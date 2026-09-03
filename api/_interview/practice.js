import { waitUntil } from '@vercel/functions';
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
  isSampledForReview,
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
  getFreeTrialUsesPerCase,
  getFreeTrialUsageCounts,
  getPremiumUsesPerCase,
  getPremiumCaseUsageCounts,
  annotateSessionsWithSourceType,
  getNextSeqNo,
  verifyUser,
  getActiveMembership,
  getPracticeOnlyAccess,
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
    // [PRACTICE-DAILY-LIMIT] AI 자율연습 — 오늘 이미 완료한 카테고리 조회
    // (연습 시작 버튼을 누르기 전에 화면에서 미리 막기 위한 용도)
    // ────────────────────────────────────────────────

export async function practiceTodayStatus(req, res, requester) {
      // [FREE-TRIAL-USAGE-CAP] Free(체험판) 회원은 "오늘 완료" 여부가 아니라 "사례별
      // 총 사용 횟수 소진" 여부로 판단합니다. 필드명(caseDoneToday 등)은 프런트가
      // 그대로 재사용할 수 있도록 유지하고, freeTrialUsage/freeTrialLimit로 실제
      // 사용 현황을 함께 내려줍니다.
      const access = await getInterviewAccess(requester.id, requester.user_status);
      if (access === 'free') {
        const [usageCounts, freeTrialLimit] = await Promise.all([
          getFreeTrialUsageCounts(requester.id),
          getFreeTrialUsesPerCase()
        ]);
        return res.status(200).json({
          caseDoneToday: (usageCounts.case || 0) >= freeTrialLimit,
          ethicsDoneToday: (usageCounts.ethics || 0) >= freeTrialLimit,
          supervisionDoneToday: false,
          freeTrialUsage: usageCounts,
          freeTrialLimit
        });
      }
      const usedTodayCats = await getPracticeCatsUsedToday(requester.id);
      const result = {
        caseDoneToday: usedTodayCats.has('case'),
        ethicsDoneToday: usedTodayCats.has('ethics'),
        // [SUPERVISION-PHASE2] 수퍼비전 학습도 같은 하루 1회 규칙을 그대로 재사용합니다.
        supervisionDoneToday: usedTodayCats.has('supervision')
      };

      // [PREMIUM-CASE-POOL] Premium 회원은 하루 1회 제한과 별개로, 카테고리별로 정해진
      // 사례 풀(기본 10개) 안에서 문제당 정해진 횟수(기본 5회)까지만 평생 연습할 수
      // 있습니다. 풀 전체가 소진되면 그 카테고리는 하루 제한과 동일하게 "완료"로
      // 취급해 화면에서 자연스럽게 막습니다. 풀이 비어 있으면(모범답안 미등록 등) 판단할
      // 수 없으므로 막지 않습니다.
      if (access === 'premium') {
        const [{ pool, byQuestion }, usesPerCase] = await Promise.all([
          getPremiumCaseUsageCounts(requester.id),
          getPremiumUsesPerCase()
        ]);
        const isExhausted = (idsSet) => idsSet.size > 0
          && [...idsSet].every(qid => (byQuestion[qid] || 0) >= usesPerCase);
        const caseExhausted = isExhausted(pool.case);
        const ethicsExhausted = isExhausted(pool.ethics);
        result.premiumPool = { poolSize: pool.poolSize, usesPerCase, caseExhausted, ethicsExhausted };
        if (caseExhausted) result.caseDoneToday = true;
        if (ethicsExhausted) result.ethicsDoneToday = true;
      }

      return res.status(200).json(result);
}

    // ────────────────────────────────────────────────
    // 모의면접 세션 결과 저장
    // ────────────────────────────────────────────────

export async function save(req, res, requester) {
      // [MULTI-CERT-2] 승인(premium/admin)된 사용자만 모의면접 결과를 저장할 수 있습니다.
      const access = await getInterviewAccess(requester.id, requester.user_status);
      if (access === 'free') {
        // [FREE-TRIAL-DEFAULT-CASE] 제출된 문제 id들이 전부 관리자가 지정한 "기본
        // 사례"(사례개념화·상담윤리 각 1개, 급수 구분 없음)인 경우에만 예외로 저장을
        // 허용합니다. 그 외 문제가 하나라도 섞여 있으면 기존과 동일하게 막습니다.
        const incomingAnswers = Array.isArray(req.body.answers) ? req.body.answers : [];
        const incomingIds = incomingAnswers.map(a => a && a.questionId).filter(Boolean).map(String);
        const { data: defaultRows, error: defaultErr } = await supabase
          .from('interview_questions')
          .select('id')
          .in('cat', ['case', 'ethics'])
          .eq('is_default_case', true);
        if (defaultErr) console.error('[interview.js] 기본 사례 조회 실패:', defaultErr.message);
        const allowedDefaultIds = new Set((defaultRows || []).map(r => String(r.id)));
        const onlyDefaultCase = incomingIds.length > 0 && incomingIds.every(qid => allowedDefaultIds.has(qid));
        if (!onlyDefaultCase) {
          return res.status(403).json({
            message: '전문상담사 AI 모의면접 이용 승인이 필요합니다. "이용 승인 신청" 버튼으로 신청해주세요. (체험판은 기본 사례만 저장할 수 있습니다.)'
          });
        }
      }
      // [ACCESS-EXPIRY] 이용 기간(3개월)이 지난 경우 — 지난 연습 기록 조회는 계속
      // 가능하지만 새 저장은 막습니다.
      if (access === 'expired') {
        return res.status(403).json({
          message: '이용 기간이 만료되었습니다. 재신청 후 다시 이용해주세요. (지난 연습 기록은 계속 조회할 수 있습니다.)'
        });
      }

      const { grade, answers, avg_confidence, checklist_rate } = req.body;

      if (!Array.isArray(answers) || answers.length === 0) {
        return res.status(400).json({ message: '저장할 답변 데이터가 없습니다.' });
      }

      // [SUPERVISION-GRADE-GATE] 수퍼비전은 1급 전용입니다. 화면에서도 2급에게는
      // 버튼 자체를 숨기지만, API 직접 호출 우회를 막기 위해 저장 시점에도 재검증합니다.
      if (requester.user_status !== 'admin' && answers.some(a => a && a.cat === 'supervision')) {
        const userGrade = await getUserGrade(requester.id);
        if (userGrade !== '1') {
          return res.status(403).json({ message: '수퍼비전 학습은 1급 소속 팀만 이용할 수 있습니다.' });
        }
      }

      // [FREE-TRIAL-USAGE-CAP][PRACTICE-DAILY-LIMIT] Free(체험판) 회원은 하루 제한이
      // 아니라 사례별 총 사용 횟수(기본 5회) 제한을 받고, 그 외(Premium/관리자)는
      // 기존과 동일하게 하루에 사례개념화·상담윤리 각 1개까지만 허용합니다.
      // (화면에서도 시작 전에 막지만, 직접 API를 호출하는 우회를 막기 위해 저장 시점에도 재검증합니다.)
      const incomingCats = new Set(answers.map(a => a && a.cat).filter(Boolean));
      if (access === 'free') {
        const [usageCounts, freeTrialLimit] = await Promise.all([
          getFreeTrialUsageCounts(requester.id),
          getFreeTrialUsesPerCase()
        ]);
        // [FREE-TRIAL-OVERSHOOT-FIX] 카테고리가 "이미 상한 도달"인지만 보면, 한 번의
        // 제출(answers)에 같은 카테고리 답변이 2개 이상 섞여 들어올 때 상한을 넘겨
        // 저장될 수 있습니다(예: 4회 사용 상태에서 2개가 한꺼번에 들어오면 6회로
        // 넘어감). 그래서 카테고리별로 "이번에 들어오는 개수"까지 더해서 검사합니다.
        const incomingCountByCat = {};
        answers.forEach(a => {
          if (a && a.cat) incomingCountByCat[a.cat] = (incomingCountByCat[a.cat] || 0) + 1;
        });
        const overLimitCats = Object.keys(incomingCountByCat)
          .filter(c => (usageCounts[c] || 0) + incomingCountByCat[c] > freeTrialLimit);
        if (overLimitCats.length > 0) {
          return res.status(403).json({
            message: `무료 체험은 ${overLimitCats.map(catLabelFor).join(', ')} 각 ${freeTrialLimit}회까지 이용할 수 있습니다. "코칭 면접 코스 등록 / 승인 신청" 후 계속 이용해주세요.`
          });
        }
      } else {
        const usedTodayCats = await getPracticeCatsUsedToday(requester.id);
        const alreadyDone = [...incomingCats].filter(c => usedTodayCats.has(c));
        if (alreadyDone.length > 0) {
          return res.status(403).json({
            message: `오늘은 이미 ${alreadyDone.map(catLabelFor).join(', ')} AI 자율연습을 완료했습니다. 내일 다시 이용해 주세요.`
          });
        }

        // [PREMIUM-CASE-POOL] Premium 회원의 사례개념화·상담윤리는 관리자가 지정한
        // 풀 안의 문제별로 정해진 횟수(기본 5회)까지만 저장할 수 있습니다. 화면에서도
        // 소진된 문제를 다시 뽑지 않도록 막지만, 직접 API 호출로 우회하는 것을 막기
        // 위해 저장 시점에도 재검증합니다.
        if (access === 'premium') {
          const caseEthicsAnswers = answers.filter(a => a && (a.cat === 'case' || a.cat === 'ethics')
            && a.questionId !== undefined && a.questionId !== null);
          if (caseEthicsAnswers.length > 0) {
            const [{ pool, byQuestion }, usesPerCase] = await Promise.all([
              getPremiumCaseUsageCounts(requester.id),
              getPremiumUsesPerCase()
            ]);
            const incomingCountByQid = {};
            caseEthicsAnswers.forEach(a => {
              const qid = String(a.questionId);
              incomingCountByQid[qid] = (incomingCountByQid[qid] || 0) + 1;
            });
            const outOfPoolIds = Object.keys(incomingCountByQid)
              .filter(qid => !pool.case.has(qid) && !pool.ethics.has(qid));
            const overLimitIds = Object.keys(incomingCountByQid)
              .filter(qid => (byQuestion[qid] || 0) + incomingCountByQid[qid] > usesPerCase);
            if (outOfPoolIds.length > 0 || overLimitIds.length > 0) {
              return res.status(403).json({
                message: `이 사례는 최대 ${usesPerCase}회까지만 연습할 수 있습니다. 다른 사례를 선택해주세요.`
              });
            }
          }
        }
      }

      // [AUTO-FEEDBACK-ASYNC] 원본 답변을 먼저 즉시 저장합니다 — AI 피드백 생성을
      // 기다리지 않으므로 응답이 빨라지고, 화면의 무료 체험 사용 횟수 카운터도 그만큼
      // 빨리 반영됩니다.
      const { data: inserted, error } = await supabase.from('practice_sessions').insert({
        user_id: requester.id,
        grade: grade || null,
        answers,
        avg_confidence: avg_confidence ?? null,
        checklist_rate: checklist_rate ?? null
      }).select('id').single();

      if (error) {
        console.error('[interview.js] 세션 저장 실패:', error.message);
        throw error;
      }

      // [AUTO-FEEDBACK-ASYNC] 응답을 먼저 보낸 뒤에도 이 작업이 끝까지 실행되도록
      // waitUntil로 감쌉니다. 실패해도 원본 답변 저장은 이미 끝난 상태라 안전하며,
      // 실패 시에는 로그만 남기고 해당 답변은 피드백 없이 남습니다(관리자가 나중에
      // 수동으로 생성할 수 있습니다).
      waitUntil((async () => {
        try {
          const enrichedAnswers = await autoAttachFeedback(answers);
          const changed = JSON.stringify(enrichedAnswers) !== JSON.stringify(answers);
          if (changed) {
            const { error: updateErr } = await supabase
              .from('practice_sessions')
              .update({ answers: enrichedAnswers })
              .eq('id', inserted.id);
            if (updateErr) console.error('[interview.js] AI 피드백 백그라운드 업데이트 실패:', updateErr.message);
          }
        } catch (e) {
          console.error('[interview.js] AI 피드백 백그라운드 생성 실패:', e.message);
        }
      })());

      return res.status(200).json({ message: '저장되었습니다.' });
}

    // ────────────────────────────────────────────────
    // 본인 연습 기록 조회
    // ────────────────────────────────────────────────

export async function list(req, res, requester) {
      const { data, error } = await supabase
        .from('practice_sessions')
        .select('*')
        .eq('user_id', requester.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      // [COACHING-FEEDBACK-GATE] 코칭 면접 코스(delivery_mode='live') 소속 팀의 수련일정
      // 제출 건은, 관리자(수퍼바이저)가 실시간 세션에서 공개(release)하기 전까지 AI
      // 피드백을 수련생 화면에 보여주지 않습니다 — 세션 전에 미리 봐버리면 코칭의 의미가
      // 없어지기 때문입니다. 그 외(비동기 AI 면접 코스·AI 자율연습)는 기존과 동일하게
      // 즉시 노출됩니다.
      // [HISTORY-SOURCE-SPLIT] "연습 기록" 화면에서 AI 자율연습·코칭 면접 코스·AI 면접
      // 코스를 구분해서 볼 수 있도록 각 세션에 sourceType을 함께 내려줍니다.
      const sessions = data || [];
      const annotated = await annotateSessionsWithSourceType(sessions);
      const liveScheduleIdSet = new Set(
        annotated.filter(s => s.sourceType === 'coaching' && s.schedule_id).map(s => s.schedule_id)
      );

      const masked = annotated.map(s => {
        if (!s.schedule_id || !liveScheduleIdSet.has(s.schedule_id) || !Array.isArray(s.answers)) return s;
        const answers = s.answers.map(a => {
          if (a && a.feedback && !a.feedbackReleasedAt) {
            const { feedback, ...rest } = a;
            return { ...rest, feedbackPending: true };
          }
          return a;
        });
        return { ...s, answers };
      });

      return res.status(200).json(masked);
}

    // ────────────────────────────────────────────────
    // [STEP4-FEEDBACK-REPORT] 본인 연습 기록의 AI 피드백을 "이상해요"로 신고합니다.
    // 한 세션에 여러 문항이 담길 수 있어(사례개념화+상담윤리+수퍼비전을 한 번에
    // 연습하는 경우 등) answerIndex로 그 세션 answers 배열 중 몇 번째 문항인지
    // 함께 지정합니다.
    // ────────────────────────────────────────────────

export async function feedbackReport(req, res, requester) {
      const { sessionId, answerIndex, reason } = req.body || {};
      if (!sessionId) return res.status(400).json({ message: 'sessionId가 필요합니다.' });
      const idx = Number.isInteger(answerIndex) ? answerIndex : 0;

      // 본인 제출 기록인지 확인 — 다른 사람 기록에 신고를 걸지 못하도록 합니다.
      const { data: session, error: sessionErr } = await supabase
        .from('practice_sessions')
        .select('id, user_id, answers')
        .eq('id', sessionId)
        .is('deleted_at', null)
        .maybeSingle();
      if (sessionErr) throw sessionErr;
      if (!session || session.user_id !== requester.id) {
        return res.status(404).json({ message: '해당 기록을 찾을 수 없습니다.' });
      }

      const answer = Array.isArray(session.answers) ? session.answers[idx] : null;
      if (!answer || !answer.feedback) {
        return res.status(400).json({ message: 'AI 피드백이 아직 없는 문항은 신고할 수 없습니다.' });
      }

      const { data: existing, error: existErr } = await supabase
        .from('interview_feedback_reports')
        .select('id')
        .eq('session_id', sessionId)
        .eq('answer_index', idx)
        .is('resolved_at', null)
        .maybeSingle();
      if (existErr) throw existErr;
      if (existing) {
        return res.status(400).json({ message: '이미 신고가 접수되어 확인 중입니다.' });
      }

      const { error: insErr } = await supabase
        .from('interview_feedback_reports')
        .insert({
          session_id: sessionId,
          answer_index: idx,
          reporter_user_id: requester.id,
          reason: (typeof reason === 'string' && reason.trim()) ? reason.trim().slice(0, 500) : null
        });
      if (insErr) throw insErr;

      return res.status(200).json({ message: '신고가 접수되었습니다. 확인 후 조치하겠습니다.' });
}

    // ────────────────────────────────────────────────
    // [SOFT-DELETE] 본인 연습 기록 전체 삭제 — 실제로 DELETE하지 않고 deleted_at을
    // 채우는 소프트 삭제로 바꿨습니다. 화면(목록/일일 제한/제출 여부 등)에서는 완전히
    // 삭제된 것처럼 동작하지만, DB에는 그대로 남아 추후 분석 자료로 쓸 수 있습니다.
    // ────────────────────────────────────────────────

export async function clear(req, res, requester) {
      const { error } = await supabase
        .from('practice_sessions')
        .update({ deleted_at: new Date().toISOString(), deleted_by: requester.id })
        .eq('user_id', requester.id)
        .is('deleted_at', null);

      if (error) throw error;
      return res.status(200).json({ message: '삭제되었습니다.' });
}

    // ────────────────────────────────────────────────
    // 관리자 — 전체 회원 x 연습 기록 통계
    // ────────────────────────────────────────────────

export async function adminList(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const [{ data: users, error: uErr }, { data: sessions, error: sErr }] = await Promise.all([
        supabase.from('users').select('id, name, email').order('name', { ascending: true }),
        supabase.from('practice_sessions').select('*').is('deleted_at', null)
      ]);

      if (uErr || sErr) {
        console.error('[interview.js] admin-list 조회 실패:', (uErr || sErr).message);
        throw (uErr || sErr);
      }

      const byUser = {};
      (sessions || []).forEach(s => {
        if (!byUser[s.user_id]) byUser[s.user_id] = [];
        byUser[s.user_id].push(s);
      });

      const totalSessions = (sessions || []).length;
      const overallAvgConf = totalSessions > 0
        ? sessions.reduce((a, s) => a + Number(s.avg_confidence || 0), 0) / totalSessions
        : 0;

      const rows = (users || [])
        .map(u => {
          const list = (byUser[u.id] || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
          const count = list.length;
          const avgConf = count > 0 ? list.reduce((a, s) => a + Number(s.avg_confidence || 0), 0) / count : 0;
          const avgChk = count > 0 ? list.reduce((a, s) => a + Number(s.checklist_rate || 0), 0) / count : 0;
          const last = count > 0 ? list[0].created_at : null;
          return { name: u.name || u.email, email: u.email, count, avgConf, avgChk, last };
        })
        .filter(r => r.count > 0)
        .sort((a, b) => b.count - a.count);

      return res.status(200).json({
        totalMembers: (users || []).length,
        totalSessions,
        overallAvgConf,
        rows
      });
}

    // ────────────────────────────────────────────────
    // [RECORDS-ADMIN] 관리자 — 전체 회원 연습기록 원본 목록 (최근 300건)
    // ────────────────────────────────────────────────

export async function adminSessions(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      // [DELETE-VISIBILITY] 수련생이 "전체 기록 삭제"를 눌러도 실제로는 deleted_at만
      // 채워질 뿐 DB에는 그대로 남습니다. 기본값(includeDeleted 미지정)은 기존과 동일하게
      // 삭제된 기록을 숨기지만, 관리자가 명시적으로 요청하면(includeDeleted:true) 삭제된
      // 기록도 함께 내려줘서 필요할 때 확인할 수 있게 합니다.
      const includeDeleted = req.body && req.body.includeDeleted === true;
      let sessionsQuery = supabase
        .from('practice_sessions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(300);
      if (!includeDeleted) sessionsQuery = sessionsQuery.is('deleted_at', null);
      const { data: rawSessions, error: sErr } = await sessionsQuery;
      if (sErr) throw sErr;

      // [HISTORY-SOURCE-SPLIT] 관리자 화면에서도 AI 자율연습·코칭 면접 코스·AI 면접
      // 코스를 구분할 수 있도록 sourceType을 함께 계산합니다.
      const sessions = await annotateSessionsWithSourceType(rawSessions || []);

      const userIds = [...new Set((sessions || []).map(s => s.user_id))];
      let usersById = {};
      if (userIds.length > 0) {
        const { data: users, error: uErr } = await supabase
          .from('users')
          .select('id, name, email')
          .in('id', userIds);
        if (uErr) throw uErr;
        usersById = Object.fromEntries((users || []).map(u => [u.id, u]));
      }

      // [STEP4-FEEDBACK-REPORT][STEP3-REVIEW-QUEUE] Phase C — 수련생이 "이상해요"로
      // 신고한 미해결 건을 검토 큐에 최우선으로 편입합니다(원 로드맵 Phase 4 항목 2
      // "신고 발생 시 검토 큐 최상단 편입"). 신고된 답변은 사유 목록 맨 앞에 신고
      // 내용을 추가하고, 세션 전체를 아래에서 목록 맨 위로 정렬합니다.
      const sessionIds = (sessions || []).map(s => s.id);
      let reportsBySessionAnswer = {};
      if (sessionIds.length > 0) {
        const { data: reports, error: repErr } = await supabase
          .from('interview_feedback_reports')
          .select('session_id, answer_index, reason')
          .in('session_id', sessionIds)
          .is('resolved_at', null);
        if (repErr) throw repErr;
        (reports || []).forEach(r => {
          reportsBySessionAnswer[`${r.session_id}:${r.answer_index}`] = r.reason || null;
        });
      }

      // [STEP3-REVIEW-QUEUE] 저장된 feedbackFlags(자동 이상신호)와 사례개념화 무작위
      // 샘플링을 합쳐 답변별/세션별 "검토 필요" 여부를 계산해 함께 내려줍니다. 아직
      // feedback 자체가 없는 답변(생성 대기중)은 검토 대상에서 제외합니다 — "미작성"은
      // admin-training-overview의 별도 대기열로 이미 추적되고 있습니다. feedbackFlags가
      // 없는 답변(이 기능 배포 이전에 생성된 피드백)도 판정 대상에서 자연히 빠집니다
      // — 과거 기록을 소급 재계산하지는 않습니다.
      const rows = (sessions || []).map(s => {
        let hasReport = false;
        const answersOut = (s.answers || []).map((a, idx) => {
          if (!a || !a.feedback) return { ...a, needsReview: false, reviewReasons: [], reported: false };
          const reasons = [...(a.feedbackFlags?.reasons || [])];
          const reportKey = `${s.id}:${idx}`;
          const isReported = Object.prototype.hasOwnProperty.call(reportsBySessionAnswer, reportKey);
          if (isReported) {
            hasReport = true;
            const reportReason = reportsBySessionAnswer[reportKey];
            reasons.unshift(reportReason ? `🚩 수련생이 신고했습니다: ${reportReason}` : '🚩 수련생이 신고했습니다');
          }
          if (a.cat === 'case' && isSampledForReview(s.id, idx)) {
            reasons.push('무작위 샘플링 검토 대상입니다(사례개념화)');
          }
          return { ...a, needsReview: reasons.length > 0, reviewReasons: reasons, reported: isReported };
        });
        return {
          id: s.id,
          user_id: s.user_id,
          user_name: usersById[s.user_id]?.name || '',
          user_email: usersById[s.user_id]?.email || '(탈퇴한 회원)',
          grade: s.grade,
          answers: answersOut,
          avg_confidence: s.avg_confidence,
          checklist_rate: s.checklist_rate,
          created_at: s.created_at,
          deletedAt: s.deleted_at || null,
          sourceType: s.sourceType,
          reviewCount: answersOut.filter(a => a.needsReview).length,
          hasReport
        };
      });

      // [STEP4-FEEDBACK-REPORT] Phase C — 신고가 있는 세션을 목록 맨 위로 정렬합니다.
      // Array.prototype.sort는 안정 정렬이라 동순위(신고 유무가 같은) 항목끼리는
      // 원래의 최신순 순서가 그대로 유지됩니다.
      rows.sort((a, b) => (b.hasReport ? 1 : 0) - (a.hasReport ? 1 : 0));

      return res.status(200).json(rows);
}

    // ────────────────────────────────────────────────
    // [RECORDS-ADMIN][SOFT-DELETE] 관리자 — 연습기록 1건 삭제. 실제로 DELETE하지 않고
    // deleted_at을 채우는 소프트 삭제로 바꿨습니다 — AI 면접 코스 제출을 지워 재제출을
    // 허용해주는 용도로도 쓰이므로, 제출 여부 판단 쿼리들도 모두 deleted_at을 함께
    // 확인합니다(그래야 재제출이 막히지 않습니다). DB에는 그대로 남아 추후 분석 자료로
    // 쓸 수 있습니다.
    // ────────────────────────────────────────────────

export async function adminSessionDelete(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { id } = req.body;
      if (!id) return res.status(400).json({ message: 'id가 필요합니다.' });

      const { error } = await supabase
        .from('practice_sessions')
        .update({ deleted_at: new Date().toISOString(), deleted_by: requester.id })
        .eq('id', id)
        .is('deleted_at', null);
      if (error) throw error;
      return res.status(200).json({ message: '삭제되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [RECORDS-ADMIN] 관리자 — 연습기록 특정 답변의 내용(fields) 직접 수정.
    // AI 면접 코스 제출 검토 화면에서 수련생이 제출한 답변을 관리자가
    // 고쳐줘야 할 때 사용합니다. answerText는 fields로부터 다시 계산해
    // 저장하고, 내용이 바뀌었으므로 기존에 생성돼 있던 AI 피드백은
    // 비워서(다시 생성하도록) 최신 상태로 유지합니다.
    // ────────────────────────────────────────────────

export async function adminSessionAnswerUpdate(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { sessionId, answerIndex, fields } = req.body;
      if (!sessionId) return res.status(400).json({ message: 'sessionId가 필요합니다.' });
      if (typeof answerIndex !== 'number' || answerIndex < 0) {
        return res.status(400).json({ message: 'answerIndex가 필요합니다.' });
      }
      if (!Array.isArray(fields) || fields.length === 0) {
        return res.status(400).json({ message: '수정할 답변 내용이 없습니다.' });
      }

      const { data: session, error: sessErr } = await supabase
        .from('practice_sessions')
        .select('answers')
        .eq('id', sessionId)
        .is('deleted_at', null)
        .maybeSingle();
      if (sessErr) throw sessErr;
      if (!session) return res.status(404).json({ message: '연습기록을 찾을 수 없습니다.' });

      const answers = Array.isArray(session.answers) ? session.answers : [];
      if (!answers[answerIndex]) {
        return res.status(400).json({ message: '해당 번호의 답변을 찾을 수 없습니다.' });
      }

      const cleanFields = fields.map(f => ({
        key: String(f.key ?? ''),
        label: String(f.label ?? ''),
        value: String(f.value ?? '').trim()
      }));
      const answerText = cleanFields.map(f => `${f.label}: ${f.value || '(미작성)'}`).join('\n');

      answers[answerIndex] = {
        ...answers[answerIndex],
        fields: cleanFields,
        answerText,
        feedback: null
      };

      const { error: updErr } = await supabase
        .from('practice_sessions')
        .update({ answers })
        .eq('id', sessionId);
      if (updErr) throw updErr;

      return res.status(200).json({ message: '수정되었습니다.', answer: answers[answerIndex] });
}

    // ────────────────────────────────────────────────
    // [AI-FEEDBACK] 관리자 — 저장된 모범답안과 비교한 AI 피드백 생성
    // 특정 연습기록(practice_sessions)의 특정 답변(answers[answerIndex])을
    // 대상으로, 등록된 모범답안(상담윤리: 문제당 1개 / 사례개념화: 선택된
    // 상담이론에 해당하는 모범답안)과 비교하여 Claude로 피드백을 생성하고
    // 그 결과를 해당 연습기록에 저장합니다(수련생도 자신의 연습 기록에서
    // 이후 다시 확인할 수 있습니다).
    // ────────────────────────────────────────────────

export async function adminGenerateFeedback(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }
      if (!GEMINI_API_KEY) {
        console.error('[interview.js] GEMINI_API_KEY 환경변수 누락');
        return res.status(500).json({ message: '서버에 AI 기능이 설정되어 있지 않습니다. 관리자에게 문의해주세요.' });
      }

      const { sessionId, answerIndex } = req.body;
      if (!sessionId) return res.status(400).json({ message: 'sessionId가 필요합니다.' });
      if (typeof answerIndex !== 'number' || answerIndex < 0) {
        return res.status(400).json({ message: 'answerIndex가 필요합니다.' });
      }

      const { data: session, error: sessErr } = await supabase
        .from('practice_sessions')
        .select('answers')
        .eq('id', sessionId)
        .is('deleted_at', null)
        .single();
      if (sessErr || !session) {
        return res.status(404).json({ message: '연습기록을 찾을 수 없습니다.' });
      }

      const answers = Array.isArray(session.answers) ? session.answers : [];
      const target = answers[answerIndex];
      if (!target) {
        return res.status(400).json({ message: '해당 번호의 답변을 찾을 수 없습니다.' });
      }
      if (!target.questionId) {
        return res.status(400).json({
          message: '이 답변에는 문제 ID 정보가 없어 모범답안을 찾을 수 없습니다 (기능 추가 이전에 저장된 기록으로 보입니다).'
        });
      }

      let feedbackText, feedbackFlags;
      try {
        const result = await generateFeedbackForAnswer(target);
        feedbackText = result.feedbackText;
        feedbackFlags = result.flags;
      } catch (e) {
        if (e.isGeminiError) {
          console.error('[interview.js] Gemini 호출 예외:', e.message);
          return res.status(502).json({ message: 'AI 피드백 생성 요청이 실패했습니다.' });
        }
        return res.status(400).json({ message: e.message || 'AI 피드백 생성 중 오류가 발생했습니다.' });
      }

      answers[answerIndex] = {
        ...target,
        feedback: feedbackText,
        feedbackGeneratedAt: new Date().toISOString(),
        feedbackFlags
      };

      const { error: updateErr } = await supabase
        .from('practice_sessions')
        .update({ answers })
        .eq('id', sessionId);
      if (updateErr) throw updateErr;

      // [STEP3-REVIEW-QUEUE] 관리자가 방금 생성한 피드백을 다시 새로고침하지 않아도
      // 바로 검토 필요 여부를 볼 수 있도록 flags도 함께 내려줍니다.
      return res.status(200).json({ message: '피드백이 생성되었습니다.', feedback: feedbackText, feedbackFlags });
}

    // ────────────────────────────────────────────────
    // [STEP4-FEEDBACK-REPORT] 관리자 — 미해결 신고 목록 (수련생이 "이상해요"로 신고한
    // AI 피드백들). 세션에 여러 문항이 담길 수 있어 answer_index로 정확히 어느
    // 문항인지 지정합니다.
    // ────────────────────────────────────────────────

export async function adminFeedbackReportsList(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { data: reports, error: repErr } = await supabase
        .from('interview_feedback_reports')
        .select('id, session_id, answer_index, reason, created_at')
        .is('resolved_at', null)
        .order('created_at', { ascending: true });
      if (repErr) throw repErr;

      if (!reports || reports.length === 0) return res.status(200).json([]);

      const sessionIds = [...new Set(reports.map(r => r.session_id))];
      const { data: sessions, error: sessErr } = await supabase
        .from('practice_sessions')
        .select('id, user_id, answers')
        .in('id', sessionIds);
      if (sessErr) throw sessErr;
      const sessionById = {};
      (sessions || []).forEach(s => { sessionById[s.id] = s; });

      const userIds = [...new Set((sessions || []).map(s => s.user_id).filter(Boolean))];
      let userById = {};
      if (userIds.length > 0) {
        const { data: users, error: userErr } = await supabase
          .from('users')
          .select('id, name, email')
          .in('id', userIds);
        if (userErr) throw userErr;
        (users || []).forEach(u => { userById[u.id] = u; });
      }

      const rows = reports.map(r => {
        const session = sessionById[r.session_id];
        const answer = session && Array.isArray(session.answers) ? session.answers[r.answer_index] : null;
        const user = session ? userById[session.user_id] : null;
        return {
          id: r.id,
          sessionId: r.session_id,
          answerIndex: r.answer_index,
          reason: r.reason,
          createdAt: r.created_at,
          studentName: user?.name || '',
          studentEmail: user?.email || '(탈퇴한 회원)',
          catLabel: answer?.catLabel || null,
          question: answer?.q || '',
          answerText: answer?.answerText || '',
          feedback: answer?.feedback || ''
        };
      });

      return res.status(200).json(rows);
}

    // ────────────────────────────────────────────────
    // [STEP4-FEEDBACK-REPORT] 관리자 — 신고 처리 완료 표시
    // ────────────────────────────────────────────────

export async function adminFeedbackReportResolve(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { reportId } = req.body || {};
      if (!reportId) return res.status(400).json({ message: 'reportId가 필요합니다.' });

      const { error } = await supabase
        .from('interview_feedback_reports')
        .update({ resolved_at: new Date().toISOString(), resolved_by: requester.id })
        .eq('id', reportId)
        .is('resolved_at', null);
      if (error) throw error;

      return res.status(200).json({ message: '처리 완료로 표시했습니다.' });
}

    // ────────────────────────────────────────────────
    // [STEP5-COACHING] 관리자(수퍼바이저) — 코칭(실시간) 팀 소속 제출 건 중 아직
    // 공개(release)하지 않은 AI 피드백 대기열을 조회합니다. 실시간 세션에서 수련생과
    // 함께 확인하며 하나씩 공개하는 용도입니다.
    // ────────────────────────────────────────────────

export async function adminLiveFeedbackQueue(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { data: liveTeams, error: liveTeamsErr } = await supabase
        .from('interview_teams')
        .select('id, name')
        .eq('delivery_mode', 'live')
        .eq('status', 'active');
      if (liveTeamsErr) throw liveTeamsErr;
      if (!liveTeams || liveTeams.length === 0) return res.status(200).json([]);

      const liveTeamIds = liveTeams.map(t => t.id);
      const teamNameById = {};
      liveTeams.forEach(t => { teamNameById[t.id] = t.name; });

      const { data: schedRows, error: schedErr } = await supabase
        .from('interview_team_schedule')
        .select('id, team_id, cat, question_id, interview_questions(question, seq_no, topic)')
        .in('team_id', liveTeamIds);
      if (schedErr) throw schedErr;
      if (!schedRows || schedRows.length === 0) return res.status(200).json([]);

      const scheduleIds = schedRows.map(r => r.id);
      const scheduleById = {};
      schedRows.forEach(r => { scheduleById[r.id] = r; });

      const { data: sessions, error: sessErr } = await supabase
        .from('practice_sessions')
        .select('id, schedule_id, user_id, answers, created_at')
        .in('schedule_id', scheduleIds)
        .is('deleted_at', null);
      if (sessErr) throw sessErr;

      const pending = (sessions || []).filter(s => {
        const a = Array.isArray(s.answers) ? s.answers[0] : null;
        return !!(a && a.feedback && !a.feedbackReleasedAt);
      });
      if (pending.length === 0) return res.status(200).json([]);

      const userIds = [...new Set(pending.map(s => s.user_id).filter(Boolean))];
      let userById = {};
      if (userIds.length > 0) {
        const { data: users, error: userErr } = await supabase
          .from('users')
          .select('id, name, email')
          .in('id', userIds);
        if (userErr) throw userErr;
        (users || []).forEach(u => { userById[u.id] = u; });
      }

      const rows = pending.map(s => {
        const sched = scheduleById[s.schedule_id];
        const answer = s.answers[0];
        const user = userById[s.user_id];
        return {
          sessionId: s.id,
          teamId: sched?.team_id || null,
          teamName: sched ? (teamNameById[sched.team_id] || '') : '',
          studentName: user?.name || '',
          studentEmail: user?.email || '(탈퇴한 회원)',
          cat: sched?.cat || answer.cat,
          catLabel: catLabelFor(sched?.cat || answer.cat),
          question: sched?.interview_questions?.question || answer.q || '',
          answerText: answer.answerText || '',
          feedback: answer.feedback || '',
          createdAt: s.created_at
        };
      }).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      return res.status(200).json(rows);
}

    // ────────────────────────────────────────────────
    // [STEP5-COACHING] 관리자(수퍼바이저) — 코칭(실시간) 팀 제출 건의 AI 피드백을
    // 수련생 화면에 공개합니다(필요하면 공개 전에 내용을 수정할 수 있습니다).
    // ────────────────────────────────────────────────

export async function adminLiveFeedbackRelease(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { sessionId, editedFeedback } = req.body || {};
      if (!sessionId) return res.status(400).json({ message: 'sessionId가 필요합니다.' });

      const { data: session, error: sessionErr } = await supabase
        .from('practice_sessions')
        .select('id, schedule_id, answers')
        .eq('id', sessionId)
        .maybeSingle();
      if (sessionErr) throw sessionErr;
      if (!session) return res.status(404).json({ message: '해당 기록을 찾을 수 없습니다.' });
      if (!session.schedule_id) {
        return res.status(400).json({ message: 'AI 자율연습 기록은 공개 대상이 아닙니다.' });
      }

      const { data: sched, error: schedErr } = await supabase
        .from('interview_team_schedule')
        .select('id, team_id')
        .eq('id', session.schedule_id)
        .maybeSingle();
      if (schedErr) throw schedErr;
      if (!sched) return res.status(400).json({ message: '수련일정을 찾을 수 없습니다.' });

      const { data: team, error: teamErr } = await supabase
        .from('interview_teams')
        .select('id, delivery_mode')
        .eq('id', sched.team_id)
        .maybeSingle();
      if (teamErr) throw teamErr;
      if (!team || team.delivery_mode !== 'live') {
        return res.status(400).json({ message: '코칭(실시간) 팀 소속 제출 건이 아닙니다.' });
      }

      const answers = Array.isArray(session.answers) ? [...session.answers] : [];
      const ans0 = answers[0];
      if (!ans0 || !ans0.feedback) {
        return res.status(400).json({ message: 'AI 피드백이 아직 생성되지 않았습니다.' });
      }

      const updatedAnswer = { ...ans0 };
      if (typeof editedFeedback === 'string' && editedFeedback.trim()) {
        updatedAnswer.feedback = editedFeedback.trim();
      }
      updatedAnswer.feedbackReleasedAt = ans0.feedbackReleasedAt || new Date().toISOString();
      answers[0] = updatedAnswer;

      const { error: updErr } = await supabase
        .from('practice_sessions')
        .update({ answers })
        .eq('id', sessionId);
      if (updErr) throw updErr;

      return res.status(200).json({ message: '수련생에게 피드백이 공개되었습니다.' });
}

