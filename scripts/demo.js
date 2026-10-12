// CHAY BAN DEMO:  npm run demo        (lan dau tu tao du lieu mau)
//                 npm run demo:reset  (xoa va tao lai du lieu mau)
// Dung file demo.db RIENG, cong 3100, khong dung Google Drive / Google Chat -> khong dong toi du lieu that (htech.db).
const fs = require('fs');
const path = require('path');

const DB = path.join(__dirname, '../demo.db');
process.env.DB_PATH = DB;
process.env.DEMO_MODE = '1';
process.env.PORT = process.env.DEMO_PORT || '3100';
process.env.GOOGLE_KEYFILE = path.join(__dirname, '../.no-google-in-demo.json'); // file khong ton tai -> khong goi Google
if (!process.env.SESSION_SECRET) process.env.SESSION_SECRET = 'demo-only-secret';

const reset = process.argv.includes('--reset');
if (reset) for (const ext of ['', '-wal', '-shm']) fs.rmSync(DB + ext, { force: true });
const needSeed = !fs.existsSync(DB);

const app = require('../app');
app.once('listening', async () => {
    const base = `http://localhost:${process.env.PORT}`;
    if (needSeed) {
        console.log('[DEMO] Dang tao du lieu mau...');
        try {
            await require('./seed-demo')(base);
            console.log('[DEMO] Da tao xong du lieu mau.');
        } catch (err) {
            console.error('[DEMO] Loi khi tao du lieu mau:', err.message);
        }
    }
    // Vai tro moi them sau khi da co demo.db: bo sung tai khoan demo con thieu (khong can reset du lieu)
    try {
        const db = require('../src/models/database');
        const { DEMO_ACCOUNTS, DEMO_PASSWORD } = require('./demo-accounts');
        const { hashPassword } = require('../src/utils/password');
        for (const [i, a] of DEMO_ACCOUNTS.entries()) {
            if (await db.getAsync('SELECT id FROM users WHERE username = ?', [a.username])) continue;
            await db.runAsync('INSERT INTO users (code, name, username, password, phone, email, status, roles) VALUES (?,?,?,?,?,?,1,?)',
                [`NV${String(i + 1).padStart(3, '0')}X`, a.name, a.username, hashPassword(DEMO_PASSWORD), `09000001${String(i).padStart(2, '0')}`, `${a.username}@demo.local`, JSON.stringify(a.roles)]);
        }
    } catch (err) { console.error('[DEMO] Khong bo sung duoc tai khoan demo:', err.message); }
    console.log(`\n[DEMO] Mo ${base}/demo/as/demo_admin  (hoac dang nhap demo_admin / demo123)`);
    console.log('[DEMO] Doi vai tro bang o chon "Demo - xem voi vai tro" o cuoi thanh menu ben trai.\n');
});
