'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db');
const { httpError } = require('./util');

const SESSION_MS = config.sessionDays * 24 * 60 * 60 * 1000;

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 12);
}

function checkPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function issueSession(res, user) {
  const token = jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: Math.floor(SESSION_MS / 1000)
  });
  res.cookie(config.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.env === 'production',
    maxAge: SESSION_MS,
    path: '/'
  });
  return token;
}

function clearSession(res) {
  res.clearCookie(config.cookieName, { path: '/' });
}

const findUser = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL');

/** Мягкая аутентификация: пользователь подставляется, если сессия валидна. */
function attachUser(req, _res, next) {
  const cookie = req.cookies ? req.cookies[config.cookieName] : null;
  const header = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const raw = cookie || header;
  if (!raw) return next();
  try {
    const payload = jwt.verify(raw, config.jwtSecret);
    const user = findUser.get(payload.sub);
    if (user) req.user = user;
  } catch (_) {
    /* просроченный или подделанный токен игнорируем */
  }
  next();
}

function requireUser(req, _res, next) {
  if (!req.user) return next(httpError(401, 'unauthorized', 'Нужно войти.'));
  if (req.user.banned_until && req.user.banned_until > Date.now()) {
    return next(httpError(403, 'banned', 'Доступ ограничен модерацией.'));
  }
  next();
}

function requireRole() {
  const roles = Array.prototype.slice.call(arguments);
  return function (req, _res, next) {
    if (!req.user) return next(httpError(401, 'unauthorized', 'Нужно войти.'));
    if (roles.indexOf(req.user.role) === -1) {
      return next(httpError(403, 'forbidden', 'Недостаточно прав.'));
    }
    next();
  };
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    handle: u.handle,
    emoji: u.emoji,
    role: u.role,
    juryScore: u.jury_score,
    subActive: Boolean(u.sub_until && u.sub_until > Date.now()),
    subUntil: u.sub_until || null,
    creditCents: u.credit_cents,
    createdAt: u.created_at
  };
}

module.exports = {
  hashPassword, checkPassword, issueSession, clearSession,
  attachUser, requireUser, requireRole, publicUser
};
