// GIAO HANG CHO KHACH: khi vat tu ve du / san xuat xong -> tao chuyen giao (don vi van chuyen, ma van don), theo doi toi khi khach nhan.
// 1 don co the giao nhieu chuyen (giao tung phan).
const db = require('../models/database');
const { toNum, userName, badRequest, notFound } = require('../utils/http');
const { PERMS } = require('../config');
const { hasRole } = require('../middlewares/authMiddleware');

const STATUSES = ['Chuẩn bị hàng', 'Đã gửi', 'Đang vận chuyển', 'Đã giao', 'Giao không thành công'];
const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
const text = (v, n = 200) => String(v || '').trim().slice(0, n);

// GET /api/delivery -> don da chot (chua huy) + muc do san sang + cac chuyen giao
exports.overview = async (req, res) => {
    const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    const orders = await db.allAsync(`SELECT o.id, o.maDH, o.maKH, o.loaiDV, o.tenMach, o.ngayChot, o.ngayBanGiao, o.ttQuyTrinh, o.ttDonHang, o.saleName, o.vip, c.tenKH, c.sdt, c.diaChi
        FROM orders o LEFT JOIN customers c ON c.maKH = o.maKH
        WHERE o.ttChotDon = 'Đã chốt' AND COALESCE(o.ttQuyTrinh, '') != 'Hủy đơn' AND o.loaiDV = 'sx' ORDER BY o.id DESC LIMIT 400`);
    const ids = orders.map((o) => o.id);
    if (!ids.length) return res.json({ orders: [], statuses: STATUSES });
    const q = ids.map(() => '?').join(', ');
    const buy = await db.allAsync(`SELECT orderId, COUNT(*) AS total, SUM(CASE WHEN qtyReceived >= qtyNeed THEN 1 ELSE 0 END) AS done FROM buy_lines WHERE cancelledAt IS NULL AND orderId IN (${q}) GROUP BY orderId`, ids);
    const boards = await db.allAsync(`SELECT oi.orderId, COUNT(*) AS total, SUM(CASE WHEN oi.soLuongGiaCong > 0 THEN 1 ELSE 0 END) AS needSx,
        SUM(CASE WHEN d.status = 'Hoàn thành' THEN 1 ELSE 0 END) AS sxDone FROM order_items oi LEFT JOIN dispatches d ON d.lineId = oi.id WHERE oi.orderId IN (${q}) GROUP BY oi.orderId`, ids);
    const pos = await db.allAsync(`SELECT orderId, COUNT(*) AS total, SUM(CASE WHEN status = 'Đã nhận' THEN 1 ELSE 0 END) AS done FROM purchase_orders WHERE status != 'Hủy' AND orderId IN (${q}) GROUP BY orderId`, ids);
    const ships = await db.allAsync(`SELECT * FROM shipments WHERE orderId IN (${q}) ORDER BY id`, ids);
    const addrs = await db.allAsync('SELECT * FROM customer_addresses ORDER BY isDefault DESC, id');
    const by = (list) => new Map(list.map((x) => [x.orderId, x]));
    const mBuy = by(buy), mBoard = by(boards), mPo = by(pos);
    const out = orders.map((o) => {
        const b = mBuy.get(o.id) || { total: 0, done: 0 }, bd = mBoard.get(o.id) || { total: 0, needSx: 0, sxDone: 0 }, p = mPo.get(o.id) || { total: 0, done: 0 };
        const list = ships.filter((s) => s.orderId === o.id);
        const matReady = b.done >= b.total && p.done >= p.total; // vat tu mua theo don + PO nhap tay gan voi don da ve het
        const sxReady = toNum(bd.sxDone) >= toNum(bd.needSx);
        const delivered = list.length > 0 && list.every((s) => s.status === 'Đã giao');
        const state = o.ttDonHang === 'Hoàn thành' || o.ttQuyTrinh === 'Hoàn thành' ? 'Hoàn thành' : delivered ? 'Đã giao, chờ đóng đơn' : list.some((s) => s.status !== 'Chuẩn bị hàng') ? 'Đang giao'
            : list.length ? 'Đang chuẩn bị hàng' : (matReady && sxReady ? 'Sẵn sàng giao' : 'Chưa đủ hàng');
        return { ...o, mat: { done: b.done + p.done, total: b.total + p.total, ready: matReady }, sx: { done: toNum(bd.sxDone), total: toNum(bd.needSx), ready: sxReady }, shipments: list, state,
            // Noi nhan: cac dia chi nhan hang da khai bao cua khach; chua khai bao thi dung dia chi chung cua khach
            addresses: addrs.filter((a) => a.maKH === o.maKH).concat(addrs.some((a) => a.maKH === o.maKH) || !o.diaChi ? [] : [{ id: 0, label: 'Địa chỉ khách hàng', receiver: o.tenKH || '', phone: o.sdt || '', address: o.diaChi, isDefault: 1 }]) };
    }).filter((o) => o.state !== 'Hoàn thành' || o.shipments.some((s) => (s.updatedAt || '').slice(0, 10) >= since));
    res.json({ orders: out, statuses: STATUSES, canWrite: hasRole(req.session.user, PERMS.DELIVERY_WRITE) });
};

function fields(b) {
    const status = STATUSES.includes(b.status) ? b.status : STATUSES[0];
    return { status, carrier: text(b.carrier, 100), trackingNo: text(b.trackingNo, 100), shipDate: day(b.shipDate), deliveredDate: day(b.deliveredDate), receiver: text(b.receiver, 150), receiverPhone: text(b.receiverPhone, 40), address: text(b.address, 300), contents: text(b.contents, 500), fee: Math.max(0, toNum(b.fee)), note: text(b.note, 500) };
}
function check(f) {
    if (!f.contents) throw badRequest('Ghi rõ nội dung chuyến giao (giao gì, số lượng).');
    if (f.status !== 'Chuẩn bị hàng' && !f.address) throw badRequest('Chọn hoặc nhập địa chỉ nhận hàng trước khi gửi.');
    if (f.status !== 'Chuẩn bị hàng' && !f.shipDate) throw badRequest('Đã gửi hàng thì cần ngày gửi.');
    if (f.status === 'Đã giao' && !f.deliveredDate) throw badRequest('Đã giao thì cần ngày khách nhận.');
    if (f.status === 'Giao không thành công' && !f.note) throw badRequest('Giao không thành công: ghi lý do vào ghi chú.');
}
// POST /api/delivery/:orderId
exports.create = async (req, res) => {
    const o = await db.getAsync(`SELECT id, maDH, ttChotDon, ttQuyTrinh FROM orders WHERE id = ?`, [req.params.orderId]);
    if (!o) throw notFound('Không tìm thấy đơn hàng.');
    if (o.ttChotDon !== 'Đã chốt' || o.ttQuyTrinh === 'Hủy đơn') throw badRequest('Chỉ giao hàng cho đơn đã chốt và chưa hủy.');
    const f = fields(req.body); check(f);
    const now = new Date().toISOString();
    const r = await db.runAsync('INSERT INTO shipments (orderId, maDH, status, carrier, trackingNo, shipDate, deliveredDate, receiver, receiverPhone, address, contents, fee, note, createdBy, createdAt, updatedBy, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [o.id, o.maDH, f.status, f.carrier, f.trackingNo, f.shipDate, f.deliveredDate, f.receiver, f.receiverPhone, f.address, f.contents, f.fee, f.note, userName(req), now, userName(req), now]);
    res.json({ success: true, id: r.lastID });
};
// PATCH /api/delivery/shipments/:id
exports.update = async (req, res) => {
    const s = await db.getAsync('SELECT * FROM shipments WHERE id = ?', [req.params.id]);
    if (!s) throw notFound('Không tìm thấy chuyến giao.');
    const f = fields({ ...s, ...req.body }); check(f);
    await db.runAsync('UPDATE shipments SET status=?, carrier=?, trackingNo=?, shipDate=?, deliveredDate=?, receiver=?, receiverPhone=?, address=?, contents=?, fee=?, note=?, updatedBy=?, updatedAt=? WHERE id=?',
        [f.status, f.carrier, f.trackingNo, f.shipDate, f.deliveredDate, f.receiver, f.receiverPhone, f.address, f.contents, f.fee, f.note, userName(req), new Date().toISOString(), s.id]);
    res.json({ success: true });
};
// DELETE /api/delivery/shipments/:id  (chi khi con "Chuẩn bị hàng")
exports.remove = async (req, res) => {
    const s = await db.getAsync('SELECT * FROM shipments WHERE id = ?', [req.params.id]);
    if (!s) throw notFound('Không tìm thấy chuyến giao.');
    if (s.status !== 'Chuẩn bị hàng') throw badRequest('Chuyến đã gửi đi thì không xóa, hãy cập nhật trạng thái.');
    await db.runAsync('DELETE FROM shipments WHERE id = ?', [s.id]);
    res.json({ success: true });
};
