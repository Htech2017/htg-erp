const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { loginLimiter } = require('../middlewares/authMiddleware');

router.get('/login', authController.getLoginPage);
router.post('/api/login', loginLimiter, authController.login);
router.get('/logout', authController.logout);

module.exports = router;
