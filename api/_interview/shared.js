// interview.js
// ─────────────────────────────────────────────────────────────────
// [통합] 한상면접(전문상담사 AI 모의면접)의 회원 데이터를 퀴즈 뱅크와
// 동일한 Supabase 프로젝트/계정 체계로 합치기 위한 API.
// auth.js / questions.js / admin.js와 동일한 패턴을 따릅니다:
//   - Authorization: Bearer <accessToken> (sessionStorage.quiz_token)
//   - service_role 키로 접근, RLS는 방어선으로만 사용
//   - 관리자 판별은 public.users.user_status === 'admin'
// action 종류
//   save       : 모의면접 세션 결과 저장
//   list       : 로그인한 본인의 연습 기록 조회 (최근 50개)
//   clear      : 본인의 연습 기록 전체 삭제
//   admin-list : (관리자 전용) 전체 회원 x 연습 기록 통계 (요약 카드용)
//
// [QBANK-DB] 질문은행 DB화 + 관리자 스케줄 공개
//   bank                  : 로그인한 회원 누구나 — 현재 공개된(is_active=true
//                           AND release_at<=now()) 질문 목록 조회. 승인(premium)
//                           여부와 무관하게 열람 가능 (질문은행은 자유 열람 영역).
//   admin-questions       : (관리자 전용) 전체 질문 목록 (미공개 포함) 조회
//   admin-question-upsert : (관리자 전용) 질문 추가/수정 (공개일·활성화 포함)
//   admin-question-delete : (관리자 전용) 질문 삭제
//
// [RECORDS-ADMIN] 회원별 연습기록 관리자 열람/관리
//   admin-sessions        : (관리자 전용) 전체 회원의 연습 기록 원본 목록 조회
//                           (회원 이름/이메일 포함, 최근순 최대 300건)
//   admin-session-delete  : (관리자 전용) 특정 연습 기록 1건 삭제
//   admin-session-answer-update : (관리자 전용) 특정 연습기록의 특정 답변(fields) 수정
//                                 (AI 면접 코스 제출 검토 화면에서 사용, AI 피드백은 초기화)
//
// [SHEET-IMPORT] 구글 시트 → Supabase 질문은행 일괄 업로드
//   admin-questions-bulk-upsert : (관리자 전용) 클라이언트에서 파싱한 행
//                                 배열을 그대로 받아 일괄 반영 (붙여넣기 가져오기)
//   admin-questions-import-url  : (관리자 전용) 구글 시트 "웹에 게시" CSV URL을
//                                 서버에서 직접 가져와 파싱 후 일괄 반영
//   두 액션 모두 (cat, question) 완전 일치 여부로 update/insert를 판단합니다.
//   질문 문구 자체를 수정한 행은 새 문제로 추가되므로, 문구를 바꾼 경우
//   admin.html의 질문 목록에서 예전 문항을 직접 삭제해 주세요.
//
// [AI-FEEDBACK] 모범답안 저장 + AI 비교 피드백
//   admin-question-upsert            : (관리자 전용, 기존 액션 확장) 상담윤리(cat=ethics)
//                                       문제는 modelAnswer(문제당 1개)를 함께 저장
//   admin-case-model-answers-list    : (관리자 전용) 사례개념화 한 문제의 상담이론별
//                                       모범답안 목록 조회
//   admin-case-model-answer-upsert   : (관리자 전용) 상담이론 하나의 모범답안 추가/수정
//   admin-case-model-answer-delete   : (관리자 전용) 상담이론 모범답안 1건 삭제
//   bank                              : (기존 액션 확장) 사례개념화 문제에 등록된
//                                       "상담이론 이름" 목록(theories)을 함께 반환.
//                                       모범답안 본문은 절대 포함하지 않습니다.
//   admin-generate-feedback          : (관리자 전용) 특정 연습기록의 특정 답변을
//                                       저장된 모범답안과 비교해 Gemini로 피드백을
//                                       생성하고 그 연습기록에 저장
//   admin-questions-bulk-upsert /
//   admin-questions-import-url       : (기존 액션 확장) 6번째 열 "모범답안"을
//                                       상담윤리 문제에 함께 반영. 열 자체가
//                                       없으면 기존 값 유지, 열은 있는데 칸이
//                                       비어 있으면 null로 지웁니다.
//   admin-case-model-answers-bulk-upsert /
//   admin-case-model-answers-import-url : (관리자 전용) 사례개념화 이론별
//                                       모범답안 전용 시트(질문/상담이론/모범답안)를
//                                       질문 "텍스트 완전 일치"로 매칭해 일괄 반영.
//                                       매칭되는 질문이 질문은행에 먼저 있어야 합니다.
//   admin-questions-bulk-upsert / admin-questions-import-url /
//   admin-case-model-answers-bulk-upsert / admin-case-model-answers-import-url
//                                     : (기존 액션 확장) "승인" 열(선택)을 지원합니다.
//                                       열 자체가 없으면 기존과 동일하게 항상 반영,
//                                       열이 있으면 TRUE/O/예 등으로 표시된 행만
//                                       반영합니다 (n8n 등이 AI 초안을 시트에 채워
//                                       넣고 사람이 검토 후 승인 표시하는 워크플로용).
//
// [AI-DRAFT] 모범답안 AI 초안 생성 (웹 경로 — DB에 바로 쓰지 않음)
//   admin-generate-draft-model-answer : (관리자 전용) 질문/평가포인트(/상담이론)를
//                                       받아 Gemini로 모범답안 초안 텍스트만 생성해
//                                       반환합니다. DB에는 아무것도 쓰지 않으며,
//                                       admin.html에서 이 텍스트를 입력창에 채운 뒤
//                                       관리자가 검토·수정 후 기존 저장 액션
//                                       (admin-question-upsert / admin-case-model
//                                       -answer-upsert)으로 직접 저장합니다.
//
// [TRAINING-OVERVIEW] 관리자용 "AI 면접 코스" 대시보드 (interview.html)
//   admin-training-overview : (관리자 전용) 전체 활성 팀의 현재 공개중/마감임박
//                             일정과 팀별 제출 현황, AI 피드백 미작성 큐를 한 번에 조회
//   admin-schedule-remind   : (관리자 전용) 특정 일정의 미제출자 전원에게
//                             마감 임박 리마인드 메일 발송
//   schedule-list           : (기존 액션 확장) 관리자가 previewTeamId를 넘기면
//                             본인 팀이 아닌 다른 팀의 수련생 화면을 미리볼 수 있음
//                             (일반 회원은 이 파라미터 사용 불가)
// ─────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─────────────────────────────────────────────────────────────────
// [SETTINGS-1] 문의 이메일 조회 — app_settings에 관리자가 설정해둔 값이
// 있으면 그 값을, 없으면(테이블 미생성 포함) 환경변수(ADMIN_EMAIL)로 폴백합니다.
// ─────────────────────────────────────────────────────────────────
export async function getContactEmail() {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'contact_email')
      .maybeSingle();
    if (error) throw error;
    return data?.value || process.env.ADMIN_EMAIL;
  } catch (e) {
    console.warn('[interview.js] app_settings 조회 실패 — 환경변수로 폴백:', e.message);
    return process.env.ADMIN_EMAIL;
  }
}

// ─────────────────────────────────────────────────────────────────
// [BANK-ACCOUNT-INFO] 코칭 면접 코스 입금 안내용 계좌 정보 — app_settings에
// 관리자가 설정해둔 값이 있으면 반환하고, 아직 설정 전이면 빈 문자열을
// 반환합니다(호출부에서 셋 중 하나라도 비어 있으면 안내 문구 자체를 생략).
// ─────────────────────────────────────────────────────────────────
export async function getBankAccountInfo() {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('key, value')
      .in('key', ['bank_name', 'bank_account_number', 'bank_account_holder']);
    if (error) throw error;
    const map = {};
    (data || []).forEach(r => { map[r.key] = r.value; });
    return {
      bankName: map.bank_name || '',
      accountNumber: map.bank_account_number || '',
      accountHolder: map.bank_account_holder || ''
    };
  } catch (e) {
    console.warn('[interview.js] app_settings(은행계좌) 조회 실패:', e.message);
    return { bankName: '', accountNumber: '', accountHolder: '' };
  }
}

// ─────────────────────────────────────────────────────────────────
// [COACHING-PROMO-BANNER] index.html/premium.html/interview.html 상단에 공통으로
// 보여주는 코칭 프로그램 개설 안내 배너 문구 — app_settings에 일반 텍스트로
// 저장합니다. 관리자가 아직 수정한 적이 없으면 기본 문구를 그대로 반환합니다.
// ─────────────────────────────────────────────────────────────────
export const COACHING_PROMO_BANNER_TEXT_DEFAULT =
  '🎉 [한국상담학회] 전문상담사 자격 면접 대비 코칭 프로그램이 지금 개설되어 있습니다. 코칭면접코스를 신청해주세요.';

export async function getCoachingPromoBannerText() {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'coaching_promo_banner_text')
      .maybeSingle();
    if (error) throw error;
    return data?.value || COACHING_PROMO_BANNER_TEXT_DEFAULT;
  } catch (e) {
    console.warn('[interview.js] app_settings(코칭 배너 문구) 조회 실패 — 기본값으로 폴백:', e.message);
    return COACHING_PROMO_BANNER_TEXT_DEFAULT;
  }
}

// ─────────────────────────────────────────────────────────────────
// [COACHING-COURSE-SCHEDULE] 코칭 면접 코스 "안내" 화면에 보여줄 개설 일정 목록 —
// app_settings에 JSON 배열 문자열로 저장합니다(급수별로 여러 개, 중복 기간도 허용).
// 관리자가 아직 입력하지 않았으면 빈 배열을 반환합니다.
// ─────────────────────────────────────────────────────────────────
export async function getCoachingCourseSchedule() {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'coaching_course_schedule')
      .maybeSingle();
    if (error) throw error;
    if (!data?.value) return [];
    const parsed = JSON.parse(data.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('[interview.js] app_settings(코칭 코스 일정) 조회/파싱 실패:', e.message);
    return [];
  }
}

// [AI-FEEDBACK] ai-gen.js와 동일한 Gemini API 키를 재사용합니다.
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
export const GEMINI_MODEL = 'gemini-3.6-flash';

// [TEAM-MGMT] 전문상담사 AI 모의면접은 더 이상 개인별 user_subscriptions로
// 관리하지 않습니다. "팀"에 소속되어 있는지 여부로 접근을 판정합니다
// (getInterviewAccess 참고). 팀이 해체되면 소속 회원 전원의 이용이
// 즉시 제한됩니다.

// [QBANK-DB] 질문 카테고리 — interview.html의 CATEGORIES와 동일
// [SUPERVISION-PHASE1] 'supervision'은 관리자 질문은행 관리 화면(콘텐츠 등록)에만
// 쓰입니다. 수련생에게 실제로 노출되는 것은 'bank' 액션에서 아직 cat을
// ('case','ethics')로 명시적으로 제한하고 있어 별도입니다 — 수련생 노출은
// 이후 단계(Phase 2)에서 그 제한을 풀 때 함께 진행합니다.
export const VALID_QUESTION_CATS = ['case', 'ethics', 'supervision'];

// [SUPERVISION-PHASE1] cat 값 → 화면 표시용 한글 라벨. cat_label 컬럼은 항상
// 이 값으로 서버가 자동 산출합니다(관리자가 직접 입력하지 않음).
export const CAT_LABEL_BY_KEY = { case: '사례개념화', ethics: '상담윤리', supervision: '수퍼비전' };
export function catLabelFor(cat) { return CAT_LABEL_BY_KEY[cat] || cat; }

// [QBANK-USAGE-SCOPE] 문제 풀 용도 — practice(AI 자율연습용) / team(AI 면접 코스용)
export const VALID_USAGE_SCOPES = ['practice', 'team'];

// ─────────────────────────────────────────────────────────────────
// [AI-DRAFT] Gemini 호출 공통 헬퍼 — admin-generate-feedback과
// admin-generate-draft-model-answer가 함께 사용합니다.
// 실패 시 예외를 던지므로 호출부에서 try/catch로 감싸 처리하세요.
// ─────────────────────────────────────────────────────────────────
export async function callGemini(prompt, maxOutputTokens = 1200) {
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': GEMINI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // [THINKING-BUDGET] gemini-3.x 계열은 thinking(내부 추론)을 끌 수 없고(thinkingBudget:0을
        // 보내면 오히려 400 오류), 이 추론 토큰도 maxOutputTokens 예산에서 함께 차감됩니다.
        // 그래서 끄는 대신 maxOutputTokens 자체를 넉넉히 잡아 추론 + 실제 답변 텍스트가
        // 모두 들어갈 여유를 둡니다(안 그러면 응답이 중간에 잘리거나 빈 응답이 됨).
        generationConfig: { maxOutputTokens }
      })
    }
  );
  const result = await geminiRes.json();
  if (!geminiRes.ok) {
    console.error('[interview.js] Gemini API 오류:', geminiRes.status, JSON.stringify(result));
    const err = new Error('AI 요청이 실패했습니다.');
    err.isGeminiError = true;
    throw err;
  }
  const text = result?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || null;
  if (!text) {
    console.error('[interview.js] Gemini 응답에 content가 없음:', JSON.stringify(result));
    const err = new Error('AI 응답을 해석할 수 없습니다.');
    err.isGeminiError = true;
    throw err;
  }
  return text;
}

// ─────────────────────────────────────────────────────────────────
// [AI-DRAFT] 모델이 프롬프트의 "마크다운/사족 금지" 지시를 완벽히 지키지 않는
// 경우를 대비한 최소한의 후처리입니다 — 관리자가 바로 복사해서 저장할 수
// 있도록 마크다운 굵게/제목/코드 기호와, 첫 줄에 흔히 붙는 "[모범답안 초안]"
// 류의 라벨을 제거합니다. 본문 내용 자체는 건드리지 않습니다.
// ─────────────────────────────────────────────────────────────────
export function sanitizeAiDraftText(text) {
  if (!text) return text;
  let t = text
    .replace(/\*\*(.*?)\*\*/g, '$1')   // **굵게**
    .replace(/__(.*?)__/g, '$1')       // __굵게__
    .replace(/^#{1,6}\s*/gm, '')       // # 제목
    .replace(/`([^`]*)`/g, '$1')       // `코드`
    .trim();
  // 첫 줄이 "[모범답안 초안]"처럼 대괄호로만 이루어진 라벨/제목이면 제거
  t = t.replace(/^\[[^\]\n]{1,30}\]\s*\n+/, '').trim();
  return t;
}

// ─────────────────────────────────────────────────────────────────
// [STEP3-REVIEW-QUEUE] Phase 3(관리자 화면: 건별 승인 → 현황 모니터링 대시보드) —
// AI 피드백의 품질을 자동으로 가늠해 관리자가 "전체 목록"이 아니라 "검토 필요"
// 항목만 훑어보면 되도록 하기 위한 신호입니다. 아래 임계값(길이/유사도)은 실제
// 데이터 분포를 보며 튜닝이 필요한 1차 추정치입니다 — 이후 Phase(카테고리별
// 자동화 강도 차등, 관리자 화면 설정값으로 분리)에서 조정 가능하게 만드는 것을
// 권장합니다.
// ─────────────────────────────────────────────────────────────────

// 답변/모범답안 사이의 대략적인 유사도 — 형태소 분석기 없이 가볍게 계산하기
// 위해 공백을 제거한 문자열의 2-gram(바이그램) 집합끼리 자카드 유사도를 씁니다.
// 정교한 의미 유사도는 아니지만 "거의 안 겹침" / "거의 동일"처럼 극단적인
// 경우는 형태소 분석 없이도 꽤 안정적으로 잡아냅니다.
function textBigramSimilarity(a, b) {
  const normalize = (s) => String(s || '').replace(/\s+/g, '');
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const sa = bigrams(normalize(a));
  const sb = bigrams(normalize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let intersection = 0;
  for (const gram of sa) { if (sb.has(gram)) intersection++; }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// AI 피드백 문장에 "확실하지 않다"류 표현이 섞여 있는지 — 모델 스스로 판단에
// 자신 없어 하는 신호로 봅니다.
const UNCERTAIN_FEEDBACK_PATTERNS = [
  '확실하지 않', '판단하기 어렵', '알 수 없', '명확하지 않', '모호하',
  '정보가 부족', '더 살펴봐야', '단정하기 어렵', '판단이 어렵'
];

const MIN_ANSWER_LENGTH_FOR_CONFIDENT_FEEDBACK = 100;
const LOW_SIMILARITY_THRESHOLD = 0.03;
const HIGH_SIMILARITY_THRESHOLD = 0.55;

// [STEP3-REVIEW-QUEUE] 답변 길이 과소 / AI 피드백의 불확실 표현 / 모범답안과의
// 유사도 극단치, 세 가지 신호를 종합해 "검토 필요" 여부를 판정합니다
// (원 로드맵 Phase 3 항목 2). generateFeedbackForAnswer 안에서 호출됩니다.
export function assessFeedbackQuality({ answerText, modelAnswerText, feedbackText }) {
  const reasons = [];
  const trimmedAnswer = String(answerText || '').trim();

  if (trimmedAnswer.length > 0 && trimmedAnswer.length < MIN_ANSWER_LENGTH_FOR_CONFIDENT_FEEDBACK) {
    reasons.push('답변 길이가 지나치게 짧습니다');
  }

  const feedbackStr = String(feedbackText || '');
  if (UNCERTAIN_FEEDBACK_PATTERNS.some(p => feedbackStr.includes(p))) {
    reasons.push('AI 피드백에 확신이 낮은 표현이 포함되어 있습니다');
  }

  if (trimmedAnswer && modelAnswerText) {
    const similarity = textBigramSimilarity(trimmedAnswer, modelAnswerText);
    if (similarity < LOW_SIMILARITY_THRESHOLD) {
      reasons.push('모범답안과 겹치는 내용이 거의 없습니다(주제 이탈 가능성)');
    } else if (similarity > HIGH_SIMILARITY_THRESHOLD) {
      reasons.push('모범답안과 매우 유사합니다(과도한 일치 — 확인 필요)');
    }
  }

  return { flagged: reasons.length > 0, reasons };
}

// [STEP3-REVIEW-QUEUE] 사례개념화는 정답이 여러 갈래라 위 자동판정 신호만으로는
// 부족할 수 있어, 신호와 별개로 일정 비율을 무작위 샘플링해 검토 큐에 함께
// 올립니다(원 로드맵 Phase 3 항목 4 — "사례개념화 한정 샘플링 검수 큐"). 완전히
// 분리된 별도 화면 대신, 같은 검토 큐 안에서 사유 라벨로 구분되게 했습니다
// (admin.html/interview.html 쪽 UI 참고). sessionId+answerIndex를 해시해 같은
// 항목이 재요청할 때마다 바뀌지 않고 고정되게 결정론적으로 고릅니다.
export const CASE_REVIEW_SAMPLING_RATE = 0.15;

export function isSampledForReview(sessionId, answerIndex, rate = CASE_REVIEW_SAMPLING_RATE) {
  const str = `${sessionId}:${answerIndex}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return (hash % 1000) / 1000 < rate;
}

// ─────────────────────────────────────────────────────────────────
// [AUTO-FEEDBACK-CORE] 답변 하나(target: {cat, questionId, theory, q, answerText})에
// 대해 등록된 모범답안과 비교한 AI 피드백을 생성해 텍스트로 반환합니다.
// admin-generate-feedback(관리자 수동 트리거)과 save/schedule-submit 제출 시
// 자동 트리거 양쪽에서 공용으로 씁니다. 모범답안이 없거나 문제 유형을 알 수
// 없으면 사용자에게 보여줄 메시지를 담은 Error를 던집니다(호출부에서 처리).
// [SUPERVISION-FEEDBACK-FIX] 예전에는 이 로직이 admin-generate-feedback 안에만
// 있었고 cat==='supervision' 분기가 빠져 있어 수퍼비전 답변은 피드백 생성이
// 항상 실패했습니다. 수퍼비전도 상담윤리와 동일하게 interview_questions.model_answer
// 1개를 그대로 씁니다.
// [STEP3-REVIEW-QUEUE] 반환값이 문자열에서 {feedbackText, flags} 객체로 바뀌었습니다
// — 호출부(autoAttachFeedback, admin-generate-feedback)도 함께 수정했습니다.
// ─────────────────────────────────────────────────────────────────
export async function generateFeedbackForAnswer(target) {
  if (!target || !target.questionId) {
    throw new Error('이 답변에는 문제 ID 정보가 없어 모범답안을 찾을 수 없습니다.');
  }

  let modelAnswerText = null;
  let theoryLabel = null;

  if (target.cat === 'ethics' || target.cat === 'supervision') {
    const { data: q, error: qErr } = await supabase
      .from('interview_questions')
      .select('model_answer, model_answer_status')
      .eq('id', target.questionId)
      .maybeSingle();
    if (qErr) throw qErr;
    modelAnswerText = q?.model_answer || null;
    if (!modelAnswerText) {
      throw new Error('이 문제에 등록된 모범답안이 없습니다. 질문은행 관리에서 먼저 등록해주세요.');
    }
    // [AI-DRAFT-QUEUE] AI가 자동 생성했지만 관리자 승인 전인 초안은 비교 기준으로
    // 쓰지 않습니다 — 검토되지 않은 내용을 그대로 수련생 피드백에 반영하지 않기 위함.
    if (q.model_answer_status === 'draft') {
      throw new Error('이 문제의 모범답안이 아직 AI 초안 승인 대기 상태입니다. "AI 초안 승인 대기" 큐에서 먼저 승인해주세요.');
    }
  } else if (target.cat === 'case') {
    if (!target.theory) {
      throw new Error('이 답변에는 선택된 상담이론 정보가 없어 모범답안을 찾을 수 없습니다.');
    }
    const { data: m, error: mErr } = await supabase
      .from('interview_case_model_answers')
      .select('model_answer, status')
      .eq('question_id', target.questionId)
      .eq('theory', target.theory)
      .maybeSingle();
    if (mErr) throw mErr;
    modelAnswerText = m?.model_answer || null;
    theoryLabel = target.theory;
    if (!modelAnswerText) {
      throw new Error(`"${target.theory}" 이론에 등록된 모범답안이 없습니다.`);
    }
    if (m.status === 'draft') {
      throw new Error(`"${target.theory}" 이론의 모범답안이 아직 AI 초안 승인 대기 상태입니다. "AI 초안 승인 대기" 큐에서 먼저 승인해주세요.`);
    }
  } else {
    throw new Error('알 수 없는 문제 유형입니다.');
  }

  const catLabelForPrompt = target.cat === 'supervision' ? '수퍼비전' : '상담윤리';
  const item3Text = target.cat === 'ethics'
    ? '놓치거나 빠뜨린 핵심 요소(비밀보장 예외, 신고의무 등 윤리강령 근거 포함)'
    : '놓치거나 빠뜨린 핵심 요소';

  // [FEEDBACK-OUTPUT-FORMAT] 수련생에게 그대로 노출되는 텍스트라 형식을 엄격히 통제합니다.
  // - 인사말/자기소개/서두 문장 금지: 예전엔 "한국상담학회 전문상담사 수련감독자로서..."
  //   같은 문장으로 시작하는 경우가 있어 명시적으로 금지.
  // - 마크다운 금지(**굵게** 등) — sanitizeAiDraftText()로도 한 번 더 걸러내지만 프롬프트
  //   단계에서부터 막습니다.
  // - "모범답안과 비교" 같은 표현으로 내부적으로 등록된 모범답안의 존재를 수련생에게
  //   드러내지 않도록 지시 — 아래 각 항목 제목에서도 "모범답안" 언급을 뺐습니다.
  const FEEDBACK_OUTPUT_FORMAT_BLOCK = `[출력 형식 — 반드시 지킬 것]
- "안녕하세요", "~로서 피드백을 제공합니다" 같은 인사말·자기소개·서두 문장을 쓰지 마세요. 바로 "1. 잘한 점"으로 시작하세요.
- 마크다운 서식을 쓰지 마세요 (**굵게**, #제목, - 목록, \`코드\` 등 모두 금지). 순수한 문장으로만 작성하세요.
- "모범답안", "정답", "채점 기준", "비교" 같은 단어나 표현을 쓰지 마세요. 내부적으로 참고 자료와 비교해 작성하더라도, 수련감독자가 답변 자체를 읽고 판단해 조언하는 것처럼 자연스럽게 쓰세요.`;

  const prompt = theoryLabel
    ? `당신은 한국상담학회 전문상담사 수련감독자입니다. 아래는 사례개념화 문제에 대해 "${theoryLabel}" 관점에서 작성된 참고 답안과, 같은 관점을 선택한 수련생의 답변입니다. 참고 답안을 내부 판단 기준으로 삼아 수련생 답변에 대한 피드백을 작성하세요.

[문제]
${target.q || ''}

[선택한 상담이론]
${theoryLabel}

[참고 답안 - ${theoryLabel} 관점 · 수련생에게는 비공개, 채점 기준으로만 활용]
${modelAnswerText}

[수련생 답변]
${target.answerText || ''}

다음 형식의 한국어 피드백을 작성하세요 (번호 매긴 4개 항목, 각 항목 2~4문장 내외):
1. 잘한 점
2. ${theoryLabel} 관점에서 보완하면 좋을 점
3. 놓치거나 빠뜨린 핵심 요소
4. 종합 의견

${FEEDBACK_OUTPUT_FORMAT_BLOCK}`
    : `당신은 한국상담학회 전문상담사 수련감독자입니다. 아래는 ${catLabelForPrompt} 문제에 대한 참고 답안과 수련생의 답변입니다. 참고 답안을 내부 판단 기준으로 삼아 수련생 답변에 대한 피드백을 작성하세요.

[문제]
${target.q || ''}

[참고 답안 - 수련생에게는 비공개, 채점 기준으로만 활용]
${modelAnswerText}

[수련생 답변]
${target.answerText || ''}

다음 형식의 한국어 피드백을 작성하세요 (번호 매긴 4개 항목, 각 항목 2~4문장 내외):
1. 잘한 점
2. 보완하면 좋을 점
3. ${item3Text}
4. 종합 의견

${FEEDBACK_OUTPUT_FORMAT_BLOCK}`;

  const feedbackText = await callGemini(prompt, 3000);
  // [FEEDBACK-OUTPUT-FORMAT] 프롬프트로 마크다운·서두 문장을 막아도 모델이 가끔 지키지
  // 않는 경우가 있어, 초안 생성과 동일하게 후처리로 한 번 더 정리합니다.
  const cleanedFeedback = sanitizeAiDraftText(feedbackText);
  // [STEP3-REVIEW-QUEUE] 이 피드백이 관리자 검토가 필요한지 자동 판정해 함께 반환합니다.
  const flags = assessFeedbackQuality({
    answerText: target.answerText,
    modelAnswerText,
    feedbackText: cleanedFeedback
  });
  return { feedbackText: cleanedFeedback, flags };
}

// ─────────────────────────────────────────────────────────────────
// [AUTO-FEEDBACK] 제출 시 AI 피드백 자동 생성 여부 — 카테고리별로 관리자가
// 켜고 끌 수 있습니다. 사례개념화는 기본 OFF(모범답안 정비가 아직 진행 중일
// 수 있어서), 상담윤리·수퍼비전은 기본 ON입니다. interview_feature_flags를
// boolean(enabled) 그대로 재사용합니다(feature-flags/admin-feature-flags-update
// 액션에서 다른 탭 노출 플래그와 함께 다룹니다).
// ─────────────────────────────────────────────────────────────────
export const AUTO_FEEDBACK_DEFAULTS = {
  autoFeedbackCase: false,
  autoFeedbackEthics: true,
  autoFeedbackSupervision: true,
};
export const AUTO_FEEDBACK_KEYS = Object.keys(AUTO_FEEDBACK_DEFAULTS);

export async function getAutoFeedbackFlags() {
  const { data, error } = await supabase
    .from('interview_feature_flags')
    .select('key, enabled')
    .in('key', AUTO_FEEDBACK_KEYS);
  if (error) throw error;
  const flags = { ...AUTO_FEEDBACK_DEFAULTS };
  (data || []).forEach(r => { if (r.key in flags) flags[r.key] = !!r.enabled; });
  return flags;
}

// [AUTO-FEEDBACK] 카테고리 → 위 플래그 키 매핑
export const AUTO_FEEDBACK_FLAG_KEY_BY_CAT = {
  case: 'autoFeedbackCase',
  ethics: 'autoFeedbackEthics',
  supervision: 'autoFeedbackSupervision',
};

// ─────────────────────────────────────────────────────────────────
// [AUTO-FEEDBACK] 제출된 answers 배열을 받아, 카테고리별 자동 생성 설정이
// 켜져 있고 모범답안이 등록된 항목에만 AI 피드백을 붙여 새 배열을 반환합니다.
// 제출 자체는 이 함수의 성패와 무관하게 항상 성공해야 하므로 절대 예외를
// 던지지 않습니다 — 설정 조회 실패, 모범답안 없음, Gemini 오류 등은 모두
// 조용히 건너뛰고 로그만 남깁니다(수련생은 이후 모범답안 등록/관리자 수동
// 생성으로 다시 시도할 수 있습니다).
// ─────────────────────────────────────────────────────────────────
export async function autoAttachFeedback(answers) {
  if (!GEMINI_API_KEY || !Array.isArray(answers) || answers.length === 0) return answers;

  let flags;
  try {
    flags = await getAutoFeedbackFlags();
  } catch (e) {
    console.warn('[interview.js] 자동 피드백 설정 조회 실패 — 자동 생성 생략:', e.message);
    return answers;
  }

  const result = [];
  for (const a of answers) {
    const flagKey = a && AUTO_FEEDBACK_FLAG_KEY_BY_CAT[a.cat];
    if (!flagKey || !flags[flagKey]) { result.push(a); continue; }
    try {
      const { feedbackText, flags } = await generateFeedbackForAnswer(a);
      result.push({ ...a, feedback: feedbackText, feedbackGeneratedAt: new Date().toISOString(), feedbackFlags: flags });
    } catch (e) {
      console.warn(`[interview.js] 자동 피드백 생성 건너뜀 (cat=${a?.cat}, questionId=${a?.questionId}):`, e.message);
      result.push(a);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────
// [SCHEDULE-MIN-INTERVAL] AI 면접 코스(팀 수련) 문항 간 최소 제출 간격(일).
// 관리자가 설정할 수 있으며 기본값은 2일입니다. interview_feature_flags의
// value_seconds 컬럼을 범용 숫자 저장소로 재사용합니다(이 키에 한해 단위는
// "초"가 아니라 "일"입니다).
// ─────────────────────────────────────────────────────────────────
export const SCHEDULE_MIN_INTERVAL_KEY = 'scheduleMinIntervalDays';
export const SCHEDULE_MIN_INTERVAL_DEFAULT = 2;

export async function getScheduleMinIntervalDays() {
  const { data, error } = await supabase
    .from('interview_feature_flags')
    .select('value_seconds')
    .eq('key', SCHEDULE_MIN_INTERVAL_KEY)
    .maybeSingle();
  if (error) throw error;
  return (data && data.value_seconds !== null && data.value_seconds !== undefined)
    ? data.value_seconds
    : SCHEDULE_MIN_INTERVAL_DEFAULT;
}

// ─────────────────────────────────────────────────────────────────
// [AI-DRAFT-CORE] 모범답안 AI 초안 텍스트를 생성하는 공용 함수 — 기존
// admin-generate-draft-model-answer(관리자가 버튼을 눌러 수동 생성) 안에만
// 있던 프롬프트 로직을 추출했습니다. Phase 2(문제 등록 시 자동 초안 생성)가
// 이 함수를 재사용합니다. 실패 시 예외를 던지므로 호출부에서 처리하세요.
// ─────────────────────────────────────────────────────────────────
export async function generateDraftModelAnswer({ cat, question, tips, theory }) {
  const questionText = String(question ?? '').trim();
  const tipsList = Array.isArray(tips)
    ? tips.filter(t => typeof t === 'string' && t.trim())
    : String(tips ?? '').split('|').map(t => t.trim()).filter(Boolean);
  const tipsBlock = tipsList.length > 0 ? tipsList.map(t => `- ${t}`).join('\n') : '(등록된 평가포인트 없음)';

  const OUTPUT_FORMAT_BLOCK = `[출력 형식 — 반드시 지킬 것]
- 답안 본문 텍스트만 출력하세요. 그대로 복사해서 바로 저장할 수 있어야 합니다.
- 마크다운 서식을 쓰지 마세요 (**굵게**, #제목, - 목록, \`코드\` 등 모두 금지). 순수한 문장으로만 작성하세요.
- "[모범답안 초안]" 같은 제목이나 라벨을 붙이지 마세요.
- "물론입니다", "다음은 초안입니다" 같은 서두 인사말이나, 끝에 덧붙이는 설명·주석·안내 문구를 쓰지 마세요.`;

  let prompt;
  if (cat === 'case') {
    prompt = `당신은 한국상담학회 전문상담사 수련감독자입니다. 아래 사례개념화 문제에 대해 "${theory}" 관점에서 모범답안 초안을 작성하세요.

[사례]
${questionText}

[평가포인트 — 반드시 다뤄야 할 요소]
${tipsBlock}

[상담이론]
${theory}

한국어로, "${theory}" 관점이 명확히 드러나는 완결된 모범답안을 작성하세요 (400~600자 내외). 평가포인트를 자연스럽게 녹여내되 항목을 그대로 나열하지 말고 하나의 답변으로 통합하세요. 이 답변은 AI가 생성한 초안이며 관리자의 검토·수정을 거칠 예정이므로, 확정된 것처럼 단정적으로 쓰기보다는 표준적인 모범답안 형태로 작성하세요.

${OUTPUT_FORMAT_BLOCK}`;
  } else if (cat === 'supervision') {
    prompt = `당신은 한국상담학회 전문상담사 수련감독자입니다. 아래는 수퍼비전 이론/모델을 설명하는 문제입니다. 이 문제에 대한 모범답안 초안을 작성하세요.

[문제]
${questionText}

[평가포인트 — 반드시 다뤄야 할 요소]
${tipsBlock}

한국어로, 해당 수퍼비전 이론/모델의 핵심 개념·특징·상담 실무(수퍼바이지 지도)에서의 적용을 중심으로 완결된 모범답안을 작성하세요 (400~600자 내외). 평가포인트를 자연스럽게 녹여내되 항목을 그대로 나열하지 말고 하나의 답변으로 통합하세요. 이 답변은 AI가 생성한 초안이며 관리자의 검토·수정을 거칠 예정이므로, 확정된 것처럼 단정적으로 쓰기보다는 표준적인 모범답안 형태로 작성하세요.

${OUTPUT_FORMAT_BLOCK}`;
  } else {
    prompt = `당신은 한국상담학회 전문상담사 수련감독자입니다. 아래 상담윤리 문제에 대한 모범답안 초안을 작성하세요.

[문제]
${questionText}

[평가포인트 — 반드시 다뤄야 할 요소]
${tipsBlock}

한국어로, 실제 면접에서 말할 수 있는 수준의 완결된 모범답안을 작성하세요 (400~600자 내외). 평가포인트를 자연스럽게 녹여내되 항목을 그대로 나열하지 말고 하나의 답변으로 통합하세요. 관련 윤리강령 근거(비밀보장 예외, 신고의무 등)가 있다면 포함하세요. 이 답변은 AI가 생성한 초안이며 관리자의 검토·수정을 거칠 예정이므로, 확정된 것처럼 단정적으로 쓰기보다는 표준적인 모범답안 형태로 작성하세요.

${OUTPUT_FORMAT_BLOCK}`;
  }

  const draftText = await callGemini(prompt, 3000);
  return sanitizeAiDraftText(draftText);
}

// ─────────────────────────────────────────────────────────────────
// [AI-DRAFT-QUEUE] Phase 2 — 문제 등록 시 모범답안 초안 자동 생성 on/off.
// 카테고리별로 관리자가 켜고 끌 수 있습니다(기본 전부 ON). interview_feature_flags를
// boolean(enabled)으로 재사용합니다.
// ─────────────────────────────────────────────────────────────────
export const AUTO_DRAFT_DEFAULTS = {
  autoDraftCase: true,
  autoDraftEthics: true,
  autoDraftSupervision: true,
};
export const AUTO_DRAFT_KEYS = Object.keys(AUTO_DRAFT_DEFAULTS);

export async function getAutoDraftFlags() {
  const { data, error } = await supabase
    .from('interview_feature_flags')
    .select('key, enabled')
    .in('key', AUTO_DRAFT_KEYS);
  if (error) throw error;
  const flags = { ...AUTO_DRAFT_DEFAULTS };
  (data || []).forEach(r => { if (r.key in flags) flags[r.key] = !!r.enabled; });
  return flags;
}

// [AI-DRAFT-QUEUE] 사례개념화 신규 문제 등록 시, 한 번에 자동 초안을 생성할
// 상담이론 최대 개수(interview_theory_options 프리셋 기준) — Gemini 호출이
// 병렬이라도 너무 많으면 요청이 오래 걸려 제한을 둡니다.
export const AUTO_DRAFT_CASE_THEORY_LIMIT = 8;

// ─────────────────────────────────────────────────────────────────
// [PRACTICE-DAILY-LIMIT] "오늘"을 한국시간(KST, UTC+9) 기준 자정~자정으로 계산해
// ISO 문자열 범위로 돌려줍니다. 서버는 UTC로 도니, KST 자정을 UTC로 환산합니다.
// ─────────────────────────────────────────────────────────────────
export function getTodayRangeKST() {
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const nowKst = new Date(Date.now() + KST_OFFSET_MS);
  const y = nowKst.getUTCFullYear(), m = nowKst.getUTCMonth(), d = nowKst.getUTCDate();
  const startUtc = new Date(Date.UTC(y, m, d) - KST_OFFSET_MS);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: startUtc.toISOString(), endIso: endUtc.toISOString() };
}

// [PRACTICE-TIME-ADMIN-ONLY] 사례개념화·상담윤리·수퍼비전의 준비/답변 시간(초) — AI 자율연습과
// AI 면접 코스 양쪽 모두 이 전역 공통값을 씁니다. interview_feature_flags를 key/value
// 저장소로 재사용하며, 이 6개 키는 enabled 대신 value_seconds 컬럼에 값을 넣습니다.
export const PRACTICE_TIME_DEFAULTS = {
  practicePrepSecCase: 900, practiceAnsSecCase: 180,
  practicePrepSecEthics: 30, practiceAnsSecEthics: 180,
  practicePrepSecSupervision: 20, practiceAnsSecSupervision: 360,
};
export const PRACTICE_TIME_KEYS = Object.keys(PRACTICE_TIME_DEFAULTS);

// [PRACTICE-TIME-ADMIN-ONLY] 위 6개 값을 DB에서 읽어와 기본값과 합쳐 돌려줍니다. 'feature-flags'
// 조회와 'schedule-list'(AI 면접 코스 수련생 화면) 양쪽에서 공통으로 씁니다.
export async function getPracticeTimeSettings() {
  const { data, error } = await supabase
    .from('interview_feature_flags')
    .select('key, value_seconds')
    .in('key', PRACTICE_TIME_KEYS);
  if (error) throw error;
  const settings = { ...PRACTICE_TIME_DEFAULTS };
  (data || []).forEach(r => {
    if (r.key in settings && r.value_seconds !== null && r.value_seconds !== undefined) {
      settings[r.key] = r.value_seconds;
    }
  });
  return settings;
}

// [FREE-TRIAL-USAGE-CAP] Free(체험판) 회원은 하루 단위 초기화가 아니라, 관리자가
// 지정한 기본 사례(사례개념화·상담윤리)를 각각 최대 이 횟수만큼만 평생 사용할 수
// 있습니다. 이후에는 "코칭 면접 코스" 등록(Premium)이 필요합니다. 관리자가 admin.html
// "⚙️ 설정" 탭에서 직접 조정할 수 있도록, scheduleMinIntervalDays와 동일한 패턴으로
// interview_feature_flags.value_seconds를 범용 숫자 저장소로 재사용합니다.
export const FREE_TRIAL_USES_PER_CASE_KEY = 'freeTrialUsesPerCase';
export const FREE_TRIAL_USES_PER_CASE_DEFAULT = 5;

export async function getFreeTrialUsesPerCase() {
  const { data, error } = await supabase
    .from('interview_feature_flags')
    .select('value_seconds')
    .eq('key', FREE_TRIAL_USES_PER_CASE_KEY)
    .maybeSingle();
  if (error) throw error;
  return (data && data.value_seconds !== null && data.value_seconds !== undefined)
    ? data.value_seconds
    : FREE_TRIAL_USES_PER_CASE_DEFAULT;
}

// [FREE-TRIAL-USAGE-CAP] 현재 관리자가 지정한 기본 사례 문제 id를 카테고리별로
// 돌려줍니다. practice.js의 제출 시 콘텐츠 제한 체크와 사용 횟수 집계가 함께 씁니다.
export async function getDefaultCaseQuestionIdsByCat() {
  const { data, error } = await supabase
    .from('interview_questions')
    .select('id, cat')
    .in('cat', ['case', 'ethics'])
    .eq('is_default_case', true);
  if (error) throw error;
  const idsByCat = { case: new Set(), ethics: new Set() };
  (data || []).forEach(r => {
    if (idsByCat[r.cat]) idsByCat[r.cat].add(String(r.id));
  });
  return idsByCat;
}

// [FREE-TRIAL-USAGE-CAP] Free 회원의 지금까지 전체 제출 기록에서, 기본 사례
// 문제로 제출된 횟수를 사례개념화/상담윤리 각각 세어 반환합니다(하루 단위가
// 아니라 평생 누적입니다). [DELETE-QUOTA-FIX] 수련생이 "연습 기록"에서 스스로
// 삭제(soft-delete)해도 이미 사용한 무료 체험 횟수는 그대로 유지되어야 하므로,
// 소프트 삭제된 기록도 포함해서 셉니다 — 목록 화면에서만 사라질 뿐, 삭제한다고
// 무료 체험 횟수를 다시 얻을 수는 없습니다.
export async function getFreeTrialUsageCounts(userId) {
  const idsByCat = await getDefaultCaseQuestionIdsByCat();
  const { data, error } = await supabase
    .from('practice_sessions')
    .select('answers')
    .eq('user_id', userId);
  if (error) throw error;
  const counts = { case: 0, ethics: 0 };
  (data || []).forEach(row => {
    (Array.isArray(row.answers) ? row.answers : []).forEach(a => {
      if (!a || !a.cat || a.questionId === undefined || a.questionId === null) return;
      const qid = String(a.questionId);
      if (a.cat === 'case' && idsByCat.case.has(qid)) counts.case++;
      if (a.cat === 'ethics' && idsByCat.ethics.has(qid)) counts.ethics++;
    });
  });
  return counts;
}

// [PREMIUM-CASE-POOL] Premium(승인) 회원은 무제한이 아니라, 카테고리(사례개념화·
// 상담윤리)별로 관리자가 지정한 "개수"만큼만 사례 풀로 제공되고, 그 풀 안에서
// 사례 하나당 정해진 횟수까지만 연습할 수 있습니다. Free 체험판(is_default_case)과
// 달리 관리자가 문제를 하나하나 지정하지 않고, "몇 개"만 설정하면 그 안의 구성
// 문제는 seq_no 오름차순(모범답안이 등록된 문제 중에서만)으로 자동 결정됩니다 —
// 문제를 새로 추가/변경해도 관리자가 별도로 손댈 필요가 없습니다. FREE_TRIAL과
// 동일하게 interview_feature_flags.value_seconds를 범용 숫자 저장소로 재사용합니다.
export const PREMIUM_CASE_POOL_SIZE_KEY = 'premiumCasePoolSize';
export const PREMIUM_CASE_POOL_SIZE_DEFAULT = 10;
export const PREMIUM_USES_PER_CASE_KEY = 'premiumUsesPerCase';
export const PREMIUM_USES_PER_CASE_DEFAULT = 5;

export async function getPremiumCasePoolSize() {
  const { data, error } = await supabase
    .from('interview_feature_flags')
    .select('value_seconds')
    .eq('key', PREMIUM_CASE_POOL_SIZE_KEY)
    .maybeSingle();
  if (error) throw error;
  return (data && data.value_seconds !== null && data.value_seconds !== undefined)
    ? data.value_seconds
    : PREMIUM_CASE_POOL_SIZE_DEFAULT;
}

export async function getPremiumUsesPerCase() {
  const { data, error } = await supabase
    .from('interview_feature_flags')
    .select('value_seconds')
    .eq('key', PREMIUM_USES_PER_CASE_KEY)
    .maybeSingle();
  if (error) throw error;
  return (data && data.value_seconds !== null && data.value_seconds !== undefined)
    ? data.value_seconds
    : PREMIUM_USES_PER_CASE_DEFAULT;
}

// [PREMIUM-CASE-POOL] 카테고리(case/ethics)별로 "공개되어 있고 모범답안이 등록된"
// 문제를 seq_no 오름차순으로 정렬해, 설정된 풀 크기만큼 앞에서부터 잘라 문제 id를
// 돌려줍니다. bank()의 사례개념화 모범답안 판정(승인된 이론만 인정)과 동일한
// 기준을 그대로 씁니다.
export async function getPremiumCasePoolQuestionIdsByCat() {
  const poolSize = await getPremiumCasePoolSize();
  const { data, error } = await supabase
    .from('interview_questions')
    .select('id, cat, seq_no, model_answer, model_answer_status')
    .eq('is_active', true)
    .eq('usage_scope', 'practice')
    .in('cat', ['case', 'ethics'])
    .lte('release_at', new Date().toISOString())
    .order('seq_no', { ascending: true });
  if (error) throw error;

  const caseIds = (data || []).filter(r => r.cat === 'case').map(r => r.id);
  let approvedTheoryCountByQuestion = {};
  if (caseIds.length > 0) {
    const { data: theoryRows, error: theoryErr } = await supabase
      .from('interview_case_model_answers')
      .select('question_id')
      .in('question_id', caseIds)
      .eq('status', 'approved');
    if (theoryErr) throw theoryErr;
    approvedTheoryCountByQuestion = (theoryRows || []).reduce((acc, r) => {
      acc[r.question_id] = (acc[r.question_id] || 0) + 1;
      return acc;
    }, {});
  }

  const hasModelAnswer = (r) => r.cat === 'case'
    ? (approvedTheoryCountByQuestion[r.id] || 0) > 0
    : !!(r.model_answer && r.model_answer.trim()) && r.model_answer_status !== 'draft';

  const idsByCat = { case: [], ethics: [] };
  (data || []).forEach(r => {
    if (!idsByCat[r.cat]) return;
    if (idsByCat[r.cat].length >= poolSize) return;
    if (hasModelAnswer(r)) idsByCat[r.cat].push(String(r.id));
  });
  return {
    case: new Set(idsByCat.case),
    ethics: new Set(idsByCat.ethics),
    poolSize
  };
}

// [PREMIUM-CASE-POOL] Premium 회원의 지금까지 전체 제출 기록에서, 풀에 속한 문제별
// 제출 횟수를 세어 반환합니다(하루 단위가 아니라 평생 누적, Free 체험판과 동일하게
// 소프트 삭제된 기록도 포함해서 셉니다 — 기록을 삭제해도 사용 횟수는 그대로 유지).
export async function getPremiumCaseUsageCounts(userId) {
  const pool = await getPremiumCasePoolQuestionIdsByCat();
  const { data, error } = await supabase
    .from('practice_sessions')
    .select('answers')
    .eq('user_id', userId);
  if (error) throw error;
  const byQuestion = {};
  (data || []).forEach(row => {
    (Array.isArray(row.answers) ? row.answers : []).forEach(a => {
      if (!a || !a.cat || a.questionId === undefined || a.questionId === null) return;
      const qid = String(a.questionId);
      if ((a.cat === 'case' && pool.case.has(qid)) || (a.cat === 'ethics' && pool.ethics.has(qid))) {
        byQuestion[qid] = (byQuestion[qid] || 0) + 1;
      }
    });
  });
  return { pool, byQuestion };
}

// ─────────────────────────────────────────────────────────────────
// [COACHING-FLAG-SYNC][FREE-TRIAL-ARCHIVE] 코칭(실시간) 팀 배정으로 Premium이
// 되는 순간 호출합니다. Free 회원은 저장 시점에 기본 사례(is_default_case=true)
// 문제만 제출할 수 있도록 막혀 있으므로, 한 세션의 답변이 전부 기본 사례
// 문제로만 이루어져 있으면 체험판 시절 기록으로 판단해 soft-delete(deleted_at)
// 처리합니다 — "연습 기록" 화면과 체험 횟수 집계에서 자연스럽게 사라집니다.
// 그 외 문제가 하나라도 섞여 있는 세션(이미 프리미엄/다른 경로로 저장된 정상
// 기록)은 절대 건드리지 않습니다. 실패해도 등급 변경 자체는 이미 끝났으므로
// 예외를 던지지 않고 로그만 남깁니다.
// ─────────────────────────────────────────────────────────────────
export async function archiveFreeTrialPracticeSessions(userId) {
  try {
    const idsByCat = await getDefaultCaseQuestionIdsByCat();
    const allDefaultIds = new Set([...idsByCat.case, ...idsByCat.ethics]);
    if (allDefaultIds.size === 0) return; // 기본 사례가 지정돼 있지 않으면 판단할 수 없으므로 건드리지 않음

    const { data: sessions, error: fetchErr } = await supabase
      .from('practice_sessions')
      .select('id, answers')
      .eq('user_id', userId)
      .is('deleted_at', null);
    if (fetchErr) throw fetchErr;

    const idsToArchive = (sessions || [])
      .filter(s => {
        const answers = Array.isArray(s.answers) ? s.answers : [];
        if (answers.length === 0) return false;
        return answers.every(a =>
          a && a.questionId !== undefined && a.questionId !== null && allDefaultIds.has(String(a.questionId))
        );
      })
      .map(s => s.id);

    if (idsToArchive.length === 0) return;

    const { error: updErr } = await supabase
      .from('practice_sessions')
      .update({ deleted_at: new Date().toISOString() })
      .in('id', idsToArchive);
    if (updErr) throw updErr;

    console.log(`[interview.js] Free 체험판 AI자율연습 기록 ${idsToArchive.length}건 보관 처리(연습 기록에서 제외) — user:`, userId);
  } catch (e) {
    console.error('[interview.js] Free 체험판 AI자율연습 기록 정리 실패(무시하고 계속 진행):', e.message);
  }
}

// [PRACTICE-DAILY-LIMIT] 오늘(KST) 이 사용자가 이미 AI 자율연습에서 다룬 카테고리 집합을 돌려줍니다.
// AI 자율연습 세션은 항상 사례개념화 1개 + 상담윤리 1개가 한 세트로 저장되므로, 보통 둘 다 함께
// 나타나지만 문제 풀이 상황(한쪽 문제풀이 없음 등)에 대비해 카테고리별로 따로 집계합니다.
// [FREE-TRIAL-USAGE-CAP] Free 회원에게는 이 함수 대신 위 getFreeTrialUsageCounts()가
// 적용됩니다(하루 제한이 아니라 총 사용 횟수 제한).
export async function getPracticeCatsUsedToday(userId) {
  const { startIso, endIso } = getTodayRangeKST();
  // [DELETE-QUOTA-FIX] 이전에는 소프트 삭제된 기록을 오늘 사용량 집계에서도
  // 제외했는데, 그러면 수련생이 "전체 기록 삭제"로 오늘 한 연습을 지운 뒤 같은
  // 카테고리를 하루에 또 연습할 수 있는 허점이 생깁니다. 화면 목록에는 삭제된
  // 것처럼 보이는 게 맞지만(연습 기록 화면), "오늘 이미 했는지" 판단은 삭제
  // 여부와 무관하게 실제로 연습을 수행했는지를 봐야 하므로 deleted_at 필터를
  // 제거합니다.
  const { data, error } = await supabase
    .from('practice_sessions')
    .select('answers')
    .eq('user_id', userId)
    .gte('created_at', startIso)
    .lt('created_at', endIso);
  if (error) throw error;
  const cats = new Set();
  (data || []).forEach(row => {
    (Array.isArray(row.answers) ? row.answers : []).forEach(a => { if (a && a.cat) cats.add(a.cat); });
  });
  return cats;
}

// ─────────────────────────────────────────────────────────────────
// [HISTORY-SOURCE-SPLIT] "연습 기록" 화면(본인용 list(), 관리자용 adminSessions())
// 양쪽에서 세션마다 AI 자율연습('practice') / 코칭 면접 코스('coaching', 소속 팀의
// delivery_mode='live') / AI 면접 코스('course', delivery_mode='async')를 구분할 수
// 있도록 sourceType을 계산해 붙여 돌려줍니다. schedule_id가 없으면 AI 자율연습(팀
// 배정과 무관하게 개인이 진행)입니다.
// ─────────────────────────────────────────────────────────────────
export async function annotateSessionsWithSourceType(sessions) {
  const scheduleIds = Array.from(new Set(sessions.map(s => s.schedule_id).filter(Boolean)));
  const deliveryModeByScheduleId = {};
  // [COACHING-LIVE-INFO] "연습 기록"에서 코칭 면접 코스의 피드백 비공개 안내에 실시간
  // 세션 날짜/시간·줌 링크를 함께 보여주기 위해, 스케줄 항목에 등록된 값을 세션마다
  // 붙여줍니다. schedule_id -> team_id를 조회하는 김에 같은 쿼리에서 함께 가져옵니다.
  const liveMetaByScheduleId = {};
  if (scheduleIds.length > 0) {
    const { data: schedRows, error: schedErr } = await supabase
      .from('interview_team_schedule')
      .select('id, team_id, live_session_time, live_meeting_link')
      .in('id', scheduleIds);
    if (schedErr) throw schedErr;
    const teamIdByScheduleId = {};
    (schedRows || []).forEach(r => {
      teamIdByScheduleId[r.id] = r.team_id;
      liveMetaByScheduleId[r.id] = {
        liveSessionTime: r.live_session_time || null,
        liveMeetingLink: r.live_meeting_link || null
      };
    });
    const teamIds = Array.from(new Set(Object.values(teamIdByScheduleId)));
    if (teamIds.length > 0) {
      const { data: teamRows, error: teamRowsErr } = await supabase
        .from('interview_teams')
        .select('id, delivery_mode')
        .in('id', teamIds);
      if (teamRowsErr) throw teamRowsErr;
      const deliveryModeByTeamId = {};
      (teamRows || []).forEach(t => { deliveryModeByTeamId[t.id] = t.delivery_mode || 'async'; });
      Object.entries(teamIdByScheduleId).forEach(([scheduleId, teamId]) => {
        deliveryModeByScheduleId[scheduleId] = deliveryModeByTeamId[teamId] || 'async';
      });
    }
  }
  return sessions.map(s => {
    const sourceType = !s.schedule_id
      ? 'practice'
      : (deliveryModeByScheduleId[s.schedule_id] === 'live' ? 'coaching' : 'course');
    const liveMeta = s.schedule_id ? (liveMetaByScheduleId[s.schedule_id] || {}) : {};
    return {
      ...s,
      sourceType,
      liveSessionTime: liveMeta.liveSessionTime || null,
      liveMeetingLink: liveMeta.liveMeetingLink || null
    };
  });
}

// ─────────────────────────────────────────────────────────────────
// [SEQ-NO] 카테고리별(사례개념화/상담윤리 각각 독립적으로) 다음 일련번호 조회.
// 신규 질문 생성 시에만 호출하며, 수정 시에는 기존 번호를 그대로 둡니다.
// ─────────────────────────────────────────────────────────────────
export async function getNextSeqNo(cat) {
  const { data, error } = await supabase
    .from('interview_questions')
    .select('seq_no')
    .eq('cat', cat)
    .order('seq_no', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.seq_no || 0) + 1;
}

// ─────────────────────────────────────────────────────────────────
// JWT 검증 헬퍼 — questions.js/admin.js와 동일한 방식
// ─────────────────────────────────────────────────────────────────
export async function verifyUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;

  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('user_status, name, email')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) return null;

  return {
    id: user.id,
    email: profile.email || user.email,
    name: profile.name || '',
    user_status: profile.user_status
  };
}

// ─────────────────────────────────────────────────────────────────
// [ACCESS-EXPIRY] 활성 팀 소속 정보(팀id/급수/만료여부)를 한 번에 조회하는
// 공용 헬퍼 — getInterviewAccess/getActiveTeamId/getUserGrade가 모두 이 결과를
// 재사용합니다. access_expires_at이 NULL이면 무제한(과거 배정 등 하위호환),
// 값이 있고 이미 지난 시각이면 만료로 취급합니다. 만료돼도 팀 소속 행 자체는
// 그대로 남아있으므로 teamId/grade는 항상 채워집니다 — "새 제출 차단"은
// isExpired를 확인하는 호출부(getInterviewAccess/getActiveTeamId)에서 합니다.
// ─────────────────────────────────────────────────────────────────
export async function getActiveMembership(userId) {
  const { data, error } = await supabase
    .from('interview_team_members')
    .select('team_id, access_expires_at, interview_teams(status, grade, delivery_mode)')
    .eq('user_id', userId)
    .is('removed_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.interview_teams?.status !== 'active') return null;
  const isExpired = !!(data.access_expires_at && new Date(data.access_expires_at) < new Date());
  return {
    teamId: data.team_id,
    grade: data.interview_teams?.grade || null,
    deliveryMode: data.interview_teams?.delivery_mode || null,
    isExpired
  };
}

// ─────────────────────────────────────────────────────────────────
// [COACHING-FLAG-SYNC] assignUserToTeam()이 코칭(실시간) 팀 배정 시 자동으로
// 올려준 user_subscriptions(coaching_interview) Premium 플래그를, 팀 제거/해체
// 시 다시 Free로 되돌립니다. 되돌리기 전에 다른 활성 코칭(실시간) 팀 소속이
// 남아있는지 먼저 확인합니다(getActiveMembership 재사용) — 남아있으면 그대로
// 둡니다. 관리자가 팀과 무관하게 수동으로 이 플래그를 켜둔 경우에도, 이 시점에
// 코칭 팀 소속이 없다면 함께 Free로 되돌아갑니다(필요하면 수동으로 다시 켤 수
// 있음). 실패해도 팀 제거/해체 자체(핵심 기능)는 이미 끝났으므로 예외를 던지지
// 않고 로그만 남깁니다.
// ─────────────────────────────────────────────────────────────────
export async function revokeCoachingSubscriptionIfNoLiveTeam(userId) {
  try {
    const membership = await getActiveMembership(userId);
    if (membership && membership.deliveryMode === 'live') return;

    const { data: sub, error: subErr } = await supabase
      .from('user_subscriptions')
      .select('status')
      .eq('user_id', userId)
      .eq('exam_type', 'coaching_interview')
      .maybeSingle();
    if (subErr) throw subErr;
    if (!sub || sub.status !== 'premium') return;

    const { error: updErr } = await supabase
      .from('user_subscriptions')
      .update({ status: 'free', expiry_date: null })
      .eq('user_id', userId)
      .eq('exam_type', 'coaching_interview');
    if (updErr) throw updErr;
    console.log('[interview.js] coaching_interview Premium 자동 회수 —', userId);
  } catch (e) {
    console.error('[interview.js] coaching_interview Premium 자동 회수 실패(무시하고 계속 진행):', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// [COACHING-FLAG-SYNC] revokeCoachingSubscriptionIfNoLiveTeam()의 역방향입니다.
// 관리자가 "회원 권한 관리"에서 코칭면접코스(coaching_interview)를 수동으로
// Free로 되돌리면, 그 사람이 현재 소속된 코칭(실시간, delivery_mode='live')
// 팀에서도 함께 제외합니다 — Free인데 코칭 팀에 남아있는 불일치 상태를 막기
// 위함입니다. AI 면접 코스(async) 팀은 이 플래그와 무관하므로 건드리지
// 않습니다. 실패해도 Free 전환 자체(핵심 기능)는 이미 끝났으므로 예외를 던지지
// 않고 로그만 남깁니다.
// ─────────────────────────────────────────────────────────────────
export async function removeUserFromLiveTeamOnCoachingDowngrade(userId) {
  try {
    const membership = await getActiveMembership(userId);
    if (!membership || membership.deliveryMode !== 'live') return;

    const { error } = await supabase
      .from('interview_team_members')
      .update({ removed_at: new Date().toISOString() })
      .eq('team_id', membership.teamId)
      .eq('user_id', userId)
      .is('removed_at', null);
    if (error) throw error;

    console.log('[interview.js] 코칭면접코스 수동 Free 전환 — 소속 코칭(실시간) 팀에서 자동 제외:', userId, membership.teamId);
  } catch (e) {
    console.error('[interview.js] 코칭면접코스 Free 전환 시 팀 제외 처리 실패(무시하고 계속 진행):', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// [PRACTICE-ONLY] 팀(코스) 배정 없이 "AI 자율연습"만 단독으로 신청/승인된
// 사용자의 접근 권한을 조회합니다. interview_practice_only_access 테이블에
// 행이 있고 access_expires_at이 지나지 않았으면 유효합니다.
// ─────────────────────────────────────────────────────────────────
export async function getPracticeOnlyAccess(userId) {
  const { data, error } = await supabase
    .from('interview_practice_only_access')
    .select('grade, access_expires_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const isExpired = !!(data.access_expires_at && new Date(data.access_expires_at) < new Date());
  return { grade: data.grade || null, isExpired };
}

// ─────────────────────────────────────────────────────────────────
// [COACHING-FLAG] "회원 권한 관리" 화면에서 관리자가 팀 배정과 무관하게 직접
// 부여/회수하는 코칭면접코스 Premium 플래그입니다. user_subscriptions에
// exam_type='coaching_interview'로 저장되며, 다른 자격증(clinical_psych/
// youth_counselor)과 동일한 FREE/PREMIUM 토글·만료일 UI를 그대로 재사용합니다.
// 이 플래그로 premium이 되면 팀 소속과 동일하게 AI자율연습이 전면 무료로
// 풀리지만, 급수 정보가 없으므로 1급 전용 수퍼비전은 포함하지 않습니다(1급/
// 수퍼비전까지 필요하면 "팀 관리"에서 팀 배정을 사용해야 합니다).
// ─────────────────────────────────────────────────────────────────
export async function getCoachingSubscriptionAccess(userId) {
  const { data, error } = await supabase
    .from('user_subscriptions')
    .select('status, expiry_date')
    .eq('user_id', userId)
    .eq('exam_type', 'coaching_interview')
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status !== 'premium') return null;
  const isExpired = !!(data.expiry_date && new Date(data.expiry_date) < new Date());
  return { isExpired };
}

// ─────────────────────────────────────────────────────────────────
// [TEAM-MGMT] 접근 판정 — 개인별 구독 대신 "현재 활성 팀에 소속되어
// 있는지"로 판단합니다. admin은 무조건 통과. 팀이 해체(status='dissolved')
// 되었거나 소속 자체가 없으면 free(이용 제한)입니다.
// [ACCESS-EXPIRY] 소속은 있지만 access_expires_at이 지났으면 'expired'를
// 반환합니다 — 'free'와 구분해 프론트가 "재신청 필요" 안내를 다르게 보여줄
// 수 있게 합니다(과거 연습 기록 조회는 access 상태와 무관하게 항상 허용됨).
// ─────────────────────────────────────────────────────────────────
export async function getInterviewAccess(userId, userStatus) {
  if (userStatus === 'admin') return 'admin';

  let membership;
  try {
    membership = await getActiveMembership(userId);
  } catch (error) {
    console.warn('[interview.js] interview_team_members 조회 실패:', error.message);
    return 'free';
  }

  // [COACHING-ONLY-PREMIUM] 회원 등급(Premium/Free)은 "코칭 면접 코스"
  // (delivery_mode='live') 소속 여부로만 결정합니다. "AI 면접 코스"(async) 팀
  // 소속은 그 자체로는 회원 등급에 영향을 주지 않습니다 — AI 면접 코스 제출
  // 가능 여부는 이 함수와 무관하게 getActiveTeamId()가 그대로 판정합니다.
  if (membership && membership.deliveryMode === 'live') {
    return membership.isExpired ? 'expired' : 'premium';
  }

  // [COACHING-FLAG] 팀 배정 없이도, 관리자가 "회원 권한 관리"에서 직접 부여한
  // 코칭면접코스 Premium 플래그가 있으면 premium으로 처리합니다.
  let coachingSub;
  try {
    coachingSub = await getCoachingSubscriptionAccess(userId);
  } catch (error) {
    console.warn('[interview.js] user_subscriptions(coaching_interview) 조회 실패:', error.message);
    coachingSub = null;
  }
  if (coachingSub) return coachingSub.isExpired ? 'expired' : 'premium';

  // [PRACTICE-ONLY] 팀 소속이 없어도 AI 자율연습 단독 신청이 승인된 사용자는
  // premium으로 처리합니다(단, AI 면접 코스 일정은 여전히 비어 있습니다 —
  // schedule-list가 teamId=null을 반환해 자연스럽게 걸러집니다).
  let practiceOnly;
  try {
    practiceOnly = await getPracticeOnlyAccess(userId);
  } catch (error) {
    console.warn('[interview.js] interview_practice_only_access 조회 실패:', error.message);
    return 'free';
  }
  if (!practiceOnly) return 'free';
  return practiceOnly.isExpired ? 'expired' : 'premium';
}

// ─────────────────────────────────────────────────────────────────
// [TEAM-SCHEDULE] 오늘 날짜를 KST(Asia/Seoul, UTC+9, 서머타임 없음) 기준
// YYYY-MM-DD 문자열로 반환합니다. 서버는 UTC로 도는 것을 전제로 합니다(Vercel).
// ─────────────────────────────────────────────────────────────────
export function todayKstDateString() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────
// [TEAM-SCHEDULE] 유저가 현재 소속된 활성 팀의 id만 반환합니다(없거나 이용
// 기간이 만료됐으면 null). getInterviewAccess와 동일한 판정 기준을 씁니다.
// ─────────────────────────────────────────────────────────────────
export async function getActiveTeamId(userId) {
  const membership = await getActiveMembership(userId);
  if (!membership || membership.isExpired) return null;
  return membership.teamId;
}

// ─────────────────────────────────────────────────────────────────
// [SUPERVISION-GRADE-GATE] 유저가 현재 소속된 활성 팀의 급수('1'/'2')를 반환합니다.
// 소속 팀이 없으면(free 상태 등) null을 반환합니다 — admin은 이 함수를 쓰지 않고
// 호출부에서 무조건 전체 노출로 처리합니다. [ACCESS-EXPIRY] 이 함수는 만료
// 여부와 무관하게 팀 소속 급수를 그대로 반환합니다 — 만료 자체는 이 함수를
// 호출하기 전에 getInterviewAccess/getActiveTeamId가 이미 걸러내므로 여기서는
// 급수 판정만 순수하게 담당합니다.
// ─────────────────────────────────────────────────────────────────
export async function getUserGrade(userId) {
  const membership = await getActiveMembership(userId);
  if (membership) return membership.grade;
  const practiceOnly = await getPracticeOnlyAccess(userId);
  return practiceOnly ? practiceOnly.grade : null;
}

// ─────────────────────────────────────────────────────────────────
// [TEAM-MGMT] 유저를 팀에 배정하는 공통 헬퍼.
// 기존에 소속된 활성 팀이 있으면 먼저 제거(removed_at 채움) 처리한 뒤
// 새 팀 소속 행을 추가합니다 — "한 시점에 한 팀만" 규칙을 코드 레벨에서도
// 지킵니다(DB에는 partial unique index로도 강제되어 있습니다).
// [ACCESS-EXPIRY] 신규 배정 시 access_expires_at을 배정 시각 + 3개월로 채웁니다
// (Phase 8 — 이용권 유효기간 3개월). 갱신(재신청 승인)도 이 함수를 그대로 다시
// 타므로 매번 새 3개월이 적용됩니다.
// ─────────────────────────────────────────────────────────────────
export async function assignUserToTeam(userId, teamId, grantedBy = null) {
  const { data: team, error: teamErr } = await supabase
    .from('interview_teams')
    .select('id, status, delivery_mode')
    .eq('id', teamId)
    .maybeSingle();
  if (teamErr) throw teamErr;
  if (!team) throw new Error('존재하지 않는 팀입니다.');
  if (team.status !== 'active') throw new Error('해체된 팀에는 배정할 수 없습니다.');

  const { error: removeErr } = await supabase
    .from('interview_team_members')
    .update({ removed_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('removed_at', null);
  if (removeErr) throw removeErr;

  const accessExpiresAt = new Date();
  accessExpiresAt.setMonth(accessExpiresAt.getMonth() + 3);

  const { error: insertErr } = await supabase
    .from('interview_team_members')
    .insert({ team_id: teamId, user_id: userId, access_expires_at: accessExpiresAt.toISOString() });
  if (insertErr) throw insertErr;

  // [COACHING-FLAG-SYNC] 코칭(실시간, delivery_mode='live') 팀에 배정되면
  // "회원 권한 관리" 화면의 코칭면접코스 열(user_subscriptions.exam_type=
  // 'coaching_interview')도 함께 Premium으로 맞춰줍니다 — 실제 접근 권한
  // (getInterviewAccess)은 이미 팀 소속만으로 premium 판정되지만, 화면 표시가
  // 그것과 어긋나 보이지 않도록 하기 위함입니다. AI 면접 코스(async) 팀 배정은
  // 원래 이 플래그와 무관하므로 건드리지 않습니다. 동기화가 실패해도 팀 배정
  // 자체(핵심 기능)는 이미 끝났으므로 예외를 던지지 않고 로그만 남깁니다.
  if (team.delivery_mode === 'live') {
    try {
      const { error: subErr } = await supabase
        .from('user_subscriptions')
        .upsert([{
          user_id: userId,
          exam_type: 'coaching_interview',
          status: 'premium',
          expiry_date: accessExpiresAt.toISOString()
        }], { onConflict: 'user_id,exam_type' });
      if (subErr) throw subErr;

      const historyRow = {
        user_id    : userId,
        exam_type  : 'coaching_interview',
        months     : 3,
        granted_at : new Date().toISOString(),
        expiry_date: accessExpiresAt.toISOString(),
        source     : 'team-assignment'
      };
      if (grantedBy) historyRow.granted_by = grantedBy;
      const { error: historyErr } = await supabase
        .from('subscription_history')
        .insert([historyRow]);
      if (historyErr) {
        console.error('[interview.js] subscription_history(coaching_interview) 기록 실패(무시하고 계속 진행):', historyErr.message);
      }
    } catch (e) {
      console.error('[interview.js] user_subscriptions(coaching_interview) 동기화 실패(팀 배정 자체는 완료됨):', e.message);
    }

    // [FREE-TRIAL-ARCHIVE] Premium 전환과 동시에, 그 이전 Free 체험판 시절
    // AI 자율연습 기록을 연습 기록에서 보이지 않도록 정리합니다.
    await archiveFreeTrialPracticeSessions(userId);
  }
}

// ─────────────────────────────────────────────────────────────────
// [TEAM-MGMT] Resend 메일 발송 공통 헬퍼 — slack-action.js의 sendEmail과 동일한
// 패턴입니다. 실패해도 예외를 던지지 않고 로그만 남깁니다(알림 실패로 본 기능이
// 막히면 안 되므로).
// ─────────────────────────────────────────────────────────────────
export async function sendEmail({ to, subject, html }) {
  const resendKey = process.env.RESEND_API_KEY;
  // [BRANDING] 수신자에게 표시되는 발신자명을 'MindPass'로 통일합니다.
  const fromEmail = `MindPass <${process.env.MAIL_FROM || 'onboarding@resend.dev'}>`;
  // [SETTINGS-2] MAIL_FROM은 실제로 받는 메일함이 없는 주소일 수 있으므로,
  // 수신자가 "답장"을 누르면 문의 이메일로 가도록 reply_to를 함께 지정합니다.
  const replyTo = await getContactEmail();
  if (!resendKey) {
    console.error('[interview.js] RESEND_API_KEY 환경변수 누락 — 메일 발송 생략:', subject);
    return;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendKey}` },
      body: JSON.stringify({ from: fromEmail, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) })
    });
    const data = await r.json();
    if (!r.ok) console.error('[interview.js] Resend 오류:', JSON.stringify(data));
  } catch (e) {
    console.error('[interview.js] 메일 발송 예외:', e.message);
  }
}

// [TEAM-MGMT] "팀 배정 완료" 안내 메일 — sendEmail을 감싼 얇은 래퍼입니다.
export async function sendTeamAssignmentEmail({ to, userName, teamName, requestedTier, requestedGrade }) {
  const adminEmail = await getContactEmail();
  // [COURSE-LABEL-IN-EMAIL] 어떤 코스에 배정된 것인지 수신자가 바로 알 수 있도록
  // 신청 유형(코칭 면접 코스 / AI 면접 코스)과 급수를 함께 표기합니다.
  const courseLabel = requestedTier === 'coaching' ? '코칭 면접 코스' : 'AI 면접 코스';
  const gradeLabel = (requestedGrade === '1' || requestedGrade === '2') ? ` (${requestedGrade}급)` : '';
  await sendEmail({
    to,
    subject: `[전문상담사 AI 모의면접] ${courseLabel}${gradeLabel} 팀 배정이 완료되었습니다`,
    html: `<div style="font-family:sans-serif;font-size:11pt;padding:30px;border:1px solid #e2e8f0;border-radius:12px;">
      <h2 style="color:#364d79;margin-bottom:10px;">${courseLabel}${gradeLabel} 팀 배정 완료</h2>
      <p style="color:#4a5568;line-height:1.7;">안녕하세요, <strong>${userName || to}</strong>님.<br>신청하신 <strong>${courseLabel}${gradeLabel}</strong>의 입금이 확인되어 "<strong>${teamName}</strong>" 팀에 배정되었습니다. 지금부터 전문상담사 AI 모의면접 연습을 이용하실 수 있습니다.</p>
      <div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:8px;padding:14px 18px;margin:16px 0;">
        <p style="margin:0;font-size:0.9rem;color:#92400e;">💡 현재 로그인 중이시라면 페이지를 <strong>새로고침</strong>하거나 <strong>재로그인</strong>하시면 즉시 반영됩니다.</p>
      </div>
      <p style="font-size:0.9rem;color:#718096;line-height:1.7;">소속 팀의 이용 기간이 종료되면 별도 안내 없이 이용이 제한될 수 있습니다.<br>문의: <a href="mailto:${adminEmail}" style="color:#364d79;">${adminEmail}</a></p>
      <p style="font-size:0.9rem;color:#a0aec0;margin-top:20px;">MindPass 드림</p>
    </div>`
  });
}

// [TEAM-MGMT] AI 면접 코스 마감 임박 리마인드 메일 — admin-schedule-remind 액션에서 사용합니다.
export async function sendScheduleReminderEmail({ to, userName, teamName, catLabel, endDate }) {
  await sendEmail({
    to,
    subject: `[전문상담사 AI 모의면접] "${teamName}" ${catLabel} 제출 마감이 얼마 남지 않았습니다`,
    html: `<div style="font-family:sans-serif;font-size:11pt;padding:30px;border:1px solid #e2e8f0;border-radius:12px;">
      <h2 style="color:#364d79;margin-bottom:10px;">제출 마감 임박 안내</h2>
      <p style="color:#4a5568;line-height:1.7;">안녕하세요, <strong>${userName || to}</strong>님.<br>"<strong>${teamName}</strong>" 팀의 <strong>${catLabel}</strong> 문제 제출 마감일이 <strong>${endDate}</strong>입니다. 아직 제출하지 않으셨다면 서둘러 주세요.</p>
      <p style="font-size:0.9rem;color:#718096;line-height:1.7;">전문상담사 AI 모의면접 페이지의 "AI 면접 코스" 탭에서 바로 제출할 수 있습니다.</p>
      <p style="font-size:0.9rem;color:#a0aec0;margin-top:20px;">MindPass 드림</p>
    </div>`
  });
}

// ─────────────────────────────────────────────────────────────────
// [SHEET-IMPORT] RFC4180 스타일 CSV 파서 (따옴표로 감싼 필드 안의 콤마/줄바꿈 지원)
// 구글 시트 "파일 > 공유 > 웹에 게시 > CSV" 링크를 그대로 fetch한 응답을 위해 사용합니다.
// ─────────────────────────────────────────────────────────────────
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* CRLF의 \r은 무시, 다음 \n에서 행 종료 처리 */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }

  return rows.filter(r => r.some(c => c && String(c).trim() !== ''));
}

// ─────────────────────────────────────────────────────────────────
// [SHEET-IMPORT] 질문 행 배열 일괄 업서트 — 붙여넣기/CSV URL 가져오기 공통 로직
// 매칭 기준: (cat, question) 완전 일치 → 있으면 update, 없으면 insert.
// 입력 행 형태: { catLabelRaw, question, tips(string|array), releaseAt, isActiveRaw }
// ─────────────────────────────────────────────────────────────────
export const CAT_LABEL_MAP = { '사례개념화': 'case', '상담윤리': 'ethics', 'case': 'case', 'ethics': 'ethics' };

export async function upsertQuestionRows(rawRows) {
  const parsed = [];
  const errors = [];

  rawRows.forEach((r, idx) => {
    const rowNum = idx + 1;
    const catKey = String(r.catLabelRaw ?? r.cat ?? '').trim();
    const cat = CAT_LABEL_MAP[catKey];
    const question = String(r.question ?? '').trim();

    if (!cat) {
      errors.push(`${rowNum}행: 구분 값을 인식할 수 없습니다 ("사례개념화" 또는 "상담윤리"여야 함) — 입력값: "${catKey}"`);
      return;
    }
    if (!question) {
      errors.push(`${rowNum}행: 질문 내용이 비어 있어 건너뛰었습니다.`);
      return;
    }

    const tips = Array.isArray(r.tips)
      ? r.tips.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim())
      : String(r.tips ?? '').split('|').map(t => t.trim()).filter(Boolean);

    let releaseAt = new Date().toISOString();
    const releaseRaw = String(r.releaseAt ?? '').trim();
    if (releaseRaw) {
      const d = new Date(releaseRaw);
      if (!isNaN(d.getTime())) releaseAt = d.toISOString();
      else errors.push(`${rowNum}행: 공개일시("${releaseRaw}")를 인식할 수 없어 즉시 공개로 처리했습니다.`);
    }

    const activeRaw = String(r.isActiveRaw ?? r.isActive ?? '').trim().toLowerCase();
    const isActive = !['false', '0', 'no', 'n', '아니오', '비활성'].includes(activeRaw);

    const row = {
      cat,
      cat_label: cat === 'case' ? '사례개념화' : '상담윤리',
      question,
      tips,
      is_active: isActive,
      release_at: releaseAt
    };

    // [QBANK-TOPIC] 8번째 열(분류)이 실제로 존재할 때만 반영합니다 — 열 자체가
    // 없는 기존 시트를 붙여넣을 때 분류가 실수로 지워지지 않도록.
    if (r.topicRaw !== undefined) {
      const topicRaw = String(r.topicRaw ?? '').trim();
      row.topic = topicRaw || null;
    }

    // [AI-FEEDBACK] 상담윤리 문제는 시트의 "모범답안" 열을 함께 반영합니다.
    // (사례개념화 이론별 모범답안은 별도 탭/별도 액션에서 문제 매칭으로 처리합니다.)
    // [APPROVAL-GATE] "승인" 열이 시트에 있으면, 승인된 행만 모범답안을 반영합니다.
    // (n8n 등이 AI 초안을 미리 채워 넣고 사람이 검토 후 승인 표시를 하는 워크플로를 지원하기 위함)
    // 열 자체가 없는 시트는 기존과 동일하게 항상 반영합니다(하위 호환).
    if (cat === 'ethics' && r.modelAnswerRaw !== undefined) {
      const hasApprovalColumn = r.approvedRaw !== undefined;
      const approvedRaw = String(r.approvedRaw ?? '').trim().toLowerCase();
      const isApproved = !hasApprovalColumn || ['true', '1', 'yes', 'y', '예', 'o', 'ok', '승인'].includes(approvedRaw);
      if (isApproved) {
        const modelAnswer = String(r.modelAnswerRaw ?? '').trim();
        row.model_answer = modelAnswer || null;
        // [AI-DRAFT-QUEUE] 시트의 "승인" 열을 통과했다는 건 이미 사람이 검토했다는
        // 뜻이므로(하위 호환으로 승인 열이 아예 없는 시트도 이 분기를 타는데, 그 경우도
        // 관리자가 직접 시트를 올린 것이라 검토를 거친 것으로 간주) 'approved'로 저장합니다.
        row.model_answer_status = modelAnswer ? 'approved' : null;
      } else {
        errors.push(`${rowNum}행: 모범답안이 미승인 상태라 반영하지 않았습니다 (다른 필드는 반영됩니다).`);
      }
    }

    parsed.push(row);
  });

  if (parsed.length === 0) {
    return { inserted: 0, updated: 0, errors };
  }

  const cats = [...new Set(parsed.map(p => p.cat))];
  const { data: existing, error: existErr } = await supabase
    .from('interview_questions')
    .select('id, cat, question')
    .in('cat', cats);
  if (existErr) throw existErr;

  const existingMap = new Map((existing || []).map(e => [`${e.cat}::${e.question}`, e.id]));

  const toInsert = [];
  const toUpdate = [];
  parsed.forEach(row => {
    const existingId = existingMap.get(`${row.cat}::${row.question}`);
    if (existingId) toUpdate.push({ id: existingId, ...row });
    else toInsert.push(row);
  });

  // [SEQ-NO] 새로 추가되는 질문들에 카테고리별로 순번을 이어서 부여합니다.
  if (toInsert.length > 0) {
    const nextSeqByCat = {};
    for (const cat of [...new Set(toInsert.map(r => r.cat))]) {
      nextSeqByCat[cat] = await getNextSeqNo(cat);
    }
    toInsert.forEach(row => {
      row.seq_no = nextSeqByCat[row.cat]++;
    });
  }

  if (toInsert.length > 0) {
    const { error: insErr } = await supabase.from('interview_questions').insert(toInsert);
    if (insErr) throw insErr;
  }

  if (toUpdate.length > 0) {
    const results = await Promise.all(toUpdate.map(row => {
      const { id, ...fields } = row;
      return supabase.from('interview_questions').update(fields).eq('id', id);
    }));
    const updateErr = results.find(r => r.error);
    if (updateErr) throw updateErr.error;
  }

  return { inserted: toInsert.length, updated: toUpdate.length, errors };
}

// ─────────────────────────────────────────────────────────────────
// [AI-FEEDBACK][SHEET-IMPORT] 사례개념화 상담이론별 모범답안 시트 일괄 업로드.
// 별도 탭(질문/상담이론/모범답안)을 받아, 질문 "텍스트가 완전히 일치"하는
// 기존 사례개념화 문제에 매칭해서 interview_case_model_answers를 upsert합니다.
// (질문 자체는 이 함수에서 새로 만들지 않습니다 — 반드시 질문은행에 먼저
// 등록되어 있어야 합니다. 매칭 실패 행은 errors로 보고합니다.)
// 입력 행 형태: { question, theory, modelAnswer }
// ─────────────────────────────────────────────────────────────────
export async function upsertCaseModelAnswerRows(rawRows) {
  const parsed = [];
  const errors = [];

  rawRows.forEach((r, idx) => {
    const rowNum = idx + 1;
    // [SEQ-NO] 일련번호가 있으면 그것을 우선 사용하고, 없으면 질문 문구로 매칭합니다.
    const seqNoRaw = String(r.seqNo ?? '').trim();
    const seqNo = seqNoRaw && !isNaN(parseInt(seqNoRaw, 10)) ? parseInt(seqNoRaw, 10) : null;
    const question = String(r.question ?? '').trim();
    const theory = String(r.theory ?? '').trim();
    const modelAnswer = String(r.modelAnswer ?? '').trim();

    if (!seqNo && !question) {
      errors.push(`${rowNum}행: 사례 번호 또는 질문(매칭용) 중 하나는 반드시 입력해야 합니다.`);
      return;
    }
    if (!theory) { errors.push(`${rowNum}행: 상담이론 이름이 비어 있어 건너뛰었습니다.`); return; }
    if (!modelAnswer) { errors.push(`${rowNum}행: 모범답안 내용이 비어 있어 건너뛰었습니다.`); return; }

    // [APPROVAL-GATE] "승인" 열이 시트에 있으면, 승인된 행만 반영합니다.
    // 열 자체가 없는 시트는 기존과 동일하게 항상 반영합니다(하위 호환).
    if (r.approvedRaw !== undefined) {
      const approvedRaw = String(r.approvedRaw ?? '').trim().toLowerCase();
      const isApproved = ['true', '1', 'yes', 'y', '예', 'o', 'ok', '승인'].includes(approvedRaw);
      if (!isApproved) {
        errors.push(`${rowNum}행: 미승인 상태라 건너뛰었습니다.`);
        return;
      }
    }

    parsed.push({ seqNo, question, theory, modelAnswer });
  });

  if (parsed.length === 0) {
    return { upserted: 0, unmatched: 0, errors };
  }

  const { data: caseQuestions, error: qErr } = await supabase
    .from('interview_questions')
    .select('id, question, seq_no')
    .eq('cat', 'case');
  if (qErr) throw qErr;

  const bySeqNo = new Map((caseQuestions || []).map(q => [q.seq_no, q.id]));
  const byQuestion = new Map((caseQuestions || []).map(q => [q.question, q.id]));

  const toUpsert = [];
  const unmatchedRows = [];
  parsed.forEach(row => {
    // 일련번호가 있으면 그것을 우선으로, 못 찾으면 질문 문구로 다시 시도합니다.
    const questionId = (row.seqNo !== null ? bySeqNo.get(row.seqNo) : null) ?? byQuestion.get(row.question);
    if (!questionId) {
      const label = row.seqNo !== null ? `사례개념화 #${row.seqNo}` : `"${row.question.slice(0, 40)}${row.question.length > 40 ? '...' : ''}"`;
      unmatchedRows.push(label);
      return;
    }
    // [AI-DRAFT-QUEUE] 시트를 통해 사람이 올린(승인 열을 통과한) 값이므로 'approved'로 저장.
    toUpsert.push({ question_id: questionId, theory: row.theory, model_answer: row.modelAnswer, status: 'approved' });
  });

  if (toUpsert.length > 0) {
    const { error: upsertErr } = await supabase
      .from('interview_case_model_answers')
      .upsert(toUpsert, { onConflict: 'question_id,theory' });
    if (upsertErr) throw upsertErr;
  }

  if (unmatchedRows.length > 0) {
    errors.push(
      `다음 항목과 일치하는 사례개념화 문제를 질문은행에서 찾지 못했습니다 (번호나 문구가 정확해야 합니다. 먼저 질문은행에 등록한 뒤 다시 시도해주세요): ` +
      unmatchedRows.join(', ')
    );
  }

  return { upserted: toUpsert.length, unmatched: unmatchedRows.length, errors };
}

