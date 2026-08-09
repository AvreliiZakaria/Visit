/**
 * Досудебная модерация: тема спора и транскрипт.
 * Возвращает { state, reason }:
 *   clean   — можно публиковать
 *   held    — на ручной разбор, в фид жюри не попадает
 *   blocked — публикация запрещена
 *
 * Задача не поймать всё, а не пустить в фид очевидную дичь:
 * личные данные третьих лиц, доксинг, несовершеннолетние, прямые угрозы.
 */

const PATTERNS = [
  { re: /(\+?\d[\d\-\s()]{9,}\d)/, reason: 'похоже на телефон', state: 'held' },
  { re: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, reason: 'похоже на email', state: 'held' },
  { re: /\b(ул\.?|улица|проспект|пр-т|кв\.\s?\d+|дом\s\d+)\b/i, reason: 'похоже на адрес', state: 'held' },
  { re: /\b(паспорт|снилс|инн|номер карты|iban)\b/i, reason: 'документы или платёжные данные', state: 'blocked' },
  { re: /\b(убью|убить его|прирежу|найду и|сожгу|изобью)\b/i, reason: 'угроза', state: 'blocked' },
  { re: /(мне\s1[0-6]\s?лет|ей\s1[0-6]\s?лет|ему\s1[0-6]\s?лет|школьниц|несовершеннолетн)/i, reason: 'возможно несовершеннолетний', state: 'blocked' },
  { re: /(instagram\.com|vk\.com|t\.me|tiktok\.com)\/[\w.]+/i, reason: 'ссылка на профиль третьего лица', state: 'held' }
];

export function screen(text) {
  const src = String(text || '');
  if (!src.trim()) return { state: 'clean', reason: null };

  let worst = { state: 'clean', reason: null };
  for (const p of PATTERNS) {
    if (p.re.test(src)) {
      if (p.state === 'blocked') return { state: 'blocked', reason: p.reason };
      worst = { state: 'held', reason: p.reason };
    }
  }
  return worst;
}

/** Грубая чистка транскрипта перед показом присяжным. */
export function redact(text) {
  return String(text || '')
    .replace(/(\+?\d[\d\-\s()]{9,}\d)/g, '[номер скрыт]')
    .replace(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi, '[почта скрыта]');
}
