// config.js
require('dotenv').config();

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

module.exports = {
    NODE_ENV,
    IS_PROD,

    PORT: Number(process.env.PORT) || 3000,
    HOST: process.env.HOST || '0.0.0.0',

    // ── MySQL ──
    DB_HOST: process.env.DB_HOST || 'localhost',
    DB_PORT: Number(process.env.DB_PORT) || 3306,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_NAME: process.env.DB_NAME,
    DB_POOL_SIZE: Number(process.env.DB_POOL_SIZE) || 10,

    // ── Sessions ──
    SESSION_NAME: 'vipbingo.sid',
    SESSION_SECRET: process.env.SESSION_SECRET || process.env.JWT_SECRET || 'change-me',
    SESSION_MAX_AGE: 24 * 60 * 60 * 1000,       // 24h
    SESSION_IDLE_TIMEOUT: 60 * 60 * 1000,       // 1h idle

    // ── Security ──
    BCRYPT_ROUNDS: 10,
    MIN_PASSWORD_LENGTH: 8,
    MAX_LOGIN_ATTEMPTS: 5,
    LOCKOUT_DURATION_MINUTES: 15,

    // ── Default admin (only used if no admin exists) ──
    DEFAULT_ADMIN_USER: process.env.DEFAULT_ADMIN_USER || 'admin',
    DEFAULT_ADMIN_EMAIL: process.env.DEFAULT_ADMIN_EMAIL || 'admin@vipbingo.local',
    DEFAULT_ADMIN_PASS: process.env.DEFAULT_ADMIN_PASS || 'ChangeMe123!'
};