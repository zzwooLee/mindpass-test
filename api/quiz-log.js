// quiz-log.js
// ─────────────────────────────────────────────────────────────────
// [QUIZ-ANALYTICS-1] 자격증 퀴즈 뱅크 참여 기록.
// common.js의 checkAnswer()가 수련생이 선택지를 고를 때마다(정답 확인 시점) 1건씩
// 이 엔드포인트로 보내 quiz_attempts 테이블에 쌓습니다. 화면에는 별도로 노출하지
// 않고, 추후 관리자가 학습 현황을 분석할 때 쓸 원본 데이터를 모으는 용도입니다.
// 채점은 questions.js가 아니라 클라이언트(common.js)에서 이뤄지므로, 정답 여부는
// 클라이언트가 계산한 값을 그대로 신뢰해 저장합니다(분석용 로그이지 응시 자격/문제
// 열람 권한 판단에는 쓰이지 않으므로 위변조 방지가 questions.js만큼 중요하지 않음).
// 기록 실패가 퀴즈 이용 자체를 막아서는 안 되므로, 클라이언트는 이 요청을
// fire-and-forget으로 보내고 실패해도 조용히 무시합니다.
// ─────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const VALID_EXAM_TYPES = ['clinical_psych', 'youth_counselor'];

async function verifyUser(req) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      console.warn('[quiz-log.js] JWT 검증 실패:', error?.message);
      return null;
    }
    return { id: user.id };
  } catch (e) {
    console.warn('[quiz-log.js] verifyUser 예외:', e.message);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');

  const verified = await verifyUser(req);
  if (!verified) {
    return res.status(401).json({ message: '세션이 만료되었습니다. 다시 로그인해주세요.' });
  }

  const { examType, questionId, grade, category, examDate, selectedChoice, correctChoice } = req.body || {};

  if (!examType || !VALID_EXAM_TYPES.includes(examType)) {
    return res.status(400).json({ message: `examType은 ${VALID_EXAM_TYPES.join(', ')} 중 하나여야 합니다.` });
  }

  const sel = parseInt(selectedChoice, 10);
  const correct = parseInt(correctChoice, 10);
  if (![1, 2, 3, 4].includes(sel) || ![1, 2, 3, 4].includes(correct)) {
    return res.status(400).json({ message: '선택지 값이 올바르지 않습니다.' });
  }

  let examDateInt = null;
  if (examDate !== undefined && examDate !== null && String(examDate).trim() !== '') {
    const d = parseInt(examDate, 10);
    if (!isNaN(d)) examDateInt = d;
  }

  try {
    const { error } = await supabase.from('quiz_attempts').insert({
      user_id: verified.id,
      exam_type: examType,
      // [QUIZ-ANALYTICS-1] questions.id의 실제 타입(uuid/정수 등)에 상관없이 안전하게
      // 저장하기 위해 문자열로 보관합니다 — 이 로그 테이블은 참조 무결성 제약을 걸지
      // 않아, 원본 문제가 나중에 수정/삭제돼도 기록 자체는 그대로 남습니다.
      question_id: (questionId !== undefined && questionId !== null) ? String(questionId) : null,
      grade: grade || null,
      category: category || null,
      exam_date: examDateInt,
      selected_choice: sel,
      correct_choice: correct,
      is_correct: sel === correct
    });
    if (error) throw error;
    return res.status(200).json({ message: 'ok' });
  } catch (e) {
    console.error('[quiz-log.js] 기록 실패:', e.message);
    return res.status(500).json({ message: '기록에 실패했습니다.' });
  }
}
