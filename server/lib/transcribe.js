'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Транскрибация записи. Нужна для двух вещей:
 *   1. Модерация до публикации: по звуку регулярками не поищешь.
 *   2. Сценарии коротких видео из согласованных дел.
 *
 * Без OPENAI_API_KEY возвращает состояние skipped. Это не ошибка,
 * а честный режим "транскрипта нет": дальше решает config.moderationStrict.
 */
async function transcribe(absPath, mime) {
  if (!config.transcriptionEnabled) return { text: null, state: 'skipped' };

  try {
    const buf = await fs.promises.readFile(absPath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime || 'audio/webm' }), path.basename(absPath));
    form.append('model', 'whisper-1');
    form.append('language', 'ru');

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.openaiKey },
      body: form
    });

    if (!res.ok) {
      const detail = await res.text().catch(function () { return ''; });
      console.warn('[transcribe] провайдер отказал:', res.status, detail.slice(0, 200));
      return { text: null, state: 'failed' };
    }

    const data = await res.json();
    return { text: (data.text || '').trim(), state: 'done' };
  } catch (err) {
    console.warn('[transcribe] ошибка:', err.message);
    return { text: null, state: 'failed' };
  }
}

module.exports = { transcribe };
