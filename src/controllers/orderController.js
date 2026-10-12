const fs = require('fs');
const path = require('path');
const db = require('../models/database');
const { ORDER_TYPES, ORDER_TYPE_LABELS, ORDER_DOCS, CONTRACT_MIN_VALUE, PAYMENT_ACCOUNTS, PENDING_WARN_DAYS, ROLES } = require('../config');
const { hasRole } = require('../middlewares/authMiddleware');
const flow = require('../utils/orderFlow');
const { priceLines } = require('../utils/stockQuote');
const lineItems = require('../utils/orderItems');
const holds = require('../utils/stockHold');
const { priceAssembly } = require('../utils/assembly');
const { setSetting } = require('../utils/googleHelper');
const { ensureCustomerFolder, createOrderFolders, sendGoogleChatMsg, getSetting, DEPT_FOLDERS, folderRelPath, deptKeysFor, ensureDeptFolder, ensureAllDeptFolders } = require('../utils/googleHelper');
const { parseJson, toNum, today, ym, escapeHtml, fmtVND, userName, badRequest, notFound, conflict, forbidden } = require('../utils/http');

const PUBLIC_DIR = path.join(__dirname, '../../public');
const CANCELLED = 'Hủy đơn';   // gia tri cua ttQuyTrinh
const CONFIRMED = 'Đã chốt';   // gia tri cua ttChotDon
const QTY_FIELDS = ['soLuongPCB', 'soLuongLK', 'soLuongGiaCong'];
const isRnd = (order) => order.loaiDV === ORDER_TYPES.RND;

// Cac cot cua don hang duoc phep ghi tu form (dung chung cho INSERT va UPDATE)
const ORDER_FIELDS = [
    'tenMach', 'ngayTao', 'ngayChot', 'leadtime', 'ngayBanGiao', 'ttQuyTrinh',
    'giaThietKe', 'heSoSale', 'vat', 'chietKhau', 'noteDH', 'giaBao', 'dauViec',
    'soLuongPCB', 'soLuongLK', 'soLuongGiaCong', 'ghiChuKyThuat',
    'ttChotDon', 'lyDoHuy', 'hangMucBanGiao', 'ttNghiemThu', 'noiDungPhatSinh',
    'ttThanhToan', 'ttDonHang', 'ngayBanGiaoThucTe', 'ghiChuNghiemThu',
    'saleName', 'brandId'
];
const NUMERIC_FIELDS = new Set(['giaThietKe', 'heSoSale', 'vat', 'chietKhau', 'giaBao', 'tamUng', 'soLuongPCB', 'soLuongLK', 'soLuongGiaCong']);

// Chuan hoa gia tri tu form. Truong khong gui len (undefined) -> giu gia tri cu `current`.
function normalizeOrder(body, current = {}) {
    const out = {};
    for (const f of ORDER_FIELDS) {
        let v = body[f];
        if (v === undefined && current[f] !== undefined) { out[f] = current[f]; continue; }
        if (v === undefined) { // tao moi ma form khong gui truong nay -> gia tri mac dinh
            out[f] = f === 'dauViec' ? '[]' : (NUMERIC_FIELDS.has(f) ? (f === 'heSoSale' ? 1 : 0) : null);
            continue;
        }
        if (f === 'dauViec') v = JSON.stringify(Array.isArray(v) ? v : []);
        else if (NUMERIC_FIELDS.has(f)) v = toNum(v, f === 'heSoSale' ? 1 : 0);
        else if (v === '') v = null;
        out[f] = v;
    }
    for (const f of ['vat', 'chietKhau']) {
        if (out[f] !== null && (out[f] < 0 || out[f] > 100)) throw badRequest('VAT và chiết khấu phải nằm trong khoảng 0 - 100%.');
    }
    for (const f of ['giaBao', 'tamUng', 'giaThietKe', ...QTY_FIELDS]) {
        if (out[f] !== null && out[f] < 0) throw badRequest('Giá và số lượng không được âm.');
    }
    return out;
}

// Ap quy tac rieng cua tung loai don:
//  - rnd: khong co so luong PCB / linh kien / san xuat
//  - sx : khong co chi phi R&D; khi tao moi phai co it nhat 1 hang muc
function applyTypeRules(data, type, isNew) {
    if (type === ORDER_TYPES.RND) {
        for (const f of QTY_FIELDS) data[f] = 0;
    } else {
        data.giaThietKe = 0;
        if (isNew && QTY_FIELDS.every((f) => !data[f])) {
            throw badRequest('Đơn PCB / Linh kiện / Sản xuất phải có số lượng của ít nhất một hạng mục.');
        }
    }
    return data;
}

const withParsedDauViec = (row) => ({ ...row, dauViec: parseJson(row.dauViec, []) });

// Dam bao dung trinh tu quy trinh: chi duoc "Đã báo giá" cho khach / "Đã chốt" khi cac bo phan
// da bao gia cost xong va Sale da co gia bao.
function assertFlow(before, after) {
    const nowQuoted = after.ttQuyTrinh === flow.QUOTED && before.ttQuyTrinh !== flow.QUOTED;
    const nowConfirmed = after.ttChotDon === flow.CONFIRMED && before.ttChotDon !== flow.CONFIRMED;
    if (!nowQuoted && !nowConfirmed) return;

    const action = nowConfirmed ? 'chốt đơn' : 'chuyển sang "Đã báo giá"';
    const missing = flow.missingQuotes(after).map((q) => q.label);
    if (missing.length) throw badRequest(`Chưa thể ${action}: còn chờ báo giá cost từ bộ phận ${missing.join(', ')}.`);
    if (toNum(after.giaBao) <= 0) throw badRequest(`Chưa thể ${action}: chưa có giá báo khách.`);
}

// Ngay chot = ngay Sale chuyen trang thai sang "Đã chốt" / "Không chốt" (khong nhap tay). Quay ve "cho phan hoi" thi xoa.
// Tra ve undefined neu trang thai chot khong doi.
function chotDate(before, after) {
    if ((before.ttChotDon || '') === (after.ttChotDon || '')) return undefined;
    return [flow.CONFIRMED, flow.REJECTED].includes(after.ttChotDon) ? today() : null;
}

const isClosed = (o) => o.ttChotDon === flow.REJECTED || o.ttQuyTrinh === flow.CANCELLED;

// Don dang "khong chot" / "huy" duoc mo lai: cac bang vat tu da tai nhap khong con hieu luc
// -> xoa gia cost cua chung de bo phan bao gia lai. Tra ve `before` da cap nhat so tong hop.
async function reopenIfNeeded(before, incoming) {
    const next = { ...before, ...incoming };
    if (isRnd(before) || !isClosed(before) || isClosed(next)) return before;
    if (!(await holds.resetReleased(before.id))) return before;
    return { ...before, ...(await lineItems.syncOrderSummary(before.id)) };
}

// Tam xuat kho di theo trang thai don: khong chot / huy -> tai nhap; chot -> xuat chinh thuc
async function syncStockHolds(before, after, user) {
    if (isRnd(after)) return '';
    if (isClosed(after) && before.ttChotDon !== flow.CONFIRMED) {
        const n = await holds.releaseOrder(after, user, `Tái nhập - ${after.ttQuyTrinh === flow.CANCELLED ? 'đơn hủy' : 'khách không chốt'} ${after.maDH}`);
        return n ? `Đã tái nhập kho ${n} mã vật tư tạm xuất.` : '';
    }
    // Don DA CHOT bi huy: dong chua dat hang tu huy; dong da dat / hang dang giu cho Truong BP Mua hang xu ly
    if (after.ttQuyTrinh === flow.CANCELLED && before.ttQuyTrinh !== flow.CANCELLED && before.ttChotDon === flow.CONFIRMED) {
        const now = new Date().toISOString();
        await db.runAsync(`UPDATE buy_lines SET cancelledAt = ?, resolution = 'Tự hủy: đơn hủy khi chưa đặt hàng', resolvedBy = ?, resolvedAt = ? WHERE orderId = ? AND poId IS NULL AND cancelledAt IS NULL`, [now, user, now, after.id]);
        return 'Đơn đã chốt bị hủy: phần đã đặt mua / hàng đang giữ cần Trưởng BP Mua hàng xử lý ở trang Điều hành mua linh kiện.';
    }
    if (after.ttChotDon === flow.CONFIRMED && before.ttChotDon !== flow.CONFIRMED) {
        await holds.confirm(after.id);
        await require('../utils/buyLines').generate(after.id); // dong "can mua" -> danh sach dieu hanh mua linh kien
    }
    return '';
}

// Dong bo dau viec thiet ke theo don hang. CHI ap dung cho don Nghien cuu phat trien:
// don da chot (va khong huy) -> dam bao co 1 dau viec; don bi huy -> go dau viec con chua giao.
// Don PCB / Linh kien / San xuat khong sinh dau viec thiet ke.
// Thu muc giao san pham thiet ke: "2. OUTPUT/1. Thiết kế" neu co, khong thi "2. OUTPUT"
const designOutput = (order) => (parseJson(order.deptFolders, {}) || {}).thietke || order.outputFolderId;
async function syncDesignJob(order) {
    if (!isRnd(order)) return;
    const job = await db.getAsync('SELECT id, ttThietKe FROM design_jobs WHERE orderId = ?', [order.id]);
    const active = order.ttChotDon === CONFIRMED && order.ttQuyTrinh !== CANCELLED;

    if (active) {
        if (!job) {
            await db.runAsync(
                `INSERT INTO design_jobs (orderId, maDH, ttThietKe, dauViec, driveLink, outputFolderId, history) VALUES (?, ?, 'Chưa giao việc', ?, ?, ?, '[]')`,
                [order.id, order.maDH, order.dauViec || '[]', (parseJson(order.deptFolders, {}) || {})['in-design'] || order.inputFolderId, designOutput(order)]);
        } else {
            await db.runAsync('UPDATE design_jobs SET maDH = ?, dauViec = ?, outputFolderId = COALESCE(outputFolderId, ?) WHERE id = ?',
                [order.maDH, order.dauViec || '[]', designOutput(order), job.id]);
        }
    } else if (job && order.ttQuyTrinh === CANCELLED && (job.ttThietKe || 'Chưa giao việc') === 'Chưa giao việc') {
        await db.runAsync('DELETE FROM design_jobs WHERE id = ?', [job.id]);
    }
}

function notifyChanges(before, after, user) {
    if (before.ttQuyTrinh !== after.ttQuyTrinh && after.ttQuyTrinh) {
        sendGoogleChatMsg(after.maDH, user, `Trạng thái quản lý: ${after.ttQuyTrinh}`);
    }
    if (before.ttDonHang !== after.ttDonHang && after.ttDonHang) {
        sendGoogleChatMsg(after.maDH, user, `Trạng thái đơn hàng: ${after.ttDonHang}`);
    }
    if (before.ttChotDon !== after.ttChotDon && after.ttChotDon) {
        const msg = after.ttChotDon === CONFIRMED
            ? `KH chốt đơn! Giá báo: ${fmtVND(after.giaBao)} đ`
            : `Trạng thái chốt: ${after.ttChotDon}`;
        sendGoogleChatMsg(after.maDH, user, msg);
    }
}

// Tinh tien bao gia (dung cho PDF)
function calcTotals(o) {
    const costPCB = toNum(o.giaCostPCB), costLK = toNum(o.giaCostLK), costGC = toNum(o.giaCostGiaCong);
    const baseCost = isRnd(o) ? toNum(o.giaThietKe) : costPCB + costLK + costGC;
    const giaGoc = toNum(o.giaBao) || baseCost * (toNum(o.heSoSale) || 1);
    const tienVat = giaGoc * toNum(o.vat) / 100;
    const tienCK = giaGoc * toNum(o.chietKhau) / 100;
    return { costPCB, costLK, costGC, giaGoc, tienVat, tienCK, tongCong: giaGoc + tienVat - tienCK };
}

// Logo luu dang /uploads/logos/xxx.png -> nhung thang vao PDF (duong dan tuong doi khong tai duoc khi render PDF)
function logoDataUri(logo) {
    if (!logo || !/^\/uploads\/logos\/[\w.-]+$/.test(logo)) return '';
    try {
        const file = path.join(PUBLIC_DIR, logo);
        const ext = path.extname(file).slice(1).toLowerCase();
        const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
        return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    } catch (e) {
        return '';
    }
}

// =============================================
// EXPORT PDF BAO GIA
// =============================================
exports.exportPDF = async (req, res) => {
    const order = await db.getAsync(
        `SELECT o.*, c.tenKH, c.sdt AS customerPhone, c.diaChi AS customerAddr
         FROM orders o LEFT JOIN customers c ON o.maKH = c.maKH WHERE o.id = ?`, [req.params.id]);
    if (!order) throw notFound('Không tìm thấy đơn hàng.');

    // Thuong hieu: theo ?brandId, roi den thuong hieu da chon tren don, cuoi cung la thuong hieu dau tien
    const brand = (req.query.brandId && await db.getAsync('SELECT * FROM brands WHERE id = ?', [req.query.brandId]))
        || (order.brandId && await db.getAsync('SELECT * FROM brands WHERE id = ?', [order.brandId]))
        || await db.getAsync('SELECT * FROM brands ORDER BY id ASC LIMIT 1')
        || {};

    const e = escapeHtml;
    const t = calcTotals(order);
    const line = (label, amount) => `<tr><td>${label}</td><td class="text-right">${fmtVND(amount)} đ</td></tr>`;

    const rnd = isRnd(order);
    const boards = rnd ? [] : await lineItems.loadLines(order.id);
    const qtyText = (o) => [['PCB', o.soLuongPCB], ['Linh kiện', o.soLuongLK], ['Sản xuất', o.soLuongGiaCong]]
        .filter(([, q]) => q > 0).map(([label, q]) => `${label}: ${e(q)}`).join(', ');
    let itemRows = '';
    if (rnd) {
        itemRows = line(`Nghiên cứu phát triển - ${e(order.tenMach)}`, t.giaGoc);
    } else if (boards.length > 1) {
        // Nhieu loai mach: moi mach 1 dong, gia bao chia theo ty le cost cua tung mach
        const costOf = (b) => toNum(b.giaCostPCB) + toNum(b.giaCostLK) + toNum(b.giaCostGiaCong);
        const totalCost = boards.reduce((sum, b) => sum + costOf(b), 0);
        let used = 0;
        boards.forEach((b, i) => {
            const last = i === boards.length - 1;
            const amount = totalCost > 0 ? (last ? t.giaGoc - used : Math.round(t.giaGoc * costOf(b) / totalCost)) : null;
            if (amount !== null) used += amount;
            itemRows += amount === null
                ? `<tr><td>${e(b.tenMach)} (${qtyText(b)})</td><td class="text-right"></td></tr>`
                : line(`${e(b.tenMach)} (${qtyText(b)})`, amount);
        });
        if (totalCost <= 0) itemRows += line('Tổng giá trị đơn hàng', t.giaGoc);
    } else {
        itemRows = line(`${e(order.tenMach)}${qtyText(order) ? ` (${qtyText(order)})` : ''}`, t.giaGoc);
    }

    let summaryRows = '';
    if (order.vat > 0) summaryRows += `<tr><td class="label">Thuế VAT (${e(order.vat)}%):</td><td class="value">+ ${fmtVND(t.tienVat)} đ</td></tr>`;
    if (order.chietKhau > 0) summaryRows += `<tr><td class="label">Chiết khấu (${e(order.chietKhau)}%):</td><td class="value" style="color:#ef4444">- ${fmtVND(t.tienCK)} đ</td></tr>`;
    summaryRows += `<tr><td class="label grand-total">TỔNG CỘNG:</td><td class="value grand-total">${fmtVND(t.tongCong)} đ</td></tr>`;

    const bankInfoHtml = brand.showBankDefault === 1 ? `
        <div class="bank-info">
            <p style="margin-top:0;color:#1e40af"><strong>THÔNG TIN THANH TOÁN:</strong></p>
            <p>Ngân hàng: <strong>${e(brand.bankName || '---')}</strong></p>
            <p>Số tài khoản: <strong>${e(brand.bankNo || '---')}</strong></p>
            <p>Chủ tài khoản: <strong>${e(brand.bankOwner || '---')}</strong></p>
        </div>` : '';

    const logo = logoDataUri(brand.logo);
    const htmlContent = `<html><head><meta charset="utf-8"><style>
        body{font-family:'Segoe UI',Arial,sans-serif;padding:40px;color:#1e293b;line-height:1.6;font-size:13px}
        .header-table{width:100%;border-bottom:2px solid #3b82f6;margin-bottom:20px;border:none}
        .title{text-align:center;color:#1e40af;font-size:24px;text-transform:uppercase;margin:10px 0;font-weight:bold}
        .info-box{display:flex;justify-content:space-between;margin-bottom:20px;background:#f8fafc;padding:15px;border-radius:8px;border:1px solid #e2e8f0}
        table{width:100%;border-collapse:collapse;margin-top:10px}
        th{background:#3b82f6;color:white;padding:10px;text-align:left;border:1px solid #3b82f6}
        td{padding:10px;border:1px solid #e2e8f0;vertical-align:top}
        .text-right{text-align:right}
        .summary-wrapper{display:flex;justify-content:flex-end;margin-top:10px}
        .summary-table{width:320px;border:none}
        .summary-table td{border:none;padding:4px 10px}
        .summary-table .label{text-align:left;color:#64748b;width:60%}
        .summary-table .value{text-align:right;font-weight:bold;width:40%;white-space:nowrap}
        .grand-total{font-size:18px!important;color:#ef4444;border-top:2px solid #e2e8f0!important;padding-top:10px!important}
        .bank-info{margin-top:30px;padding:15px;border:1px dashed #3b82f6;background:#f0f7ff;border-radius:8px}
        .footer{text-align:center;margin-top:50px;font-size:11px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:10px}
        h3{color:#1e40af;border-left:4px solid #3b82f6;padding-left:10px;margin-top:25px}
        .pre{white-space:pre-wrap}
    </style></head><body>
        <table class="header-table">
            <tr>
                <td style="border:none;width:70%"><h2 style="margin:0;color:#1e40af">${e(brand.company || '')}</h2><p style="margin:5px 0;color:#64748b">${e(brand.address || '')}</p></td>
                <td style="text-align:right;border:none;width:30%">${logo ? `<img src="${logo}" style="height:60px">` : ''}</td>
            </tr>
        </table>
        <h1 class="title">${rnd ? 'BÁO GIÁ NGHIÊN CỨU PHÁT TRIỂN' : 'BÁO GIÁ DỊCH VỤ'}</h1>
        <div class="info-box">
            <div style="width:55%">
                <p><strong>Khách hàng:</strong> ${e(order.tenKH || 'N/A')}</p>
                <p><strong>Điện thoại:</strong> ${e(order.customerPhone || '---')}</p>
                <p><strong>Địa chỉ:</strong> ${e(order.customerAddr || '---')}</p>
            </div>
            <div style="width:40%;text-align:right">
                <p><strong>Số báo giá:</strong> ${e(order.maDH)}</p>
                <p><strong>Ngày tạo:</strong> ${e(order.ngayTao || '')}</p>
                <p><strong>Leadtime:</strong> ${e(order.leadtime || '---')} ngày</p>
            </div>
        </div>
        <table>
            <thead><tr><th style="width:70%">Hạng mục dịch vụ</th><th style="width:30%;text-align:right">Thành tiền</th></tr></thead>
            <tbody>${itemRows}</tbody>
        </table>
        <div class="summary-wrapper"><table class="summary-table">${summaryRows}</table></div>
        <h3>Ghi chú kỹ thuật</h3>
        <p class="pre">${e(order.ghiChuKyThuat || order.noteDH || 'Không có')}</p>
        <h3>Hạng mục bàn giao</h3>
        <p class="pre">${e(order.hangMucBanGiao || (rnd ? 'Hồ sơ thiết kế và sản phẩm mẫu theo yêu cầu.' : 'Toàn bộ sản phẩm PCB / Linh kiện / Sản xuất theo yêu cầu.'))}</p>
        ${bankInfoHtml}
        <div class="footer"><p>Báo giá có hiệu lực trong vòng 15 ngày kể từ ngày tạo. Trân trọng cảm ơn!</p></div>
    </body></html>`;

    // Nap thu vien khi can: html-pdf-node keo theo trinh duyet khong giao dien, khong nen nap luc khoi dong
    const htmlToPdf = require('html-pdf-node');
    const pdfBuffer = await htmlToPdf.generatePdf({ content: htmlContent }, { format: 'A4', printBackground: true });

    const safeName = String(order.maDH || order.id).replace(/[^\w.-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=BaoGia_${safeName}.pdf`);
    res.send(pdfBuffer);
};

// =============================================
// GET ORDERS - Lay danh sach don hang
// =============================================
exports.getOrders = async (req, res) => {
    const rows = await db.allAsync(`
        SELECT o.*, c.sdt AS customerPhone, c.tenKH AS customerName,
               (SELECT b.company FROM brands b WHERE b.id = o.brandId) AS brandName,
               (SELECT d.designer FROM design_jobs d WHERE d.orderId = o.id LIMIT 1) AS designer,
               (SELECT d.ttThietKe FROM design_jobs d WHERE d.orderId = o.id LIMIT 1) AS ttThietKe
        FROM orders o
        LEFT JOIN customers c ON o.maKH = c.maKH
        ORDER BY o.id DESC`);
    const itemsByOrder = await loadAllLines();
    const docsByOrder = await loadAllDocs();
    const heldByOrder = new Map((await db.allAsync(
        `SELECT orderId, COUNT(DISTINCT itemId) AS items FROM stock_holds WHERE status = 'hold' GROUP BY orderId`)).map((h) => [h.orderId, h.items]));
    res.json(rows.map((r) => flow.decorate({
        ...withParsedDauViec(r), costDetail: parseJson(r.costDetail, {}), loaiDVLabel: ORDER_TYPE_LABELS[r.loaiDV] || '',
        items: itemsByOrder.get(r.id) || [],        // cac loai mach cua don (don R&D khong co)
        tamXuat: heldByOrder.get(r.id) || 0,        // so ma vat tu dang tam xuat cho don nay
        warnDays: PENDING_WARN_DAYS,
        chungTu: buildDocs(r, docsByOrder.get(r.id) || []) // hop dong, hoa don, bien ban + danh sach con thieu
    })));
};

// ----- Chung tu cua don hang (hop dong, hoa don, bien ban) -----
// Trang thai mac dinh khi chua ai cap nhat: don khong co VAT thi hoa don mac dinh "Không xuất"
function defaultDocStatus(loai, order) {
    const hasVat = toNum(order.vat) > 0;
    if (loai === 'hoadon' && !hasVat) return 'Không xuất';
    // Hop dong: chi don co VAT va tong gia tri tu CONTRACT_MIN_VALUE (20 trieu). Don co VAT nho hon chi can PO cua khach.
    const needContract = hasVat && flow.tongCong(order) >= CONTRACT_MIN_VALUE;
    if (loai === 'hopdong' && !needContract) return 'Không cần';
    if (loai === 'po' && (!hasVat || needContract)) return 'Không cần';
    return ORDER_DOCS[loai].statuses[0];
}
// rows: cac dong order_documents cua 1 don -> { hopdong: {...}, hoadon: {...}, bienban: {...}, thieu: [nhan cac chung tu chua xong] }
function buildDocs(order, rows) {
    const out = {};
    const missing = [];
    const confirmed = order.ttChotDon === flow.CONFIRMED && order.ttQuyTrinh !== flow.CANCELLED;
    for (const [loai, def] of Object.entries(ORDER_DOCS)) {
        const row = rows.find((r) => r.loai === loai) || {};
        const trangThai = row.trangThai || defaultDocStatus(loai, order);
        const done = def.done.includes(trangThai);
        out[loai] = { loai, label: def.label, trangThai, done, so: row.so || '', ngay: row.ngay || '', giaTri: row.giaTri || null, link: row.link || '', ghiChu: row.ghiChu || '', updatedBy: row.updatedBy || '', updatedAt: row.updatedAt || '' };
        // Chi nhac voi don da chot; bien ban chi nhac khi don da giao xong
        const due = loai === 'bienban' ? (order.ttDonHang === flow.DONE || order.ttQuyTrinh === flow.DONE) : true;
        if (confirmed && due && !done) missing.push(def.label);
    }
    out.thieu = missing;
    return out;
}
async function loadAllDocs() {
    const map = new Map();
    for (const r of await db.allAsync('SELECT * FROM order_documents')) {
        if (!map.has(r.orderId)) map.set(r.orderId, []);
        map.get(r.orderId).push(r);
    }
    return map;
}

exports.getDocuments = async (req, res) => {
    const order = await db.getAsync('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) throw notFound('Không tìm thấy đơn hàng.');
    res.json({ success: true, docs: buildDocs(order, await db.allAsync('SELECT * FROM order_documents WHERE orderId = ?', [order.id])), types: ORDER_DOCS });
};

// PUT /api/orders/:id/documents/:loai  { trangThai, so, ngay, giaTri, link, ghiChu }
exports.saveDocument = async (req, res) => {
    const def = ORDER_DOCS[req.params.loai];
    if (!def) throw badRequest('Loại chứng từ không hợp lệ.');
    const order = await db.getAsync('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) throw notFound('Không tìm thấy đơn hàng.');

    const trangThai = String(req.body.trangThai || '');
    if (!def.statuses.includes(trangThai)) throw badRequest(`Trạng thái ${def.label.toLowerCase()} không hợp lệ.`);
    const so = String(req.body.so || '').trim().slice(0, 100);
    const ngay = /^\d{4}-\d{2}-\d{2}$/.test(req.body.ngay || '') ? req.body.ngay : null;
    const link = String(req.body.link || '').trim().slice(0, 500);
    if (link && !/^https?:\/\//i.test(link)) throw badRequest('Link file phải bắt đầu bằng http:// hoặc https://');
    const giaTri = req.body.giaTri === undefined || req.body.giaTri === '' || req.body.giaTri === null ? null : toNum(req.body.giaTri);
    if (giaTri !== null && giaTri < 0) throw badRequest('Giá trị không được âm.');
    // Hoa don da xuat thi phai co so hoa don de doi chieu
    if (req.params.loai === 'hoadon' && ['Đã xuất', 'Đã gửi khách'].includes(trangThai) && !so) throw badRequest('Vui lòng nhập số hóa đơn.');

    const user = userName(req);
    await db.runAsync(
        `INSERT INTO order_documents (orderId, loai, trangThai, so, ngay, giaTri, link, ghiChu, updatedBy, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(orderId, loai) DO UPDATE SET trangThai = excluded.trangThai, so = excluded.so, ngay = excluded.ngay, giaTri = excluded.giaTri,
            link = excluded.link, ghiChu = excluded.ghiChu, updatedBy = excluded.updatedBy, updatedAt = excluded.updatedAt`,
        [order.id, req.params.loai, trangThai, so, ngay, giaTri, link, String(req.body.ghiChu || '').slice(0, 500), user, new Date().toISOString()]);

    sendGoogleChatMsg(order.maDH, user, `${def.label}: ${trangThai}${so ? ` (số ${so})` : ''}`);
    res.json({ success: true, docs: buildDocs(order, await db.allAsync('SELECT * FROM order_documents WHERE orderId = ?', [order.id])) });
};

// Tat ca hang muc mach, gom theo don (1 truy van cho ca danh sach)
async function loadAllLines() {
    const rows = await db.allAsync('SELECT * FROM order_items ORDER BY orderId, stt, id');
    const map = new Map();
    for (const r of rows) {
        if (!map.has(r.orderId)) map.set(r.orderId, []);
        map.get(r.orderId).push({ ...r, costDetail: parseJson(r.costDetail, {}) || {} });
    }
    return map;
}

// =============================================
// DON DA CHOT cho Mua hang / San xuat (chi don loai PCB / Linh kien / San xuat, khong gom don R&D)
// type: PCB | LK | LinhKien | GiaCong (bo trong = tat ca)
// Dung chung cho /api/orders/for-purchase, /api/purchase/sale-orders, /api/production/sale-orders
// =============================================
async function listConfirmedOrders(type) {
    const column = { PCB: 'soLuongPCB', LK: 'soLuongLK', LinhKien: 'soLuongLK', GiaCong: 'soLuongGiaCong' }[type];
    const rows = await db.allAsync(`
        SELECT o.id, o.maDH, o.maKH, o.tenMach, o.ngayTao, o.ngayBanGiao, o.ttDonHang, o.ttChotDon, o.dauViec,
               o.soLuongPCB, o.soLuongLK, o.soLuongGiaCong,
               o.giaCostPCB, o.giaCostLK, o.giaCostGiaCong, o.costDetail,
               o.ghiChuKyThuat, o.folderId, o.inputFolderId, o.outputFolderId,
               o.giaBao, o.heSoSale,
               c.tenKH AS customerName
        FROM orders o
        LEFT JOIN customers c ON o.maKH = c.maKH
        WHERE o.loaiDV = ? AND o.ttChotDon = ? AND COALESCE(o.ttQuyTrinh, '') != ?
              ${column ? `AND COALESCE(o.${column}, 0) > 0` : ''}
        ORDER BY o.id DESC`, [ORDER_TYPES.SX, CONFIRMED, CANCELLED]);
    const itemsByOrder = await loadAllLines();
    return rows.map((r) => ({ ...withParsedDauViec(r), costDetail: parseJson(r.costDetail, {}), items: itemsByOrder.get(r.id) || [] }));
}
exports.listConfirmedOrders = listConfirmedOrders;
exports.buildDocs = buildDocs;

exports.getOrdersForPurchase = async (req, res) => {
    res.json(await listConfirmedOrders(req.query.type || ''));
};

// Hang muc vat tu duoc bao gia bang bang vat tu co kiem tra ton kho
const STOCK_FIELDS = ['giaCostLK', 'giaCostPCB'];

// =============================================
// YEU CAU BAO GIA - danh sach don dang cho cac bo phan bao gia cost
// Moi don tra ve cac loai mach (lines); moi loai mach co cac hang muc thuoc bo phan cua nguoi dang nhap.
// =============================================
exports.getQuoteRequests = async (req, res) => {
    const rows = await db.allAsync(`
        SELECT o.*, c.tenKH AS customerName
        FROM orders o LEFT JOIN customers c ON o.maKH = c.maKH
        WHERE COALESCE(o.ttChotDon, '') NOT IN (?, ?) AND COALESCE(o.ttQuyTrinh, '') NOT IN (?, ?)
        ORDER BY o.id DESC`, [flow.CONFIRMED, flow.REJECTED, flow.CANCELLED, flow.DONE]);
    const itemsByOrder = await loadAllLines();
    // ?dept=pcb | lk | sx | rnd : chi lay hang muc cua 1 bo phan (moi bo phan co trang bao gia rieng)
    const deptField = { pcb: 'giaCostPCB', lk: 'giaCostLK', sx: 'giaCostGiaCong', rnd: 'giaThietKe' }[req.query.dept] || null;
    const mine = (q) => hasRole(req.session.user, q.roles) && (!deptField || q.field === deptField);
    const heldMap = new Map(); // "lineId:field" -> { itemId: so luong dang tam xuat }
    for (const h of await db.allAsync(`SELECT lineId, field, itemId, SUM(quantity) AS qty FROM stock_holds WHERE status = 'hold' GROUP BY lineId, field, itemId`)) {
        const key = `${h.lineId}:${h.field}`;
        if (!heldMap.has(key)) heldMap.set(key, {});
        heldMap.get(key)[h.itemId] = h.qty;
    }

    const result = [];
    for (const o of rows) {
        let lines;
        if (isRnd(o)) {
            const items = flow.requiredQuotes(o).filter(mine).map((q) => ({ field: q.field, label: q.label, quantity: null, cost: toNum(o[q.field]), tool: null, detail: null }));
            lines = items.length ? [{ lineId: null, tenMach: o.tenMach, items }] : [];
        } else {
            const boards = itemsByOrder.get(o.id) || [];
            lines = boards.map((b) => ({
                lineId: b.id, tenMach: b.tenMach,
                items: lineItems.SX_QUOTES.filter((q) => toNum(b[q.qtyField]) > 0 && mine(q)).map((q) => ({
                    field: q.field, label: q.label, quantity: toNum(b[q.qtyField]), cost: toNum(b[q.field]),
                    // phan hang muc nay dang tam xuat: khi lap lai bang vat tu thi duoc cong tra vao ton kha dung
                    held: (heldMap.get(`${b.id}:${q.field}`) || {}),
                    tool: STOCK_FIELDS.includes(q.field) ? 'stock' : (q.field === 'giaCostGiaCong' ? 'assembly' : null),
                    detail: (b.costDetail || {})[q.field] || null
                }))
            })).filter((l) => l.items.length);
        }
        if (!lines.length) continue;
        result.push({
            id: o.id, maDH: o.maDH, loaiDV: o.loaiDV, loaiDVLabel: ORDER_TYPE_LABELS[o.loaiDV] || '',
            maKH: o.maKH, customerName: o.customerName, tenMach: o.tenMach, ngayTao: o.ngayTao, ngayBanGiao: o.ngayBanGiao,
            ghiChuKyThuat: o.ghiChuKyThuat, inputFolderId: o.inputFolderId, folderId: o.folderId, hasOutput: !!o.outputFolderId,
            saleName: o.saleName || '', tongCost: flow.totalCost(o), choBaoGia: flow.missingQuotes(o).map((q) => q.label),
            giaiDoan: flow.computeStage(o), lines, pending: lines.some((l) => l.items.some((i) => i.cost <= 0))
        });
    }
    res.json(result);
};

// Danh sach vat tu can mua cua ca don (gop cac loai mach)
// =============================================
// THU MUC DRIVE CUA DON HANG: mo thu muc theo ten, tu tao thu muc bo phan neu chua co.
// GET /api/orders/:id/folder/:key   key = root | input | output | documents | pcb | linhkien | sanxuat | kho | thietke
// =============================================
async function orderFolderId(order, key) {
    const fixed = { root: order.folderId, input: order.inputFolderId, output: order.outputFolderId, documents: order.documentFolderId };
    if (key in fixed) return fixed[key] || null;
    return ensureDeptFolder(order, key);
}
exports.orderFolderId = orderFolderId;
exports.openFolder = async (req, res) => {
    const order = await db.getAsync('SELECT id, maDH, maKH, loaiDV, folderId, inputFolderId, outputFolderId, documentFolderId, deptFolders FROM orders WHERE id = ?', [req.params.id]);
    if (!order) throw notFound('Không tìm thấy đơn hàng.');
    // ?line=<id loai mach>: thu muc rieng cua loai mach do trong INPUT / PCB | BOM | SMT
    const gh = require('../utils/googleHelper');
    const line = req.query.line && gh.BOARD_DEPTS[req.params.key] ? await db.getAsync('SELECT id, tenMach, folders FROM order_items WHERE id = ? AND orderId = ?', [req.query.line, order.id]) : null;
    if (line) {
        const bid = await gh.ensureBoardFolder(order, req.params.key, line);
        const rel = folderRelPath(order, req.params.key);
        if (req.query.info) return res.json({ success: !!bid, url: bid ? `https://drive.google.com/drive/folders/${encodeURIComponent(bid)}` : null, relPath: bid && rel ? [...rel, gh.boardFolderName(line.tenMach)] : null, error: bid ? undefined : 'Đơn chưa có thư mục trên Google Drive.' });
        if (bid) return res.redirect(`https://drive.google.com/drive/folders/${encodeURIComponent(bid)}`);
    }
    const id = await orderFolderId(order, req.params.key);
    // ?info=1: tra ve dia chi web + duong dan tuong doi (de trinh duyet mo thu muc tren may neu co cai Google Drive)
    if (req.query.info) return res.json({ success: !!id, url: id ? `https://drive.google.com/drive/folders/${encodeURIComponent(id)}` : null, relPath: id ? folderRelPath(order, req.params.key) : null, error: id ? undefined : 'Đơn chưa có thư mục này trên Google Drive.' });
    if (id) return res.redirect(`https://drive.google.com/drive/folders/${encodeURIComponent(id)}`);
    res.status(404).send(`<meta charset="utf-8"><body style="font-family:Arial;padding:40px;color:#334155"><h3>Đơn ${escapeHtml(order.maDH)} chưa có thư mục này trên Google Drive</h3><p>Đơn được tạo khi chưa kết nối Google Drive, hoặc loại đơn này không có thư mục bộ phận đó. Kiểm tra kết nối ở Cài đặt hệ thống.</p></body>`);
};
// Danh sach thu muc cua 1 loai don (de giao dien ve cac nut mo thu muc)
exports.folderKeys = (loaiDV) => deptKeysFor(loaiDV).map((k) => ({ key: k, label: DEPT_FOLDERS[k].label }));

exports.getBuyList = async (req, res) => {
    const order = await db.getAsync('SELECT id, maDH FROM orders WHERE id = ?', [req.params.id]);
    if (!order) throw notFound('Không tìm thấy đơn hàng.');
    const boards = lineItems.buyList(await lineItems.loadLines(order.id));
    res.json({ success: true, maDH: order.maDH, boards, total: boards.reduce((s, b) => s + b.total, 0) });
};

// Bang don gia gia cong mac dinh (Quan ly san xuat tu dat, luu trong bang settings)
const RATE_KEY = 'production_rates';
const DEFAULT_RATES = { smdPad: 0, thtPad: 0, ic: 0, test: 0, setup: 0, lossPercent: 0 };
exports.getProductionRates = async (req, res) => {
    res.json({ success: true, rates: { ...DEFAULT_RATES, ...(parseJson(await getSetting(RATE_KEY), {}) || {}) } });
};
exports.saveProductionRates = async (req, res) => {
    const rates = priceAssembly({}, req.body || {}, 0).rates; // dung chung bo kiem tra / chuan hoa so
    await setSetting(RATE_KEY, JSON.stringify(rates));
    res.json({ success: true, rates });
};

// =============================================
// PATCH COST - Bo phan bao gia cost
// Don R&D:  { giaThietKe }
// Don sx (theo tung loai mach): { lineId, giaCostPCB | giaCostLK | giaCostGiaCong }                       -> nhap tay 1 con so
//        hoac vat tu:  { lineId, detail: { giaCostLK: [ {itemId, name, need, buyPrice, stockPrice} ] } }   -> doi chieu ton kho
//        hoac gia cong:{ lineId, assembly: { counts: {smdPads, thtPads, icCount}, rates: {...}, source } } -> tinh theo diem han
// =============================================
exports.patchCost = async (req, res) => {
    const order = await db.getAsync('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) throw notFound('Không tìm thấy đơn hàng.');
    if (order.ttChotDon === flow.CONFIRMED) throw conflict('Đơn đã chốt với khách, không thể sửa giá cost.');
    if (order.ttQuyTrinh === flow.CANCELLED) throw conflict('Đơn đã hủy.');
    const user = userName(req);
    const assertRole = (q) => { if (!hasRole(req.session.user, q.roles)) throw forbidden(`Bạn không thuộc bộ phận báo giá hạng mục ${q.label}.`); };
    const changed = [];
    const next = {};
    let costDetail = {};
    let after;
    let boardName = '';

    if (isRnd(order)) {
        const q = flow.QUOTE_ITEMS.find((x) => x.field === 'giaThietKe');
        if (req.body.giaThietKe === undefined) throw badRequest('Không có hạng mục nào để cập nhật.');
        assertRole(q);
        next.giaThietKe = toNum(req.body.giaThietKe);
        if (next.giaThietKe < 0) throw badRequest('Giá cost không được âm.');
        changed.push(`${q.label}: ${fmtVND(next.giaThietKe)} đ`);
        await db.runAsync('UPDATE orders SET giaThietKe = ? WHERE id = ?', [next.giaThietKe, order.id]);
        after = { ...order, ...next };
    } else {
        const boards = await lineItems.loadLines(order.id);
        const board = req.body.lineId ? boards.find((b) => b.id === Number(req.body.lineId)) : (boards.length === 1 ? boards[0] : null);
        if (!board) throw badRequest('Chưa chọn loại mạch cần báo giá.');
        boardName = board.tenMach;
        costDetail = { ...board.costDetail };
        const bodyDetail = req.body.detail || {};
        const toHold = []; // cac bang vat tu vua tinh, se tam xuat sau khi luu

        for (const q of lineItems.SX_QUOTES) {
            const lines = bodyDetail[q.field];
            const assembly = q.field === 'giaCostGiaCong' ? req.body.assembly : undefined;
            if (req.body[q.field] === undefined && lines === undefined && assembly === undefined) continue;
            if (toNum(board[q.qtyField]) <= 0) throw badRequest(`Mạch "${board.tenMach}" không có hạng mục ${q.label} cần báo giá.`);
            assertRole(q);

            let value;
            if (lines !== undefined) {
                if (!STOCK_FIELDS.includes(q.field)) throw badRequest(`Hạng mục ${q.label} không dùng bảng vật tư.`);
                // Tai nhap phan hang muc nay da tam xuat lan truoc, roi tinh lai theo ton kho hien tai.
                // (Ton kho hien tai da tru san phan tam xuat cua cac loai mach / don hang khac.)
                await holds.releaseLineField(order, board.id, q.field, user);
                const priced = await priceLines(lines);
                if (priced.total <= 0) throw badRequest('Bảng vật tư không có dòng nào công ty lo (tất cả là khách cấp). Nếu khách cấp 100% linh kiện, hãy nhờ Sale bỏ tick "Linh kiện" trên đơn.');
                costDetail[q.field] = { ...priced, by: user };
                toHold.push({ field: q.field, lines: priced.lines });
                value = priced.total;
                changed.push(`${q.label}: ${fmtVND(value)} đ (${priced.lines.length} vật tư, ${priced.lines.filter((l) => l.toBuy > 0).length} loại cần mua thêm)`);
            } else if (assembly !== undefined) {
                const priced = priceAssembly(assembly.counts || {}, assembly.rates || {}, toNum(board[q.qtyField]));
                if (priced.total <= 0) throw badRequest('Giá gia công đang bằng 0: kiểm tra lại số điểm hàn và đơn giá.');
                costDetail[q.field] = { assembly: { ...priced, source: String(assembly.source || '').slice(0, 300) }, total: priced.total, by: user, at: new Date().toISOString() };
                value = priced.total;
                changed.push(`${q.label}: ${fmtVND(value)} đ (${priced.counts.smdPads} điểm dán, ${priced.counts.thtPads} điểm cắm, ${priced.counts.icCount} IC / board)`);
            } else {
                value = toNum(req.body[q.field]);
                delete costDetail[q.field]; // nhap tay 1 con so -> bang chi tiet cu khong con khop
                if (holds.STOCK_FIELDS.includes(q.field)) await holds.releaseLineField(order, board.id, q.field, user, `Tái nhập - bỏ bảng vật tư ${order.maDH}`);
                changed.push(`${q.label}: ${fmtVND(value)} đ`);
            }
            if (value < 0) throw badRequest('Giá cost không được âm.');
            next[q.field] = value;
        }
        const fields = Object.keys(next);
        if (!fields.length) throw badRequest('Không có hạng mục nào để cập nhật.');

        await db.runAsync(`UPDATE order_items SET ${fields.map((f) => `${f} = ?`).join(', ')}, costDetail = ? WHERE id = ?`,
            [...fields.map((f) => next[f]), JSON.stringify(costDetail), board.id]);

        // TAM XUAT phan "lay kho". Neu kho vua bi don khac lay mat (hiem) -> huy bao gia hang muc nay de lap lai.
        for (const h of toHold) {
            try {
                await holds.hold(order, board, h.field, h.lines, user);
                changed.push(`tạm xuất kho ${h.lines.filter((l) => l.fromStock > 0).length} mã`);
            } catch (err) {
                await holds.releaseLineField(order, board.id, h.field, user, `Tái nhập - tạm xuất không thành công ${order.maDH}`);
                delete costDetail[h.field];
                await db.runAsync(`UPDATE order_items SET ${h.field} = 0, costDetail = ? WHERE id = ?`, [JSON.stringify(costDetail), board.id]);
                await lineItems.syncOrderSummary(order.id);
                throw conflict('Tồn kho vừa thay đổi nên chưa tạm xuất được. Vui lòng mở lại công cụ Kiểm tra kho và lưu lại.');
            }
        }
        after = { ...order, ...(await lineItems.syncOrderSummary(order.id)) };
    }

    const stillMissing = flow.missingQuotes(after).map((q) => q.label);
    sendGoogleChatMsg(order.maDH, user, `Báo giá cost${boardName ? ` [${boardName}]` : ''}: ${changed.join(' | ')}` + (stillMissing.length
        ? ` (còn chờ: ${stillMissing.join(', ')})`
        : ` — ĐÃ ĐỦ báo giá, tổng cost ${fmtVND(flow.totalCost(after))} đ. Sale nhân hệ số và báo khách.`));
    res.json({ success: true, ...next, tongCost: flow.totalCost(after), choBaoGia: stillMissing, detail: costDetail });
};

// =============================================
// PATCH STATUS - Cap nhat nhanh trang thai don hang
// Body: { ttDonHang, ttChotDon, ttQuyTrinh, lyDoHuy, giaBao, heSoSale }
// =============================================
exports.patchStatus = async (req, res) => {
    const before = await db.getAsync('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!before) throw notFound('Không tìm thấy đơn hàng.');

    const updates = {};
    for (const f of ['ttDonHang', 'ttChotDon', 'ttQuyTrinh', 'lyDoHuy']) {
        if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    for (const f of ['giaBao', 'heSoSale']) {
        if (req.body[f] !== undefined) {
            updates[f] = toNum(req.body[f]);
            if (updates[f] < 0) throw badRequest('Giá trị không được âm.');
        }
    }
    if (!Object.keys(updates).length) throw badRequest('Không có trường nào để cập nhật.');

    const base = await reopenIfNeeded(before, updates);
    if (updates.ttQuyTrinh === flow.QUOTED && before.ttQuyTrinh !== flow.QUOTED) updates.ngayBaoGia = today(); // moc tinh so ngay cho chot
    const after = { ...base, ...updates };
    assertFlow(before, after);
    const chot = chotDate(before, after);
    if (chot !== undefined) { updates.ngayChot = chot; after.ngayChot = chot; }
    updates.ttThanhToan = flow.paymentStatus(after);
    const fields = Object.keys(updates);
    await db.runAsync(`UPDATE orders SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
        [...fields.map((f) => updates[f]), req.params.id]);

    await syncDesignJob(after);
    const stockNote = await syncStockHolds(before, after, userName(req));
    notifyChanges(before, after, userName(req));
    res.json({ success: true, giaiDoan: flow.computeStage({ ...after, ...updates }), stockNote });
};

// =============================================
// THU TIEN - Sale hoac Ke toan ghi nhan tien khach tra cho don da chot
// Moi lan thu: cong vao "da thu" cua don, ghi 1 dong THU vao so quy, luu lich su.
// Thu tien chi de tru cong no; khong phan biet tai khoan nhan tien.
// =============================================
exports.getPayments = async (req, res) => {
    const rows = await db.allAsync('SELECT * FROM order_payments WHERE orderId = ? ORDER BY id DESC', [req.params.id]);
    res.json(rows.map((r) => ({ ...r, taiKhoanLabel: PAYMENT_ACCOUNTS[r.taiKhoan] || '' })));
};

exports.addPayment = async (req, res) => {
    const order = await db.getAsync('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) throw notFound('Không tìm thấy đơn hàng.');
    if (order.ttChotDon !== flow.CONFIRMED) throw badRequest('Chỉ thu tiền cho đơn đã chốt.');
    if (order.ttQuyTrinh === flow.CANCELLED) throw badRequest('Đơn đã hủy.');

    const soTien = Math.round(toNum(req.body.soTien));
    const ngay = /^\d{4}-\d{2}-\d{2}$/.test(req.body.ngay || '') ? req.body.ngay : today();
    const ghiChu = String(req.body.ghiChu || '').trim();
    const user = userName(req);
    if (soTien <= 0) throw badRequest('Số tiền thu phải lớn hơn 0.');
    if (soTien > flow.conNo(order)) throw badRequest(`Số tiền thu vượt quá số còn phải thu (${fmtVND(flow.conNo(order))} đ).`);

    // 1 cau lenh vua kiem tra vua cong -> bam 2 lan / 2 nguoi cung thu khong lam thu vuot
    const result = await db.runAsync(
        `UPDATE orders SET tamUng = COALESCE(tamUng, 0) + ? WHERE id = ? AND ${flow.debtSql()} >= ? - 0.5`,
        [soTien, order.id, soTien]);
    if (!result.changes) throw conflict('Số còn phải thu vừa thay đổi, vui lòng tải lại trang.');

    const after = { ...order, tamUng: toNum(order.tamUng) + soTien };
    // Dong tien don hang KHONG di vao so quy: quy chi quan ly ton dau + thu chi noi bo.
    try {
        await db.runAsync('INSERT INTO order_payments (orderId, maDH, ngay, soTien, ghiChu, nguoiThu, quyId, createdAt, taiKhoan) VALUES (?,?,?,?,?,?,?,?,?)',
            [order.id, order.maDH, ngay, soTien, ghiChu, user, '', new Date().toISOString(), '']);
    } catch (err) {
        await db.runAsync('UPDATE orders SET tamUng = COALESCE(tamUng, 0) - ? WHERE id = ?', [soTien, order.id]); // hoan tac
        throw err;
    }
    await db.runAsync('UPDATE orders SET ttThanhToan = ? WHERE id = ?', [flow.paymentStatus(after), order.id]);

    sendGoogleChatMsg(order.maDH, user, `Thu tiền: ${fmtVND(soTien)} đ — còn phải thu ${fmtVND(flow.conNo(after))} đ`);
    res.json({ success: true, daThu: flow.daThu(after), conNo: flow.conNo(after), ttThanhToan: flow.paymentStatus(after), giaiDoan: flow.computeStage(after) });
};

// =============================================
// GET NEXT STT (xem truoc ma don hang)
// =============================================
exports.getNextSTT = async (req, res) => {
    const row = await db.getAsync('SELECT last_seq FROM order_sequences WHERE prefix = ?', [req.query.prefix || '']);
    res.json({ stt: String((row ? row.last_seq : 0) + 1).padStart(3, '0') });
};

// =============================================
// SAVE ORDER - Tao moi / Cap nhat don hang
// =============================================
exports.saveOrder = async (req, res) => {
    const body = { ...(req.body || {}) };
    const user = userName(req);
    // Tien da thu va trang thai thanh toan do Ke toan ghi nhan (nut Thu tien), khong sua tu form don hang.
    delete body.tamUng;
    delete body.ttThanhToan;
    delete body.ngayChot; // tu ghi khi doi trang thai chot
    // Sale phu trach va thuong hieu di theo TAI KHOAN sale, khong chon theo tung don. Chi Admin doi duoc tren don.
    const isAdmin = hasRole(req.session.user, []);
    if (!isAdmin) { delete body.saleName; delete body.brandId; }
    if (!body.id) {
        const me = await db.getAsync('SELECT brandId FROM users WHERE id = ?', [req.session.user.id]);
        if (!String(body.saleName || '').trim()) body.saleName = user;
        if (!body.brandId) body.brandId = (me && me.brandId) || null;
    }
    // Chi phi R&D la bao gia cua bo phan Thiet ke: chi Truong BP Thiet ke / Admin duoc nhap.
    if (!hasRole(req.session.user, [ROLES.TBP])) delete body.giaThietKe;

    // --- CAP NHAT DON CU ---
    if (body.id) {
        const original = await db.getAsync('SELECT * FROM orders WHERE id = ?', [body.id]);
        if (!original) throw notFound('Không tìm thấy đơn hàng.');
        const incoming = {};
        for (const f of ['ttChotDon', 'ttQuyTrinh']) if (body[f] !== undefined) incoming[f] = body[f];
        const before = await reopenIfNeeded(original, incoming);

        // Don sx: danh sach loai mach. Chi sua duoc khi chua chot; doi so luong mach nao thi mach do phai bao gia lai.
        const sx = !isRnd(before);
        const locked = before.ttChotDon === flow.CONFIRMED;
        let plan = null;
        let summary = {};
        if (sx) {
            const current = await lineItems.loadLines(before.id);
            plan = Array.isArray(body.items) && !locked ? lineItems.planLines(body.items, current) : { lines: current, removedIds: [], reset: [] };
            summary = lineItems.summarize(plan.lines);
            // Ten mach va so luong tren don la tong hop tu cac loai mach, khong lay tu form
            for (const f of ['tenMach', ...lineItems.QTY_FIELDS]) body[f] = summary[f];
        }

        // Loai don khong doi sau khi tao (da gan voi dau viec thiet ke hoac PO / lenh san xuat)
        const data = applyTypeRules(normalizeOrder(body, before), before.loaiDV, false);
        // Don da chot: khong doi gia cost R&D nua
        if (locked) data.giaThietKe = before.giaThietKe;

        const after = { ...before, ...data, ...summary };
        assertFlow(before, after);
        const chot = chotDate(before, after);
        if (chot !== undefined) { data.ngayChot = chot; after.ngayChot = chot; }
        data.ttThanhToan = flow.paymentStatus(after);
        await db.runAsync(`UPDATE orders SET ${ORDER_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
            [...ORDER_FIELDS.map((f) => data[f]), body.id]);
        if (after.ttQuyTrinh === flow.QUOTED && before.ttQuyTrinh !== flow.QUOTED) {
            after.ngayBaoGia = today(); // moc tinh so ngay cho chot
            await db.runAsync('UPDATE orders SET ngayBaoGia = ? WHERE id = ?', [after.ngayBaoGia, body.id]);
        }
        if (sx) {
            await lineItems.writeLines(before.id, plan);
            require('../utils/googleHelper').ensureBoardFolders(before.id).catch(() => {}); // thu muc rieng cua tung loai mach (chay nen)
            await lineItems.syncOrderSummary(before.id);
            if (plan.reset.length) sendGoogleChatMsg(before.maDH, user, `Sale đổi số lượng — cần báo giá lại: ${plan.reset.join('; ')}`);
            await holds.reconcile(before, user); // xoa loai mach / doi so luong -> tai nhap phan da tam xuat
        }
        const resetFields = plan ? plan.reset : [];

        await syncDesignJob(after);
        const stockNote = await syncStockHolds(original, after, user);
        notifyChanges(original, after, user);
        return res.json({
            success: true, id: before.id, maDH: before.maDH, giaiDoan: flow.computeStage(after), baoGiaLai: resetFields.length > 0,
            itemsLocked: sx && locked && Array.isArray(body.items), stockNote,
            folderId: before.folderId, inputFolderId: before.inputFolderId,
            outputFolderId: before.outputFolderId, documentFolderId: before.documentFolderId
        });
    }

    // --- TAO MOI DON HANG ---
    const maKH = String(body.maKH || '').trim();
    if (!maKH) throw badRequest('Vui lòng chọn khách hàng.');
    const customer = await db.getAsync('SELECT id, maKH, customerFolderId FROM customers WHERE maKH = ?', [maKH]);
    if (!customer) throw badRequest(`Khách hàng ${maKH} không tồn tại.`);

    const loaiDV = body.loaiDV === ORDER_TYPES.RND ? ORDER_TYPES.RND : ORDER_TYPES.SX;
    // Don sx: cac loai mach. (Neu noi goi cu chi gui 1 ten mach + so luong thi coi nhu don co 1 loai mach.)
    let plan = null;
    let summary = {};
    if (loaiDV === ORDER_TYPES.SX) {
        const items = Array.isArray(body.items) && body.items.length ? body.items
            : [{ tenMach: body.tenMach, soLuongPCB: body.soLuongPCB, soLuongLK: body.soLuongLK, soLuongGiaCong: body.soLuongGiaCong }];
        plan = lineItems.planLines(items, []);
        summary = lineItems.summarize(plan.lines);
        for (const f of ['tenMach', ...lineItems.QTY_FIELDS]) body[f] = summary[f];
    }
    // Sale phu trach: mac dinh la nguoi tao don (dung cho bao cao theo Sale)
    if (!String(body.saleName || '').trim()) body.saleName = user;
    const data = applyTypeRules(normalizeOrder({ ...body, ngayTao: body.ngayTao || today() }), loaiDV, true);
    assertFlow({}, { loaiDV, ...data, ...summary });
    data.ttThanhToan = flow.paymentStatus(data);

    // Ma DH: YYMM_<maKH>_<STT 3 so>
    const { yy, mm } = ym(data.ngayTao);
    const prefix = `${yy}${mm}_${maKH}`;
    const maDH = `${prefix}_${String(await db.nextSeq(prefix)).padStart(3, '0')}`;

    // Thu muc Drive: <thu muc KH>/<maDH>/... Neu KH chua co thu muc (vd import tu Excel) thi tao luon.
    let folders = {
        folderId: body.folderId || null, inputFolderId: body.inputFolderId || null,
        outputFolderId: body.outputFolderId || null, documentFolderId: body.documentFolderId || null
    };
    if (!folders.folderId) {
        let custFolderId = customer.customerFolderId;
        if (!custFolderId) {
            const ext = await db.getAsync('SELECT customerFolderId FROM customers_ext WHERE maKH = ?', [maKH]);
            custFolderId = (ext && ext.customerFolderId) || await ensureCustomerFolder(maKH);
            if (custFolderId) await db.runAsync('UPDATE customers SET customerFolderId = ? WHERE id = ?', [custFolderId, customer.id]);
        }
        const parentId = custFolderId || await getSetting('google_drive_root_id');
        folders = await createOrderFolders(maDH, parentId);
    }

    const cols = ['maDH', 'maKH', 'loaiDV', ...ORDER_FIELDS, 'folderId', 'inputFolderId', 'outputFolderId', 'documentFolderId'];
    const values = [maDH, maKH, loaiDV, ...ORDER_FIELDS.map((f) => data[f]),
        folders.folderId, folders.inputFolderId, folders.outputFolderId, folders.documentFolderId];
    const result = await db.runAsync(
        `INSERT INTO orders (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, values);

    if (plan) {
        await lineItems.writeLines(result.lastID, plan);
        await lineItems.syncOrderSummary(result.lastID);
    }
    // Thu muc tung bo phan trong "2. OUTPUT" (loi Drive khong lam hong viec tao don)
    let deptFolders = {};
    try { deptFolders = await ensureAllDeptFolders({ id: result.lastID, loaiDV, inputFolderId: folders.inputFolderId, outputFolderId: folders.outputFolderId, deptFolders: null }); } catch (e) { /* bo qua */ }
    require('../utils/googleHelper').ensureBoardFolders(result.lastID).catch(() => {}); // thu muc rieng cua tung loai mach (chay nen)
    await syncDesignJob({ id: result.lastID, maDH, loaiDV, ...data, ...folders, deptFolders: JSON.stringify(deptFolders) });
    const waiting = flow.missingQuotes({ loaiDV, ...data, ...summary }).map((q) => q.label);
    sendGoogleChatMsg(maDH, user, (loaiDV === ORDER_TYPES.RND
        ? `Đơn R&D mới: ${data.tenMach || ''}`
        : `Đơn hàng mới (${plan.lines.length} loại mạch): ${data.tenMach || ''} | PCB:${data.soLuongPCB || 0} LK:${data.soLuongLK || 0} SX:${data.soLuongGiaCong || 0}`)
        + (waiting.length ? ` — cần báo giá cost: ${waiting.join(', ')}` : ''));

    res.json({ success: true, id: result.lastID, maDH, loaiDV, ...folders });
};

// =============================================
// DELETE ORDER
// =============================================
exports.deleteOrder = async (req, res) => {
    const id = req.params.id;
    const order = await db.getAsync('SELECT id FROM orders WHERE id = ?', [id]);
    if (!order) throw notFound('Không tìm thấy đơn hàng.');

    // Khong xoa don da co PO / lenh san xuat de tranh chung tu mo coi. Hay chuyen trang thai sang "Hủy đơn".
    const linked = await db.getAsync(
        `SELECT (SELECT COUNT(*) FROM purchase_orders WHERE orderId = ?) AS po,
                (SELECT COUNT(*) FROM production_orders WHERE orderId = ?) AS wo`, [id, id]);
    if (linked.po || linked.wo) {
        throw conflict(`Đơn hàng đã có ${linked.po} PO mua hàng và ${linked.wo} lệnh sản xuất nên không thể xóa. Hãy chuyển trạng thái sang "Hủy đơn".`);
    }

    // Vat tu dang tam xuat cho don nay duoc tai nhap truoc khi xoa
    const full = await db.getAsync('SELECT id, maDH FROM orders WHERE id = ?', [id]);
    await holds.releaseOrder(full, userName(req), `Tái nhập - xóa đơn ${full.maDH}`);
    await db.runAsync('DELETE FROM design_jobs WHERE orderId = ?', [id]);
    await db.runAsync('DELETE FROM order_items WHERE orderId = ?', [id]);
    await db.runAsync('DELETE FROM order_documents WHERE orderId = ?', [id]);
    await db.runAsync('DELETE FROM orders WHERE id = ?', [id]);
    res.json({ success: true });
};
