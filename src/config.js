// Cau hinh chung cua he thong: bien moi truong, vai tro, phan quyen.
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '../.env'), quiet: true });

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    SESSION_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('[CANH BAO] Chua co SESSION_SECRET trong file .env - dang dung khoa tam, moi phien dang nhap se mat khi khoi dong lai.');
}

const ROLES = {
    ADMIN: 'Admin',
    SALE: 'Sale',
    TBP: 'Trưởng BP Thiết kế',
    NVTK: 'Nhân viên Thiết kế',
    PM: 'Project Manager',
    KT: 'Kế toán',
    HC: 'Hành chính',               // bo phan chung tu: hop dong, PO khach, hoa don, bien ban
    MH_PCB: 'Mua hàng PCB',
    MH_LK: 'Mua hàng linh kiện',
    TBP_MH: 'Trưởng BP Mua hàng',   // co moi quyen cua Mua hang PCB + Mua hang linh kien, them: xu ly don huy, duyet chi Quy Mua hang
    QLSX: 'Quản lý sản xuất',
    KHO: 'Quản lý kho',
    XUONG: 'Xưởng sản xuất'   // tai khoan cua 1 xuong: chi thay viec da dieu phoi cho xuong minh
};
const R = ROLES;

// Trang giao dien -> view + cac vai tro duoc vao (Admin luon duoc vao).
// roles = null nghia la moi tai khoan da dang nhap deu vao duoc.
const PAGES = {
    '/':                   { view: 'dashboard',          roles: null },
    '/dashboard-stats':    { view: 'dashboard',          roles: null },
    '/khach-hang':         { view: 'khach-hang',         roles: [R.SALE] },
    // Quan ly don hang tach 2 muc (cung 1 giao dien, loc theo `orderType`)
    '/don-hang/rnd':       { view: 'don-hang', roles: [R.SALE, R.TBP], locals: { orderType: 'rnd', orderTypeLabel: 'R&D (Nghiên cứu phát triển)' } },
    '/don-hang/san-xuat':  { view: 'don-hang', roles: [R.SALE],        locals: { orderType: 'sx',  orderTypeLabel: 'PCB / Linh kiện / Sản xuất' } },
    '/nhap-xuat-du-lieu':  { view: 'nhap-xuat-du-lieu', roles: null }, // nhap / xuat Excel, txt cho cac danh sach (quyen theo tung danh sach)
    '/hanh-chinh':         { view: 'hanh-chinh', roles: [R.HC, R.KT, R.SALE] }, // chung tu & hop dong cua don da chot
    '/giao-hang':          { view: 'giao-hang', roles: [R.KHO, R.SALE, R.QLSX, R.MH_LK, R.MH_PCB, R.KT] }, // giao hang cho khach, theo doi van chuyen
    '/don-hang/vip':       { view: 'don-hang-vip', roles: [R.SALE, R.QLSX, R.MH_LK, R.KHO] },
    // Bao gia cost tach theo bo phan (cung 1 giao dien, loc theo `dept`)
    '/bao-gia/pcb':        { view: 'bao-gia', roles: [R.MH_PCB], locals: { dept: 'pcb', deptLabel: 'PCB' } },
    '/bao-gia/linh-kien':  { view: 'bao-gia', roles: [R.MH_LK],  locals: { dept: 'lk',  deptLabel: 'linh kiện' } },
    '/bao-gia/san-xuat':   { view: 'bao-gia', roles: [R.QLSX],   locals: { dept: 'sx',  deptLabel: 'sản xuất' } },
    '/bao-gia/rnd':        { view: 'bao-gia', roles: [R.TBP],    locals: { dept: 'rnd', deptLabel: 'nghiên cứu phát triển' } },
    '/reports':            { view: 'reports',            roles: [R.SALE, R.KT] },
    '/thiet-ke':           { view: 'thiet-ke',           roles: [R.TBP, R.NVTK] },
    '/du-an':              { view: 'du-an',              roles: [R.TBP, R.PM] },
    '/mua-hang-pcb':       { view: 'mua-hang-pcb',       roles: [R.MH_PCB, R.QLSX] },
    '/mua-hang-linh-kien': { view: 'mua-hang-linh-kien', roles: [R.MH_LK, R.QLSX] },
    '/dieu-hanh-mua-linh-kien': { view: 'dieu-hanh-mua-linh-kien', roles: [R.MH_LK, R.QLSX, R.KHO] },
    '/soan-linh-kien':     { view: 'soan-linh-kien',     roles: [R.KHO, R.QLSX, R.MH_LK, R.MH_PCB] }, // kho soan linh kien lay tu kho cho don da chot (kho = nguon mua noi bo)
    '/quan-ly-kho':        { view: 'quan-ly-kho',        roles: [R.KHO, R.QLSX, R.MH_PCB, R.MH_LK] },
    '/quan-ly-san-xuat':   { view: 'quan-ly-san-xuat',   roles: [R.QLSX] },
    '/dieu-phoi-san-xuat': { view: 'dieu-phoi-san-xuat', roles: [R.QLSX] },
    '/xuong':              { view: 'xuong',              roles: [R.XUONG, R.QLSX] },
    '/ke-toan':            { view: 'ke-toan',            roles: [R.KT] },
    '/quan-ly-quy':        { view: 'quan-ly-quy',        roles: [R.KT, R.TBP, R.MH_PCB, R.MH_LK, R.QLSX] },
    '/settings/system':    { view: 'system-settings',    roles: [] },
    '/settings/brand':     { view: 'brand-settings',     roles: [] },
    '/tai-khoan':          { view: 'tai-khoan',          roles: [] }
};

// Hai loai don hang (cot orders.loaiDV)
//  - rnd: Nghien cuu phat trien -> di luong Thiet ke (tu sinh dau viec thiet ke khi chot)
//  - sx : PCB / Linh kien / San xuat -> di luong Mua hang, Kho, San xuat
const ORDER_TYPES = { RND: 'rnd', SX: 'sx' };
// Noi nhan tien cua khach: tai khoan cong ty (don xuat VAT) hoac tai khoan ca nhan (don khong xuat VAT)
const PAYMENT_ACCOUNTS = { congty: 'TK công ty', canhan: 'TK cá nhân' };
// Bon quy: Quy chung cap tien cho quy cua cac phong (R&D, Mua hang, San xuat).
// Tien khach tra don R&D vao Quy R&D; don PCB / linh kien / san xuat vao Quy chung.
const FUNDS = { chung: 'Quỹ chung', rnd: 'Quỹ R&D', muahang: 'Quỹ phòng Mua hàng', sanxuat: 'Quỹ Sản xuất' };
const GENERAL_FUND = 'chung';
// Vai tro duoc xem / ghi so va duoc duyet chi cua tung quy (Admin luon duoc; Ke toan xem / ghi so moi quy)
const FUND_ROLES = {
    chung:   { use: [],                   approve: [] },
    rnd:     { use: [R.TBP],              approve: [R.TBP] },
    muahang: { use: [R.MH_PCB, R.MH_LK],  approve: [R.TBP_MH] },
    sanxuat: { use: [R.QLSX],             approve: [R.QLSX] }
};
// Don chua chot qua so ngay nay se duoc canh bao de Sale kiem tra va chuyen trang thai (kho van tam xuat cho toi khi don Khong chot / Huy)
const PENDING_WARN_DAYS = parseInt(process.env.PENDING_WARN_DAYS, 10) || 10;
// Chung tu cua don hang ma Sale va Ke toan cung theo doi. Trang thai dau tien la mac dinh;
// `done` = cac trang thai coi nhu da xong (khong con canh bao).
const ORDER_DOCS = {
    hopdong: { label: 'Hợp đồng', statuses: ['Chưa có', 'Đã soạn', 'Đã gửi khách', 'Đã ký', 'Không cần'], done: ['Đã ký', 'Không cần'] },
    po:      { label: 'PO khách hàng', statuses: ['Chưa có', 'Đã nhận', 'Không cần'], done: ['Đã nhận', 'Không cần'] },
    hoadon:  { label: 'Hóa đơn',  statuses: ['Chưa xuất', 'Đã xuất', 'Đã gửi khách', 'Không xuất'], done: ['Đã xuất', 'Đã gửi khách', 'Không xuất'] },
    bienban: { label: 'Biên bản bàn giao / nghiệm thu', statuses: ['Chưa có', 'Đã gửi khách', 'Đã ký', 'Không cần'], done: ['Đã ký', 'Không cần'] }
};
// Don co VAT tu muc nay tro len moi can hop dong; duoi muc nay chi can PO cua khach. Don VAT 0% khong can ca hai.
const CONTRACT_MIN_VALUE = parseInt(process.env.CONTRACT_MIN_VALUE, 10) || 20000000;
const ORDER_TYPE_LABELS = { rnd: 'Nghiên cứu phát triển', sx: 'PCB / Linh kiện / Sản xuất' };

// Nhom vai tro dung cho API
const PERMS = {
    CUSTOMER_READ:  [R.SALE, R.TBP, R.PM, R.KT],
    CUSTOMER_WRITE: [R.SALE],
    ORDER_READ:     [R.SALE, R.TBP, R.KT],
    ORDER_WRITE:    [R.SALE, R.TBP],
    ORDER_COST:     [R.MH_PCB, R.MH_LK, R.QLSX, R.TBP],   // cac bo phan bao gia cost (Sale khong tu nhap cost)
    ADMIN_DOCS:     [R.HC, R.KT, R.SALE],                 // trang Hanh chinh: xem va soan chung tu
    ORDER_DOCS:     [R.KT, R.SALE, R.HC],                       // cap nhat trang thai hop dong, hoa don, bien ban
    ORDER_PAYMENT:  [R.KT, R.SALE],                       // ghi nhan thu tien don hang (ca Sale va Ke toan)
    ORDER_CONFIRMED:[R.SALE, R.TBP, R.MH_PCB, R.MH_LK, R.QLSX, R.KHO, R.KT],
    DESIGN:         [R.TBP, R.NVTK],
    DESIGN_MANAGE:  [R.TBP],
    PROJECT:        [R.TBP, R.PM],
    REPORT:         [R.SALE, R.KT],
    FUND_VIEW:      [R.KT, R.TBP, R.MH_PCB, R.MH_LK, R.QLSX],   // moi nguoi chi thay quy cua phong minh (xem FUND_ROLES)
    FUND_MANAGE:    [R.KT, R.TBP, R.MH_PCB, R.MH_LK, R.QLSX],
    FUND_TRANSFER:  [R.KT],                                  // cap quy tu Quy chung cho quy cac phong
    FUND_APPROVE:   [R.TBP],          // TBP Thiet ke duyet chi quy R&D; quy cong ty chi Admin duyet (kiem tra trong fundController)
    PURCHASE_READ:  [R.MH_PCB, R.MH_LK, R.QLSX, R.KT, R.KHO],
    PURCHASE_WRITE: [R.MH_PCB, R.MH_LK, R.QLSX],
    VIP:            [R.SALE, R.QLSX, R.MH_LK, R.KHO],   // xem don khach VIP, kiem tra vat tu cua lo
    VIP_MANAGE:     [R.SALE, R.QLSX, R.MH_LK],          // khai bao san pham VIP + BOM chuan
    VIP_LOT:        [R.SALE, R.QLSX],                   // tao lo hang
    MATERIALS:      [R.QLSX, R.KHO, R.MH_PCB, R.MH_LK], // cap nhat tinh trang vat tu san xuat (PCB / linh kien khach cap, stencil)
    DISPATCH:       [R.QLSX],                          // dieu phoi don cho cac xuong, quan ly danh sach xuong
    WORKSHOP:       [R.XUONG, R.QLSX],                 // xem / cap nhat viec cua xuong
    DELIVERY:       [R.KHO, R.SALE, R.QLSX, R.MH_LK, R.MH_PCB, R.KT], // xem giao hang
    DELIVERY_WRITE: [R.KHO, R.SALE, R.QLSX],                           // tao / cap nhat chuyen giao
    STOCK_CONFIRM:  [R.KHO],                                           // Kho xac nhan con hang cho bao gia
    BUYING:         [R.MH_LK, R.QLSX, R.KHO],          // dieu hanh mua linh kien: xem, nhan hang, ghep bo
    BUYING_RESOLVE: [R.TBP_MH],                        // xu ly dong mua / hang giu cua don da chot bi huy (Admin luon duoc)
    BUYING_ORDER:   [R.MH_LK, R.QLSX],                 // chon NCC, tao PO
    PICKING:        [R.MH_LK, R.MH_PCB, R.KHO, R.QLSX], // soan + xuat linh kien theo don
    INVENTORY:      [R.KHO, R.QLSX, R.MH_PCB, R.MH_LK],
    PRODUCTION:     [R.QLSX],
    DEBT_VIEW:      [R.SALE, R.KT],
    ADMIN_ONLY:     []
};

// Truong BP Mua hang ke thua moi quyen cua 2 vai tro mua hang (trang, API, quy)
for (const list of [...Object.values(PAGES).map((p) => p.roles), ...Object.values(PERMS), ...Object.values(FUND_ROLES).map((f) => f.use)]) {
    if (Array.isArray(list) && (list.includes(R.MH_PCB) || list.includes(R.MH_LK)) && !list.includes(R.TBP_MH)) list.push(R.TBP_MH);
}

module.exports = {
    PORT: parseInt(process.env.PORT, 10) || 3000,
    SESSION_SECRET,
    DB_PATH: process.env.DB_PATH || path.join(__dirname, '../htech.db'),
    GOOGLE_KEYFILE: process.env.GOOGLE_KEYFILE || path.join(__dirname, '../credentials.json'),
    COOKIE_SECURE: process.env.COOKIE_SECURE === 'true',
    CONTRACT_MIN_VALUE,
    DEMO_MODE: process.env.DEMO_MODE === '1', // chi bat khi chay `npm run demo` (du lieu mau, doi vai tro nhanh)
    ROLES,
    ALL_ROLES: Object.values(ROLES),
    ORDER_TYPES,
    ORDER_TYPE_LABELS,
    PAYMENT_ACCOUNTS,
    ORDER_DOCS,
    PENDING_WARN_DAYS,
    FUNDS,
    GENERAL_FUND,
    FUND_ROLES,
    PAGES,
    PERMS
};
