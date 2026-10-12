// TINH TRANG VAT TU cho san xuat cua 1 loai mach: PCB, linh kien, stencil.
// Nguon linh kien co 3 truong hop:
//   - Cong ty lo 100%      : don co hang muc Linh kien, BOM khong co dong khach cap  -> theo bang ghep bo (kho + mua)
//   - Khach cap 100%       : don KHONG co hang muc Linh kien (chi san xuat)           -> theo doi bang trang thai "khach da gui" cua mach
//   - Mot phan khach cap   : BOM co dong danh dau "Khach cap"                          -> dong do theo doi so luong khach gui, con lai kho + mua
// PCB tuong tu: don co hang muc PCB -> theo PO PCB cua don; khong co -> khach cap, theo trang thai "khach da gui".
// Stencil: trang thai nhap tay (Khong can / Chua co / Da dat / Da co).
const db = require('../models/database');
const { toNum, parseJson } = require('./http');

const KHACH_STATUSES = ['Chưa nhận', 'Nhận một phần', 'Đã nhận đủ'];
const STENCIL_STATUSES = ['Chưa xác định', 'Không cần', 'Chưa có', 'Đã đặt', 'Đã có', 'Khách cấp - chưa nhận', 'Khách cấp - đã nhận'];
const STENCIL_READY = ['Không cần', 'Đã có', 'Khách cấp - đã nhận'];
const PO_RANK = ['Hủy', 'Chờ duyệt', 'Đã duyệt', 'Đã đặt hàng', 'Đang giao', 'Đã nhận'];

// boards: cac dong order_items (co soLuong*, costDetail, materials, kitAt). Tra ve Map lineId -> tinh trang vat tu.
async function forBoards(boards) {
    const out = new Map();
    if (!boards.length) return out;
    const { buildKit } = require('../controllers/buyingController'); // nap tre, tranh vong lap require
    const ids = boards.map((b) => b.id), orderIds = [...new Set(boards.map((b) => b.orderId))];
    const marks = (a) => a.map(() => '?').join(', ');
    const holds = await db.allAsync(`SELECT * FROM stock_holds WHERE field = 'giaCostLK' AND status = 'issued' AND lineId IN (${marks(ids)})`, ids);
    const lines = await db.allAsync(`SELECT * FROM buy_lines WHERE lineId IN (${marks(ids)})`, ids);
    const pos = await db.allAsync(`SELECT orderId, status, expectedDate, poCode FROM purchase_orders WHERE type = 'PCB' AND orderId IN (${marks(orderIds)})`, orderIds);
    for (const b of boards) {
        const m = parseJson(b.materials, {}) || {};
        // --- PCB ---
        let pcb;
        if (toNum(b.soLuongPCB) > 0) {
            const mine = pos.filter((p) => p.orderId === b.orderId && p.status !== 'Hủy').sort((x, y) => PO_RANK.indexOf(y.status) - PO_RANK.indexOf(x.status));
            const best = mine[0];
            pcb = { source: 'Công ty đặt', status: best ? `${best.status}${best.status !== 'Đã nhận' && best.expectedDate ? ' · dự kiến ' + best.expectedDate : ''}` : 'Chưa đặt PCB', ready: !!best && mine.every((p) => p.status === 'Đã nhận'), manual: false };
        } else {
            const st = KHACH_STATUSES.includes(m.pcbKhach) ? m.pcbKhach : KHACH_STATUSES[0];
            pcb = { source: 'Khách cấp', status: st, ready: st === 'Đã nhận đủ', manual: true };
        }
        // --- Linh kien ---
        let lk;
        if (toNum(b.soLuongLK) > 0) {
            const kit = buildKit({ ...b, costDetail: typeof b.costDetail === 'string' ? b.costDetail : JSON.stringify(b.costDetail || {}) }, holds.filter((h) => h.lineId === b.id), lines.filter((l) => l.lineId === b.id));
            const src = kit.khachRows ? `Một phần khách cấp (${kit.khachRows}/${kit.total} mã)` : 'Công ty lo (kho + mua)';
            lk = kit.hasBom
                ? { source: src, status: b.kitAt ? `Đã bàn giao bộ linh kiện${kit.complete ? '' : ' (thiếu)'}` : `Đủ ${kit.ready}/${kit.total} mã`, ready: !!b.kitAt || kit.complete, manual: false, ready_n: kit.ready, total_n: kit.total }
                : { source: 'Công ty lo', status: b.kitAt ? 'Đã bàn giao' : 'Không có bảng vật tư (báo giá nhập tay)', ready: !!b.kitAt, manual: false };
        } else {
            const st = KHACH_STATUSES.includes(m.lkKhach) ? m.lkKhach : KHACH_STATUSES[0];
            lk = { source: 'Khách cấp 100%', status: st, ready: st === 'Đã nhận đủ', manual: true };
        }
        // --- Stencil ---
        const stS = STENCIL_STATUSES.includes(m.stencil) ? m.stencil : STENCIL_STATUSES[0];
        const stencil = { source: /^Khách cấp/.test(stS) ? 'Khách cấp' : (stS === 'Không cần' ? '—' : 'Công ty'), status: stS, ready: STENCIL_READY.includes(stS), manual: true };
        out.set(b.id, { pcb, lk, stencil, ready: pcb.ready && lk.ready && stencil.ready, note: m.note || '', updatedBy: m.updatedBy || '', updatedAt: m.updatedAt || '' });
    }
    return out;
}

module.exports = { forBoards, KHACH_STATUSES, STENCIL_STATUSES };
