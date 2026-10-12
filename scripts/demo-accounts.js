// Tai khoan mau cho che do demo (mat khau chung: demo123). `home` = trang mo ra khi doi sang vai tro do.
const DEMO_PASSWORD = 'demo123';
const DEMO_ACCOUNTS = [
    { username: 'demo_admin', name: 'Admin Demo',        roles: ['Admin'],                label: 'Admin (toàn quyền)',        home: '/' },
    { username: 'demo_sale',  name: 'Nguyễn Văn Sale',   roles: ['Sale'],                 label: 'Sale 1 — Nguyễn Văn Sale',  home: '/don-hang' },
    { username: 'demo_sale2', name: 'Trần Thị Kinh Doanh', roles: ['Sale'],               label: 'Sale 2 — Trần Thị Kinh Doanh', home: '/don-hang' },
    { username: 'demo_pcb',   name: 'Lê Mua PCB',        roles: ['Mua hàng PCB'],         label: 'Mua hàng PCB',              home: '/bao-gia/pcb' },
    { username: 'demo_lk',    name: 'Phạm Mua Linh Kiện', roles: ['Mua hàng linh kiện'],  label: 'Mua hàng linh kiện',        home: '/bao-gia/linh-kien' },
    { username: 'demo_tbpmh', name: 'Trịnh Trưởng Mua Hàng', roles: ['Trưởng BP Mua hàng'],  label: 'Trưởng BP Mua hàng',        home: '/dieu-hanh-mua-linh-kien' },
    { username: 'demo_qlsx',  name: 'Hoàng Sản Xuất',    roles: ['Quản lý sản xuất'],     label: 'Quản lý sản xuất',          home: '/bao-gia/san-xuat' },
    { username: 'demo_xuong1', name: 'Xưởng Tân Bình',     roles: ['Xưởng sản xuất'],       label: 'Xưởng 1 — Tân Bình',        home: '/xuong' },
    { username: 'demo_xuong2', name: 'Xưởng Thủ Đức',      roles: ['Xưởng sản xuất'],       label: 'Xưởng 2 — Thủ Đức',         home: '/xuong' },
    { username: 'demo_kho',   name: 'Vũ Thủ Kho',        roles: ['Quản lý kho'],          label: 'Quản lý kho',               home: '/dieu-hanh-mua-linh-kien' },
    { username: 'demo_tbp',   name: 'Đỗ Trưởng Thiết Kế', roles: ['Trưởng BP Thiết kế'],  label: 'Trưởng BP Thiết kế (R&D)',  home: '/don-hang/rnd' },
    { username: 'demo_nvtk',  name: 'Bùi Kỹ Sư',         roles: ['Nhân viên Thiết kế'],   label: 'Nhân viên Thiết kế',        home: '/thiet-ke' },
    { username: 'demo_pm',    name: 'Đặng Quản Dự Án',   roles: ['Project Manager'],      label: 'Project Manager',           home: '/du-an' },
    { username: 'demo_kt',    name: 'Ngô Kế Toán',       roles: ['Kế toán'],              label: 'Kế toán',                   home: '/ke-toan' },
    { username: 'demo_hc',    name: 'Lý Hành Chính',     roles: ['Hành chính'],           label: 'Hành chính',                home: '/hanh-chinh' }
];
module.exports = { DEMO_ACCOUNTS, DEMO_PASSWORD };
