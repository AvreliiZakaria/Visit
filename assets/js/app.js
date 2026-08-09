/**
 * Логика живого «Вердикта». Работает только с настоящим бэкендом:
 * запись идёт с микрофона, файлы уходят на сервер, голоса пишутся в базу.
 */
(function () {
  'use strict';

  var API = window.VerdictAPI;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var S = {
    online: false,
    user: null,
    dispute: null,
    caseData: null,
    listened: { a: 0, b: 0 },
    audio: {},
    tier: 'urgent',
    tiers: [],
    payFor: null,
    pollTimer: null
  };

  /* ------------------------------------------------------------- утилиты */

  var toastTimer;
  function toast(msg, bad) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('bad', !!bad);
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 3200);
  }

  function fail(e) {
    toast((e && e.message) || 'Что-то пошло не так.', true);
    if (e) console.warn('[verdict]', e.code || '', e.message || e);
  }

  function mmss(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function ago(ts) {
    var m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return m + ' мин назад';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' ч назад';
    return Math.floor(h / 24) + ' дн назад';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function show(sel, on) {
    var el = $(sel);
    if (el) el.classList.toggle('on', !!on);
  }

  /* --------------------------------------------------------- навигация */

  var TAB = { create: 'create', invite: 'create', verdict: 'create', jury: 'jury', profile: 'profile' };

  function go(name) {
    $$('.pane').forEach(function (p) { p.classList.toggle('on', p.id === 'p-' + name); });
    $$('#rail button').forEach(function (b) { b.setAttribute('aria-current', String(b.dataset.go === name)); });
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.go === TAB[name]); });
    window.scrollTo({ top: 0, behavior: 'smooth' });

    stopPolling();
    if (name === 'jury') loadCase();
    if (name === 'verdict') loadMyCases();
    if (name === 'profile') loadProfile();
    if (name === 'invite' && S.dispute) startPolling(S.dispute.id);
  }
  $$('[data-go]').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.go); }); });

  /* --------------------------------------------------------- диктофон */

  var wave = $('#wave');
  for (var i = 0; i < 52; i++) wave.appendChild(document.createElement('i'));

  function paintWave(level, seed) {
    var kids = wave.children;
    for (var k = 0; k < kids.length; k++) {
      var wobble = 0.45 + Math.abs(Math.sin(k * 1.7 + (seed || 0))) * 0.55;
      kids[k].style.height = Math.max(8, level * wobble * 100) + '%';
    }
  }
  paintWave(0.08, 0);

  var Rec = {
    stream: null, mr: null, chunks: [], startedAt: 0, timer: null, raf: 0,
    ctx: null, analyser: null, blob: null, durationMs: 0, active: false,

    async start() {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        $('#recErr').textContent = 'Микрофон не дали. Без записи суда не будет: разреши доступ в настройках браузера.';
        $('#recErr').classList.add('on');
        return false;
      }

      this.chunks = [];
      this.blob = null;
      this.mr = new MediaRecorder(this.stream);
      this.mr.ondataavailable = function (e) { if (e.data.size) Rec.chunks.push(e.data); };
      this.mr.onstop = function () {
        Rec.blob = new Blob(Rec.chunks, { type: Rec.mr.mimeType || 'audio/webm' });
        Rec.durationMs = Date.now() - Rec.startedAt;
        Rec.cleanup();
        Rec.afterStop();
      };

      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      var src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);

      this.mr.start(250);
      this.startedAt = Date.now();
      this.active = true;

      $('#recErr').classList.remove('on');
      $('#recState').textContent = 'Идёт запись';
      $('#recLabel').textContent = 'Стоп';
      $('#recActions').hidden = true;
      wave.classList.add('live');
      wave.classList.remove('done');

      var buf = new Uint8Array(this.analyser.frequencyBinCount);
      var draw = function () {
        if (!Rec.active) return;
        Rec.analyser.getByteTimeDomainData(buf);
        var peak = 0;
        for (var j = 0; j < buf.length; j++) peak = Math.max(peak, Math.abs(buf[j] - 128) / 128);
        paintWave(Math.min(1, peak * 1.7), Date.now() / 400);
        Rec.raf = requestAnimationFrame(draw);
      };
      draw();

      this.timer = setInterval(function () {
        var left = 60000 - (Date.now() - Rec.startedAt);
        $('#recTimer').textContent = mmss(Math.max(0, left));
        if (left <= 0) Rec.stop();
      }, 100);

      return true;
    },

    stop() {
      if (!this.active) return;
      this.active = false;
      try { this.mr.stop(); } catch (e) { /* уже остановлен */ }
    },

    cleanup() {
      clearInterval(this.timer);
      cancelAnimationFrame(this.raf);
      if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
      if (this.ctx) { try { this.ctx.close(); } catch (e) { /* ok */ } }
      wave.classList.remove('live');
    },

    afterStop() {
      if (this.durationMs < 10000) {
        this.blob = null;
        paintWave(0.08, 0);
        $('#recTimer').textContent = '0:60';
        $('#recState').textContent = 'Слишком коротко';
        $('#recLabel').textContent = 'Записать аргументы';
        $('#recErr').textContent = 'Меньше 10 секунд: жюри не поймёт сути.';
        $('#recErr').classList.add('on');
        return;
      }
      wave.classList.add('done');
      paintWave(0.75, 1.2);
      $('#recState').textContent = 'Записано ' + mmss(this.durationMs);
      $('#recTimer').textContent = mmss(this.durationMs);
      $('#recLabel').textContent = 'Перезаписать';
      $('#recActions').hidden = false;
    }
  };

  $('#recBtn').addEventListener('click', function () {
    if (Rec.active) Rec.stop(); else Rec.start();
  });
  $('#reRec').addEventListener('click', function () { Rec.start(); });
  $('#rePlay').addEventListener('click', function () {
    if (!Rec.blob) return;
    new Audio(URL.createObjectURL(Rec.blob)).play();
    toast('Слушаем запись');
  });

  /* ------------------------------------------------------ создать дело */

  var topic = $('#topic');
  topic.addEventListener('input', function () {
    $('#topicCount').textContent = topic.value.length + '/90';
    $('#topicErr').classList.remove('on');
  });

  $('#submitCase').addEventListener('click', async function () {
    if (!S.online) return toast('Сервер не подключён, дело создать не получится.', true);

    var text = topic.value.trim();
    if (text.length < 8) {
      $('#topicErr').textContent = 'Тема слишком короткая: жюри не поймёт, о чём спор.';
      $('#topicErr').classList.add('on');
      return topic.focus();
    }
    if (!Rec.blob) {
      $('#recErr').textContent = 'Сначала запиши аргументы.';
      $('#recErr').classList.add('on');
      return;
    }

    var btn = this;
    var consent = $('#consent').checked;
    btn.disabled = true;
    btn.textContent = 'Отправляю…';

    try {
      var d = await API.createDispute(text, consent);
      await API.uploadSide(d.id, 'a', Rec.blob, Rec.durationMs, '');
      S.dispute = await API.dispute(d.id);
      renderInvite();
      go('invite');
      toast(consent ? 'Дело создано, согласие на контент получено' : 'Дело создано, в контент не пойдёт');
    } catch (e) {
      fail(e);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Создать дело и отправить оппоненту';
    }
  });

  /* ------------------------------------------------- вторая сторона */

  function inviteUrl(code) {
    return location.origin + location.pathname.replace(/[^/]*$/, '') + 'join.html?c=' + code;
  }

  function renderInvite() {
    var d = S.dispute;
    if (!d) return;

    $('#inviteTopic').textContent = d.topic;

    var url = inviteUrl(d.code);
    $('#inviteLink').textContent = url;
    $('#shareTg').href = 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent('Спорим? Пусть решат сто незнакомцев');
    $('#shareWa').href = 'https://wa.me/?text=' + encodeURIComponent('Спорим? Пусть решат сто незнакомцев: ' + url);

    var left = d.deadlineAt ? d.deadlineAt - Date.now() : 0;
    $('#inviteClock').textContent = left > 0 ? mmss(left) + ' до закрытия' : 'время вышло';

    $('#inviteStatus').textContent = {
      draft: 'Черновик',
      awaiting_opponent: 'Дело ждёт вторую сторону',
      in_jury: 'Дело в суде',
      verdict: 'Вердикт вынесен',
      held: 'На проверке модератора'
    }[d.status] || d.status;

    $('#parties').innerHTML = d.sides.map(function (s) {
      var tagClass = s.label === 'a' ? 'tag-a' : 'tag-b';
      var name = s.label === 'a' ? 'сторона А' : 'сторона Б';
      var right = s.recorded
        ? '<span class=mono style=\'color:var(--go-deep);font-size:.8125rem\'>готово</span>'
        : '<span class=mono style=\'color:var(--ink-3);font-size:.8125rem\'>ждём</span>';
      var body = s.recorded
        ? '<p style=\'font-weight:600;margin-top:6px\'>Записано, ' + mmss(s.durationMs || 0) + '</p>'
        : '<div class=pending><span class=spinner></span>Ждём запись</div>';
      return '<div class=party><div><span class=\'tag ' + tagClass + '\'>' + name + '</span>' + body + '</div>' + right + '</div>';
    }).join('');

    var stale = d.status === 'awaiting_opponent' && d.deadlineAt && Date.now() > d.deadlineAt;
    $('#ghostNotice').style.display = stale ? 'block' : 'none';

    if (d.status === 'in_jury' && !S.payFor) openPaywall(d.id);
  }

  $('#copyLink').addEventListener('click', function () {
    var url = $('#inviteLink').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(url).catch(function () {});
    toast('Ссылка скопирована, отправь оппоненту');
  });

  $('#shareNative').addEventListener('click', function () {
    var url = $('#inviteLink').textContent;
    if (navigator.share) navigator.share({ title: 'Вердикт', text: 'Спорим? Пусть решат сто незнакомцев', url: url });
    else toast('Скопируй ссылку и отправь вручную');
  });

  $('#publishOneSided').addEventListener('click', async function () {
    try {
      S.dispute = await API.publishOneSided(S.dispute.id);
      renderInvite();
      toast('Дело опубликовано с пометкой «одна сторона»');
    } catch (e) { fail(e); }
  });

  $('#toVerdictFromInvite').addEventListener('click', function () { go('verdict'); });

  function startPolling(disputeId) {
    stopPolling();
    S.pollTimer = setInterval(async function () {
      try {
        S.dispute = await API.dispute(disputeId);
        renderInvite();
        if (S.dispute.status === 'verdict') { stopPolling(); go('verdict'); }
      } catch (e) { stopPolling(); }
    }, 6000);
  }

  function stopPolling() {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = null;
  }

  /* -------------------------------------------------------- зал жюри */

  var PLAY_ICON = '<svg viewBox=\'0 0 16 16\' fill=currentColor aria-hidden=true><path d=\'M4 2.5v11l9-5.5z\'/></svg>';
  var PAUSE_ICON = '<svg viewBox=\'0 0 16 16\' fill=currentColor aria-hidden=true><rect x=4 y=3 width=3 height=10/><rect x=9 y=3 width=3 height=10/></svg>';

  async function loadCase() {
    if (!S.online) return;

    show('#jurySkel', true);
    show('#juryCase', false);
    show('#juryEmpty', false);
    show('#votedBox', false);
    $('#juryTag').textContent = 'загружаю';

    try {
      var c = await API.nextCase();
      if (!c) {
        show('#jurySkel', false);
        show('#juryEmpty', true);
        $('#juryTag').textContent = 'очередь пуста';
        return;
      }
      S.caseData = c;
      renderCase(c);
    } catch (e) {
      show('#jurySkel', false);
      show('#juryEmpty', true);
      fail(e);
    }
  }

  function renderCase(c) {
    S.listened = { a: 0, b: 0 };
    Object.keys(S.audio).forEach(function (k) { try { S.audio[k].pause(); } catch (e) {} });
    S.audio = {};

    $('#caseTopic').textContent = c.topic;
    $('#caseAge').textContent = (c.oneSided ? 'одна сторона · ' : '') + ago(c.publishedAt);
    $('#juryTag').textContent = 'дело на разборе';
    $('#juryComment').value = '';

    $('#caseSides').innerHTML = c.sides.map(function (s) {
      var name = s.label === 'a' ? 'сторона А' : 'сторона Б';
      var tagClass = s.label === 'a' ? 'tag-a' : 'tag-b';
      return '' +
        '<div class=\'side ' + s.label + '\'>' +
          '<div class=side-head>' +
            '<button class=play data-play=' + s.label + ' aria-label=Слушать>' + PLAY_ICON + '</button>' +
            '<div style=\'min-width:0\'>' +
              '<span class=\'tag ' + tagClass + '\'>' + name + '</span>' +
              (s.quote ? '<p class=side-quote>' + esc(s.quote) + '</p>' : '') +
            '</div>' +
          '</div>' +
          '<div class=track><b data-bar=' + s.label + '></b></div>' +
          '<div class=track-meta><span data-time=' + s.label + '>0:00</span><span>' + mmss(s.durationMs || 60000) + '</span></div>' +
        '</div>';
    }).join('');

    c.sides.forEach(function (s) {
      var a = new Audio(API.audioUrl(s.audioUrl));
      a.preload = 'metadata';

      var lastT = 0;
      var played = 0;

      a.addEventListener('timeupdate', function () {
        var dt = a.currentTime - lastT;
        if (dt > 0 && dt < 1.5) played += dt;   // прыжки по таймлайну не считаем
        lastT = a.currentTime;

        var dur = a.duration || (s.durationMs / 1000) || 60;
        S.listened[s.label] = Math.min(1, played / dur);

        var bar = $('[data-bar=' + s.label + ']');
        if (bar) bar.style.transform = 'scaleX(' + (a.currentTime / dur) + ')';
        var tm = $('[data-time=' + s.label + ']');
        if (tm) tm.textContent = mmss(a.currentTime * 1000);

        updateGate();
      });

      a.addEventListener('ended', function () { setIcon(s.label, false); });
      a.addEventListener('seeking', function () { lastT = a.currentTime; });
      a.addEventListener('error', function () { toast('Запись не загрузилась. Обнови страницу.', true); });

      S.audio[s.label] = a;
    });

    $$('[data-play]').forEach(function (b) {
      b.addEventListener('click', function () { togglePlay(b.dataset.play); });
    });

    show('#jurySkel', false);
    show('#juryCase', true);
    $('#voteGate').style.display = 'block';
    show('#votedBox', false);
    updateGate();
  }

  function setIcon(side, playing) {
    var btn = $('[data-play=' + side + ']');
    if (!btn) return;
    btn.classList.toggle('playing', playing);
    btn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  }

  function togglePlay(side) {
    var a = S.audio[side];
    if (!a) return;

    Object.keys(S.audio).forEach(function (k) {
      if (k !== side) { S.audio[k].pause(); setIcon(k, false); }
    });

    if (a.paused) { a.play(); setIcon(side, true); }
    else { a.pause(); setIcon(side, false); }
  }

  function updateGate() {
    var c = S.caseData;
    if (!c) return;

    var need = c.listenThreshold || 0.8;
    var servedAt = c.expiresAt - 15 * 60000;
    var waited = (Date.now() - servedAt) >= (c.minDeliberationMs || 15000);
    var enough = S.listened.a >= need && S.listened.b >= need;
    var ok = enough && waited;

    ['a', 'b'].forEach(function (k) {
      var btn = $('[data-vote=' + k + ']');
      if (!btn) return;
      btn.disabled = !ok;
      btn.querySelector('small').textContent = 'слушал ' + Math.round((S.listened[k] || 0) * 100) + '%';
    });

    $('#gateHint').textContent = enough
      ? (waited ? 'Обе стороны выслушаны. Решай.' : 'Не спеши: голоса быстрее 15 секунд сервер не принимает.')
      : 'Голос откроется, когда прослушаешь обе стороны на ' + Math.round(need * 100) + '%';
  }

  $$('[data-vote]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      if (!S.caseData) return;
      Object.keys(S.audio).forEach(function (k) { S.audio[k].pause(); setIcon(k, false); });

      btn.disabled = true;
      try {
        await API.vote(S.caseData.assignmentId, {
          side: btn.dataset.vote,
          listenedA: S.listened.a,
          listenedB: S.listened.b,
          comment: $('#juryComment').value.trim()
        });
        $('#voteGate').style.display = 'none';
        show('#votedBox', true);
        $('#juryTag').textContent = 'голос учтён';
      } catch (e) {
        fail(e);
        updateGate();
      }
    });
  });

  $('#nextCase').addEventListener('click', loadCase);
  $('#retryJury').addEventListener('click', loadCase);

  $('#skipCase').addEventListener('click', async function () {
    if (!S.caseData) return;
    try { await API.skipCase(S.caseData.assignmentId); } catch (e) { /* вернётся по таймауту */ }
    loadCase();
  });

  $('#reportCase').addEventListener('click', async function () {
    if (!S.caseData) return;
    var reason = prompt('Причина: доксинг, травля, несовершеннолетний, персональные данные, спам, другое', 'персональные данные');
    if (!reason) return;
    try {
      var r = await API.report({ targetType: 'dispute', targetId: S.caseData.disputeId, reason: reason.trim() });
      toast(r.autoHidden ? 'Жалоба принята, дело снято до разбора' : 'Жалоба принята, модератор посмотрит');
      loadCase();
    } catch (e) { fail(e); }
  });

  /* -------------------------------------------------------- мои дела */

  async function loadMyCases() {
    if (!S.online) return;

    var box = $('#caseList');
    box.innerHTML = '<div class=skel><i style=\'width:60%\'></i><i style=\'width:80%\'></i></div>';

    try {
      var r = await API.myDisputes();
      if (!r.disputes.length) {
        box.innerHTML = '<p class=small>Дел пока нет. Создай первое во вкладке «Создать спор».</p>';
        $('#caseDetail').innerHTML = '';
        return;
      }

      box.innerHTML = r.disputes.map(function (d) {
        var label = {
          draft: 'черновик', awaiting_opponent: 'ждёт оппонента', in_jury: 'в суде',
          verdict: 'вердикт', held: 'на проверке', closed: 'закрыто'
        }[d.status] || d.status;

        var res = d.verdict
          ? (d.verdict.myResult === 'win'
              ? '<span class=\'res w\'>победа</span>'
              : d.verdict.myResult === 'loss'
                ? '<span class=\'res l\'>проигрыш</span>'
                : '<span class=res>ничья</span>')
          : '<span class=res style=\'color:var(--ink-3)\'>' + d.quorum.collected + '/' + d.quorum.needed + '</span>';

        return '<button class=hist data-case=' + d.id + '><p>' + esc(d.topic) + '</p><span>' + res +
               ' <span class=\'muted mono\' style=\'font-size:.6875rem\'>' + label + '</span></span></button>';
      }).join('');

      $$('[data-case]', box).forEach(function (b) {
        b.addEventListener('click', function () { openCase(b.dataset.case); });
      });

      openCase(r.disputes[0].id);
    } catch (e) { fail(e); }
  }

  async function openCase(id) {
    try {
      var d = await API.dispute(id);
      S.dispute = d;
      var box = $('#caseDetail');

      if (d.status !== 'verdict') {
        var pct = d.quorum.needed ? Math.min(1, d.quorum.collected / d.quorum.needed) : 0;
        box.innerHTML = '' +
          '<span class=eyebrow>Собрано присяжных</span>' +
          '<p class=\'quorum-num mono\' style=\'margin-top:8px\'>' + d.quorum.collected + ' <span>из ' + d.quorum.needed + '</span></p>' +
          '<div class=qtrack><b style=\'transform:scaleX(' + pct + ')\'></b></div>' +
          '<p class=small style=\'margin-top:16px;max-width:56ch\'>Время вердикта не обещаем, пока жюри не набрано. Голоса живые, накрутки нет: одна фальшивая цифра убивает доверие ко всем вердиктам сразу.</p>' +
          (d.status === 'in_jury' ? '<div style=\'margin-top:24px\'><button class=btn id=speedUp>Ускорить сбор жюри</button></div>' : '') +
          (d.status === 'held' ? '<div class=notice><strong>Дело на ручной проверке</strong><p class=small>Причина: ' + esc(d.moderationReason || 'нужен разбор модератора') + '</p></div>' : '') +
          (d.status === 'awaiting_opponent' ? '<div style=\'margin-top:24px\'><button class=\'btn btn-ghost\' id=backToInvite>Ссылка для оппонента</button></div>' : '');

        if ($('#speedUp')) $('#speedUp').addEventListener('click', function () { openPaywall(d.id); });
        if ($('#backToInvite')) $('#backToInvite').addEventListener('click', function () { renderInvite(); go('invite'); });
        return;
      }

      var v = d.verdict;
      var stampClass = v.myResult === 'win' ? 'stamp win' : 'stamp';
      var stampText = v.winner === 'tie' ? 'Ничья' : (v.winner === 'a' ? 'Права сторона А' : 'Права сторона Б');

      box.innerHTML = '' +
        '<span class=eyebrow>Вердикт · ' + v.totalVotes + ' присяжных</span>' +
        '<div class=vsplit><i class=sa></i><i class=sb></i></div>' +
        '<div class=vnums><span class=na>' + v.pctA + '%</span><span class=nb>' + v.pctB + '%</span></div>' +
        '<div class=\'' + stampClass + '\'>' + stampText + '</div>' +
        (v.myResult === 'loss' ? '<p class=small style=\'margin-top:14px\'>Бейдж по этому делу висит в профиле 30 дней.</p>' : '') +
        '<hr class=divider><span class=eyebrow>Комментарии присяжных</span><div id=commentBox></div>';

      requestAnimationFrame(function () {
        var sa = $('.vsplit .sa', box);
        var sb = $('.vsplit .sb', box);
        if (sa) sa.style.transform = 'scaleX(' + (v.pctA / 100) + ')';
        if (sb) sb.style.transform = 'scaleX(' + (v.pctB / 100) + ')';
      });

      loadComments(d.id);
    } catch (e) { fail(e); }
  }

  async function loadComments(disputeId) {
    var box = $('#commentBox');
    if (!box) return;

    try {
      var r = await API.comments(disputeId);
      if (!r.comments.length) {
        box.innerHTML = '<p class=small style=\'margin-top:12px\'>Присяжные промолчали.</p>';
        return;
      }

      box.innerHTML = r.comments.map(function (c) {
        return '<div class=tc><button class=tc-up data-up=' + c.id + '><span>▲</span><span class=mono>' + c.upvotes + '</span></button>' +
               '<div><p>' + esc(c.body) + '</p><p class=tc-who>' + esc(c.emoji + ' ' + c.nickname) + '</p></div></div>';
      }).join('');

      $$('[data-up]', box).forEach(function (b) {
        b.addEventListener('click', async function () {
          try {
            var r2 = await API.upvote(b.dataset.up);
            b.querySelector('.mono').textContent = r2.upvotes;
          } catch (e) { fail(e); }
        });
      });
    } catch (e) {
      box.innerHTML = '<p class=small style=\'margin-top:12px\'>Комментарии откроются вместе с вердиктом.</p>';
    }
  }

  $('#refreshCases').addEventListener('click', loadMyCases);

  /* --------------------------------------------------------- профиль */

  async function loadProfile() {
    if (!S.online) return;

    try {
      var r = await API.me();
      var u = r.user;

      $('#profileName').textContent = u.emoji + ' ' + u.nickname;
      $('#levelTag').textContent = 'судья ' + u.juryLevel + ' уровня';

      $('#profileRecord').innerHTML = '' +
        '<div><b class=mono>' + u.wins + '</b><span class=eyebrow>побед</span></div>' +
        '<div><b class=mono style=\'color:var(--a)\'>' + u.losses + '</b><span class=eyebrow>поражений</span></div>' +
        '<div><b class=mono>' + u.casesJudged + '</b><span class=eyebrow>дел отсужено</span></div>';

      $('#profileBadges').innerHTML = r.badges.length
        ? r.badges.map(function (b) {
            return '<span class=\'bdg ' + (b.kind === 'loss' ? 'loss' : '') + '\'>' + esc(b.label) + '</span>';
          }).join('')
        : '<span class=muted>Пока чисто. Проиграешь дело, появится первый.</span>';

      $('#profileHistory').innerHTML = r.history.length
        ? r.history.map(function (h) {
            var res = h.result === 'win'
              ? '<span class=\'res w\'>' + h.myPct + '% · победа</span>'
              : h.result === 'loss'
                ? '<span class=\'res l\'>' + h.myPct + '% · проигрыш</span>'
                : '<span class=res style=\'color:var(--ink-3)\'>ждёт кворума</span>';
            return '<button class=hist data-hist=' + h.id + '><p>' + esc(h.topic) + '</p>' + res + '</button>';
          }).join('')
        : '<p class=small>Споров ещё не было.</p>';

      $$('[data-hist]').forEach(function (b) {
        b.addEventListener('click', function () { go('verdict'); openCase(b.dataset.hist); });
      });

      if (u.subscriber) $('#openSub').textContent = 'Подписка активна';
    } catch (e) { fail(e); }
  }

  $('#openSub').addEventListener('click', function () { openPaywall(null, 'sub'); });

  $('#wipeMe').addEventListener('click', async function () {
    if (!confirm('Обезличить аккаунт? Бейджи и история исчезнут, отменить нельзя.')) return;
    try {
      var r = await API.deleteMe();
      toast(r.note);
      localStorage.removeItem('verdict_token');
      setTimeout(function () { location.reload(); }, 1200);
    } catch (e) { fail(e); }
  });

  /* -------------------------------------------------------- пейволл */

  var LABELS = {
    urgent: { name: 'Срочный суд', note: 'Вердикт за 30 минут, дело поднимается в начало очереди жюри', flag: 'импульс' },
    wide: { name: 'Расширенное жюри', note: 'До 1000 голосов. Для дел, где «сто человек это мало»' },
    sub: { name: 'Подписка', note: 'Неограниченные споры, срочность включена' }
  };

  async function openPaywall(disputeId, forceTier) {
    S.payFor = disputeId;
    if (forceTier) S.tier = forceTier;

    if (!S.tiers.length) {
      try { S.tiers = (await API.tiers()).tiers; } catch (e) { return fail(e); }
    }

    $('#sheetKicker').textContent = disputeId ? 'Дело готово к суду' : 'Подписка';

    $('#tierList').innerHTML = S.tiers.filter(function (t) {
      return t.key !== 'free' && (disputeId ? true : t.key === 'sub');
    }).map(function (t) {
      var meta = LABELS[t.key] || { name: t.label, note: '' };
      var price = t.key === 'sub' ? (t.priceCents / 100) + ' $/мес' : (t.priceCents / 100) + ' $';
      return '<button class=\'tier ' + (t.key === S.tier ? 'sel' : '') + '\' data-tier=' + t.key + '>' +
        (meta.flag ? '<span class=flag>' + meta.flag + '</span>' : '') +
        '<b>' + meta.name + '</b><span class=price>' + price + '</span>' +
        '<small>' + meta.note + '</small></button>';
    }).join('');

    $$('#tierList .tier').forEach(function (t) {
      t.addEventListener('click', function () {
        $$('#tierList .tier').forEach(function (x) { x.classList.remove('sel'); });
        t.classList.add('sel');
        S.tier = t.dataset.tier;
      });
    });

    $('#scrim').classList.add('on');
    $('#sheet').classList.add('on');
  }

  function closePaywall() {
    $('#scrim').classList.remove('on');
    $('#sheet').classList.remove('on');
  }

  $('#scrim').addEventListener('click', closePaywall);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePaywall(); });
  $('#skipPay').addEventListener('click', function () { closePaywall(); go('verdict'); });

  $('#buy').addEventListener('click', async function () {
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Оплата…';

    try {
      var r = await API.checkout(S.tier, S.payFor);
      closePaywall();
      toast(r.note);
      if (S.tier === 'sub') { loadProfile(); }
      else { go('verdict'); if (S.payFor) openCase(S.payFor); }
    } catch (e) {
      fail(e);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Оплатить';
    }
  });

  /* ------------------------------------------------------------ старт */

  (async function boot() {
    var health = await API.health();
    if (!health) {
      $('#offlineBanner').classList.add('on');
      $('#envTag').textContent = 'офлайн';
      $('#whoAmI').textContent = 'сервер не подключён';
      return;
    }

    S.online = true;
    $('#envTag').textContent = 'сервер на связи';

    try {
      S.user = await API.ensureUser();
      $('#whoAmI').innerHTML = S.user.emoji + ' <b>' + esc(S.user.nickname) + '</b>';
    } catch (e) {
      fail(e);
      return;
    }

    var screen = new URLSearchParams(location.search).get('screen');
    if (screen && ['create', 'invite', 'jury', 'verdict', 'profile'].indexOf(screen) > -1) go(screen);
  })();
})();
