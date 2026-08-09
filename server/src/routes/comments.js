import { Router } from 'express';
import { db } from '../db.js';
import { id } from '../lib/ids.js';
import { auth } from '../middleware/auth.js';
import { limit } from '../middleware/ratelimit.js';
import { redact } from '../lib/moderation.js';

export const router = Router();

/** GET /api/comments/:disputeId — комментарии открываются вместе с вердиктом. */
router.get('/:disputeId', auth(), (req, res) => {
  const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.disputeId);
  if (!d) return res.status(404).json({ error: 'not_found' });
  if (d.status !== 'verdict') {
    return res.status(409).json({ error: 'too_early', message: 'Комментарии открываются вместе с вердиктом.' });
  }

  const rows = db.prepare(`
    SELECT c.id, c.body, c.upvotes, c.created_at, u.emoji, u.nickname,
           EXISTS(SELECT 1 FROM comment_votes cv WHERE cv.comment_id = c.id AND cv.user_id = ?) AS upvoted
    FROM comments c JOIN users u ON u.id = c.author_id
    WHERE c.dispute_id = ? AND c.hidden = 0
    ORDER BY c.upvotes DESC, c.created_at ASC LIMIT 100
  `).all(req.user.id, d.id);

  res.json({ comments: rows.map(r => Object.assign({}, r, { upvoted: !!r.upvoted })) });
});

/** POST /api/comments/:disputeId — писать может только тот, кто слушал и голосовал. */
router.post('/:disputeId', auth(), limit({ key: 'comment', max: 60, windowMs: 3600000 }), (req, res) => {
  const voted = db.prepare('SELECT 1 FROM votes WHERE dispute_id = ? AND juror_id = ?')
    .get(req.params.disputeId, req.user.id);
  if (!voted) {
    return res.status(403).json({ error: 'not_juror', message: 'Комментировать может тот, кто слушал и голосовал.' });
  }

  const body = String((req.body && req.body.body) || '').trim().slice(0, 400);
  if (body.length < 3) return res.status(422).json({ error: 'empty' });

  const cid = id();
  db.prepare('INSERT INTO comments (id, dispute_id, author_id, body, created_at) VALUES (?,?,?,?,?)')
    .run(cid, req.params.disputeId, req.user.id, redact(body), Date.now());
  res.status(201).json({ id: cid });
});

/** POST /api/comments/:commentId/upvote */
router.post('/:commentId/upvote', auth(), limit({ key: 'upvote', max: 300, windowMs: 3600000 }), (req, res) => {
  const c = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.commentId);
  if (!c) return res.status(404).json({ error: 'not_found' });
  if (c.author_id === req.user.id) return res.status(409).json({ error: 'self_vote' });

  try {
    db.transaction(() => {
      db.prepare('INSERT INTO comment_votes (comment_id, user_id, created_at) VALUES (?,?,?)')
        .run(c.id, req.user.id, Date.now());
      db.prepare('UPDATE comments SET upvotes = upvotes + 1 WHERE id = ?').run(c.id);
    })();
  } catch {
    return res.status(409).json({ error: 'already' });
  }

  res.json({ upvotes: db.prepare('SELECT upvotes FROM comments WHERE id = ?').get(c.id).upvotes });
});
