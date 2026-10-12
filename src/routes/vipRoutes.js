const express = require('express');
const router = express.Router();
const vc = require('../controllers/vipController');
const { requireRole } = require('../middlewares/authMiddleware');
const { PERMS } = require('../config');

router.get('/', requireRole(PERMS.VIP), vc.overview);
router.post('/check', requireRole(PERMS.VIP), vc.check);
router.post('/products/save', requireRole(PERMS.VIP_MANAGE), vc.saveProduct);
router.post('/lots', requireRole(PERMS.VIP_LOT), vc.createLot);

module.exports = router;
