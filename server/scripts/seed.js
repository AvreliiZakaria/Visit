'use strict';

/**
 * Тестовые данные для разработки.
 *
 * Создаёт несколько аккаунтов и одно дело, чтобы интерфейс не был пустым.
 * Голосов не создаёт: фальшивые голоса ломают смысл продукта, поэтому
 * их нет даже в сидах. Проголосуй сам с тестовых аккаунтов.
 *
 * Аудиозаписи тоже не подделываются: их нужно записать через интерфейс.
 */

const config = require('../config');
const { db, nextDisputeNo } = require('../db');
const { id, token, now, anonHandle } = require('../lib/util');
const A = require('../lib/auth');
const court = require('../lib/court');

if (config.env === 'production') {
  console.error('Сиды в продакшене не запускаем.');
  process.exit(1);
}

const PASSWORD = 'verdict123';
const ACCOUNTS = [
  { email: 'a@verdict.local', role: 'user' },
  { email: 'b@verdict.local', role: 'user' },
  { email: 'juror1@verdict.local', role: 'user' },
  { email: 'juror2@verdict.local', role: 'user' },
  { email: 'moder@verdict.local', role: 'moderator' }
];

const created = [];

for (const acc of ACCOUNTS) {
  const exists = db.prepare('SELECT * FROM users WHERE email = ?').get(acc.email);
  if (exists) {
    created.push(exists);
    continue;
  }
  const anon = anonHandle();
  const user = {
    id: id(),
    email: acc.email,
    password_hash: A.hashPassword(PASSWORD),
    handle: anon.handle,
    emoji: anon.emoji,
    role: acc.role,
    age_confirmed: 1,
    created_at: now()
  };
  db.prepare(
    'INSERT INTO users (id, email, password_hash, handle, emoji, role, age_confirmed, created_at) ' +
    'VALUES (@id, @email, @password_hash, @handle, @emoji, @role, @age_confirmed, @created_at)'
  ).run(user);
  created.push(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id));
}

const topic = 'Нормально ли читать переписку партнёра, если телефон остался открытым';
let dispute = db.prepare('SELECT * FROM disputes WHERE topic = ?').get(topic);

if (!dispute) {
  const t = now();
  const row = {
    id: id(),
    public_no: nextDisputeNo(),
    topic: topic,
    creator_id: created[0].id,
    opponent_id: created[1].id,
    invite_token: token(12),
    tier: 'free',
    consent_content: 1,
    status: 'awaiting_opponent',
    target_jury: court.targetFor('free'),
    min_quorum: config.jury.minQuorum,
    opponent_deadline: t + config.deadlines.opponentWindowHours * 3600000,
    created_at: t
  };
  db.prepare(
    'INSERT INTO disputes (id, public_no, topic, creator_id, opponent_id, invite_token, tier, ' +
    'consent_content, status, target_jury, min_quorum, opponent_deadline, created_at) VALUES ' +
    '(@id, @public_no, @topic, @creator_id, @opponent_id, @invite_token, @tier, @consent_content, ' +
    '@status, @target_jury, @min_quorum, @opponent_deadline, @created_at)'
  ).run(row);
  dispute = db.prepare('SELECT * FROM disputes WHERE id = ?').get(row.id);
}

console.log('');
console.log('  Тестовые аккаунты созданы. Пароль у всех: ' + PASSWORD);
ACCOUNTS.forEach(function (a) { console.log('    ' + a.email + '  (' + a.role + ')'); });
console.log('');
console.log('  Заготовка дела: ' + dispute.topic);
console.log('  Ссылка для второй стороны:');
console.log('    ' + config.publicUrl + '/join.html?t=' + dispute.invite_token);
console.log('');
console.log('  Записи нужно записать вручную через интерфейс: подделывать аудио и голоса');
console.log('  этот проект не умеет принципиально.');
console.log('');
console.log('  Совет: для локальной проверки вердикта поставь JURY_MIN_QUORUM=2 в .env');
console.log('');
