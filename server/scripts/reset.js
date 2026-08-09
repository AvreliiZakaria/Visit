'use strict';

/**
 * Полный сброс. Удаляет базу и все загруженные записи.
 * Осознанно требует подтверждения флагом, чтобы не снести данные случайно.
 *
 *   node server/scripts/reset.js --yes
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

if (process.argv.indexOf('--yes') === -1) {
  console.log('');
  console.log('  Это удалит базу и все записи безвозвратно:');
  console.log('    ' + config.dbPath);
  console.log('    ' + config.uploadDir);
  console.log('');
  console.log('  Если уверен, запусти: npm run reset -- --yes');
  console.log('');
  process.exit(1);
}

['', '-wal', '-shm', '-journal'].forEach(function (suffix) {
  const p = config.dbPath + suffix;
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log('удалено: ' + p);
  }
});

if (fs.existsSync(config.uploadDir)) {
  fs.readdirSync(config.uploadDir).forEach(function (f) {
    fs.unlinkSync(path.join(config.uploadDir, f));
  });
  console.log('очищена папка записей: ' + config.uploadDir);
}

console.log('Готово. При следующем запуске база создастся заново.');
