const express = require('express');
const router = express.Router();
const projectController = require('../controllers/projectController');
const { requireRole } = require('../middlewares/authMiddleware');
const { PERMS } = require('../config');

router.use(requireRole(PERMS.PROJECT));

router.get('/', projectController.getProjects);
router.post('/save', projectController.saveProject);
router.delete('/:id', projectController.deleteProject);

module.exports = router;
