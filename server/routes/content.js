'use strict';

/**
 * Выгрузка дел для коротких видео. Отдаёт только то, на что есть
 * явное согласие автора, только после вердикта и только в переработанном виде:
 * текст истории, а не оригинальная запись.
 *
 * Голосовые файлы через этот маршрут не уходят никогда. Публикуется синтез.
 */

const express = require('express');
const { db } = require('../db');
const { wrap } = require('../lib/util');
const A = require('../lib/auth');

const router = express.Router();

router.get('/reels', A.requireRole('moderator', 'admin'), wrap(function (req, res) {
  const limit = Math.min(Number(req.query.limit) || 20, 100);

  const rows = db.prepare(
    'SELECT d.id, d.public_no, d.topic, v.pct_a, v.pct_b, v.winner, v.total_votes, v.issued_at ' +
    'FROM disputes d JOIN verdicts v ON v.dispute_id = d.id ' +
    'WHERE d.consent_content = 1 AND d.status = \'verdict\' ' +
    'ORDER BY v.total_votes DESC, ABS(v.pct_a - 50) ASC LIMIT ?'
  ).all(limit);

  const out = rows.map(function (r) {
    const sides = db.prepare(
      'SELECT label, transcript, duration_ms FROM sides WHERE dispute_id = ? ORDER BY label'
    ).all(r.id);

    const top = db.prepare(
      'SELECT body, score FROM comments WHERE dispute_id = ? AND hidden = 0 ' +
      'ORDER BY score DESC LIMIT 3'
    ).all(r.id);

    return {
      disputeId: r.id,
      no: r.public_no,
      hook: r.topic,
      /* Транскрипты уже прошли через вырезание персональных данных. */
      script: sides.map(function (s) {
        return {
          side: s.label,
          text: s.transcript || null,
          seconds: Math.round(s.duration_ms / 1000)
        };
      }),
      result: { pctA: r.pct_a, pctB: r.pct_b, winner: r.winner, votes: r.total_votes },
      topComments: top,
      /* Насколько спор спорный: чем ближе к пятидесяти, тем жарче комменты под видео. */
      controversy: 100 - Math.abs(r.pct_a - 50) * 2,
      rights: 'Согласие получено при создании дела. Оригинальную запись не публиковать, только синтез.'
    };
  });

  res.json({ reels: out, count: out.length });
}));

module.exports = router;
