/**
 * socket.js — Small helper for pages that want to talk to Socket.IO directly.
 * Most pages don't need this since api.js handles everything.
 */
(function () {
    if (typeof io === 'undefined') {
        const s = document.createElement('script');
        s.src = '/socket.io/socket.io.js';
        document.head.appendChild(s);
    }
})();

window.getSocket = function () {
    if (window._sock) return window._sock;
    window._sock = io({ withCredentials: true });
    return window._sock;
};