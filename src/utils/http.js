// Cac ham dung chung cho controller.

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const badRequest = (msg) => new HttpError(400, msg);
const notFound = (msg = 'Không tìm thấy dữ liệu') => new HttpError(404, msg);
const forbidden = (msg = 'Bạn không có quyền thực hiện thao tác này') => new HttpError(403, msg);
const conflict = (msg) => new HttpError(409, msg);

// Doc chuoi JSON luu trong DB, khong bao gio nem loi.
function parseJson(str, fallback = []) {
    if (str === null || str === undefined || str === '') return fallback;
    if (typeof str !== 'string') return str;
    try {
        const v = JSON.parse(str);
        return v === null || v === undefined ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

function toNum(v, def = 0) {
    if (v === null || v === undefined || v === '') return def;
    if (typeof v === 'number') return Number.isFinite(v) ? v : def;
    let s = String(v).trim().replace(/,/g, '');
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // "1.000.000" (kieu Viet Nam) -> 1000000
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : def;
}

// '' -> null (dung cho cac cot UNIQUE de khong bi trung chuoi rong)
const emptyToNull = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

// Ngay hien tai theo gio may chu, dang YYYY-MM-DD (khong dung UTC de tranh lech ngay truoc 7h sang).
function today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Tien to thang: { yy: '26', yyyy: '2026', mm: '10' }
function ym(dateStr) {
    let d = dateStr ? new Date(dateStr) : new Date();
    if (Number.isNaN(d.getTime())) d = new Date();
    return {
        yy: String(d.getFullYear()).slice(-2),
        yyyy: String(d.getFullYear()),
        mm: String(d.getMonth() + 1).padStart(2, '0')
    };
}

function escapeHtml(v) {
    return String(v === null || v === undefined ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const fmtVND = (n) => new Intl.NumberFormat('vi-VN').format(toNum(n));

const userName = (req) => (req.session && req.session.user ? req.session.user.name : 'Hệ thống');

module.exports = {
    HttpError, badRequest, notFound, forbidden, conflict,
    parseJson, toNum, emptyToNull, today, ym, escapeHtml, fmtVND, userName
};
