/* common.js */
// ─────────────────────────────────────────────────────────────────
// 수정 이력
// [MULTI-CERT-1] 자격증별(exam_type) 구독 구조 반영
//                변경 전: currentUser.status 하나로 free/premium/admin 표현
//                변경 후: currentUser = { id, email, name, isAdmin, subscriptions }
//                subscriptions는 { clinical_psych: 'free'|'premium', youth_counselor: 'free'|'premium' }
//                admin 여부는 isAdmin으로 별도 관리(자격증과 무관).
//                문제 조회/연도 조회/AI 생성/프리미엄 신청 요청에는 모두
//                examType을 함께 보내야 합니다. 현재 선택된 자격증은
//                premium.html의 #sel-exam-type에서 읽습니다.
//                관리자 패널도 유저별로 자격증 두 개의 등급을 각각 표시·관리하도록
//                loadUserList/updateSubscriptionStatus/setSubscriptionExpiry/
//                toggleSiteAdmin으로 재구성했습니다. (기존 updateUserStatus/
//                setExpiryDate는 각각 examType 파라미터를 받는 형태로 대체됨)
// [FIX-Critical-1] checkAnswer — `correct` 변수로 선언 후 `safeCorrect`로
//                  참조하던 버그 수정. parseInt()로 정수 변환 후 변수명 통일.
// [FIX-High-1]    handleLogout — 로그아웃 시 btn-admin-menu 명시적 숨김 처리
// [FIX-High-2]    forceLogout (자동 로그아웃) — 동일하게 btn-admin-menu 숨김 처리
// [기존 유지]     STORAGE_KEY 전역 상수화, setupAutoLogout 모듈,
//                 escapeHtml, authHeaders, 퀴즈 엔진 뼈대
// ─────────────────────────────────────────────────────────────────

const QUIZ_STORAGE_KEY = 'quiz_last_active';
window._quizStorageKey = QUIZ_STORAGE_KEY;

const EXAM_LABELS = { clinical_psych: '임상심리사', youth_counselor: '청소년상담사', counselor_interview: '전문상담사 AI 모의면접', coaching_interview: '코칭면접코스' };

// ─────────────────────────────────────────────
// 0. 자동 로그아웃 모듈
//    · 비활동 30분 경과 시 자동 로그아웃
//    · 만료 2분 전 경고 모달 → "계속하기" 누르면 세션 연장
//    · 탭 전환 후 복귀 시에도 즉시 체크
// ─────────────────────────────────────────────
(function setupAutoLogout() {
    const TIMEOUT_MS  = 30 * 60 * 1000;
    const WARN_MS     =  2 * 60 * 1000;
    const CHECK_MS    =      60 * 1000;
    const THROTTLE_MS =      30 * 1000;
    const STORAGE_KEY = QUIZ_STORAGE_KEY;

    let warnInterval  = null;
    let checkInterval = null;
    let throttleTimer = null;

    function resetActivity() {
        sessionStorage.setItem(STORAGE_KEY, Date.now());
        const warnModal = document.getElementById('auto-logout-modal');
        if (warnModal && warnModal.style.display === 'flex') {
            warnModal.style.display = 'none';
            clearInterval(warnInterval);
            warnInterval = null;
            startCheck();
        }
    }

    function forceLogout() {
        clearInterval(warnInterval);
        clearInterval(checkInterval);
        clearTimeout(throttleTimer);
        throttleTimer = null;
        warnInterval  = null;
        checkInterval = null;

        sessionStorage.removeItem('quiz_user');
        sessionStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem('quiz_token');

        const warnModal = document.getElementById('auto-logout-modal');
        if (warnModal) warnModal.style.display = 'none';

        const adminBtn = document.getElementById('btn-admin-menu');
        if (adminBtn) adminBtn.style.display = 'none';

        const path = location.pathname;
        if (!path.endsWith('index.html') && path !== '/' && path !== '') {
            location.href = 'index.html';
        } else {
            const guestView = document.getElementById('guest-view');
            const userView  = document.getElementById('user-view');
            if (guestView) guestView.style.display = 'block';
            if (userView)  userView.style.display  = 'none';
        }
    }

    function showWarnModal(remainSec) {
        clearInterval(warnInterval);
        warnInterval = null;

        const modal   = document.getElementById('auto-logout-modal');
        const countEl = document.getElementById('auto-logout-count');
        if (!modal) { forceLogout(); return; }
        if (countEl) countEl.innerText = remainSec;
        modal.style.display = 'flex';

        let remain = remainSec;
        warnInterval = setInterval(() => {
            remain -= 1;
            if (countEl) countEl.innerText = remain;
            if (remain <= 0) { clearInterval(warnInterval); warnInterval = null; forceLogout(); }
        }, 1000);
    }

    function startCheck() {
        clearInterval(checkInterval);
        checkInterval = setInterval(() => {
            if (!sessionStorage.getItem('quiz_user')) { clearInterval(checkInterval); checkInterval = null; return; }
            const lastActive = parseInt(sessionStorage.getItem(STORAGE_KEY) || Date.now());
            const idle       = Date.now() - lastActive;
            const remain     = TIMEOUT_MS - idle;

            if (remain <= 0) {
                clearInterval(checkInterval);
                checkInterval = null;
                forceLogout();
            } else if (remain <= WARN_MS) {
                const modal = document.getElementById('auto-logout-modal');
                if (modal && modal.style.display !== 'flex') {
                    clearInterval(checkInterval);
                    checkInterval = null;
                    showWarnModal(Math.floor(remain / 1000));
                }
            }
        }, CHECK_MS);
    }

    window._startAutoLogoutCheck = startCheck;

    ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(evt => {
        document.addEventListener(evt, () => {
            if (!sessionStorage.getItem('quiz_user')) return;

            const warnModal = document.getElementById('auto-logout-modal');
            if (warnModal && warnModal.style.display === 'flex') {
                resetActivity();
                return;
            }

            if (throttleTimer) return;
            resetActivity();
            throttleTimer = setTimeout(() => { throttleTimer = null; }, THROTTLE_MS);
        }, { passive: true });
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return;
        if (!sessionStorage.getItem('quiz_user')) return;
        const lastActive = parseInt(sessionStorage.getItem(STORAGE_KEY) || Date.now());
        if (Date.now() - lastActive >= TIMEOUT_MS) { forceLogout(); }
    });

    window._initAutoLogout = function () {
        if (!sessionStorage.getItem('quiz_user')) return;
        resetActivity();
        startCheck();
    };

    window.extendSession = function () {
        clearInterval(warnInterval);
        warnInterval = null;
        resetActivity();
    };
})();

// ─────────────────────────────────────────────
// 1. 전역 상태 관리
// [MULTI-CERT-1] currentUser 구조 변경: status → isAdmin + subscriptions
// ─────────────────────────────────────────────
let allQuestions     = [];
let currentIndex     = 0;
let currentExamType  = ''; // 마지막으로 문제를 불러온 자격증 — checkAnswer 등에서 사용

function safeParseUser() {
    try { return JSON.parse(sessionStorage.getItem('quiz_user')); }
    catch { sessionStorage.removeItem('quiz_user'); return null; }
}

let currentUser         = safeParseUser() || { email: '', isAdmin: false, subscriptions: {} };
let currentTargetUserId = null;

// ─────────────────────────────────────────────────────────────────
// [MULTI-CERT-1] 특정 자격증에 대한 현재 유저의 등급을 반환합니다.
// admin은 자격증과 무관하게 'admin', 그 외는 subscriptions[examType] || 'free'.
// premium.html 등 다른 스크립트에서 window.getCurrentExamStatus(examType)로 사용합니다.
// ─────────────────────────────────────────────────────────────────
window.getCurrentExamStatus = function (examType) {
    if (currentUser.isAdmin) return 'admin';
    return (currentUser.subscriptions && currentUser.subscriptions[examType]) || 'free';
};

// ─────────────────────────────────────────────────────────────────
// [TIER-BENEFITS] 무료/프리미엄 이용범위를 항상 "무료"와 "프리미엄" 두 구간으로
// 명확히 나눠서 렌더링하는 공통 헬퍼. premium.html(업그레이드 모달 + 자격증 페이지
// 안내 카드)과 interview.html(업그레이드 모달), 총 세 곳이 모두 이 함수 하나로
// 렌더링해서 문구/구성이 서로 어긋나는 일이 없도록 합니다.
// info는 premium-info.js의 PREMIUM_INFO[examType] 형태이며
// { free: string[], premium: string[] }를 읽습니다.
// [TIER-INFO-COVERAGE] yearInfo(선택)는 { free: '2015년 ~ 2024년', premium: '...' }
// 형태로, 각 라벨 우측에 실제 이용 가능 연도를 배지로 붙여줍니다. premium.html의
// 자격증 페이지 안내 카드처럼 연도 정보가 있는 곳에서만 넘기면 되고, 업그레이드
// 모달처럼 연도 개념이 없는 곳(interview.html 등)은 생략하면 기존과 동일하게
// 라벨만 표시됩니다.
// ─────────────────────────────────────────────────────────────────
// [PROGRAM-ONLY] info.free가 빈 배열/미지정이면(예: counselor_interview처럼
// 무료·유료 구분 없이 단일 프로그램만 있는 서비스) "🔒 무료 회원" 블록 자체를
// 생략합니다. clinical_psych/youth_counselor처럼 free 항목이 있는 경우는
// 기존과 동일하게 두 블록 모두 표시됩니다.
window.renderTierBenefitsHTML = function (info, yearInfo, labels) {
    if (!info) return '';
    const freeList    = info.free || [];
    const premiumList = info.premium || [];
    const freeItems    = freeList.map(b => `<li>${escapeHtml(b)}</li>`).join('');
    const premiumItems = premiumList.map(b => `<li>${escapeHtml(b)}</li>`).join('');
    const freeYear    = yearInfo?.free    ? `<span class="tier-benefit-year">${escapeHtml(yearInfo.free)}</span>`    : '';
    const premiumYear = yearInfo?.premium ? `<span class="tier-benefit-year">${escapeHtml(yearInfo.premium)}</span>` : '';
    // [LABEL-OVERRIDE] counselor_interview처럼 실제로는 무료/프리미엄 두 등급이 아니라
    // 프로그램 하나만 있는 곳에서는 "프리미엄 회원"이라는 문구가 어색해서, 호출부가
    // labels로 원하는 문구를 넘기면 그걸 쓰고, 안 넘기면 기존 문구를 그대로 씁니다.
    const freeLabel    = (labels && labels.free)    || '🔒 무료 회원';
    const premiumLabel = (labels && labels.premium) || '⭐ 프리미엄 회원';
    const freeBlock = freeList.length ? `
        <div class="tier-benefit-block tier-benefit-free">
            <div class="tier-benefit-label-row">
                <span class="tier-benefit-label">${freeLabel}</span>
                ${freeYear}
            </div>
            <ul>${freeItems}</ul>
        </div>` : '';
    const premiumBlock = `
        <div class="tier-benefit-block tier-benefit-premium">
            <div class="tier-benefit-label-row">
                <span class="tier-benefit-label">${premiumLabel}</span>
                ${premiumYear}
            </div>
            <ul>${premiumItems}</ul>
        </div>`;
    return freeBlock + premiumBlock;
};

// ─────────────────────────────────────────────────────────────────
// [MULTI-CERT-4] 요금 표시 공통 헬퍼.
// price는 premium-info.js의 PREMIUM_INFO[examType].price로,
// { label, amount } 단일 객체이거나 { label, amount, months } 배열입니다
// (clinical_psych/youth_counselor는 월/6개월 두 플랜 배열).
//
// - renderPriceRowsHTML: 정적 표시용(자격증 페이지 안내 카드) — 선택 불가,
//   모든 플랜을 그냥 나열합니다.
// - renderPricePlanSelectorHTML: 업그레이드 모달용 — 플랜이 2개 이상이면
//   라디오 버튼으로 선택하게 하고, 각 input에 data-months를 실어서
//   sendUpgradeEmail()이 선택된 개월 수를 바로 읽어 /api/send-mail로 보낼 수
//   있게 합니다. 플랜이 1개뿐이면(예: counselor_interview) 선택 UI 없이
//   정적 표시와 동일하게 보여줍니다.
// ─────────────────────────────────────────────────────────────────
window.renderPriceRowsHTML = function (price, opts) {
    const list = Array.isArray(price) ? price : [price];
    const valueStyle = opts?.emphasis ? ' style="font-weight:800; font-size:var(--fs-emphasis); color:#1a202c;"' : '';
    return list.map(p => {
        // [PRICE-NOTE-LINEBREAK] noteLines(배열)가 있으면 줄마다 escape한 뒤 <br>로
        // 이어붙여 여러 줄로 보여줍니다. 없으면 기존처럼 note(단일 문자열) 한 줄만 씁니다.
        const noteHtml = Array.isArray(p.noteLines) && p.noteLines.length > 0
            ? p.noteLines.map(line => escapeHtml(line)).join('<br>')
            : (p.note ? escapeHtml(p.note) : '');
        return `
        <div class="payment-row">
            <span class="payment-label">${escapeHtml(p.label)}</span>
            <span class="payment-value"${valueStyle}>${escapeHtml(p.amount)}</span>
        </div>
        ${noteHtml ? `<div class="payment-note" style="font-size:${p.noteHighlight ? 'var(--fs-body)' : 'var(--fs-caption)'}; font-weight:${p.noteHighlight ? '700' : '400'}; color:${p.noteHighlight ? 'var(--accent)' : '#a0aec0'}; text-align:right; line-height:1.5; margin-top:${p.noteHighlight ? '4px' : '-4px'};">${noteHtml}</div>` : ''}
    `;
    }).join('');
};

window.renderPricePlanSelectorHTML = function (price) {
    const list = Array.isArray(price) ? price : [price];
    if (list.length <= 1) return window.renderPriceRowsHTML(list);

    return list.map((p, i) => `
        <label class="payment-row" style="cursor:pointer; align-items:center;">
            <span style="display:flex; align-items:center; gap:8px;">
                <input type="radio" name="upgradePlanRadio" value="${i}" data-months="${parseInt(p.months, 10) || 1}" data-sessions="${p.sessions != null ? p.sessions : ''}"
                       ${i === 0 ? 'checked' : ''} style="width:auto; margin:0;">
                <span class="payment-label" style="font-weight:600;">${escapeHtml(p.label)}</span>
            </span>
            <span class="payment-value">${escapeHtml(p.amount)}</span>
        </label>
    `).join('');
};

// 현재 선택된(또는 유일한) 플랜의 개월 수를 반환합니다. 라디오가 없으면(플랜 1개)
// 1개월로 간주합니다 — counselor_interview처럼 플랜 개념이 없는 서비스는
// 서버에서도 이 값을 쓰지 않으므로 안전한 기본값입니다.
window.getSelectedPlanMonths = function () {
    const checked = document.querySelector('input[name="upgradePlanRadio"]:checked');
    return checked ? (parseInt(checked.dataset.months, 10) || 1) : 1;
};

// ─────────────────────────────────────────────────────────────────
// XSS 방어 헬퍼
// ─────────────────────────────────────────────────────────────────
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────
// [COACHING-COURSE-SCHEDULE] 개설 일정 표시용 날짜/시간 포맷 헬퍼 — 코칭 면접
// 코스 개설 일정을 보여주는 여러 화면(interview.html, index.html)이 공유합니다.
// ─────────────────────────────────────────────────────────────────
function formatDateWithDow(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    const dow = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
    return `${dateStr}(${dow})`;
}

function formatTimeKo(timeStr) {
    if (!timeStr || !/^\d{2}:\d{2}$/.test(timeStr)) return '';
    const [hStr, mStr] = timeStr.split(':');
    let h = parseInt(hStr, 10);
    const period = h < 12 ? '오전' : '오후';
    h = h % 12;
    if (h === 0) h = 12;
    return `${period} ${h}:${mStr}`;
}

function formatTimeRangeKo(startTime, endTime) {
    const start = formatTimeKo(startTime);
    const end = formatTimeKo(endTime);
    if (start && end) return `${start} ~ ${end}`;
    return start || end || '';
}

// [COACHING-COURSE-BANNER] 개설 일정 중 "아직 시작하지 않았거나 오늘 시작하는" 회차가
// 하나라도 있으면 true — index.html/premium.html/interview.html이 공통으로 씁니다.
function isCoachingCourseUpcoming(schedule) {
    if (!Array.isArray(schedule) || schedule.length === 0) return false;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return schedule.some(r => r && typeof r.startDate === 'string' && r.startDate >= todayStr);
}

// [COACHING-COURSE-BANNER] 배너 마크업 — opts.href(다른 페이지로 이동)나
// opts.onclick(현재 페이지에서 바로 신청 모달 열기) 중 하나를 받습니다.
function renderCoachingPromoBannerHTML(opts) {
    opts = opts || {};
    const action = opts.href
        ? `<a href="${opts.href}" class="coaching-promo-btn">신청하기</a>`
        : `<button type="button" class="coaching-promo-btn" onclick="${opts.onclick || ''}">신청하기</button>`;
    return `
    <div class="coaching-promo-banner">
        <div class="coaching-promo-text">🎉 현재 전문상담사 자격 면접 대비 코칭 프로그램이 개설되었습니다. 본 프로그램 참여를 원하시는 분은 <b>코칭면접코스</b>를 신청해주세요.</div>
        ${action}
    </div>`;
}

// ─────────────────────────────────────────────────────────────────
// 공통 인증 헤더 생성 헬퍼
// ─────────────────────────────────────────────────────────────────
function authHeaders() {
    const token = sessionStorage.getItem('quiz_token');
    return {
        'Content-Type' : 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };
}

// ─────────────────────────────────────────────
// 2. 초기 로드 및 UI 업데이트
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    updateUserUI();

    if (currentUser.isAdmin) {
        const adminBtn = document.getElementById('btn-admin-menu');
        if (adminBtn) adminBtn.style.display = 'inline-block';
    }

    const guestView = document.getElementById('guest-view');
    const userView  = document.getElementById('user-view');
    if (guestView && userView && currentUser.email) {
        guestView.style.display = 'none';
        userView.style.display  = 'block';
        const infoEl = document.getElementById('user-display-info');
        const displayName = currentUser.name || currentUser.email;
        if (infoEl) infoEl.innerText = currentUser.isAdmin ? `${displayName} (ADMIN)` : displayName;
    }

    if (typeof window._initAutoLogout === 'function') {
        window._initAutoLogout();
    }
});

// [MULTI-CERT-1] display-status(등급 배지)는 자격증마다 다르므로 여기서 채우지 않습니다.
// premium.html이 현재 선택된 examType 기준으로 별도 렌더링합니다.
function updateUserUI() {
    const savedUser = sessionStorage.getItem('quiz_user');
    if (savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
        } catch {
            sessionStorage.removeItem('quiz_user');
            return;
        }
        // interview.html의 인사말("OOO님")과 표기를 통일합니다.
        const nameEl = document.getElementById('display-name');
        if (nameEl) nameEl.innerText = `${currentUser.name || currentUser.email}님`;
    }
}

// ─────────────────────────────────────────────
// 3. 커스텀 모달 제어
// ─────────────────────────────────────────────
window.closeCustomModal = function () {
    const modal = document.getElementById('custom-modal');
    if (modal) modal.style.display = 'none';
};

window.showAlert = function (title, desc) {
    const modal = document.getElementById('custom-modal');
    if (!modal) { alert(`${title}\n${desc}`); return; }

    document.getElementById('modal-title').innerText = title;
    document.getElementById('modal-desc').innerText  = desc;
    document.getElementById('modal-date-input').style.display = 'none';
    document.getElementById('modal-cancel-btn').style.display = 'none';

    const confirmBtn = document.getElementById('modal-confirm-btn');
    confirmBtn.onclick = closeCustomModal;
    modal.style.display = 'flex';
};

// ─────────────────────────────────────────────
// 4. 인증 — 로그인 / 회원가입 / 로그아웃
// ─────────────────────────────────────────────

window.handleLogin = async function () {
    const email    = document.getElementById('email')?.value.trim();
    const password = document.getElementById('password')?.value;

    if (!email || !password) {
        return showAlert('입력 오류', '이메일과 비밀번호를 입력해주세요.');
    }

    try {
        const res  = await fetch('/api/login', {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({ email, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);

        if (data.accessToken) {
            sessionStorage.setItem('quiz_token', data.accessToken);
        }

        // [MULTI-CERT-1] 로그인 응답 구조: { user, isAdmin, subscriptions, accessToken }
        const userData = {
            id            : data.user.id,
            email         : data.user.email,
            name          : data.user.name || data.user.user_metadata?.name || '',
            isAdmin       : !!data.isAdmin,
            subscriptions : data.subscriptions || {}
        };
        sessionStorage.setItem('quiz_user', JSON.stringify(userData));
        currentUser = userData;

        sessionStorage.setItem(QUIZ_STORAGE_KEY, Date.now());

        if (typeof window._startAutoLogoutCheck === 'function') {
            window._startAutoLogoutCheck();
        }

        // [LANDING-DIRECT-NAV] 랜딩 페이지의 기능 카드(퀴즈 뱅크/모의면접)를 눌러
        // 로그인했다면, 로그인 완료 후 그 화면으로 바로 이동시킵니다. 헤더의 일반
        // "로그인" 버튼처럼 redirectTo 없이 연 경우는 기존과 동일하게 아래의
        // guest-view/user-view 전환 로직(예: index.html의 "다시 오셨네요" 메뉴)을 따릅니다.
        if (window._pendingLoginRedirect) {
            const redirectTo = window._pendingLoginRedirect;
            window._pendingLoginRedirect = null;
            location.href = redirectTo;
            return;
        }

        const guestView = document.getElementById('guest-view');
        const userView  = document.getElementById('user-view');
        if (guestView && userView) {
            guestView.style.display = 'none';
            userView.style.display  = 'block';
            // [COACHING-COURSE-BANNER] 리다이렉트 없이(일반 로그인 버튼으로) index.html에서
            // 바로 로그인한 경우에도 배너의 동작(로그인 유도 → 바로 이동)이 최신 상태로
            // 갱신되도록 다시 그립니다. index.html에만 정의된 함수라 존재할 때만 호출합니다.
            if (typeof renderCoachingPromoBanner === 'function') renderCoachingPromoBanner();
            const infoEl = document.getElementById('user-display-info');
            const loginDisplayName = userData.name || userData.email;
            if (infoEl) infoEl.innerText = userData.isAdmin ? `${loginDisplayName} (ADMIN)` : loginDisplayName;

            if (userData.isAdmin) {
                const adminBtn = document.getElementById('btn-admin-menu');
                if (adminBtn) adminBtn.style.display = 'inline-block';
            }

            // [FIX] index.html 전용 요소 — guest-view가 로그인 모달 안에 있으므로
            // 모달을 닫고, 뒤에 남아 있는 랜딩 히어로/로그인 버튼도 함께 숨겨야
            // "블러 처리된 빈 모달이 화면 위에 겹쳐 보이는" 현상이 생기지 않습니다.
            // (새로고침하면 index.html의 DOMContentLoaded 로직이 같은 처리를 하기
            // 때문에 새로고침 후에는 정상으로 보였던 버그입니다.)
            const modalOverlay = document.getElementById('auth-modal-overlay');
            if (modalOverlay) modalOverlay.style.display = 'none';
            const heroLanding = document.getElementById('hero-landing');
            if (heroLanding) heroLanding.style.display = 'none';
            const openLoginBtn = document.getElementById('btn-open-login');
            if (openLoginBtn) openLoginBtn.style.display = 'none';
        } else {
            location.href = 'premium.html';
        }
    } catch (e) {
        showAlert('로그인 실패', e.message);
    }
};

window.handleSignUp = async function () {
    const name     = document.getElementById('signup-name')?.value.trim();
    const email    = document.getElementById('signup-email')?.value.trim();
    const password = document.getElementById('signup-password')?.value;

    if (!name) return showAlert('입력 오류', '이름을 입력해주세요.');
    if (name.length > 20) return showAlert('입력 오류', '이름은 20자 이내로 입력해주세요.');
    if (!email || !password) return showAlert('입력 오류', '이메일과 비밀번호를 입력해주세요.');
    if (password.length < 6) return showAlert('입력 오류', '비밀번호는 6자 이상이어야 합니다.');

    try {
        const res  = await fetch('/api/signup', {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({ name, email, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);
        showAlert('가입 완료', data.message);
    } catch (e) {
        showAlert('가입 실패', e.message);
    }
};

window.handleResetPassword = async function () {
    const email = document.getElementById('reset-email')?.value.trim();
    if (!email) return showAlert('입력 오류', '이메일을 입력해주세요.');

    const btn = document.getElementById('btn-send-reset');
    if (btn) { btn.disabled = true; btn.innerText = '발송 중...'; }

    try {
        const res  = await fetch('/api/reset-password', {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({ email })
        });
        const data = await res.json();
        showAlert('이메일 발송', data.message || '재설정 링크를 발송했습니다. 스팸함도 확인해주세요.');
    } catch (e) {
        showAlert('오류', '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = '재설정 링크 발송'; }
    }
};

window.handleSetNewPassword = async function () {
    const pw  = document.getElementById('new-password')?.value;
    const pw2 = document.getElementById('new-password-confirm')?.value;

    if (!pw || pw.length < 6) {
        return showAlert('입력 오류', '비밀번호는 6자 이상 입력해주세요.');
    }
    if (pw !== pw2) {
        return showAlert('입력 오류', '두 비밀번호가 일치하지 않습니다.');
    }

    const searchParams = new URLSearchParams(location.search);
    const hashParams   = new URLSearchParams(location.hash.replace(/^#/, ''));

    const recoveryToken = searchParams.get('token_hash')
        || hashParams.get('token_hash')
        || hashParams.get('access_token')
        || searchParams.get('access_token');

    if (!recoveryToken) {
        return showAlert('오류', '유효하지 않은 접근입니다. 재설정 이메일의 링크를 다시 클릭해주세요.');
    }

    const btn = document.getElementById('btn-set-password');
    if (btn) { btn.disabled = true; btn.innerText = '변경 중...'; }

    try {
        const res  = await fetch('/api/set-new-password', {
            method : 'POST',
            headers: {
                'Content-Type' : 'application/json',
                'Authorization': `Bearer ${recoveryToken}`
            },
            body: JSON.stringify({ password: pw })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message);

        history.replaceState(null, '', location.pathname);
        showAlert('변경 완료', '비밀번호가 변경되었습니다. 새 비밀번호로 로그인해주세요.');
        if (typeof switchTab === 'function') switchTab('login');
    } catch (e) {
        showAlert('오류', e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = '비밀번호 변경 완료'; }
    }
};

// ─────────────────────────────────────────────────────────────────
// 로그아웃
// ─────────────────────────────────────────────────────────────────
window.handleLogout = function () {
    const modal = document.getElementById('custom-modal');

    function _doLogout() {
        sessionStorage.removeItem('quiz_user');
        sessionStorage.removeItem(QUIZ_STORAGE_KEY);
        sessionStorage.removeItem('quiz_token');

        const adminBtn = document.getElementById('btn-admin-menu');
        if (adminBtn) adminBtn.style.display = 'none';

        location.href = 'index.html';
    }

    if (!modal) {
        if (confirm('정말 로그아웃 하시겠습니까?')) {
            _doLogout();
        }
        return;
    }

    document.getElementById('modal-title').innerText = '로그아웃';
    document.getElementById('modal-desc').innerText  = '정말 로그아웃 하시겠습니까?';
    document.getElementById('modal-date-input').style.display = 'none';
    document.getElementById('modal-cancel-btn').style.display = 'inline-block';

    document.getElementById('modal-confirm-btn').onclick = () => {
        _doLogout();
    };
    modal.style.display = 'flex';
};

// ─────────────────────────────────────────────
// 5. 퀴즈 엔진
// [MULTI-CERT-1] examType을 함께 전송하고, 어떤 자격증으로 문제를 불러왔는지
// currentExamType에 기록해서 checkAnswer의 해설 노출 판단에 사용합니다.
// ─────────────────────────────────────────────

window.loadQuestions = async function () {
    if (!currentUser?.email) {
        showAlert('인증 필요', '로그인 후 이용해주세요.');
        return;
    }

    const examType = document.getElementById('sel-exam-type')?.value;
    if (!examType) {
        showAlert('선택 필요', '먼저 자격증을 선택해주세요.');
        return;
    }

    const area = document.getElementById('question-area');
    if (area) area.innerHTML = '<div style="text-align:center; padding:50px;">데이터 로드 중...</div>';

    const payload = {
        examType,
        grade   : document.getElementById('sel-grade')?.value,
        category: document.getElementById('sel-category')?.value,
        year    : document.getElementById('sel-year')?.value,
        limit   : parseInt(document.getElementById('sel-limit')?.value || 20)
    };

    try {
        const response = await fetch('/api/questions', {
            method : 'POST',
            headers: authHeaders(),
            body   : JSON.stringify(payload)
        });

        if (response.status === 401) {
            showAlert('세션 만료', '다시 로그인해주세요.');
            location.href = 'index.html';
            return;
        }

        allQuestions    = await response.json();
        currentIndex    = 0;
        currentExamType = examType;
        renderQuestion();
    } catch (e) {
        if (area) area.innerHTML = '<div style="text-align:center; padding:50px;">불러오기 실패</div>';
    }
};

function renderQuestion() {
    const area = document.getElementById('question-area');
    if (!area) return;
    if (!allQuestions.length) {
        area.innerHTML = '<div class="card" style="text-align:center; padding:50px;">해당 조건의 문제가 없습니다.</div>';
        return;
    }

    currentIndex = Math.max(0, Math.min(currentIndex, allQuestions.length - 1));

    const q           = allQuestions[currentIndex];
    const displayYear = q.exam_date ? String(q.exam_date).substring(0, 4) + '년' : '';

    const safeQuestion = escapeHtml(q.question);
    const safeCategory = escapeHtml(q.category);

    area.innerHTML = `
        <div class="card">
            <div class="card-header-info">
                <span>문제 ${currentIndex + 1} / ${allQuestions.length}</span>
                <span>${safeCategory} ${displayYear ? '(' + displayYear + ')' : ''}</span>
            </div>
            <div class="card-question">${safeQuestion}</div>
            <div class="choices">
                ${[1, 2, 3, 4].map(num => `
                    <button class="choice-btn" id="choice-${num}" onclick="checkAnswer(${num})">
                        <span class="choice-num">${num}</span>
                        <span class="choice-text">${escapeHtml(q['choice' + num])}</span>
                    </button>
                `).join('')}
            </div>
            <div id="result-box" class="result-box" style="display:none; margin-top:25px; text-align:center;"></div>
            <div class="card-footer">
                <button class="btn-nav" onclick="changeQuestion(-1)" ${currentIndex === 0 ? 'disabled' : ''}>이전</button>
                <button class="btn-nav active" onclick="changeQuestion(1)" ${currentIndex === allQuestions.length - 1 ? 'disabled' : ''}>다음</button>
            </div>
        </div>
    `;
}

window.checkAnswer = function (selected) {
    const q           = allQuestions[currentIndex];
    const safeCorrect = parseInt(q.answer, 10);
    const resultBox   = document.getElementById('result-box');
    const btns        = document.querySelectorAll('.choice-btn');

    btns.forEach(btn => (btn.style.pointerEvents = 'none'));

    if (![1, 2, 3, 4].includes(safeCorrect)) {
        resultBox.innerHTML     = '<div style="color:#e74c3c;">문제 데이터 오류입니다.</div>';
        resultBox.style.display = 'block';
        return;
    }

    // [QUIZ-ANALYTICS-1] 추후 분석 자료로 쓰기 위해 이 문제 풀이를 서버에 기록합니다.
    // 화면에는 아무 것도 보여주지 않는 백그라운드 호출이며, 실패해도 퀴즈 이용에는
    // 영향이 없도록 조용히 무시합니다(fire-and-forget).
    fetch('/api/quiz-log', {
        method : 'POST',
        headers: authHeaders(),
        body   : JSON.stringify({
            examType      : currentExamType,
            questionId    : q.id,
            grade         : q.grade,
            category      : q.category,
            examDate      : q.exam_date,
            selectedChoice: selected,
            correctChoice : safeCorrect
        })
    }).catch(() => {});

    let resultHTML = '';
    if (selected === safeCorrect) {
        document.getElementById(`choice-${selected}`).style.borderColor     = '#2ecc71';
        document.getElementById(`choice-${selected}`).style.backgroundColor = '#eafaf2';
        resultHTML = `<div style="color:#2ecc71; font-weight:800; font-size:1.2rem; margin-bottom:10px;">✅ 정답입니다!</div>`;
    } else {
        document.getElementById(`choice-${selected}`).style.borderColor     = '#e74c3c';
        document.getElementById(`choice-${selected}`).style.backgroundColor = '#fdf0ee';
        document.getElementById(`choice-${safeCorrect}`).style.borderColor      = '#2ecc71';
        document.getElementById(`choice-${safeCorrect}`).style.backgroundColor  = '#f0fff4';
        resultHTML = `<div style="color:#e74c3c; font-weight:800; font-size:1.2rem; margin-bottom:10px;">❌ 오답입니다.</div>
                      <div style="background:#f8f9fa; padding:12px; border-radius:8px; margin-bottom:15px;">정답은 <strong>${safeCorrect}번</strong> 입니다.</div>`;
    }

    // [MULTI-CERT-1] 해설 노출 여부는 "문제를 불러올 때 선택했던 자격증" 기준입니다.
    const examStatus = window.getCurrentExamStatus(currentExamType);
    if (q.explanation && examStatus !== 'free') {
        const isBroken = q.explanation.includes('자료 외 정보');
        const safeExp  = isBroken
            ? '해설에 문제가 있어 수정 중입니다.'
            : escapeHtml(q.explanation).replace(/\n/g, '<br>');
        resultHTML += `
            <div style="text-align:left; background:#f0f4ff; border-left:4px solid #364d79; padding:15px; border-radius:8px; margin-top:15px;">
                <strong>💡 해설:</strong><br>${safeExp}
            </div>`;
    }
    resultBox.innerHTML     = resultHTML;
    resultBox.style.display = 'block';
};

window.changeQuestion = function (step) {
    currentIndex += step;
    renderQuestion();
};

// ─────────────────────────────────────────────
// 6. 관리자 기능
// [MULTI-CERT-1] 통계/회원 목록 모두 자격증별로 재구성되었습니다.
// [MULTI-CERT-2] 관리자 대시보드가 admin.html로 독립되면서, 이 페이지
// 안에서 패널을 열고 닫던 toggleAdminPanel()은 더 이상 쓰이지 않아 제거했습니다.
// 실제 렌더링(테이블 구조 등)은 admin.html에서 담당하고,
// 여기서는 데이터를 불러오는 역할만 합니다.
// ─────────────────────────────────────────────
async function loadAdminStats() {
    try {
        const response = await fetch('/api/admin/stats', {
            method : 'POST',
            headers: authHeaders(),
            body   : JSON.stringify({})
        });
        if (response.status === 401 || response.status === 403) {
            console.error('관리자 권한 없음');
            return;
        }
        // [MULTI-CERT-1] { totalUsers, byExamType: { clinical_psych: {...}, youth_counselor: {...} } }
        const stats = await response.json();
        if (typeof window.renderAdminStats === 'function') {
            window.renderAdminStats(stats);
        }

        const vRes = await fetch('/api/admin/verify-stats', {
            method : 'POST',
            headers: authHeaders(),
            body   : JSON.stringify({})
        });
        if (vRes.ok) {
            const vStats = await vRes.json();
            if (typeof window.renderVerifyStats === 'function') {
                window.renderVerifyStats(vStats);
            }
        }
    } catch (e) { console.error('통계 실패', e); }
}

async function loadUserList() {
    try {
        const response = await fetch('/api/admin/users', {
            method : 'POST',
            headers: authHeaders(),
            body   : JSON.stringify({})
        });
        if (response.status === 401 || response.status === 403) {
            console.error('관리자 권한 없음');
            return;
        }
        // [MULTI-CERT-1] 각 유저 객체에 subscriptions: { clinical_psych: {status, expiry_date}, ... }가 포함됩니다.
        const users = await response.json();
        if (!response.ok || !Array.isArray(users)) {
            console.error('유저 목록 로드 실패:', (users && users.message) || users);
            return;
        }
        if (typeof window.renderUserList === 'function') {
            window.renderUserList(users);
        }
    } catch (e) { console.error('유저 목록 로드 실패', e); }
}

window.refreshAdminDashboard = async function () {
    const btn = document.querySelector('.btn-refresh-stats');
    if (btn) btn.innerText = '로딩 중...';
    await loadAdminStats();
    await loadUserList();
    if (btn) btn.innerText = '🔄 데이터 새로고침';
};

// ─────────────────────────────────────────────
// 7. 등급 / 기한 / 관리자 / 삭제
// [MULTI-CERT-1] 자격증별 등급 변경(update-subscription)과 사이트 관리자
// 지정(set-admin)을 분리했습니다.
// ─────────────────────────────────────────────

// 자격증별 등급 변경 (free/premium) — premium 선택 시 만료일 모달을 띄웁니다.
window.updateSubscriptionStatus = function (userId, examType, newStatus) {
    const modal      = document.getElementById('custom-modal');
    const dateInput  = document.getElementById('modal-date-input');
    const confirmBtn = document.getElementById('modal-confirm-btn');

    document.getElementById('modal-cancel-btn').style.display = 'inline-block';

    if (newStatus === 'premium') {
        document.getElementById('modal-title').innerText = `${EXAM_LABELS[examType] || examType} Premium 기한 설정`;
        document.getElementById('modal-desc').innerText  = '만료일을 선택해 주세요.';
        dateInput.style.display = 'block';

        const nextMonth = new Date();
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        dateInput.value = nextMonth.toISOString().split('T')[0];

        confirmBtn.onclick = () => {
            if (!dateInput.value) return;
            executeSubscriptionUpdate(userId, examType, newStatus, dateInput.value);
        };
    } else {
        document.getElementById('modal-title').innerText = '등급 변경';
        document.getElementById('modal-desc').innerText  = `${EXAM_LABELS[examType] || examType}을(를) FREE 등급으로 변경하시겠습니까?`;
        dateInput.style.display = 'none';
        confirmBtn.onclick = () => executeSubscriptionUpdate(userId, examType, newStatus, null);
    }
    modal.style.display = 'flex';
};

async function executeSubscriptionUpdate(userId, examType, newStatus, expiry) {
    try {
        const response = await fetch('/api/admin/update-subscription', {
            method : 'POST',
            headers: authHeaders(),
            body   : JSON.stringify({
                targetUserId: userId,
                examType,
                newStatus,
                expiryDate  : expiry
            })
        });
        if (response.ok) {
            closeCustomModal();
            showAlert('성공', '변경 사항이 저장되었습니다.');
            refreshAdminDashboard();
        } else {
            const err = await response.json();
            showAlert('오류', err.message || '변경 실패');
        }
    } catch (e) { showAlert('오류', '통신 실패'); }
}

// 자격증별 만료일만 수정 (등급은 그대로 유지)
window.setSubscriptionExpiry = function (userId, examType) {
    currentTargetUserId = userId;
    const modal     = document.getElementById('custom-modal');
    const dateInput = document.getElementById('modal-date-input');

    document.getElementById('modal-title').innerText = `${EXAM_LABELS[examType] || examType} 만료일 수정`;
    document.getElementById('modal-desc').innerText  = '새로운 만료일을 선택하세요.';
    dateInput.style.display = 'block';
    document.getElementById('modal-cancel-btn').style.display = 'inline-block';

    document.getElementById('modal-confirm-btn').onclick = async () => {
        if (!dateInput.value) return;
        try {
            const response = await fetch('/api/admin/update-subscription', {
                method : 'POST',
                headers: authHeaders(),
                body   : JSON.stringify({
                    targetUserId: userId,
                    examType,
                    expiryDate  : dateInput.value
                })
            });
            if (response.ok) {
                closeCustomModal();
                showAlert('성공', '날짜가 업데이트되었습니다.');
                refreshAdminDashboard();
            } else {
                const err = await response.json();
                showAlert('오류', err.message || '날짜 업데이트 실패');
            }
        } catch (e) { showAlert('오류', '통신 실패'); }
    };
    modal.style.display = 'flex';
};

// 사이트 전체 관리자 지정/해제 — 자격증과 무관
window.toggleSiteAdmin = function (userId, email, currentlyAdmin) {
    const modal = document.getElementById('custom-modal');
    const nextIsAdmin = !currentlyAdmin;

    document.getElementById('modal-title').innerText = '관리자 권한 변경';
    document.getElementById('modal-desc').innerText  =
        nextIsAdmin
            ? `${email} 님을 사이트 관리자로 지정하시겠습니까?`
            : `${email} 님의 관리자 권한을 해제하시겠습니까?`;
    document.getElementById('modal-date-input').style.display = 'none';
    document.getElementById('modal-cancel-btn').style.display = 'inline-block';

    document.getElementById('modal-confirm-btn').onclick = async () => {
        try {
            const response = await fetch('/api/admin/set-admin', {
                method : 'POST',
                headers: authHeaders(),
                body   : JSON.stringify({ targetUserId: userId, isAdmin: nextIsAdmin })
            });
            if (response.ok) {
                closeCustomModal();
                showAlert('성공', '관리자 권한이 변경되었습니다.');
                refreshAdminDashboard();
            } else {
                const err = await response.json();
                showAlert('오류', err.message || '변경 실패');
            }
        } catch (e) { showAlert('오류', '통신 실패'); }
    };
    modal.style.display = 'flex';
};

window.deleteUser = function (userId, email) {
    const modal = document.getElementById('custom-modal');
    document.getElementById('modal-title').innerText = '회원 삭제';
    document.getElementById('modal-desc').innerText  = `[경고] ${email} 사용자를 정말 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`;
    document.getElementById('modal-date-input').style.display = 'none';
    document.getElementById('modal-cancel-btn').style.display = 'inline-block';

    document.getElementById('modal-confirm-btn').onclick = async () => {
        try {
            const response = await fetch('/api/admin/delete-user', {
                method : 'POST',
                headers: authHeaders(),
                body   : JSON.stringify({ targetUserId: userId })
            });
            if (response.ok) {
                closeCustomModal();
                showAlert('성공', '삭제되었습니다.');
                refreshAdminDashboard();
            } else {
                const err = await response.json();
                showAlert('오류', err.message || '삭제 실패');
            }
        } catch (e) { showAlert('오류', '통신 실패'); }
    };
    modal.style.display = 'flex';
};
