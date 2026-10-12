const express = require('express');
const router = express.Router();
const designController = require('../controllers/designController');
const userController = require('../controllers/userController');
const { requireRole } = require('../middlewares/authMiddleware');
const { PERMS } = require('../config');

const canUse = requireRole(PERMS.DESIGN);

router.get('/', canUse, designController.getDesignJobs);
router.get('/technicians', canUse, userController.getTechnicians);
router.post('/save', canUse, designController.saveDesignJob);
router.delete('/:id', requireRole(PERMS.DESIGN_MANAGE), designController.deleteDesignJob);

module.exports = router;
