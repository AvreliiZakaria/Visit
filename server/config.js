'use strict';

require('dotenv').config();

const path = require('path');

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}
function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

const root = path.resolve(__dirname, '..');

const config = {
  root,
  env: process.env.NODE_ENV || 'development',
  port: num('PORT', 3000),
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),

  jwtSecret: process.env.JWT_SECRET || '',
  cookieName: 'verdict_session',
  sessionDays: 30,

  dbPath: path.resolve(root, process.env.DB_PATH || './data/verdict.sqlite'),
  uploadDir: path.resolve(root, process.env.UPLOAD_DIR || './uploads'),
  maxAudioBytes: num('MAX_AUDIO_MB', 8) * 1024 * 1024,

  jury: {
    targetFree: num('JURY_TARGET_FREE', 100),
    targetWide: num('JURY_TARGET_WIDE', 1000),
    minQuorum: num('JURY_MIN_QUORUM', 30),
    minSecondsBeforeVote: num('MIN_SECONDS_BEFORE_VOTE', 15),
    minListenRatio: num('MIN_LISTEN_RATIO', 0.8),
    assignmentTtlMinutes: 30
  },

  deadlines: {
    freeHours: num('DEADLINE_FREE_HOURS', 24),
    urgentMinutes: num('DEADLINE_URGENT_MINUTES', 30),
    opponentWindowHours: num('OPPONENT_WINDOW_HOURS', 24)
  },

  openaiKey: process.env.OPENAI_API_KEY || '',
  moderationStrict: bool('MODERATION_STRICT', false),

  stripeKey: process.env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  prices: {
    urgent: num('PRICE_URGENT_CENTS', 300),
    wide: num('PRICE_WIDE_CENTS', 500),
    sub: num('PRICE_SUB_CENTS', 700)
  },

  adminEmail: (process.env.ADMIN_EMAIL || '').trim().toLowerCase()
};

config.paymentsMode = config.stripeKey ? 'stripe' : 'sandbox';
config.transcriptionEnabled = Boolean(config.openaiKey);

if (!config.jwtSecret) {
  if (config.env === 'production') {
    console.error('[config] JWT_SECRET не задан. В продакшене это недопустимо.');
    process.exit(1);
  }
  config.jwtSecret = 'dev-only-insecure-secret-change-me';
  console.warn('[config] JWT_SECRET не задан, использую небезопасный ключ для разработки.');
}

module.exports = config;
