'use strict';

const express = require('express');
const config = require('../config');
const { db } = require('../db');
const { id, now, hash, flipFor, httpError, wrap } = require('../lib/util');
const { rateLimit } = require('../lib/rate');
const A = require('../lib/auth');
const court = require('../lib/court');
const events = require('../lib/events');

const router = express.Router();

/* ===============================================================
   Выдача дела присяжному.

   Кому не выдаём: сторонам дела, тем кто уже голосовал,
   тем кому это дело уже выдавали. Порядок сторон перемешивается
   детерминированно, чтобы при перезагрузке не менялся.

   Приоритет: активные присяжные видят дела раньше. Это единственный
   честный способ решить холодный старт: судишь других, быстрее судят тебя.
   =============================================================== */
router.get('/next',
  A.requireUser,
  rateLimit({ max: 300, windowMs: 60 * 60 * 1000, scope: 'jury_next' }),
  wrap(function (req, res) {
    const t = now();

    const d = db.prepare(
      "SELECT d.* FROM disputes d" +
      " WHERE d.status = 'in_jury'" +
      '   AND d.creator_id != ?' +
      '   AND (d.opponent_id IS NULL OR d.opponent_id != ?)' +
      '   AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.dispute_id = d.id AND v.juror_id = ?)' +
      '   AND NOT EXISTS (SELECT 1 FROM jury_assignments ja WHERE ja.dispute_id = d.id AND ja.juror_id = ?)' +
      '   AND (SELECT COUNT(*) FROM votes v2 WHERE v2.dispute_id = d.id) < d.target_jury' +
      ' ORDER BY (d.tier = \'urgent\') DESC, d.priority DESC, d.deadline_at ASC' +
      ' LIMIT 1'
    ).get(req.user.id, req.user.id, req.user.id, req.user.id);

    if (!d) {
      return res.json({
        case: null,
        message: 'Дела закончились. Новые появляются круглые сутки.'
      });
    }

    const flip = flipFor(d.id, req.user.id);
    db.prepare(
      'INSERT OR REPLACE INTO jury_assignments (id, dispute_id, juror_id, order_flip, served_at, expires_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id(), d.id, req.user.id, flip, t, t + config.jury.assignmentTtlMinutes * 60000);

    const sides = db.prepare(
      'SELECT label, duration_ms FROM sides WHERE dispute_id = ? ORDER BY label'
    ).all(d.id);

    const cards = sides.map(function (s) {
      return {
        label: s.label,
        durationMs: s.duration_ms,
        audioUrl: '/api/disputes/' + d.id + '/audio/' + s.label
      };
    });
    if (flip) cards.reverse();

    res.json({
      case: {
        disputeId: d.id,
        no: d.public_no,
        topic: d.topic,
        oneSided: Boolean(d.one_sided),
        openedAt: d.jury_opened_at,
        servedAt: t,
        /* Клиент узнаёт правила заранее, но проверяет их всё равно сервер. */
        rules: {
          minListenRatio: config.jury.minListenRatio,
          minSecondsBeforeVote: config.jury.minSecondsBeforeVote
        },
        sides: cards
      }
    });
  })
);

/* ===============================================================
   Голос. Здесь весь антифрод, и он серверный.

   Клиент может врать про прослушивание, поэтому проверяем три вещи:
   прошло ли достаточно времени с выдачи дела, укладывается ли
   заявленное прослушивание в реально возможное, и один ли голос от юзера.
   =============================================================== */
router.post('/:disputeId/vote',
  A.requireUser,
  rateLimit({ max: 200, windowMs: 60 * 60 * 1000, scope: 'vote' }),
  wrap(function (req, res) {
    const disputeId = req.params.disputeId;
    const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId);
    if (!d) throw httpError(404, 'not_found', 'Дело не найдено.');
    if (d.status !== 'in_jury') throw httpError(409, 'not_open', 'Дело больше не принимает голоса.');
    if (d.creator_id === req.user.id || d.opponent_id === req.user.id) {
      throw httpError(403, 'party', 'Свои дела не судят.');
    }

    const sideLabel = req.body.side === 'b' ? 'b' : req.body.side === 'a' ? 'a' : null;
    if (!sideLabel) throw httpError(400, 'bad_side', 'Выбери сторону.');

    const assignment = db.prepare(
      'SELECT * FROM jury_assignments WHERE dispute_id = ? AND juror_id = ?'
    ).get(disputeId, req.user.id);
    if (!assignment) throw httpError(409, 'not_assigned', 'Это дело тебе не выдавали.');

    const elapsedMs = now() - assignment.served_at;
    if (elapsedMs < config.jury.minSecondsBeforeVote * 1000) {
      throw httpError(400, 'too_fast',
        'Слишком быстро. Такой голос не считается: значит, записи не слушали.');
    }

    const la = Number(req.body.listenedA);
    const lb = Number(req.body.listenedB);
    if (!Number.isFinite(la) || !Number.isFinite(lb)) {
      throw httpError(400, 'bad_listen', 'Нет данных о прослушивании.');
    }

    const min = config.jury.minListenRatio;
    if (la < min || lb < min) {
      throw httpError(400, 'not_listened',
        'Голос откроется, когда прослушаешь обе стороны на ' + Math.round(min * 100) + '%.');
    }

    /* Заявить можно что угодно, но за 20 секунд две минуты аудио не слушаются. */
    const sides = db.prepare('SELECT label, duration_ms FROM sides WHERE dispute_id = ?').all(disputeId);
    let needMs = 0;
    for (const s of sides) {
      needMs += s.duration_ms * (s.label === 'a' ? Math.min(la, 1) : Math.min(lb, 1));
    }
    if (elapsedMs + 2000 < needMs) {
      throw httpError(400, 'impossible_listen',
        'Заявленное прослушивание не сходится со временем. Голос не принят.');
    }

    const exists = db.prepare('SELECT id FROM votes WHERE dispute_id = ? AND juror_id = ?')
      .get(disputeId, req.user.id);
    if (exists) throw httpError(409, 'already_voted', 'Ты уже голосовал в этом деле.');

    const deviceHash = hash(String(req.body.deviceId || '') + '|' + (req.get('user-agent') || ''));
    const ipHash = hash(req.ip);

    /* Одно устройство, один голос в деле. Второй аккаунт с того же телефона не поможет. */
    if (deviceHash) {
      const sameDevice = db.prepare(
        'SELECT id FROM votes WHERE dispute_id = ? AND device_hash = ?'
      ).get(disputeId, deviceHash);
      if (sameDevice) {
        throw httpError(409, 'device_voted', 'С этого устройства в деле уже голосовали.');
      }
    }

    db.transaction(function () {
      db.prepare(
        'INSERT INTO votes (id, dispute_id, juror_id, side_label, listened_a, listened_b, ' +
        'device_hash, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id(), disputeId, req.user.id, sideLabel, la, lb, deviceHash, ipHash, now());

      db.prepare('UPDATE users SET jury_score = jury_score + 1 WHERE id = ?').run(req.user.id);
    })();

    const state = court.quorumState(disputeId);
    events.publish(disputeId, 'quorum', state);

    /* Кворум мог собраться этим самым голосом. */
    if (state.collected >= state.target) court.issueVerdict(disputeId, 'quorum');

    /* Присяжному не отдаём ни счёт, ни проценты. Только факт, что голос учтён. */
    res.status(201).json({
      ok: true,
      message: 'Голос учтён. Счёт скрыт до вердикта.',
      juryScore: req.user.jury_score + 1
    });
  })
);

/* ===============================================================
   Комментарий присяжного. Только после голоса.
   =============================================================== */
router.post('/:disputeId/comment',
  A.requireUser,
  rateLimit({ max: 100, windowMs: 60 * 60 * 1000, scope: 'comment' }),
  wrap(function (req, res) {
    const disputeId = req.params.disputeId;
    const body = String(req.body.body || '').trim();
    if (body.length < 3) throw httpError(400, 'empty', 'Пустой комментарий.');
    if (body.length > 400) throw httpError(400, 'long', 'Не длиннее 400 символов.');

    const voted = db.prepare('SELECT id FROM votes WHERE dispute_id = ? AND juror_id = ?')
      .get(disputeId, req.user.id);
    if (!voted) throw httpError(403, 'vote_first', 'Сначала проголосуй.');

    const moderation = require('../lib/moderation');
    const scan = moderation.scan(body, { transcriptAvailable: true });
    if (scan.state === 'blocked') {
      throw httpError(400, 'blocked_content',
        'Комментарий не прошёл проверку: ' + scan.note + '. Личные данные и угрозы удаляй.');
    }

    const commentId = id();
    db.prepare(
      'INSERT INTO comments (id, dispute_id, juror_id, body, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(commentId, disputeId, req.user.id, body, now());

    res.status(201).json({ ok: true, commentId: commentId });
  })
);

/** Апвоут комментария. Один голос от пользователя. */
router.post('/comments/:commentId/upvote', A.requireUser, wrap(function (req, res) {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.commentId);
  if (!c) throw httpError(404, 'not_found', 'Комментарий не найден.');

  try {
    db.prepare('INSERT INTO comment_votes (comment_id, user_id, created_at) VALUES (?, ?, ?)')
      .run(c.id, req.user.id, now());
  } catch (_) {
    throw httpError(409, 'already', 'Ты уже поднимал этот комментарий.');
  }

  db.prepare('UPDATE comments SET score = score + 1 WHERE id = ?').run(c.id);
  res.json({ ok: true });
}));

/** Комментарии видны только после вердикта: до него они влияли бы на голоса. */
router.get('/:disputeId/comments', wrap(function (req, res) {
  const d = db.prepare('SELECT status FROM disputes WHERE id = ?').get(req.params.disputeId);
  if (!d) throw httpError(404, 'not_found', 'Дело не найдено.');
  if (d.status !== 'verdict') {
    return res.json({ comments: [], message: 'Комментарии откроются вместе с вердиктом.' });
  }

  const rows = db.prepare(
    'SELECT id, body, score, created_at FROM comments WHERE dispute_id = ? AND hidden = 0 ' +
    'ORDER BY score DESC, created_at ASC LIMIT 50'
  ).all(req.params.disputeId);

  res.json({ comments: rows });
}));

module.exports = router;
