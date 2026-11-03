/**
 * api.js — Browser shim with CSRF + 401 handling
 */

const API_BASE = window.location.origin;
let socket = null;
let csrfToken = null;

function readCookie(name) {
    const m = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[2]) : null;
}
function refreshCsrf() {
    csrfToken = readCookie('csrf_token');
}
refreshCsrf();

async function http(method, path, body = null) {
    let finalPath = path;
    if (method === 'GET') {
        const sep = path.includes('?') ? '&' : '?';
        finalPath = `${path}${sep}_=${Date.now()}`;
    }

    const opts = {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken || '',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache'
        },
        credentials: 'include',        // ← MUST be 'include' for session cookies
        cache: 'no-store'
    };
    if (body !== null) opts.body = JSON.stringify(body);
    // Reads give up after 12s so a stalled connection can't pile up requests (writes are never cut off)
    if (method === 'GET' && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        opts.signal = AbortSignal.timeout(12000);
    }

    const res = await fetch(API_BASE + finalPath, opts);

    // Refresh CSRF token from any updated cookie
    const newToken = readCookie('csrf_token');
    if (newToken) csrfToken = newToken;

    if (res.status === 401) {
        // ── Do NOT redirect if:
        //    1. We're already on the login page (avoid redirect loops)
        //    2. This is the /auth/me check (expected 401 when logged out)
        const onLoginPage = window.location.pathname.includes('login');
        const isMeCheck = path.startsWith('/api/auth/me');

        if (!onLoginPage && !isMeCheck) {
            const next = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.href = `/login.html?next=${next}`;
        }
        throw new Error('Unauthorized');
    }

    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
}

// ── Socket bootstrap (FIXED) ───────────────────────────────────────────────
// Old bug: the socket.io script was re-injected on every ensureSocket() call,
// and every onXxx() wrapper retried registration exactly ONCE after 200ms.
// If /socket.io/socket.io.js (~150 KB) took longer than 200 ms to load — the
// norm on a first visit over the internet — every callback (numberCalled,
// gameStateChanged, …) was silently dropped FOREVER and the game fell back
// to 2-second polling.
//
// Fix: inject the script exactly ONCE, expose whenSocketReady(cb) which
// queues subscriptions until the socket actually exists, and have every
// onXxx wrapper use it. Callbacks can no longer be dropped.
let socketReadyPromise = null;

function loadSocketIoScript() {
    return new Promise((resolve, reject) => {
        if (typeof window.io !== 'undefined') return resolve();
        // If a tag is already in flight, wait on it instead of adding another
        const inFlight = document.querySelector('script[data-socket-io]');
        if (inFlight) {
            inFlight.addEventListener('load', () => resolve(), { once: true });
            inFlight.addEventListener('error', () => reject(new Error('socket.io failed to load')), { once: true });
            return;
        }
        const s = document.createElement('script');
        s.src = '/socket.io/socket.io.js';
        s.async = false;
        s.dataset.socketIo = '1';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('socket.io failed to load'));
        document.head.appendChild(s);
    });
}

function bootstrapSocket() {
    if (!socketReadyPromise) {
        socketReadyPromise = loadSocketIoScript().then(() => initSocket());
    }
    return socketReadyPromise;
}

// Registers cb on the socket as soon as it exists (queues until then).
function whenSocketReady(cb) {
    bootstrapSocket()
        .then((sock) => { if (sock && cb) cb(sock); })
        .catch((e) => console.error('Socket bootstrap failed:', e));
}

// Kept for compatibility: returns the socket if it already exists, else null.
// New code should use whenSocketReady() / the onXxx wrappers instead.
function ensureSocket() {
    return socket || null;
}

function initSocket() {
    if (socket) return socket;
    socket = window.io(API_BASE, {
        withCredentials: true,
        // polling first: on cPanel/LiteSpeed/Passenger the WebSocket upgrade is
        // often not proxied, so trying websocket first stalls every reconnect.
        transports: ['polling', 'websocket'],
        reconnectionDelay: 500,
        reconnectionDelayMax: 3000,
        timeout: 10000
    });
    let wasDown = false;
    socket.on('connect', () => {
        console.log('🔌 Socket connected');
        window.dispatchEvent(new CustomEvent('bingo-socket-up', { detail: { recovered: wasDown } }));
        wasDown = false;
    });
    socket.on('disconnect', () => {
        wasDown = true;
        window.dispatchEvent(new Event('bingo-socket-down'));
    });
    socket.on('connect_error', (err) => {
        if (err.message === 'Unauthorized' && !window.location.pathname.includes('login')) {
            window.location.href = '/login.html';
        }
    });
    return socket;
}

window.api = {
    // ---------- AUTH ----------
    login: (email, password) => http('POST', '/api/auth/login', { email, password }),
    logout: () => http('POST', '/api/auth/logout'),
    me: () => http('GET', '/api/auth/me'),
    changePassword: (currentPassword, newPassword) =>
        http('POST', '/api/auth/change-password', { currentPassword, newPassword }),

    // ---------- PROFILE (self-edit) ----------
    getProfile: () => http('GET', '/api/profile'),
    updateProfile: (data) => http('PUT', '/api/profile', data),
    changeOwnPassword: (current_password, new_password) =>
        http('PUT', '/api/profile/password', { current_password, new_password }),

    // ---------- USERS (admin) ----------
    getUsers: () => http('GET', '/api/users'),
    createUser: (data) => http('POST', '/api/users', data),
    toggleUserActive: (userId) => http('POST', `/api/users/${userId}/toggle-active`),

    // ---------- SETTINGS ----------
    getSettings: () => http('GET', '/api/settings'),
    updateSettings: (s) => http('POST', '/api/settings', s),

    // ---------- WALLET ----------
    getWalletBalance: () => http('GET', '/api/wallet/balance'),
    getWalletTransactions: (limit, offset, type) => {
        let url = `/api/wallet/transactions?limit=${limit || 20}&offset=${offset || 0}`;
        if (type) url += `&type=${type}`;
        return http('GET', url);
    },
    creditWallet: (amount, reason, by) => http('POST', '/api/wallet/credit', { amount, reason, by }),
    debitWallet: (amount, reason, by) => http('POST', '/api/wallet/debit', { amount, reason, by }),

    // ---------- CARTELAS ----------
    getAllCartelas: () => http('GET', '/api/cartelas'),
    getCartelaById: (id) => http('GET', `/api/cartelas/${id}`),

    // ---------- TICKETS ----------
    sellTicket: (cartelaId, price, seller) => http('POST', '/api/tickets/sell', { cartelaId, price, seller }),
    bulkSellTickets: (cartelaIds, price, seller) => http('POST', '/api/tickets/bulk-sell', { cartelaIds, price, seller }),
    getGameTickets: (gameId) => http('GET', `/api/tickets/game/${gameId}`),
    getAvailableCartelas: (gameId) => http('GET', `/api/tickets/available?gameId=${gameId}`),
    refundTicket: (ticketId) => http('POST', '/api/tickets/refund', { ticketId }),
    disqualifyTicket: (identifier) => http('POST', '/api/tickets/disqualify', { identifier }),

    // ---------- GAMES ----------
    createGame: (gameNumber) => http('POST', '/api/games/create', { gameNumber }),
    createNewGameWithExistingCartelas: () => http('POST', '/api/games/create-with-existing'),
    startGame: () => http('POST', '/api/games/start'),
    pauseGame: () => http('POST', '/api/games/pause'),
    togglePauseGame: () => http('POST', '/api/games/toggle-pause'),
    finishGame: (gameId, reason) => http('POST', '/api/games/finish', { gameId, reason }),
    resetGameById: (gameId, reason) => http('POST', '/api/games/reset', { gameId, reason }),
    resetAllGames: () => http('POST', '/api/games/reset-all'),
    getSelection: () => http('GET', '/api/games/selection'),
    setSelection: (cartelaId, selected) => http('POST', '/api/games/selection', { cartelaId, selected }),
    setSelectionMany: (cartelaIds, replace = true) => http('POST', '/api/games/selection', { cartelaIds, selected: true, replace }),
    getState: () => http('GET', '/api/games/state'),
    getRunningGame: () => http('GET', '/api/games/running'),
    getWaitingGame: () => http('GET', '/api/games/waiting'),
    getWaitingGames: () => http('GET', '/api/games/waiting/all'),
    getAllGames: () => http('GET', '/api/games/all'),
    getStuckGames: () => http('GET', '/api/games/stuck'),
    getSummaryStats: () => http('GET', '/api/games/stats'),

    // ---------- WINNERS ----------
    checkCartela: (cartelaNumber) => http('POST', '/api/winners/check', { cartelaNumber }),
    recordWinner: (cartelaNumber, prizeType, prizeAmount) =>
        http('POST', '/api/winners/record', { cartelaNumber, prizeType, prizeAmount }),
    getWinners: (gameId) => http('GET', `/api/winners/game/${gameId}`),
    getWinnerByCartelaId: (cartelaId) => http('GET', `/api/winners/cartela/${cartelaId}`),
    getWinnerCountForGame: (gameId) => http('GET', `/api/winners/count/${gameId}`),

    // ---------- REPORTS ----------
    getDailyReport: (date) => http('GET', `/api/reports/daily?date=${date || ''}`),
    getWeeklyReport: (start) => http('GET', `/api/reports/weekly?start=${start || ''}`),
    getMonthlyReport: (year, month) => http('GET', `/api/reports/monthly?year=${year || ''}&month=${month || ''}`),
    exportGamesPDF: () => window.open('/api/pdf/games', '_blank'),
    exportDailyPDF: (date) => window.open(`/api/pdf/daily?date=${date || ''}`, '_blank'),
    exportWeeklyPDF: (start) => window.open(`/api/pdf/weekly?start=${start || ''}`, '_blank'),
    exportMonthlyPDF: (y, m) => window.open(`/api/pdf/monthly?year=${y || ''}&month=${m || ''}`, '_blank'),
    exportCartelasPDF: () => window.open('/api/pdf/cartelas', '_blank'),

    // ---------- COMMISSIONS ----------
    getCommissionTiers: () => http('GET', '/api/commissions/tiers'),
    getUnpaidCommissions: () => http('GET', '/api/commissions/unpaid'),
    markCommissionPaid: (commissionId) => http('POST', '/api/commissions/mark-paid', { commissionId }),
    getSellerCommissionSummary: (seller, from, to) =>
        http('GET', `/api/commissions/seller/${seller}?from=${from || ''}&to=${to || ''}`),
    calculateCommission: (totalSales) => http('POST', '/api/commissions/calculate', { totalSales }),
    getCommissionTier: () => http('GET', '/api/admin/commission'),
    setCommissionTier: (tier) => http('POST', '/api/admin/commission/manual', { tier }),
    setAutoCommission: () => http('POST', '/api/admin/commission/auto'),
    setTierRate: (tier, rate) => http('POST', '/api/admin/commission/tier-rate', { tier, rate }),

    // ---------- JACKPOT ----------
    getJackpotStatus: () => http('GET', '/api/admin/jackpot'),
    setJackpotStatus: (enabled) => http('POST', '/api/admin/jackpot', { enabled }),
    toggleJackpot: (enabled) => http('POST', '/api/admin/jackpot', { enabled }),
    setJackpotConfig: (cfg) => http('POST', '/api/admin/jackpot/config', cfg),
    resetJackpot: () => http('POST', '/api/admin/jackpot/reset'),
    toggleJackpotPublic: (enabled) => http('POST', '/api/jackpot/toggle', { enabled }),
    adjustJackpot: (amount, notes) => http('POST', '/api/jackpot/adjust', { amount, notes }),
    getJackpotHistory: () => http('GET', '/api/jackpot/history'),
    getPublicJackpotStatus: () => http('GET', '/api/jackpot/status'),

    // ---------- REAL-TIME ----------
    // FIXED: subscriptions are queued until the socket exists, so a slow
    // /socket.io/socket.io.js download can no longer drop them.
    onGameStateChanged: (cb) => whenSocketReady((s) => s.on('gameStateChanged', cb)),
    onNumberCalled: (cb) => whenSocketReady((s) => s.on('numberCalled', cb)),
    onSelectionChanged: (cb) => whenSocketReady((s) => s.on('selectionChanged', cb)),
    onGameEnded: (cb) => whenSocketReady((s) => s.on('gameEnded', cb)),
    onWinnerRecorded: (cb) => whenSocketReady((s) => s.on('winnerRecorded', cb)),
    onJackpotChanged: (cb) => whenSocketReady((s) => s.on('jackpotChanged', cb)),
    onCommissionRecorded: (cb) => whenSocketReady((s) => s.on('commissionRecorded', cb)),

    // ---------- CROSS-TAB SYNC ----------
    notifyChange: (key) => {
        try {
            localStorage.setItem(key, Date.now().toString());
            window.dispatchEvent(new CustomEvent('data-changed', { detail: { key } }));
        } catch { }
    },
    onChange: (key, cb) => {
        window.addEventListener('storage', (e) => {
            if (e.key === key) cb(e.newValue);
        });
        window.addEventListener('data-changed', (e) => {
            if (e.detail && e.detail.key === key) cb();
        });
    },
    exitApp: () => { if (confirm('Close this window?')) window.close(); }
};