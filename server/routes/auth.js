'use strict';

const express = require('express');
const config = require('../config');
const { db } = require('../db');
const { id, now, anonHandle, httpError, wrap } = require('../lib/util');
const { rateLimit } = require('../lib/rate');
const A = require('../lib/auth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ---------------------------------------------------------------
   Регистрация. Возраст 17+ подтверждается явно: это требование
   магазинов для контента, где люди ругаются про личную жизнь.
   --------------------------------------------------------------- */
router.post('/register',
  rateLimit({ max: 10, windowMs: 60 * 60 * 1000, scope: 'register' }),
  wrap(function (req, res) {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const ageConfirmed = Boolean(req.body.ageConfirmed);

    if (!EMAIL_RE.test(email)) throw httpError(400, 'bad_email', 'Проверь адрес почты.');
    if (password.length < 8) throw httpError(400, 'weak_password', 'Пароль от 8 символов.');
    if (!ageConfirmed) throw httpError(400, 'age_required', 'Нужно подтвердить, что тебе 17 или больше.');

    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) throw httpError(409, 'email_taken', 'Такая почта уже зарегистрирована.');

    const anon = anonHandle();
    const role = config.adminEmail && config.adminEmail === email ? 'admin' : 'user';
    const user = {
      id: id(),
      email: email,
      password_hash: A.hashPassword(password),
      handle: anon.handle,
      emoji: anon.emoji,
      role: role,
      age_confirmed: 1,
      created_at: now()
    };

    db.prepare(
      'INSERT INTO users (id, email, password_hash, handle, emoji, role, age_confirmed, created_at) ' +
      'VALUES (@id, @email, @password_hash, @handle, @emoji, @role, @age_confirmed, @created_at)'
    ).run(user);

    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    A.issueSession(res, fresh);
    res.status(201).json({ user: A.publicUser(fresh) });
  })
);

/* --------------------------------------------------------------- */
router.post('/login',
  rateLimit({ max: 20, windowMs: 15 * 60 * 1000, scope: 'login' }),
  wrap(function (req, res) {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const user = db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL').get(email);
    /* Одинаковый ответ на неверную почту и неверный пароль: не подсказываем, кто зарегистрирован. */
    if (!user || !A.checkPassword(password, user.password_hash)) {
      throw httpError(401, 'bad_credentials', 'Почта или пароль не подходят.');
    }

    A.issueSession(res, user);
    res.json({ user: A.publicUser(user) });
  })
);

router.post('/logout', function (req, res) {
  A.clearSession(res);
  res.json({ ok: true });
});

router.get('/me', function (req, res) {
  if (!req.user) return res.json({ user: null });

  const stats = db.prepare(
    'SELECT' +
    " (SELECT COUNT(*) FROM disputes d JOIN verdicts v ON v.dispute_id = d.id" +
    "    JOIN sides s ON s.dispute_id = d.id AND s.user_id = ?" +
    "    WHERE v.winner = s.label) AS wins," +
    " (SELECT COUNT(*) FROM disputes d JOIN verdicts v ON v.dispute_id = d.id" +
    "    JOIN sides s ON s.dispute_id = d.id AND s.user_id = ?" +
    "    WHERE v.winner != 'tie' AND v.winner != s.label) AS losses," +
    ' (SELECT COUNT(*) FROM votes WHERE juror_id = ?) AS judged'
  ).get(req.user.id, req.user.id, req.user.id);

  const badges = db.prepare(
    'SELECT kind, label, expires_at, created_at FROM badges WHERE user_id = ? ' +
    'AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC'
  ).all(req.user.id, now());

  res.json({ user: A.publicUser(req.user), stats: stats, badges: badges });
});

/* ---------------------------------------------------------------
   Право на удаление. Всё связанное уходит каскадом, аудио с диска
   чистит фоновая задача по осиротевшим файлам.
   --------------------------------------------------------------- */
router.delete('/me', A.requireUser, wrap(function (req, res) {
  const t = now();
  db.prepare(
    "UPDATE users SET deleted_at = ?, email = 'deleted+' || id || '@verdict.local', " +
    "password_hash = '', handle = 'Удалённый аккаунт', emoji = '⚰️' WHERE id = ?"
  ).run(t, req.user.id);
  db.prepare('DELETE FROM sides WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM votes WHERE juror_id = ?').run(req.user.id);
  db.prepare('UPDATE comments SET hidden = 1 WHERE juror_id = ?').run(req.user.id);
  A.clearSession(res);
  res.json({ ok: true, deletedAt: t });
}));

module.exports = router;
