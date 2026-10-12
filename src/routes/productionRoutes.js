const express = require('express');
const router = express.Router();
const pc = require('../controllers/productionController');
const { requireRole } = require('../middlewares/authMiddleware');
const { PERMS } = require('../config');

router.use(requireRole(PERMS.PRODUCTION));

router.get('/lines', pc.getLines);
router.post('/lines/save', pc.saveLine);
router.get('/work-orders', pc.getWorkOrders);
router.post('/work-orders/save', pc.saveWorkOrder);
router.patch('/work-orders/:id/progress', pc.updateProgress);
router.delete('/work-orders/:id', pc.deleteWorkOrder);
router.get('/sale-orders', pc.getOrdersForProduction);

module.exports = router;
