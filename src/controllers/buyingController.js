// DIEU HANH MUA LINH KIEN
//   buy_lines: tung dong vat tu can mua cua tung don (sinh khi don chot) -> chon NCC -> gom PO theo NCC -> nhan hang -> ghep bo theo BOM.
//   Hang ve: nhap kho roi GIU ngay cho dung don (phieu Nhap + phieu Xuat), phan mua du (MOQ) nam lai trong kho.
//   Ghep bo: 1 loai mach du bo khi phan lay kho da soan va phan mua da ve du -> ban giao cho san xuat.
const db = require('../models/database');
const { ROLES, PERMS } = require('../config');
const { hasRole } = require('../middlewares/authMiddleware');
const { postTransaction } = require('./inventoryController');
const buy = require('../utils/buyLines');
const { sendGoogleChatMsg } = require('../utils/googleHelper');
const { parseJson, toNum, today, ym, userName, badRequest, notFound, forbidden, conflict } = require('../utils/http');

const DONE = 'Hoàn thành';
const lineStatus = (l) => (l.cancelledAt ? 'Đã hủy' : l.khachCap ? (toNum(l.qtyReceived) <= 0 ? 'Chờ khách gửi' : (toNum(l.qtyReceived) < toNum(l.qtyNeed) ? 'Khách gửi thiếu' : 'Khách đã gửi đủ')) : !l.poId ? 'Chưa đặt' : (toNum(l.qtyReceived) <= 0 ? 'Đã đặt' : (toNum(l.qtyReceived) < (l.toStock ? toNum(l.qtyOrdered) : toNum(l.qtyNeed)) ? 'Về thiếu' : 'Đã về đủ')));
const decorate = (l) => ({ ...l, status: lineStatus(l), late: !!(!l.cancelledAt && l.poId && l.expectedDate && l.expectedDate < today() && toNum(l.qtyReceived) < toNum(l.qtyNeed)) });

// Bang ghep bo cua 1 loai mach: tung dong BOM -> can / lay kho (da soan?) / mua (da ve?)
function buildKit(board, holds, lines) {
    const detail = (parseJson(board.costDetail, {}) || {})[buy.FIELD];
    const bom = detail && Array.isArray(detail.lines) ? detail.lines : null;
    const stockLeft = new Map(); // itemId -> { qty da soan, qty tong } (1 ma co the nam o nhieu dong BOM)
    for (const h of holds) {
        const s = stockLeft.get(h.itemId) || { picked: 0, total: 0, holds: [] };
        s.total += h.quantity; if (h.pickedAt || h.shippedAt) s.picked += h.quantity;
        s.holds.push({ id: h.id, picked: !!(h.pickedAt || h.shippedAt), shipped: !!h.shippedAt, pickedBy: h.pickedBy || '' });
        stockLeft.set(h.itemId, s);
    }
    const rows = (bom || []).map((l, idx) => {
        const bl0 = lines.find((x) => x.bomIdx === idx) || null;
        const khachCap = !!(l.khachCap || (bl0 && bl0.khachCap));
        // dong khach cap: phan "mua" chinh la so luong khach phai gui sang
        const fromStock = khachCap ? 0 : toNum(l.fromStock), toBuy = khachCap ? toNum(l.need) : toNum(l.toBuy);
        const s = stockLeft.get(l.itemId) || { picked: 0, total: 0, holds: [] };
        // cac dong tam xuat kho cua ma nay (de tick "da soan" ngay tren bang ghep bo); 1 ma nam o nhieu dong BOM thi chi gan cho dong dau
        const holdsOfRow = fromStock > 0 ? s.holds.splice(0) : [];
        const stockGot = Math.min(fromStock, s.picked); s.picked -= stockGot;
        const bl = lines.find((x) => x.bomIdx === idx) || null;
        const buyGot = bl ? Math.min(toBuy, toNum(bl.qtyReceived)) : 0;
        return {
            name: l.name, itemCode: l.itemCode || '', unit: l.unit || '', need: toNum(l.need), fromStock, stockGot, toBuy, buyGot, khachCap, buyLineId: bl ? bl.id : null, itemId: l.itemId || null, holds: holdsOfRow,
            supplierName: bl ? bl.supplierName || '' : '', poCode: bl ? bl.poCode || '' : '', buyStatus: bl ? lineStatus(bl) : '', expectedDate: bl ? bl.expectedDate || '' : '',
            ready: stockGot >= fromStock && buyGot >= toBuy
        };
    });
    const ready = rows.filter((r) => r.ready).length;
    return {
        lineId: board.id, tenMach: board.tenMach, soLuongLK: board.soLuongLK, hasBom: !!bom, rows, total: rows.length, ready,
        complete: ready === rows.length, khachRows: rows.filter((r) => r.khachCap).length, kitAt: board.kitAt, kitBy: board.kitBy, kitNote: board.kitNote, kitCode: board.kitCode
    };
}

async function loadKit(lineId) {
    const board = await db.getAsync('SELECT * FROM order_items WHERE id = ?', [lineId]);
    if (!board) return null;
    const holds = await db.allAsync(`SELECT * FROM stock_holds WHERE lineId = ? AND field = ? AND status = 'issued'`, [lineId, buy.FIELD]);
    const lines = await db.allAsync('SELECT * FROM buy_lines WHERE lineId = ?', [lineId]);
    return { board, kit: buildKit(board, holds, lines) };
}

// GET /api/buying/overview
exports.buildKit = buildKit;
// Ghi 1 dong nhat ky kiem vat tu
const METHODS = ['Nhập tay', 'Máy quét mã vạch', 'Camera mã vạch', 'Camera OCR'];
const OK_TYPE = 'Đúng chủng loại', WRONG_TYPE = 'Sai chủng loại';
async function logCheck(req, l, it, result) {
    await db.runAsync('INSERT INTO buy_checks (buyLineId, poId, poCode, orderId, maDH, supplierName, itemCode, name, qty, result, note, method, scanned, checkedBy, checkedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [l.id, l.poId || null, l.poCode || '', l.orderId, l.maDH, l.khachCap ? 'Khách gửi' : (l.supplierName || ''), l.itemCode || '', l.name, it.qty, result, String(it.note || '').trim().slice(0, 300),
            METHODS.includes(it.method) ? it.method : METHODS[0], String(it.scanned || '').trim().slice(0, 300), userName(req), new Date().toISOString()]);
}
exports.overview = async (req, res) => {
    const since = new Date(Date.now() - 60 * 86400000).toISOString();
    const orders = await db.allAsync(`
        SELECT o.id, o.maDH, o.maKH, o.ngayChot, o.ngayBanGiao, o.ttQuyTrinh, o.ttDonHang, c.tenKH
        FROM orders o LEFT JOIN customers c ON c.maKH = o.maKH
        WHERE o.loaiDV = 'sx' AND o.ttChotDon = 'Đã chốt' AND COALESCE(o.ttQuyTrinh, '') != 'Hủy đơn' AND COALESCE(o.soLuongLK, 0) > 0
        ORDER BY o.id DESC`);
    const boards = await db.allAsync('SELECT * FROM order_items WHERE soLuongLK > 0 ORDER BY orderId, stt, id');
    const holds = await db.allAsync(`SELECT * FROM stock_holds WHERE field = ? AND status = 'issued'`, [buy.FIELD]);
    const lines = (await db.allAsync('SELECT * FROM buy_lines ORDER BY id')).map(decorate);
    const group = (list, key) => { const m = new Map(); for (const x of list) { if (!m.has(x[key])) m.set(x[key], []); m.get(x[key]).push(x); } return m; };
    const holdsByLine = group(holds, 'lineId'), linesByLine = group(lines, 'lineId'), boardsByOrder = group(boards, 'orderId');

    const outOrders = [];
    for (const o of orders) {
        const kits = (boardsByOrder.get(o.id) || []).map((b) => buildKit(b, holdsByLine.get(b.id) || [], linesByLine.get(b.id) || []));
        if (!kits.length) continue;
        const finished = o.ttQuyTrinh === DONE || o.ttDonHang === DONE;
        const open = kits.some((k) => !k.kitAt);
        if (open ? finished : !kits.some((k) => k.kitAt >= since)) continue; // an don cu da giao xong / da ban giao qua 60 ngay
        const total = kits.reduce((s, k) => s + k.total, 0), ready = kits.reduce((s, k) => s + k.ready, 0);
        const etas = kits.flatMap((k) => k.rows.filter((r) => !r.ready && r.expectedDate).map((r) => r.expectedDate)).sort();
        const status = !open ? 'Đã bàn giao' : (kits.filter((k) => !k.kitAt).every((k) => k.complete) ? 'Đủ bộ, chờ bàn giao' : 'Đang gom');
        outOrders.push({ orderId: o.id, maDH: o.maDH, tenKH: o.tenKH || o.maKH || '', ngayChot: o.ngayChot, ngayBanGiao: o.ngayBanGiao, kits, total, ready, status, eta: etas.length ? etas[etas.length - 1] : '' });
    }
    // Vi tri kho cua tung ma (de di soan)
    const locs = new Map((await db.allAsync('SELECT id, location FROM inventory')).map((i) => [i.id, i.location || '']));
    for (const o of outOrders) for (const k of o.kits) for (const r of k.rows) r.location = r.itemId ? (locs.get(r.itemId) || '') : '';
    const shown = new Set(outOrders.map((o) => o.orderId));
    const pos = await db.allAsync(`SELECT id, poCode, supplierId, supplierName, totalAmount, status, createdBy, createdAt, expectedDate, receivedDate, note, shipStatus, carrier, trackingNo, shipNote
        FROM purchase_orders WHERE id IN (SELECT DISTINCT poId FROM buy_lines WHERE poId IS NOT NULL) ORDER BY id DESC`);
    // Tu khoa de may quet / camera tim ra dong vat tu: ma hang, ma NSX, ten goi khac
    const keyOf = new Map();
    for (const i of await db.allAsync('SELECT id, itemCode, mpn FROM inventory')) keyOf.set(i.id, [i.itemCode, i.mpn].filter(Boolean));
    for (const a of await db.allAsync('SELECT itemId, alias FROM inventory_aliases')) if (keyOf.has(a.itemId)) keyOf.get(a.itemId).push(a.alias);
    for (const l of lines) l.keys = [...new Set([...(l.itemId ? keyOf.get(l.itemId) || [] : []), l.itemCode, l.name].filter(Boolean))];
    const checks = await db.allAsync('SELECT * FROM buy_checks WHERE checkedAt >= ? ORDER BY id DESC LIMIT 2000', [since]);
    res.json({
        checks,
        orders: outOrders,
        lines: lines.filter((l) => shown.has(l.orderId)),
        cancelled: await cancelledOrders(lines),
        pos: pos.map((p) => { const ls = lines.filter((l) => l.poId === p.id); return { ...p, lines: ls, late: ls.some((l) => l.late) }; })
            .filter((p) => p.status !== 'Đã nhận' || (p.receivedDate || '') >= since.slice(0, 10)),
        suppliers: await db.allAsync(`SELECT id, name FROM suppliers WHERE COALESCE(status, 1) = 1 AND COALESCE(type, '') IN ('', 'LinhKien', 'Tất cả') ORDER BY name`),
        canOrder: hasRole(req.session.user, [ROLES.MH_LK, ROLES.QLSX]), canForce: hasRole(req.session.user, [ROLES.QLSX]), canResolve: hasRole(req.session.user, PERMS.BUYING_RESOLVE)
    });
};

// Don DA CHOT roi bi HUY: nhung gi con treo -> dong da dat hang chua xu ly + hang kho dang giu (chua ban giao san xuat)
async function cancelledOrders(lines) {
    const orders = await db.allAsync(`SELECT o.id, o.maDH, o.maKH, o.lyDoHuy, c.tenKH FROM orders o LEFT JOIN customers c ON c.maKH = o.maKH
        WHERE o.loaiDV = 'sx' AND o.ttChotDon = 'Đã chốt' AND o.ttQuyTrinh = 'Hủy đơn' ORDER BY o.id DESC`);
    const out = [];
    for (const o of orders) {
        const pending = lines.filter((l) => l.orderId === o.id && l.poId && !l.resolution);
        const holds = await db.allAsync(`SELECT h.id, h.quantity, v.itemCode, v.itemName, v.unit, l.tenMach FROM stock_holds h
            LEFT JOIN inventory v ON v.id = h.itemId LEFT JOIN order_items l ON l.id = h.lineId
            WHERE h.orderId = ? AND h.status = 'issued' AND l.kitAt IS NULL`, [o.id]);
        const done = lines.filter((l) => l.orderId === o.id && l.resolution);
        if (pending.length || holds.length) out.push({ orderId: o.id, maDH: o.maDH, tenKH: o.tenKH || o.maKH || '', lyDoHuy: o.lyDoHuy || '', pending, holds, done });
    }
    return out;
}
async function refreshPO(poId) {
    const ls = await db.allAsync('SELECT * FROM buy_lines WHERE poId = ?', [poId]);
    const live = ls.filter((l) => !l.cancelledAt);
    const total = Math.round(live.reduce((s, l) => s + l.qtyOrdered * l.priceActual, 0));
    const full = live.length && live.every((l) => toNum(l.qtyReceived) >= toNum(l.qtyOrdered));
    const status = !live.length ? 'Hủy' : (full ? 'Đã nhận' : (live.some((l) => toNum(l.qtyReceived) > 0) ? 'Đang giao' : 'Đã đặt hàng'));
    await db.runAsync('UPDATE purchase_orders SET totalAmount = ?, status = ?, receivedDate = CASE WHEN ? = 1 THEN COALESCE(receivedDate, ?) ELSE receivedDate END WHERE id = ?', [total, status, full ? 1 : 0, today(), poId]);
}

// POST /api/buying/resolve/:lineId  { action: 'cancel' | 'tostock', note }   (Truong BP Mua hang / Admin)
//   cancel  : huy dong voi NCC (chi khi hang chua ve)
//   tostock : van nhan hang nhung nhap kho thuong; phan da ve dang giu cho don duoc tra lai ton kho
exports.resolveLine = async (req, res) => {
    const l = await db.getAsync('SELECT b.*, o.ttQuyTrinh FROM buy_lines b JOIN orders o ON o.id = b.orderId WHERE b.id = ?', [req.params.lineId]);
    if (!l) throw notFound('Không tìm thấy dòng mua.');
    if (l.ttQuyTrinh !== 'Hủy đơn') throw badRequest('Chỉ xử lý dòng mua của đơn đã hủy.');
    if (l.resolution) throw conflict('Dòng này đã được xử lý.');
    const user = userName(req), now = new Date().toISOString();
    const note = String(req.body.note || '').trim().slice(0, 300);
    if (req.body.action === 'cancel') {
        if (toNum(l.qtyReceived) > 0) throw badRequest('Hàng đã về một phần, không hủy được: chọn "Chuyển nhập kho".');
        await db.runAsync('UPDATE buy_lines SET cancelledAt = ?, resolution = ?, resolvedBy = ?, resolvedAt = ? WHERE id = ?', [now, `Hủy với NCC${note ? ': ' + note : ''}`, user, now, l.id]);
    } else if (req.body.action === 'tostock') {
        const reserved = Math.min(toNum(l.qtyReceived), toNum(l.qtyNeed));
        if (reserved > 0 && l.itemId) {
            const item = await db.getAsync('SELECT * FROM inventory WHERE id = ?', [l.itemId]);
            if (item) await postTransaction({ item, type: 'Nhap', quantity: reserved, unitPrice: 0, reason: `Tái nhập - đơn ${l.maDH} hủy sau khi mua`, refType: 'TaiNhap', refId: String(l.orderId), refCode: l.maDH, user });
        }
        await db.runAsync('UPDATE buy_lines SET toStock = 1, resolution = ?, resolvedBy = ?, resolvedAt = ? WHERE id = ?', [`Chuyển nhập kho${note ? ': ' + note : ''}`, user, now, l.id]);
    } else throw badRequest('Cách xử lý không hợp lệ.');
    await refreshPO(l.poId);
    res.json({ success: true });
};

// POST /api/buying/resolve-stock/:orderId  -> tra hang kho dang giu cho don huy ve ton kho (loai mach chua ban giao san xuat)
exports.resolveStock = async (req, res) => {
    const order = await db.getAsync('SELECT id, maDH, ttQuyTrinh FROM orders WHERE id = ?', [req.params.orderId]);
    if (!order) throw notFound('Không tìm thấy đơn hàng.');
    if (order.ttQuyTrinh !== 'Hủy đơn') throw badRequest('Chỉ trả kho cho đơn đã hủy.');
    const rows = await db.allAsync(`SELECT h.* FROM stock_holds h LEFT JOIN order_items l ON l.id = h.lineId WHERE h.orderId = ? AND h.status = 'issued' AND l.kitAt IS NULL`, [order.id]);
    const user = userName(req);
    for (const h of rows) {
        const item = await db.getAsync('SELECT * FROM inventory WHERE id = ?', [h.itemId]);
        if (item) await postTransaction({ item, type: 'Nhap', quantity: h.quantity, unitPrice: 0, reason: `Tái nhập - đơn ${order.maDH} hủy sau khi chốt`, refType: 'TaiNhap', refId: String(order.id), refCode: order.maDH, user });
        await db.runAsync(`UPDATE stock_holds SET status = 'released', closedAt = ? WHERE id = ?`, [new Date().toISOString(), h.id]);
    }
    res.json({ success: true, count: rows.length });
};

// PATCH /api/buying/lines/:id  { supplierName, qtyOrdered, priceActual }  (chi khi chua vao PO)
exports.updateLine = async (req, res) => {
    const line = await db.getAsync('SELECT * FROM buy_lines WHERE id = ?', [req.params.id]);
    if (!line) throw notFound('Không tìm thấy dòng cần mua.');
    if (line.poId) throw conflict(`Dòng này đã nằm trong ${line.poCode}, không sửa được.`);
    const sup = req.body.supplierName !== undefined ? await buy.ensureSupplier(req.body.supplierName) : { id: line.supplierId, name: line.supplierName };
    const qtyOrdered = req.body.qtyOrdered !== undefined ? toNum(req.body.qtyOrdered) : line.qtyOrdered;
    const priceActual = req.body.priceActual !== undefined ? toNum(req.body.priceActual) : line.priceActual;
    if (qtyOrdered < line.qtyNeed) throw badRequest(`Số lượng đặt không được nhỏ hơn số cần (${line.qtyNeed}).`);
    if (priceActual < 0) throw badRequest('Giá mua không được âm.');
    await db.runAsync('UPDATE buy_lines SET supplierId = ?, supplierName = ?, qtyOrdered = ?, priceActual = ?, updatedAt = ? WHERE id = ?',
        [sup.id, sup.name, qtyOrdered, priceActual, new Date().toISOString(), line.id]);
    // Tu tro mua theo nhom: doi NCC cho ca nhom tu tro chua dat cua don (applyGroup). Khong chon -> chi doi rieng dong nay (NCC het hang).
    let grouped = 0;
    if (req.body.applyGroup && req.body.supplierName !== undefined && line.grp === 'passive') {
        const r = await db.runAsync(`UPDATE buy_lines SET supplierId = ?, supplierName = ?, updatedAt = ? WHERE orderId = ? AND grp = 'passive' AND poId IS NULL AND cancelledAt IS NULL AND id != ?`,
            [sup.id, sup.name, new Date().toISOString(), line.orderId, line.id]);
        grouped = r.changes;
    }
    res.json({ success: true, grouped });
};

// POST /api/buying/po  { lineIds: [], expectedDate, note }  -> moi NCC 1 PO
exports.createPOs = async (req, res) => {
    const ids = [...new Set((Array.isArray(req.body.lineIds) ? req.body.lineIds : []).map(Number).filter(Boolean))];
    if (!ids.length) throw badRequest('Chưa chọn dòng nào để đặt hàng.');
    const lines = await db.allAsync(`SELECT * FROM buy_lines WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
    if (lines.some((l) => l.khachCap)) throw badRequest('Dòng khách cấp không đặt mua.');
    if (lines.some((l) => l.cancelledAt)) throw conflict('Có dòng thuộc đơn đã hủy, vui lòng tải lại trang.');
    if (lines.some((l) => l.poId)) throw conflict('Có dòng đã được đặt hàng, vui lòng tải lại trang.');
    const noSup = lines.filter((l) => !l.supplierId);
    if (noSup.length) throw badRequest(`Còn ${noSup.length} dòng chưa chọn nhà cung cấp (vd: ${noSup[0].name}).`);
    const expectedDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.expectedDate || '') ? req.body.expectedDate : null;
    const user = userName(req);
    const { yy, mm } = ym();
    const prefix = `PO-LK-${yy}${mm}`;
    const created = [];
    const bySup = new Map();
    for (const l of lines) { if (!bySup.has(l.supplierId)) bySup.set(l.supplierId, []); bySup.get(l.supplierId).push(l); }
    for (const [supplierId, ls] of bySup) {
        const poCode = `${prefix}-${String(await db.nextSeq(prefix)).padStart(3, '0')}`;
        const items = ls.map((l) => ({ name: l.name, qty: l.qtyOrdered, price: l.priceActual, maDH: l.maDH, buyLineId: l.id }));
        const totalAmount = Math.round(ls.reduce((s, l) => s + l.qtyOrdered * l.priceActual, 0));
        const orderIds = [...new Set(ls.map((l) => l.orderId))];
        const r = await db.runAsync(
            `INSERT INTO purchase_orders (poCode,orderId,maDH,type,supplierId,supplierName,items,totalAmount,currency,status,createdBy,createdAt,expectedDate,note)
             VALUES (?,?,?,'LinhKien',?,?,?,?,'VND','Đã đặt hàng',?,?,?,?)`,
            [poCode, orderIds.length === 1 ? orderIds[0] : null, [...new Set(ls.map((l) => l.maDH))].join(', '), supplierId, ls[0].supplierName,
                JSON.stringify(items), totalAmount, user, new Date().toISOString(), expectedDate, String(req.body.note || '').slice(0, 500)]);
        await db.runAsync(`UPDATE buy_lines SET poId = ?, poCode = ?, expectedDate = ?, updatedAt = ? WHERE id IN (${ls.map(() => '?').join(', ')})`,
            [r.lastID, poCode, expectedDate, new Date().toISOString(), ...ls.map((l) => l.id)]);
        created.push({ poCode, supplierName: ls[0].supplierName, lines: ls.length, totalAmount });
    }
    res.json({ success: true, pos: created });
};

// POST /api/buying/receive  { items: [{ lineId, qty }] }  -> nhap kho, giu cho don, cap nhat PO
exports.receive = async (req, res) => {
    // Moi lan nhan = 1 lan KIEM: dem so luong + xac nhan chung loai. Sai chung loai -> chi ghi nhat ky, KHONG nhan hang.
    const items = (Array.isArray(req.body.items) ? req.body.items : []).map((i) => ({ lineId: Number(i.lineId), qty: toNum(i.qty), wrong: !!i.wrong, note: i.note, method: i.method, scanned: i.scanned })).filter((i) => i.lineId && i.qty > 0);
    if (!items.length) throw badRequest('Chưa nhập số lượng đếm được.');
    const bad = items.find((i) => i.wrong && !String(i.note || '').trim());
    if (bad) throw badRequest('Dòng sai chủng loại cần ghi chú: thực tế nhận được loại gì.');
    const user = userName(req);
    const poIds = new Set();
    for (const it of items) {
        const l = await db.getAsync('SELECT * FROM buy_lines WHERE id = ?', [it.lineId]);
        if (!l) throw notFound('Không tìm thấy dòng cần mua.');
        if (l.khachCap) throw badRequest(`"${l.name}" là hàng khách cấp, nhận ở mục khách gửi.`);
        if (!l.poId) throw badRequest(`"${l.name}" chưa được đặt hàng.`);
        if (l.cancelledAt) throw badRequest(`"${l.name}" đã hủy, không nhận hàng.`);
        if (it.wrong) { await logCheck(req, l, it, WRONG_TYPE); continue; }
        if (l.toStock) l.qtyNeed = 0; // don da huy: hang ve nhap kho thuong, khong giu cho don
        if (toNum(l.qtyReceived) + it.qty > toNum(l.qtyOrdered) + 1e-9) throw badRequest(`"${l.name}": nhận ${it.qty} là vượt số đã đặt (${l.qtyOrdered}, đã về ${l.qtyReceived}).`);
        if (l.surplus === 'khach' && !l.toStock) l.qtyNeed = Math.max(toNum(l.qtyNeed), toNum(l.qtyOrdered)); // phan mua du TRA KHACH: giu ca cho don, khong de lai kho
        const reserve = Math.min(l.qtyReceived + it.qty, l.qtyNeed) - Math.min(l.qtyReceived, l.qtyNeed); // phan giu cho don; con lai (mua du) nam trong kho
        if (l.itemId) {
            const item = await db.getAsync('SELECT * FROM inventory WHERE id = ?', [l.itemId]);
            if (item) {
                await postTransaction({ item, type: 'Nhap', quantity: it.qty, unitPrice: l.priceActual, reason: `Nhập mua hàng ${l.poCode} - ${l.supplierName}`, refType: 'MuaHang', refId: String(l.poId), refCode: l.poCode, user });
                if (reserve > 0) {
                    const fresh = await db.getAsync('SELECT * FROM inventory WHERE id = ?', [l.itemId]);
                    await postTransaction({ item: fresh, type: 'Xuat', quantity: reserve, reason: `Giữ cho đơn ${l.maDH} - ${l.tenMach || ''}`.trim(), refType: 'GiuChoDon', refId: String(l.orderId), refCode: l.maDH, user });
                }
            }
        }
        await db.runAsync('UPDATE buy_lines SET qtyReceived = qtyReceived + ?, updatedAt = ? WHERE id = ?', [it.qty, new Date().toISOString(), l.id]);
        await logCheck(req, l, it, OK_TYPE);
        poIds.add(l.poId);
    }
    for (const poId of poIds) {
        const ls = await db.allAsync('SELECT qtyOrdered, qtyReceived FROM buy_lines WHERE poId = ? AND cancelledAt IS NULL', [poId]);
        const full = ls.every((l) => toNum(l.qtyReceived) >= toNum(l.qtyOrdered));
        await db.runAsync('UPDATE purchase_orders SET status = ?, receivedDate = ? WHERE id = ?', [full ? 'Đã nhận' : 'Đang giao', full ? today() : null, poId]);
    }
    res.json({ success: true, received: items.filter((i) => !i.wrong).length, wrong: items.filter((i) => i.wrong).length });
};

// POST /api/buying/receive-customer  { items: [{ lineId, qty }] }  -> ghi nhan linh kien KHACH GUI sang (khong nhap kho cong ty)
exports.receiveCustomer = async (req, res) => {
    const items = (Array.isArray(req.body.items) ? req.body.items : []).map((i) => ({ lineId: Number(i.lineId), qty: toNum(i.qty), note: i.note, method: i.method, scanned: i.scanned })).filter((i) => i.lineId && i.qty > 0);
    if (!items.length) throw badRequest('Chưa nhập số lượng khách gửi.');
    for (const it of items) {
        const l = await db.getAsync('SELECT * FROM buy_lines WHERE id = ?', [it.lineId]);
        if (!l || !l.khachCap) throw notFound('Không tìm thấy dòng khách cấp.');
        if (l.cancelledAt) throw badRequest('Dòng này đã hủy.');
        await db.runAsync('UPDATE buy_lines SET qtyReceived = qtyReceived + ?, updatedAt = ? WHERE id = ?', [it.qty, new Date().toISOString(), l.id]);
        await logCheck(req, l, it, OK_TYPE);
    }
    res.json({ success: true });
};

// POST /api/buying/kit/:lineId  { note, force }  -> ban giao bo linh kien cua 1 loai mach cho san xuat
exports.handoff = async (req, res) => {
    const data = await loadKit(req.params.lineId);
    if (!data) throw notFound('Không tìm thấy loại mạch.');
    const { board, kit } = data;
    if (board.kitAt) throw conflict('Loại mạch này đã bàn giao rồi.');
    const order = await db.getAsync('SELECT id, maDH, ttChotDon, ttQuyTrinh FROM orders WHERE id = ?', [board.orderId]);
    if (!order || order.ttChotDon !== 'Đã chốt' || order.ttQuyTrinh === 'Hủy đơn') throw badRequest('Chỉ bàn giao cho đơn đã chốt.');
    const note = String(req.body.note || '').trim().slice(0, 500);
    if (!kit.complete) {
        if (!req.body.force) throw badRequest(`Chưa đủ bộ: còn ${kit.total - kit.ready} mã chưa soạn / chưa về.`);
        if (!hasRole(req.session.user, [ROLES.QLSX])) throw forbidden('Chỉ Quản lý sản xuất hoặc Admin được cho bàn giao khi chưa đủ bộ.');
        if (!note) throw badRequest('Bàn giao thiếu cần ghi rõ lý do.');
    }
    const { yy, mm } = ym();
    const prefix = `BG-${yy}${mm}`;
    const kitCode = `${prefix}-${String(await db.nextSeq(prefix)).padStart(3, '0')}`;
    const now = new Date().toISOString(), user = userName(req);
    await db.runAsync('UPDATE order_items SET kitAt = ?, kitBy = ?, kitNote = ?, kitCode = ? WHERE id = ?', [now, user, kit.complete ? note : `BÀN GIAO THIẾU: ${note}`, kitCode, board.id]);
    // phan lay kho da soan cua loai mach nay duoc xuat that kem phieu ban giao
    await db.runAsync(`UPDATE stock_holds SET shippedAt = ?, shippedBy = ?, shipCode = ? WHERE lineId = ? AND field = ? AND status = 'issued' AND shippedAt IS NULL AND pickedAt IS NOT NULL`,
        [now, user, kitCode, board.id, buy.FIELD]);
    sendGoogleChatMsg(order.maDH, user, `Bàn giao linh kiện [${board.tenMach}] cho sản xuất — phiếu ${kitCode}${kit.complete ? ' (đủ bộ)' : ` (THIẾU ${kit.total - kit.ready} mã: ${note})`}`);
    res.json({ success: true, kitCode, complete: kit.complete });
};
