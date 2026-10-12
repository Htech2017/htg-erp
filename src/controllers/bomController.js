// Cong cu so khop BOM cua khach (file trong Google Drive hoac file tai len) voi du lieu kho.
const XLSX = require('xlsx');
const db = require('../models/database');
const { listSpreadsheets, listFolderFiles, downloadSpreadsheet, downloadFile, ensureDeptFolder } = require('../utils/googleHelper');
const { estimateAssembly } = require('../utils/assembly');
const gerber = require('../utils/gerber');
const { buildIndex, matchRow } = require('../utils/partMatch');
const { badRequest, notFound } = require('../utils/http');

const MAX_ROWS = 1000;

// Tu khoa de doan cot trong file BOM (Altium, KiCad, Excel tu lam...)
const COLUMN_HINTS = {
    name:    ['comment', 'value', 'gia tri', 'ten linh kien', 'ten vat tu', 'ten', 'name', 'part', 'linh kien'],
    desc:    ['description', 'mo ta', 'dien giai', 'ghi chu', 'note'],
    qty:     ['quantity', 'qty', 'so luong', 'sl'],
    mpn:     ['mpn', 'manufacturer part', 'part number', 'part no', 'p/n', 'ma nsx', 'ma linh kien', 'libref'],
    package: ['footprint', 'package', 'kieu chan', 'pattern', 'case'],
    ref:     ['designator', 'reference', 'ref', 'vi tri']
};
const plain = (v) => String(v === null || v === undefined ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().trim();

function guessMapping(headers) {
    const mapping = {};
    const used = new Set();
    for (const [field, hints] of Object.entries(COLUMN_HINTS)) {
        for (const hint of hints) {
            const idx = headers.findIndex((h, i) => !used.has(i) && (plain(h) === hint || plain(h).includes(hint)));
            if (idx >= 0) { mapping[field] = idx; used.add(idx); break; }
        }
    }
    return mapping;
}

// Doc bang tinh -> { sheets, sheet, headers, rows (mang 2 chieu), mapping (doan cot) }
function parseWorkbook(buffer, sheetName) {
    let workbook;
    try { workbook = XLSX.read(buffer, { type: 'buffer' }); } catch (e) { throw badRequest('Không đọc được file. Chỉ hỗ trợ .xlsx, .xls, .csv hoặc Google Sheets.'); }
    const sheet = workbook.SheetNames.includes(sheetName) ? sheetName : workbook.SheetNames[0];
    const table = XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { header: 1, defval: '', blankrows: false });
    if (!table.length) throw badRequest('Sheet không có dữ liệu.');

    // Dong tieu de: dong dau tien (trong 20 dong dau) co nhieu o khop tu khoa nhat
    const allHints = Object.values(COLUMN_HINTS).flat();
    let headerRow = 0, best = 0;
    table.slice(0, 20).forEach((row, i) => {
        const hits = row.filter((c) => allHints.some((h) => plain(c) === h || (plain(c).length < 30 && plain(c).includes(h)))).length;
        if (hits > best) { best = hits; headerRow = i; }
    });
    const headers = table[headerRow].map((h, i) => String(h || `Cột ${i + 1}`));
    const rows = table.slice(headerRow + 1).filter((r) => r.some((c) => String(c).trim() !== '')).slice(0, MAX_ROWS);
    return { sheets: workbook.SheetNames, sheet, headers, rows, mapping: best ? guessMapping(headers) : {} };
}

async function orderFolders(orderId, lineId) {
    const order = await db.getAsync('SELECT id, maDH, maKH, loaiDV, folderId, inputFolderId, outputFolderId, documentFolderId, deptFolders FROM orders WHERE id = ?', [orderId]);
    if (!order) throw notFound('Không tìm thấy đơn hàng.');
    // File cua khach nam trong 1. INPUT va cac thu muc con BOM / PCB / SMT (tao neu chua co)
    const subs = [];
    for (const key of ['in-bom', 'in-pcb', 'in-smt']) subs.push(await ensureDeptFolder(order, key));
    // Thu muc rieng cua loai mach dang bao gia (PCB/<ten mach>, BOM/<ten mach>, SMT/<ten mach>) duoc tim truoc
    const line = lineId ? await db.getAsync('SELECT id, tenMach, folders FROM order_items WHERE id = ? AND orderId = ?', [lineId, order.id]) : null;
    if (line) { const gh = require('../utils/googleHelper'); for (const key of ['in-bom', 'in-pcb', 'in-smt']) { const id = await gh.ensureBoardFolder(order, key, line); if (id) { subs.unshift(id); line.folders = JSON.stringify({ ...JSON.parse(line.folders || '{}'), [key]: id }); } } }
    return { order, folders: [...new Set([...subs, order.inputFolderId, order.folderId, order.documentFolderId].filter(Boolean))] };
}

// GET /api/inventory/bom/drive-files?orderId= : file bang tinh trong thu muc Drive cua don hang
exports.listDriveFiles = async (req, res) => {
    const { order, folders } = await orderFolders(req.query.orderId, req.query.lineId);
    if (!folders.length) return res.json({ success: true, files: [], message: 'Đơn hàng chưa có thư mục Google Drive.' });
    try {
        // kind=gerber: file san xuat cua mach (zip, gerber, file khoan); mac dinh: file bang tinh (BOM)
        const GERBER_RE = /\.(zip|gbr|ger|gtp|gbp|gtl|gbl|drl|xln|nc|txt|crc|crs)$/i;
        const files = req.query.kind === 'gerber'
            ? (await listFolderFiles(folders)).filter((f) => GERBER_RE.test(f.name || ''))
            : await listSpreadsheets(folders);
        res.json({ success: true, files, inputFolderId: order.inputFolderId });
    } catch (err) {
        console.error('Loi doc Drive:', err.message);
        res.json({ success: false, files: [], error: 'Không đọc được Google Drive. Bạn có thể tải file BOM lên từ máy.' });
    }
};

// POST /api/inventory/bom/parse : multipart (file) hoac JSON { orderId, fileId }; tuy chon sheet
exports.parseBom = async (req, res) => {
    let buffer, name;
    if (req.file) {
        buffer = req.file.buffer; name = req.file.originalname;
    } else if (req.body.fileId) {
        const { folders } = await orderFolders(req.body.orderId);
        try {
            ({ buffer, name } = await downloadSpreadsheet(req.body.fileId, folders));
        } catch (err) {
            console.error('Loi tai file Drive:', err.message);
            // Chi hien thong bao do he thong tu dat; loi noi bo (duong dan, khoa API...) khong dua ra giao dien
            throw badRequest(/^File /.test(err.message) ? err.message : 'Không tải được file từ Google Drive. Bạn có thể tải file BOM lên từ máy.');
        }
    } else {
        throw badRequest('Chưa chọn file BOM.');
    }
    res.json({ success: true, name, ...parseWorkbook(buffer, req.body.sheet) });
};

// POST /api/inventory/bom/match : { maKH, rows: [{ name, desc, mpn, package }] } -> ung vien trong kho cho tung dong
exports.matchBom = async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, MAX_ROWS) : [];
    if (!rows.length) throw badRequest('Không có dòng BOM nào để so khớp.');

    const [items, aliases] = await Promise.all([
        db.allAsync('SELECT id, itemCode, itemName, description, mpn, package, unit, quantity, unitCost FROM inventory'),
        db.allAsync('SELECT itemId, alias, aliasNorm, maKH FROM inventory_aliases')
    ]);
    const index = buildIndex(items, aliases);
    res.json({ success: true, matches: rows.map((row) => matchRow(row, index, req.body.maKH)) });
};

// POST /api/inventory/bom/assembly-estimate : { rows: [{ name, desc, package, ref, qty }] }
// -> so diem han dan (SMD), diem han cam (THT), so IC cua 1 board, uoc luong theo kieu chan trong BOM
exports.assemblyEstimate = async (req, res) => {
    const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, MAX_ROWS) : [];
    if (!rows.length) throw badRequest('Không có dòng BOM nào để ước lượng.');
    res.json({ success: true, ...estimateAssembly(rows) });
};

// POST /api/inventory/bom/gerber-count : multipart files[] (gerber / file khoan / .zip) hoac JSON { orderId, fileId }
// -> so pad dan (lop paste tren / duoi) va so lo khoan theo duong kinh
exports.gerberCount = async (req, res) => {
    let files = (req.files || []).map((f) => ({ name: f.originalname, buffer: f.buffer }));
    if (!files.length && req.body.fileId) {
        const { folders } = await orderFolders(req.body.orderId);
        try {
            files = [await downloadFile(req.body.fileId, folders, 20 * 1024 * 1024)];
        } catch (err) {
            console.error('Loi tai file Drive:', err.message);
            throw badRequest(/^File /.test(err.message) ? err.message : 'Không tải được file từ Google Drive. Bạn có thể tải file lên từ máy.');
        }
    }
    if (!files.length) throw badRequest('Chưa chọn file gerber / file khoan.');

    let result;
    try { result = gerber.analyze(files); } catch (e) { throw badRequest('Không đọc được file. Hãy tải file .zip gerber hoặc từng file lớp paste (.GTP/.GBP) và file khoan (.DRL/.TXT).'); }
    if (!result.drillFiles.length && !result.pasteFiles.length) {
        throw badRequest('Không tìm thấy lớp kem hàn (paste) hoặc file khoan trong các file đã chọn.');
    }
    res.json({ success: true, ...result });
};
