const db = require('../models/database');
const XLSX = require('xlsx');
const { ensureCustomerFolder } = require('../utils/googleHelper');
const { toNum, badRequest, notFound, conflict } = require('../utils/http');
const { debtSql, receivableSql } = require('../utils/orderFlow');

// Cong no = no cu + (tong tien khach phai tra - da thu) cua cac don DA CHOT, chua huy
const DEBT_SQL = `
    SELECT c.*, (COALESCE(c.old_debt, 0) + COALESCE(d.debt, 0)) AS total_debt
    FROM customers c
    LEFT JOIN (
        SELECT maKH, SUM(${debtSql()}) AS debt
        FROM orders
        WHERE ${receivableSql()}
        GROUP BY maKH
    ) d ON d.maKH = c.maKH
    ORDER BY c.id DESC`;

// Quy tac ma KH: NickName + 5 so cuoi SDT
function buildMaKH(nickName, sdt) {
    const digits = String(sdt || '').replace(/\D/g, '');
    const last5 = digits.length >= 5 ? digits.slice(-5) : digits.padStart(5, '0');
    return `${nickName}${last5}`;
}

exports.getCustomers = async (req, res) => {
    res.json(await db.allAsync(DEBT_SQL));
};

exports.saveCustomer = async (req, res) => {
    const id = req.body.id;
    const nick_name = String(req.body.nick_name || 'KH').trim();
    const tenKH = String(req.body.tenKH || req.body.name || '').trim();
    const sdt = String(req.body.sdt || req.body.phone || '').trim();
    const diaChi = req.body.diaChi || req.body.address || '';
    const old_debt = toNum(req.body.old_debt);

    if (!tenKH) throw badRequest('Vui lòng nhập tên khách hàng.');

    if (id) {
        const current = await db.getAsync('SELECT id FROM customers WHERE id = ?', [id]);
        if (!current) throw notFound('Không tìm thấy khách hàng.');
        // GIU NGUYEN ma KH khi sua: don hang, du an lien ket theo maKH nen doi ma se lam mat lien ket.
        await db.runAsync('UPDATE customers SET nick_name=?, tenKH=?, sdt=?, diaChi=?, old_debt=? WHERE id=?',
            [nick_name, tenKH, sdt, diaChi, old_debt, id]);
        return res.json({ success: true });
    }

    const maKH = String(req.body.maKH || buildMaKH(nick_name, sdt)).trim();
    if (await db.getAsync('SELECT id FROM customers WHERE maKH = ?', [maKH])) {
        throw conflict(`Mã khách hàng ${maKH} đã tồn tại (trùng NickName và 5 số cuối SĐT).`);
    }

    const customerFolderId = await ensureCustomerFolder(maKH);
    const result = await db.runAsync(
        'INSERT INTO customers (maKH, nick_name, tenKH, sdt, diaChi, old_debt, customerFolderId) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [maKH, nick_name, tenKH, sdt, diaChi, old_debt, customerFolderId]);
    res.json({ success: true, id: result.lastID, maKH, customerFolderId });
};

// Import khach hang tu Excel (theo file mau). Thu muc Drive se duoc tao khi khach co don hang dau tien.
exports.importCustomers = async (req, res) => {
    if (!req.file) throw badRequest('Server không nhận được file Excel.');

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    if (!rows.length) throw badRequest('File Excel trống hoặc sai định dạng!');

    let added = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const tenKH = String(row['Tên khách hàng'] || row.tenKH || '').trim();
        const nick = String(row.NickName || row.nick_name || 'KH').trim();
        const sdt = String(row['Số điện thoại'] || row.sdt || '').trim();
        if (!tenKH) { skipped.push(`Dòng ${i + 2}: thiếu tên khách hàng`); continue; }

        const maKH = buildMaKH(nick, sdt);
        const result = await db.runAsync(
            'INSERT OR IGNORE INTO customers (maKH, nick_name, tenKH, sdt, diaChi, old_debt) VALUES (?, ?, ?, ?, ?, ?)',
            [maKH, nick, tenKH, sdt, row['Địa chỉ'] || row.diaChi || '', toNum(row['Nợ cũ'] || row.old_debt)]);
        if (result.changes) added += 1;
        else skipped.push(`Dòng ${i + 2}: mã ${maKH} đã tồn tại`);
    }

    let message = `Đã thêm ${added}/${rows.length} khách hàng.`;
    if (skipped.length) message += ` Bỏ qua ${skipped.length} dòng: ${skipped.slice(0, 5).join('; ')}${skipped.length > 5 ? '…' : ''}`;
    res.json({ success: true, count: added, skipped, message });
};

exports.downloadTemplate = (req, res) => {
    const ws = XLSX.utils.json_to_sheet([{
        'NickName': 'KH001',
        'Tên khách hàng': 'Nguyễn Văn A',
        'Số điện thoại': '0987654321',
        'Địa chỉ': 'Hà Nội',
        'Nợ cũ': 0
    }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template_KH');

    res.setHeader('Content-Disposition', 'attachment; filename=Mau_Import_KhachHang.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
};

exports.deleteCustomer = async (req, res) => {
    const result = await db.runAsync('DELETE FROM customers WHERE id = ?', [req.params.id]);
    if (!result.changes) throw notFound('Không tìm thấy khách hàng.');
    res.json({ success: true });
};
exports.buildMaKH = buildMaKH;

// ===== DIA CHI NHAN HANG cua khach (1 khach co the co nhieu noi nhan) - dung khi tao chuyen giao hang =====
exports.getAddresses = async (req, res) => {
    res.json(await db.allAsync('SELECT * FROM customer_addresses WHERE maKH = ? ORDER BY isDefault DESC, id', [req.params.maKH]));
};
// PUT /api/customers/:maKH/addresses { list: [{ label, receiver, phone, address, isDefault }] } -> thay toan bo danh sach
exports.saveAddresses = async (req, res) => {
    const maKH = req.params.maKH;
    if (!(await db.getAsync('SELECT id FROM customers WHERE maKH = ?', [maKH]))) throw notFound('Không tìm thấy khách hàng.');
    const cut = (v, n) => String(v || '').trim().slice(0, n);
    const list = (Array.isArray(req.body.list) ? req.body.list : []).slice(0, 30).map((a) => ({ label: cut(a.label, 80), receiver: cut(a.receiver, 120), phone: cut(a.phone, 40), address: cut(a.address, 300), isDefault: a.isDefault ? 1 : 0 })).filter((a) => a.address);
    if (list.length && !list.some((a) => a.isDefault)) list[0].isDefault = 1;
    let seen = false;
    for (const a of list) { if (a.isDefault && seen) a.isDefault = 0; if (a.isDefault) seen = true; } // chi 1 dia chi mac dinh
    await db.runAsync('DELETE FROM customer_addresses WHERE maKH = ?', [maKH]);
    for (const a of list) await db.runAsync('INSERT INTO customer_addresses (maKH, label, receiver, phone, address, isDefault) VALUES (?,?,?,?,?,?)', [maKH, a.label, a.receiver, a.phone, a.address, a.isDefault]);
    res.json({ success: true, count: list.length });
};
