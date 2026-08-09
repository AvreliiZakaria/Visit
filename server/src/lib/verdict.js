import { db } from '../db.js';
import { id } from './ids.js';
import { MIN_QUORUM } from '../config.js';

const BADGE_TTL_MS = 30 * 24 * 3600000;

export function tally(disputeId) {
  const rows = db.prepare(
    'SELECT side_label AS side, COUNT(*) AS n FROM votes WHERE dispute_id = ? GROUP BY side_label'
  ).all(disputeId);

  const a = rows.find(r => r.side === 'a')?.n || 0;
  const b = rows.find(r => r.side === 'b')?.n || 0;
  const total = a + b;
  if (!total) return { a: 0, b: 0, total: 0, pctA: 0, pctB: 0, winner: 'tie' };

  const pctA = Math.round((a / total) * 100);
  return { a, b, total, pctA, pctB: 100 - pctA, winner: a === b ? 'tie' : (a > b ? 'a' : 'b') };
}

function badgeLabel(topic) {
  const words = String(topic).replace(/[«»"'.,!?]/g, '').split(/\s+/).filter(Boolean).slice(0, 3);
  const text = words.join(' ');
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Проигранное дело';
}

export function finalize(dispute) {
  const t = tally(dispute.id);
  const now = Date.now();

  db.transaction(() => {
    db.prepare('INSERT OR REPLACE INTO verdicts (dispute_id, pct_a, pct_b, winner, total_votes, created_at) VALUES (?,?,?,?,?,?)')
      .run(dispute.id, t.pctA, t.pctB, t.winner, t.total, now);

    db.prepare("UPDATE disputes SET status = 'verdict', verdict_at = ? WHERE id = ?").run(now, dispute.id);

    if (t.winner !== 'tie') {
      const loserLabel = t.winner === 'a' ? 'b' : 'a';
      const loser = db.prepare('SELECT user_id FROM sides WHERE dispute_id = ? AND label = ?').get(dispute.id, loserLabel);
      const winner = db.prepare('SELECT user_id FROM sides WHERE dispute_id = ? AND label = ?').get(dispute.id, t.winner);

      if (loser && loser.user_id) {
        db.prepare('UPDATE users SET losses = losses + 1 WHERE id = ?').run(loser.user_id);
        db.prepare('INSERT INTO badges (id, user_id, dispute_id, kind, label, created_at, expires_at) VALUES (?,?,?,?,?,?,?)')
          .run(id(), loser.user_id, dispute.id, 'loss', badgeLabel(dispute.topic), now, now + BADGE_TTL_MS);
      }
      if (winner && winner.user_id) {
        db.prepare('UPDATE users SET wins = wins + 1 WHERE id = ?').run(winner.user_id);
      }
    }

    db.prepare('DELETE FROM assignments WHERE dispute_id = ? AND voted = 0').run(dispute.id);
  })();

  return t;
}

/** Планировщик: закрывает дела, где собран кворум или вышел срок. */
export function finalizeDue() {
  const rows = db.prepare(`
    SELECT d.*, (SELECT COUNT(*) FROM votes v WHERE v.dispute_id = d.id) AS votes
    FROM disputes d WHERE d.status = 'in_jury'
  `).all();

  const now = Date.now();
  const closed = [];

  for (const d of rows) {
    const quorumReached = d.votes >= d.jury_size;
    const timedOut = d.deadline_at && now > d.deadline_at && d.votes >= MIN_QUORUM;
    if (quorumReached || timedOut) {
      finalize(d);
      closed.push(d.id);
    }
  }

  db.prepare('DELETE FROM assignments WHERE voted = 0 AND expires_at < ?').run(now);
  return closed;
}
