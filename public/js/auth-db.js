// Tien ich dung chung cho moi trang (duoc nap trong header).

// Bien so thanh chuoi co dau phan cach: 1000 -> 1.000
function formatNumber(n) {
    return String(n).replace(/\D/g, "").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// Chong chen ma HTML khi dua du lieu vao innerHTML: dung esc(giaTri) trong cac template.
function esc(v) {
    return String(v === null || v === undefined ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Boc fetch() cho toan bo he thong:
//  - 401 (het phien dang nhap) -> chuyen ve trang dang nhap
//  - 403 (khong du quyen)      -> thong bao ro rang thay vi im lang
(function () {
    const originalFetch = window.fetch.bind(window);
    let redirecting = false;

    window.fetch = async function (input, init) {
        const response = await originalFetch(input, init);
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const isOwnApi = url.startsWith('/') && !url.startsWith('/api/login');

        if (isOwnApi && response.status === 401 && !redirecting) {
            redirecting = true;
            window.location.href = '/login';
        } else if (isOwnApi && response.status === 403) {
            response.clone().json().then((body) => {
                const message = (body && body.error) || 'Bạn không có quyền thực hiện thao tác này.';
                if (window.Swal) Swal.fire({ icon: 'warning', title: 'Không có quyền', text: message });
                else console.warn(message);
            }).catch(() => {});
        }
        return response;
    };
})();

// ===== THU TIEN DON HANG (dung chung cho trang Don hang va trang Ke toan) =====
// order: { id, maDH, vat, tongCong, daThu, conNo }. onDone(result) duoc goi sau khi ghi nhan thanh cong.
async function openCollectPayment(order, onDone) {
    const vnd = v => (v || 0).toLocaleString('vi-VN');
    const { value: form } = await Swal.fire({
        title: 'Thu tiền đơn ' + order.maDH,
        html: `<p class="text-sm text-gray-500 mb-3">Tổng đơn ${vnd(order.tongCong)}đ · Đã thu ${vnd(order.daThu)}đ · <b class="text-red-600">Còn ${vnd(order.conNo)}đ</b></p>
               <input id="pay_amount" class="swal2-input" inputmode="numeric" placeholder="Số tiền thu (đ)" value="${vnd(order.conNo)}" oninput="formatCurrencyInput(this)">
               <input id="pay_date" type="date" class="swal2-input" value="${new Date().toLocaleDateString('en-CA')}">
               <input id="pay_note" class="swal2-input" placeholder="Ghi chú (tên người nhận, nội dung CK...)">`,
        showCancelButton: true, confirmButtonText: 'Ghi nhận', cancelButtonText: 'Hủy', confirmButtonColor: '#059669',
        preConfirm: () => ({
            soTien: getRawNumber('pay_amount'),
            ngay: document.getElementById('pay_date').value,
            ghiChu: document.getElementById('pay_note').value
        })
    });
    if (!form) return;
    const res = await fetch(`/api/orders/${order.id}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    const result = await res.json();
    if (!result.success) return Swal.fire('Lỗi', result.error || 'Không ghi nhận được', 'error');
    Swal.fire({ toast: true, position: 'top-end', icon: 'success', timer: 2500, showConfirmButton: false, title: `Đã thu. Còn phải thu ${vnd(result.conNo)}đ` });
    if (onDone) onDone(result);
}

async function showOrderPayments(order) {
    const rows = await (await fetch(`/api/orders/${order.id}/payments`)).json();
    const vnd = v => (v || 0).toLocaleString('vi-VN');
    let body = '<tr><td class="p-4 text-gray-400 italic">Chưa có lần thu nào được ghi nhận qua nút Thu tiền</td></tr>';
    if (Array.isArray(rows) && rows.length) {
        body = rows.map(p => `<tr><td class="p-2 text-left">${esc(p.ngay)}</td><td class="p-2 text-right font-bold text-emerald-600">${vnd(p.soTien)}đ</td><td class="p-2 text-left">${esc(p.nguoiThu || '')}</td><td class="p-2 text-left text-gray-500">${esc(p.ghiChu || '')}</td></tr>`).join('');
    }
    Swal.fire({ title: 'Lịch sử thu tiền ' + (order.maDH || ''), html: `<table class="w-full text-sm">${body}</table>`, width: 720, confirmButtonText: 'Đóng' });
}

// ===== CHUNG TU DON HANG: hop dong, hoa don, bien ban (dung chung cho trang Don hang va trang Ke toan) =====
const ORDER_DOC_STATUSES = {
    hopdong: ['Chưa có', 'Đã soạn', 'Đã gửi khách', 'Đã ký', 'Không cần'],
    po: ['Chưa có', 'Đã nhận', 'Không cần'],
    hoadon: ['Chưa xuất', 'Đã xuất', 'Đã gửi khách', 'Không xuất'],
    bienban: ['Chưa có', 'Đã gửi khách', 'Đã ký', 'Không cần']
};
// Nhan trang thai chung tu; bam vao de cap nhat
function orderDocBadge(order, loai, clickFn) {
    const d = (order.chungTu || {})[loai];
    if (!d) return '';
    const skipped = d.trangThai === 'Không cần' || d.trangThai === 'Không xuất';
    const cls = skipped ? 'bg-gray-100 text-gray-500' : d.done ? 'bg-emerald-100 text-emerald-700' : (/Đã/.test(d.trangThai) ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-600');
    return `<button type="button" onclick="event.stopPropagation(); ${clickFn}(${order.id}, '${loai}')" title="${esc(d.label)}${d.so ? ' số ' + esc(d.so) : ''}${d.ngay ? ' - ' + esc(d.ngay) : ''}. Bấm để cập nhật" class="px-2 py-0.5 rounded text-[10px] font-black ${cls} hover:opacity-75">${esc(d.trangThai)}${d.so ? ' · ' + esc(d.so) : ''}</button>`;
}
// order: { id, maDH, tongCong, chungTu }. onDone(docs) duoc goi sau khi luu.
async function openOrderDocument(order, loai, onDone) {
    const d = (order.chungTu || {})[loai] || { label: loai, trangThai: ORDER_DOC_STATUSES[loai][0] };
    const isInvoice = loai === 'hoadon';
    const { value: form } = await Swal.fire({
        title: `${d.label} — ${order.maDH}`,
        html: `<select id="doc_status" class="swal2-select" style="display:flex;width:80%">${ORDER_DOC_STATUSES[loai].map(s => `<option ${s === d.trangThai ? 'selected' : ''}>${s}</option>`).join('')}</select>
               <input id="doc_so" class="swal2-input" placeholder="Số ${esc(d.label.toLowerCase())}" value="${esc(d.so || '')}">
               <input id="doc_ngay" type="date" class="swal2-input" title="Ngày ký / ngày xuất" value="${esc(d.ngay || '')}">
               ${isInvoice ? `<input id="doc_giaTri" class="swal2-input" inputmode="numeric" placeholder="Giá trị hóa đơn (đ)" value="${d.giaTri ? Number(d.giaTri).toLocaleString('vi-VN') : (order.tongCong ? Number(order.tongCong).toLocaleString('vi-VN') : '')}" oninput="formatCurrencyInput(this)">` : ''}
               <input id="doc_link" class="swal2-input" placeholder="Link file (Google Drive...)" value="${esc(d.link || '')}">
               <input id="doc_ghiChu" class="swal2-input" placeholder="Ghi chú" value="${esc(d.ghiChu || '')}">
               ${d.updatedBy ? `<p class="text-xs text-gray-400 mt-2">Cập nhật gần nhất: ${esc(d.updatedBy)} · ${esc(String(d.updatedAt || '').slice(0, 10))}</p>` : ''}`,
        showCancelButton: true, confirmButtonText: 'Lưu', cancelButtonText: 'Hủy',
        preConfirm: () => ({
            trangThai: document.getElementById('doc_status').value,
            so: document.getElementById('doc_so').value,
            ngay: document.getElementById('doc_ngay').value,
            giaTri: isInvoice ? getRawNumber('doc_giaTri') : undefined,
            link: document.getElementById('doc_link').value,
            ghiChu: document.getElementById('doc_ghiChu').value
        })
    });
    if (!form) return;
    const res = await fetch(`/api/orders/${order.id}/documents/${loai}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
    const result = await res.json();
    if (!result.success) return Swal.fire('Lỗi', result.error || 'Không lưu được', 'error');
    Swal.fire({ toast: true, position: 'top-end', icon: 'success', timer: 2000, showConfirmButton: false, title: 'Đã cập nhật ' + d.label.toLowerCase() });
    if (onDone) onDone(result.docs);
}

// ===== CUA SO (MODAL) -> TRANG CHI TIET =====
// Moi khung `fixed inset-0` cua cac trang duoc hien thanh TRANG CHI TIET chiem tron vung noi dung (khong con popup de len trang):
// khi khung duoc mo, phan con lai cua trang an di va co thanh "Quay lai" o dau; dong khung thi tra lai trang nhu cu.
// Cac trang van mo / dong khung nhu truoc (bo class `hidden` hoac dat style.display) nen khong phai sua tung trang.
(function pageModals() {
    if (window.__pageModals) return; // file nay co the bi nap 2 lan
    window.__pageModals = true;
    const css = document.createElement('style');
    css.textContent = `
        .page-modal { position: static !important; inset: auto !important; background: transparent !important; padding: 0 !important; overflow: visible !important;
            -webkit-backdrop-filter: none !important; backdrop-filter: none !important; flex-direction: column !important; align-items: stretch !important; justify-content: flex-start !important; gap: 12px; }
        .page-modal > *:not(.pm-bar) { max-width: none !important; width: 100% !important; margin: 0 !important; max-height: none !important; box-shadow: 0 1px 3px rgba(0,0,0,.08) !important; transform: none !important; }
        /* Form nho (truoc la popup hep) khong keo dan het man hinh: o nhap giu do dai vua voi noi dung */
        .page-modal > .max-w-sm:not(.pm-bar), .page-modal > .max-w-md:not(.pm-bar), .page-modal > .max-w-lg:not(.pm-bar), .page-modal > .max-w-xl:not(.pm-bar) { max-width: 720px !important; }
        .page-modal > .max-w-2xl:not(.pm-bar), .page-modal > .max-w-3xl:not(.pm-bar) { max-width: 980px !important; }
        .page-modal .max-h-\\[90vh\\], .page-modal .max-h-\\[85vh\\], .page-modal .max-h-\\[80vh\\], .page-modal .max-h-\\[70vh\\], .page-modal .max-h-screen { max-height: none !important; }
        .pm-bar { display: flex; align-items: center; gap: 12px; background: #fff; border: 1px solid #f1f5f9; border-radius: 16px; padding: 10px 16px; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
        .pm-bar button { background: #f1f5f9; color: #334155; font-weight: 700; font-size: 14px; padding: 6px 12px; border-radius: 8px; }
        .pm-bar button:hover { background: #e2e8f0; }
        .pm-hidden { display: none !important; }`;
    document.head.appendChild(css);

    const stack = []; // cac trang chi tiet dang mo (trang mo tu trong trang khac thi xep chong)
    let main = null, savedScroll = 0, fromPop = false, skipPop = false;
    // style.display dat truc tiep thi uu tien hon class `hidden` (giong cach trinh duyet hien thi)
    const ownShown = (el) => (el.style.display ? el.style.display !== 'none' : !el.classList.contains('hidden'));

    function layout() {
        const top = stack[stack.length - 1] || null;
        [...main.children].forEach((c) => { if (c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE') c.classList.toggle('pm-hidden', !!top && c !== top); });
    }
    function closeModal(el) {
        const btn = [...el.querySelectorAll('[onclick]')].find((b) => !b.closest('.pm-bar') && /^\s*(close|hide)\w*\(/i.test(b.getAttribute('onclick') || ''));
        if (btn) btn.click();
        if (ownShown(el)) { if (el.style.display) el.style.display = 'none'; else el.classList.add('hidden'); }
    }
    function sync(el) {
        const shown = ownShown(el), idx = stack.indexOf(el);
        if (shown && idx < 0) {
            if (!stack.length) savedScroll = main.scrollTop;
            if (el.parentNode !== main) main.appendChild(el);
            stack.push(el);
            layout();
            main.scrollTop = 0;
            history.pushState({ pm: el.id }, '');
        } else if (!shown && idx >= 0) {
            stack.splice(idx, 1);
            layout();
            if (!stack.length) main.scrollTop = savedScroll;
            if (!fromPop && history.state && history.state.pm === el.id) { skipPop = true; history.back(); } // tu dong bang nut tren trang: lui lich su, khong dong them trang ben duoi
        }
    }
    function setup() {
        main = document.querySelector('main');
        if (!main) return;
        document.querySelectorAll('div.fixed.inset-0[id]').forEach((el) => {
            el._pmByClass = el.classList.contains('hidden');
            el.classList.add('page-modal');
            el.onclick = null; // bo kieu "bam ra ngoai de dong" cua popup
            const bar = document.createElement('div');
            bar.className = 'pm-bar';
            bar.innerHTML = '<button type="button"><i class="fas fa-arrow-left mr-1"></i>Quay lại</button>';
            bar.firstChild.addEventListener('click', () => closeModal(el));
            el.insertBefore(bar, el.firstChild);
            new MutationObserver(() => sync(el)).observe(el, { attributes: true, attributeFilter: ['class', 'style'] });
            sync(el);
        });
        // Nut Back cua trinh duyet = "Quay lai"
        window.addEventListener('popstate', () => {
            if (skipPop) { skipPop = false; return; }
            const top = stack[stack.length - 1];
            if (!top) return;
            fromPop = true;
            closeModal(top);
            setTimeout(() => { fromPop = false; }, 0);
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup); else setup();
})();

// ===== MO THU MUC DRIVE CUA DON HANG: tren may (neu may co Google Drive cho may tinh) hoac tren web =====
// Moi nut mo thu muc la 1 lien ket toi /api/orders/<id>/folder/<key> (hoac /api/dispatch/mine/<id>/folder/<key>).
// - Duong dan thu muc goc tren may do Admin khai bao 1 lan o trang CAI DAT HE THONG (window.HTG_DRIVE_ROOT, dung chung moi may).
// - Chua khai bao: nut mo thu muc tren web (drive.google.com).
// - Da khai bao: lan dau bam nut tren 1 may, he thong hoi may nay mo "tren may" hay "tren web" va nho lua chon (theo trinh duyet).
//   Mo tren may dung giao thuc htgfolder:// (cai cong cu /tools/htg-open-folder.zip 1 lan), kem lien ket "Mo tren web" du phong.
const DRIVE_MODE_KEY = 'htgDriveMode';
const systemDriveRoot = () => String(window.HTG_DRIVE_ROOT || '').trim().replace(/[\\/]+$/, '');
function driveMode() { try { const m = localStorage.getItem(DRIVE_MODE_KEY); return m === 'local' || m === 'web' ? m : ''; } catch (e) { return 'web'; } }
function setDriveMode(mode) {
    try { if (mode) localStorage.setItem(DRIVE_MODE_KEY, mode); else localStorage.removeItem(DRIVE_MODE_KEY); } catch (e) { /* bo qua */ }
    if (window.Swal && mode) Swal.fire({ toast: true, position: 'top-end', icon: 'success', timer: 2500, showConfirmButton: false, title: mode === 'local' ? 'Máy này: mở thư mục trên máy' : 'Máy này: mở thư mục trên web' });
}
async function askDriveMode() {
    const r = await Swal.fire({
        title: 'Mở thư mục trên máy này?', icon: 'question',
        html: `<div style="font-size:13px;text-align:left;line-height:1.5">Nếu máy này đã cài <b>Google Drive cho máy tính</b> và công cụ <a href="/tools/htg-open-folder.zip" style="color:#2563eb;font-weight:700">htg-open-folder</a>, các nút thư mục sẽ mở thẳng File Explorer tại<br><code>${esc(systemDriveRoot())}</code><br>Nếu không, chọn mở trên web. Hệ thống chỉ hỏi một lần cho mỗi máy.</div>`,
        showDenyButton: true, showCancelButton: true, confirmButtonText: 'Mở trên máy', denyButtonText: 'Mở trên web', cancelButtonText: 'Để sau'
    });
    if (r.isConfirmed) { setDriveMode('local'); return 'local'; }
    if (r.isDenied) { setDriveMode('web'); return 'web'; }
    return '';
}
async function openFolderUrl(apiUrl) {
    const root = systemDriveRoot();
    let mode = root ? driveMode() : 'web';
    if (root && !mode) mode = await askDriveMode();
    if (!mode) return;
    if (mode === 'web') { window.open(apiUrl, '_blank'); return; }
    let info;
    try { info = await (await fetch(apiUrl + (apiUrl.includes('?') ? '&' : '?') + 'info=1')).json(); } catch (e) { window.open(apiUrl, '_blank'); return; }
    if (!info.success) return Swal.fire({ icon: 'info', title: 'Chưa có thư mục', text: info.error || 'Đơn chưa có thư mục này trên Google Drive.' });
    if (!info.relPath) { window.open(info.url, '_blank'); return; }
    const sep = (root.includes('/') && !root.includes('\\')) ? '/' : '\\';
    const path = root + sep + info.relPath.join(sep);
    try { if (navigator.clipboard) navigator.clipboard.writeText(path).catch(() => {}); } catch (e) { /* bo qua */ }
    location.href = 'htgfolder://open?path=' + encodeURIComponent(path);
    Swal.fire({ toast: true, position: 'bottom-end', icon: 'info', timer: 9000, showConfirmButton: false, title: 'Đang mở thư mục trên máy',
        html: `<div style="font-size:12px;text-align:left">${esc(path)}<br>Đã copy đường dẫn. Không thấy cửa sổ mở? <a href="${esc(info.url)}" target="_blank" style="color:#2563eb;font-weight:700">Mở trên web</a> · <a href="#" onclick="setDriveMode('web'); return false" style="color:#64748b">Máy này luôn mở trên web</a></div>` });
}
function openOrderFolder(orderId, key) { return openFolderUrl(`/api/orders/${orderId}/folder/${key}`); }
document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !/^\/api\/(orders|dispatch\/mine)\/\d+\/folder\//.test(a.getAttribute('href') || '')) return;
    if (!systemDriveRoot() || driveMode() === 'web') return; // mo tren web nhu lien ket thuong
    e.preventDefault();
    openFolderUrl(a.getAttribute('href'));
});
