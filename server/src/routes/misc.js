import { Router } from 'express';
import { db, track } from '../db.js';
import { id } from '../lib/ids.js';
import { auth, admin } from '../middleware/auth.js';
import { limit } from '../middleware/ratelimit.js';

export const router = Router();

/** GET /api/stats — живые счётчики для тикера на лендинге. */
router.get('/stats', (_req, res) => {
  const one = sql => db.prepare(sql).get();

  res.json({
    live: one("SELECT COUNT(*) AS n FROM disputes WHERE status = 'in_jury'").n,
    verdicts: one("SELECT COUNT(*) AS n FROM disputes WHERE status = 'verdict'").n,
    votes: one('SELECT COUNT(*) AS n FROM votes').n,
    jurors: one('SELECT COUNT(DISTINCT juror_id) AS n FROM votes').n,
    recent: db.prepare(`
      SELECT d.topic, v.pct_a, v.pct_b, v.winner, v.total_votes
      FROM verdicts v JOIN disputes d ON d.id = v.dispute_id
      ORDER BY v.created_at DESC LIMIT 6
    `).all(),
    waiting: db.prepare(`
      SELECT d.topic, (SELECT COUNT(*) FROM votes v WHERE v.dispute_id = d.id) AS votes, d.jury_size
      FROM disputes d WHERE d.status = 'in_jury'
      ORDER BY d.published_at DESC LIMIT 6
    `).all()
  });
});

/** POST /api/waitlist { email, role } */
router.post('/waitlist', limit({ key: 'waitlist', max: 10, windowMs: 3600000 }), (req, res) => {
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(422).json({ error: 'bad_email', message: 'Проверь адрес, похоже на опечатку.' });
  }

  try {
    db.prepare('INSERT INTO waitlist (id, email, role, created_at) VALUES (?,?,?,?)')
      .run(id(), email, String(body.role || '').slice(0, 40), Date.now());
  } catch {
    // уже в списке: для человека это тот же успех
  }

  track(null, 'waitlist_signup', { role: body.role || null });
  res.status(201).json({ ok: true, total: db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n });
});

/** GET /api/funnel — воронка, чтобы видеть, где всё умирает. */
router.get('/funnel', (_req, res) => {
  const n = name => db.prepare('SELECT COUNT(*) AS n FROM events WHERE name = ?').get(name).n;
  const created = db.prepare('SELECT COUNT(*) AS n FROM disputes').get().n;
  const reachedJury = db.prepare("SELECT COUNT(*) AS n FROM disputes WHERE status IN ('in_jury','verdict')").get().n;
  const revenue = db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS c FROM payments WHERE status = 'paid'").get().c;

  res.json({
    signups: n('signup'),
    disputesCreated: created,
    reachedJury,
    secondSideRate: created ? Math.round((reachedJury / created) * 100) : 0,
    votes: n('vote_cast'),
    payments: n('payment'),
    revenueUsd: Number((revenue / 100).toFixed(2)),
    waitlist: db.prepare('SELECT COUNT(*) AS n FROM waitlist').get().n
  });
});

/** DELETE /api/me — право на удаление данных. */
router.delete('/me', auth(), (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM assignments WHERE juror_id = ?').run(req.user.id);
    db.prepare('UPDATE comments SET hidden = 1 WHERE author_id = ?').run(req.user.id);
    db.prepare("UPDATE users SET nickname = 'Удалённый аккаунт', emoji = '⬛', device_hash = NULL WHERE id = ?").run(req.user.id);
  })();

  track(req.user.id, 'account_deleted');
  res.json({ ok: true, note: 'Аккаунт обезличен. Голоса остались в статистике без привязки к тебе.' });
});

/* ------------------------------------------------------------- админка */

/** GET /api/admin/queue — что ждёт ручного разбора. */
router.get('/admin/queue', admin, (_req, res) => {
  res.json({
    held: db.prepare("SELECT id, topic, moderation_reason, created_at FROM disputes WHERE moderation_state != 'clean' ORDER BY created_at DESC LIMIT 100").all(),
    reports: db.prepare("SELECT * FROM reports WHERE status = 'open' ORDER BY created_at DESC LIMIT 100").all()
  });
});

/** POST /api/admin/disputes/:id/decision { action: approve | block } */
router.post('/admin/disputes/:id/decision', admin, (req, res) => {
  const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found' });

  if (req.body && req.body.action === 'approve') {
    const now = Date.now();
    db.prepare("UPDATE disputes SET moderation_state = 'clean', moderation_reason = NULL, status = 'in_jury', published_at = COALESCE(published_at, ?) WHERE id = ?")
      .run(now, d.id);
  } else {
    db.prepare("UPDATE disputes SET moderation_state = 'blocked', status = 'closed' WHERE id = ?").run(d.id);
    db.prepare('DELETE FROM assignments WHERE dispute_id = ?').run(d.id);
  }

  db.prepare("UPDATE reports SET status = 'upheld' WHERE target_type = 'dispute' AND target_id = ?").run(d.id);
  res.json({ ok: true });
});

/** POST /api/admin/users/:id/ban { days, reason } */
router.post('/admin/users/:id/ban', admin, (req, res) => {
  const body = req.body || {};
  const days = Math.max(1, Math.min(3650, Number(body.days || 30)));
  db.prepare('UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ?')
    .run(Date.now() + days * 24 * 3600000, String(body.reason || 'нарушение правил'), req.params.id);
  res.json({ ok: true });
});
