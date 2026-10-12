const express = require('express');
const router = express.Router();
const settingController = require('../controllers/settingController');
const { requireLogin, requireRole } = require('../middlewares/authMiddleware');
const { logoUpload } = require('../middlewares/upload');

const adminOnly = requireRole();

// Thuong hieu
router.get('/brands', requireLogin, settingController.getBrands);
router.post('/brands/save', adminOnly, logoUpload.single('logoFile'), settingController.saveBrand);
router.delete('/brands/:id', adminOnly, settingController.deleteBrand);

// He thong (Drive & Webhook)
router.post('/test-drive', adminOnly, settingController.testDrive);
router.post('/save-drive', adminOnly, settingController.saveDrive);
router.post('/save-webhook', adminOnly, settingController.saveWebhook);
router.post('/save-drive-local', adminOnly, settingController.saveDriveLocal);

module.exports = router;
