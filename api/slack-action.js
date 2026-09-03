// slack-action.js
// ─────────────────────────────────────────────────────────────────
// 수정 이력
// [MULTI-CERT-1] 자격증별(exam_type) 승인 처리
//                변경 전: 승인 시 users.user_status/expiry_date를 직접 갱신
//                변경 후: send-mail.js가 실어 보낸 actionData.examType을 읽어
//                user_subscriptions(user_id, exam_type)에 upsert합니다.
//                actionData.userId가 비어있으면 이메일로 유저 id를 재조회한
//                뒤 upsert합니다(기존 update-by-id → email fallback 패턴을
//                upsert 방식에 맞게 조정). examType이 없거나 알 수 없는 값이면
//                구버전 신청 형식으로 간주해 DB 반영 없이 관리자에게 수동 처리를
//                안내합니다(기존 Slack 신청 메시지가 새 코드 배포 전에 눌리는
//                경우에 대한 안전장치).
// [FIX-Critical-1] 승인 후 활성화 즉시 반영 안내 — 승인 메일에
//                  "새로고침 또는 재로그인 시 즉시 반영됩니다" 문구 추가
//                  (DB는 업데이트되지만 로그인 세션 sessionStorage는 별도 갱신 필요)
// [FIX-High-1]    responseUrl fetch 실패(4xx/5xx/네트워크 오류) 시
//                  오류 로그를 남기도록 처리 — 무음 실패 방지
//                  (관리자가 Slack 메시지 미갱신 상태를 인지하지 못하고 중복 클릭 방지)
// [기존 유지]     action.value JSON.parse 실패 시 개별 try/catch 안전 처리
// [기존 유지]     Slack 서명 검증(HMAC-SHA256) + 타임스탬프 재전송 방지
// [기존 유지]     승인 처리 dbSuccess 플래그 — DB 실패 시 메일 미발송 + Slack 실패 표시
// [MULTI-CERT-4] 승인 만료일을 요금제(개월 수) 반영으로 수정
//                변경 전: 승인 시 요금제와 무관하게 항상 expiry.setMonth(+1)
//                (premium.html에 월/6개월 요금제가 생겼는데도 6개월 결제자가
//                1개월만 활성화되는 불일치가 있었음)
//                변경 후: send-mail.js가 actionValue에 실어 보낸
//                actionData.planMonths(1~60, 기본 1)만큼 더합니다. 확인
//                메일/Slack 완료 메시지에도 "요금제: N개월"을 함께 표시합니다.
// [SETTINGS-1] 문의 이메일을 process.env.ADMIN_EMAIL 하드코딩 대신
//              app_settings 테이블(관리자 화면에서 수정 가능)에서 읽어오도록
//              변경. 값이 없으면(아직 설정 안 함) 기존처럼 환경변수로 폴백.
// [SETTINGS-2] MAIL_FROM(발신 주소)이 실제 받는 메일함이 없는 주소(예:
//              info@도메인처럼 서비스에 등록되지 않은 주소)일 수 있어, 수신자가
//              "답장"을 누르면 문의 이메일로 가도록 reply_to를 추가했습니다.
// ─────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

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

// Vercel bodyParser 비활성화 — raw body로 Slack 서명 검증
export const config = {
  api: {
    bodyParser: false
  }
};

// ─────────────────────────────────────────────────────────────────
// raw body 읽기 헬퍼
// ─────────────────────────────────────────────────────────────────
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────
// [SETTINGS-1] 문의 이메일 조회 — app_settings에 관리자가 설정해둔 값이
// 있으면 그 값을, 없으면(테이블 미생성 포함) 환경변수로 폴백합니다.
// ─────────────────────────────────────────────────────────────────
async function getContactEmail() {
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'contact_email')
      .maybeSingle();
    if (error) throw error;
    return data?.value || process.env.ADMIN_EMAIL;
  } catch (e) {
    console.warn('[slack-action] app_settings 조회 실패 — 환경변수로 폴백:', e.message);
    return process.env.ADMIN_EMAIL;
  }
}

// ─────────────────────────────────────────────────────────────────
// [BANK-ACCOUNT-INFO] 코칭 면접 코스 입금 안내용 계좌 정보 — app_settings에
// 관리자가 설정해둔 값이 있으면 반환하고, 셋 중 하나라도 없으면 호출부에서
// 계좌 안내 문구 자체를 생략합니다.
// ─────────────────────────────────────────────────────────────────
async function getBankAccountInfo() {
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
    console.warn('[slack-action] app_settings(은행계좌) 조회 실패:', e.message);
    return { bankName: '', accountNumber: '', accountHolder: '' };
  }
}

// ─────────────────────────────────────────────────────────────────
// Slack 서명 검증 (HMAC-SHA256)
// ─────────────────────────────────────────────────────────────────
function verifySlackSignature(rawBody, headers) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error('[slack-action] SLACK_SIGNING_SECRET 환경변수 누락');
    return false;
  }

  const timestamp = headers['x-slack-request-timestamp'];
  const slackSig  = headers['x-slack-signature'];

  if (!timestamp || !slackSig) {
    console.warn('[slack-action] 서명 헤더 없음');
    return false;
  }

  // 재전송 공격 방지: 요청 시각이 5분 이상 차이나면 거부
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
    console.warn('[slack-action] 타임스탬프 오류 — 재전송 공격 가능성:', timestamp);
    return false;
  }

  const sigBaseString = `v0:${timestamp}:${rawBody.toString()}`;
  const hmac          = crypto.createHmac('sha256', signingSecret);
  hmac.update(sigBaseString);
  const mySignature = `v0=${hmac.digest('hex')}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(mySignature, 'utf8'),
      Buffer.from(slackSig,    'utf8')
    );
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
// Resend 메일 발송
// ─────────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const resendKey = process.env.RESEND_API_KEY;
  // [BRANDING] 수신자에게 표시되는 발신자명을 'MindPass'로 통일합니다.
  const fromEmail = `MindPass <${process.env.MAIL_FROM || 'onboarding@resend.dev'}>`;
  // [SETTINGS-2] MAIL_FROM은 실제로 받는 메일함이 없는 주소(예: info@도메인)일 수
  // 있으므로, 수신자가 "답장"을 누르면 문의 이메일(contact_email/ADMIN_EMAIL)로
  // 가도록 reply_to를 함께 지정합니다.
  const replyTo = await getContactEmail();

  if (!resendKey) {
    console.error('[slack-action] RESEND_API_KEY 환경변수 누락');
    return;
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({ from: fromEmail, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) })
    });
    const data = await r.json();
    if (!r.ok) console.error('[slack-action] Resend 오류:', JSON.stringify(data));
    else       console.log('[slack-action] 메일 발송 성공:', data.id);
  } catch (e) {
    console.error('[slack-action] 메일 발송 예외:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// [FIX-High-1] Slack responseUrl 업데이트 헬퍼
// ─────────────────────────────────────────────────────────────────
async function updateSlackMessage(responseUrl, blocks) {
  try {
    const slackRes = await fetch(responseUrl, {
      method : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body   : JSON.stringify({ replace_original: true, blocks })
    });
    if (!slackRes.ok) {
      console.error(
        '[slack-action] Slack 메시지 갱신 실패 — HTTP', slackRes.status,
        '관리자가 메시지를 다시 확인해주세요.'
      );
    } else {
      console.log('[slack-action] Slack 메시지 갱신 성공:', slackRes.status);
    }
  } catch (e) {
    console.error('[slack-action] Slack 메시지 갱신 네트워크 오류:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// 핸들러
// ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (e) {
    console.error('[slack-action] raw body 읽기 실패:', e.message);
    return res.status(400).end();
  }

  if (!verifySlackSignature(rawBody, req.headers)) {
    console.error('[slack-action] 서명 검증 실패 — 요청 거부');
    return res.status(403).end();
  }

  const rawBodyStr = rawBody.toString('utf8');

  console.log('[slack-action] 요청 수신 (서명 검증 통과)');

  try {
    let payload;
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const params     = new URLSearchParams(rawBodyStr);
      const payloadStr = params.get('payload');
      if (!payloadStr) {
        console.error('[slack-action] payload 파라미터 없음');
        return res.status(200).end();
      }
      payload = JSON.parse(payloadStr);
    } else if (contentType.includes('application/json')) {
      payload = JSON.parse(rawBodyStr);
    } else {
      try {
        const params     = new URLSearchParams(rawBodyStr);
        const payloadStr = params.get('payload');
        payload = payloadStr ? JSON.parse(payloadStr) : JSON.parse(rawBodyStr);
      } catch {
        console.error('[slack-action] payload 파싱 실패');
        return res.status(200).end();
      }
    }

    if (payload?.type === 'url_verification') {
      return res.status(200).json({ challenge: payload.challenge });
    }

    const action      = payload?.actions?.[0];
    const actionId    = action?.action_id;
    const responseUrl = payload?.response_url;
    const adminEmail  = await getContactEmail();

    let actionData = {};
    try {
      actionData = JSON.parse(action?.value || '{}');
    } catch (parseErr) {
      console.error('[slack-action] action.value 파싱 실패:', parseErr.message, '/ raw value:', action?.value);
      return res.status(200).end();
    }

    const userId    = actionData.userId;
    const userEmail = actionData.userEmail;
    const userName  = actionData.userName;
    const examType  = actionData.examType;
    const requestedGrade = (actionData.requestedGrade === '1' || actionData.requestedGrade === '2') ? actionData.requestedGrade : null;
    // [PRACTICE-ONLY] 신청 유형(AI 면접 코스 / AI 자율연습 단독). 옛 신청 메시지에는
    // 이 필드가 없으므로 기본값은 기존 동작과 동일한 'course'입니다.
    const requestedTier = (actionData.requestedTier === 'practice' || actionData.requestedTier === 'coaching') ? actionData.requestedTier : 'course';
    // [MULTI-CERT-4] 신청 시 선택한 요금제(개월 수) — send-mail.js에서 1~60으로
    // 검증해 보내지만, 방어적으로 여기서도 다시 한번 범위를 확인하고
    // 없거나 잘못된 값이면 기존과 동일하게 1개월로 처리합니다.
    const parsedPlanMonths = parseInt(actionData.planMonths, 10);
    const planMonths = (!isNaN(parsedPlanMonths) && parsedPlanMonths >= 1 && parsedPlanMonths <= 60)
      ? parsedPlanMonths
      : 1;
    const examLabel = EXAM_LABELS[examType] || examType || '자격증 미상';
    // [MULTI-CERT-2] counselor_interview는 "퀴즈 뱅크"가 아니라 모의면접 서비스이므로
    // 이메일 문구를 서비스 종류에 맞게 분기합니다.
    // [BRANDING] 사용자에게 보내는 이메일에는 어느 자격증(임상심리사/청소년상담사)인지
    // 구분하지 않고, 두 서비스 명칭("자격증 퀴즈 뱅크" / "전문상담사 AI 모의면접")만 노출합니다.
    // 관리자용 Slack 메시지(examLabel)는 운영 구분을 위해 기존대로 유지합니다.
    const isInterviewService = examType === 'counselor_interview';
    const serviceName = isInterviewService ? '전문상담사 AI 모의면접' : '자격증 퀴즈 뱅크';
    const usageLine    = isInterviewService
      ? '이제 전문상담사 AI 모의면접 연습을 이용하실 수 있습니다.'
      : '이제 자격증 퀴즈 뱅크의 기출문제와 AI 예상 문제를 이용하실 수 있습니다.';
    // [BRANDING-2] "프리미엄 멤버십 활성화" 안내 메일에서는 어떤 자격증이 활성화됐는지
    // 사용자가 바로 알 수 있도록 서비스명 뒤에 자격증명을 괄호로 덧붙입니다.
    // (다른 이메일들은 기존 방침대로 자격증 구분 없이 서비스명만 노출합니다.)
    const serviceNameDetailed = isInterviewService ? serviceName : `${serviceName}(${examLabel})`;

    console.log('[slack-action] actionId:', actionId, '/ examType:', examType, '/ userEmail:', userEmail);

    if (!actionId || !responseUrl) {
      console.error('[slack-action] actionId 또는 responseUrl 없음 — 처리 중단');
      return res.status(200).end();
    }

    // ── 승인 처리 ──────────────────────────────────────────────
    if (actionId === 'approve_premium') {
      // [MULTI-CERT-1] examType이 없거나 알 수 없는 값이면(구버전 신청 형식)
      // 어떤 자격증에 premium을 부여할지 알 수 없으므로 DB를 건드리지 않고
      // 관리자에게 수동 처리를 안내합니다.
      if (!examType || !VALID_EXAM_TYPES.includes(examType)) {
        console.error('[slack-action] examType 누락/알수없음 — 수동 처리 필요:', examType);
        await updateSlackMessage(responseUrl, [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⚠️ *자격증 정보 누락 — 수동 처리 필요*\n${userName || userEmail} (${userEmail})\n어느 자격증 신청인지 확인 후 관리자 대시보드에서 직접 등급을 변경해주세요.`
          }
        }]);
        return res.status(200).end();
      }

      // [MULTI-CERT-1] userId가 없으면 이메일로 재조회 후 upsert
      let resolvedUserId = userId;
      if (!resolvedUserId && userEmail) {
        const { data: userRow, error: lookupErr } = await supabase
          .from('users')
          .select('id')
          .eq('email', userEmail)
          .maybeSingle();
        if (lookupErr) console.error('[slack-action] 이메일로 유저 조회 실패:', lookupErr.message);
        resolvedUserId = userRow?.id || null;
      }

      if (!resolvedUserId) {
        console.error('[slack-action] userId를 확인할 수 없어 처리 불가 —', userEmail);
        await updateSlackMessage(responseUrl, [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⚠️ *유저를 찾을 수 없음 — 수동 처리 필요*\n${userName || userEmail} (${userEmail}) / ${examLabel}`
          }
        }]);
        return res.status(200).end();
      }

      // [TEAM-MGMT] counselor_interview는 더 이상 개인별 premium을 바로 부여하지
      // 않습니다. AI 면접 코스는 결제 확인만 이 시점에 기록하고(interview_pending_members),
      // 실제 팀 배정은 관리자가 admin.html "팀 관리" 화면에서 별도로 처리합니다.
      // [PRACTICE-ONLY] AI 자율연습 단독 신청은 팀 배정이 필요 없으므로, 승인과
      // 동시에 interview_practice_only_access에 upsert해 즉시 활성화합니다.
      if (examType === 'counselor_interview' && requestedTier === 'practice') {
        console.log('[slack-action] AI 자율연습 단독 즉시 활성화 처리 시작 —', userEmail);

        const accessExpiresAt = new Date();
        accessExpiresAt.setMonth(accessExpiresAt.getMonth() + 3);

        const { error: practiceUpsertErr } = await supabase
          .from('interview_practice_only_access')
          .upsert({
            user_id: resolvedUserId,
            grade: requestedGrade,
            access_expires_at: accessExpiresAt.toISOString(),
            granted_at: new Date().toISOString()
          }, { onConflict: 'user_id' });

        if (practiceUpsertErr) {
          console.error('[slack-action] interview_practice_only_access upsert 실패:', practiceUpsertErr.message);
          await updateSlackMessage(responseUrl, [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⚠️ *DB 업데이트 실패 — 수동 처리 필요*\n${userName || userEmail} (${userEmail}) / ${examLabel} (AI 자율연습 단독)\n관리자 대시보드에서 직접 확인해주세요.`
            }
          }]);
          return res.status(200).end();
        }

        const expiryStr = accessExpiresAt.toLocaleDateString('ko-KR');
        const gradePriceLine = requestedGrade
          ? `<p style="color:#4a5568;line-height:1.7;">신청하신 급수: <strong>${requestedGrade}급</strong> · 이용 요금: <strong>${(COUNSELOR_INTERVIEW_PRICE.practice || {})[requestedGrade] || '확인 필요'}</strong></p>`
          : '';
        await sendEmail({
          to     : userEmail,
          subject: `[${serviceName}] 이용 승인이 완료되었습니다`,
          html   : `<div style="font-family:sans-serif;font-size:11pt;padding:30px;border:1px solid #e2e8f0;border-radius:12px;">
            <h2 style="color:#364d79;margin-bottom:10px;">AI 자율연습 이용 승인 완료</h2>
            <p style="color:#4a5568;line-height:1.7;">안녕하세요, <strong>${userName || userEmail}</strong>님.<br>AI 자율연습 이용이 승인되어 즉시 활성화되었습니다. 새로고침 또는 재로그인 시 반영됩니다.</p>
            ${gradePriceLine}
            <p style="color:#4a5568;line-height:1.7;">이용 기간은 <strong>${expiryStr}</strong>까지입니다.</p>
            <p style="font-size:0.9rem;color:#718096;line-height:1.7;">문의: <a href="mailto:${adminEmail}" style="color:#364d79;">${adminEmail}</a></p>
            <p style="font-size:0.9rem;color:#a0aec0;margin-top:20px;">MindPass 드림</p>
          </div>`
        });

        const gradePriceSlackLine = requestedGrade
          ? `\n🎓 급수: ${requestedGrade}급 · 💰 요금: ${(COUNSELOR_INTERVIEW_PRICE.practice || {})[requestedGrade] || '확인 필요'}`
          : '';
        await updateSlackMessage(responseUrl, [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *AI 자율연습 단독 즉시 활성화 완료 (${examLabel})*\n${userName || userEmail} (${userEmail})${gradePriceSlackLine}\n(팀 배정 불필요 — 자동 활성화됨, 이용기한 ${expiryStr})`
          }
        }]);
        return res.status(200).end();
      }

      // [STEP5-COACHING] 코칭 면접 코스는 AI 면접 코스처럼 급수별 공통 팀에 자동
      // 배정할 수 없습니다 — 소그룹(9명 기준) 코호트 팀을 관리자가 새로 만들어 수동
      // 배정해야 하므로, 결제확인 대기열(interview_pending_members)에 requested_tier
      // = 'coaching'으로 등록만 하고, 실제 팀 배정은 admin.html "팀 관리"에서
      // 관리자가 처리하도록 안내합니다.
      if (examType === 'counselor_interview' && requestedTier === 'coaching') {
        console.log('[slack-action] 코칭 면접 코스 결제확인 대기열 등록 시작 —', userEmail, '/ 급수:', requestedGrade);

        const { data: existingCoachingPending, error: existCoachingErr } = await supabase
          .from('interview_pending_members')
          .select('id')
          .eq('user_id', resolvedUserId)
          .is('assigned_at', null)
          .maybeSingle();
        if (existCoachingErr) console.error('[slack-action] 대기열 중복 확인 실패(코칭):', existCoachingErr.message);

        let coachingDbSuccess = !!existingCoachingPending;
        if (!existingCoachingPending) {
          const { error: coachingPendingErr } = await supabase
            .from('interview_pending_members')
            .insert({ user_id: resolvedUserId, requested_grade: requestedGrade, requested_tier: 'coaching' });
          if (!coachingPendingErr) {
            coachingDbSuccess = true;
          } else {
            console.error('[slack-action] interview_pending_members(coaching) insert 실패:', coachingPendingErr.message);
          }
        }

        if (!coachingDbSuccess) {
          await updateSlackMessage(responseUrl, [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⚠️ *DB 업데이트 실패 — 수동 처리 필요*\n${userName || userEmail} (${userEmail}) / ${examLabel}(코칭 면접 코스)\n관리자 대시보드 "팀 관리"에서 직접 확인해주세요.`
            }
          }]);
          return res.status(200).end();
        }

        const coachingGradePriceLine = requestedGrade
          ? `<p style="color:#4a5568;line-height:1.7;">신청하신 급수: <strong>${requestedGrade}급</strong> · 이용 요금: <strong>${(COUNSELOR_INTERVIEW_PRICE.coaching || {})[requestedGrade] || '확인 필요'}</strong></p>`
          : '';
        // [BANK-ACCOUNT-INFO] 이 시점은 아직 "입금 확인"이 아니라 "신청 접수"입니다.
        // 실제 입금 확인과 팀 배정은 관리자가 admin.html "팀 관리"에서 별도로
        // 처리하므로, 아직 입금 전인 신청자를 위해 계좌 정보를 안내합니다
        // (관리자가 [설정]에 계좌 정보를 등록해둔 경우에만 표시됩니다).
        const bankInfo = await getBankAccountInfo();
        const bankInfoHtml = (bankInfo.bankName && bankInfo.accountNumber && bankInfo.accountHolder)
          ? `<div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:8px;padding:14px 18px;margin:16px 0;">
              <p style="margin:0 0 6px;font-size:0.9rem;color:#92400e;font-weight:700;">💳 아직 이용 요금을 입금하지 않으셨다면, 아래 계좌로 입금해주세요.</p>
              <p style="margin:0;font-size:0.95rem;color:#4a5568;">${bankInfo.bankName} ${bankInfo.accountNumber} (예금주: ${bankInfo.accountHolder})</p>
            </div>`
          : '';
        await sendEmail({
          to     : userEmail,
          subject: `[${serviceName}] 코칭 면접 코스 신청이 접수되었습니다`,
          html   : `<div style="font-family:sans-serif;font-size:11pt;padding:30px;border:1px solid #e2e8f0;border-radius:12px;">
            <h2 style="color:#364d79;margin-bottom:10px;">코칭 면접 코스 신청 접수</h2>
            <p style="color:#4a5568;line-height:1.7;">안녕하세요, <strong>${userName || userEmail}</strong>님.<br>코칭 면접 코스 신청이 접수되었습니다. 입금이 확인되면 소그룹(9명 기준) 팀 배정 후 이용하실 수 있으며, 팀 배정이 완료되면 별도로 안내드리겠습니다.</p>
            ${coachingGradePriceLine}
            ${bankInfoHtml}
            <p style="font-size:0.9rem;color:#718096;line-height:1.7;">문의: <a href="mailto:${adminEmail}" style="color:#364d79;">${adminEmail}</a></p>
            <p style="font-size:0.9rem;color:#a0aec0;margin-top:20px;">MindPass 드림</p>
          </div>`
        });

        const coachingGradePriceSlackLine = requestedGrade
          ? `\n🎓 급수: ${requestedGrade}급 · 💰 요금: ${(COUNSELOR_INTERVIEW_PRICE.coaching || {})[requestedGrade] || '확인 필요'}`
          : '';
        await updateSlackMessage(responseUrl, [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *코칭 면접 코스 신청 접수 완료 (${examLabel})*\n${userName || userEmail} (${userEmail})${coachingGradePriceSlackLine}\n입금 확인 후 "팀 관리"에서 소그룹(9명 기준) 코칭 팀을 만들어 배정해주세요.`
          }
        }]);
        return res.status(200).end();
      }

      // [COURSE-SHARED-TEAM] AI 면접 코스는 더 이상 관리자가 팀을 수동 배정하지
      // 않습니다. 급수별로 미리 만들어둔 "공통 일정" 팀(interview_teams.team_type
      // = 'course_shared')에 승인과 동시에 바로 배정해 즉시 이용을 시작합니다.
      // (수련일정은 이 공통 팀 기준으로 관리자가 한 번만 curating하면 모든
      // AI 면접 코스 이용자가 동일하게 봅니다 — 코칭 면접 코스처럼 소그룹 팀을
      // 새로 만드는 경우에는 여전히 admin.html "팀 관리"에서 수동 배정합니다.)
      if (examType === 'counselor_interview' && requestedTier !== 'coaching') {
        console.log('[slack-action] AI 면접 코스 즉시 배정 처리 시작 —', userEmail, '/ 급수:', requestedGrade);

        let courseTeam = null;
        let courseTeamLookupErr = null;
        if (requestedGrade === '1' || requestedGrade === '2') {
          const { data: teamRow, error: teamLookupErr } = await supabase
            .from('interview_teams')
            .select('id, name')
            .eq('team_type', 'course_shared')
            .eq('grade', requestedGrade)
            .eq('status', 'active')
            .maybeSingle();
          courseTeam = teamRow || null;
          courseTeamLookupErr = teamLookupErr || null;
        }
        if (courseTeamLookupErr) {
          console.error('[slack-action] course_shared 팀 조회 실패:', courseTeamLookupErr.message);
        }

        // [COURSE-SHARED-TEAM-FALLBACK] 공통 일정 팀이 아직 만들어지지 않았거나
        // 조회에 실패한 경우, 예전처럼 결제확인 대기열에 등록해 관리자가 수동으로
        // 팀을 배정할 수 있게 안전장치를 둡니다(서비스 중단 방지).
        if (!courseTeam) {
          console.warn('[slack-action] course_shared 팀 없음 — 결제확인 대기열로 폴백:', requestedGrade);

          const { data: existingPending, error: existErr } = await supabase
            .from('interview_pending_members')
            .select('id')
            .eq('user_id', resolvedUserId)
            .is('assigned_at', null)
            .maybeSingle();
          if (existErr) console.error('[slack-action] 대기열 중복 확인 실패:', existErr.message);

          let dbSuccess = !!existingPending;
          if (!existingPending) {
            const { error: pendingErr } = await supabase
              .from('interview_pending_members')
              .insert({ user_id: resolvedUserId, requested_grade: requestedGrade });
            if (!pendingErr) {
              dbSuccess = true;
            } else {
              console.error('[slack-action] interview_pending_members insert 실패:', pendingErr.message);
            }
          }

          if (!dbSuccess) {
            await updateSlackMessage(responseUrl, [{
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `⚠️ *DB 업데이트 실패 — 수동 처리 필요*\n${userName || userEmail} (${userEmail}) / ${examLabel}\n관리자 대시보드 "팀 관리"에서 직접 확인해주세요.`
              }
            }]);
            return res.status(200).end();
          }

          await updateSlackMessage(responseUrl, [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⚠️ *공통 일정 팀 미설정 — 수동 배정 필요 (${examLabel})*\n${userName || userEmail} (${userEmail}) · ${requestedGrade || '?'}급\n"AI 면접 코스 공통 일정(${requestedGrade || '?'}급)" 팀을 admin.html "팀 관리"에서 먼저 만든 뒤, 결제확인 대기열에서 배정해주세요.`
            }
          }]);
          return res.status(200).end();
        }

        const { error: removeErr } = await supabase
          .from('interview_team_members')
          .update({ removed_at: new Date().toISOString() })
          .eq('user_id', resolvedUserId)
          .is('removed_at', null);
        if (removeErr) console.error('[slack-action] 기존 팀 소속 제거 실패:', removeErr.message);

        const accessExpiresAt = new Date();
        accessExpiresAt.setMonth(accessExpiresAt.getMonth() + 3);

        const { error: joinErr } = await supabase
          .from('interview_team_members')
          .insert({ team_id: courseTeam.id, user_id: resolvedUserId, access_expires_at: accessExpiresAt.toISOString() });

        if (joinErr) {
          console.error('[slack-action] course_shared 팀 배정 실패:', joinErr.message);
          await updateSlackMessage(responseUrl, [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `⚠️ *DB 업데이트 실패 — 수동 처리 필요*\n${userName || userEmail} (${userEmail}) / ${examLabel}\n관리자 대시보드 "팀 관리"에서 직접 확인해주세요.`
            }
          }]);
          return res.status(200).end();
        }

        const expiryStr = accessExpiresAt.toLocaleDateString('ko-KR');

        // [PRICE-BY-GRADE] 신청한 급수와 그 급수의 이용 요금을 승인 완료 메일에도
        // 함께 표시해, 수련생이 자신이 신청한 금액을 다시 확인할 수 있게 합니다.
        const gradePriceLine = requestedGrade
          ? `<p style="color:#4a5568;line-height:1.7;">신청하신 급수: <strong>${requestedGrade}급</strong> · 이용 요금: <strong>${(COUNSELOR_INTERVIEW_PRICE.course || {})[requestedGrade] || '확인 필요'}</strong></p>`
          : '';
        await sendEmail({
          to     : userEmail,
          subject: `[${serviceName}] 이용 승인이 완료되었습니다`,
          html   : `<div style="font-family:sans-serif;font-size:11pt;padding:30px;border:1px solid #e2e8f0;border-radius:12px;">
            <h2 style="color:#364d79;margin-bottom:10px;">AI 면접 코스 이용 승인 완료</h2>
            <p style="color:#4a5568;line-height:1.7;">안녕하세요, <strong>${userName || userEmail}</strong>님.<br>입금이 확인되어 AI 면접 코스 이용이 즉시 활성화되었습니다. 새로고침 또는 재로그인 시 반영됩니다.</p>
            ${gradePriceLine}
            <p style="color:#4a5568;line-height:1.7;">이용 기간은 <strong>${expiryStr}</strong>까지입니다.</p>
            <p style="font-size:0.9rem;color:#718096;line-height:1.7;">문의: <a href="mailto:${adminEmail}" style="color:#364d79;">${adminEmail}</a></p>
            <p style="font-size:0.9rem;color:#a0aec0;margin-top:20px;">MindPass 드림</p>
          </div>`
        });

        // [PRICE-BY-GRADE] 급수·금액과 배정된 공통 일정 팀을 Slack 완료 메시지에도
        // 표시합니다(관리자가 별도로 배정할 필요 없음을 명확히 함).
        const gradePriceSlackLine = requestedGrade
          ? `\n🎓 급수: ${requestedGrade}급 · 💰 요금: ${(COUNSELOR_INTERVIEW_PRICE.course || {})[requestedGrade] || '확인 필요'}`
          : '';
        await updateSlackMessage(responseUrl, [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `✅ *AI 면접 코스 즉시 배정 완료 (${examLabel})*\n${userName || userEmail} (${userEmail})${gradePriceSlackLine}\n"${courseTeam.name}"에 자동 배정됨 (팀 배정 불필요, 이용기한 ${expiryStr})`
          }
        }]);
        return res.status(200).end();
      }

      // [MULTI-CERT-4] 예전엔 요금제와 무관하게 항상 +1개월로 승인됐습니다.
      // 이제 신청 시 선택한 planMonths(1개월/6개월)만큼 더합니다.
      const expiry    = new Date();
      expiry.setMonth(expiry.getMonth() + planMonths);
      const expiryStr = expiry.toLocaleDateString('ko-KR');

      console.log('[slack-action] 승인 처리 시작 —', examLabel, '/ 요금제:', planMonths, '개월 / 만료일:', expiryStr);

      const { error } = await supabase
        .from('user_subscriptions')
        .upsert(
          [{ user_id: resolvedUserId, exam_type: examType, status: 'premium', expiry_date: expiry.toISOString() }],
          { onConflict: 'user_id,exam_type' }
        );

      // [MULTI-CERT-6] 프리미엄 등록 이력 기록 — user_subscriptions는 만료되면
      // (수동이든 cron 자동 다운그레이드든) 값이 free로 덮어써져 과거 기록이
      // 사라집니다. subscription_history에는 부여될 때마다 한 줄씩만 추가하고
      // 절대 수정/삭제하지 않아, 관리자가 이후에도 등록 이력을 조회할 수 있습니다.
      // 이 insert가 실패해도 본 승인 흐름(구독 반영/메일 발송)은 막지 않습니다 —
      // 이력 기록은 부가 기능이라 실패해도 핵심 기능에 영향을 주면 안 됩니다.
      const { error: historyError } = await supabase
        .from('subscription_history')
        .insert([{
          user_id    : resolvedUserId,
          exam_type  : examType,
          months     : planMonths,
          granted_at : new Date().toISOString(),
          expiry_date: expiry.toISOString(),
          source     : 'slack-approval'
        }]);
      if (historyError) {
        console.error('[slack-action] subscription_history 기록 실패(무시하고 계속 진행):', historyError.message);
      }

      if (error) {
        console.error('[slack-action] user_subscriptions upsert 실패:', error.message);
        console.error('[slack-action] DB 업데이트 최종 실패 — 승인 메일 미발송');
        await updateSlackMessage(responseUrl, [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `⚠️ *DB 업데이트 실패 — 수동 처리 필요*\n${userName || userEmail} (${userEmail}) / ${examLabel}\n관리자 대시보드에서 직접 등급을 변경해주세요.`
          }
        }]);
        return res.status(200).end();
      }
      console.log('[slack-action] user_subscriptions upsert 성공');

      await sendEmail({
        to     : userEmail,
        subject: `[${serviceNameDetailed}] 프리미엄 멤버십이 활성화되었습니다`,
        html   : `<div style="font-family:sans-serif;font-size:11pt;padding:30px;border:1px solid #e2e8f0;border-radius:12px;">
          <h2 style="color:#364d79;margin-bottom:10px;">프리미엄 멤버십 활성화</h2>
          <p style="color:#4a5568;line-height:1.7;">안녕하세요, <strong>${userName || userEmail}</strong>님.<br>입금이 확인되어 <strong>${serviceNameDetailed}</strong> 프리미엄 멤버십이 활성화되었습니다.</p>
          <div style="background:#f0f4ff;border-left:4px solid #364d79;padding:16px 20px;margin:20px 0;border-radius:4px 12px 12px 4px;">
            <p style="margin:0;font-size:0.95rem;color:#2d3748;">이용 서비스: <strong>${serviceNameDetailed}</strong><br>등급: <strong>Premium</strong><br>요금제: <strong>${planMonths}개월</strong><br>만료일: <strong>${expiryStr}</strong></p>
          </div>
          <div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:8px;padding:14px 18px;margin-bottom:16px;">
            <p style="margin:0;font-size:0.9rem;color:#92400e;">
              💡 <strong>즉시 적용 방법:</strong> 현재 로그인 중이시라면 페이지를 <strong>새로고침</strong>하거나 <strong>재로그인</strong>하시면 프리미엄 혜택이 즉시 반영됩니다.
            </p>
          </div>
          <p style="font-size:0.9rem;color:#718096;line-height:1.7;">${usageLine}<br>문의: <a href="mailto:${adminEmail}" style="color:#364d79;">${adminEmail}</a></p>
          <p style="font-size:0.9rem;color:#a0aec0;margin-top:20px;">MindPass 드림</p>
        </div>`
      });

      await updateSlackMessage(responseUrl, [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *Premium 승인 완료 (${examLabel})*\n${userName || userEmail} (${userEmail})\n요금제: ${planMonths}개월 / 만료일: ${expiryStr}`
        }
      }]);
    }

    // ── 거절 처리 ──────────────────────────────────────────────
    if (actionId === 'reject_premium') {
      console.log('[slack-action] 거절 처리 시작 —', examLabel);

      await sendEmail({
        to     : userEmail,
        subject: `[${serviceName}] 프리미엄 신청 결과 안내`,
        html   : `<div style="font-family:sans-serif;font-size:11pt;padding:30px;border:1px solid #e2e8f0;border-radius:12px;">
          <h2 style="color:#e53e3e;margin-bottom:10px;">프리미엄 신청 안내</h2>
          <p style="color:#4a5568;line-height:1.7;">안녕하세요, <strong>${userName || userEmail}</strong>님.<br>신청하신 <strong>${serviceName}</strong> 프리미엄 멤버십 처리 중 문제가 발생했습니다.<br>입금 내역을 확인 후 아래로 문의해주시면 빠르게 처리해드리겠습니다.</p>
          <p style="font-size:0.9rem;color:#718096;line-height:1.7;">문의: <a href="mailto:${adminEmail}" style="color:#364d79;">${adminEmail}</a></p>
          <p style="font-size:0.9rem;color:#a0aec0;margin-top:20px;">MindPass 드림</p>
        </div>`
      });

      await updateSlackMessage(responseUrl, [{
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `❌ *신청 거절 (${examLabel})*: ${userName || userEmail} (${userEmail})`
        }
      }]);
    }

    return res.status(200).end();

  } catch (error) {
    console.error('[slack-action] 처리 오류:', error.message);
    console.error('[slack-action] 스택:', error.stack);
    return res.status(200).end();
  }
}
