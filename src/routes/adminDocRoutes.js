const express = require('express');
const router = express.Router();
const ac = require('../controllers/adminDocController');
const { requireRole } = require('../middlewares/authMiddleware');
const { PERMS } = require('../config');

router.use(requireRole(PERMS.ADMIN_DOCS));
router.get('/', ac.overview);
router.get('/:id/draft/:loai', ac.draft);

module.exports = router;
