// Refresh controls for the installed app (PWA), which has no browser reload button:
// a refresh tab on the right edge (desktop) and pull-down-to-refresh (touch screens).
(function () {
    'use strict';

    const standalone =
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches) ||
        window.navigator.standalone === true;
    if (!standalone) return;

    const PULL_TRIGGER_PX = 80;
    const PULL_MAX_PX = 130;

    // Reloading the game room pauses a running game, so ask first there.
    function okToRefresh() {
        try {
            if (typeof gameState !== 'undefined' && gameState && gameState.isRunning && !gameState.isPaused) {
                return window.confirm('A game is running. Refreshing will pause it. Refresh anyway?');
            }
        } catch (e) { /* not the game page */ }
        return true;
    }

    function doRefresh() {
        if (!okToRefresh()) return false;
        window.location.reload();
        return true;
    }

    const css = document.createElement('style');
    css.textContent = `
        .pwa-refresh-btn {
            position: fixed; right: 0; top: 50%; transform: translateY(-50%);
            width: 38px; height: 46px; border: none; border-radius: 10px 0 0 10px;
            background: rgba(13, 55, 103, 0.88); color: #fff; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            box-shadow: -2px 2px 10px rgba(0,0,0,0.25); opacity: 0.55;
            z-index: 2500; transition: opacity .15s ease, width .15s ease;
        }
        .pwa-refresh-btn:hover, .pwa-refresh-btn:focus-visible { opacity: 1; width: 44px; outline: none; }
        .pwa-refresh-btn svg { width: 20px; height: 20px; }
        .pwa-pull {
            position: fixed; left: 50%; top: 0; width: 40px; height: 40px; margin-left: -20px;
            border-radius: 50%; background: #fff; color: #0D3767;
            box-shadow: 0 2px 10px rgba(0,0,0,0.3);
            display: flex; align-items: center; justify-content: center;
            transform: translateY(-50px); opacity: 0; z-index: 4000; pointer-events: none;
        }
        .pwa-pull svg { width: 22px; height: 22px; }
        .pwa-pull.ready { background: #FF8500; color: #fff; }
        .pwa-pull.spin svg { animation: pwaSpin .7s linear infinite; }
        @keyframes pwaSpin { to { transform: rotate(360deg); } }
        @media (pointer: coarse) { .pwa-refresh-btn { display: none; } }
    `;
    document.head.appendChild(css);

    const icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';

    function init() {
        // Desktop / mouse: refresh tab on the right edge.
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pwa-refresh-btn';
        btn.title = 'Refresh';
        btn.setAttribute('aria-label', 'Refresh page');
        btn.innerHTML = icon;
        btn.addEventListener('click', doRefresh);
        document.body.appendChild(btn);

        // Touch: pull down from the top of the page to refresh.
        const pull = document.createElement('div');
        pull.className = 'pwa-pull';
        pull.innerHTML = icon;
        document.body.appendChild(pull);

        let startY = null;
        let dist = 0;

        const pageAtTop = () => (window.scrollY || document.documentElement.scrollTop || 0) <= 0;

        // Ignore pulls that start inside a box that is itself scrolled down
        // (e.g. the card grid), or inside a form field.
        function blockedTarget(el) {
            for (let n = el; n && n !== document.body; n = n.parentElement) {
                if (/^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)) return true;
                if (n.scrollTop > 0) return true;
            }
            return false;
        }

        function show(d) {
            const y = Math.min(d, PULL_MAX_PX) - 50;
            pull.style.transform = `translateY(${y}px) rotate(${d * 2}deg)`;
            pull.style.opacity = String(Math.min(1, d / PULL_TRIGGER_PX));
            pull.classList.toggle('ready', d >= PULL_TRIGGER_PX);
        }

        function reset() {
            startY = null; dist = 0;
            pull.style.transition = 'transform .2s ease, opacity .2s ease';
            pull.style.transform = 'translateY(-50px)';
            pull.style.opacity = '0';
            pull.classList.remove('ready', 'spin');
            setTimeout(() => { pull.style.transition = ''; }, 220);
        }

        window.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1 || !pageAtTop() || blockedTarget(e.touches[0].target)) { startY = null; return; }
            startY = e.touches[0].clientY;
            dist = 0;
        }, { passive: true });

        window.addEventListener('touchmove', (e) => {
            if (startY == null) return;
            const d = e.touches[0].clientY - startY;
            if (d <= 0 || !pageAtTop()) { if (dist > 0) reset(); else startY = null; return; }
            dist = d * 0.6;
            show(dist);
        }, { passive: true });

        window.addEventListener('touchend', () => {
            if (startY == null) return;
            if (dist >= PULL_TRIGGER_PX) {
                pull.classList.add('spin');
                pull.style.transform = 'translateY(30px)';
                if (!doRefresh()) reset();
            } else {
                reset();
            }
        }, { passive: true });

        window.addEventListener('touchcancel', reset, { passive: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
