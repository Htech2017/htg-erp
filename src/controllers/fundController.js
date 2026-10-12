const crypto = require('crypto');
const xlsx = require('xlsx');
const db = require('../models/database');
const { ROLES, FUNDS, FUND_ROLES, GENERAL_FUND, PAYMENT_ACCOUNTS, PERMS } = require('../config');
const { hasRole } = require('../middlewares/authMiddleware');
const { toNum, today, ym, userName, badRequest, notFound, forbidden, conflict } = require('../utils/http');
const { verifyPassword } = require('../utils/password');

const PENDING = 'Chờ duyệt';
const APPROVED = 'Đã duyệt';

const newId = (prefix) => `${prefix}${Date.now()}${crypto.randomBytes(2).toString('hex')}`;

// Chuan hoa ngay: nhan Date, so serial cua Excel, hoac chuoi -> YYYY-MM-DD
function normalizeDate(v) {
    if (v === undefined || v === null || v === '') return today();
    const p = (n) => String(n).padStart(2, '0');
    if (v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    if (typeof v === 'number') {
        const d = xlsx.SSF.parse_date_code(v);
        if (d) return `${d.y}-${p(d.m)}-${p(d.d)}`;
    }
    const s = String(v).trim();
    const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // dd/mm/yyyy
    if (dmy) return `${dmy[3]}-${p(dmy[2])}-${p(dmy[1])}`;
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : today();
}

function normalizeLoai(v) {
    const s = String(v || '').trim().toUpperCase();
    if (s === 'THU' || s === 'CHI') return s;
    throw badRequest('Loại giao dịch phải là THU hoặc CHI.');
}

// ---------- BON QUY + HAI TAI KHOAN ----------
// Quy: chung | rnd | muahang | sanxuat (xem FUNDS, FUND_ROLES trong config). Tai khoan giu tien: 'congty' | 'canhan'.
// Admin va Ke toan thao tac moi quy; moi phong chi thao tac quy cua phong minh.
function allowedFunds(user) {
    if (hasRole(user, [ROLES.KT])) return Object.keys(FUNDS);
    return Object.keys(FUNDS).filter((quy) => FUND_ROLES[quy].use.length && hasRole(user, FUND_ROLES[quy].use));
}
function resolveFund(req, value) {
    const allowed = allowedFunds(req.session.user);
    const quy = value || allowed[0];
    if (!FUNDS[quy]) throw badRequest('Quỹ không hợp lệ.');
    if (!allowed.includes(quy)) throw forbidden(`Bạn không có quyền thao tác ${FUNDS[quy]}.`);
    return quy;
}
function resolveAccount(value, fallback = 'congty') {
    const tk = value || fallback;
    if (!PAYMENT_ACCOUNTS[tk]) throw badRequest('Tài khoản không hợp lệ.');
    return tk;
}
// Duyet chi: Admin duyet moi quy; truong bo phan duyet quy cua phong minh (FUND_ROLES[quy].approve).
function assertCanApprove(user, quy) {
    const roles = FUND_ROLES[quy] ? FUND_ROLES[quy].approve : [];
    if (!hasRole(user, roles)) throw forbidden(`Bạn không có quyền duyệt chi ${FUNDS[quy] || ''}.`);
}

// Tong thu / chi / ton cua tung quy, tach theo tai khoan giu tien
function summarize(rows) {
    const blank = () => ({ thu: 0, chi: 0, ton: 0 });
    const out = {};
    for (const quy of Object.keys(FUNDS)) out[quy] = { ...blank(), taiKhoan: { congty: blank(), canhan: blank(), chuaRo: blank() } };
    for (const r of rows) {
        const f = out[r.quy];
        if (!f) continue;
        const acc = f.taiKhoan[r.taiKhoan] || f.taiKhoan.chuaRo;
        const tien = toNum(r.tien);
        for (const b of [f, acc]) {
            if (r.loai === 'THU') { b.thu += tien; b.ton += tien; } else { b.chi += tien; b.ton -= tien; }
        }
    }
    return out;
}

// ---------- DE NGHI CHI ----------
exports.saveRequest = async (req, res) => {
    const { id, ngay } = req.body;
    const noiDung = String(req.body.noiDung || '').trim();
    const tien = toNum(req.body.tien);
    const user = userName(req);

    if (!noiDung) throw badRequest('Vui lòng nhập nội dung đề nghị.');
    if (tien <= 0) throw badRequest('Số tiền phải lớn hơn 0.');

    if (id) {
        // Sua phieu khong doi quy cua phieu
        const result = await db.runAsync(
            'UPDATE requests_chi SET ngay=?, noiDung=?, tien=? WHERE id=? AND nguoi=? AND status=?',
            [normalizeDate(ngay), noiDung, tien, id, user, PENDING]);
        if (!result.changes) throw forbidden('Không có quyền sửa hoặc phiếu đã duyệt');
        return res.json({ success: true });
    }

    // Ma phieu: YYYYMM + STT 3 so (vd 202604016). Cap so bang 1 cau lenh nen khong trung khi 2 nguoi tao cung luc.
    const { yyyy, mm } = ym(ngay);
    const prefix = `${yyyy}${mm}`;
    const seq = await db.nextSeq(`REQ_${prefix}`,
        'SELECT COALESCE(MAX(CAST(substr(id, 7) AS INTEGER)), 0) + 1 FROM requests_chi WHERE id LIKE ?', [`${prefix}%`]);
    const newReqId = `${prefix}${String(seq).padStart(3, '0')}`;

    const quy = resolveFund(req, req.body.quy);
    await db.runAsync('INSERT INTO requests_chi (id, ngay, noiDung, tien, nguoi, status, quy) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [newReqId, normalizeDate(ngay), noiDung, tien, user, PENDING, quy]);
    res.json({ success: true, newId: newReqId });
};

exports.deleteRequest = async (req, res) => {
    // Chi cho xoa neu dung nguoi tao va phieu con cho duyet
    const result = await db.runAsync('DELETE FROM requests_chi WHERE id=? AND nguoi=? AND status=?',
        [req.params.id, userName(req), PENDING]);
    if (!result.changes) throw forbidden('Không có quyền xóa hoặc phiếu đã duyệt');
    res.json({ success: true });
};

exports.approveRequest = async (req, res) => {
    const { id } = req.body;
    const row = await db.getAsync('SELECT * FROM requests_chi WHERE id = ?', [id]);
    if (!row) throw notFound('Không tìm thấy đề nghị chi.');
    assertCanApprove(req.session.user, row.quy);
    const taiKhoan = resolveAccount(req.body.taiKhoan); // chi tu tai khoan nao

    // Chi chuyen trang thai khi phieu CON cho duyet -> bam duyet 2 lan cung khong tao 2 khoan chi.
    const result = await db.runAsync('UPDATE requests_chi SET status = ? WHERE id = ? AND status = ?', [APPROVED, id, PENDING]);
    if (!result.changes) throw conflict('Phiếu này đã được duyệt trước đó.');

    try {
        await db.runAsync(`INSERT INTO so_quy (id, ngay, loai, hangMuc, tien, nguoi, note, quy, taiKhoan) VALUES (?, ?, 'CHI', ?, ?, ?, ?, ?, ?)`,
            [newId('TC'), today(), `CHI DUYỆT: ${row.noiDung}`, row.tien, userName(req), `Duyệt từ phiếu ${id}`, row.quy, taiKhoan]);
    } catch (err) {
        await db.runAsync('UPDATE requests_chi SET status = ? WHERE id = ?', [PENDING, id]); // hoan tac
        throw err;
    }
    res.json({ success: true });
};

// ---------- SO QUY ----------
exports.getFundData = async (req, res) => {
    const funds = allowedFunds(req.session.user);
    const marks = funds.map(() => '?').join(', ');
    const [soQuy, dsDeNghi] = await Promise.all([
        db.allAsync(`SELECT * FROM so_quy WHERE quy IN (${marks}) ORDER BY ngay DESC, id DESC`, funds),
        db.allAsync(`SELECT * FROM requests_chi WHERE quy IN (${marks}) ORDER BY id DESC`, funds)
    ]);
    const summary = summarize(soQuy);
    res.json({
        canTransfer: hasRole(req.session.user, PERMS.FUND_TRANSFER), generalFund: GENERAL_FUND,
        soQuy, dsDeNghi, summary,
        funds: funds.map((key) => ({ key, label: FUNDS[key] })),
        canApprove: funds.filter((quy) => { try { assertCanApprove(req.session.user, quy); return true; } catch (e) { return false; } })
    });
};

// Cap quy: Quy chung chi cho quy cua 1 phong (hoac phong hoan tra ve Quy chung).
// Ghi 2 dong cung ma `chuyenQuy`: CHI o quy nguon, THU o quy nhan. Body: { from, to, tien, taiKhoan, ngay, note }
exports.transfer = async (req, res) => {
    const { from, to } = req.body;
    const tien = toNum(req.body.tien);
    if (!FUNDS[from] || !FUNDS[to] || from === to) throw badRequest('Quỹ nguồn và quỹ nhận không hợp lệ.');
    if (from !== GENERAL_FUND && to !== GENERAL_FUND) throw badRequest('Chỉ cấp từ Quỹ chung cho quỹ các phòng, hoặc hoàn từ quỹ phòng về Quỹ chung.');
    if (tien <= 0) throw badRequest('Số tiền phải lớn hơn 0.');

    const taiKhoan = resolveAccount(req.body.taiKhoan);
    const ngay = normalizeDate(req.body.ngay);
    const note = String(req.body.note || '').trim();
    const user = userName(req);

    // Khong cap vuot so du cua quy nguon
    const src = await db.getAsync(`SELECT COALESCE(SUM(CASE WHEN loai = 'THU' THEN tien ELSE -tien END), 0) AS ton FROM so_quy WHERE quy = ?`, [from]);
    if (tien > src.ton) throw badRequest(`${FUNDS[from]} chỉ còn ${new Intl.NumberFormat('vi-VN').format(src.ton)} đ, không đủ để chuyển.`);

    const code = newId('CQ');
    const label = `${FUNDS[from]} → ${FUNDS[to]}`;
    await db.runAsync('INSERT INTO so_quy (id, ngay, loai, hangMuc, tien, nguoi, note, quy, taiKhoan, chuyenQuy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`${code}_C`, ngay, 'CHI', `CẤP QUỸ: ${label}`, tien, user, note, from, taiKhoan, code]);
    try {
        await db.runAsync('INSERT INTO so_quy (id, ngay, loai, hangMuc, tien, nguoi, note, quy, taiKhoan, chuyenQuy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [`${code}_T`, ngay, 'THU', `NHẬN QUỸ: ${label}`, tien, user, note, to, taiKhoan, code]);
    } catch (err) {
        await db.runAsync('DELETE FROM so_quy WHERE id = ?', [`${code}_C`]); // hoan tac
        throw err;
    }
    res.json({ success: true, code });
};

exports.createTransaction = async (req, res) => {
    const hangMuc = String(req.body.hangMuc || '').trim();
    const tien = toNum(req.body.tien);
    if (!hangMuc) throw badRequest('Vui lòng nhập hạng mục.');
    if (tien <= 0) throw badRequest('Số tiền phải lớn hơn 0.');

    // Ma giao dich va nguoi lap do server quyet dinh, khong lay tu trinh duyet.
    const id = newId('TC');
    await db.runAsync('INSERT INTO so_quy (id, ngay, loai, hangMuc, tien, nguoi, note, quy, taiKhoan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, normalizeDate(req.body.ngay), normalizeLoai(req.body.loai), hangMuc, tien, userName(req), req.body.note || '',
            resolveFund(req, req.body.quy), resolveAccount(req.body.taiKhoan)]);
    res.json({ success: true, id });
};

exports.resetFund = async (req, res) => {
    // Xac nhan bang mat khau cua chinh Admin dang dang nhap (khong con mat khau viet cung trong code).
    const me = await db.getAsync('SELECT password FROM users WHERE id = ?', [req.session.user.id]);
    if (!me || !verifyPassword(req.body.password, me.password)) throw forbidden('Mật khẩu không chính xác!');

    await db.runAsync('DELETE FROM so_quy');
    await db.runAsync('DELETE FROM requests_chi');
    await db.runAsync("DELETE FROM order_sequences WHERE prefix LIKE 'REQ_%'");
    console.warn(`[QUY] ${userName(req)} da reset toan bo so quy luc ${new Date().toISOString()}`);
    res.json({ success: true });
};

exports.importExcel = async (req, res) => {
    if (!req.file) throw badRequest('Server không nhận được file Excel từ giao diện.');

    let rows;
    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer', cellDates: true });
        rows = xlsx.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    } catch (e) {
        throw badRequest('Lỗi xử lý file Excel. Vui lòng tải Template chuẩn để sử dụng.');
    }
    if (!rows.length) throw badRequest('File Excel trống hoặc sai định dạng!');

    const user = userName(req);
    const quy = resolveFund(req, req.body.quy); // import vao quy dang chon tren giao dien
    const accountOf = (v) => (/c[áa]\s*nh[âa]n/i.test(String(v || '')) ? 'canhan' : 'congty'); // cot "Tài khoản": Công ty / Cá nhân
    let count = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const loai = String(row['Loại'] || row.loai || '').trim().toUpperCase();
        const tien = toNum(row['Số tiền'] || row.tien);
        // Dong sai loai hoac khong co so tien se bi bo qua (truoc day bi ghi nham thanh THU 0 dong).
        if ((loai !== 'THU' && loai !== 'CHI') || tien <= 0) { skipped.push(i + 2); continue; }

        await db.runAsync('INSERT INTO so_quy (id, ngay, loai, hangMuc, tien, nguoi, note, quy, taiKhoan) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [`${newId('EX')}_${i}`, normalizeDate(row['Ngày'] || row.ngay), loai,
                row['Hạng mục'] || row.hangMuc || 'Import từ Excel', tien,
                row['Người lập'] || row.nguoi || user, row['Ghi chú'] || row.note || '',
                quy, accountOf(row['Tài khoản'] || row.taiKhoan)]);
        count += 1;
    }
    res.json({ success: true, count, skipped });
};

exports.downloadTemplate = (req, res) => {
    const ws = xlsx.utils.json_to_sheet([
        { 'Ngày': '2026-04-17', 'Loại': 'THU', 'Hạng mục': 'Khách hàng thanh toán đợt 1', 'Số tiền': 15000000, 'Tài khoản': 'Công ty', 'Người lập': 'Admin', 'Ghi chú': 'Chuyển khoản VCB' },
        { 'Ngày': '2026-04-18', 'Loại': 'CHI', 'Hạng mục': 'Mua linh kiện điện tử', 'Số tiền': 2500000, 'Người lập': 'Admin', 'Ghi chú': 'Thanh toán tiền mặt' }
    ]);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Template_ThuChi');

    res.setHeader('Content-Disposition', 'attachment; filename="Template_Import_Quy.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));
};
