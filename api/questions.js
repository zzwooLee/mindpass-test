// questions.js
// ─────────────────────────────────────────────────────────────────
// 수정 이력
// [MULTI-CERT-1] 자격증별(exam_type) 구독 지원
//                변경 전: users.user_status 하나로 전체 자격증 등급을 관리
//                변경 후: user_subscriptions 테이블에서 (user_id, exam_type)
//                기준으로 free/premium을 조회. admin은 users.user_status로
//                여전히 전 자격증 우회. examType은 body 필수 파라미터.
// [FIX-High-1] premium 만료 처리 fire-and-forget → await + 실패 로그
//              기존 .then(()=>{}).catch(()=>{}) 패턴은 업데이트 실패 시
//              아무 흔적도 남기지 않아 만료 후에도 premium 접근이 허용될 수 있었음
// [FIX-High-2] Cache-Control: no-store 헤더 추가
//              로그아웃 후 브라우저/CDN 캐시에서 이전 문제 데이터가 재사용되는 것을 방지
// [기존 유지]  free 유저 limit 서버 강제 제한 (클라이언트 우회 방지)
// [기존 유지]  Fisher-Yates 셔플 (통계적 균등성 보장)
// [기존 유지]  body.userStatus 폴백 완전 제거 — JWT 검증 실패 시 401 반환
// [기존 유지]  exam_date int4(YYYYMMDD) 연도 필터 정수 범위 처리
// [FIX-MIXED-DATE-FORMAT] exam_date에 8자리(YYYYMMDD)와 4자리(연도만) 형식이
//              섞여 있어 8자리 범위 조건만으로는 4자리 형식 문제가 연도 필터에서
//              누락되는 문제를 확인, OR 조건으로 두 형식 모두 포함하도록 수정
// [FIX-2025-1] premium 열람 범위 수정
//              변경 전: explanation IS NOT NULL 조건만 적용 (is_premium 무관)
//              변경 후: is_premium = true AND explanation IS NOT NULL
//              → premium 유저는 유료 문제(is_premium=TRUE) 중 해설이 있는 문제만 열람
// [FIX-2025-2] free 유저 해설 차단
//              변경 전: explanation 컬럼이 있으면 무조건 노출
//              변경 후: free 유저에게는 해설 블록 자체를 반환하지 않음
//              → 클라이언트(common.js) checkAnswer에서 추가 처리
// [MULTI-CERT-3] premium 열람 범위를 무료 문제 포함으로 확장
//              변경 전: premium 회원은 is_premium=TRUE(+해설 있음) 문제만 조회
//              가능해, 무료(is_premium=FALSE) 문제는 프리미엄 결제 후 오히려
//              볼 수 없었습니다.
//              변경 후: premium 회원은 무료 문제 세트 + 프리미엄 문제 세트를
//              각각 조회해 합칩니다(공통 필터를 baseQuery() 팩토리로 분리 후
//              두 번 호출). 즉 프리미엄 = 무료 전체 + 추가 연도(해설 포함).
//              years.js의 연도 목록도 동일하게 맞춰야 합니다(별도 커밋 참고).
// [FREE-ALL-1] 기출문제 전면 무료화 (2026-08)
//              임상심리사/청소년상담사 기출문제의 free/premium 구분을
//              폐지했습니다. 로그인한 모든 사용자가 등급/과목/연도 필터에
//              맞는 문제 전체를 동일하게 조회하며, 해설(explanation)은
//              누구에게도 제공하지 않습니다(응답에서 항상 제거).
//              전문상담사 AI 모의면접(counselor_interview) 유료 프로그램은
//              이 파일과 무관하며 영향받지 않습니다.
// ─────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const VALID_EXAM_TYPES = ['clinical_psych', 'youth_counselor'];

// ─────────────────────────────────────────────────────────────────
// JWT 검증 헬퍼
// [MULTI-CERT-1] examType을 받아 해당 자격증 구독 상태를 조회합니다.
// admin은 users.user_status로 전 자격증 우회, 그 외에는
// user_subscriptions(user_id, exam_type)에서 free/premium을 판단합니다.
// ─────────────────────────────────────────────────────────────────
async function verifyUser(req, examType) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.split(' ')[1];

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      console.warn('[questions.js] JWT 검증 실패:', authError?.message);
      return null;
    }

    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('user_status')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      console.warn('[questions.js] users 조회 실패:', profileError?.message);
      return null;
    }

    // admin은 자격증과 무관하게 전 범위 접근
    if (profile.user_status === 'admin') {
      return { id: user.id, user_status: 'admin' };
    }

    const { data: sub, error: subError } = await supabase
      .from('user_subscriptions')
      .select('status, expiry_date')
      .eq('user_id', user.id)
      .eq('exam_type', examType)
      .maybeSingle();

    if (subError) {
      console.warn('[questions.js] user_subscriptions 조회 실패:', subError.message);
      return { id: user.id, user_status: 'free' };
    }

    let status = sub?.status || 'free';
    if (status === 'premium' && sub?.expiry_date) {
      if (new Date(sub.expiry_date) < new Date()) {
        status = 'free';
        const { error: downgradeErr } = await supabase
          .from('user_subscriptions')
          .update({ status: 'free' })
          .eq('user_id', user.id)
          .eq('exam_type', examType);
        if (downgradeErr) {
          console.error('[questions.js] premium 만료 처리 DB 업데이트 실패:', downgradeErr.message);
        } else {
          console.log('[questions.js] premium 만료 → free 처리 완료:', user.id, '/ examType:', examType);
        }
      }
    }

    return { id: user.id, user_status: status };
  } catch (e) {
    console.warn('[questions.js] verifyUser 예외:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Fisher-Yates 셔플
// Math.random() 기반 sort()는 통계적으로 균등하지 않습니다.
// Fisher-Yates는 모든 순열이 동등한 확률을 가집니다.
// ─────────────────────────────────────────────────────────────────
function fisherYatesShuffle(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────
// 핸들러
// ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  // [FIX-High-2] 캐시 방지 헤더 — years.js와 동일한 패턴
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const { grade, category, year, limit, examType } = req.body;

  // [MULTI-CERT-1] examType 필수 검증
  if (!examType || !VALID_EXAM_TYPES.includes(examType)) {
    return res.status(400).json({ message: `examType은 ${VALID_EXAM_TYPES.join(', ')} 중 하나여야 합니다.` });
  }

  const verified = await verifyUser(req, examType);
  if (!verified) {
    console.warn('[questions.js] 인증 실패 → 401 반환');
    return res.status(401).json({ message: '세션이 만료되었습니다. 다시 로그인해주세요.' });
  }

  const userStatus = verified.user_status;
  console.log('[questions.js] JWT 검증 성공 → userStatus:', userStatus, '/ examType:', examType);

  try {
    // ── 0~1, 3. 자격증 / 등급 / 과목 / 연도 공통 필터 ──────────
    // [MULTI-CERT-3] premium 회원은 무료 문제 세트 + 프리미엄 문제 세트를 각각
    // 조회해 합쳐야 하므로, 공통 필터를 매번 새로 적용할 수 있도록 팩토리
    // 함수로 뺐습니다(supabase-js 쿼리 빌더는 한 번 조립한 체인을 재사용할 수
    // 없어 .or()로 한 번에 합치는 대신 이 방식을 씁니다).
    function baseQuery() {
      let q = supabase.from('questions').select('*').eq('exam_type', examType);
      if (grade)    q = q.eq('grade', grade);
      if (category) q = q.eq('category', category);
      if (year && String(year).trim() !== '') {
        const y = parseInt(year, 10);
        if (!isNaN(y) && y > 1900 && y < 2100) {
          const dateFrom = y * 10000 + 101;
          const dateTo   = y * 10000 + 1231;
          // [FIX-MIXED-DATE-FORMAT] exam_date(int4)에 8자리(YYYYMMDD)와
          // 4자리(연도만) 형식이 섞여 있는 것으로 확인되었습니다. 8자리 범위
          // 조건만 쓰면 4자리로 저장된 문제는 해당 연도로 필터링해도 누락됩니다.
          // "8자리 범위에 속함" 또는 "4자리 연도와 정확히 일치" 둘 중 하나만
          // 맞아도 포함되도록 OR로 묶어 두 형식을 모두 잡아냅니다.
          q = q.or(`and(exam_date.gte.${dateFrom},exam_date.lte.${dateTo}),exam_date.eq.${y}`);
          console.log(`[questions.js] 연도 필터: ${dateFrom}~${dateTo} 또는 exam_date=${y}`);
        }
      }
      return q;
    }

    // ── 2. 기출문제 전면 무료화 ────────────────────────────
    // [FREE-ALL-1] 정책 변경: 임상심리사·청소년상담사 기출문제는 더 이상
    // free/premium으로 조회 범위를 나누지 않습니다. 로그인한 사용자라면
    // 등급/과목/연도 필터에 맞는 문제 전체(구 is_premium=TRUE 포함)를
    // 동일하게 조회합니다.
    const { data, error } = await baseQuery();
    if (error) throw error;

    if (!data || data.length === 0) {
      console.log('[questions.js] 조건에 맞는 문제 없음');
      return res.status(200).json([]);
    }

    // ── 4. 개수 제한 파싱 ────────────────────────────────────
    // [FREE-ALL-1] free 유저 20문제 강제 캡을 제거했습니다 — 모든 로그인
    // 사용자가 동일하게 최대 100문제까지 선택할 수 있습니다.
    const parsedLimit = parseInt(limit, 10);
    const limitNum = Math.min(
      (!isNaN(parsedLimit) && parsedLimit > 0) ? parsedLimit : 20,
      100
    );

    // ── 5. Fisher-Yates 셔플 + 슬라이스 ─────────────────────
    const shuffled = fisherYatesShuffle(data).slice(0, limitNum);

    // [FREE-ALL-2] 해설(explanation)은 등급과 무관하게 절대 제공하지 않습니다.
    // "기출문제는 무료로 제공하되 해설은 제공하지 않는다"는 정책에 따라
    // 응답 페이로드에서 해설 필드를 항상 제거합니다.
    const sanitized = shuffled.map(({ explanation, ...rest }) => rest);

    console.log(`[questions.js] 응답: ${sanitized.length}문제 / 전체 ${data.length}문제`);
    return res.status(200).json(sanitized);

  } catch (error) {
    console.error('[questions.js] 오류:', error.message);
    return res.status(500).json({ message: error.message });
  }
}
