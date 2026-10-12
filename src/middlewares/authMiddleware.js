const { ROLES } = require('../config');

// Yeu cau goi tu trinh duyet (mo trang / tai file) hay tu fetch()?
function isPageRequest(req) {
    return req.method === 'GET' && !req.xhr && (req.get('accept') || '').includes('text/html');
}

function hasRole(user, roles) {
    if (!user) return false;
    const mine = Array.isArray(user.allRoles) ? user.allRoles : [];
    if (mine.includes(ROLES.ADMIN)) return true;
    if (roles === null || roles === undefined) return true; // moi tai khoan da dang nhap
    return roles.some((r) => mine.includes(r));
}

function rejectUnauthenticated(req, res) {
    if (isPageRequest(req)) return res.redirect('/login');
    return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', error: 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.' });
}

function rejectForbidden(req, res) {
    if (isPageRequest(req)) {
        return res.status(403).send(
            '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>Không có quyền</title></head>' +
            '<body style="font-family:Segoe UI,Arial,sans-serif;text-align:center;padding:80px;color:#334155">' +
            '<h2>Bạn không có quyền truy cập trang này</h2>' +
            '<p>Vui lòng liên hệ quản trị viên nếu cần được cấp quyền.</p>' +
            '<p><a href="/" style="color:#4f46e5">Về trang chủ</a></p></body></html>'
        );
    }
    return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Bạn không có quyền thực hiện thao tác này.' });
}

// Chi can dang nhap
const requireLogin = (req, res, next) => {
    if (req.session && req.session.user) return next();
    return rejectUnauthenticated(req, res);
};

// Dang nhap + co it nhat mot trong cac vai tro (Admin luon duoc phep).
// requireRole() khong tham so = chi Admin; requireRole(null) = moi tai khoan da dang nhap.
const requireRole = (...roles) => {
    const allowed = roles.length === 1 && roles[0] === null ? null : roles.flat();
    return (req, res, next) => {
        if (!req.session || !req.session.user) return rejectUnauthenticated(req, res);
        if (!hasRole(req.session.user, allowed)) return rejectForbidden(req, res);
        return next();
    };
};

// Gioi han so lan dang nhap sai: 10 lan / 15 phut cho moi cap IP + tai khoan.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;
const fails = new Map();
const failKey = (req) => `${req.ip}|${String((req.body && req.body.username) || '').toLowerCase()}`;

const loginLimiter = (req, res, next) => {
    const entry = fails.get(failKey(req));
    if (entry && entry.count >= MAX_FAILS && Date.now() - entry.first < WINDOW_MS) {
        return res.status(429).json({ success: false, error: 'Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.' });
    }
    return next();
};
const recordLoginFail = (req) => {
    const key = failKey(req);
    const now = Date.now();
    const entry = fails.get(key);
    if (!entry || now - entry.first > WINDOW_MS) fails.set(key, { count: 1, first: now });
    else entry.count += 1;
    if (fails.size > 5000) {
        for (const [k, v] of fails) if (now - v.first > WINDOW_MS) fails.delete(k);
    }
};
const clearLoginFail = (req) => fails.delete(failKey(req));

module.exports = { requireLogin, requireRole, hasRole, loginLimiter, recordLoginFail, clearLoginFail };
