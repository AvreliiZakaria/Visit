/* Страница второй стороны: token t, вход, запись и отправка в живой API. */
(function () {
  'use strict';
  var API = window.VerdictAPI;
  var $ = function (s) { return document.querySelector(s); };
  var token = new URLSearchParams(location.search).get('t');
  var dispute = null;
  function toast(msg, bad) { var t = $('#toast'); t.textContent = msg; t.className = 'toast on' + (bad ? ' bad' : ''); clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.classList.remove('on'); }, 3200); }
  function state(id) { ['loading','missing','taken','form','done'].forEach(function (k) { $('#' + k).classList.toggle('on', k === id); }); }

  async function boot() {
    if (!token) return state('missing');
    try {
      if (!await API.health()) throw new Error('Сервер не отвечает. Открой ссылку через http://localhost:3000.');
      var preview = (await API.peekInvite(token)).dispute;
      if (!preview || preview.taken || preview.status !== 'awaiting_opponent') return state('taken');
      var me = (await API.me()).user;
      if (!me) {
        location.href = 'login.html?mode=register&next=' + encodeURIComponent('join.html?t=' + token);
        return;
      }
      await API.acceptInvite(token);
      dispute = preview;
      $('#joinTopic').textContent = preview.topic;
      state('form');
      if (!window.mountRecorder) throw new Error('Диктофон не загрузился.');
      window.mountRecorder($('#joinRecorderMount'), { label: 'Записать ответ', onDone: async function (blob, durationMs, ui) {
        ui.busy(true);
        try { await API.uploadSide(dispute.id, blob, durationMs); state('done'); }
        catch (e) { toast(e.message || 'Не отправилось.', true); ui.busy(false); }
      }, onError: function (msg) { toast(msg, true); } });
    } catch (e) { toast(e.message || 'Ссылка не работает.', true); state('missing'); }
  }
  boot();
})();
