// TRANG HANH CHINH: theo doi va soan chung tu cua don da chot (hop dong, PO khach, hoa don, bien ban ban giao / nghiem thu).
// Chi tra ve thong tin can cho chung tu (khong co gia cost). Cap nhat trang thai dung chung API /api/orders/:id/documents/:loai.
const db = require('../models/database');
const flow = require('../utils/orderFlow');
const orderController = require('./orderController');
const { ORDER_DOCS, CONTRACT_MIN_VALUE } = require('../config');
const { toNum, today, escapeHtml, badRequest, notFound } = require('../utils/http');

// GET /api/hanh-chinh
exports.overview = async (req, res) => {
    const orders = await db.allAsync(`SELECT o.*, c.tenKH, c.sdt, c.diaChi FROM orders o LEFT JOIN customers c ON c.maKH = o.maKH
        WHERE o.ttChotDon = 'Đã chốt' AND COALESCE(o.ttQuyTrinh, '') != 'Hủy đơn' ORDER BY o.id DESC LIMIT 500`);
    const docs = await db.allAsync('SELECT * FROM order_documents');
    const ships = await db.allAsync('SELECT orderId, status, deliveredDate FROM shipments');
    res.json({
        types: ORDER_DOCS, contractMin: CONTRACT_MIN_VALUE,
        orders: orders.map((o) => {
            const sh = ships.filter((s) => s.orderId === o.id);
            return { id: o.id, maDH: o.maDH, maKH: o.maKH, tenKH: o.tenKH || o.maKH, sdt: o.sdt || '', diaChi: o.diaChi || '', loaiDV: o.loaiDV, tenMach: o.tenMach, ngayChot: o.ngayChot, ngayBanGiao: o.ngayBanGiao,
                saleName: o.saleName, vat: toNum(o.vat), tongCong: flow.tongCong(o), daThu: flow.daThu(o), conNo: flow.conNo(o), giaiDoan: flow.computeStage(o),
                daGiao: sh.length > 0 && sh.every((s) => s.status === 'Đã giao'), soChuyen: sh.length, hasFolder: !!(o.documentFolderId || o.folderId),
                chungTu: orderController.buildDocs(o, docs.filter((d) => d.orderId === o.id)) };
        })
    });
};

// ---------- Soan ban nhap (file .doc mo bang Word) tu du lieu don ----------
const money = (v) => Math.round(toNum(v)).toLocaleString('vi-VN');
const e = escapeHtml;
async function loadForDraft(id) {
    const o = await db.getAsync('SELECT o.*, c.tenKH, c.sdt, c.diaChi FROM orders o LEFT JOIN customers c ON c.maKH = o.maKH WHERE o.id = ?', [id]);
    if (!o) throw notFound('Không tìm thấy đơn hàng.');
    const items = await db.allAsync('SELECT * FROM order_items WHERE orderId = ? ORDER BY stt, id', [id]);
    const brand = (o.brandId && await db.getAsync('SELECT * FROM brands WHERE id = ?', [o.brandId])) || await db.getAsync('SELECT * FROM brands ORDER BY id LIMIT 1') || {};
    const addr = await db.getAsync('SELECT * FROM customer_addresses WHERE maKH = ? ORDER BY isDefault DESC, id LIMIT 1', [o.maKH]);
    const rows = items.length ? items.map((i) => ({ name: i.tenMach, qty: Math.max(toNum(i.soLuongGiaCong), toNum(i.soLuongLK), toNum(i.soLuongPCB)),
        scope: [toNum(i.soLuongPCB) > 0 ? 'PCB' : '', toNum(i.soLuongLK) > 0 ? 'linh kiện' : '', toNum(i.soLuongGiaCong) > 0 ? 'gia công lắp ráp' : ''].filter(Boolean).join(', ') }))
        : [{ name: o.tenMach, qty: 1, scope: o.loaiDV === 'rnd' ? 'nghiên cứu phát triển' : '' }];
    return { o, rows, brand, addr };
}
const page = (title, body) => `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${e(title)}</title>
<style>body{font-family:'Times New Roman';font-size:13pt;line-height:1.4} h1{text-align:center;font-size:16pt;margin:6pt 0} p{margin:4pt 0} table{border-collapse:collapse;width:100%} td,th{border:1px solid #000;padding:4pt 6pt;font-size:12pt} .c{text-align:center} .r{text-align:right} .nb td{border:none} .todo{background:#ffff00}</style></head><body>${body}</body></html>`;
const head = `<p class="c"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br><b>Độc lập - Tự do - Hạnh phúc</b><br>---------------</p>`;
const parties = (d, a, b) => `<p><b>${a}: ${e(d.o.tenKH || d.o.maKH)}</b></p><p>Địa chỉ: ${e(d.o.diaChi || '') || '<span class="todo">...</span>'}</p><p>Điện thoại: ${e(d.o.sdt || '') || '<span class="todo">...</span>'} &nbsp;&nbsp; Mã số thuế: <span class="todo">...</span></p><p>Đại diện: <span class="todo">...</span> &nbsp;&nbsp; Chức vụ: <span class="todo">...</span></p>
<p><b>${b}: ${e(d.brand.company || '') || '<span class="todo">...</span>'}</b></p><p>Địa chỉ: ${e(d.brand.address || '') || '<span class="todo">...</span>'}</p><p>Tài khoản: ${e(d.brand.bankNo || '') || '<span class="todo">...</span>'} - ${e(d.brand.bankName || '')} ${d.brand.bankOwner ? '- ' + e(d.brand.bankOwner) : ''}</p><p>Đại diện: <span class="todo">...</span> &nbsp;&nbsp; Chức vụ: <span class="todo">...</span></p>`;
const sign = (a, b) => `<br><table class="nb"><tr class="nb"><td class="c" style="border:none"><b>${a}</b><br><i>(Ký, ghi rõ họ tên)</i><br><br><br><br></td><td class="c" style="border:none"><b>${b}</b><br><i>(Ký, ghi rõ họ tên)</i><br><br><br><br></td></tr></table>`;
const goods = (d, withMoney) => `<table><tr><th>STT</th><th>Sản phẩm</th><th>Phạm vi</th><th>Số lượng</th>${withMoney ? '' : '<th>Ghi chú</th>'}</tr>${d.rows.map((r, i) => `<tr><td class="c">${i + 1}</td><td>${e(r.name || '')}</td><td>${e(r.scope)}</td><td class="r">${money(r.qty)}</td>${withMoney ? '' : '<td></td>'}</tr>`).join('')}</table>`;

function contract(d) {
    const o = d.o, total = flow.tongCong(o), vat = toNum(o.vat), before = vat > 0 ? Math.round(total / (1 + vat / 100)) : total;
    return page(`Hợp đồng ${o.maDH}`, `${head}<h1>HỢP ĐỒNG KINH TẾ</h1><p class="c">Số: <span class="todo">${e(o.maDH)}/HĐKT</span></p>
<p>Hôm nay, ngày <span class="todo">${today().split('-').reverse().join('/')}</span>, chúng tôi gồm:</p>${parties(d, 'BÊN A (Bên mua)', 'BÊN B (Bên bán)')}
<p>Hai bên thống nhất ký hợp đồng với các điều khoản sau:</p>
<p><b>Điều 1. Nội dung hàng hóa, dịch vụ</b></p>${goods(d, true)}
<p><b>Điều 2. Giá trị hợp đồng</b></p><p>Giá trị trước thuế: ${money(before)} đ. Thuế GTGT ${vat}%: ${money(total - before)} đ. <b>Tổng giá trị thanh toán: ${money(total)} đ.</b></p>
<p><b>Điều 3. Thanh toán</b></p><p class="todo">Tạm ứng ...% khi ký hợp đồng; phần còn lại thanh toán trong ... ngày kể từ ngày bàn giao và nhận đủ hóa đơn. Hình thức: chuyển khoản.</p>
<p><b>Điều 4. Giao hàng</b></p><p>Thời gian giao dự kiến: ${e(o.ngayBanGiao || '') || '<span class="todo">...</span>'}. Địa điểm: ${e((d.addr && d.addr.address) || o.diaChi || '') || '<span class="todo">...</span>'}${d.addr && d.addr.receiver ? ` (người nhận: ${e(d.addr.receiver)} ${e(d.addr.phone || '')})` : ''}.</p>
<p><b>Điều 5. Chất lượng, bảo hành</b></p><p class="todo">Hàng hóa đúng theo hồ sơ thiết kế / BOM do Bên A cung cấp và xác nhận. Bảo hành ... tháng đối với lỗi gia công.</p>
<p><b>Điều 6. Điều khoản chung</b></p><p class="todo">Hai bên cam kết thực hiện đúng các điều khoản. Tranh chấp được giải quyết bằng thương lượng; nếu không thành thì đưa ra Tòa án có thẩm quyền. Hợp đồng lập thành 02 bản có giá trị như nhau, mỗi bên giữ 01 bản.</p>
${sign('ĐẠI DIỆN BÊN A', 'ĐẠI DIỆN BÊN B')}`);
}
function handover(d) {
    const o = d.o;
    return page(`Biên bản bàn giao ${o.maDH}`, `${head}<h1>BIÊN BẢN BÀN GIAO VÀ NGHIỆM THU</h1><p class="c">Số: <span class="todo">${e(o.maDH)}/BBBG</span> &nbsp; (theo đơn hàng ${e(o.maDH)})</p>
<p>Hôm nay, ngày <span class="todo">${today().split('-').reverse().join('/')}</span>, tại <span class="todo">${e((d.addr && d.addr.address) || o.diaChi || '...')}</span>, chúng tôi gồm:</p>${parties(d, 'BÊN NHẬN (Bên A)', 'BÊN GIAO (Bên B)')}
<p>Hai bên tiến hành bàn giao và nghiệm thu các hàng hóa sau:</p>${goods(d, false)}
<p>Tình trạng hàng hóa: <span class="todo">đủ số lượng, đúng chủng loại, đạt yêu cầu.</span></p><p>Ý kiến khác: <span class="todo">...</span></p>
<p>Biên bản lập thành 02 bản có giá trị như nhau, mỗi bên giữ 01 bản.</p>${sign('ĐẠI DIỆN BÊN NHẬN', 'ĐẠI DIỆN BÊN GIAO')}`);
}
// GET /api/hanh-chinh/:id/draft/:loai  (hopdong | bienban)
exports.draft = async (req, res) => {
    const make = { hopdong: contract, bienban: handover }[req.params.loai];
    if (!make) throw badRequest('Chỉ soạn nháp được hợp đồng và biên bản.');
    const d = await loadForDraft(req.params.id);
    res.setHeader('Content-Type', 'application/msword; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.loai === 'hopdong' ? 'HopDong' : 'BienBan'}_${d.o.maDH.replace(/[^\w.-]/g, '_')}.doc"`);
    res.send('﻿' + make(d));
};
