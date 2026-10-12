// Quy trinh don hang (dung chung cho controller va bao cao):
//   1. Sale tao don
//   2. Cac bo phan bao gia cost      -> giai doan "Chờ bộ phận báo giá"
//   3. Sale nhan he so, bao khach    -> "Chờ Sale báo khách" -> "Chờ khách phản hồi"
//   4. Khach chot / khong chot       -> "Đang thực hiện" / "Không chốt"
//   5. Mua hang - San xuat (don sx) hoac Thiet ke (don rnd) thuc hien don da chot
//   6. Ke toan thu tien              -> "Chờ thu tiền" -> "Hoàn thành"
const { ROLES, ORDER_TYPES, PENDING_WARN_DAYS } = require('../config');
const { toNum, parseJson } = require('./http');

const CANCELLED = 'Hủy đơn';     // ttQuyTrinh
const QUOTED = 'Đã báo giá';     // ttQuyTrinh
const DONE = 'Hoàn thành';       // ttQuyTrinh / ttDonHang
const CONFIRMED = 'Đã chốt';     // ttChotDon
const REJECTED = 'Không chốt';   // ttChotDon

const STAGES = {
    WAIT_COST: 'Chờ bộ phận báo giá',
    WAIT_SALE: 'Chờ Sale báo khách',
    WAIT_CUSTOMER: 'Chờ khách phản hồi',
    IN_PROGRESS: 'Đang thực hiện',
    WAIT_PAYMENT: 'Chờ thu tiền',
    DONE: 'Hoàn thành',
    REJECTED: 'Không chốt',
    CANCELLED: 'Đã hủy'
};

// Moi hang muc can bao gia: cot luu gia cost, bo phan chiu trach nhiem, cot so luong (neu co)
const QUOTE_ITEMS = [
    { field: 'giaThietKe',     label: 'Thiết kế (R&D)', type: ORDER_TYPES.RND, roles: [ROLES.TBP] },
    { field: 'giaCostPCB',     label: 'PCB',            type: ORDER_TYPES.SX,  roles: [ROLES.MH_PCB, ROLES.TBP_MH], qtyField: 'soLuongPCB' },
    { field: 'giaCostLK',      label: 'Linh kiện',      type: ORDER_TYPES.SX,  roles: [ROLES.MH_LK, ROLES.TBP_MH],  qtyField: 'soLuongLK' },
    { field: 'giaCostGiaCong', label: 'Sản xuất',       type: ORDER_TYPES.SX,  roles: [ROLES.QLSX],   qtyField: 'soLuongGiaCong' }
];

// Cac hang muc ma don nay can bo phan bao gia
function requiredQuotes(order) {
    const type = order.loaiDV === ORDER_TYPES.RND ? ORDER_TYPES.RND : ORDER_TYPES.SX;
    return QUOTE_ITEMS.filter((q) => q.type === type && (!q.qtyField || toNum(order[q.qtyField]) > 0));
}
// Don sx co nhieu loai mach: 1 bo phan chi "xong" khi da bao gia cho MOI loai mach co hang muc cua minh.
// Danh sach bo phan con thieu duoc tinh san va luu o orders.quotePending (xem utils/orderItems.js).
function missingQuotes(order) {
    if (order.loaiDV !== ORDER_TYPES.RND && order.quotePending !== null && order.quotePending !== undefined) {
        const labels = parseJson(order.quotePending, []);
        return QUOTE_ITEMS.filter((q) => q.type === ORDER_TYPES.SX && labels.includes(q.label));
    }
    return requiredQuotes(order).filter((q) => toNum(order[q.field]) <= 0);
}
const totalCost = (order) => requiredQuotes(order).reduce((s, q) => s + toNum(order[q.field]), 0);

// So tien khach phai tra = gia bao + VAT - chiet khau
function tongCong(order) {
    const gia = toNum(order.giaBao);
    return Math.round(gia + gia * toNum(order.vat) / 100 - gia * toNum(order.chietKhau) / 100);
}
const daThu = (order) => toNum(order.tamUng);
const conNo = (order) => tongCong(order) - daThu(order);

function paymentStatus(order) {
    if (daThu(order) <= 0) return 'Chưa thanh toán';
    return conNo(order) <= 0 ? 'Thu đủ' : 'Tạm ứng';
}

function computeStage(order) {
    if (order.ttQuyTrinh === CANCELLED) return STAGES.CANCELLED;
    if (order.ttChotDon === REJECTED) return STAGES.REJECTED;
    if (order.ttChotDon === CONFIRMED) {
        const delivered = order.ttQuyTrinh === DONE || order.ttDonHang === DONE;
        if (!delivered) return STAGES.IN_PROGRESS;
        return conNo(order) <= 0 ? STAGES.DONE : STAGES.WAIT_PAYMENT;
    }
    if (missingQuotes(order).length) return STAGES.WAIT_COST;
    return order.ttQuyTrinh === QUOTED ? STAGES.WAIT_CUSTOMER : STAGES.WAIT_SALE;
}

// Don dang cho chot (chua Chot / Khong chot / Huy): so ngay da cho, tinh tu ngay bao gia cho khach (chua bao gia thi tu ngay tao don)
function pendingInfo(order) {
    const open = order.ttChotDon !== CONFIRMED && order.ttChotDon !== REJECTED && order.ttQuyTrinh !== CANCELLED && order.ttQuyTrinh !== DONE;
    if (!open) return { soNgayCho: null, quaHan: false };
    const from = new Date(String(order.ngayBaoGia || order.ngayTao || '').slice(0, 10));
    if (Number.isNaN(from.getTime())) return { soNgayCho: null, quaHan: false };
    const soNgayCho = Math.max(0, Math.floor((Date.now() - from.getTime()) / 86400000));
    return { soNgayCho, quaHan: soNgayCho > PENDING_WARN_DAYS };
}

// Bo sung cac truong tinh toan khi tra don hang ve giao dien
function decorate(order) {
    return {
        ...order,
        tongCong: tongCong(order),
        daThu: daThu(order),
        // Chi don da chot (chua huy) moi phat sinh cong no
        conNo: order.ttChotDon === CONFIRMED && order.ttQuyTrinh !== CANCELLED ? conNo(order) : 0,
        tongCost: totalCost(order),
        giaiDoan: computeStage(order),
        ...pendingInfo(order),   // soNgayCho, quaHan (qua PENDING_WARN_DAYS ngay chua chot)
        choBaoGia: missingQuotes(order).map((q) => q.label)
    };
}

// ----- Bieu thuc SQL dung chung cho cong no -----
// Cong no chi phat sinh tu don DA CHOT va chua huy; tinh tren tong tien khach phai tra (da gom VAT, chiet khau).
const totalSql = (a = '') => `(COALESCE(${a}giaBao, 0) * (1 + COALESCE(${a}vat, 0) / 100.0 - COALESCE(${a}chietKhau, 0) / 100.0))`;
const debtSql = (a = '') => `(${totalSql(a)} - COALESCE(${a}tamUng, 0))`;
const receivableSql = (a = '') => `(${a}ttChotDon = '${CONFIRMED}' AND COALESCE(${a}ttQuyTrinh, '') != '${CANCELLED}')`;

module.exports = {
    CANCELLED, QUOTED, DONE, CONFIRMED, REJECTED, STAGES, QUOTE_ITEMS,
    pendingInfo, requiredQuotes, missingQuotes, totalCost, tongCong, daThu, conNo, paymentStatus, computeStage, decorate,
    totalSql, debtSql, receivableSql
};
