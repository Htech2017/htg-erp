const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { requireRole } = require('../middlewares/authMiddleware');
const { PERMS } = require('../config');

router.use(requireRole(PERMS.REPORT));

router.get('/summary', reportController.getReportSummary);
router.get('/data', reportController.getReportData);
router.post('/calculate-bonus', reportController.calculateBonus);

module.exports = router;
