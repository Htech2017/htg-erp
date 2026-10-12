// Cau hinh tai file dung chung (gioi han dung luong va loai file).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { badRequest } = require('../utils/http');

const LOGO_DIR = path.join(__dirname, '../../public/uploads/logos');
fs.mkdirSync(LOGO_DIR, { recursive: true });
const ITEM_DIR = path.join(__dirname, '../../public/uploads/items');
fs.mkdirSync(ITEM_DIR, { recursive: true });

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const EXCEL_EXT = ['.xlsx', '.xls', '.csv'];

const byExtension = (allowed, message) => (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(allowed.includes(ext) ? null : badRequest(message), allowed.includes(ext));
};

// Logo thuong hieu: chi nhan anh, toi da 2MB, ten file do server dat
const logoUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, LOGO_DIR),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').toLowerCase();
            cb(null, `logo-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: byExtension(IMAGE_EXT, 'Logo phải là file ảnh (png, jpg, webp, gif).')
});

// File Excel import: doc trong RAM, toi da 5MB
const excelUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: byExtension(EXCEL_EXT, 'Chỉ nhận file Excel (.xlsx, .xls, .csv).')
});

// Anh vat tu trong kho: chi nhan anh, toi da 3MB
const itemImageUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, ITEM_DIR),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname || '').toLowerCase();
            cb(null, `item-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
        }
    }),
    limits: { fileSize: 3 * 1024 * 1024 },
    fileFilter: byExtension(IMAGE_EXT, 'Ảnh vật tư phải là file ảnh (png, jpg, webp, gif).')
});

// File san xuat cua mach (gerber, file khoan, hoac .zip): doc trong RAM, toi da 20 file x 20MB
const gerberUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 20 }
});

module.exports = { logoUpload, excelUpload, itemImageUpload, gerberUpload, ITEM_DIR };
