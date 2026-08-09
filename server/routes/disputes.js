'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const config = require('../config');
const { db, nextDisputeNo } = require('../db');
const { id, token, now, httpError, wrap, clamp } = require('../lib/util');
const { rateLimit } = require('../lib/rate');
const A = require('../lib/auth');
const court = require('../lib/court');
const moderation = require('../lib/moderation');
const { transcribe } = require('../lib/transcribe');
const events = require('../lib/events');

const router = express.Router();

/* ---------------------------------------------------------------
   Приём аудио. 60 секунд речи в opus это меньше мегабайта,
   лимит из конфига оставляет запас и режет попытки залить кино.
   --------------------------------------------------------------- */
const ALLOWED_MIME = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/aac'];

const upload = multer({
  storage: multer.diskStorage({
    destination: function (_req, _file, cb) { cb(null, config.uploadDir); },
    filename: function (_req, file, cb) {
      const ext = (file.mimetype.split('/')[1] || 'webm').replace(/[^a-z0-9]/gi, '');
      cb(null, id() + '.' + ext);
    }
  }),
  limits: { fileSize: config.maxAudioBytes, files: 1 },
  fileFilter: function (_req, file, cb) {
    const base = String(file.mimetype).split(';')[0].trim();
    if (ALLOWED_MIME.indexOf(base) === -1) {
      return cb(httpError(415, 'bad_audio_type', 'Такой формат записи не принимаем.'));
    }
    cb(null, true);
  }
});

function disputeById(disputeId) {
  return db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId);
}
function sidesOf(disputeId) {
  return db.prepare('SELECT * FROM sides WHERE dispute_id = ? ORDER BY label').all(disputeId);
}
function isParty(dispute, userId) {
  return dispute.creator_id === userId || dispute.opponent_id === userId;
}

/** Что отдаём наружу. Транскрипты и пути к файлам не показываем никогда. */
function viewDispute(d, opts) {
  const o = opts || {};
  const sides = sidesOf(d.id);
  const verdict = db.prepare('SELECT * FROM verdicts WHERE dispute_id = ?').get(d.id);

  const out = {
    id: d.id,
    no: d.public_no,
    topic: d.topic,
    status: d.status,
    tier: d.tier,
    oneSided: Boolean(d.one_sided),
    consentContent: Boolean(d.consent_content),
    createdAt: d.created_at,
    opponentDeadline: d.opponent_deadline,
    remindersSent: d.reminders_sent,
    inviteUrl: o.includeInvite ? config.publicUrl + '/join.html?t=' + d.invite_token : undefined,
    sides: sides.map(function (s) {
      return {
        label: s.label,
        durationMs: s.duration_ms,
        audioUrl: '/api/disputes/' + d.id + '/audio/' + s.label,
        moderationState: s.moderation_state,
        recordedAt: s.created_at
      };
    }),
    quorum: court.quorumState(d.id)
  };

  /* Проценты появляются только вместе с вердиктом. До этого их нет ни для кого. */
  if (verdict) {
    out.verdict = {
      pctA: verdict.pct_a,
      pctB: verdict.pct_b,
      winner: verdict.winner,
      totalVotes: verdict.total_votes,
      issuedAt: verdict.issued_at,
      topComments: court.topComments(d.id)
    };
  }
  return out;
}

/* ===============================================================
   Создание дела
   =============================================================== */
router.post('/',
  A.requireUser,
  rateLimit({ max: 20, windowMs: 60 * 60 * 1000, scope: 'create_dispute' }),
  wrap(function (req, res) {
    const topic = String(req.body.topic || '').replace(/\s+/g, ' ').trim();
    if (topic.length < 8) throw httpError(400, 'topic_short', 'Опиши спор одним предложением, хотя бы 8 символов.');
    if (topic.length > 90) throw httpError(400, 'topic_long', 'Тема длиннее 90 символов, сократи.');

    const consent = Boolean(req.body.consentContent);
    const t = now();

    const dispute = {
      id: id(),
      public_no: nextDisputeNo(),
      topic: topic,
      creator_id: req.user.id,
      invite_token: token(12),
      tier: 'free',
      consent_content: consent ? 1 : 0,
      status: 'awaiting_opponent',
      target_jury: court.targetFor('free'),
      min_quorum: config.jury.minQuorum,
      opponent_deadline: t + config.deadlines.opponentWindowHours * 3600000,
      created_at: t
    };

    db.prepare(
      'INSERT INTO disputes (id, public_no, topic, creator_id, invite_token, tier, consent_content, ' +
      'status, target_jury, min_quorum, opponent_deadline, created_at) VALUES ' +
      '(@id, @public_no, @topic, @creator_id, @invite_token, @tier, @consent_content, ' +
      '@status, @target_jury, @min_quorum, @opponent_deadline, @created_at)'
    ).run(dispute);

    res.status(201).json({ dispute: viewDispute(disputeById(dispute.id), { includeInvite: true }) });
  })
);

/* ===============================================================
   Загрузка записи стороны. Ставит модерацию в очередь.
   =============================================================== */
router.post('/:id/sides',
  A.requireUser,
  rateLimit({ max: 40, windowMs: 60 * 60 * 1000, scope: 'upload_audio' }),
  upload.single('audio'),
  wrap(async function (req, res) {
    const d = disputeById(req.params.id);
    if (!d) throw httpError(404, 'not_found', 'Дело не найдено.');
    if (!req.file) throw httpError(400, 'no_audio', 'Запись не пришла.');

    const cleanup = function () {
      fs.promises.unlink(path.join(config.uploadDir, req.file.filename)).catch(function () {});
    };

    if (['verdict', 'expired', 'blocked', 'abandoned'].indexOf(d.status) !== -1) {
      cleanup();
      throw httpError(409, 'closed', 'Дело уже закрыто.');
    }

    /* Кто и на какой стороне. Автор всегда А, вторая сторона всегда Б. */
    let label;
    if (d.creator_id === req.user.id) {
      label = 'a';
    } else if (d.opponent_id === req.user.id) {
      label = 'b';
    } else {
      cleanup();
      throw httpError(403, 'not_a_party', 'Ты не сторона этого дела.');
    }

    const already = db.prepare('SELECT id FROM sides WHERE dispute_id = ? AND label = ?').get(d.id, label);
    if (already) {
      cleanup();
      throw httpError(409, 'already_recorded', 'Твоя запись уже есть. Перезапись после отправки запрещена.');
    }

    const durationMs = clamp(Number(req.body.durationMs) || 0, 0, 65000);
    if (durationMs < 10000) {
      cleanup();
      throw httpError(400, 'too_short', 'Меньше 10 секунд: жюри не поймёт сути.');
    }

    const side = {
      id: id(),
      dispute_id: d.id,
      user_id: req.user.id,
      label: label,
      audio_file: req.file.filename,
      audio_mime: String(req.file.mimetype).split(';')[0].trim(),
      audio_bytes: req.file.size,
      duration_ms: durationMs,
      created_at: now()
    };

    db.prepare(
      'INSERT INTO sides (id, dispute_id, user_id, label, audio_file, audio_mime, audio_bytes, ' +
      'duration_ms, created_at) VALUES (@id, @dispute_id, @user_id, @label, @audio_file, @audio_mime, ' +
      '@audio_bytes, @duration_ms, @created_at)'
    ).run(side);

    /* Транскрибация и модерация. Пользователь не ждёт ответа сети. */
    res.status(201).json({
      side: { label: label, durationMs: durationMs, moderationState: 'pending' },
      dispute: viewDispute(disputeById(d.id), { includeInvite: isParty(d, req.user.id) })
    });

    try {
      const abs = path.join(config.uploadDir, side.audio_file);
      const tr = await transcribe(abs, side.audio_mime);
      const verdictOfScan = moderation.scan(tr.text, {
        strict: config.moderationStrict,
        transcriptAvailable: tr.state === 'done'
      });

      db.prepare(
        'UPDATE sides SET transcript = ?, transcript_state = ?, moderation_state = ?, moderation_note = ? WHERE id = ?'
      ).run(
        verdictOfScan.redacted || tr.text || null,
        tr.state,
        verdictOfScan.state,
        verdictOfScan.note,
        side.id
      );

      if (verdictOfScan.state === 'blocked') {
        db.prepare(
          'INSERT INTO reports (id, target_type, target_id, reporter_id, reason, detail, state, created_at) ' +
          'VALUES (?, ?, ?, NULL, ?, ?, ?, ?)'
        ).run(id(), 'side', side.id, 'automod', verdictOfScan.note || '', 'open', now());
      }

      const fresh = disputeById(d.id);
      const bothIn = sidesOf(d.id).length === 2;
      if (bothIn || fresh.one_sided) court.openForJury(d.id);
    } catch (err) {
      console.error('[sides] пост-обработка не удалась:', err.message);
    }
  })
);

/* ===============================================================
   Присоединение второй стороны по ссылке
   =============================================================== */
router.get('/invite/:token', wrap(function (req, res) {
  const d = db.prepare('SELECT * FROM disputes WHERE invite_token = ?').get(req.params.token);
  if (!d) throw httpError(404, 'not_found', 'Ссылка не работает или дело удалено.');

  const sideA = db.prepare("SELECT duration_ms FROM sides WHERE dispute_id = ? AND label = 'a'").get(d.id);
  res.json({
    dispute: {
      id: d.id,
      no: d.public_no,
      topic: d.topic,
      status: d.status,
      opponentDeadline: d.opponent_deadline,
      sideARecorded: Boolean(sideA),
      sideADurationMs: sideA ? sideA.duration_ms : null,
      taken: Boolean(d.opponent_id)
    }
  });
}));

router.post('/invite/:token/accept', A.requireUser, wrap(function (req, res) {
  const d = db.prepare('SELECT * FROM disputes WHERE invite_token = ?').get(req.params.token);
  if (!d) throw httpError(404, 'not_found', 'Ссылка не работает.');
  if (d.creator_id === req.user.id) throw httpError(400, 'self_dispute', 'Нельзя спорить с собой.');
  if (d.opponent_id && d.opponent_id !== req.user.id) throw httpError(409, 'taken', 'Вторую сторону уже заняли.');
  if (d.status !== 'awaiting_opponent') throw httpError(409, 'closed', 'Дело больше не ждёт вторую сторону.');

  db.prepare('UPDATE disputes SET opponent_id = ? WHERE id = ?').run(req.user.id, d.id);
  events.publish(d.id, 'opponent_joined', { at: now() });
  res.json({ dispute: viewDispute(disputeById(d.id), {}) });
}));

/* ===============================================================
   Оппонент молчит: напоминание или публикация с пометкой
   =============================================================== */
router.post('/:id/remind', A.requireUser, wrap(function (req, res) {
  const d = disputeById(req.params.id);
  if (!d) throw httpError(404, 'not_found', 'Дело не найдено.');
  if (d.creator_id !== req.user.id) throw httpError(403, 'forbidden', 'Это не твоё дело.');
  if (d.reminders_sent >= 2) throw httpError(429, 'enough', 'Два напоминания уже отправлены. Больше не станем.');

  db.prepare('UPDATE disputes SET reminders_sent = reminders_sent + 1 WHERE id = ?').run(d.id);
  res.json({ ok: true, remindersSent: d.reminders_sent + 1 });
}));

router.post('/:id/publish-one-sided', A.requireUser, wrap(function (req, res) {
  const d = disputeById(req.params.id);
  if (!d) throw httpError(404, 'not_found', 'Дело не найдено.');
  if (d.creator_id !== req.user.id) throw httpError(403, 'forbidden', 'Это не твоё дело.');
  if (d.status !== 'awaiting_opponent') throw httpError(409, 'bad_status', 'Дело уже не ждёт вторую сторону.');

  const waited = now() - d.created_at;
  if (waited < config.deadlines.opponentWindowHours * 3600000) {
    throw httpError(400, 'too_early', 'Односторонняя публикация возможна только когда вышло время на ответ.');
  }

  db.prepare('UPDATE disputes SET one_sided = 1 WHERE id = ?').run(d.id);
  const status = court.openForJury(d.id);
  res.json({ ok: true, status: status, dispute: viewDispute(disputeById(d.id), {}) });
}));

/* ===============================================================
   Чтение дела, мои дела, поток обновлений, аудио
   =============================================================== */
router.get('/mine', A.requireUser, wrap(function (req, res) {
  const rows = db.prepare(
    'SELECT DISTINCT d.* FROM disputes d LEFT JOIN sides s ON s.dispute_id = d.id ' +
    'WHERE d.creator_id = ? OR d.opponent_id = ? OR s.user_id = ? ' +
    'ORDER BY d.created_at DESC LIMIT 50'
  ).all(req.user.id, req.user.id, req.user.id);

  res.json({
    disputes: rows.map(function (d) {
      return viewDispute(d, { includeInvite: d.creator_id === req.user.id });
    })
  });
}));

router.get('/:id', wrap(function (req, res) {
  const d = disputeById(req.params.id);
  if (!d) throw httpError(404, 'not_found', 'Дело не найдено.');

  const party = req.user ? isParty(d, req.user.id) : false;
  const juror = req.user
    ? db.prepare('SELECT id FROM jury_assignments WHERE dispute_id = ? AND juror_id = ?').get(d.id, req.user.id)
    : null;

  /* Незакрытое дело видят только участники и присяжные, которым его выдали. */
  if (d.status !== 'verdict' && !party && !juror) {
    throw httpError(403, 'forbidden', 'Это дело тебе не выдавали.');
  }

  res.json({ dispute: viewDispute(d, { includeInvite: party && d.creator_id === req.user.id }) });
}));

/** Живой счётчик кворума. Проценты сюда не попадают до вердикта. */
router.get('/:id/stream', A.requireUser, wrap(function (req, res) {
  const d = disputeById(req.params.id);
  if (!d) throw httpError(404, 'not_found', 'Дело не найдено.');
  if (!isParty(d, req.user.id)) throw httpError(403, 'forbidden', 'Поток только для сторон дела.');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 5000\n\n');
  res.write('event: quorum\ndata: ' + JSON.stringify(court.quorumState(d.id)) + '\n\n');

  events.subscribe(d.id, res);

  const beat = setInterval(function () {
    try {
      res.write('event: quorum\ndata: ' + JSON.stringify(court.quorumState(d.id)) + '\n\n');
    } catch (_) {
      clearInterval(beat);
    }
  }, 10000);
  req.on('close', function () { clearInterval(beat); });
}));

/** Раздача записи. Слушать может сторона дела или присяжный с выданным делом. */
router.get('/:id/audio/:label', A.requireUser, wrap(function (req, res) {
  const d = disputeById(req.params.id);
  if (!d) throw httpError(404, 'not_found', 'Дело не найдено.');

  const label = req.params.label === 'b' ? 'b' : 'a';
  const side = db.prepare('SELECT * FROM sides WHERE dispute_id = ? AND label = ?').get(d.id, label);
  if (!side) throw httpError(404, 'no_side', 'Записи нет.');

  const party = isParty(d, req.user.id);
  const assigned = db.prepare(
    'SELECT id FROM jury_assignments WHERE dispute_id = ? AND juror_id = ?'
  ).get(d.id, req.user.id);

  if (!party && !assigned && d.status !== 'verdict') {
    throw httpError(403, 'forbidden', 'Запись доступна только сторонам и присяжным этого дела.');
  }

  const abs = path.join(config.uploadDir, side.audio_file);
  if (!fs.existsSync(abs)) throw httpError(410, 'gone', 'Файл записи уже удалён.');

  res.setHeader('Content-Type', side.audio_mime);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Accept-Ranges', 'bytes');
  fs.createReadStream(abs).pipe(res);
}));

module.exports = router;
