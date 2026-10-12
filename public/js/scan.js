// QUET MA VACH / CAMERA dung chung (kiem vat tu mua ve, nhap - xuat kho).
// - May quet ma vach (USB / bluetooth) hoat dong nhu ban phim: quet vao o quet la xong, khong can cai dat.
// - Camera ma vach / QR: BarcodeDetector cua trinh duyet.   - Camera OCR: chup nhan, doc chu bang Tesseract.js (tai tu internet lan dau).
// Trang dung: chen HtgScan.barHtml() vao giao dien, goi HtgScan.mount() sau moi lan ve lai, gan HtgScan.onScan = (text, method) => {...}.
(function () {
    const S = { dev: 'scanner', stream: null, timer: null, busy: false, keyTimes: [], onScan: null, onClear: null, onChange: null };
    try { S.dev = localStorage.getItem('htg_scan_dev') || 'scanner'; } catch (e) { /* bo qua */ }
    const el = (id) => document.getElementById(id);
    const h = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const alertBox = (title, text, icon) => (window.Swal ? Swal.fire(title, text, icon) : alert(title + '\n' + text));

    S.norm = (v) => String(v == null ? '' : v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '');
    // So luong in tren nhan cua NCC (LCSC: qty:100 ; Digikey / Mouser: truong Q100)
    S.qty = (text) => {
        const m = /(?:qty|quantity|sl)\s*[:=]\s*(\d+)/i.exec(text) || /(?:^|[\x1d\x1e,;{])Q(\d{1,7})(?:$|[\x1d\x1e,;}])/.exec(text);
        return m ? Number(m[1]) : 0;
    };
    // entries: [{ id, keys: [ma hang, ma NSX, ten goi khac, ten] }] -> { ids, strong }
    //   strong: ma nam tron trong noi dung quet; neu khong co thi lay cac dong khop 1 phan (go mot phan ten / ma)
    S.match = (text, entries) => {
        const whole = S.norm(text);
        const tokens = String(text).split(/[\s,;:{}\x1d\x1e|]+/).map(S.norm).filter((t) => t.length >= 4);
        const strong = [], weak = [];
        for (const e of entries) {
            const keys = (e.keys || []).map(S.norm).filter((k) => k.length >= 3);
            if (keys.some((k) => whole.includes(k) || tokens.includes(k))) strong.push(e.id);
            else if (whole.length >= 3 && keys.some((k) => k.includes(whole) || tokens.some((t) => k.includes(t)))) weak.push(e.id);
        }
        return { ids: strong.length ? strong : weak, strong: strong.length > 0 };
    };

    S.barHtml = (opt = {}) => {
        const cam = S.dev !== 'scanner';
        const o = (v, label) => `<option value="${v}" ${S.dev === v ? 'selected' : ''}>${label}</option>`;
        return `<div class="bg-white rounded-2xl border border-blue-200 shadow-sm p-4 space-y-3">
        <div class="flex flex-wrap items-center gap-2">
            <i class="fas fa-barcode text-blue-600 text-lg"></i>
            <select id="scanDev" onchange="HtgScan.setDev(this.value)" class="border rounded-lg px-2 py-1.5 text-sm bg-white font-bold text-gray-700">
                ${o('scanner', 'Máy quét mã vạch / gõ tay')}${o('barcode', 'Camera: mã vạch, QR')}${o('ocr', 'Camera OCR: đọc chữ trên nhãn')}</select>
            <input id="scanBox" onkeydown="HtgScan.key(event)" placeholder="${h(opt.placeholder || 'Quét mã vạch, hoặc gõ mã / tên vật tư rồi Enter')}" autocomplete="off" class="border rounded-lg px-3 py-1.5 text-sm w-96 max-w-full outline-none focus:ring-2 focus:ring-blue-400">
            ${cam ? '<button type="button" onclick="HtgScan.start()" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-600 text-white hover:bg-blue-700"><i class="fas fa-video mr-1"></i>Bật camera</button>' : ''}
            <button type="button" onclick="HtgScan.clear()" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-white border hover:bg-gray-100">Hiện tất cả</button>
            ${opt.extra || ''}
            <span id="scanInfo" class="text-xs text-gray-500"></span>
        </div>
        <div id="scanCam" class="flex flex-wrap items-start gap-3" style="display:none">
            <video id="scanVideo" autoplay playsinline muted class="rounded-lg border bg-black w-80 max-w-full"></video>
            <div class="space-y-2 text-xs text-gray-500">
                <p id="scanCamHint"></p>
                <button type="button" id="scanShot" onclick="HtgScan.ocrShot()" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-700 text-white hover:bg-slate-800"><i class="fas fa-camera mr-1"></i>Chụp &amp; đọc nhãn</button>
                <button type="button" onclick="HtgScan.stop()" class="px-3 py-1.5 rounded-lg text-xs font-bold bg-white border hover:bg-gray-100">Tắt camera</button>
            </div>
        </div></div>`;
    };
    S.setDev = (v) => { S.dev = v; try { localStorage.setItem('htg_scan_dev', v); } catch (e) { /* bo qua */ } S.stop(); if (S.onChange) S.onChange(); };
    S.focus = () => { const b = el('scanBox'); if (b) b.focus(); };
    S.info = (html) => { const i = el('scanInfo'); if (i) i.innerHTML = html || ''; };
    S.clear = () => { S.info(''); if (S.onClear) S.onClear(); S.focus(); };
    // Goi sau moi lan giao dien duoc ve lai: gan lai camera dang bat. Tra ve false neu trang hien khong co thanh quet.
    S.mount = () => {
        if (!el('scanBox')) { S.stop(); return false; }
        if (S.stream) {
            el('scanCam').style.display = '';
            el('scanVideo').srcObject = S.stream;
            el('scanShot').style.display = S.dev === 'ocr' ? '' : 'none';
            el('scanCamHint').textContent = S.dev === 'ocr' ? 'Đưa nhãn vào giữa khung hình, đủ sáng, rồi bấm "Chụp & đọc nhãn".' : 'Đưa mã vạch / mã QR trên túi hàng vào khung hình, hệ thống tự nhận.';
        }
        return true;
    };
    // May quet go rat nhanh roi gui Enter; nguoi go thi cham -> phan biet de ghi "nhan dien bang" cho dung
    S.key = (e) => {
        if (e.key !== 'Enter') { S.keyTimes.push(Date.now()); return; }
        e.preventDefault(); // o quet nam trong form thi Enter khong duoc gui form
        const text = e.target.value, t = S.keyTimes; S.keyTimes = [];
        const fast = t.length >= 4 && (t[t.length - 1] - t[0]) / t.length < 35;
        e.target.value = '';
        if (text.trim() && S.onScan) S.onScan(text, fast ? 'Máy quét mã vạch' : 'Nhập tay');
    };
    S.stop = () => {
        if (S.timer) { clearInterval(S.timer); S.timer = null; }
        if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }
        const p = el('scanCam'); if (p) p.style.display = 'none';
    };
    S.start = async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return alertBox('Chưa dùng được camera', 'Trình duyệt chỉ cho mở camera khi phần mềm chạy bằng địa chỉ https:// hoặc trên chính máy chủ (localhost). Có thể dùng máy quét mã vạch thay thế — không cần cài đặt.', 'info');
        if (S.dev === 'barcode' && !('BarcodeDetector' in window)) return alertBox('Trình duyệt chưa hỗ trợ đọc mã vạch bằng camera', 'Hãy dùng Chrome / Edge trên điện thoại Android, hoặc chọn "Camera OCR", hoặc dùng máy quét mã vạch.', 'info');
        try { S.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } } }); }
        catch (e) { S.stream = null; return alertBox('Không mở được camera', 'Hãy cho phép trình duyệt dùng camera rồi thử lại. (' + (e.message || e.name) + ')', 'error'); }
        S.mount();
        if (S.dev !== 'barcode') return;
        const detector = new BarcodeDetector();
        let lastValue = '', lastAt = 0;
        S.timer = setInterval(async () => {
            const video = el('scanVideo');
            if (!video || S.busy || video.readyState < 2) return;
            S.busy = true;
            try {
                const codes = await detector.detect(video);
                const value = codes.length ? codes[0].rawValue : '';
                if (value && (value !== lastValue || Date.now() - lastAt > 4000)) { lastValue = value; lastAt = Date.now(); if (S.onScan) S.onScan(value, 'Camera mã vạch'); }
            } catch (e) { /* khung hinh loi: bo qua */ }
            S.busy = false;
        }, 400);
    };
    const loadScript = (src) => new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('Không tải được thư viện đọc chữ (cần internet).')); document.head.appendChild(s); });
    S.ocrShot = async () => {
        const video = el('scanVideo'), hint = el('scanCamHint');
        if (!video || !S.stream || S.busy) return;
        S.busy = true; hint.textContent = 'Đang đọc chữ trên nhãn...';
        try {
            const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
            const out = await Tesseract.recognize(canvas, 'eng');
            const text = (out.data.text || '').replace(/\s+/g, ' ').trim();
            hint.textContent = text ? 'Đã đọc: ' + text.slice(0, 120) : 'Không đọc được chữ nào. Đưa nhãn gần hơn, đủ sáng rồi chụp lại.';
            if (text && S.onScan) S.onScan(text, 'Camera OCR');
        } catch (e) { hint.textContent = e.message || 'Không đọc được nhãn.'; }
        S.busy = false;
    };
    window.addEventListener('beforeunload', S.stop);
    window.HtgScan = S;
})();
