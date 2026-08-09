/**
 * Наполняет базу делами, чтобы зал жюри не был пустым на старте.
 * Важно: создаём ДЕЛА, а не голоса. Голоса накручивать нельзя,
 * иначе вердикты ничего не стоят и сторы банят за фейковую активность.
 *
 * Запуск: npm run seed
 */
import fs from 'node:fs';
import path from 'node:path';
import { db, AUDIO_DIR } from './db.js';
import { id, shortCode, anonName } from './lib/ids.js';
import { JURY_SIZE, FREE_DEADLINE_MS } from './config.js';

/** Минимальный WAV, чтобы у дел была настоящая слушаемая дорожка. */
function makeWav(seconds, freq) {
  const rate = 8000;
  const n = Math.floor(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);

  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (rate * 0.2)) * Math.min(1, (n - i) / (rate * 0.2));
    const wobble = Math.sin((2 * Math.PI * 1.7 * i) / rate) * 0.35 + 0.65;
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 7000 * env * wobble), 44 + i * 2);
  }
  return buf;
}

function writeAudio(seconds, freq) {
  const name = id() + '.wav';
  fs.writeFileSync(path.join(AUDIO_DIR, name), makeWav(seconds, freq));
  return { name, durationMs: seconds * 1000 };
}

function makeUser() {
  const { nickname, emoji } = anonName();
  const uid = id();
  db.prepare('INSERT INTO users (id, nickname, emoji, created_at) VALUES (?,?,?,?)')
    .run(uid, nickname, emoji, Date.now());
  return uid;
}

const CASES = [
  { topic: 'Читать переписку партнёра, если телефон остался открытым',
    a: 'Если бы там нечего было скрывать, ты бы не паниковал из-за одного взгляда на экран.',
    b: 'Открытый телефон это не приглашение, а доверие. Ты его только что потратила.' },
  { topic: 'Кто выносит мусор, если пакет стоит с его стороны кухни',
    a: 'Я готовил три дня подряд, мусор объективно не моя зона ответственности.',
    b: 'Пакет буквально у твоих ног, это тридцать секунд, а не подвиг.' },
  { topic: 'Отвечать на рабочие письма в оплаченном отпуске',
    a: 'Два письма за неделю никого не убили, зато проект не встал.',
    b: 'Ты обещал не открывать ноутбук. Я планировала этот отпуск полгода.' },
  { topic: 'Брать чужую зарядку без спроса, если хозяин в другой комнате',
    a: 'Пять минут, и я вернул её на то же место. Проблемы не существует.',
    b: 'Спросить занимает меньше времени, чем зарядить телефон.' },
  { topic: 'Поехать на рыбалку в годовщину, потому что путёвку купили за месяц',
    a: 'Путёвку взяли заранее, деньги бы сгорели. Годовщину перенесли на субботу.',
    b: 'Годовщина известна с прошлого года. Меня не спросили, мне сообщили.' },
  { topic: 'Приводить друзей домой без предупреждения, если живёте вдвоём',
    a: 'Это и мой дом тоже. Я не должен согласовывать каждого гостя.',
    b: 'Я вышла из душа и увидела четырёх незнакомых людей на кухне.' }
];

let made = 0;
const now = Date.now();

for (const c of CASES) {
  if (db.prepare('SELECT 1 FROM disputes WHERE topic = ?').get(c.topic)) continue;

  const ua = makeUser();
  const ub = makeUser();
  const did = id();
  const audioA = writeAudio(12, 190);
  const audioB = writeAudio(12, 240);
  const published = now - Math.floor(Math.random() * 3 * 3600000);

  db.transaction(() => {
    db.prepare("INSERT INTO disputes (id, code, topic, creator_id, status, tier, jury_size, consent_content, moderation_state, created_at, published_at, deadline_at) VALUES (?,?,?,?,'in_jury','free',?,1,'clean',?,?,?)")
      .run(did, shortCode(), c.topic, ua, JURY_SIZE, published, published, published + FREE_DEADLINE_MS);

    db.prepare("INSERT INTO sides (id, dispute_id, label, user_id, audio_file, mime, duration_ms, transcript, created_at) VALUES (?,?,'a',?,?,'audio/wav',?,?,?)")
      .run(id(), did, ua, audioA.name, audioA.durationMs, c.a, published);
    db.prepare("INSERT INTO sides (id, dispute_id, label, user_id, audio_file, mime, duration_ms, transcript, created_at) VALUES (?,?,'b',?,?,'audio/wav',?,?,?)")
      .run(id(), did, ub, audioB.name, audioB.durationMs, c.b, published);
  })();

  made++;
}

console.log(made ? 'Добавлено дел: ' + made + '. Зал жюри больше не пустой.' : 'Дела уже есть, ничего не менял.');
console.log('Голоса не засеяны специально: накрутка убивает доверие к вердиктам.');
db.close();
