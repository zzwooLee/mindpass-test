// premium-info.js
// ─────────────────────────────────────────────────────────────────
// [MULTI-CERT-1] 자격증별로 가격/혜택 문구를 분리했습니다.
// premium.html이 현재 선택된 examType 기준으로 PREMIUM_INFO[examType]을 읽습니다.
// 가격·혜택 수정 시 이 파일만 변경하면 됩니다.
// 계좌번호·이메일 등 민감 정보는 Vercel 환경변수에서 관리합니다.
// [TIER-BENEFITS] 예전에는 benefits 배열 하나에 프리미엄 혜택과 무료 제한을 섞어
// 나열해 어디까지 무료이고 어디서부터 유료인지 구분이 어려웠습니다. free/premium
// 두 배열로 분리했고, common.js의 renderTierBenefitsHTML()이 이 구조를 읽어
// premium.html(업그레이드 모달 + 자격증 페이지 안내 카드)과 interview.html
// (업그레이드 모달) 세 곳 모두에 동일한 모양으로 렌더링합니다.
// [MULTI-CERT-3] clinical_psych/youth_counselor 문구를 실제 조회 방식(questions.js)에
// 맞게 다시 정리했습니다.
//  - free: "최대 20문제"는 총 열람 가능 문제 수 제한이 아니라 1회 무작위 출제
//    개수입니다. 무료 연도의 문제 전체를 20문제씩 무작위로 반복 열람할 수 있어
//    "최대 20문제까지"라는 표현이 오해를 줄 수 있어 수정했습니다.
//  - premium: 예전에는 premium 회원이 is_premium=TRUE 문제만 조회했지만,
//    questions.js를 무료+프리미엄 통합 조회로 바꾸면서 실제로 무료 회원 열람
//    범위를 포함해 추가 연도까지 보게 됩니다. 문구도 이에 맞춰 "무료 회원
//    열람 범위 포함 + 추가 연도(해설 포함)"로 수정했습니다.
// [MULTI-CERT-4] price를 단일 {label, amount} 객체에서 요금제 배열로 변경
//                (clinical_psych/youth_counselor만 — 월/6개월 두 플랜).
//                각 항목의 months 값은 신청 모달의 요금제 선택 라디오 →
//                send-mail.js → slack-action.js 승인 처리까지 그대로 전달되어
//                실제 구독 만료일 계산에 쓰입니다(예전엔 요금제와 무관하게
//                항상 1개월로 고정 승인됐던 문제를 함께 고쳤습니다).
//                counselor_interview는 플랜이 하나뿐이라 기존 단일 객체 구조를
//                그대로 유지합니다(renderUpgradeModal이 배열/단일 객체 모두 처리).
// [FREE-ALL-1] 기출문제 전면 무료화 (2026-08) — 위 [MULTI-CERT-3]/[MULTI-CERT-4]
//              항목 중 clinical_psych/youth_counselor의 요금제·premium 문구는
//              더 이상 유효하지 않습니다. 이 두 자격증은 price/premium/notice
//              필드 없이 free 목록만 가집니다. counselor_interview는 영향
//              없이 기존 구조를 그대로 유지합니다.
// ─────────────────────────────────────────────────────────────────

const PREMIUM_INFO = {
    // [FREE-ALL-1] 기출문제 전면 무료화 — 임상심리사/청소년상담사는 더 이상
    // 유료 멤버십을 판매하지 않습니다. price/premium/notice 필드를 제거하고
    // free 목록만 안내용으로 남겨둡니다(premium.html의 이용 범위 안내 카드에서
    // 참고). 실제 문제 조회 범위는 api/questions.js·api/years.js가 결정합니다.
    clinical_psych: {
        title   : '임상심리사 기출문제 뱅크',
        subtitle: '전체 연도 기출문제를 무료로 풀어보세요.<br>(해설은 제공되지 않습니다)',
        free: [
            '전체 연도 · 전체 문제 무료 열람 (횟수 제한 없음)',
            '해설 미제공'
        ]
    },
    youth_counselor: {
        title   : '청소년상담사 기출문제 뱅크',
        subtitle: '1급·2급·3급 전 범위 기출문제를 무료로 풀어보세요.<br>(해설은 제공되지 않습니다)',
        free: [
            '전체 연도 · 전체 문제 무료 열람 (횟수 제한 없음)',
            '해설 미제공'
        ]
    },
    // [MULTI-CERT-2] 전문상담사 AI 모의면접 — 퀴즈 뱅크와 별도로 승인 관리되는 서비스
    // [PROGRAM-ONLY] 무료/유료 요금제 구분이 있는 서비스가 아니라, 사례개념화·
    // 상담윤리·수퍼비전(1급만) 실전 모의면접을 지원하는 단일 프로그램입니다.
    // free 배열을 비워두면 renderTierBenefitsHTML이 "🔒 무료 회원" 블록을
    // 자동으로 생략합니다(common.js [PROGRAM-ONLY] 참고).
    counselor_interview: {
        title   : '코칭 면접 코스 이용 승인',
        subtitle: '사례개념화·상담윤리·수퍼비전(1급) 실전 코칭 프로그램',
        // [PRICE-BY-GRADE] 2026-08 가격 재설계(AI 주도 전환) — 급수별로 다른 금액을
        // 보여줍니다. interview.html의 renderUpgradeModal()이 응시 급수 선택에 맞춰
        // 이 중 하나를 골라 보여주고, api/send-mail.js·api/slack-action.js도 같은
        // 금액을 별도로 복제해 관리자 알림에 표시합니다(세 곳 모두 동기화 유지 필요).
        price: {
            '2': { label: '이용 요금(2급)', amount: '190,000원', note: 'AI 면접 코스 8회(1개월) · AI 자율연습 자동 포함' },
            '1': { label: '이용 요금(1급)', amount: '240,000원', note: 'AI 면접 코스 8회(1개월) · AI 자율연습 자동 포함' }
        },
        // [PRACTICE-ONLY] AI 자율연습만 단독으로 신청하는 요금제(AI 면접 코스 없이
        // 자율연습만 이용). interview.html의 신청 모달에서 "AI 자율연습 단독" 옵션을
        // 선택하면 이 가격을 보여주고, api/send-mail.js·api/slack-action.js도 같은
        // 금액을 별도로 복제해 관리자 알림에 표시합니다(세 곳 모두 동기화 유지 필요).
        practicePrice: {
            '2': { label: '이용 요금(2급, AI 자율연습 단독)', amount: '115,000원', note: 'AI 자율연습만 이용 (AI 면접 코스 미포함)' },
            '1': { label: '이용 요금(1급, AI 자율연습 단독)', amount: '155,000원', note: 'AI 자율연습만 이용 (AI 면접 코스 미포함)' }
        },
        // [COACHING-TIER] 코칭 면접 코스 — 소그룹(9명 기준) 팀 배정 + 6주 6회 실시간
        // 화상 수퍼비전. AI 면접 코스와 동일한 제출·AI 피드백 파이프라인을 쓰되,
        // 피드백은 실시간 세션에서 수퍼바이저가 공개하기 전까지 보류됩니다.
        // [COACHING-FIXED-SESSIONS] 2026-08 — 급수당 회차(세션 수)를 1개로 고정.
        // 2급은 5회, 1급은 6회만 제공합니다(다른 회차 옵션 없음). 회차 수가 바뀌면
        // api/send-mail.js·api/slack-action.js의 COUNSELOR_INTERVIEW_PRICE.coaching과
        // 반드시 동일하게 유지해주세요.
        coachingPrice: {
            '2': { label: '이용 요금(2급, 코칭 면접 코스)', amount: '270,000원', noteLines: ['5회 (주 1회 · 회당 2시간)', '사례개념화 · 상담윤리'], noteHighlight: true },
            '1': { label: '이용 요금(1급, 코칭 면접 코스)', amount: '320,000원', noteLines: ['6회 (주 1회 · 회당 2시간)', '사례개념화 · 상담윤리 · 수퍼비전'], noteHighlight: true }
        },
        free: [],
        // [GRADE-SCOPED-BENEFITS] 첫 항목은 interview.html의 renderUpgradeModal()이
        // 선택된 급수(1급/2급)에 맞춰 문구를 바꿔서 보여줍니다(수퍼비전은 1급에만
        // 해당). 여기 적힌 문구는 초기값(2급 기준) 폴백용입니다.
        premium: [
            '사례개념화·상담윤리 실전 코칭 지원',
            '소그룹(9명 기준) 실시간 화상 코칭',
            'AI 자율연습 사례 제공 (영역별 10개)',
            '연습 결과 자동 저장 및 기록 조회'
        ],
        notice: '승인 즉시 활성화되며, 만료 후에도 기록은 계속 조회할 수 있습니다.'
    }
};
