import { Router } from 'express';
import { db, track } from '../db.js';
import { id } from '../lib/ids.js';
import { auth } from '../middleware/auth.js';
import { limit } from '../middleware/ratelimit.js';
import { redact } from '../lib/moderation.js';
import { finalizeDue } from '../lib/verdict.js';
import { ASSIGNMENT_TTL_MS, LISTEN_THRESHOLD, MIN_DELIBERATION_MS } from '../config.js';

export const router = Router();

function caseView(assignment, _jurorId) {
  const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(assignment.dispute_id);
  const sides = db.prepare('SELECT * FROM sides WHERE dispute_id = ? ORDER BY label').all(d.id);

  const payload = sides.filter(s => s.audio_file).map(s => ({
    label: s.label,
    audioUrl: '/api/disputes/audio/' + s.id,
    durationMs: s.duration_ms,
    quote: s.transcript ? redact(s.transcript).slice(0, 180) : null
  }));

  return {
    assignmentId: assignment.id,
    disputeId: d.id,
    topic: d.topic,
    oneSided: !!d.one_sided,
    publishedAt: d.published_at,
    expiresAt: assignment.expires_at,
    listenThreshold: LISTEN_THRESHOLD,
    minDeliberationMs: MIN_DELIBERATION_MS,
    // порядок сторон перемешан: никто не выигрывает просто потому, что говорил первым
    sides: assignment.order_flip ? payload.slice().reverse() : payload
  };
}

/**
 * GET /api/jury/next — одно дело присяжному.
 * Не свои дела, где ещё не голосовал, где нет живого назначения и не набран кворум.
 * Срочные вперёд, дальше те, где меньше голосов и которые ждут дольше.
 */
router.get('/next', auth(), limit({ key: 'jurynext', max: 240, windowMs: 3600000 }), (req, res) => {
  const now = Date.now();
  db.prepare('DELETE FROM assignments WHERE voted = 0 AND expires_at < ?').run(now);

  const live = db.prepare('SELECT * FROM assignments WHERE juror_id = ? AND voted = 0 AND expires_at > ? LIMIT 1')
    .get(req.user.id, now);
  if (live) return res.json(caseView(live, req.user.id));

  const d = db.prepare(`
    SELECT d.*,
           (SELECT COUNT(*) FROM votes v WHERE v.dispute_id = d.id) AS votes,
           (SELECT COUNT(*) FROM assignments a WHERE a.dispute_id = d.id AND a.voted = 0 AND a.expires_at > ?) AS pending
    FROM disputes d
    WHERE d.status = 'in_jury'
      AND d.moderation_state = 'clean'
      AND NOT EXISTS (SELECT 1 FROM sides s WHERE s.dispute_id = d.id AND s.user_id = ?)
      AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.dispute_id = d.id AND v.juror_id = ?)
      AND (SELECT COUNT(*) FROM votes v2 WHERE v2.dispute_id = d.id) < d.jury_size
    ORDER BY CASE d.tier WHEN 'urgent' THEN 0 WHEN 'sub' THEN 0 WHEN 'wide' THEN 1 ELSE 2 END,
             votes ASC, d.published_at ASC
    LIMIT 1
  `).get(now, req.user.id, req.user.id);

  if (!d) {
    const waiting = db.prepare("SELECT COUNT(*) AS n FROM disputes WHERE status = 'in_jury'").get().n;
    return res.status(204).set('X-Cases-Live', String(waiting)).end();
  }

  const assignment = {
    id: id(),
    dispute_id: d.id,
    juror_id: req.user.id,
    order_flip: Math.random() < 0.5 ? 1 : 0,
    created_at: now,
    expires_at: now + ASSIGNMENT_TTL_MS,
    voted: 0
  };

  db.prepare('INSERT INTO assignments (id, dispute_id, juror_id, order_flip, created_at, expires_at, voted) VALUES (@id,@dispute_id,@juror_id,@order_flip,@created_at,@expires_at,@voted)')
    .run(assignment);

  track(req.user.id, 'case_served', { disputeId: d.id });
  res.json(caseView(assignment, req.user.id));
});

/**
 * POST /api/jury/:assignmentId/vote  { side, listenedA, listenedB, comment }
 * Все проверки на сервере: клиенту тут верить нельзя.
 */
router.post('/:assignmentId/vote', auth(), limit({ key: 'vote', max: 300, windowMs: 3600000 }), (req, res) => {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.assignmentId);
  if (!a || a.juror_id !== req.user.id) return res.status(404).json({ error: 'no_assignment' });
  if (a.voted) return res.status(409).json({ error: 'already_voted', message: 'Ты уже голосовал в этом деле.' });

  const now = Date.now();
  if (now > a.expires_at) {
    return res.status(410).json({ error: 'expired', message: 'Время на дело вышло, оно вернулось в очередь.' });
  }

  const body = req.body || {};
  const side = String(body.side || '');
  if (!['a', 'b'].includes(side)) return res.status(400).json({ error: 'bad_side' });

  const la = Number(body.listenedA || 0);
  const lb = Number(body.listenedB || 0);
  if (la < LISTEN_THRESHOLD || lb < LISTEN_THRESHOLD) {
    return res.status(422).json({
      error: 'not_listened',
      message: 'Нужно прослушать обе стороны минимум на ' + Math.round(LISTEN_THRESHOLD * 100) + '%.'
    });
  }

  const elapsed = now - a.created_at;
  if (elapsed < MIN_DELIBERATION_MS) {
    return res.status(422).json({ error: 'too_fast', message: 'Слишком быстро для двух минут аудио. Такие голоса мы не считаем.' });
  }

  const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(a.dispute_id);
  if (!d || d.status !== 'in_jury') return res.status(409).json({ error: 'closed', message: 'Дело уже закрыто.' });

  try {
    db.transaction(() => {
      db.prepare('INSERT INTO votes (id, dispute_id, juror_id, side_label, device_hash, listened_a, listened_b, elapsed_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id(), d.id, req.user.id, side, req.user.device_hash, la, lb, elapsed, now);
      db.prepare('UPDATE assignments SET voted = 1 WHERE id = ?').run(a.id);
      db.prepare('UPDATE users SET cases_judged = cases_judged + 1, jury_score = jury_score + 1 WHERE id = ?').run(req.user.id);
    })();
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'duplicate', message: 'С этого устройства в деле уже есть голос.' });
    }
    throw e;
  }

  const comment = String(body.comment || '').trim().slice(0, 400);
  if (comment.length > 2) {
    db.prepare('INSERT INTO comments (id, dispute_id, author_id, body, created_at) VALUES (?,?,?,?,?)')
      .run(id(), d.id, req.user.id, redact(comment), now);
  }

  track(req.user.id, 'vote_cast', { disputeId: d.id, side });
  finalizeDue();

  const collected = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE dispute_id = ?').get(d.id).n;
  // счёт присяжному не показываем: стадный эффект ломает справедливость
  res.json({ ok: true, quorum: { collected, needed: d.jury_size } });
});

/** POST /api/jury/:assignmentId/skip — не моё дело, верни в очередь. */
router.post('/:assignmentId/skip', auth(), (req, res) => {
  const a = db.prepare('SELECT * FROM assignments WHERE id = ? AND juror_id = ?').get(req.params.assignmentId, req.user.id);
  if (!a) return res.status(404).json({ error: 'no_assignment' });

  db.prepare('DELETE FROM assignments WHERE id = ?').run(a.id);
  track(req.user.id, 'case_skipped', { disputeId: a.dispute_id });
  res.json({ ok: true });
});
