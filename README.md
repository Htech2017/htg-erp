# HTG-ERP — phần mềm vận hành công ty

Node.js (Express 5) + EJS + SQLite.

## Chạy để test

Yêu cầu: Node.js 18 trở lên.

```bash
git clone https://github.com/Htech2017/htg-erp.git
cd htg-erp
git checkout test/2026-10-12
npm install
```

### Cách 1 — bản demo (có sẵn dữ liệu mẫu, không cần file riêng)

```bash
npm run demo          # mở http://localhost:3100
npm run demo:reset    # xóa và tạo lại dữ liệu mẫu
```

Đăng nhập nhanh bằng ô "Demo - xem với vai trò" ở cuối menu trái (mật khẩu mọi tài khoản demo: `demo123`). Bản demo tắt Google Drive và thông báo Google Chat.

### Cách 2 — bản đầy đủ (Google Drive, Google Chat)

1. Chép các file riêng được gửi kèm vào thư mục gốc của dự án: `.env`, `credentials.json` (và `htech.db` nếu có).
2. Chạy:

```bash
npm start             # mở địa chỉ in ra ở cửa sổ lệnh (mặc định http://localhost:3000)
```

3. Đăng nhập bằng tài khoản Admin, vào **Cài đặt Hệ thống** nhập ID thư mục Google Drive và link webhook Google Chat.

Không đưa `.env`, `credentials.json`, `*.db` lên git (đã có trong `.gitignore`).

## Ghi chú cho tester

- Camera quét mã chỉ mở được khi chạy bằng `https://` hoặc trên chính máy chạy phần mềm (`localhost`); máy quét mã vạch USB dùng được mọi lúc.
- Gửi phản hồi kèm ảnh chụp màn hình, đường dẫn trang và tài khoản / vai trò đang dùng.
