// gameManager.js
const { run, get, all, transaction } = require('./database');
const NumberCaller = require('./numberCaller');
const { checkBingo } = require('./bingoChecker');
const commissionService = require('./services/commissionService');
const config = require('./config');

class GameManager {
    constructor(io) {
        this.io = io;
        this.activeGames = new Map();
        this.settings = null;
        // Async init runs in background
        this._ready = this._init();
    }

    async _init() {
        this.settings = await this.loadSettings();
        await this.recoverOrphanedGames();
    }

    // Call this to make sure the manager is ready before using it.
    async ready() {
        await this._ready;
    }

    // ============================================================
    // SETTINGS
    // ============================================================
    async loadSettings() {
        let s = null;
        try { s = await get('SELECT * FROM settings WHERE id = 1'); } catch (e) {}
        if (!s) s = {};
        return {
            thicket_price: s.thicket_price ?? 10,
            draw_interval: s.draw_interval ?? 4000,
            first_draw_delay_ms: s.first_draw_delay_ms ?? 3500,
            winning_patterns: s.winning_patterns ?? 'horizontal,vertical,diagonal,four_corners,full_house',
            patterns_required: s.patterns_required ?? 1,
            max_winners: s.max_winners ?? 3,
            first_winner_share: s.first_winner_share ?? 80,
            second_winner_share: s.second_winner_share ?? 15,
            third_winner_share: s.third_winner_share ?? 5,
            jackpot_enabled: s.jackpot_enabled ?? 0,
            jackpot_balance: s.jackpot_balance ?? 0,
            jackpot_contribution_pct: s.jackpot_contribution_pct ?? 10,
            jackpot_games_required: s.jackpot_games_required ?? 6,
            jackpot_games_counter: s.jackpot_games_counter ?? 0,
            jackpot_armed: s.jackpot_armed ?? 0,
            jackpot_last_won_game: s.jackpot_last_won_game ?? 0,
            commission_mode: s.commission_mode ?? 'auto',
            commission_tier: s.commission_tier ?? 0,
            commission_rate: s.commission_rate ?? 0,
            commission_min: s.commission_min ?? 0,
            commission_max: s.commission_max ?? 0
        };
    }

    async reloadSettings() {
        this.settings = await this.loadSettings();
        for (const [, g] of this.activeGames) {
            g.drawInterval = this.settings.draw_interval;
            g.winningPatterns = this.settings.winning_patterns.split(',');
            g.patternsRequired = this.settings.patterns_required;
            g.maxWinners = this.settings.max_winners;
            if (g.numberCaller) g.numberCaller.setDrawInterval(g.drawInterval);
        }
    }

    async recoverOrphanedGames() {
        try {
            const r = await run(`
                UPDATE games SET status='finished', end_time=NOW(),
                    notes='Auto-ended: server restart'
                WHERE status IN ('running', 'paused')
            `);
            if (r.changes > 0) console.log(`✅ Recovered ${r.changes} orphaned games`);
        } catch (e) {
            console.error('Recovery error:', e);
        }
    }

    // ============================================================
    // JACKPOT
    // ============================================================
    async getJackpotStatus() {
        const s = await get('SELECT * FROM settings WHERE id=1') || {};
        const required = s.jackpot_games_required ?? 6;
        const counter = s.jackpot_games_counter ?? 0;
        return {
            enabled: !!s.jackpot_enabled,
            amount: s.jackpot_balance || 0,
            contributionPct: s.jackpot_contribution_pct ?? 10,
            gamesRequired: required,
            gamesCounter: counter,
            armed: !!s.jackpot_armed,
            gamesRemaining: Math.max(0, required - counter)
        };
    }

    async setJackpotStatus(enabled) {
        await run('UPDATE settings SET jackpot_enabled=? WHERE id=1', [enabled ? 1 : 0]);
        await this.reloadSettings();
        const status = await this.getJackpotStatus();
        this.io.emit('jackpotChanged', status);
        console.log(`🎰 Jackpot ${enabled ? 'ENABLED' : 'DISABLED'}`);
        return { success: true, ...status };
    }

    // Starts the jackpot over: empties the pool and the game count so it collects from the beginning.
    // Not allowed while a game is running or paused (that game's prize depends on the pool).
    async resetJackpot(by = 'admin') {
        const busy = await get("SELECT id FROM games WHERE status IN ('running','paused') LIMIT 1");
        if (busy) return { success: false, error: 'Finish the current game before resetting the jackpot.' };

        const s = await get('SELECT jackpot_balance FROM settings WHERE id=1') || {};
        const before = Number(s.jackpot_balance || 0);
        await run('UPDATE settings SET jackpot_balance = 0, jackpot_games_counter = 0, jackpot_armed = 0 WHERE id=1');
        try {
            await run(
                `INSERT INTO jackpot_history (event_type, amount, balance_before, balance_after, notes)
                 VALUES ('reset', ?, ?, 0, ?)`,
                [before, before, `Reset by ${by}`]
            );
        } catch (e) { /* history is optional */ }

        await this.reloadSettings();
        const status = await this.getJackpotStatus();
        this.io.emit('jackpotChanged', status);
        return { success: true, ...status };
    }

    async setJackpotConfig({ contributionPct, gamesRequired }) {
        const updates = [];
        const params = [];
        if (Number.isFinite(contributionPct) && contributionPct > 0 && contributionPct <= 100) {
            updates.push('jackpot_contribution_pct = ?');
            params.push(contributionPct);
        }
        if (Number.isFinite(gamesRequired) && gamesRequired >= 1) {
            updates.push('jackpot_games_required = ?');
            params.push(Math.floor(gamesRequired));
        }
        if (!updates.length) return { success: false, error: 'No valid config provided' };
        await run(`UPDATE settings SET ${updates.join(', ')} WHERE id=1`, params);
        await this.reloadSettings();
        const status = await this.getJackpotStatus();
        this.io.emit('jackpotChanged', status);
        return { success: true, ...status };
    }

    // ============================================================
    // COMMISSION
    // ============================================================
    async getCommissionTier() {
        return commissionService.getCommissionConfig();
    }

    async setCommissionTier(tier) {
        const result = await commissionService.setManualTier(tier);
        await this.reloadSettings();
        return result;
    }

    async setAutoCommission() {
        const result = await commissionService.setAutoMode();
        await this.reloadSettings();
        return result;
    }

    calculateCommission(sales) {
        return commissionService.calculateCommission(sales);
    }

    // ============================================================
    // GAME QUERIES
    // ============================================================
    async getGame(id) {
        return await get('SELECT * FROM games WHERE id = ?', [id]);
    }

    async getWaitingGame() {
        return await get("SELECT * FROM games WHERE status='waiting' ORDER BY id DESC LIMIT 1");
    }

    async getRunningGame() {
        return await get("SELECT * FROM games WHERE status='running' ORDER BY id DESC LIMIT 1");
    }

    async getWaitingGames() {
        return await all("SELECT * FROM games WHERE status='waiting' ORDER BY id DESC");
    }

    // ---- Shared card selection (admin and cashiers see the same picked cards) ----
    getSelection(gameId) {
        const sel = this.selections && this.selections.get(gameId);
        return sel ? [...sel].map(([cartelaId, by]) => ({ cartelaId, by })) : [];
    }

    emitSelection(gameId) {
        this.io.emit('selectionChanged', { gameId, cards: this.getSelection(gameId) });
    }

    // selected=true adds the cards (replace=true swaps the whole selection), selected=false removes them
    async setSelection(user, cartelaIds, selected = true, replace = false) {
        const game = await this.getWaitingGame();
        if (!game) return { success: false, error: 'No game is ready for card selection' };

        if (!this.selections) this.selections = new Map();
        let sel = this.selections.get(game.id);
        if (!sel) { sel = new Map(); this.selections.set(game.id, sel); }

        const ids = [...new Set((cartelaIds || []).map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0))];
        const rejected = [];
        if (replace) sel.clear();

        if (selected) {
            const sold = new Set((await all('SELECT cartela_id FROM tickets WHERE game_id=?', [game.id])).map(r => Number(r.cartela_id)));
            const known = new Set((await all('SELECT id FROM cartelas')).map(r => Number(r.id)));
            for (const id of ids) {
                if (!known.has(id) || sold.has(id)) { rejected.push(id); continue; }
                if (!sel.has(id)) sel.set(id, user);
            }
        } else {
            ids.forEach(id => sel.delete(id));
        }

        this.emitSelection(game.id);
        return { success: true, gameId: game.id, cards: this.getSelection(game.id), rejected };
    }

    // Cards that were sold leave the selection
    releaseSelection(gameId, cartelaIds) {
        const sel = this.selections && this.selections.get(gameId);
        if (!sel) return;
        let changed = false;
        for (const id of cartelaIds || []) changed = sel.delete(parseInt(id, 10)) || changed;
        if (changed) this.emitSelection(gameId);
    }

    clearSelection(gameId) {
        if (this.selections && this.selections.delete(gameId)) this.emitSelection(gameId);
    }

    // Any game that is not finished yet. Only one of these may exist at a time.
    async getActiveGame() {
        return await get("SELECT * FROM games WHERE status IN ('running','paused','waiting') ORDER BY id DESC LIMIT 1");
    }

    // Runs create/start one at a time so two clicks can't make two games.
    _exclusive(fn) {
        const next = (this._lock || Promise.resolve()).then(fn, fn);
        this._lock = next.catch(() => {});
        return next;
    }

    // ============================================================
    // CREATE GAME
    // ============================================================
    async createGame(userId, gameNumber = null) {
        return this._exclusive(async () => {
        const active = await this.getActiveGame();
        if (active && active.status === 'waiting') return active;   // reuse the game already waiting
        if (active) throw new Error(`Game ${active.game_number} is still ${active.status}. Finish it before starting a new game.`);

        const num = gameNumber || this.generateGameNumber();
        const r = await run(
            `INSERT INTO games (game_number, status, draw_interval, created_by)
             VALUES (?, 'waiting', ?, ?)`,
            [num, this.settings.draw_interval, userId]
        );
        console.log(`✅ Game ${r.lastInsertRowid} created: ${num}`);
        return await this.getGame(r.lastInsertRowid);
        });
    }

    async createNewGameWithExistingCartelas(userId) {
        return this._exclusive(async () => {
        const active = await this.getActiveGame();
        if (active) throw new Error(`Game ${active.game_number} is still ${active.status}. Finish it before starting a new game.`);

        const lastGame = await get(`
            SELECT g.id, COUNT(t.id) AS cnt
            FROM games g INNER JOIN tickets t ON t.game_id = g.id
            GROUP BY g.id ORDER BY g.id DESC LIMIT 1
        `);
        if (!lastGame) throw new Error('No previous game with tickets found');

        const cartelas = await all(`
            SELECT DISTINCT c.id, c.serial, c.numbers
            FROM cartelas c
            INNER JOIN tickets t ON t.cartela_id = c.id
            WHERE t.game_id = ?
            ORDER BY c.id
        `, [lastGame.id]);

        if (cartelas.length === 0) throw new Error('No cartelas found in previous game');

        const ticketPrice = this.settings.thicket_price;
        const totalBet = cartelas.length * ticketPrice;
        const gameNumber = this.generateGameNumber();

        const result = await run(
            `INSERT INTO games (game_number, status, draw_interval, prize_pool, created_by)
             VALUES (?, 'waiting', ?, ?, ?)`,
            [gameNumber, this.settings.draw_interval, totalBet, userId]
        );
        const newGameId = result.lastInsertRowid;

        for (const c of cartelas) {
            const ticketNum = `TKT-${Date.now()}-${Math.floor(Math.random() * 10000)}-${c.id}`;
            await run(
                `INSERT INTO tickets (ticket_number, cartela_id, game_id, price, sold_by, status)
                 VALUES (?, ?, ?, ?, 'system', 'active')`,
                [ticketNum, c.id, newGameId, ticketPrice]
            );
        }

        console.log(`✅ New game ${newGameId} created with ${cartelas.length} cartelas`);
        return {
            gameId: newGameId,
            gameNumber,
            totalCartelas: cartelas.length,
            totalBetAmount: totalBet
        };
        });
    }

    generateGameNumber() {
        const n = new Date();
        const p = (x) => String(x).padStart(2, '0');
        return `GAME-${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
    }

    // ============================================================
    // START GAME
    // ============================================================
    async startGame(gameId) {
        const game = await this.getGame(gameId);
        if (!game) throw new Error('Game not found');
        if (game.status !== 'waiting') throw new Error(`Cannot start from status '${game.status}'`);

        const other = await get("SELECT * FROM games WHERE status IN ('running','paused') AND id <> ? LIMIT 1", [gameId]);
        if (other) throw new Error(`Game ${other.game_number} is still ${other.status}. Finish it before starting a new game.`);

        const tickets = await all(
            `SELECT t.*, c.numbers AS cartela_numbers
             FROM tickets t JOIN cartelas c ON c.id = t.cartela_id
             WHERE t.game_id = ? AND t.status = 'active'`,
            [gameId]
        );
        if (tickets.length === 0) throw new Error('No active tickets in this game');

        const totalSales = tickets.reduce((s, t) => s + Number(t.price), 0);

        const preTier = await commissionService.resolveTier(totalSales);
        const preCommissionPct = preTier.rate || 0;
        const preCommissionAmount = totalSales * (preCommissionPct / 100);

        const settingsForJp = await this.loadSettings();
        const preJackpotOn = !!settingsForJp.jackpot_enabled;
        const preJackpotPct = preJackpotOn ? (settingsForJp.jackpot_contribution_pct ?? 10) : 0;
        const preJackpotContrib = totalSales * (preJackpotPct / 100);

        const prizePool = Math.max(0, totalSales - preCommissionAmount - preJackpotContrib);

        // No cashier wallet needed: games start without checking or deducting a wallet balance.

        // Draw interval
        let interval = parseInt(game.draw_interval, 10);
        if (!Number.isFinite(interval) || interval < 100) {
            interval = parseInt(this.settings.draw_interval, 10);
        }
        if (!Number.isFinite(interval) || interval < 100) interval = 4000;

        const firstDrawDelay = Number.isFinite(this.settings.first_draw_delay_ms)
            ? Math.max(0, this.settings.first_draw_delay_ms)
            : 3500;

        // Jackpot
        let jackpotContribution = 0;
        let jackpotArmedThisGame = false;
        const settings = await this.loadSettings();

        if (settings.jackpot_enabled) {
            const pct = settings.jackpot_contribution_pct ?? 10;
            jackpotContribution = totalSales * (pct / 100);
            const jpBefore = settings.jackpot_balance || 0;
            const jpAfter = jpBefore + jackpotContribution;

            const newCounter = (settings.jackpot_games_counter || 0) + 1;
            const gamesRequired = settings.jackpot_games_required ?? 6;

            jackpotArmedThisGame = newCounter >= gamesRequired;
            const armedFlag = jackpotArmedThisGame ? 1 : 0;

            await run(
                `UPDATE settings SET
                    jackpot_balance = ?,
                    jackpot_games_counter = ?,
                    jackpot_armed = ?
                 WHERE id=1`,
                [jpAfter, newCounter, armedFlag]
            );

            try {
                await run(
                    `INSERT INTO jackpot_history
                        (game_id, event_type, amount, balance_before, balance_after, notes)
                     VALUES (?, 'contribution', ?, ?, ?, ?)`,
                    [gameId, jackpotContribution, jpBefore, jpAfter,
                     `Game ${gameId} contribution (${newCounter}/${gamesRequired})${jackpotArmedThisGame ? ' — ARMED' : ''}`]
                );
            } catch { /* optional */ }

            console.log(`🎰 Jackpot +${jackpotContribution.toFixed(2)} → ${jpAfter.toFixed(2)} (${newCounter}/${gamesRequired}${jackpotArmedThisGame ? ' ARMED!' : ''})`);

            this.io.emit('jackpotChanged', {
                ...await this.getJackpotStatus(),
                armedThisGame: jackpotArmedThisGame
            });

            await this.reloadSettings();
        }

        await run(
            `UPDATE games SET status='running', start_time=NOW(),
                prize_pool=?, total_cards=? WHERE id=?`,
            [prizePool, tickets.length, gameId]
        );

        const numberCaller = new NumberCaller(interval, { firstDrawDelay });

        const instance = {
            id: gameId,
            gameNumber: game.game_number,
            prizePool,
            totalSales,
            jackpotContribution,
            jackpotArmed: jackpotArmedThisGame,
            winnerCount: 0,
            maxWinners: this.settings.max_winners,
            winningPatterns: this.settings.winning_patterns.split(','),
            patternsRequired: this.settings.patterns_required,
            numberCaller,
            isPaused: false
        };
        this.activeGames.set(gameId, instance);

        numberCaller.on('numberCalled', (s) => {
            this.onNumberCalled(gameId, s);
        });

        numberCaller.on('completed', () => {
            this.endGame(gameId, 'All numbers called');
        });

        numberCaller.on('started', (info) => {
            console.log(
                `▶️  Game ${gameId} started — first draw in ${info.firstDelay}ms, ` +
                `then every ${info.interval}ms` +
                (jackpotArmedThisGame ? ' — JACKPOT GAME!' : '')
            );
        });

        numberCaller.start();
        this.clearSelection(gameId);
        await this.broadcastState();

        return {
            success: true,
            gameId,
            prizePool,
            totalTickets: tickets.length,
            totalTicketCost: totalSales,
            walletDeducted: false,
            jackpotContribution,
            jackpotArmed: jackpotArmedThisGame,
            firstDrawDelay
        };
    }

    async onNumberCalled(gameId, state) {
        const g = this.activeGames.get(gameId);
        if (!g) return;
        // Announce first: the draw must reach screens on time even if MySQL is slow.
        // Previously the emit waited for two DB writes, so a slow DB held numbers back
        // while the timer kept drawing, and they were then released all at once.
        this.io.emit('numberCalled', state.number);
        // Writes are chained per game so called_numbers keeps the draw order.
        g.saveChain = (g.saveChain || Promise.resolve()).then(async () => {
            try {
                await run('INSERT INTO called_numbers (game_id, number) VALUES (?, ?)', [gameId, state.number]);
                await run("UPDATE games SET last_draw_time = NOW() WHERE id=?", [gameId]);
            } catch (e) {
                console.error('Error saving called number:', e.message);
            }
        });
        await g.saveChain;
        this.scheduleBroadcast();
    }

    async pauseGame(gameId) {
        const g = this.activeGames.get(gameId);
        if (!g) throw new Error('Game not running');
        g.numberCaller.pause();
        g.isPaused = true;
        await run("UPDATE games SET status='paused' WHERE id=?", [gameId]);
        await this.broadcastState();
        return { success: true, isPaused: true };
    }

    async resumeGame(gameId) {
        const g = this.activeGames.get(gameId);
        if (!g) throw new Error('Game not running');
        g.numberCaller.resume();
        g.isPaused = false;
        await run("UPDATE games SET status='running' WHERE id=?", [gameId]);
        await this.broadcastState();
        return { success: true, isPaused: false };
    }

    async togglePause(gameId) {
        const game = await this.getGame(gameId);
        if (!game) throw new Error('Game not found');
        if (game.status === 'running') return await this.pauseGame(gameId);
        if (game.status === 'paused') return await this.resumeGame(gameId);
        throw new Error(`Cannot toggle from status '${game.status}'`);
    }

    // ============================================================
    // END GAME
    // ============================================================
    async endGame(gameId, reason = 'manual') {
        const g = this.activeGames.get(gameId);
        if (g?.numberCaller) g.numberCaller.stop();

        const tickets = await all('SELECT * FROM tickets WHERE game_id=?', [gameId]);
        const winners = await all('SELECT * FROM winners WHERE game_id=?', [gameId]);
        const totalSales = tickets.reduce((s, t) => s + Number(t.price || 0), 0);
        const totalPrizes = winners.reduce((s, w) => s + Number(w.prize_amount || 0), 0);

        await run(
            `UPDATE games SET status='finished', end_time=NOW(),
                total_cards=?, prize_pool=?, notes=? WHERE id=?`,
            [tickets.length, totalPrizes, `Ended: ${reason}`, gameId]
        );

        this.activeGames.delete(gameId);

        try {
            const commissions = await commissionService.recordAllCommissions(gameId);
            if (commissions.length > 0) {
                const tier = await commissionService.resolveTier(totalSales);
                console.log(`💼 Commission recorded — Tier ${tier.tier} (${tier.rate}%, ${tier.mode})`);
                this.io.to('admins').emit('commissionRecorded', { gameId, commissions, tier });
            }
        } catch (e) {
            console.error('Commission recording error:', e);
        }

        this.io.emit('gameEnded', { gameId, reason });
        await this.broadcastState();

        console.log(`🏁 Game ${gameId} ended (${reason})`);
        return { success: true, totalSales, totalPrizes };
    }

    async finishGame(gameId, reason) {
        const game = await this.getGame(gameId);
        if (!game) throw new Error('Game not found');
        if (game.status === 'finished') return { success: true, message: 'Already finished' };
        return await this.endGame(gameId, reason || 'admin finish');
    }

    // Clears the way for a fresh game: ends running/paused games (keeping their history)
    // and discards waiting games together with the cards picked for them.
    async resetAllGames(reason = 'reset from card selection') {
        return this._exclusive(async () => {
            const open = await all("SELECT id, status FROM games WHERE status IN ('running','paused','waiting') ORDER BY id");
            let ended = 0, discarded = 0;
            for (const g of open) {
                if (g.status === 'waiting') {
                    await this.resetGame(g.id, reason);
                    discarded++;
                } else {
                    await this.endGame(g.id, reason);
                    ended++;
                }
            }
            return { success: true, ended, discarded };
        });
    }

    async resetGame(gameId, reason) {
        const game = await this.getGame(gameId);
        if (!game) throw new Error('Game not found');
        if (this.activeGames.has(gameId)) {
            const g = this.activeGames.get(gameId);
            g.numberCaller.stop();
            this.activeGames.delete(gameId);
        }
        await run('DELETE FROM games WHERE id=?', [gameId]);
        this.clearSelection(gameId);
        console.log(`🗑️ Game ${gameId} deleted (${reason})`);
        await this.broadcastState();
        return { success: true };
    }

    // ============================================================
    // STATE
    // ============================================================
    async getState() {
        const running = await this.getRunningGame();
        const paused = await get("SELECT * FROM games WHERE status='paused' ORDER BY id DESC LIMIT 1");
        const waiting = await this.getWaitingGame();
        const game = running || paused || waiting;

        if (!game) return await this.emptyState();

        const gameId = game.id;
        const tickets = await all('SELECT * FROM tickets WHERE game_id=?', [gameId]);
        const called = (await all(
            'SELECT number FROM called_numbers WHERE game_id=? ORDER BY id',
            [gameId]
        )).map(r => r.number);
        const winnerCount = (await get(
            'SELECT COUNT(*) AS c FROM winners WHERE game_id=?',
            [gameId]
        )).c;

        const totalSales = tickets.reduce((s, t) => s + Number(t.price || 0), 0);
        const s = this.settings;

        const isJackpotGame = !!(s.jackpot_enabled && s.jackpot_armed && game.status === 'running');

        const tier = await commissionService.resolveTier(totalSales);
        const commissionPct = tier.rate || 0;
        const commissionAmount = totalSales * (commissionPct / 100);

        const jackpotOn = !!s.jackpot_enabled;
        const jackpotPct = jackpotOn ? (s.jackpot_contribution_pct ?? 10) : 0;
        const jackpotContrib = totalSales * (jackpotPct / 100);

        let computedPrize = Math.max(0, totalSales - commissionAmount - jackpotContrib);
        if (isJackpotGame && (s.jackpot_balance || 0) > 0) {
            computedPrize += (s.jackpot_balance || 0);
        }

        return {
            gameId,
            gameNumber: game.game_number,
            started: game.status === 'running' || game.status === 'paused',
            paused: game.status === 'paused',
            gameStatus: game.status,
            calledNumbers: called,
            lastCalled: called[called.length - 1] || null,
            lastFiveNumbers: called.slice(-5),
            remainingNumbers: 75 - called.length,
            prizePool: Math.round(computedPrize * 100) / 100,
            totalSales,
            totalTickets: tickets.length,
            winnerCount,
            jackpotEnabled: !!s.jackpot_enabled,
            jackpotBalance: s.jackpot_balance || 0,
            jackpotArmed: !!s.jackpot_armed,
            jackpotGamesCounter: s.jackpot_games_counter ?? 0,
            jackpotGamesRequired: s.jackpot_games_required ?? 6,
            jackpotGamesRemaining: Math.max(0, (s.jackpot_games_required ?? 6) - (s.jackpot_games_counter ?? 0)),
            isJackpotGame,
            jackpotPrizeForWinner: isJackpotGame ? (s.jackpot_balance || 0) : 0,
            settings: {
                drawInterval: game.draw_interval,
                firstDrawDelay: s.first_draw_delay_ms ?? 3500,
                patterns: s.winning_patterns.split(','),
                patternsRequired: s.patterns_required,
                thicketPrice: s.thicket_price,
                prizeDistribution: {
                    winner: s.prize_distribution_winner,
                    house: s.prize_distribution_house
                }
            }
        };
    }

    async getAdminState() {
        const base = await this.getState();
        const cfg = await this.getCommissionTier();
        const houseBalance = (await get('SELECT house_balance FROM settings WHERE id=1') || {}).house_balance || 0;

        const sales = base.totalSales || 0;
        const auto = await commissionService.resolveTier(sales);

        return {
            ...base,
            commission: {
                mode: cfg.mode,
                tier: cfg.tier || auto.tier,
                rate: cfg.rate || auto.rate,
                min: cfg.min || auto.min,
                max: cfg.max || auto.max,
                autoTier: auto.tier,
                autoRate: auto.rate,
                source: cfg.mode === 'manual' ? 'manual' : auto.source,
                houseBalance,
                estimatedCommission: (cfg.rate || auto.rate)
                    ? Math.round(houseBalance * ((cfg.rate || auto.rate) / 100) * 100) / 100
                    : 0
            }
        };
    }

    async emptyState() {
        const s = this.settings;
        return {
            gameId: null,
            gameNumber: null,
            started: false,
            paused: false,
            gameStatus: 'no_game',
            calledNumbers: [],
            lastCalled: null,
            lastFiveNumbers: [],
            remainingNumbers: 75,
            prizePool: 0,
            totalSales: 0,
            totalTickets: 0,
            winnerCount: 0,
            jackpotEnabled: !!s.jackpot_enabled,
            jackpotBalance: s.jackpot_balance || 0,
            jackpotArmed: !!s.jackpot_armed,
            jackpotGamesCounter: s.jackpot_games_counter ?? 0,
            jackpotGamesRequired: s.jackpot_games_required ?? 6,
            jackpotGamesRemaining: Math.max(0, (s.jackpot_games_required ?? 6) - (s.jackpot_games_counter ?? 0)),
            isJackpotGame: false,
            jackpotPrizeForWinner: 0,
            settings: {
                drawInterval: s.draw_interval,
                firstDrawDelay: s.first_draw_delay_ms ?? 3500,
                patterns: s.winning_patterns.split(','),
                patternsRequired: s.patterns_required,
                thicketPrice: s.thicket_price,
                prizeDistribution: {
                    winner: s.prize_distribution_winner,
                    house: s.prize_distribution_house
                }
            }
        };
    }

    // Coalesced broadcast: at most one full-state build in flight; extra requests
    // during a slow build collapse into a single follow-up instead of piling up.
    scheduleBroadcast() {
        if (this._bcastRunning) { this._bcastAgain = true; return; }
        this._bcastRunning = true;
        (async () => {
            do {
                this._bcastAgain = false;
                await this.broadcastState();
            } while (this._bcastAgain);
            this._bcastRunning = false;
        })();
    }

    async broadcastState() {
        try {
            this.io.emit('gameStateChanged', await this.getState());
            this.io.to('admins').emit('adminGameStateChanged', await this.getAdminState());
        } catch (e) {
            console.error('Broadcast error:', e);
        }
    }

    // ============================================================
    // CHECK CARTELA
    // ============================================================
    async checkCartela(cartelaId) {
        const game = (await this.getRunningGame())
            || await get("SELECT * FROM games WHERE status='paused' ORDER BY id DESC LIMIT 1");
        if (!game) return { valid: false, reason: 'No active game' };

        const ticket = await get(
            `SELECT t.*, c.numbers FROM tickets t
             JOIN cartelas c ON c.id = t.cartela_id
             WHERE t.cartela_id=? AND t.game_id=?`,
            [cartelaId, game.id]
        );
        if (!ticket) return { valid: false, reason: 'Ticket not found' };
        if (ticket.status === 'disqualified') return { valid: false, reason: 'Ticket already disqualified' };
        if (ticket.status === 'refunded') return { valid: false, reason: 'Ticket refunded' };
        if (ticket.status === 'winner') return { valid: false, reason: 'Ticket already recorded as winner' };

        const called = (await all(
            'SELECT number FROM called_numbers WHERE game_id=? ORDER BY id',
            [game.id]
        )).map(r => r.number);

        if (called.length === 0) return { valid: false, reason: 'No numbers called yet' };

        const lastCalled = called[called.length - 1];
        console.log(`🔍 CHECK #${cartelaId}: ${called.length} called, last=${lastCalled}`);

        const result = checkBingo(
            ticket.numbers,
            called,
            this.settings.winning_patterns.split(','),
            this.settings.patterns_required
        );

        if (!result.valid) {
            // Late claim: card has the required pattern(s) complete, but the win
            // was not completed by the last called number. Surface the flag so
            // the cashier UI announces the late-claim message and locks the card.
            if (result.late) return result;

            const cartelaNumbers = typeof ticket.numbers === 'string'
                ? ticket.numbers.split(',').map(Number)
                : ticket.numbers;
            const hasLastCalled = Array.isArray(cartelaNumbers) && cartelaNumbers.includes(lastCalled);

            if (!hasLastCalled) {
                console.log(`   ℹ️ #${cartelaId} missing last called (${lastCalled}) — not a winner (no DQ)`);
                return {
                    valid: false,
                    reason: `Does not have the last called number (${lastCalled})`
                };
            }
            return result;
        }

        const winnerCount = (await get(
            'SELECT COUNT(*) AS c FROM winners WHERE game_id=?',
            [game.id]
        )).c;

        if (winnerCount >= this.settings.max_winners) {
            return { valid: false, reason: `Max winners (${this.settings.max_winners}) reached` };
        }

        const tickets = await all('SELECT * FROM tickets WHERE game_id=?', [game.id]);
        const totalSales = tickets.reduce((s, t) => s + Number(t.price), 0);

        const tier = await commissionService.resolveTier(totalSales);
        const commissionPct = tier.rate || 0;
        const commissionAmount = totalSales * (commissionPct / 100);

        const s = await get('SELECT * FROM settings WHERE id=1');
        const jackpotOn = !!(s.jackpot_enabled);
        const jackpotPct = jackpotOn ? (s.jackpot_contribution_pct ?? 10) : 0;
        const jackpotContribution = totalSales * (jackpotPct / 100);

        const basePrize = Math.max(0, totalSales - commissionAmount - jackpotContribution);

        console.log(
            `   💼 Commission ${commissionPct}% (${tier.mode}) = ${commissionAmount.toFixed(2)} Br` +
            (jackpotOn ? ` · Jackpot ${jackpotPct}% = ${jackpotContribution.toFixed(2)} Br` : '') +
            ` · Base prize = ${basePrize.toFixed(2)} Br`
        );

        let prizeAmount = basePrize;
        let jackpotBonus = 0;

        if (s.jackpot_enabled && s.jackpot_armed && winnerCount === 0 && (s.jackpot_balance || 0) > 0) {
            jackpotBonus = Number(s.jackpot_balance);
            prizeAmount += jackpotBonus;
            console.log(`   🎰 Jackpot ARMED — pool ${jackpotBonus.toFixed(2)} Br paid on top`);
        }

        console.log(`   ✅ WINNER #${winnerCount + 1}: patterns=${result.patterns.join(',')} prize=${prizeAmount.toFixed(2)} Br`);

        return {
            valid: true,
            ticket: {
                id: ticket.id,
                ticket_number: ticket.ticket_number,
                cartela_id: ticket.cartela_id,
                price: ticket.price
            },
            type: result.patterns[0] || 'BINGO',
            patterns: result.patterns,
            prize_amount: Math.round(prizeAmount * 100) / 100,
            jackpotBonus,
            totalSales,
            commissionPct,
            commissionAmount: Math.round(commissionAmount * 100) / 100,
            jackpotPct,
            jackpotContribution: Math.round(jackpotContribution * 100) / 100,
            basePrize: Math.round(basePrize * 100) / 100,
            lastCalledNumber: lastCalled,
            winnerRank: winnerCount + 1,
            maxWinners: this.settings.max_winners
        };
    }

    // ============================================================
    // RECORD WINNER
    // ============================================================
    async recordWinner(cartelaId, prizeType, prizeAmount) {
        const game = (await this.getRunningGame())
            || await get("SELECT * FROM games WHERE status='paused' ORDER BY id DESC LIMIT 1");
        if (!game) return { success: false, error: 'No active game' };

        const winnerCount = (await get(
            'SELECT COUNT(*) AS c FROM winners WHERE game_id=?',
            [game.id]
        )).c;

        if (winnerCount >= this.settings.max_winners) {
            return { success: false, error: `Max winners (${this.settings.max_winners}) reached` };
        }

        const check = await this.checkCartela(cartelaId);
        if (!check.valid) return check;

        const rank = winnerCount + 1;
        const finalPrize = prizeAmount || check.prize_amount;

        console.log(`🏆 RECORDING WINNER #${rank}: cartela #${cartelaId}, prize ${finalPrize}`);

        await run(
            `INSERT INTO winners (game_id, ticket_id, cartela_id, prize_type,
                prize_amount, winner_rank, win_time)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`,
            [game.id, check.ticket.id, check.ticket.cartela_id,
             prizeType || check.type, finalPrize, rank]
        );

        await run("UPDATE tickets SET status='winner' WHERE id=?", [check.ticket.id]);
        await run("UPDATE games SET winner_count=? WHERE id=?", [rank, game.id]);

        const s = await get('SELECT * FROM settings WHERE id=1');
        let jackpotWon = 0;
        if (s.jackpot_enabled && s.jackpot_armed && rank === 1) {
            const jpBefore = Number(s.jackpot_balance || 0);
            if (jpBefore > 0) {
                jackpotWon = jpBefore;
                await run(
                    `UPDATE settings SET
                        jackpot_balance = 0,
                        jackpot_games_counter = 0,
                        jackpot_armed = 0,
                        jackpot_last_won_game = ?
                     WHERE id=1`,
                    [game.id]
                );

                try {
                    await run(
                        `INSERT INTO jackpot_history
                            (game_id, event_type, amount, balance_before, balance_after, notes)
                         VALUES (?, 'win', ?, ?, 0, ?)`,
                        [game.id, jpBefore, jpBefore, `Jackpot WON by cartela #${cartelaId} (rank ${rank})`]
                    );
                } catch { /* optional */ }

                console.log(`🎰💰 JACKPOT WON — ${jpBefore.toFixed(2)} Br paid. Pool reset, counter reset.`);

                this.io.emit('jackpotChanged', {
                    ...await this.getJackpotStatus(),
                    wonThisGame: true,
                    wonAmount: jpBefore
                });

                await this.reloadSettings();
            }
        }

        this.io.emit('winnerRecorded', {
            gameId: game.id,
            cartelaId,
            rank,
            prizeAmount: finalPrize,
            jackpotBonus: jackpotWon,
            patterns: check.patterns
        });

        console.log(`🏁 AUTO-ENDING game ${game.id} after winner #${rank}`);
        await this.endGame(game.id, `Winner #${rank} found — game ended`);

        return {
            success: true,
            winnerRank: rank,
            prizeAmount: finalPrize,
            jackpotBonus: jackpotWon,
            patterns: check.patterns,
            totalWinners: rank,
            maxWinners: this.settings.max_winners,
            gameEnded: true
        };
    }

    // ============================================================
    // STATS
    // ============================================================
    async getSummaryStats() {
        const houseBalance = (await get('SELECT house_balance FROM settings WHERE id=1') || {}).house_balance || 0;
        const cfg = await commissionService.getCommissionConfig();
        const sales = (await get('SELECT COALESCE(SUM(price),0) AS s FROM tickets') || {}).s || 0;
        const auto = await commissionService.resolveTier(sales);

        return {
            total_games: (await get('SELECT COUNT(*) AS c FROM games')).c,
            total_tickets_sold: (await get('SELECT COUNT(*) AS c FROM tickets')).c,
            total_revenue: sales,
            total_winners: (await get('SELECT COUNT(*) AS c FROM winners')).c,
            current_house_balance: houseBalance,
            total_cartelas: (await get('SELECT COUNT(*) AS c FROM cartelas')).c,
            wallet_balance: (await get('SELECT balance FROM wallet WHERE id=1') || {}).balance || 0,
            jackpot_balance: (await get('SELECT jackpot_balance FROM settings WHERE id=1') || {}).jackpot_balance || 0,
            commission: {
                mode: cfg.mode,
                tier: cfg.tier || auto.tier,
                rate: cfg.rate || auto.rate,
                min: cfg.min || auto.min,
                max: cfg.max || auto.max,
                autoTier: auto.tier,
                autoRate: auto.rate,
                source: cfg.mode === 'manual' ? 'manual' : auto.source,
                estimated: (cfg.rate || auto.rate)
                    ? Math.round(houseBalance * ((cfg.rate || auto.rate) / 100) * 100) / 100
                    : 0
            }
        };
    }
}

module.exports = GameManager;