// admin.js
// ─────────────────────────────────────────────────────────────────
// 수정 이력
// [MULTI-CERT-1] 자격증별(exam_type) 구독 관리로 구조 변경
//                변경 전: update-user 액션 하나로 users.user_status(free/
//                premium/admin)와 expiry_date를 동시에 관리
//                변경 후: 사이트 전체 관리자 권한(admin)과 자격증별 구독
//                (free/premium)을 분리했습니다.
//                · set-admin      — users.user_status를 admin/free로 전환
//                · update-subscription — user_subscriptions(user_id, exam_type)
//                  행을 upsert하여 특정 자격증의 등급/만료일만 변경
//                stats/verify-stats/users 응답도 자격증별로 분리해 반환합니다.
//                이 변경은 common.js/premium.html 관리자 패널과 함께
//                반영되어야 화면에서 정상 동작합니다.
// [FIX-1] update-user: newStatus 허용값 검증 추가 (free/premium/admin 외 차단) 유지
// [FIX-2] delete-user: Auth 삭제 실패 시 경고 로그 유지
// [FIX-3] newStatus 검증 조건과 updateData 적용 조건 불일치 수정
//         기존: 검증은 !== undefined/null/'' 로, 적용은 if (newStatus) falsy 체크로 달리 처리
//         수정: typeof string && trim() !== '' 로 통일 → 논리적 일관성 확보
// [FIX-4] stats action: activeUsers 변수명 → totalUsers 로 변경 (실제 의미와 일치)
// [MULTI-CERT-6] 프리미엄 등록 이력(subscription_history) 도입
//                user_subscriptions는 만료되면 free로 덮어써져 과거 기록이
//                사라지는 문제가 있었습니다. update-subscription에서 premium을
//                부여할 때(그리고 slack-action.js 자동 승인, admin/update-expiry.js
//                수동 연장에서도) subscription_history에 로그를 한 줄씩 추가하고,
//                이 파일의 새 'subscription-history' 액션으로 관리자가 조회할 수
//                있습니다. 테이블 생성은 sql/subscription_history.sql 참고
//                (Supabase SQL Editor에서 직접 실행 필요).
// [SETTINGS-1] 문의 이메일을 관리자 화면에서 직접 수정할 수 있도록
//              'get-settings'/'update-settings' 액션 추가. app_settings
//              key/value 테이블에 저장하며, 값이 없으면 기존처럼
//              process.env.ADMIN_EMAIL로 폴백합니다.
//              (테이블 생성: sql/app_settings.sql, Supabase SQL Editor에서 실행)

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { archiveFreeTrialPracticeSessions, removeUserFromLiveTeamOnCoachingDowngrade, COACHING_PROMO_BANNER_TEXT_DEFAULT } from './_interview/shared.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// [TEAM-MGMT] counselor_interview(전문상담사 면접)는 개인별 구독
// (update-subscription) 대상에서 제외되었습니다. 이제 팀 배정으로만
// 이용 여부가 결정됩니다 — api/interview.js의 admin-team-* 액션 참고.
const VALID_EXAM_TYPES     = ['clinical_psych', 'youth_counselor', 'coaching_interview'];
const QUESTION_EXAM_TYPES  = ['clinical_psych', 'youth_counselor'];

// ─────────────────────────────────────────────────────────────────
// JWT 검증 헬퍼 — 사이트 전체 관리자 권한은 자격증과 무관합니다.
// ─────────────────────────────────────────────────────────────────
async function verifyUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.split(' ')[1];

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;

  const { data: profile, error: profileError } = await supabase
    .from('users')
    .select('user_status')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) return null;

  return { id: user.id, user_status: profile.user_status };
}

// ─────────────────────────────────────────────────────────────────
// 허용된 상태값 목록 — 서버에서 강제 검증
// ─────────────────────────────────────────────────────────────────
const VALID_SUB_STATUSES = ['free', 'premium'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const { action } = req.query;

  const requester = await verifyUser(req);
  if (!requester) {
    return res.status(401).json({ message: 'Unauthorized: 유효하지 않은 토큰입니다.' });
  }
  if (requester.user_status !== 'admin') {
    return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
  }

  const { targetUserId, examType, newStatus, expiryDate, isAdmin, questionId, is_verified, contactEmail, bankName, bankAccountNumber, bankAccountHolder, coachingCourseSchedule, coachingPromoBannerText } = req.body;

  try {
    switch (action) {

      case 'stats': {
        // [MULTI-CERT-1] 자격증별 문제 수 / 프리미엄 구독자 수를 따로 집계합니다.
        // [MULTI-CERT-2] counselor_interview는 questions 테이블이 없으므로
        // totalQuestions는 null로 두고(프론트에서 해당 카드는 숨김), premiumUsers만 집계합니다.
        const byExamType = {};
        for (const et of VALID_EXAM_TYPES) {
          let totalQuestions = null;
          if (QUESTION_EXAM_TYPES.includes(et)) {
            const { count } = await supabase
              .from('questions')
              .select('*', { count: 'exact', head: true })
              .eq('exam_type', et);
            totalQuestions = count || 0;
          }

          const { count: premiumSubs } = await supabase
            .from('user_subscriptions')
            .select('*', { count: 'exact', head: true })
            .eq('exam_type', et)
            .eq('status', 'premium');

          byExamType[et] = { totalQuestions, premiumUsers: premiumSubs || 0 };
        }

        // [FIX-4] 변수명을 totalUsers로 변경 — users 테이블 전체 카운트임을 명확히 합니다.
        const { count: totalUsers } = await supabase
          .from('users')
          .select('*', { count: 'exact', head: true });

        return res.status(200).json({ totalUsers: totalUsers || 0, byExamType });
      }

      case 'users': {
        const { data: users, error } = await supabase
          .from('users')
          .select('*')
          .order('created_at', { ascending: false });
        if (error) throw error;

        // [MULTI-CERT-1] 자격증별 구독 정보를 유저별로 붙여서 반환합니다.
        const { data: subs, error: subsError } = await supabase
          .from('user_subscriptions')
          .select('user_id, exam_type, status, expiry_date');
        if (subsError) throw subsError;

        const subsByUser = {};
        for (const s of subs || []) {
          if (!subsByUser[s.user_id]) subsByUser[s.user_id] = {};
          subsByUser[s.user_id][s.exam_type] = { status: s.status, expiry_date: s.expiry_date };
        }

        // [COACHING-FLAG] "코칭면접코스" 열은 이제 clinical_psych/youth_counselor와
        // 동일한 user_subscriptions 기반 FREE/PREMIUM 토글로 관리되므로(위
        // subsByUser에 exam_type='coaching_interview' 행도 함께 포함됩니다),
        // 팀 배정을 직접 조회해서 읽기 전용으로 계산해주던 이전 블록은 더 이상
        // 필요하지 않아 제거했습니다. AI 면접 코스/코칭 면접 코스의 팀 배정
        // 현황은 "팀 관리" 탭에서 확인합니다.
        const merged = (users || []).map(u => ({
          ...u,
          subscriptions: subsByUser[u.id] || {}
        }));

        return res.status(200).json(merged);
      }

      // [MULTI-CERT-1] 사이트 전체 관리자 권한 전환 — 자격증과 무관합니다.
      case 'set-admin': {
        if (!targetUserId) {
          return res.status(400).json({ message: 'targetUserId가 필요합니다.' });
        }
        if (typeof isAdmin !== 'boolean') {
          return res.status(400).json({ message: 'isAdmin(boolean)이 필요합니다.' });
        }

        const { error } = await supabase
          .from('users')
          .update({ user_status: isAdmin ? 'admin' : 'free' })
          .eq('id', targetUserId);
        if (error) throw error;

        return res.status(200).json({ message: isAdmin ? '관리자로 지정되었습니다.' : '관리자 권한이 해제되었습니다.' });
      }

      // [MULTI-CERT-1] 자격증별 구독(등급/만료일) 변경 — update-user를 대체합니다.
      case 'update-subscription': {
        if (!targetUserId) {
          return res.status(400).json({ message: 'targetUserId가 필요합니다.' });
        }
        if (!examType || !VALID_EXAM_TYPES.includes(examType)) {
          return res.status(400).json({ message: `examType은 ${VALID_EXAM_TYPES.join(', ')} 중 하나여야 합니다.` });
        }

        // 기존 행이 있으면 부분 업데이트하듯 병합합니다 (예: 날짜만 바꾸는 경우).
        const { data: existing } = await supabase
          .from('user_subscriptions')
          .select('status, expiry_date')
          .eq('user_id', targetUserId)
          .eq('exam_type', examType)
          .maybeSingle();

        const upsertData = {
          user_id    : targetUserId,
          exam_type  : examType,
          status     : existing?.status || 'free',
          expiry_date: existing?.expiry_date || null
        };

        // [COACHING-FLAG-SYNC] 관리자가 이번 요청에서 "명시적으로" free로 바꿨는지
        // 표시해둡니다 — 이미 free였던 행을 다른 이유(날짜만 수정 등)로 건드린
        // 경우까지 팀에서 제외해버리면 과합니다.
        let explicitlySetToFree = false;

        if (typeof newStatus === 'string' && newStatus.trim() !== '') {
          const normalizedStatus = newStatus.trim().toLowerCase();
          if (!VALID_SUB_STATUSES.includes(normalizedStatus)) {
            return res.status(400).json({
              message: `유효하지 않은 상태값입니다. 허용값: ${VALID_SUB_STATUSES.join(', ')}`
            });
          }
          upsertData.status = normalizedStatus;
          if (normalizedStatus === 'free') {
            upsertData.expiry_date = null;
            explicitlySetToFree = true;
          }
        }

        if (expiryDate) upsertData.expiry_date = expiryDate;

        const { error } = await supabase
          .from('user_subscriptions')
          .upsert([upsertData], { onConflict: 'user_id,exam_type' });
        if (error) throw error;

        // [MULTI-CERT-6] 관리자가 수동으로 premium을 부여/연장한 경우도 이력에
        // 남깁니다. free로 바꾸는 경우는 "부여"가 아니라 "회수"이므로 기록하지
        // 않습니다(이력 테이블은 "언제 프리미엄이 됐는지"만 남기는 로그입니다).
        if (upsertData.status === 'premium') {
          const { error: historyError } = await supabase
            .from('subscription_history')
            .insert([{
              user_id    : targetUserId,
              exam_type  : examType,
              months     : null, // 관리자가 상태만 바꾼 경우 개월 수 정보가 없음
              granted_at : new Date().toISOString(),
              expiry_date: upsertData.expiry_date,
              source     : 'admin-manual',
              granted_by : requester.id
            }]);
          if (historyError) {
            console.error('[admin.js] subscription_history 기록 실패(무시하고 계속 진행):', historyError.message);
          }

          // [FREE-TRIAL-ARCHIVE] 코칭면접코스를 수동으로 Premium 전환한 경우도
          // 팀 배정 때와 동일하게, 이전 Free 체험판 시절 AI자율연습 기록을
          // "연습 기록"에서 보이지 않도록 정리합니다. (다른 exam_type은 해당 없음)
          if (examType === 'coaching_interview') {
            await archiveFreeTrialPracticeSessions(targetUserId);
          }
        } else if (examType === 'coaching_interview' && explicitlySetToFree) {
          // [COACHING-FLAG-SYNC] 코칭면접코스를 수동으로 Free로 되돌린 경우,
          // 소속된 코칭(실시간) 팀에서도 함께 제외합니다.
          await removeUserFromLiveTeamOnCoachingDowngrade(targetUserId);
        }

        return res.status(200).json({ message: '변경 사항이 저장되었습니다.' });
      }

      case 'delete-user': {
        if (!targetUserId) {
          return res.status(400).json({ message: 'targetUserId가 필요합니다.' });
        }

        // 1) users 테이블에서 삭제 — user_subscriptions는 FK on delete cascade로 함께 삭제됩니다.
        const { error: dbError } = await supabase
          .from('users')
          .delete()
          .eq('id', targetUserId);
        if (dbError) throw dbError;

        // 2) Supabase Auth 계정 삭제 (Service Role 키 필요)
        // [FIX-2] Auth 삭제 실패 시 경고 로그 기록 후 200 반환
        const { error: authError } = await supabase.auth.admin.deleteUser(targetUserId);
        if (authError) {
          console.error(
            '[admin.js] Auth 계정 삭제 실패 — Supabase 대시보드에서 수동 정리 필요:',
            authError.message,
            '/ targetUserId:', targetUserId
          );
        } else {
          console.log('[admin.js] Auth 계정 삭제 완료:', targetUserId);
        }

        return res.status(200).json({ message: '사용자가 삭제되었습니다.' });
      }

      case 'update-question': {
        if (!questionId) {
          return res.status(400).json({ message: 'questionId가 필요합니다.' });
        }

        const { error } = await supabase
          .from('questions')
          .update({ is_verified })
          .eq('id', questionId);
        if (error) throw error;

        return res.status(200).json({ message: '문제 검수 상태가 업데이트되었습니다.' });
      }

      case 'verify-stats': {
        // [MULTI-CERT-1] 자격증별 검수 현황을 분리해서 반환합니다.
        // [MULTI-CERT-2] counselor_interview는 questions 테이블 기반 검수 대상이 아니므로 제외합니다.
        const byExamType = {};
        for (const et of QUESTION_EXAM_TYPES) {
          const { count: verified } = await supabase
            .from('questions')
            .select('*', { count: 'exact', head: true })
            .eq('exam_type', et)
            .eq('is_verified', true);
          const { count: unverified } = await supabase
            .from('questions')
            .select('*', { count: 'exact', head: true })
            .eq('exam_type', et)
            .eq('is_verified', false);
          byExamType[et] = { verified: verified || 0, unverified: unverified || 0 };
        }

        return res.status(200).json({ byExamType });
      }

      // [MULTI-CERT-6] 프리미엄 등록 이력 조회 — subscription_history는
      // user_subscriptions와 달리 만료/다운그레이드로 값이 덮어써지지 않는
      // 순수 로그 테이블입니다. 최근 500건을 유저 이름/이메일과 함께 반환합니다.
      case 'subscription-history': {
        const { data: history, error } = await supabase
          .from('subscription_history')
          .select('*')
          .order('granted_at', { ascending: false })
          .limit(500);
        if (error) throw error;

        const userIds = [...new Set((history || []).map(h => h.user_id))];
        const { data: users, error: usersError } = userIds.length
          ? await supabase.from('users').select('id, name, email').in('id', userIds)
          : { data: [], error: null };
        if (usersError) throw usersError;

        const userMap = new Map((users || []).map(u => [u.id, u]));
        const merged = (history || []).map(h => ({
          ...h,
          user_name : userMap.get(h.user_id)?.name  || null,
          user_email: userMap.get(h.user_id)?.email || null
        }));

        return res.status(200).json(merged);
      }

      // [SETTINGS-1] 운영 설정(현재는 문의 이메일 하나) 조회.
      // app_settings에 값이 없으면(아직 관리자가 설정한 적 없음) 기존처럼
      // 환경변수 ADMIN_EMAIL로 폴백해 프론트가 항상 값을 받을 수 있게 합니다.
      case 'get-settings': {
        // [BANK-ACCOUNT-INFO] 문의 이메일과 함께 코칭 면접 코스 입금 안내용
        // 은행계좌 정보(은행명/계좌번호/예금주)도 같이 조회합니다.
        // [COACHING-COURSE-SCHEDULE] 코칭 면접 코스 개설 일정(급수별, 중복 가능)도 함께 조회합니다.
        // [COACHING-PROMO-BANNER] 홈/퀴즈뱅크/모의면접 상단 배너 문구도 같이 조회합니다.
        const { data, error } = await supabase
          .from('app_settings')
          .select('key, value')
          .in('key', ['contact_email', 'bank_name', 'bank_account_number', 'bank_account_holder', 'coaching_course_schedule', 'coaching_promo_banner_text']);
        if (error) throw error;

        const settingsMap = {};
        (data || []).forEach(r => { settingsMap[r.key] = r.value; });

        let coachingCourseScheduleOut = [];
        if (settingsMap.coaching_course_schedule) {
          try {
            const parsed = JSON.parse(settingsMap.coaching_course_schedule);
            if (Array.isArray(parsed)) coachingCourseScheduleOut = parsed;
          } catch (e) {
            console.warn('[admin.js] coaching_course_schedule 파싱 실패:', e.message);
          }
        }

        return res.status(200).json({
          contactEmail: settingsMap.contact_email || process.env.ADMIN_EMAIL || '',
          bankName: settingsMap.bank_name || '',
          bankAccountNumber: settingsMap.bank_account_number || '',
          bankAccountHolder: settingsMap.bank_account_holder || '',
          coachingCourseSchedule: coachingCourseScheduleOut,
          coachingPromoBannerText: settingsMap.coaching_promo_banner_text || COACHING_PROMO_BANNER_TEXT_DEFAULT
        });
      }

      // [SETTINGS-1] 문의 이메일 변경 — app_settings에 upsert합니다.
      case 'update-settings': {
        // [BANK-ACCOUNT-INFO] 문의 이메일 카드와 은행계좌 정보 카드가 화면에서
        // 분리되어 있어, 각자 자신에게 해당하는 필드만 보내도록 부분 업데이트로
        // 처리합니다(요청에 없는 필드는 값을 건드리지 않음).
        const settingsRows = [];

        if (contactEmail !== undefined) {
          const trimmed = typeof contactEmail === 'string' ? contactEmail.trim() : '';
          if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
            return res.status(400).json({ message: '올바른 이메일 주소를 입력해주세요.' });
          }
          settingsRows.push({ key: 'contact_email', value: trimmed, updated_at: new Date().toISOString(), updated_by: requester.id });
        }

        if (bankName !== undefined || bankAccountNumber !== undefined || bankAccountHolder !== undefined) {
          const trimmedBankName   = typeof bankName === 'string' ? bankName.trim() : '';
          const trimmedBankNumber = typeof bankAccountNumber === 'string' ? bankAccountNumber.trim() : '';
          const trimmedBankHolder = typeof bankAccountHolder === 'string' ? bankAccountHolder.trim() : '';
          if (!trimmedBankName || !trimmedBankNumber || !trimmedBankHolder) {
            return res.status(400).json({ message: '은행명·계좌번호·예금주를 모두 입력해주세요.' });
          }
          const nowIso = new Date().toISOString();
          settingsRows.push(
            { key: 'bank_name', value: trimmedBankName, updated_at: nowIso, updated_by: requester.id },
            { key: 'bank_account_number', value: trimmedBankNumber, updated_at: nowIso, updated_by: requester.id },
            { key: 'bank_account_holder', value: trimmedBankHolder, updated_at: nowIso, updated_by: requester.id }
          );
        }

        // [COACHING-COURSE-SCHEDULE] 코칭 면접 코스 개설 일정 — 급수별로 여러 건, 기간이
        // 겹치는 중복 개설도 허용합니다. app_settings에는 JSON 배열 문자열로 저장합니다.
        let sanitizedCoachingCourseSchedule = null;
        if (coachingCourseSchedule !== undefined) {
          if (!Array.isArray(coachingCourseSchedule)) {
            return res.status(400).json({ message: '코칭 면접 코스 일정 형식이 올바르지 않습니다.' });
          }
          sanitizedCoachingCourseSchedule = [];
          for (let idx = 0; idx < coachingCourseSchedule.length; idx++) {
            const entry = coachingCourseSchedule[idx];
            const grade = entry && (entry.grade === '1' || entry.grade === '2') ? entry.grade : null;
            const startDate = entry && typeof entry.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.startDate) ? entry.startDate : null;
            if (!grade || !startDate) {
              return res.status(400).json({ message: `코칭 면접 코스 일정 ${idx + 1}번째 항목의 급수/시작일을 확인해주세요.` });
            }
            const endDate = entry && typeof entry.endDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.endDate) ? entry.endDate : '';
            // [COACHING-SCHEDULE-TIME] 회차 진행 시작/종료 시각(HH:MM, 24시간제) — 선택 입력입니다.
            const startTime = entry && typeof entry.startTime === 'string' && /^\d{2}:\d{2}$/.test(entry.startTime) ? entry.startTime : '';
            const endTime = entry && typeof entry.endTime === 'string' && /^\d{2}:\d{2}$/.test(entry.endTime) ? entry.endTime : '';
            const note = entry && typeof entry.note === 'string' ? entry.note.trim().slice(0, 200) : '';
            const capacity = entry && Number.isFinite(Number(entry.capacity)) && Number(entry.capacity) > 0 ? Math.floor(Number(entry.capacity)) : null;
            const id = entry && typeof entry.id === 'string' && entry.id ? entry.id : randomUUID();
            sanitizedCoachingCourseSchedule.push({ id, grade, startDate, endDate, startTime, endTime, note, capacity });
          }
          settingsRows.push({
            key: 'coaching_course_schedule',
            value: JSON.stringify(sanitizedCoachingCourseSchedule),
            updated_at: new Date().toISOString(),
            updated_by: requester.id
          });
        }

        // [COACHING-PROMO-BANNER] 홈/퀴즈뱅크/모의면접 상단 배너 문구 저장.
        if (coachingPromoBannerText !== undefined) {
          const trimmed = typeof coachingPromoBannerText === 'string' ? coachingPromoBannerText.trim() : '';
          if (!trimmed) {
            return res.status(400).json({ message: '배너 문구를 입력해주세요.' });
          }
          if (trimmed.length > 300) {
            return res.status(400).json({ message: '배너 문구는 300자 이내로 입력해주세요.' });
          }
          settingsRows.push({ key: 'coaching_promo_banner_text', value: trimmed, updated_at: new Date().toISOString(), updated_by: requester.id });
        }

        if (settingsRows.length === 0) {
          return res.status(400).json({ message: '저장할 항목이 없습니다.' });
        }

        const { error } = await supabase
          .from('app_settings')
          .upsert(settingsRows, { onConflict: 'key' });
        if (error) throw error;

        console.log(`[admin.js] 운영 설정 변경 — ${settingsRows.map(r => r.key).join(', ')} (처리자: ${requester.id})`);
        const responseBody = { message: '저장되었습니다.' };
        if (sanitizedCoachingCourseSchedule !== null) responseBody.coachingCourseSchedule = sanitizedCoachingCourseSchedule;
        return res.status(200).json(responseBody);
      }

      default:
        return res.status(400).json({ message: '알 수 없는 액션입니다.' });
    }
  } catch (error) {
    console.error(`[admin.js] action=${action}`, error.message);
    return res.status(500).json({ message: error.message });
  }
}
