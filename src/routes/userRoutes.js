const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { requireLogin, requireRole } = require('../middlewares/authMiddleware');

const adminOnly = requireRole();

router.get('/technicians', requireLogin, userController.getTechnicians);
router.get('/', requireLogin, userController.getUsers);
router.post('/save', adminOnly, userController.saveUser);
router.delete('/:id', adminOnly, userController.deleteUser);

module.exports = router;
