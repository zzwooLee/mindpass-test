// subscription-check.js
// ─────────────────────────────────────────────────────────────────
// [MULTI-CERT-5] 프리미엄 만료 자동 처리 (Vercel Cron, 매일 1회 실행)
//
// 지금까지 만료 처리는 "유저가 로그인/문제 조회를 할 때" auth.js·questions.js·
// years.js가 그 자리에서 확인해 premium → free로 내리는 지연(lazy) 방식뿐이었습니다.
// 그래서 (1) 만료 전에 미리 알려줄 방법이 없었고, (2) 유저가 로그인하지 않으면
// 실제로는 만료됐어도 DB상 premium 상태가 계속 남아있었습니다.
//
// 이 크론이 매일 하는 일:
//  1. [D-7 안내] status=premium이고 만료일이 "지금부터 6~7일 후" 사이인 구독을
//     찾아 만료 임박 안내 메일을 보냅니다. 하루 1회 실행 기준으로 이 창이
//     한 구독당 정확히 한 번만 걸리도록 폭을 24시간으로 잡았습니다(중복 발송 방지
//     플래그 컬럼 없이도 안전).
//  2. [자동 다운그레이드] status=premium이고 만료일이 이미 지난 구독을 모두
//     free로 일괄 전환합니다. 유저가 다시 로그인하지 않아도 정시에 반영됩니다.
//
// [ACCESS-EXPIRY / Phase 8] counselor_interview(전문상담사 AI 모의면접)는
// user_subscriptions가 아니라 interview_team_members.access_expires_at으로
// 판정합니다(interview.js/auth.js 주석 참고). 이 값은 getInterviewAccess()가
// 요청마다 즉시 비교해 판정하는 라이브 계산이라 위 2번(자동 다운그레이드) 같은
// DB 갱신이 필요 없고, 1번(D-7 안내 메일)만 이 크론에 추가로 붙입니다.
//
// [SETTINGS-1] 문의 이메일을 process.env.ADMIN_EMAIL 하드코딩 대신
//              app_settings 테이블(관리자 화면에서 수정 가능)에서 읽어옵니다.
//              값이 없으면(아직 설정 안 함) 기존처럼 환경변수로 폴백합니다.
//
// 보안: Vercel Cron은 호출 시 Authorization: Bearer <CRON_SECRET> 헤더를
// 자동으로 붙여줍니다(Vercel 프로젝트 환경변수에 CRON_SECRET을 설정해두면 됨).
// 이 값이 일치하지 않으면 외부에서의 임의 호출로 간주해 401을 반환합니다.
// ─────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const VALID_EXAM_TYPES = ['clinical_psych', 'youth_counselor'];
const EXAM_LABELS = { clinical_psych: '임상심리사', youth_counselor: '청소년상담사' };

// ─────────────────────────────────────────────────────────────────
// [SETTINGS-1] 문의 이메일 조회 — app_settings에 관리자가 설정해둔 값이
// 있으면 그 값을, 없으면(테이블 미생성 포함) 환경변수(ADMIN_EMAIL)로 폴백합니다.
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
    console.warn('[subscription-check.js] app_settings 조회 실패 — 환경변수로 폴백:', e.message);
    return process.env.ADMIN_EMAIL;
  }
}

// ─────────────────────────────────────────────────────────────────
// Resend 메일 발송 — slack-action.js/interview.js와 동일한 패턴입니다.
// ─────────────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = `MindPass <${process.env.MAIL_FROM || 'onboarding@resend.dev'}>`;
  // [SETTINGS-2] MAIL_FROM은 실제로 받는 메일함이 없는 주소일 수 있으므로,
  // 수신자가 "답장"을 누르면 문의 이메일로 가도록 reply_to를 함께 지정합니다.
  const replyTo = await getContactEmail();

  if (!resendKey) {
    console.error('[subscription-check.js] RESEND_API_KEY 환경변수 누락 — 메일 발송 생략:', subject);
    return false;
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${resendKey}` },
      body   : JSON.stringify({ from: fromEmail, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) })
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[subscription-check.js] Resend 오류:', JSON.stringify(data));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[subscription-check.js] 메일 발송 예외:', e.message);
    return false;
  }
}

export default async function handler(req, res) {
  // Vercel Cron은 GET으로 호출합니다. 수동 테스트도 편하도록 GET/POST 둘 다 허용합니다.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  // [보안] Vercel이 자동으로 실어 보내는 CRON_SECRET 검증 — 없으면 외부 호출로 간주.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${cronSecret}`) {
      console.warn('[subscription-check.js] CRON_SECRET 불일치 — 401 반환');
      return res.status(401).json({ message: 'Unauthorized' });
    }
  } else {
    console.warn('[subscription-check.js] CRON_SECRET 환경변수가 설정되지 않았습니다. 보안을 위해 설정을 권장합니다.');
  }

  const adminEmail = await getContactEmail();

  try {
    const now = new Date();
    const in6days = new Date(now); in6days.setDate(in6days.getDate() + 6);
    const in7days = new Date(now); in7days.setDate(in7days.getDate() + 7);

    // ── 1. D-7 만료 임박 안내 ──────────────────────────────────
    const { data: upcoming, error: upcomingErr } = await supabase
      .from('user_subscriptions')
      .select('user_id, exam_type, expiry_date')
      .eq('status', 'premium')
      .in('exam_type', VALID_EXAM_TYPES)
      .gte('expiry_date', in6days.toISOString())
      .lt('expiry_date', in7days.toISOString());

    if (upcomingErr) {
      console.error('[subscription-check.js] 만료 임박 구독 조회 실패:', upcomingErr.message);
    }

    let reminderSent = 0;
    let reminderFailed = 0;

    if (upcoming && upcoming.length > 0) {
      const userIds = [...new Set(upcoming.map(row => row.user_id))];
      const { data: users, error: usersErr } = await supabase
        .from('users')
        .select('id, email, name')
        .in('id', userIds);

      if (usersErr) {
        console.error('[subscription-check.js] 유저 정보 조회 실패:', usersErr.message);
      }
      const userMap = new Map((users || []).map(u => [u.id, u]));

      for (const row of upcoming) {
        const user = userMap.get(row.user_id);
        if (!user?.email) {
          console.warn('[subscription-check.js] 이메일 없는 유저 — 리마인드 생략:', row.user_id, row.exam_type);
          continue;
        }

        const examLabel = EXAM_LABELS[row.exam_type] || row.exam_type;
        const expiryStr = new Date(row.expiry_date).toLocaleDateString('ko-KR');

        const ok = await sendEmail({
          to     : user.email,
          subject: `[자격증 퀴즈 뱅크] 프리미엄 멤버십 만료 임박 안내 (D-7)`,
          html   : `<div style="font-family:sans-serif;font-size:11pt;padding:30px;border:1px solid #e2e8f0;border-radius:12px;">
            <h2 style="color:#c05621;margin-bottom:10px;">만료 임박 안내</h2>
            <p style="color:#4a5568;line-height:1.7;">안녕하세요, <strong>${user.name || user.email}</strong>님.<br><strong>${examLabel}</strong> 프리미엄 멤버십이 <strong>${expiryStr}</strong>에 만료될 예정입니다.</p>
            <div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:8px;padding:14px 18px;margin:16px 0;">
              <p style="margin:0;font-size:0.9rem;color:#92400e;">만료 이후에는 자동으로 무료 회원으로 전환되어, 무료 연도의 문제만 열람 가능합니다.<br>계속 이용하시려면 로그인 후 자격증 퀴즈 뱅크 페이지에서 다시 신청해주세요.</p>
            </div>
            <p style="font-size:0.9rem;color:#718096;line-height:1.7;">문의: <a href="mailto:${adminEmail}" style="color:#364d79;">${adminEmail}</a></p>
            <p style="font-size:0.9rem;color:#a0aec0;margin-top:20px;">MindPass 드림</p>
          </div>`
        });

        if (ok) reminderSent++; else reminderFailed++;
      }
    }

    // ── 1-2. [ACCESS-EXPIRY] 전문상담사 AI 모의면접 이용 기간 D-7 안내 ──
    // interview_team_members.access_expires_at이 "지금부터 6~7일 후" 사이인
    // 활성 팀원을 찾아 안내 메일을 보냅니다. 자동 다운그레이드 DB 갱신은
    // 필요 없습니다(getInterviewAccess가 매번 즉시 판정하므로).
    const { data: upcomingInterview, error: upcomingInterviewErr } = await supabase
      .from('interview_team_members')
      .select('user_id, access_expires_at, interview_teams(status, name)')
      .is('removed_at', null)
      .not('access_expires_at', 'is', null)
      .gte('access_expires_at', in6days.toISOString())
      .lt('access_expires_at', in7days.toISOString());

    if (upcomingInterviewErr) {
      console.error('[subscription-check.js] AI 모의면접 만료 임박 조회 실패:', upcomingInterviewErr.message);
    }

    let interviewReminderSent = 0;
    let interviewReminderFailed = 0;
    const activeUpcomingInterview = (upcomingInterview || []).filter(r => r.interview_teams?.status === 'active');

    if (activeUpcomingInterview.length > 0) {
      const interviewUserIds = [...new Set(activeUpcomingInterview.map(r => r.user_id))];
      const { data: interviewUsers, error: interviewUsersErr } = await supabase
        .from('users')
        .select('id, email, name')
        .in('id', interviewUserIds);

      if (interviewUsersErr) {
        console.error('[subscription-check.js] 유저 정보 조회 실패(AI 모의면접):', interviewUsersErr.message);
      }
      const interviewUserMap = new Map((interviewUsers || []).map(u => [u.id, u]));

      for (const row of activeUpcomingInterview) {
        const user = interviewUserMap.get(row.user_id);
        if (!user?.email) {
          console.warn('[subscription-check.js] 이메일 없는 유저 — AI 모의면접 리마인드 생략:', row.user_id);
          continue;
        }

        const expiryStr = new Date(row.access_expires_at).toLocaleDateString('ko-KR');

        const ok = await sendEmail({
          to     : user.email,
          subject: `[MindPass] 전문상담사 AI 모의면접 이용 기간 만료 임박 안내 (D-7)`,
          html   : `<div style="font-family:sans-serif;font-size:11pt;padding:30px;border:1px solid #e2e8f0;border-radius:12px;">
            <h2 style="color:#c05621;margin-bottom:10px;">이용 기간 만료 임박 안내</h2>
            <p style="color:#4a5568;line-height:1.7;">안녕하세요, <strong>${user.name || user.email}</strong>님.<br><strong>전문상담사 AI 모의면접</strong> 이용 기간이 <strong>${expiryStr}</strong>에 만료될 예정입니다.</p>
            <div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:8px;padding:14px 18px;margin:16px 0;">
              <p style="margin:0;font-size:0.9rem;color:#92400e;">만료 이후에는 AI 자율연습·AI 면접 코스 등 새 연습 제출이 제한됩니다(지난 연습 기록·피드백은 계속 조회 가능).<br>계속 이용하시려면 로그인 후 재신청해주세요.</p>
            </div>
            <p style="font-size:0.9rem;color:#718096;line-height:1.7;">문의: <a href="mailto:${adminEmail}" style="color:#364d79;">${adminEmail}</a></p>
            <p style="font-size:0.9rem;color:#a0aec0;margin-top:20px;">MindPass 드림</p>
          </div>`
        });

        if (ok) interviewReminderSent++; else interviewReminderFailed++;
      }
    }

    // ── 2. 만료된 구독 자동 다운그레이드 ────────────────────────
    // [MULTI-CERT-5] update()에 .select()를 붙여, 실제로 몇 건이 내려갔는지
    // 응답으로 받아 로그/모니터링에 씁니다.
    const { data: downgraded, error: downgradeErr } = await supabase
      .from('user_subscriptions')
      .update({ status: 'free' })
      .eq('status', 'premium')
      .in('exam_type', VALID_EXAM_TYPES)
      .lt('expiry_date', now.toISOString())
      .select('user_id, exam_type');

    if (downgradeErr) {
      console.error('[subscription-check.js] 자동 다운그레이드 실패:', downgradeErr.message);
    }

    const summary = {
      checkedAt         : now.toISOString(),
      reminderCandidates: upcoming?.length || 0,
      reminderSent,
      reminderFailed,
      downgraded        : downgraded?.length || 0,
      // [ACCESS-EXPIRY] 전문상담사 AI 모의면접(counselor_interview) — 자동
      // 다운그레이드 항목은 없음(라이브 판정이라 DB 갱신 불필요).
      interviewReminderCandidates: activeUpcomingInterview.length,
      interviewReminderSent,
      interviewReminderFailed
    };
    console.log('[subscription-check.js] 실행 완료:', JSON.stringify(summary));

    return res.status(200).json(summary);
  } catch (error) {
    console.error('[subscription-check.js] 오류:', error.message);
    return res.status(500).json({ message: error.message });
  }
}
