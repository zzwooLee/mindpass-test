// exam-coverage.js
// ─────────────────────────────────────────────────────────────────
// [TIER-INFO-COVERAGE] 자격증 퀴즈 뱅크 안내 카드("이용 가능 연도 안내")에
// 실제로 열람 가능한 연도 범위를 하드코딩 없이 매 요청마다 DB에서 직접
// 확인해 응답합니다. 문제가 추가/삭제되어도 코드 수정 없이 항상 최신 상태를
// 반영합니다.
//
// [FREE-ALL-1] 기출문제 전면 무료화 — 예전에는 free(is_premium=FALSE)와
// premium(is_premium=TRUE + 해설 있음) 두 구간의 연도 범위를 각각 계산해
// 비교했지만, 이제 free/premium 구분이 없어 exam_type(+grade) 기준
// 전체 연도 범위 하나(all)만 계산합니다.
//
// [GRADE-AWARE] 급수(1급/2급/3급)별로 수록 연도가 다를 수 있으므로, 급수별로도
// 계산합니다. 급수 목록은 questions 테이블에 실제로 존재하는 값을 그대로
// 조회합니다(프론트엔드 gradeData를 하드코딩으로 복제하지 않기 위함 — 데이터가
// 유일한 출처입니다). 모든 급수의 값이 동일하면 uniform=true로 표시해,
// 프론트엔드가 "통합 표기" 대신 "급수별 표기"를 써야 하는지 판단할 수 있게 합니다.
//
// [PUBLIC-LANDING-COVERAGE] 원래는 로그인 여부만 확인(비로그인 스크래핑 방지)
// 하고 모든 로그인 사용자에게 동일한 값을 보여주는 API였습니다. 이제 랜딩페이지
// (index.html)가 비로그인 방문자에게도 "실제로 이용 가능한 연도"를 정확히
// 보여줘야 해서 인증 자체를 없앴습니다 — 이 응답에는 애초에 사용자별로 다른
// 값이나 민감한 정보가 없고(모두에게 동일한 연도 범위), 어차피 랜딩페이지에
// 공개할 값이라 로그인 게이트를 유지할 실익이 없습니다.
// ─────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const VALID_EXAM_TYPES = ['clinical_psych', 'youth_counselor'];

// ─────────────────────────────────────────────────────────────────
// int4 값(20190601 또는 2019) → "2019" (years.js의 toYear와 동일 로직)
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
// 해당 자격증에 실제로 존재하는 급수 목록을 questions 테이블에서 직접 조회합니다.
// (프론트엔드 gradeData를 서버에 하드코딩으로 복제하지 않기 위함)
// ─────────────────────────────────────────────────────────────────
async function getDistinctGrades(examType) {
  const { data, error } = await supabase
    .from('questions')
    .select('grade')
    .eq('exam_type', examType)
    .not('grade', 'is', null);

  if (error) {
    console.error('[exam-coverage.js] 급수 목록 조회 실패:', examType, error.message);
    return [];
  }

  const grades = [...new Set((data || []).map(r => String(r.grade)))];
  grades.sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  return grades;
}

// ─────────────────────────────────────────────────────────────────
// [FIX-YEAR-RANGE-1] 최소/최대 연도를 order()+limit(1) 2회 조회로 구하던
// 방식을 제거했습니다. exam_date 컬럼에 형식이 섞여 있거나(YYYYMMDD 정수 /
// 연도만 있는 값 등) NULL이 아닌 이상값이 섞여 있으면, DB 정렬 순서가
// toYear()가 해석하는 "연도" 순서와 어긋나 최소/최대가 뒤바뀌거나(예:
// 청소년상담사에서 "2022~2021년"처럼 min>max로 표시) 최신 연도(예: 2026)가
// 누락되는 문제가 있었습니다.
// 이제 exam_date 전체를 한 번에 조회한 뒤, years.js의 extractYears와 동일한
// toYear() 파서로 정규화하고 JS에서 직접 최소/최대를 계산합니다 — DB 컬럼의
// 실제 저장 형식/정렬 순서에 의존하지 않으므로 더 안전합니다.
// ─────────────────────────────────────────────────────────────────
async function getYearRange(examType, grade) {
  let q = supabase.from('questions').select('exam_date').eq('exam_type', examType).not('exam_date', 'is', null);
  if (grade) q = q.eq('grade', grade);

  const { data, error } = await q;
  if (error) {
    console.error('[exam-coverage.js] 연도 범위 조회 실패:', examType, grade || '(전체 급수)', error.message);
    return { minYear: null, maxYear: null };
  }

  const years = (data || [])
    .map(row => toYear(row.exam_date))
    .filter(Boolean)
    .map(Number);

  if (!years.length) return { minYear: null, maxYear: null };

  return { minYear: String(Math.min(...years)), maxYear: String(Math.max(...years)) };
}

function sameRange(a, b) {
  return a.minYear === b.minYear && a.maxYear === b.maxYear;
}

// ─────────────────────────────────────────────────────────────────
// 급수 통합 값 + 급수별 값 + uniform 여부를 모두 계산합니다.
// ─────────────────────────────────────────────────────────────────
async function buildCoverageInfo(examType, grades) {
  const combined = await getYearRange(examType, null);

  const perGrade = {};
  await Promise.all(grades.map(async g => {
    perGrade[g] = await getYearRange(examType, g);
  }));

  const uniform = grades.every(g => sameRange(perGrade[g], combined));

  return { combined, perGrade, uniform };
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

  try {
    const result = {};
    for (const examType of VALID_EXAM_TYPES) {
      const grades = await getDistinctGrades(examType);
      const all    = await buildCoverageInfo(examType, grades);
      result[examType] = { grades, all };
    }

    console.log('[exam-coverage.js] 응답:', JSON.stringify(result));
    return res.status(200).json(result);
  } catch (error) {
    console.error('[exam-coverage.js] 오류:', error.message);
    return res.status(500).json({ message: error.message });
  }
}
