const express = require('express');
const session = require('express-session');
const path = require('path');

const config = require('./src/config');
const db = require('./src/models/database');
const SqliteStore = require('./src/utils/sessionStore');
const { requireRole, hasRole } = require('./src/middlewares/authMiddleware');
const { notFoundHandler, errorHandler } = require('./src/middlewares/errorHandler');

const app = express();
app.disable('x-powered-by');
if (config.COOKIE_SECURE) app.set('trust proxy', 1); // chay sau reverse proxy HTTPS

// 1. Middleware co ban
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use(session({
    store: new SqliteStore(db),
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false, // khong tao phien cho khach chua dang nhap
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax',
        secure: config.COOKIE_SECURE
    }
}));

// Bien dung chung cho EJS
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    // Duong dan thu muc goc Google Drive tren may (Admin khai bao o Cai dat he thong) -> cac nut mo thu muc dung
    require('./src/utils/googleHelper').getSetting('drive_local_root').then((v) => { res.locals.driveLocalRoot = v || ''; next(); }).catch(() => next());
});

// CHE DO DEMO (chi khi chay `npm run demo`, dung file demo.db rieng): doi nhanh tai khoan theo vai tro de xem giao dien.
// Khong bao gio bat khi chay that: `npm start` / `npm run dev` khong dat DEMO_MODE.
if (config.DEMO_MODE) {
    const { DEMO_ACCOUNTS } = require('./scripts/demo-accounts');
    app.use((req, res, next) => { res.locals.demoAccounts = DEMO_ACCOUNTS; next(); });
    app.get('/demo/as/:username', async (req, res) => {
        const acc = DEMO_ACCOUNTS.find((a) => a.username === req.params.username);
        const user = acc && await db.getAsync('SELECT * FROM users WHERE username = ? AND status = 1', [acc.username]);
        if (!user) return res.status(404).send('Khong co tai khoan demo nay');
        const roles = JSON.parse(user.roles || '[]');
        req.session.regenerate(() => {
            req.session.user = { id: user.id, name: user.name, username: user.username, role: roles[0] || '', allRoles: roles, workshopId: user.workshopId || null, brandId: user.brandId || null };
            req.session.save(() => res.redirect(acc.home || '/'));
        });
    });
}

// BUC TUONG CHO TAI KHOAN XUONG: tai khoan chi co vai tro "Xuong san xuat" (xuong ngoai) chi vao duoc trang cua xuong
// va API viec cua xuong; moi duong dan khac (bang dieu khien, danh sach nhan vien, don hang...) deu bi chan.
app.use((req, res, next) => {
    const u = req.session.user;
    if (!u || !Array.isArray(u.allRoles) || !u.allRoles.length || !u.allRoles.every((r) => r === config.ROLES.XUONG)) return next();
    const p = req.path;
    if (p === '/xuong' || p.startsWith('/api/dispatch/mine') || p === '/logout' || p === '/login' || p.startsWith('/demo/as/')) return next();
    if (p.startsWith('/api/')) return res.status(403).json({ success: false, code: 'FORBIDDEN', error: 'Tài khoản xưởng không có quyền này.' });
    res.redirect('/xuong');
});

// 2. API
app.use('/', require('./src/routes/authRoutes'));
app.use('/api/customers', require('./src/routes/customerRoutes'));
app.use('/api/orders', require('./src/routes/orderRoutes'));
app.use('/api/design-jobs', require('./src/routes/designRoutes'));
app.use('/api/users', require('./src/routes/userRoutes'));
app.use('/api/fund', require('./src/routes/fundRoutes'));
app.use('/api/projects', require('./src/routes/projectRoutes'));
app.use('/api/settings', require('./src/routes/settingRoutes'));
app.use('/api/reports', require('./src/routes/reportRoutes'));
app.use('/api/dashboard', require('./src/routes/dashBoardRoutes'));
app.use('/api/purchase', require('./src/routes/purchaseRoutes'));
app.use('/api/buying', require('./src/routes/buyingRoutes'));
app.use('/api/dispatch', require('./src/routes/dispatchRoutes'));
app.use('/api/vip', require('./src/routes/vipRoutes'));
app.use('/api/io', require('./src/routes/dataIoRoutes'));
app.use('/api/delivery', require('./src/routes/deliveryRoutes'));
app.use('/api/hanh-chinh', require('./src/routes/adminDocRoutes'));
app.use('/api/inventory', require('./src/routes/inventoryRoutes'));
app.use('/api/production', require('./src/routes/productionRoutes'));

// 3. Trang giao dien: quyen truy cap khai bao tap trung trong src/config.js (PAGES)
for (const [url, page] of Object.entries(config.PAGES)) {
    const guard = page.roles === null ? requireRole(null) : requireRole(page.roles);
    app.get(url, guard, (req, res) => res.render(`pages/${page.view}`, page.locals || {}));
}

// Duong dan cu /don-hang -> trang don hang dau tien ma tai khoan co quyen (giu nguyen tham so ?quaHan, ?addFor...)
app.get('/don-hang', requireRole(null), (req, res) => {
    const first = ['/don-hang/san-xuat', '/don-hang/rnd'].find((url) => hasRole(req.session.user, config.PAGES[url].roles));
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    res.redirect(first ? first + qs : '/');
});

// Duong dan cu /bao-gia -> chuyen toi trang bao gia dau tien ma tai khoan co quyen
app.get('/bao-gia', requireRole(null), (req, res) => {
    const first = Object.entries(config.PAGES).find(([url, page]) => url.startsWith('/bao-gia/') && hasRole(req.session.user, page.roles));
    res.redirect(first ? first[0] : '/');
});

// 4. 404 + xu ly loi tap trung
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;

// 5. Chi mo cong khi Database da san sang
db.ready
    .then(() => {
        app.listen(config.PORT, () => {
            console.log(`Server MVC is running on http://localhost:${config.PORT}`);
            app.emit('listening');
        });
    })
    .catch((err) => {
        console.error('Khong khoi tao duoc Database:', err);
        process.exit(1);
    });
