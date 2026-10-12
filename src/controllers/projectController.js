const db = require('../models/database');
const { getOrCreateFolder, getSetting } = require('../utils/googleHelper');
const { parseJson, toNum, badRequest, notFound } = require('../utils/http');

// Cac cot luu dang JSON
const JSON_FIELDS = ['tasks', 'payments', 'project_expenses', 'pm_expenses', 'company_payments'];
// Cac cot thuong
const PLAIN_FIELDS = ['name', 'type', 'maKH', 'leader', 'status', 'contractValue', 'start', 'end', 'drive_folder_url', 'folder_name', 'profit_ratio'];
const ALL_FIELDS = [...PLAIN_FIELDS, ...JSON_FIELDS];
const col = (f) => `"${f}"`; // "end" la tu khoa cua SQL nen luon boc trong ngoac kep

exports.getProjects = async (req, res) => {
    const rows = await db.allAsync(`
        SELECT p.*, c.tenKH
        FROM projects p
        LEFT JOIN customers c ON p.maKH = c.maKH
        ORDER BY p.id DESC`);
    res.json(rows.map((r) => {
        const out = { ...r };
        for (const f of JSON_FIELDS) out[f] = parseJson(r[f], []);
        return out;
    }));
};

// Tao thu muc Drive <root>/Project/<folder_name> neu du an chua co link
async function resolveDriveUrl(driveUrl, folderName) {
    if (driveUrl || !folderName) return driveUrl;
    try {
        const rootId = await getSetting('google_drive_root_id');
        if (!rootId) return driveUrl;
        const parentId = await getOrCreateFolder('Project', rootId);
        const folderId = await getOrCreateFolder(folderName, parentId);
        return `https://drive.google.com/drive/folders/${folderId}`;
    } catch (err) {
        console.error('Loi Drive:', err.message);
        return driveUrl;
    }
}

// Tao moi hoac cap nhat. Khi cap nhat, truong nao khong gui len thi giu nguyen gia tri cu.
exports.saveProject = async (req, res) => {
    const data = { ...req.body };
    if (data.contractValue !== undefined) data.contractValue = toNum(data.contractValue);
    if (data.profit_ratio !== undefined) {
        data.profit_ratio = toNum(data.profit_ratio, 50);
        if (data.profit_ratio < 0 || data.profit_ratio > 100) throw badRequest('Tỷ lệ lợi nhuận phải nằm trong khoảng 0 - 100%.');
    }

    if (data.id) {
        const current = await db.getAsync('SELECT * FROM projects WHERE id = ?', [data.id]);
        if (!current) throw notFound('Dự án không tồn tại');

        const driveUrl = await resolveDriveUrl(data.drive_folder_url || current.drive_folder_url, data.folder_name);
        if (driveUrl) data.drive_folder_url = driveUrl;

        const values = ALL_FIELDS.map((f) => {
            if (data[f] === undefined) return current[f];
            return JSON_FIELDS.includes(f) ? JSON.stringify(data[f] || []) : data[f];
        });
        await db.runAsync(`UPDATE projects SET ${ALL_FIELDS.map((f) => `${col(f)} = ?`).join(', ')} WHERE id = ?`, [...values, data.id]);
        return res.json({ success: true, drive_url: driveUrl });
    }

    if (!String(data.name || '').trim()) throw badRequest('Vui lòng nhập tên dự án.');
    const driveUrl = await resolveDriveUrl(data.drive_folder_url, data.folder_name);
    const defaults = { type: 'Dự án công ty', status: 'Khởi tạo', contractValue: 0, profit_ratio: 50, drive_folder_url: driveUrl };
    const values = ALL_FIELDS.map((f) => {
        if (JSON_FIELDS.includes(f)) return JSON.stringify(data[f] || []);
        if (f === 'drive_folder_url') return driveUrl;
        return data[f] !== undefined && data[f] !== '' && data[f] !== null ? data[f] : (defaults[f] !== undefined ? defaults[f] : data[f]);
    });
    const result = await db.runAsync(
        `INSERT INTO projects (${ALL_FIELDS.map(col).join(', ')}) VALUES (${ALL_FIELDS.map(() => '?').join(', ')})`, values);
    res.json({ success: true, id: result.lastID, drive_url: driveUrl });
};

exports.deleteProject = async (req, res) => {
    const { id } = req.params;
    if (!id || id === 'undefined') throw badRequest('ID dự án không hợp lệ');
    const result = await db.runAsync('DELETE FROM projects WHERE id = ?', [id]);
    if (!result.changes) throw notFound('Không tìm thấy dự án để xóa');
    res.json({ success: true });
};
