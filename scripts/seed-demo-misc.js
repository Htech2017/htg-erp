// Du lieu mau: 4 quy (ton dau, cap quy, thu chi, de nghi chi cho duyet / da duyet) va du an.
module.exports = async function seedMisc(ctx) {
    const { day, post, cust } = ctx;
    const fund = (u, loai, quy, tien, hangMuc, note) => post(u, '/api/fund/transaction', { loai, quy, tien, hangMuc, note, ngay: day(-20) });
    await fund('demo_kt', 'THU', 'chung', 300000000, 'TỒN ĐẦU', 'Khởi tạo quỹ');
    await post('demo_kt', '/api/fund/transfer', { from: 'chung', to: 'rnd', tien: 40000000, ngay: day(-18), note: 'Cấp quỹ tháng' });
    await post('demo_kt', '/api/fund/transfer', { from: 'chung', to: 'muahang', tien: 80000000, ngay: day(-18), note: 'Cấp quỹ tháng' });
    await post('demo_kt', '/api/fund/transfer', { from: 'chung', to: 'sanxuat', tien: 30000000, ngay: day(-18), note: 'Cấp quỹ tháng' });
    await post('demo_kt', '/api/fund/transfer', { from: 'sanxuat', to: 'chung', tien: 5000000, ngay: day(-5), note: 'Hoàn quỹ chưa dùng' });
    await fund('demo_kt', 'CHI', 'chung', 15000000, 'Tiền thuê văn phòng', 'Tháng này');
    await fund('demo_tbp', 'CHI', 'rnd', 3500000, 'Mua kit phát triển', 'Kit STM32 + LoRa');
    await fund('demo_lk', 'CHI', 'muahang', 12000000, 'Thanh toán linh kiện', 'Thế Giới Chip');
    await fund('demo_pcb', 'CHI', 'muahang', 5400000, 'Thanh toán PCB', 'JLCPCB');
    await fund('demo_qlsx', 'CHI', 'sanxuat', 2200000, 'Mua thiếc hàn, flux', '');
    const req = (u, quy, tien, noiDung) => post(u, '/api/fund/request', { quy, tien, noiDung, ngay: day(-2) });
    const r1 = await req('demo_tbp', 'rnd', 6000000, 'Mua máy hiện sóng cũ');
    await req('demo_tbp', 'rnd', 1200000, 'Phí in mạch mẫu');
    await req('demo_lk', 'muahang', 9000000, 'Đặt cọc lô ESP32');
    const r4 = await req('demo_qlsx', 'sanxuat', 4500000, 'Bảo trì máy gắp chip');
    await req('demo_kt', 'chung', 20000000, 'Thưởng quý cho nhân viên');
    await post('demo_tbp', '/api/fund/approve', { id: r1.newId });   // Truong BP Thiet ke duyet quy R&D
    await post('demo_qlsx', '/api/fund/approve', { id: r4.newId });  // Quan ly san xuat duyet quy San xuat

    // ---------- Khach VIP: 2 san pham co BOM chuan + 1 lo dang lam ----------
    const inv = await ctx.db.allAsync('SELECT id, itemCode FROM inventory');
    const idOf = (code) => (inv.find((i) => i.itemCode === code) || {}).id;
    const vipBom = [
        { itemId: idOf('C100NF-0603'), name: 'C100NF-0603', perSet: 6, buyPrice: 50, supplier: 'LCSC' },
        { itemId: idOf('R10K-0603'), name: 'R10K-0603', perSet: 10, buyPrice: 25, supplier: 'LCSC' },
        { itemId: idOf('ESP32-WROOM-32E'), name: 'ESP32-WROOM-32E', perSet: 1, buyPrice: 70000, supplier: 'Mouser' },
        { itemId: idOf('CONN-USB-C16'), name: 'CONN-USB-C16', perSet: 1, buyPrice: 2600, supplier: 'LCSC' }
    ];
    const vp1 = (await post('demo_lk', '/api/vip/products/save', { maKH: cust.A, maMach: 'HTV-WF3', tenMach: 'Bộ điều khiển WiFi V3', coPCB: 1, coLK: 1, coSX: 1, giaPCB: 18000, giaGiaCong: 12000, giaBan: 165000, bom: vipBom, ghiChu: 'Đặt đều mỗi tháng' })).id;
    const vp2 = (await post('demo_lk', '/api/vip/products/save', { maKH: cust.A, maMach: 'HTV-PSU5', tenMach: 'Mạch nguồn phụ 5V', coPCB: 0, coLK: 1, coSX: 1, giaGiaCong: 6000, giaBan: 42000,
        bom: [{ itemId: idOf('AMS1117-3.3'), name: 'AMS1117-3.3', perSet: 1, buyPrice: 2000, supplier: 'LCSC' }, { itemId: idOf('C100NF-0603'), name: 'C100NF-0603', perSet: 4, buyPrice: 50, supplier: 'LCSC' }, { itemId: idOf('1N4148-SOD323'), name: '1N4148-SOD323', perSet: 2, buyPrice: 150, supplier: 'LCSC' }] })).id;
    await post('demo_sale', '/api/vip/lots', { maKH: cust.A, items: [{ productId: vp1, qty: 80 }, { productId: vp2, qty: 120 }], ngayBanGiao: day(12), vat: 8, note: 'Lô tháng này' });
    // Sau khi tao lo, khach doi thiet ke ma mach HTV-PSU5 -> rev 2 (lo cu van ghi rev 1 va duoc canh bao)
    await post('demo_lk', '/api/vip/products/save', { id: vp2, maKH: cust.A, maMach: 'HTV-PSU5', tenMach: 'Mạch nguồn phụ 5V', coPCB: 0, coLK: 1, coSX: 1, giaGiaCong: 6000, giaBan: 42000, changeNote: 'Khách đổi diode 1N4148 từ 2 con lên 3 con, thêm 1 tụ 100nF lọc nguồn',
        bom: [{ itemId: idOf('AMS1117-3.3'), name: 'AMS1117-3.3', perSet: 1, buyPrice: 2000, supplier: 'LCSC' }, { itemId: idOf('C100NF-0603'), name: 'C100NF-0603', perSet: 5, buyPrice: 50, supplier: 'LCSC' }, { itemId: idOf('1N4148-SOD323'), name: '1N4148-SOD323', perSet: 3, buyPrice: 150, supplier: 'LCSC' }] });

    await post('demo_pm', '/api/projects/save', { name: 'Hệ thống giám sát trạm bơm', type: 'Dự án công ty', maKH: cust.B, leader: 'Đặng Quản Dự Án', status: 'Đang thực hiện', contractValue: 450000000, start: day(-60), end: day(60), profit_ratio: 50 });
    await post('demo_pm', '/api/projects/save', { name: 'Thiết bị đo pin cầm tay', type: 'Dự án công ty', maKH: cust.D, leader: 'Đặng Quản Dự Án', status: 'Khởi tạo', contractValue: 180000000, start: day(-5), end: day(120), profit_ratio: 60 });
};
