const express = require('express');
const router = express.Router();
const pc = require('../controllers/purchaseController');
const { requireRole } = require('../middlewares/authMiddleware');
const { PERMS } = require('../config');

const canRead = requireRole(PERMS.PURCHASE_READ);
const canWrite = requireRole(PERMS.PURCHASE_WRITE);

// Nha cung cap
router.get('/suppliers', canRead, pc.getSuppliers);
router.post('/suppliers/save', canWrite, pc.saveSupplier);
router.delete('/suppliers/:id', canWrite, pc.deleteSupplier);

// PO mua hang
router.get('/orders', canRead, pc.getPurchaseOrders);
router.post('/orders/save', canWrite, pc.savePurchaseOrder);
router.patch('/orders/:id/status', canWrite, pc.updatePOStatus);
router.delete('/orders/:id', canWrite, pc.deletePurchaseOrder);

// Kiem vat tu mua ve tai khau mua hang (quyen kiem theo loai PO, xet trong controller)
const chk = require('../controllers/checkController');
router.get('/check-log', canRead, chk.log);
router.get('/check-customer', canRead, chk.customerPending);
router.get('/check/:key', canRead, chk.detail);
router.post('/check/:key', canRead, chk.submit);

// Ho tro bao gia: nhap hoi gia, xuat Excel gui NCC, Kho xac nhan con hang
const qs = require('../controllers/quoteSupportController');
const canQuote = requireRole(PERMS.ORDER_COST);
router.get('/rfq-draft/:lineId/:field', canQuote, qs.getDraft);
router.put('/rfq-draft/:lineId/:field', canQuote, qs.saveDraft);
router.post('/rfq-export', canQuote, qs.rfqExport);
const multer = require('multer');
const bomUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post('/buy-bom-export', canQuote, qs.buyBomExport);
router.post('/buy-bom-parse', canQuote, bomUpload.single('file'), qs.buyBomParse);
router.get('/stock-confirms', canRead, qs.listConfirms);
router.post('/stock-confirms', canQuote, qs.requestConfirms);
router.post('/stock-confirms/:id/answer', requireRole(PERMS.STOCK_CONFIRM), qs.answerConfirm);
router.patch('/orders/:id/shipping', canWrite, pc.updateShipping);

// Don hang Sale da chot
router.get('/sale-orders', canWrite, pc.getOrdersForPurchase);

// Xuat linh kien theo don hang (soan hang tu kho cho don da chot)
const pick = require('../controllers/pickController');
const canPick = requireRole(PERMS.PICKING);
router.get('/picking', canPick, pick.getPicking);
router.patch('/picking/:id', canPick, pick.setPicked);
router.post('/picking/order/:orderId/pick-all', canPick, pick.pickAll);
router.post('/picking/order/:orderId/ship', canPick, pick.ship);

module.exports = router;
