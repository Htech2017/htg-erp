const session = require('express-session');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const html_to_pdf = require('html-pdf-node');

const multer = require('multer');
const upload = multer({ dest: 'uploads/' });

const { google } = require('googleapis');

// Đường dẫn tới file credentials của con bot
const KEYFILEPATH = path.join(__dirname, 'credentials.json');

// Cấu hình quyền truy cập (Scope)
const SCOPES = ['https://www.googleapis.com/auth/drive'];

// Khởi tạo Auth
const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILEPATH,
    scopes: SCOPES,
});

const drive = google.drive({ version: 'v3', auth });

const app = express();

// --- CẤU HÌNH ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true }));

// --- KẾT NỐI SQLITE ---
const db = new sqlite3.Database('./htech.db', (err) => {
    if (err) console.error("Lỗi kết nối database:", err);
    else console.log("✅ Đã kết nối Database SQLite: htech.db");
});

// --- KHỞI TẠO CÁC BẢNG (Chỉ chạy 1 lần đầu) ---
db.serialize(() => {
     
    // 1. Thương hiệu
    db.run(`CREATE TABLE IF NOT EXISTS brands (id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT, code TEXT, address TEXT, bankName TEXT, bankNo TEXT, bankOwner TEXT, logo TEXT)`);

    // 2. Khách hàng
    db.run(`CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, maKH TEXT UNIQUE, nick_name TEXT, tenKH TEXT, sdt TEXT, diaChi TEXT)`);

    // 3. Đơn hàng
    db.run(`CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, maDH TEXT, loaiDV TEXT, maKH TEXT, tenMach TEXT, ngayTao TEXT, ngayChot TEXT, leadtime INTEGER, ngayBanGiao TEXT, ttQuyTrinh TEXT, giaThietKe REAL, heSoSale REAL, vat REAL, chietKhau REAL, noteDH TEXT, giaBao REAL, tamUng REAL, dauViec TEXT)`);

    // 4. Các bảng còn lại (Thiết kế, Dự án, Sổ quỹ, Nhân sự...)
    db.run(`CREATE TABLE IF NOT EXISTS design_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, orderId INTEGER, maDH TEXT, designer TEXT, ttThietKe TEXT, version TEXT, driveLink TEXT, feedbackTK TEXT, dauViec TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, customer TEXT, leader TEXT, status TEXT, contractValue REAL, start TEXT, end TEXT, desc TEXT, tasks TEXT, payments TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS external_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, createdAt TEXT, priceRoot REAL, priceGuest REAL, psMe REAL, psCty REAL, note TEXT, payStatus TEXT, heSo REAL)`);
    db.run(`CREATE TABLE IF NOT EXISTS so_quy (id TEXT PRIMARY KEY, ngay TEXT, loai TEXT, hangMuc TEXT, tien REAL, nguoi TEXT, note TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, phone TEXT, email TEXT, status INTEGER, roles TEXT)`);
    
    db.run("CREATE TABLE IF NOT EXISTS requests_chi (id TEXT PRIMARY KEY, ngay TEXT, noiDung TEXT, tien REAL, nguoi TEXT, status TEXT)");
// Thêm cột nợ cũ nếu chưa có (Chạy đoạn này hoặc dùng DB Browser)
    console.log("🛠️ Cấu trúc các bảng đã sẵn sàng.");
});


// 1. Cấu hình Session
app.use(session({
    secret: 'htech_secret_key',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // Sống trong 24h
}));

// Thêm đoạn này vào app.js (Dưới phần app.use(session(...)))
app.use((req, res, next) => {
    // res.locals giúp biến 'user' có thể truy cập được ở mọi file .ejs
    res.locals.user = req.session.user || null; 
    next();
});

// 2. Middleware kiểm tra đăng nhập
const requireLogin = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
};


// 3. Route Đăng nhập & Đăng xuất
app.get('/login', (req, res) => {
    res.render('pages/login', { layout: false }); // Không dùng layout sidebar
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    const sql = `SELECT * FROM users WHERE username = ? AND password = ? AND status = 1`;
    
    db.get(sql, [username, password], (err, user) => {
        if (err) return res.status(500).json({ success: false, error: "Lỗi hệ thống" });
        
        if (user) {
            // Đăng nhập thành công, lưu vào session
            // Vì roles trong DB đang là chuỗi JSON, ta cần parse lại
            const userRoles = JSON.parse(user.roles);
            
            req.session.user = {
                id: user.id,
                name: user.name,
                role: userRoles[0], // Lấy quyền đầu tiên làm mặc định
                allRoles: userRoles
            };
            res.json({ success: true });
        } else {
            res.json({ success: false, error: "Sai tài khoản hoặc mật khẩu!" });
        }
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// 4. Áp dụng requireLogin cho tất cả các trang quản lý
app.get('/', requireLogin, (req, res) => res.render('pages/dashboard'));
app.get('/don-hang', requireLogin, (req, res) => res.render('pages/don-hang'));
app.get('/khach-hang', requireLogin, (req, res) => res.render('pages/khach-hang'));
app.get('/reports', requireLogin, (req, res) => res.render('pages/reports'));



// --- API CHO TRANG KHÁCH HÀNG ---

// Kiểm tra xem bạn có thiếu dấu / ở đầu hoặc sai chính tả không
app.post('/api/customers/save', (req, res) => {
    const id = req.body.id;
    const nick_name = req.body.nick_name || 'KH';
    const tenKH = req.body.tenKH || req.body.name;
    const sdt = req.body.sdt || req.body.phone || '';
    const diaChi = req.body.diaChi || req.body.address;
    const old_debt = parseFloat(req.body.old_debt) || 0;

    // TỰ TẠO MAKH: Nếu không có mã thì lấy Nickname + 4 số cuối điện thoại
    // Ví dụ: Htech_1079
    const generatedMaKH = req.body.maKH || `${nick_name.replace(/\s+/g, '')}_${sdt.slice(-4)}`;

    if (id) {
        // Cập nhật (Thêm maKH vào câu lệnh)
        const sql = `UPDATE customers SET maKH=?, nick_name=?, tenKH=?, sdt=?, diaChi=?, old_debt=? WHERE id=?`;
        const params = [generatedMaKH, nick_name, tenKH, sdt, diaChi, old_debt, id];
        
        db.run(sql, params, (err) => {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true });
        });
    } else {
        // Thêm mới (Thêm maKH vào câu lệnh)
        const sql = `INSERT INTO customers (maKH, nick_name, tenKH, sdt, diaChi, old_debt) VALUES (?, ?, ?, ?, ?, ?)`;
        const params = [generatedMaKH, nick_name, tenKH, sdt, diaChi, old_debt];
        
        db.run(sql, params, function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true, id: this.lastID });
        });
    }
});
// Lấy danh sách khách hàng
app.get('/api/customers', (req, res) => {
    // SQL nâng cao: Lấy nợ cũ + (Tổng giá báo đơn hàng - Tổng đã ứng)
    const sql = `
        SELECT 
            c.*, 
            (
                COALESCE(c.old_debt, 0) + 
                COALESCE((
                    SELECT SUM(o.giaBao - o.tamUng) 
                    FROM orders o 
                    WHERE o.maKH = c.maKH AND o.ttQuyTrinh != 'Hủy'
                ), 0)
            ) AS total_debt
        FROM customers c 
        ORDER BY c.id DESC
    `;

    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});


app.delete('/api/customers/:id', (req, res) => {
    db.run(`DELETE FROM customers WHERE id = ?`, req.params.id, (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

// --- API CHO TRANG ĐƠN HÀNG ---

// 1. Lấy danh sách đơn hàng
app.get('/api/orders', (req, res) => {
    // Chúng ta lấy kèm theo thông tin của bảng thiết kế để biết tiến độ
    const sql = `
        SELECT o.*, d.designer, d.ttThietKe 
        FROM orders o 
        LEFT JOIN design_jobs d ON o.id = d.orderId 
        ORDER BY o.id DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // Chuyển đổi chuỗi dauViec (JSON) về dạng mảng
        const formattedRows = rows.map(row => ({
            ...row,
            dauViec: JSON.parse(row.dauViec || "[]")
        }));
        res.json(formattedRows);
    });
});

// 2. Lưu đơn hàng
app.post('/api/orders/save', async (req, res) => {
    // 1. Khai báo data đầu tiên
    const data = req.body;
    const dauViecStr = JSON.stringify(data.dauViec || []);
    const userName = req.session.user ? req.session.user.name : 'Hệ thống';
    
    let folderId = data.folderId || null;
    let inputFolderId = data.inputFolderId || null;
    let outputFolderId = data.outputFolderId || null;

    try {
        // 2. Lấy dữ liệu cũ nếu là trường hợp Sửa đơn (Update)
        if (data.id) {
            const oldOrder = await new Promise((resolve) => {
                db.get("SELECT ttQuyTrinh, ttChotDon, folderId, inputFolderId, outputFolderId FROM orders WHERE id = ?", [data.id], (err, row) => resolve(row));
            });

            if (oldOrder) {
                // Lưu vào req để dùng trong callback db.run phía dưới
                req.oldOrderData = oldOrder; 
                folderId = folderId || oldOrder.folderId;
                inputFolderId = inputFolderId || oldOrder.inputFolderId;
                outputFolderId = outputFolderId || oldOrder.outputFolderId;
            }
        }

        // 3. Tạo cấu trúc Folder Google Drive (Nếu chưa có)
        if (!folderId) {
            const rootId = await getSetting('google_drive_root_id');
            if (rootId) {
                const folderName = `${data.maKH || 'KH'}_${data.tenMach || data.maDH}`;
                try {
                    const parent = await drive.files.create({
                        resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [rootId] },
                        fields: 'id', supportsAllDrives: true
                    });
                    folderId = parent.data.id;

                    const [inF, outF] = await Promise.all([
                        drive.files.create({ resource: { name: '1. INPUT', mimeType: 'application/vnd.google-apps.folder', parents: [folderId] }, fields: 'id', supportsAllDrives: true }),
                        drive.files.create({ resource: { name: '2. OUTPUT', mimeType: 'application/vnd.google-apps.folder', parents: [folderId] }, fields: 'id', supportsAllDrives: true })
                    ]);
                    inputFolderId = inF.data.id;
                    outputFolderId = outF.data.id;

                    await drive.files.create({
                        resource: { name: `Yêu cầu - ${data.maDH}.docx`, mimeType: 'application/vnd.google-apps.document', parents: [inputFolderId] },
                        supportsAllDrives: true
                    });
                } catch (err) {
                    console.error("Lỗi Drive API:", err.message);
                }
            }
        }

        // 4. Chuẩn bị Params lưu Database (20 tham số ứng với 20 dấu ?)
        const params = [
            data.maDH, data.loaiDV, data.maKH, data.tenMach, data.ngayTao, data.ngayChot,
            data.leadtime, data.ngayBanGiao, data.ttQuyTrinh, data.giaThietKe, data.heSoSale,
            data.vat, data.chietKhau, data.noteDH, data.giaBao, data.tamUng, dauViecStr,
            folderId, inputFolderId, outputFolderId, data.ttChotDon, 
            data.lyDoHuy // THÊM BIẾN NÀY VÀO PARAMS (Vị trí thứ 21)
        ];

        

        if (data.id) {
            // --- TRƯỜNG HỢP CẬP NHẬT (UPDATE) ---
            const sql = `UPDATE orders SET maDH=?, loaiDV=?, maKH=?, tenMach=?, ngayTao=?, ngayChot=?, leadtime=?, ngayBanGiao=?, ttQuyTrinh=?, giaThietKe=?, heSoSale=?, vat=?, chietKhau=?, noteDH=?, giaBao=?, tamUng=?, dauViec=?, folderId=?, inputFolderId=?, outputFolderId=?, ttChotDon=?, lyDoHuy=? WHERE id=?`;
            
            db.run(sql, [...params, data.id], function(err) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                
                handleDesignSync(data.id, data.maDH, data.ttChotDon, data.ttQuyTrinh, dauViecStr, inputFolderId,outputFolderId);

                // Kiểm tra thay đổi để bắn thông báo
                const old = req.oldOrderData;
                if (old) {
                    // Thông báo Quy trình kỹ thuật
                    if (old.ttQuyTrinh !== data.ttQuyTrinh) {
                        let emoji = data.ttQuyTrinh === 'Hoàn thành' ? '🎉' : '🔄';
                        sendGoogleChatMsg(data.maDH, userName, `${emoji} Trạng thái kỹ thuật: *${data.ttQuyTrinh}*`);
                    }
                    // Thông báo trạng thái Chốt đơn
                    if (old.ttChotDon !== data.ttChotDon) {
                        let chotEmoji = data.ttChotDon === 'Đã chốt' ? '🤝' : '⏳';
                        let extra = data.ttChotDon === 'Đã chốt' ? `\n💰 Giá trị: *${new Intl.NumberFormat('vi-VN').format(data.giaBao)} đ*` : '';
                        sendGoogleChatMsg(data.maDH, userName, `${chotEmoji} Giao dịch chuyển sang: *${data.ttChotDon}*${extra}`);
                    }
                }
                res.json({ success: true, folderId, inputFolderId, outputFolderId });
            });

        } else {
            // --- TRƯỜNG HỢP THÊM MỚI (INSERT) ---
            const sql = `INSERT INTO orders (maDH, loaiDV, maKH, tenMach, ngayTao, ngayChot, leadtime, ngayBanGiao, ttQuyTrinh, giaThietKe, heSoSale, vat, chietKhau, noteDH, giaBao, tamUng, dauViec, folderId, inputFolderId, outputFolderId, ttChotDon, lyDoHuy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
            
            db.run(sql, params, function(err) {
                if (err) return res.status(500).json({ success: false, error: err.message });
                const newId = this.lastID;
                
                handleDesignSync(newId, data.maDH, data.ttChotDon, data.ttQuyTrinh, dauViecStr, inputFolderId,outputFolderId);
                sendGoogleChatMsg(data.maDH, userName, `🆕 Khởi tạo đơn hàng mới: *${data.tenMach}*`);
                
                res.json({ success: true, id: newId, folderId, inputFolderId, outputFolderId });
            });
        }
    } catch (error) {
        console.error("Lỗi Save Order:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Hàm đồng bộ sang trang Thiết kế
function handleDesignSync(orderId, maDH, ttChotDon, ttQuyTrinh, dauViec, inputFolderId, outputFolderId) {
    if (ttChotDon === 'Đã chốt' && ttQuyTrinh !== 'Hủy đơn') {
        db.get("SELECT id FROM design_jobs WHERE orderId = ?", [orderId], (err, row) => {
            if (!row) {
                // Thêm mới: Lưu cả 2 ID vào 2 cột khác nhau
                const sqlInsert = `INSERT INTO design_jobs (orderId, maDH, ttThietKe, dauViec, driveLink, outputFolderId) 
                                   VALUES (?, ?, 'Chưa giao việc', ?, ?, ?)`;
                db.run(sqlInsert, [orderId, maDH, dauViec, inputFolderId, outputFolderId]);
            } else {
                // Cập nhật: Cập nhật cả 2 cột để đảm bảo đồng bộ
                const sqlUpdate = `UPDATE design_jobs SET maDH=?, dauViec=?, driveLink=?, outputFolderId=? WHERE orderId=?`;
                db.run(sqlUpdate, [maDH, dauViec, inputFolderId, outputFolderId, orderId]);
            }
        });
    } else {
        db.run(`DELETE FROM design_jobs WHERE orderId = ?`, [orderId]);
    }
}
// 3. Xóa đơn hàng
app.delete('/api/orders/:id', (req, res) => {
    db.run(`DELETE FROM orders WHERE id = ?`, req.params.id, (err) => {
        if (err) return res.status(500).json({ success: false });
        // Xóa luôn việc thiết kế liên quan
        db.run(`DELETE FROM design_jobs WHERE orderId = ?`, req.params.id);
        res.json({ success: true });
    });
});

const axios = require('axios'); // Cần chạy: npm install axios

// Webhook URL lấy từ cấu hình Google Chat (Space > Apps > Webhooks)
const GOOGLE_CHAT_WEBHOOK = "URL_WEBHOOK_CUA_BAN"; 

app.post('/api/design-jobs/save', async (req, res) => {
    const { id, designer, ttThietKe, version, folderPath, feedbackTK, maDH } = req.body;
    
    const sql = `UPDATE design_jobs SET designer=?, ttThietKe=?, version=?, feedbackTK=? WHERE id=?`;
    
    db.run(sql, [designer, ttThietKe, version, feedbackTK, id], async function(err) {
        if (err) return res.status(500).json({ success: false });

        // Gửi thông báo sang Google Chat
        const msg = `🛠️ *CẬP NHẬT THIẾT KẾ*\n` +
                    ` Trạng thái: *${ttThietKe}*\n` +
                    ` Version: ${version || '1.0'}\n` +
                    ` Ghi chú: ${feedbackTK || 'Không có'}`;
        
        sendGoogleChatMsg(maDH, req.session.user.name, msg);

        res.json({ success: true });
    });
});


// --- API CHO TRANG THIẾT KẾ ---

app.delete('/api/design-jobs/:id', (req, res) => {
    db.run(`DELETE FROM design_jobs WHERE id = ?`, req.params.id, (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

// 1. Lấy danh sách việc thiết kế
app.get('/api/design-jobs', (req, res) => {
    // Lấy thông tin từ bảng design_jobs
    db.all("SELECT * FROM design_jobs ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const formatted = rows.map(r => ({
            ...r,
            dauViec: JSON.parse(r.dauViec || "[]")
        }));
        res.json(formatted);
    });
});

// 2. Cập nhật tiến độ thiết kế (Nút Lưu & Đồng bộ)
app.post('/api/design-jobs/save', (req, res) => {
    const { id, designer, ttThietKe, version, driveLink, feedbackTK } = req.body;
    
    const sql = `UPDATE design_jobs SET designer=?, ttThietKe=?, version=?, driveLink=?, feedbackTK=? WHERE id=?`;
    db.run(sql, [designer, ttThietKe, version, driveLink, feedbackTK, id], function(err) {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
    
});

// 3. API lấy danh sách nhân viên kỹ thuật (Cho bộ lọc và chọn người phụ trách)
app.get('/api/users/technicians', (req, res) => {
    db.all("SELECT name, code FROM users WHERE roles LIKE '%Thiết kế%'", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// --- API CHO TRANG NHÂN SỰ (USERS) ---

// 1. Lấy danh sách nhân viên
app.get('/api/users', (req, res) => {
    db.all("SELECT * FROM users ORDER BY code ASC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const formatted = rows.map(r => ({
            ...r,
            roles: JSON.parse(r.roles || "[]") // Chuyển chuỗi JSON thành mảng
        }));
        res.json(formatted);
    });
});

// 2. Lưu nhân viên (Thêm mới hoặc Cập nhật)
app.post('/api/users/save', (req, res) => {
    const { id, code, name, username, password, phone, email, roles, status } = req.body;
    const rolesStr = JSON.stringify(roles);
    const activeStatus = status ? 1 : 0;

    if (id) {
        // TRƯỜNG HỢP CẬP NHẬT (EDIT)
        let sql, params;
        
        if (password && password.trim() !== "") {
            // Nếu người dùng có nhập mật khẩu mới
            sql = `UPDATE users SET name=?, username=?, password=?, phone=?, email=?, roles=?, status=? WHERE id=?`;
            params = [name, username, password, phone, email, rolesStr, activeStatus, id];
        } else {
            // Nếu không nhập mật khẩu (giữ nguyên pass cũ)
            sql = `UPDATE users SET name=?, username=?, phone=?, email=?, roles=?, status=? WHERE id=?`;
            params = [name, username, phone, email, rolesStr, activeStatus, id];
        }

        db.run(sql, params, function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true });
        });
    } else {
        // TRƯỜNG HỢP TẠO MỚI (ADD)
        const sql = `INSERT INTO users (code, name, username, password, phone, email, roles, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
        db.run(sql, [code, name, username, password, phone, email, rolesStr, activeStatus], function(err) {
            if (err) return res.status(500).json({ success: false, error: err.message });
            res.json({ success: true });
        });
    }
});

// 3. Xóa nhân viên
app.delete('/api/users/:id', (req, res) => {
    db.run(`DELETE FROM users WHERE id = ?`, req.params.id, (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

// --- API CHO QUẢN LÝ QUỸ & SỔ QUY ---

// 1. Lấy dữ liệu sổ quỹ và đề nghị chi
app.get('/api/fund', (req, res) => {
    // Lấy song song dữ liệu từ 2 bảng
    db.all("SELECT * FROM so_quy ORDER BY ngay DESC, id DESC", [], (errQuy, rowsQuy) => {
        db.all("SELECT * FROM requests_chi ORDER BY id DESC", [], (errReq, rowsReq) => {
            res.json({
                soQuy: rowsQuy || [],
                dsDeNghi: rowsReq || []
            });
        });
    });
});

// 2. Ghi sổ Thu/Chi thủ công
app.post('/api/fund/transaction', (req, res) => {
    const { id, ngay, loai, hangMuc, tien, nguoi, note } = req.body;
    const sql = `INSERT INTO so_quy (id, ngay, loai, hangMuc, tien, nguoi, note) VALUES (?, ?, ?, ?, ?, ?, ?)`;
    db.run(sql, [id, ngay, loai, hangMuc, tien, nguoi, note], function(err) {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

// 3. Gửi Đề nghị chi (Dành cho NV)
app.post('/api/fund/request', (req, res) => {
    const { id, ngay, noiDung, tien, nguoi } = req.body;
    // status mặc định là 'Chờ duyệt'
    db.run(`INSERT INTO requests_chi (id, ngay, noiDung, tien, nguoi, status) VALUES (?, ?, ?, ?, ?, 'Chờ duyệt')`,
    [id, ngay, noiDung, tien, nguoi], (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

// 4. Phê duyệt đề nghị chi (Tự động chuyển vào sổ quỹ)
app.post('/api/fund/approve', (req, res) => {

    const { id, approver } = req.body;
    const userRole = req.session.user.role;

    // Chặn nếu không phải sếp
    if (userRole !== 'Trưởng BP Thiết kế' && userRole !== 'Admin') {
        return res.status(403).json({ success: false, error: "Bạn không có quyền duyệt!" });
    }
    
    db.get("SELECT * FROM requests_chi WHERE id = ?", [id], (err, row) => {
        if (!row) return res.json({ success: false });

        db.serialize(() => {
            // Cập nhật trạng thái đề nghị
            db.run("UPDATE requests_chi SET status = 'Đã duyệt' WHERE id = ?", [id]);
            
            // Tự động ghi vào sổ quỹ (Phiếu CHI)
            const quyId = 'TC' + Date.now();
            db.run(`INSERT INTO so_quy (id, ngay, loai, hangMuc, tien, nguoi, note) VALUES (?, ?, 'CHI', ?, ?, ?, ?)`,
            [quyId, new Date().toISOString().split('T')[0], `CHI DUYỆT: ${row.noiDung}`, row.tien, approver, `Duyệt từ phiếu ${id}`]);
            
            res.json({ success: true });
        });
    });
});


// --- API CHO QUẢN LÝ DỰ ÁN (PROJECTS) ---

// 1. Lấy danh sách dự án kèm thông tin khách hàng (Dùng JOIN)
app.get('/api/projects', (req, res) => {
    const sql = `
        SELECT p.*, c.tenKH, c.sdt 
        FROM projects p 
        LEFT JOIN customers c ON p.maKH = c.maKH 
        ORDER BY p.id DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const formatted = rows.map(r => ({
            ...r,
            tasks: JSON.parse(r.tasks || "[]"),
            payments: JSON.parse(r.payments || "[]")
        }));
        res.json(formatted);
    });
});

// 2. Lưu dự án (Bổ sung cột maKH)
app.post('/api/projects/save',(req, res) => {
    const data = req.body;
    const tasksStr = JSON.stringify(data.tasks || []);
    const paymentsStr = JSON.stringify(data.payments || []);

    if (data.id) {
        const sql = `UPDATE projects SET name=?, maKH=?, leader=?, status=?, contractValue=?, start=?, end=?, desc=?, tasks=?, payments=? WHERE id=?`;
        const params = [data.name, data.maKH, data.leader, data.status, data.contractValue, data.start, data.end, data.desc, tasksStr, paymentsStr, data.id];
        db.run(sql, params, (err) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true });
        });
    } else {
        const sql = `INSERT INTO projects (name, maKH, leader, status, contractValue, start, end, desc, tasks, payments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const params = [data.name, data.maKH, data.leader, data.status, data.contractValue, data.start, data.end, data.desc, tasksStr, paymentsStr];
        db.run(sql, params, function(err) {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, id: this.lastID });
        });
    }
});

// 3. Xóa dự án
app.delete('/api/projects/:id',(req, res) => {
    db.run(`DELETE FROM projects WHERE id = ?`, req.params.id, (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});


// --- API CHO DỰ ÁN NGOÀI (EXTERNAL PROJECTS) ---

// 1. Lấy danh sách dự án ngoài
app.get('/api/external-projects', (req, res) => {
    db.all("SELECT * FROM external_projects ORDER BY createdAt DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 2. Lưu dự án ngoài (Thêm mới hoặc Cập nhật)
app.post('/api/external-projects/save', (req, res) => {
    const data = req.body;
    // Chuyển mảng mốc thanh toán thành chuỗi JSON để lưu vào TEXT
    const payGuestStr = JSON.stringify(data.payments_guest || []);
    const payCtyStr = JSON.stringify(data.payments_company || []);

    if (data.id) {
        const sql = `UPDATE external_projects SET 
            name=?, maKH=?, createdAt=?, priceRoot=?, priceGuest=?, 
            psMe=?, psCty=?, note=?, payStatus=?, heSo=?, 
            payments_guest=?, payments_company=? WHERE id=?`;
        const params = [
            data.name, data.maKH, data.createdAt, data.priceRoot, data.priceGuest,
            data.psMe, data.psCty, data.note, data.payStatus, data.heSo,
            payGuestStr, payCtyStr, data.id
        ];
        db.run(sql, params, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
    } else {
        const sql = `INSERT INTO external_projects (
            name, maKH, createdAt, priceRoot, priceGuest, psMe, psCty, note, payStatus, heSo, payments_guest, payments_company
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`;
        const params = [
            data.name, data.maKH, data.createdAt, data.priceRoot, data.priceGuest,
            data.psMe, data.psCty, data.note, data.payStatus, data.heSo,
            payGuestStr, payCtyStr
        ];
        db.run(sql, params, function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, id: this.lastID });
        });
    }
});

// 3. Xóa dự án ngoài
app.delete('/api/external-projects/:id', (req, res) => {
    db.run(`DELETE FROM external_projects WHERE id = ?`, req.params.id, (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

app.get('/api/dashboard-stats', async (req, res) => {
    try {
        // 1. Tổng khách hàng
        const countKH = await new Promise((resolve) => {
            db.get("SELECT COUNT(*) as count FROM customers", (err, row) => resolve(row ? row.count : 0));
        });

        // 2. Đơn hàng đang xử lý (Trừ các đơn đã Hoàn thành hoặc Hủy)
        const activeOrders = await new Promise((resolve) => {
            db.get("SELECT COUNT(*) as count FROM orders WHERE ttQuyTrinh NOT IN ('Hoàn thành', 'Hủy')", (err, row) => resolve(row ? row.count : 0));
        });

        // 3. Tính tổng công nợ (Sử dụng COALESCE để tránh lỗi NULL khi bảng trống)
        const debtData = await new Promise((resolve) => {
    // Sử dụng dấu -- cho comment trong SQL hoặc xóa bỏ comment để an toàn tuyệt đối
    const sql = `
        SELECT (
            (SELECT COALESCE(SUM(old_debt), 0) FROM customers)
            +
            (SELECT COALESCE(SUM(
                giaBao - (
                    SELECT COALESCE(SUM(CAST(json_extract(value, '$.amount') AS REAL)), 0)
                    FROM json_each(COALESCE(orders.giaBao, '[]'))
                )
            ), 0) FROM orders WHERE ttQuyTrinh != 'Hủy')
        ) as totalDebt
    `;

    db.get(sql, [], (err, row) => {
        if (err) {
            console.error("Lỗi tính toán Dashboard Debt:", err.message);
            resolve(0);
        } else {
            resolve(row ? row.totalDebt : 0);
        }
    });
});

        // 4. 5 đơn hàng mới cập nhật
        const recentOrders = await new Promise((resolve) => {
            db.all("SELECT maDH, tenMach, ttQuyTrinh, giaBao FROM orders ORDER BY id DESC LIMIT 5", (err, rows) => resolve(rows || []));
        });

        // 5. Trạng thái kết nối (Dùng hàm getSetting đã viết ở bước trước)
        const driveId = await getSetting('google_drive_root_id');
        const webhook = await getSetting('google_chat_webhook');

        // Trả về JSON chuẩn
        res.json({
            countKH,
            activeOrders,
            totalDebt: debtData,
            recentOrders,
            systemStatus: {
                drive: driveId ? 'connected' : 'disconnected',
                webhook: webhook ? 'connected' : 'disconnected'
            }
        });

    } catch (error) {
        console.error("Critical Dashboard Error:", error);
        // Trả về cấu hình an toàn thay vì lỗi 500
        res.json({
            countKH: 0, activeOrders: 0, totalDebt: 0, recentOrders: [],
            systemStatus: { drive: 'disconnected', webhook: 'disconnected' }
        });
    }
});

// --- API CHO SETTINGS & BRANDS ---

// 1. Lấy toàn bộ danh sách Brands
app.get('/api/brands', (req, res) => {
    db.all("SELECT * FROM brands ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

// 2. Lưu Brand (Thêm/Sửa)
app.post('/api/brands/save', (req, res) => {
    const data = req.body;
    if (data.id) {
        const sql = `UPDATE brands SET company=?, code=?, address=?, bankName=?, bankNo=?, bankOwner=?, logo=? WHERE id=?`;
        const params = [data.company, data.code, data.address, data.bankName, data.bankNo, data.bankOwner, data.logo, data.id];
        db.run(sql, params, (err) => {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true });
        });
    } else {
        const sql = `INSERT INTO brands (company, code, address, bankName, bankNo, bankOwner, logo) VALUES (?,?,?,?,?,?,?)`;
        const params = [data.company, data.code, data.address, data.bankName, data.bankNo, data.bankOwner, data.logo];
        db.run(sql, params, function(err) {
            if (err) return res.status(500).json({ success: false });
            res.json({ success: true, id: this.lastID });
        });
    }
});

// 3. Xóa Brand
app.delete('/api/brands/:id', (req, res) => {
    db.run(`DELETE FROM brands WHERE id = ?`, req.params.id, (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

// --- API WEBHOOK TRONG APP.JS ---

// Hàm helper lấy giá trị cấu hình từ bảng settings
function getSetting(key) {
    return new Promise((resolve, reject) => {
        db.get("SELECT value FROM settings WHERE key = ?", [key], (err, row) => {
            if (err) resolve(null); // Trả về null nếu lỗi để tránh crash
            resolve(row ? row.value : null);
        });
    });
}

// Lưu cấu hình Webhook
app.post('/api/settings/save-webhook', (req, res) => {
    const { url } = req.body;
    db.run(`INSERT OR REPLACE INTO settings (key, value, status) VALUES (?, ?, ?)`, 
    ['google_chat_webhook', url, url ? 'connected' : 'disconnected'], (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

// Hàm Helper để bắn tin nhắn (Dùng trong các API khác

app.post('/api/settings/save-drive', (req, res) => {
    const { folderId } = req.body;
    db.run(`INSERT OR REPLACE INTO settings (key, value, status) VALUES (?, ?, ?)`, 
    ['google_drive_root_id', folderId, 'connected'], (err) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true });
    });
});

app.post('/api/settings/test-drive', async (req, res) => {
    const { folderId } = req.body;
    
    if (!folderId) {
        return res.json({ success: false, message: "ID thư mục bị trống" });
    }

    try {
        // Sử dụng drive.files.get để kiểm tra sự tồn tại của Folder
        const response = await drive.files.get({
            fileId: folderId,
            fields: 'id, name',
            supportsAllDrives: true, // QUAN TRỌNG: Cho phép Shared Drive
        });

        console.log("Kết nối Drive thành công:", response.data.name);
        res.json({ success: true, folderName: response.data.name });
    } catch (error) {
        console.error("Lỗi Drive API:", error.message);
        // Nếu lỗi 404 ở đây, nghĩa là con bot chưa được "mời" vào Shared Drive
        res.json({ success: false, message: error.message });
    }
});

async function sendGoogleChatMsg(maDH, nhanVien, hanhDong) {
    const webhookUrl = await getSetting('google_chat_webhook');
    if (!webhookUrl) return;

    const message = {
        text: `🔔 *THÔNG BÁO HỆ THỐNG ERP*\n` +
              `📦 *Đơn hàng:* ${maDH}\n` +
              `👤 *Nhân viên:* ${nhanVien}\n` +
              `📝 *Nội dung:* ${hanhDong}`
    };

    try {
        await axios.post(webhookUrl, message);
    } catch (error) {
        console.error("Lỗi gửi Webhook:", error.message);
    }
}

app.post('/api/orders/upload-file', upload.single('file'), async (req, res) => {
    const { folderId, maDH, nhanVien } = req.body;

    // Kiểm tra đầu vào khắt khe để tránh lỗi 'undefined'
    if (!folderId || folderId === 'null' || folderId === 'undefined') {
        return res.status(400).json({ success: false, error: "ID thư mục Drive không hợp lệ" });
    }

    try {
        const fileMetadata = {
            name: req.file.originalname,
            parents: [folderId]
        };
        const media = {
            mimeType: req.file.mimetype,
            body: fs.createReadStream(req.file.path)
        };

        const gFile = await drive.files.create({
            resource: fileMetadata,
            media: media,
            fields: 'id, webViewLink',
            supportsAllDrives: true
        });

        // Xóa file tạm
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);

        // Bắn tin nhắn lên Google Chat
        const user = nhanVien || "Thành viên HTG";
        await sendGoogleChatMsg(maDH, user, `📂 Đã tải lên tài liệu yêu cầu: *${req.file.originalname}*`);

        res.json({ success: true, fileId: gFile.data.id });
    } catch (error) {
        console.error("Lỗi Drive Upload:", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});


app.post('/api/customers/import', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: "Không có file nào được tải lên" });

    try {
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

        let importCount = 0;

        for (const item of data) {
            // Lấy dữ liệu từ các cột (Tên cột phải khớp với dòng đầu tiên trong Excel của bạn)
            const nick_name = item['Nick name'] || item['Nickname'] || 'KH';
            const tenKH = item['Tên khách hàng'] || item['Name'] || '';
            const sdt = String(item['Số điện thoại'] || item['SĐT'] || '').replace(/\D/g, '');
            const diaChi = item['Địa chỉ'] || '';
            const old_debt = parseFloat(item['Nợ cũ'] || 0);

            // Tự tạo maKH theo quy tắc: NICKNAME_4SOCUOI
            const maKH = `${nick_name.replace(/\s+/g, '')}_${sdt.slice(-4)}`;

            // Chèn vào DB (Dùng INSERT OR IGNORE để tránh trùng mã khách hàng)
            await new Promise((resolve, reject) => {
                const sql = `INSERT OR IGNORE INTO customers (maKH, nick_name, tenKH, sdt, diaChi, old_debt) VALUES (?, ?, ?, ?, ?, ?)`;
                db.run(sql, [maKH, nick_name, tenKH, sdt, diaChi, old_debt], function(err) {
                    if (!err && this.changes > 0) importCount++;
                    resolve();
                });
            });
        }

        // Xóa file tạm sau khi xong
        fs.unlinkSync(req.file.path);

        res.json({ success: true, message: `Đã nhập thành công ${importCount} khách hàng.` });
    } catch (error) {
        console.error("Lỗi Import Excel:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/customers/template', (req, res) => {
    try {
        // 1. Tạo dữ liệu mẫu (Chỉ có tiêu đề cột)
        const templateData = [
            {
                "Nick name": "HTech",
                "Tên khách hàng": "Nguyễn Văn A",
                "Số điện thoại": "0987654321",
                "Địa chỉ": "Hà Nội",
                "Nợ cũ": 0
            }
        ];

        // 2. Chuyển thành Workbook
        const ws = XLSX.utils.json_to_sheet(templateData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Template");

        // 3. Gửi file về trình duyệt
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        
        res.setHeader('Content-Disposition', 'attachment; filename=Mau_Import_KhachHang.xlsx');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);

    } catch (error) {
        res.status(500).send("Không thể tạo file mẫu");
    }
});

app.get('/api/orders/export-pdf/:id', async (req, res) => {
    const orderId = req.params.id;
    const brandId = req.query.brandId || 1; // Lấy ID brand từ query string

    try {
        const sql = `
            SELECT o.*, c.tenKH, c.sdt as customerPhone, c.diaChi as customerAddr,
                   b.company as brandName, b.address as brandAddr, b.logo, b.bankName, b.bankNo, b.bankOwner
            FROM orders o
            LEFT JOIN customers c ON o.maKH = c.maKH
            LEFT JOIN brands b ON b.id = ? -- Lấy đúng Brand người dùng chọn
            WHERE o.id = ?`;
        
        const data = await new Promise((resolve, reject) => {
            db.get(sql, [brandId, orderId], (err, row) => err ? reject(err) : resolve(row));
        });

        if (!data) return res.status(404).send("Không tìm thấy dữ liệu");

        // --- LOGIC TÍNH TOÁN CÁC THÀNH PHẦN GIÁ ---
        const giaGoc = (data.giaThietKe || 0) * (data.heSoSale || 1);
        const tienVat = giaGoc * (data.vat || 0) / 100;
        const tienCK = giaGoc * (data.chietKhau || 0) / 100;
        const tongCong = giaGoc + tienVat - tienCK;

        const htmlContent = `
        <html>
            <head>
                <meta charset="utf-8">
                <style>
                    body { font-family: 'Segoe UI', Arial, sans-serif; padding: 40px; color: #1e293b; line-height: 1.5; }
                    .header-table { width: 100%; border-bottom: 3px solid #3b82f6; margin-bottom: 20px; }
                    .title { text-align: center; color: #1e40af; font-size: 24px; text-transform: uppercase; margin: 20px 0; }
                    .info-box { display: flex; justify-content: space-between; margin-bottom: 30px; background: #f8fafc; padding: 15px; border-radius: 10px; font-size: 13px; }
                    table.main-table { width: 100%; border-collapse: collapse; }
                    table.main-table th { background: #3b82f6; color: white; padding: 10px; text-align: left; font-size: 13px; }
                    table.main-table td { padding: 10px; border: 1px solid #e2e8f0; font-size: 13px; }
                    
                    /* CSS cho phần tổng tiền */
                    .summary-container { margin-top: 20px; width: 100%; display: flex; justify-content: flex-end; }
                    .summary-table { width: 300px; float: right; border-collapse: collapse; }
                    .summary-table td { padding: 5px 10px; border: none; text-align: right; font-size: 13px; }
                    .summary-table .label { text-align: left; color: #64748b; }
                    .summary-table .grand-total { font-size: 18px; font-weight: bold; color: #ef4444; border-top: 2px solid #e2e8f0; padding-top: 10px; }
                    
                    .bank-info { margin-top: 30px; padding: 15px; border: 1px dashed #cbd5e1; border-radius: 8px; background: #fff; font-size: 12px; }
                    .footer { text-align: center; margin-top: 40px; font-size: 11px; color: #94a3b8; }
                </style>
            </head>
            <body>
                <table class="header-table">
                    <tr>
                        <td style="border:none">
                            <h2 style="margin:0; color:#1e40af">${data.brandName}</h2>
                            <p style="margin:5px 0; font-size:11px">${data.brandAddr}</p>
                        </td>
                        <td style="text-align:right; border:none">
                            ${data.logo ? `<img src="${data.logo}" style="height:60px" crossorigin="anonymous">` : ''}
                        </td>
                    </tr>
                </table>

                <h1 class="title">BÁO GIÁ DỊCH VỤ</h1>

                <div class="info-box">
                    <div style="width: 60%">
                        <p><strong>Khách hàng:</strong> ${data.tenKH || 'N/A'}</p>
                        <p><strong>Điện thoại:</strong> ${data.customerPhone || '---'}</p>
                        <p><strong>Địa chỉ:</strong> ${data.customerAddr || '---'}</p>
                    </div>
                    <div style="width: 40%; text-align: right">
                        <p><strong>Số báo giá:</strong> ${data.maDH}</p>
                        <p><strong>Ngày tạo:</strong> ${data.ngayTao}</p>
                    </div>
                </div>

                <table class="main-table">
                    <thead>
                        <tr>
                            <th width="40%">Hạng mục</th>
                            <th width="40%">Chi tiết kỹ thuật</th>
                            <th style="text-align:right" width="20%">Đơn giá (x${data.heSoSale})</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><strong>${data.loaiDV}</strong><br><small>${data.tenMach}</small></td>
                            <td style="font-size:11px; color: #475569">${Array.isArray(JSON.parse(data.dauViec || "[]")) ? JSON.parse(data.dauViec).join(', ') : data.dauViec}</td>
                            <td style="text-align:right; font-weight:bold">${new Intl.NumberFormat('vi-VN').format(giaGoc)} đ</td>
                        </tr>
                    </tbody>
                </table>

                <div class="summary-container">
                    <table class="summary-table">
                        <tr>
                            <td class="label">Tạm tính:</td>
                            <td>${new Intl.NumberFormat('vi-VN').format(giaGoc)} đ</td>
                        </tr>
                        <tr>
                            <td class="label">Thuế VAT (${data.vat}%):</td>
                            <td>+ ${new Intl.NumberFormat('vi-VN').format(tienVat)} đ</td>
                        </tr>
                        <tr>
                            <td class="label">Chiết khấu (${data.chietKhau}%):</td>
                            <td style="color: #ef4444">- ${new Intl.NumberFormat('vi-VN').format(tienCK)} đ</td>
                        </tr>
                        <tr>
                            <td class="label grand-total">TỔNG CỘNG:</td>
                            <td class="grand-total">${new Intl.NumberFormat('vi-VN').format(tongCong)} đ</td>
                        </tr>
                    </table>
                </div>

                <div class="bank-info">
                    <p style="margin-top:0"><strong>THÔNG TIN THANH TOÁN:</strong></p>
                    <p>Ngân hàng: <strong>${data.bankName || '---'}</strong></p>
                    <p>Số tài khoản: <strong>${data.bankNo || '---'}</strong></p>
                    <p>Chủ tài khoản: <strong>${data.bankOwner || '---'}</strong></p>
                </div>

                <div class="footer">
                    <p>Báo giá có hiệu lực trong vòng 15 ngày kể từ ngày phát hành.</p>
                    <p>--- Trân trọng cảm ơn Quý khách ---</p>
                </div>
            </body>
        </html>`;

        const options = { format: 'A4', printBackground: true };
        html_to_pdf.generatePdf({ content: htmlContent }, options).then(pdfBuffer => {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `inline; filename=BaoGia_${data.maDH}.pdf`);
            res.send(pdfBuffer);
        });

    } catch (err) {
        console.error("❌ Lỗi Render PDF:", err);
        res.status(500).send("Lỗi máy chủ khi tạo PDF");
    }
});

app.get('/api/reports/summary', (req, res) => {
    const sql = `
        SELECT 
            COUNT(*) as totalOrders,
            SUM(CASE WHEN ttChotDon = 'Đã chốt' THEN 1 ELSE 0 END) as closedOrders,
            SUM(giaBao) as totalRevenue,
            SUM(tamUng) as totalCollected,
            SUM(giaBao - tamUng) as totalDebt
        FROM orders 
        WHERE ttQuyTrinh != 'Hủy đơn'`;

    db.get(sql, [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // Tính tỷ lệ chốt đơn
        const winRate = row.totalOrders > 0 ? ((row.closedOrders / row.totalOrders) * 100).toFixed(1) : 0;
        res.json({ ...row, winRate });
    });
});
// --- ROUTES ĐIỀU HƯỚNG ---
app.get('/', (req, res) => res.render('pages/dashboard'));
app.get('/dashboard', (req, res) => res.render('pages/dashboard'));
app.get('/khach-hang', (req, res) => res.render('pages/khach-hang'));
app.get('/don-hang', (req, res) => res.render('pages/don-hang'));
app.get('/thiet-ke', (req, res) => res.render('pages/thiet-ke'));
app.get('/du-an', (req, res) => res.render('pages/du-an'));
app.get('/du-an-ngoai', (req, res) => res.render('pages/du-an-ngoai'));
app.get('/quan-ly-quy', (req, res) => res.render('pages/quan-ly-quy'));
app.get('/tai-khoan', (req, res) => res.render('pages/tai-khoan'));
app.get('/cai-dat', (req, res) => res.render('pages/cai-dat'));
// Thêm dòng này vào app.js (Đoạn các Route GET)
app.get('/reports', (req, res) => {
    res.render('pages/reports', { title: 'Báo cáo hệ thống' });
});

// --- KHỞI CHẠY ---
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Hệ thống đang chạy tại: http://localhost:${PORT}`);
});