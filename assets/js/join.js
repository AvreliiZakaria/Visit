/* Приглашение: гость сразу записывает ответ, аккаунт не нужен. */
(function () {
  'use strict';
  var API = window.VerdictAPI, $ = function (s) { return document.querySelector(s); };
  var token = new URLSearchParams(location.search).get('t'), dispute = null;
  function toast(msg, bad) { var t = $('#toast'); t.textContent = msg; t.className = 'toast on' + (bad ? ' bad' : ''); clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.classList.remove('on'); }, 3500); }
  function state(id) { ['loading','missing','taken','form','done'].forEach(function (k) { var el = $('#' + k); if (el) el.classList.toggle('on', k === id); }); }
  async function boot() {
    var failTimer = setTimeout(function () { if ($('#loading').classList.contains('on')) { toast('Сервер не ответил за 10 секунд.', true); state('missing'); } }, 11000);
    try {
      if (!token) throw new Error('В ссылке нет кода дела.');
      var health = await API.health(); if (!health) throw new Error('Сервер не отвечает. Открой ссылку через http://localhost:3000.');
      var preview = (await API.peekInvite(token)).dispute;
      if (!preview) throw new Error('Дело не найдено.');
      if (preview.taken || preview.status !== 'awaiting_opponent') return state('taken');
      dispute = preview; $('#joinTopic').textContent = preview.topic; state('form');
      if (!window.mountRecorder) throw new Error('Диктофон не загрузился.');
      window.mountRecorder($('#joinRecorderMount'), { label: 'Записать ответ', onDone: async function (blob, durationMs, ui) { ui.busy(true); try { await API.guestAnswer(token, blob, durationMs); state('done'); toast('Ответ отправлен в суд.'); } catch (e) { toast(e.message || 'Не отправилось.', true); ui.busy(false); } }, onError: function (msg) { toast(msg, true); } });
    } catch (e) { toast(e.message || 'Ссылка не работает.', true); state('missing'); }
    finally { clearTimeout(failTimer); }
  }
  boot();
})();
