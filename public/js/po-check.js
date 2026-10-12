// KIEM VAT TU MUA VE - giao dien dung chung cho trang Mua hang PCB va Mua hang linh kien (can /js/scan.js).
// PoCheck.open(idPO) | PoCheck.open('kc-<id don>') | PoCheck.openLog('pcb' | 'lk') | PoCheck.openCustomer()
// Mo thanh 1 trang chi tiet (an danh sach), co nut Quay lai. Sau khi kiem xong goi PoCheck.onDone() de trang tai lai danh sach.
(function () {
    const C = { data: null, scan: null, hidden: [], onDone: null };
    const h = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const n = (v) => (Number(v) || 0).toLocaleString('vi-VN');
    const num = (v) => { let t = String(v == null ? '' : v).trim().replace(/\s/g, ''); if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, ''); return parseFloat(t.replace(',', '.')) || 0; };
    const dt = (v) => { const d = new Date(v); return isNaN(d) ? '' : d.toLocaleDateString('vi-VN') + ' ' + d.toLocaleTimeString('vi-VN'); };
    const OK = 'Đúng chủng loại';
    const fail = (msg) => (window.Swal ? Swal.fire('Lỗi', msg || 'Không thực hiện được', 'error') : alert(msg));

    function page(title, body) {
        let box = document.getElementById('poCheckPage');
        if (!box) {
            const host = document.querySelector('main > div') || document.querySelector('main');
            C.hidden = [...host.children].filter((c) => c.style.display !== 'none');
            C.hidden.forEach((c) => { c.dataset.pcDisplay = c.style.display; c.style.display = 'none'; });
            box = document.createElement('div'); box.id = 'poCheckPage'; box.className = 'space-y-4';
            host.appendChild(box);
            const m = document.querySelector('main'); if (m) m.scrollTop = 0;
        }
        box.innerHTML = `<div class="flex flex-wrap items-center gap-3 bg-white rounded-2xl border border-gray-100 shadow-sm px-5 py-3">
            <button onclick="PoCheck.close()" class="px-3 py-1.5 rounded-lg text-sm font-bold bg-slate-100 text-slate-700 hover:bg-slate-200"><i class="fas fa-arrow-left mr-1"></i>Quay lại</button>
            <h2 class="font-black text-slate-800 text-lg">${title}</h2></div>${body}`;
    }
    C.close = () => {
        HtgScan.stop(); C.data = null; C.scan = null;
        const box = document.getElementById('poCheckPage'); if (box) box.remove();
        C.hidden.forEach((c) => { c.style.display = c.dataset.pcDisplay || ''; }); C.hidden = [];
        if (C.onDone) C.onDone();
    };

    function logTable(list, full) {
        if (!list.length) return '<p class="text-xs text-gray-400 italic">Chưa có lần kiểm nào.</p>';
        return `<div class="overflow-x-auto"><table class="w-full text-xs"><thead class="text-[10px] uppercase text-gray-400 text-left border-b"><tr><th class="p-2">Ngày giờ kiểm</th><th class="p-2">Người kiểm</th>${full ? '<th class="p-2">PO · nguồn</th><th class="p-2">Đơn</th>' : ''}<th class="p-2">Vật tư</th><th class="p-2 text-right">SL đếm</th><th class="p-2">Kết quả</th><th class="p-2">Nhận diện bằng</th><th class="p-2">Ghi chú</th></tr></thead>
            <tbody>${list.map((c) => `<tr class="border-b last:border-0 ${c.result === OK ? '' : 'bg-red-50'}" data-logrow="${h([dt(c.checkedAt), c.checkedBy, c.poCode, c.supplierName, c.maDH, c.name, c.itemCode, c.result].join(' ').toLowerCase())}"><td class="p-2 whitespace-nowrap font-semibold text-gray-700">${dt(c.checkedAt)}</td><td class="p-2">${h(c.checkedBy)}</td>
                ${full ? `<td class="p-2 text-gray-600">${h(c.poCode || '—')} · ${h(c.supplierName)}</td><td class="p-2 text-gray-500">${h(c.maDH)}</td>` : ''}
                <td class="p-2">${h(c.name)}</td><td class="p-2 text-right font-bold">${n(c.qty)}</td><td class="p-2 font-bold ${c.result === OK ? 'text-emerald-600' : 'text-red-600'}">${h(c.result)}</td>
                <td class="p-2 text-gray-500" title="${h(c.scanned)}">${h(c.method)}</td><td class="p-2 text-gray-600">${h(c.note)}</td></tr>`).join('')}</tbody></table></div>`;
    }

    C.open = async (key) => {
        const d = await (await fetch('/api/purchase/check/' + key)).json();
        if (!d.success) return fail(d.error);
        C.data = d; C.scan = null; render();
    };
    function render() {
        const d = C.data, edit = d.open && d.canCheck, kc = d.kind === 'kc';
        const last = (l) => d.checks.find((c) => (d.kind === 'manual' ? c.itemIdx === l.key : c.buyLineId === l.key));
        page(`${h(d.title)} <span class="font-normal text-sm text-gray-500">· ${h(d.sub)} · ${kc ? 'kiểm hàng khách gửi' : 'chi tiết PO & kiểm hàng về'}${d.status ? ' · ' + h(d.status) : ''}</span>`, `
            ${d.info ? `<div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">${[['Nhà cung cấp', h(d.info.supplierName) || '—'], ['Loại PO', h({ PCB: 'PCB', LinhKien: 'Linh kiện', GiaCong: 'Gia công' }[d.info.type] || d.info.type)], ['Cho đơn hàng', h(d.info.maDH) || '—'], ['Giá trị PO', n(d.info.totalAmount) + ' ' + h(d.info.currency === 'VND' ? 'đ' : d.info.currency)], ['Ngày đặt · người đặt', (d.info.createdAt ? new Date(d.info.createdAt).toLocaleDateString('vi-VN') : '—') + ' · ' + h(d.info.createdBy)], ['Dự kiến về · đã nhận', h((d.expectedDate || '—').slice(0, 10)) + ' · ' + h(d.info.receivedDate || 'chưa')]]
                .map(([a, b]) => `<div><p class="text-[10px] font-black text-gray-400 uppercase">${a}</p><p class="font-semibold text-gray-800 mt-0.5">${b}</p></div>`).join('')}${d.info.note ? `<p class="col-span-2 md:col-span-6 text-xs text-gray-600"><span class="text-gray-400">Ghi chú: </span>${h(d.info.note)}</p>` : ''}</div>` : ''}
            ${d.ship ? shipHtml(d) : ''}
            ${edit ? HtgScan.barHtml() : ''}
            <div class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
            ${edit ? `<div class="flex flex-wrap items-center justify-end gap-2 px-5 py-3 bg-slate-50 border-b">
                <button onclick="PoCheck.fill()" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-white border hover:bg-gray-100">Điền về đủ (các dòng đang hiện)</button>
                <button onclick="PoCheck.submit()" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700"><i class="fas fa-clipboard-check mr-1"></i>Xác nhận đã kiểm</button></div>` : ''}
            <div class="overflow-x-auto"><table class="w-full text-xs"><thead class="text-[10px] uppercase text-gray-400 text-left border-b"><tr><th class="p-2">Vật tư</th><th class="p-2">Cho đơn · mạch</th><th class="p-2 text-right">${kc ? 'Cần' : 'Đặt'}</th><th class="p-2 text-right">Đã về</th>${kc ? '' : '<th class="p-2 text-right">Đơn giá</th><th class="p-2 text-right">Thành tiền</th>'}<th class="p-2">Kiểm gần nhất</th><th class="p-2 text-right">Đếm được lần này</th>${kc ? '' : '<th class="p-2">Chủng loại</th>'}<th class="p-2">Ghi chú kiểm</th></tr></thead>
            <tbody>${d.lines.map((l) => { const rest = Math.max(0, l.ordered - l.received), on = edit && rest > 0 && !l.cancelled, c = last(l); return `<tr class="border-b last:border-0 ${l.cancelled ? 'opacity-50' : ''} ${l.alt ? 'bg-yellow-100' : ''}" data-scanrow="${l.key}">
                <td class="p-2 font-semibold text-gray-700">${h(l.name)}${l.code && !l.name.includes(l.code) ? `<span class="block font-normal text-gray-400">${h(l.code)}</span>` : ''}${l.alt ? `<span class="block text-[11px] font-bold text-yellow-800"><i class="fas fa-exchange-alt mr-1"></i>Mã thay thế: ${h(l.alt)} — hàng về có thể là mã này</span>` : ''}${l.need && l.ordered > l.need ? `<span class="block text-[11px] font-normal text-amber-700">cần ${n(l.need)}, dư ${n(l.ordered - l.need)} → ${l.surplus === 'khach' ? 'trả khách' : 'nhập kho'}</span>` : ''}</td>
                <td class="p-2 text-gray-500">${h(l.forOrder)}</td><td class="p-2 text-right">${n(l.ordered)} ${h(l.unit)}</td>
                <td class="p-2 text-right font-bold ${l.received >= l.ordered ? 'text-emerald-600' : ''}">${n(l.received)}</td>
                ${kc ? '' : `<td class="p-2 text-right">${l.price ? n(l.price) : '—'}</td><td class="p-2 text-right font-semibold">${l.price ? n(Math.round(l.price * l.ordered)) : '—'}</td>`}
                <td class="p-2 text-[11px] ${c && c.result !== OK ? 'text-red-600 font-bold' : 'text-gray-500'}">${c ? `${h(c.checkedBy)}<span class="block">${dt(c.checkedAt)}${c.result !== OK ? ' · ' + h(c.result) : ''}</span>` : '—'}</td>
                <td class="p-2 text-right">${on ? `<input data-qty="${l.key}" data-rest="${rest}" placeholder="còn ${n(rest)}" class="border rounded px-2 py-1 text-xs text-right w-24 outline-none focus:ring-2 focus:ring-emerald-400">` : (l.cancelled ? 'đã hủy' : (rest > 0 ? '' : '<span class="text-gray-300">đủ</span>'))}</td>
                ${kc ? '' : `<td class="p-2">${on ? `<select data-type="${l.key}" class="border rounded px-1 py-1 text-xs bg-white"><option value="">Đúng loại</option><option value="1">Sai loại</option></select>` : ''}</td>`}
                <td class="p-2">${on ? `<input data-note="${l.key}" placeholder="thiếu, sai mã, bao bì..." class="border rounded px-2 py-1 text-xs w-40">` : ''}</td></tr>`; }).join('') || '<tr><td colspan="10" class="p-6 text-center text-gray-400 italic">PO này không có dòng hàng nào.</td></tr>'}</tbody></table></div>
            <p class="px-4 py-2 text-[11px] border-t ${d.open && !d.canCheck ? 'text-amber-700 bg-amber-50' : 'text-gray-400'}">${d.open && !d.canCheck ? 'Tài khoản của bạn chỉ xem. Việc kiểm do nhóm mua hàng phụ trách loại hàng này thực hiện.' : 'Chỉ kiểm <b>đủ số lượng</b> và <b>đúng chủng loại</b>. Mỗi lần xác nhận được ghi lại ngày, giờ, người kiểm. Dòng "Sai loại" không tính là đã về và bắt buộc có ghi chú.'}</p></div>
            <div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-4"><p class="text-xs font-black text-gray-400 uppercase mb-2">Nhật ký kiểm</p>${logTable(d.checks, false)}</div>`);
        if (edit && HtgScan.mount()) { if (C.scan) showScan(); else HtgScan.focus(); }
    }
    // Van chuyen tu NCC ve: NCC da gui chua, don vi van chuyen, ma van don, du kien ve
    function shipHtml(d) {
        const s = d.ship, ro = d.canCheck ? '' : 'disabled', inp = 'border rounded-lg px-2 py-1.5 text-sm bg-white';
        return `<div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-4">
            <p class="text-xs font-black text-gray-400 uppercase mb-2"><i class="fas fa-truck mr-1"></i>Vận chuyển từ nhà cung cấp ${s.at ? `<span class="normal-case font-normal text-gray-400">· cập nhật ${dt(s.at)} bởi ${h(s.by)}</span>` : ''}</p>
            <div class="flex flex-wrap items-end gap-3 text-xs font-bold text-gray-600">
                <label>Tình trạng<select id="shipStatus" ${ro} class="block mt-1 ${inp} font-bold">${s.statuses.map((x) => `<option ${x === s.shipStatus ? 'selected' : ''}>${h(x)}</option>`).join('')}</select></label>
                <label>Đơn vị vận chuyển<input id="shipCarrier" ${ro} value="${h(s.carrier)}" placeholder="DHL, FedEx, GHTK, xe NCC..." class="block mt-1 ${inp} w-44 font-normal"></label>
                <label>Mã vận đơn<input id="shipTracking" ${ro} value="${h(s.trackingNo)}" class="block mt-1 ${inp} w-44 font-normal"></label>
                <label>Dự kiến về<input id="shipEta" type="date" ${ro} value="${h((s.expectedDate || '').slice(0, 10))}" class="block mt-1 ${inp} font-normal"></label>
                <label class="flex-1 min-w-[180px]">Ghi chú<input id="shipNote" ${ro} value="${h(s.shipNote)}" placeholder="kẹt hải quan, giao 2 đợt..." class="block mt-1 ${inp} w-full font-normal"></label>
                ${d.canCheck ? '<button onclick="PoCheck.saveShip()" class="px-4 py-2 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-700">Lưu vận chuyển</button>' : ''}
            </div></div>`;
    }
    C.saveShip = async () => {
        const v = (id) => document.getElementById(id).value;
        const res = await (await fetch(`/api/purchase/orders/${C.data.ship.poId}/shipping`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shipStatus: v('shipStatus'), carrier: v('shipCarrier'), trackingNo: v('shipTracking'), expectedDate: v('shipEta'), shipNote: v('shipNote') }) })).json();
        if (!res.success) return fail(res.error);
        if (window.Swal) Swal.fire({ toast: true, position: 'top-end', icon: 'success', timer: 2000, showConfirmButton: false, title: 'Đã lưu tình trạng vận chuyển' });
        C.open(C.data.key);
    };
    const rows = () => [...document.querySelectorAll('#poCheckPage tr[data-scanrow]')];
    function applyScan(text, method) {
        if (!C.data) return;
        const m = HtgScan.match(text, C.data.lines.map((l) => ({ id: l.key, keys: l.keys })));
        C.scan = { text: String(text).trim().slice(0, 300), method, ids: m.ids, qty: HtgScan.qty(text) };
        showScan();
    }
    function showScan() {
        const s = C.scan;
        if (!s.ids.length) {
            rows().forEach((tr) => { tr.style.display = ''; });
            return HtgScan.info(`<b class="text-red-600"><i class="fas fa-exclamation-triangle mr-1"></i>Không có vật tư nào ở đây khớp "${h(s.text.slice(0, 60))}"</b> — kiểm tra lại: có thể giao sai chủng loại hoặc hàng của PO khác.`);
        }
        let first = null;
        rows().forEach((tr) => {
            const on = s.ids.includes(Number(tr.dataset.scanrow));
            tr.style.display = on ? '' : 'none';
            if (on) { tr.dataset.method = s.method; tr.dataset.scanned = s.text; const i = tr.querySelector('input[data-qty]'); if (i && !first) first = i; }
        });
        HtgScan.info(`<b class="text-blue-700">${s.ids.length} dòng khớp</b> "${h(s.text.slice(0, 60))}" · ${h(s.method)}${s.qty ? ` · nhãn ghi SL ${n(s.qty)}` : ''}`);
        if (first) { if (s.ids.length === 1 && s.qty && !first.value) first.value = s.qty; first.focus(); }
    }
    C.fill = () => document.querySelectorAll('#poCheckPage input[data-qty]').forEach((i) => { if (i.closest('tr').style.display !== 'none') i.value = i.dataset.rest; });
    C.submit = async () => {
        const q = (sel) => document.querySelector('#poCheckPage ' + sel);
        const items = [...document.querySelectorAll('#poCheckPage input[data-qty]')].map((i) => { const k = i.dataset.qty, tr = i.closest('tr'), t = q(`select[data-type="${k}"]`);
            return { key: Number(k), qty: num(i.value), wrong: !!t && t.value === '1', note: q(`input[data-note="${k}"]`).value.trim(), method: tr.dataset.method || 'Nhập tay', scanned: tr.dataset.scanned || '' }; }).filter((i) => i.qty > 0);
        if (!items.length) return window.Swal && Swal.fire('Chưa nhập số lượng', 'Nhập số lượng đếm được ở cột "Đếm được lần này" hoặc bấm "Điền về đủ".', 'info');
        const res = await (await fetch('/api/purchase/check/' + C.data.key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) })).json();
        if (!res.success) return fail(res.error);
        if (window.Swal) Swal.fire({ toast: true, position: 'top-end', icon: res.wrong ? 'warning' : 'success', timer: 3500, showConfirmButton: false, title: `Đã ghi nhật ký kiểm: ${res.received} dòng đã nhận${res.wrong ? `, ${res.wrong} dòng sai chủng loại (chưa tính là đã về)` : ''}` });
        C.open(C.data.key);
    };

    C.openLog = async (scope) => {
        const list = await (await fetch('/api/purchase/check-log?scope=' + scope)).json();
        C.data = null;
        page('Nhật ký kiểm vật tư <span class="font-normal text-sm text-gray-500">· 90 ngày gần nhất · ' + list.length + ' lần kiểm</span>', `<div class="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
            <input oninput="PoCheck.filterLog(this.value)" placeholder="Lọc theo ngày (vd 06/10/2026), giờ, người kiểm, PO, vật tư..." class="border rounded-lg px-3 py-1.5 text-sm w-96 max-w-full">${logTable(list, true)}</div>`);
    };
    C.filterLog = (v) => { const x = v.trim().toLowerCase(); document.querySelectorAll('#poCheckPage tr[data-logrow]').forEach((tr) => { tr.style.display = !x || tr.dataset.logrow.includes(x) ? '' : 'none'; }); };
    C.openCustomer = async () => {
        const list = await (await fetch('/api/purchase/check-customer')).json();
        C.data = null;
        page('Hàng khách gửi chờ kiểm', `<div class="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">${list.length ? `<table class="w-full text-sm"><thead class="bg-slate-50 text-[10px] uppercase text-gray-500 text-left"><tr><th class="p-3">Đơn hàng</th><th class="p-3">Khách hàng</th><th class="p-3">Dòng khách cấp đã về đủ</th></tr></thead>
            <tbody>${list.map((o) => `<tr onclick="PoCheck.open('kc-${o.orderId}')" class="border-t cursor-pointer hover:bg-blue-50/50"><td class="p-3 font-bold text-blue-700">${h(o.maDH)}</td><td class="p-3">${h(o.tenKH)}</td><td class="p-3 font-bold text-amber-600">${o.done}/${o.lines}</td></tr>`).join('')}</tbody></table>
            <p class="px-4 py-2 text-xs text-gray-400 border-t">Bấm vào một đơn để kiểm linh kiện khách gửi sang. Hàng khách gửi không nhập vào kho công ty.</p>` : '<p class="p-8 text-center text-gray-400 italic">Không có đơn nào đang chờ linh kiện khách gửi.</p>'}</div>`);
    };

    HtgScan.onScan = applyScan;
    HtgScan.onClear = () => { C.scan = null; rows().forEach((tr) => { tr.style.display = ''; }); };
    HtgScan.onChange = () => { if (C.data) render(); };
    window.PoCheck = C;
})();
