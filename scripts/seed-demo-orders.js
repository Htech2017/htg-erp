// Du lieu mau: 15 don hang phu het cac giai doan cua quy trinh (xem ghi chu "DEMO n" tren tung don).
module.exports = async function seedOrders({ ws1, ws2, db, day, post, patch, api, cust, sup, item, line1, RATES, brandA, brandB }) {
    const bomOf = (n) => [ // bang vat tu cho n bo mach: ma du kho, ma het hang phai mua, ma khong co trong kho
        { itemId: item['C100NF-0603'], need: 10 * n, perSet: 10, buyPrice: 50, supplier: 'LCSC' },
        { itemId: item['R10K-0603'], need: 8 * n, perSet: 8, buyPrice: 25, supplier: 'LCSC' },
        { itemId: item['STM32F103C8T6'], need: n, perSet: 1, buyPrice: 35000, supplier: 'Digikey' },
        { itemId: item['AMS1117-3.3'], need: n, perSet: 1, buyPrice: 2000, supplier: 'Mouser' },
        { itemId: item['LED-RED-0603'], need: 2 * n, perSet: 2, buyPrice: 180, supplier: 'LCSC' },
        { name: 'Thạch anh 8MHz HC49 (chưa có trong kho)', need: n, perSet: 1, buyPrice: 1500, unit: 'con' } // chua chon NCC -> chon o trang Dieu hanh mua
    ];
    async function newOrder(sale, o) {
        const r = await post(sale, '/api/orders/save', { ngayTao: day(o.ago ? -o.ago : -3), leadtime: 14, vat: 0, chietKhau: 0, heSoSale: 1.3, ...o });
        const lines = await db.allAsync('SELECT id, tenMach, soLuongPCB, soLuongLK, soLuongGiaCong FROM order_items WHERE orderId = ? ORDER BY stt', [r.id]);
        return { id: r.id, maDH: r.maDH, lines };
    }
    // Bao gia cost tung loai mach: PCB nhap tay, linh kien theo bang vat tu (tam xuat kho), san xuat theo diem han
    async function quote(order, { pcb = true, lk = true, sx = true } = {}) {
        for (const l of order.lines) {
            if (pcb && l.soLuongPCB > 0) await patch('demo_pcb', `/api/orders/${order.id}/cost`, { lineId: l.id, giaCostPCB: 45000 * l.soLuongPCB + 500000 });
            if (lk && l.soLuongLK > 0) await patch('demo_lk', `/api/orders/${order.id}/cost`, { lineId: l.id, detail: { giaCostLK: bomOf(l.soLuongLK) } });
            if (sx && l.soLuongGiaCong > 0) await patch('demo_qlsx', `/api/orders/${order.id}/cost`, { lineId: l.id, assembly: { counts: { smdPads: 180, thtPads: 24, icCount: 3 }, rates: RATES, source: 'Ước lượng từ BOM' } });
        }
    }
    const costOf = async (id) => { const o = await db.getAsync('SELECT * FROM orders WHERE id = ?', [id]); return (o.giaCostPCB || 0) + (o.giaCostLK || 0) + (o.giaCostGiaCong || 0) + (o.giaThietKe || 0); };
    async function sendQuote(sale, order, heSo = 1.3) {
        const giaBao = Math.round(await costOf(order.id) * heSo / 1000) * 1000;
        await patch(sale, `/api/orders/${order.id}/status`, { heSoSale: heSo, giaBao, ttQuyTrinh: 'Đã báo giá' });
    }
    const confirm = (sale, order) => patch(sale, `/api/orders/${order.id}/status`, { ttChotDon: 'Đã chốt' });
    const conNo = async (order) => (await api('demo_kt', 'GET', '/api/orders')).find((o) => o.id === order.id).conNo;
    const pay = (who, order, soTien, ghiChu) => post(who, `/api/orders/${order.id}/payments`, { soTien, ghiChu });
    const payPart = async (who, order, ratio, ghiChu) => pay(who, order, Math.round(await conNo(order) * ratio), ghiChu);
    const doc = (who, order, loai, body) => api(who, 'PUT', `/api/orders/${order.id}/documents/${loai}`, body);
    const board = (tenMach, pcb, lk, sx) => ({ tenMach, soLuongPCB: pcb, soLuongLK: lk, soLuongGiaCong: sx });
    // Kiem hang ve (du so luong, dung loai) lam o khau Mua hang: /api/purchase/check/<PO>
    const recv = async (lines) => { for (const x of lines) { const l = await db.getAsync('SELECT id, poId, qtyNeed FROM buy_lines WHERE id = ?', [x.id]); if (l && l.poId) await post('demo_lk', `/api/purchase/check/${l.poId}`, { items: [{ key: l.id, qty: l.qtyNeed }] }); } };
    const shipAll = async (order) => { await post('demo_kho', `/api/purchase/picking/order/${order.id}/pick-all`); await post('demo_kho', `/api/purchase/picking/order/${order.id}/ship`); };

    // Mua du, hang ve du (don da giao): chon NCC con thieu -> tao PO -> nhan du; roi ban giao bo linh kien
    async function buyAll(order) {
        const ls = await db.allAsync('SELECT * FROM buy_lines WHERE orderId = ? ORDER BY id', [order.id]);
        if (!ls.length) return;
        for (const l of ls.filter((x) => !x.supplierId)) await patch('demo_lk', `/api/buying/lines/${l.id}`, { supplierName: 'Linh kiện Thế Giới Chip' });
        await post('demo_lk', '/api/buying/po', { lineIds: ls.map((l) => l.id), expectedDate: day(-20) });
        await recv(ls);
    }
    const handoffAll = async (order) => { for (const l of order.lines.filter((x) => x.soLuongLK > 0)) await post('demo_kho', `/api/buying/kit/${l.id}`, { note: '' }); };

    // 1. Moi tao, chua bo phan nao bao gia (2 loai mach)
    await newOrder('demo_sale', { loaiDV: 'sx', maKH: cust.A, brandId: brandA, ago: 1, noteDH: 'DEMO 1: mới tạo, chờ cả 3 bộ phận báo giá', items: [board('Mạch điều khiển V1', 50, 50, 50), board('Mạch nguồn 5V', 50, 50, 0)] });
    // 2. Bao gia do dang: PCB xong, con cho linh kien + san xuat
    const o2 = await newOrder('demo_sale2', { loaiDV: 'sx', maKH: cust.B, brandId: brandB, ago: 2, noteDH: 'DEMO 2: PCB đã báo giá, còn chờ linh kiện và sản xuất', items: [board('Gateway LoRa', 100, 100, 100)] });
    await quote(o2, { lk: false, sx: false });
    // 3. Du bao gia cost, cho Sale nhan he so (kho dang tam xuat)
    const o3 = await newOrder('demo_sale', { loaiDV: 'sx', maKH: cust.C, brandId: brandA, ago: 3, noteDH: 'DEMO 3: đủ cost, chờ Sale nhân hệ số và báo khách', items: [board('Mạch đo nhiệt độ', 20, 20, 20)] });
    await quote(o3);
    // 4. Da bao khach, dang cho phan hoi (trong han)
    const o4 = await newOrder('demo_sale2', { loaiDV: 'sx', maKH: cust.A, brandId: brandA, ago: 4, vat: 8, noteDH: 'DEMO 4: đã báo khách, chờ phản hồi', items: [board('Mạch cảm biến khí', 30, 30, 30)] });
    await quote(o4); await sendQuote('demo_sale2', o4, 1.35);
    // 5. Da bao khach 15 ngay chua chot -> canh bao qua han, kho van dang tam xuat
    const o5 = await newOrder('demo_sale', { loaiDV: 'sx', maKH: cust.D, brandId: brandB, ago: 18, noteDH: 'DEMO 5: báo giá quá 10 ngày chưa chốt (cảnh báo)', items: [board('Mạch driver motor', 25, 25, 0)] });
    await quote(o5); await sendQuote('demo_sale', o5, 1.25);
    await db.runAsync('UPDATE orders SET ngayBaoGia = ? WHERE id = ?', [day(-15), o5.id]);
    // 6. Khach khong chot -> tai nhap kho
    const o6 = await newOrder('demo_sale', { loaiDV: 'sx', maKH: cust.B, brandId: brandA, ago: 12, noteDH: 'DEMO 6: khách không chốt, kho đã tái nhập', items: [board('Mạch hiển thị LED', 40, 40, 40)] });
    await quote(o6); await sendQuote('demo_sale', o6);
    await patch('demo_sale', `/api/orders/${o6.id}/status`, { ttChotDon: 'Không chốt', lyDoHuy: 'Giá cao hơn đối thủ' });
    // 7. Huy don khi dang bao gia
    const o7 = await newOrder('demo_sale2', { loaiDV: 'sx', maKH: cust.C, brandId: brandB, ago: 9, noteDH: 'DEMO 7: đơn hủy', items: [board('Mạch test jig', 5, 5, 5)] });
    await quote(o7, { sx: false });
    await patch('demo_sale2', `/api/orders/${o7.id}/status`, { ttQuyTrinh: 'Hủy đơn', lyDoHuy: 'Khách dừng dự án' });
    // 8. Da chot, chua soan hang, chua thu tien; PO cho duyet; hop dong da ky
    const o8 = await newOrder('demo_sale', { loaiDV: 'sx', maKH: cust.A, brandId: brandA, ago: 6, vat: 8, noteDH: 'DEMO 8: VAT trên 20 triệu (cần hợp đồng), đã chốt, chưa soạn, chưa thu tiền', items: [board('Mạch IoT node', 150, 150, 150), board('Mạch sạc pin', 150, 150, 0)] });
    await quote(o8); await sendQuote('demo_sale', o8); await confirm('demo_sale', o8);
    await doc('demo_sale', o8, 'hopdong', { trangThai: 'Đã ký', so: 'HĐ-2610-008', ngay: day(-2) });
    await post('demo_pcb', '/api/purchase/orders/save', { orderId: o8.id, maDH: o8.maDH, type: 'PCB', supplierId: sup.pcb.id, supplierName: sup.pcb.name, items: [{ name: 'PCB Mạch IoT node', qty: 150, price: 45000 }, { name: 'PCB Mạch sạc pin', qty: 150, price: 45000 }], totalAmount: 13500000, status: 'Chờ duyệt', expectedDate: day(10) });
    // 9. Da chot, dang soan do dang, tam ung 30%; PO dang giao; lenh san xuat dang chay
    const o9 = await newOrder('demo_sale2', { loaiDV: 'sx', maKH: cust.D, brandId: brandB, ago: 10, noteDH: 'DEMO 9: đã chốt, đang soạn linh kiện, đã tạm ứng 30%', items: [board('Mạch điều khiển robot', 10, 10, 10)] });
    await quote(o9); await sendQuote('demo_sale2', o9, 1.4); await confirm('demo_sale2', o9);
    await payPart('demo_sale2', o9, 0.3, 'Tạm ứng 30%');
    const holds9 = await db.allAsync(`SELECT id FROM stock_holds WHERE orderId = ? AND status = 'issued' ORDER BY id`, [o9.id]);
    for (const h of holds9.slice(0, 2)) await patch('demo_kho', `/api/purchase/picking/${h.id}`, { picked: true });
    // Mua linh kien don 9: dat het (NCC nao chua co thi chon), hang ve mot phan
    const buy9 = await db.allAsync('SELECT * FROM buy_lines WHERE orderId = ? ORDER BY id', [o9.id]);
    for (const l of buy9.filter((x) => !x.supplierId)) await patch('demo_lk', `/api/buying/lines/${l.id}`, { supplierName: 'Linh kiện Thế Giới Chip' });
    await post('demo_lk', '/api/buying/po', { lineIds: buy9.map((l) => l.id), expectedDate: day(3), note: 'Đặt cho đơn robot' });
    if (buy9[0]) await recv([buy9[0]]);
    await post('demo_qlsx', '/api/production/work-orders/save', { orderId: o9.id, maDH: o9.maDH, productName: 'Mạch điều khiển robot', quantity: 10, lineId: line1, lineName: 'Chuyền SMT 1', assignedTo: 'Hoàng Sản Xuất', startDate: day(-1), expectedDate: day(5), status: 'Đang sản xuất', progress: 40 });
    // 10. Da chot, da xuat kho, da giao nhung con no -> Cho thu tien; hoa don da xuat
    const o10 = await newOrder('demo_sale', { loaiDV: 'sx', maKH: cust.B, brandId: brandA, ago: 25, vat: 8, noteDH: 'DEMO 10: đã giao, còn công nợ (chờ thu tiền)', items: [board('Mạch gateway 4G', 10, 10, 10)] });
    await quote(o10); await sendQuote('demo_sale', o10); await confirm('demo_sale', o10);
    await buyAll(o10); await shipAll(o10); await handoffAll(o10);
    await payPart('demo_kt', o10, 0.5, 'Thanh toán đợt 1 (50%)');
    await patch('demo_sale', `/api/orders/${o10.id}/status`, { ttDonHang: 'Hoàn thành' });
    await doc('demo_kt', o10, 'hoadon', { trangThai: 'Đã xuất', so: '0000123', ngay: day(-4) });
    await doc('demo_sale', o10, 'po', { trangThai: 'Đã nhận', so: 'PO-SV-0925', ngay: day(-22) }); // VAT duoi 20 trieu: chi can PO
    await doc('demo_sale', o10, 'bienban', { trangThai: 'Đã gửi khách', ngay: day(-3) });
    // 11. Hoan thanh, thu du, du chung tu; PO da nhan; lenh san xuat xong
    const o11 = await newOrder('demo_sale2', { loaiDV: 'sx', maKH: cust.A, brandId: brandB, ago: 40, vat: 8, noteDH: 'DEMO 11: hoàn thành, đã thu đủ, đủ chứng từ', items: [board('Mạch nguồn 12V', 20, 20, 20)] });
    await quote(o11); await sendQuote('demo_sale2', o11, 1.3); await confirm('demo_sale2', o11);
    await buyAll(o11); await shipAll(o11); await handoffAll(o11);
    await payPart('demo_sale2', o11, 0.4, 'Tạm ứng 40%');
    await payPart('demo_kt', o11, 1, 'Thanh toán phần còn lại');
    await patch('demo_sale2', `/api/orders/${o11.id}/status`, { ttDonHang: 'Hoàn thành', ttQuyTrinh: 'Hoàn thành' });
    await doc('demo_sale2', o11, 'po', { trangThai: 'Đã nhận', so: 'PO-MA-0811', ngay: day(-38) });
    await doc('demo_kt', o11, 'hoadon', { trangThai: 'Đã gửi khách', so: '0000098', ngay: day(-12) });
    await doc('demo_sale2', o11, 'bienban', { trangThai: 'Đã ký', ngay: day(-12) });
    await post('demo_pcb', '/api/purchase/orders/save', { orderId: o11.id, maDH: o11.maDH, type: 'PCB', supplierId: sup.pcb.id, supplierName: sup.pcb.name, items: [{ name: 'PCB Mạch nguồn 12V', qty: 20, price: 45000 }], totalAmount: 900000, status: 'Đã nhận', expectedDate: day(-25) });
    await post('demo_qlsx', '/api/production/work-orders/save', { orderId: o11.id, maDH: o11.maDH, productName: 'Mạch nguồn 12V', quantity: 20, lineId: line1, lineName: 'Chuyền SMT 1', assignedTo: 'Hoàng Sản Xuất', startDate: day(-24), expectedDate: day(-14), status: 'Hoàn thành', progress: 100 });

    // 16. Da chot, da dat mua, hang ve 1 phan roi KHACH HUY -> Truong BP Mua hang xu ly dong mua + hang giu
    const o16 = await newOrder('demo_sale', { loaiDV: 'sx', maKH: cust.C, brandId: brandA, ago: 8, noteDH: 'DEMO 16: đã chốt, đã đặt mua rồi khách hủy (cần Trưởng BP Mua hàng xử lý)', items: [board('Mạch điều khiển đèn', 10, 10, 0)] });
    await quote(o16); await sendQuote('demo_sale', o16); await confirm('demo_sale', o16);
    const buy16 = (await db.allAsync('SELECT * FROM buy_lines WHERE orderId = ? ORDER BY id', [o16.id])).filter((l) => l.supplierId);
    if (buy16.length) {
        await post('demo_lk', '/api/buying/po', { lineIds: buy16.map((l) => l.id), expectedDate: day(4) });
        await recv([buy16[0]]);
    }
    await patch('demo_sale', `/api/orders/${o16.id}/status`, { ttQuyTrinh: 'Hủy đơn', lyDoHuy: 'Khách đổi thiết kế' });

    // Dieu phoi san xuat: don 9 -> xuong 1 (dang lam 40%), don 10 -> xuong 2 (xong), don 11 -> xuong 1 (xong); don 8 de CHO dieu phoi
    const dispatch = async (order, wsId, days, account, upd) => {
        for (const l of order.lines.filter((x) => x.soLuongGiaCong > 0)) {
            const d = await post('demo_qlsx', '/api/dispatch/assign', { lineId: l.id, workshopId: wsId, expectedDate: day(days), note: 'Ưu tiên test 100% trước khi giao' });
            if (upd) await patch(account, `/api/dispatch/mine/${d.id}`, upd(l));
        }
    };
    await dispatch(o9, ws1, -1, 'demo_xuong1', (l) => ({ status: 'Đang sản xuất', doneQty: Math.round(l.soLuongGiaCong * 0.4), workshopNote: 'Đang chờ nốt linh kiện' }));
    await dispatch(o10, ws2, -6, 'demo_xuong2', () => ({ status: 'Hoàn thành' }));
    await dispatch(o11, ws1, -14, 'demo_xuong1', () => ({ status: 'Hoàn thành' }));

    // 17. Chi dat SAN XUAT: khach cap 100% PCB va linh kien
    const o17 = await newOrder('demo_sale2', { loaiDV: 'sx', maKH: cust.C, ago: 7, noteDH: 'DEMO 17: chỉ gia công, khách cấp 100% PCB và linh kiện', items: [board('Mạch đèn LED khách cấp vật tư', 0, 0, 200)] });
    await quote(o17); await sendQuote('demo_sale2', o17, 1.3); await confirm('demo_sale2', o17);
    await api('demo_qlsx', 'PATCH', `/api/dispatch/materials/${o17.lines[0].id}`, { pcbKhach: 'Đã nhận đủ', lkKhach: 'Nhận một phần', stencil: 'Đã đặt', note: 'Khách hẹn gửi nốt tụ trở trong tuần' });
    // 18. Dat linh kien + san xuat, khach cap 1 PHAN linh kien (MCU khach gui), PCB khach cap
    const o18 = await newOrder('demo_sale', { loaiDV: 'sx', maKH: cust.D, ago: 6, noteDH: 'DEMO 18: khách cấp một phần linh kiện (MCU) và PCB', items: [board('Mạch đo điện áp', 0, 30, 30)] });
    for (const l of o18.lines) {
        const bom = bomOf(30).map((x) => (x.itemId === item['STM32F103C8T6'] ? { ...x, khachCap: true } : x));
        await patch('demo_lk', `/api/orders/${o18.id}/cost`, { lineId: l.id, detail: { giaCostLK: bom } });
        await patch('demo_qlsx', `/api/orders/${o18.id}/cost`, { lineId: l.id, assembly: { counts: { smdPads: 180, thtPads: 24, icCount: 3 }, rates: RATES, source: 'Ước lượng từ BOM' } });
    }
    await sendQuote('demo_sale', o18, 1.3); await confirm('demo_sale', o18);

    // ----- Don R&D -----
    await newOrder('demo_sale', { loaiDV: 'rnd', maKH: cust.D, brandId: brandA, ago: 1, tenMach: 'Thiết kế mạch BMS 4S', dauViec: 'Thiết kế schematic + layout BMS 4S 20A', noteDH: 'DEMO 12: R&D chờ báo giá' });
    const o13 = await newOrder('demo_sale2', { loaiDV: 'rnd', maKH: cust.B, brandId: brandB, ago: 5, tenMach: 'Firmware cảm biến LoRa', dauViec: 'Viết firmware đọc cảm biến, truyền LoRaWAN', noteDH: 'DEMO 13: R&D đã báo khách' });
    await patch('demo_tbp', `/api/orders/${o13.id}/cost`, { giaThietKe: 18000000 }); await sendQuote('demo_sale2', o13, 1.5);
    const o14 = await newOrder('demo_sale', { loaiDV: 'rnd', maKH: cust.D, brandId: brandA, ago: 14, vat: 8, tenMach: 'Thiết kế mạch điều khiển robot', dauViec: 'Schematic, layout 4 lớp, BOM, gerber', noteDH: 'DEMO 14: R&D đang thiết kế, đã tạm ứng' });
    await patch('demo_tbp', `/api/orders/${o14.id}/cost`, { giaThietKe: 25000000 }); await sendQuote('demo_sale', o14, 1.4); await confirm('demo_sale', o14);
    await payPart('demo_sale', o14, 0.5, 'Tạm ứng 50% khi ký');
    await doc('demo_sale', o14, 'hopdong', { trangThai: 'Đã gửi khách', so: 'HĐ-RD-014', ngay: day(-9) });
    const o15 = await newOrder('demo_sale2', { loaiDV: 'rnd', maKH: cust.A, brandId: brandB, ago: 45, tenMach: 'Thiết kế mạch nguồn xung 24V', dauViec: 'Thiết kế + review + bàn giao file sản xuất', noteDH: 'DEMO 15: R&D hoàn thành' });
    await patch('demo_tbp', `/api/orders/${o15.id}/cost`, { giaThietKe: 12000000 }); await sendQuote('demo_sale2', o15, 1.5); await confirm('demo_sale2', o15);
    await payPart('demo_kt', o15, 1, 'Thanh toán 100%');
    await patch('demo_sale2', `/api/orders/${o15.id}/status`, { ttDonHang: 'Hoàn thành', ttQuyTrinh: 'Hoàn thành' });
    await doc('demo_sale2', o15, 'bienban', { trangThai: 'Đã ký', ngay: day(-20) });
    await doc('demo_kt', o15, 'hoadon', { trangThai: 'Không xuất' });
    // Dau viec thiet ke (sinh tu dong khi don R&D chot): 1 dang xu ly, 1 da hoan thanh
    const jobs = await db.allAsync('SELECT id, orderId FROM design_jobs');
    const job = (o) => jobs.find((j) => j.orderId === o.id);
    if (job(o14)) await post('demo_tbp', '/api/design-jobs/save', { id: job(o14).id, designer: 'Bùi Kỹ Sư', ttThietKe: 'Đang xử lý', version: '0.2', deadline: day(7), feedbackTK: 'Đã xong schematic, đang layout' });
    if (job(o15)) await post('demo_tbp', '/api/design-jobs/save', { id: job(o15).id, designer: 'Bùi Kỹ Sư', ttThietKe: 'Đã hoàn thành', version: '1.0', deadline: day(-22), feedbackTK: 'Đã bàn giao' });
};
