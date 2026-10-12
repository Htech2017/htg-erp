// XUAT LINH KIEN THEO DON HANG (soan hang tu kho cho don da chot)
//   - Khi bao gia, phan "lay kho" da duoc TAM XUAT (ton kho da giam).
//   - Khach chot -> cac dong tam xuat chuyen 'issued' va hien o day de soan.
//   - Soan du -> "Xuat kho": cap so phieu xuat (PXK-YYMM-001), danh dau da xuat that. Ton kho KHONG tru them lan nua.
const db = require('../models/database');
const { today, ym, userName, badRequest, notFound, conflict } = require('../utils/http');

const DONE = 'Hoàn thành';
const CANCELLED = 'Hủy đơn';

// GET /api/purchase/picking  -> danh sach don can soan + don da xuat trong 60 ngay
exports.getPicking = async (req, res) => {
    const since = new Date(Date.now() - 60 * 86400000).toISOString();
    const rows = await db.allAsync(`
        SELECT h.id, h.orderId, h.lineId, h.quantity, h.pickedAt, h.pickedBy, h.shippedAt, h.shippedBy, h.shipCode,
               o.maDH, o.maKH, o.ngayChot, o.ngayBanGiao, o.ttQuyTrinh, o.ttDonHang,
               c.tenKH, l.tenMach, l.stt,
               v.itemCode, v.itemName, v.unit, v.location, v.quantity AS tonKho, v.mpn, h.itemId
        FROM stock_holds h
        JOIN orders o ON o.id = h.orderId
        LEFT JOIN customers c ON c.maKH = o.maKH
        LEFT JOIN order_items l ON l.id = h.lineId
        LEFT JOIN inventory v ON v.id = h.itemId
        WHERE h.status = 'issued' AND COALESCE(o.ttQuyTrinh, '') != ?
          AND ( h.shippedAt >= ?
                OR (h.shippedAt IS NULL AND COALESCE(o.ttQuyTrinh, '') != ? AND COALESCE(o.ttDonHang, '') != ?) )
        ORDER BY o.ngayChot DESC, o.id DESC, l.stt, v.itemCode`, [CANCELLED, since, DONE, DONE]);

    const byOrder = new Map();
    for (const r of rows) {
        if (!byOrder.has(r.orderId)) {
            byOrder.set(r.orderId, { orderId: r.orderId, maDH: r.maDH, maKH: r.maKH, tenKH: r.tenKH || '', ngayChot: r.ngayChot, ngayBanGiao: r.ngayBanGiao, lines: [] });
        }
        byOrder.get(r.orderId).lines.push({
            id: r.id, lineId: r.lineId, itemId: r.itemId, mpn: r.mpn || '', tenMach: r.tenMach || '', itemCode: r.itemCode || '(mã đã xoá)', itemName: r.itemName || '', unit: r.unit || '',
            location: r.location || '', quantity: r.quantity, tonKho: r.tonKho,
            picked: !!r.pickedAt, pickedBy: r.pickedBy, pickedAt: r.pickedAt,
            shipped: !!r.shippedAt, shippedBy: r.shippedBy, shippedAt: r.shippedAt, shipCode: r.shipCode
        });
    }
    const orders = [...byOrder.values()].map((o) => {
        const pending = o.lines.filter((l) => !l.shipped);
        const picked = pending.filter((l) => l.picked).length;
        const status = !pending.length ? 'Đã xuất kho' : (picked === pending.length ? 'Đã soạn đủ' : (picked ? 'Đang soạn' : 'Chưa soạn'));
        return { ...o, status, total: o.lines.length, pending: pending.length, picked };
    });
    res.json(orders);
};

// PATCH /api/purchase/picking/:id  { picked: true|false }
exports.setPicked = async (req, res) => {
    const row = await db.getAsync(`SELECT * FROM stock_holds WHERE id = ? AND status = 'issued'`, [req.params.id]);
    if (!row) throw notFound('Không tìm thấy dòng cần soạn.');
    if (row.shippedAt) throw conflict('Dòng này đã xuất kho, không sửa được.');
    const picked = !!req.body.picked;
    await db.runAsync('UPDATE stock_holds SET pickedAt = ?, pickedBy = ? WHERE id = ?',
        [picked ? new Date().toISOString() : null, picked ? userName(req) : null, row.id]);
    res.json({ success: true });
};

// POST /api/purchase/picking/order/:orderId/pick-all  -> danh dau soan het cac dong chua xuat
exports.pickAll = async (req, res) => {
    await db.runAsync(`UPDATE stock_holds SET pickedAt = ?, pickedBy = ? WHERE orderId = ? AND status = 'issued' AND shippedAt IS NULL AND pickedAt IS NULL`,
        [new Date().toISOString(), userName(req), req.params.orderId]);
    res.json({ success: true });
};

// POST /api/purchase/picking/order/:orderId/ship  -> xuat kho that cho cac dong da soan
exports.ship = async (req, res) => {
    const order = await db.getAsync('SELECT id, maDH, ttChotDon, ttQuyTrinh FROM orders WHERE id = ?', [req.params.orderId]);
    if (!order) throw notFound('Không tìm thấy đơn hàng.');
    if (order.ttChotDon !== 'Đã chốt' || order.ttQuyTrinh === CANCELLED) throw badRequest('Chỉ xuất kho cho đơn đã chốt.');
    const rows = await db.allAsync(`SELECT id, pickedAt FROM stock_holds WHERE orderId = ? AND status = 'issued' AND shippedAt IS NULL`, [order.id]);
    if (!rows.length) throw badRequest('Đơn này không còn dòng nào chờ xuất.');
    const missing = rows.filter((r) => !r.pickedAt).length;
    if (missing) throw badRequest(`Còn ${missing} mã chưa soạn. Soạn đủ rồi mới xuất kho.`);

    const { yy, mm } = ym();
    const prefix = `PXK-${yy}${mm}`;
    const shipCode = `${prefix}-${String(await db.nextSeq(prefix)).padStart(3, '0')}`;
    const result = await db.runAsync(
        `UPDATE stock_holds SET shippedAt = ?, shippedBy = ?, shipCode = ? WHERE orderId = ? AND status = 'issued' AND shippedAt IS NULL AND pickedAt IS NOT NULL`,
        [new Date().toISOString(), userName(req), shipCode, order.id]);
    res.json({ success: true, shipCode, lines: result.changes, ngay: today() });
};
