// 1. Hàm lấy dữ liệu từ SQLite (Thông qua API Node.js)

// Hàm biến số thành chuỗi có dấu phân cách: 1000 -> 1.000
function formatNumber(n) {
    return n.replace(/\D/g, "").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// Hàm xử lý sự kiện khi gõ phím
function formatCurrencyInput(input) {
    // Lấy giá trị hiện tại (xóa hết ký tự không phải số)
    let val = input.value.replace(/\D/g, "");
    
    // Nếu trống thì thôi
    if (val === "") {
        input.value = "";
        return;
    }
    
    // Cập nhật lại giá trị hiển thị có dấu chấm
    input.value = formatNumber(val);
}

async function getDB() {
    try {
        const response = await fetch('/api/db');
        if (!response.ok) throw new Error("Lỗi kết nối server");
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error("Lỗi getDB:", error);
        // Trả về cấu trúc trống để tránh lỗi filter/map ở các trang
        return { 
            users: [], brands: [], orders: [], 
            externalProjects: [], customers: [], 
            designJobs: [], transactions: [] 
        };
    }
}

// 2. Hàm lưu dữ liệu vào SQLite
async function saveDB(data) {
    try {
        const response = await fetch('/api/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data)
        });
        
        const result = await response.json();
        if (result.success) {
            console.log("✅ Dữ liệu đã lưu vào SQLite");
            return true;
        }
        return false;
    } catch (error) {
        console.error("Lỗi saveDB:", error);
        alert("Không thể lưu dữ liệu vào hệ thống!");
        return false;
    }
}

// 3. Hàm lấy User hiện tại (Vẫn có thể dùng LocalStorage cho phiên làm việc)
function getCurrentUser() {
    const activeRole = localStorage.getItem('active_role') || 'Admin';
    return {
        name: activeRole,
        roles: [activeRole]
    };
}