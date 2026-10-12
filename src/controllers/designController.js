const db = require('../models/database');
const { ROLES } = require('../config');
const { hasRole } = require('../middlewares/authMiddleware');
const { sendGoogleChatMsg } = require('../utils/googleHelper');
const { parseJson, userName, notFound, forbidden } = require('../utils/http');

exports.getDesignJobs = async (req, res) => {
    const rows = await db.allAsync('SELECT * FROM design_jobs ORDER BY id DESC');
    res.json(rows.map((r) => ({ ...r, dauViec: parseJson(r.dauViec, []), history: parseJson(r.history, []) })));
};

exports.saveDesignJob = async (req, res) => {
    const { id, ttThietKe, version, driveLink, feedbackTK, deadline } = req.body;
    const user = userName(req);

    const job = await db.getAsync('SELECT * FROM design_jobs WHERE id = ?', [id]);
    if (!job) throw notFound('Không tìm thấy đầu việc thiết kế.');

    // Truong BP / Admin duoc giao viec. Nhan vien thiet ke chi cap nhat viec cua chinh minh va khong doi nguoi phu trach.
    const isManager = hasRole(req.session.user, [ROLES.TBP]);
    if (!isManager && job.designer !== user) throw forbidden('Bạn chỉ được cập nhật đầu việc được giao cho mình.');
    const designer = isManager && req.body.designer !== undefined ? req.body.designer : job.designer;

    const history = parseJson(job.history, []);
    if (job.ttThietKe !== ttThietKe || feedbackTK) {
        history.push({ status: ttThietKe, by: user, note: feedbackTK || '', version: version || '', at: new Date().toISOString() });
    }

    await db.runAsync(
        'UPDATE design_jobs SET designer=?, ttThietKe=?, version=?, driveLink=?, feedbackTK=?, deadline=?, history=? WHERE id=?',
        [designer, ttThietKe, version, driveLink || job.driveLink || null, feedbackTK, deadline || null, JSON.stringify(history), id]);

    sendGoogleChatMsg(job.maDH, user,
        `CẬP NHẬT THIẾT KẾ - Trạng thái: ${ttThietKe} | Version: ${version || '1.0'} | Ghi chú: ${feedbackTK || 'Không có'}`);
    res.json({ success: true });
};

exports.deleteDesignJob = async (req, res) => {
    const result = await db.runAsync('DELETE FROM design_jobs WHERE id = ?', [req.params.id]);
    if (!result.changes) throw notFound('Không tìm thấy đầu việc thiết kế.');
    res.json({ success: true });
};
