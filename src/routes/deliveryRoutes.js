const express = require('express');
const router = express.Router();
const dc = require('../controllers/deliveryController');
const { requireRole } = require('../middlewares/authMiddleware');
const { PERMS } = require('../config');

router.get('/', requireRole(PERMS.DELIVERY), dc.overview);
router.post('/:orderId', requireRole(PERMS.DELIVERY_WRITE), dc.create);
router.patch('/shipments/:id', requireRole(PERMS.DELIVERY_WRITE), dc.update);
router.delete('/shipments/:id', requireRole(PERMS.DELIVERY_WRITE), dc.remove);

module.exports = router;
