const db = require('../models/database');
const { toNum, badRequest } = require('../utils/http');
const { debtSql, receivableSql, tongCong } = require('../utils/orderFlow');

const NOT_CANCELLED = "COALESCE(ttQuyTrinh, '') != 'Hủy đơn'";
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Tong hop nhanh toan bo don hang
exports.getReportSummary = async (req, res) => {
    const row = await db.getAsync(`
        SELECT COUNT(*) AS totalOrders,
               COALESCE(SUM(CASE WHEN ttChotDon = 'Đã chốt' THEN 1 ELSE 0 END), 0) AS closedOrders,
               COALESCE(SUM(giaBao), 0) AS totalRevenue,
               COALESCE(SUM(tamUng), 0) AS totalCollected,
               COALESCE(SUM(CASE WHEN ${receivableSql()} THEN ${debtSql()} ELSE 0 END), 0) AS totalDebt
        FROM orders WHERE ${NOT_CANCELLED}`);
    const winRate = row.totalOrders > 0 ? ((row.closedOrders / row.totalOrders) * 100).toFixed(1) : 0;
    res.json({ ...row, winRate });
};

// ----- Bao cao kinh doanh theo bo phan / theo Sale / theo thuong hieu -----
// Doanh thu = gia bao (chua VAT) cua don DA CHOT, chua huy, tao trong ky. Loi nhuan gop = doanh thu - cost.
// Don PCB / linh kien / san xuat: doanh thu chia cho Mua hang va San xuat theo ty le cost cua tung phan.
async function loadBusinessBreakdown(startDate, endDate) {
    const range = [startDate, endDate];
    const [orders, po, wo] = await Promise.all([
        db.allAsync(`
            SELECT o.id, o.loaiDV, o.giaBao, o.vat, o.chietKhau, o.tamUng, o.ttChotDon, o.giaThietKe,
                   o.giaCostPCB, o.giaCostLK, o.giaCostGiaCong, o.soLuongPCB, o.soLuongLK, o.soLuongGiaCong,
                   o.saleName, o.brandId, b.company AS brandName
            FROM orders o LEFT JOIN brands b ON b.id = o.brandId
            WHERE o.ngayTao >= ? AND o.ngayTao <= ? AND COALESCE(o.ttQuyTrinh, '') != 'Hủy đơn'`, range),
        db.getAsync(`SELECT COUNT(*) AS n, COALESCE(SUM(totalAmount), 0) AS amount FROM purchase_orders
                     WHERE substr(createdAt, 1, 10) >= ? AND substr(createdAt, 1, 10) <= ? AND COALESCE(status, '') != 'Hủy'`, range),
        db.getAsync(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'Hoàn thành' THEN 1 ELSE 0 END), 0) AS done FROM production_orders
                     WHERE substr(createdAt, 1, 10) >= ? AND substr(createdAt, 1, 10) <= ?`, range)
    ]);

    const blank = (key, label) => ({ key, label, quoted: 0, orders: 0, revenue: 0, cost: 0, profit: 0, collected: 0, debt: 0 });
    const dept = { rnd: blank('rnd', 'Nghiên cứu phát triển (R&D)'), buy: blank('buy', 'Mua hàng (PCB + linh kiện)'), prod: blank('prod', 'Sản xuất'), none: blank('none', 'Chưa phân bổ (đơn chưa có cost)') };
    const sales = new Map();
    const brands = new Map();
    const group = (map, key, label) => { if (!map.has(key)) map.set(key, blank(key, label)); return map.get(key); };

    for (const o of orders) {
        const confirmed = o.ttChotDon === 'Đã chốt';
        const revenue = toNum(o.giaBao);
        const pcbLk = toNum(o.giaCostPCB) + toNum(o.giaCostLK);
        const prod = toNum(o.giaCostGiaCong);
        const cost = o.loaiDV === 'rnd' ? toNum(o.giaThietKe) : pcbLk + prod;

        // --- theo bo phan ---
        if (o.loaiDV === 'rnd') {
            dept.rnd.quoted += 1;
            if (confirmed) { dept.rnd.orders += 1; dept.rnd.revenue += revenue; dept.rnd.cost += cost; }
        } else {
            if (toNum(o.soLuongPCB) + toNum(o.soLuongLK) > 0) dept.buy.quoted += 1;
            if (toNum(o.soLuongGiaCong) > 0) dept.prod.quoted += 1;
            if (confirmed) {
                if (cost > 0) {
                    if (pcbLk > 0) { dept.buy.orders += 1; dept.buy.revenue += revenue * pcbLk / cost; dept.buy.cost += pcbLk; }
                    if (prod > 0) { dept.prod.orders += 1; dept.prod.revenue += revenue * prod / cost; dept.prod.cost += prod; }
                } else {
                    dept.none.orders += 1; dept.none.revenue += revenue;
                }
            }
        }

        // --- theo Sale va theo thuong hieu ---
        const targets = [
            group(sales, o.saleName || '', o.saleName || 'Chưa gán Sale'),
            group(brands, o.brandId || 0, o.brandName || 'Chưa gán thương hiệu')
        ];
        for (const g of targets) {
            g.quoted += 1;
            if (!confirmed) continue;
            g.orders += 1; g.revenue += revenue; g.cost += cost;
            g.collected += toNum(o.tamUng);
            g.debt += tongCong(o) - toNum(o.tamUng);
        }
    }

    const finish = (g) => ({
        ...g, revenue: Math.round(g.revenue), cost: Math.round(g.cost), profit: Math.round(g.revenue - g.cost),
        margin: g.revenue > 0 ? Math.round((g.revenue - g.cost) / g.revenue * 1000) / 10 : 0,   // % loi nhuan gop
        winRate: g.quoted > 0 ? Math.round(g.orders / g.quoted * 1000) / 10 : 0                  // % don chot / don bao gia
    });
    const byRevenue = (a, b) => b.revenue - a.revenue;
    const byDept = [dept.rnd, dept.buy, dept.prod, ...(dept.none.orders ? [dept.none] : [])].map(finish);
    byDept.find((d) => d.key === 'buy').extra = `${po.n} PO mua hàng, tổng ${Math.round(po.amount).toLocaleString('vi-VN')} đ`;
    byDept.find((d) => d.key === 'prod').extra = `${wo.n} lệnh sản xuất, ${wo.done} đã hoàn thành`;
    return { byDept, bySale: [...sales.values()].map(finish).sort(byRevenue), byBrand: [...brands.values()].map(finish).sort(byRevenue) };
}

// Du lieu bao cao theo khoang ngay: doanh thu, cong no theo khach, doanh thu theo nhan vien thiet ke
async function loadReportData(startDate, endDate) {
    const range = [startDate, endDate];
    const [summary, customerDebts, designerRevenues] = await Promise.all([
        db.getAsync(`
            SELECT COALESCE(SUM(giaBao), 0) AS totalRevenue,
                   COALESCE(SUM(CASE WHEN loaiDV = 'rnd' THEN giaBao ELSE 0 END), 0) AS revenueRnd,
                   COALESCE(SUM(CASE WHEN loaiDV = 'sx' THEN giaBao ELSE 0 END), 0) AS revenueSx,
                   COALESCE(SUM(CASE WHEN ${receivableSql()} THEN ${debtSql()} ELSE 0 END), 0) AS totalDebt
            FROM orders WHERE ngayTao >= ? AND ngayTao <= ? AND ${NOT_CANCELLED}`, range),
        db.allAsync(`
            SELECT COALESCE(c.tenKH, o.maKH) AS tenKH, c.sdt,
                   COUNT(o.id) AS totalOrders,
                   SUM(${debtSql('o.')}) AS debtAmount
            FROM orders o
            LEFT JOIN customers c ON o.maKH = c.maKH
            WHERE o.ngayTao >= ? AND o.ngayTao <= ?
              AND ${debtSql('o.')} > 0.5
              AND ${receivableSql('o.')}
            GROUP BY o.maKH ORDER BY debtAmount DESC`, range),
        db.allAsync(`
            SELECT d.designer AS name,
                   COUNT(DISTINCT o.id) AS projectCount,
                   COALESCE(SUM(o.giaBao), 0) AS revenue
            FROM (SELECT DISTINCT orderId, designer FROM design_jobs WHERE COALESCE(designer, '') != '') d
            JOIN orders o ON d.orderId = o.id
            WHERE o.loaiDV = 'rnd' AND o.ngayTao >= ? AND o.ngayTao <= ? AND COALESCE(o.ttQuyTrinh, '') != 'Hủy đơn'
            GROUP BY d.designer ORDER BY revenue DESC`, range)
    ]);
    return { summary, customerDebts, designerRevenues };
}

exports.getReportData = async (req, res) => {
    const { startDate, endDate } = req.query;
    if (!isDate(startDate) || !isDate(endDate)) throw badRequest('Vui lòng chọn khoảng ngày hợp lệ (YYYY-MM-DD).');
    if (startDate > endDate) throw badRequest('Ngày bắt đầu phải trước ngày kết thúc.');
    res.json({ success: true, ...(await loadReportData(startDate, endDate)), ...(await loadBusinessBreakdown(startDate, endDate)) });
};

// Tinh bang thuong (chi tra ve JSON, khong luu Database)
exports.calculateBonus = async (req, res) => {
    const { monthStr, reportData } = req.body;
    const salePercent = toNum(req.body.salePercent);
    const headPercent = toNum(req.body.headPercent);
    const designerPercent = toNum(req.body.designerPercent);
    if ([salePercent, headPercent, designerPercent].some((p) => p < 0 || p > 100)) {
        throw badRequest('Tỷ lệ thưởng phải nằm trong khoảng 0 - 100%.');
    }

    // Uu tien tinh lai tu Database theo khoang ngay; neu giao dien khong gui ngay thi dung so lieu da tai.
    const { startDate, endDate } = req.body;
    const data = isDate(startDate) && isDate(endDate) ? await loadReportData(startDate, endDate) : reportData;
    if (!data || !data.summary) throw badRequest('Thiếu dữ liệu báo cáo để tính thưởng.');

    const totalRevenue = toNum(data.summary.totalRevenue);
    const bonusList = [];
    const add = (Nhom, NhanVien, NoiDung, base, percent) => bonusList.push({
        STT: bonusList.length + 1, Nhom, NhanVien, NoiDung,
        DoanhThuTinhThuong: base,
        TienThuong: Math.round(base * (percent / 100))
    });

    if (salePercent > 0 && totalRevenue > 0) {
        add('Bộ phận Sale', 'Team Sale', `Thưởng Doanh thu ${monthStr} (${salePercent}%)`, totalRevenue, salePercent);
    }
    if (headPercent > 0 && totalRevenue > 0) {
        add('Quản lý', 'Trưởng BP Thiết kế', `Thưởng Quản lý ${monthStr} (${headPercent}%)`, totalRevenue, headPercent);
    }
    if (designerPercent > 0) {
        for (const nv of data.designerRevenues || []) {
            if (toNum(nv.revenue) > 0) {
                add('NV Thiết kế', nv.name, `Thưởng % Đơn hàng ${monthStr} (${designerPercent}%)`, toNum(nv.revenue), designerPercent);
            }
        }
    }
    res.json({ success: true, data: bonusList });
};
