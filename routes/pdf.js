// routes/pdf.js
const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const config = require('../config');
const { all, get } = require('../database');
const { requireAuth } = require('../auth');

router.use(requireAuth);

function streamPDF(res, filename, buildFn) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    doc.pipe(res);
    buildFn(doc);
    doc.end();
}

// ---------- Game history PDF ----------
router.get('/games', async (req, res) => {
    try {
        const games = await all(`
            SELECT g.*,
                COUNT(DISTINCT t.id) AS ticket_count,
                COALESCE(SUM(t.price), 0) AS total_sales,
                (SELECT COUNT(*) FROM winners w WHERE w.game_id=g.id) AS winner_count
            FROM games g LEFT JOIN tickets t ON t.game_id = g.id
            GROUP BY g.id ORDER BY g.id DESC
        `);

        streamPDF(res, 'games.pdf', (doc) => {
            doc.fontSize(20).text('VIP BINGO — Game History', { align: 'center' });
            doc.moveDown();
            doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
            doc.moveDown(2);

            games.forEach((g, i) => {
                if (i > 0 && i % 3 === 0) doc.addPage();
                doc.fontSize(12).text(`Game #${g.id} — ${g.game_number}`, { underline: true });
                doc.fontSize(10).text(`Status: ${g.status}`);
                doc.text(`Date: ${g.start_time || 'N/A'}`);
                doc.text(`Tickets: ${g.ticket_count}`);
                doc.text(`Sales: ${Number(g.total_sales || 0).toFixed(2)} Br`);
                doc.text(`Winners: ${g.winner_count}`);
                doc.moveDown();
            });
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('PDF error');
    }
});

// ---------- Daily report PDF ----------
router.get('/daily', async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().split('T')[0];
        const report = await get(`
            SELECT
                (SELECT COUNT(*) FROM games WHERE DATE(start_time)=?) AS total_games,
                (SELECT COUNT(*) FROM tickets WHERE DATE(created_at)=?) AS total_tickets,
                (SELECT COALESCE(SUM(price),0) FROM tickets WHERE DATE(created_at)=?) AS total_sales,
                (SELECT COUNT(*) FROM winners WHERE DATE(win_time)=?) AS total_winners
        `, [date, date, date, date]);

        streamPDF(res, `daily-${date}.pdf`, (doc) => {
            doc.fontSize(20).text('VIP BINGO — Daily Report', { align: 'center' });
            doc.moveDown();
            doc.fontSize(12).text(`Date: ${date}`);
            doc.moveDown();
            doc.fontSize(14).text(`Total Games: ${report.total_games}`);
            doc.text(`Total Tickets: ${report.total_tickets}`);
            doc.text(`Total Sales: ${Number(report.total_sales).toFixed(2)} Br`);
            doc.text(`Total Winners: ${report.total_winners}`);
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('PDF error');
    }
});

// ---------- Weekly report PDF ----------
router.get('/weekly', async (req, res) => {
    try {
        const start = req.query.start || new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
        const end = new Date().toISOString().split('T')[0];
        const report = await get(`
            SELECT
                (SELECT COUNT(*) FROM games WHERE DATE(start_time) BETWEEN ? AND ?) AS total_games,
                (SELECT COUNT(*) FROM tickets WHERE DATE(created_at) BETWEEN ? AND ?) AS total_tickets,
                (SELECT COALESCE(SUM(price),0) FROM tickets WHERE DATE(created_at) BETWEEN ? AND ?) AS total_sales,
                (SELECT COUNT(*) FROM winners WHERE DATE(win_time) BETWEEN ? AND ?) AS total_winners
        `, [start, end, start, end, start, end, start, end]);

        streamPDF(res, `weekly.pdf`, (doc) => {
            doc.fontSize(20).text('VIP BINGO — Weekly Report', { align: 'center' });
            doc.moveDown();
            doc.fontSize(12).text(`Period: ${start} to ${end}`);
            doc.moveDown();
            doc.fontSize(14).text(`Total Games: ${report.total_games}`);
            doc.text(`Total Tickets: ${report.total_tickets}`);
            doc.text(`Total Sales: ${Number(report.total_sales).toFixed(2)} Br`);
            doc.text(`Total Winners: ${report.total_winners}`);
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('PDF error');
    }
});

// ---------- Monthly report PDF ----------
router.get('/monthly', async (req, res) => {
    try {
        const now = new Date();
        const year = parseInt(req.query.year) || now.getFullYear();
        const month = parseInt(req.query.month) || (now.getMonth() + 1);
        const start = `${year}-${String(month).padStart(2, '0')}-01`;
        const end = new Date(year, month, 0).toISOString().split('T')[0];
        const report = await get(`
            SELECT
                (SELECT COUNT(*) FROM games WHERE DATE(start_time) BETWEEN ? AND ?) AS total_games,
                (SELECT COUNT(*) FROM tickets WHERE DATE(created_at) BETWEEN ? AND ?) AS total_tickets,
                (SELECT COALESCE(SUM(price),0) FROM tickets WHERE DATE(created_at) BETWEEN ? AND ?) AS total_sales,
                (SELECT COUNT(*) FROM winners WHERE DATE(win_time) BETWEEN ? AND ?) AS total_winners
        `, [start, end, start, end, start, end, start, end]);

        streamPDF(res, `monthly-${year}-${month}.pdf`, (doc) => {
            doc.fontSize(20).text('VIP BINGO — Monthly Report', { align: 'center' });
            doc.moveDown();
            doc.fontSize(12).text(`Period: ${year}-${String(month).padStart(2, '0')}`);
            doc.moveDown();
            doc.fontSize(14).text(`Total Games: ${report.total_games}`);
            doc.text(`Total Tickets: ${report.total_tickets}`);
            doc.text(`Total Sales: ${Number(report.total_sales).toFixed(2)} Br`);
            doc.text(`Total Winners: ${report.total_winners}`);
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('PDF error');
    }
});

// ---------- Cartelas PDF export ----------
router.get('/cartelas', async (req, res) => {
    try {
        const cartelas = await all('SELECT * FROM cartelas ORDER BY serial');

        streamPDF(res, 'cartelas.pdf', (doc) => {
            doc.fontSize(18).text('VIP BINGO — Cartelas', { align: 'center' });
            doc.moveDown();

            let x = 40, y = 80, count = 0;
            const cellSize = 28;

            for (const cartela of cartelas) {
                // MySQL stores numbers as a comma-separated string like "1,16,31,46,61,..."
                // Rebuild a 5x5 grid: [row][col] using column-major layout
                let nums = [];
                try {
                    if (typeof cartela.numbers === 'string') {
                        nums = cartela.numbers.split(',').map(n => n.trim()).map(n => n === '' ? 0 : Number(n));
                    } else if (Array.isArray(cartela.numbers)) {
                        nums = cartela.numbers;
                    }
                } catch { nums = []; }

                const grid = Array.from({ length: 5 }, () => Array(5).fill(0));
                for (let col = 0; col < 5; col++) {
                    for (let row = 0; row < 5; row++) {
                        grid[row][col] = nums[col * 5 + row] || 0;
                    }
                }

                doc.fontSize(10).text(cartela.serial, x, y - 12);

                const letters = ['B', 'I', 'N', 'G', 'O'];
                letters.forEach((L, i) => {
                    doc.rect(x + i * cellSize, y, cellSize, cellSize).stroke();
                    doc.text(L, x + i * cellSize + 10, y + 8);
                });
                for (let r = 0; r < 5; r++) {
                    for (let c = 0; c < 5; c++) {
                        const val = grid[r][c] === 0 ? 'FREE' : grid[r][c];
                        doc.rect(x + c * cellSize, y + (r + 1) * cellSize, cellSize, cellSize).stroke();
                        doc.fontSize(9).text(String(val), x + c * cellSize + 5, y + (r + 1) * cellSize + 8);
                    }
                }
                count++;
                x += 200;
                if (count % 3 === 0) { x = 40; y += 220; }
                if (count % 6 === 0 && count < cartelas.length) {
                    doc.addPage(); x = 40; y = 80;
                }
            }
        });
    } catch (e) {
        console.error(e);
        res.status(500).send('PDF error');
    }
});

module.exports = router;
