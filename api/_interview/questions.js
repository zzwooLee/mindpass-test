import {
  supabase,
  getContactEmail,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  VALID_QUESTION_CATS,
  CAT_LABEL_BY_KEY,
  catLabelFor,
  VALID_USAGE_SCOPES,
  callGemini,
  sanitizeAiDraftText,
  generateFeedbackForAnswer,
  AUTO_FEEDBACK_DEFAULTS,
  AUTO_FEEDBACK_KEYS,
  getAutoFeedbackFlags,
  AUTO_FEEDBACK_FLAG_KEY_BY_CAT,
  autoAttachFeedback,
  SCHEDULE_MIN_INTERVAL_KEY,
  SCHEDULE_MIN_INTERVAL_DEFAULT,
  getScheduleMinIntervalDays,
  generateDraftModelAnswer,
  AUTO_DRAFT_DEFAULTS,
  AUTO_DRAFT_KEYS,
  getAutoDraftFlags,
  AUTO_DRAFT_CASE_THEORY_LIMIT,
  getTodayRangeKST,
  PRACTICE_TIME_DEFAULTS,
  PRACTICE_TIME_KEYS,
  getPracticeTimeSettings,
  getPracticeCatsUsedToday,
  getPremiumCasePoolQuestionIdsByCat,
  getPremiumCaseUsageCounts,
  getPremiumUsesPerCase,
  getNextSeqNo,
  verifyUser,
  getActiveMembership,
  getPracticeOnlyAccess,
  getInterviewAccess,
  todayKstDateString,
  getActiveTeamId,
  getUserGrade,
  assignUserToTeam,
  sendEmail,
  sendTeamAssignmentEmail,
  sendScheduleReminderEmail,
  parseCsv,
  CAT_LABEL_MAP,
  upsertQuestionRows,
  upsertCaseModelAnswerRows
} from './shared.js';

    // ────────────────────────────────────────────────
    // [QBANK-DB] 질문은행 — 현재 공개된 질문 목록 (회원 누구나 열람 가능)
    // ────────────────────────────────────────────────

export async function bank(req, res, requester) {
      // [QBANK-USAGE-SCOPE] AI 자율연습용(practice)으로 지정된 문제만 노출합니다.
      // AI 면접 코스용(team) 문제는 여기 섞이지 않고 AI 면접 코스 탭에서만 볼 수 있습니다.
      // [SUPERVISION-GRADE-GATE] 수퍼비전은 1급 평가영역이라 1급 소속 수련생(과 관리자)
      // 에게만 노출합니다. 2급 수련생에게는 아예 문제 목록에서 제외해, 문제 문구 자체가
      // 클라이언트로 내려가지 않도록 서버 단계에서 막습니다.
      let allowedCats = ['case', 'ethics', 'supervision'];
      let restrictToDefaultCase = false;
      let restrictToPremiumPool = false;
      if (requester.user_status !== 'admin') {
        const grade = await getUserGrade(requester.id);
        if (grade !== '1') allowedCats = ['case', 'ethics'];
        // [FREE-TRIAL-DEFAULT-CASE] Free 회원(승인 전)은 관리자가 지정한 기본 사례
        // (사례개념화·상담윤리 각 1개, 급수 구분 없음)만 받습니다 — 전체 문제은행은
        // 이용 승인 후에만 노출됩니다.
        const access = await getInterviewAccess(requester.id, requester.user_status);
        if (access === 'free') {
          allowedCats = ['case', 'ethics'];
          restrictToDefaultCase = true;
        } else if (access === 'premium') {
          // [PREMIUM-CASE-POOL] Premium 회원은 사례개념화·상담윤리에 한해 관리자가
          // 지정한 풀 크기(기본 10개)·사례당 사용 횟수(기본 5회) 제한을 받습니다.
          // 수퍼비전은 이 제한과 무관합니다.
          restrictToPremiumPool = true;
        }
      }

      let bankQuery = supabase
        .from('interview_questions')
        .select('id, cat, cat_label, question, tips, seq_no, topic, model_answer, model_answer_status, is_default_case')
        .eq('is_active', true)
        .eq('usage_scope', 'practice')
        .in('cat', allowedCats)
        .lte('release_at', new Date().toISOString())
        .order('created_at', { ascending: true });
      if (restrictToDefaultCase) bankQuery = bankQuery.eq('is_default_case', true);
      const { data, error } = await bankQuery;

      if (error) throw error;

      // [AI-FEEDBACK] 사례개념화 문제에는 등록된 상담이론 "이름"만 함께 내려줍니다.
      // 모범답안 본문은 절대 포함하지 않습니다 (정답 노출 방지 — 관리자 API에서만 다룹니다).
      // [AI-DRAFT-QUEUE] status='draft'(AI가 자동 생성했지만 관리자가 아직 승인하지
      // 않은) 이론은 여기서 제외합니다 — 수련생에게는 승인된 이론만 선택지로 보여줍니다.
      const caseIds = (data || []).filter(r => r.cat === 'case').map(r => r.id);
      let theoriesByQuestion = {};
      if (caseIds.length > 0) {
        const { data: theoryRows, error: theoryErr } = await supabase
          .from('interview_case_model_answers')
          .select('question_id, theory, status')
          .in('question_id', caseIds)
          .eq('status', 'approved');
        if (theoryErr) throw theoryErr;
        theoriesByQuestion = (theoryRows || []).reduce((acc, r) => {
          if (!acc[r.question_id]) acc[r.question_id] = [];
          acc[r.question_id].push(r.theory);
          return acc;
        }, {});
      }

      // [MODEL-ANSWER-REQUIRED] AI 자율연습 무작위 출제는 모범답안이 등록된 문제 중에서만
      // 뽑도록, "모범답안이 있는지" 여부만 boolean으로 함께 내려줍니다(내용 자체는 노출 안 함).
      // [AI-DRAFT-QUEUE] status='draft'인 모범답안은 승인 전이라 "없는 것"으로 취급합니다.
      let mapped = (data || []).map(r => ({
        id: r.id, cat: r.cat, catLabel: r.cat_label, q: r.question, tips: r.tips || [],
        seqNo: r.seq_no, topic: r.topic || null,
        isDefaultCase: !!r.is_default_case,
        theories: r.cat === 'case' ? (theoriesByQuestion[r.id] || []) : undefined,
        hasModelAnswer: r.cat === 'case'
          ? (theoriesByQuestion[r.id] || []).length > 0
          : !!(r.model_answer && r.model_answer.trim()) && r.model_answer_status !== 'draft'
      }));

      // [PREMIUM-CASE-POOL] Premium 회원은 사례개념화·상담윤리 문제를 관리자가 지정한
      // 풀(seq_no 오름차순 · 모범답안 등록분 중 앞에서부터 N개)로만 받고, 그중에서도
      // 이미 사례당 사용 횟수(기본 5회)를 다 채운 문제는 제외합니다 — 클라이언트의
      // 무작위 출제(pickCombinedQuestions)가 별도 로직 없이도 자연히 남은 사례만
      // 뽑도록 만들기 위함입니다. 수퍼비전 등 다른 카테고리는 그대로 둡니다.
      if (restrictToPremiumPool) {
        const [{ pool, byQuestion }, usesPerCase] = await Promise.all([
          getPremiumCaseUsageCounts(requester.id),
          getPremiumUsesPerCase()
        ]);
        mapped = mapped.filter(q => {
          if (q.cat !== 'case' && q.cat !== 'ethics') return true;
          const inPool = q.cat === 'case' ? pool.case.has(String(q.id)) : pool.ethics.has(String(q.id));
          if (!inPool) return false;
          return (byQuestion[String(q.id)] || 0) < usesPerCase;
        });
      }

      return res.status(200).json(mapped);
}

    // ────────────────────────────────────────────────
    // [QBANK-DB] 관리자 — 전체 질문 목록 (미공개 포함)
    // ────────────────────────────────────────────────

export async function adminQuestions(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { data, error } = await supabase
        .from('interview_questions')
        .select('*')
        .order('release_at', { ascending: false });

      if (error) throw error;

      // [QBANK-MODEL-ANSWER-BADGE] 목록에서 모범답안 등록 여부를 바로 확인할 수 있도록,
      // 사례개념화 문제들의 상담이론별 모범답안 개수를 한 번에 집계해서 각 행에 붙여줍니다.
      // (상담윤리는 interview_questions.model_answer 컬럼에 직접 있어서 별도 조회가 필요 없습니다.)
      const caseIds = (data || []).filter(q => q.cat === 'case').map(q => q.id);
      let caseModelAnswerCounts = {};
      if (caseIds.length > 0) {
        const { data: cmaRows, error: cmaErr } = await supabase
          .from('interview_case_model_answers')
          .select('question_id')
          .in('question_id', caseIds);
        if (cmaErr) throw cmaErr;
        caseModelAnswerCounts = (cmaRows || []).reduce((acc, r) => {
          acc[r.question_id] = (acc[r.question_id] || 0) + 1;
          return acc;
        }, {});
      }
      const mapped = (data || []).map(q => ({
        ...q,
        case_model_answer_count: q.cat === 'case' ? (caseModelAnswerCounts[q.id] || 0) : undefined
      }));

      return res.status(200).json(mapped);
}

    // ────────────────────────────────────────────────
    // [QBANK-DB] 관리자 — 질문 추가/수정 (공개일·활성화 포함)
    // ────────────────────────────────────────────────

export async function adminQuestionUpsert(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { id, cat, question, tips, isActive, releaseAt, modelAnswer, usageScope, topic } = req.body;

      if (!cat || !VALID_QUESTION_CATS.includes(cat)) {
        return res.status(400).json({ message: `cat은 ${VALID_QUESTION_CATS.join(', ')} 중 하나여야 합니다.` });
      }
      if (!question || typeof question !== 'string' || !question.trim()) {
        return res.status(400).json({ message: '질문 내용이 필요합니다.' });
      }
      if (usageScope !== undefined && !VALID_USAGE_SCOPES.includes(usageScope)) {
        return res.status(400).json({ message: `usageScope는 ${VALID_USAGE_SCOPES.join(', ')} 중 하나여야 합니다.` });
      }

      const row = {
        cat,
        // [QFORM-CATLABEL-REMOVED] 관리자가 별도로 표시명을 입력하지 않고, cat 값에서 항상 자동 산출합니다.
        cat_label: catLabelFor(cat),
        question: question.trim(),
        tips: Array.isArray(tips) ? tips.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()) : [],
        is_active: typeof isActive === 'boolean' ? isActive : true,
        release_at: releaseAt ? new Date(releaseAt).toISOString() : new Date().toISOString(),
        // [QBANK-TOPIC] 사례 분류/주제 태그 — 자유 입력, 비어 있으면 null(미분류)
        topic: typeof topic === 'string' ? (topic.trim() || null) : null,
      };
      // [QBANK-USAGE-SCOPE] AI 자율연습용(practice)/AI 면접 코스용(team) 구분 —
      // 안 보내면 신규는 DB 기본값(practice), 수정은 기존 값 유지.
      if (usageScope !== undefined) {
        row.usage_scope = usageScope;
      }

      // [AI-FEEDBACK] 상담윤리·수퍼비전 문제는 문제당 모범답안 1개를 함께 저장합니다.
      // (사례개념화는 상담이론별로 여러 개라 별도 테이블/액션으로 관리합니다.)
      // [AI-DRAFT-QUEUE] 관리자가 이 필드에 직접 텍스트를 넣어 제출했다는 건 이미
      // 검토(직접 작성 또는 AI 초안을 보고 수정)를 마쳤다는 뜻이라 바로 'approved'로
      // 저장합니다. 비워서 제출하면 아래에서 자동 초안 생성을 시도해 'draft'로 남깁니다.
      if (cat !== 'case' && typeof modelAnswer === 'string') {
        const trimmedModelAnswer = modelAnswer.trim();
        row.model_answer = trimmedModelAnswer || null;
        row.model_answer_status = trimmedModelAnswer ? 'approved' : null;
      }

      if (id) {
        const { error } = await supabase.from('interview_questions').update(row).eq('id', id);
        if (error) throw error;
        return res.status(200).json({ message: '질문이 수정되었습니다.' });
      } else {
        // [SEQ-NO] 신규 질문은 해당 카테고리의 다음 번호를 자동으로 부여합니다.
        row.seq_no = await getNextSeqNo(cat);
        const { data: inserted, error } = await supabase.from('interview_questions').insert(row).select('id').single();
        if (error) throw error;

        // [AI-DRAFT-QUEUE] Phase 2 — 모범답안 없이 신규 등록되면 백그라운드(같은 요청 안에서
        // 동기 처리) AI 초안을 자동 생성해 'draft' 상태로 채워둡니다. 실패해도 질문 등록
        // 자체는 이미 성공했으므로 응답에는 영향 주지 않고 로그만 남깁니다.
        let draftNote = '';
        try {
          const autoDraftFlags = await getAutoDraftFlags();
          if (cat !== 'case') {
            const flagKey = cat === 'ethics' ? 'autoDraftEthics' : 'autoDraftSupervision';
            const hasModelAnswer = !!row.model_answer;
            if (!hasModelAnswer && GEMINI_API_KEY && autoDraftFlags[flagKey]) {
              const draftText = await generateDraftModelAnswer({ cat, question: row.question, tips: row.tips });
              const { error: draftUpdateErr } = await supabase
                .from('interview_questions')
                .update({ model_answer: draftText, model_answer_status: 'draft' })
                .eq('id', inserted.id);
              if (draftUpdateErr) throw draftUpdateErr;
              draftNote = ' AI 모범답안 초안이 자동 생성되어 승인 대기 중입니다.';
            }
          } else if (GEMINI_API_KEY && autoDraftFlags.autoDraftCase) {
            const { data: theoryOptions, error: theoryErr } = await supabase
              .from('interview_theory_options')
              .select('name')
              .order('name', { ascending: true })
              .limit(AUTO_DRAFT_CASE_THEORY_LIMIT);
            if (theoryErr) throw theoryErr;
            const theoryNames = (theoryOptions || []).map(t => t.name).filter(Boolean);
            if (theoryNames.length > 0) {
              // [AI-DRAFT-QUEUE][PRACTICE-AUTO-APPROVE] AI 자율연습용(usage_scope='practice')
              // 사례개념화는 정식 AI 면접 코스보다 부담이 낮은 자율학습 트랙이라, 관리자
              // 검토 없이 AI 초안을 바로 승인 상태로 노출합니다. AI 면접 코스용(team)은
              // 기존대로 승인 대기(draft)로 남겨 관리자가 검토하게 합니다.
              const effectiveUsageScope = row.usage_scope || 'practice';
              const autoApprove = effectiveUsageScope === 'practice';
              const results = await Promise.allSettled(
                theoryNames.map(theoryName =>
                  generateDraftModelAnswer({ cat: 'case', question: row.question, tips: row.tips, theory: theoryName })
                    .then(draftText => ({ theoryName, draftText }))
                )
              );
              const successRows = results
                .filter(r => r.status === 'fulfilled')
                .map(r => ({
                  question_id: inserted.id,
                  theory: r.value.theoryName,
                  model_answer: r.value.draftText,
                  status: autoApprove ? 'approved' : 'draft'
                }));
              const failedCount = results.length - successRows.length;
              if (successRows.length > 0) {
                const { error: caseInsertErr } = await supabase
                  .from('interview_case_model_answers')
                  .upsert(successRows, { onConflict: 'question_id,theory' });
                if (caseInsertErr) throw caseInsertErr;
                draftNote = autoApprove
                  ? ` 상담이론 ${successRows.length}개에 대해 AI 모범답안이 자동 생성되어 바로 노출됩니다(AI 자율연습용이라 승인 절차 없이 즉시 적용).`
                  : ` 상담이론 ${successRows.length}개에 대해 AI 모범답안 초안이 자동 생성되어 승인 대기 중입니다.`;
                if (failedCount > 0) draftNote += ` (${failedCount}개는 생성 실패 — 나중에 수동으로 추가해주세요.)`;
              }
            }
          }
        } catch (draftErr) {
          console.warn('[interview.js] 신규 질문 자동 초안 생성 실패(질문 등록 자체는 성공):', draftErr.message);
        }

        return res.status(200).json({ message: `질문이 추가되었습니다. (${catLabelFor(cat)} #${row.seq_no})${draftNote}` });
      }
}

    // ────────────────────────────────────────────────
    // [QBANK-DB] 관리자 — 질문 삭제
    // ────────────────────────────────────────────────
    // ────────────────────────────────────────────────
    // [SUPERVISION-BULK-ACTIVE] 관리자 — 특정 구분(cat)+용도(usage_scope)의 문제를
    // 한 번에 활성화/비활성화합니다. 기존에는 "수퍼비전 학습" 기능 플래그 하나로
    // AI 자율연습 화면에서 수퍼비전 단계 전체를 껐다 켰는데, 그 스위치를 없애는 대신
    // 문제별 활성화 여부로 일원화하면서 카테고리 단위 일괄 조작이 필요해 추가했습니다.
    // ────────────────────────────────────────────────

export async function adminQuestionsBulkSetActive(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { cat, usage_scope, active } = req.body;
      if (!cat || !usage_scope || typeof active !== 'boolean') {
        return res.status(400).json({ message: 'cat, usage_scope, active가 필요합니다.' });
      }

      const { data, error } = await supabase
        .from('interview_questions')
        .update({ is_active: active })
        .eq('cat', cat)
        .eq('usage_scope', usage_scope)
        .select('id');
      if (error) throw error;

      return res.status(200).json({ message: `${data?.length || 0}개 문제를 ${active ? '활성화' : '비활성화'}했습니다.`, count: data?.length || 0 });
}

export async function adminQuestionDelete(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { id } = req.body;
      if (!id) return res.status(400).json({ message: 'id가 필요합니다.' });

      const { error } = await supabase.from('interview_questions').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ message: '질문이 삭제되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [FREE-TRIAL-DEFAULT-CASE] 관리자 — Free 회원 체험판에 쓰일 "기본 사례" 지정/해제.
    // 카테고리(사례개념화/상담윤리)당 항상 최대 1개만 켜지도록, 켤 때는 같은 카테고리의
    // 기존 기본 사례를 먼저 끕니다(급수 구분 없이 전체 공통 1세트).
    // ────────────────────────────────────────────────

export async function adminQuestionSetDefault(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { id, isDefault } = req.body;
      if (!id || typeof isDefault !== 'boolean') {
        return res.status(400).json({ message: 'id, isDefault가 필요합니다.' });
      }

      const { data: target, error: fetchErr } = await supabase
        .from('interview_questions')
        .select('id, cat')
        .eq('id', id)
        .single();
      if (fetchErr || !target) {
        return res.status(404).json({ message: '질문을 찾을 수 없습니다.' });
      }
      if (!['case', 'ethics'].includes(target.cat)) {
        return res.status(400).json({ message: '사례개념화·상담윤리 문제만 기본 사례로 지정할 수 있습니다.' });
      }

      if (isDefault) {
        const { error: clearErr } = await supabase
          .from('interview_questions')
          .update({ is_default_case: false })
          .eq('cat', target.cat)
          .eq('is_default_case', true);
        if (clearErr) throw clearErr;
      }

      const { error: setErr } = await supabase
        .from('interview_questions')
        .update({ is_default_case: isDefault })
        .eq('id', id);
      if (setErr) throw setErr;

      return res.status(200).json({ message: isDefault ? '기본 사례로 지정했습니다.' : '기본 사례 지정을 해제했습니다.' });
}

    // ────────────────────────────────────────────────
    // [AI-FEEDBACK] 관리자 — 사례개념화 문제의 상담이론별 모범답안 목록
    // ────────────────────────────────────────────────

export async function adminCaseModelAnswersList(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { questionId } = req.body;
      if (!questionId) return res.status(400).json({ message: 'questionId가 필요합니다.' });

      const { data, error } = await supabase
        .from('interview_case_model_answers')
        .select('*')
        .eq('question_id', questionId)
        .order('theory', { ascending: true });
      if (error) throw error;

      return res.status(200).json(data || []);
}

    // ────────────────────────────────────────────────
    // [AI-FEEDBACK] 관리자 — 사례개념화 상담이론별 모범답안 추가/수정
    // ────────────────────────────────────────────────

export async function adminCaseModelAnswerUpsert(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { id, questionId, theory, modelAnswer } = req.body;

      if (!questionId) return res.status(400).json({ message: 'questionId가 필요합니다.' });
      if (!theory || typeof theory !== 'string' || !theory.trim()) {
        return res.status(400).json({ message: '상담이론 이름이 필요합니다.' });
      }
      if (!modelAnswer || typeof modelAnswer !== 'string' || !modelAnswer.trim()) {
        return res.status(400).json({ message: '모범답안 내용이 필요합니다.' });
      }

      // [AI-DRAFT-QUEUE] 이 액션은 항상 관리자가 직접 입력/검토한 텍스트를 받으므로
      // (modelAnswer 필수 검증이 위에 있음) 저장과 동시에 'approved'로 처리합니다 —
      // 초안 승인 대기열에서 "승인" 버튼을 눌러도 결국 이 액션과 동일하게 처리됩니다.
      const row = {
        question_id: questionId,
        theory: theory.trim(),
        model_answer: modelAnswer.trim(),
        status: 'approved'
      };

      if (id) {
        const { error } = await supabase.from('interview_case_model_answers').update(row).eq('id', id);
        if (error) throw error;
      } else {
        // 같은 문제+이론 조합이 이미 있으면 덮어씁니다 (unique(question_id, theory)).
        const { error } = await supabase
          .from('interview_case_model_answers')
          .upsert([row], { onConflict: 'question_id,theory' });
        if (error) throw error;
      }

      return res.status(200).json({ message: '모범답안이 저장되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [AI-FEEDBACK] 관리자 — 사례개념화 상담이론별 모범답안 삭제
    // ────────────────────────────────────────────────

export async function adminCaseModelAnswerDelete(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { id } = req.body;
      if (!id) return res.status(400).json({ message: 'id가 필요합니다.' });

      const { error } = await supabase.from('interview_case_model_answers').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ message: '삭제되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [THEORY-PRESET] 관리자 — 상담이론 풀다운 목록 조회/추가·수정/삭제
    // interview_case_model_answers.theory는 이 테이블을 참조하는 외래키가
    // 아니므로, 여기서 삭제해도 이미 저장된 모범답안은 그대로 남습니다.
    // ────────────────────────────────────────────────

export async function adminTheoryOptionsList(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }
      const { data, error } = await supabase
        .from('interview_theory_options')
        .select('*')
        .order('name', { ascending: true });
      if (error) throw error;
      return res.status(200).json(data || []);
}

export async function adminTheoryOptionsUpsert(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }
      const { id, name } = req.body;
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed) return res.status(400).json({ message: '이론 이름이 필요합니다.' });

      if (id) {
        const { error } = await supabase.from('interview_theory_options').update({ name: trimmed }).eq('id', id);
        if (error) {
          if (error.code === '23505') return res.status(400).json({ message: '이미 등록된 이론 이름입니다.' });
          throw error;
        }
        return res.status(200).json({ message: '수정되었습니다.' });
      } else {
        const { error } = await supabase.from('interview_theory_options').insert({ name: trimmed });
        if (error) {
          if (error.code === '23505') return res.status(400).json({ message: '이미 등록된 이론 이름입니다.' });
          throw error;
        }
        return res.status(200).json({ message: '추가되었습니다.' });
      }
}

export async function adminTheoryOptionsDelete(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }
      const { id } = req.body;
      if (!id) return res.status(400).json({ message: 'id가 필요합니다.' });
      const { error } = await supabase.from('interview_theory_options').delete().eq('id', id);
      if (error) throw error;
      return res.status(200).json({ message: '삭제되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [AI-DRAFT] 관리자 — 모범답안 AI 초안 생성 (DB에는 기록하지 않고 텍스트만 반환)
    // admin.html의 모범답안 입력창 옆 "AI 초안 생성" 버튼에서 호출합니다.
    // 관리자가 반환된 텍스트를 검토·수정한 뒤 기존 저장 버튼으로 직접 저장하는
    // 흐름이라, 별도의 승인/검토 테이블 없이도 "화면에서 보고 고쳐서 저장"이
    // 곧 리뷰가 됩니다 (구글 시트 → n8n 경로의 승인 절차와는 별개의 경로).
    // ────────────────────────────────────────────────

export async function adminGenerateDraftModelAnswer(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }
      if (!GEMINI_API_KEY) {
        console.error('[interview.js] GEMINI_API_KEY 환경변수 누락');
        return res.status(500).json({ message: '서버에 AI 기능이 설정되어 있지 않습니다. 관리자에게 문의해주세요.' });
      }

      const { cat, question, tips, theory } = req.body || {};
      if (!VALID_QUESTION_CATS.includes(cat)) {
        return res.status(400).json({ message: `cat은 ${VALID_QUESTION_CATS.join(', ')} 중 하나여야 합니다.` });
      }
      const questionText = String(question ?? '').trim();
      if (!questionText) {
        return res.status(400).json({ message: '문제 내용(question)이 필요합니다.' });
      }
      if (cat === 'case' && !String(theory ?? '').trim()) {
        return res.status(400).json({ message: '사례개념화 문제는 상담이론(theory)이 필요합니다.' });
      }

      let draft;
      try {
        draft = await generateDraftModelAnswer({ cat, question: questionText, tips, theory });
      } catch (e) {
        console.error('[interview.js] Gemini 호출 예외:', e.message);
        return res.status(502).json({ message: e.isGeminiError ? 'AI 초안 생성 요청이 실패했습니다.' : 'AI 초안 생성 중 오류가 발생했습니다.' });
      }

      return res.status(200).json({ draft });
}

    // ────────────────────────────────────────────────
    // [AI-DRAFT-QUEUE] 관리자 — AI 자동 생성 모범답안 초안 승인 대기 목록.
    // 상담윤리·수퍼비전(interview_questions.model_answer_status='draft')과
    // 사례개념화(interview_case_model_answers.status='draft')를 한 목록으로 합쳐서 반환합니다.
    // ────────────────────────────────────────────────

export async function adminModelAnswerDraftsList(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { data: questionDrafts, error: qErr } = await supabase
        .from('interview_questions')
        .select('id, cat, cat_label, question, seq_no, model_answer')
        .eq('model_answer_status', 'draft')
        .order('created_at', { ascending: false });
      if (qErr) throw qErr;

      const { data: caseDrafts, error: cErr } = await supabase
        .from('interview_case_model_answers')
        .select('id, question_id, theory, model_answer, interview_questions(question, seq_no)')
        .eq('status', 'draft')
        .order('created_at', { ascending: false });
      if (cErr) throw cErr;

      // [CASE-THEORY-MISSING] 초안조차 하나도 생성되지 않은 사례개념화 문제(Phase 2
      // 이전에 등록된 문제 등)도 이 목록에 함께 노출합니다 — 그렇지 않으면 이론이
      // 아예 없는 문제는 이 큐에 절대 나타나지 않아 관리자가 존재를 알 수 없습니다.
      const { data: caseQuestions, error: caseQErr } = await supabase
        .from('interview_questions')
        .select('id, question, seq_no, is_active')
        .eq('cat', 'case')
        .eq('is_active', true);
      if (caseQErr) throw caseQErr;

      const { data: theoryQuestionIds, error: theoryIdsErr } = await supabase
        .from('interview_case_model_answers')
        .select('question_id');
      if (theoryIdsErr) throw theoryIdsErr;
      const questionsWithAnyTheory = new Set((theoryQuestionIds || []).map(r => r.question_id));
      const caseMissing = (caseQuestions || []).filter(q => !questionsWithAnyTheory.has(q.id));

      const rows = [
        ...(questionDrafts || []).map(q => ({
          type: 'question',
          id: q.id,
          cat: q.cat,
          catLabel: q.cat_label,
          seqNo: q.seq_no,
          question: q.question,
          theory: null,
          modelAnswer: q.model_answer
        })),
        ...(caseDrafts || []).map(c => ({
          type: 'case',
          id: c.id,
          cat: 'case',
          catLabel: catLabelFor('case'),
          seqNo: c.interview_questions?.seq_no ?? null,
          question: c.interview_questions?.question || '',
          theory: c.theory,
          modelAnswer: c.model_answer
        })),
        ...caseMissing.map(q => ({
          type: 'case-missing',
          id: q.id,
          cat: 'case',
          catLabel: catLabelFor('case'),
          seqNo: q.seq_no,
          question: q.question,
          theory: null,
          modelAnswer: null,
          noTheory: true
        }))
      ];

      return res.status(200).json(rows);
}

    // ────────────────────────────────────────────────
    // [AI-DRAFT-QUEUE] 관리자 — 초안 승인(그대로, 또는 수정한 텍스트로).
    // ────────────────────────────────────────────────

export async function adminModelAnswerApprove(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { type, id, modelAnswer } = req.body || {};
      const trimmed = typeof modelAnswer === 'string' ? modelAnswer.trim() : '';
      if (!trimmed) return res.status(400).json({ message: '승인할 모범답안 내용이 필요합니다.' });

      if (type === 'question') {
        const { error } = await supabase
          .from('interview_questions')
          .update({ model_answer: trimmed, model_answer_status: 'approved' })
          .eq('id', id)
          .eq('model_answer_status', 'draft');
        if (error) throw error;
      } else if (type === 'case') {
        const { error } = await supabase
          .from('interview_case_model_answers')
          .update({ model_answer: trimmed, status: 'approved' })
          .eq('id', id)
          .eq('status', 'draft');
        if (error) throw error;
      } else {
        return res.status(400).json({ message: 'type은 question 또는 case여야 합니다.' });
      }

      return res.status(200).json({ message: '승인되었습니다. 이제 수련생 화면과 AI 피드백에 사용됩니다.' });
}

    // ────────────────────────────────────────────────
    // [AI-DRAFT-QUEUE] 관리자 — 초안 반려. 상담윤리·수퍼비전은 모범답안을 비워
    // 다시 미등록 상태로 되돌리고(필요하면 나중에 직접 입력하거나 재생성),
    // 사례개념화는 초안 행 자체를 삭제합니다(이론별 개별 행이므로).
    // ────────────────────────────────────────────────

export async function adminModelAnswerReject(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { type, id } = req.body || {};

      if (type === 'question') {
        const { error } = await supabase
          .from('interview_questions')
          .update({ model_answer: null, model_answer_status: null })
          .eq('id', id)
          .eq('model_answer_status', 'draft');
        if (error) throw error;
      } else if (type === 'case') {
        const { error } = await supabase
          .from('interview_case_model_answers')
          .delete()
          .eq('id', id)
          .eq('status', 'draft');
        if (error) throw error;
      } else {
        return res.status(400).json({ message: 'type은 question 또는 case여야 합니다.' });
      }

      return res.status(200).json({ message: '반려되었습니다.' });
}

    // ────────────────────────────────────────────────
    // [SHEET-IMPORT] 관리자 — 구글 시트 붙여넣기 가져오기
    // (클라이언트가 TSV를 이미 rows 배열로 파싱해서 보냄)
    // ────────────────────────────────────────────────

export async function adminQuestionsBulkUpsert(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { rows } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: '가져올 행이 없습니다.' });
      }
      if (rows.length > 500) {
        return res.status(400).json({ message: '한 번에 최대 500행까지 가져올 수 있습니다.' });
      }

      const result = await upsertQuestionRows(rows);
      return res.status(200).json(result);
}

    // ────────────────────────────────────────────────
    // [SHEET-IMPORT] 관리자 — 구글 시트 "웹에 게시" CSV URL로 가져오기
    // ────────────────────────────────────────────────

export async function adminQuestionsImportUrl(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { csvUrl } = req.body;
      if (!csvUrl || typeof csvUrl !== 'string' || !/^https?:\/\//.test(csvUrl)) {
        return res.status(400).json({ message: '올바른 CSV URL이 필요합니다 (http/https).' });
      }

      let csvText;
      try {
        const resp = await fetch(csvUrl);
        if (resp.status === 401 || resp.status === 403) {
          return res.status(400).json({ message: `CSV URL 요청 실패: HTTP ${resp.status} — 시트 공유 설정을 확인해 주세요. 구글 시트 우측 상단 "공유" 버튼 → "일반 액세스"를 "링크가 있는 모든 사용자 - 뷰어"로 변경한 뒤 다시 시도해 주세요. (조직 계정이라 링크 공유가 막혀 있다면 방법 1의 붙여넣기를 이용해 주세요.)` });
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        csvText = await resp.text();
      } catch (e) {
        return res.status(400).json({ message: `CSV URL 요청 실패: ${e.message}` });
      }

      const table = parseCsv(csvText);
      if (table.length === 0) {
        return res.status(400).json({ message: 'CSV 내용이 비어 있습니다. 시트가 "웹에 게시 > CSV"로 게시되어 있는지 확인해 주세요.' });
      }

      // 헤더 행 자동 감지 (구분/질문/평가포인트/공개일시/활성화 열 이름 매칭)
      const header = table[0].map(h => String(h || '').trim());
      const findCol = (names) => header.findIndex(h => names.some(n => h.includes(n)));
      const idxCat     = findCol(['구분', '카테고리', 'cat']);
      const idxQ       = findCol(['질문', 'question']);
      const idxTips    = findCol(['평가', 'tips', '포인트']);
      const idxRelease = findCol(['공개', 'release']);
      const idxActive  = findCol(['활성', 'active']);
      const idxModelAnswer = findCol(['모범답안', 'model']);
      const idxApproved = findCol(['승인', 'approved', 'approval']);
      const hasHeader  = idxQ !== -1;
      const dataRows   = hasHeader ? table.slice(1) : table;

      // [AI-FEEDBACK] 모범답안 열은 "열 자체가 없음"(기존 값 유지)과 "열은 있는데
      // 칸이 비어 있음"(명시적으로 null로 지움)을 구분해야 하므로 기본값 ''를 쓰지 않습니다.
      const modelAnswerColIdx = hasHeader ? idxModelAnswer : 5;
      // [APPROVAL-GATE] "승인" 열도 마찬가지로 "열 자체가 없음"(항상 반영, 하위 호환)과
      // "열은 있는데 비어있음"(미승인으로 간주)을 구분합니다.
      const approvedColIdx = hasHeader ? idxApproved : 6;
      const rows = dataRows.map(cols => {
        const row = {
          catLabelRaw: cols[hasHeader ? idxCat     : 0] || '',
          question:    cols[hasHeader ? idxQ       : 1] || '',
          tips:        cols[hasHeader ? idxTips    : 2] || '',
          releaseAt:   cols[hasHeader ? idxRelease : 3] || '',
          isActiveRaw: cols[hasHeader ? idxActive  : 4] || ''
        };
        if (modelAnswerColIdx !== -1 && cols[modelAnswerColIdx] !== undefined) {
          row.modelAnswerRaw = cols[modelAnswerColIdx];
        }
        if (approvedColIdx !== -1 && cols[approvedColIdx] !== undefined) {
          row.approvedRaw = cols[approvedColIdx];
        }
        return row;
      }).filter(r => r.question && String(r.question).trim());

      if (rows.length === 0) {
        return res.status(400).json({ message: '인식 가능한 데이터 행이 없습니다. 헤더/열 순서를 확인해 주세요.' });
      }
      if (rows.length > 500) {
        return res.status(400).json({ message: '한 번에 최대 500행까지 가져올 수 있습니다.' });
      }

      const result = await upsertQuestionRows(rows);
      return res.status(200).json(result);
}

    // ────────────────────────────────────────────────
    // [AI-FEEDBACK][SHEET-IMPORT] 사례개념화 상담이론별 모범답안 — 붙여넣기 가져오기
    // 열 구성: 질문(매칭용) / 상담이론 / 모범답안
    // ────────────────────────────────────────────────

export async function adminCaseModelAnswersBulkUpsert(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { rows } = req.body;
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: '가져올 행이 없습니다.' });
      }
      if (rows.length > 500) {
        return res.status(400).json({ message: '한 번에 최대 500행까지 가져올 수 있습니다.' });
      }

      const result = await upsertCaseModelAnswerRows(rows);
      return res.status(200).json(result);
}

    // ────────────────────────────────────────────────
    // [AI-FEEDBACK][SHEET-IMPORT] 사례개념화 상담이론별 모범답안 — CSV URL 가져오기
    // ────────────────────────────────────────────────

export async function adminCaseModelAnswersImportUrl(req, res, requester) {
      if (requester.user_status !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: 관리자 권한이 필요합니다.' });
      }

      const { csvUrl } = req.body;
      if (!csvUrl || typeof csvUrl !== 'string' || !/^https?:\/\//.test(csvUrl)) {
        return res.status(400).json({ message: '올바른 CSV URL이 필요합니다 (http/https).' });
      }

      let csvText;
      try {
        const resp = await fetch(csvUrl);
        if (resp.status === 401 || resp.status === 403) {
          return res.status(400).json({ message: `CSV URL 요청 실패: HTTP ${resp.status} — 시트 공유 설정을 확인해 주세요. 구글 시트 우측 상단 "공유" 버튼 → "일반 액세스"를 "링크가 있는 모든 사용자 - 뷰어"로 변경한 뒤 다시 시도해 주세요. (조직 계정이라 링크 공유가 막혀 있다면 방법 1의 붙여넣기를 이용해 주세요.)` });
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        csvText = await resp.text();
      } catch (e) {
        return res.status(400).json({ message: `CSV URL 요청 실패: ${e.message}` });
      }

      const table = parseCsv(csvText);
      if (table.length === 0) {
        return res.status(400).json({ message: 'CSV 내용이 비어 있습니다.' });
      }

      // [SEQ-NO] 기본 열 순서는 "사례 번호 · 상담이론 · 모범답안"입니다.
      // "질문" 열이 있으면(번호 대신 또는 번호와 함께) 문구 매칭 대체수단으로도 사용됩니다.
      const header = table[0].map(h => String(h || '').trim());
      const findCol = (names) => header.findIndex(h => names.some(n => h.includes(n)));
      const idxSeqNo  = findCol(['번호', '사례번호', 'seq', 'no.']);
      const idxQ      = findCol(['질문', 'question']);
      const idxTheory = findCol(['이론', 'theory']);
      const idxAnswer = findCol(['모범답안', 'answer', 'model']);
      const idxApproved = findCol(['승인', 'approved', 'approval']);
      const hasHeader = idxSeqNo !== -1 || idxQ !== -1 || idxTheory !== -1 || idxAnswer !== -1;
      const dataRows  = hasHeader ? table.slice(1) : table;
      // [APPROVAL-GATE] "승인" 열이 시트에 없으면 항상 반영(하위 호환), 있으면 승인된 행만 반영합니다.
      const approvedColIdx = hasHeader ? idxApproved : 4;

      const rows = dataRows.map(cols => {
        const row = {
          seqNo:       cols[hasHeader ? idxSeqNo  : 0] || '',
          theory:      cols[hasHeader ? idxTheory : 1] || '',
          modelAnswer: cols[hasHeader ? idxAnswer : 2] || '',
          question:    cols[hasHeader ? idxQ      : -1] || ''
        };
        if (approvedColIdx !== -1 && cols[approvedColIdx] !== undefined) {
          row.approvedRaw = cols[approvedColIdx];
        }
        return row;
      }).filter(r => (r.seqNo && String(r.seqNo).trim()) || (r.question && String(r.question).trim()));

      if (rows.length === 0) {
        return res.status(400).json({ message: '인식 가능한 데이터 행이 없습니다. 헤더/열 순서를 확인해 주세요.' });
      }
      if (rows.length > 500) {
        return res.status(400).json({ message: '한 번에 최대 500행까지 가져올 수 있습니다.' });
      }

      const result = await upsertCaseModelAnswerRows(rows);
      return res.status(200).json(result);
}

