// auth.js
const bcrypt = require('bcryptjs');
const validator = require('validator');
const config = require('./config');
const { get, run, all } = require('./database');

// ============================================================
// VALIDATION
// ============================================================
function validatePassword(password) {
    if (!password || typeof password !== 'string') {
        return { valid: false, error: 'Password is required' };
    }
    if (password.length < config.MIN_PASSWORD_LENGTH) {
        return { valid: false, error: `Password must be at least ${config.MIN_PASSWORD_LENGTH} characters` };
    }
    if (!/[A-Za-z]/.test(password)) {
        return { valid: false, error: 'Password must contain at least one letter' };
    }
    if (!/[0-9]/.test(password)) {
        return { valid: false, error: 'Password must contain at least one number' };
    }
    return { valid: true };
}

function validateEmail(email) {
    if (!email || !validator.isEmail(email)) {
        return { valid: false, error: 'Invalid email address' };
    }
    return { valid: true };
}

function validateUsername(username) {
    if (!username || !/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
        return { valid: false, error: 'Username must be 3-30 chars (letters, numbers, underscore)' };
    }
    return { valid: true };
}

// ============================================================
// USER CREATION
// ============================================================
async function createUser({ username, email, password, fullName = '', role = 'cashier' }) {
    const uv = validateUsername(username);
    if (!uv.valid) return { success: false, error: uv.error };

    const ev = validateEmail(email);
    if (!ev.valid) return { success: false, error: ev.error };

    const pv = validatePassword(password);
    if (!pv.valid) return { success: false, error: pv.error };

    if (!['admin', 'cashier'].includes(role)) {
        return { success: false, error: 'Role must be admin or cashier' };
    }

    const existing = await get(
        'SELECT id FROM users WHERE username = ? OR email = ?',
        [username, email.toLowerCase()]
    );
    if (existing) return { success: false, error: 'Username or email already exists' };

    const hash = bcrypt.hashSync(password, config.BCRYPT_ROUNDS);

    const result = await run(`
        INSERT INTO users (username, email, password_hash, full_name, role)
        VALUES (?, ?, ?, ?, ?)
    `, [username, email.toLowerCase(), hash, fullName, role]);

    return {
        success: true,
        userId: result.lastInsertRowid,
        user: { id: result.lastInsertRowid, username, email, role }
    };
}

// ============================================================
// ENSURE INITIAL ADMIN
// ============================================================
async function ensureAdminUser() {
    const existing = await get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (existing) return;

    const r = await createUser({
        username: config.DEFAULT_ADMIN_USER,
        email: config.DEFAULT_ADMIN_EMAIL,
        password: config.DEFAULT_ADMIN_PASS,
        fullName: 'Administrator',
        role: 'admin'
    });

    if (r.success) {
        console.log('');
        console.log('════════════════════════════════════════════');
        console.log('  ✅ Initial admin created');
        console.log(`     Username: ${config.DEFAULT_ADMIN_USER}`);
        console.log(`     Email:    ${config.DEFAULT_ADMIN_EMAIL}`);
        console.log(`     Password: ${config.DEFAULT_ADMIN_PASS}`);
        console.log('  ⚠️  CHANGE THE PASSWORD AFTER FIRST LOGIN!');
        console.log('════════════════════════════════════════════');
        console.log('');
    }
}

// ============================================================
// LOGIN
// ============================================================
async function verifyLogin(email, password, ipAddress = '', userAgent = '') {
    const normalizedEmail = (email || '').trim().toLowerCase();

    const recordAttempt = async (userId, success, reason) => {
        try {
            await run(`
                INSERT INTO login_audit
                    (user_id, email_attempted, ip_address, user_agent, success, reason)
                VALUES (?, ?, ?, ?, ?, ?)
            `, [userId, normalizedEmail, ipAddress, userAgent, success ? 1 : 0, reason]);
        } catch { /* ignore */ }
    };

    if (!validator.isEmail(normalizedEmail)) {
        await recordAttempt(null, false, 'invalid-email-format');
        return { success: false, error: 'Invalid email or password' };
    }

    const user = await get('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
    if (!user) {
        await recordAttempt(null, false, 'user-not-found');
        return { success: false, error: 'Invalid email or password' };
    }

    if (!user.is_active) {
        await recordAttempt(user.id, false, 'account-inactive');
        return { success: false, error: 'Account is disabled' };
    }

    if (user.locked_until) {
        const lockUntil = new Date(user.locked_until);
        if (lockUntil > new Date()) {
            const mins = Math.ceil((lockUntil - new Date()) / 60000);
            await recordAttempt(user.id, false, 'account-locked');
            return { success: false, error: `Account locked. Try again in ${mins} minute(s).` };
        }
    }

    const ok = bcrypt.compareSync(password || '', user.password_hash);
    if (!ok) {
        const newAttempts = (user.failed_login_attempts || 0) + 1;
        let lockUntil = null;
        if (newAttempts >= config.MAX_LOGIN_ATTEMPTS) {
            lockUntil = new Date(Date.now() + config.LOCKOUT_DURATION_MINUTES * 60000);
        }
        await run(`
            UPDATE users
            SET failed_login_attempts = ?, locked_until = ?
            WHERE id = ?
        `, [newAttempts, lockUntil, user.id]);

        await recordAttempt(user.id, false, 'wrong-password');

        if (lockUntil) {
            return {
                success: false,
                error: `Too many failed attempts. Account locked for ${config.LOCKOUT_DURATION_MINUTES} minutes.`
            };
        }
        return { success: false, error: 'Invalid email or password' };
    }

    await run(`
        UPDATE users
        SET failed_login_attempts = 0, locked_until = NULL, last_login = NOW()
        WHERE id = ?
    `, [user.id]);

    await recordAttempt(user.id, true, 'success');

    return {
        success: true,
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            full_name: user.full_name,
            role: user.role
        }
    };
}

// ============================================================
// CHANGE PASSWORD
// ============================================================
async function changePassword(userId, currentPassword, newPassword) {
    const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return { success: false, error: 'User not found' };

    if (!bcrypt.compareSync(currentPassword || '', user.password_hash)) {
        return { success: false, error: 'Current password is incorrect' };
    }

    const pv = validatePassword(newPassword);
    if (!pv.valid) return { success: false, error: pv.error };

    if (currentPassword === newPassword) {
        return { success: false, error: 'New password must be different from current' };
    }

    const hash = bcrypt.hashSync(newPassword, config.BCRYPT_ROUNDS);
    await run(`
        UPDATE users
        SET password_hash = ?, password_changed_at = NOW(), updated_at = NOW()
        WHERE id = ?
    `, [hash, userId]);

    return { success: true };
}

// ============================================================
// MIDDLEWARE
// ============================================================
async function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Unauthorized', redirect: '/login.html' });
        }
        return res.redirect('/login.html');
    }

    const now = Date.now();
    if (req.session.lastActivity && (now - req.session.lastActivity) > config.SESSION_IDLE_TIMEOUT) {
        return req.session.destroy(() => {
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ error: 'Session expired', redirect: '/login.html' });
            }
            res.redirect('/login.html?expired=1');
        });
    }
    req.session.lastActivity = now;

    try {
        const dbUser = await get('SELECT id, is_active, role FROM users WHERE id = ?', [req.session.user.id]);
        if (!dbUser || !dbUser.is_active) {
            return req.session.destroy(() => {
                res.status(401).json({ error: 'Account no longer valid', redirect: '/login.html' });
            });
        }
        req.session.user.role = dbUser.role;
        next();
    } catch (e) {
        console.error('requireAuth error:', e);
        res.status(500).json({ error: 'Server error' });
    }
}

function requireAdmin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

// ============================================================
// ROLE HELPERS
// ============================================================
function isAdmin(req) {
    return req.session?.user?.role === 'admin';
}

function isCashier(req) {
    return req.session?.user?.role === 'cashier';
}

function requireRole(...allowedRoles) {
    return (req, res, next) => {
        const role = req.session?.user?.role;
        if (!role || !allowedRoles.includes(role)) {
            return res.status(403).json({
                error: 'Forbidden',
                message: `This action requires one of: ${allowedRoles.join(', ')}`
            });
        }
        next();
    };
}

module.exports = {
    validatePassword,
    validateEmail,
    validateUsername,
    createUser,
    ensureAdminUser,
    verifyLogin,
    changePassword,
    requireAuth,
    requireAdmin,
    isAdmin,
    isCashier,
    requireRole
};
