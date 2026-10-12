// Uoc luong khoi luong gia cong (han dan SMD / han cam THT) tu BOM:
// moi dong BOM -> so chan cua 1 linh kien theo kieu chan (footprint), kieu gan (SMD / THT), co phai IC khong.
const { toNum } = require('./http');

const SOT_PINS = { 23: 3, 223: 4, 89: 3, 323: 3, 363: 6, 353: 5, 523: 3, 563: 6, 143: 4 };
const IC_FAMILY = /(soic|sop|ssop|tssop|msop|qfn|dfn|tqfp|lqfp|qfp|bga|plcc|dip|lga|son)/;

// Tra ve { pins, mount: 'SMD' | 'THT' | null, note } ; pins = null khi khong doan duoc
function footprintInfo(packageText, nameText = '') {
    const pkg = String(packageText || '').trim();
    const p = pkg.toLowerCase();
    const all = `${p} ${String(nameText || '').toLowerCase()}`;
    const tht = /(dip|sip|tht|pth|through|radial|axial|to-?220|to-?92|to-?247|to-?3p|do-?41|do-?35|do-?15|do-?201|hc-?49|hdr|header|pinhdr|terminal|screw|jst|molex|idc|socket|dc-?jack|usb-?b)/.test(all)
        && !/(smd|smt)/.test(all);
    let m;

    // Hang rao / dau noi: 1x8, 2x05 -> so chan = hang x cot
    if ((m = all.match(/(?<![\d.])(\d{1,2})\s*x\s*(\d{1,3})(?![\d.])/)) && /(hdr|header|pin|conn|idc|jst|molex|terminal|socket|con\d|xh|ph\b|kf)/.test(all)) {
        return { pins: parseInt(m[1], 10) * parseInt(m[2], 10), mount: /(smd|smt)/.test(all) ? 'SMD' : 'THT', note: 'Đầu nối' };
    }
    // SOT-23-5, SOT23-6 ...
    if ((m = p.match(/sot[-_ ]?23[-_ ]?([3-8])\b/))) return { pins: parseInt(m[1], 10), mount: 'SMD', note: 'SOT' };
    if ((m = p.match(/sot[-_ ]?(\d{2,3})/)) && SOT_PINS[m[1]]) return { pins: SOT_PINS[m[1]], mount: 'SMD', note: 'SOT' };
    // TO-xxx
    if (/to-?(220|92|247|3p|126)/.test(p)) return { pins: 3, mount: 'THT', note: 'TO cắm' };
    if (/(to-?252|to-?263|dpak|d2pak)/.test(p)) return { pins: 3, mount: 'SMD', note: 'TO dán' };
    // Ho IC co so chan trong ten: SOIC-8, LQFP48, DIP-16, QFN32 ...
    if ((m = p.match(/(soic|sop|ssop|tssop|msop|qfn|dfn|tqfp|lqfp|qfp|bga|plcc|dip|sip|lga|son|so)[-_ ]?(\d{1,4})(?!\d*p\d)/))) {
        const dip = m[1] === 'dip' || m[1] === 'sip';
        return { pins: parseInt(m[2], 10), mount: dip ? 'THT' : 'SMD', note: m[1].toUpperCase() };
    }
    // Ten theo chuan IPC-7351: SOIC127P600X175-8N, QFP50P900X900X160-48N -> so chan o cuoi
    if ((m = p.match(/-(\d{1,4})n?$/)) && /p\d{2,}x/.test(p)) return { pins: parseInt(m[1], 10), mount: 'SMD', note: 'IPC' };
    // Linh kien 2 chan dan: 0603, C0805, RESC1608X55N, SOD-123, SMA ...
    if (/(?<![0-9])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)\b/.test(p) || /^(resc|capc|indc|ledc|diom|capm|resm)\d{4}/.test(p)) return { pins: 2, mount: 'SMD', note: 'Chip 2 chân' };
    if (/(sod-?\d+|\bsm[abc]\b|do-?214|melf)/.test(p)) return { pins: 2, mount: 'SMD', note: 'Diode dán' };
    if (/(do-?41|do-?35|do-?15|do-?201|hc-?49|radial|axial|cap-?d\d|cp_radial)/.test(all)) return { pins: 2, mount: 'THT', note: '2 chân cắm' };
    if (tht) return { pins: null, mount: 'THT', note: 'Cắm, chưa rõ số chân' };
    return { pins: null, mount: null, note: pkg ? 'Chưa nhận ra kiểu chân' : 'BOM không ghi kiểu chân' };
}

// rows: [{ name, desc, package, ref, qty }] -> chi tiet tung dong + tong cho 1 board
function estimateAssembly(rows) {
    const totals = { smdPads: 0, thtPads: 0, icCount: 0, smdParts: 0, thtParts: 0, unknownRows: 0, parts: 0 };
    const lines = rows.map((r) => {
        const refs = String(r.ref || '').split(/[\s,;]+/).filter(Boolean);
        const qty = toNum(r.qty) > 0 ? toNum(r.qty) : refs.length; // khong co cot so luong thi dem so vi tri (designator)
        const info = footprintInfo(r.package, `${r.name || ''} ${r.desc || ''}`);
        const isIC = /^(u|ic)\d/i.test(refs[0] || '') || (info.pins >= 8 && IC_FAMILY.test(String(r.package || '').toLowerCase()));
        const line = { name: r.name, package: r.package || '', ref: refs.slice(0, 6).join(', ') + (refs.length > 6 ? '…' : ''), qty, pins: info.pins, mount: info.mount, isIC, note: info.note };

        totals.parts += qty;
        if (info.pins === null || !info.mount) { totals.unknownRows += 1; return line; }
        if (info.mount === 'SMD') { totals.smdPads += info.pins * qty; totals.smdParts += qty; }
        else { totals.thtPads += info.pins * qty; totals.thtParts += qty; }
        if (isIC) totals.icCount += qty;
        return line;
    });
    return { lines, totals };
}

// Gia gia cong 1 loai mach:
//   1 board = diem dan x don gia dan + diem cam x don gia cam + so IC x phu phi IC + phi test
//   tong    = gia 1 board x so luong x (1 + hao hut %) + phi chuan bi (stencil, lap trinh may...)
function priceAssembly(counts, rates, quantity) {
    const c = { smdPads: Math.max(0, Math.round(toNum(counts.smdPads))), thtPads: Math.max(0, Math.round(toNum(counts.thtPads))), icCount: Math.max(0, Math.round(toNum(counts.icCount))) };
    const r = {
        smdPad: Math.max(0, toNum(rates.smdPad)), thtPad: Math.max(0, toNum(rates.thtPad)), ic: Math.max(0, toNum(rates.ic)),
        test: Math.max(0, toNum(rates.test)), setup: Math.max(0, toNum(rates.setup)), lossPercent: Math.min(100, Math.max(0, toNum(rates.lossPercent)))
    };
    const perBoard = c.smdPads * r.smdPad + c.thtPads * r.thtPad + c.icCount * r.ic + r.test;
    const total = Math.round(perBoard * quantity * (1 + r.lossPercent / 100) + r.setup);
    return { counts: c, rates: r, quantity, perBoard: Math.round(perBoard), total };
}

module.exports = { footprintInfo, estimateAssembly, priceAssembly };
