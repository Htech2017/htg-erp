const db = require('../models/database');
const { ROLES, ALL_ROLES } = require('../config');
const { hasRole } = require('../middlewares/authMiddleware');
const { parseJson, badRequest, notFound, conflict } = require('../utils/http');
const { hashPassword } = require('../utils/password');

const MIN_PASSWORD = 6;

// Con it nhat 1 Admin dang hoat dong ngoai tai khoan `exceptId`?
async function hasOtherActiveAdmin(exceptId) {
    const rows = await db.allAsync('SELECT id, roles FROM users WHERE status = 1 AND id != ?', [exceptId || 0]);
    return rows.some((u) => parseJson(u.roles, []).includes(ROLES.ADMIN));
}

exports.getUsers = async (req, res) => {
    const rows = await db.allAsync('SELECT id, code, name, username, phone, email, status, roles, workshopId, brandId FROM users ORDER BY code ASC');
    const isAdmin = hasRole(req.session.user, []);
    res.json(rows.map((r) => {
        const roles = parseJson(r.roles, []);
        // Khong bao gio tra mat khau. Tai khoan khong phai Admin chi thay thong tin toi thieu.
        return isAdmin ? { ...r, roles } : { id: r.id, code: r.code, name: r.name, roles, status: r.status };
    }));
};

exports.saveUser = async (req, res) => {
    const { id, code, phone, email, status } = req.body;
    const name = String(req.body.name || '').trim();
    const username = String(req.body.username || '').trim();
    const password = req.body.password ? String(req.body.password) : '';
    const roles = Array.isArray(req.body.roles) ? req.body.roles.filter((r) => ALL_ROLES.includes(r)) : [];
    const active = status ? 1 : 0;
    // Tai khoan xuong phai thuoc 1 xuong; vai tro khac khong gan xuong
    const workshopId = roles.includes(ROLES.XUONG) ? (Number(req.body.workshopId) || null) : null;
    if (roles.includes(ROLES.XUONG) && !(workshopId && await db.getAsync('SELECT id FROM workshops WHERE id = ?', [workshopId]))) throw badRequest('Tài khoản xưởng cần chọn xưởng.');

    if (!name || !username) throw badRequest('Vui lòng nhập họ tên và tên đăng nhập.');
    if (!roles.length) throw badRequest('Vui lòng chọn ít nhất một vai trò hợp lệ.');
    if (password && password.length < MIN_PASSWORD) throw badRequest(`Mật khẩu phải có ít nhất ${MIN_PASSWORD} ký tự.`);

    const dup = await db.getAsync('SELECT id FROM users WHERE username = ? AND id != ?', [username, id || 0]);
    if (dup) throw conflict('Tên đăng nhập đã tồn tại.');

    if (id) {
        const current = await db.getAsync('SELECT id FROM users WHERE id = ?', [id]);
        if (!current) throw notFound('Không tìm thấy tài khoản.');

        const stillAdmin = active === 1 && roles.includes(ROLES.ADMIN);
        if (!stillAdmin && !(await hasOtherActiveAdmin(id))) {
            throw badRequest('Hệ thống phải còn ít nhất một tài khoản Admin đang hoạt động.');
        }

        if (password) {
            await db.runAsync('UPDATE users SET name=?, username=?, password=?, phone=?, email=?, roles=?, status=? WHERE id=?',
                [name, username, hashPassword(password), phone, email, JSON.stringify(roles), active, id]);
        } else {
            await db.runAsync('UPDATE users SET name=?, username=?, phone=?, email=?, roles=?, status=? WHERE id=?',
                [name, username, phone, email, JSON.stringify(roles), active, id]);
        }
        // Buoc tai khoan nay dang nhap lai de quyen / mat khau moi co hieu luc ngay (tru chinh nguoi dang sua).
        await db.runAsync('UPDATE users SET workshopId = ?, brandId = ? WHERE id = ?', [workshopId, Number(req.body.brandId) || null, id]);
        if (Number(id) !== Number(req.session.user.id)) await db.runAsync('DELETE FROM sessions WHERE uid = ?', [id]);
        return res.json({ success: true });
    }

    if (!password) throw badRequest('Vui lòng nhập mật khẩu cho tài khoản mới.');
    const result = await db.runAsync(
        'INSERT INTO users (code, name, username, password, phone, email, roles, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [code, name, username, hashPassword(password), phone, email, JSON.stringify(roles), active]);
    await db.runAsync('UPDATE users SET workshopId = ?, brandId = ? WHERE id = ?', [workshopId, Number(req.body.brandId) || null, result.lastID]);
    res.json({ success: true, id: result.lastID });
};

exports.deleteUser = async (req, res) => {
    const id = Number(req.params.id);
    if (id === Number(req.session.user.id)) throw badRequest('Không thể tự xóa tài khoản đang đăng nhập.');
    if (!(await hasOtherActiveAdmin(id))) throw badRequest('Hệ thống phải còn ít nhất một tài khoản Admin đang hoạt động.');

    const result = await db.runAsync('DELETE FROM users WHERE id = ?', [id]);
    if (!result.changes) throw notFound('Không tìm thấy tài khoản.');
    await db.runAsync('DELETE FROM sessions WHERE uid = ?', [id]);
    res.json({ success: true });
};

exports.getTechnicians = async (req, res) => {
    const rows = await db.allAsync("SELECT name, code FROM users WHERE roles LIKE '%Thiết kế%' AND status = 1 ORDER BY name ASC");
    res.json(rows);
};
