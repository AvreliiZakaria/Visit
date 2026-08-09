import path from 'node:path';

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const PORT = num(process.env.PORT, 8080);
export const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret';
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

export const JURY_SIZE = num(process.env.JURY_SIZE, 100);
export const JURY_SIZE_WIDE = num(process.env.JURY_SIZE_WIDE, 1000);
export const MIN_QUORUM = num(process.env.MIN_QUORUM, 20);

export const FREE_DEADLINE_MS = num(process.env.FREE_DEADLINE_HOURS, 24) * 3600000;
export const URGENT_DEADLINE_MS = num(process.env.URGENT_DEADLINE_MINUTES, 30) * 60000;

export const LISTEN_THRESHOLD = num(process.env.LISTEN_THRESHOLD, 0.8);
export const MIN_DELIBERATION_MS = num(process.env.MIN_DELIBERATION_SECONDS, 15) * 1000;

export const ASSIGNMENT_TTL_MS = 15 * 60000;
export const MAX_AUDIO_BYTES = 6 * 1024 * 1024;
export const MAX_SIDE_SECONDS = 65;

export const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '';

export const TIERS = {
  free:   { price_cents: 0,   jury: JURY_SIZE,      deadline_ms: FREE_DEADLINE_MS,   label: 'Обычный суд' },
  urgent: { price_cents: 300, jury: JURY_SIZE,      deadline_ms: URGENT_DEADLINE_MS, label: 'Срочный суд' },
  wide:   { price_cents: 500, jury: JURY_SIZE_WIDE, deadline_ms: FREE_DEADLINE_MS,   label: 'Расширенное жюри' },
  sub:    { price_cents: 700, jury: JURY_SIZE,      deadline_ms: URGENT_DEADLINE_MS, label: 'Подписка' }
};
