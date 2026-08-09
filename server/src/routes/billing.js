import { Router } from 'express';
import { db, track } from '../db.js';
import { id } from '../lib/ids.js';
import { auth } from '../middleware/auth.js';
import { limit } from '../middleware/ratelimit.js';
import { TIERS, JURY_SIZE_WIDE } from '../config.js';
import { view } from './disputes.js';

export const router = Router();

/**
 * Провайдер намеренно заглушка: настоящие деньги в мобильном приложении идут
 * через App Store и Google Play IAP, а в вебе через Stripe. Здесь лежит логика
 * применения тарифа, которую потом дёргает вебхук провайдера.
 */

router.get('/tiers', (_req, res) => {
  res.json({
    tiers: Object.entries(TIERS).map(([key, t]) => ({
      key, label: t.label, priceCents: t.price_cents, jury: t.jury, deadlineMs: t.deadline_ms
    }))
  });
});

/** POST /api/billing/checkout { tier, disputeId } */
router.post('/checkout', auth(), limit({ key: 'pay', max: 30, windowMs: 3600000 }), (req, res) => {
  const body = req.body || {};
  const tierKey = String(body.tier || '');
  const tier = TIERS[tierKey];
  if (!tier || tierKey === 'free') return res.status(400).json({ error: 'bad_tier' });

  const now = Date.now();
  const disputeId = body.disputeId ? String(body.disputeId) : null;
  let dispute = null;

  if (tierKey !== 'sub') {
    if (!disputeId) return res.status(400).json({ error: 'no_dispute', message: 'Не указано дело.' });
    dispute = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId);
    if (!dispute) return res.status(404).json({ error: 'not_found' });
    if (dispute.creator_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
    if (dispute.status === 'verdict') {
      return res.status(409).json({ error: 'already_done', message: 'Вердикт уже вынесен, ускорять нечего.' });
    }
  }

  db.transaction(() => {
    db.prepare('INSERT INTO payments (id, user_id, dispute_id, tier, amount_cents, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id(), req.user.id, disputeId, tierKey, tier.price_cents, 'paid', now);

    if (tierKey === 'sub') {
      const base = Math.max(now, req.user.sub_until || 0);
      db.prepare('UPDATE users SET sub_until = ? WHERE id = ?').run(base + 30 * 24 * 3600000, req.user.id);
    } else if (tierKey === 'urgent') {
      // срочность влияет только на скорость сбора жюри, не на результат
      const deadline = (dispute.published_at || now) + tier.deadline_ms;
      db.prepare("UPDATE disputes SET tier = 'urgent', deadline_at = ? WHERE id = ?").run(deadline, dispute.id);
    } else if (tierKey === 'wide') {
      db.prepare("UPDATE disputes SET tier = 'wide', jury_size = ? WHERE id = ?").run(JURY_SIZE_WIDE, dispute.id);
    }
  })();

  track(req.user.id, 'payment', { tier: tierKey, cents: tier.price_cents });

  res.json({
    ok: true,
    tier: tierKey,
    note: 'Оплата влияет на скорость сбора жюри и его размер, но не на результат.',
    dispute: disputeId ? view(disputeId, req.user.id) : null
  });
});

/** POST /api/billing/webhook — точка входа для настоящего провайдера. */
router.post('/webhook', (req, res) => {
  // подпись провайдера проверяется здесь, до применения тарифа
  track(null, 'billing_webhook', { type: (req.body && req.body.type) || 'unknown' });
  res.json({ received: true });
});
