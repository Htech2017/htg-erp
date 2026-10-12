const db = require('../models/database');
const { PERMS } = require('../config');
const { hasRole } = require('../middlewares/authMiddleware');
const { getSetting } = require('../utils/googleHelper');
const { debtSql, receivableSql, pendingInfo } = require('../utils/orderFlow');
const { PENDING_WARN_DAYS, PERMS: P } = require('../config');

// So lieu tong quan cho Dashboard (cac truy van chay song song)
exports.getDashboardStats = async (req, res) => {
    const canSeeMoney = hasRole(req.session.user, PERMS.DEBT_VIEW);

    const [kh, active, debt, recentOrders, driveId, webhook] = await Promise.all([
        db.getAsync('SELECT COUNT(*) AS count FROM customers'),
        db.getAsync(`SELECT COUNT(*) AS count FROM orders WHERE COALESCE(ttQuyTrinh, '') NOT IN ('Hoàn thành', 'Hủy đơn')`),
        db.getAsync(`
            SELECT (SELECT COALESCE(SUM(old_debt), 0) FROM customers)
                 + (SELECT COALESCE(SUM(${debtSql()}), 0) FROM orders WHERE ${receivableSql()})
                 AS totalDebt`),
        db.allAsync('SELECT maDH, tenMach, ttQuyTrinh, giaBao FROM orders ORDER BY id DESC LIMIT 5'),
        getSetting('google_drive_root_id'),
        getSetting('google_chat_webhook')
    ]);

    // Don chua chot qua han: chi tinh cho nguoi xem duoc don hang
    let overdue = [];
    if (hasRole(req.session.user, P.ORDER_READ)) {
        const open = await db.allAsync(`
            SELECT o.id, o.maDH, o.tenMach, o.ngayTao, o.ngayBaoGia, o.ttChotDon, o.ttQuyTrinh,
                   (SELECT COUNT(DISTINCT h.itemId) FROM stock_holds h WHERE h.orderId = o.id AND h.status = 'hold') AS tamXuat
            FROM orders o
            WHERE COALESCE(o.ttChotDon, '') NOT IN ('Đã chốt', 'Không chốt') AND COALESCE(o.ttQuyTrinh, '') NOT IN ('Hủy đơn', 'Hoàn thành')`);
        overdue = open.map((o) => ({ ...o, ...pendingInfo(o) })).filter((o) => o.quaHan).sort((a, b) => b.soNgayCho - a.soNgayCho);
    }

    res.json({
        overdueOrders: overdue.slice(0, 20), overdueCount: overdue.length, warnDays: PENDING_WARN_DAYS,
        countKH: kh.count,
        activeOrders: active.count,
        // Cong no va gia bao chi hien cho Admin / Sale / Ke toan
        totalDebt: canSeeMoney ? debt.totalDebt : null,
        recentOrders: canSeeMoney ? recentOrders : recentOrders.map((o) => ({ ...o, giaBao: null })),
        systemStatus: {
            drive: driveId ? 'connected' : 'disconnected',
            webhook: webhook ? 'connected' : 'disconnected'
        }
    });
};
