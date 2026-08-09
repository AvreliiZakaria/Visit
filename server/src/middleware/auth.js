import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { JWT_SECRET, ADMIN_TOKEN } from '../config.js';

export function sign(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '365d' });
}

function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  return null;
}

export function auth(required = true) {
  return (req, res, next) => {
    const token = readToken(req);
    if (!token) {
      if (!required) return next();
      return res.status(401).json({ error: 'no_token', message: 'Нужен токен. Сначала создай анонимный аккаунт.' });
    }
    try {
      const { sub } = jwt.verify(token, JWT_SECRET);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sub);
      if (!user) return res.status(401).json({ error: 'no_user', message: 'Аккаунт не найден.' });
      if (user.banned_until && user.banned_until > Date.now()) {
        return res.status(403).json({ error: 'banned', message: 'Аккаунт заблокирован.', reason: user.ban_reason });
      }
      req.user = user;
      next();
    } catch {
      if (!required) return next();
      res.status(401).json({ error: 'bad_token', message: 'Токен недействителен.' });
    }
  };
}

export function admin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(403).json({ error: 'forbidden' });
  next();
}
