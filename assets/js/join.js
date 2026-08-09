/** Страница второй стороны: пришёл по ссылке, записал минуту, дело ушло жюри. */
(function () {
  'use strict';

  var API = window.VerdictAPI;
  var $ = function (s) { return document.querySelector(s); };

  var code = new URLSearchParams(location.search).get('c');
  var disputeId = null;

  var toastTimer;
  function toast(msg, bad) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('bad', !!bad);
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 3200);
  }

  function state(id) {
    ['loading', 'missing', 'taken', 'form', 'done'].forEach(function (k) {
      $('#' + k).classList.toggle('on', k === id);
    });
  }

  function mmss(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  /* --------------------------------------------------------- диктофон */

  var wave = $('#wave');
  for (var i = 0; i < 52; i++) wave.appendChild(document.createElement('i'));

  function paint(level, seed) {
    var kids = wave.children;
    for (var k = 0; k < kids.length; k++) {
      var wobble = 0.45 + Math.abs(Math.sin(k * 1.7 + (seed || 0))) * 0.55;
      kids[k].style.height = Math.max(8, level * wobble * 100) + '%';
    }
  }
  paint(0.08, 0);

  var R = {
    stream: null, mr: null, chunks: [], startedAt: 0, timer: null, raf: 0,
    ctx: null, an: null, blob: null, durationMs: 0, active: false
  };

  async function startRec() {
    try {
      R.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      $('#recErr').textContent = 'Микрофон не дали. Без записи ответить не получится.';
      $('#recErr').classList.add('on');
      return;
    }

    R.chunks = [];
    R.blob = null;
    R.mr = new MediaRecorder(R.stream);
    R.mr.ondataavailable = function (e) { if (e.data.size) R.chunks.push(e.data); };

    R.mr.onstop = function () {
      R.blob = new Blob(R.chunks, { type: R.mr.mimeType || 'audio/webm' });
      R.durationMs = Date.now() - R.startedAt;

      clearInterval(R.timer);
      cancelAnimationFrame(R.raf);
      R.stream.getTracks().forEach(function (t) { t.stop(); });
      try { R.ctx.close(); } catch (e) { /* ok */ }
      wave.classList.remove('live');

      if (R.durationMs < 10000) {
        R.blob = null;
        paint(0.08, 0);
        $('#recTimer').textContent = '0:60';
        $('#recState').textContent = 'Слишком коротко';
        $('#recLabel').textContent = 'Записать ответ';
        $('#recErr').textContent = 'Меньше 10 секунд: жюри не поймёт сути.';
        $('#recErr').classList.add('on');
        return;
      }

      wave.classList.add('done');
      paint(0.75, 1.2);
      $('#recState').textContent = 'Записано ' + mmss(R.durationMs);
      $('#recTimer').textContent = mmss(R.durationMs);
      $('#recLabel').textContent = 'Перезаписать';
      $('#recActions').hidden = false;
    };

    R.ctx = new (window.AudioContext || window.webkitAudioContext)();
    var src = R.ctx.createMediaStreamSource(R.stream);
    R.an = R.ctx.createAnalyser();
    R.an.fftSize = 512;
    src.connect(R.an);

    R.mr.start(250);
    R.startedAt = Date.now();
    R.active = true;

    $('#recErr').classList.remove('on');
    $('#recState').textContent = 'Идёт запись';
    $('#recLabel').textContent = 'Стоп';
    $('#recActions').hidden = true;
    wave.classList.add('live');
    wave.classList.remove('done');

    var buf = new Uint8Array(R.an.frequencyBinCount);
    (function draw() {
      if (!R.active) return;
      R.an.getByteTimeDomainData(buf);
      var peak = 0;
      for (var j = 0; j < buf.length; j++) peak = Math.max(peak, Math.abs(buf[j] - 128) / 128);
      paint(Math.min(1, peak * 1.7), Date.now() / 400);
      R.raf = requestAnimationFrame(draw);
    })();

    R.timer = setInterval(function () {
      var left = 60000 - (Date.now() - R.startedAt);
      $('#recTimer').textContent = mmss(Math.max(0, left));
      if (left <= 0) stopRec();
    }, 100);
  }

  function stopRec() {
    if (!R.active) return;
    R.active = false;
    try { R.mr.stop(); } catch (e) { /* ok */ }
  }

  $('#recBtn').addEventListener('click', function () {
    if (R.active) stopRec(); else startRec();
  });
  $('#reRec').addEventListener('click', startRec);
  $('#rePlay').addEventListener('click', function () {
    if (R.blob) new Audio(URL.createObjectURL(R.blob)).play();
  });

  $('#send').addEventListener('click', async function () {
    if (!R.blob) {
      $('#recErr').textContent = 'Сначала запиши ответ.';
      $('#recErr').classList.add('on');
      return;
    }

    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Отправляю…';

    try {
      await API.claim(code);
      await API.uploadSide(disputeId, 'b', R.blob, R.durationMs, '');
      state('done');
    } catch (e) {
      toast(e.message || 'Не отправилось', true);
      btn.disabled = false;
      btn.textContent = 'Отправить в суд';
    }
  });

  (async function boot() {
    var health = await API.health();
    if (!health) {
      $('#offlineBanner').classList.add('on');
      state('missing');
      return;
    }
    if (!code) return state('missing');

    try {
      await API.ensureUser();
      var d = await API.byCode(code);
      disputeId = d.id;

      if (d.taken || ['in_jury', 'verdict', 'closed'].indexOf(d.status) > -1) return state('taken');

      $('#joinTopic').textContent = d.topic;
      state('form');
    } catch (e) {
      state('missing');
    }
  })();
})();
