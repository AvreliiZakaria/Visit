import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { db, track, AUDIO_DIR } from '../db.js';
import { id, shortCode } from '../lib/ids.js';
import { auth } from '../middleware/auth.js';
import { limit } from '../middleware/ratelimit.js';
import { screen, redact } from '../lib/moderation.js';
import { TIERS, JURY_SIZE, FREE_DEADLINE_MS, MAX_AUDIO_BYTES, MAX_SIDE_SECONDS } from '../config.js';

export const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, AUDIO_DIR),
    filename: (_req, file, cb) => {
      const m = file.mimetype || '';
      const ext = m.includes('mp4') ? '.m4a' : m.includes('wav') ? '.wav' : m.includes('ogg') ? '.ogg' : '.webm';
      cb(null, id() + ext);
    }
  }),
  limits: { fileSize: MAX_AUDIO_BYTES },
  fileFilter: (_req, file, cb) => cb(null, /^audio\//.test(file.mimetype || ''))
});

/* ------------------------------------------------------------- создание */

/** POST /api/disputes  { topic, consent } */
router.post('/', auth(), limit({ key: 'create', max: 20, windowMs: 3600000 }), (req, res) => {
  const topic = String((req.body && req.body.topic) || '').trim().slice(0, 90);
  if (topic.length < 8) {
    return res.status(422).json({ error: 'bad_topic', message: 'Тема слишком короткая: жюри не поймёт, о чём спор.' });
  }

  const mod = screen(topic);
  if (mod.state === 'blocked') {
    return res.status(422).json({ error: 'moderation', message: 'Тема нарушает правила: ' + mod.reason });
  }

  const now = Date.now();
  const did = id();
  const consent = req.body && req.body.consent ? 1 : 0;

  db.transaction(() => {
    db.prepare('INSERT INTO disputes (id, code, topic, creator_id, status, tier, jury_size, consent_content, moderation_state, moderation_reason, created_at, deadline_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(did, shortCode(), topic, req.user.id, 'draft', 'free', JURY_SIZE, consent, mod.state, mod.reason, now, now + FREE_DEADLINE_MS);

    db.prepare('INSERT INTO sides (id, dispute_id, label, user_id, created_at) VALUES (?,?,?,?,?)')
      .run(id(), did, 'a', req.user.id, now);
    db.prepare('INSERT INTO sides (id, dispute_id, label, created_at) VALUES (?,?,?,?)')
      .run(id(), did, 'b', now);
  })();

  track(req.user.id, 'dispute_created', { consent: !!consent });
  res.status(201).json(view(did, req.user.id));
});

/* ---------------------------------------------------------------- аудио */

/** POST /api/disputes/:id/sides/:label/audio — multipart: audio, durationMs, transcript */
router.post('/:id/sides/:label/audio', auth(), limit({ key: 'upload', max: 40, windowMs: 3600000 }), upload.single('audio'), (req, res) => {
  const did = req.params.id;
  const label = req.params.label;
  if (!['a', 'b'].includes(label)) return res.status(400).json({ error: 'bad_side' });
  if (!req.file) return res.status(400).json({ error: 'no_audio', message: 'Файл записи не пришёл.' });

  const dispute = db.prepare('SELECT * FROM disputes WHERE id = ?').get(did);
  const side = dispute && db.prepare('SELECT * FROM sides WHERE dispute_id = ? AND label = ?').get(did, label);

  if (!dispute || !side) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(404).json({ error: 'not_found' });
  }
  if (side.user_id && side.user_id !== req.user.id) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(403).json({ error: 'not_your_side', message: 'Эта сторона занята другим человеком.' });
  }
  if (!['draft', 'awaiting_opponent'].includes(dispute.status)) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(409).json({ error: 'locked', message: 'Дело уже в суде, запись изменить нельзя.' });
  }

  const durationMs = Math.min(Number((req.body && req.body.durationMs) || 0), MAX_SIDE_SECONDS * 1000);
  if (durationMs < 10000) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(422).json({ error: 'too_short', message: 'Меньше 10 секунд: жюри не поймёт сути.' });
  }

  const transcript = String((req.body && req.body.transcript) || '').slice(0, 4000);
  const mod = screen(transcript);
  if (mod.state === 'blocked') {
    fs.rmSync(req.file.path, { force: true });
    return res.status(422).json({ error: 'moderation', message: 'Запись нарушает правила: ' + mod.reason });
  }

  db.transaction(() => {
    if (side.audio_file) fs.rmSync(path.join(AUDIO_DIR, side.audio_file), { force: true });

    db.prepare('UPDATE sides SET user_id = ?, audio_file = ?, mime = ?, duration_ms = ?, transcript = ? WHERE id = ?')
      .run(req.user.id, path.basename(req.file.path), req.file.mimetype, durationMs, transcript, side.id);

    if (mod.state === 'held') {
      db.prepare("UPDATE disputes SET moderation_state = 'held', moderation_reason = ? WHERE id = ?").run(mod.reason, did);
    }
    maybePublish(did);
  })();

  track(req.user.id, 'side_recorded', { side: label, durationMs });
  res.json(view(did, req.user.id));
});

/** GET /api/disputes/audio/:sideId?token=... — запись отдаём только тем, кому положено. */
router.get('/audio/:sideId', auth(), (req, res) => {
  const side = db.prepare('SELECT * FROM sides WHERE id = ?').get(req.params.sideId);
  if (!side || !side.audio_file) return res.status(404).end();

  const isParty = !!db.prepare('SELECT 1 FROM sides WHERE dispute_id = ? AND user_id = ?').get(side.dispute_id, req.user.id);
  const isJuror = !!db.prepare('SELECT 1 FROM assignments WHERE dispute_id = ? AND juror_id = ? AND expires_at > ?').get(side.dispute_id, req.user.id, Date.now());
  const hasVoted = !!db.prepare('SELECT 1 FROM votes WHERE dispute_id = ? AND juror_id = ?').get(side.dispute_id, req.user.id);

  if (!isParty && !isJuror && !hasVoted) return res.status(403).json({ error: 'forbidden' });

  res.sendFile(path.join(AUDIO_DIR, side.audio_file), { headers: { 'Cache-Control': 'private, max-age=3600' } });
});

/* --------------------------------------------------------- вторая сторона */

/** GET /api/disputes/by-code/:code */
router.get('/by-code/:code', auth(false), (req, res) => {
  const d = db.prepare('SELECT * FROM disputes WHERE code = ?').get(req.params.code);
  if (!d) return res.status(404).json({ error: 'not_found', message: 'Дела по этой ссылке нет.' });

  const b = db.prepare("SELECT user_id, audio_file FROM sides WHERE dispute_id = ? AND label = 'b'").get(d.id);
  res.json({
    id: d.id, code: d.code, topic: d.topic, status: d.status,
    taken: !!(b && b.audio_file), createdAt: d.created_at, deadlineAt: d.deadline_at
  });
});

/** POST /api/disputes/by-code/:code/claim — занять сторону Б. */
router.post('/by-code/:code/claim', auth(), (req, res) => {
  const d = db.prepare('SELECT * FROM disputes WHERE code = ?').get(req.params.code);
  if (!d) return res.status(404).json({ error: 'not_found' });
  if (d.creator_id === req.user.id) {
    return res.status(409).json({ error: 'self', message: 'Нельзя спорить с самим собой: это уже не суд, а монолог.' });
  }

  const b = db.prepare("SELECT * FROM sides WHERE dispute_id = ? AND label = 'b'").get(d.id);
  if (b.user_id && b.user_id !== req.user.id) {
    return res.status(409).json({ error: 'taken', message: 'Сторону Б уже занял другой человек.' });
  }

  db.prepare('UPDATE sides SET user_id = ? WHERE id = ?').run(req.user.id, b.id);
  track(req.user.id, 'opponent_joined', { disputeId: d.id });
  res.json({ disputeId: d.id, sideId: b.id, topic: d.topic });
});

/* ---------------------------------------------------------------- чтение */

/** GET /api/disputes/mine */
router.get('/mine', auth(), (req, res) => {
  const rows = db.prepare('SELECT DISTINCT d.id FROM disputes d JOIN sides s ON s.dispute_id = d.id WHERE s.user_id = ? ORDER BY d.created_at DESC LIMIT 50')
    .all(req.user.id);
  res.json({ disputes: rows.map(r => view(r.id, req.user.id)) });
});

/** GET /api/disputes/:id */
router.get('/:id', auth(), (req, res) => {
  const v = view(req.params.id, req.user.id);
  if (!v) return res.status(404).json({ error: 'not_found' });
  res.json(v);
});

/** POST /api/disputes/:id/publish-one-sided */
router.post('/:id/publish-one-sided', auth(), (req, res) => {
  const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'not_found' });
  if (d.creator_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (d.status !== 'awaiting_opponent') {
    return res.status(409).json({ error: 'bad_status', message: 'Так можно только пока дело ждёт вторую сторону.' });
  }
  if (Date.now() - d.created_at < FREE_DEADLINE_MS) {
    return res.status(409).json({ error: 'too_early', message: 'Дай оппоненту сутки. Пока время не вышло.' });
  }

  const now = Date.now();
  db.prepare("UPDATE disputes SET one_sided = 1, status = 'in_jury', published_at = ?, deadline_at = ? WHERE id = ?")
    .run(now, now + FREE_DEADLINE_MS, d.id);

  track(req.user.id, 'published_one_sided', { disputeId: d.id });
  res.json(view(d.id, req.user.id));
});

/* --------------------------------------------------------------- утилиты */

/** Дело уходит в жюри только когда обе стороны записались и модерация чистая. */
export function maybePublish(disputeId) {
  const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId);
  if (!d || !['draft', 'awaiting_opponent'].includes(d.status)) return;

  const sides = db.prepare('SELECT label, audio_file FROM sides WHERE dispute_id = ?').all(disputeId);
  const ready = sides.filter(s => s.audio_file).length;

  if (ready === 0) return;

  if (ready === 1) {
    if (d.status !== 'awaiting_opponent') {
      db.prepare("UPDATE disputes SET status = 'awaiting_opponent' WHERE id = ?").run(disputeId);
    }
    return;
  }

  if (d.moderation_state === 'held') {
    db.prepare("UPDATE disputes SET status = 'held' WHERE id = ?").run(disputeId);
    return;
  }

  const now = Date.now();
  const tier = TIERS[d.tier];
  const deadline = now + ((tier && tier.deadline_ms) || FREE_DEADLINE_MS);
  db.prepare("UPDATE disputes SET status = 'in_jury', published_at = ?, deadline_at = ? WHERE id = ?")
    .run(now, deadline, disputeId);
}

/** Единое представление дела. Счёт до вердикта не показываем никому. */
export function view(disputeId, viewerId) {
  const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId);
  if (!d) return null;

  const sides = db.prepare('SELECT * FROM sides WHERE dispute_id = ? ORDER BY label').all(disputeId);
  const votes = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE dispute_id = ?').get(disputeId).n;
  const verdict = db.prepare('SELECT * FROM verdicts WHERE dispute_id = ?').get(disputeId);
  const isParty = sides.some(s => s.user_id === viewerId);
  const mySide = (sides.find(s => s.user_id === viewerId) || {}).label || null;

  const out = {
    id: d.id,
    code: isParty ? d.code : undefined,
    topic: d.topic,
    status: d.status,
    tier: d.tier,
    jurySize: d.jury_size,
    oneSided: !!d.one_sided,
    consentContent: !!d.consent_content,
    moderation: d.moderation_state,
    moderationReason: d.moderation_state === 'clean' ? null : d.moderation_reason,
    createdAt: d.created_at,
    publishedAt: d.published_at,
    deadlineAt: d.deadline_at,
    quorum: { collected: votes, needed: d.jury_size },
    mySide,
    sides: sides.map(s => ({
      label: s.label,
      recorded: !!s.audio_file,
      durationMs: s.duration_ms,
      quote: s.transcript ? redact(s.transcript).slice(0, 180) : null,
      audioUrl: s.audio_file ? '/api/disputes/audio/' + s.id : null
    })),
    verdict: null
  };

  if (verdict) {
    out.verdict = {
      pctA: verdict.pct_a,
      pctB: verdict.pct_b,
      winner: verdict.winner,
      totalVotes: verdict.total_votes,
      createdAt: verdict.created_at,
      topComments: db.prepare(`
        SELECT c.id, c.body, c.upvotes, u.emoji, u.nickname
        FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.dispute_id = ? AND c.hidden = 0
        ORDER BY c.upvotes DESC, c.created_at ASC LIMIT 3
      `).all(disputeId)
    };
    if (isParty) {
      out.verdict.myResult = verdict.winner === 'tie' ? 'tie' : (verdict.winner === mySide ? 'win' : 'loss');
    }
  }

  return out;
}
