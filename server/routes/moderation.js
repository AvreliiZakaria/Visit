'use strict';

/**
 * Жалобы и разбор. Первые месяцы разбирать придётся руками:
 * автоматика ловит персональные данные и угрозы, но не ловит контекст.
 */

const express = require('express');
const { db } = require('../db');
const { id, now, httpError, wrap } = require('../lib/util');
const { rateLimit } = require('../lib/rate');
const A = require('../lib/auth');

const router = express.Router();

const REASONS = ['doxxing', 'harassment', 'nsfw', 'minor', 'thirdparty_data', 'spam', 'other'];

/** Пожаловаться может любой авторизованный. Кнопка есть на каждом экране. */
router.post('/reports',
  A.requireUser,
  rateLimit({ max: 30, windowMs: 60 * 60 * 1000, scope: 'report' }),
  wrap(function (req, res) {
    const targetType = String(req.body.targetType || '');
    const targetId = String(req.body.targetId || '');
    const reason = String(req.body.reason || '');

    if (['dispute', 'comment', 'side'].indexOf(targetType) === -1) {
      throw httpError(400, 'bad_target', 'Непонятно, на что жалоба.');
    }
    if (REASONS.indexOf(reason) === -1) {
      throw httpError(400, 'bad_reason', 'Выбери причину из списка.');
    }

    const table = targetType === 'dispute' ? 'disputes' : targetType === 'comment' ? 'comments' : 'sides';
    const exists = db.prepare('SELECT id FROM ' + table + ' WHERE id = ?').get(targetId);
    if (!exists) throw httpError(404, 'not_found', 'Объект жалобы не найден.');

    db.prepare(
      'INSERT INTO reports (id, target_type, target_id, reporter_id, reason, detail, state, created_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(id(), targetType, targetId, req.user.id, reason,
      String(req.body.detail || '').slice(0, 500), 'open', now());

    /* Три независимые жалобы снимают дело с фида до разбора. */
    if (targetType === 'dispute') {
      const n = db.prepare(
        "SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE target_type = 'dispute' " +
        "AND target_id = ? AND state = 'open'"
      ).get(targetId).n;
      if (n >= 3) {
        db.prepare("UPDATE disputes SET status = 'held' WHERE id = ? AND status = 'in_jury'").run(targetId);
      }
    }

    res.status(201).json({ ok: true, message: 'Жалоба принята, разберём.' });
  })
);

/* ---------------- очередь модератора ---------------- */
router.get('/queue', A.requireRole('moderator', 'admin'), wrap(function (_req, res) {
  const reports = db.prepare(
    "SELECT * FROM reports WHERE state = 'open' ORDER BY created_at ASC LIMIT 100"
  ).all();

  const held = db.prepare(
    "SELECT d.id, d.public_no, d.topic, d.status, d.created_at FROM disputes d " +
    "WHERE d.status IN ('held', 'blocked') ORDER BY d.created_at ASC LIMIT 100"
  ).all();

  const flaggedSides = db.prepare(
    "SELECT s.id, s.dispute_id, s.label, s.moderation_state, s.moderation_note, s.transcript " +
    "FROM sides s WHERE s.moderation_state IN ('flagged','blocked') ORDER BY s.created_at ASC LIMIT 100"
  ).all();

  res.json({ reports: reports, heldDisputes: held, flaggedSides: flaggedSides });
}));

router.post('/reports/:id/resolve', A.requireRole('moderator', 'admin'), wrap(function (req, res) {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r) throw httpError(404, 'not_found', 'Жалоба не найдена.');

  const uphold = Boolean(req.body.uphold);
  const t = now();

  db.prepare('UPDATE reports SET state = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
    .run(uphold ? 'upheld' : 'rejected', req.user.id, t, r.id);

  if (uphold) {
    if (r.target_type === 'comment') {
      db.prepare('UPDATE comments SET hidden = 1 WHERE id = ?').run(r.target_id);
    }
    if (r.target_type === 'dispute') {
      db.prepare("UPDATE disputes SET status = 'blocked' WHERE id = ?").run(r.target_id);
    }
    if (r.target_type === 'side') {
      const s = db.prepare('SELECT * FROM sides WHERE id = ?').get(r.target_id);
      if (s) {
        db.prepare("UPDATE sides SET moderation_state = 'blocked' WHERE id = ?").run(s.id);
        db.prepare("UPDATE disputes SET status = 'blocked' WHERE id = ?").run(s.dispute_id);
      }
    }
  } else if (r.target_type === 'dispute') {
    db.prepare("UPDATE disputes SET status = 'in_jury' WHERE id = ? AND status = 'held'").run(r.target_id);
  }

  db.prepare(
    'INSERT INTO audit_log (id, actor_id, action, subject, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id(), req.user.id, uphold ? 'report_upheld' : 'report_rejected', r.id,
    JSON.stringify({ targetType: r.target_type, targetId: r.target_id }), t);

  res.json({ ok: true });
}));

/** Ручное решение по задержанной записи: пропустить или заблокировать. */
router.post('/sides/:id/review', A.requireRole('moderator', 'admin'), wrap(function (req, res) {
  const s = db.prepare('SELECT * FROM sides WHERE id = ?').get(req.params.id);
  if (!s) throw httpError(404, 'not_found', 'Запись не найдена.');

  const allow = Boolean(req.body.allow);
  db.prepare('UPDATE sides SET moderation_state = ?, moderation_note = ? WHERE id = ?')
    .run(allow ? 'clean' : 'blocked', String(req.body.note || '').slice(0, 300), s.id);

  const court = require('../lib/court');
  const status = allow
    ? court.openForJury(s.dispute_id)
    : (db.prepare("UPDATE disputes SET status = 'blocked' WHERE id = ?").run(s.dispute_id), 'blocked');

  db.prepare(
    'INSERT INTO audit_log (id, actor_id, action, subject, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id(), req.user.id, allow ? 'side_allowed' : 'side_blocked', s.id, null, now());

  res.json({ ok: true, disputeStatus: status });
}));

/** Бан. Срок в днях, ноль означает снятие. */
router.post('/users/:id/ban', A.requireRole('admin'), wrap(function (req, res) {
  const days = Number(req.body.days);
  if (!Number.isFinite(days) || days < 0) throw httpError(400, 'bad_days', 'Укажи срок в днях.');

  const until = days === 0 ? null : now() + days * 24 * 3600000;
  db.prepare('UPDATE users SET banned_until = ? WHERE id = ?').run(until, req.params.id);

  db.prepare(
    'INSERT INTO audit_log (id, actor_id, action, subject, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id(), req.user.id, days === 0 ? 'unban' : 'ban', req.params.id,
    JSON.stringify({ days: days, reason: String(req.body.reason || '') }), now());

  res.json({ ok: true, bannedUntil: until });
}));

module.exports = router;
