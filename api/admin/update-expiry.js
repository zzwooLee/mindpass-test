// update-expiry.js
// ─────────────────────────────────────────────────────────────────
// 수정 이력
// [MULTI-CERT-1] user_subscriptions 기반으로 전환
//                변경 전: users.user_status/expiry_date를 직접 갱신
//                (자격증 구분 없음)
//                변경 후: examType을 받아 user_subscriptions(user_id, exam_type)를
//                upsert합니다. 이 엔드포인트는 프론트엔드에서 아직 호출하는
//                곳이 없는 예비 기능이지만, vercel.json 라우팅 수정으로
//                실제 호출이 가능해졌으므로 새 구독 모델과 일치시켜 둡니다.
// [SEC-1] requesterId를 body에서 받아 DB 조회하던 방식 제거
//         → Authorization 헤더 JWT 검증으로 교체 (admin.js와 동일한 패턴)
//         클라이언트가 requesterId를 위조해도 무효화됨
// [SEC-2] targetUserId 누락 / months 유효성 검사 추가
// [MULTI-CERT-6] user_subscriptions upsert 후 subscription_history에도
//                기록 (source: 'admin-update-expiry'). 만료 후에도 등록
//                이력이 남도록 하기 위함. 실패해도 기존 흐름은 막지 않음
//                (best-effort, 로그만 남김). 테이블: sql/subscription_history.sql
// ─────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const VALID_EXAM_TYPES = ['clinical_psych', 'youth_counselor', 'counselor_interview'];

// ─────────────────────────────────────────────────────────────────
// JWT 검증 헬퍼 (admin.js와 동일한 패턴)
// ─────────────────────────────────────────────────────────────────
async function verifyAdmin(req) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.split(' ')[1];

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      console.warn('[update-expiry.js] JWT 검증 실패:', error?.message);
      return null;
    }

    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('user_status')
      .eq('id', user.id)
      .single();

    if (profileError || !profile) {
      console.warn('[update-expiry.js] users 조회 실패:', profileError?.message);
      return null;
    }

    return { id: user.id, user_status: profile.user_status };
  } catch (e) {
    console.warn('[update-expiry.js] verifyAdmin 예외:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// 핸들러
// ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const requester = await verifyAdmin(req);
  if (!requester) {
    return res.status(401).json({ message: 'Unauthorized: 유효하지 않은 토큰입니다.' });
  }
  if (requester.user_status !== 'admin') {
    return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
  }

  const { targetUserId, months, examType } = req.body;

  if (!targetUserId) {
    return res.status(400).json({ message: 'targetUserId가 필요합니다.' });
  }
  if (!examType || !VALID_EXAM_TYPES.includes(examType)) {
    return res.status(400).json({ message: `examType은 ${VALID_EXAM_TYPES.join(', ')} 중 하나여야 합니다.` });
  }

  const parsedMonths = parseInt(months, 10);
  if (isNaN(parsedMonths) || parsedMonths < 1 || parsedMonths > 60) {
    return res.status(400).json({ message: 'months는 1~60 사이의 정수여야 합니다.' });
  }

  const expiry = new Date();
  expiry.setMonth(expiry.getMonth() + parsedMonths);

  try {
    // [MULTI-CERT-1] users 테이블이 아니라 해당 자격증의 구독 행을 upsert합니다.
    const { error } = await supabase
      .from('user_subscriptions')
      .upsert(
        [{ user_id: targetUserId, exam_type: examType, status: 'premium', expiry_date: expiry.toISOString() }],
        { onConflict: 'user_id,exam_type' }
      );

    if (error) throw error;

    // [MULTI-CERT-6] 등록 이력 기록 (best-effort, 실패해도 본 흐름은 계속 진행)
    const { error: historyError } = await supabase
      .from('subscription_history')
      .insert([{
        user_id    : targetUserId,
        exam_type  : examType,
        months     : parsedMonths,
        granted_at : new Date().toISOString(),
        expiry_date: expiry.toISOString(),
        source     : 'admin-update-expiry',
        granted_by : requester.id
      }]);
    if (historyError) {
      console.error('[update-expiry.js] subscription_history 기록 실패(무시하고 계속 진행):', historyError.message);
    }

    console.log(
      `[update-expiry.js] 구독 갱신 완료 — targetUserId: ${targetUserId}, examType: ${examType},`,
      `만료일: ${expiry.toISOString()}, 처리자: ${requester.id}`
    );

    return res.status(200).json({ message: '구독 갱신 완료' });
  } catch (e) {
    console.error('[update-expiry.js] 오류:', e.message);
    return res.status(500).json({ message: e.message });
  }
}
