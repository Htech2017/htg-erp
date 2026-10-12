const express = require('express');
const router = express.Router();
const c = require('../controllers/customerController');
const { requireRole } = require('../middlewares/authMiddleware');
const { excelUpload } = require('../middlewares/upload');
const { PERMS } = require('../config');

const canRead = requireRole(PERMS.CUSTOMER_READ);
const canWrite = requireRole(PERMS.CUSTOMER_WRITE);

router.get('/', canRead, c.getCustomers);
router.get('/template', canWrite, c.downloadTemplate);
router.post('/save', canWrite, c.saveCustomer);
router.post('/import', canWrite, excelUpload.single('file'), c.importCustomers);
router.get('/:maKH/addresses', canRead, c.getAddresses);
router.put('/:maKH/addresses', canWrite, c.saveAddresses);
router.delete('/:id', canWrite, c.deleteCustomer);

module.exports = router;
