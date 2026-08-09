'use strict';

/**
 * Движок суда. Здесь живут правила, которые нельзя нарушать:
 * кворум, дедлайны, подсчёт вердикта, возврат денег за несобранное жюри.
 *
 * Голоса никогда не создаются программно. Ни одной функции, которая
 * вставляет голос без реального присяжного, в этом файле нет и не будет.
 */

const config = require('../config');
const { db } = require('../db');
const { id, now } = require('./util');
const events = require('./events');

const q = {
  dispute: db.prepare('SELECT * FROM disputes WHERE id = ?'),
  sides: db.prepare('SELECT * FROM sides WHERE dispute_id = ? ORDER BY label'),
  countVotes: db.prepare('SELECT COUNT(*) AS n FROM votes WHERE dispute_id = ?'),
  tally: db.prepare('SELECT side_label, COUNT(*) AS n FROM votes WHERE dispute_id = ? GROUP BY side_label'),
  verdict: db.prepare('SELECT * FROM verdicts WHERE dispute_id = ?'),
  inJury: db.prepare("SELECT * FROM disputes WHERE status = 'in_jury'"),
  staleDrafts: db.prepare(
    "SELECT * FROM disputes WHERE status = 'awaiting_opponent' " +
    'AND opponent_deadline IS NOT NULL AND opponent_deadline < ?'),
  topComments: db.prepare(
    'SELECT id, body, score, created_at FROM comments ' +
    'WHERE dispute_id = ? AND hidden = 0 ORDER BY score DESC, created_at ASC LIMIT 3')
};

function targetFor(tier) {
  return tier === 'wide' ? config.jury.targetWide : config.jury.targetFree;
}

function deadlineFor(tier, from) {
  const t = from || now();
  return tier === 'urgent'
    ? t + config.deadlines.urgentMinutes * 60000
    : t + config.deadlines.freeHours * 3600000;
}

/**
 * Единственная цифра, которую стороны видят до вердикта: сколько присяжных собрано.
 * Текущий счёт не отдаётся никогда, иначе включается стадный эффект.
 */
function quorumState(disputeId) {
  const d = q.dispute.get(disputeId);
  if (!d) return null;
  const collected = q.countVotes.get(disputeId).n;
  return {
    collected: collected,
    target: d.target_jury,
    minQuorum: d.min_quorum,
    deadlineAt: d.deadline_at,
    status: d.status,
    ready: collected >= d.target_jury
  };
}

/** Открывает дело для жюри: только когда обе стороны записаны и модерация пропустила. */
const openForJury = db.transaction(function (disputeId) {
  const d = q.dispute.get(disputeId);
  if (!d) return null;

  const sides = q.sides.all(disputeId);

  if (sides.some(function (s) { return s.moderation_state === 'blocked'; })) {
    db.prepare("UPDATE disputes SET status = 'blocked' WHERE id = ?").run(disputeId);
    events.publish(disputeId, 'status', { status: 'blocked' });
    return 'blocked';
  }

  if (sides.some(function (s) {
    return s.moderation_state === 'flagged' || s.moderation_state === 'pending';
  })) {
    db.prepare("UPDATE disputes SET status = 'held' WHERE id = ?").run(disputeId);
    events.publish(disputeId, 'status', { status: 'held' });
    return 'held';
  }

  if (sides.length < 2 && !d.one_sided) return d.status;

  const t = now();
  db.prepare(
    "UPDATE disputes SET status = 'in_jury', jury_opened_at = ?, deadline_at = ? WHERE id = ?"
  ).run(t, deadlineFor(d.tier, t), disputeId);

  events.publish(disputeId, 'status', { status: 'in_jury' });
  return 'in_jury';
});

function truncateLabel(topic) {
  const clean = String(topic).replace(/\s+/g, ' ').trim();
  return clean.length > 42 ? clean.slice(0, 41) + '…' : clean;
}

/**
 * Обещание с лендинга: жюри не собралось, значит за срочность не платят.
 * Возврат идёт в кредит на счёт, чтобы не зависеть от политики магазина.
 */
function refundForFailedQuorum(disputeId) {
  const paid = db.prepare(
    "SELECT * FROM payments WHERE dispute_id = ? AND status = 'paid' AND product IN ('urgent','wide')"
  ).all(disputeId);

  for (const p of paid) {
    db.prepare('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?')
      .run('refunded', now(), p.id);
    db.prepare('UPDATE users SET credit_cents = credit_cents + ? WHERE id = ?')
      .run(p.amount_cents, p.user_id);
    db.prepare(
      'INSERT INTO audit_log (id, actor_id, action, subject, meta, created_at) VALUES (?, NULL, ?, ?, ?, ?)'
    ).run(id(), 'refund_no_quorum', p.id, JSON.stringify({ cents: p.amount_cents, disputeId: disputeId }), now());
  }
}

/** Подсчёт и фиксация вердикта. Идемпотентно: повторный вызов ничего не портит. */
const issueVerdict = db.transaction(function (disputeId, reason) {
  const d = q.dispute.get(disputeId);
  if (!d || d.status !== 'in_jury') return null;

  const existing = q.verdict.get(disputeId);
  if (existing) return existing;

  const rows = q.tally.all(disputeId);
  let a = 0, b = 0;
  for (const r of rows) {
    if (r.side_label === 'a') a = r.n;
    if (r.side_label === 'b') b = r.n;
  }
  const total = a + b;

  /* Кворум не собран, время вышло: вердикта нет, деньги возвращаем. */
  if (total < d.min_quorum) {
    db.prepare("UPDATE disputes SET status = 'expired' WHERE id = ?").run(disputeId);
    refundForFailedQuorum(disputeId);
    events.publish(disputeId, 'expired', { collected: total, minQuorum: d.min_quorum });
    return null;
  }

  const pctA = Math.round((a / total) * 100);
  const pctB = 100 - pctA;
  const winner = a === b ? 'tie' : a > b ? 'a' : 'b';
  const t = now();

  db.prepare(
    'INSERT INTO verdicts (id, dispute_id, pct_a, pct_b, winner, total_votes, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id(), disputeId, pctA, pctB, winner, total, t);

  db.prepare("UPDATE disputes SET status = 'verdict' WHERE id = ?").run(disputeId);

  /* Бейдж проигравшему на 30 дней. При ничьей бейджей нет. */
  if (winner !== 'tie') {
    const loserLabel = winner === 'a' ? 'b' : 'a';
    const loser = q.sides.all(disputeId).find(function (s) { return s.label === loserLabel; });
    if (loser) {
      db.prepare(
        'INSERT INTO badges (id, user_id, dispute_id, kind, label, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id(), loser.user_id, disputeId, 'loss', truncateLabel(d.topic), t + 30 * 24 * 3600000, t);
    }
  }

  db.prepare(
    'INSERT INTO audit_log (id, actor_id, action, subject, meta, created_at) VALUES (?, NULL, ?, ?, ?, ?)'
  ).run(id(), 'verdict_issued', disputeId,
    JSON.stringify({ pctA: pctA, pctB: pctB, total: total, reason: reason || 'quorum' }), t);

  events.publish(disputeId, 'verdict', { pctA: pctA, pctB: pctB, winner: winner, totalVotes: total });
  return q.verdict.get(disputeId);
});

/** Дела, где вторая сторона не ответила в срок. */
const sweepAbandoned = db.transaction(function () {
  const rows = q.staleDrafts.all(now());
  for (const d of rows) {
    db.prepare("UPDATE disputes SET status = 'abandoned' WHERE id = ?").run(d.id);
    events.publish(d.id, 'abandoned', { reason: 'opponent_timeout' });
  }
  return rows.length;
});

/**
 * Тик планировщика. Закрывает дела двумя способами: собран целевой размер жюри,
 * либо вышел дедлайн при достигнутом минимальном кворуме.
 */
function tick() {
  let closed = 0;
  const t = now();

  for (const d of q.inJury.all()) {
    const collected = q.countVotes.get(d.id).n;
    if (collected >= d.target_jury) {
      if (issueVerdict(d.id, 'quorum')) closed++;
    } else if (d.deadline_at && d.deadline_at <= t) {
      issueVerdict(d.id, 'deadline');
      closed++;
    }
  }

  const abandoned = sweepAbandoned();

  /* Просроченные выдачи дел освобождают слоты для других присяжных. */
  db.prepare(
    'DELETE FROM jury_assignments WHERE expires_at < ? AND id NOT IN (' +
    ' SELECT ja.id FROM jury_assignments ja JOIN votes v' +
    ' ON v.dispute_id = ja.dispute_id AND v.juror_id = ja.juror_id)'
  ).run(t);

  return { closed: closed, abandoned: abandoned };
}

let timer = null;
function startScheduler(intervalMs) {
  if (timer) return timer;
  timer = setInterval(function () {
    try {
      const r = tick();
      if (r.closed || r.abandoned) {
        console.log('[court] вердиктов: ' + r.closed + ', дел закрыто без ответа: ' + r.abandoned);
      }
    } catch (err) {
      console.error('[court] сбой планировщика:', err);
    }
  }, intervalMs || 15000);
  timer.unref();
  return timer;
}

module.exports = {
  targetFor: targetFor,
  deadlineFor: deadlineFor,
  quorumState: quorumState,
  openForJury: openForJury,
  issueVerdict: issueVerdict,
  refundForFailedQuorum: refundForFailedQuorum,
  topComments: function (disputeId) { return q.topComments.all(disputeId); },
  tick: tick,
  startScheduler: startScheduler
};
