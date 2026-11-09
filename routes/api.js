// routes/api.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { get, all, run } = require('../database');
const {
    verifyLogin,
    requireAuth,
    requireAdmin,
    changePassword,
    createUser
} = require('../auth');
const commissionService = require('../services/commissionService');
const config = require('../config');

// ============================================================
// PUBLIC AUTH ROUTES
// ============================================================

router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    const ip = req.ip || req.connection.remoteAddress || '';
    const ua = req.headers['user-agent'] || '';

    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    try {
        const result = await verifyLogin(email, password, ip, ua);
        if (!result.success) {
            return res.status(401).json({ success: false, error: result.error });
        }

        const userForSession = result.user;
        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regenerate error:', err);
                return res.status(500).json({ success: false, error: 'Session error' });
            }

            req.session.user = userForSession;
            req.session.loginAt = Date.now();
            req.session.lastActivity = Date.now();
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');

            req.session.save((err2) => {
                if (err2) {
                    console.error('Session save error:', err2);
                    return res.status(500).json({ success: false, error: 'Session error' });
                }
                res.json({
                    success: true,
                    user: userForSession,
                    csrfToken: req.session.csrfToken
                });
            });
        });
    } catch (e) {
        console.error('Login error:', e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

router.post('/auth/logout', (req, res) => {
    if (!req.session) return res.json({ success: true });
    req.session.destroy(() => {
        res.clearCookie(config.SESSION_NAME);
        res.json({ success: true });
    });
});

router.get('/auth/me', async (req, res) => {
    if (!req.session?.user) {
        return res.status(401).json({ success: false, error: 'Not logged in' });
    }
    try {
        const dbUser = await get(
            'SELECT id, username, email, full_name, role, last_login FROM users WHERE id = ?',
            [req.session.user.id]
        );
        if (!dbUser) {
            return req.session.destroy(() => {
                res.status(401).json({ success: false, error: 'User not found' });
            });
        }
        res.json({ success: true, user: dbUser });
    } catch (e) {
        console.error('auth/me error:', e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ============================================================
// ALL ROUTES BELOW REQUIRE AUTH
// ============================================================
router.use(requireAuth);

// ============================================================
// CHANGE PASSWORD
// ============================================================
router.post('/auth/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, error: 'Both passwords required' });
    }
    try {
        const r = await changePassword(req.session.user.id, currentPassword, newPassword);
        if (!r.success) return res.status(400).json(r);
        res.json({ success: true, message: 'Password changed' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ============================================================
// PROFILE
// ============================================================
router.get('/profile', async (req, res) => {
    try {
        const user = await get(
            `SELECT id, username, email, full_name, role, last_login, created_at
             FROM users WHERE id = ?`,
            [req.session.user.id]
        );
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });
        res.json({ success: true, user });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

router.put('/profile', async (req, res) => {
    const { full_name, username, email, phone } = req.body || {};

    if (!full_name || !username || !email) {
        return res.status(400).json({ success: false, error: 'Full name, username and email are required' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ success: false, error: 'Invalid email address' });
    }

    try {
        const dupeU = await get(
            'SELECT id FROM users WHERE username = ? AND id != ?',
            [username, req.session.user.id]
        );
        if (dupeU) return res.status(400).json({ success: false, error: 'Username already taken' });

        const dupeE = await get(
            'SELECT id FROM users WHERE email = ? AND id != ?',
            [email, req.session.user.id]
        );
        if (dupeE) return res.status(400).json({ success: false, error: 'Email already in use' });

        const cols = (await all(`SHOW COLUMNS FROM users`)).map(c => c.Field);
        const hasPhone = cols.includes('phone');

        if (hasPhone) {
            await run(
                `UPDATE users SET full_name = ?, username = ?, email = ?, phone = ? WHERE id = ?`,
                [full_name, username, email, phone || null, req.session.user.id]
            );
        } else {
            await run(
                `UPDATE users SET full_name = ?, username = ?, email = ? WHERE id = ?`,
                [full_name, username, email, req.session.user.id]
            );
        }

        req.session.user.full_name = full_name;
        req.session.user.username = username;
        req.session.user.email = email;

        const updated = await get(
            `SELECT id, username, email, full_name, role, last_login, created_at
             FROM users WHERE id = ?`,
            [req.session.user.id]
        );

        res.json({ success: true, user: updated });
    } catch (e) {
        console.error('Profile update error:', e);
        res.status(500).json({ success: false, error: 'Failed to update profile' });
    }
});

router.put('/profile/password', async (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
        return res.status(400).json({ success: false, error: 'Both passwords required' });
    }
    if (new_password.length < 8) {
        return res.status(400).json({ success: false, error: 'New password must be at least 8 characters' });
    }
    try {
        const r = await changePassword(req.session.user.id, current_password, new_password);
        if (!r.success) return res.status(400).json(r);
        res.json({ success: true, message: 'Password updated' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ============================================================
// USER MANAGEMENT (admin only)
// ============================================================
router.get('/users', requireAdmin, async (req, res) => {
    try {
        const users = await all(`
            SELECT id, username, email, full_name, role, is_active, last_login, created_at
            FROM users ORDER BY id DESC
        `);
        res.json(users);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/users', requireAdmin, async (req, res) => {
    const { username, email, password, fullName, role } = req.body || {};
    try {
        const r = await createUser({ username, email, password, fullName, role });
        if (!r.success) return res.status(400).json(r);
        res.json(r);
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

router.post('/users/:id/toggle-active', requireAdmin, async (req, res) => {
    const userId = parseInt(req.params.id);
    if (userId === req.session.user.id) {
        return res.status(400).json({ success: false, error: 'Cannot disable your own account' });
    }
    try {
        const user = await get('SELECT is_active FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ success: false, error: 'User not found' });

        const newState = user.is_active ? 0 : 1;
        await run('UPDATE users SET is_active = ? WHERE id = ?', [newState, userId]);

        res.json({ success: true, is_active: newState });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ============================================================
// SETTINGS
// ============================================================
router.get('/settings', async (req, res) => {
    try {
        const s = await get('SELECT * FROM settings WHERE id=1');
        res.json(s);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/settings', requireAdmin, async (req, res) => {
    try {
        const updates = req.body;
        const current = await get('SELECT * FROM settings WHERE id=1');
        const merged = { ...current, ...updates };

        await run(`
            UPDATE settings SET
                thicket_price = ?,
                draw_interval = ?,
                winning_patterns = ?,
                patterns_required = ?,
                max_winners = ?,
                first_winner_share = ?,
                second_winner_share = ?,
                third_winner_share = ?,
                prize_distribution_winner = ?,
                prize_distribution_house = ?,
                commission_enabled = ?,
                updated_at = NOW()
            WHERE id = 1
        `, [
            merged.thicket_price,
            merged.draw_interval,
            merged.winning_patterns,
            merged.patterns_required,
            merged.max_winners,
            merged.first_winner_share,
            merged.second_winner_share,
            merged.third_winner_share,
            merged.prize_distribution_winner,
            merged.prize_distribution_house,
            merged.commission_enabled
        ]);

        const gm = req.app.get('gameManager');
        if (gm) gm.reloadSettings();

        res.json({ success: true, settings: await get('SELECT * FROM settings WHERE id=1') });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ============================================================
// WALLET — admin only
// ============================================================
router.get('/wallet/balance', requireAdmin, async (req, res) => {
    try {
        const w = await get('SELECT balance FROM wallet WHERE id=1');
        res.json({ success: true, balance: w?.balance || 0 });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

router.get('/wallet/transactions', requireAdmin, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const offset = parseInt(req.query.offset) || 0;
        const txns = await all(
            'SELECT * FROM wallet_transactions ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [limit, offset]
        );
        res.json(txns);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Server error' });
    }
});

router.post('/wallet/credit', requireAdmin, async (req, res) => {
    const { amount, reason, by } = req.body;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });

    try {
        const w = await get('SELECT balance FROM wallet WHERE id=1');
        const before = w.balance;
        const after = before + amt;
        const txId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        await run(
            `INSERT INTO wallet_transactions
                (transaction_id, transaction_type, amount, balance_before, balance_after, description, created_by)
             VALUES (?, 'deposit', ?, ?, ?, ?, ?)`,
            [txId, amt, before, after, reason || 'Admin credit', by || 'admin']
        );
        await run('UPDATE wallet SET balance=?, updated_at=NOW() WHERE id=1', [after]);

        res.json({ success: true, balance: after });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

router.post('/wallet/debit', requireAdmin, async (req, res) => {
    const { amount, reason, by } = req.body;
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).json({ success: false, error: 'Invalid amount' });

    try {
        const w = await get('SELECT balance FROM wallet WHERE id=1');
        if (w.balance < amt) return res.status(400).json({ success: false, error: 'Insufficient balance' });

        const before = w.balance;
        const after = before - amt;
        const txId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        await run(
            `INSERT INTO wallet_transactions
                (transaction_id, transaction_type, amount, balance_before, balance_after, description, created_by)
             VALUES (?, 'withdrawal', ?, ?, ?, ?, ?)`,
            [txId, amt, before, after, reason || 'Admin debit', by || 'admin']
        );
        await run('UPDATE wallet SET balance=?, updated_at=NOW() WHERE id=1', [after]);

        res.json({ success: true, balance: after });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ============================================================
// CARTELAS
// ============================================================
router.get('/cartelas', async (req, res) => {
    try {
        const cartelas = await all('SELECT * FROM cartelas ORDER BY id');
        res.json(cartelas);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/cartelas/:id', async (req, res) => {
    try {
        const c = await get('SELECT * FROM cartelas WHERE id=?', [req.params.id]);
        if (!c) return res.status(404).json({ error: 'Not found' });
        res.json(c);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// TICKETS
// ============================================================
router.post('/tickets/sell', async (req, res) => {
    const { cartelaId, price, seller } = req.body;
    try {
        const game = await get("SELECT * FROM games WHERE status='waiting' ORDER BY id DESC LIMIT 1");
        if (!game) return res.status(400).json({ success: false, error: 'No waiting game' });

        const existing = await get(
            'SELECT id FROM tickets WHERE cartela_id=? AND game_id=?',
            [cartelaId, game.id]
        );
        if (existing) return res.status(400).json({ success: false, error: 'Cartela already sold' });

        const ticketNum = `TKT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const priceRow = await get('SELECT thicket_price AS p FROM settings WHERE id=1');
        const finalPrice = (req.session.user.role === 'admin' && price) ? price : priceRow.p;
        const sellerName = (req.session.user.role === 'admin' && seller) || req.session.user.username;

        await run(
            `INSERT INTO tickets (ticket_number, cartela_id, game_id, price, sold_by, status)
             VALUES (?, ?, ?, ?, ?, 'active')`,
            [ticketNum, cartelaId, game.id, finalPrice, sellerName]
        );

        await run(
            `UPDATE games SET total_cards = total_cards + 1,
                prize_pool = prize_pool + ? WHERE id=?`,
            [finalPrice, game.id]
        );

        req.app.get('gameManager')?.releaseSelection(game.id, [cartelaId]);

        res.json({
            success: true,
            ticket: {
                ticket_number: ticketNum,
                cartela_id: cartelaId,
                game_id: game.id,
                price: finalPrice
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

router.post('/tickets/bulk-sell', async (req, res) => {
    const { cartelaIds, price, seller } = req.body;
    if (!Array.isArray(cartelaIds)) {
        return res.status(400).json({ success: false, error: 'cartelaIds must be array' });
    }

    try {
        const game = await get("SELECT * FROM games WHERE status='waiting' ORDER BY id DESC LIMIT 1");
        if (!game) return res.status(400).json({ success: false, error: 'No waiting game' });

        const priceRow = await get('SELECT thicket_price AS p FROM settings WHERE id=1');
        const finalPrice = (req.session.user.role === 'admin' && price) ? price : priceRow.p;
        const sellerName = (req.session.user.role === 'admin' && seller) || req.session.user.username;
        const success = [];
        const failed = [];

        for (const cartelaId of cartelaIds) {
            try {
                const existing = await get(
                    'SELECT id FROM tickets WHERE cartela_id=? AND game_id=?',
                    [cartelaId, game.id]
                );
                if (existing) { failed.push({ cartelaId, error: 'Already sold' }); continue; }

                const ticketNum = `TKT-${Date.now()}-${Math.floor(Math.random() * 10000)}-${cartelaId}`;
                await run(
                    `INSERT INTO tickets (ticket_number, cartela_id, game_id, price, sold_by, status)
                     VALUES (?, ?, ?, ?, ?, 'active')`,
                    [ticketNum, cartelaId, game.id, finalPrice, sellerName]
                );
                await run(
                    `UPDATE games SET total_cards = total_cards + 1,
                        prize_pool = prize_pool + ? WHERE id=?`,
                    [finalPrice, game.id]
                );
                success.push(cartelaId);
            } catch (e) {
                failed.push({ cartelaId, error: e.message });
            }
        }

        req.app.get('gameManager')?.releaseSelection(game.id, success);
        res.json({ success: true, sold: success.length, failed, gameId: game.id });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

router.get('/tickets/game/:gameId', async (req, res) => {
    try {
        const tickets = await all(
            `SELECT t.*, c.serial AS cartela_serial, c.numbers AS cartela_numbers
             FROM tickets t JOIN cartelas c ON c.id = t.cartela_id
             WHERE t.game_id=? ORDER BY t.id DESC`,
            [req.params.gameId]
        );
        res.json(tickets);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/tickets/available', async (req, res) => {
    const gameId = req.query.gameId;
    if (!gameId) return res.status(400).json({ error: 'gameId required' });
    try {
        const cartelas = await all(
            `SELECT * FROM cartelas WHERE id NOT IN (
                SELECT cartela_id FROM tickets WHERE game_id=?
            ) ORDER BY serial`,
            [gameId]
        );
        res.json(cartelas);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/tickets/refund', requireAdmin, async (req, res) => {
    const { ticketId } = req.body;
    try {
        const t = await get('SELECT * FROM tickets WHERE id=?', [ticketId]);
        if (!t) return res.status(404).json({ success: false, error: 'Ticket not found' });
        if (t.status !== 'active') return res.status(400).json({ success: false, error: `Cannot refund status '${t.status}'` });

        await run("UPDATE tickets SET status='refunded' WHERE id=?", [ticketId]);
        await run('UPDATE games SET prize_pool = prize_pool - ? WHERE id=?', [t.price, t.game_id]);
        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

router.post('/tickets/disqualify', async (req, res) => {
    const { identifier } = req.body;
    try {
        const game = await get("SELECT * FROM games WHERE status IN ('running','paused') ORDER BY id DESC LIMIT 1");
        if (!game) return res.status(400).json({ success: false, error: 'No active game' });

        const t = await get(
            'SELECT * FROM tickets WHERE game_id=? AND cartela_id=? AND status=?',
            [game.id, identifier, 'active']
        );
        if (!t) return res.status(404).json({ success: false, error: 'Ticket not found' });

        await run("UPDATE tickets SET status='disqualified' WHERE id=?", [t.id]);
        res.json({ success: true, ticketId: t.id });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// ============================================================
// GAMES
// ============================================================
router.post('/games/create', async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        const game = await gm.createGame(req.session.user.id, req.body.gameNumber);
        res.json({ success: true, gameId: game.id, gameNumber: game.game_number });
    } catch (e) {
        console.error(e);
        res.status(400).json({ success: false, error: e.message });
    }
});

router.post('/games/create-with-existing', requireAdmin, async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        const r = await gm.createNewGameWithExistingCartelas(req.session.user.id);
        res.json({ success: true, ...r });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

router.post('/games/start', requireAdmin, async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        const waiting = await gm.getWaitingGame();
        if (!waiting) return res.status(400).json({ success: false, error: 'No waiting game' });

        const result = await gm.startGame(waiting.id);
        
        // Immediately push the fresh state to all connected clients
        if (gm.broadcastState) gm.broadcastState();
        
        res.json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

router.post('/games/pause', requireAdmin, async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        const running = await gm.getRunningGame();
        if (!running) return res.status(400).json({ success: false, error: 'No running game' });
        
        const result = await gm.pauseGame(running.id);
        
        // Immediately push the fresh state to all connected clients
        if (gm.broadcastState) gm.broadcastState();
        
        res.json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

router.post('/games/toggle-pause', requireAdmin, async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        const running = await gm.getRunningGame();
        const paused = await get("SELECT * FROM games WHERE status='paused' ORDER BY id DESC LIMIT 1");
        const game = running || paused;
        if (!game) return res.status(400).json({ success: false, error: 'No active game' });
        
        const result = await gm.togglePause(game.id);
        
        // Immediately push the fresh state to all connected clients
        if (gm.broadcastState) gm.broadcastState();
        
        res.json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

router.post('/games/finish', requireAdmin, async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        const { gameId, reason } = req.body;
        
        const result = await gm.finishGame(gameId, reason);
        
        // Immediately push the fresh state to all connected clients
        if (gm.broadcastState) gm.broadcastState();
        
        res.json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

router.post('/games/reset', requireAdmin, async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        const { gameId, reason } = req.body;
        
        const result = await gm.resetGame(gameId, reason);
        
        // Immediately push the fresh state to all connected clients
        if (gm.broadcastState) gm.broadcastState();
        
        res.json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

router.post('/games/reset-all', requireAdmin, async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        const result = await gm.resetAllGames('Reset from card selection by ' + (req.session.user.username || 'user'));
        if (gm.broadcastState) gm.broadcastState();
        res.json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

router.get('/games/selection', async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        const game = await gm.getWaitingGame();
        res.json({ gameId: game ? game.id : null, cards: game ? gm.getSelection(game.id) : [] });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/games/selection', async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        const b = req.body || {};
        if (b.replace && req.session.user.role !== 'admin') {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        const ids = Array.isArray(b.cartelaIds) ? b.cartelaIds : [b.cartelaId];
        const result = await gm.setSelection(req.session.user.username, ids, b.selected !== false, !!b.replace);
        res.status(result.success ? 200 : 400).json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

router.get('/games/state', async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        // Returns the full authoritative state (calledNumbers, lastCalled, status, etc)
        res.json(await gm.getState());
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/games/running', async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        res.json(await gm.getRunningGame());
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/games/waiting', async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        res.json(await gm.getWaitingGame());
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/games/waiting/all', async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        res.json(await gm.getWaitingGames());
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/games/all', async (req, res) => {
    try {
        const games = await all(`
            SELECT g.*,
                COUNT(DISTINCT t.id) AS ticket_count,
                COALESCE(SUM(t.price), 0) AS total_sales,
                (SELECT COUNT(*) FROM winners w WHERE w.game_id=g.id) AS winner_count
            FROM games g
            LEFT JOIN tickets t ON t.game_id = g.id
            GROUP BY g.id
            ORDER BY g.id DESC
        `);
        res.json(games);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/games/stuck', async (req, res) => {
    try {
        const stuck = await all(`
            SELECT id, game_number, status, last_heartbeat, last_draw_time
            FROM games
            WHERE status IN ('running','paused')
            AND (last_heartbeat IS NULL OR last_heartbeat < DATE_SUB(NOW(), INTERVAL 30 MINUTE))
        `);
        res.json(stuck);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/games/stats', requireAdmin, async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        res.json(await gm.getSummaryStats());
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// WINNERS
// ============================================================
router.post('/winners/check', async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        const { cartelaNumber } = req.body;
        const result = await gm.checkCartela(cartelaNumber);
        res.json(result);
    } catch (e) {
        res.status(500).json({ valid: false, error: e.message });
    }
});

router.post('/winners/record', async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        const { cartelaNumber, prizeType, prizeAmount } = req.body;
        const result = await gm.recordWinner(cartelaNumber, prizeType, prizeAmount);
        res.json(result);
        
        // Immediately push the fresh state to all connected clients
        if (gm.broadcastState) gm.broadcastState();
        
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/winners/game/:gameId', async (req, res) => {
    try {
        const winners = await all(`
            SELECT w.*, t.ticket_number, t.status AS ticket_status,
                   c.serial AS cartela_serial, c.numbers AS cartela_numbers
            FROM winners w
            JOIN tickets t ON t.id = w.ticket_id
            JOIN cartelas c ON c.id = w.cartela_id
            WHERE w.game_id=?
            ORDER BY w.winner_rank ASC
        `, [req.params.gameId]);
        res.json(winners);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/winners/cartela/:cartelaId', async (req, res) => {
    try {
        const w = await get(`
            SELECT w.*, t.ticket_number
            FROM winners w JOIN tickets t ON t.id = w.ticket_id
            WHERE w.cartela_id=?
            ORDER BY w.id DESC LIMIT 1
        `, [req.params.cartelaId]);
        res.json(w);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/winners/count/:gameId', async (req, res) => {
    try {
        const r = await get('SELECT COUNT(*) AS c FROM winners WHERE game_id=?', [req.params.gameId]);
        res.json({ count: r.c });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ============================================================
// REPORTS
// ============================================================
// Totals for any date range (inclusive): games started, cards sold in those
// games (refunds excluded) and the commission recorded when they ended.
router.get('/reports/range', requireAdmin, async (req, res) => {
    try {
        const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
        let { from, to } = req.query;
        if (!isDate(from) || !isDate(to)) {
            return res.status(400).json({ success: false, error: 'from and to must be YYYY-MM-DD' });
        }
        if (from > to) [from, to] = [to, from];
        const stats = await get(`
            SELECT
                (SELECT COUNT(*) FROM games g
                    WHERE DATE(g.start_time) BETWEEN ? AND ?) AS total_games,
                (SELECT COUNT(*) FROM tickets t JOIN games g ON g.id = t.game_id
                    WHERE DATE(g.start_time) BETWEEN ? AND ? AND t.status <> 'refunded') AS total_cards,
                (SELECT COALESCE(SUM(w.amount), 0) FROM wallet_transactions w JOIN games g ON g.id = w.reference_id
                    WHERE w.transaction_type = 'commission' AND DATE(g.start_time) BETWEEN ? AND ?) AS total_commission
        `, [from, to, from, to, from, to]);
        res.json({ success: true, report: { from, to, ...stats } });
    } catch (e) {
        console.error('Range report error:', e);
        res.status(500).json({ success: false, error: 'Failed to build report' });
    }
});

// Daily/weekly/monthly use the same basis as /reports/range: games started in the
// period, the non-refunded cards in those games, and the commission recorded for them.
async function periodStats(from, to) {
    return await get(`
        SELECT
            (SELECT COUNT(*) FROM games g
                WHERE DATE(g.start_time) BETWEEN ? AND ?) AS total_games,
            (SELECT COUNT(*) FROM tickets t JOIN games g ON g.id = t.game_id
                WHERE DATE(g.start_time) BETWEEN ? AND ? AND t.status <> 'refunded') AS total_tickets_sold,
            (SELECT COALESCE(SUM(t.price), 0) FROM tickets t JOIN games g ON g.id = t.game_id
                WHERE DATE(g.start_time) BETWEEN ? AND ? AND t.status <> 'refunded') AS total_sales,
            (SELECT COUNT(*) FROM winners w JOIN games g ON g.id = w.game_id
                WHERE DATE(g.start_time) BETWEEN ? AND ?) AS total_winners,
            (SELECT COALESCE(SUM(w.prize_amount), 0) FROM winners w JOIN games g ON g.id = w.game_id
                WHERE DATE(g.start_time) BETWEEN ? AND ?) AS total_prizes,
            (SELECT COALESCE(SUM(wt.amount), 0) FROM wallet_transactions wt JOIN games g ON g.id = wt.reference_id
                WHERE wt.transaction_type = 'commission' AND DATE(g.start_time) BETWEEN ? AND ?) AS total_commission,
            (SELECT COALESCE(SUM(jh.amount), 0) FROM jackpot_history jh JOIN games g ON g.id = jh.game_id
                WHERE jh.event_type = 'win' AND DATE(g.start_time) BETWEEN ? AND ?) AS total_jackpot_paid,
            (SELECT COUNT(*) FROM jackpot_history jh JOIN games g ON g.id = jh.game_id
                WHERE jh.event_type = 'win' AND DATE(g.start_time) BETWEEN ? AND ?) AS jackpots_won
    `, [from, to, from, to, from, to, from, to, from, to, from, to, from, to, from, to]);
}

const isYmd = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const localYmd = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

router.get('/reports/daily', requireAdmin, async (req, res) => {
    try {
        const date = isYmd(req.query.date) ? req.query.date : localYmd();
        const stats = await periodStats(date, date);
        res.json({ success: true, report: { report_date: date, ...stats } });
    } catch (e) { console.error('Daily report error:', e); res.status(500).json({ success: false, error: 'Server error' }); }
});

router.get('/reports/weekly', requireAdmin, async (req, res) => {
    try {
        const start = isYmd(req.query.start) ? req.query.start : localYmd(new Date(Date.now() - 7 * 86400000));
        const end = localYmd();
        const stats = await periodStats(start, end);
        res.json({ success: true, report: { start_date: start, end_date: end, ...stats } });
    } catch (e) { console.error('Weekly report error:', e); res.status(500).json({ success: false, error: 'Server error' }); }
});

router.get('/reports/monthly', requireAdmin, async (req, res) => {
    try {
        const now = new Date();
        const year = parseInt(req.query.year) || now.getFullYear();
        const month = parseInt(req.query.month) || (now.getMonth() + 1);
        const start = `${year}-${String(month).padStart(2, '0')}-01`;
        const end = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`;
        const stats = await periodStats(start, end);
        res.json({ success: true, report: { year, month, ...stats } });
    } catch (e) { console.error('Monthly report error:', e); res.status(500).json({ success: false, error: 'Server error' }); }
});

// ============================================================
// COMMISSIONS — admin only
// ============================================================
router.get('/commissions/tiers', requireAdmin, (req, res) => {
    res.json(commissionService.tiersList ? commissionService.tiersList() : []);
});

router.get('/commissions/unpaid', requireAdmin, async (req, res) => {
    try {
        if (typeof commissionService.getUnpaidCommissions === 'function') {
            const r = await commissionService.getUnpaidCommissions();
            return res.json(r);
        }
        res.json([]);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/commissions/mark-paid', requireAdmin, async (req, res) => {
    try {
        const { commissionId } = req.body;
        if (typeof commissionService.markCommissionPaid === 'function') {
            const r = await commissionService.markCommissionPaid(commissionId, req.session.user.username);
            return res.json(r);
        }
        res.status(501).json({ success: false, error: 'Not implemented' });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.get('/commissions/seller/:seller', requireAdmin, async (req, res) => {
    try {
        const { seller } = req.params;
        const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
        const to = req.query.to || new Date().toISOString().split('T')[0];
        if (typeof commissionService.getSellerSummary === 'function') {
            const r = await commissionService.getSellerSummary(seller, from, to);
            return res.json(r);
        }
        res.json({ seller, from, to, commissions: [] });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/commissions/calculate', requireAdmin, (req, res) => {
    const { totalSales } = req.body;
    res.json(commissionService.calculateCommission(parseFloat(totalSales) || 0));
});

// ============================================================
// COMMISSION CONFIG (auto/manual) — admin only
// ============================================================
router.get('/admin/commission', requireAdmin, async (req, res) => {
    try {
        const cfg = await commissionService.getCommissionConfig();
        res.json(cfg);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/admin/commission/manual', requireAdmin, async (req, res) => {
    try {
        const tier = parseInt(req.body.tier, 10);
        if (!tier && tier !== 0) {
            return res.status(400).json({ success: false, error: 'tier is required' });
        }
        const result = await commissionService.setManualTier(tier);

        const gm = req.app.get('gameManager');
        if (gm) gm.reloadSettings();

        res.json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

router.post('/admin/commission/auto', requireAdmin, async (req, res) => {
    try {
        const result = await commissionService.setAutoMode();

        const gm = req.app.get('gameManager');
        if (gm) gm.reloadSettings();

        res.json(result);
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

router.post('/admin/commission/tier-rate', requireAdmin, async (req, res) => {
    try {
        const tier = parseInt(req.body.tier, 10);
        const rate = parseFloat(req.body.rate);

        if (!Number.isFinite(tier)) {
            return res.status(400).json({ success: false, error: 'tier is required' });
        }
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
            return res.status(400).json({ success: false, error: 'rate must be between 0 and 100' });
        }

        if (typeof commissionService.setTierRate !== 'function') {
            return res.status(500).json({ success: false, error: 'setTierRate not implemented' });
        }

        const result = await commissionService.setTierRate(tier, rate);

        const gm = req.app.get('gameManager');
        if (gm) gm.reloadSettings();

        const io = req.app.get('io');
        if (io) {
            io.to('admins').emit('commissionTierRateUpdated', {
                tier, rate, tiers: commissionService.tiersList()
            });
        }

        console.log(`✏️  Admin updated Tier ${tier} rate → ${rate}%`);
        res.json(result);
    } catch (e) {
        console.error('Tier rate update failed:', e);
        res.status(400).json({ success: false, error: e.message });
    }
});

// ============================================================
// JACKPOT — admin only
// ============================================================
router.get('/admin/jackpot', requireAdmin, async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        if (gm) return res.json(await gm.getJackpotStatus());

        const s = await get('SELECT jackpot_enabled, jackpot_balance, jackpot_contribution_pct, jackpot_games_required, jackpot_games_counter, jackpot_armed FROM settings WHERE id=1');
        res.json({
            enabled: !!s?.jackpot_enabled,
            amount: s?.jackpot_balance || 0,
            contributionPct: s?.jackpot_contribution_pct ?? 10,
            gamesRequired: s?.jackpot_games_required ?? 6,
            gamesCounter: s?.jackpot_games_counter ?? 0,
            armed: !!s?.jackpot_armed,
            gamesRemaining: Math.max(0, (s?.jackpot_games_required ?? 6) - (s?.jackpot_games_counter ?? 0))
        });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/admin/jackpot', requireAdmin, async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        if (!gm) return res.status(500).json({ success: false, error: 'Game manager unavailable' });
        res.json(await gm.setJackpotStatus(!!req.body.enabled));
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

router.post('/admin/jackpot/reset', async (req, res) => {   // any signed-in user (cashiers included)
    try {
        const gm = req.app.get('gameManager');
        const result = await gm.resetJackpot(req.session.user.username || 'admin');
        res.status(result.success ? 200 : 400).json(result);
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

router.post('/admin/jackpot/config', requireAdmin, async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        if (!gm) return res.status(500).json({ success: false, error: 'Game manager unavailable' });
        const contributionPct = parseFloat(req.body.contributionPct);
        const gamesRequired = parseInt(req.body.gamesRequired, 10);
        res.json(await gm.setJackpotConfig({ contributionPct, gamesRequired }));
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// ============================================================
// PUBLIC JACKPOT STATUS
// ============================================================
router.get('/jackpot/status', async (req, res) => {
    try {
        const gm = req.app.get('gameManager');
        if (gm) return res.json(await gm.getJackpotStatus());

        const s = await get('SELECT jackpot_enabled, jackpot_balance, jackpot_contribution_pct, jackpot_games_required, jackpot_games_counter, jackpot_armed FROM settings WHERE id=1');
        res.json({
            enabled: !!s?.jackpot_enabled,
            amount: s?.jackpot_balance || 0,
            contributionPct: s?.jackpot_contribution_pct ?? 10,
            gamesRequired: s?.jackpot_games_required ?? 6,
            gamesCounter: s?.jackpot_games_counter ?? 0,
            armed: !!s?.jackpot_armed,
            gamesRemaining: Math.max(0, (s?.jackpot_games_required ?? 6) - (s?.jackpot_games_counter ?? 0))
        });
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/jackpot/toggle', async (req, res) => {   // any signed-in user (cashiers included)
    try {
        const gm = req.app.get('gameManager');
        if (!gm) return res.status(500).json({ success: false, error: 'Game manager unavailable' });
        // A running game's prize includes the jackpot, so don't change it mid-game
        const busy = await get("SELECT id FROM games WHERE status IN ('running','paused') LIMIT 1");
        if (busy) return res.status(400).json({ success: false, error: 'Finish the current game before turning the jackpot on or off.' });
        res.json(await gm.setJackpotStatus(!!req.body.enabled));
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

router.post('/jackpot/adjust', requireAdmin, async (req, res) => {
    try {
        const { amount, notes } = req.body;
        const amt = parseFloat(amount);
        if (isNaN(amt)) return res.status(400).json({ error: 'Invalid amount' });

        const s = await get('SELECT jackpot_balance FROM settings WHERE id=1');
        const before = s.jackpot_balance || 0;
        const after = Math.max(0, before + amt);

        await run('UPDATE settings SET jackpot_balance=? WHERE id=1', [after]);
        try {
            await run(`INSERT INTO jackpot_history
                    (event_type, amount, balance_before, balance_after, notes)
                 VALUES (?, ?, ?, ?, ?)`,
                [amt > 0 ? 'manual_add' : 'manual_remove', Math.abs(amt), before, after, notes || 'Admin adjustment']);
        } catch { /* optional */ }

        const gm = req.app.get('gameManager');
        if (gm) gm.reloadSettings();

        res.json({ success: true, balance: after });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

router.get('/jackpot/history', requireAdmin, async (req, res) => {
    try {
        const history = await all('SELECT * FROM jackpot_history ORDER BY id DESC LIMIT 100');
        res.json(history);
    } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;