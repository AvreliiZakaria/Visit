import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { JWT_SECRET } from '../config.js';

export const id = () => randomUUID();

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function shortCode(len = 8) {
  const b = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[b[i] % ALPHABET.length];
  return out.slice(0, 4) + '-' + out.slice(4);
}

export function hashDevice(deviceId) {
  if (!deviceId) return null;
  return createHmac('sha256', JWT_SECRET).update(String(deviceId)).digest('hex').slice(0, 32);
}

const ANIMALS = ['Лис', 'Барсук', 'Филин', 'Ёж', 'Выдра', 'Сокол', 'Бобр', 'Рысь', 'Кабан', 'Тюлень', 'Дрозд', 'Хорёк'];
const EMOJI = ['🦊', '🦡', '🦉', '🦔', '🦦', '🦅', '🦫', '🐆', '🐗', '🦭', '🐦', '🦨'];

export function anonName() {
  const i = Math.floor(Math.random() * ANIMALS.length);
  const n = 100 + Math.floor(Math.random() * 900);
  return { nickname: ANIMALS[i] + ' ' + n, emoji: EMOJI[i] };
}
