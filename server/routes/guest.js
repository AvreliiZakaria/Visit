'use strict';

/* Гостевой ответ: человек по ссылке записывает сторону Б без регистрации. */
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../config');
const { db } = require('../db');
const { id, token, now, httpError, wrap, anonHandle } = require('../lib/util');
const { rateLimit } = require('../lib/rate');
const A = require('../lib/auth');
const court = require('../lib/court');
const moderation = require('../lib/moderation');
const { transcribe } = require('../lib/transcribe');
const events = require('../lib/events');

const router = express.Router();
const ALLOWED = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac'];
const upload = multer({
  storage: multer.diskStorage({
    destination: function (_req, _file, cb) { cb(null, config.uploadDir); },
    filename: function (_req, file, cb) { cb(null, id() + '.' + (file.mimetype.split('/')[1] || 'webm').replace(/[^a-z0-9]/gi, '')); }
  }),
  limits: { fileSize: config.maxAudioBytes, files: 1 },
  fileFilter: function (_req, file, cb) {
    const mime = String(file.mimetype).split(';')[0];
    cb(ALLOWED.includes(mime) ? null : httpError(415, 'bad_audio_type', 'Такой формат записи не принимаем.'), ALLOWED.includes(mime));
  }
});

router.post('/invite/:token/answer', rateLimit({ max: 10, windowMs: 60 * 60 * 1000, scope: 'guest_answer' }), upload.single('audio'), wrap(async function (req, res) {
  const d = db.prepare('SELECT * FROM disputes WHERE invite_token = ?').get(req.params.token);
  if (!d) throw httpError(404, 'not_found', 'Ссылка не работает или дело удалено.');
  if (d.status !== 'awaiting_opponent' || d.opponent_id) throw httpError(409, 'taken', 'На это дело уже ответили или оно закрыто.');
  if (!req.file) throw httpError(400, 'no_audio', 'Запись не пришла.');

  const filePath = path.join(config.uploadDir, req.file.filename);
  const cleanup = function () { fs.promises.unlink(filePath).catch(function () {}); };
  const durationMs = Math.max(0, Math.min(65000, Number(req.body.durationMs) || 0));
  if (durationMs < 10000) { cleanup(); throw httpError(400, 'too_short', 'Меньше 10 секунд: жюри не поймёт сути.'); }

  /* Технический guest-user нужен только для связей в БД. Пароля и сессии у гостя нет. */
  const anon = anonHandle();
  const guest = { id: id(), email: 'guest+' + token(12) + '@verdict.local', password_hash: A.hashPassword(token(24)), handle: anon.handle, emoji: anon.emoji, role: 'user', age_confirmed: 1, created_at: now() };

  const side = { id: id(), dispute_id: d.id, user_id: guest.id, label: 'b', audio_file: req.file.filename, audio_mime: String(req.file.mimetype).split(';')[0], audio_bytes: req.file.size, duration_ms: durationMs, created_at: now() };
  db.transaction(function () {
    const fresh = db.prepare('SELECT * FROM disputes WHERE id = ?').get(d.id);
    if (!fresh || fresh.status !== 'awaiting_opponent' || fresh.opponent_id) throw httpError(409, 'taken', 'На это дело уже ответили.');
    db.prepare('INSERT INTO users (id, email, password_hash, handle, emoji, role, age_confirmed, created_at) VALUES (@id, @email, @password_hash, @handle, @emoji, @role, @age_confirmed, @created_at)').run(guest);
    db.prepare('UPDATE disputes SET opponent_id = ? WHERE id = ?').run(guest.id, d.id);
    db.prepare('INSERT INTO sides (id, dispute_id, user_id, label, audio_file, audio_mime, audio_bytes, duration_ms, created_at) VALUES (@id, @dispute_id, @user_id, @label, @audio_file, @audio_mime, @audio_bytes, @duration_ms, @created_at)').run(side);
  })();
  events.publish(d.id, 'opponent_joined', { at: now() });

  /* Отвечаем сразу, а расшифровка и модерация идут в фоне. */
  res.status(201).json({ ok: true, message: 'Ответ принят. Дело ушло на проверку и затем в жюри.' });
  try {
    const tr = await transcribe(filePath, side.audio_mime);
    const scan = moderation.scan(tr.text, { strict: config.moderationStrict, transcriptAvailable: tr.state === 'done' });
    db.prepare('UPDATE sides SET transcript = ?, transcript_state = ?, moderation_state = ?, moderation_note = ? WHERE id = ?').run(scan.redacted || tr.text || null, tr.state, scan.state, scan.note, side.id);
    if (scan.state === 'blocked') db.prepare("UPDATE disputes SET status = 'blocked' WHERE id = ?").run(d.id);
    else court.openForJury(d.id);
  } catch (err) { console.error('[guest] пост-обработка не удалась:', err.message); }
}));

module.exports = router;
