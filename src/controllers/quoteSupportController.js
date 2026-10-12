// HO TRO BAO GIA cua phong Mua hang:
//   1. Luu NHAP bang vat tu khi dang cho NCC bao gia (chua du gia nen chua luu duoc bao gia chinh thuc).
//   2. Tong hop vat tu can hoi gia theo tung NCC -> xuat Excel de gui NCC.
//   3. KHO la 1 "NCC noi bo": phan lay tu kho can Kho XAC NHAN con hang (so tren phan mem co the lech thuc te). Chua xac nhan chi canh bao, khong chan.
const XLSX = require('xlsx');
const db = require('../models/database');
const { parseJson, toNum, userName, badRequest, notFound } = require('../utils/http');

const FIELDS = ['giaCostLK', 'giaCostPCB', 'giaCostGiaCong'];
const PENDING = 'Chờ xác nhận', ENOUGH = 'Còn đủ', SHORT = 'Không đủ';

// ---------- 1. Nhap hoi gia ----------
async function lineOf(req) {
    const line = await db.getAsync('SELECT id, orderId, rfqDraft FROM order_items WHERE id = ?', [req.params.lineId]);
    if (!line) throw notFound('Không tìm thấy loại mạch.');
    if (!FIELDS.includes(req.params.field)) throw badRequest('Hạng mục không hợp lệ.');
    return line;
}
exports.getDraft = async (req, res) => {
    const line = await lineOf(req);
    res.json({ success: true, draft: parseJson(line.rfqDraft, {})[req.params.field] || null });
};
exports.saveDraft = async (req, res) => {
    const line = await lineOf(req);
    const all = parseJson(line.rfqDraft, {});
    const rows = (Array.isArray(req.body.rows) ? req.body.rows : []).slice(0, 300).map((r) => ({ itemId: Number(r.itemId) || null, name: String(r.name || '').trim().slice(0, 200), perSet: toNum(r.perSet), need: toNum(r.need),
        buyPrice: toNum(r.buyPrice), stockPrice: toNum(r.stockPrice), supplier: String(r.supplier || '').trim().slice(0, 100), khachCap: !!r.khachCap,
        rid: String(r.rid || '').slice(0, 20), buyQty: toNum(r.buyQty), surplus: r.surplus === 'khach' ? 'khach' : (r.surplus === 'kho' ? 'kho' : ''), alt: String(r.alt || '').trim().slice(0, 150), lead: String(r.lead || '').trim().slice(0, 60) })).filter((r) => r.name);
    if (rows.length) all[req.params.field] = { rows, passiveSupplier: String(req.body.passiveSupplier || '').trim().slice(0, 100), by: userName(req), at: new Date().toISOString() };
    else delete all[req.params.field]; // gui rong = xoa nhap (sau khi da luu bao gia chinh thuc)
    await db.runAsync('UPDATE order_items SET rfqDraft = ? WHERE id = ?', [JSON.stringify(all), line.id]);
    res.json({ success: true, at: rows.length ? all[req.params.field].at : null });
};

// ---------- 2. Xuat Excel hoi gia theo NCC ----------
// POST /api/purchase/rfq-export { title, groups: [{ supplier, rows: [{ name, mpn, package, qty, unit }] }] }
exports.rfqExport = async (req, res) => {
    const groups = (Array.isArray(req.body.groups) ? req.body.groups : []).filter((g) => Array.isArray(g.rows) && g.rows.length).slice(0, 40);
    if (!groups.length) throw badRequest('Không có vật tư nào cần hỏi giá.');
    const head = ['STT', 'Vật tư', 'Mã NSX', 'Kiểu chân', 'Số lượng', 'Đơn vị', 'Đơn giá', 'Thời gian giao', 'Ghi chú'];
    const wb = XLSX.utils.book_new();
    const sheet = (rows, withSupplier) => {
        const aoa = [[...(withSupplier ? ['Nhà cung cấp'] : []), ...head], ...rows.map((r, i) => [...(withSupplier ? [r.supplier] : []), i + 1, String(r.name || ''), String(r.mpn || ''), String(r.package || ''), toNum(r.qty), String(r.unit || ''), '', '', ''])];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!cols'] = aoa[0].map((h) => ({ wch: h === 'Vật tư' ? 42 : (h === 'Nhà cung cấp' || h === 'Mã NSX' ? 22 : 13) }));
        return ws;
    };
    XLSX.utils.book_append_sheet(wb, sheet(groups.flatMap((g) => g.rows.map((r) => ({ ...r, supplier: g.supplier }))), true), 'Tong hop');
    const used = new Set(['tong hop']);
    for (const g of groups) {
        let name = String(g.supplier || 'Chua chon NCC').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'NCC';
        while (used.has(name.toLowerCase())) name += '_';
        used.add(name.toLowerCase());
        XLSX.utils.book_append_sheet(wb, sheet(g.rows, false), name);
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Hoi_gia_NCC.xlsx');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
};

// ---------- 3. Kho xac nhan con hang ----------
// GET /api/purchase/stock-confirms?orderId=  (khong co orderId: cac yeu cau dang cho + da tra loi 30 ngay gan day)
exports.listConfirms = async (req, res) => {
    const base = `SELECT s.*, i.itemCode, i.itemName, i.unit, i.location, i.quantity AS stockNow, o.maDH, c.tenKH, oi.tenMach
        FROM stock_confirms s LEFT JOIN inventory i ON i.id = s.itemId LEFT JOIN orders o ON o.id = s.orderId LEFT JOIN customers c ON c.maKH = o.maKH LEFT JOIN order_items oi ON oi.id = s.lineId`;
    if (req.query.orderId) return res.json(await db.allAsync(`${base} WHERE s.orderId = ? ORDER BY s.id`, [req.query.orderId]));
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    res.json(await db.allAsync(`${base} WHERE s.status = ? OR s.confirmedAt >= ? ORDER BY CASE WHEN s.status = ? THEN 0 ELSE 1 END, s.id DESC LIMIT 500`, [PENDING, since, PENDING]));
};
// POST /api/purchase/stock-confirms { orderId, lineId, field, items: [{ itemId, qty }] }  -> mua hang gui yeu cau cho Kho
exports.requestConfirms = async (req, res) => {
    const { orderId, lineId, field } = req.body;
    if (!FIELDS.includes(field)) throw badRequest('Hạng mục không hợp lệ.');
    const line = await db.getAsync('SELECT id FROM order_items WHERE id = ? AND orderId = ?', [lineId, orderId]);
    if (!line) throw notFound('Không tìm thấy loại mạch của đơn.');
    const want = new Map();
    for (const it of Array.isArray(req.body.items) ? req.body.items : []) { const id = Number(it.itemId), q = toNum(it.qty); if (id && q > 0) want.set(id, (want.get(id) || 0) + q); }
    const old = await db.allAsync('SELECT * FROM stock_confirms WHERE lineId = ? AND field = ?', [lineId, field]);
    const now = new Date().toISOString();
    let asked = 0;
    for (const o of old) if (!want.has(o.itemId)) await db.runAsync('DELETE FROM stock_confirms WHERE id = ?', [o.id]); // dong khong con lay kho nua
    for (const [itemId, qty] of want) {
        const o = old.find((x) => x.itemId === itemId);
        if (o && Math.abs(toNum(o.qty) - qty) < 1e-9 && o.status !== SHORT) continue; // da hoi dung so luong nay roi (dang cho hoac da xac nhan du)
        if (o) await db.runAsync('UPDATE stock_confirms SET qty = ?, status = ?, qtyOk = NULL, note = NULL, confirmedBy = NULL, confirmedAt = NULL, requestedBy = ?, requestedAt = ? WHERE id = ?', [qty, PENDING, userName(req), now, o.id]);
        else await db.runAsync('INSERT INTO stock_confirms (orderId, lineId, field, itemId, qty, status, requestedBy, requestedAt) VALUES (?,?,?,?,?,?,?,?)', [orderId, lineId, field, itemId, qty, PENDING, userName(req), now]);
        asked += 1;
    }
    res.json({ success: true, asked, total: want.size });
};
// POST /api/purchase/stock-confirms/:id/answer { ok, qtyOk, note }  -> Kho tra loi
exports.answerConfirm = async (req, res) => {
    const s = await db.getAsync('SELECT * FROM stock_confirms WHERE id = ?', [req.params.id]);
    if (!s) throw notFound('Yêu cầu không còn (mua hàng đã đổi bảng vật tư).');
    const ok = !!req.body.ok;
    const qtyOk = ok ? toNum(s.qty) : toNum(req.body.qtyOk);
    if (!ok && (qtyOk < 0 || qtyOk >= toNum(s.qty))) throw badRequest(`Không đủ thì nhập số thực tế còn dùng được (nhỏ hơn ${s.qty}).`);
    await db.runAsync('UPDATE stock_confirms SET status = ?, qtyOk = ?, note = ?, confirmedBy = ?, confirmedAt = ? WHERE id = ?', [ok ? ENOUGH : SHORT, qtyOk, String(req.body.note || '').trim().slice(0, 300), userName(req), new Date().toISOString(), s.id]);
    res.json({ success: true });
};

// ---------- 4. BOM DI MUA: xuat BOM sau khi check kho -> mua hang xu ly tren Excel -> upload lai ----------
const BUY_COLS = [['rid', 'Mã dòng'], ['itemCode', 'Mã hàng'], ['mpn', 'Mã NSX'], ['package', 'Kiểu chân'], ['name', 'Vật tư'], ['need', 'SL cần'], ['fromStock', 'Lấy kho'], ['toBuy', 'SL cần mua'],
    ['supplier', 'Nhà cung cấp'], ['buyPrice', 'Đơn giá'], ['buyQty', 'SL mua thực tế'], ['surplus', 'Phần dư (kho / khách)'], ['alt', 'Mã thay thế'], ['lead', 'Thời gian giao'], ['note', 'Ghi chú']];
// POST /api/purchase/buy-bom-export { title, rows: [...] }
exports.buyBomExport = async (req, res) => {
    const rows = (Array.isArray(req.body.rows) ? req.body.rows : []).slice(0, 500);
    if (!rows.length) throw badRequest('Bảng vật tư chưa có dòng nào.');
    const aoa = [BUY_COLS.map((c) => c[1]), ...rows.map((r) => BUY_COLS.map(([k]) => (k === 'surplus' ? ({ khach: 'khách', kho: 'kho' }[r.surplus] || '') : (r[k] === undefined || r[k] === null ? '' : r[k]))))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = BUY_COLS.map(([k]) => ({ wch: k === 'name' ? 42 : (['supplier', 'alt', 'note', 'mpn'].includes(k) ? 20 : 13) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'BOM di mua');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=BOM_di_mua.xlsx');
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
};
// POST /api/purchase/buy-bom-parse (file, sheet, mapping?) -> doc file BOM sau xu ly: tieu de, goi y ghep cot, cac dong da ghep. KHONG ghi gi:
// trinh duyet doi chieu voi bang vat tu dang mo, nguoi dung xem ket qua roi moi luu.
exports.buyBomParse = async (req, res) => {
    if (!req.file) throw badRequest('Chưa chọn file.');
    const io = require('./dataIoController');
    const fields = [['rid', ['ma dong', 'row id']], ['itemCode', ['ma hang', 'ma lk', 'ma linh kien', 'item code']], ['mpn', ['ma nsx', 'mpn', 'manufacturer part', 'part number']], ['name', ['vat tu', 'linh kien', 'ten', 'comment', 'description', 'name']],
        ['toBuy', ['sl can mua', 'can mua']], ['supplier', ['nha cung cap', 'ncc', 'nguon mua', 'supplier']], ['buyPrice', ['don gia', 'gia mua', 'gia', 'price', 'unit price']], ['buyQty', ['sl mua thuc te', 'sl mua', 'so luong mua', 'sl dat', 'moq', 'order qty']],
        ['surplus', ['phan du', 'phan du kho khach', 'xu ly phan du']], ['alt', ['ma thay the', 'thay the', 'alternative', 'substitute']], ['lead', ['thoi gian giao', 'lead time', 'giao hang']], ['note', ['ghi chu', 'note']]]
        .map(([key, aliases]) => ({ key, label: BUY_COLS.find((c) => c[0] === key)[1], aliases }));
    const t = io.readMapped(req.file, fields, req.body.sheet, req.body.mapping ? parseJson(req.body.mapping, null) : null, req.body.headerRow);
    res.json({ success: true, ...t, fields: fields.map((f) => ({ key: f.key, label: f.label })) });
};
