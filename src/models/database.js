const sqlite3 = require('sqlite3').verbose();
const { DB_PATH } = require('../config');
const { isHashed, hashPassword } = require('../utils/password');

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) console.error('Loi ket noi database:', err);
});

// ---------- Ham Promise dung chung (thay cho callback long nhau) ----------
db.runAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
    });
});
db.getAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});
db.allAsync = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
});

// Cap so thu tu tang dan theo tien to, an toan khi nhieu nguoi bam cung luc (1 cau lenh duy nhat).
// initSql (tuy chon): cau SELECT tra ve gia tri khoi dau khi tien to chua ton tai.
db.nextSeq = async (prefix, initSql = null, initParams = []) => {
    const init = initSql ? `(${initSql})` : '1';
    const row = await db.getAsync(
        `INSERT INTO order_sequences (prefix, last_seq) VALUES (?, ${init})
         ON CONFLICT(prefix) DO UPDATE SET last_seq = last_seq + 1
         RETURNING last_seq`,
        [prefix, ...initParams]
    );
    return row.last_seq;
};

// ---------- Cau truc bang ----------
const TABLES = [
    `CREATE TABLE IF NOT EXISTS brands (id INTEGER PRIMARY KEY AUTOINCREMENT, company TEXT, code TEXT, address TEXT, bankName TEXT, bankNo TEXT, bankOwner TEXT, logo TEXT)`,
    `CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, maKH TEXT UNIQUE, nick_name TEXT, tenKH TEXT, sdt TEXT, diaChi TEXT)`,
    `CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, maDH TEXT, loaiDV TEXT, maKH TEXT, tenMach TEXT, ngayTao TEXT, ngayChot TEXT, leadtime INTEGER, ngayBanGiao TEXT, ttQuyTrinh TEXT, giaThietKe REAL, heSoSale REAL, vat REAL, chietKhau REAL, noteDH TEXT, giaBao REAL, tamUng REAL, dauViec TEXT)`,
    `CREATE TABLE IF NOT EXISTS design_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, orderId INTEGER, maDH TEXT, designer TEXT, ttThietKe TEXT, version TEXT, driveLink TEXT, feedbackTK TEXT, dauViec TEXT)`,
    `CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, customer TEXT, leader TEXT, status TEXT, contractValue REAL, start TEXT, end TEXT, desc TEXT, tasks TEXT, payments TEXT)`,
    `CREATE TABLE IF NOT EXISTS external_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, createdAt TEXT, priceRoot REAL, priceGuest REAL, psMe REAL, psCty REAL, note TEXT, payStatus TEXT, heSo REAL)`,
    `CREATE TABLE IF NOT EXISTS so_quy (id TEXT PRIMARY KEY, ngay TEXT, loai TEXT, hangMuc TEXT, tien REAL, nguoi TEXT, note TEXT)`,
    `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, name TEXT, username TEXT, password TEXT, phone TEXT, email TEXT, status INTEGER, roles TEXT)`,
    `CREATE TABLE IF NOT EXISTS requests_chi (id TEXT PRIMARY KEY, ngay TEXT, noiDung TEXT, tien REAL, nguoi TEXT, status TEXT)`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT, status TEXT)`,
    `CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL, uid INTEGER)`,
    `CREATE TABLE IF NOT EXISTS order_sequences (prefix TEXT PRIMARY KEY, last_seq INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS customers_ext (maKH TEXT PRIMARY KEY, customerFolderId TEXT)`,
    // Hang muc mach cua don hang: 1 don co nhieu loai mach, moi loai co so luong, BOM va gia cost rieng
    `CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, orderId INTEGER NOT NULL, stt INTEGER DEFAULT 1, tenMach TEXT, soLuongPCB INTEGER DEFAULT 0, soLuongLK INTEGER DEFAULT 0, soLuongGiaCong INTEGER DEFAULT 0, giaCostPCB REAL DEFAULT 0, giaCostLK REAL DEFAULT 0, giaCostGiaCong REAL DEFAULT 0, costDetail TEXT, ghiChu TEXT)`,
    // Chung tu cua don hang (hop dong, hoa don, bien ban): moi loai 1 dong cho moi don
    `CREATE TABLE IF NOT EXISTS order_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, orderId INTEGER NOT NULL, loai TEXT NOT NULL, trangThai TEXT, so TEXT, ngay TEXT, giaTri REAL, link TEXT, ghiChu TEXT, updatedBy TEXT, updatedAt TEXT, UNIQUE(orderId, loai))`,
    // Tam xuat kho cho don dang bao gia: status = hold (dang tam xuat) | released (da tai nhap) | issued (don chot, xuat chinh thuc)
    `CREATE TABLE IF NOT EXISTS stock_holds (id INTEGER PRIMARY KEY AUTOINCREMENT, orderId INTEGER NOT NULL, lineId INTEGER, field TEXT, itemId INTEGER NOT NULL, quantity REAL NOT NULL, status TEXT NOT NULL DEFAULT 'hold', createdBy TEXT, createdAt TEXT, closedAt TEXT)`,
    // Ten goi khac cua 1 ma hang (moi khach goi 1 kieu): aliasNorm la dang chuan hoa de so khop
    `CREATE TABLE IF NOT EXISTS inventory_aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, itemId INTEGER NOT NULL, alias TEXT NOT NULL, aliasNorm TEXT NOT NULL, maKH TEXT, createdBy TEXT, createdAt TEXT, UNIQUE(itemId, aliasNorm))`,
    `CREATE TABLE IF NOT EXISTS order_payments (id INTEGER PRIMARY KEY AUTOINCREMENT, orderId INTEGER NOT NULL, maDH TEXT, ngay TEXT, soTien REAL NOT NULL, ghiChu TEXT, nguoiThu TEXT, quyId TEXT, createdAt TEXT)`,
    `CREATE TABLE IF NOT EXISTS buy_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, orderId INTEGER NOT NULL, maDH TEXT, lineId INTEGER, tenMach TEXT, bomIdx INTEGER, itemId INTEGER, itemCode TEXT, name TEXT, unit TEXT, qtyNeed REAL DEFAULT 0, supplierId INTEGER, supplierName TEXT, priceQuote REAL DEFAULT 0, qtyOrdered REAL DEFAULT 0, priceActual REAL DEFAULT 0, qtyReceived REAL DEFAULT 0, poId INTEGER, poCode TEXT, expectedDate TEXT, createdAt TEXT, updatedAt TEXT)`,
    // Nhat ky KIEM VAT TU mua ve / khach gui: ai kiem, luc nao (de doi chieu camera), dem duoc bao nhieu, dung chung loai khong. Chi ghi them, khong sua.
    `CREATE TABLE IF NOT EXISTS buy_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, buyLineId INTEGER NOT NULL, poId INTEGER, poCode TEXT, orderId INTEGER, maDH TEXT, supplierName TEXT, itemCode TEXT, name TEXT, qty REAL DEFAULT 0, result TEXT, note TEXT, method TEXT, scanned TEXT, checkedBy TEXT, checkedAt TEXT)`,
    `CREATE TABLE IF NOT EXISTS customer_addresses (id INTEGER PRIMARY KEY AUTOINCREMENT, maKH TEXT NOT NULL, label TEXT, receiver TEXT, phone TEXT, address TEXT, isDefault INTEGER DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS stock_confirms (id INTEGER PRIMARY KEY AUTOINCREMENT, orderId INTEGER NOT NULL, lineId INTEGER, field TEXT, itemId INTEGER NOT NULL, qty REAL DEFAULT 0, status TEXT, qtyOk REAL, note TEXT, requestedBy TEXT, requestedAt TEXT, confirmedBy TEXT, confirmedAt TEXT)`,
    `CREATE TABLE IF NOT EXISTS shipments (id INTEGER PRIMARY KEY AUTOINCREMENT, orderId INTEGER NOT NULL, maDH TEXT, status TEXT, carrier TEXT, trackingNo TEXT, shipDate TEXT, deliveredDate TEXT, receiver TEXT, contents TEXT, fee REAL DEFAULT 0, note TEXT, createdBy TEXT, createdAt TEXT, updatedBy TEXT, updatedAt TEXT)`,
    `CREATE TABLE IF NOT EXISTS vip_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, productId INTEGER NOT NULL, rev INTEGER, ngay TEXT, noiDung TEXT, nguoi TEXT, bomSnapshot TEXT)`,
    `CREATE TABLE IF NOT EXISTS vip_sanpham (id INTEGER PRIMARY KEY AUTOINCREMENT, maKH TEXT NOT NULL, tenMach TEXT NOT NULL, coPCB INTEGER DEFAULT 0, coLK INTEGER DEFAULT 1, coSX INTEGER DEFAULT 1, giaPCB REAL DEFAULT 0, giaGiaCong REAL DEFAULT 0, giaBan REAL DEFAULT 0, bom TEXT DEFAULT '[]', ghiChu TEXT, active INTEGER DEFAULT 1, updatedBy TEXT, updatedAt TEXT)`,
    `CREATE TABLE IF NOT EXISTS workshops (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT, contact TEXT, phone TEXT, capability TEXT, note TEXT, status INTEGER DEFAULT 1, createdAt TEXT)`,
    `CREATE TABLE IF NOT EXISTS dispatches (id INTEGER PRIMARY KEY AUTOINCREMENT, orderId INTEGER NOT NULL, lineId INTEGER NOT NULL UNIQUE, workshopId INTEGER NOT NULL, quantity REAL DEFAULT 0, status TEXT DEFAULT 'Đã giao xưởng', progress INTEGER DEFAULT 0, doneQty REAL DEFAULT 0, expectedDate TEXT, note TEXT, workshopNote TEXT, assignedBy TEXT, assignedAt TEXT, updatedBy TEXT, updatedAt TEXT, completedAt TEXT)`,
    `CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT NOT NULL, type TEXT, phone TEXT, email TEXT, address TEXT, contactPerson TEXT, bankName TEXT, bankNo TEXT, note TEXT, rating INTEGER DEFAULT 3, status INTEGER DEFAULT 1, createdAt TEXT)`,
    `CREATE TABLE IF NOT EXISTS purchase_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, poCode TEXT UNIQUE, orderId INTEGER, maDH TEXT, type TEXT, supplierId INTEGER, supplierName TEXT, items TEXT DEFAULT '[]', totalAmount REAL DEFAULT 0, currency TEXT DEFAULT 'VND', status TEXT DEFAULT 'Chờ duyệt', createdBy TEXT, createdAt TEXT, expectedDate TEXT, receivedDate TEXT, note TEXT, attachments TEXT DEFAULT '[]')`,
    `CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, itemCode TEXT UNIQUE, itemName TEXT NOT NULL, category TEXT, unit TEXT DEFAULT 'cái', quantity REAL DEFAULT 0, minQuantity REAL DEFAULT 0, location TEXT, description TEXT, note TEXT, createdAt TEXT)`,
    `CREATE TABLE IF NOT EXISTS inventory_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, transCode TEXT UNIQUE, itemId INTEGER, itemCode TEXT, itemName TEXT, type TEXT, quantity REAL, unitPrice REAL DEFAULT 0, reason TEXT, refType TEXT, refId TEXT, refCode TEXT, createdBy TEXT, createdAt TEXT, note TEXT)`,
    `CREATE TABLE IF NOT EXISTS production_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, woCode TEXT UNIQUE, orderId INTEGER, maDH TEXT, productName TEXT, quantity INTEGER DEFAULT 1, status TEXT DEFAULT 'Chờ sản xuất', lineId INTEGER, lineName TEXT, assignedTo TEXT, startDate TEXT, expectedDate TEXT, completedDate TEXT, progress INTEGER DEFAULT 0, stages TEXT DEFAULT '[]', bom TEXT DEFAULT '[]', note TEXT, createdBy TEXT, createdAt TEXT)`,
    `CREATE TABLE IF NOT EXISTS production_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, name TEXT NOT NULL, type TEXT, capacity TEXT, status TEXT DEFAULT 'Hoạt động', lastMaintenance TEXT, nextMaintenance TEXT, note TEXT, createdAt TEXT)`
];

// Cac cot bo sung sau nay. Chi ALTER khi cot chua co (khong con nuot loi im lang nhu truoc).
const EXTRA_COLUMNS = {
    users: { workshopId: 'INTEGER', brandId: 'INTEGER' }, // brandId: thuong hieu cua tai khoan sale (tu gan vao don sale do tao) // tai khoan xuong thuoc xuong nao
    buy_lines: { altNote: 'TEXT', surplus: 'TEXT', khachCap: 'INTEGER DEFAULT 0', grp: 'TEXT', cancelledAt: 'TEXT', toStock: 'INTEGER DEFAULT 0', resolution: 'TEXT', resolvedBy: 'TEXT', resolvedAt: 'TEXT' }, // xu ly khi don bi huy
    shipments: { address: 'TEXT', receiverPhone: 'TEXT' }, // noi nhan cua chuyen giao (lay tu dia chi nhan hang cua khach)
    purchase_orders: { shipStatus: 'TEXT', carrier: 'TEXT', trackingNo: 'TEXT', shipNote: 'TEXT', shipUpdatedBy: 'TEXT', shipUpdatedAt: 'TEXT' }, // van chuyen tu NCC ve
    buy_checks: { itemIdx: 'INTEGER' }, // dong thu may cua PO nhap tay (PO khong co buy_lines)
    vip_sanpham: { maMach: 'TEXT', rev: 'INTEGER DEFAULT 1' }, // ma mach cua khach + so lan doi thiet ke
    order_items: { folders: 'TEXT', rfqDraft: 'TEXT', vipRev: 'INTEGER', vipProductId: 'INTEGER', materials: 'TEXT', kitAt: 'TEXT', kitBy: 'TEXT', kitNote: 'TEXT', kitCode: 'TEXT' }, // ban giao bo linh kien cho san xuat
    stock_holds: { pickedAt: 'TEXT', pickedBy: 'TEXT', shippedAt: 'TEXT', shippedBy: 'TEXT', shipCode: 'TEXT' },
    brands: { qr_url: 'TEXT', showBankDefault: 'INTEGER DEFAULT 1' },
    customers: { old_debt: 'REAL DEFAULT 0', customerFolderId: 'TEXT' },
    design_jobs: { deadline: 'TEXT', history: `TEXT DEFAULT '[]'`, outputFolderId: 'TEXT' },
    projects: {
        maKH: 'TEXT', project_expenses: 'TEXT', drive_folder_url: 'TEXT', folder_name: 'TEXT',
        type: `TEXT DEFAULT 'Dự án công ty'`, pm_expenses: 'TEXT', company_payments: 'TEXT', profit_ratio: 'INTEGER DEFAULT 50'
    },
    external_projects: { maKH: 'TEXT', payments_guest: 'TEXT', payments_company: 'TEXT' },
    sessions: { uid: 'INTEGER' },
    order_payments: { taiKhoan: 'TEXT' },
    inventory: { unitCost: 'REAL DEFAULT 0', mpn: 'TEXT', package: 'TEXT', image: 'TEXT' },
    so_quy: { taiKhoan: 'TEXT', quy: 'TEXT', chuyenQuy: 'TEXT' },   // chuyenQuy: ma lan cap quy (2 dong CHI / THU cung ma)
    requests_chi: { quy: 'TEXT' },
    orders: {
        vip: 'INTEGER DEFAULT 0', vipBatchNo: 'INTEGER', // lo hang cua khach VIP
        deptFolders: 'TEXT', // JSON { pcb, linhkien, sanxuat, kho, thietke } -> id thu muc bo phan trong "2. OUTPUT"
        soLuongPCB: 'INTEGER DEFAULT 0', soLuongLK: 'INTEGER DEFAULT 0', soLuongGiaCong: 'INTEGER DEFAULT 0',
        ghiChuKyThuat: 'TEXT', giaCostPCB: 'REAL DEFAULT 0', giaCostLK: 'REAL DEFAULT 0', giaCostGiaCong: 'REAL DEFAULT 0',
        folderId: 'TEXT', inputFolderId: 'TEXT', outputFolderId: 'TEXT', documentFolderId: 'TEXT',
        ttChotDon: 'TEXT', lyDoHuy: 'TEXT', hangMucBanGiao: 'TEXT', ttNghiemThu: 'TEXT', noiDungPhatSinh: 'TEXT',
        ttThanhToan: 'TEXT', ttDonHang: 'TEXT', ngayBanGiaoThucTe: 'TEXT', ghiChuNghiemThu: 'TEXT',
        costDetail: 'TEXT', quotePending: 'TEXT', ngayBaoGia: 'TEXT',
        saleName: 'TEXT', brandId: 'INTEGER'   // Sale phu trach va thuong hieu cua don (dung cho bao cao kinh doanh)
    }
};

// Index cho cac cot hay duoc loc / join
const INDEXES = [
    'CREATE INDEX IF NOT EXISTS idx_orders_maKH ON orders(maKH)',
    'CREATE INDEX IF NOT EXISTS idx_orders_maDH ON orders(maDH)',
    'CREATE INDEX IF NOT EXISTS idx_orders_ngayTao ON orders(ngayTao)',
    'CREATE INDEX IF NOT EXISTS idx_orders_chot ON orders(ttChotDon)',
    'CREATE INDEX IF NOT EXISTS idx_orders_loaiDV ON orders(loaiDV)',
    'CREATE INDEX IF NOT EXISTS idx_orders_sale ON orders(saleName)',
    'CREATE INDEX IF NOT EXISTS idx_orders_brand ON orders(brandId)',
    'CREATE INDEX IF NOT EXISTS idx_payments_orderId ON order_payments(orderId)',
    'CREATE INDEX IF NOT EXISTS idx_aliases_norm ON inventory_aliases(aliasNorm)',
    'CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(orderId)',
    'CREATE INDEX IF NOT EXISTS idx_holds_order ON stock_holds(orderId, status)',
    'CREATE INDEX IF NOT EXISTS idx_holds_item ON stock_holds(itemId, status)',
    'CREATE INDEX IF NOT EXISTS idx_buy_order ON buy_lines(orderId)',
    'CREATE INDEX IF NOT EXISTS idx_buy_po ON buy_lines(poId)',
    'CREATE INDEX IF NOT EXISTS idx_dispatch_ws ON dispatches(workshopId, status)',
    'CREATE INDEX IF NOT EXISTS idx_design_orderId ON design_jobs(orderId)',
    'CREATE INDEX IF NOT EXISTS idx_po_orderId ON purchase_orders(orderId)',
    'CREATE INDEX IF NOT EXISTS idx_po_type ON purchase_orders(type)',
    'CREATE INDEX IF NOT EXISTS idx_invtrans_item ON inventory_transactions(itemId)',
    'CREATE INDEX IF NOT EXISTS idx_wo_orderId ON production_orders(orderId)',
    'CREATE INDEX IF NOT EXISTS idx_soquy_ngay ON so_quy(ngay)',
    'CREATE INDEX IF NOT EXISTS idx_soquy_quy ON so_quy(quy)',
    'CREATE INDEX IF NOT EXISTS idx_projects_maKH ON projects(maKH)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions(uid)'
];

async function ensureColumns(table, columns) {
    const existing = new Set((await db.allAsync(`PRAGMA table_info("${table}")`)).map((c) => c.name));
    for (const [name, def] of Object.entries(columns)) {
        if (!existing.has(name)) await db.runAsync(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${def}`);
    }
}

// Chuyen mat khau dang luu chu thuong sang dang bam (chay 1 lan, cac lan sau khong con gi de chuyen).
async function hashPlainPasswords() {
    const users = await db.allAsync('SELECT id, password FROM users');
    let converted = 0;
    for (const u of users) {
        if (u.password && !isHashed(u.password)) {
            await db.runAsync('UPDATE users SET password = ? WHERE id = ?', [hashPassword(u.password), u.id]);
            converted += 1;
        }
    }
    if (converted) console.log(`Da bam ${converted} mat khau dang luu dang chu thuong.`);
}

// Dua loaiDV cua cac don cu ve 2 gia tri chuan: 'rnd' (nghien cuu phat trien) va 'sx' (PCB / linh kien / san xuat).
// Don co so luong PCB/LK/gia cong hoac mang nhan 'pcb-lk-gc' -> sx; con lai (don thiet ke cu) -> rnd.
async function normalizeOrderTypes() {
    const isSx = `(loaiDV = 'pcb-lk-gc' OR COALESCE(soLuongPCB, 0) + COALESCE(soLuongLK, 0) + COALESCE(soLuongGiaCong, 0) > 0)`;
    const legacy = `(loaiDV IS NULL OR loaiDV NOT IN ('rnd', 'sx'))`;
    await db.runAsync(`UPDATE orders SET loaiDV = 'sx' WHERE ${legacy} AND ${isSx}`);
    await db.runAsync(`UPDATE orders SET loaiDV = 'rnd' WHERE ${legacy}`);
}

// Gia kho (gia von binh quan) cho cac ma hang chua co: lay binh quan gia cua cac phieu nhap co don gia.
async function backfillUnitCost() {
    await db.runAsync(`
        UPDATE inventory SET unitCost = COALESCE((
            SELECT SUM(t.quantity * t.unitPrice) / SUM(t.quantity)
            FROM inventory_transactions t
            WHERE t.itemId = inventory.id AND t.type = 'Nhap' AND t.unitPrice > 0 AND t.quantity > 0), 0)
        WHERE COALESCE(unitCost, 0) = 0`);
}

// Gan quy cho cac dong so quy / de nghi chi cu (truoc khi tach 2 quy):
//  - dong thu tien don hang -> theo loai don (don R&D -> quy R&D, con lai -> quy cong ty)
//  - cac dong cu con lai    -> quy R&D (so quy cu do bo phan Thiet ke quan ly va duyet chi)
async function normalizeFunds() {
    await db.runAsync(`
        UPDATE so_quy SET quy = (
            SELECT CASE WHEN o.loaiDV = 'rnd' THEN 'rnd' ELSE 'chung' END
            FROM order_payments p JOIN orders o ON o.id = p.orderId WHERE p.quyId = so_quy.id)
        WHERE quy IS NULL AND id IN (SELECT quyId FROM order_payments)`);
    // "Quy cong ty" cu doi ten thanh "Quy chung"
    await db.runAsync(`UPDATE so_quy SET quy = 'chung' WHERE quy = 'congty'`);
    await db.runAsync(`UPDATE requests_chi SET quy = 'chung' WHERE quy = 'congty'`);
    const keys = `'chung', 'rnd', 'muahang', 'sanxuat'`;
    await db.runAsync(`UPDATE so_quy SET quy = 'rnd' WHERE quy IS NULL OR quy NOT IN (${keys})`);
    await db.runAsync(`UPDATE requests_chi SET quy = 'rnd' WHERE quy IS NULL OR quy NOT IN (${keys})`);
}

async function init() {
    await db.runAsync('PRAGMA journal_mode = WAL');
    await db.runAsync('PRAGMA busy_timeout = 5000');
    for (const sql of TABLES) await db.runAsync(sql);
    for (const [table, cols] of Object.entries(EXTRA_COLUMNS)) await ensureColumns(table, cols);
    for (const sql of INDEXES) await db.runAsync(sql);

    // Ten dang nhap khong duoc trung. Neu du lieu cu dang trung thi chi canh bao, khong chan khoi dong.
    try {
        await db.runAsync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL AND username != ''`);
    } catch (e) {
        console.warn('[CANH BAO] Dang co ten dang nhap bi trung trong bang users, chua tao duoc rang buoc duy nhat.');
    }

    await hashPlainPasswords();
    await normalizeOrderTypes();
    await normalizeFunds();
    // Don da bao gia truoc khi co cot ngayBaoGia: tam lay ngay tao don lam moc tinh so ngay cho
    await db.runAsync(`UPDATE orders SET ngayBaoGia = ngayTao WHERE ngayBaoGia IS NULL AND ttQuyTrinh = 'Đã báo giá'`);
    await backfillUnitCost();
    await require('../utils/orderItems').migrateLegacyOrders(); // nap tre de tranh vong lap require
    await require('../utils/stockHold').backfill();
    await require('../utils/buyLines').backfill();
    await db.runAsync('DELETE FROM sessions WHERE expires < ?', [Date.now()]);
    console.log('Database da san sang.');
}

db.ready = init();

module.exports = db;
