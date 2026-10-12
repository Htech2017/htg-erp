const express = require('express');
const router = express.Router();
const orderController = require('../controllers/orderController');
const { requireRole } = require('../middlewares/authMiddleware');
const { PERMS } = require('../config');

const canRead = requireRole(PERMS.ORDER_READ);
const canWrite = requireRole(PERMS.ORDER_WRITE);

router.get('/', canRead, orderController.getOrders);
router.get('/for-purchase', requireRole(PERMS.ORDER_CONFIRMED), orderController.getOrdersForPurchase);
router.get('/quote-requests', requireRole(PERMS.ORDER_COST), orderController.getQuoteRequests);
router.get('/next-stt', canWrite, orderController.getNextSTT);
router.get('/production-rates', requireRole(PERMS.PRODUCTION), orderController.getProductionRates);
router.post('/production-rates', requireRole(PERMS.PRODUCTION), orderController.saveProductionRates);
router.get('/:id/folder/:key', requireRole(null), orderController.openFolder); // moi bo phan deu mo duoc thu muc lien quan
router.get('/:id/buy-list', requireRole([...PERMS.ORDER_COST, ...PERMS.ORDER_CONFIRMED]), orderController.getBuyList);
router.get('/export-pdf/:id', canRead, orderController.exportPDF);
router.post('/save', canWrite, orderController.saveOrder);
router.patch('/:id/cost', requireRole(PERMS.ORDER_COST), orderController.patchCost);
router.patch('/:id/status', canWrite, orderController.patchStatus);
router.get('/:id/documents', requireRole([...PERMS.ORDER_READ, ...PERMS.ADMIN_DOCS]), orderController.getDocuments);
router.put('/:id/documents/:loai', requireRole(PERMS.ORDER_DOCS), orderController.saveDocument);
router.get('/:id/payments', canRead, orderController.getPayments);
router.post('/:id/payments', requireRole(PERMS.ORDER_PAYMENT), orderController.addPayment);
router.delete('/:id', canWrite, orderController.deleteOrder);

module.exports = router;
