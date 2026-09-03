// interview.js
// ─────────────────────────────────────────────────────────────────
// [STEP8-MODULARIZE] 이 파일은 이제 얇은 라우터(dispatcher)입니다 — 실제 액션
// 로직은 전부 api/_interview/*.js로 옮겼습니다. URL 라우팅(vercel.json의
// /api/interview/:action -> /api/interview.js?action=:action)은 전혀 바뀌지
// 않았고, 동작도 100% 동일합니다 -- action 이름에 따라 아래 맵에서 찾은
// 함수를 호출할 뿐입니다. 새 액션을 추가할 때는 api/_interview/ 아래 알맞은
// 파일(도메인별로: practice/settings/questions/teams/schedule)에 함수를
// 추가하고, 아래 ACTION_HANDLERS에 한 줄만 등록하면 됩니다.
// 공용 헬퍼(verifyUser, supabase, catLabelFor 등)는 api/_interview/shared.js에
// 모아뒀습니다.
// ─────────────────────────────────────────────────────────────────

import { verifyUser } from './_interview/shared.js';
import * as practiceHandlers from './_interview/practice.js';
import * as settingsHandlers from './_interview/settings.js';
import * as questionsHandlers from './_interview/questions.js';
import * as teamsHandlers from './_interview/teams.js';
import * as scheduleHandlers from './_interview/schedule.js';

const ACTION_HANDLERS = {
  'practice-today-status': practiceHandlers.practiceTodayStatus,
  'save': practiceHandlers.save,
  'list': practiceHandlers.list,
  'feedback-report': practiceHandlers.feedbackReport,
  'clear': practiceHandlers.clear,
  'admin-list': practiceHandlers.adminList,
  'admin-sessions': practiceHandlers.adminSessions,
  'admin-session-delete': practiceHandlers.adminSessionDelete,
  'admin-session-answer-update': practiceHandlers.adminSessionAnswerUpdate,
  'admin-generate-feedback': practiceHandlers.adminGenerateFeedback,
  'admin-feedback-reports-list': practiceHandlers.adminFeedbackReportsList,
  'admin-feedback-report-resolve': practiceHandlers.adminFeedbackReportResolve,
  'admin-live-feedback-queue': practiceHandlers.adminLiveFeedbackQueue,
  'admin-live-feedback-release': practiceHandlers.adminLiveFeedbackRelease,
  'my-settings': settingsHandlers.mySettings,
  'feature-flags': settingsHandlers.featureFlags,
  'public-service-status': settingsHandlers.publicServiceStatus,
  'admin-schedule-min-interval-update': settingsHandlers.adminScheduleMinIntervalUpdate,
  'admin-free-trial-uses-per-case-update': settingsHandlers.adminFreeTrialUsesPerCaseUpdate,
  'admin-premium-case-pool-size-update': settingsHandlers.adminPremiumCasePoolSizeUpdate,
  'admin-premium-uses-per-case-update': settingsHandlers.adminPremiumUsesPerCaseUpdate,
  'admin-practice-times-update': settingsHandlers.adminPracticeTimesUpdate,
  'admin-feature-flags-update': settingsHandlers.adminFeatureFlagsUpdate,
  'bank': questionsHandlers.bank,
  'admin-questions': questionsHandlers.adminQuestions,
  'admin-question-upsert': questionsHandlers.adminQuestionUpsert,
  'admin-questions-bulk-set-active': questionsHandlers.adminQuestionsBulkSetActive,
  'admin-question-delete': questionsHandlers.adminQuestionDelete,
  'admin-question-set-default': questionsHandlers.adminQuestionSetDefault,
  'admin-case-model-answers-list': questionsHandlers.adminCaseModelAnswersList,
  'admin-case-model-answer-upsert': questionsHandlers.adminCaseModelAnswerUpsert,
  'admin-case-model-answer-delete': questionsHandlers.adminCaseModelAnswerDelete,
  'admin-theory-options-list': questionsHandlers.adminTheoryOptionsList,
  'admin-theory-options-upsert': questionsHandlers.adminTheoryOptionsUpsert,
  'admin-theory-options-delete': questionsHandlers.adminTheoryOptionsDelete,
  'admin-generate-draft-model-answer': questionsHandlers.adminGenerateDraftModelAnswer,
  'admin-model-answer-drafts-list': questionsHandlers.adminModelAnswerDraftsList,
  'admin-model-answer-approve': questionsHandlers.adminModelAnswerApprove,
  'admin-model-answer-reject': questionsHandlers.adminModelAnswerReject,
  'admin-questions-bulk-upsert': questionsHandlers.adminQuestionsBulkUpsert,
  'admin-questions-import-url': questionsHandlers.adminQuestionsImportUrl,
  'admin-case-model-answers-bulk-upsert': questionsHandlers.adminCaseModelAnswersBulkUpsert,
  'admin-case-model-answers-import-url': questionsHandlers.adminCaseModelAnswersImportUrl,
  'admin-teams-list': teamsHandlers.adminTeamsList,
  'admin-team-create': teamsHandlers.adminTeamCreate,
  'admin-team-update-settings': teamsHandlers.adminTeamUpdateSettings,
  'admin-team-dissolve': teamsHandlers.adminTeamDissolve,
  'admin-team-delete': teamsHandlers.adminTeamDelete,
  'admin-team-members': teamsHandlers.adminTeamMembers,
  'admin-team-member-add': teamsHandlers.adminTeamMemberAdd,
  'admin-team-member-remove': teamsHandlers.adminTeamMemberRemove,
  'admin-pending-members-list': teamsHandlers.adminPendingMembersList,
  'admin-pending-member-assign': teamsHandlers.adminPendingMemberAssign,
  'admin-pending-member-dismiss': teamsHandlers.adminPendingMemberDismiss,
  'schedule-list': scheduleHandlers.scheduleList,
  'schedule-submit': scheduleHandlers.scheduleSubmit,
  'admin-training-overview': scheduleHandlers.adminTrainingOverview,
  'admin-schedule-remind': scheduleHandlers.adminScheduleRemind,
  'admin-schedule-list': scheduleHandlers.adminScheduleList,
  'admin-schedule-upsert': scheduleHandlers.adminScheduleUpsert,
  'admin-schedule-delete': scheduleHandlers.adminScheduleDelete,
  'admin-schedule-submissions': scheduleHandlers.adminScheduleSubmissions,
};

// [PUBLIC-SERVICE-STATUS] 로그인 없이도 호출할 수 있는 액션 — 랜딩페이지(index.html)가
// 비로그인 방문자에게 "AI 면접 코스/코칭 면접 코스가 지금 열려 있는지"를 보여주기
// 위해 씁니다. 새 액션을 이 목록에 추가할 때는 해당 핸들러가 절대 민감한 값을
// 반환하지 않는지 반드시 확인해주세요(로그인 확인을 건너뛰기 때문입니다).
const PUBLIC_ACTIONS = new Set(['public-service-status']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const { action } = req.query;

  let requester = null;
  if (!PUBLIC_ACTIONS.has(action)) {
    requester = await verifyUser(req);
    if (!requester) {
      return res.status(401).json({ message: '세션이 만료되었습니다. 다시 로그인해주세요.' });
    }
  }

  const handlerFn = ACTION_HANDLERS[action];
  if (!handlerFn) {
    return res.status(400).json({ message: 'Invalid interview action' });
  }

  try {
    return await handlerFn(req, res, requester);
  } catch (error) {
    console.error(`[interview.js] action=${action} 예외:`, error.message);
    return res.status(500).json({ message: error.message });
  }
}
