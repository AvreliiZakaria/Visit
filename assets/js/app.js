/* Живое приложение: создание дел, мои дела и настоящий зал жюри. */
(function () {
  'use strict';
  var API = window.VerdictAPI;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var S = { user: null, caseData: null, audio: {}, listened: { a: 0, b: 0 }, voted: false, recorder: null };
  var STATUS = { awaiting_opponent: 'ждёт оппонента', held: 'на проверке', in_jury: 'идёт сбор жюри', verdict: 'вердикт вынесен', expired: 'закрыто', abandoned: 'оппонент не ответил', blocked: 'заблокировано' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>\"]/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;' }[c]; }); }
  function toast(text, bad) { var t = $('#toast'); if (!t) return; t.textContent = text; t.className = 'toast on' + (bad ? ' bad' : ''); clearTimeout(toast.timer); toast.timer = setTimeout(function () { t.classList.remove('on'); }, 3500); }
  function go(name) { $$('.pane').forEach(function (p) { p.classList.toggle('on', p.id === 'p-' + name); }); $$('#rail button').forEach(function (b) { b.setAttribute('aria-current', String(b.dataset.go === name)); }); $$('#tabbar button').forEach(function (b) { b.classList.toggle('on', b.dataset.go === name); }); window.scrollTo({ top: 0, behavior: 'smooth' }); if (name === 'cases') loadCases(); if (name === 'jury') loadJury(); if (name === 'profile') loadProfile(); }
  $$('[data-go]').forEach(function (b) { b.addEventListener('click', function () { go(b.dataset.go); }); });

  async function boot() {
    try {
      var health = await API.health();
      if (!health) throw new Error('Сервер не отвечает. Открой http://localhost:3000.');
      var me = await API.me();
      if (!me.user) { location.href = 'login.html?next=' + encodeURIComponent('app.html'); return; }
      S.user = me.user; $('#whoami').textContent = S.user.emoji + ' ' + S.user.handle; $('#juryScore').textContent = 'отсуждено дел: ' + ((me.stats && me.stats.judged) || 0);
      if (health.payments === 'sandbox') { $('#modeTag').hidden = false; $('#modeTag').textContent = 'песочница'; }
      mountCreate();
    } catch (e) { document.body.innerHTML = '<main style="max-width:600px;margin:80px auto;padding:24px;font:16px system-ui"><h1>Сервер не запущен</h1><p>' + esc(e.message) + '</p><p>Запусти <code>npm run dev</code> и открой <code>http://localhost:3000</code>.</p></main>'; }
  }

  function mountCreate() {
    if (!window.mountRecorder) return toast('Не загрузился диктофон.', true);
    S.recorder = window.mountRecorder($('#recorderMount'), { label: 'Записать аргументы', onDone: async function (blob, durationMs, ui) {
      var topic = $('#topic').value.replace(/\s+/g, ' ').trim();
      if (topic.length < 8) { $('#topicErr').classList.add('on'); $('#topic').focus(); return toast('Сначала опиши спор.', true); }
      ui.busy(true);
      try { var r = await API.createDispute(topic, $('#consent').checked); var d = r.dispute || r; await API.uploadSide(d.id, blob, durationMs); toast('Готово. Отправь ссылку оппоненту.'); $('#topic').value = ''; $('#topicCount').textContent = '0/90'; $('#consent').checked = false; ui.reset(); go('cases'); openCase(d.id); }
      catch (e) { toast(e.message, true); } finally { ui.busy(false); }
    }, onError: function (m) { toast(m, true); } });
    $('#topic').addEventListener('input', function () { $('#topicCount').textContent = this.value.length + '/90'; $('#topicErr').classList.remove('on'); });
  }

  async function loadCases() {
    var box = $('#casesList'); if (!box) return;
    try { var r = await API.myDisputes(); if (!r.disputes.length) { box.innerHTML = '<p class="small">Дел пока нет. Создай первый спор.</p>'; return; } box.innerHTML = r.disputes.map(function (d) { return '<button class="hist" data-case="' + d.id + '"><p>' + esc(d.topic) + '</p><span class="res">' + esc(STATUS[d.status] || d.status) + '</span></button>'; }).join(''); $$('[data-case]', box).forEach(function (b) { b.addEventListener('click', function () { openCase(b.dataset.case); }); }); }
    catch (e) { toast(e.message, true); }
  }
  async function openCase(id) {
    try { var r = await API.getDispute(id), d = r.dispute || r; $('#casesList').style.display = 'none'; $('#caseDetail').style.display = 'block'; $('#dNo').textContent = 'Дело № ' + d.no; $('#dStatus').textContent = STATUS[d.status] || d.status; $('#dTopic').textContent = d.topic; $('#blockInvite').style.display = d.status === 'awaiting_opponent' ? 'block' : 'none'; $('#blockQuorum').style.display = d.status === 'in_jury' || d.status === 'held' ? 'block' : 'none'; $('#blockVerdict').style.display = d.verdict ? 'block' : 'none'; if (d.inviteUrl) $('#inviteUrl').textContent = d.inviteUrl; if (d.quorum) { $('#qNow').textContent = d.quorum.collected; $('#qTarget').textContent = d.quorum.target; $('#qBar').style.transform = 'scaleX(' + Math.min(1, d.quorum.collected / d.quorum.target) + ')'; $('#qNote').textContent = 'Собрано живых голосов: ' + d.quorum.collected + '. Проценты появятся только после вердикта.'; } if (d.verdict) { $('#pctA').textContent = d.verdict.pctA + '%'; $('#pctB').textContent = d.verdict.pctB + '%'; } }
    catch (e) { toast(e.message, true); }
  }
  $('#refreshCases').addEventListener('click', loadCases); $('#backToList').addEventListener('click', function () { $('#caseDetail').style.display = 'none'; $('#casesList').style.display = 'block'; loadCases(); }); $('#copyLink').addEventListener('click', function () { navigator.clipboard.writeText($('#inviteUrl').textContent).then(function () { toast('Ссылка скопирована.'); }); }); $('#remindBtn').addEventListener('click', async function () { try { var r = await API.remind(S.dispute.id); toast('Напоминание отправлено: ' + r.remindersSent + ' из 2.'); } catch (e) { toast(e.message, true); } });

  function stopAudio() { Object.keys(S.audio).forEach(function (k) { try { S.audio[k].pause(); } catch (_) {} }); }
  function renderJury(c) {
    S.caseData = c; S.listened = { a: 0, b: 0 }; S.voted = false; stopAudio(); S.audio = {};
    $('#juryBody').style.display = 'block'; $('#juryEmpty').style.display = 'none'; $('#jurySkel').style.display = 'none'; $('#caseNo').textContent = 'Дело № ' + c.no; $('#caseTopic').textContent = c.topic; $('#juryScore').textContent = 'дело готово к разбору';
    $('#oneSidedWarn').style.display = c.oneSided ? 'block' : 'none'; $('#voteGate').style.display = 'block'; $('#votedBox').style.display = 'none';
    $('#sidesMount').innerHTML = c.sides.map(function (s) { var n = s.label === 'a' ? 'сторона А' : 'сторона Б'; return '<div class="side ' + s.label + '"><div class="side-head"><button class="play" data-play="' + s.label + '"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg></button><div><span class="tag tag-' + s.label + '">' + n + '</span><p class="side-quote">Запись ' + Math.round((s.durationMs || 0) / 1000) + ' сек. Прослушай минимум 80%.</p></div></div><div class="track"><b data-bar="' + s.label + '"></b></div><div class="track-meta"><span data-time="' + s.label + '">0:00</span><span>0:' + String(Math.round((s.durationMs || 60000) / 1000)).padStart(2, '0') + '</span></div></div>'; }).join('');
    c.sides.forEach(function (s) { var a = new Audio(s.audioUrl); var played = 0, last = 0; a.addEventListener('timeupdate', function () { var cur = a.currentTime; if (last && cur > last && cur - last < 1.5) played += cur - last; last = cur; var ratio = Math.min(1, played / ((s.durationMs || 60000) / 1000)); S.listened[s.label] = ratio; var bar = $('[data-bar="' + s.label + '"]'); if (bar) bar.style.transform = 'scaleX(' + ratio + ')'; var tm = $('[data-time="' + s.label + '"]'); if (tm) tm.textContent = '0:' + String(Math.round(played)).padStart(2, '0'); updateGate(); }); a.addEventListener('ended', function () { setPlay(s.label, false); }); a.addEventListener('error', function () { toast('Не удалось загрузить запись.', true); }); S.audio[s.label] = a; });
    $$('[data-play]').forEach(function (b) { b.addEventListener('click', function () { var a = S.audio[b.dataset.play]; if (!a) return; stopAudio(); if (a.paused) { a.play().then(function () { setPlay(b.dataset.play, true); }).catch(function () { toast('Браузер заблокировал аудио.', true); }); } else setPlay(b.dataset.play, false); }); });
    updateGate();
  }
  function setPlay(k, on) { var b = $('[data-play="' + k + '"]'); if (b) { b.classList.toggle('playing', on); b.innerHTML = on ? '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="3" width="3" height="10"/><rect x="9" y="3" width="3" height="10"/></svg>' : '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>'; } }
  function updateGate() { if (!S.caseData) return; var min = (S.caseData.rules && S.caseData.rules.minListenRatio) || .8; var ok = S.listened.a >= min && S.listened.b >= min; $$('[data-vote]').forEach(function (b) { b.disabled = !ok || S.voted; b.querySelector('small').textContent = 'слушал ' + Math.round((S.listened[b.dataset.vote] || 0) * 100) + '%'; }); $('#gateHint').textContent = ok ? 'Обе стороны выслушаны. Решай.' : 'Голос откроется, когда прослушаешь обе стороны на 80%.'; }
  async function loadJury() {
    $('#jurySkel').style.display = 'grid'; $('#juryBody').style.display = 'none'; $('#juryEmpty').style.display = 'none';
    try { var r = await API.nextCase(); if (!r.case) { $('#jurySkel').style.display = 'none'; $('#juryEmpty').style.display = 'block'; $('#juryEmpty h2').textContent = 'В этом аккаунте пока нечего судить'; var p = $('#juryEmpty p'); if (p) p.textContent = r.message || 'Свои дела и дела, на которые ты отвечал, жюри не выдаёт. Открой этот раздел другим аккаунтом или попроси друга открыть его на другом устройстве.'; return; } renderJury(r.case); } catch (e) { $('#jurySkel').style.display = 'none'; $('#juryEmpty').style.display = 'block'; var p2 = $('#juryEmpty p'); if (p2) p2.textContent = e.message; }
  }
  $$('[data-vote]').forEach(function (b) { b.addEventListener('click', async function () { if (!S.caseData) return; try { await API.vote(S.caseData.disputeId, { side: b.dataset.vote, listenedA: S.listened.a, listenedB: S.listened.b, deviceId: window.verdictDeviceId ? window.verdictDeviceId() : '' }); S.voted = true; $('#voteGate').style.display = 'none'; $('#votedBox').style.display = 'block'; toast('Голос учтён.'); } catch (e) { toast(e.message, true); updateGate(); } }); });
  $('#nextCase').addEventListener('click', loadJury); $('#retryJury').addEventListener('click', loadJury);
  async function loadProfile() { try { var r = await API.me(); $('#profileName').textContent = r.user.emoji + ' ' + r.user.handle; $('#statWins').textContent = r.stats.wins; $('#statLosses').textContent = r.stats.losses; $('#statJudged').textContent = r.stats.judged; } catch (e) { toast(e.message, true); } }
  $('#logout').addEventListener('click', async function () { await API.logout(); location.href = 'login.html'; });
  boot();
})();
