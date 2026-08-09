import { Router } from 'express';
import { db, track } from '../db.js';
import { id } from '../lib/ids.js';
import { auth } from '../middleware/auth.js';
import { limit } from '../middleware/ratelimit.js';

export const router = Router();

const REASONS = ['доксинг', 'травля', 'несовершеннолетний', 'персональные данные', 'спам', 'другое'];

router.get('/reasons', (_req, res) => res.json({ reasons: REASONS }));

/** POST /api/reports { targetType, targetId, reason, note } */
router.post('/', auth(), limit({ key: 'report', max: 30, windowMs: 3600000 }), (req, res) => {
  const body = req.body || {};
  const targetType = body.targetType === 'comment' ? 'comment' : 'dispute';
  const targetId = String(body.targetId || '');
  const reason = REASONS.includes(body.reason) ? body.reason : 'другое';

  const exists = targetType === 'dispute'
    ? db.prepare('SELECT 1 FROM disputes WHERE id = ?').get(targetId)
    : db.prepare('SELECT 1 FROM comments WHERE id = ?').get(targetId);
  if (!exists) return res.status(404).json({ error: 'not_found' });

  db.prepare('INSERT INTO reports (id, target_type, target_id, reporter_id, reason, note, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id(), targetType, targetId, req.user.id, reason, String(body.note || '').slice(0, 500), Date.now());

  // три жалобы и дело уходит из фида до ручного разбора
  const count = db.prepare("SELECT COUNT(*) AS n FROM reports WHERE target_type = ? AND target_id = ? AND status = 'open'")
    .get(targetType, targetId).n;

  if (count >= 3) {
    if (targetType === 'dispute') {
      db.prepare("UPDATE disputes SET status = 'held', moderation_state = 'held', moderation_reason = 'жалобы присяжных' WHERE id = ? AND status = 'in_jury'")
        .run(targetId);
      db.prepare('DELETE FROM assignments WHERE dispute_id = ? AND voted = 0').run(targetId);
    } else {
      db.prepare('UPDATE comments SET hidden = 1 WHERE id = ?').run(targetId);
    }
  }

  track(req.user.id, 'report_filed', { targetType, reason });
  res.status(201).json({ ok: true, autoHidden: count >= 3 });
});
