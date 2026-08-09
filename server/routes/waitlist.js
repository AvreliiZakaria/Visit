'use strict';

/**
 * Список ожидания беты. Отдельная таблица, потому что это единственное,
 * что собирается до регистрации, и удаляться должно по одному запросу.
 */

const express = require('express');
const { db } = require('../db');
const { id, now, hash, httpError, wrap } = require('../lib/util');
const { rateLimit } = require('../lib/rate');

const router = express.Router();

db.exec(`
CREATE TABLE IF NOT EXISTS waitlist (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  role       TEXT,
  city       TEXT,
  ip_hash    TEXT,
  created_at INTEGER NOT NULL
);
`);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ROLES = ['spor', 'jury', 'creator', 'other'];

/** Публичный счётчик. Настоящее число, без накрутки для красоты. */
router.get('/count', function (_req, res) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n;
  res.json({ count: n });
});

router.post('/',
  rateLimit({ max: 10, windowMs: 60 * 60 * 1000, scope: 'waitlist' }),
  wrap(function (req, res) {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw httpError(400, 'bad_email', 'Проверь адрес почты.');

    const role = ROLES.indexOf(String(req.body.role)) !== -1 ? String(req.body.role) : 'other';
    const city = String(req.body.city || '').slice(0, 80) || null;

    const exists = db.prepare('SELECT id FROM waitlist WHERE email = ?').get(email);
    if (exists) {
      const n = db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n;
      return res.json({ ok: true, already: true, count: n });
    }

    db.prepare(
      'INSERT INTO waitlist (id, email, role, city, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id(), email, role, city, hash(req.ip), now());

    const n = db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n;
    res.status(201).json({ ok: true, count: n });
  })
);

/** Право быть забытым работает и до регистрации. */
router.delete('/', rateLimit({ max: 20, windowMs: 3600000, scope: 'waitlist_del' }),
  wrap(function (req, res) {
    const email = String(req.body.email || '').trim().toLowerCase();
    db.prepare('DELETE FROM waitlist WHERE email = ?').run(email);
    res.json({ ok: true });
  })
);

module.exports = router;
