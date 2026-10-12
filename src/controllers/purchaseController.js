const db = require('../models/database');
const { ROLES } = require('../config');
const { listConfirmedOrders } = require('./orderController');
const { parseJson, toNum, today, ym, emptyToNull, userName, badRequest, notFound, forbidden } = require('../utils/http');

const PO_TYPES = ['PCB', 'LinhKien', 'GiaCong'];
const PO_STATUSES = ['Chờ duyệt', 'Đã duyệt', 'Đã đặt hàng', 'Đang giao', 'Đã nhận', 'Hủy'];
const RECEIVED = 'Đã nhận';

// Mua hang PCB chi thao tac PO loai PCB; Mua hang linh kien chi thao tac Linh kien / Gia cong.
// Admin va Quan ly san xuat thao tac duoc tat ca.
function assertCanHandleType(user, type) {
    const roles = user.allRoles || [];
    if (roles.includes(ROLES.ADMIN) || roles.includes(ROLES.QLSX)) return;
    if (roles.includes(ROLES.TBP_MH)) return;
    const ok = type === 'PCB' ? roles.includes(ROLES.MH_PCB) : roles.includes(ROLES.MH_LK);
    if (!ok) throw forbidden('Bạn không có quyền thao tác PO thuộc loại này.');
}

// ===== SUPPLIERS =====
exports.getSuppliers = async (req, res) => {
    res.json(await db.allAsync('SELECT * FROM suppliers ORDER BY name ASC'));
};

exports.saveSupplier = async (req, res) => {
    const { id, type, phone, email, address, contactPerson, bankName, bankNo, note, status } = req.body;
    const name = String(req.body.name || '').trim();
    const rating = Math.max(1, Math.min(5, Math.round(toNum(req.body.rating, 3))));
    if (!name) throw badRequest('Vui lòng nhập tên nhà cung cấp.');

    if (id) {
        const result = await db.runAsync(
            'UPDATE suppliers SET name=?,type=?,phone=?,email=?,address=?,contactPerson=?,bankName=?,bankNo=?,note=?,rating=?,status=? WHERE id=?',
            [name, type, phone, email, address, contactPerson, bankName, bankNo, note, rating, status !== false && status !== 0 ? 1 : 0, id]);
        if (!result.changes) throw notFound('Không tìm thấy nhà cung cấp.');
        return res.json({ success: true });
    }
    // Ma NCC bo trong -> luu NULL (cot UNIQUE: nhieu chuoi rong '' se bi bao trung tu NCC thu 2).
    const result = await db.runAsync(
        'INSERT INTO suppliers (code,name,type,phone,email,address,contactPerson,bankName,bankNo,note,rating,status,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)',
        [emptyToNull(req.body.code), name, type, phone, email, address, contactPerson, bankName, bankNo, note, rating, new Date().toISOString()]);
    res.json({ success: true, id: result.lastID });
};

exports.deleteSupplier = async (req, res) => {
    const result = await db.runAsync('DELETE FROM suppliers WHERE id = ?', [req.params.id]);
    if (!result.changes) throw notFound('Không tìm thấy nhà cung cấp.');
    res.json({ success: true });
};

// ===== PURCHASE ORDERS =====
exports.getPurchaseOrders = async (req, res) => {
    const { type } = req.query;
    const rows = type
        ? await db.allAsync('SELECT * FROM purchase_orders WHERE type = ? ORDER BY id DESC', [type])
        : await db.allAsync('SELECT * FROM purchase_orders ORDER BY id DESC');
    res.json(rows.map((r) => ({ ...r, items: parseJson(r.items, []), attachments: parseJson(r.attachments, []) })));
};

exports.savePurchaseOrder = async (req, res) => {
    const { id, orderId, maDH, type, supplierId, supplierName, items, currency, expectedDate, note } = req.body;
    const status = req.body.status || 'Chờ duyệt';
    const totalAmount = toNum(req.body.totalAmount);

    if (!PO_TYPES.includes(type)) throw badRequest('Loại PO không hợp lệ.');
    if (!PO_STATUSES.includes(status)) throw badRequest('Trạng thái PO không hợp lệ.');
    if (totalAmount < 0) throw badRequest('Giá trị PO không được âm.');
    assertCanHandleType(req.session.user, type);
    const itemsStr = JSON.stringify(Array.isArray(items) ? items : []);

    if (id) {
        const current = await db.getAsync('SELECT id, type, receivedDate FROM purchase_orders WHERE id = ?', [id]);
        if (!current) throw notFound('Không tìm thấy PO.');
        assertCanHandleType(req.session.user, current.type);
        const receivedDate = status === RECEIVED ? (current.receivedDate || today()) : current.receivedDate;
        await db.runAsync(
            'UPDATE purchase_orders SET orderId=?,maDH=?,type=?,supplierId=?,supplierName=?,items=?,totalAmount=?,currency=?,status=?,expectedDate=?,receivedDate=?,note=? WHERE id=?',
            [orderId, maDH, type, supplierId, supplierName, itemsStr, totalAmount, currency || 'VND', status, expectedDate, receivedDate, note, id]);
        return res.json({ success: true });
    }

    // Ma PO: PO-<loai>-<YYMM>-<STT 3 so>, cap so tang dan nen khong bi trung.
    const { yy, mm } = ym();
    const prefix = `PO-${{ PCB: 'PCB', LinhKien: 'LK', GiaCong: 'GC' }[type]}-${yy}${mm}`;
    const poCode = `${prefix}-${String(await db.nextSeq(prefix)).padStart(3, '0')}`;
    const result = await db.runAsync(
        `INSERT INTO purchase_orders (poCode,orderId,maDH,type,supplierId,supplierName,items,totalAmount,currency,status,createdBy,createdAt,expectedDate,receivedDate,note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [poCode, orderId, maDH, type, supplierId, supplierName, itemsStr, totalAmount, currency || 'VND', status,
            userName(req), new Date().toISOString(), expectedDate, status === RECEIVED ? today() : null, note]);
    res.json({ success: true, id: result.lastID, poCode });
};

exports.updatePOStatus = async (req, res) => {
    const { status } = req.body;
    if (!PO_STATUSES.includes(status)) throw badRequest('Trạng thái PO không hợp lệ.');

    const current = await db.getAsync('SELECT id, type, receivedDate FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!current) throw notFound('Không tìm thấy PO.');
    assertCanHandleType(req.session.user, current.type);

    // "Đã nhận" ma khong gui ngay -> lay hom nay (truoc day ngay nhan bi bo trong).
    const receivedDate = status === RECEIVED ? (req.body.receivedDate || current.receivedDate || today()) : current.receivedDate;
    await db.runAsync('UPDATE purchase_orders SET status = ?, receivedDate = ? WHERE id = ?', [status, receivedDate, current.id]);
    res.json({ success: true });
};

// PATCH /api/purchase/orders/:id/shipping { shipStatus, carrier, trackingNo, shipNote, expectedDate } -> van chuyen tu NCC ve
const SHIP_STATUSES = ['Chưa gửi', 'NCC đã gửi', 'Đang vận chuyển', 'Thông quan', 'Đang giao nội địa', 'Đã về'];
exports.SHIP_STATUSES = SHIP_STATUSES;
exports.updateShipping = async (req, res) => {
    const po = await db.getAsync('SELECT id, type, expectedDate FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!po) throw notFound('Không tìm thấy PO.');
    assertCanHandleType(req.session.user, po.type);
    const b = req.body || {};
    if (!SHIP_STATUSES.includes(b.shipStatus)) throw badRequest('Tình trạng vận chuyển không hợp lệ.');
    const cut = (v, n) => String(v || '').trim().slice(0, n);
    const eta = /^\d{4}-\d{2}-\d{2}$/.test(b.expectedDate || '') ? b.expectedDate : po.expectedDate;
    await db.runAsync('UPDATE purchase_orders SET shipStatus=?, carrier=?, trackingNo=?, shipNote=?, expectedDate=?, shipUpdatedBy=?, shipUpdatedAt=? WHERE id=?',
        [b.shipStatus, cut(b.carrier, 100), cut(b.trackingNo, 100), cut(b.shipNote, 300), eta, userName(req), new Date().toISOString(), po.id]);
    res.json({ success: true });
};

exports.deletePurchaseOrder = async (req, res) => {
    const current = await db.getAsync('SELECT id, type FROM purchase_orders WHERE id = ?', [req.params.id]);
    if (!current) throw notFound('Không tìm thấy PO.');
    assertCanHandleType(req.session.user, current.type);
    await db.runAsync('DELETE FROM purchase_orders WHERE id = ?', [current.id]);
    res.json({ success: true });
};

// Don hang Sale da chot co hang muc tuong ung (PCB / Linh kien / Gia cong)
exports.getOrdersForPurchase = async (req, res) => {
    res.json(await listConfirmedOrders(req.query.type || ''));
};
