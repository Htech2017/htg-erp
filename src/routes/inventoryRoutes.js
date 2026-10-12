const express = require('express');
const router = express.Router();
const ic = require('../controllers/inventoryController');
const bom = require('../controllers/bomController');
const { requireRole } = require('../middlewares/authMiddleware');
const { excelUpload, itemImageUpload, gerberUpload } = require('../middlewares/upload');
const { PERMS } = require('../config');

router.use(requireRole(PERMS.INVENTORY));

router.get('/items', ic.getItems);
router.post('/items/save', ic.saveItem);
router.delete('/items/:id', ic.deleteItem);
router.post('/items/:id/image', itemImageUpload.single('image'), ic.uploadImage);
router.delete('/items/:id/image', ic.deleteImage);
router.get('/transactions', ic.getTransactions);
router.post('/transactions', ic.createTransaction);

// Ten goi khac cua ma hang
router.post('/aliases', ic.saveAliases);

// So khop BOM cua khach voi kho
router.get('/bom/drive-files', bom.listDriveFiles);
router.post('/bom/parse', excelUpload.single('file'), bom.parseBom);
router.post('/bom/match', bom.matchBom);

// Ho tro bao gia gia cong: uoc luong diem han tu BOM, dem pad tu gerber / file khoan
router.post('/bom/assembly-estimate', bom.assemblyEstimate);
router.post('/bom/gerber-count', gerberUpload.array('files', 20), bom.gerberCount);

module.exports = router;
