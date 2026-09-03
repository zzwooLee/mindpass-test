// send-mail.js
// ─────────────────────────────────────────────────────────────────
// 수정 이력
// [MULTI-CERT-1] 자격증별(exam_type) 프리미엄 신청 지원
//                변경 전: verified.userStatus(전역) !== 'free'이면 무조건
//                중복 신청으로 차단
//                변경 후: body의 examType을 받아 해당 자격증의 구독 상태만
//                확인합니다. 한 자격증은 이미 premium이어도 다른 자격증은
//                신청할 수 있어야 하기 때문입니다. Slack 메시지/승인 payload에도
//                examType을 포함해 slack-action.js가 올바른 자격증에 대해서만
//                premium을 부여하도록 했습니다.
// [FIX-High-1] actionValue JSON.stringify 전 userName null/undefined 정제
//              profile 조회 실패 시 undefined가 직렬화되어 Slack 메시지에
//              "undefined" 문자열이 표시되거나 slack-action.js에서 파싱 오류 발생
//              → userName: userName || '' 로 명시적 빈 문자열 폴백 적용
// [기존 유지]  JWT 인증 — 비인증 사용자의 임의 Slack 알림 발송 차단
// [기존 유지]  본인 이메일 강제 사용 — body 값 신뢰 안 함
// [MULTI-CERT-4] 요금제(개월 수) 선택 지원
//                변경 전: 승인 시 slack-action.js가 항상 +1개월로 고정 승인
//                (premium.html에 월/6개월 요금제가 생겼는데도 반영 안 됨)
//                변경 후: body의 planMonths(1~60, 기본 1)를 받아 검증 후
//                actionValue와 Slack 메시지에 함께 실어 보냅니다.
//                slack-action.js가 승인 시 이 값으로 만료일을 계산합니다.
// ─────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const VALID_EXAM_TYPES = ['clinical_psych', 'youth_counselor', 'counselor_interview'];
const EXAM_LABELS = { clinical_psych: '임상심리사', youth_counselor: '청소년상담사', counselor_interview: '전문상담사 AI 모의면접' };
// [PRICE-BY-GRADE][PRACTICE-ONLY] AI 면접 코스 / AI 자율연습 단독 급수별 가격 —
// premium-info.js의 PREMIUM_INFO.counselor_interview.price/practicePrice와
// 반드시 동일하게 유지해주세요 (서버 파일이라 별도로 복제해서 씁니다 —
// EXAM_LABELS와 같은 방식).
const COUNSELOR_INTERVIEW_PRICE = {
  course  : { '1': '240,000원', '2': '190,000원' },
  practice: { '1': '155,000원', '2': '115,000원' },
  // [STEP5-COACHING][COACHING-FIXED-SESSIONS] 급수당 회차(세션 수)가 1개로
  // 고정됩니다(2급 5회, 1급 6회) — 요금 문자열에 회차를 함께 표기합니다.
  // premium-info.js의 PREMIUM_INFO.counselor_interview.coachingPrice와 반드시
  // 동일하게 유지해주세요.
  coaching: { '1': '320,000원 (6회)', '2': '270,000원 (5회)' }
};
const COUNSELOR_INTERVIEW_TIER_LABELS = { course: 'AI 면접 코스', practice: 'AI 자율연습 단독', coaching: '코칭 면접 코스' };

// ─────────────────────────────────────────────────────────────────
// JWT 검증 헬퍼 — 유저 프로필(이메일/이름/admin 여부)만 확인합니다.
// 자격증별 구독 상태는 핸들러에서 별도로 조회합니다.
// ─────────────────────────────────────────────────────────────────
async function verifyUser(req) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.split(' ')[1];

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      console.warn('[send-mail.js] JWT 검증 실패:', error?.message);
      return null;
    }

    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('id, email, name, user_status')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      console.warn('[send-mail.js] users 조회 실패:', profileError?.message);
      return null;
    }

    return {
      id       : profile.id,
      email    : profile.email || user.email,
      name     : profile.name  || '',
      isAdmin  : profile.user_status === 'admin'
    };
  } catch (e) {
    console.warn('[send-mail.js] verifyUser 예외:', e.message);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { examType, requestedGrade, planMonths, requestedTier } = req.body || {};

  // [MULTI-CERT-1] examType 필수 검증
  if (!examType || !VALID_EXAM_TYPES.includes(examType)) {
    return res.status(400).json({ message: `examType은 ${VALID_EXAM_TYPES.join(', ')} 중 하나여야 합니다.` });
  }

  // [REQUESTED-GRADE] counselor_interview 신청 시에만 응시 급수(1급/2급)를 받습니다.
  let gradeValue = null;
  // [PRACTICE-ONLY] counselor_interview 신청 시에만 신청 유형(course/practice)을
  // 받습니다. 인식할 수 없는 값이거나 없으면 기존 동작과 동일하게 'course'(AI
  // 면접 코스)로 처리합니다(하위호환 — 옛 클라이언트는 이 필드를 보내지 않음).
  let tierValue = null;
  if (examType === 'counselor_interview') {
    if (requestedGrade !== '1' && requestedGrade !== '2') {
      return res.status(400).json({ message: '응시 급수(1급/2급)를 선택해주세요.' });
    }
    gradeValue = requestedGrade;
    tierValue = (requestedTier === 'practice' || requestedTier === 'coaching') ? requestedTier : 'course';
  }

  // [MULTI-CERT-4] 요금제(개월 수) — clinical_psych/youth_counselor 신청 모달의
  // 요금제 라디오 선택값입니다. premium-info.js의 실제 플랜(1개월/6개월)과
  // 어긋나지 않도록 정수 1~60 범위만 허용하고, 없거나 잘못된 값이면 기존과
  // 동일하게 1개월로 처리합니다. 이 값은 slack-action.js가 승인 시 만료일
  // 계산(expiry.setMonth(+planMonths))에 그대로 사용합니다.
  const parsedPlanMonths = parseInt(planMonths, 10);
  const planMonthsValue = (!isNaN(parsedPlanMonths) && parsedPlanMonths >= 1 && parsedPlanMonths <= 60)
    ? parsedPlanMonths
    : 1;

  // JWT 인증 검증 — 비인증 접근 차단
  const verified = await verifyUser(req);
  if (!verified) {
    return res.status(401).json({ message: 'Unauthorized: 로그인 후 이용해주세요.' });
  }

  // admin은 이미 전 자격증 접근 가능하므로 신청 자체가 의미 없음
  if (verified.isAdmin) {
    return res.status(400).json({ message: '관리자 계정은 이미 모든 자격증에 접근할 수 있습니다.' });
  }

  // [TEAM-MGMT] counselor_interview는 user_subscriptions가 아니라 팀 소속 /
  // 배정 대기열 기준으로 중복 신청을 판단합니다.
  if (examType === 'counselor_interview') {
    const { data: membership, error: memErr } = await supabase
      .from('interview_team_members')
      .select('team_id, interview_teams(status)')
      .eq('user_id', verified.id)
      .is('removed_at', null)
      .maybeSingle();
    if (memErr) {
      console.error('[send-mail.js] interview_team_members 조회 실패:', memErr.message);
      return res.status(500).json({ message: '팀 소속 확인 중 오류가 발생했습니다.' });
    }
    if (membership && membership.interview_teams?.status === 'active') {
      console.log('[send-mail.js] 중복 신청 차단(이미 팀 소속) —', verified.email);
      return res.status(400).json({ message: '이미 팀에 배정되어 전문상담사 면접을 이용 중입니다.' });
    }

    const { data: pending, error: pendErr } = await supabase
      .from('interview_pending_members')
      .select('id')
      .eq('user_id', verified.id)
      .is('assigned_at', null)
      .maybeSingle();
    if (pendErr) {
      console.error('[send-mail.js] interview_pending_members 조회 실패:', pendErr.message);
      return res.status(500).json({ message: '신청 상태 확인 중 오류가 발생했습니다.' });
    }
    if (pending) {
      console.log('[send-mail.js] 중복 신청 차단(배정 대기중) —', verified.email);
      return res.status(400).json({ message: '이미 결제 확인 후 팀 배정 대기 중입니다.' });
    }

    // [PRACTICE-ONLY] AI 자율연습 단독을 신청하는 경우, 이미 유효한 단독 이용
    // 권한이 있으면 중복 신청을 차단합니다(AI 면접 코스 신청은 위 팀 소속/대기열
    // 체크로 이미 걸러지며, 단독 이용 중에도 코스로 업그레이드 신청은 허용합니다).
    if (tierValue === 'practice') {
      const { data: practiceAccess, error: praErr } = await supabase
        .from('interview_practice_only_access')
        .select('access_expires_at')
        .eq('user_id', verified.id)
        .maybeSingle();
      if (praErr) {
        console.error('[send-mail.js] interview_practice_only_access 조회 실패:', praErr.message);
        return res.status(500).json({ message: '이용 권한 확인 중 오류가 발생했습니다.' });
      }
      if (practiceAccess && new Date(practiceAccess.access_expires_at) >= new Date()) {
        console.log('[send-mail.js] 중복 신청 차단(AI 자율연습 이용 중) —', verified.email);
        return res.status(400).json({ message: '이미 AI 자율연습을 이용 중입니다.' });
      }
    }
  } else {
    // [MULTI-CERT-1] 해당 자격증의 구독 상태만 확인 — 다른 자격증이 premium이어도 신청 가능
    const { data: sub, error: subError } = await supabase
      .from('user_subscriptions')
      .select('status')
      .eq('user_id', verified.id)
      .eq('exam_type', examType)
      .maybeSingle();

    if (subError) {
      console.error('[send-mail.js] user_subscriptions 조회 실패:', subError.message);
      return res.status(500).json({ message: '구독 상태 확인 중 오류가 발생했습니다.' });
    }

    if (sub?.status === 'premium') {
      console.log('[send-mail.js] 중복 신청 차단 —', EXAM_LABELS[examType], '/', verified.email);
      return res.status(400).json({ message: `이미 ${EXAM_LABELS[examType]} 프리미엄 회원입니다.` });
    }
  }

  const userEmail = verified.email;
  const userId    = verified.id;
  const userName  = verified.name;

  if (!userEmail) {
    return res.status(400).json({ message: '사용자 이메일 정보를 가져올 수 없습니다.' });
  }

  const slackToken   = process.env.SLACK_BOT_TOKEN;
  const slackChannel = process.env.SLACK_CHANNEL_ID;

  const missing = [];
  if (!slackToken)   missing.push('SLACK_BOT_TOKEN');
  if (!slackChannel) missing.push('SLACK_CHANNEL_ID');
  if (missing.length > 0) {
    return res.status(500).json({
      message: `환경변수 누락: ${missing.join(', ')}`
    });
  }

  try {
    const today = new Date().toLocaleDateString('ko-KR');
    const examLabel = EXAM_LABELS[examType];

    // [MULTI-CERT-1] actionValue에 examType 포함 — slack-action.js가 올바른
    // 자격증에 대해서만 premium을 부여할 수 있도록 합니다.
    // [MULTI-CERT-4] planMonths도 함께 실어 보내, 승인 시 slack-action.js가
    // 신청한 요금제(1개월/6개월)에 맞는 만료일을 계산하도록 합니다.
    const actionValue = JSON.stringify({
      userId,
      userEmail,
      userName: userName || '',
      examType,
      requestedGrade: gradeValue,
      requestedTier: tierValue,
      planMonths: planMonthsValue
    });

    const gradeLine = gradeValue ? `\n🎓 응시 급수: ${gradeValue}급` : '';
    // [MULTI-CERT-4] counselor_interview는 요금제 개념이 없으므로(팀 배정 방식) 생략합니다.
    const planLine  = (examType !== 'counselor_interview') ? `\n🗓️ 요금제: ${planMonthsValue}개월` : '';
    // [PRACTICE-ONLY] counselor_interview는 신청 유형(AI 면접 코스 / AI 자율연습
    // 단독)이 있으므로 관리자가 승인 전에 바로 구분할 수 있도록 표시합니다.
    const tierLine = tierValue ? `\n📦 신청 유형: ${COUNSELOR_INTERVIEW_TIER_LABELS[tierValue]}` : '';
    // [PRICE-BY-GRADE][PRACTICE-ONLY] counselor_interview는 급수·신청 유형에 따라
    // 이용 요금이 다르므로 관리자가 승인 전에 바로 확인할 수 있도록 Slack 메시지에
    // 함께 표시합니다.
    const priceLine = (examType === 'counselor_interview' && gradeValue && tierValue)
      ? `\n💰 이용 요금: ${(COUNSELOR_INTERVIEW_PRICE[tierValue] || {})[gradeValue] || '확인 필요'}`
      : '';

    const slackBody = {
      channel: slackChannel,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⭐ *프리미엄 멤버십 (${examLabel})*\n${userName || '이름없음'}(${userEmail}) - ${today} 신청${gradeLine}${tierLine}${planLine}${priceLine}`
          }
        },
        {
          type: 'actions',
          elements: [
            {
              type      : 'button',
              text      : { type: 'plain_text', text: '✅ 승인', emoji: true },
              style     : 'primary',
              action_id : 'approve_premium',
              value     : actionValue
            },
            {
              type      : 'button',
              text      : { type: 'plain_text', text: '❌ 거절', emoji: true },
              style     : 'danger',
              action_id : 'reject_premium',
              value     : actionValue
            }
          ]
        }
      ]
    };

    const slackRes  = await fetch('https://slack.com/api/chat.postMessage', {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${slackToken}`
      },
      body: JSON.stringify(slackBody)
    });

    const slackData = await slackRes.json();
    console.log('Slack response:', JSON.stringify(slackData));

    if (!slackData.ok) {
      return res.status(500).json({
        message: `Slack 오류: ${slackData.error}`,
        detail : slackData
      });
    }

    res.status(200).json({ message: '신청이 완료되었습니다.' });

  } catch (error) {
    console.error('send-mail error:', error.message);
    res.status(500).json({ message: error.message });
  }
}
