// Luu phien dang nhap vao SQLite de khong bi dang xuat moi lan khoi dong lai server.
const session = require('express-session');

class SqliteStore extends session.Store {
    constructor(db) {
        super();
        this.db = db;
        const timer = setInterval(() => {
            db.run('DELETE FROM sessions WHERE expires < ?', [Date.now()], () => {});
        }, 60 * 60 * 1000);
        timer.unref();
    }

    get(sid, cb) {
        this.db.get('SELECT sess, expires FROM sessions WHERE sid = ?', [sid], (err, row) => {
            if (err) return cb(err);
            if (!row || row.expires < Date.now()) return cb(null, null);
            try { cb(null, JSON.parse(row.sess)); } catch (e) { cb(null, null); }
        });
    }

    set(sid, sess, cb) {
        const expires = sess.cookie && sess.cookie.expires
            ? new Date(sess.cookie.expires).getTime()
            : Date.now() + 24 * 60 * 60 * 1000;
        const uid = sess.user ? sess.user.id : null;
        this.db.run(
            `INSERT INTO sessions (sid, sess, expires, uid) VALUES (?, ?, ?, ?)
             ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires, uid = excluded.uid`,
            [sid, JSON.stringify(sess), expires, uid],
            (err) => cb && cb(err)
        );
    }

    destroy(sid, cb) {
        this.db.run('DELETE FROM sessions WHERE sid = ?', [sid], (err) => cb && cb(err));
    }
}

module.exports = SqliteStore;
