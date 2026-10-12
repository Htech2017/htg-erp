// "Tam xuat" kho cho don dang bao gia:
//   - Nguoi bao gia luu bang vat tu  -> phan "lay kho" duoc TAM XUAT ngay (ton kho giam, don khac khong tinh trung duoc)
//   - Khach KHONG chot / don huy / doi so luong / lap lai bang vat tu -> TAI NHAP (ton kho tra lai)
//   - Khach chot don                 -> tam xuat thanh xuat chinh thuc (ton kho khong doi them)
// Moi lan tam xuat / tai nhap deu co phieu trong lich su kho (refType 'TamXuat' / 'TaiNhap').
const db = require('../models/database');
const { toNum, parseJson } = require('./http');

const STOCK_FIELDS = ['giaCostLK', 'giaCostPCB'];
const postTransaction = (args) => require('../controllers/inventoryController').postTransaction(args); // nap tre, tranh vong lap require

// Ton kho ma chinh hang muc nay dang tam xuat -> { itemId: so luong }
async function ownHolds(lineId, field) {
    const rows = await db.allAsync(`SELECT itemId, SUM(quantity) AS qty FROM stock_holds WHERE lineId = ? AND field = ? AND status = 'hold' GROUP BY itemId`, [lineId, field]);
    return Object.fromEntries(rows.map((r) => [r.itemId, r.qty]));
}

// Tai nhap cac dong tam xuat cho truoc
async function releaseRows(rows, order, reason, user) {
    for (const h of rows) {
        const item = await db.getAsync('SELECT * FROM inventory WHERE id = ?', [h.itemId]);
        if (item) {
            await postTransaction({ item, type: 'Nhap', quantity: h.quantity, unitPrice: 0, reason, refType: 'TaiNhap', refId: String(order.id), refCode: order.maDH, user });
        }
        await db.runAsync(`UPDATE stock_holds SET status = 'released', closedAt = ? WHERE id = ?`, [new Date().toISOString(), h.id]);
    }
    return rows.length;
}

async function releaseLineField(order, lineId, field, user, reason) {
    const rows = await db.allAsync(`SELECT * FROM stock_holds WHERE lineId = ? AND field = ? AND status = 'hold'`, [lineId, field]);
    return releaseRows(rows, order, reason || `Tái nhập - lập lại báo giá ${order.maDH}`, user);
}

// Tam xuat phan "lay kho" cua 1 bang vat tu (gop theo ma hang)
async function hold(order, line, field, pricedLines, user) {
    const byItem = new Map();
    for (const l of pricedLines) if (l.itemId && l.fromStock > 0) byItem.set(l.itemId, (byItem.get(l.itemId) || 0) + toNum(l.fromStock));
    for (const [itemId, quantity] of byItem) {
        const item = await db.getAsync('SELECT * FROM inventory WHERE id = ?', [itemId]);
        if (!item) continue;
        await postTransaction({
            item, type: 'Xuat', quantity, reason: `Tạm xuất báo giá ${order.maDH} - ${line.tenMach || ''}`.trim(),
            refType: 'TamXuat', refId: String(order.id), refCode: order.maDH, user
        });
        await db.runAsync(`INSERT INTO stock_holds (orderId, lineId, field, itemId, quantity, status, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, 'hold', ?, ?)`,
            [order.id, line.id, field, itemId, quantity, user, new Date().toISOString()]);
    }
}

// Khach khong chot / don huy: tai nhap toan bo va danh dau bang vat tu la "da tai nhap"
// (neu mo lai don thi bo phan phai bao gia lai vi ton kho co the da khac)
async function releaseOrder(order, user, reason) {
    const rows = await db.allAsync(`SELECT * FROM stock_holds WHERE orderId = ? AND status = 'hold'`, [order.id]);
    if (!rows.length) return 0;
    await releaseRows(rows, order, reason, user);
    const lines = await db.allAsync('SELECT id, costDetail FROM order_items WHERE orderId = ?', [order.id]);
    for (const l of lines) {
        const detail = parseJson(l.costDetail, {}) || {};
        let touched = false;
        for (const f of STOCK_FIELDS) if (detail[f] && detail[f].lines) { detail[f].released = true; touched = true; }
        if (touched) await db.runAsync('UPDATE order_items SET costDetail = ? WHERE id = ?', [JSON.stringify(detail), l.id]);
    }
    return rows.length;
}

// Mo lai don da "khong chot" / "huy": cac bang vat tu da tai nhap khong con hieu luc -> xoa gia cost, cho bao gia lai
async function resetReleased(orderId) {
    const lines = await db.allAsync('SELECT id, costDetail FROM order_items WHERE orderId = ?', [orderId]);
    let reset = 0;
    for (const l of lines) {
        const detail = parseJson(l.costDetail, {}) || {};
        const fields = STOCK_FIELDS.filter((f) => detail[f] && detail[f].released);
        if (!fields.length) continue;
        for (const f of fields) delete detail[f];
        await db.runAsync(`UPDATE order_items SET ${fields.map((f) => `${f} = 0`).join(', ')}, costDetail = ? WHERE id = ?`, [JSON.stringify(detail), l.id]);
        reset += fields.length;
    }
    return reset;
}

// Sau khi Sale sua don: tai nhap cac phan tam xuat khong con bang vat tu tuong ung (xoa loai mach, doi so luong...)
async function reconcile(order, user) {
    const rows = await db.allAsync(`SELECT h.*, i.costDetail AS lineDetail FROM stock_holds h LEFT JOIN order_items i ON i.id = h.lineId WHERE h.orderId = ? AND h.status = 'hold'`, [order.id]);
    const orphan = rows.filter((h) => {
        const detail = parseJson(h.lineDetail, null);
        return !detail || !detail[h.field] || !detail[h.field].lines;
    });
    return releaseRows(orphan, order, `Tái nhập - Sale sửa đơn ${order.maDH}`, user);
}

// Khach chot: tam xuat -> xuat chinh thuc
async function confirm(orderId) {
    await db.runAsync(`UPDATE stock_holds SET status = 'issued', closedAt = ? WHERE orderId = ? AND status = 'hold'`, [new Date().toISOString(), orderId]);
}

// Tong dang tam xuat theo ma hang (hien o trang kho)
async function heldByItem() {
    const rows = await db.allAsync(`SELECT itemId, SUM(quantity) AS qty, COUNT(DISTINCT orderId) AS orders FROM stock_holds WHERE status = 'hold' GROUP BY itemId`);
    return new Map(rows.map((r) => [r.itemId, { qty: r.qty, orders: r.orders }]));
}

// Chay 1 lan khi khoi dong: cac bang vat tu lap TRUOC khi co tinh nang tam xuat (don chua chot, chua dong)
// duoc tam xuat bo sung. Ma hang khong con du ton thi bo qua (nguoi bao gia lap lai khi can).
async function backfill() {
    const lines = await db.allAsync(`
        SELECT i.*, o.maDH FROM order_items i JOIN orders o ON o.id = i.orderId
        WHERE COALESCE(o.ttChotDon, '') NOT IN ('Đã chốt', 'Không chốt') AND COALESCE(o.ttQuyTrinh, '') NOT IN ('Hủy đơn', 'Hoàn thành')
          AND i.costDetail LIKE '%fromStock%'`);
    for (const line of lines) {
        const detail = parseJson(line.costDetail, {}) || {};
        for (const field of STOCK_FIELDS) {
            if (!detail[field] || !detail[field].lines || detail[field].released) continue;
            if (await db.getAsync('SELECT id FROM stock_holds WHERE lineId = ? AND field = ? LIMIT 1', [line.id, field])) continue;
            try { await hold({ id: line.orderId, maDH: line.maDH }, line, field, detail[field].lines, 'Hệ thống'); } catch (e) { /* khong du ton: bo qua */ }
        }
    }
}

module.exports = { backfill, STOCK_FIELDS, ownHolds, releaseLineField, hold, releaseOrder, resetReleased, reconcile, confirm, heldByItem };
