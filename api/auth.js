// auth.js
// ─────────────────────────────────────────────────────────────────
// 수정 이력
// [MULTI-CERT-1] 자격증별(exam_type) 구독 응답 구조 변경
//                변경 전: 로그인 응답이 단일 status(free/premium/admin) 하나로
//                전체 자격증 등급을 표현
//                변경 후: user_subscriptions(user_id, exam_type)를 조회해
//                { clinical_psych: 'free'|'premium', youth_counselor: 'free'|'premium' }
//                형태의 subscriptions 맵을 반환합니다. admin은 isAdmin 플래그로
//                별도 표현하며 자격증별 구독 조회를 생략합니다(어차피 전 범위 우회).
//                이 변경은 common.js(로그인 응답 파싱)와 함께 반영되어야 합니다.
//                users.user_status/expiry_date는 admin 여부 판단 용도로만 남기고,
//                premium 여부/만료일 판단은 이제 user_subscriptions가 단일 소스입니다.
// [FIX-Critical-1] reset-password redirectTo — Supabase 대시보드 Redirect URLs
//                  허용 목록에 SITE_URL/index.html 등록 필요 주석 강화 및
//                  SITE_URL 미설정 시 경고 로그 추가
// [FIX-Critical-2] login — users 행 자동생성 로직을 insert → upsert로 교체
//                  signup 직후 로그인 시 중복 insert 경쟁 조건 해소
// [FIX-High-1]    questions.js / years.js와 동일하게 premium 만료 처리를
//                  fire-and-forget → await + 실패 로그로 교체
// [FIX-High-2]    기존 FIX 사항 유지
// [FIX-High-3]    Cache-Control: no-store 헤더 추가
//                  로그아웃 후 브라우저/CDN 캐시에서 인증 응답이 재사용되는 것을 방지
// [FIX-Critical-3] reset-password — SITE_URL 미설정 시 실존하지 않는
//                  placeholder 도메인('https://your-domain.vercel.app')으로
//                  폴백하던 것을, 요청의 실제 host 헤더로 폴백하도록 교체.
//                  기존 방식은 재설정 메일 링크 클릭 시 100% Vercel
//                  "DEPLOYMENT_NOT_FOUND" 404로 이어졌습니다. SITE_URL 환경변수를
//                  실제 도메인으로 설정하는 것이 여전히 권장되는 방법입니다.
// ─────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// [BUGFIX-SESSION-LEAK] supabase.auth.signInWithPassword()를 위 supabase
// 클라이언트로 호출하면, 그 순간부터 이 클라이언트의 모든 .from() 조회가
// service_role이 아니라 "방금 로그인한 그 회원 본인"의 세션(JWT)으로
// 실행됩니다. RLS가 걸린 테이블(예: interview_team_members)을 그 뒤에
// 이 클라이언트로 조회하면 관리자가 아니라는 이유로 에러 없이 0건이
// 반환됩니다(RLS 필터링은 조용히 결과만 비웁니다). users/user_subscriptions처럼
// RLS가 꺼진 테이블은 영향이 없어 지금까지 드러나지 않았을 뿐입니다.
// → signInWithPassword 전용으로 세션을 저장하지 않는 별도 클라이언트를 씁니다.
function createAuthOnlyClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

const EXAM_TYPES = ['clinical_psych', 'youth_counselor', 'counselor_interview'];

// 주의: SUPABASE_KEY는 반드시 service_role 키여야 합니다.
// anon 키와 service_role 키 모두 'eyJ'로 시작하는 JWT이므로
// 코드에서 두 키를 구분하는 것은 불가능합니다.
// set-new-password(비밀번호 재설정)와 delete-user(회원 삭제)는
// service_role 키 없이 anon 키만으로는 403 오류가 발생합니다.
// → Supabase 대시보드 → Project Settings → API → service_role 키를 사용하세요.

// ─────────────────────────────────────────────────────────────────
// [MULTI-CERT-1] 자격증별 구독 상태 조회 헬퍼
// user_subscriptions에 행이 없는 자격증은 'free'로 간주합니다.
// premium인데 만료일이 지난 행은 즉시 free로 다운그레이드합니다.
// ─────────────────────────────────────────────────────────────────
async function getSubscriptions(userId) {
  const result = {};
  for (const examType of EXAM_TYPES) result[examType] = 'free';

  const { data: subs, error } = await supabase
    .from('user_subscriptions')
    .select('exam_type, status, expiry_date')
    .eq('user_id', userId);

  if (error) {
    console.error('[auth.js] user_subscriptions 조회 실패:', error.message);
  } else {
    for (const row of subs || []) {
      // [TEAM-MGMT] counselor_interview는 더 이상 user_subscriptions로 판정하지
      // 않습니다(아래에서 팀 소속 기준으로 별도 계산). 과거에 premium으로
      // 남아있는 행이 있어도 무시합니다.
      if (row.exam_type === 'counselor_interview') continue;

      let status = row.status || 'free';
      if (status === 'premium' && row.expiry_date && new Date(row.expiry_date) < new Date()) {
        status = 'free';
        const { error: downgradeErr } = await supabase
          .from('user_subscriptions')
          .update({ status: 'free' })
          .eq('user_id', userId)
          .eq('exam_type', row.exam_type);
        if (downgradeErr) {
          console.error('[auth.js] premium 만료 처리 실패:', downgradeErr.message, '/ exam_type:', row.exam_type);
        } else {
          console.log('[auth.js] premium 만료 → free 처리 완료:', userId, '/ exam_type:', row.exam_type);
        }
      }
      if (EXAM_TYPES.includes(row.exam_type)) {
        result[row.exam_type] = status;
      }
    }
  }

  // [TEAM-MGMT] counselor_interview는 활성 팀 소속 여부로 판정합니다.
  // interview_team_members.removed_at is null == 현재 소속 중.
  // [ACCESS-EXPIRY] access_expires_at(이용권 3개월 만료)이 지났으면 팀 소속이
  // 남아있어도 'free'로 취급합니다 — 지난 연습 기록 조회 자체는 interview.js의
  // list 액션이 access 상태와 무관하게 항상 허용하므로 여기서 막을 필요는 없습니다.
  const { data: membership, error: teamErr } = await supabase
    .from('interview_team_members')
    .select('team_id, access_expires_at, interview_teams(status, delivery_mode)')
    .eq('user_id', userId)
    .is('removed_at', null)
    .maybeSingle();

  // [COACHING-ONLY-PREMIUM] 회원 등급 배지는 "코칭 면접 코스"(delivery_mode=
  // 'live') 소속 여부로만 결정합니다. "AI 면접 코스"(async) 팀 소속은 그
  // 자체로는 이 배지에 영향을 주지 않습니다.
  if (teamErr) {
    console.error('[auth.js] interview_team_members 조회 실패:', teamErr.message);
  } else if (membership && membership.interview_teams?.status === 'active' && membership.interview_teams?.delivery_mode === 'live') {
    const isExpired = !!(membership.access_expires_at && new Date(membership.access_expires_at) < new Date());
    result.counselor_interview = isExpired ? 'free' : 'premium';
  } else {
    // [COACHING-FLAG] 팀 소속이 없어도, 관리자가 "회원 권한 관리"에서 직접
    // 부여한 코칭면접코스 Premium 플래그가 있으면 premium으로 처리합니다.
    const { data: coachingSub, error: coachingErr } = await supabase
      .from('user_subscriptions')
      .select('status, expiry_date')
      .eq('user_id', userId)
      .eq('exam_type', 'coaching_interview')
      .maybeSingle();

    if (coachingErr) {
      console.error('[auth.js] user_subscriptions(coaching_interview) 조회 실패:', coachingErr.message);
    }

    if (coachingSub && coachingSub.status === 'premium') {
      const isExpired = !!(coachingSub.expiry_date && new Date(coachingSub.expiry_date) < new Date());
      result.counselor_interview = isExpired ? 'free' : 'premium';
    } else {
      // [PRACTICE-ONLY] 팀 소속이 없어도 "AI 자율연습" 단독 신청이 승인된 사용자는
      // premium으로 처리합니다(AI 면접 코스 일정은 비어 있지만 자율연습 탭은 열립니다).
      const { data: practiceAccess, error: practiceErr } = await supabase
        .from('interview_practice_only_access')
        .select('access_expires_at')
        .eq('user_id', userId)
        .maybeSingle();

      if (practiceErr) {
        console.error('[auth.js] interview_practice_only_access 조회 실패:', practiceErr.message);
      } else if (practiceAccess) {
        const isExpired = !!(practiceAccess.access_expires_at && new Date(practiceAccess.access_expires_at) < new Date());
        result.counselor_interview = isExpired ? 'free' : 'premium';
      }
    }
  }

  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  // [FIX-High-3] 캐시 방지 헤더 — 인증 응답은 절대 캐시되어서는 안 됩니다.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const { action } = req.query;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error('[auth.js] SUPABASE_URL 또는 SUPABASE_KEY 환경변수 누락');
    return res.status(500).json({ message: '서버 설정 오류입니다. 관리자에게 문의해주세요.' });
  }

  try {
    // ────────────────────────────────────────────────
    // 로그인
    // ────────────────────────────────────────────────
    if (action === 'login') {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ message: '이메일과 비밀번호를 입력해주세요.' });
      }

      // [BUGFIX-SESSION-LEAK] 별도 클라이언트 사용 — 아래에서 계속 쓰는
      // 모듈 레벨 supabase 클라이언트는 service_role 권한을 그대로 유지해야 합니다.
      const { data, error } = await createAuthOnlyClient().auth.signInWithPassword({ email, password });
      if (error) {
        console.error('[auth.js] signInWithPassword 실패:', error.message);
        throw error;
      }

      // 이메일 인증 체크 — signInWithPassword 직후, users 조회 이전
      // 미인증 사용자가 isNotFound 조건을 만족해 users 행이 삽입되는 버그 방지
      if (data.user.email_confirmed_at === null) {
        console.warn('[auth.js] 미인증 이메일 로그인 시도:', email);
        return res.status(403).json({
          message: '이메일 인증이 필요합니다. 받은 편지함을 확인하고 인증 링크를 클릭해주세요.'
        });
      }

      const { data: userProfile, error: profileError } = await supabase
        .from('users')
        .select('user_status, name')
        .eq('id', data.user.id)
        .single();

      if (profileError) {
        console.error('[auth.js] users 조회 실패 (id:', data.user.id, '):', profileError.message);
        console.error('[auth.js] 힌트: Vercel 환경변수 SUPABASE_KEY가 service_role 키인지 확인하세요.');
      }

      // users 행 자동생성 조건
      // PGRST116(행 없음) 코드를 명시적으로 처리하고,
      // profileError 없이 userProfile이 null인 경우도 포함
      const isRlsError = profileError?.message?.includes('42501') || profileError?.code === '42501';
      const isNotFound = profileError?.code === 'PGRST116' || (!userProfile && !isRlsError);

      if (isNotFound) {
        console.log('[auth.js] users 행 자동 생성 시도 (첫 로그인):', data.user.id);
        const { error: upsertError } = await supabase.from('users').upsert([{
          id         : data.user.id,
          email      : data.user.email,
          name       : data.user.user_metadata?.name || '',
          user_status: 'free'
        }], { onConflict: 'id', ignoreDuplicates: true });

        if (upsertError) {
          console.error('[auth.js] users 행 자동 생성 실패:', upsertError.message);
        }
      }

      // [MULTI-CERT-1] admin은 전 자격증 우회 — subscriptions 조회를 생략하고
      // 프론트엔드가 자격증 무관하게 표시할 수 있도록 모두 'admin'으로 채웁니다.
      const isAdmin = userProfile?.user_status === 'admin';
      let subscriptions;
      if (isAdmin) {
        subscriptions = { clinical_psych: 'admin', youth_counselor: 'admin' };
      } else {
        subscriptions = await getSubscriptions(data.user.id);
      }

      console.log('[auth.js] 로그인 성공:', email, '/ isAdmin:', isAdmin, '/ subscriptions:', subscriptions);

      return res.status(200).json({
        user: {
          id   : data.user.id,
          email: data.user.email,
          name : userProfile?.name || data.user.user_metadata?.name || ''
        },
        isAdmin,
        subscriptions,
        accessToken: data.session.access_token
      });
    }

    // ────────────────────────────────────────────────
    // 회원가입
    // ────────────────────────────────────────────────
    if (action === 'signup') {
      const { email, password, name } = req.body;
      if (!email || !password || !name) {
        return res.status(400).json({ message: '이름, 이메일, 비밀번호를 모두 입력해주세요.' });
      }
      if (password.length < 6) {
        return res.status(400).json({ message: '비밀번호는 6자 이상이어야 합니다.' });
      }
      if (name.length > 20) {
        return res.status(400).json({ message: '이름은 20자 이내로 입력해주세요.' });
      }

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name } }
      });
      if (error) throw error;

      // 이메일 확인이 비활성화된 환경(Confirm email = OFF)에서는 즉시 users 행 생성
      if (data.user?.id && data.user?.email_confirmed_at) {
        console.log('[auth.js] 이메일 확인 비활성화 환경 — 가입 즉시 users 행 생성:', data.user.id);
        const { error: upsertError } = await supabase
          .from('users')
          .upsert([{ id: data.user.id, email, name, user_status: 'free' }], {
            onConflict    : 'id',
            ignoreDuplicates: true
          });
        if (upsertError) {
          console.error('[auth.js] users upsert 실패:', upsertError.message);
        }
      }

      return res.status(200).json({
        message: '가입 완료! 이메일 받은 편지함에서 인증 링크를 클릭해주세요.'
      });
    }

    // ────────────────────────────────────────────────
    // 비밀번호 재설정 이메일 발송
    // ────────────────────────────────────────────────
    if (action === 'reset-password') {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ message: '이메일을 입력해주세요.' });
      }

      // [FIX-Critical-3] 이전에는 SITE_URL 미설정 시 실존하지 않는 placeholder
      // 도메인('https://your-domain.vercel.app')으로 폴백해, 재설정 메일의
      // 링크를 클릭하면 무조건 Vercel "DEPLOYMENT_NOT_FOUND" 404가 발생했습니다.
      // → 요청이 실제로 도달한 호스트(x-forwarded-host/host 헤더)로 폴백해
      // 최소한 살아있는 배포로는 연결되도록 합니다. 다만 이 값은 프리뷰
      // 배포 등에서 변할 수 있으므로, Vercel 프로젝트 환경변수에 SITE_URL을
      // 실제 서비스 도메인으로 명시적으로 설정하는 것을 강력히 권장합니다.
      const requestHost = req.headers['x-forwarded-host'] || req.headers.host;
      const fallbackUrl = requestHost ? `https://${requestHost}` : null;

      if (!process.env.SITE_URL) {
        console.warn(
          '[auth.js] SITE_URL 환경변수가 설정되지 않았습니다. ' +
          `요청 호스트(${requestHost || '알 수 없음'})로 임시 대체합니다. ` +
          'Vercel 환경변수에 SITE_URL을 실제 서비스 도메인으로 설정하고, ' +
          'Supabase Redirect URLs 허용 목록에도 동일 도메인/index.html을 등록하세요.'
        );
      }

      const siteUrl = process.env.SITE_URL || fallbackUrl;
      if (!siteUrl) {
        console.error('[auth.js] SITE_URL도 없고 요청 호스트도 확인할 수 없어 재설정 링크를 만들 수 없습니다.');
        return res.status(500).json({ message: '서버 설정 오류로 재설정 링크를 생성할 수 없습니다. 관리자에게 문의해주세요.' });
      }

      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${siteUrl}/index.html?type=recovery`
      });

      if (error) {
        console.error('[auth.js] resetPasswordForEmail 오류:', error.message);
      }

      // 보안상 이메일 존재 여부 미노출 — 성공/실패 무관하게 200 반환
      return res.status(200).json({
        message: '재설정 링크를 발송했습니다. 이메일을 확인해주세요. (스팸함도 확인해주세요)'
      });
    }

    // ────────────────────────────────────────────────
    // 새 비밀번호 저장
    // [주의] supabase.auth.admin.updateUserById()는 service_role 키 필수
    // SUPABASE_KEY가 anon 키이면 이 액션은 403으로 실패합니다.
    // Vercel 환경변수에 service_role 키를 설정했는지 반드시 확인하세요.
    // ────────────────────────────────────────────────
    if (action === 'set-new-password') {
      const { password } = req.body;
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: '인증 토큰이 없습니다.' });
      }
      if (!password || password.length < 6) {
        return res.status(400).json({ message: '비밀번호는 6자 이상 입력해주세요.' });
      }

      const token = authHeader.split(' ')[1];

      // recovery 토큰으로 사용자 확인
      const { data: sessionData, error: sessionError } =
        await supabase.auth.getUser(token);
      if (sessionError || !sessionData.user) {
        return res.status(401).json({
          message: '유효하지 않거나 만료된 토큰입니다. 재설정 링크를 다시 요청해주세요.'
        });
      }

      const { error: updateError } = await supabase.auth.admin.updateUserById(
        sessionData.user.id,
        { password }
      );
      if (updateError) {
        console.error(
          '[auth.js] updateUserById 실패. SUPABASE_KEY가 service_role 키인지 확인하세요:',
          updateError.message
        );
        throw updateError;
      }

      return res.status(200).json({ message: '비밀번호가 성공적으로 변경되었습니다.' });
    }

    return res.status(400).json({ message: 'Invalid auth action' });

  } catch (error) {
    console.error(`[auth.js] action=${action} 예외:`, error.message);
    return res.status(500).json({ message: error.message });
  }
}
