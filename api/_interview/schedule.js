import {
  supabase,
  getContactEmail,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  VALID_QUESTION_CATS,
  CAT_LABEL_BY_KEY,
  catLabelFor,
  VALID_USAGE_SCOPES,
  callGemini,
  sanitizeAiDraftText,
  generateFeedbackForAnswer,
  AUTO_FEEDBACK_DEFAULTS,
  AUTO_FEEDBACK_KEYS,
  getAutoFeedbackFlags,
  AUTO_FEEDBACK_FLAG_KEY_BY_CAT,
  autoAttachFeedback,
  SCHEDULE_MIN_INTERVAL_KEY,
  SCHEDULE_MIN_INTERVAL_DEFAULT,
  getScheduleMinIntervalDays,
  generateDraftModelAnswer,
  AUTO_DRAFT_DEFAULTS,
  AUTO_DRAFT_KEYS,
  getAutoDraftFlags,
  AUTO_DRAFT_CASE_THEORY_LIMIT,
  getTodayRangeKST,
  PRACTICE_TIME_DEFAULTS,
  PRACTICE_TIME_KEYS,
  getPracticeTimeSettings,
  getPracticeCatsUsedToday,
  getNextSeqNo,
  verifyUser,
  getActiveMembership,
  getPracticeOnlyAccess,
  getCoachingSubscriptionAccess,
  getInterviewAccess,
  todayKstDateString,
  getActiveTeamId,
  getUserGrade,
  assignUserToTeam,
  sendEmail,
  sendTeamAssignmentEmail,
  sendScheduleReminderEmail,
  parseCsv,
  CAT_LABEL_MAP,
  upsertQuestionRows,
  upsertCaseModelAnswerRows
} from './shared.js';

    // ────────────────────────────────────────────────
    // [TEAM-SCHEDULE] 내 소속 팀의 수련일정 목록.
    // 오늘 날짜(KST)에 해당하는 항목만 문제 전체 내용을 내려줍니다 —
    // 미래 일정은 날짜만, 지난 일정은 제출 여부만 내려줍니다(문제 유출 방지).
    // ────────────────────────────────────────────────

export async function scheduleList(req, res, requester) {
      // [ADMIN-PREVIEW] 관리자는 previewTeamId를 넘겨서 특정 팀 수련생 화면을
      // 그대로 미리볼 수 있습니다(일반 수련생은 이 파라미터를 쓸 수 없습니다 —
      // 본인 팀이 아닌 문제를 미리 열람하지 못하도록 관리자 권한을 확인합니다).
      const { previewTeamId } = req.body || {};
      let teamId;
      let isPreview = false;
      if (previewTeamId && requester.user_status === 'admin') {
        teamId = previewTeamId;
        isPreview = true;
      } else {
        teamId = await getActiveTeamId(requester.id);
      }

      // [COACHING-FLAG] 팀 배정(delivery_mode='live')과 무관하게, 관리자가
      // "회원 권한 관리"에서 직접 부여한 코칭면접코스 Premium 플래그가 있는지
      // 함께 내려줍니다. 프론트(코칭 면접 코스 탭)는 이 값이 있으면 아직 팀
      // 배정 전이어도 "신청 안내" 버튼 대신 배정 대기 안내를 보여줍니다.
      let coachingFlagPremium = false;
      try {
        const coachingSub = await getCoachingSubscriptionAccess(requester.id);
        coachingFlagPremium = !!(coachingSub && !coachingSub.isExpired);
      } catch (error) {
        console.warn('[interview.js] user_subscriptions(coaching_interview) 조회 실패(schedule-list):', error.message);
      }

      if (!teamId) {
        let practiceOnly = false;
        try {
          const practiceAccess = await getPracticeOnlyAccess(requester.id);
          practiceOnly = !!(practiceAccess && !practiceAccess.isExpired);
        } catch (error) {
          console.warn('[interview.js] interview_practice_only_access 조회 실패(schedule-list):', error.message);
        }
        return res.status(200).json({ teamId: null, rows: [], practiceOnly, deliveryMode: null, coachingFlagPremium });
      }

      // [PRACTICE-TIME-ADMIN-ONLY] 준비/답변 제한시간은 더 이상 팀별 값이 아니라, 관리자가
      // 설정한 전체 공통 값을 그대로 사용합니다(AI 자율연습과 동일한 설정).
      const practiceTimeSettings = await getPracticeTimeSettings();
      const prepSecByCat = {
        case: practiceTimeSettings.practicePrepSecCase,
        ethics: practiceTimeSettings.practicePrepSecEthics,
        supervision: practiceTimeSettings.practicePrepSecSupervision,
      };
      const ansSecByCat = {
        case: practiceTimeSettings.practiceAnsSecCase,
        ethics: practiceTimeSettings.practiceAnsSecEthics,
        supervision: practiceTimeSettings.practiceAnsSecSupervision,
      };

      const { data: teamInfo, error: teamInfoErr } = await supabase
        .from('interview_teams')
        .select('team_type, grade, question_count, delivery_mode')
        .eq('id', teamId)
        .maybeSingle();
      if (teamInfoErr) throw teamInfoErr;

      // ──────────────────────────────────────────────────────────────
      // [COURSE-SHARED-ORDER] AI 면접 코스 공통 일정 팀은 날짜가 아니라 "순서"로
      // 진행합니다 — 카테고리(사례개념화·상담윤리·수퍼비전)별로 독립적으로, 이전
      // 순서를 제출해야 다음 순서 문제가 열립니다. 승인된 순간 누구나 1번부터
      // 시작하므로 팀 배정을 기다릴 필요가 없습니다.
      // ──────────────────────────────────────────────────────────────
      if (teamInfo?.team_type === 'course_shared') {
        const catsToShow = ['case', 'ethics'];
        if (teamInfo.grade === '1') catsToShow.push('supervision');

        const { data: orderItems, error: orderItemsErr } = await supabase
          .from('interview_team_schedule')
          .select('id, cat, order_no, question_id, mode_structured, mode_freeform, interview_questions(question, tips, seq_no, topic, is_active)')
          .eq('team_id', teamId)
          .in('cat', catsToShow)
          .not('order_no', 'is', null)
          .order('order_no', { ascending: true });
        if (orderItemsErr) throw orderItemsErr;

        const itemIds = (orderItems || []).map(it => it.id);
        let submittedIdSet = new Set();
        if (itemIds.length > 0) {
          const { data: subs, error: subErr } = await supabase
            .from('practice_sessions')
            .select('schedule_id')
            .eq('user_id', requester.id)
            .is('deleted_at', null)
            .in('schedule_id', itemIds);
          if (subErr) throw subErr;
          submittedIdSet = new Set((subs || []).map(s => s.schedule_id));
        }

        const itemsByCat = {};
        catsToShow.forEach(c => { itemsByCat[c] = {}; });
        (orderItems || []).forEach(it => { itemsByCat[it.cat][it.order_no] = it; });

        const completedCountByCat = {};
        catsToShow.forEach(c => {
          completedCountByCat[c] = Object.values(itemsByCat[c]).filter(it => submittedIdSet.has(it.id)).length;
        });

        // [CASE-THEORY-READY-GATE] 지금 순서가 사례개념화라면, 승인된 상담이론이
        // 있는지 확인합니다(없으면 '준비중'으로 표시하고 제출을 막습니다).
        const currentCaseOrderNo = completedCountByCat.case + 1;
        const currentCaseItem = itemsByCat.case[currentCaseOrderNo];
        let currentCaseTheories = [];
        if (currentCaseItem) {
          const { data: theoryRows, error: theoryErr } = await supabase
            .from('interview_case_model_answers')
            .select('theory')
            .eq('question_id', currentCaseItem.question_id)
            .eq('status', 'approved');
          if (theoryErr) throw theoryErr;
          currentCaseTheories = (theoryRows || []).map(t => t.theory);
        }

        const total = teamInfo.question_count || 8;
        const mapped = [];
        catsToShow.forEach(cat => {
          const completedCount = completedCountByCat[cat];
          for (let orderNo = 1; orderNo <= total; orderNo++) {
            const item = itemsByCat[cat][orderNo];
            const isSubmitted = item ? submittedIdSet.has(item.id) : false;
            let status;
            if (isSubmitted) {
              status = 'closed';
            } else if (orderNo === completedCount + 1) {
              // [QCAT-BULK-ACTIVE] 다음 순서 문제가 비활성화됐거나(관리자가 내림),
              // 사례개념화인데 승인된 이론이 아직 없거나, 애초에 아직 등록되지
              // 않았다면 모두 "준비중"으로 표시하고 제출 화면을 내려주지 않습니다.
              const inactiveGate = item && item.interview_questions && item.interview_questions.is_active === false;
              const theoryGate = cat === 'case' && item && currentCaseTheories.length === 0;
              status = (!item || inactiveGate || theoryGate) ? 'preparing' : 'open';
            } else {
              status = 'upcoming';
            }

            const base = {
              id: item ? item.id : null,
              startDate: null,
              endDate: null,
              orderNo,
              cat,
              catLabel: catLabelFor(cat),
              status,
              submitted: isSubmitted
            };
            if (status === 'open' && item) {
              base.question = {
                id: item.question_id,
                q: item.interview_questions?.question,
                tips: item.interview_questions?.tips || [],
                seqNo: item.interview_questions?.seq_no,
                topic: item.interview_questions?.topic || null,
                modeStructured: item.mode_structured ?? null,
                modeFreeform: item.mode_freeform ?? null,
                theories: cat === 'case' ? currentCaseTheories : []
              };
              base.timeLimitSec = ansSecByCat[cat];
              base.prepTimeLimitSec = prepSecByCat[cat];
            }
            mapped.push(base);
          }
        });

        return res.status(200).json({ teamId, rows: mapped, isPreview, orderBased: true, deliveryMode: teamInfo?.delivery_mode || 'async', coachingFlagPremium });
      }

      // ──────────────────────────────────────────────────────────────
      // [TEAM-SCHEDULE-RANGE] 코호트(소그룹) 팀 — 기존 날짜 기반 공개 기간 방식.
      // ──────────────────────────────────────────────────────────────
      // [QCAT-BULK-ACTIVE] is_active도 함께 받아옵니다 — 이미 배정된 일정이라도 문제가
      // 비활성화되면 공개중 상태에서 즉시 숨기기 위해 필요합니다.
      const { data: rows, error } = await supabase
        .from('interview_team_schedule')
        .select('id, start_date, end_date, cat, question_id, mode_structured, mode_freeform, live_session_time, live_meeting_link, interview_questions(question, tips, seq_no, topic, is_active)')
        .eq('team_id', teamId)
        .order('start_date', { ascending: true });
      if (error) throw error;

      const todayStr = todayKstDateString();

      const scheduleIds = (rows || []).map(r => r.id);
      let submittedSet = new Set();
      if (scheduleIds.length > 0) {
        const { data: subs, error: subErr } = await supabase
          .from('practice_sessions')
          .select('schedule_id')
          .eq('user_id', requester.id)
          .is('deleted_at', null)
          .in('schedule_id', scheduleIds);
        if (subErr) throw subErr;
        submittedSet = new Set((subs || []).map(s => s.schedule_id));
      }

      // [TEAM-SCHEDULE-RANGE] 오늘 날짜가 [start_date, end_date] 안에 있으면 "공개중"입니다
      // (하루가 아니라 기간). 공개중인 문제(사례개념화·상담윤리 모두 가능, 최대 2건)에
      // 등록된 상담이론 이름도 함께 내려줍니다(모범답안 본문은 제외, 사례개념화만 해당).
      // [CASE-THEORY-READY-GATE]는 그대로 "모범답안이 승인된 이론이 있는가"로 판단하지만
      // (모범답안 없이 제출되는 상황 방지), 실제 선택창에 무엇을 보여줄지는 코칭(실시간,
      // delivery_mode='live') 팀과 그 외를 다르게 처리합니다 — 코칭 면접 코스는 소그룹
      // 실시간 화상 코칭에서 수퍼바이저가 직접 피드백을 주므로 AI 모범답안 유무와 무관하게
      // 전체 상담이론 목록(interview_theory_options) 중에서 고를 수 있어야 합니다.
      const openRows = (rows || []).filter(r => r.start_date <= todayStr && todayStr <= r.end_date);
      const openCaseIds = openRows.filter(r => r.cat === 'case').map(r => r.question_id);
      let theoriesByQuestion = {};
      if (openCaseIds.length > 0) {
        const { data: theoryRows, error: theoryErr } = await supabase
          .from('interview_case_model_answers')
          .select('question_id, theory')
          .in('question_id', openCaseIds)
          .eq('status', 'approved');
        if (theoryErr) throw theoryErr;
        theoriesByQuestion = (theoryRows || []).reduce((acc, t) => {
          if (!acc[t.question_id]) acc[t.question_id] = [];
          acc[t.question_id].push(t.theory);
          return acc;
        }, {});
      }

      const isCoachingLiveTeam = teamInfo?.delivery_mode === 'live';
      let allTheoryNames = [];
      if (isCoachingLiveTeam && openCaseIds.length > 0) {
        const { data: allTheoryRows, error: allTheoryErr } = await supabase
          .from('interview_theory_options')
          .select('name')
          .order('name', { ascending: true });
        if (allTheoryErr) throw allTheoryErr;
        allTheoryNames = (allTheoryRows || []).map(t => t.name).filter(Boolean);
      }

      const mapped = (rows || []).map(r => {
        const isOpen = r.start_date <= todayStr && todayStr <= r.end_date;
        const isPast = r.end_date < todayStr;
        // [QCAT-BULK-ACTIVE] 관리자가 문제를 비활성화하면, 이미 배정되어 "공개중"으로
        // 보이던 일정이라도 수련생 화면에서는 즉시 숨깁니다 — 마치 배정되지 않은 것처럼
        // 목록에서 아예 빠집니다. 비활성화 전에 이미 제출한 답변은 practice_sessions에
        // 그대로 남아 있으므로 여기서 안 보인다고 기록이 사라지는 것은 아닙니다.
        if (isOpen && r.interview_questions && r.interview_questions.is_active === false) {
          return null;
        }
        // [CASE-THEORY-READY-GATE] 사례개념화인데 승인된 이론이 하나도 없으면 "공개중"이
        // 아니라 "준비중"으로 표시하고, 답변 화면 자체를 내려주지 않습니다 — 이론을
        // 고르지 못한 채로 제출돼 나중에 AI 피드백을 만들 수 없는 상황을 막기 위함입니다.
        const caseNotReady = isOpen && r.cat === 'case' && (theoriesByQuestion[r.question_id] || []).length === 0;
        const base = {
          id: r.id,
          startDate: r.start_date,
          endDate: r.end_date,
          cat: r.cat,
          catLabel: catLabelFor(r.cat),
          status: caseNotReady ? 'preparing' : (isOpen ? 'open' : (isPast ? 'closed' : 'upcoming')),
          submitted: submittedSet.has(r.id)
        };
        // [COACHING-LIVE-SESSION] 코칭(실시간) 팀은 공개 여부와 무관하게 정기 화상
        // 세션 시간/링크를 미리 안내합니다.
        if (teamInfo?.delivery_mode === 'live') {
          base.liveSessionTime = r.live_session_time || null;
          base.liveMeetingLink = r.live_meeting_link || null;
        }
        if (isOpen && !caseNotReady) {
          // [ANSWER-MODE] 우선순위: 이 배정(팀×기간)에 지정된 값 > (클라이언트에서) 전체
          // 기본값. 배정별 설정이 없으면(null) 클라이언트가 전체 기본값을 적용합니다.
          base.question = {
            id: r.question_id,
            q: r.interview_questions?.question,
            tips: r.interview_questions?.tips || [],
            seqNo: r.interview_questions?.seq_no,
            topic: r.interview_questions?.topic || null,
            modeStructured: r.mode_structured ?? null,
            modeFreeform: r.mode_freeform ?? null,
            theories: r.cat === 'case'
              ? (isCoachingLiveTeam ? allTheoryNames : (theoriesByQuestion[r.question_id] || []))
              : []
          };
          base.timeLimitSec = ansSecByCat[r.cat];
          base.prepTimeLimitSec = prepSecByCat[r.cat];
        }
        return base;
      }).filter(Boolean);

      return res.status(200).json({ teamId, rows: mapped, isPreview, deliveryMode: teamInfo?.delivery_mode || 'async', coachingFlagPremium });
}

    // ────────────────────────────────────────────────
    // [TEAM-SCHEDULE] 오늘 열린 수련일정 문제에 답변 제출 (1인 1회)
    // ────────────────────────────────────────────────

export async function scheduleSubmit(req, res, requester) {
      const { scheduleId, fields, theory } = req.body;
      if (!scheduleId) return res.status(400).json({ message: 'scheduleId가 필요합니다.' });
      if (!Array.isArray(fields) || fields.length === 0) {
        return res.status(400).json({ message: '제출할 답변이 없습니다.' });
      }

      // [ACCESS-EXPIRY] getActiveTeamId는 소속이 없거나 이용 기간이 만료되면 둘 다
      // null을 반환하므로, 만료된 경우에는 별도로 조회해 더 명확한 안내 메시지를 줍니다.
      if (requester.user_status !== 'admin') {
        const access = await getInterviewAccess(requester.id, requester.user_status);
        if (access === 'expired') {
          return res.status(403).json({
            message: '이용 기간이 만료되었습니다. 재신청 후 다시 이용해주세요. (지난 제출 기록은 계속 조회할 수 있습니다.)'
          });
        }
      }

      const teamId = await getActiveTeamId(requester.id);
      if (!teamId) return res.status(403).json({ message: '소속된 팀이 없어 제출할 수 없습니다.' });

      const { data: row, error: rowErr } = await supabase
        .from('interview_team_schedule')
        .select('id, team_id, start_date, end_date, order_no, cat, question_id, interview_questions(question)')
        .eq('id', scheduleId)
        .maybeSingle();
      if (rowErr) throw rowErr;
      if (!row) return res.status(404).json({ message: '수련일정을 찾을 수 없습니다.' });
      if (row.team_id !== teamId) {
        return res.status(403).json({ message: '본인이 속한 팀의 수련일정이 아닙니다.' });
      }

      // [CASE-THEORY-READY-GATE] 사례개념화는 승인된 상담이론이 하나 이상 있어야 제출을
      // 받을 수 있습니다 — 화면에서 "준비중"으로 막아도 API 직접 호출 우회를 막기
      // 위해 저장 시점에도 재검증합니다.
      if (row.cat === 'case') {
        const { data: approvedTheories, error: theoryCheckErr } = await supabase
          .from('interview_case_model_answers')
          .select('id')
          .eq('question_id', row.question_id)
          .eq('status', 'approved')
          .limit(1);
        if (theoryCheckErr) throw theoryCheckErr;
        if (!approvedTheories || approvedTheories.length === 0) {
          return res.status(400).json({ message: '이 문제는 아직 준비 중입니다(모범답안 승인 대기). 관리자에게 문의해주세요.' });
        }
      }

      // [SUPERVISION-GRADE-GATE] 수퍼비전 배정은 관리자가 등록 시점에 1급 팀에만
      // 허용하지만, 이후 팀 급수가 바뀌는 경우를 대비해 제출 시점에도 재검증합니다.
      if (row.cat === 'supervision' && requester.user_status !== 'admin') {
        const grade = await getUserGrade(requester.id);
        if (grade !== '1') {
          return res.status(403).json({ message: '수퍼비전 학습은 1급 소속 팀만 이용할 수 있습니다.' });
        }
      }

      if (row.order_no != null) {
        // [COURSE-SHARED-ORDER] 순서 기반(공통 일정) 배정 — 화면에서 잠가둬도 API를
        // 직접 호출해 순서를 건너뛰지 못하도록, 이 카테고리에서 이미 제출한 개수가
        // 정확히 (이 순서 - 1)인지 저장 시점에도 재검증합니다.
        const { data: catItems, error: catItemsErr } = await supabase
          .from('interview_team_schedule')
          .select('id')
          .eq('team_id', row.team_id)
          .eq('cat', row.cat)
          .not('order_no', 'is', null);
        if (catItemsErr) throw catItemsErr;
        const catItemIds = (catItems || []).map(x => x.id);
        let submittedCountForCat = 0;
        if (catItemIds.length > 0) {
          const { count, error: subCountErr } = await supabase
            .from('practice_sessions')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', requester.id)
            .is('deleted_at', null)
            .in('schedule_id', catItemIds);
          if (subCountErr) throw subCountErr;
          submittedCountForCat = count || 0;
        }
        if (submittedCountForCat !== row.order_no - 1) {
          return res.status(400).json({ message: '이전 순서의 문제를 먼저 제출해야 합니다.' });
        }
      } else {
        // [TEAM-SCHEDULE-RANGE] 날짜 기반(코호트) 배정 — 기존 공개 기간 검증.
        const todayStr = todayKstDateString();
        if (todayStr < row.start_date || todayStr > row.end_date) {
          return res.status(400).json({ message: '지금은 공개 기간이 아니라 제출할 수 없습니다.' });
        }
      }

      // 상담이론은 선택사항입니다(자유 연습과 동일) — 해당 문제에 등록된 이론이 없으면
      // 선택 없이도 제출할 수 있고, theory는 null로 저장됩니다. 이론 정보는 나중에
      // "AI 피드백" 요청 시에만 필요합니다.

      const { data: existing, error: exErr } = await supabase
        .from('practice_sessions')
        .select('id')
        .eq('schedule_id', scheduleId)
        .eq('user_id', requester.id)
        .is('deleted_at', null)
        .maybeSingle();
      if (exErr) throw exErr;
      if (existing) return res.status(400).json({ message: '이미 제출하셨습니다.' });

      // [SCHEDULE-MIN-INTERVAL] AI 면접 코스는 하루에 몰아서 제출하지 못하도록 직전
      // AI 면접 코스 제출 시각으로부터 최소 간격(관리자 설정, 기본 2일)을 둡니다.
      // 전체 8회/1개월 기한 자체는 admin-schedule-upsert의 공개기간으로 이미 제한됩니다.
      // [SCHEDULE-MIN-INTERVAL-PER-CAT] 최소 제출 간격은 카테고리별로 독립적으로 계산합니다
      // — 사례개념화를 방금 제출했다고 상담윤리(다른 카테고리) 제출까지 막히면 안 되므로,
      // "가장 최근 제출" 대신 "같은 카테고리의 가장 최근 제출"을 기준으로 봅니다.
      if (requester.user_status !== 'admin') {
        const minIntervalDays = await getScheduleMinIntervalDays();
        if (minIntervalDays > 0) {
          const { data: recentSubs, error: lastErr } = await supabase
            .from('practice_sessions')
            .select('created_at, answers')
            .eq('user_id', requester.id)
            .not('schedule_id', 'is', null)
            .is('deleted_at', null)
            .order('created_at', { ascending: false })
            .limit(50);
          if (lastErr) throw lastErr;
          const lastSameCat = (recentSubs || []).find(s => Array.isArray(s.answers) && s.answers[0] && s.answers[0].cat === row.cat);
          if (lastSameCat) {
            const minMs = minIntervalDays * 24 * 60 * 60 * 1000;
            const elapsedMs = Date.now() - new Date(lastSameCat.created_at).getTime();
            if (elapsedMs < minMs) {
              const remainingHours = Math.max(1, Math.ceil((minMs - elapsedMs) / (60 * 60 * 1000)));
              return res.status(403).json({
                message: `직전 ${catLabelFor(row.cat)} 제출로부터 최소 ${minIntervalDays}일이 지나야 다음 ${catLabelFor(row.cat)} 문항을 제출할 수 있습니다. 약 ${remainingHours}시간 후 다시 시도해주세요.`
              });
            }
          }
        }
      }

      const answerText = fields.map(f => `${f.label}: ${f.value || '(미작성)'}`).join('\n');

      const answers = [{
        cat: row.cat,
        catLabel: catLabelFor(row.cat),
        q: row.interview_questions?.question || '',
        questionId: row.question_id,
        fields,
        answerText,
        theory: row.cat === 'case' ? (theory || null) : null
      }];

      // [AUTO-FEEDBACK] 저장 전에 카테고리별 자동 생성 설정에 따라 AI 피드백을 붙입니다.
      const enrichedAnswers = await autoAttachFeedback(answers);

      const { error: insErr } = await supabase.from('practice_sessions').insert({
        user_id: requester.id,
        schedule_id: scheduleId,
        grade: null,
        answers: enrichedAnswers,
        avg_confidence: null,
        checklist_rate: null
      });
      if (insErr) {
        if (insErr.code === '23505') {
          return res.status(400).json({ message: '이미 제출하셨습니다.' });
        }
        throw insErr;
      }

      return res.status(200).json({ message: '제출되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [TRAINING-OVERVIEW] 관리자 — 전체 팀의 "AI 면접 코스" 현황을 한 번에 조회합니다.
    // interview.html의 "AI 면접 코스" 탭에서 관리자에게 보여주는 대시보드용 데이터입니다.
    // - 팀별로 지금 공개중인 일정(사례/윤리)과 제출 현황(제출/미제출 인원)
    // - 마감(종료일)이 오늘·내일인 일정은 closingSoon으로 표시
    // - 제출은 됐지만 아직 AI 피드백이 없는 답변들을 feedbackPendingQueue로 모아서 반환
    // ────────────────────────────────────────────────

export async function adminTrainingOverview(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const todayStr = todayKstDateString();
      const tomorrowStr = new Date(new Date(todayStr).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const { data: teams, error: tErr } = await supabase
        .from('interview_teams')
        .select('id, name, delivery_mode')
        .eq('status', 'active')
        .order('name', { ascending: true });
      if (tErr) throw tErr;

      if (!teams || teams.length === 0) {
        const { count: earlyReportCount, error: earlyReportErr } = await supabase
          .from('interview_feedback_reports')
          .select('id', { count: 'exact', head: true })
          .is('resolved_at', null);
        if (earlyReportErr) console.warn('[interview.js] 미해결 신고 건수 조회 실패:', earlyReportErr.message);
        return res.status(200).json({
          teams: [], feedbackPendingQueue: [],
          summary: { totalSubmitted: 0, feedbackDone: 0, feedbackPending: 0, unresolvedReports: earlyReportCount || 0 }
        });
      }

      const teamIds = teams.map(t => t.id);

      const { data: members, error: mErr } = await supabase
        .from('interview_team_members')
        .select('team_id, user_id, users(name, email)')
        .in('team_id', teamIds)
        .is('removed_at', null);
      if (mErr) throw mErr;

      const membersByTeam = {};
      (members || []).forEach(m => {
        if (!membersByTeam[m.team_id]) membersByTeam[m.team_id] = [];
        membersByTeam[m.team_id].push({ userId: m.user_id, name: m.users?.name || '', email: m.users?.email || '' });
      });

      // [범위 제한] 아주 오래 지난 일정까지 계속 불러오면 무거워지므로, 종료일 기준
      // 최근 30일 이내(또는 아직 열려있거나 예정된) 일정만 대상으로 합니다.
      // [COURSE-SHARED-ORDER] 순서 기반(공통 일정) 배정은 end_date가 없으므로(null),
      // 이 범위 필터에서 함께 제외되지 않도록 end_date가 null인 행도 포함시킵니다 —
      // 그래야 그 팀의 제출 답변도 아래 "AI 피드백 미작성 큐"에 계속 반영됩니다.
      const rangeStart = new Date(new Date(todayStr).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { data: scheduleRows, error: schErr } = await supabase
        .from('interview_team_schedule')
        .select('id, team_id, start_date, end_date, order_no, cat, question_id, interview_questions(question, seq_no, topic)')
        .in('team_id', teamIds)
        .or(`end_date.gte.${rangeStart},end_date.is.null`)
        .order('end_date', { ascending: true });
      if (schErr) throw schErr;

      const scheduleIds = (scheduleRows || []).map(r => r.id);
      let subsBySchedule = {};
      if (scheduleIds.length > 0) {
        const { data: subs, error: sErr } = await supabase
          .from('practice_sessions')
          .select('id, schedule_id, user_id, answers')
          .is('deleted_at', null)
          .in('schedule_id', scheduleIds);
        if (sErr) throw sErr;
        (subs || []).forEach(s => {
          if (!subsBySchedule[s.schedule_id]) subsBySchedule[s.schedule_id] = [];
          subsBySchedule[s.schedule_id].push(s);
        });
      }

      const feedbackPendingQueue = [];
      const scheduleByTeam = {};
      (scheduleRows || []).forEach(r => {
        // [COURSE-SHARED-ORDER] 순서 기반 배정(order_no 있음, 날짜 없음)은 "공개중/
        // 마감임박" 카드 개념이 없으므로 항상 false — 다만 그 제출 건은 아래에서
        // feedbackPendingQueue에는 그대로 반영됩니다.
        const isOpen = r.end_date != null && r.start_date <= todayStr && todayStr <= r.end_date;
        const isClosingSoon = r.end_date != null && (r.end_date === todayStr || r.end_date === tomorrowStr);
        const teamMembers = membersByTeam[r.team_id] || [];
        const subs = subsBySchedule[r.id] || [];
        const submittedUserIds = new Set(subs.map(s => s.user_id));
        const notSubmitted = teamMembers.filter(m => !submittedUserIds.has(m.userId));
        const catLabel = catLabelFor(r.cat);
        const team = teams.find(t => t.id === r.team_id);

        // [AI-FEEDBACK-QUEUE] 제출된 답변인데 feedback이 비어있으면 피드백 미작성 큐에 추가.
        subs.forEach(s => {
          const answer = (s.answers && s.answers[0]) || null;
          if (answer && !answer.feedback) {
            const member = teamMembers.find(m => m.userId === s.user_id);
            feedbackPendingQueue.push({
              sessionId: s.id,
              teamId: r.team_id,
              teamName: team?.name || '',
              studentName: member?.name || member?.email || '(알 수 없음)',
              cat: r.cat,
              catLabel,
              question: r.interview_questions?.question || '',
              scheduleId: r.id
            });
          }
        });

        if (!isOpen && !isClosingSoon) return; // 대시보드에는 공개중이거나 마감임박인 것만 노출
        if (!scheduleByTeam[r.team_id]) scheduleByTeam[r.team_id] = [];
        scheduleByTeam[r.team_id].push({
          id: r.id,
          cat: r.cat,
          catLabel,
          topic: r.interview_questions?.topic || null,
          question: r.interview_questions?.question || '',
          seqNo: r.interview_questions?.seq_no,
          startDate: r.start_date,
          endDate: r.end_date,
          isOpen,
          isClosingSoon,
          totalMembers: teamMembers.length,
          submittedCount: submittedUserIds.size,
          notSubmittedCount: notSubmitted.length,
          notSubmitted: notSubmitted
        });
      });

      const teamsOut = teams.map(t => ({
        teamId: t.id,
        teamName: t.name,
        // [PREVIEW-SPLIT] AI 면접 코스/코칭 면접 코스 각 탭의 "수련생 화면 미리보기"
        // 팀 선택 목록을 분리하는 데 씁니다(delivery_mode='live'만 코칭 목록에 노출).
        deliveryMode: t.delivery_mode || 'async',
        memberCount: (membersByTeam[t.id] || []).length,
        schedules: scheduleByTeam[t.id] || []
      }));

      // [STEP3-MONITORING-SUMMARY] 관리자가 건별로 하나씩 확인하지 않고도 전체 현황을
      // 한눈에 볼 수 있도록, 이 화면이 이미 조회한 범위(최근 30일 + 순서 기반 공통
      // 일정 전체)의 제출·피드백 현황을 요약합니다. "실패" 건수는 아직 별도로 구분해
      // 기록하지 않아(자동 생성 실패도 "미작성"과 동일하게 저장됨) 이번 단계에서는
      // 미작성(대기) 건수에 합쳐서 보여줍니다 — 원인별로 나누는 것은 이후 과제입니다.
      const allSubsInScope = Object.values(subsBySchedule).flat();
      const feedbackDoneCount = allSubsInScope.filter(s => {
        const answer = s.answers && s.answers[0];
        return !!(answer && answer.feedback);
      }).length;
      // [STEP4-FEEDBACK-REPORT] 신고 누적 통계를 요약 카드에도 노출합니다(전체 미해결
      // 건수 — 팀/기간 범위와 무관하게 항상 전체 기준).
      const { count: unresolvedReportCount, error: reportCountErr } = await supabase
        .from('interview_feedback_reports')
        .select('id', { count: 'exact', head: true })
        .is('resolved_at', null);
      if (reportCountErr) console.warn('[interview.js] 미해결 신고 건수 조회 실패:', reportCountErr.message);

      const summary = {
        totalSubmitted: allSubsInScope.length,
        feedbackDone: feedbackDoneCount,
        feedbackPending: feedbackPendingQueue.length,
        unresolvedReports: unresolvedReportCount || 0
      };

      return res.status(200).json({ teams: teamsOut, feedbackPendingQueue, summary });
}

    // ────────────────────────────────────────────────
    // [TRAINING-OVERVIEW] 관리자 — 특정 일정의 미제출자 전원에게 마감 임박 리마인드 메일 발송
    // ────────────────────────────────────────────────

export async function adminScheduleRemind(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { scheduleId } = req.body;
      if (!scheduleId) return res.status(400).json({ message: 'scheduleId가 필요합니다.' });

      const { data: schedule, error: schErr } = await supabase
        .from('interview_team_schedule')
        .select('team_id, start_date, end_date, cat, interview_teams(name)')
        .eq('id', scheduleId)
        .maybeSingle();
      if (schErr) throw schErr;
      if (!schedule) return res.status(404).json({ message: '수련일정을 찾을 수 없습니다.' });

      const { data: members, error: mErr } = await supabase
        .from('interview_team_members')
        .select('user_id, users(name, email)')
        .eq('team_id', schedule.team_id)
        .is('removed_at', null);
      if (mErr) throw mErr;

      const { data: subs, error: sErr } = await supabase
        .from('practice_sessions')
        .select('user_id')
        .eq('schedule_id', scheduleId)
        .is('deleted_at', null);
      if (sErr) throw sErr;
      const submittedUserIds = new Set((subs || []).map(s => s.user_id));

      const notSubmittedMembers = (members || []).filter(m => !submittedUserIds.has(m.user_id) && m.users?.email);
      if (notSubmittedMembers.length === 0) {
        return res.status(200).json({ message: '미제출자가 없습니다.', sentCount: 0 });
      }

      const catLabel = schedule.cat === 'case' ? '사례개념화' : '상담윤리';
      const teamName = schedule.interview_teams?.name || '';
      await Promise.all(notSubmittedMembers.map(m => sendScheduleReminderEmail({
        to: m.users.email,
        userName: m.users.name,
        teamName,
        catLabel,
        endDate: schedule.end_date
      })));

      return res.status(200).json({ message: `${notSubmittedMembers.length}명에게 리마인드 메일을 보냈습니다.`, sentCount: notSubmittedMembers.length });
}

    // ────────────────────────────────────────────────
    // [TEAM-SCHEDULE] 관리자 — 팀의 수련일정 목록 (문제 라벨 + 제출 인원 포함)
    // ────────────────────────────────────────────────

export async function adminScheduleList(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { teamId } = req.body;
      if (!teamId) return res.status(400).json({ message: 'teamId가 필요합니다.' });

      const { data, error } = await supabase
        .from('interview_team_schedule')
        .select('id, start_date, end_date, order_no, cat, question_id, mode_structured, mode_freeform, live_session_time, live_meeting_link, interview_questions(question, seq_no, topic)')
        .eq('team_id', teamId)
        .order('start_date', { ascending: true })
        .order('order_no', { ascending: true });
      if (error) throw error;

      const ids = (data || []).map(r => r.id);
      const countMap = {};
      if (ids.length > 0) {
        const { data: subs, error: sErr } = await supabase
          .from('practice_sessions')
          .select('schedule_id')
          .is('deleted_at', null)
          .in('schedule_id', ids);
        if (sErr) throw sErr;
        (subs || []).forEach(s => { countMap[s.schedule_id] = (countMap[s.schedule_id] || 0) + 1; });
      }

      const rows = (data || []).map(r => ({
        id: r.id,
        startDate: r.start_date,
        endDate: r.end_date,
        // [COURSE-SHARED-ORDER] 날짜 기반 배정은 null, 순서 기반(공통 일정) 배정은
        // 1부터 시작하는 정수입니다.
        orderNo: r.order_no,
        cat: r.cat,
        catLabel: catLabelFor(r.cat),
        questionId: r.question_id,
        questionLabel: r.interview_questions
          ? `${r.interview_questions.topic ? `[${r.interview_questions.topic}] ` : ''}#${r.interview_questions.seq_no ?? '-'} ${(r.interview_questions.question || '').slice(0, 50)}${(r.interview_questions.question || '').length > 50 ? '…' : ''}`
          : '(삭제된 문제)',
        submittedCount: countMap[r.id] || 0,
        // [ANSWER-MODE-ASSIGNMENT-OVERRIDE] null이면 이 배정은 문제별 설정(또는 전체
        // 기본값)을 따르고, 지정된 경우에만 이 배정(팀×기간)에 한해 덮어씁니다.
        modeStructured: r.mode_structured,
        modeFreeform: r.mode_freeform,
        // [COACHING-LIVE-SESSION] 코칭(실시간) 팀에 한해 의미가 있는 필드입니다.
        liveSessionTime: r.live_session_time,
        liveMeetingLink: r.live_meeting_link
      }));

      return res.status(200).json(rows);
}

    // ────────────────────────────────────────────────
    // [TEAM-SCHEDULE-RANGE] 관리자 — 특정 공개 기간(시작일~종료일)에 문제 지정/변경
    // (사례개념화·상담윤리 모두 가능. 같은 팀+시작일+유형(cat) 조합이 이미 있으면
    //  문제/종료일을 교체합니다. 같은 기간에 사례개념화 1개 + 상담윤리 1개까지
    //  함께 지정할 수 있습니다. 하루만 공개하려면 시작일=종료일로 지정하세요.)
    // ────────────────────────────────────────────────

export async function adminScheduleUpsert(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { teamId, startDate, endDate, orderNo, questionId, modeStructured, modeFreeform, liveSessionTime, liveMeetingLink } = req.body;
      if (!teamId || !questionId) {
        return res.status(400).json({ message: 'teamId, questionId가 필요합니다.' });
      }

      const { data: teamRow, error: teamErr } = await supabase
        .from('interview_teams')
        .select('grade, team_type, question_count')
        .eq('id', teamId)
        .maybeSingle();
      if (teamErr) throw teamErr;
      if (!teamRow) return res.status(400).json({ message: '존재하지 않는 팀입니다.' });

      // [COURSE-SHARED-ORDER] AI 면접 코스 공통 일정 팀은 날짜 대신 "진행 순서"로
      // 문제를 배정합니다 — 수련생 각자가 이전 순서를 제출해야 다음 순서가 열립니다.
      const isOrderBased = teamRow.team_type === 'course_shared';

      let orderNoValue = null;
      if (isOrderBased) {
        const parsedOrderNo = parseInt(orderNo, 10);
        const maxOrderNo = teamRow.question_count || 8;
        if (isNaN(parsedOrderNo) || parsedOrderNo < 1 || parsedOrderNo > maxOrderNo) {
          return res.status(400).json({ message: `진행 순서는 1~${maxOrderNo} 사이여야 합니다(팀 설정의 문항 수 기준).` });
        }
        orderNoValue = parsedOrderNo;
      } else {
        if (!startDate || !endDate) {
          return res.status(400).json({ message: 'startDate, endDate가 필요합니다.' });
        }
        if (endDate < startDate) {
          return res.status(400).json({ message: '종료일은 시작일보다 빠를 수 없습니다.' });
        }
      }

      // [ANSWER-MODE-ASSIGNMENT-OVERRIDE] 이 배정(팀×기간/순서)에 한해 답안 모드를
      // 문제별 설정과 다르게 강제할 수 있습니다. 두 값은 항상 함께(둘 다 null =
      // 문제별 설정 따름, 또는 둘 다 지정) 저장되며, 지정하는 경우 최소 하나는 true여야
      // 합니다.
      const modeStructuredIsNull = modeStructured === null || modeStructured === undefined;
      const modeFreeformIsNull = modeFreeform === null || modeFreeform === undefined;
      if (modeStructuredIsNull !== modeFreeformIsNull) {
        return res.status(400).json({ message: '답안 모드는 구조형·통합형 둘 다 "문제 설정 따름"이거나 둘 다 지정되어야 합니다.' });
      }
      if (!modeStructuredIsNull && !modeStructured && !modeFreeform) {
        return res.status(400).json({ message: '답안 모드는 구조형/통합형 중 최소 하나는 켜져 있어야 합니다.' });
      }

      const { data: q, error: qErr } = await supabase
        .from('interview_questions')
        .select('id, cat, usage_scope')
        .eq('id', questionId)
        .maybeSingle();
      if (qErr) throw qErr;
      if (!q) return res.status(400).json({ message: '존재하지 않는 문제입니다.' });
      // [QBANK-USAGE-SCOPE] AI 면접 코스용(team)으로 지정된 문제만 배정할 수 있습니다.
      if (q.usage_scope !== 'team') {
        return res.status(400).json({ message: 'AI 면접 코스용으로 지정된 문제만 배정할 수 있습니다. 질문은행 관리에서 이 문제의 용도를 "AI 면접 코스용"으로 변경한 뒤 다시 시도해 주세요.' });
      }
      // [SUPERVISION-GRADE-GATE] 수퍼비전은 1급 평가영역이라 1급 팀에만 배정할 수 있습니다.
      if (q.cat === 'supervision' && teamRow.grade !== '1') {
        return res.status(400).json({ message: '수퍼비전 문제는 1급 팀에만 배정할 수 있습니다. 팀 설정에서 응시 급수를 먼저 1급으로 변경해 주세요.' });
      }

      const upsertRow = {
        team_id: teamId, cat: q.cat, question_id: questionId,
        mode_structured: modeStructuredIsNull ? null : !!modeStructured,
        mode_freeform: modeFreeformIsNull ? null : !!modeFreeform,
        // [COACHING-LIVE-SESSION] 코칭(실시간) 팀의 정기 화상 세션 일정 — 코호트
        // (날짜 기반) 팀에서만 의미가 있지만, 값이 없으면 그냥 null로 저장되므로
        // 팀 종류와 무관하게 항상 받아둡니다.
        live_session_time: (typeof liveSessionTime === 'string' && liveSessionTime.trim()) ? liveSessionTime.trim() : null,
        live_meeting_link: (typeof liveMeetingLink === 'string' && liveMeetingLink.trim()) ? liveMeetingLink.trim() : null,
      };
      if (isOrderBased) {
        upsertRow.order_no = orderNoValue;
        upsertRow.start_date = null;
        upsertRow.end_date = null;
      } else {
        upsertRow.start_date = startDate;
        upsertRow.end_date = endDate;
        upsertRow.order_no = null;
      }

      const { error } = await supabase
        .from('interview_team_schedule')
        .upsert(
          [upsertRow],
          { onConflict: isOrderBased ? 'team_id,cat,order_no' : 'team_id,start_date,cat' }
        );
      if (error) throw error;

      return res.status(200).json({ message: '저장되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [TEAM-SCHEDULE] 관리자 — 수련일정 항목 삭제
    // ────────────────────────────────────────────────

export async function adminScheduleDelete(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { id } = req.body;
      if (!id) return res.status(400).json({ message: 'id가 필요합니다.' });

      const { error } = await supabase.from('interview_team_schedule').delete().eq('id', id);
      if (error) throw error;

      return res.status(200).json({ message: '삭제되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [TEAM-SCHEDULE] 관리자 — 특정 수련일정의 팀원별 제출 여부
    // ────────────────────────────────────────────────

export async function adminScheduleSubmissions(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { scheduleId } = req.body;
      if (!scheduleId) return res.status(400).json({ message: 'scheduleId가 필요합니다.' });

      const { data: schedule, error: schErr } = await supabase
        .from('interview_team_schedule')
        .select('team_id, start_date, end_date, cat')
        .eq('id', scheduleId)
        .maybeSingle();
      if (schErr) throw schErr;
      if (!schedule) return res.status(404).json({ message: '수련일정을 찾을 수 없습니다.' });

      const { data: members, error: mErr } = await supabase
        .from('interview_team_members')
        .select('user_id, users(name, email)')
        .eq('team_id', schedule.team_id)
        .is('removed_at', null);
      if (mErr) throw mErr;

      // [TEAM-SCHEDULE-REVIEW] 관리자 검토용 — 제출 여부뿐 아니라 실제 답변 내용
      // (fields/answerText/theory/feedback)까지 함께 내려줍니다.
      const { data: subs, error: sErr } = await supabase
        .from('practice_sessions')
        .select('id, user_id, created_at, answers')
        .eq('schedule_id', scheduleId)
        .is('deleted_at', null);
      if (sErr) throw sErr;
      const subMap = {};
      (subs || []).forEach(s => { subMap[s.user_id] = s; });

      const rows = (members || []).map(m => {
        const s = subMap[m.user_id];
        return {
          userId: m.user_id,
          name: m.users?.name || '',
          email: m.users?.email || '',
          submitted: !!s,
          submittedAt: s?.created_at || null,
          sessionId: s?.id || null,
          answer: (s?.answers && s.answers[0]) || null
        };
      });

      return res.status(200).json({
        startDate: schedule.start_date,
        endDate: schedule.end_date,
        cat: schedule.cat,
        catLabel: catLabelFor(schedule.cat),
        rows
      });
}

