'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
require('./db');

const A = require('./lib/auth');
const court = require('./lib/court');
const { rateLimit } = require('./lib/rate');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ---------------------------------------------------------------
   Вебхук провайдера должен получить сырое тело до JSON-парсера,
   иначе подпись не сойдётся.
   --------------------------------------------------------------- */
app.post('/api/payments/webhook', express.raw({ type: '*/*', limit: '1mb' }));

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));
app.use(cookieParser());

/* Базовые заголовки безопасности. Микрофон разрешён только своему источнику. */
app.use(function (_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  next();
});

app.use(A.attachUser);
app.use('/api', rateLimit({ max: 1200, windowMs: 15 * 60 * 1000, scope: 'api' }));

/* ---------------- маршруты API ---------------- */
app.use('/api/auth', require('./routes/auth'));
app.use('/api/disputes', require('./routes/disputes'));
app.use('/api/jury', require('./routes/jury'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/moderation', require('./routes/moderation'));
app.use('/api/content', require('./routes/content'));
app.use('/api/waitlist', require('./routes/waitlist'));

app.get('/api/health', function (_req, res) {
  res.json({
    ok: true,
    env: config.env,
    payments: config.paymentsMode,
    transcription: config.transcriptionEnabled ? 'on' : 'off',
    moderation: config.moderationStrict ? 'strict' : 'lenient',
    rules: {
      juryTargetFree: config.jury.targetFree,
      juryTargetWide: config.jury.targetWide,
      minQuorum: config.jury.minQuorum,
      minListenRatio: config.jury.minListenRatio,
      minSecondsBeforeVote: config.jury.minSecondsBeforeVote
    },
    time: Date.now()
  });
});

/* ---------------- статика ---------------- */
app.use(express.static(config.root, {
  extensions: ['html'],
  setHeaders: function (res, filePath) {
    if (/\.(css|js)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));

app.use('/api', function (_req, res) {
  res.status(404).json({ error: 'not_found', message: 'Такого метода нет.' });
});

app.get('*', function (_req, res) {
  res.sendFile(path.join(config.root, 'index.html'));
});

/* ---------------- обработка ошибок ---------------- */
app.use(function (err, _req, res, _next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: 'file_too_large',
      message: 'Запись слишком большая. Шестьдесят секунд весят меньше мегабайта.'
    });
  }

  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);

  res.status(status).json({
    error: err.code || 'server_error',
    message: status >= 500 ? 'Что-то сломалось на сервере. Мы уже знаем.' : err.message
  });
});

/* ---------------- запуск ---------------- */
const server = app.listen(config.port, function () {
  console.log('');
  console.log('  Вердикт запущен');
  console.log('  Адрес:        ' + config.publicUrl);
  console.log('  База:         ' + config.dbPath);
  console.log('  Записи:       ' + config.uploadDir);
  console.log('  Платежи:      ' + config.paymentsMode +
    (config.paymentsMode === 'sandbox' ? ' (деньги не двигаются)' : ''));
  console.log('  Транскрипт:   ' + (config.transcriptionEnabled ? 'включён' : 'выключен'));
  console.log('  Жюри:         ' + config.jury.targetFree + ' целевых, минимум ' +
    config.jury.minQuorum + ' для вердикта');
  if (config.adminEmail) console.log('  Модератор:    ' + config.adminEmail);
  console.log('');
});

court.startScheduler(15000);

function shutdown(signal) {
  console.log('\n[' + signal + '] останавливаюсь.');
  server.close(function () { process.exit(0); });
  setTimeout(function () { process.exit(1); }, 8000).unref();
}
process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });

module.exports = app;
