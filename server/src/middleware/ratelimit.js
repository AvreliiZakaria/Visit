const buckets = new Map();

/** Простой лимитер в памяти: хватает для одного инстанса. */
export function limit({ key = 'default', max = 30, windowMs = 60000 } = {}) {
  return (req, res, next) => {
    const who = (req.user && req.user.id) || req.ip || 'anon';
    const k = key + ':' + who;
    const now = Date.now();

    let b = buckets.get(k);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(k, b);
    }
    b.count++;

    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.reset - now) / 1000)));
      return res.status(429).json({ error: 'rate_limited', message: 'Слишком часто. Подожди немного.' });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60000).unref();
