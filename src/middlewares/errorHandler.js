// Xu ly loi tap trung: controller chi can throw, khong can try/catch lap lai.
const multer = require('multer');

function notFoundHandler(req, res) {
    if (req.originalUrl.startsWith('/api/')) {
        return res.status(404).json({ success: false, error: 'Không tìm thấy API này.' });
    }
    return res.status(404).send('Không tìm thấy trang.');
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
    let status = err.status || err.statusCode || 500;
    let message = err.message || 'Lỗi hệ thống';

    if (err instanceof multer.MulterError) {
        status = 400;
        message = err.code === 'LIMIT_FILE_SIZE' ? 'File tải lên quá lớn.' : 'File tải lên không hợp lệ.';
    } else if (err.code === 'SQLITE_CONSTRAINT') {
        status = 409;
        message = 'Dữ liệu bị trùng (mã đã tồn tại) hoặc thiếu trường bắt buộc.';
    } else if (err.type === 'entity.too.large') {
        status = 413;
        message = 'Dữ liệu gửi lên quá lớn.';
    } else if (err.type === 'entity.parse.failed') {
        status = 400;
        message = 'Dữ liệu gửi lên không đúng định dạng.';
    }

    if (status >= 500) {
        console.error(`[LOI] ${req.method} ${req.originalUrl}:`, err);
        message = 'Lỗi hệ thống, vui lòng thử lại.'; // khong tra chi tiet loi noi bo ra ngoai
    }
    if (res.headersSent) return;

    const isPage = req.method === 'GET' && (req.get('accept') || '').includes('text/html');
    if (isPage) return res.status(status).send(message);
    return res.status(status).json({ success: false, error: message });
}

module.exports = { notFoundHandler, errorHandler };
