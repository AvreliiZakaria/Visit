'use strict';

/**
 * Платежи. Два режима.
 *
 * Без STRIPE_SECRET_KEY работает песочница: покупка подтверждается локально,
 * деньги не двигаются, в таблице payments стоит provider = 'sandbox'.
 * Так можно разрабатывать и показывать продукт, ничего не подключая.
 *
 * С ключом создаётся настоящая сессия Stripe Checkout, а право пользоваться
 * покупкой выдаётся только из вебхука. Клиенту верить нельзя: в мобильном
 * приложении на iOS и Android то же самое делается через IAP и RevenueCat,
 * и там точно так же подтверждение приходит с сервера, а не из приложения.
 */

const express = require('express');
const config = require('../config');
const { db } = require('../db');
const { id, now, httpError, wrap } = require('../lib/util');
const { rateLimit } = require('../lib/rate');
const A = require('../lib/auth');
const court = require('../lib/court');
const events = require('../lib/events');

const router = express.Router();

const PRODUCTS = {
  urgent: { cents: config.prices.urgent, title: 'Срочный суд', needsDispute: true },
  wide: { cents: config.prices.wide, title: 'Расширенное жюри', needsDispute: true },
  sub: { cents: config.prices.sub, title: 'Подписка «Неограниченные споры»', needsDispute: false }
};

router.get('/catalog', function (_req, res) {
  res.json({
    mode: config.paymentsMode,
    currency: 'usd',
    products: Object.keys(PRODUCTS).map(function (key) {
      return { product: key, title: PRODUCTS[key].title, cents: PRODUCTS[key].cents };
    }),
    note: 'Оплата влияет на скорость сбора жюри и его размер, но не на результат.'
  });
});

/**
 * Выдача купленного. Единственное место, где меняются права,
 * и вызывается оно только из доверенного контекста: вебхук или песочница.
 */
const grant = db.transaction(function (payment) {
  const t = now();

  if (payment.product === 'sub') {
    const u = db.prepare('SELECT sub_until FROM users WHERE id = ?').get(payment.user_id);
    const from = u.sub_until && u.sub_until > t ? u.sub_until : t;
    db.prepare('UPDATE users SET sub_until = ? WHERE id = ?').run(from + 30 * 24 * 3600000, payment.user_id);
  }

  if (payment.product === 'urgent' && payment.dispute_id) {
    const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(payment.dispute_id);
    if (d) {
      const base = d.jury_opened_at || t;
      db.prepare('UPDATE disputes SET tier = ?, priority = 10, deadline_at = ? WHERE id = ?')
        .run('urgent', court.deadlineFor('urgent', base), d.id);
      events.publish(d.id, 'tier', { tier: 'urgent' });
    }
  }

  if (payment.product === 'wide' && payment.dispute_id) {
    db.prepare('UPDATE disputes SET tier = ?, target_jury = ? WHERE id = ?')
      .run('wide', court.targetFor('wide'), payment.dispute_id);
    events.publish(payment.dispute_id, 'tier', { tier: 'wide' });
  }

  db.prepare('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?').run('paid', t, payment.id);

  db.prepare(
    'INSERT INTO audit_log (id, actor_id, action, subject, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id(), payment.user_id, 'payment_granted', payment.id,
    JSON.stringify({ product: payment.product, provider: payment.provider }), t);
});

/* ===============================================================
   Оформление покупки
   =============================================================== */
router.post('/checkout',
  A.requireUser,
  rateLimit({ max: 30, windowMs: 60 * 60 * 1000, scope: 'checkout' }),
  wrap(async function (req, res) {
    const product = String(req.body.product || '');
    const spec = PRODUCTS[product];
    if (!spec) throw httpError(400, 'bad_product', 'Такого тарифа нет.');

    const disputeId = req.body.disputeId ? String(req.body.disputeId) : null;

    if (spec.needsDispute) {
      if (!disputeId) throw httpError(400, 'dispute_required', 'Не указано дело.');
      const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId);
      if (!d) throw httpError(404, 'not_found', 'Дело не найдено.');
      if (d.creator_id !== req.user.id && d.opponent_id !== req.user.id) {
        throw httpError(403, 'forbidden', 'Это не твоё дело.');
      }
      if (['verdict', 'expired', 'blocked'].indexOf(d.status) !== -1) {
        throw httpError(409, 'closed', 'Дело уже закрыто, платить не за что.');
      }
    }

    /* Подписка включает срочность: второй раз за то же брать деньги нельзя. */
    if (product === 'urgent' && req.user.sub_until && req.user.sub_until > now()) {
      const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(disputeId);
      const base = d.jury_opened_at || now();
      db.prepare('UPDATE disputes SET tier = ?, priority = 10, deadline_at = ? WHERE id = ?')
        .run('urgent', court.deadlineFor('urgent', base), disputeId);
      return res.json({ status: 'granted_by_subscription', message: 'Срочность уже входит в подписку.' });
    }

    const payment = {
      id: id(),
      user_id: req.user.id,
      dispute_id: disputeId,
      product: product,
      amount_cents: spec.cents,
      provider: config.paymentsMode,
      provider_ref: null,
      status: 'pending',
      created_at: now(),
      updated_at: now()
    };

    db.prepare(
      'INSERT INTO payments (id, user_id, dispute_id, product, amount_cents, provider, provider_ref, ' +
      'status, created_at, updated_at) VALUES (@id, @user_id, @dispute_id, @product, @amount_cents, ' +
      '@provider, @provider_ref, @status, @created_at, @updated_at)'
    ).run(payment);

    /* ---- накопленный кредит от невынесенных вердиктов ---- */
    if (req.user.credit_cents >= spec.cents) {
      db.prepare('UPDATE users SET credit_cents = credit_cents - ? WHERE id = ?')
        .run(spec.cents, req.user.id);
      db.prepare('UPDATE payments SET provider = ?, provider_ref = ? WHERE id = ?')
        .run('credit', 'internal_credit', payment.id);
      grant(db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id));
      return res.json({ status: 'paid_with_credit', paymentId: payment.id });
    }

    /* ---- песочница ---- */
    if (config.paymentsMode === 'sandbox') {
      grant(payment);
      return res.json({
        status: 'paid',
        mode: 'sandbox',
        paymentId: payment.id,
        warning: 'Режим песочницы: деньги не списаны. Для реальных платежей задай STRIPE_SECRET_KEY.'
      });
    }

    /* ---- настоящий Stripe Checkout ---- */
    const params = new URLSearchParams();
    params.append('mode', product === 'sub' ? 'subscription' : 'payment');
    params.append('success_url', config.publicUrl + '/app.html?paid=' + payment.id);
    params.append('cancel_url', config.publicUrl + '/app.html?canceled=1');
    params.append('client_reference_id', payment.id);
    params.append('line_items[0][quantity]', '1');
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][unit_amount]', String(spec.cents));
    params.append('line_items[0][price_data][product_data][name]', spec.title);
    if (product === 'sub') {
      params.append('line_items[0][price_data][recurring][interval]', 'month');
    }

    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.stripeKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });

    const session = await r.json();
    if (!r.ok) {
      db.prepare('UPDATE payments SET status = ?, updated_at = ? WHERE id = ?')
        .run('failed', now(), payment.id);
      console.error('[stripe] отказ:', session);
      throw httpError(502, 'provider_error', 'Платёжный провайдер не ответил. Попробуй позже.');
    }

    db.prepare('UPDATE payments SET provider_ref = ?, updated_at = ? WHERE id = ?')
      .run(session.id, now(), payment.id);

    res.json({ status: 'redirect', checkoutUrl: session.url, paymentId: payment.id });
  })
);

/* ===============================================================
   Вебхук Stripe. Единственный источник правды об оплате.
   Тело должно приходить сырым, это настроено в index.js.
   =============================================================== */
router.post('/webhook', wrap(function (req, res) {
  if (config.paymentsMode !== 'stripe') return res.json({ ignored: true });

  const crypto = require('crypto');
  const sigHeader = req.get('stripe-signature') || '';
  const raw = req.body;

  if (config.stripeWebhookSecret) {
    const parts = {};
    sigHeader.split(',').forEach(function (kv) {
      const i = kv.indexOf('=');
      if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
    const expected = crypto
      .createHmac('sha256', config.stripeWebhookSecret)
      .update(parts.t + '.' + raw.toString('utf8'))
      .digest('hex');
    const given = Buffer.from(parts.v1 || '', 'utf8');
    const mine = Buffer.from(expected, 'utf8');
    if (given.length !== mine.length || !crypto.timingSafeEqual(given, mine)) {
      return res.status(400).json({ error: 'bad_signature' });
    }
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch (_) {
    return res.status(400).json({ error: 'bad_json' });
  }

  if (event.type === 'checkout.session.completed') {
    const ref = event.data.object.client_reference_id;
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(ref);
    if (payment && payment.status === 'pending') grant(payment);
  }

  res.json({ received: true });
}));

router.get('/mine', A.requireUser, wrap(function (req, res) {
  const rows = db.prepare(
    'SELECT id, product, amount_cents, provider, status, created_at, dispute_id ' +
    'FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
  ).all(req.user.id);
  res.json({ payments: rows, creditCents: req.user.credit_cents });
}));

module.exports = router;
