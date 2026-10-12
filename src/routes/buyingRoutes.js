const express = require('express');
const router = express.Router();
const bc = require('../controllers/buyingController');
const { requireRole } = require('../middlewares/authMiddleware');
const { PERMS } = require('../config');

const canUse = requireRole(PERMS.BUYING);
const canOrder = requireRole(PERMS.BUYING_ORDER);

router.get('/overview', canUse, bc.overview);
router.patch('/lines/:id', canOrder, bc.updateLine);
router.post('/po', canOrder, bc.createPOs);
// Kiem / nhan vat tu KHONG lam o trang dieu hanh: lam o trang Mua hang PCB, Mua hang linh kien (/api/purchase/check).
router.post('/kit/:lineId', canUse, bc.handoff);

const canResolve = requireRole(PERMS.BUYING_RESOLVE);
router.post('/resolve/:lineId', canResolve, bc.resolveLine);
router.post('/resolve-stock/:orderId', canResolve, bc.resolveStock);

module.exports = router;
