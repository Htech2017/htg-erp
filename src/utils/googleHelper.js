const { google } = require('googleapis');
const axios = require('axios');
const db = require('../models/database');
const { GOOGLE_KEYFILE } = require('../config');

// --- CAU HINH GOOGLE API ---
const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_KEYFILE,
    scopes: ['https://www.googleapis.com/auth/drive']
});
const drive = google.drive({ version: 'v3', auth });
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// --- SETTINGS (co bo nho dem de khong query DB moi lan gui thong bao) ---
const settingCache = new Map();

async function getSetting(key) {
    if (settingCache.has(key)) return settingCache.get(key);
    try {
        const row = await db.getAsync('SELECT value FROM settings WHERE key = ?', [key]);
        const value = row && row.value ? row.value : null;
        settingCache.set(key, value);
        return value;
    } catch (err) {
        console.error(`Loi khi lay setting ${key}:`, err.message);
        return null;
    }
}

async function setSetting(key, value) {
    const v = value ? String(value).trim() : '';
    await db.runAsync(
        'INSERT INTO settings (key, value, status) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, status = excluded.status',
        [key, v, v ? 'connected' : 'disconnected']
    );
    settingCache.set(key, v || null);
}

// Ky tu ' va \ trong ten thu muc phai duoc escape, neu khong cau truy van Drive se sai / bi chen dieu kien.
const escapeQuery = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function createFolder(name, parentId) {
    const res = await drive.files.create({
        resource: { name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : [] },
        fields: 'id',
        supportsAllDrives: true
    });
    return res.data.id;
}

// Tim hoac tao folder tren Drive
async function getOrCreateFolder(folderName, parentId = null) {
    let query = `name = '${escapeQuery(folderName)}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    if (parentId) query += ` and '${escapeQuery(parentId)}' in parents`;

    const res = await drive.files.list({
        q: query,
        fields: 'files(id, name)',
        spaces: 'drive',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
    });
    if (res.data.files && res.data.files.length > 0) return res.data.files[0].id;
    return createFolder(folderName, parentId);
}

// Thu muc khach hang: <root>/Orders/<maKH>. Tra ve null neu chua cau hinh Drive hoac Drive loi.
async function ensureCustomerFolder(maKH) {
    const rootId = await getSetting('google_drive_root_id');
    if (!rootId || !maKH) return null;
    try {
        const ordersFolderId = await getOrCreateFolder('Orders', rootId);
        return await getOrCreateFolder(maKH, ordersFolderId);
    } catch (err) {
        console.error('Loi tao folder KH tren Drive:', err.message);
        return null;
    }
}

// File "Yêu cầu khách hàng - <maDH>" trong 1. INPUT: Google Docs (mo / tai ve duoc bang Word) co san mau de Sale nhap thong tin.
async function createRequestDoc(maDH, inputFolderId) {
    const name = `Yêu cầu khách hàng - ${maDH}`;
    const row = (k) => `<tr><td style="width:35%;padding:6px;border:1px solid #999;background:#f3f4f6"><b>${k}</b></td><td style="padding:6px;border:1px solid #999">&nbsp;</td></tr>`;
    const section = (title, keys) => `<h3>${title}</h3><table style="width:100%;border-collapse:collapse">${keys.map(row).join('')}</table>`;
    const html = `<html><body style="font-family:Arial"><h2>YÊU CẦU KHÁCH HÀNG — ${maDH}</h2>`
        + section('1. Thông tin chung', ['Khách hàng / người liên hệ', 'Tên sản phẩm / tên mạch', 'Số lượng', 'Ngày khách cần hàng', 'Mục đích sử dụng'])
        + section('2. Yêu cầu kỹ thuật', ['PCB (số lớp, độ dày, màu, xử lý bề mặt)', 'Linh kiện (khách cấp / công ty mua, yêu cầu hãng)', 'Gia công SMT / hàn tay / lắp ráp', 'Kiểm tra, nạp firmware, đóng gói', 'Thiết kế (nếu là đơn R&D): chức năng, thông số'])
        + section('3. Tài liệu khách gửi (đã để trong các thư mục BOM / PCB / SMT / Design)', ['File BOM', 'File gerber / PCB', 'File tọa độ, hướng dẫn SMT', 'Tài liệu khác'])
        + section('4. Thương mại', ['Giá mục tiêu / ngân sách', 'Xuất hóa đơn VAT (có / không)', 'Điều kiện thanh toán, giao hàng', 'Ghi chú khác'])
        + '</body></html>';
    try {
        await drive.files.create({
            resource: { name, mimeType: 'application/vnd.google-apps.document', parents: [inputFolderId] },
            media: { mimeType: 'text/html', body: html },
            supportsAllDrives: true
        });
    } catch (err) {
        // Khong chuyen duoc mau -> van tao file trong de Sale nhap
        await drive.files.create({ resource: { name, mimeType: 'application/vnd.google-apps.document', parents: [inputFolderId] }, supportsAllDrives: true });
    }
}

// Thu muc don hang: <parent>/<maDH>/{1. INPUT, 2. OUTPUT, 3. Documents}
async function createOrderFolders(maDH, parentId) {
    const empty = { folderId: null, inputFolderId: null, outputFolderId: null, documentFolderId: null };
    if (!parentId) return empty;
    try {
        const folderId = await createFolder(maDH, parentId);
        const [inputFolderId, outputFolderId, documentFolderId] = await Promise.all([
            createFolder(INPUT_NAME, folderId),
            createFolder(OUTPUT_NAME, folderId),
            createFolder(DOCS_NAME, folderId)
        ]);
        await createRequestDoc(maDH, inputFolderId);
        return { folderId, inputFolderId, outputFolderId, documentFolderId };
    } catch (err) {
        console.error('Loi Drive API:', err.message);
        return empty;
    }
}

// ----- THU MUC CON CUA DON HANG -----
// <root>/Orders/<maKH>/<maDH>/
//     1. INPUT        yeu cau tu khach hang. Co file "Yêu cầu khách hàng - <maDH>" de Sale nhap thong tin, va cac thu muc con:
//         don R&D : Design
//         don sx  : BOM · PCB · SMT
//     2. OUTPUT       du lieu cua tung bo phan lam ra:
//         don R&D : 1. Thiết kế
//         don sx  : 1. PCB · 2. Linh kiện · 3. Sản xuất · 4. Kho - Giao hàng
//     3. Documents    hop dong, PO khach, hoa don, bien ban (Sale + Ke toan)
const INPUT_NAME = '1. INPUT', OUTPUT_NAME = '2. OUTPUT', DOCS_NAME = '3. Documents';
const DEPT_FOLDERS = {
    'in-design': { parent: 'input',  name: 'Design',             label: 'INPUT / Design', types: ['rnd'] },
    'in-bom':    { parent: 'input',  name: 'BOM',                label: 'INPUT / BOM',    types: ['sx'] },
    'in-pcb':    { parent: 'input',  name: 'PCB',                label: 'INPUT / PCB',    types: ['sx'] },
    'in-smt':    { parent: 'input',  name: 'SMT',                label: 'INPUT / SMT',    types: ['sx'] },
    thietke:     { parent: 'output', name: '1. Thiết kế',        label: 'OUTPUT / Thiết kế',        types: ['rnd'] },
    pcb:         { parent: 'output', name: '1. PCB',             label: 'OUTPUT / PCB',             types: ['sx'] },
    linhkien:    { parent: 'output', name: '2. Linh kiện',       label: 'OUTPUT / Linh kiện',       types: ['sx'] },
    sanxuat:     { parent: 'output', name: '3. Sản xuất',        label: 'OUTPUT / Sản xuất',        types: ['sx'] },
    kho:         { parent: 'output', name: '4. Kho - Giao hàng', label: 'OUTPUT / Kho - Giao hàng', types: ['sx'] }
};
// Duong dan tuong doi cua 1 thu muc (tinh tu thu muc goc cua he thong) -> dung de mo thu muc tren may co cai Google Drive
function folderRelPath(order, key) {
    const base = ['Orders', order.maKH, order.maDH];
    if (!order.maKH || !order.maDH) return null;
    if (key === 'root') return base;
    if (key === 'input') return [...base, INPUT_NAME];
    if (key === 'output') return [...base, OUTPUT_NAME];
    if (key === 'documents') return [...base, DOCS_NAME];
    const def = DEPT_FOLDERS[key];
    return def ? [...base, def.parent === 'input' ? INPUT_NAME : OUTPUT_NAME, def.name] : null;
}
const deptKeysFor = (loaiDV) => Object.keys(DEPT_FOLDERS).filter((k) => DEPT_FOLDERS[k].types.includes(loaiDV === 'rnd' ? 'rnd' : 'sx'));
const parseDept = (order) => { try { return JSON.parse(order.deptFolders || '{}') || {}; } catch (e) { return {}; } };

// Tra ve id thu muc cua 1 bo phan (tao neu chua co). Don cu chua co thu muc bo phan se duoc tao khi co nguoi mo lan dau.
// order: { id, loaiDV, inputFolderId, outputFolderId, deptFolders }.  Khong co Drive / loi Drive -> null.
async function ensureDeptFolder(order, dept) {
    if (!DEPT_FOLDERS[dept] || !deptKeysFor(order.loaiDV).includes(dept)) return null;
    const map = parseDept(order);
    if (map[dept]) return map[dept];
    const parentId = DEPT_FOLDERS[dept].parent === 'input' ? order.inputFolderId : order.outputFolderId;
    if (!parentId) return null;
    try {
        map[dept] = await getOrCreateFolder(DEPT_FOLDERS[dept].name, parentId);
        // gop voi gia tri moi nhat trong DB (2 bo phan co the mo cung luc)
        const fresh = await db.getAsync('SELECT deptFolders FROM orders WHERE id = ?', [order.id]);
        const merged = { ...parseDept(fresh || {}), [dept]: map[dept] };
        await db.runAsync('UPDATE orders SET deptFolders = ? WHERE id = ?', [JSON.stringify(merged), order.id]);
        return map[dept];
    } catch (err) {
        console.error('Loi tao thu muc bo phan tren Drive:', err.message);
        return null;
    }
}
// ----- Thu muc RIENG cua tung loai mach trong INPUT: PCB/<ten mach>, BOM/<ten mach>, SMT/<ten mach> -----
// Chi tao cho hang muc ma loai mach do co dat (vd mach chi dat PCB thi chi co PCB/<ten mach>).
const BOARD_DEPTS = { 'in-pcb': 'soLuongPCB', 'in-bom': 'soLuongLK', 'in-smt': 'soLuongGiaCong' };
const boardFolderName = (tenMach) => String(tenMach || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Mach';
const parseMap = (v) => { try { return JSON.parse(v || '{}') || {}; } catch (e) { return {}; } };
// line: { id, tenMach, folders }. Tra ve id thu muc cua loai mach trong thu muc bo phan (tao neu chua co); khong co Drive -> null.
async function ensureBoardFolder(order, dept, line) {
    if (!BOARD_DEPTS[dept] || !line) return null;
    const map = parseMap(line.folders);
    if (map[dept]) return map[dept];
    const fresh = await db.getAsync('SELECT id, loaiDV, inputFolderId, outputFolderId, deptFolders FROM orders WHERE id = ?', [order.id]);
    const deptId = fresh ? await ensureDeptFolder(fresh, dept) : null;
    if (!deptId) return null;
    try {
        const id = await getOrCreateFolder(boardFolderName(line.tenMach), deptId);
        const cur = await db.getAsync('SELECT folders FROM order_items WHERE id = ?', [line.id]);
        await db.runAsync('UPDATE order_items SET folders = ? WHERE id = ?', [JSON.stringify({ ...parseMap(cur && cur.folders), [dept]: id }), line.id]);
        return id;
    } catch (err) {
        console.error('Loi tao thu muc loai mach tren Drive:', err.message);
        return null;
    }
}
// Tao san thu muc cho moi loai mach cua don (goi sau khi luu don) de Sale upload du lieu ngay
async function ensureBoardFolders(orderId) {
    const order = await db.getAsync('SELECT id, loaiDV, inputFolderId FROM orders WHERE id = ?', [orderId]);
    if (!order || order.loaiDV === 'rnd' || !order.inputFolderId) return;
    for (const line of await db.allAsync('SELECT * FROM order_items WHERE orderId = ? ORDER BY stt, id', [orderId])) {
        for (const [dept, qtyField] of Object.entries(BOARD_DEPTS)) {
            if (Number(line[qtyField]) > 0) { const id = await ensureBoardFolder(order, dept, line); if (id) line.folders = JSON.stringify({ ...parseMap(line.folders), [dept]: id }); }
        }
    }
}

// Tao san moi thu muc bo phan cua don (goi khi tao don moi)
async function ensureAllDeptFolders(order) {
    let cur = { ...order };
    for (const dept of deptKeysFor(order.loaiDV)) {
        const id = await ensureDeptFolder(cur, dept);
        if (!id) continue;
        cur = { ...cur, deptFolders: JSON.stringify({ ...parseDept(cur), [dept]: id }) };
    }
    return parseDept(cur);
}

// ----- Doc file BOM cua khach trong thu muc don hang -----
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Liet ke moi file nam truc tiep trong cac thu muc cho truoc
async function listFolderFiles(folderIds) {
    const files = [];
    for (const folderId of folderIds.filter(Boolean)) {
        const res = await drive.files.list({
            q: `'${escapeQuery(folderId)}' in parents and trashed = false`,
            fields: 'files(id, name, mimeType, modifiedTime, size)',
            orderBy: 'modifiedTime desc', pageSize: 200,
            supportsAllDrives: true, includeItemsFromAllDrives: true
        });
        for (const f of res.data.files || []) files.push({ ...f, folderId });
    }
    return files;
}

// File bang tinh (xlsx, xls, csv, Google Sheets)
async function listSpreadsheets(folderIds) {
    return (await listFolderFiles(folderIds)).filter((f) => f.mimeType === SHEET_MIME || /\.(xlsx|xls|csv)$/i.test(f.name || ''));
}

// Tai noi dung 1 file. Chi cho tai file nam trong cac thu muc duoc phep (thu muc cua don hang).
async function downloadFile(fileId, allowedFolderIds, maxBytes = 10 * 1024 * 1024) {
    const meta = await drive.files.get({ fileId, fields: 'id, name, mimeType, parents, size', supportsAllDrives: true });
    const parents = meta.data.parents || [];
    if (!parents.some((p) => allowedFolderIds.includes(p))) throw new Error('File không nằm trong thư mục của đơn hàng.');
    if (Number(meta.data.size || 0) > maxBytes) throw new Error(`File quá lớn (tối đa ${Math.round(maxBytes / 1024 / 1024)}MB).`);

    const res = meta.data.mimeType === SHEET_MIME
        ? await drive.files.export({ fileId, mimeType: XLSX_MIME }, { responseType: 'arraybuffer' })
        : await drive.files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    return { name: meta.data.name, buffer: Buffer.from(res.data) };
}
const downloadSpreadsheet = downloadFile;

// Gui tin nhan Google Chat. Khong bao gio nem loi va khong lam cham request (goi khong can await).
async function sendGoogleChatMsg(maDH, nhanVien, hanhDong) {
    try {
        const webhookUrl = await getSetting('google_chat_webhook');
        if (!webhookUrl || !/^https:\/\//i.test(webhookUrl)) return;
        await axios.post(webhookUrl, {
            text: `🔔 *THÔNG BÁO HỆ THỐNG HTECH*\n` +
                  `📦 *Đơn hàng:* ${maDH}\n` +
                  `👤 *Nhân viên:* ${nhanVien}\n` +
                  `📝 *Nội dung:* ${hanhDong}`
        }, { timeout: 8000 });
    } catch (error) {
        console.error('Loi gui Webhook Google Chat:', error.message);
    }
}

module.exports = {
    drive,
    getSetting,
    setSetting,
    getOrCreateFolder,
    ensureCustomerFolder,
    createOrderFolders,
    DEPT_FOLDERS, folderRelPath, deptKeysFor, ensureDeptFolder, ensureAllDeptFolders, BOARD_DEPTS, boardFolderName, ensureBoardFolder, ensureBoardFolders,
    listFolderFiles,
    listSpreadsheets,
    downloadSpreadsheet,
    downloadFile,
    sendGoogleChatMsg
};
