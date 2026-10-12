const fs = require('fs');
const path = require('path');
const db = require('../models/database');
const { normalizeText } = require('../utils/partMatch');
const { ITEM_DIR } = require('../middlewares/upload');
const { toNum, ym, userName, badRequest, notFound, conflict } = require('../utils/http');

// Ghi 1 phieu nhap/xuat va cap nhat ton kho. Xuat qua ton se bi tu choi.
async function postTransaction({ item, type, quantity, unitPrice = 0, reason, refType, refId, refCode, note, user }) {
    const delta = type === 'Nhap' ? quantity : -quantity;

    // 1 cau lenh vua kiem tra vua tru ton -> 2 nguoi xuat cung luc khong lam am kho.
    // Nhap kho co don gia -> cap nhat gia kho theo binh quan gia quyen (gia cu x ton cu + gia nhap x SL nhap) / tong SL.
    // Xuat kho khong lam doi gia kho.
    const price = type === 'Nhap' ? toNum(unitPrice) : 0;
    const result = await db.runAsync(
        `UPDATE inventory SET
            unitCost = CASE WHEN ? > 0 THEN
                (CASE WHEN COALESCE(unitCost, 0) > 0 AND quantity > 0 THEN (unitCost * quantity + ? * ?) / (quantity + ?) ELSE ? END)
                ELSE unitCost END,
            quantity = quantity + ?
         WHERE id = ? AND quantity + ? >= 0`, [price, price, quantity, quantity, price, delta, item.id, delta]);
    if (!result.changes) throw conflict(`Không đủ tồn kho để xuất (hiện còn ${item.quantity} ${item.unit || ''}).`);

    const { yy, mm } = ym();
    const prefix = `${type === 'Nhap' ? 'NK' : 'XK'}-${yy}${mm}`;
    const transCode = `${prefix}-${String(await db.nextSeq(prefix)).padStart(4, '0')}`;
    try {
        await db.runAsync(
            `INSERT INTO inventory_transactions (transCode,itemId,itemCode,itemName,type,quantity,unitPrice,reason,refType,refId,refCode,createdBy,createdAt,note)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [transCode, item.id, item.itemCode, item.itemName, type, quantity, unitPrice, reason, refType, refId, refCode, user, new Date().toISOString(), note]);
    } catch (err) {
        await db.runAsync('UPDATE inventory SET quantity = quantity - ? WHERE id = ?', [delta, item.id]); // hoan tac ton kho
        throw err;
    }
    return transCode;
}

exports.postTransaction = postTransaction; // dung chung cho tam xuat / tai nhap (utils/stockHold.js)

// ===== INVENTORY ITEMS =====
exports.getItems = async (req, res) => {
    const [items, aliases] = await Promise.all([
        db.allAsync('SELECT * FROM inventory ORDER BY category, itemName ASC'),
        db.allAsync('SELECT itemId, alias FROM inventory_aliases ORDER BY id ASC')
    ]);
    const byItem = new Map();
    for (const a of aliases) {
        if (!byItem.has(a.itemId)) byItem.set(a.itemId, []);
        byItem.get(a.itemId).push(a.alias);
    }
    // quantity = ton kha dung (da tru phan dang tam xuat cho cac don dang bao gia); held = so dang tam xuat
    const held = await require('../utils/stockHold').heldByItem();
    res.json(items.map((i) => ({ ...i, aliases: byItem.get(i.id) || [], held: (held.get(i.id) || {}).qty || 0, heldOrders: (held.get(i.id) || {}).orders || 0 })));
};

// Them ten goi khac cho 1 ma hang (bo qua neu da co). Dung chung cho form kho va cong cu so khop BOM.
async function addAlias(itemId, alias, maKH, user) {
    const text = String(alias || '').trim();
    const norm = normalizeText(text);
    if (!text || !norm) return false;
    const result = await db.runAsync(
        'INSERT OR IGNORE INTO inventory_aliases (itemId, alias, aliasNorm, maKH, createdBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
        [itemId, text.slice(0, 200), norm, maKH || null, user, new Date().toISOString()]);
    return result.changes > 0;
}
exports.addAlias = addAlias;

// Dong bo danh sach ten goi khac theo dung noi dung form (them cai moi, xoa cai bi bo)
async function syncAliases(itemId, list, user) {
    const wanted = new Map();
    for (const a of list) {
        const norm = normalizeText(a);
        if (norm) wanted.set(norm, String(a).trim());
    }
    const current = await db.allAsync('SELECT id, aliasNorm FROM inventory_aliases WHERE itemId = ?', [itemId]);
    for (const c of current) {
        if (!wanted.has(c.aliasNorm)) await db.runAsync('DELETE FROM inventory_aliases WHERE id = ?', [c.id]);
    }
    for (const alias of wanted.values()) await addAlias(itemId, alias, null, user);
}

// Ghi nho nhieu ten goi cung luc (sau khi nguoi bao gia xac nhan so khop BOM)
// Body: { maKH, aliases: [{ itemId, alias }] }
exports.saveAliases = async (req, res) => {
    const list = Array.isArray(req.body.aliases) ? req.body.aliases.slice(0, 500) : [];
    let added = 0;
    for (const a of list) {
        const item = await db.getAsync('SELECT id, itemName, itemCode FROM inventory WHERE id = ?', [a.itemId]);
        if (!item) continue;
        // Ten trung voi ten / ma hang thi khong can ghi nho
        const norm = normalizeText(a.alias);
        if (norm === normalizeText(item.itemName) || norm === normalizeText(item.itemCode)) continue;
        if (await addAlias(item.id, a.alias, req.body.maKH, userName(req))) added += 1;
    }
    res.json({ success: true, added });
};

// Anh vat tu (tuy chon)
function removeImageFile(image) {
    if (!image || !/^\/uploads\/items\/[\w.-]+$/.test(image)) return;
    fs.unlink(path.join(ITEM_DIR, path.basename(image)), () => {});
}
exports.uploadImage = async (req, res) => {
    if (!req.file) throw badRequest('Chưa chọn file ảnh.');
    const item = await db.getAsync('SELECT id, image FROM inventory WHERE id = ?', [req.params.id]);
    if (!item) { removeImageFile(`/uploads/items/${req.file.filename}`); throw notFound('Không tìm thấy mặt hàng.'); }
    const image = `/uploads/items/${req.file.filename}`;
    await db.runAsync('UPDATE inventory SET image = ? WHERE id = ?', [image, item.id]);
    removeImageFile(item.image);
    res.json({ success: true, image });
};
exports.deleteImage = async (req, res) => {
    const item = await db.getAsync('SELECT id, image FROM inventory WHERE id = ?', [req.params.id]);
    if (!item) throw notFound('Không tìm thấy mặt hàng.');
    await db.runAsync('UPDATE inventory SET image = NULL WHERE id = ?', [item.id]);
    removeImageFile(item.image);
    res.json({ success: true });
};

exports.saveItem = async (req, res) => {
    const { id, category, unit, location, description, note } = req.body;
    const mpn = String(req.body.mpn || '').trim() || null;       // ma nha san xuat
    const pkg = String(req.body.package || '').trim() || null;   // kieu chan / footprint
    const aliases = Array.isArray(req.body.aliases) ? req.body.aliases : null; // ten goi khac (null = khong dong toi)
    const itemCode = String(req.body.itemCode || '').trim().toUpperCase();
    const itemName = String(req.body.itemName || '').trim();
    const quantity = toNum(req.body.quantity);
    const minQuantity = toNum(req.body.minQuantity);
    const unitCost = req.body.unitCost === undefined ? null : toNum(req.body.unitCost); // gia kho nhap tay (tuy chon)
    if (unitCost !== null && unitCost < 0) throw badRequest('Giá kho không được âm.');
    const user = userName(req);

    if (!itemCode || !itemName) throw badRequest('Vui lòng nhập mã hàng và tên hàng.');
    if (quantity < 0 || minQuantity < 0) throw badRequest('Số lượng không được âm.');
    if (await db.getAsync('SELECT id FROM inventory WHERE itemCode = ? AND id != ?', [itemCode, id || 0])) {
        throw conflict(`Mã hàng ${itemCode} đã tồn tại.`);
    }

    if (id) {
        const current = await db.getAsync('SELECT * FROM inventory WHERE id = ?', [id]);
        if (!current) throw notFound('Không tìm thấy mặt hàng.');

        await db.runAsync('UPDATE inventory SET itemCode=?,itemName=?,category=?,unit=?,minQuantity=?,location=?,description=?,note=?,mpn=?,package=? WHERE id=?',
            [itemCode, itemName, category, unit, minQuantity, location, description, note, mpn, pkg, id]);
        if (aliases) await syncAliases(id, aliases, user);
        if (unitCost !== null) await db.runAsync('UPDATE inventory SET unitCost = ? WHERE id = ?', [unitCost, id]);

        // Sua so ton truc tiep -> tu sinh phieu dieu chinh de luon truy vet duoc lich su ton kho.
        const diff = quantity - toNum(current.quantity);
        if (req.body.quantity !== undefined && diff !== 0) {
            await postTransaction({
                item: { ...current, itemCode, itemName }, type: diff > 0 ? 'Nhap' : 'Xuat', quantity: Math.abs(diff),
                reason: 'Điều chỉnh tồn kho', refType: 'DieuChinh', user
            });
        }
        return res.json({ success: true, id: Number(id) });
    }

    const result = await db.runAsync(
        'INSERT INTO inventory (itemCode,itemName,category,unit,quantity,minQuantity,location,description,note,mpn,package,createdAt) VALUES (?,?,?,?,0,?,?,?,?,?,?,?)',
        [itemCode, itemName, category, unit || 'cái', minQuantity, location, description, note, mpn, pkg, new Date().toISOString()]);
    if (aliases) await syncAliases(result.lastID, aliases, user);
    if (unitCost) await db.runAsync('UPDATE inventory SET unitCost = ? WHERE id = ?', [unitCost, result.lastID]);
    if (quantity > 0) {
        await postTransaction({
            item: { id: result.lastID, itemCode, itemName, quantity: 0, unit }, type: 'Nhap', quantity,
            reason: 'Tồn đầu kỳ', refType: 'TonDau', user
        });
    }
    res.json({ success: true, id: result.lastID });
};

exports.deleteItem = async (req, res) => {
    const item = await db.getAsync('SELECT id, quantity, image FROM inventory WHERE id = ?', [req.params.id]);
    if (!item) throw notFound('Không tìm thấy mặt hàng.');
    if (toNum(item.quantity) !== 0) throw conflict('Mặt hàng còn tồn kho, hãy xuất hết trước khi xóa.');
    if (await db.getAsync(`SELECT id FROM stock_holds WHERE itemId = ? AND status = 'hold' LIMIT 1`, [item.id])) throw conflict('Mặt hàng đang được tạm xuất cho đơn hàng đang báo giá, chưa xóa được.');
    await db.runAsync('DELETE FROM inventory WHERE id = ?', [item.id]);
    await db.runAsync('DELETE FROM inventory_aliases WHERE itemId = ?', [item.id]);
    removeImageFile(item.image);
    res.json({ success: true });
};

// ===== TRANSACTIONS =====
exports.getTransactions = async (req, res) => {
    const { itemId } = req.query;
    const rows = itemId
        ? await db.allAsync('SELECT * FROM inventory_transactions WHERE itemId = ? ORDER BY id DESC LIMIT 500', [itemId])
        : await db.allAsync('SELECT * FROM inventory_transactions ORDER BY id DESC LIMIT 200');
    res.json(rows);
};

exports.createTransaction = async (req, res) => {
    const { itemId, type, reason, refType, refId, refCode, note } = req.body;
    const quantity = toNum(req.body.quantity);
    const unitPrice = toNum(req.body.unitPrice);

    if (type !== 'Nhap' && type !== 'Xuat') throw badRequest('Loại phiếu không hợp lệ.');
    if (quantity <= 0) throw badRequest('Số lượng phải lớn hơn 0.');
    if (unitPrice < 0) throw badRequest('Đơn giá không được âm.');

    const item = await db.getAsync('SELECT * FROM inventory WHERE id = ?', [itemId]);
    if (!item) throw notFound('Không tìm thấy mặt hàng.');

    const transCode = await postTransaction({ item, type, quantity, unitPrice, reason, refType, refId, refCode, note, user: userName(req) });
    res.json({ success: true, transCode });
};
