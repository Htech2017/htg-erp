// Bam mat khau bang scrypt (co san trong Node, khong can cai them thu vien).
const crypto = require('crypto');

const PREFIX = 'scrypt$';

function isHashed(stored) {
    return typeof stored === 'string' && stored.startsWith(PREFIX);
}

function hashPassword(plain) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(plain), salt, 64).toString('hex');
    return `${PREFIX}${salt}$${hash}`;
}

function verifyPassword(plain, stored) {
    if (!isHashed(stored) || plain === undefined || plain === null) return false;
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const expected = Buffer.from(parts[2], 'hex');
    const actual = crypto.scryptSync(String(plain), parts[1], 64);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = { isHashed, hashPassword, verifyPassword };
