// So khop ten linh kien cua khach voi ma hang trong kho.
// Cung 1 linh kien moi khach goi 1 kieu ("100nF", "0.1uF", "tụ 104") -> quy ve cung 1 "khoa thong so":
//   loai (C / R / L) + gia tri quy ve don vi chuan (F / Ohm / H). 100nF = 0.1uF = ma 104 = 1.000e-7 F.
// Thu tu uu tien khi so khop:
//   1. Ten goi da ghi nho (alias)      2. Trung ma hang / ma nha san xuat
//   3. Trung thong so (+ kieu chan)    4. Ten gan giong

const PACKAGE_RE = /(?<![0-9])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512)\b|\b(sot|sod|soic|sop|ssop|tssop|msop|qfn|dfn|tqfp|lqfp|qfp|bga|dip|to|sma|smb|smc)[-_ ]?(\d+[a-z]?)\b/i;

function stripDiacritics(s) {
    return String(s === null || s === undefined ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}
// Dang chuan de so sanh ten goi: bo dau, chu thuong, bo khoang trang va ky tu dac biet. "Tụ 104" -> "tu104"
function normalizeText(s) {
    return stripDiacritics(s).toLowerCase().replace(/[µμ]/g, 'u').replace(/[^a-z0-9.]/g, '');
}
function tokens(s) {
    return stripDiacritics(s).toLowerCase().replace(/[µμ]/g, 'u').split(/[^a-z0-9.]+/).filter((t) => t.length > 1);
}

function parsePackage(text) {
    const m = String(text || '').match(PACKAGE_RE);
    if (!m) return null;
    return m[1] ? m[1] : `${m[2].toUpperCase()}-${m[3].toUpperCase()}`;
}
function parseVoltage(text) {
    const m = String(text || '').replace(/,/g, '.').match(/(\d+(?:\.\d+)?)\s*v(?:dc|ac)?\b/i);
    return m ? parseFloat(m[1]) : null;
}

const SMALL = { p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3 };

// Tra ve { kind: 'C' | 'R' | 'L', value } hoac null neu khong doc duoc thong so
function parseSpec(raw) {
    if (!raw) return null;
    const original = stripDiacritics(raw).replace(/[µμ]/g, 'u').replace(/(\d),(\d)/g, '$1.$2');
    // bo kieu chan va dien ap de khong nham voi gia tri (0603, 50V...)
    const text = original.replace(new RegExp(PACKAGE_RE.source, 'gi'), ' ').replace(/\d+(?:\.\d+)?\s*v(?:dc|ac)?\b/gi, ' ');
    const lower = text.toLowerCase();

    const hintC = /\b(tu|cap|capacitor|mlcc|ceramic|tantalum|c\d*)\b/.test(lower);
    const hintR = /\b(dien tro|tro|res|resistor|r\d*)\b|ohm|Ω/.test(lower) || /Ω/.test(raw);
    const hintL = /\b(cuon cam|inductor|l\d+)\b/.test(lower);
    let m;

    // --- Tu dien: 100nF, 0.1 uF, 4u7, 100n ---
    if ((m = lower.match(/(\d+(?:\.\d+)?)\s*([pnu])f\b/))) return { kind: 'C', value: parseFloat(m[1]) * SMALL[m[2]] };
    if ((m = lower.match(/\b(\d+)([pnu])(\d)f?\b/)) && !hintR && !hintL) return { kind: 'C', value: parseFloat(`${m[1]}.${m[3]}`) * SMALL[m[2]] };
    // --- Cuon cam: 10uH, 4.7 mH ---
    if ((m = lower.match(/(\d+(?:\.\d+)?)\s*([num])h\b/))) return { kind: 'L', value: parseFloat(m[1]) * SMALL[m[2]] };
    // --- Dien tro: 10k, 4k7, 4.7K, 1M, 100R, 4R7, 100 ohm ---
    if ((m = text.match(/\b(\d+)([kKMR])(\d{1,2})\b/)) && !hintC) {
        const mult = { k: 1e3, K: 1e3, M: 1e6, R: 1 }[m[2]];
        return { kind: 'R', value: parseFloat(`${m[1]}.${m[3]}`) * mult };
    }
    if ((m = text.match(/(\d+(?:\.\d+)?)\s*([kK]|M|R)(?:\s*(?:ohm|Ω))?\b/)) && !hintC) {
        return { kind: 'R', value: parseFloat(m[1]) * { k: 1e3, K: 1e3, M: 1e6, R: 1 }[m[2]] };
    }
    if ((m = lower.match(/(\d+(?:\.\d+)?)\s*(?:ohm|Ω)/))) return { kind: 'R', value: parseFloat(m[1]) };
    if ((m = lower.match(/\b(\d+(?:\.\d+)?)\s*([pnu])\b/)) && !hintR && !hintL) return { kind: 'C', value: parseFloat(m[1]) * SMALL[m[2]] };

    // --- Ma 3 / 4 chu so: "tụ 104" = 10 x 10^4 pF, "điện trở 472" = 47 x 10^2 Ohm (chi khi biet loai linh kien) ---
    if (hintC && (m = lower.match(/\b(\d{2})(\d)\b/))) return { kind: 'C', value: parseInt(m[1], 10) * Math.pow(10, parseInt(m[2], 10)) * 1e-12 };
    if (hintR && (m = lower.match(/\b(\d{2,3})(\d)\b/))) return { kind: 'R', value: parseInt(m[1], 10) * Math.pow(10, parseInt(m[2], 10)) };
    return null;
}
const specKey = (spec) => (spec ? `${spec.kind}:${spec.value.toExponential(3)}` : null);

// Hien thi gia tri theo cach doc quen thuoc: 1e-7 F -> "100nF"
function formatSpec(spec) {
    if (!spec) return '';
    const units = spec.kind === 'R'
        ? [[1e6, 'MΩ'], [1e3, 'kΩ'], [1, 'Ω']]
        : [[1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p']];
    const suffix = spec.kind === 'C' ? 'F' : spec.kind === 'L' ? 'H' : '';
    for (const [mult, label] of units) {
        if (spec.value >= mult || mult === units[units.length - 1][0]) return `${parseFloat((spec.value / mult).toPrecision(4))}${label}${suffix}`;
    }
    return '';
}

// Chuan bi du lieu kho 1 lan cho nhieu dong BOM
function buildIndex(items, aliases) {
    const aliasByItem = new Map();
    for (const a of aliases) {
        if (!aliasByItem.has(a.itemId)) aliasByItem.set(a.itemId, []);
        aliasByItem.get(a.itemId).push(a);
    }
    return items.map((item) => {
        const itemAliases = aliasByItem.get(item.id) || [];
        const texts = [item.itemName, item.description, ...itemAliases.map((a) => a.alias)].filter(Boolean);
        const specs = new Set(texts.map((t) => specKey(parseSpec(t))).filter(Boolean));
        const all = [item.itemCode, item.itemName, item.description, item.mpn, item.package].filter(Boolean).join(' ');
        return {
            item, specs,
            aliasNorms: new Map(itemAliases.map((a) => [a.aliasNorm, a])),
            codeNorms: new Set([item.itemCode, item.mpn].filter(Boolean).map(normalizeText)),
            nameNorm: normalizeText(item.itemName),
            pkg: parsePackage(item.package) || parsePackage(all),
            voltage: parseVoltage(all),
            tokenSet: new Set(tokens(all))
        };
    });
}

// row: { name, desc, mpn, package } -> toi da 3 ung vien [{ itemId, score, reason }]
function matchRow(row, index, maKH) {
    const text = [row.name, row.desc].filter(Boolean).join(' ');
    const nameNorm = normalizeText(row.name);
    const mpnNorm = normalizeText(row.mpn);
    const spec = parseSpec(text);
    const key = specKey(spec);
    const pkg = parsePackage(row.package) || parsePackage(text);
    const voltage = parseVoltage(text);
    const rowTokens = new Set(tokens(text));

    const out = [];
    for (const e of index) {
        let score = 0;
        let reason = '';
        const alias = nameNorm && e.aliasNorms.get(nameNorm);
        if (alias) {
            score = alias.maKH && maKH && alias.maKH === maKH ? 100 : 98;
            reason = 'Tên gọi đã ghi nhớ';
            // Ten goi chi noi gia tri ("tụ 104") nhung BOM ghi kieu chan khac ma hang -> khong tu nhan
            if (pkg && e.pkg && pkg !== e.pkg) { score = 45; reason += `, nhưng KHÁC kiểu chân (${pkg} ≠ ${e.pkg})`; }
        } else if ((mpnNorm && e.codeNorms.has(mpnNorm)) || (nameNorm && e.codeNorms.has(nameNorm))) {
            score = 97; reason = 'Trùng mã hàng / mã NSX';
        } else if (nameNorm && nameNorm === e.nameNorm) {
            score = 96; reason = 'Trùng tên';
        } else if (key && e.specs.has(key)) {
            score = 75; reason = `Cùng thông số ${formatSpec(spec)}`;
            if (pkg && e.pkg) {
                if (pkg === e.pkg) { score += 20; reason += `, cùng kiểu chân ${pkg}`; }
                else { score = 40; reason += `, KHÁC kiểu chân (${pkg} ≠ ${e.pkg})`; }
            } else {
                reason += ', chưa rõ kiểu chân';
            }
            if (voltage && e.voltage && voltage !== e.voltage) { score -= 15; reason += `, khác điện áp (${voltage}V ≠ ${e.voltage}V)`; }
        } else if (rowTokens.size) {
            let common = 0;
            for (const t of rowTokens) if (e.tokenSet.has(t)) common += 1;
            const jaccard = common / (rowTokens.size + e.tokenSet.size - common);
            if (jaccard >= 0.4) { score = Math.round(40 + 30 * jaccard); reason = 'Tên gần giống'; }
        }
        if (score >= 40) out.push({ itemId: e.item.id, score, reason });
    }
    out.sort((a, b) => b.score - a.score);
    return { spec: spec ? formatSpec(spec) : null, package: pkg, candidates: out.slice(0, 3) };
}

module.exports = { normalizeText, parseSpec, specKey, formatSpec, parsePackage, parseVoltage, buildIndex, matchRow };
