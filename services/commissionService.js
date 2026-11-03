// services/commissionService.js
const { run, get, all } = require('../database');

// ============================================================
// DEFAULT TIER DEFINITIONS
// ============================================================
const DEFAULT_TIERS = [
    { tier: 0, min: 0,    max: 499,  rate: 10 },
    { tier: 1, min: 500,  max: 1000, rate: 15 },
    { tier: 2, min: 1100, max: 1500, rate: 30 },
    { tier: 3, min: 1600, max: 3000, rate: 35 },
    { tier: 4, min: 3100, max: 6000, rate: 40 }
];

// ============================================================
// SEED TIERS (call once at startup — safe to call many times)
// ============================================================
async function ensureTiersTable() {
    try {
        for (const t of DEFAULT_TIERS) {
            const existing = await get('SELECT tier FROM commission_tiers WHERE tier = ?', [t.tier]);
            if (!existing) {
                await run(
                    `INSERT INTO commission_tiers (tier, min, max, rate)
                     VALUES (?, ?, ?, ?)`,
                    [t.tier, t.min, t.max, t.rate]
                );
                console.log(`🌱 Seeded Tier ${t.tier} → ${t.rate}%`);
            }
        }
    } catch (e) {
        console.error('ensureTiersTable error:', e.message);
    }
}

// ============================================================
// LOAD TIERS FROM DB (with fallback to defaults)
// ============================================================
async function loadTiers() {
    try {
        const rows = await all('SELECT tier, min, max, rate FROM commission_tiers ORDER BY tier');
        if (rows && rows.length) return rows;
    } catch (e) {
        console.warn('loadTiers: DB read failed, using defaults —', e.message);
    }
    return DEFAULT_TIERS.map(t => ({ ...t }));
}

/**
 * Public accessor — always reads latest rates from DB.
 * Now async because it hits the database.
 */
async function tiersList() {
    return await loadTiers();
}

/**
 * Legacy accessor. Since the underlying load is async now, the
 * synchronous iterator methods can't be supported safely.
 * Anything using `TIERS.map/find/forEach` should switch to
 * `await tiersList()`.
 */
const TIERS = {
    valueOf() { throw new Error('TIERS is async now — use await tiersList()'); },
    get length() { throw new Error('TIERS is async now — use await tiersList()'); }
};

// ============================================================
// TIER RESOLUTION
// ============================================================
async function tierFromSales(sales) {
    if (!Number.isFinite(sales) || sales < 0) return null;

    const tiers = await loadTiers();
    if (!tiers.length) return null;

    const tier0 = tiers.find(t => t.tier === 0) || tiers[0];
    if (sales <= tier0.max) return { ...tier0 };

    for (const t of tiers) {
        if (sales >= t.min && sales <= t.max) return { ...t };
    }

    const below = tiers.filter(t => sales >= t.min).sort((a, b) => b.min - a.min);
    if (below.length) return { ...below[0] };

    return { ...tier0 };
}

async function resolveTier(sales) {
    const s = await get('SELECT * FROM settings WHERE id=1') || {};
    const mode = s.commission_mode || 'auto';
    const tiers = await loadTiers();

    if (mode === 'manual' && s.commission_tier != null) {
        const manual = tiers.find(t => t.tier === s.commission_tier);
        if (manual) {
            return {
                mode: 'manual',
                tier: manual.tier,
                rate: manual.rate,
                min: manual.min,
                max: manual.max,
                source: 'admin override'
            };
        }
    }

    const auto = await tierFromSales(sales);
    if (auto) {
        return {
            mode: 'auto',
            tier: auto.tier,
            rate: auto.rate,
            min: auto.min,
            max: auto.max,
            source: `auto from sales ${sales}`
        };
    }

    const fallback = tiers[0] || { tier: 0, min: 0, max: 499, rate: 10 };
    return {
        mode: 'auto',
        tier: fallback.tier,
        rate: fallback.rate,
        min: fallback.min,
        max: fallback.max,
        source: 'default'
    };
}

// This one is pure math once the tier is resolved — but resolving is async.
// So make it async too.
async function calculateCommission(sales) {
    const t = await resolveTier(sales);
    if (!Number.isFinite(t.rate) || t.rate <= 0) return 0;
    return Math.round(sales * (t.rate / 100) * 100) / 100;
}

// ============================================================
// RECORD ALL COMMISSIONS FOR A GAME
// ============================================================
async function recordAllCommissions(gameId) {
    const tickets = await all('SELECT * FROM tickets WHERE game_id=?', [gameId]);
    if (!tickets.length) return [];

    const totalSales = tickets.reduce((s, t) => s + Number(t.price || 0), 0);
    const tier = await resolveTier(totalSales);
    const commissionAmount = totalSales * (tier.rate / 100);

    try {
        await run(
            `INSERT INTO wallet_transactions
                (transaction_id, transaction_type, amount,
                 balance_before, balance_after, description,
                 reference_id, reference_type, created_by, created_at, status)
             VALUES (?, 'commission', ?, 0, 0, ?, ?, 'commission', 'system', NOW(), 'completed')`,
            [
                `comm_${gameId}_${Date.now()}`,
                Math.round(commissionAmount * 100) / 100,
                `Tier ${tier.tier} (${tier.rate}%) — ${tier.mode} [${tier.source}] for game ${gameId}`,
                gameId
            ]
        );
    } catch (e) {
        console.error('Commission tx log failed:', e.message);
    }

    const bySeller = {};
    for (const t of tickets) {
        const seller = t.sold_by || 'system';
        bySeller[seller] = (bySeller[seller] || 0) + Number(t.price || 0);
    }

    return Object.entries(bySeller).map(([seller, sales]) => {
        const amount = sales * (tier.rate / 100);
        return {
            gameId,
            seller,
            sales,
            rate: tier.rate,
            tier: tier.tier,
            amount: Math.round(amount * 100) / 100
        };
    });
}

// ============================================================
// ADMIN HELPERS
// ============================================================
async function getCommissionConfig() {
    const s = await get('SELECT * FROM settings WHERE id=1') || {};
    const tiers = await loadTiers();
    const manualTier = s.commission_tier != null
        ? tiers.find(t => t.tier === s.commission_tier)
        : null;

    return {
        mode: s.commission_mode || 'auto',
        tier: s.commission_tier || 0,
        rate: manualTier ? manualTier.rate : (s.commission_rate || 0),
        min: manualTier ? manualTier.min : (s.commission_min || 0),
        max: manualTier ? manualTier.max : (s.commission_max || 0),
        tiers
    };
}

async function setAutoMode() {
    await run(`UPDATE settings SET commission_mode='auto' WHERE id=1`);
    return { success: true, mode: 'auto' };
}

async function setManualTier(tierNumber) {
    const tiers = await loadTiers();
    const t = tiers.find(x => x.tier === tierNumber);
    if (!t) throw new Error(`Invalid tier: ${tierNumber}`);
    await run(
        `UPDATE settings
         SET commission_mode='manual', commission_tier=?, commission_rate=?,
             commission_min=?, commission_max=?
         WHERE id=1`,
        [t.tier, t.rate, t.min, t.max]
    );
    return {
        success: true,
        mode: 'manual',
        tier: t.tier,
        rate: t.rate,
        min: t.min,
        max: t.max
    };
}

// ============================================================
// EDIT A SINGLE TIER'S RATE
// ============================================================
async function setTierRate(tierNumber, newRate) {
    const tier = parseInt(tierNumber, 10);
    const rate = parseFloat(newRate);

    if (!Number.isFinite(tier)) {
        throw new Error(`Invalid tier: ${tierNumber}`);
    }
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        throw new Error('Rate must be between 0 and 100');
    }

    const existing = await get('SELECT tier FROM commission_tiers WHERE tier = ?', [tier]);
    if (!existing) {
        throw new Error(`Tier ${tier} not found`);
    }

    await run('UPDATE commission_tiers SET rate = ? WHERE tier = ?', [rate, tier]);

    const s = await get('SELECT commission_mode, commission_tier FROM settings WHERE id=1') || {};
    if (s.commission_mode === 'manual' && s.commission_tier === tier) {
        const row = await get('SELECT min, max FROM commission_tiers WHERE tier = ?', [tier]);
        if (row) {
            await run(
                `UPDATE settings SET commission_rate = ?, commission_min = ?, commission_max = ?
                 WHERE id=1`,
                [rate, row.min, row.max]
            );
        }
    }

    console.log(`✏️  Tier ${tier} rate updated to ${rate}%`);
    return { success: true, tier, rate };
}

// ============================================================
// LEGACY HELPERS (still used by routes/api.js)
// ============================================================
async function getUnpaidCommissions() {
    return await all(
        `SELECT * FROM commissions WHERE payout_status='pending' ORDER BY created_at DESC`
    );
}

async function markCommissionPaid(commissionId, paidBy) {
    await run(
        `UPDATE commissions SET payout_status='paid', paid_at=NOW(), paid_by=?
         WHERE id=?`,
        [paidBy || 'admin', commissionId]
    );
    return { success: true };
}

async function getSellerSummary(seller, from, to) {
    const rows = await all(
        `SELECT * FROM commissions
         WHERE seller=? AND DATE(created_at) BETWEEN ? AND ?
         ORDER BY created_at DESC`,
        [seller, from, to]
    );
    const total = rows.reduce((s, r) => s + Number(r.commission_amount || 0), 0);
    return { seller, from, to, total, commissions: rows };
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
    DEFAULT_TIERS,
    ensureTiersTable,
    TIERS,
    tiersList,
    tierFromSales,
    resolveTier,
    calculateCommission,
    recordAllCommissions,
    getCommissionConfig,
    setAutoMode,
    setManualTier,
    setTierRate,
    // legacy
    getUnpaidCommissions,
    markCommissionPaid,
    getSellerSummary
};