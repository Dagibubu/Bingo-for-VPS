// server.js
const express = require('express');
const http = require('http');
const path = require('path');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');
const crypto = require('crypto');

const config = require('./config');
const { MySQLSessionStore } = require('./database');
const { ensureAdminUser, requireAuth, requireAdmin } = require('./auth');
const apiRoutes = require('./routes/api');
const pdfRoutes = require('./routes/pdf');
const GameManager = require('./gameManager');

// ============================================================
// APP SETUP
// ============================================================
const app = express();
app.set('trust proxy', true);   // ← trust all proxy hops (cPanel/LiteSpeed/Passenger)

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: true, credentials: true }
});

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// ============================================================
// NO-CACHE FOR ALL API RESPONSES
// ============================================================
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
    next();
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ============================================================
// SESSIONS
// ============================================================
const sessionMiddleware = session({
    store: new MySQLSessionStore({ clearIntervalMs: 15 * 60 * 1000 }),
    name: config.SESSION_NAME,
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: true,                     // ← honor X-Forwarded-Proto from proxy
    cookie: {
        httpOnly: true,
        secure: false,               // ← FIXED: don't drop the cookie on proxy HTTP
        sameSite: 'lax',
        maxAge: config.SESSION_MAX_AGE
    }
});

app.use(sessionMiddleware);

// ============================================================
// RATE LIMITING
// ============================================================
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down.' }
});
app.use('/api/', globalLimiter);

// ============================================================
// CSRF TOKEN
// ============================================================
app.use((req, res, next) => {
    if (!req.session) return next();
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.cookie('csrf_token', req.session.csrfToken, {
        httpOnly: false,
        sameSite: 'lax',
        secure: false,               // ← FIXED: match session cookie
        maxAge: config.SESSION_MAX_AGE
    });
    next();
});

app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (!req.path.startsWith('/api/')) return next();
    if (req.path === '/api/auth/login') return next();

    const headerToken = req.headers['x-csrf-token'];
    if (!headerToken || headerToken !== req.session?.csrfToken) {
        return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    next();
});

// ============================================================
// FAVICON
// ============================================================
app.get('/favicon.ico', (req, res) => {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🎯</text></svg>`);
});

// ============================================================
// STATIC + PAGE GUARDS
// ============================================================
app.use((req, res, next) => {
    const adminPages = ['/admin.html', '/index.html', '/settings.html', '/betsettings.html', '/game.html'];
    if (!adminPages.includes(req.path)) return next();
    if (!req.session?.user) return res.redirect('/login.html?next=' + encodeURIComponent(req.path));
    if (req.session.user.role !== 'admin') return res.redirect('/register.html?forbidden=1');
    next();
});

app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        } else if (/[\\/]assets[\\/]/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=604800');
        }
    }
}));

const ADMIN_ONLY_PAGES = ['/admin.html', '/index.html', '/settings.html', '/betsettings.html', '/game.html'];

app.get('*.html', (req, res, next) => {
    if (req.path === '/login.html') return next();

    if (!req.session?.user) {
        const next = req.path !== '/' ? `?next=${encodeURIComponent(req.path)}` : '';
        return res.redirect('/login.html' + next);
    }

    if (ADMIN_ONLY_PAGES.includes(req.path) && req.session.user.role !== 'admin') {
        console.log(`🚫 ${req.session.user.username} (${req.session.user.role}) blocked from ${req.path}`);
        return res.redirect('/register.html?forbidden=1');
    }

    next();
});

// ============================================================
// INIT ADMIN + GAME MANAGER
// ============================================================
const gameManager = new GameManager(io);
app.set('gameManager', gameManager);
app.set('io', io);

// ============================================================
// ROUTES
// ============================================================
app.use('/api', apiRoutes);
app.use('/api/pdf', requireAdmin, pdfRoutes);

app.get('/', (req, res) => {
    if (req.session?.user) {
        return res.redirect(req.session.user.role === 'admin' ? '/menu.html' : '/register.html');
    }
    res.redirect('/login.html');
});

app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.status(404).send('Not found');
});

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    if (req.path.startsWith('/api/')) {
        return res.status(500).json({ error: 'Server error' });
    }
    res.status(500).send('Server error');
});

// ============================================================
// SOCKET.IO
// ============================================================
io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, () => {
        const sess = socket.request.session;
        if (!sess || !sess.user) {
            return next(new Error('Unauthorized'));
        }
        socket.user = sess.user;
        next();
    });
});

io.on('connection', async (socket) => {
    console.log(`🔌 Connected: ${socket.user.username} (${socket.user.role})`);

    if (socket.user.role === 'admin') {
        socket.join('admins');
    }

    try {
        socket.emit('gameStateChanged', await gameManager.getState());
    } catch (e) {
        console.error('Initial state error:', e);
    }

    socket.on('disconnect', () => {
        console.log(`🔌 Disconnected: ${socket.user.username}`);
    });
});

// ============================================================
// START
// ============================================================
const LISTEN_PORT = Number(process.env.PORT) || 3000;
const LISTEN_HOST = '0.0.0.0';

(async () => {
    try {
        await ensureAdminUser();
        await gameManager.ready();
    } catch (e) {
        console.error('Startup error:', e);
        process.exit(1);
    }

    server.listen(LISTEN_PORT, LISTEN_HOST, () => {
        console.log('');
        console.log('════════════════════════════════════════════');
        console.log('  🎯 VIP BINGO Server Running (MySQL)');
        console.log('════════════════════════════════════════════');
        console.log(`  Bound:   ${LISTEN_HOST}:${LISTEN_PORT}`);
        console.log(`  Mode:    ${config.NODE_ENV}`);
        console.log(`  DB:      ${config.DB_NAME}@${config.DB_HOST}`);
        console.log('  🔐 Authentication + RBAC enabled');
        console.log('════════════════════════════════════════════');
        console.log('');
    });
})();