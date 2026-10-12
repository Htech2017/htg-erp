const express = require('express');
const path = require('path');
const multer = require('multer');
const router = express.Router();
const io = require('../controllers/dataIoController');
const { requireRole } = require('../middlewares/authMiddleware');
const { badRequest } = require('../utils/http');

// Quyen theo tung danh sach duoc kiem tra trong controller (moi danh sach dung dung quyen cua trang goc).
const EXT = ['.xlsx', '.xls', '.csv', '.txt', '.tsv'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => { const ok = EXT.includes(path.extname(file.originalname || '').toLowerCase()); cb(ok ? null : badRequest('Chỉ nhận file .xlsx, .xls, .csv, .txt.'), ok); } });

router.use(requireRole(null));
router.get('/entities', io.entities);
router.get('/export/:entity', io.exportData);
router.post('/parse', upload.single('file'), io.parse);
router.post('/import', upload.single('file'), io.importData);
router.post('/preview-bom', upload.single('file'), io.previewBom);

module.exports = router;
