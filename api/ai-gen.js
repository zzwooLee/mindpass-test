// api/ai-gen.js
// ─────────────────────────────────────────────────────────────────
// 수정 이력
// [MULTI-CERT-1] 자격증별(exam_type) 구독 지원
//                변경 전: users.user_status 하나로 premium/admin만 확인
//                변경 후: user_subscriptions(user_id, exam_type)에서 해당
//                자격증의 premium 여부를 확인. admin은 여전히 전 자격증 우회.
//                기출 패턴 조회 쿼리에도 exam_type 필터를 추가했습니다.
// [SEC-1] JWT 인증 + 등급 검증 추가
//         변경 전: 인증 검사가 전혀 없어 로그인 없이 누구나 직접 호출 가능
//                  → GEMINI_API_KEY 남용(비용 유출) 및 무단 문제 생성 위험
//         변경 후: questions.js/years.js와 동일한 패턴으로 Authorization
//                  헤더의 Bearer 토큰을 Supabase로 검증하고, premium/admin
//                  등급만 호출을 허용합니다.
// [FIX-1]  Claude → Gemini API로 전환 (CLAUDE_API_KEY → GEMINI_API_KEY)
//          모델: gemini-3.6-flash. interview.js의 admin-generate-feedback
//          액션과 동일한 Gemini 인프라를 사용합니다.
// [FIX-2]  환경변수 누락 / 응답 파싱 실패에 대한 방어 로직 추가
// ─────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-3.6-flash';
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const VALID_EXAM_TYPES = ['clinical_psych', 'youth_counselor'];

// ─────────────────────────────────────────────────────────────────
// JWT 검증 헬퍼 (questions.js / years.js와 동일한 패턴)
// ─────────────────────────────────────────────────────────────────
async function verifyUser(req, examType) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.split(' ')[1];

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      console.warn('[ai-gen.js] JWT 검증 실패:', authError?.message);
      return null;
    }

    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('user_status')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      console.warn('[ai-gen.js] users 조회 실패:', profileError?.message);
      return null;
    }

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
      console.warn('[ai-gen.js] user_subscriptions 조회 실패:', subError.message);
      return { id: user.id, user_status: 'free' };
    }

    let status = sub?.status || 'free';
    if (status === 'premium' && sub?.expiry_date && new Date(sub.expiry_date) < new Date()) {
      status = 'free';
      const { error: downgradeErr } = await supabase
        .from('user_subscriptions')
        .update({ status: 'free' })
        .eq('user_id', user.id)
        .eq('exam_type', examType);
      if (downgradeErr) {
        console.error('[ai-gen.js] premium 만료 처리 DB 업데이트 실패:', downgradeErr.message);
      }
    }

    return { id: user.id, user_status: status };
  } catch (e) {
    console.warn('[ai-gen.js] verifyUser 예외:', e.message);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || !GEMINI_API_KEY) {
    console.error('[ai-gen.js] 환경변수 누락 (SUPABASE_URL / SUPABASE_KEY / GEMINI_API_KEY)');
    return res.status(500).json({ message: '서버 설정 오류입니다. 관리자에게 문의해주세요.' });
  }

  const { grade, category, examType } = req.body || {};

  // [MULTI-CERT-1] examType 필수 검증
  if (!examType || !VALID_EXAM_TYPES.includes(examType)) {
    return res.status(400).json({ message: `examType은 ${VALID_EXAM_TYPES.join(', ')} 중 하나여야 합니다.` });
  }
  if (!grade || !category) {
    return res.status(400).json({ message: 'grade와 category를 모두 입력해주세요.' });
  }

  // [SEC-1] 인증 + 등급 검증 — premium/admin만 호출 가능
  const verified = await verifyUser(req, examType);
  if (!verified) {
    return res.status(401).json({ message: '세션이 만료되었습니다. 다시 로그인해주세요.' });
  }
  if (verified.user_status === 'free') {
    return res.status(403).json({ message: 'AI 예상 문제 생성은 프리미엄 전용 기능입니다.' });
  }

  try {
    // 1. 패턴 분석용 기출 데이터 가져오기 (Supabase) — 자격증 필터 포함
    const patternUrl = `${SUPABASE_URL}/rest/v1/questions?exam_type=eq.${encodeURIComponent(examType)}&grade=eq.${encodeURIComponent(grade)}&category=eq.${encodeURIComponent(category)}&limit=5`;
    const patternRes = await fetch(patternUrl, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    if (!patternRes.ok) {
      const errText = await patternRes.text();
      console.error('[ai-gen.js] 기출 데이터 조회 실패:', patternRes.status, errText);
      return res.status(502).json({ message: '기출 데이터 조회에 실패했습니다.' });
    }
    const sampleData = await patternRes.json();

    // 2. Gemini 프롬프트 구성 (기존 .gs 파일의 프롬프트 자산 활용)
    const examLabel = examType === 'youth_counselor' ? '청소년상담사' : '임상심리사';
    const prompt = `당신은 ${examLabel} 국가고시 출제위원입니다.
    제시된 기출문제 패턴을 분석하여 실제 시험과 유사한 새로운 문제를 3개 생성하세요.
    패턴 데이터: ${JSON.stringify(sampleData)}

    응답은 반드시 아래 JSON 배열 형식으로만 답변하세요:
    [
      { "stem": "상황설명(있을경우)", "question": "문제", "choice1": "보기1", "choice2": "보기2", "choice3": "보기3", "choice4": "보기4", "answer": 정답번호(1-4) }
    ]`;

    // 3. Gemini API 호출 (JSON 응답 형식 강제)
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
          generationConfig: { maxOutputTokens: 1500, responseMimeType: 'application/json' }
        })
      }
    );

    const result = await geminiRes.json();
    if (!geminiRes.ok) {
      console.error('[ai-gen.js] Gemini API 오류:', geminiRes.status, JSON.stringify(result));
      return res.status(502).json({ message: 'AI 문제 생성 요청이 실패했습니다.' });
    }

    const generatedText = result?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || null;
    if (!generatedText) {
      console.error('[ai-gen.js] Gemini 응답에 content가 없음:', JSON.stringify(result));
      return res.status(502).json({ message: 'AI 응답을 해석할 수 없습니다.' });
    }

    // JSON 데이터만 추출하여 파싱
    const jsonMatch = generatedText.match(/\[\s*\{[\s\S]*\}\s*\]/);
    let questions = [];
    if (jsonMatch) {
      try {
        questions = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        console.error('[ai-gen.js] JSON 파싱 실패:', parseErr.message, '/ raw:', generatedText);
        return res.status(502).json({ message: 'AI 응답 형식을 해석하지 못했습니다.' });
      }
    }

    return res.status(200).json(questions);
  } catch (error) {
    console.error('[ai-gen.js] 오류:', error.message);
    return res.status(500).json({ message: error.message });
  }
}
