'use strict';

const crypto = require('crypto');

const ANIMALS = [
  ['🦊', 'Лис'], ['🦉', 'Сова'], ['🐺', 'Волк'], ['🦡', 'Барсук'], ['🦫', 'Бобр'],
  ['🐗', 'Кабан'], ['🦔', 'Ёж'], ['🐆', 'Барс'], ['🦅', 'Орёл'], ['🐢', 'Черепаха'],
  ['🦭', 'Тюлень'], ['🦌', 'Олень'], ['🐙', 'Спрут'], ['🦇', 'Нетопырь'], ['🐈', 'Кот']
];

function id() {
  return crypto.randomUUID();
}

function token(bytes) {
  return crypto.randomBytes(bytes || 16).toString('base64url');
}

function now() {
  return Date.now();
}

function hash(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function anonHandle() {
  const pick = ANIMALS[crypto.randomInt(ANIMALS.length)];
  return { emoji: pick[0], handle: pick[1] + ' ' + crypto.randomInt(100, 999) };
}

/** Детерминированное перемешивание порядка сторон для конкретного присяжного. */
function flipFor(disputeId, jurorId) {
  const h = crypto.createHash('sha256').update(disputeId + ':' + jurorId).digest();
  return h[0] % 2;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function httpError(status, code, message) {
  const e = new Error(message || code);
  e.status = status;
  e.code = code;
  return e;
}

/** Ошибки асинхронных обработчиков уходят в error middleware, а не в пустоту. */
function wrap(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { id, token, now, hash, anonHandle, flipFor, clamp, httpError, wrap, ANIMALS };
