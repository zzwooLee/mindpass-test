import {
  supabase,
  getContactEmail,
  getBankAccountInfo,
  getCoachingCourseSchedule,
  getCoachingPromoBannerText,
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
  FREE_TRIAL_USES_PER_CASE_KEY,
  FREE_TRIAL_USES_PER_CASE_DEFAULT,
  PREMIUM_CASE_POOL_SIZE_KEY,
  PREMIUM_CASE_POOL_SIZE_DEFAULT,
  PREMIUM_USES_PER_CASE_KEY,
  PREMIUM_USES_PER_CASE_DEFAULT,
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
    // [TEAM-SETTINGS] 내 소속 팀의 응시 급수 / 문항 수 조회
    // (연습 설정 화면에 표시용 — 수련생은 값을 고르지 않고 이 값을 그대로 봅니다)
    // 소속 팀이 없는 경우(관리자 등)는 기본값(2급 · 4문항)을 반환합니다.
    // ────────────────────────────────────────────────

export async function mySettings(req, res, requester) {
      const { data: membership, error: mErr } = await supabase
        .from('interview_team_members')
        .select('interview_teams(name, grade, question_count, status)')
        .eq('user_id', requester.id)
        .is('removed_at', null)
        .maybeSingle();
      if (mErr) throw mErr;

      const team = membership?.interview_teams;
      if (team && team.status === 'active') {
        return res.status(200).json({
          teamName: team.name,
          grade: team.grade,
          questionCount: team.question_count
        });
      }

      // [PRACTICE-ONLY] 팀 소속이 없으면 AI 자율연습 단독 신청 승인 여부를 확인해
      // 급수를 그대로 반영합니다(기본값 '2'로 잘못 표시되는 것을 방지).
      const practiceOnly = await getPracticeOnlyAccess(requester.id);
      if (practiceOnly && !practiceOnly.isExpired) {
        return res.status(200).json({
          teamName: null,
          grade: practiceOnly.grade || '2',
          questionCount: 4,
          practiceOnly: true
        });
      }
      return res.status(200).json({ teamName: null, grade: '2', questionCount: 4 });
}

    // ────────────────────────────────────────────────
    // [FEATURE-FLAGS] 로그인한 회원 누구나 — 탭별 사용 여부 조회.
    // interview.html이 로그인 직후 이 값을 받아 꺼진 탭의 메뉴를 숨기고
    // 진입을 막습니다. 관리자 계정은 클라이언트에서 이 값과 무관하게
    // 항상 모든 탭에 접근할 수 있도록 처리합니다(꺼진 탭도 관리 목적으로
    // 계속 사용 가능).
    // ────────────────────────────────────────────────

export async function featureFlags(req, res, requester) {
      // [PRACTICE-TIME-ADMIN-ONLY] value_seconds도 함께 받아옵니다 — 사례개념화·상담윤리·
      // 수퍼비전 준비/답변 시간(초)은 boolean이 아니라 이 컬럼에 저장됩니다.
      const { data, error } = await supabase
        .from('interview_feature_flags')
        .select('key, enabled, value_seconds');
      if (error) throw error;

      // [QBANK-ADMIN-ONLY] "질문은행"은 더 이상 이 목록에 포함하지 않습니다 — 수련생 화면에서는
      // 항상 숨기고 관리자에게만 고정 노출합니다 (interview.html의 isNavTabVisibleForCurrentUser 참고).
      const flags = {
        practice: true, schedule: true, coaching: true, history: true, guide: true,
        // [DOWNLOAD-BTN-TOGGLE] 모의면접 완료 화면의 "결과 텍스트로 저장" 버튼 노출 여부.
        showDownloadResultBtn: true,
        // [ANSWER-MODE] 카테고리별 구조형/통합형 답안 모드 전체 기본값 — AI 자율연습용과
        // AI 면접 코스용을 따로 설정할 수 있습니다(문제별/배정별로 다시 재정의 가능).
        modeCasePracticeStructured: true, modeCasePracticeFreeform: true,
        modeEthicsPracticeStructured: true, modeEthicsPracticeFreeform: true,
        modeCaseTeamStructured: true, modeCaseTeamFreeform: true,
        modeEthicsTeamStructured: true, modeEthicsTeamFreeform: true,
        // [PRACTICE-TIME-ADMIN-ONLY] AI 자율연습·AI 면접 코스 공통 준비/답변 시간(초) — 수련생은
        // 더 이상 조정할 수 없고, 관리자가 설정한 전체 공통 값을 그대로 씁니다.
        ...PRACTICE_TIME_DEFAULTS,
        // [AUTO-FEEDBACK] 카테고리별 제출 시 AI 피드백 자동 생성 여부.
        ...AUTO_FEEDBACK_DEFAULTS,
        // [AI-DRAFT-QUEUE] 카테고리별 신규 문제 등록 시 모범답안 초안 자동 생성 여부.
        ...AUTO_DRAFT_DEFAULTS,
        // [SCHEDULE-MIN-INTERVAL] AI 면접 코스 문항 간 최소 제출 간격(일).
        [SCHEDULE_MIN_INTERVAL_KEY]: SCHEDULE_MIN_INTERVAL_DEFAULT,
        // [FREE-TRIAL-USAGE-CAP] Free 회원의 기본 사례(사례개념화/상담윤리) 각각의
        // 최대 사용 횟수(하루 제한이 아니라 평생 누적 상한).
        [FREE_TRIAL_USES_PER_CASE_KEY]: FREE_TRIAL_USES_PER_CASE_DEFAULT,
        // [PREMIUM-CASE-POOL] Premium 회원의 사례개념화/상담윤리 카테고리별 사례 풀
        // 크기, 그리고 사례 하나당 최대 사용 횟수(하루 제한이 아니라 평생 누적 상한).
        [PREMIUM_CASE_POOL_SIZE_KEY]: PREMIUM_CASE_POOL_SIZE_DEFAULT,
        [PREMIUM_USES_PER_CASE_KEY]: PREMIUM_USES_PER_CASE_DEFAULT,
      };

      (data || []).forEach(r => {
        if (!(r.key in flags)) return;
        if (PRACTICE_TIME_KEYS.includes(r.key) || r.key === SCHEDULE_MIN_INTERVAL_KEY || r.key === FREE_TRIAL_USES_PER_CASE_KEY
          || r.key === PREMIUM_CASE_POOL_SIZE_KEY || r.key === PREMIUM_USES_PER_CASE_KEY) {
          if (r.value_seconds !== null && r.value_seconds !== undefined) flags[r.key] = r.value_seconds;
        } else {
          flags[r.key] = !!r.enabled;
        }
      });
      // [BANK-ACCOUNT-INFO] 코칭 면접 코스 신청 모달에서 안내할 입금 계좌 정보 —
      // interview_feature_flags가 아니라 app_settings(관리자 [설정] 메뉴)에서 관리합니다.
      flags.bankAccount = await getBankAccountInfo();
      flags.coachingCourseSchedule = await getCoachingCourseSchedule();
      flags.coachingPromoBannerText = await getCoachingPromoBannerText();
      return res.status(200).json(flags);
}

    // ────────────────────────────────────────────────
    // [SCHEDULE-MIN-INTERVAL] 관리자 — AI 면접 코스 문항 간 최소 제출 간격(일) 저장.
    // ────────────────────────────────────────────────

export async function adminScheduleMinIntervalUpdate(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const days = Number(req.body?.days);
      if (!Number.isFinite(days) || days < 0 || days > 30) {
        return res.status(400).json({ message: '최소 간격 값이 올바르지 않습니다 (0~30일).' });
      }

      const { error } = await supabase
        .from('interview_feature_flags')
        .upsert([{ key: SCHEDULE_MIN_INTERVAL_KEY, value_seconds: Math.round(days) }], { onConflict: 'key' });
      if (error) throw error;

      return res.status(200).json({ message: '최소 제출 간격이 저장되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [FREE-TRIAL-USAGE-CAP] 관리자 — Free 회원 기본 사례 사용 횟수 상한 저장.
    // ────────────────────────────────────────────────

export async function adminFreeTrialUsesPerCaseUpdate(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const uses = Number(req.body?.uses);
      if (!Number.isFinite(uses) || uses < 1 || uses > 100) {
        return res.status(400).json({ message: '사용 횟수 값이 올바르지 않습니다 (1~100회).' });
      }

      const { error } = await supabase
        .from('interview_feature_flags')
        .upsert([{ key: FREE_TRIAL_USES_PER_CASE_KEY, value_seconds: Math.round(uses) }], { onConflict: 'key' });
      if (error) throw error;

      return res.status(200).json({ message: 'Free 회원 사용 횟수 제한이 저장되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [PREMIUM-CASE-POOL] 관리자 — Premium 회원 카테고리별 사례 풀 크기 저장.
    // ────────────────────────────────────────────────

export async function adminPremiumCasePoolSizeUpdate(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const size = Number(req.body?.size);
      if (!Number.isFinite(size) || size < 1 || size > 200) {
        return res.status(400).json({ message: '사례 풀 크기 값이 올바르지 않습니다 (1~200개).' });
      }

      const { error } = await supabase
        .from('interview_feature_flags')
        .upsert([{ key: PREMIUM_CASE_POOL_SIZE_KEY, value_seconds: Math.round(size) }], { onConflict: 'key' });
      if (error) throw error;

      return res.status(200).json({ message: 'Premium 회원 사례 풀 크기가 저장되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [PREMIUM-CASE-POOL] 관리자 — Premium 회원 사례당 사용 횟수 상한 저장.
    // ────────────────────────────────────────────────

export async function adminPremiumUsesPerCaseUpdate(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const uses = Number(req.body?.uses);
      if (!Number.isFinite(uses) || uses < 1 || uses > 100) {
        return res.status(400).json({ message: '사용 횟수 값이 올바르지 않습니다 (1~100회).' });
      }

      const { error } = await supabase
        .from('interview_feature_flags')
        .upsert([{ key: PREMIUM_USES_PER_CASE_KEY, value_seconds: Math.round(uses) }], { onConflict: 'key' });
      if (error) throw error;

      return res.status(200).json({ message: 'Premium 회원 사례당 사용 횟수 제한이 저장되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [PRACTICE-TIME-ADMIN-ONLY] 관리자 — 사례개념화·상담윤리·수퍼비전 준비/답변 시간(초) 저장.
    // AI 자율연습과 AI 면접 코스 양쪽에 동일하게 적용됩니다(getPracticeTimeSettings 참고).
    // ────────────────────────────────────────────────

export async function adminPracticeTimesUpdate(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { times } = req.body;
      if (!times || typeof times !== 'object') {
        return res.status(400).json({ message: 'times 객체가 필요합니다.' });
      }

      const rows = [];
      for (const k of PRACTICE_TIME_KEYS) {
        if (!(k in times)) continue;
        const sec = Number(times[k]);
        if (!Number.isFinite(sec) || sec < 0 || sec > 3600) {
          return res.status(400).json({ message: `${k} 값이 올바르지 않습니다 (0~3600초).` });
        }
        rows.push({ key: k, value_seconds: Math.round(sec) });
      }
      if (rows.length === 0) {
        return res.status(400).json({ message: '저장할 항목이 없습니다.' });
      }

      const { error } = await supabase
        .from('interview_feature_flags')
        .upsert(rows, { onConflict: 'key' });
      if (error) throw error;

      return res.status(200).json({ message: '준비/답변 시간 설정이 저장되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [FEATURE-FLAGS] 관리자 — 탭별 사용 여부 저장
    // ────────────────────────────────────────────────

export async function adminFeatureFlagsUpdate(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { flags } = req.body;
      const validKeys = [
        'practice', 'schedule', 'coaching', 'history', 'guide',
        // [DOWNLOAD-BTN-TOGGLE] 모의면접 완료 화면의 "결과 텍스트로 저장" 버튼 노출 여부.
        'showDownloadResultBtn',
        'modeCasePracticeStructured', 'modeCasePracticeFreeform',
        'modeEthicsPracticeStructured', 'modeEthicsPracticeFreeform',
        'modeCaseTeamStructured', 'modeCaseTeamFreeform',
        'modeEthicsTeamStructured', 'modeEthicsTeamFreeform',
        // [AUTO-FEEDBACK] 카테고리별 제출 시 AI 피드백 자동 생성 on/off
        ...AUTO_FEEDBACK_KEYS,
        // [AI-DRAFT-QUEUE] 카테고리별 신규 문제 등록 시 모범답안 초안 자동 생성 on/off
        ...AUTO_DRAFT_KEYS,
      ];
      if (!flags || typeof flags !== 'object') {
        return res.status(400).json({ message: 'flags 객체가 필요합니다.' });
      }

      const rows = validKeys
        .filter(k => k in flags)
        .map(k => ({ key: k, enabled: !!flags[k] }));
      if (rows.length === 0) {
        return res.status(400).json({ message: '저장할 항목이 없습니다.' });
      }

      // [ANSWER-MODE] AI 자율연습/AI 면접 코스 각각, 사례개념화/상담윤리 각각 구조형·통합형
      // 중 최소 하나는 항상 켜져 있어야 합니다(둘 다 끄면 수련생이 답변을 아예 작성할 수
      // 없으므로). 이번 요청값과 기존 DB 저장값을 합쳐서 검증합니다.
      const modePairs = [
        ['modeCasePracticeStructured', 'modeCasePracticeFreeform'],
        ['modeEthicsPracticeStructured', 'modeEthicsPracticeFreeform'],
        ['modeCaseTeamStructured', 'modeCaseTeamFreeform'],
        ['modeEthicsTeamStructured', 'modeEthicsTeamFreeform'],
      ];
      const modeKeysTouched = modePairs.flat();
      if (modePairs.some(([a, b]) => a in flags || b in flags)) {
        const { data: existing, error: exErr } = await supabase
          .from('interview_feature_flags')
          .select('key, enabled')
          .in('key', modeKeysTouched);
        if (exErr) throw exErr;
        const merged = {};
        modeKeysTouched.forEach(k => { merged[k] = true; });
        (existing || []).forEach(r => { merged[r.key] = !!r.enabled; });
        Object.keys(flags).forEach(k => { if (k in merged) merged[k] = !!flags[k]; });
        for (const [a, b] of modePairs) {
          if (!merged[a] && !merged[b]) {
            return res.status(400).json({ message: `${a} / ${b}는 최소 하나는 켜져 있어야 합니다.` });
          }
        }
      }

      const { error } = await supabase
        .from('interview_feature_flags')
        .upsert(rows, { onConflict: 'key' });
      if (error) throw error;

      return res.status(200).json({ message: '저장되었습니다.' });
}

// ────────────────────────────────────────────────
// [PUBLIC-SERVICE-STATUS] 로그인하지 않은 방문자(랜딩페이지 index.html)에게도
// "지금 AI 면접 코스/코칭 면접 코스가 열려 있는지"를 보여주기 위한 공개 액션입니다.
// interview.js 라우터에서 이 액션만 verifyUser 없이 호출되므로(공개 액션 목록에
// 등록되어 있어야 함), requester 인자를 받지 않습니다 — 절대 민감한 값(이메일,
// 계좌, 문항 내용, 사용자 정보 등)을 반환하면 안 되고, 아래처럼 "탭 열림/닫힘
// 여부"와 "코칭 면접 코스 개설 일정"처럼 랜딩페이지에 공개해도 되는 값만 다룹니다.
// [VERCEL-FUNCTION-LIMIT] 원래 별도의 api/public.js 서버리스 함수로 만들었으나,
// Vercel Hobby 플랜은 배포당 서버리스 함수를 12개까지만 허용해서 배포가
// 실패했습니다(이미 12개였음). 새 함수를 추가하는 대신 기존 api/interview.js
// 라우터에 공개 액션 하나를 얹는 방식으로 바꿔 함수 개수를 늘리지 않았습니다.
// ────────────────────────────────────────────────
export async function publicServiceStatus(req, res) {
  const { data, error } = await supabase
    .from('interview_feature_flags')
    .select('key, enabled')
    .in('key', ['practice', 'schedule', 'coaching']);
  if (error) throw error;

  const flags = { practice: true, schedule: true, coaching: true };
  (data || []).forEach(r => {
    if (r.key in flags) flags[r.key] = !!r.enabled;
  });

  const coachingCourseSchedule = await getCoachingCourseSchedule();
  const coachingPromoBannerText = await getCoachingPromoBannerText();

  return res.status(200).json({
    practiceOpen: flags.practice,
    scheduleOpen: flags.schedule,
    coachingOpen: flags.coaching,
    coachingCourseSchedule,
    coachingPromoBannerText
  });
}

