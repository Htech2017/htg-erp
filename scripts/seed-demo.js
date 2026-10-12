// Tao du lieu mau cho ban demo. Moi thao tac di qua API that (dung luat nghiep vu, dung phan quyen tung vai tro),
// chi rieng viec tao tai khoan va lui ngay (de co don qua han) la ghi thang vao demo.db.
const db = require('../src/models/database');
const { hashPassword } = require('../src/utils/password');
const { DEMO_ACCOUNTS, DEMO_PASSWORD } = require('./demo-accounts');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA');

module.exports = async function seed(base) {
    if (!String(process.env.DB_PATH || '').endsWith('demo.db')) throw new Error('Chi duoc tao du lieu mau tren demo.db');

    // ---------- Tai khoan ----------
    for (const [i, a] of DEMO_ACCOUNTS.entries()) {
        await db.runAsync('INSERT INTO users (code, name, username, password, phone, email, status, roles) VALUES (?,?,?,?,?,?,1,?)',
            [`NV${String(i + 1).padStart(3, '0')}`, a.name, a.username, hashPassword(DEMO_PASSWORD), `09000000${String(i).padStart(2, '0')}`, `${a.username}@demo.local`, JSON.stringify(a.roles)]);
    }

    // ---------- Goi API voi tu cach tung vai tro ----------
    const jars = {};
    async function cookie(username) {
        if (!jars[username]) {
            const r = await fetch(`${base}/demo/as/${username}`, { redirect: 'manual' });
            jars[username] = (r.headers.get('set-cookie') || '').split(';')[0];
        }
        return jars[username];
    }
    async function api(username, method, url, body) {
        const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: await cookie(username) }, body: body ? JSON.stringify(body) : undefined });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.success === false) throw new Error(`${method} ${url} (${username}): ${j.error || r.status}`);
        return j;
    }
    const post = (u, url, body) => api(u, 'POST', url, body || {});
    const patch = (u, url, body) => api(u, 'PATCH', url, body);

    // ---------- Thuong hieu, khach hang, nha cung cap, chuyen san xuat ----------
    const brandA = (await post('demo_admin', '/api/settings/brands/save', { company: 'HTG Electronics', code: 'HTG', address: 'Hà Nội', bankName: 'Vietcombank', bankNo: '0011000000000', bankOwner: 'CONG TY HTG', showBankDefault: true })).id;
    const brandB = (await post('demo_admin', '/api/settings/brands/save', { company: 'Htech PCB', code: 'HTECH', address: 'TP. Hồ Chí Minh', bankName: 'Techcombank', bankNo: '1903000000000', bankOwner: 'HTECH PCB', showBankDefault: true })).id;

    const cust = {};
    for (const c of [
        { key: 'A', nick_name: 'Minh', tenKH: 'Công ty TNHH Điện tử Minh Anh', sdt: '0912345001', diaChi: 'Cầu Giấy, Hà Nội' },
        { key: 'B', nick_name: 'Sao', tenKH: 'Công ty CP Sao Việt IoT', sdt: '0912345002', diaChi: 'Quận 7, TP. HCM', old_debt: 12500000 },
        { key: 'C', nick_name: 'Hung', tenKH: 'Anh Hùng (khách lẻ)', sdt: '0912345003', diaChi: 'Đà Nẵng' },
        { key: 'D', nick_name: 'Robo', tenKH: 'Startup RoboTech', sdt: '0912345004', diaChi: 'Thủ Đức, TP. HCM' }
    ]) cust[c.key] = (await post('demo_sale', '/api/customers/save', c)).maKH;

    const sup = {};
    for (const s of [
        { key: 'pcb', name: 'JLCPCB', type: 'PCB', contactPerson: 'Support', rating: 5 },
        { key: 'lk', name: 'Linh kiện Thế Giới Chip', type: 'LinhKien', phone: '0988000111', rating: 4 },
        { key: 'gc', name: 'Xưởng SMT Bình Minh', type: 'GiaCong', phone: '0988000222', rating: 3 },
        { key: 'dk', name: 'Digikey', type: 'LinhKien', rating: 5 },
        { key: 'ms', name: 'Mouser', type: 'LinhKien', rating: 5 },
        { key: 'lc', name: 'LCSC', type: 'LinhKien', rating: 4 }
    ]) sup[s.key] = { id: (await post('demo_qlsx', '/api/purchase/suppliers/save', s)).id, name: s.name };

    const line1 = (await post('demo_qlsx', '/api/production/lines/save', { name: 'Chuyền SMT 1', type: 'SMT', capacity: 5000, status: 'Hoạt động' })).id;
    await post('demo_qlsx', '/api/production/lines/save', { name: 'Chuyền hàn tay', type: 'THT', capacity: 800, status: 'Hoạt động' });
    const RATES = { smdPad: 30, thtPad: 150, ic: 500, test: 2000, setup: 300000, lossPercent: 3 };
    await post('demo_qlsx', '/api/orders/production-rates', RATES);

    // ---------- Kho: du / thieu / het hang / duoi muc toi thieu / nhieu ten goi ----------
    const item = {};
    for (const it of [
        { itemCode: 'C100NF-0603', itemName: 'Tụ gốm 100nF 50V 0603', category: 'Tụ điện', unit: 'con', quantity: 5000, minQuantity: 1000, location: 'A1-01', package: '0603', unitCost: 45, aliases: ['0.1uF', 'tụ 104', '100n'] },
        { itemCode: 'R10K-0603', itemName: 'Điện trở 10K 1% 0603', category: 'Điện trở', unit: 'con', quantity: 8000, minQuantity: 1000, location: 'A1-02', package: '0603', unitCost: 20, aliases: ['10k', '103'] },
        { itemCode: 'R1K-0603', itemName: 'Điện trở 1K 1% 0603', category: 'Điện trở', unit: 'con', quantity: 300, minQuantity: 1000, location: 'A1-03', package: '0603', unitCost: 20, aliases: ['1k', '102'] },
        { itemCode: 'STM32F103C8T6', itemName: 'MCU STM32F103C8T6 LQFP48', category: 'IC', unit: 'con', quantity: 120, minQuantity: 50, location: 'B2-01', mpn: 'STM32F103C8T6', package: 'LQFP48', unitCost: 32000, aliases: ['F103C8', 'Blue pill MCU'] },
        { itemCode: 'ESP32-WROOM-32E', itemName: 'Module WiFi ESP32-WROOM-32E', category: 'Module', unit: 'con', quantity: 40, minQuantity: 20, location: 'B2-02', mpn: 'ESP32-WROOM-32E-N4', unitCost: 68000, aliases: ['ESP32', 'WROOM32'] },
        { itemCode: 'AMS1117-3.3', itemName: 'IC ổn áp AMS1117-3.3 SOT223', category: 'IC', unit: 'con', quantity: 600, minQuantity: 200, location: 'B2-03', package: 'SOT223', unitCost: 1800, aliases: ['1117 3V3', 'LDO 3.3V'] },
        { itemCode: 'LED-RED-0603', itemName: 'LED đỏ 0603', category: 'LED', unit: 'con', quantity: 0, minQuantity: 500, location: 'A2-01', package: '0603', unitCost: 150, aliases: ['led do'] },
        { itemCode: 'CONN-USB-C16', itemName: 'Cổng USB Type-C 16 pin', category: 'Connector', unit: 'con', quantity: 250, minQuantity: 100, location: 'C1-01', unitCost: 2500, aliases: ['USB-C', 'Type C 16P'] },
        { itemCode: 'HDR-2X20', itemName: 'Header đực 2x20 2.54mm', category: 'Connector', unit: 'con', quantity: 90, minQuantity: 100, location: 'C1-02', unitCost: 3500, aliases: ['header 40 pin'] },
        { itemCode: '1N4148-SOD323', itemName: 'Diode 1N4148 SOD323', category: 'Diode', unit: 'con', quantity: 2000, minQuantity: 500, location: 'A2-02', mpn: '1N4148WS', package: 'SOD323', unitCost: 120, aliases: ['4148'] }
    ]) item[it.itemCode] = (await post('demo_kho', '/api/inventory/items/save', it)).id;
    await post('demo_kho', '/api/inventory/transactions', { itemId: item['R10K-0603'], type: 'Nhap', quantity: 2000, unitPrice: 18, reason: 'Nhập bổ sung từ NCC' });
    await post('demo_kho', '/api/inventory/transactions', { itemId: item['CONN-USB-C16'], type: 'Xuat', quantity: 20, reason: 'Xuất mẫu thử cho phòng Thiết kế' });

    // ---------- Xuong san xuat + gan tai khoan xuong ----------
    const ws1 = (await post('demo_qlsx', '/api/dispatch/workshops/save', { name: 'Xưởng Tân Bình', contact: 'Anh Tâm', phone: '0977000111', address: 'Tân Bình, TP. HCM', capability: 'SMT, hàn tay' })).id;
    const ws2 = (await post('demo_qlsx', '/api/dispatch/workshops/save', { name: 'Xưởng Thủ Đức', contact: 'Chị Hoa', phone: '0977000222', address: 'Thủ Đức, TP. HCM', capability: 'Hàn tay, lắp ráp, test' })).id;
    await post('demo_qlsx', '/api/dispatch/workshops/save', { name: 'Xưởng Bình Dương (tạm ngừng)', contact: 'Anh Lâm', capability: 'SMT số lượng lớn', status: false });
    await db.runAsync('UPDATE users SET workshopId = ? WHERE username = ?', [ws1, 'demo_xuong1']);
    await db.runAsync('UPDATE users SET workshopId = ? WHERE username = ?', [ws2, 'demo_xuong2']);

    // Thuong hieu di theo tai khoan sale
    await db.runAsync('UPDATE users SET brandId = ? WHERE username = ?', [brandA, 'demo_sale']);
    await db.runAsync('UPDATE users SET brandId = ? WHERE username = ?', [brandB, 'demo_sale2']);

    const ctx = { ws1, ws2, db, day, post, patch, api, cust, sup, item, line1, RATES, brandA, brandB };
    await require('./seed-demo-orders')(ctx);
    await require('./seed-demo-misc')(ctx);
};
