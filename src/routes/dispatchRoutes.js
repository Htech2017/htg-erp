const express = require('express');
const router = express.Router();
const dc = require('../controllers/dispatchController');
const { requireRole } = require('../middlewares/authMiddleware');
const { PERMS } = require('../config');

const manage = requireRole(PERMS.DISPATCH);       // Quan ly san xuat, Admin
const workshop = requireRole(PERMS.WORKSHOP);     // tai khoan xuong (+ QLSX, Admin)

router.get('/board', manage, dc.board);
router.post('/workshops/save', manage, dc.saveWorkshop);
router.post('/assign', manage, dc.assign);
router.patch('/materials/:lineId', requireRole(PERMS.MATERIALS), dc.saveMaterials);
router.delete('/assign/:id', manage, dc.unassign);
router.get('/mine', workshop, dc.mine);
router.patch('/mine/:id', workshop, dc.updateMine);
router.get('/mine/:id/folder/:key', workshop, dc.openFolder);

module.exports = router;
