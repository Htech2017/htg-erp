const express = require('express');
const router = express.Router();
const fundController = require('../controllers/fundController');
const { requireRole } = require('../middlewares/authMiddleware');
const { excelUpload } = require('../middlewares/upload');
const { PERMS } = require('../config');

const canView = requireRole(PERMS.FUND_VIEW);
const canManage = requireRole(PERMS.FUND_MANAGE);

router.get('/', canView, fundController.getFundData);
router.get('/template', canManage, fundController.downloadTemplate);
router.post('/transaction', canManage, fundController.createTransaction);
router.post('/transfer', requireRole(PERMS.FUND_TRANSFER), fundController.transfer); // cap quy: Quy chung <-> quy cac phong
router.post('/import-excel', canManage, excelUpload.single('excelFile'), fundController.importExcel);
// De nghi chi: ai xem duoc so quy deu tao duoc; chi nguoi tao moi sua / xoa phieu cua minh
router.post('/request', canView, fundController.saveRequest);
router.delete('/request/:id', canView, fundController.deleteRequest);
router.post('/approve', canView, fundController.approveRequest); // quyen duyet theo tung quy: xem fundController.assertCanApprove
// Xoa toan bo so quy: chi Admin
router.post('/reset', requireRole(PERMS.ADMIN_ONLY), fundController.resetFund);

module.exports = router;
