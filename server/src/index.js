import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, ALLOW_ORIGIN } from './config.js';
import { db } from './db.js';
import { finalizeDue } from './lib/verdict.js';

import { router as authRouter } from './routes/auth.js';
import { router as disputesRouter } from './routes/disputes.js';
import { router as juryRouter } from './routes/jury.js';
import { router as commentsRouter } from './routes/comments.js';
import { router as reportsRouter } from './routes/reports.js';
import { router as billingRouter } from './routes/billing.js';
import { router as miscRouter } from './routes/misc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = path.resolve(__dirname, '../..');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

if (ALLOW_ORIGIN) {
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    time: Date.now(),
    disputes: db.prepare('SELECT COUNT(*) AS n FROM disputes').get().n,
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n
  });
});

app.use('/api/auth', authRouter);
app.use('/api/disputes', disputesRouter);
app.use('/api/jury', juryRouter);
app.use('/api/comments', commentsRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/billing', billingRouter);
app.use('/api', miscRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'unknown_endpoint' }));

// фронтенд лежит в корне репозитория
app.use(express.static(SITE_ROOT, { extensions: ['html'], maxAge: '1h' }));
app.get('*', (_req, res) => res.sendFile(path.join(SITE_ROOT, 'index.html')));

app.use((err, _req, res, _next) => {
  const tooBig = err && err.code === 'LIMIT_FILE_SIZE';
  console.error('[error]', err && err.message);
  res.status(tooBig ? 413 : 500).json({
    error: tooBig ? 'file_too_large' : 'server_error',
    message: tooBig ? 'Запись слишком большая. Максимум минута.' : 'Что-то сломалось на сервере.'
  });
});

// планировщик: закрывает дела по кворуму и по таймауту
const tick = setInterval(() => {
  try {
    const closed = finalizeDue();
    if (closed.length) console.log('[вердикт] закрыто дел:', closed.length);
  } catch (e) {
    console.error('[вердикт] ошибка планировщика:', e.message);
  }
}, 15000);
tick.unref();

const server = app.listen(PORT, () => {
  console.log('Вердикт слушает http://localhost:' + PORT);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('останавливаюсь…');
    server.close(() => { db.close(); process.exit(0); });
  });
}
