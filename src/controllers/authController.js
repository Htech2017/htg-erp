const db = require('../models/database');
const { parseJson } = require('../utils/http');
const { verifyPassword } = require('../utils/password');
const { recordLoginFail, clearLoginFail } = require('../middlewares/authMiddleware');

exports.getLoginPage = (req, res) => {
    if (req.session && req.session.user) return res.redirect('/');
    res.render('pages/login', { layout: false });
};

exports.login = async (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = req.body && req.body.password;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Vui lòng nhập tài khoản và mật khẩu!' });
    }

    const user = await db.getAsync('SELECT * FROM users WHERE username = ? AND status = 1', [username]);
    if (!user || !verifyPassword(password, user.password)) {
        recordLoginFail(req);
        return res.status(401).json({ success: false, error: 'Sai tài khoản hoặc mật khẩu!' });
    }
    clearLoginFail(req);

    const roles = parseJson(user.roles, []);
    const sessionUser = { id: user.id, name: user.name, username: user.username, role: roles[0] || '', allRoles: roles, workshopId: user.workshopId || null, brandId: user.brandId || null };

    // Tao phien moi sau khi dang nhap de tranh bi co dinh phien (session fixation)
    req.session.regenerate((err) => {
        if (err) return res.status(500).json({ success: false, error: 'Lỗi hệ thống' });
        req.session.user = sessionUser;
        req.session.save((saveErr) => {
            if (saveErr) return res.status(500).json({ success: false, error: 'Lỗi hệ thống' });
            res.json({ success: true });
        });
    });
};

exports.logout = (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
};
