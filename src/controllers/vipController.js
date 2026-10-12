// DON HANG KHACH VIP - khach dat gia cong deu dan, quan ly theo LO.
//   - San pham VIP (vip_sanpham): moi san pham la 1 mach cua 1 khach, co BOM chuan, gia PCB / gia cong / gia ban theo 1 san pham.
//   - Lo hang: chon khach + cac san pham + so luong. He thong doi chieu tung BOM voi kho: ma nao lay kho, ma nao phai mua them.
//   - Tao lo = tao 1 don PCB/LK/SX da chot san (khong qua vong bao gia), danh dau orders.vip = 1. Tu do di theo cac trang san co:
//     Dieu hanh mua linh kien (mua them, soan kho, nhat theo BOM, ban giao) -> Dieu phoi san xuat -> giao hang, thu tien.
const db = require('../models/database');
const flow = require('../utils/orderFlow');
const materials = require('../utils/materials');
const orderController = require('./orderController');
const { isPassive } = require('../utils/stockQuote');
const { parseJson, toNum, userName, badRequest, notFound, conflict } = require('../utils/http');

const cleanBom = (list) => (Array.isArray(list) ? list : []).slice(0, 300).map((l) => ({
    itemId: Number(l.itemId) || null, name: String(l.name || '').trim().slice(0, 200), perSet: toNum(l.perSet),
    buyPrice: toNum(l.buyPrice), supplier: String(l.supplier || '').trim().slice(0, 100), khachCap: !!l.khachCap
})).filter((l) => l.name && l.perSet > 0);
exports.cleanBom = cleanBom;
// Ten hien thi cua 1 ma mach: "<ma mach> - <ten>"
const boardName = (p) => (p.maMach && p.maMach !== p.tenMach ? `${p.maMach} - ${p.tenMach}` : p.tenMach);
// Phan THIET KE cua BOM (linh kien nao, dinh muc bao nhieu, ai cap). Doi gia mua / nguon mua khong phai doi thiet ke.
const designKey = (bom) => JSON.stringify(bom.map((l) => [l.itemId || l.name.toLowerCase(), l.perSet, l.khachCap ? 1 : 0]));

// Doi chieu BOM cua cac san pham voi ton kho HIEN TAI. Ton kho duoc tru dan qua tung BOM (khong tinh trung), nhung KHONG gop cac BOM voi nhau.
async function checkLot(items) {
    const inv = await db.allAsync('SELECT id, itemCode, itemName, unit, quantity, unitCost, category, location FROM inventory');
    const byId = new Map(inv.map((i) => [i.id, i]));
    const remaining = new Map(inv.map((i) => [i.id, Math.max(0, toNum(i.quantity))]));
    const boards = [];
    for (const it of items) {
        const p = await db.getAsync('SELECT * FROM vip_sanpham WHERE id = ? AND active = 1', [it.productId]);
        if (!p) throw notFound('Không tìm thấy sản phẩm VIP.');
        const qty = Math.round(toNum(it.qty));
        if (qty <= 0) throw badRequest(`Sản phẩm "${p.tenMach}": số lượng phải lớn hơn 0.`);
        if (toNum(p.giaBan) <= 0) throw badRequest(`Mã mạch "${boardName(p)}" chưa có giá bán: hãy bổ sung ở tab Sản phẩm VIP trước khi tạo lô.`);
        if (p.coLK && !cleanBom(parseJson(p.bom, [])).length) throw badRequest(`Mã mạch "${boardName(p)}" chưa có BOM: hãy nhập BOM cho mã mạch này trước khi tạo lô.`);
        const rows = (p.coLK ? cleanBom(parseJson(p.bom, [])) : []).map((l) => {
            const item = l.itemId ? byId.get(l.itemId) : null;
            const need = Math.round(l.perSet * qty * 1000) / 1000;
            const avail = item ? remaining.get(item.id) : 0;
            const fromStock = l.khachCap ? 0 : Math.min(need, avail);
            const toBuy = l.khachCap ? 0 : need - fromStock;
            if (item) remaining.set(item.id, avail - fromStock);
            return { ...l, itemCode: item ? item.itemCode : '', name: item ? `${item.itemCode} - ${item.itemName}` : l.name, unit: item ? item.unit : '', location: item ? item.location || '' : '',
                need, stock: avail, fromStock, toBuy, amount: Math.round(toBuy * l.buyPrice), group: isPassive(item, l.name) ? 'passive' : '' };
        });
        boards.push({ productId: p.id, tenMach: boardName(p), maMach: p.maMach || '', rev: p.rev || 1, qty, coPCB: !!p.coPCB, coLK: !!p.coLK, coSX: !!p.coSX, giaPCB: p.giaPCB, giaGiaCong: p.giaGiaCong, giaBan: p.giaBan, rows,
            fromStockN: rows.filter((r) => r.fromStock > 0).length, toBuyN: rows.filter((r) => r.toBuy > 0).length, khachN: rows.filter((r) => r.khachCap).length,
            buyAmount: rows.reduce((s, r) => s + r.amount, 0), revenue: Math.round(toNum(p.giaBan) * qty) });
    }
    return { boards, buyAmount: boards.reduce((s, b) => s + b.buyAmount, 0), revenue: boards.reduce((s, b) => s + b.revenue, 0) };
}

// GET /api/vip
exports.overview = async (req, res) => {
    const inv = await db.allAsync('SELECT id, itemCode, itemName, unit, quantity, minQuantity, unitCost FROM inventory ORDER BY itemCode');
    const stock = new Map(inv.map((i) => [i.id, i]));
    const revs = await db.allAsync('SELECT id, productId, rev, ngay, noiDung, nguoi FROM vip_revisions ORDER BY rev DESC, id DESC');
    const products = (await db.allAsync(`SELECT p.*, c.tenKH FROM vip_sanpham p LEFT JOIN customers c ON c.maKH = p.maKH ORDER BY p.active DESC, p.maKH, p.maMach, p.tenMach`)).map((p) => {
        const bom = cleanBom(parseJson(p.bom, []));
        // Kho hien du lam bao nhieu bo (tinh theo cac ma co trong kho, khong tinh dong khach cap)
        let sets = null, limit = '';
        for (const l of bom) {
            if (l.khachCap) continue;
            const item = l.itemId ? stock.get(l.itemId) : null;
            const can = item ? Math.floor(toNum(item.quantity) / l.perSet) : 0;
            if (sets === null || can < sets) { sets = can; limit = item ? item.itemCode : l.name; }
        }
        return { ...p, bom, rev: p.rev || 1, maMach: p.maMach || '', label: boardName(p), revisions: revs.filter((r) => r.productId === p.id), stockSets: sets, stockLimit: sets === null ? '' : limit };
    });
    const orders = await db.allAsync(`SELECT o.*, c.tenKH FROM orders o LEFT JOIN customers c ON c.maKH = o.maKH WHERE o.vip = 1 ORDER BY o.id DESC LIMIT 300`);
    const ids = orders.map((o) => o.id);
    const boards = ids.length ? await db.allAsync(`SELECT * FROM order_items WHERE orderId IN (${ids.map(() => '?').join(', ')}) ORDER BY orderId, stt`, ids) : [];
    const mats = await materials.forBoards(boards);
    const dispatches = ids.length ? await db.allAsync(`SELECT d.lineId, d.status, d.progress, w.name AS workshopName FROM dispatches d LEFT JOIN workshops w ON w.id = d.workshopId WHERE d.orderId IN (${ids.map(() => '?').join(', ')})`, ids) : [];
    res.json({
        products,
        lots: orders.map((o) => ({
            id: o.id, maDH: o.maDH, maKH: o.maKH, tenKH: o.tenKH || o.maKH, ngayTao: o.ngayTao, ngayBanGiao: o.ngayBanGiao, noteDH: o.noteDH, saleName: o.saleName, vat: o.vat,
            giaiDoan: flow.computeStage(o), ttQuyTrinh: o.ttQuyTrinh, ttDonHang: o.ttDonHang, tongCong: flow.tongCong(o), daThu: flow.daThu(o), conNo: flow.conNo(o), tongCost: flow.totalCost(o),
            boards: boards.filter((b) => b.orderId === o.id).map((b) => ({ lineId: b.id, tenMach: b.tenMach, vipProductId: b.vipProductId || null, vipRev: b.vipRev || null, qty: Math.max(toNum(b.soLuongGiaCong), toNum(b.soLuongLK), toNum(b.soLuongPCB)), kitAt: b.kitAt, mat: mats.get(b.id) || null, dispatch: dispatches.find((d) => d.lineId === b.id) || null }))
        })),
        customers: await db.allAsync('SELECT maKH, tenKH FROM customers ORDER BY tenKH'),
        inventory: inv,
        suppliers: await db.allAsync(`SELECT name FROM suppliers WHERE COALESCE(status, 1) = 1 AND COALESCE(type, '') IN ('', 'LinhKien', 'Tất cả') ORDER BY name`)
    });
};

// POST /api/vip/products/save
exports.saveProduct = async (req, res) => {
    const b = req.body || {};
    const maMach = String(b.maMach || '').trim().slice(0, 80);
    const tenMach = String(b.tenMach || '').trim() || maMach;
    const maKH = String(b.maKH || '').trim();
    const draft = !!b.draft; // nhap tu file: cho phep thieu gia / BOM, bo sung sau (chua tao lo duoc cho toi khi du)
    let changeNote = String(b.changeNote || '').trim().slice(0, 500);
    if (!maMach) throw badRequest('Vui lòng nhập mã mạch (mã khách dùng để gọi mạch này).');
    const old = b.id ? await db.getAsync('SELECT * FROM vip_sanpham WHERE id = ?', [b.id]) : null;
    if (b.id && !old) throw notFound('Không tìm thấy sản phẩm.');
    if (await db.getAsync('SELECT id FROM vip_sanpham WHERE maKH = ? AND maMach = ? COLLATE NOCASE AND id != ?', [maKH, maMach, b.id || 0])) throw conflict(`Khách này đã có mã mạch "${maMach}". Nếu khách đổi thiết kế, hãy mở mã mạch đó và ghi nhận thay đổi thiết kế.`);
    if (!(await db.getAsync('SELECT id FROM customers WHERE maKH = ?', [maKH]))) throw badRequest('Vui lòng chọn khách hàng.');
    const co = { coPCB: b.coPCB ? 1 : 0, coLK: b.coLK ? 1 : 0, coSX: b.coSX ? 1 : 0 };
    if (!co.coPCB && !co.coLK && !co.coSX) throw badRequest('Sản phẩm cần ít nhất một hạng mục: PCB, linh kiện hoặc sản xuất.');
    const giaPCB = toNum(b.giaPCB), giaGiaCong = toNum(b.giaGiaCong), giaBan = toNum(b.giaBan);
    const oldBom = old ? cleanBom(parseJson(old.bom, [])) : [];
    const bom = co.coLK ? (b.keepBom ? oldBom : cleanBom(b.bom)) : [];
    if (!draft && co.coPCB && giaPCB <= 0) throw badRequest('Có hạng mục PCB thì cần giá PCB / 1 sản phẩm.');
    if (!draft && co.coSX && giaGiaCong <= 0) throw badRequest('Có hạng mục sản xuất thì cần giá gia công / 1 sản phẩm.');
    if (!draft && giaBan <= 0) throw badRequest('Vui lòng nhập giá bán / 1 sản phẩm.');
    if (co.coLK && !draft) {
        if (!bom.length) throw badRequest('Có hạng mục linh kiện thì BOM cần ít nhất một dòng.');
        if (bom.every((l) => l.khachCap)) throw badRequest('Tất cả linh kiện đều khách cấp: hãy bỏ tick hạng mục Linh kiện.');
        const noPrice = bom.find((l) => !l.khachCap && l.buyPrice <= 0);
        if (noPrice) throw badRequest(`BOM: "${noPrice.name}" chưa có giá mua (dùng khi kho thiếu phải mua thêm).`);
    }
    // Doi thiet ke: cung 1 ma mach nhung khach doi BOM / mach -> bat buoc ghi noi dung thay doi, tang rev, luu lai BOM cua rev do.
    const designChanged = !!old && oldBom.length > 0 && designKey(oldBom) !== designKey(bom);
    if (!changeNote && b.autoNote && (designChanged || (oldBom.length === 0 && bom.length > 0))) changeNote = String(b.autoNote).trim().slice(0, 500); // nhap tu file: chi ghi khi BOM thuc su doi
    if (designChanged && !changeNote) throw badRequest('BOM khác với thiết kế đang lưu: hãy ghi "Nội dung thay đổi thiết kế" để lưu thành rev mới.');
    const now = new Date().toISOString();
    const vals = [maKH, maMach, tenMach, co.coPCB, co.coLK, co.coSX, giaPCB, giaGiaCong, giaBan, JSON.stringify(bom), String(b.ghiChu || '').trim().slice(0, 500), b.active === false || b.active === 0 ? 0 : 1];
    if (b.id) {
        const r = await db.runAsync('UPDATE vip_sanpham SET maKH=?, maMach=?, tenMach=?, coPCB=?, coLK=?, coSX=?, giaPCB=?, giaGiaCong=?, giaBan=?, bom=?, ghiChu=?, active=?, updatedBy=?, updatedAt=? WHERE id=?',
            [...vals, userName(req), now, b.id]);
        if (!r.changes) throw notFound('Không tìm thấy sản phẩm.');
        let rev = old.rev || 1;
        const firstBom = oldBom.length === 0 && bom.length > 0; // BOM dau tien cua ma mach khong tinh la doi thiet ke
        if (changeNote && !firstBom) {
            rev += 1;
            await db.runAsync('UPDATE vip_sanpham SET rev = ? WHERE id = ?', [rev, b.id]);
            await db.runAsync('INSERT INTO vip_revisions (productId, rev, ngay, noiDung, nguoi, bomSnapshot) VALUES (?,?,?,?,?,?)', [b.id, rev, now, changeNote, userName(req), JSON.stringify(bom)]);
        } else {
            // Doi gia / nguon mua, hoac BOM dau tien: cap nhat ban luu cua rev hien tai
            await db.runAsync('UPDATE vip_revisions SET bomSnapshot = ?, noiDung = CASE WHEN ? = \'\' THEN noiDung ELSE noiDung || \' · \' || ? END WHERE productId = ? AND rev = ?', [JSON.stringify(bom), changeNote, changeNote, b.id, rev]);
        }
        return res.json({ success: true, id: Number(b.id), rev });
    }
    const r = await db.runAsync('INSERT INTO vip_sanpham (maKH, maMach, tenMach, coPCB, coLK, coSX, giaPCB, giaGiaCong, giaBan, bom, ghiChu, active, updatedBy, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [...vals, userName(req), now]);
    await db.runAsync('INSERT INTO vip_revisions (productId, rev, ngay, noiDung, nguoi, bomSnapshot) VALUES (?,1,?,?,?,?)', [r.lastID, now, changeNote || 'Thiết kế ban đầu', userName(req), JSON.stringify(bom)]);
    res.json({ success: true, id: r.lastID, rev: 1 });
};

// POST /api/vip/check  { items: [{ productId, qty }] }  -> xem truoc: tung BOM lay kho bao nhieu, mua them bao nhieu
exports.check = async (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) throw badRequest('Chọn ít nhất một sản phẩm.');
    res.json({ success: true, ...(await checkLot(items)) });
};

// Goi lai cac ham xu ly don hang san co (dung luat nghiep vu, tam xuat kho, sinh dong mua...) voi quyen he thong.
async function internal(handler, req, { body = {}, params = {}, query = {} }) {
    const out = {};
    const fakeReq = { body, params, query, session: { user: { ...req.session.user, allRoles: ['Admin'] } } };
    const fakeRes = { json(o) { out.body = o; return this; }, status() { return this; }, redirect() {}, send() {} };
    await handler(fakeReq, fakeRes);
    return out.body || {};
}

// POST /api/vip/lots  { maKH, items: [{ productId, qty }], ngayBanGiao, vat, note }  -> tao lo = don da chot san
exports.createLot = async (req, res) => {
    const maKH = String(req.body.maKH || '').trim();
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) throw badRequest('Chọn ít nhất một sản phẩm cho lô.');
    const plan = await checkLot(items); // kiem tra san pham, so luong; tinh doanh thu
    const products = [];
    for (const it of items) {
        const p = await db.getAsync('SELECT * FROM vip_sanpham WHERE id = ?', [it.productId]);
        if (p.maKH !== maKH) throw badRequest(`Mã mạch "${boardName(p)}" không thuộc khách hàng đã chọn.`);
        products.push({ p, qty: Math.round(toNum(it.qty)) });
    }
    const note = String(req.body.note || '').trim();
    // 1. Tao don (lo): moi san pham la 1 loai mach
    const created = await internal(orderController.saveOrder, req, { body: {
        loaiDV: 'sx', maKH, saleName: userName(req), ngayBanGiao: /^\d{4}-\d{2}-\d{2}$/.test(req.body.ngayBanGiao || '') ? req.body.ngayBanGiao : null, vat: toNum(req.body.vat),
        noteDH: `LÔ VIP${note ? ' · ' + note : ''}`,
        items: products.map(({ p, qty }) => ({ tenMach: boardName(p), soLuongPCB: p.coPCB ? qty : 0, soLuongLK: p.coLK ? qty : 0, soLuongGiaCong: p.coSX ? qty : 0 }))
    } });
    if (!created.id) throw conflict('Không tạo được lô.');
    try {
        await db.runAsync('UPDATE orders SET vip = 1 WHERE id = ?', [created.id]);
        const lines = await db.allAsync('SELECT id FROM order_items WHERE orderId = ? ORDER BY stt, id', [created.id]);
        // 2. Gia cost tung mach theo san pham; linh kien doi chieu kho (tam xuat phan lay kho)
        for (const [i, { p, qty }] of products.entries()) {
            const lineId = lines[i].id;
            await db.runAsync('UPDATE order_items SET vipProductId = ?, vipRev = ?, ghiChu = ? WHERE id = ?', [p.id, p.rev || 1, `Thiết kế rev ${p.rev || 1}`, lineId]); // lo lam theo thiet ke nao
            if (p.coPCB) await internal(orderController.patchCost, req, { params: { id: created.id }, body: { lineId, giaCostPCB: Math.round(p.giaPCB * qty) } });
            if (p.coLK) await internal(orderController.patchCost, req, { params: { id: created.id }, body: { lineId, detail: { giaCostLK: cleanBom(parseJson(p.bom, [])).map((l) => ({ ...l, need: Math.round(l.perSet * qty * 1000) / 1000 })) } } });
            if (p.coSX) await internal(orderController.patchCost, req, { params: { id: created.id }, body: { lineId, giaCostGiaCong: Math.round(p.giaGiaCong * qty) } });
        }
        // 3. Gia ban theo san pham, chot luon (khach VIP khong qua vong bao gia) -> sinh danh sach can mua
        await internal(orderController.patchStatus, req, { params: { id: created.id }, body: { giaBao: plan.revenue, ttQuyTrinh: 'Đã báo giá', ttChotDon: 'Đã chốt' } });
    } catch (err) {
        // Lam do: huy lo vua tao (tai nhap kho phan da tam xuat) roi bao loi
        try { await internal(orderController.patchStatus, req, { params: { id: created.id }, body: { ttQuyTrinh: 'Hủy đơn', lyDoHuy: 'Tạo lô VIP không thành công' } }); await internal(orderController.deleteOrder, req, { params: { id: created.id } }); } catch (e) { /* bo qua */ }
        throw err;
    }
    res.json({ success: true, id: created.id, maDH: created.maDH });
};
