// DIEU PHOI SAN XUAT: co nhieu xuong nho; Quan ly san xuat giao tung loai mach cua don da chot cho 1 xuong.
// Tai khoan xuong (vai tro "Xuong san xuat", gan voi 1 xuong) CHI thay viec da giao cho xuong minh,
// va khong thay gia, khach hang hay cac phan khac cua he thong (xem buc tuong trong app.js).
const db = require('../models/database');
const { ROLES, PERMS } = require('../config');
const { hasRole } = require('../middlewares/authMiddleware');
const { sendGoogleChatMsg, ensureDeptFolder } = require('../utils/googleHelper');
const materials = require('../utils/materials');
const { toNum, today, userName, badRequest, notFound, forbidden, conflict } = require('../utils/http');

const STATUSES = ['Đã giao xưởng', 'Đang sản xuất', 'Tạm dừng', 'Hoàn thành'];
const DONE = 'Hoàn thành';
const isManager = (req) => hasRole(req.session.user, [ROLES.QLSX]);
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);

const DISPATCH_SQL = `
    SELECT d.*, w.name AS workshopName, o.maDH, o.ngayBanGiao, o.ghiChuKyThuat, o.inputFolderId, o.outputFolderId, o.deptFolders, o.loaiDV, o.folderId, o.ttQuyTrinh,
           l.tenMach, l.soLuongGiaCong, l.soLuongLK, l.kitAt, l.kitCode, l.ghiChu AS lineNote, c.tenKH
    FROM dispatches d
    JOIN orders o ON o.id = d.orderId
    JOIN order_items l ON l.id = d.lineId
    LEFT JOIN workshops w ON w.id = d.workshopId
    LEFT JOIN customers c ON c.maKH = o.maKH`;
const late = (d) => !!(d.status !== DONE && d.expectedDate && d.expectedDate < today());

// GET /api/dispatch/board  (Quan ly san xuat)
exports.board = async (req, res) => {
    const workshops = await db.allAsync('SELECT * FROM workshops ORDER BY status DESC, name');
    const dispatches = (await db.allAsync(`${DISPATCH_SQL} WHERE COALESCE(o.ttQuyTrinh, '') != 'Hủy đơn' ORDER BY d.id DESC`)).map((d) => ({ ...d, late: late(d) }));
    // Loai mach co san xuat cua don da chot, chua giao xuong nao
    const pending = await db.allAsync(`
        SELECT l.id AS lineId, l.orderId, l.tenMach, l.soLuongGiaCong, l.soLuongLK, l.kitAt, o.maDH, o.ngayChot, o.ngayBanGiao, c.tenKH
        FROM order_items l JOIN orders o ON o.id = l.orderId LEFT JOIN customers c ON c.maKH = o.maKH
        WHERE o.loaiDV = 'sx' AND o.ttChotDon = 'Đã chốt' AND COALESCE(o.ttQuyTrinh, '') NOT IN ('Hủy đơn', 'Hoàn thành') AND COALESCE(o.ttDonHang, '') != 'Hoàn thành'
          AND l.soLuongGiaCong > 0 AND NOT EXISTS (SELECT 1 FROM dispatches d WHERE d.lineId = l.id)
        ORDER BY COALESCE(o.ngayBanGiao, '9999'), o.id`);
    // Tinh trang vat tu (PCB, linh kien, stencil) cua tung loai mach
    const lineIds = [...new Set([...pending.map((p) => p.lineId), ...dispatches.map((d) => d.lineId)])];
    const boards = lineIds.length ? await db.allAsync(`SELECT * FROM order_items WHERE id IN (${lineIds.map(() => '?').join(', ')})`, lineIds) : [];
    const mats = await materials.forBoards(boards);
    for (const x of [...pending, ...dispatches]) x.mat = mats.get(x.lineId) || null;
    const users = await db.allAsync('SELECT name, username, workshopId FROM users WHERE workshopId IS NOT NULL AND status = 1');
    res.json({
        workshops: workshops.map((w) => {
            const mine = dispatches.filter((d) => d.workshopId === w.id);
            const open = mine.filter((d) => d.status !== DONE);
            return { ...w, open: open.length, openQty: open.reduce((s, d) => s + toNum(d.quantity), 0), lateCount: open.filter((d) => d.late).length, done: mine.length - open.length, accounts: users.filter((u) => u.workshopId === w.id).map((u) => u.name) };
        }),
        pending, dispatches, statuses: STATUSES, khachStatuses: materials.KHACH_STATUSES, stencilStatuses: materials.STENCIL_STATUSES, canMaterials: hasRole(req.session.user, PERMS.MATERIALS)
    });
};

// PATCH /api/dispatch/materials/:lineId  { pcbKhach, lkKhach, stencil, note }  -> tinh trang vat tu nhap tay cua 1 loai mach
exports.saveMaterials = async (req, res) => {
    const line = await db.getAsync('SELECT id, materials FROM order_items WHERE id = ?', [req.params.lineId]);
    if (!line) throw notFound('Không tìm thấy loại mạch.');
    let cur = {};
    try { cur = JSON.parse(line.materials || '{}') || {}; } catch (e) { cur = {}; }
    for (const k of ['pcbKhach', 'lkKhach']) if (req.body[k] !== undefined) { if (!materials.KHACH_STATUSES.includes(req.body[k])) throw badRequest('Trạng thái không hợp lệ.'); cur[k] = req.body[k]; }
    if (req.body.stencil !== undefined) { if (!materials.STENCIL_STATUSES.includes(req.body.stencil)) throw badRequest('Trạng thái stencil không hợp lệ.'); cur.stencil = req.body.stencil; }
    if (req.body.note !== undefined) cur.note = String(req.body.note || '').trim().slice(0, 300);
    cur.updatedBy = userName(req); cur.updatedAt = new Date().toISOString();
    await db.runAsync('UPDATE order_items SET materials = ? WHERE id = ?', [JSON.stringify(cur), line.id]);
    res.json({ success: true });
};

// POST /api/dispatch/workshops/save
exports.saveWorkshop = async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) throw badRequest('Vui lòng nhập tên xưởng.');
    const f = ['address', 'contact', 'phone', 'capability', 'note'].map((k) => String(req.body[k] || '').trim().slice(0, 300));
    const status = req.body.status === false || req.body.status === 0 || req.body.status === '0' ? 0 : 1;
    if (await db.getAsync('SELECT id FROM workshops WHERE LOWER(name) = LOWER(?) AND id != ?', [name, req.body.id || 0])) throw conflict('Tên xưởng đã tồn tại.');
    if (req.body.id) {
        const r = await db.runAsync('UPDATE workshops SET name=?, address=?, contact=?, phone=?, capability=?, note=?, status=? WHERE id=?', [name, ...f, status, req.body.id]);
        if (!r.changes) throw notFound('Không tìm thấy xưởng.');
        return res.json({ success: true, id: Number(req.body.id) });
    }
    const r = await db.runAsync('INSERT INTO workshops (name, address, contact, phone, capability, note, status, createdAt) VALUES (?,?,?,?,?,?,?,?)', [name, ...f, status, new Date().toISOString()]);
    res.json({ success: true, id: r.lastID });
};

// POST /api/dispatch/assign  { lineId, workshopId, expectedDate, note }  -> giao moi hoac chuyen xuong
exports.assign = async (req, res) => {
    const line = await db.getAsync(`SELECT l.*, o.maDH, o.ttChotDon, o.ttQuyTrinh, o.loaiDV FROM order_items l JOIN orders o ON o.id = l.orderId WHERE l.id = ?`, [req.body.lineId]);
    if (!line) throw notFound('Không tìm thấy loại mạch.');
    if (line.loaiDV !== 'sx' || line.ttChotDon !== 'Đã chốt' || line.ttQuyTrinh === 'Hủy đơn') throw badRequest('Chỉ điều phối đơn đã chốt.');
    if (!(toNum(line.soLuongGiaCong) > 0)) throw badRequest('Loại mạch này không có hạng mục sản xuất.');
    const ws = await db.getAsync('SELECT * FROM workshops WHERE id = ? AND status = 1', [req.body.workshopId]);
    if (!ws) throw badRequest('Xưởng không tồn tại hoặc đã ngừng hoạt động.');
    const user = userName(req), now = new Date().toISOString();
    const expectedDate = dateOrNull(req.body.expectedDate), note = String(req.body.note || '').trim().slice(0, 500);
    const cur = await db.getAsync('SELECT * FROM dispatches WHERE lineId = ?', [line.id]);
    if (cur) {
        if (cur.status === DONE) throw conflict('Loại mạch này xưởng đã làm xong, không chuyển xưởng được.');
        const moved = cur.workshopId !== ws.id;
        await db.runAsync(`UPDATE dispatches SET workshopId = ?, expectedDate = ?, note = ?, assignedBy = ?, assignedAt = ?${moved ? ", status = 'Đã giao xưởng', progress = 0, doneQty = 0, workshopNote = NULL" : ''} WHERE id = ?`,
            [ws.id, expectedDate, note, user, now, cur.id]);
        if (moved) sendGoogleChatMsg(line.maDH, user, `Chuyển sản xuất [${line.tenMach}] sang ${ws.name}`);
        return res.json({ success: true, id: cur.id, moved });
    }
    const r = await db.runAsync(`INSERT INTO dispatches (orderId, lineId, workshopId, quantity, status, progress, doneQty, expectedDate, note, assignedBy, assignedAt) VALUES (?,?,?,?,'Đã giao xưởng',0,0,?,?,?,?)`,
        [line.orderId, line.id, ws.id, toNum(line.soLuongGiaCong), expectedDate, note, user, now]);
    sendGoogleChatMsg(line.maDH, user, `Điều phối sản xuất [${line.tenMach}] × ${line.soLuongGiaCong} cho ${ws.name}${expectedDate ? `, hạn ${expectedDate}` : ''}`);
    res.json({ success: true, id: r.lastID });
};

// DELETE /api/dispatch/assign/:id  -> thu hoi (chi khi xuong chua bat dau)
exports.unassign = async (req, res) => {
    const cur = await db.getAsync('SELECT * FROM dispatches WHERE id = ?', [req.params.id]);
    if (!cur) throw notFound('Không tìm thấy phiếu điều phối.');
    if (cur.status !== 'Đã giao xưởng') throw conflict('Xưởng đã bắt đầu làm, không thu hồi được. Hãy chuyển xưởng nếu cần.');
    await db.runAsync('DELETE FROM dispatches WHERE id = ?', [cur.id]);
    res.json({ success: true });
};

// Tai khoan xuong chi lay viec cua xuong minh; QLSX / Admin xem duoc moi xuong (?workshopId)
function scopeWorkshop(req) {
    if (isManager(req)) return req.query.workshopId ? Number(req.query.workshopId) : null;
    const id = Number(req.session.user.workshopId);
    if (!id) throw forbidden('Tài khoản chưa được gán vào xưởng nào. Liên hệ Quản lý sản xuất.');
    return id;
}
// Thong tin xuong duoc thay: KHONG co gia, KHONG co ten khach hang
const forWorkshop = (d) => ({
    id: d.id, maDH: d.maDH, tenMach: d.tenMach, quantity: d.quantity, status: d.status, progress: d.progress, doneQty: d.doneQty,
    expectedDate: d.expectedDate, late: late(d), note: d.note, workshopNote: d.workshopNote, assignedBy: d.assignedBy, assignedAt: d.assignedAt, completedAt: d.completedAt,
    workshopId: d.workshopId, workshopName: d.workshopName, ghiChuKyThuat: d.ghiChuKyThuat, lineNote: d.lineNote,
    mat: d.mat ? { pcb: d.mat.pcb, lk: d.mat.lk, stencil: d.mat.stencil, ready: d.mat.ready, note: d.mat.note } : null,
    kitReady: d.mat ? d.mat.ready : (!!d.kitAt || !(toNum(d.soLuongLK) > 0)), kitAt: d.kitAt, kitCode: d.kitCode, hasInput: !!(d.inputFolderId || d.folderId), hasOutput: !!d.outputFolderId
});

// GET /api/dispatch/mine
exports.mine = async (req, res) => {
    const wsId = scopeWorkshop(req);
    const rows = await db.allAsync(`${DISPATCH_SQL} WHERE COALESCE(o.ttQuyTrinh, '') != 'Hủy đơn' ${wsId ? 'AND d.workshopId = ?' : ''} ORDER BY (d.status = 'Hoàn thành'), COALESCE(d.expectedDate, '9999'), d.id DESC`, wsId ? [wsId] : []);
    const ids = rows.map((r) => r.lineId);
    const mats = await materials.forBoards(ids.length ? await db.allAsync(`SELECT * FROM order_items WHERE id IN (${ids.map(() => '?').join(', ')})`, ids) : []);
    for (const r of rows) r.mat = mats.get(r.lineId) || null;
    const ws = wsId ? await db.getAsync('SELECT id, name FROM workshops WHERE id = ?', [wsId]) : null;
    res.json({ workshop: ws, list: rows.map(forWorkshop), statuses: STATUSES, isManager: isManager(req) });
};

// GET /api/dispatch/mine/:id/folder/:key   key = input (yeu cau cua khach) | sanxuat (thu muc cua bo phan san xuat)
exports.openFolder = async (req, res) => {
    const cur = await db.getAsync(`${DISPATCH_SQL} WHERE d.id = ?`, [req.params.id]);
    if (!cur) throw notFound('Không tìm thấy việc được giao.');
    if (!isManager(req) && Number(req.session.user.workshopId) !== cur.workshopId) throw forbidden('Việc này không thuộc xưởng của bạn.');
    const order = { id: cur.orderId, loaiDV: cur.loaiDV, inputFolderId: cur.inputFolderId, outputFolderId: cur.outputFolderId, deptFolders: cur.deptFolders };
    // xuong chi mo 2 thu muc: INPUT/SMT (yeu cau, file SMT cua khach) va OUTPUT/San xuat
    const id = req.params.key === 'sanxuat' ? await ensureDeptFolder(order, 'sanxuat') : ((await ensureDeptFolder(order, 'in-smt')) || cur.inputFolderId || cur.folderId);
    if (req.query.info) return res.json({ success: !!id, url: id ? `https://drive.google.com/drive/folders/${encodeURIComponent(id)}` : null, relPath: null }); // xuong ngoai: chi mo ban web
    if (!id) return res.status(404).send('<meta charset="utf-8"><body style="font-family:Arial;padding:40px">Đơn này chưa có thư mục trên Google Drive.</body>');
    res.redirect(`https://drive.google.com/drive/folders/${encodeURIComponent(id)}`);
};

// PATCH /api/dispatch/mine/:id  { status, progress, doneQty, workshopNote }
exports.updateMine = async (req, res) => {
    const cur = await db.getAsync(`${DISPATCH_SQL} WHERE d.id = ?`, [req.params.id]);
    if (!cur) throw notFound('Không tìm thấy việc được giao.');
    if (!isManager(req) && Number(req.session.user.workshopId) !== cur.workshopId) throw forbidden('Việc này không thuộc xưởng của bạn.');
    if (cur.ttQuyTrinh === 'Hủy đơn') throw conflict('Đơn đã hủy.');
    if (cur.status === DONE && !isManager(req)) throw conflict('Việc đã báo hoàn thành. Cần sửa thì liên hệ Quản lý sản xuất.');
    const status = req.body.status === undefined ? cur.status : String(req.body.status);
    if (!STATUSES.includes(status)) throw badRequest('Trạng thái không hợp lệ.');
    let doneQty = req.body.doneQty === undefined ? toNum(cur.doneQty) : Math.round(toNum(req.body.doneQty));
    if (doneQty < 0 || doneQty > toNum(cur.quantity)) throw badRequest(`Số lượng đã làm phải từ 0 đến ${cur.quantity}.`);
    if (status === DONE) doneQty = toNum(cur.quantity);
    const progress = status === DONE ? 100 : (cur.quantity > 0 ? Math.round(doneQty / cur.quantity * 100) : 0);
    const user = userName(req), now = new Date().toISOString();
    await db.runAsync('UPDATE dispatches SET status = ?, progress = ?, doneQty = ?, workshopNote = ?, updatedBy = ?, updatedAt = ?, completedAt = ? WHERE id = ?',
        [status, progress, doneQty, req.body.workshopNote === undefined ? cur.workshopNote : String(req.body.workshopNote || '').trim().slice(0, 500), user, now, status === DONE ? (cur.completedAt || now) : null, cur.id]);
    if (status !== cur.status) sendGoogleChatMsg(cur.maDH, user, `${cur.workshopName}: [${cur.tenMach}] ${status}${status === DONE ? '' : ` (${doneQty}/${cur.quantity})`}`);
    res.json({ success: true, progress, doneQty });
};
