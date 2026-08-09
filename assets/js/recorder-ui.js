/* =========================================================
   Компонент записи: таймер, живая волна по сигналу микрофона,
   прослушивание перед отправкой, отсев записей короче 10 секунд.
   Используется и в приложении, и на странице приглашения.
   ========================================================= */
(function (global) {
  'use strict';

  var MAX_MS = 60000;
  var MIN_MS = 10000;
  var BARS = 52;

  function fmt(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return '0:' + String(s).padStart(2, '0');
  }

  global.mountRecorder = function (mount, opts) {
    var o = opts || {};

    mount.innerHTML =
      '<div class="recorder">' +
      '  <div class="rec-top">' +
      '    <span class="eyebrow" data-state>Готов к записи</span>' +
      '    <span class="rec-timer mono" data-timer>0:60</span>' +
      '  </div>' +
      '  <div class="wave" data-wave aria-hidden="true"></div>' +
      '  <button class="btn btn-block" data-main type="button">' + (o.label || 'Записать аргументы') + '</button>' +
      '  <div class="rec-actions" data-actions style="display:none">' +
      '    <button class="btn btn-ghost btn-sm" data-listen type="button">Прослушать</button>' +
      '    <button class="btn btn-ghost btn-sm" data-again type="button">Записать заново</button>' +
      '    <button class="btn btn-sm" data-send type="button">Отправить</button>' +
      '  </div>' +
      '  <p class="inline-err" data-err></p>' +
      '</div>';

    var el = {
      state: mount.querySelector('[data-state]'),
      timer: mount.querySelector('[data-timer]'),
      wave: mount.querySelector('[data-wave]'),
      main: mount.querySelector('[data-main]'),
      actions: mount.querySelector('[data-actions]'),
      listen: mount.querySelector('[data-listen]'),
      again: mount.querySelector('[data-again]'),
      send: mount.querySelector('[data-send]'),
      err: mount.querySelector('[data-err]')
    };

    for (var i = 0; i < BARS; i++) el.wave.appendChild(document.createElement('i'));
    var bars = el.wave.children;
    var levels = new Array(BARS).fill(0);

    function paintIdle() {
      for (var i = 0; i < BARS; i++) bars[i].style.height = '8%';
    }
    function pushLevel(v) {
      levels.push(Math.min(1, Math.max(0.04, v * 2.4)));
      levels.shift();
      for (var i = 0; i < BARS; i++) bars[i].style.height = (levels[i] * 100) + '%';
    }
    paintIdle();

    function fail(msg) {
      el.err.textContent = msg;
      el.err.classList.add('on');
      if (typeof o.onError === 'function') o.onError(msg);
    }
    function clearErr() { el.err.classList.remove('on'); }

    var rec = new global.VerdictRecorder();
    var tick = null;
    var result = null;
    var audioEl = null;

    async function start() {
      clearErr();
      result = null;
      el.actions.style.display = 'none';
      el.wave.classList.remove('done');
      el.wave.classList.add('live');

      try {
        await rec.start(pushLevel);
      } catch (err) {
        el.wave.classList.remove('live');
        paintIdle();
        return fail(err.message);
      }

      el.state.textContent = 'Идёт запись';
      el.main.textContent = 'Стоп';
      tick = setInterval(function () {
        var left = MAX_MS - (Date.now() - rec.startedAt);
        el.timer.textContent = fmt(left);
        if (left <= 0) stop();
      }, 100);
    }

    async function stop() {
      clearInterval(tick);
      el.wave.classList.remove('live');
      var r = await rec.stop();
      if (!r) return;

      if (r.durationMs < MIN_MS) {
        paintIdle();
        el.timer.textContent = '0:60';
        el.state.textContent = 'Слишком коротко';
        el.main.textContent = o.label || 'Записать аргументы';
        return fail('Меньше 10 секунд: жюри не поймёт сути. Запиши ещё раз.');
      }

      result = r;
      el.wave.classList.add('done');
      el.state.textContent = 'Записано ' + fmt(r.durationMs);
      el.timer.textContent = fmt(r.durationMs);
      el.main.style.display = 'none';
      el.actions.style.display = 'flex';
    }

    el.main.addEventListener('click', function () {
      if (rec.rec && rec.rec.state === 'recording') stop(); else start();
    });

    el.again.addEventListener('click', function () {
      el.main.style.display = 'flex';
      el.main.textContent = o.label || 'Записать аргументы';
      start();
    });

    el.listen.addEventListener('click', function () {
      if (!result) return;
      if (audioEl) { audioEl.pause(); URL.revokeObjectURL(audioEl.src); }
      audioEl = new Audio(URL.createObjectURL(result.blob));
      audioEl.play();
    });

    var ui = {
      busy: function (on) {
        el.send.disabled = on;
        el.again.disabled = on;
        el.send.textContent = on ? 'Отправляем…' : 'Отправить';
      },
      reset: function () {
        result = null;
        paintIdle();
        el.timer.textContent = '0:60';
        el.state.textContent = 'Готов к записи';
        el.actions.style.display = 'none';
        el.main.style.display = 'flex';
        el.main.textContent = o.label || 'Записать аргументы';
        el.wave.classList.remove('done');
      },
      hasRecording: function () { return Boolean(result); }
    };

    el.send.addEventListener('click', function () {
      if (!result) return fail('Сначала запиши аргументы.');
      if (typeof o.onDone === 'function') o.onDone(result.blob, result.durationMs, ui);
    });

    return ui;
  };
})(window);
