const db = require('../models/database');
const { drive, setSetting } = require('../utils/googleHelper');
const { badRequest, notFound } = require('../utils/http');

const LOGO_PATH = /^\/uploads\/logos\/[\w.-]+$/;

// ---------- THUONG HIEU ----------
exports.getBrands = async (req, res) => {
    res.json(await db.allAsync('SELECT * FROM brands ORDER BY id DESC'));
};

exports.saveBrand = async (req, res) => {
    const data = req.body;
    const company = String(data.company || '').trim();
    if (!company) throw badRequest('Vui lòng nhập tên công ty / thương hiệu.');
    const showBank = data.showBankDefault === 'true' || data.showBankDefault === true || data.showBankDefault === '1' ? 1 : 0;

    // Logo: uu tien file moi tai len; neu khong thi giu logo cu (chi chap nhan duong dan trong thu muc logo).
    let logoPath = LOGO_PATH.test(data.oldLogo || '') ? data.oldLogo : '';
    if (req.file) logoPath = `/uploads/logos/${req.file.filename}`;

    const params = [company, data.code, data.address, data.bankName, data.bankNo, data.bankOwner, logoPath, showBank];
    if (data.id) {
        const result = await db.runAsync(
            'UPDATE brands SET company=?, code=?, address=?, bankName=?, bankNo=?, bankOwner=?, logo=?, showBankDefault=? WHERE id=?',
            [...params, data.id]);
        if (!result.changes) throw notFound('Không tìm thấy thương hiệu.');
        return res.json({ success: true });
    }
    const result = await db.runAsync(
        'INSERT INTO brands (company, code, address, bankName, bankNo, bankOwner, logo, showBankDefault) VALUES (?,?,?,?,?,?,?,?)', params);
    res.json({ success: true, id: result.lastID });
};

exports.deleteBrand = async (req, res) => {
    const result = await db.runAsync('DELETE FROM brands WHERE id = ?', [req.params.id]);
    if (!result.changes) throw notFound('Không tìm thấy thương hiệu.');
    res.json({ success: true });
};

// ---------- HE THONG (Drive & Webhook) ----------
exports.testDrive = async (req, res) => {
    const { folderId } = req.body;
    if (!folderId) return res.json({ success: false, message: 'Chưa nhập ID thư mục.' });
    try {
        const response = await drive.files.get({ fileId: folderId, fields: 'name', supportsAllDrives: true });
        res.json({ success: true, folderName: response.data.name });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
};

exports.saveDrive = async (req, res) => {
    await setSetting('google_drive_root_id', req.body.folderId);
    res.json({ success: true });
};

// Thu muc goc cua he thong tren may tinh co cai Google Drive (vd G:\\Shared drives\\HTG\\ERP). De trong = moi nut mo thu muc tren web.
exports.saveDriveLocal = async (req, res) => {
    const p = String(req.body.path || '').trim().replace(/[\\/]+$/, '');
    if (p.length > 300) throw badRequest('Đường dẫn quá dài.');
    if (p && !/^([a-zA-Z]:\\|\\\\|\/)/.test(p)) throw badRequest('Đường dẫn phải là đường dẫn đầy đủ, ví dụ G:\\Shared drives\\HTG\\ERP');
    await setSetting('drive_local_root', p);
    res.json({ success: true, path: p });
};

exports.saveWebhook = async (req, res) => {
    const url = String(req.body.url || '').trim();
    if (url && !/^https:\/\//i.test(url)) throw badRequest('Webhook phải là đường dẫn https://');
    await setSetting('google_chat_webhook', url);
    res.json({ success: true });
};
