// KIEM VAT TU MUA VE tai tung khau mua hang (trang Mua hang PCB, trang Mua hang linh kien).
// Nguoi mua hang chi kiem: DU SO LUONG va DUNG CHUNG LOAI. Moi lan kiem ghi nhat ky (ngay gio, nguoi kiem, cach nhan dien) de doi chieu camera.
//   - PO tao tu trang Dieu hanh mua linh kien (co buy_lines): kiem dung -> nhap kho + giu cho don (dung lai buyingController.receive).
//   - PO nhap tay (PCB, linh kien, gia cong): kiem theo tung dong hang cua PO; du het cac dong -> PO "Đã nhận".
//   - Linh kien KHACH GUI sang (khong co PO): kiem theo don hang.
const db = require('../models/database');
const { ROLES } = require('../config');
const buying = require('./buyingController');
const { parseJson, toNum, today, userName, badRequest, notFound, forbidden } = require('../utils/http');

const OK_TYPE = 'Đúng chủng loại', WRONG_TYPE = 'Sai chủng loại';
const METHODS = ['Nhập tay', 'Máy quét mã vạch', 'Camera mã vạch', 'Camera OCR'];
const isPcb = (type) => type === 'PCB';
// PCB do Mua hang PCB kiem; linh kien / gia cong / hang khach gui do Mua hang linh kien kiem. Truong BP Mua hang va Admin kiem duoc ca hai.
function canCheck(user, pcb) {
    const roles = (user && user.allRoles) || [];
    return roles.includes(ROLES.ADMIN) || roles.includes(ROLES.TBP_MH) || roles.includes(pcb ? ROLES.MH_PCB : ROLES.MH_LK);
}
async function scanKeys() {
    const m = new Map();
    for (const i of await db.allAsync('SELECT id, itemCode, mpn FROM inventory')) m.set(i.id, [i.itemCode, i.mpn].filter(Boolean));
    for (const a of await db.allAsync('SELECT itemId, alias FROM inventory_aliases')) if (m.has(a.itemId)) m.get(a.itemId).push(a.alias);
    return m;
}

async function load(key) {
    const kc = /^kc-(\d+)$/.exec(String(key));
    if (kc) {
        const o = await db.getAsync('SELECT o.id, o.maDH, o.maKH, c.tenKH FROM orders o LEFT JOIN customers c ON c.maKH = o.maKH WHERE o.id = ?', [kc[1]]);
        if (!o) throw notFound('Không tìm thấy đơn hàng.');
        const rows = await db.allAsync('SELECT * FROM buy_lines WHERE orderId = ? AND khachCap = 1 AND cancelledAt IS NULL ORDER BY lineId, id', [o.id]);
        return { kind: 'kc', pcb: false, order: o, rows, title: `Hàng khách gửi · ${o.maDH}`, sub: o.tenKH || o.maKH || '' };
    }
    const po = await db.getAsync('SELECT * FROM purchase_orders WHERE id = ?', [Number(key) || 0]);
    if (!po) throw notFound('Không tìm thấy PO.');
    const rows = await db.allAsync('SELECT * FROM buy_lines WHERE poId = ? ORDER BY id', [po.id]);
    return { kind: rows.length ? 'buy' : 'manual', pcb: isPcb(po.type), po, rows, title: po.poCode, sub: `${po.supplierName || ''}${po.maDH ? ' · đơn ' + po.maDH : ''}` };
}
const manualReceived = async (poId) => new Map((await db.allAsync('SELECT itemIdx, SUM(qty) AS q FROM buy_checks WHERE poId = ? AND buyLineId = 0 AND result = ? GROUP BY itemIdx', [poId, OK_TYPE])).map((r) => [r.itemIdx, toNum(r.q)]));

// GET /api/purchase/check/:key   (key = id PO, hoac kc-<id don> cho hang khach gui)
exports.detail = async (req, res) => {
    const d = await load(req.params.key);
    const keys = await scanKeys();
    let lines, checks;
    if (d.kind === 'manual') {
        const got = await manualReceived(d.po.id);
        lines = parseJson(d.po.items, []).map((it, i) => ({ key: i, name: it.name, code: '', forOrder: d.po.maDH || '', unit: it.unit || '', ordered: toNum(it.qty), received: got.get(i) || 0, price: toNum(it.price), keys: [it.name] }));
        checks = await db.allAsync('SELECT * FROM buy_checks WHERE poId = ? ORDER BY id DESC', [d.po.id]);
    } else {
        lines = d.rows.map((l) => ({ key: l.id, name: l.name, code: l.itemCode || '', forOrder: `${l.maDH} · ${l.tenMach || ''}`, unit: l.unit || '', ordered: toNum(d.kind === 'kc' ? l.qtyNeed : l.qtyOrdered), received: toNum(l.qtyReceived), price: toNum(l.priceActual),
            cancelled: !!l.cancelledAt, alt: l.altNote || '', surplus: l.surplus || '', need: toNum(l.qtyNeed), keys: [...new Set([...(l.itemId ? keys.get(l.itemId) || [] : []), l.itemCode, l.name, l.altNote].filter(Boolean))] }));
        const ids = d.rows.map((l) => l.id);
        checks = ids.length ? await db.allAsync(`SELECT * FROM buy_checks WHERE buyLineId IN (${ids.map(() => '?').join(', ')}) ORDER BY id DESC`, ids) : [];
    }
    const cancelled = d.po && d.po.status === 'Hủy';
    res.json({ success: true, key: req.params.key, kind: d.kind, title: d.title, sub: d.sub, status: d.po ? d.po.status : '', expectedDate: d.po ? d.po.expectedDate : '',
        open: !cancelled && lines.some((l) => !l.cancelled && l.received < l.ordered), canCheck: canCheck(req.session.user, d.pcb), lines, checks,
        info: d.po ? { type: d.po.type, supplierName: d.po.supplierName || '', maDH: d.po.maDH || '', totalAmount: toNum(d.po.totalAmount), currency: d.po.currency || 'VND', createdBy: d.po.createdBy || '', createdAt: d.po.createdAt || '', receivedDate: d.po.receivedDate || '', note: d.po.note || '' } : null,
        ship: d.po ? { poId: d.po.id, shipStatus: d.po.shipStatus || 'Chưa gửi', carrier: d.po.carrier || '', trackingNo: d.po.trackingNo || '', shipNote: d.po.shipNote || '', expectedDate: d.po.expectedDate || '', by: d.po.shipUpdatedBy || '', at: d.po.shipUpdatedAt || '', statuses: require('./purchaseController').SHIP_STATUSES } : null });
};

// POST /api/purchase/check/:key  { items: [{ key, qty, wrong, note, method, scanned }] }
exports.submit = async (req, res) => {
    const d = await load(req.params.key);
    if (!canCheck(req.session.user, d.pcb)) throw forbidden(d.pcb ? 'PO PCB do nhóm Mua hàng PCB kiểm.' : 'Vật tư này do nhóm Mua hàng linh kiện kiểm.');
    const items = (Array.isArray(req.body.items) ? req.body.items : []).map((i) => ({ key: Number(i.key), qty: toNum(i.qty), wrong: !!i.wrong, note: String(i.note || '').trim().slice(0, 300), method: METHODS.includes(i.method) ? i.method : METHODS[0], scanned: String(i.scanned || '').trim().slice(0, 300) })).filter((i) => i.qty > 0);
    if (!items.length) throw badRequest('Chưa nhập số lượng đếm được.');
    if (items.some((i) => i.wrong && !i.note)) throw badRequest('Dòng sai chủng loại cần ghi chú: thực tế nhận được loại gì.');
    const count = { success: true, received: items.filter((i) => !i.wrong).length, wrong: items.filter((i) => i.wrong).length };
    if (d.kind !== 'manual') {
        const own = new Set(d.rows.map((l) => l.id));
        if (items.some((i) => !own.has(i.key))) throw badRequest('Có dòng không thuộc phiếu này.');
        if (d.kind === 'kc' && items.some((i) => i.wrong)) throw badRequest('Hàng khách gửi sai loại: không ghi nhận, báo lại Sale để làm việc với khách.');
        const out = {};
        const fakeRes = { json(o) { out.body = o; return this; }, status() { return this; } };
        await (d.kind === 'kc' ? buying.receiveCustomer : buying.receive)({ body: { items: items.map((i) => ({ ...i, lineId: i.key })) }, session: req.session, params: {}, query: {} }, fakeRes);
        return res.json(count);
    }
    if (d.po.status === 'Hủy') throw badRequest('PO đã hủy.');
    const poItems = parseJson(d.po.items, []);
    const got = await manualReceived(d.po.id);
    for (const it of items) {
        const line = poItems[it.key];
        if (!line) throw badRequest('Có dòng không thuộc PO này.');
        if (!it.wrong && (got.get(it.key) || 0) + it.qty > toNum(line.qty) + 1e-9) throw badRequest(`"${line.name}": đếm ${it.qty} là vượt số đã đặt (${line.qty}, đã về ${got.get(it.key) || 0}).`);
    }
    for (const it of items) {
        const line = poItems[it.key];
        await db.runAsync('INSERT INTO buy_checks (buyLineId, itemIdx, poId, poCode, orderId, maDH, supplierName, itemCode, name, qty, result, note, method, scanned, checkedBy, checkedAt) VALUES (0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            [it.key, d.po.id, d.po.poCode, d.po.orderId || null, d.po.maDH || '', d.po.supplierName || '', '', line.name, it.qty, it.wrong ? WRONG_TYPE : OK_TYPE, it.note, it.method, it.scanned, userName(req), new Date().toISOString()]);
        if (!it.wrong) got.set(it.key, (got.get(it.key) || 0) + it.qty);
    }
    const full = poItems.length > 0 && poItems.every((l, i) => (got.get(i) || 0) >= toNum(l.qty));
    if (full || [...got.values()].some((q) => q > 0)) await db.runAsync('UPDATE purchase_orders SET status = ?, receivedDate = ? WHERE id = ?', [full ? 'Đã nhận' : 'Đang giao', full ? today() : null, d.po.id]);
    res.json(count);
};

// GET /api/purchase/check-log?scope=pcb|lk  -> nhat ky kiem 90 ngay gan nhat cua khau do
exports.log = async (req, res) => {
    const since = new Date(Date.now() - 90 * 86400000).toISOString();
    const pcb = req.query.scope === 'pcb';
    res.json(await db.allAsync(`SELECT c.* FROM buy_checks c LEFT JOIN purchase_orders p ON p.id = c.poId
        WHERE c.checkedAt >= ? AND ${pcb ? "p.type = 'PCB'" : "COALESCE(p.type, '') != 'PCB'"} ORDER BY c.id DESC LIMIT 2000`, [since]));
};

// GET /api/purchase/check-customer -> cac don dang cho linh kien khach gui
exports.customerPending = async (req, res) => {
    res.json(await db.allAsync(`SELECT l.orderId, l.maDH, c.tenKH, COUNT(*) AS lines, SUM(CASE WHEN l.qtyReceived >= l.qtyNeed THEN 1 ELSE 0 END) AS done
        FROM buy_lines l LEFT JOIN orders o ON o.id = l.orderId LEFT JOIN customers c ON c.maKH = o.maKH
        WHERE l.khachCap = 1 AND l.cancelledAt IS NULL AND COALESCE(o.ttQuyTrinh, '') != 'Hủy đơn' GROUP BY l.orderId HAVING done < lines ORDER BY l.orderId DESC`));
};
