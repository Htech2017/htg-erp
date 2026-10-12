// NHAP / XUAT DU LIEU (Excel .xlsx/.xls, .csv, .txt) cho cac danh sach: khach hang, kho, nha cung cap, san pham VIP, BOM theo ma mach, don hang.
// Dung de so hoa du lieu dang co: file cua nguoi dung KHONG can dung mau - he thong tu do dong tieu de, goi y ghep cot <-> truong,
// nguoi dung chinh lai roi "Kiem tra truoc" (khong ghi) hoac "Nhap du lieu". Ghi du lieu di qua cac ham luu san co de giu dung luat nghiep vu.
const path = require('path');
const XLSX = require('xlsx');
const db = require('../models/database');
const { PERMS } = require('../config');
const { hasRole } = require('../middlewares/authMiddleware');
const { buildIndex, matchRow } = require('../utils/partMatch');
const { parseJson, toNum, userName, badRequest, forbidden } = require('../utils/http');
const customerController = require('./customerController');
const inventoryController = require('./inventoryController');
const purchaseController = require('./purchaseController');
const orderController = require('./orderController');
const vipController = require('./vipController');

const MAX_ROWS = 5000;
const norm = (v) => String(v === null || v === undefined ? '' : v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '');
const str = (v) => String(v === null || v === undefined ? '' : v).trim();
const yes = (v) => ['1', 'x', 'co', 'yes', 'y', 'true', 'v'].includes(norm(v));
// Ngay: nhan Date (Excel), yyyy-mm-dd, dd/mm/yyyy
function toDate(v) {
    if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(v.getTime() + 12 * 3600 * 1000).toISOString().slice(0, 10);
    const s = str(v);
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return '';
}

// ---------- Doc file thanh bang (mang cac dong, moi dong la mang o) ----------
function parseDelimited(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
    const delim = ['\t', ';', ',', '|'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
        } else if (ch === '"' && cell === '') quoted = true;
        else if (ch === delim) { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i += 1; row.push(cell); rows.push(row); row = []; cell = ''; }
        else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
}
function readTable(file, sheetName) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    let rows, sheets = [];
    if (['.txt', '.tsv', '.csv'].includes(ext)) {
        const buf = file.buffer;
        const text = buf[0] === 0xFF && buf[1] === 0xFE ? buf.toString('utf16le') : buf.toString('utf8');
        rows = parseDelimited(text);
    } else {
        const wb = XLSX.read(file.buffer, { type: 'buffer', cellDates: true });
        sheets = wb.SheetNames;
        const ws = wb.Sheets[sheets.includes(sheetName) ? sheetName : sheets[0]];
        rows = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true }) : [];
    }
    rows = rows.map((r) => r.map((c) => (typeof c === 'string' ? c.trim() : c))).filter((r) => r.some((c) => c !== '' && c !== null && c !== undefined));
    return { rows, sheets };
}
// Dong tieu de = dong (trong 15 dong dau) co nhieu o trung ten truong nhat. Goi y ghep cot: trung ten / ten goi khac cua truong.
function detect(entity, rows) {
    const keys = entity.fields.map((f) => [f, [f.label, f.key, ...(f.aliases || [])].map(norm)]);
    let headerRow = 0, best = 0;
    rows.slice(0, 15).forEach((r, i) => {
        const hit = r.filter((c) => { const x = norm(c); return x && keys.some(([, names]) => names.includes(x)); }).length;
        if (hit > best) { best = hit; headerRow = i; }
    });
    const headers = (rows[headerRow] || []).map((h, i) => str(h) || `Cột ${i + 1}`);
    const mapping = {}, used = new Set();
    for (const pass of [0, 1]) {
        for (const [f, names] of keys) {
            if (mapping[f.key] !== undefined) continue;
            const idx = headers.findIndex((h, i) => !used.has(i) && norm(h) && (pass === 0 ? names.includes(norm(h)) : names.some((x) => x.length >= 4 && norm(h).includes(x))));
            if (idx >= 0) { mapping[f.key] = idx; used.add(idx); }
        }
    }
    return { headerRow, headers, mapping, matched: best };
}

// Goi lai ham luu san co voi quyen he thong (quyen nhap cua tung danh sach da kiem tra rieng o duoi).
async function internal(handler, req, body) {
    const out = {};
    const fakeReq = { body, params: {}, query: {}, session: { user: { ...req.session.user, allRoles: ['Admin'] } } };
    const fakeRes = { json(o) { out.body = o; return this; }, status() { return this; }, redirect() {}, send() {} };
    await handler(fakeReq, fakeRes);
    return out.body || {};
}
const F = (key, label, aliases = [], required = false) => ({ key, label, aliases, required });
const need = (rec, key, label) => { if (!str(rec[key])) throw badRequest(`thiếu ${label}`); return str(rec[key]); };
async function findCustomer(ctx, value) {
    if (!ctx.customers) ctx.customers = await db.allAsync('SELECT id, maKH, tenKH, nick_name FROM customers');
    const x = norm(value);
    return x ? ctx.customers.find((c) => norm(c.maKH) === x) || ctx.customers.find((c) => norm(c.tenKH) === x) || ctx.customers.find((c) => norm(c.nick_name) === x) : null;
}

// ---------- Khai bao cac danh sach ----------
const given = (r, k) => r[k] !== undefined && str(r[k]) !== '';
const pick = (r, cur, k) => (given(r, k) ? str(r[k]) : (cur ? cur[k] : undefined));
const perRow = (fn) => async (records, ctx, req, opt) => {
    const tasks = [];
    for (const r of records) {
        try { tasks.push({ rows: [r._row], ...(await fn(r, ctx, req, opt)) }); } catch (e) { tasks.push({ rows: [r._row], action: 'error', error: e.message }); }
    }
    return tasks;
};
const seen = (ctx, key) => { ctx.seen = ctx.seen || new Set(); if (ctx.seen.has(key)) throw badRequest('trùng với một dòng phía trên trong file'); ctx.seen.add(key); };

const ENTITIES = {};
ENTITIES.customers = {
    label: 'Khách hàng', read: PERMS.CUSTOMER_READ, write: PERMS.CUSTOMER_WRITE, keyNote: 'Khóa: Mã KH. Bỏ trống mã thì tự sinh = NickName + 5 số cuối SĐT.',
    fields: [F('maKH', 'Mã KH', ['ma khach hang', 'ma khach', 'customer code']), F('nick_name', 'NickName', ['nick', 'ten viet tat', 'ten ngan']), F('tenKH', 'Tên khách hàng', ['ten khach', 'khach hang', 'ten', 'name', 'cong ty'], true),
        F('sdt', 'Số điện thoại', ['sdt', 'dien thoai', 'phone', 'mobile', 'so dt', 'dt', 'tel']), F('diaChi', 'Địa chỉ', ['dia chi', 'address', 'dc']), F('old_debt', 'Nợ cũ', ['no cu', 'cong no dau', 'no dau ky'])],
    rows: () => db.allAsync('SELECT maKH, nick_name, tenKH, sdt, diaChi, old_debt FROM customers ORDER BY tenKH'),
    plan: perRow(async (r, ctx, req, opt) => {
        const tenKH = need(r, 'tenKH', 'tên khách hàng');
        const nick = str(r.nick_name) || 'KH';
        const maKH = str(r.maKH) || customerController.buildMaKH(nick, r.sdt);
        seen(ctx, maKH);
        const cur = await db.getAsync('SELECT * FROM customers WHERE maKH = ?', [maKH]);
        if (cur && !opt.update) return { action: 'skip', label: `${maKH} đã có` };
        if (cur) return { action: 'update', label: `${maKH} - ${tenKH}`, run: () => db.runAsync('UPDATE customers SET nick_name=?, tenKH=?, sdt=?, diaChi=?, old_debt=? WHERE id=?',
            [pick(r, cur, 'nick_name'), tenKH, pick(r, cur, 'sdt'), pick(r, cur, 'diaChi'), given(r, 'old_debt') ? toNum(r.old_debt) : cur.old_debt, cur.id]) };
        // Thu muc Drive duoc tao khi khach co don hang dau tien (khong tao hang loat luc nhap)
        return { action: 'new', label: `${maKH} - ${tenKH}`, run: () => db.runAsync('INSERT INTO customers (maKH, nick_name, tenKH, sdt, diaChi, old_debt) VALUES (?,?,?,?,?,?)', [maKH, nick, tenKH, str(r.sdt), str(r.diaChi), toNum(r.old_debt)]) };
    })
};
ENTITIES.inventory = {
    label: 'Kho (mặt hàng, linh kiện)', read: PERMS.INVENTORY, write: PERMS.INVENTORY, keyNote: 'Khóa: Mã hàng. Mã mới có "Tồn kho" thì sinh phiếu Tồn đầu kỳ; mã cũ đổi tồn thì sinh phiếu điều chỉnh.',
    fields: [F('itemCode', 'Mã hàng', ['ma', 'ma lk', 'ma linh kien', 'ma vat tu', 'item code', 'code', 'part number'], true), F('itemName', 'Tên hàng', ['ten', 'ten linh kien', 'ten vat tu', 'mo ta ngan', 'name', 'item name'], true),
        F('category', 'Nhóm', ['loai', 'nhom hang', 'category']), F('unit', 'Đơn vị', ['dvt', 'don vi tinh', 'unit']), F('quantity', 'Tồn kho', ['ton', 'so luong', 'sl', 'sl ton', 'qty', 'quantity']),
        F('minQuantity', 'Tồn tối thiểu', ['ton min', 'min', 'dinh muc ton']), F('unitCost', 'Giá kho', ['don gia', 'gia', 'gia von', 'gia nhap', 'price']), F('location', 'Vị trí', ['vi tri kho', 'ke', 'ngan', 'location']),
        F('mpn', 'Mã NSX', ['mpn', 'ma nha san xuat', 'manufacturer part']), F('package', 'Kiểu chân', ['footprint', 'package', 'kieu chan']), F('description', 'Mô tả', ['thong so', 'description']), F('note', 'Ghi chú', ['note']),
        F('aliases', 'Tên gọi khác', ['alias', 'ten khac'])],
    rows: async () => {
        const al = await db.allAsync('SELECT itemId, alias FROM inventory_aliases');
        return (await db.allAsync('SELECT * FROM inventory ORDER BY itemCode')).map((i) => ({ ...i, aliases: al.filter((a) => a.itemId === i.id).map((a) => a.alias).join('; ') }));
    },
    plan: perRow(async (r, ctx, req, opt) => {
        const itemCode = need(r, 'itemCode', 'mã hàng').toUpperCase();
        seen(ctx, itemCode);
        const cur = await db.getAsync('SELECT * FROM inventory WHERE itemCode = ?', [itemCode]);
        if (cur && !opt.update) return { action: 'skip', label: `${itemCode} đã có` };
        const body = { itemCode, itemName: cur ? pick(r, cur, 'itemName') : need(r, 'itemName', 'tên hàng') };
        for (const k of ['category', 'unit', 'location', 'description', 'note', 'mpn', 'package']) body[k] = pick(r, cur, k);
        body.minQuantity = given(r, 'minQuantity') ? toNum(r.minQuantity) : (cur ? cur.minQuantity : 0);
        if (given(r, 'unitCost')) body.unitCost = toNum(r.unitCost);
        if (given(r, 'quantity')) body.quantity = toNum(r.quantity);
        if (given(r, 'aliases')) body.aliases = str(r.aliases).split(/[;|]/).map((a) => a.trim()).filter(Boolean);
        if (cur) body.id = cur.id;
        return { action: cur ? 'update' : 'new', label: `${itemCode} - ${body.itemName}`, run: () => internal(inventoryController.saveItem, req, body) };
    })
};
ENTITIES.suppliers = {
    label: 'Nhà cung cấp', read: PERMS.PURCHASE_READ, write: PERMS.PURCHASE_WRITE, keyNote: 'Khóa: Mã NCC, không có mã thì theo Tên NCC.',
    fields: [F('code', 'Mã NCC', ['ma', 'ma nha cung cap', 'code']), F('name', 'Tên NCC', ['ten', 'nha cung cap', 'ncc', 'ten nha cung cap', 'supplier', 'name'], true), F('type', 'Loại', ['nhom', 'type']),
        F('phone', 'Điện thoại', ['sdt', 'so dien thoai', 'phone']), F('email', 'Email', ['mail']), F('address', 'Địa chỉ', ['dia chi', 'address']), F('contactPerson', 'Người liên hệ', ['lien he', 'contact']),
        F('bankName', 'Ngân hàng', ['bank']), F('bankNo', 'Số tài khoản', ['stk', 'tai khoan', 'so tk']), F('rating', 'Đánh giá (1-5)', ['danh gia', 'rating']), F('note', 'Ghi chú', ['note'])],
    rows: () => db.allAsync('SELECT * FROM suppliers ORDER BY name'),
    plan: perRow(async (r, ctx, req, opt) => {
        const name = need(r, 'name', 'tên nhà cung cấp');
        seen(ctx, norm(str(r.code) || name));
        if (!ctx.suppliers) ctx.suppliers = await db.allAsync('SELECT * FROM suppliers');
        const cur = (given(r, 'code') && ctx.suppliers.find((s) => norm(s.code) === norm(r.code))) || ctx.suppliers.find((s) => norm(s.name) === norm(name));
        if (cur && !opt.update) return { action: 'skip', label: `${name} đã có` };
        const body = { name, code: str(r.code) };
        for (const k of ['type', 'phone', 'email', 'address', 'contactPerson', 'bankName', 'bankNo', 'note']) body[k] = pick(r, cur, k);
        body.rating = given(r, 'rating') ? toNum(r.rating) : (cur ? cur.rating : 3);
        if (cur) { body.id = cur.id; body.status = cur.status; }
        return { action: cur ? 'update' : 'new', label: name, run: () => internal(purchaseController.saveSupplier, req, body) };
    })
};

const findProduct = (maKH, maMach) => db.getAsync('SELECT * FROM vip_sanpham WHERE maKH = ? AND maMach = ? COLLATE NOCASE', [maKH, maMach]);
const productBody = (p) => ({ id: p.id, maKH: p.maKH, maMach: p.maMach, tenMach: p.tenMach, coPCB: p.coPCB, coLK: p.coLK, coSX: p.coSX, giaPCB: p.giaPCB, giaGiaCong: p.giaGiaCong, giaBan: p.giaBan, ghiChu: p.ghiChu, active: p.active });
ENTITIES['vip-products'] = {
    label: 'Sản phẩm VIP (mã mạch)', read: PERMS.VIP, write: PERMS.VIP_MANAGE, keyNote: 'Khóa: Khách hàng + Mã mạch. BOM của từng mã mạch nhập ở danh sách "BOM theo mã mạch"; cập nhật ở đây không đụng tới BOM.',
    fields: [F('maKH', 'Khách hàng (mã hoặc tên)', ['ma kh', 'ma khach hang', 'khach hang', 'ten khach hang', 'khach'], true), F('maMach', 'Mã mạch', ['ma san pham', 'ma sp', 'ma hang', 'model', 'part no', 'board'], true),
        F('tenMach', 'Tên mạch', ['ten san pham', 'ten sp', 'ten', 'mo ta']), F('coPCB', 'Có PCB (x)', ['pcb']), F('coLK', 'Có linh kiện (x)', ['linh kien', 'lk']), F('coSX', 'Có sản xuất (x)', ['san xuat', 'gia cong', 'sx', 'smt']),
        F('giaPCB', 'Giá PCB / sp', ['gia pcb', 'don gia pcb']), F('giaGiaCong', 'Giá gia công / sp', ['gia gia cong', 'don gia gia cong', 'gia sx']), F('giaBan', 'Giá bán / sp', ['gia ban', 'don gia', 'don gia ban', 'gia']), F('ghiChu', 'Ghi chú', ['note'])],
    rows: async () => (await db.allAsync('SELECT * FROM vip_sanpham ORDER BY maKH, maMach')).map((p) => ({ ...p, coPCB: p.coPCB ? 'x' : '', coLK: p.coLK ? 'x' : '', coSX: p.coSX ? 'x' : '' })),
    exportFields: [F('rev', 'Rev thiết kế'), F('active', 'Đang dùng')],
    plan: perRow(async (r, ctx, req, opt) => {
        const cust = await findCustomer(ctx, need(r, 'maKH', 'khách hàng'));
        if (!cust) throw badRequest(`không tìm thấy khách hàng "${str(r.maKH)}" (nhập danh sách Khách hàng trước)`);
        const maMach = need(r, 'maMach', 'mã mạch');
        seen(ctx, cust.maKH + '|' + norm(maMach));
        const cur = await findProduct(cust.maKH, maMach);
        if (cur && !opt.update) return { action: 'skip', label: `${maMach} đã có` };
        const anyCo = ['coPCB', 'coLK', 'coSX'].some((k) => r[k] !== undefined);
        const co = (k, def) => (anyCo ? (yes(r[k]) ? 1 : 0) : (cur ? cur[k] : def));
        const num = (k) => (given(r, k) ? toNum(r[k]) : (cur ? cur[k] : 0));
        const body = { ...(cur ? productBody(cur) : {}), maKH: cust.maKH, maMach, tenMach: pick(r, cur, 'tenMach') || maMach, coPCB: co('coPCB', 0), coLK: co('coLK', 1), coSX: co('coSX', 1),
            giaPCB: num('giaPCB'), giaGiaCong: num('giaGiaCong'), giaBan: num('giaBan'), ghiChu: pick(r, cur, 'ghiChu') || '', draft: true, keepBom: true };
        return { action: cur ? 'update' : 'new', label: `${cust.maKH} · ${maMach}`, run: () => internal(vipController.saveProduct, req, body) };
    })
};
ENTITIES['vip-bom'] = {
    label: 'BOM theo mã mạch (khách VIP)', read: PERMS.VIP, write: PERMS.VIP_MANAGE,
    keyNote: 'Mỗi mã mạch một BOM. File nhập THAY toàn bộ BOM của mã mạch đó và ghi thành một lần đổi thiết kế (rev mới). Linh kiện được dò với kho theo mã hàng / mã NSX / tên gọi đã ghi nhớ.',
    fields: [F('maKH', 'Khách hàng (mã hoặc tên)', ['ma kh', 'ma khach hang', 'khach hang', 'khach']), F('maMach', 'Mã mạch', ['ma san pham', 'ma sp', 'model', 'board']),
        F('linhKien', 'Linh kiện', ['ten linh kien', 'ten', 'comment', 'value', 'description', 'mo ta', 'name', 'part'], true), F('maHang', 'Mã hàng kho', ['ma hang', 'ma lk', 'ma linh kien', 'item code', 'ma kho']),
        F('mpn', 'Mã NSX', ['mpn', 'manufacturer part', 'part number', 'ma nha san xuat']), F('package', 'Kiểu chân', ['footprint', 'package']),
        F('perSet', 'Định mức / sp', ['dinh muc', 'so luong', 'sl', 'qty', 'quantity', 'sl/bo'], true), F('buyPrice', 'Giá mua', ['don gia', 'gia', 'price']), F('supplier', 'Nguồn mua', ['ncc', 'nha cung cap', 'supplier']), F('khachCap', 'Khách cấp (x)', ['khach cap', 'khach gui'])],
    rows: async (req) => {
        const inv = new Map((await db.allAsync('SELECT id, itemCode, itemName, mpn, package FROM inventory')).map((i) => [i.id, i]));
        const pid = Number(req.query.productId) || 0;
        const out = [];
        for (const p of await db.allAsync(`SELECT * FROM vip_sanpham ${pid ? 'WHERE id = ?' : ''} ORDER BY maKH, maMach`, pid ? [pid] : [])) {
            for (const l of vipController.cleanBom(parseJson(p.bom, []))) {
                const it = l.itemId ? inv.get(l.itemId) : null;
                out.push({ maKH: p.maKH, maMach: p.maMach || p.tenMach, linhKien: it ? it.itemName : l.name, maHang: it ? it.itemCode : '', mpn: it ? it.mpn : '', package: it ? it.package : '', perSet: l.perSet, buyPrice: l.buyPrice, supplier: l.supplier, khachCap: l.khachCap ? 'x' : '' });
            }
        }
        return out;
    },
    plan: async (records, ctx, req, opt) => {
        const inv = await db.allAsync('SELECT * FROM inventory');
        const index = buildIndex(inv, await db.allAsync('SELECT * FROM inventory_aliases'));
        const byCode = new Map(inv.map((i) => [norm(i.itemCode), i]));
        const byId = new Map(inv.map((i) => [i.id, i]));
        const fixed = opt.productId ? await db.getAsync('SELECT * FROM vip_sanpham WHERE id = ?', [opt.productId]) : null;
        if (opt.productId && !fixed) throw badRequest('Không tìm thấy mã mạch đã chọn.');
        const groups = new Map(), tasks = [];
        for (const r of records) {
            try {
                let key, g;
                if (fixed) key = 'fixed';
                else {
                    const cust = await findCustomer(ctx, need(r, 'maKH', 'khách hàng (hoặc chọn sẵn mã mạch ở trên)'));
                    if (!cust) throw badRequest(`không tìm thấy khách hàng "${str(r.maKH)}"`);
                    key = cust.maKH + '|' + norm(need(r, 'maMach', 'mã mạch'));
                    if (!groups.has(key)) groups.set(key, { maKH: cust.maKH, maMach: str(r.maMach), product: await findProduct(cust.maKH, str(r.maMach)), rows: [], lines: [], bad: 0 });
                }
                if (!groups.has(key)) groups.set(key, { maKH: fixed.maKH, maMach: fixed.maMach || fixed.tenMach, product: fixed, rows: [], lines: [], bad: 0 });
                g = groups.get(key);
                g.rows.push(r._row);
                const name = str(r.linhKien) || str(r.maHang) || str(r.mpn);
                const perSet = toNum(r.perSet);
                try {
                    if (!name) throw badRequest('thiếu tên / mã linh kiện');
                    if (!(perSet > 0)) throw badRequest('định mức phải lớn hơn 0');
                    let item = byCode.get(norm(r.maHang)) || byCode.get(norm(r.mpn)) || byCode.get(norm(r.linhKien)) || null;
                    if (!item) { const c = matchRow({ name, mpn: str(r.mpn), package: str(r.package) }, index, g.maKH).candidates[0]; if (c && c.score >= 96) item = byId.get(c.itemId); }
                    const same = g.lines.find((l) => (item ? l.itemId === item.id : !l.itemId && norm(l.name) === norm(name)));
                    if (same) same.perSet += perSet; // cung 1 linh kien nam o nhieu dong (nhieu vi tri) -> cong don dinh muc
                    else g.lines.push({ itemId: item ? item.id : null, name: item ? `${item.itemCode} - ${item.itemName}` : name, perSet, buyPrice: given(r, 'buyPrice') ? toNum(r.buyPrice) : (item ? Math.round(toNum(item.unitCost)) : 0), supplier: str(r.supplier), khachCap: yes(r.khachCap), priceGiven: given(r, 'buyPrice') });
                } catch (e) { g.bad += 1; tasks.push({ rows: [r._row], action: 'error', error: e.message }); }
            } catch (e) { tasks.push({ rows: [r._row], action: 'error', error: e.message }); }
        }
        for (const g of groups.values()) {
            const inStock = g.lines.filter((l) => l.itemId).length;
            const label = `${g.maKH} · ${g.maMach}: ${g.lines.length} linh kiện (${inStock} khớp kho, ${g.lines.length - inStock} không có trong kho)`;
            if (g.bad) { tasks.push({ rows: g.rows, action: 'error', label, error: `BOM mã mạch ${g.maMach} chưa nhập vì có ${g.bad} dòng lỗi (BOM phải đủ dòng)` }); continue; }
            // File khong co gia mua / nguon mua -> giu gia, nguon dang luu cua dung linh kien do
            const oldBom = g.product ? vipController.cleanBom(parseJson(g.product.bom, [])) : [];
            for (const l of g.lines) {
                const o = oldBom.find((x) => (l.itemId ? x.itemId === l.itemId : !x.itemId && norm(x.name) === norm(l.name)));
                if (o && !l.priceGiven) l.buyPrice = o.buyPrice;
                if (o && !l.supplier) l.supplier = o.supplier;
            }
            const base = g.product ? productBody(g.product) : { maKH: g.maKH, maMach: g.maMach, tenMach: g.maMach, coPCB: 0, coSX: 1, giaBan: 0 };
            tasks.push({ rows: g.rows, action: g.product ? 'update' : 'new', label: (g.product ? '' : 'Tạo mã mạch mới · ') + label,
                run: () => internal(vipController.saveProduct, req, { ...base, coLK: 1, bom: g.lines, changeNote: str(opt.note), autoNote: `Nhập BOM từ file ${ctx.fileName}`, draft: true }) });
        }
        return tasks;
    }
};

const flow = require('../utils/orderFlow');
const isRndText = (v) => /rnd|rd|nghiencuu|thietke/.test(norm(v));
ENTITIES.orders = {
    label: 'Đơn hàng', read: PERMS.ORDER_READ, write: PERMS.ORDER_WRITE,
    keyNote: 'Nhập = TẠO ĐƠN MỚI (không sửa đơn đã có). Các dòng cùng "Nhóm đơn" gộp thành 1 đơn nhiều loại mạch; bỏ trống thì mỗi dòng 1 đơn. Giá, chốt đơn, thu tiền làm tiếp trên phần mềm.',
    fields: [F('nhom', 'Nhóm đơn', ['ma don', 'ma dh', 'so don', 'ma don hang', 'nhom']), F('loaiDV', 'Loại đơn (SX / R&D)', ['loai', 'loai don', 'loai dv', 'dich vu']), F('maKH', 'Khách hàng (mã hoặc tên)', ['ma kh', 'ma khach hang', 'khach hang', 'ten khach hang', 'khach'], true),
        F('tenMach', 'Tên mạch / nội dung', ['ten mach', 'san pham', 'ten san pham', 'noi dung', 'ma mach', 'ten'], true), F('soLuongPCB', 'SL PCB', ['so luong pcb', 'pcb']), F('soLuongLK', 'SL linh kiện', ['so luong linh kien', 'sl lk', 'linh kien']),
        F('soLuongGiaCong', 'SL sản xuất', ['sl gia cong', 'so luong gia cong', 'so luong san xuat', 'sl sx', 'gia cong', 'san xuat', 'so luong']), F('ngayTao', 'Ngày tạo', ['ngay', 'ngay dat', 'ngay nhan']),
        F('ngayBanGiao', 'Ngày giao', ['ngay ban giao', 'giao hang', 'han giao', 'ngay giao hang']), F('vat', 'VAT (%)', ['vat', 'thue']), F('noteDH', 'Ghi chú', ['note', 'ghi chu don'])],
    exportFields: [F('tenKH', 'Tên khách hàng'), F('giaiDoan', 'Giai đoạn'), F('ttChotDon', 'Chốt đơn'), F('ngayChot', 'Ngày chốt'), F('tongCong', 'Giá trị (gồm VAT)'), F('daThu', 'Đã thu'), F('conNo', 'Còn phải thu'), F('saleName', 'Sale')],
    rows: async () => {
        const items = await db.allAsync('SELECT * FROM order_items ORDER BY orderId, stt, id');
        const out = [];
        for (const o of await db.allAsync('SELECT o.*, c.tenKH FROM orders o LEFT JOIN customers c ON c.maKH = o.maKH ORDER BY o.id DESC')) {
            const base = { nhom: o.maDH, loaiDV: o.loaiDV === 'rnd' ? 'R&D' : 'SX', maKH: o.maKH, tenKH: o.tenKH, ngayTao: (o.ngayTao || '').slice(0, 10), ngayBanGiao: o.ngayBanGiao, vat: o.vat, noteDH: o.noteDH,
                giaiDoan: flow.computeStage(o), ttChotDon: o.ttChotDon, ngayChot: o.ngayChot, saleName: o.saleName };
            const money = { tongCong: flow.tongCong(o), daThu: flow.daThu(o), conNo: flow.conNo(o) }; // tien chi ghi o dong dau cua don
            const lines = items.filter((i) => i.orderId === o.id);
            if (!lines.length) out.push({ ...base, ...money, tenMach: o.tenMach, soLuongPCB: o.soLuongPCB, soLuongLK: o.soLuongLK, soLuongGiaCong: o.soLuongGiaCong });
            lines.forEach((l, i) => out.push({ ...base, ...(i ? {} : money), tenMach: l.tenMach, soLuongPCB: l.soLuongPCB, soLuongLK: l.soLuongLK, soLuongGiaCong: l.soLuongGiaCong }));
        }
        return out;
    },
    plan: async (records, ctx, req) => {
        const groups = new Map(), tasks = [];
        for (const r of records) {
            try {
                const cust = await findCustomer(ctx, need(r, 'maKH', 'khách hàng'));
                if (!cust) throw badRequest(`không tìm thấy khách hàng "${str(r.maKH)}" (nhập danh sách Khách hàng trước)`);
                const tenMach = need(r, 'tenMach', 'tên mạch / nội dung');
                const key = given(r, 'nhom') ? norm(r.nhom) : `row${r._row}`;
                if (!groups.has(key)) groups.set(key, { cust, first: r, rows: [], items: [] });
                const g = groups.get(key);
                if (g.cust.maKH !== cust.maKH) throw badRequest(`nhóm đơn "${str(r.nhom)}" có 2 khách hàng khác nhau`);
                g.rows.push(r._row);
                g.items.push({ tenMach, soLuongPCB: Math.round(toNum(r.soLuongPCB)), soLuongLK: Math.round(toNum(r.soLuongLK)), soLuongGiaCong: Math.round(toNum(r.soLuongGiaCong)) });
            } catch (e) { tasks.push({ rows: [r._row], action: 'error', error: e.message }); }
        }
        for (const g of groups.values()) {
            const f = g.first, rnd = isRndText(f.loaiDV);
            if (!rnd && g.items.some((i) => i.soLuongPCB + i.soLuongLK + i.soLuongGiaCong <= 0)) { tasks.push({ rows: g.rows, action: 'error', error: 'đơn SX cần số lượng PCB, linh kiện hoặc sản xuất lớn hơn 0' }); continue; }
            const body = { loaiDV: rnd ? 'rnd' : 'sx', maKH: g.cust.maKH, ngayTao: toDate(f.ngayTao) || undefined, ngayBanGiao: toDate(f.ngayBanGiao) || null, vat: toNum(f.vat),
                noteDH: [str(f.noteDH), given(f, 'nhom') ? `Mã cũ: ${str(f.nhom)}` : ''].filter(Boolean).join(' · '), ...(rnd ? { tenMach: g.items.map((i) => i.tenMach).join(', ') } : { items: g.items }) };
            tasks.push({ rows: g.rows, action: 'new', label: `Đơn ${rnd ? 'R&D' : 'SX'} · ${g.cust.maKH} · ${rnd ? body.tenMach : g.items.length + ' loại mạch'}`,
                run: async () => { const res = await internal(orderController.saveOrder, req, body); return res.maDH ? `→ ${res.maDH}` : ''; } });
        }
        return tasks;
    }
};

// ---------- API ----------
const can = (req, e, mode) => hasRole(req.session.user, e[mode]);
function entityOf(req, key, mode) {
    const e = ENTITIES[key];
    if (!e) throw badRequest('Danh sách không hợp lệ.');
    if (!can(req, e, mode)) throw forbidden(`Bạn không có quyền ${mode === 'write' ? 'nhập' : 'xuất'} danh sách "${e.label}".`);
    return e;
}
const publicFields = (e) => e.fields.map((f) => ({ key: f.key, label: f.label, required: !!f.required }));

// GET /api/io/entities -> cac danh sach tai khoan nay duoc xuat / nhap
exports.entities = async (req, res) => {
    res.json(Object.entries(ENTITIES).filter(([, e]) => can(req, e, 'read') || can(req, e, 'write'))
        .map(([key, e]) => ({ key, label: e.label, keyNote: e.keyNote, canRead: can(req, e, 'read'), canWrite: can(req, e, 'write'), fields: publicFields(e) })));
};

// GET /api/io/export/:entity?format=xlsx|txt&template=1
exports.exportData = async (req, res) => {
    const key = req.params.entity;
    const template = req.query.template === '1';
    const e = entityOf(req, key, template && ENTITIES[key] && can(req, ENTITIES[key], 'write') ? 'write' : 'read');
    const fields = [...e.fields, ...(template ? [] : e.exportFields || [])];
    const data = template ? [] : await e.rows(req);
    const aoa = [fields.map((f) => f.label), ...data.map((r) => fields.map((f) => (r[f.key] === null || r[f.key] === undefined ? '' : r[f.key])))];
    const name = `${template ? 'Mau' : 'Xuat'}_${key}_${new Date().toISOString().slice(0, 10)}`;
    if (req.query.format === 'txt') {
        const clean = (v) => String(v).replace(/[\t\r\n]+/g, ' ');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=${name}.txt`);
        return res.send('﻿' + aoa.map((r) => r.map(clean).join('\t')).join('\r\n'));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = fields.map((f, i) => ({ wch: Math.min(45, Math.max(f.label.length + 2, ...aoa.slice(1, 200).map((r) => String(r[i]).length + 1))) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Du lieu');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${name}.xlsx`);
    res.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
};

// POST /api/io/parse (file, entity, sheet) -> tieu de cot, goi y ghep truong, vai dong xem truoc
exports.parse = async (req, res) => {
    const e = entityOf(req, req.body.entity, 'write');
    if (!req.file) throw badRequest('Chưa chọn file.');
    const { rows, sheets } = readTable(req.file, req.body.sheet);
    if (rows.length < 2) throw badRequest('File không có dữ liệu (cần 1 dòng tiêu đề và ít nhất 1 dòng dữ liệu).');
    const d = detect(e, rows);
    const show = (c) => (c instanceof Date ? toDate(c) : c);
    res.json({ success: true, sheets, headerRow: d.headerRow, headers: d.headers, mapping: d.mapping, total: rows.length - d.headerRow - 1, sample: rows.slice(d.headerRow + 1, d.headerRow + 6).map((r) => r.map(show)) });
};

// POST /api/io/import (file, entity, sheet, headerRow, mapping JSON {truong: so cot}, update, dryRun, productId, note)
exports.importData = async (req, res) => {
    const e = entityOf(req, req.body.entity, 'write');
    if (!req.file) throw badRequest('Chưa chọn file.');
    const mapping = parseJson(req.body.mapping, {});
    const missing = e.fields.filter((f) => f.required && !(Number(mapping[f.key]) >= 0) && !(req.body.entity === 'vip-bom' && f.key === 'maKH'));
    if (missing.length) throw badRequest(`Chưa ghép cột cho trường bắt buộc: ${missing.map((f) => f.label).join(', ')}.`);
    const { rows } = readTable(req.file, req.body.sheet);
    const headerRow = Math.max(0, Number(req.body.headerRow) || 0);
    const body = rows.slice(headerRow + 1);
    if (body.length > MAX_ROWS) throw badRequest(`File có ${body.length} dòng, mỗi lần nhập tối đa ${MAX_ROWS} dòng. Hãy tách file.`);
    const records = body.map((r, i) => {
        const rec = { _row: headerRow + 2 + i };
        for (const f of e.fields) { const c = mapping[f.key]; if (c !== undefined && c !== null && c !== '' && Number(c) >= 0) rec[f.key] = r[Number(c)] === undefined ? '' : r[Number(c)]; }
        return rec;
    });
    const dryRun = req.body.dryRun === '1';
    const opt = { update: req.body.update === '1', productId: Number(req.body.productId) || 0, note: req.body.note };
    const tasks = await e.plan(records, { fileName: req.file.originalname, user: userName(req) }, req, opt);
    const count = { new: 0, update: 0, skip: 0, error: 0 };
    const results = [];
    for (const t of tasks) {
        let info = '';
        if (t.action !== 'error' && t.action !== 'skip' && !dryRun) {
            try { const r = await t.run(); if (typeof r === 'string') info = r; } catch (err) { t.action = 'error'; t.error = err.message; }
        }
        count[t.action] += 1;
        results.push({ rows: t.rows.length > 3 ? `${t.rows[0]}–${t.rows[t.rows.length - 1]}` : t.rows.join(', '), first: t.rows[0], action: t.action, label: [t.label, info].filter(Boolean).join(' '), error: t.error || '' });
    }
    results.sort((a, b) => (a.action === 'error' ? 0 : 1) - (b.action === 'error' ? 0 : 1) || a.first - b.first);
    res.json({ success: true, dryRun, count, total: records.length, results: results.slice(0, 500) });
};

// POST /api/io/preview-bom (file, sheet, headerRow, mapping, maKH) -> doc file BOM, do voi kho, TRA VE cac dong BOM (khong ghi gi).
// Dung ngay trong form ma mach VIP: nguoi dung xem lai bang BOM roi moi bam luu.
exports.previewBom = async (req, res) => {
    const e = entityOf(req, 'vip-bom', 'write');
    if (!req.file) throw badRequest('Chưa chọn file.');
    const mapping = parseJson(req.body.mapping, {});
    for (const k of ['linhKien', 'perSet']) if (!(Number(mapping[k]) >= 0) || mapping[k] === '' || mapping[k] === null) throw badRequest(`Chưa ghép cột cho "${e.fields.find((f) => f.key === k).label}".`);
    const { rows } = readTable(req.file, req.body.sheet);
    const headerRow = Math.max(0, Number(req.body.headerRow) || 0);
    const inv = await db.allAsync('SELECT * FROM inventory');
    const index = buildIndex(inv, await db.allAsync('SELECT * FROM inventory_aliases'));
    const byCode = new Map(inv.map((i) => [norm(i.itemCode), i]));
    const byId = new Map(inv.map((i) => [i.id, i]));
    const col = (r, k) => (mapping[k] === undefined || mapping[k] === null || mapping[k] === '' ? '' : r[Number(mapping[k])]);
    const lines = [], errors = [];
    rows.slice(headerRow + 1, headerRow + 1 + MAX_ROWS).forEach((r, i) => {
        const name = str(col(r, 'linhKien')) || str(col(r, 'maHang')) || str(col(r, 'mpn'));
        const perSet = toNum(col(r, 'perSet'));
        if (!name && !perSet) return; // dong trong / dong tong
        if (!name) return errors.push(`Dòng ${headerRow + 2 + i}: thiếu tên / mã linh kiện`);
        if (!(perSet > 0)) return errors.push(`Dòng ${headerRow + 2 + i} (${name}): định mức phải lớn hơn 0`);
        let item = byCode.get(norm(col(r, 'maHang'))) || byCode.get(norm(col(r, 'mpn'))) || byCode.get(norm(col(r, 'linhKien'))) || null;
        if (!item) { const c = matchRow({ name, mpn: str(col(r, 'mpn')), package: str(col(r, 'package')) }, index, str(req.body.maKH)).candidates[0]; if (c && c.score >= 96) item = byId.get(c.itemId); }
        const same = lines.find((l) => (item ? l.itemId === item.id : !l.itemId && norm(l.name) === norm(name)));
        if (same) { same.perSet += perSet; return; }
        const price = str(col(r, 'buyPrice')) !== '' ? toNum(col(r, 'buyPrice')) : (item ? Math.round(toNum(item.unitCost)) : 0);
        lines.push({ itemId: item ? item.id : null, name: item ? `${item.itemCode} - ${item.itemName}` : name, perSet, buyPrice: price, supplier: str(col(r, 'supplier')), khachCap: yes(col(r, 'khachCap')) });
    });
    if (!lines.length) throw badRequest(errors[0] || 'Không đọc được dòng BOM nào. Kiểm tra lại cột đã ghép.');
    res.json({ success: true, lines, errors: errors.slice(0, 30), matched: lines.filter((l) => l.itemId).length });
};

// Doc 1 file bang bat ky theo danh sach truong cho truoc (dung cho cac cong cu upload khac): tra tieu de, goi y ghep cot va cac dong da ghep.
exports.readMapped = (file, fields, sheet, mapping, headerRowIn) => {
    const { rows, sheets } = readTable(file, sheet);
    if (rows.length < 2) throw badRequest('File không có dữ liệu (cần 1 dòng tiêu đề và ít nhất 1 dòng dữ liệu).');
    const d = detect({ fields }, rows);
    const headerRow = mapping && headerRowIn !== undefined && headerRowIn !== '' ? Math.max(0, Number(headerRowIn) || 0) : d.headerRow;
    const map = mapping || d.mapping;
    const body = rows.slice(headerRow + 1, headerRow + 1 + MAX_ROWS);
    const records = body.map((r, i) => {
        const rec = { _row: headerRow + 2 + i };
        for (const f of fields) { const c = map[f.key]; if (c !== undefined && c !== null && c !== '' && Number(c) >= 0) rec[f.key] = r[Number(c)] instanceof Date ? toDate(r[Number(c)]) : (r[Number(c)] === undefined ? '' : r[Number(c)]); }
        return rec;
    });
    return { sheets, headerRow, headers: (rows[headerRow] || []).map((h, i) => str(h) || `Cột ${i + 1}`), mapping: map, records, sample: body.slice(0, 3) };
};
