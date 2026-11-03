// database.js
const mysql = require('mysql2/promise');
const config = require('./config');

// ============================================================
// CONNECTION POOL
// ============================================================
const pool = mysql.createPool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    database: config.DB_NAME,
    waitForConnections: true,
    connectionLimit: config.DB_POOL_SIZE,
    queueLimit: 0,
    charset: 'utf8mb4',
    timezone: 'Z',
    decimalNumbers: true,     // DECIMAL columns → JS numbers
    dateStrings: true,        // DATETIME → strings like 'YYYY-MM-DD HH:MM:SS'
    multipleStatements: false
});

console.log(`✅ MySQL pool created (${config.DB_NAME}@${config.DB_HOST})`);

// ============================================================
// HELPERS — same shape as better-sqlite3 (async now)
// ============================================================
function clean(params) {
    if (!params) return [];
    if (!Array.isArray(params)) params = [params];
    return params.map(p => (p === undefined ? null : p));
}

async function run(sql, params = []) {
    try {
        const [result] = await pool.execute(sql, clean(params));
        return {
            changes: result.affectedRows,
            lastInsertRowid: result.insertId,   // better-sqlite3 name
            lastID: result.insertId             // alias
        };
    } catch (e) {
        console.error('❌ DB RUN:', e.message, '\nSQL:', sql, '\nParams:', params);
        throw e;
    }
}

async function get(sql, params = []) {
    try {
        const [rows] = await pool.execute(sql, clean(params));
        return rows[0] || undefined;
    } catch (e) {
        console.error('❌ DB GET:', e.message, '\nSQL:', sql, '\nParams:', params);
        throw e;
    }
}

async function all(sql, params = []) {
    try {
        const [rows] = await pool.execute(sql, clean(params));
        return rows;
    } catch (e) {
        console.error('❌ DB ALL:', e.message, '\nSQL:', sql, '\nParams:', params);
        throw e;
    }
}

// ============================================================
// TRANSACTION — async, receives a scoped `tx`
// ============================================================
async function transaction(fn) {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const tx = {
            run: async (sql, params = []) => {
                const [r] = await conn.execute(sql, clean(params));
                return { changes: r.affectedRows, lastInsertRowid: r.insertId, lastID: r.insertId };
            },
            get: async (sql, params = []) => {
                const [rows] = await conn.execute(sql, clean(params));
                return rows[0] || undefined;
            },
            all: async (sql, params = []) => {
                const [rows] = await conn.execute(sql, clean(params));
                return rows;
            }
        };
        const result = await fn(tx);
        await conn.commit();
        return result;
    } catch (e) {
        await conn.rollback();
        throw e;
    } finally {
        conn.release();
    }
}

// ============================================================
// SESSION STORE — minimal, uses the same pool
// ============================================================
class MySQLSessionStore extends require('express-session').Store {
    constructor(opts = {}) {
        super();
        this.clearIntervalMs = opts.clearIntervalMs || 15 * 60 * 1000;
        this._timer = setInterval(() => this.clearExpired(), this.clearIntervalMs);
        this._timer.unref?.();
    }

    async get(sid, cb) {
        try {
            const row = await get(
                'SELECT sess FROM sessions WHERE sid = ? AND expire > ?',
                [sid, Date.now()]
            );
            if (!row) return cb(null, null);
            const sess = typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess;
            cb(null, sess);
        } catch (e) { cb(e); }
    }

    async set(sid, sess, cb) {
        try {
            const expire = sess?.cookie?.expires
                ? new Date(sess.cookie.expires).getTime()
                : Date.now() + 24 * 60 * 60 * 1000;
            const json = JSON.stringify(sess);
            await run(
                `INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE sess = VALUES(sess), expire = VALUES(expire)`,
                [sid, json, expire]
            );
            cb(null);
        } catch (e) { cb(e); }
    }

    async destroy(sid, cb) {
        try {
            await run('DELETE FROM sessions WHERE sid = ?', [sid]);
            cb(null);
        } catch (e) { cb(e); }
    }

    async touch(sid, sess, cb) {
        try {
            const expire = sess?.cookie?.expires
                ? new Date(sess.cookie.expires).getTime()
                : Date.now() + 24 * 60 * 60 * 1000;
            await run('UPDATE sessions SET expire = ? WHERE sid = ?', [expire, sid]);
            cb(null);
        } catch (e) { cb(e); }
    }

    async clearExpired() {
        try {
            await run('DELETE FROM sessions WHERE expire <= ?', [Date.now()]);
        } catch { /* ignore */ }
    }

    async length(cb) {
        try {
            const r = await get('SELECT COUNT(*) AS c FROM sessions WHERE expire > ?', [Date.now()]);
            cb(null, r.c);
        } catch (e) { cb(e); }
    }

    async clear(cb) {
        try {
            await run('DELETE FROM sessions');
            cb(null);
        } catch (e) { cb(e); }
    }

    async all(cb) {
        try {
            const rows = await all('SELECT sid, sess FROM sessions WHERE expire > ?', [Date.now()]);
            const list = rows.map(r => ({
                sid: r.sid,
                sess: typeof r.sess === 'string' ? JSON.parse(r.sess) : r.sess
            }));
            cb(null, list);
        } catch (e) { cb(e); }
    }
}

module.exports = {
    pool,
    run,
    get,
    all,
    transaction,
    MySQLSessionStore
};