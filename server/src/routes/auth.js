import { Router } from 'express';
import { db, track } from '../db.js';
import { id, anonName, hashDevice } from '../lib/ids.js';
import { sign, auth } from '../middleware/auth.js';
import { limit } from '../middleware/ratelimit.js';

export const router = Router();

export function publicUser(u) {
  return {
    id: u.id,
    nickname: u.nickname,
    emoji: u.emoji,
    wins: u.wins,
    losses: u.losses,
    casesJudged: u.cases_judged,
    juryScore: u.jury_score,
    juryLevel: 1 + Math.floor(u.cases_judged / 25),
    subscriber: !!(u.sub_until && u.sub_until > Date.now()),
    subUntil: u.sub_until || null
  };
}

/**
 * POST /api/auth/anon
 * Анонимный аккаунт: ни почты, ни пароля. Только device id, который
 * превращается в хеш и работает как правило «один голос с устройства».
 */
router.post('/anon', limit({ key: 'anon', max: 20, windowMs: 3600000 }), (req, res) => {
  const deviceId = String((req.body && req.body.deviceId) || '').slice(0, 200);
  const hash = hashDevice(deviceId);

  if (hash) {
    const existing = db.prepare('SELECT * FROM users WHERE device_hash = ? ORDER BY created_at LIMIT 1').get(hash);
    if (existing) return res.json({ token: sign(existing.id), user: publicUser(existing), returning: true });
  }

  const { nickname, emoji } = anonName();
  const uid = id();
  db.prepare('INSERT INTO users (id, nickname, emoji, device_hash, created_at) VALUES (?,?,?,?,?)')
    .run(uid, nickname, emoji, hash, Date.now());

  track(uid, 'signup');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  res.status(201).json({ token: sign(uid), user: publicUser(user), returning: false });
});

/** GET /api/auth/me — профиль, бейджи, история споров. */
router.get('/me', auth(), (req, res) => {
  const badges = db.prepare('SELECT kind, label, expires_at FROM badges WHERE user_id = ? ORDER BY created_at DESC LIMIT 24')
    .all(req.user.id);

  const history = db.prepare(`
    SELECT d.id, d.topic, d.status, v.pct_a, v.pct_b, v.winner, s.label AS my_side
    FROM sides s
    JOIN disputes d ON d.id = s.dispute_id
    LEFT JOIN verdicts v ON v.dispute_id = d.id
    WHERE s.user_id = ?
    ORDER BY d.created_at DESC LIMIT 30
  `).all(req.user.id);

  res.json({
    user: publicUser(req.user),
    badges,
    history: history.map(h => ({
      id: h.id,
      topic: h.topic,
      status: h.status,
      mySide: h.my_side,
      myPct: h.winner ? (h.my_side === 'a' ? h.pct_a : h.pct_b) : null,
      result: !h.winner ? null : (h.winner === 'tie' ? 'tie' : (h.winner === h.my_side ? 'win' : 'loss'))
    }))
  });
});
