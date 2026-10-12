// Hang muc mach cua don hang PCB / Linh kien / San xuat.
// 1 don co nhieu loai mach; moi loai mach co so luong, BOM va gia cost rieng.
// Cac cot soLuong* / giaCost* / tenMach tren bang orders la TONG HOP tu cac hang muc (de phan con lai cua he thong dung nhu cu).
const db = require('../models/database');
const flow = require('./orderFlow');
const { ORDER_TYPES } = require('../config');
const { toNum, parseJson, badRequest } = require('./http');

const SX_QUOTES = flow.QUOTE_ITEMS.filter((q) => q.qtyField); // PCB, Linh kien, San xuat
const QTY_FIELDS = SX_QUOTES.map((q) => q.qtyField);
const COST_FIELDS = SX_QUOTES.map((q) => q.field);
const MAX_LINES = 50;

async function loadLines(orderId) {
    const rows = await db.allAsync('SELECT * FROM order_items WHERE orderId = ? ORDER BY stt ASC, id ASC', [orderId]);
    return rows.map((r) => ({ ...r, costDetail: parseJson(r.costDetail, {}) || {} }));
}

// Tong hop cac hang muc -> gia tri ghi len bang orders
function summarize(lines) {
    const out = {};
    for (const f of [...QTY_FIELDS, ...COST_FIELDS]) out[f] = lines.reduce((s, l) => s + toNum(l[f]), 0);
    const names = lines.map((l) => l.tenMach).filter(Boolean);
    out.tenMach = names.length <= 3 ? names.join(' + ') : `${names.slice(0, 2).join(' + ')} (+${names.length - 2} mạch khác)`;
    // Bo phan nao con it nhat 1 loai mach chua bao gia
    const pending = SX_QUOTES.filter((q) => lines.some((l) => toNum(l[q.qtyField]) > 0 && toNum(l[q.field]) <= 0)).map((q) => q.label);
    out.quotePending = JSON.stringify(pending);
    return out;
}

// So sanh danh sach hang muc Sale gui len voi hien trang -> danh sach moi + cac hang muc phai bao gia lai.
// Doi so luong 1 hang muc -> xoa gia cost va bang chi tiet cua hang muc do (chi rieng loai mach bi doi).
function planLines(bodyItems, currentLines) {
    if (!Array.isArray(bodyItems) || !bodyItems.length) throw badRequest('Đơn hàng cần ít nhất một loại mạch.');
    if (bodyItems.length > MAX_LINES) throw badRequest(`Một đơn tối đa ${MAX_LINES} loại mạch.`);
    const byId = new Map(currentLines.map((l) => [l.id, l]));
    const reset = [];

    const lines = bodyItems.map((raw, idx) => {
        const tenMach = String(raw.tenMach || '').trim();
        if (!tenMach) throw badRequest(`Loại mạch thứ ${idx + 1}: chưa nhập tên mạch.`);
        const line = { ...(byId.get(Number(raw.id)) || { id: null, costDetail: {} }), tenMach, stt: idx + 1, ghiChu: raw.ghiChu || null };
        line.costDetail = { ...line.costDetail };
        for (const q of SX_QUOTES) {
            const qty = Math.round(toNum(raw[q.qtyField]));
            if (qty < 0) throw badRequest(`Mạch "${tenMach}": số lượng không được âm.`);
            const old = toNum(line[q.qtyField]);
            if (line.id && qty !== old && toNum(line[q.field]) > 0) reset.push(`${tenMach} / ${q.label}`);
            if (!line.id || qty !== old) { line[q.field] = 0; delete line.costDetail[q.field]; }
            line[q.qtyField] = qty;
        }
        if (QTY_FIELDS.every((f) => !line[f])) throw badRequest(`Mạch "${tenMach}": cần số lượng PCB, linh kiện hoặc sản xuất.`);
        return line;
    });
    const keptIds = new Set(lines.map((l) => l.id).filter(Boolean));
    return { lines, removedIds: currentLines.filter((l) => !keptIds.has(l.id)).map((l) => l.id), reset };
}

async function writeLines(orderId, plan) {
    for (const id of plan.removedIds) await db.runAsync('DELETE FROM order_items WHERE id = ? AND orderId = ?', [id, orderId]);
    for (const l of plan.lines) {
        const values = [l.stt, l.tenMach, ...QTY_FIELDS.map((f) => l[f]), ...COST_FIELDS.map((f) => toNum(l[f])), JSON.stringify(l.costDetail || {}), l.ghiChu || null];
        if (l.id) {
            await db.runAsync(`UPDATE order_items SET stt = ?, tenMach = ?, ${[...QTY_FIELDS, ...COST_FIELDS].map((f) => `${f} = ?`).join(', ')}, costDetail = ?, ghiChu = ? WHERE id = ?`, [...values, l.id]);
        } else {
            const r = await db.runAsync(`INSERT INTO order_items (orderId, stt, tenMach, ${[...QTY_FIELDS, ...COST_FIELDS].join(', ')}, costDetail, ghiChu) VALUES (?, ${values.map(() => '?').join(', ')})`, [orderId, ...values]);
            l.id = r.lastID;
        }
    }
}

// Ghi lai cac cot tong hop tren bang orders theo hien trang hang muc
async function syncOrderSummary(orderId) {
    const summary = summarize(await loadLines(orderId));
    const fields = [...QTY_FIELDS, ...COST_FIELDS, 'tenMach', 'quotePending'];
    await db.runAsync(`UPDATE orders SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`, [...fields.map((f) => summary[f]), orderId]);
    return summary;
}

// Ton kho da duoc cac loai mach KHAC trong cung don tinh "lay kho" -> { itemId: so luong }
function reservedByOthers(lines, lineId) {
    const reserved = {};
    for (const l of lines) {
        if (l.id === lineId) continue;
        for (const detail of Object.values(l.costDetail || {})) {
            for (const row of (detail && detail.lines) || []) {
                if (row.itemId && row.fromStock > 0) reserved[row.itemId] = (reserved[row.itemId] || 0) + row.fromStock;
            }
        }
    }
    return reserved;
}

// Gop danh sach vat tu can mua cua ca don (1 linh kien dung o nhieu mach -> 1 dong mua)
// Danh sach vat tu cua don, GIU NGUYEN THEO TUNG BOM (loai mach): hang ve phai chia lai theo tung mach nen khong gop cac mach voi nhau.
function buyList(lines) {
    const boards = [];
    for (const l of lines) {
        for (const field of ['giaCostLK', 'giaCostPCB']) {
            const detail = (l.costDetail || {})[field];
            if (!detail || !Array.isArray(detail.lines)) continue;
            const rows = detail.lines.map((row) => ({
                itemId: row.itemId, itemCode: row.itemCode, name: row.name, unit: row.unit, need: toNum(row.need), fromStock: toNum(row.fromStock), toBuy: toNum(row.toBuy),
                buyPrice: toNum(row.buyPrice), supplier: row.supplier || '', khachCap: !!row.khachCap, amount: Math.round(toNum(row.toBuy) * toNum(row.buyPrice))
            }));
            boards.push({ lineId: l.id, tenMach: l.tenMach, field, soLuong: toNum(field === 'giaCostLK' ? l.soLuongLK : l.soLuongPCB), rows, total: rows.reduce((s, r) => s + r.amount, 0) });
        }
    }
    return boards;
}

// Don sx cu (truoc khi co hang muc) -> tao 1 hang muc tu so lieu san co tren don
async function migrateLegacyOrders() {
    const orders = await db.allAsync(
        `SELECT * FROM orders o WHERE o.loaiDV = ? AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.orderId = o.id)`, [ORDER_TYPES.SX]);
    for (const o of orders) {
        const detail = parseJson(o.costDetail, {}) || {};
        await db.runAsync(
            `INSERT INTO order_items (orderId, stt, tenMach, ${[...QTY_FIELDS, ...COST_FIELDS].join(', ')}, costDetail) VALUES (?, 1, ?, ${[...QTY_FIELDS, ...COST_FIELDS].map(() => '?').join(', ')}, ?)`,
            [o.id, o.tenMach || o.maDH, ...QTY_FIELDS.map((f) => toNum(o[f])), ...COST_FIELDS.map((f) => toNum(o[f])), JSON.stringify(detail)]);
        await syncOrderSummary(o.id);
    }
    if (orders.length) console.log(`Da chuyen ${orders.length} don cu sang dang nhieu loai mach.`);
}

module.exports = { SX_QUOTES, QTY_FIELDS, COST_FIELDS, loadLines, summarize, planLines, writeLines, syncOrderSummary, reservedByOthers, buyList, migrateLegacyOrders };
