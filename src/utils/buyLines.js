// DANH SACH CAN MUA cua don da chot: moi dong "can mua" trong bang vat tu linh kien (luc bao gia) -> 1 dong buy_lines.
// Dong nay di theo suot qua trinh mua: chon NCC -> gom vao PO -> hang ve -> ghep bo theo BOM.
const db = require('../models/database');
const { toNum, parseJson } = require('./http');

const FIELD = 'giaCostLK';

// Tim NCC theo ten (khong phan biet hoa thuong); chua co thi tao moi (loai Linh kien)
async function ensureSupplier(name) {
    const clean = String(name || '').trim().slice(0, 100);
    if (!clean) return { id: null, name: '' };
    const found = await db.getAsync('SELECT id, name FROM suppliers WHERE LOWER(name) = LOWER(?)', [clean]);
    if (found) return found;
    const r = await db.runAsync(`INSERT INTO suppliers (name, type, rating, status, createdAt) VALUES (?, 'LinhKien', 3, 1, ?)`, [clean, new Date().toISOString()]);
    return { id: r.lastID, name: clean };
}

// Sinh dong can mua cho 1 don (chi chay 1 lan cho moi don)
async function generate(orderId) {
    if (await db.getAsync('SELECT id FROM buy_lines WHERE orderId = ? LIMIT 1', [orderId])) return 0;
    const order = await db.getAsync('SELECT id, maDH FROM orders WHERE id = ?', [orderId]);
    if (!order) return 0;
    const boards = await db.allAsync('SELECT id, tenMach, costDetail FROM order_items WHERE orderId = ? ORDER BY stt, id', [orderId]);
    let n = 0;
    for (const b of boards) {
        const detail = (parseJson(b.costDetail, {}) || {})[FIELD];
        if (!detail || !Array.isArray(detail.lines)) continue;
        for (const [idx, l] of detail.lines.entries()) {
            // Dong khach cap: khong mua, chi theo doi khach da gui sang chua
            if (l.khachCap) {
                await db.runAsync(`INSERT INTO buy_lines (orderId, maDH, lineId, tenMach, bomIdx, grp, itemId, itemCode, name, unit, qtyNeed, supplierName, khachCap, qtyOrdered, qtyReceived, createdAt)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,'Khách cấp',1,0,0,?)`, [order.id, order.maDH, b.id, b.tenMach, idx, l.group || '', l.itemId || null, l.itemCode || null, l.name, l.unit || '', toNum(l.need), new Date().toISOString()]);
                n += 1;
                continue;
            }
            if (!(toNum(l.toBuy) > 0)) continue;
            const sup = await ensureSupplier(l.supplier);
            await db.runAsync(
                `INSERT INTO buy_lines (orderId, maDH, lineId, tenMach, bomIdx, grp, itemId, itemCode, name, unit, qtyNeed, supplierId, supplierName, priceQuote, qtyOrdered, priceActual, qtyReceived, createdAt, altNote, surplus)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
                [order.id, order.maDH, b.id, b.tenMach, idx, l.group || '', l.itemId || null, l.itemCode || null, l.name, l.unit || '', toNum(l.toBuy),
                    sup.id, sup.name, toNum(l.buyPrice), Math.max(toNum(l.toBuy), toNum(l.buyQty)), toNum(l.buyPrice), new Date().toISOString(), l.alt || null, l.surplus || null]); // SL dat = SL mua thuc te trong BOM di mua
            n += 1;
        }
    }
    return n;
}

// Khi khoi dong: don da chot truoc khi co tinh nang nay (chua giao xong, chua huy) duoc sinh bo sung
async function backfill() {
    const rows = await db.allAsync(`SELECT id FROM orders WHERE loaiDV = 'sx' AND ttChotDon = 'Đã chốt'
        AND COALESCE(ttQuyTrinh, '') NOT IN ('Hủy đơn', 'Hoàn thành') AND COALESCE(ttDonHang, '') != 'Hoàn thành'`);
    for (const r of rows) await generate(r.id);
}

module.exports = { FIELD, ensureSupplier, generate, backfill };
