// Dem pad tu file san xuat cua mach (chinh xac hon dem tren anh):
//   - File khoan Excellon (.drl / .txt / .xln): moi toa do = 1 lo khoan, gom theo duong kinh mui khoan
//   - Lop kem han (paste: .gtp / .gbp / *F_Paste* / *B_Paste*): moi lan "flash" (D03) = 1 pad dan
const XLSX = require('xlsx');

const isZip = (buf) => buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;

// Giai nen .zip (dung bo doc zip co san trong thu vien xlsx) -> [{ name, text }]
function unzip(buffer) {
    const cfb = XLSX.CFB.read(buffer, { type: 'buffer' });
    const out = [];
    cfb.FileIndex.forEach((f, i) => {
        if (!f.content || !f.size || f.size > 20 * 1024 * 1024) return;
        const fullPath = cfb.FullPaths[i] || f.name;
        if (/Sh33tJ5/.test(fullPath)) return;
        out.push({ name: fullPath.replace(/^Root Entry\//, ''), text: Buffer.from(f.content).toString('latin1') });
    });
    return out;
}

function classify(name, text) {
    const n = name.toLowerCase();
    const head = text.slice(0, 2000);
    const isExcellon = /^\s*M48/m.test(head) || (/\bT\d+C[\d.]+/.test(head) && !/%FS/.test(head));
    if (isExcellon) return { kind: 'drill', plated: !/npth|non[-_ ]?plated/.test(n) };
    if (!/%FS|G04|%MO/.test(head)) return null;
    const paste = /\.(gtp|gbp|crc|crs|spt|spb|pmc|pms)$/.test(n) || /paste|kem|stencil/.test(n);
    if (!paste) return null;
    const bottom = /\.(gbp|crs|spb|pms)$/.test(n) || /(b[._-]?paste|bottom|bot[._-]|_b\.|back)/.test(n);
    return { kind: 'paste', side: bottom ? 'bottom' : 'top' };
}

// File khoan -> [{ diameter (mm), count }]
function parseDrill(text) {
    let unit = /INCH/i.test(text.slice(0, 3000)) || /\bM72\b/.test(text) ? 25.4 : 1;
    const tools = new Map();   // ma mui khoan -> duong kinh mm
    const counts = new Map();
    let current = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(';')) continue;
        if (/^METRIC/i.test(line) || line === 'M71') unit = 1;
        else if (/^INCH/i.test(line) || line === 'M72') unit = 25.4;
        let m;
        if ((m = line.match(/^T(\d+).*?C([\d.]+)/))) { tools.set(parseInt(m[1], 10), parseFloat(m[2]) * unit); continue; }
        if ((m = line.match(/^T(\d+)\s*$/))) { current = parseInt(m[1], 10); continue; }
        // Lo khoan: dong co toa do X / Y (bo qua lenh phay ranh G00 / G01 / G85)
        if (current && /^[XY][-+\d.]/.test(line) && !/G0[0-3]|G85/.test(line)) counts.set(current, (counts.get(current) || 0) + 1);
    }
    return [...counts.entries()]
        .map(([tool, count]) => ({ diameter: Math.round((tools.get(tool) || 0) * 1000) / 1000, count }))
        .sort((a, b) => a.diameter - b.diameter);
}

// Lop paste -> so pad (flash D03 + vung to G36 cho pad hinh dang rieng)
function parsePaste(text) {
    let op = 0, flashes = 0, regions = 0, inRegion = false;
    for (const block of text.split('*')) {
        const b = block.trim();
        if (!b || b.startsWith('%') || b.startsWith('G04')) continue;
        if (b.includes('G36')) { inRegion = true; regions += 1; continue; }
        if (b.includes('G37')) { inRegion = false; continue; }
        const m = b.match(/D0?([123])$/);
        if (m) op = parseInt(m[1], 10);
        if (!inRegion && op === 3 && (/[XY]/.test(b) || m)) flashes += 1; // D03 co tinh "nho lenh": dong toa do sau do van la flash
    }
    return { flashes, regions, pads: flashes + regions };
}

// files: [{ name, buffer }] (co the la .zip) -> ket qua dem
function analyze(files) {
    const entries = [];
    for (const f of files) {
        if (isZip(f.buffer)) entries.push(...unzip(f.buffer));
        else entries.push({ name: f.name, text: f.buffer.toString('latin1') });
    }
    const result = { drillFiles: [], pasteFiles: [], holes: [], smdTop: 0, smdBottom: 0, ignored: [] };
    const holeMap = new Map();
    for (const e of entries) {
        const type = classify(e.name, e.text);
        if (!type) { result.ignored.push(e.name); continue; }
        if (type.kind === 'drill') {
            const tools = parseDrill(e.text);
            result.drillFiles.push({ name: e.name, plated: type.plated, holes: tools.reduce((s, t) => s + t.count, 0) });
            if (!type.plated) continue; // lo khong ma (bat oc, dinh vi) khong tinh la diem han
            for (const t of tools) holeMap.set(t.diameter, (holeMap.get(t.diameter) || 0) + t.count);
        } else {
            const p = parsePaste(e.text);
            result.pasteFiles.push({ name: e.name, side: type.side, pads: p.pads });
            if (type.side === 'bottom') result.smdBottom += p.pads; else result.smdTop += p.pads;
        }
    }
    result.holes = [...holeMap.entries()].map(([diameter, count]) => ({ diameter, count })).sort((a, b) => a.diameter - b.diameter);
    return result;
}

module.exports = { analyze, parseDrill, parsePaste };
