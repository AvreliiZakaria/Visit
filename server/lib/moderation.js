'use strict';

/**
 * Модерация до публикации. Работает по транскрипту записи.
 *
 * Задача не в том, чтобы поймать грубость: люди спорят, они грубят.
 * Задача не пустить в фид то, за что снимают приложение из магазина:
 * персональные данные третьих лиц, угрозы расправы, призывы травить,
 * несовершеннолетние в недопустимом контексте.
 */

const PATTERNS = [
  { code: 'phone',   severity: 'block', label: 'номер телефона', re: /(\+?\d[\d\-\s()]{8,}\d)/g },
  { code: 'email',   severity: 'block', label: 'адрес почты',    re: /[\w.+-]+@[\w-]+\.[a-zа-я]{2,}/gi },
  { code: 'address', severity: 'block', label: 'домашний адрес', re: /\b(улица|ул\.|проспект|пр-т|переулок|шоссе|дом|кв\.|квартира)\s+[^,.;]{2,40}/gi },
  { code: 'card',    severity: 'block', label: 'номер карты',    re: /\b(?:\d[ -]?){13,19}\b/g },
  { code: 'social',  severity: 'flag',  label: 'ссылка на профиль', re: /(instagram\.com|vk\.com|t\.me|facebook\.com|tiktok\.com)\/[\w.\-]+/gi },
  { code: 'threat',  severity: 'block', label: 'угроза расправы', re: /\b(убью|прирежу|сожгу|порежу|искалечу|найду и убью)\b/gi },
  { code: 'doxx',    severity: 'block', label: 'призыв травить конкретного человека', re: /\b(вот (её|его) (номер|адрес|инстаграм)|найдите (её|его)|напишите ему все)\b/gi },
  { code: 'minor',   severity: 'block', label: 'несовершеннолетний в недопустимом контексте', re: /\b(1[0-6]|[1-9])\s*(лет|года|годика)\b[^.?!]{0,60}\b(секс|голая|голый|интим)/gi }
];

const REDACTABLE = ['phone', 'email', 'address', 'card'];

/** Маскирует персональные данные, чтобы дело можно было спасти правкой, а не удалением. */
function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const p of PATTERNS) {
    if (REDACTABLE.indexOf(p.code) === -1) continue;
    out = out.replace(p.re, '[вырезано]');
  }
  return out;
}

/**
 * @returns {{state:string, hits:Array, note:(string|null), redacted:(string|null)}}
 *   state: clean | flagged | blocked
 */
function scan(transcript, opts) {
  const o = opts || {};
  const strict = Boolean(o.strict);
  const available = o.transcriptAvailable !== false;

  if (!available) {
    return strict
      ? { state: 'flagged', hits: [], note: 'Транскрипта нет, дело ждёт ручной проверки.', redacted: null }
      : { state: 'clean', hits: [], note: 'Проверка по транскрипту не выполнялась.', redacted: null };
  }

  const text = String(transcript || '');
  const hits = [];
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m && m.length) {
      hits.push({ code: p.code, label: p.label, severity: p.severity, count: m.length });
    }
  }

  const blocked = hits.some(function (h) { return h.severity === 'block'; });
  const flagged = hits.some(function (h) { return h.severity === 'flag'; });

  return {
    state: blocked ? 'blocked' : flagged ? 'flagged' : 'clean',
    hits: hits,
    note: hits.length ? hits.map(function (h) { return h.label; }).join(', ') : null,
    redacted: blocked ? redact(text) : null
  };
}

module.exports = { scan, redact, PATTERNS };
