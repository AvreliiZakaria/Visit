/* Живое приложение. HTML и этот файл синхронизированы. */
(function () {
  'use strict';
  var API = window.VerdictAPI;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var S = { user: null, dispute: null, recorder: null, poll: null };
  var STATUS = { awaiting_opponent: 'ждёт оппонента', held: 'на проверке', in_jury: 'идёт сбор жюри', verdict: 'вердикт вынесен', expired: 'закрыто', abandoned: 'оппонент не ответил', blocked: 'заблокировано' };

  function toast(text, bad) {
    var el = $('#toast'); if (!el) return;
    el.textContent = text; el.className = 'toast on' + (bad ? ' bad' : '');
    clearTimeout(toast.timer); toast.timer = setTimeout(function () { el.classList.remove('on'); }, 3500);
  }
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>\"]/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;' }[c]; }); }
  function go(name) {
    $$('.pane').forEach(function (p) { p.classList.toggle('on', p.id === 'p-' + name); });
    $$('#rail button,[data-go]').forEach(function (b) { if (b.dataset.go) b.setAttribute('aria-current', String(b.dataset.go === name)); });
    $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.go === name); });
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (name === 'cases') loadCases();
    if (name === 'jury') loadJury();
    if (name === 'profile') loadProfile();
  }
  $$('[data-go]').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.go); }); });

  async function boot() {
    try {
      var health = await API.health();
      if (!health) throw new Error('Сервер не отвечает. Открой приложение через http://localhost:3000.');
      var me = await API.me();
      if (!me.user) { location.href = 'login.html?next=' + encodeURIComponent('app.html'); return; }
      S.user = me.user;
      $('#whoami').textContent = S.user.emoji + ' ' + S.user.handle;
      $('#juryScore').textContent = 'отсужено дел: ' + ((me.stats && me.stats.judged) || 0);
      if (health.payments === 'sandbox') { $('#modeTag').hidden = false; $('#modeTag').textContent = 'песочница'; }
      mountCreate();
    } catch (e) {
      document.body.innerHTML = '<main style="max-width:600px;margin:80px auto;padding:24px;font:16px system-ui"><h1>Сервер не запущен</h1><p>' + esc(e.message) + '</p><p>Запусти <code>npm run dev</code> и открой <code>http://localhost:3000</code>.</p></main>';
    }
  }

  function mountCreate() {
    if (!window.mountRecorder) return toast('Не загрузился компонент записи. Обнови страницу Ctrl+F5.', true);
    S.recorder = window.mountRecorder($('#recorderMount'), {
      label: 'Записать аргументы',
      onDone: async function (blob, durationMs, ui) {
        var topic = $('#topic').value.replace(/\s+/g, ' ').trim();
        if (topic.length < 8) { $('#topicErr').classList.add('on'); $('#topic').focus(); return toast('Сначала опиши спор.', true); }
        ui.busy(true);
        try {
          var created = await API.createDispute(topic, $('#consent').checked);
          var dispute = created.dispute || created;
          await API.uploadSide(dispute.id, blob, durationMs);
          toast('Готово. Теперь отправь ссылку оппоненту.');
          $('#topic').value = ''; $('#topicCount').textContent = '0/90'; $('#consent').checked = false; ui.reset();
          await openCase(dispute.id); go('cases');
        } catch (e) { toast(e.message, true); } finally { ui.busy(false); }
      },
      onError: function (msg) { toast(msg, true); }
    });
    $('#topic').addEventListener('input', function () { $('#topicCount').textContent = this.value.length + '/90'; $('#topicErr').classList.remove('on'); });
  }

  async function loadCases() {
    var box = $('#casesList'); if (!box) return;
    try {
      var r = await API.myDisputes();
      if (!r.disputes.length) { box.innerHTML = '<p class="small">Дел пока нет. Создай первый спор.</p>'; return; }
      box.innerHTML = r.disputes.map(function (d) { return '<button class="hist" data-case="' + d.id + '"><p>' + esc(d.topic) + '</p><span class="res">' + esc(STATUS[d.status] || d.status) + '</span></button>'; }).join('');
      $$('[data-case]', box).forEach(function (b) { b.addEventListener('click', function () { openCase(b.dataset.case); }); });
    } catch (e) { toast(e.message, true); }
  }
  async function openCase(id) {
    try {
      var r = await API.getDispute(id), d = r.dispute || r; S.dispute = d;
      $('#casesList').style.display = 'none'; $('#caseDetail').style.display = 'block';
      $('#dNo').textContent = 'Дело № ' + d.no; $('#dStatus').textContent = STATUS[d.status] || d.status; $('#dTopic').textContent = d.topic;
      $('#blockInvite').style.display = d.status === 'awaiting_opponent' ? 'block' : 'none';
      $('#blockQuorum').style.display = d.status === 'in_jury' || d.status === 'held' ? 'block' : 'none';
      $('#blockVerdict').style.display = d.verdict ? 'block' : 'none';
      if (d.inviteUrl) $('#inviteUrl').textContent = d.inviteUrl;
      if (d.quorum) { $('#qNow').textContent = d.quorum.collected; $('#qTarget').textContent = d.quorum.target; $('#qBar').style.transform = 'scaleX(' + Math.min(1, d.quorum.collected / d.quorum.target) + ')'; $('#qNote').textContent = 'Собрано живых голосов: ' + d.quorum.collected + '. Проценты появятся только после вердикта.'; }
      if (d.verdict) { $('#pctA').textContent = d.verdict.pctA + '%'; $('#pctB').textContent = d.verdict.pctB + '%'; $('#barA').style.transform = 'scaleX(' + d.verdict.pctA / 100 + ')'; $('#barB').style.transform = 'scaleX(' + d.verdict.pctB / 100 + ')'; $('#stampMount').innerHTML = '<div class="stamp">Права сторона ' + String(d.verdict.winner).toUpperCase() + '</div>'; }
    } catch (e) { toast(e.message, true); }
  }
  $('#refreshCases').addEventListener('click', loadCases);
  $('#backToList').addEventListener('click', function () { $('#caseDetail').style.display = 'none'; $('#casesList').style.display = 'block'; loadCases(); });
  $('#copyLink').addEventListener('click', function () { navigator.clipboard.writeText($('#inviteUrl').textContent).then(function () { toast('Ссылка скопирована.'); }); });
  $('#remindBtn').addEventListener('click', async function () { try { var r = await API.remind(S.dispute.id); toast('Напоминание отправлено: ' + r.remindersSent + ' из 2.'); } catch (e) { toast(e.message, true); } });
  $('#oneSidedBtn').addEventListener('click', async function () { try { await API.publishOneSided(S.dispute.id); await openCase(S.dispute.id); } catch (e) { toast(e.message, true); } });

  async function loadJury() {
    try { var r = await API.nextCase(); if (!r.case) { $('#juryBody').style.display = 'none'; $('#juryEmpty').style.display = 'block'; return; } toast('Дело загружено.'); } catch (e) { toast(e.message, true); }
  }
  async function loadProfile() { try { var r = await API.me(); $('#profileName').textContent = r.user.emoji + ' ' + r.user.handle; $('#statWins').textContent = r.stats.wins; $('#statLosses').textContent = r.stats.losses; $('#statJudged').textContent = r.stats.judged; } catch (e) { toast(e.message, true); } }
  $('#logout').addEventListener('click', async function () { await API.logout(); location.href = 'login.html'; });
  boot();
})();
