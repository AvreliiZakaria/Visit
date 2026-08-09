'use strict';

/**
 * Ограничитель частоты в памяти. Для одного инстанса достаточно.
 * Когда появится второй сервер, ключи переезжают в Redis, интерфейс тот же.
 */

const buckets = new Map();

setInterval(function () {
  const t = Date.now();
  for (const entry of buckets) {
    if (t - entry[1].start > entry[1].windowMs * 2) buckets.delete(entry[0]);
  }
}, 60000).unref();

function limit(opts) {
  const t = Date.now();
  let b = buckets.get(opts.key);
  if (!b || t - b.start > opts.windowMs) {
    b = { start: t, count: 0, windowMs: opts.windowMs };
    buckets.set(opts.key, b);
  }
  b.count += 1;
  return {
    ok: b.count <= opts.max,
    remaining: Math.max(0, opts.max - b.count),
    resetInMs: b.windowMs - (t - b.start)
  };
}

function rateLimit(opts) {
  const scope = opts.scope || 'global';
  return function (req, res, next) {
    const who = req.user ? 'u:' + req.user.id : 'ip:' + (req.ip || 'unknown');
    const r = limit({ key: scope + ':' + who, max: opts.max, windowMs: opts.windowMs });
    res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    if (!r.ok) {
      return res.status(429).json({
        error: 'rate_limited',
        message: 'Слишком часто. Подожди немного.',
        retryInSeconds: Math.ceil(r.resetInMs / 1000)
      });
    }
    next();
  };
}

module.exports = { limit, rateLimit };
