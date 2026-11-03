// loadCartelas.js
const fs = require('fs');
const path = require('path');
const { run, get, all, transaction } = require('./database');

// Try every plausible location for cartelas.json.
// The first two entries work when loadCartelas.js sits at the project root.
const CANDIDATE_PATHS = [
    path.join(__dirname, 'public', 'data', 'cartelas.json'),
    path.join(__dirname, 'data', 'cartelas.json'),
    path.join(__dirname, 'cartelas.json'),
    // Fallbacks for the old layout (script one level above project)
    path.join(__dirname, '..', 'data', 'cartelas.json'),
    path.join(__dirname, '..', 'public', 'data', 'cartelas.json')
];

function findCartelasFile() {
    for (const p of CANDIDATE_PATHS) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

async function loadCartelas({ reset = false } = {}) {
    console.log('📂 Loading cartelas from JSON...\n');

    const filePath = findCartelasFile();
    if (!filePath) {
        console.error('❌ cartelas.json not found. Looked in:');
        CANDIDATE_PATHS.forEach(p => console.error('   ' + p));
        console.error('\nUpload cartelas.json to:');
        console.error('   ' + path.join(__dirname, 'public', 'data', 'cartelas.json'));
        process.exit(1);
    }
    console.log(`   Found: ${filePath}`);

    const raw = fs.readFileSync(filePath, 'utf8');
    let cartelas;
    try {
        cartelas = JSON.parse(raw);
    } catch (e) {
        console.error('❌ Invalid JSON:', e.message);
        process.exit(1);
    }

    if (!Array.isArray(cartelas)) {
        console.error('❌ cartelas.json must be an array');
        process.exit(1);
    }
    console.log(`   Parsed ${cartelas.length} cartelas from JSON\n`);

    if (reset) {
        const existing = (await get('SELECT COUNT(*) AS c FROM cartelas')).c;
        console.log(`🧹 Reset requested — wiping ${existing} existing cartelas...`);
        await run('SET FOREIGN_KEY_CHECKS = 0');
        try {
            // Delete child rows first, then the parent.
            await run('DELETE FROM tickets');
            await run('DELETE FROM cartelas');
        } finally {
            await run('SET FOREIGN_KEY_CHECKS = 1');
        }
    }

    const existingSerials = new Set(
        (await all('SELECT serial FROM cartelas')).map(r => r.serial)
    );
    console.log(`   DB currently has ${existingSerials.size} cartelas\n`);

    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    console.log('💾 Inserting into database...\n');

    await transaction(async (tx) => {
        for (const c of cartelas) {
            if (!c.serial || !Array.isArray(c.grid) || c.grid.length !== 25) {
                console.error(`   ⚠️  Invalid cartela: ${c.serial || '(no serial)'}`);
                errors++;
                continue;
            }

            if (existingSerials.has(c.serial)) {
                skipped++;
                continue;
            }

            const numbersStr = c.grid.join(',');

            try {
                await tx.run(
                    'INSERT INTO cartelas (id, serial, numbers) VALUES (?, ?, ?)',
                    [c.id, c.serial, numbersStr]
                );
                inserted++;
                if (inserted % 50 === 0) process.stdout.write(`   Inserted ${inserted}...\r`);
            } catch (e) {
                console.error(`\n   ❌ Failed ${c.serial}: ${e.message}`);
                errors++;
            }
        }
    });

    const total = (await get('SELECT COUNT(*) AS c FROM cartelas')).c;
    console.log('');
    console.log('════════════════════════════════════════════');
    console.log('  ✅ Cartelas loaded');
    console.log('════════════════════════════════════════════');
    console.log(`  Inserted:  ${inserted}`);
    console.log(`  Skipped:   ${skipped} (already existed)`);
    console.log(`  Errors:    ${errors}`);
    console.log(`  Total now: ${total}`);
    console.log('════════════════════════════════════════════');
    console.log('');

    process.exit(0);
}

const reset = process.argv.includes('--reset');
loadCartelas({ reset }).catch(e => {
    console.error('❌ Fatal:', e);
    process.exit(1);
});
