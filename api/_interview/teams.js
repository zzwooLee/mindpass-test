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
  revokeCoachingSubscriptionIfNoLiveTeam,
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
    // [TEAM-MGMT] 관리자 — 팀 목록 (활성/해체 전체, 멤버 수 포함)
    // ────────────────────────────────────────────────

export async function adminTeamsList(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { data: teams, error: tErr } = await supabase
        .from('interview_teams')
        .select('*')
        .order('created_at', { ascending: false });
      if (tErr) throw tErr;

      const { data: members, error: mErr } = await supabase
        .from('interview_team_members')
        .select('team_id')
        .is('removed_at', null);
      if (mErr) throw mErr;

      const countByTeam = {};
      (members || []).forEach(m => { countByTeam[m.team_id] = (countByTeam[m.team_id] || 0) + 1; });

      const rows = (teams || []).map(t => ({ ...t, memberCount: countByTeam[t.id] || 0 }));
      return res.status(200).json(rows);
}

    // ────────────────────────────────────────────────
    // [TEAM-MGMT] 관리자 — 팀 생성
    // ────────────────────────────────────────────────

export async function adminTeamCreate(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { name, startDate, endDate, grade, questionCount, deliveryMode } = req.body;
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ message: '팀 이름이 필요합니다.' });
      }

      const row = {
        name: name.trim(),
        start_date: startDate || null,
        end_date: endDate || null,
        status: 'active',
        created_by: requester.id
      };

      // [TEAM-SETTINGS] 급수/문항 수 — 안 보내면 DB 기본값(2급 · 4문항) 사용
      if (grade !== undefined) {
        if (!['1', '2'].includes(String(grade))) {
          return res.status(400).json({ message: 'grade는 1 또는 2여야 합니다.' });
        }
        row.grade = String(grade);
      }
      if (questionCount !== undefined) {
        const qc = parseInt(questionCount, 10);
        if (isNaN(qc) || qc < 1 || qc > 15) {
          return res.status(400).json({ message: 'questionCount는 1~15 사이의 정수여야 합니다.' });
        }
        row.question_count = qc;
      }

      // [COACHING-DELIVERY-MODE] 전달 방식 — 기본은 비동기(async, 기존 방식과 동일).
      // "live"로 지정하면 코칭 면접 코스처럼 AI 피드백이 제출 즉시 공개되지 않고,
      // 관리자(수퍼바이저)가 실시간 세션에서 공개(release)하기 전까지 보류됩니다.
      if (deliveryMode !== undefined) {
        if (!['async', 'live'].includes(deliveryMode)) {
          return res.status(400).json({ message: 'deliveryMode는 async 또는 live여야 합니다.' });
        }
        row.delivery_mode = deliveryMode;
      }

      // [PRACTICE-TIME-ADMIN-ONLY] 준비/답변 제한시간은 더 이상 팀별로 지정하지 않고,
      // 관리자가 설정한 전체 공통 값을 그대로 씁니다(getPracticeTimeSettings 참고).

      const { error } = await supabase.from('interview_teams').insert(row);
      if (error) throw error;

      return res.status(200).json({ message: '팀이 생성되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [TEAM-SETTINGS] 관리자 — 기존 팀의 급수/문항 수 수정
    // [PRACTICE-TIME-ADMIN-ONLY] 준비/답변 제한시간은 더 이상 팀별로 지정하지 않습니다 —
    // 전체 공통 값은 '⏱️ 연습 시간 설정' 카드(admin-practice-times-update)에서 관리합니다.
    // ────────────────────────────────────────────────

export async function adminTeamUpdateSettings(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { teamId, grade, questionCount, deliveryMode } = req.body;
      if (!teamId) return res.status(400).json({ message: 'teamId가 필요합니다.' });
      if (!['1', '2'].includes(String(grade))) {
        return res.status(400).json({ message: 'grade는 1 또는 2여야 합니다.' });
      }
      const qc = parseInt(questionCount, 10);
      if (isNaN(qc) || qc < 1 || qc > 15) {
        return res.status(400).json({ message: 'questionCount는 1~15 사이의 정수여야 합니다.' });
      }

      const updateRow = { grade: String(grade), question_count: qc };
      // [COACHING-DELIVERY-MODE] 전달 방식은 값이 넘어올 때만 변경합니다 — 안 보내면 기존 값 유지.
      // [COURSE-SHARED-TEAM] AI 면접 코스 공통 일정 팀(team_type='course_shared')은
      // 급수별로 하나뿐인 공용 인프라라 실시간(코칭)으로 바꾸면 그 순간 모든 AI 면접
      // 코스 이용자의 피드백이 한꺼번에 보류되므로, 이 팀은 항상 비동기(async)로
      // 고정하고 실수로 live로 바뀌지 못하게 막습니다.
      if (deliveryMode !== undefined) {
        if (!['async', 'live'].includes(deliveryMode)) {
          return res.status(400).json({ message: 'deliveryMode는 async 또는 live여야 합니다.' });
        }
        if (deliveryMode === 'live') {
          const { data: teamTypeRow, error: teamTypeErr } = await supabase
            .from('interview_teams')
            .select('team_type')
            .eq('id', teamId)
            .maybeSingle();
          if (teamTypeErr) throw teamTypeErr;
          if (teamTypeRow?.team_type === 'course_shared') {
            return res.status(400).json({ message: 'AI 면접 코스 공통 일정 팀은 전달 방식을 코칭(실시간)으로 바꿀 수 없습니다.' });
          }
        }
        updateRow.delivery_mode = deliveryMode;
      }

      const { error } = await supabase
        .from('interview_teams')
        .update(updateRow)
        .eq('id', teamId);
      if (error) throw error;

      return res.status(200).json({ message: '설정이 저장되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [TEAM-MGMT] 관리자 — 팀 해체 (소속 회원 전원 즉시 이용 제한)
    // ────────────────────────────────────────────────

export async function adminTeamDissolve(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { teamId } = req.body;
      if (!teamId) return res.status(400).json({ message: 'teamId가 필요합니다.' });

      // [COURSE-SHARED-TEAM] AI 면접 코스 공통 일정 팀은 개별 회원 관리 대상이
      // 아니라 급수별로 하나뿐인 공용 인프라이므로, 통째로 해체할 수 없게 막습니다
      // (해체 시 그 순간의 모든 AI 면접 코스 이용자가 한꺼번에 접근을 잃게 됨).
      // 특정 이용자만 제외하려면 "멤버 관리"에서 개별적으로 제거해주세요.
      const { data: teamTypeRow, error: teamTypeErr } = await supabase
        .from('interview_teams')
        .select('team_type, delivery_mode')
        .eq('id', teamId)
        .maybeSingle();
      if (teamTypeErr) throw teamTypeErr;
      if (teamTypeRow?.team_type === 'course_shared') {
        return res.status(400).json({ message: 'AI 면접 코스 공통 일정 팀은 해체할 수 없습니다. 특정 회원만 제외하려면 "멤버 관리"에서 개별적으로 제거해주세요.' });
      }

      // [COACHING-FLAG-SYNC] 해체로 제거될 회원 목록을 먼저 조회해둡니다 — 해체 후에는
      // removed_at이 이미 채워져 있어 "이 팀 소속이었던 회원"을 가려내기 번거롭습니다.
      let affectedUserIds = [];
      if (teamTypeRow?.delivery_mode === 'live') {
        const { data: activeMembers, error: activeMembersErr } = await supabase
          .from('interview_team_members')
          .select('user_id')
          .eq('team_id', teamId)
          .is('removed_at', null);
        if (activeMembersErr) {
          console.error('[interview.js] 해체 전 팀원 조회 실패(Premium 되돌리기 생략):', activeMembersErr.message);
        } else {
          affectedUserIds = (activeMembers || []).map(m => m.user_id);
        }
      }

      const now = new Date().toISOString();

      const { error: teamErr } = await supabase
        .from('interview_teams')
        .update({ status: 'dissolved', dissolved_at: now })
        .eq('id', teamId);
      if (teamErr) throw teamErr;

      const { error: memberErr } = await supabase
        .from('interview_team_members')
        .update({ removed_at: now })
        .eq('team_id', teamId)
        .is('removed_at', null);
      if (memberErr) throw memberErr;

      // [COACHING-FLAG-SYNC] 코칭(실시간) 팀 해체 시, 방금 제거된 회원들 중 다른
      // 활성 코칭 팀 소속이 없는 경우 Premium 플래그를 Free로 되돌립니다.
      for (const uid of affectedUserIds) {
        await revokeCoachingSubscriptionIfNoLiveTeam(uid);
      }

      return res.status(200).json({ message: '팀이 해체되었습니다. 소속 회원의 이용이 제한됩니다.' });
}

    // ────────────────────────────────────────────────
    // [TEAM-MGMT] 관리자 — 팀 완전 삭제 (목록에서 아예 제거)
    // 이미 해체된(status='dissolved') 팀만 삭제할 수 있습니다 — 활성 팀은 먼저 "해체"를
    // 거쳐야 합니다. 소속 멤버·수련일정(interview_team_schedule)은 DB 외래키 cascade로
    // 함께 삭제되고, 이미 제출된 답변(practice_sessions)은 schedule_id만 null로 바뀌며
    // 기록 자체는 남습니다. interview_pending_members.assigned_team_id는 cascade가 없어
    // 미리 null로 비워둡니다.
    // ────────────────────────────────────────────────

export async function adminTeamDelete(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { teamId } = req.body;
      if (!teamId) return res.status(400).json({ message: 'teamId가 필요합니다.' });

      const { data: team, error: findErr } = await supabase
        .from('interview_teams')
        .select('id, status')
        .eq('id', teamId)
        .maybeSingle();
      if (findErr) throw findErr;
      if (!team) return res.status(404).json({ message: '팀을 찾을 수 없습니다.' });
      if (team.status === 'active') {
        return res.status(400).json({ message: '활성 상태인 팀은 삭제할 수 없습니다. 먼저 "해체"를 진행해주세요.' });
      }

      const { error: pendingErr } = await supabase
        .from('interview_pending_members')
        .update({ assigned_team_id: null })
        .eq('assigned_team_id', teamId);
      if (pendingErr) throw pendingErr;

      const { error: delErr } = await supabase
        .from('interview_teams')
        .delete()
        .eq('id', teamId);
      if (delErr) throw delErr;

      return res.status(200).json({ message: '팀이 삭제되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [TEAM-MGMT] 관리자 — 팀 상세 (현재 소속 멤버 목록)
    // ────────────────────────────────────────────────

export async function adminTeamMembers(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { teamId } = req.body;
      if (!teamId) return res.status(400).json({ message: 'teamId가 필요합니다.' });

      const { data, error } = await supabase
        .from('interview_team_members')
        .select('id, user_id, added_at, users(name, email)')
        .eq('team_id', teamId)
        .is('removed_at', null)
        .order('added_at', { ascending: true });
      if (error) throw error;

      const rows = (data || []).map(r => ({
        userId: r.user_id,
        name: r.users?.name || '',
        email: r.users?.email || '',
        addedAt: r.added_at
      }));
      return res.status(200).json(rows);
}

    // ────────────────────────────────────────────────
    // [TEAM-MGMT] 관리자 — 팀에 멤버 배정(기존 소속 팀이 있으면 자동 이동)
    // ────────────────────────────────────────────────

export async function adminTeamMemberAdd(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { teamId, userId } = req.body;
      if (!teamId || !userId) {
        return res.status(400).json({ message: 'teamId와 userId가 필요합니다.' });
      }

      try {
        await assignUserToTeam(userId, teamId, requester.id);
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }

      return res.status(200).json({ message: '배정되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [TEAM-MGMT] 관리자 — 팀에서 멤버 제거 (팀 해체 없이 개별 제거)
    // ────────────────────────────────────────────────

export async function adminTeamMemberRemove(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { teamId, userId } = req.body;
      if (!teamId || !userId) {
        return res.status(400).json({ message: 'teamId와 userId가 필요합니다.' });
      }

      // [COACHING-FLAG-SYNC] 제거되는 팀이 코칭(실시간)인지 먼저 확인해둡니다 —
      // 그래야 제거 후 Premium 플래그를 되돌릴지 판단할 수 있습니다.
      const { data: teamRow, error: teamRowErr } = await supabase
        .from('interview_teams')
        .select('delivery_mode')
        .eq('id', teamId)
        .maybeSingle();
      if (teamRowErr) throw teamRowErr;

      const { error } = await supabase
        .from('interview_team_members')
        .update({ removed_at: new Date().toISOString() })
        .eq('team_id', teamId)
        .eq('user_id', userId)
        .is('removed_at', null);
      if (error) throw error;

      if (teamRow?.delivery_mode === 'live') {
        await revokeCoachingSubscriptionIfNoLiveTeam(userId);
      }

      return res.status(200).json({ message: '제거되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [TEAM-MGMT] 관리자 — 결제 확인 후 팀 배정 대기 목록
    // (Slack에서 관리자가 승인 버튼을 누르면 slack-action.js가 여기에 기록합니다)
    // ────────────────────────────────────────────────

export async function adminPendingMembersList(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { data, error } = await supabase
        .from('interview_pending_members')
        .select('id, user_id, confirmed_at, requested_grade, requested_tier, users(name, email)')
        .is('assigned_at', null)
        .order('confirmed_at', { ascending: true });
      if (error) throw error;

      const rows = (data || []).map(r => ({
        id: r.id,
        userId: r.user_id,
        name: r.users?.name || '',
        email: r.users?.email || '(탈퇴한 회원)',
        confirmedAt: r.confirmed_at,
        requestedGrade: r.requested_grade || null,
        // [STEP5-COACHING] 'coaching'이면 코칭 면접 코스(소그룹 팀 신규 배정 필요),
        // 그 외(null 포함)는 AI 면접 코스 공통 일정 팀 배정 실패 시의 폴백입니다.
        requestedTier: r.requested_tier || 'course'
      }));
      return res.status(200).json(rows);
}

    // ────────────────────────────────────────────────
    // [TEAM-MGMT] 관리자 — 대기 중인 결제확인 건을 팀에 배정
    // ────────────────────────────────────────────────

export async function adminPendingMemberAssign(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { pendingId, teamId } = req.body;
      if (!pendingId || !teamId) {
        return res.status(400).json({ message: 'pendingId와 teamId가 필요합니다.' });
      }

      const { data: pending, error: pErr } = await supabase
        .from('interview_pending_members')
        .select('id, user_id, requested_tier, requested_grade, users(name, email)')
        .eq('id', pendingId)
        .is('assigned_at', null)
        .maybeSingle();
      if (pErr) throw pErr;
      if (!pending) return res.status(404).json({ message: '대기 중인 건을 찾을 수 없습니다(이미 처리되었을 수 있습니다).' });

      const { data: team, error: tErr } = await supabase
        .from('interview_teams')
        .select('id, name, status')
        .eq('id', teamId)
        .maybeSingle();
      if (tErr) throw tErr;
      if (!team) return res.status(400).json({ message: '존재하지 않는 팀입니다.' });

      try {
        await assignUserToTeam(pending.user_id, teamId, requester.id);
      } catch (e) {
        return res.status(400).json({ message: e.message });
      }

      const now = new Date().toISOString();
      const { error: updErr } = await supabase
        .from('interview_pending_members')
        .update({ assigned_team_id: teamId, assigned_at: now })
        .eq('id', pendingId);
      if (updErr) throw updErr;

      if (pending.users?.email) {
        await sendTeamAssignmentEmail({
          to: pending.users.email,
          userName: pending.users.name,
          teamName: team.name,
          requestedTier: pending.requested_tier,
          requestedGrade: pending.requested_grade
        });
      }

      return res.status(200).json({ message: `"${team.name}" 팀에 배정되었습니다.` });
}

    // ────────────────────────────────────────────────
    // [TEAM-MGMT] 관리자 — 대기 목록에서 제외(배정하지 않고 종료)
    // ────────────────────────────────────────────────

export async function adminPendingMemberDismiss(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { pendingId } = req.body;
      if (!pendingId) return res.status(400).json({ message: 'pendingId가 필요합니다.' });

      const { error } = await supabase
        .from('interview_pending_members')
        .update({ assigned_at: new Date().toISOString(), assigned_team_id: null })
        .eq('id', pendingId)
        .is('assigned_at', null);
      if (error) throw error;

      return res.status(200).json({ message: '대기 목록에서 제외되었습니다.' });
}

