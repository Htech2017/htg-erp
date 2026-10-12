const db = require('../models/database');
const { listConfirmedOrders } = require('./orderController');
const { parseJson, toNum, today, ym, emptyToNull, userName, badRequest, notFound } = require('../utils/http');

const DONE = 'Hoàn thành';
const WO_STATUSES = ['Chờ sản xuất', 'Đang sản xuất', DONE, 'Tạm dừng'];
const clampProgress = (v) => Math.max(0, Math.min(100, Math.round(toNum(v))));

// ===== PRODUCTION LINES =====
exports.getLines = async (req, res) => {
    res.json(await db.allAsync('SELECT * FROM production_lines ORDER BY code ASC'));
};

exports.saveLine = async (req, res) => {
    const { id, type, capacity, status, lastMaintenance, nextMaintenance, note } = req.body;
    const name = String(req.body.name || '').trim();
    if (!name) throw badRequest('Vui lòng nhập tên dây chuyền.');

    if (id) {
        const result = await db.runAsync(
            'UPDATE production_lines SET name=?,type=?,capacity=?,status=?,lastMaintenance=?,nextMaintenance=?,note=? WHERE id=?',
            [name, type, capacity, status || 'Hoạt động', lastMaintenance, nextMaintenance, note, id]);
        if (!result.changes) throw notFound('Không tìm thấy dây chuyền.');
        return res.json({ success: true });
    }
    const result = await db.runAsync(
        'INSERT INTO production_lines (code,name,type,capacity,status,lastMaintenance,nextMaintenance,note,createdAt) VALUES (?,?,?,?,?,?,?,?,?)',
        [emptyToNull(req.body.code), name, type, capacity, status || 'Hoạt động', lastMaintenance, nextMaintenance, note, new Date().toISOString()]);
    res.json({ success: true, id: result.lastID });
};

// ===== WORK ORDERS =====
exports.getWorkOrders = async (req, res) => {
    const rows = await db.allAsync('SELECT * FROM production_orders ORDER BY id DESC');
    res.json(rows.map((r) => ({ ...r, stages: parseJson(r.stages, []), bom: parseJson(r.bom, []) })));
};

exports.saveWorkOrder = async (req, res) => {
    const { id, orderId, maDH, lineId, lineName, assignedTo, startDate, expectedDate, stages, bom, note } = req.body;
    const productName = String(req.body.productName || '').trim();
    const quantity = Math.round(toNum(req.body.quantity, 1));
    let status = req.body.status || 'Chờ sản xuất';
    let progress = clampProgress(req.body.progress);

    if (!productName) throw badRequest('Vui lòng nhập tên sản phẩm.');
    if (quantity <= 0) throw badRequest('Số lượng phải lớn hơn 0.');
    if (!WO_STATUSES.includes(status)) throw badRequest('Trạng thái lệnh sản xuất không hợp lệ.');
    if (status === DONE) progress = 100;

    const stagesStr = JSON.stringify(Array.isArray(stages) ? stages : []);
    const bomStr = JSON.stringify(Array.isArray(bom) ? bom : []);

    if (id) {
        const current = await db.getAsync('SELECT id, completedDate FROM production_orders WHERE id = ?', [id]);
        if (!current) throw notFound('Không tìm thấy lệnh sản xuất.');
        const completedDate = status === DONE ? (current.completedDate || today()) : null;
        await db.runAsync(
            `UPDATE production_orders SET orderId=?,maDH=?,productName=?,quantity=?,status=?,lineId=?,lineName=?,assignedTo=?,
             startDate=?,expectedDate=?,completedDate=?,progress=?,stages=?,bom=?,note=? WHERE id=?`,
            [orderId, maDH, productName, quantity, status, lineId, lineName, assignedTo, startDate, expectedDate, completedDate, progress, stagesStr, bomStr, note, id]);
        return res.json({ success: true });
    }

    const { yy, mm } = ym();
    const prefix = `WO-${yy}${mm}`;
    const woCode = `${prefix}-${String(await db.nextSeq(prefix)).padStart(3, '0')}`;
    const result = await db.runAsync(
        `INSERT INTO production_orders (woCode,orderId,maDH,productName,quantity,status,lineId,lineName,assignedTo,startDate,expectedDate,completedDate,progress,stages,bom,note,createdBy,createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [woCode, orderId, maDH, productName, quantity, status, lineId, lineName, assignedTo, startDate, expectedDate,
            status === DONE ? today() : null, progress, stagesStr, bomStr, note, userName(req), new Date().toISOString()]);
    res.json({ success: true, id: result.lastID, woCode });
};

exports.updateProgress = async (req, res) => {
    const current = await db.getAsync('SELECT id, status, completedDate FROM production_orders WHERE id = ?', [req.params.id]);
    if (!current) throw notFound('Không tìm thấy lệnh sản xuất.');

    const status = req.body.status || current.status;
    if (!WO_STATUSES.includes(status)) throw badRequest('Trạng thái lệnh sản xuất không hợp lệ.');
    const progress = status === DONE ? 100 : clampProgress(req.body.progress);
    // Hoan thanh ma khong gui ngay -> lay hom nay. Mo lai lenh -> xoa ngay hoan thanh.
    const completedDate = status === DONE ? (req.body.completedDate || current.completedDate || today()) : null;

    await db.runAsync('UPDATE production_orders SET progress = ?, status = ?, completedDate = ? WHERE id = ?',
        [progress, status, completedDate, current.id]);
    res.json({ success: true });
};

exports.deleteWorkOrder = async (req, res) => {
    const result = await db.runAsync('DELETE FROM production_orders WHERE id = ?', [req.params.id]);
    if (!result.changes) throw notFound('Không tìm thấy lệnh sản xuất.');
    res.json({ success: true });
};

// Don hang Sale da chot de tao lenh san xuat
exports.getOrdersForProduction = async (req, res) => {
    res.json(await listConfirmedOrders(req.query.type || ''));
};
