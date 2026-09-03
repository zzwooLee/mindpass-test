// years.js
// ─────────────────────────────────────────────────────────────────
// 수정 이력
// [MULTI-CERT-1] 자격증별(exam_type) 구독 및 연도 목록 지원
//                변경 전: users.user_status 하나로 전체 자격증 등급을 관리,
//                뷰가 exam_type을 구분하지 않아 자격증 간 연도가 섞였음
//                변경 후: user_subscriptions(user_id, exam_type)에서 등급을
//                조회하고, 뷰/폴백 쿼리 모두 exam_type으로 필터링합니다.
//                unique_years_premium 뷰에 grade 컬럼이 추가되어 이제
//                실제로 뷰 단에서 grade 필터가 동작합니다(이전에는 뷰에
//                grade 컬럼이 없어 매번 에러 → 직접 쿼리 폴백으로 빠졌음).
// [FIX-High-1] premium 만료 처리 fire-and-forget → await + 실패 로그
//              기존 .then(()=>{}).catch(()=>{}) 패턴은 업데이트 실패 시
//              아무 흔적도 남기지 않아 만료 후에도 premium 접근이 허용될 수 있었음
// [기존 유지]  extractYears: exam_date → year → 첫 번째 숫자값 순으로 탐색
// [기존 유지]  body.userStatus 폴백 완전 제거 — JWT 검증 실패 시 401 반환
// [기존 유지]  select('*') 유연 파싱 (컬럼명 독립)
// [NEW-1] grade 파라미터 수신 — premium 유저에게 급수별 연도 필터링 적용
//         unique_years_premium 뷰는 explanation 완전성 조건을 포함하므로
//         grade가 주어지면 뷰 결과를 grade로 추가 필터링합니다.
//         free / admin 유저는 grade 파라미터를 무시하고 기존 동작을 유지합니다.
// [NEW-2] premium 유저 뷰 0건 시 폴백 금지
//         뷰가 정상 동작했으나 결과가 0건인 경우는 "해당 조건을 충족하는 연도 없음"
//         이므로 빈 배열을 즉시 반환합니다. 폴백으로 넘어가면 explanation 완전성
//         조건을 우회하여 의도하지 않은 연도가 표시될 수 있습니다.
// [FIX-2025-3] free 유저 연도 필터 완전 차단
//              변경 전: unique_years_free 뷰로 연도 목록 제공
//              변경 후: free 유저는 빈 배열 즉시 반환 → 연도 select 비활성화
// [FIX-2025-4] premium 폴백 쿼리 조건 수정
//              변경 전: explanation IS NOT NULL + 자료 외 정보 제외
//              변경 후: is_premium=TRUE AND explanation IS NOT NULL (questions.js와 일치)
// [MULTI-CERT-3] premium 연도 목록을 무료 문제 포함으로 확장
//              변경 전: unique_years_premium 뷰(프리미엄 조건만 반영)로 연도를
//              채워, questions.js에서 premium 회원이 실제로 볼 수 있게 된
//              "무료 문제만 있는 연도"가 드롭다운에서 빠지는 불일치가 있었습니다.
//              변경 후: premium 유저는 뷰를 거치지 않고 무료(is_premium=FALSE)
//              + 프리미엄(is_premium=TRUE, 해설 있음) 두 조건을 직접 조회해
//              합칩니다. admin은 기존 unique_years 뷰 + 폴백 로직을 그대로 유지.
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
// ─────────────────────────────────────────────────────────────────
async function verifyUser(req, examType) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.split(' ')[1];

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      console.warn('[years.js] JWT 검증 실패:', error?.message);
      return null;
    }

    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('user_status')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      console.warn('[years.js] users 조회 실패:', profileError?.message);
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
      console.warn('[years.js] user_subscriptions 조회 실패:', subError.message);
      return { id: user.id, user_status: 'free' };
    }

    let userStatus = sub?.status || 'free';
    if (userStatus === 'premium' && sub?.expiry_date) {
      if (new Date(sub.expiry_date) < new Date()) {
        console.log('[years.js] premium 만료 → free 처리 시작:', user.id, '/ examType:', examType);
        userStatus = 'free';
        const { error: downgradeErr } = await supabase
          .from('user_subscriptions')
          .update({ status: 'free' })
          .eq('user_id', user.id)
          .eq('exam_type', examType);
        if (downgradeErr) {
          console.error('[years.js] premium 만료 처리 DB 업데이트 실패:', downgradeErr.message);
        } else {
          console.log('[years.js] premium 만료 → free 처리 완료:', user.id);
        }
      }
    }

    console.log('[years.js] JWT 검증 성공 → userStatus:', userStatus, '/ examType:', examType);
    return { id: user.id, user_status: userStatus };
  } catch (e) {
    console.warn('[years.js] verifyUser 예외:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// int4 값(20190601 또는 2019) → "2019"
// ─────────────────────────────────────────────────────────────────
function toYear(val) {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  if (isNaN(n) || n <= 0) return null;
  const y = n >= 10000000 ? Math.floor(n / 10000) : n;
  if (y < 1900 || y > 2100) return null;
  return String(y);
}

// ─────────────────────────────────────────────────────────────────
// 뷰 또는 테이블 행 배열 → 연도 문자열 배열
// exam_date → year → 첫 번째 숫자값 순으로 탐색
// select('*')와 조합하여 컬럼 존재 여부에 독립적으로 동작합니다.
// ─────────────────────────────────────────────────────────────────
function extractYears(rows) {
  return rows
    .map(row => {
      // 1순위: exam_date 컬럼
      if (row.exam_date !== undefined) return toYear(row.exam_date);
      // 2순위: year 컬럼
      if (row.year !== undefined)      return toYear(row.year);
      // 3순위: 첫 번째 숫자 값 (뷰 컬럼명이 다를 경우 폴백)
      const firstNumeric = Object.values(row).find(v => typeof v === 'number' || typeof v === 'string');
      return toYear(firstNumeric);
    })
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────
// 핸들러
// ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const { grade, examType } = req.body;

  // [MULTI-CERT-1] examType 필수 검증
  if (!examType || !VALID_EXAM_TYPES.includes(examType)) {
    return res.status(400).json({ message: `examType은 ${VALID_EXAM_TYPES.join(', ')} 중 하나여야 합니다.` });
  }

  const verified = await verifyUser(req, examType);
  if (!verified) {
    console.warn('[years.js] 인증 실패 → 401 반환');
    return res.status(401).json({ message: '세션이 만료되었습니다. 다시 로그인해주세요.' });
  }

  const userStatus = verified.user_status;
  console.log('[years.js] 최종 userStatus:', userStatus, '/ examType:', examType);

  const gradeValue = grade && String(grade).trim() !== '' ? String(grade).trim() : null;

  try {
    // [FREE-ALL-1] 기출문제 전면 무료화 — free/premium 구분 없이 모든 로그인
    // 사용자가 동일한 연도 목록을 조회합니다. questions.js와 마찬가지로
    // is_premium/explanation 조건 없이 exam_type(+grade) 기준 전체 연도를
    // 직접 조회합니다(더 이상 grade 미선택 시 빈 배열을 반환하지 않습니다).
    let query = supabase.from('questions').select('exam_date')
      .eq('exam_type', examType).not('exam_date', 'is', null);
    if (gradeValue) query = query.eq('grade', gradeValue);

    const { data, error } = await query;
    if (error) {
      console.error('[years.js] 연도 조회 실패:', error.message);
      throw error;
    }
    console.log('[years.js] 조회 건수:', data?.length || 0, '/ grade:', gradeValue, '/ examType:', examType);

    const years  = extractYears(data || []);
    const result = [...new Set(years)].sort((a, b) => Number(b) - Number(a));
    console.log('[years.js] 최종 응답 연도 목록:', result);

    return res.status(200).json(result);

  } catch (error) {
    console.error('[years.js] 핸들러 오류:', error.message);
    return res.status(500).json({ message: error.message });
  }
}
