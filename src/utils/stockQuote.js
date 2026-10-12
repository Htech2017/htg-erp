// Bao gia vat tu co kiem tra ton kho:
//   so luong can mua = so luong khach can - so luong lay tu kho
//   gia cost         = (lay kho x gia kho) + (can mua x gia di mua)
const db = require('../models/database');
const { toNum, badRequest } = require('./http');

// Tinh lai tung dong theo ton kho HIEN TAI (khong tin so lieu tinh o trinh duyet).
// lines: [{ itemId?, name, need, buyPrice, stockPrice? }]
// Ton kho trong bang inventory da tru san phan dang tam xuat cho cac don / loai mach khac.
// Tu, tro mua THEO NHOM: ca nhom lay 1 NCC, chi doi rieng tung ma khi NCC do het hang. IC va linh kien khac can doi NCC tung ma.
const PASSIVE_RE = /(^|[^a-zà-ỹ])(tụ|trở|điện trở|resistor|capacitor|cap|res)([^a-zà-ỹ]|$)/i;
const isPassive = (item, name) => PASSIVE_RE.test(`${(item && item.category) || ''} ${name || ''}`) || /^[RC]\d/i.test((item && item.itemCode) || '');

async function priceLines(lines, reserved = {}) {
    if (!Array.isArray(lines) || !lines.length) throw badRequest('Bảng vật tư chưa có dòng nào.');
    if (lines.length > 300) throw badRequest('Bảng vật tư quá dài (tối đa 300 dòng).');

    const ids = [...new Set(lines.map((l) => Number(l.itemId)).filter(Boolean))];
    const items = ids.length
        ? await db.allAsync(`SELECT id, itemCode, itemName, unit, quantity, unitCost, category FROM inventory WHERE id IN (${ids.map(() => '?').join(', ')})`, ids)
        : [];
    const byId = new Map(items.map((i) => [i.id, i]));
    const remaining = new Map(items.map((i) => [i.id, Math.max(0, toNum(i.quantity) - toNum(reserved[i.id]))])); // 1 ma hang xuat hien nhieu dong khong duoc tinh ton 2 lan

    const out = [];
    let total = 0;
    lines.forEach((line, idx) => {
        const row = idx + 1;
        const item = byId.get(Number(line.itemId)) || null;
        const name = String((item && `${item.itemCode} - ${item.itemName}`) || line.name || '').trim();
        const need = toNum(line.need);
        const buyPrice = toNum(line.buyPrice);
        if (!name) throw badRequest(`Dòng ${row}: chưa chọn hoặc nhập tên vật tư.`);
        if (need <= 0) throw badRequest(`Dòng ${row} (${name}): số lượng cần phải lớn hơn 0.`);
        if (buyPrice < 0) throw badRequest(`Dòng ${row} (${name}): giá mua không được âm.`);

        // Khach cap (khach gui linh kien sang): khong lay kho, khong mua, khong tinh vao gia cost
        const khachCap = !!line.khachCap;
        const stock = item ? remaining.get(item.id) : 0;
        const fromStock = khachCap ? 0 : Math.min(need, stock);
        const toBuy = khachCap ? 0 : need - fromStock;
        if (item) remaining.set(item.id, stock - fromStock);

        // Gia kho = gia von binh quan cua ma hang; ma hang chua co gia von thi nguoi bao gia nhap tay
        const stockPrice = item && toNum(item.unitCost) > 0 ? toNum(item.unitCost) : toNum(line.stockPrice);
        if (fromStock > 0 && stockPrice <= 0) throw badRequest(`Dòng ${row} (${name}): kho còn hàng nhưng chưa có giá kho, vui lòng nhập giá kho.`);
        if (toBuy > 0 && buyPrice <= 0) throw badRequest(`Dòng ${row} (${name}): cần mua thêm ${toBuy} nhưng chưa có giá mua.`);

        // Mua theo MOQ / mua du: SL mua thuc te >= SL can mua. Phan du TRA KHACH thi khach chiu (tinh vao cost); phan du NHAP KHO thi cong ty giu (khong tinh).
        const buyQty = toBuy > 0 ? Math.max(toBuy, toNum(line.buyQty)) : 0;
        const surplus = buyQty > toBuy ? (line.surplus === 'khach' ? 'khach' : 'kho') : '';
        const cost = Math.round(fromStock * stockPrice + (surplus === 'khach' ? buyQty : toBuy) * buyPrice);
        total += cost;
        out.push({
            itemId: item ? item.id : null, itemCode: item ? item.itemCode : null, name, unit: item ? item.unit : (line.unit || ''),
            perSet: toNum(line.perSet) || null, need, stock: item ? Math.max(0, toNum(item.quantity) - toNum(reserved[item.id])) : 0,
            fromStock, toBuy, stockPrice: fromStock > 0 ? stockPrice : 0, buyPrice: toBuy > 0 ? buyPrice : 0,
            khachCap, group: isPassive(item, name) ? 'passive' : '',
            supplier: toBuy > 0 ? String(line.supplier || '').trim().slice(0, 100) : '', cost,
            rid: String(line.rid || '').slice(0, 20) || `L${idx + 1}`, buyQty, surplus,
            alt: String(line.alt || '').trim().slice(0, 150), lead: String(line.lead || '').trim().slice(0, 60)
        });
    });
    return { lines: out, total, at: new Date().toISOString() };
}

module.exports = { priceLines, isPassive };
