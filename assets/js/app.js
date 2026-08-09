/* =========================================================
   Приложение «Вердикт». Работает на реальном API.
   Никаких вымышленных данных: всё, что видно на экране,
   пришло с сервера.
   ========================================================= */
(function () {
  'use strict';

  var API = window.VerdictAPI;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var S = {
    me: null,
    stats: null,
    badges: [],
    screen: 'create',
    cases: [],
    openCase: null,
    stream: null,
    jury: null,
    listen: { a: 0, b: 0 },
    players: {},
    tier: 'urgent',
    rules: { minListenRatio: 0.8, minSecondsBeforeVote: 15 },
    voted: false
  };

  /* ---------------- мелочи ---------------- */
  var toastTimer;
  function toast(text, bad) {
    var t = $('#toast');
    t.textContent = text;
    t.className = 'toast on' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, bad ? 4200 : 2800);
  }
  function fmtSec(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function money(cents) { return (cents / 100).toFixed(2) + ' $'; }
  function esc(str) {
    return String(str).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var STATUS_RU = {
    awaiting_opponent: 'ждёт вторую сторону',
    held: 'на проверке модерации',
    in_jury: 'идёт сбор жюри',
    verdict: 'вердикт вынесен',
    expired: 'закрыто без вердикта',
    blocked: 'заблокировано',
    abandoned: 'оппонент не ответил'
  };

  /* ---------------- навигация ---------------- */
  var TAB = { create: 'create', cases: 'cases', jury: 'jury', profile: 'cases' };
  function go(name) {
    S.screen = name;
    $$('.pane').forEach(function (p) { p.classList.toggle('on', p.id === 'p-' + name); });
    $$('#rail button').forEach(function (b) { b.setAttribute('aria-current', String(b.dataset.go === name)); });
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.go === TAB[name]); });
    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (name === 'cases') loadCases();
    if (name === 'jury') loadNextCase();
    if (name === 'profile') loadProfile();
  }
  $$('[data-go]').forEach(function (b) {
    b.addEventListener('click', function () { go(b.dataset.go); });
  });

  /* =========================================================
     Запуск: без сессии сразу на вход
     ========================================================= */
  (async function boot() {
    var health = null;
    try {
      health = await API.health();
    } catch (_) {
      document.body.innerHTML =
        '<div style="max-width:52ch;margin:15vh auto;padding:24px;font-family:system-ui">' +
        '<h1 style="font-size:1.5rem;margin:0 0 12px">Бэкенд не запущен</h1>' +
        '<p style="color:#555;line-height:1.6">Это приложение работает только вместе с сервером. ' +
        'В папке проекта выполни <code>npm install</code>, затем <code>npm start</code>, ' +
        'и открой <code>http://localhost:3000/app.html</code>.</p>' +
        '<p style="color:#555;line-height:1.6">Открытый как файл или на GitHub Pages, он работать не будет: ' +
        'записи, голоса и вердикты живут на сервере.</p></div>';
      return;
    }

    if (health.rules) {
      S.rules.minListenRatio = health.rules.minListenRatio;
      S.rules.minSecondsBeforeVote = health.rules.minSecondsBeforeVote;
    }
    if (health.payments === 'sandbox') {
      var tag = $('#modeTag');
      tag.hidden = false;
      tag.textContent = 'песочница';
      tag.classList.add('sandbox');
      $('#payFine').textContent = 'Режим песочницы: покупка подтверждается локально, деньги не списываются. ' +
        'Для настоящих платежей задай STRIPE_SECRET_KEY в .env.';
    } else {
      $('#payFine').textContent = 'Оплата влияет на скорость сбора жюри и его размер, но не на результат. ' +
        'Если кворум не соберётся, деньги возвращаются на счёт автоматически.';
    }

    var res = await API.me();
    if (!res.user) {
      location.href = 'login.html?next=' + encodeURIComponent('app.html' + location.hash);
      return;
    }

    S.me = res.user;
    S.stats = res.stats;
    S.badges = res.badges || [];
    $('#whoami').textContent = S.me.emoji + ' ' + S.me.handle;
    $('#juryScore').textContent = 'отсужено дел: ' + (res.stats ? res.stats.judged : 0);

    mountCreateRecorder();

    /* Ссылка вида app.html#d=<id> открывает конкретное дело */
    var m = /#d=([\w-]+)/.exec(location.hash);
    if (m) {
      go('cases');
      openCase(m[1]);
    }
  })();

  $('#logout').addEventListener('click', async function () {
    await API.logout();
    location.href = 'index.html';
  });

  /* =========================================================
     01. Создание дела
     ========================================================= */
  var topicEl = $('#topic');
  topicEl.addEventListener('input', function () {
    $('#topicCount').textContent = topicEl.value.length + '/90';
    if (topicEl.value.trim().length >= 8) $('#topicErr').classList.remove('on');
  });

  function mountCreateRecorder() {
    window.mountRecorder($('#recorderMount'), {
      label: 'Записать аргументы',
      onDone: async function (blob, durationMs, ui) {
        var topic = topicEl.value.replace(/\s+/g, ' ').trim();
        if (topic.length < 8) {
          $('#topicErr').classList.add('on');
          topicEl.focus();
          return toast('Сначала опиши спор.', true);
        }

        ui.busy(true);
        try {
          var created = await API.createDispute(topic, $('#consent').checked);
          await API.uploadSide(created.dispute.id, blob, durationMs);
          toast('Дело создано. Осталось позвать оппонента.');
          topicEl.value = '';
          $('#topicCount').textContent = '0/90';
          $('#consent').checked = false;
          ui.reset();
          go('cases');
          openCase(created.dispute.id);
        } catch (err) {
          toast(err.message, true);
        } finally {
          ui.busy(false);
        }
      },
      onError: function (msg) { toast(msg, true); }
    });
  }

  /* =========================================================
     02. Мои дела
     ========================================================= */
  async function loadCases() {
    if (S.openCase) return;
    var mount = $('#casesList');
    try {
      var res = await API.myDisputes();
      S.cases = res.disputes;
    } catch (err) {
      mount.innerHTML = '<p class="muted">' + esc(err.message) + '</p>';
      return;
    }

    if (!S.cases.length) {
      mount.innerHTML =
        '<p class="small" style="max-width:48ch">Дел пока нет. Создай первый спор: тема, минута голосом, ' +
        'ссылка оппоненту.</p>' +
        '<div class="chips"><button class="chip" data-go="create">Создать спор</button></div>';
      $$('[data-go]', mount).forEach(function (b) {
        b.addEventListener('click', function () { go(b.dataset.go); });
      });
      return;
    }

    mount.innerHTML = S.cases.map(function (d) {
      var right = d.verdict
        ? d.verdict.pctA + ' / ' + d.verdict.pctB
        : d.quorum && d.status === 'in_jury'
          ? d.quorum.collected + ' из ' + d.quorum.target
          : STATUS_RU[d.status] || d.status;
      return '<button class="hist" data-open="' + d.id + '">' +
        '<p>' + esc(d.topic) + '</p>' +
        '<span class="res">' + esc(right) + '</span></button>';
    }).join('');

    $$('[data-open]', mount).forEach(function (b) {
      b.addEventListener('click', function () { openCase(b.dataset.open); });
    });
  }
  $('#refreshCases').addEventListener('click', function () {
    S.openCase = null;
    closeStream();
    $('#caseDetail').style.display = 'none';
    $('#casesList').style.display = 'block';
    loadCases();
  });
  $('#backToList').addEventListener('click', function () {
    S.openCase = null;
    closeStream();
    $('#caseDetail').style.display = 'none';
    $('#casesList').style.display = 'block';
    history.replaceState(null, '', 'app.html');
    loadCases();
  });

  function closeStream() {
    if (S.stream) { S.stream.close(); S.stream = null; }
  }

  async function openCase(id) {
    var d;
    try {
      d = (await API.getDispute(id)).dispute;
    } catch (err) {
      return toast(err.message, true);
    }

    S.openCase = d;
    history.replaceState(null, '', 'app.html#d=' + d.id);
    $('#casesList').style.display = 'none';
    $('#caseDetail').style.display = 'block';

    $('#dNo').textContent = 'Дело № ' + d.no;
    $('#dStatus').textContent = STATUS_RU[d.status] || d.status;
    $('#dTopic').textContent = d.topic;

    $('#blockInvite').style.display = d.status === 'awaiting_opponent' ? 'block' : 'none';
    $('#blockQuorum').style.display = (d.status === 'in_jury' || d.status === 'held') ? 'block' : 'none';
    $('#blockVerdict').style.display = d.verdict ? 'block' : 'none';
    $('#blockExpired').style.display = (d.status === 'expired' || d.status === 'abandoned' || d.status === 'blocked') ? 'block' : 'none';

    if (d.status === 'awaiting_opponent') {
      $('#inviteUrl').textContent = d.inviteUrl || (location.origin + '/join.html');
      var late = d.opponentDeadline && d.opponentDeadline < Date.now();
      $('#ghostNotice').style.display = late ? 'block' : 'none';
    }

    if (d.status === 'in_jury' || d.status === 'held') {
      paintQuorum(d.quorum, d.status);
      closeStream();
      S.stream = API.streamDispute(d.id, {
        quorum: function (q) { paintQuorum(q, 'in_jury'); },
        verdict: function () { openCase(d.id); },
        expired: function () { openCase(d.id); },
        status: function () { openCase(d.id); },
        tier: function () { openCase(d.id); }
      });
    }

    if (d.verdict) paintVerdict(d);

    if (d.status === 'expired') {
      $('#expiredText').textContent =
        'Жюри не собралось до дедлайна, поэтому вердикт не выносился. Платежи за это дело ' +
        'возвращены на твой счёт: обещали не брать деньги без результата, значит не берём.';
    } else if (d.status === 'abandoned') {
      $('#expiredText').textContent = 'Вторая сторона не ответила в отведённое время, дело закрыто.';
    } else if (d.status === 'blocked') {
      $('#expiredText').textContent =
        'Дело заблокировано модерацией. Чаще всего причина в личных данных третьих лиц ' +
        'или в угрозах внутри записи.';
    }
  }

  function paintQuorum(q, status) {
    if (!q) return;
    $('#qNow').textContent = q.collected;
    $('#qTarget').textContent = q.target;
    $('#qBar').style.transform = 'scaleX(' + Math.min(1, q.collected / q.target) + ')';

    var note;
    if (status === 'held') {
      note = 'Дело на проверке модерации. Присяжные его пока не видят.';
    } else if (q.collected < q.minQuorum) {
      note = 'Минимум для вердикта: ' + q.minQuorum + ' голосов. Пока их меньше, ' +
        'время вердикта мы не обещаем и голоса не накручиваем.';
    } else {
      var left = q.deadlineAt ? Math.max(0, q.deadlineAt - Date.now()) : 0;
      note = 'Кворума уже хватает для вердикта. Дожидаемся ' + q.target +
        ' голосов или дедлайна: осталось ' + fmtSec(left) + '.';
    }
    $('#qNote').textContent = note;
  }

  async function paintVerdict(d) {
    var v = d.verdict;
    $('#vLabel').textContent = 'Вердикт · ' + v.totalVotes + ' присяжных';

    requestAnimationFrame(function () {
      $('#barA').style.transform = 'scaleX(' + (v.pctA / 100) + ')';
      $('#barB').style.transform = 'scaleX(' + (v.pctB / 100) + ')';
    });
    $('#pctA').textContent = v.pctA + '%';
    $('#pctB').textContent = v.pctB + '%';

    var stamp = v.winner === 'tie'
      ? '<div class="stamp tie">Ничья, ровно пополам</div>'
      : '<div class="stamp">Виновен: сторона ' + (v.winner === 'a' ? 'Б' : 'А') + '</div>';
    $('#stampMount').innerHTML = stamp;

    var mount = $('#commentsMount');
    try {
      var res = await API.comments(d.id);
      if (!res.comments.length) {
        mount.innerHTML = '<p class="muted" style="margin-top:12px">Присяжные не оставили комментариев.</p>';
      } else {
        mount.innerHTML = res.comments.slice(0, 10).map(function (c) {
          return '<div class="tc"><div class="tc-up">' +
            '<button data-up="' + c.id + '" title="Поднять">▲</button>' +
            '<span class="mono">' + c.score + '</span></div>' +
            '<div><p>' + esc(c.body) + '</p></div></div>';
        }).join('');
        $$('[data-up]', mount).forEach(function (b) {
          b.addEventListener('click', async function () {
            try {
              await API.upvote(b.dataset.up);
              b.nextElementSibling.textContent = Number(b.nextElementSibling.textContent) + 1;
            } catch (err) { toast(err.message, true); }
          });
        });
      }
    } catch (_) {
      mount.innerHTML = '';
    }
  }

  /* ---------------- действия по делу ---------------- */
  $('#copyLink').addEventListener('click', function () {
    var url = $('#inviteUrl').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(url).catch(function () {});
    toast('Ссылка скопирована. Отправь оппоненту.');
  });
  $('#shareTg').addEventListener('click', function () {
    var url = $('#inviteUrl').textContent;
    window.open('https://t.me/share/url?url=' + encodeURIComponent(url) +
      '&text=' + encodeURIComponent('Записал свою версию. Твоя очередь.'), '_blank');
  });
  $('#shareWa').addEventListener('click', function () {
    var url = $('#inviteUrl').textContent;
    window.open('https://wa.me/?text=' + encodeURIComponent('Записал свою версию. Твоя очередь: ' + url), '_blank');
  });
  $('#shareNative').addEventListener('click', function () {
    var url = $('#inviteUrl').textContent;
    if (navigator.share) {
      navigator.share({ title: 'Вердикт', text: 'Запиши свою версию спора', url: url }).catch(function () {});
    } else {
      toast('Браузер не умеет делиться, ссылка скопирована.');
      if (navigator.clipboard) navigator.clipboard.writeText(url);
    }
  });
  $('#remindBtn').addEventListener('click', async function () {
    try {
      var r = await API.remind(S.openCase.id);
      toast('Напоминание отправлено (' + r.remindersSent + ' из 2).');
    } catch (err) { toast(err.message, true); }
  });
  $('#oneSidedBtn').addEventListener('click', async function () {
    try {
      await API.publishOneSided(S.openCase.id);
      toast('Дело опубликовано с пометкой «одна сторона».');
      openCase(S.openCase.id);
    } catch (err) { toast(err.message, true); }
  });
  $('#shareVerdict').addEventListener('click', function () {
    var d = S.openCase;
    var text = 'Вердикт по делу № ' + d.no + ': ' + d.topic + '\n' +
      'Сторона А ' + d.verdict.pctA + '%, сторона Б ' + d.verdict.pctB + '%. ' +
      d.verdict.totalVotes + ' присяжных.';
    if (navigator.clipboard) navigator.clipboard.writeText(text);
    toast('Результат скопирован. Голоса и имена не попали.');
  });
  $('#reportCase').addEventListener('click', function () { reportFlow('dispute', S.openCase.id); });

  function reportFlow(type, id) {
    var reason = window.prompt(
      'Причина жалобы: doxxing, harassment, nsfw, minor, thirdparty_data, spam, other', 'harassment');
    if (!reason) return;
    API.report(type, id, reason.trim(), '')
      .then(function () { toast('Жалоба принята, разберём.'); })
      .catch(function (err) { toast(err.message, true); });
  }

  /* =========================================================
     03. Зал жюри
     ========================================================= */
  async function loadNextCase() {
    stopAllPlayers();
    S.voted = false;
    S.listen = { a: 0, b: 0 };
    $('#jurySkel').style.display = 'grid';
    $('#juryBody').style.display = 'none';
    $('#juryEmpty').style.display = 'none';

    var res;
    try {
      res = await API.nextCase();
    } catch (err) {
      $('#jurySkel').style.display = 'none';
      return toast(err.message, true);
    }

    $('#jurySkel').style.display = 'none';

    if (!res.case) {
      $('#juryEmpty').style.display = 'block';
      return;
    }

    S.jury = res.case;
    if (res.case.rules) S.rules = res.case.rules;

    $('#juryBody').style.display = 'block';
    $('#caseNo').textContent = 'Дело № ' + res.case.no;
    $('#caseTopic').textContent = res.case.topic;
    $('#oneSidedWarn').style.display = res.case.oneSided ? 'block' : 'none';
    $('#votedBox').style.display = 'none';
    $('#voteGate').style.display = 'block';
    $('#juryComment').value = '';

    renderSides(res.case.sides);
    updateGate();
  }

  function renderSides(sides) {
    var mount = $('#sidesMount');
    mount.innerHTML = sides.map(function (s) {
      var name = s.label === 'a' ? 'сторона А' : 'сторона Б';
      return '<div class="side ' + s.label + '" data-side="' + s.label + '">' +
        '<div class="side-head">' +
        '<button class="play" data-play="' + s.label + '" aria-label="Слушать ' + name + '">' +
        '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg></button>' +
        '<div style="min-width:0">' +
        '<span class="tag tag-' + s.label + '">' + name + '</span>' +
        '<p class="side-quote">Запись ' + fmtSec(s.durationMs) + '. Слушай целиком: ' +
        'голос откроется только после ' + Math.round(S.rules.minListenRatio * 100) + '%.</p>' +
        '</div></div>' +
        '<div class="track"><b data-bar="' + s.label + '"></b></div>' +
        '<div class="track-meta"><span data-time="' + s.label + '">0:00</span>' +
        '<span>' + fmtSec(s.durationMs) + '</span></div></div>';
    }).join('');

    /* Настоящие плееры на файлы с сервера. */
    S.players = {};
    sides.forEach(function (s) {
      var audio = new Audio(s.audioUrl);
      audio.preload = 'metadata';
      var listenedMs = 0;
      var lastAt = 0;

      /* Считаем реально проигранное время, а не позицию ползунка:
         перемотка вперёд прослушиванием не считается. */
      audio.addEventListener('timeupdate', function () {
        var t = audio.currentTime * 1000;
        if (lastAt && t > lastAt && t - lastAt < 1500) listenedMs += t - lastAt;
        lastAt = t;
        var ratio = Math.min(1, listenedMs / s.durationMs);
        S.listen[s.label] = ratio;
        var bar = $('[data-bar="' + s.label + '"]');
        if (bar) bar.style.transform = 'scaleX(' + ratio + ')';
        var lab = $('[data-time="' + s.label + '"]');
        if (lab) lab.textContent = fmtSec(listenedMs);
        updateGate();
      });
      audio.addEventListener('seeking', function () { lastAt = audio.currentTime * 1000; });
      audio.addEventListener('ended', function () { setPlayIcon(s.label, false); });
      audio.addEventListener('error', function () {
        toast('Запись не загрузилась. Обнови страницу.', true);
      });

      S.players[s.label] = audio;
    });

    $$('[data-play]', mount).forEach(function (btn) {
      btn.addEventListener('click', function () { togglePlay(btn.dataset.play); });
    });
  }

  function setPlayIcon(label, playing) {
    var btn = $('[data-play="' + label + '"]');
    if (!btn) return;
    btn.classList.toggle('playing', playing);
    btn.innerHTML = playing
      ? '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/></svg>'
      : '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>';
  }

  function stopAllPlayers() {
    Object.keys(S.players).forEach(function (k) {
      try { S.players[k].pause(); } catch (_) {}
      setPlayIcon(k, false);
    });
  }

  function togglePlay(label) {
    var audio = S.players[label];
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      setPlayIcon(label, false);
      return;
    }
    stopAllPlayers();
    audio.play().then(function () { setPlayIcon(label, true); })
      .catch(function () { toast('Браузер не дал воспроизвести. Нажми ещё раз.', true); });
  }

  function updateGate() {
    var min = S.rules.minListenRatio;
    var ok = S.listen.a >= min && S.listen.b >= min;
    ['a', 'b'].forEach(function (k) {
      var btn = $('[data-vote="' + k + '"]');
      if (!btn) return;
      btn.disabled = !ok || S.voted;
      $('small', btn).textContent = 'слушал ' + Math.round((S.listen[k] || 0) * 100) + '%';
    });

    var elapsed = S.jury ? (Date.now() - S.jury.servedAt) / 1000 : 0;
    var waitLeft = Math.ceil(S.rules.minSecondsBeforeVote - elapsed);
    $('#gateHint').textContent = ok
      ? (waitLeft > 0
        ? 'Обе стороны выслушаны. Сервер примет голос через ' + waitLeft + ' с.'
        : 'Обе стороны выслушаны. Решай.')
      : 'Голос откроется, когда прослушаешь обе стороны на ' + Math.round(min * 100) + '%.';
  }

  $$('[data-vote]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      if (!S.jury) return;
      stopAllPlayers();
      btn.disabled = true;

      try {
        await API.vote(S.jury.disputeId, {
          side: btn.dataset.vote,
          listenedA: S.listen.a,
          listenedB: S.listen.b,
          deviceId: window.verdictDeviceId()
        });
        S.voted = true;
        $('#voteGate').style.display = 'none';
        $('#votedBox').style.display = 'block';
        var scoreEl = $('#juryScore');
        var n = Number((scoreEl.textContent.match(/\d+/) || [0])[0]) + 1;
        scoreEl.textContent = 'отсужено дел: ' + n;
      } catch (err) {
        toast(err.message, true);
        updateGate();
      }
    });
  });

  $('#sendComment').addEventListener('click', async function () {
    var body = $('#juryComment').value.trim();
    if (!body) return toast('Комментарий пустой.', true);
    try {
      await API.comment(S.jury.disputeId, body);
      $('#juryComment').value = '';
      toast('Комментарий уйдёт сторонам вместе с вердиктом.');
    } catch (err) { toast(err.message, true); }
  });
  $('#nextCase').addEventListener('click', loadNextCase);
  $('#retryJury').addEventListener('click', loadNextCase);
  $('#reportJuryCase').addEventListener('click', function () {
    if (S.jury) reportFlow('dispute', S.jury.disputeId);
  });

  /* Таймер подсказки: она зависит от времени, а не только от прослушивания. */
  setInterval(function () {
    if (S.screen === 'jury' && S.jury && !S.voted) updateGate();
  }, 1000);

  /* =========================================================
     04. Профиль
     ========================================================= */
  async function loadProfile() {
    var res = await API.me();
    if (!res.user) return;
    S.me = res.user;

    $('#profileName').textContent = res.user.emoji + ' ' + res.user.handle;
    $('#statWins').textContent = res.stats.wins;
    $('#statLosses').textContent = res.stats.losses;
    $('#statJudged').textContent = res.stats.judged;
    $('#subTag').textContent = res.user.subActive
      ? 'подписка до ' + new Date(res.user.subUntil).toLocaleDateString('ru-RU')
      : 'без подписки';

    var badges = res.badges || [];
    $('#badgesMount').innerHTML = badges.length
      ? badges.map(function (b) {
          return '<span class="bdg' + (b.kind === 'loss' ? ' loss' : '') + '">' + esc(b.label) + '</span>';
        }).join('')
      : '<span class="muted">Пока пусто. Проиграешь спор, появится.</span>';

    try {
      var pay = await API.myPayments();
      var rows = pay.payments;
      $('#paymentsMount').innerHTML =
        (pay.creditCents > 0
          ? '<p class="small" style="margin-bottom:12px">На счету ' + money(pay.creditCents) +
            ' возврата за дела без кворума. Спишется автоматически при следующей покупке.</p>'
          : '') +
        (rows.length
          ? rows.map(function (p) {
              var st = { paid: 'оплачено', pending: 'ждёт оплаты', refunded: 'возвращено', failed: 'не прошло' }[p.status] || p.status;
              return '<div class="hist"><p>' + esc(p.product) + '</p><span class="res">' +
                money(p.amount_cents) + ' · ' + st + '</span></div>';
            }).join('')
          : '<p class="muted">Покупок не было.</p>');
    } catch (_) {
      $('#paymentsMount').innerHTML = '<p class="muted">Не удалось загрузить платежи.</p>';
    }
  }

  $('#buySub').addEventListener('click', function () {
    S.tier = 'sub';
    $$('.tier').forEach(function (t) { t.classList.toggle('sel', t.dataset.tier === 'sub'); });
    openSheet();
  });

  $('#deleteAcc').addEventListener('click', async function () {
    if (!window.confirm('Удалить аккаунт? Записи, голоса и история исчезнут навсегда.')) return;
    try {
      await API.deleteAccount();
      location.href = 'index.html';
    } catch (err) { toast(err.message, true); }
  });

  /* =========================================================
     Пейволл
     ========================================================= */
  function openSheet() { $('#scrim').classList.add('on'); $('#sheet').classList.add('on'); }
  function closeSheet() { $('#scrim').classList.remove('on'); $('#sheet').classList.remove('on'); }
  $('#scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  $('#openPaywall').addEventListener('click', openSheet);
  $('#skipPay').addEventListener('click', closeSheet);
  $$('.tier').forEach(function (t) {
    t.addEventListener('click', function () {
      $$('.tier').forEach(function (x) { x.classList.remove('sel'); });
      t.classList.add('sel');
      S.tier = t.dataset.tier;
    });
  });

  $('#buy').addEventListener('click', async function () {
    var btn = $('#buy');
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = 'Обрабатываем…';

    try {
      var disputeId = S.tier === 'sub' ? null : (S.openCase ? S.openCase.id : null);
      if (S.tier !== 'sub' && !disputeId) throw new Error('Открой дело, к которому относится покупка.');

      var r = await API.checkout(S.tier, disputeId);

      if (r.status === 'redirect' && r.checkoutUrl) {
        location.href = r.checkoutUrl;
        return;
      }

      closeSheet();
      if (r.warning) toast(r.warning);
      else if (r.status === 'paid_with_credit') toast('Оплачено накопленным возвратом.');
      else if (r.status === 'granted_by_subscription') toast('Срочность уже входит в подписку.');
      else toast('Готово.');

      if (disputeId) openCase(disputeId);
      if (S.tier === 'sub') loadProfile();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });

  window.addEventListener('beforeunload', closeStream);
})();
