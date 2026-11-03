// seed.js
const { get } = require('./database');

(async () => {
    console.log('🌱 seed.js\n');

    const count = (await get('SELECT COUNT(*) AS c FROM cartelas')).c;
    console.log(`Cartelas in DB: ${count}\n`);

    if (count === 0) {
        console.log('→ DB is empty. Loading from cartelas.json...\n');
        require('./loadCartelas');
    } else {
        console.log('✅ Cartelas already loaded.');
        console.log('');
        console.log('To force-reload from JSON (WARNING: clears existing):');
        console.log('   node loadCartelas.js --reset');
    }
})().catch(e => { console.error(e); process.exit(1); });