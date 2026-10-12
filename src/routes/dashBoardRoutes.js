const express = require('express');
const router = express.Router();
const dashBoardController = require('../controllers/dashBoardController');
const { requireLogin } = require('../middlewares/authMiddleware');

router.get('/stats', requireLogin, dashBoardController.getDashboardStats);

module.exports = router;
