// scripts/create-tables.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

(async () => {
    const admin = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD
    });
    await admin.query(
        `CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await admin.end();
    console.log(`✅ Database "${process.env.DB_NAME}" ensured`);

    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT) || 3306,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        multipleStatements: true
    });

    const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
    await conn.query(sql);
    await conn.end();

    console.log('✅ All tables created');
    process.exit(0);
})().catch(e => { console.error('❌', e); process.exit(1); });