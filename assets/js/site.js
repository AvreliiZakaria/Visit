/** Вердикт: логика лендинга. Работает и без сервера, но с сервером оживает. */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var yr = $('#year');
  if (yr) yr.textContent = new Date().getFullYear();

  /* ---------- мобильное меню ---------- */
  var burger = $('#burger');
  var drawer = $('#drawer');
  if (burger && drawer) {
    var setDrawer = function (open) {
      drawer.classList.toggle('on', open);
      burger.setAttribute('aria-expanded', String(open));
      document.body.style.overflow = open ? 'hidden' : '';
    };
    burger.addEventListener('click', function () { setDrawer(!drawer.classList.contains('on')); });
    $$('a', drawer).forEach(function (a) { a.addEventListener('click', function () { setDrawer(false); }); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setDrawer(false); });
    window.addEventListener('resize', function () { if (window.innerWidth > 760) setDrawer(false); });
  }

  /* ---------- тикер дел ---------- */
  var FALLBACK = [
    'Дело 4417 · рыбалка в годовщину · 71 к 29 · виновен истец',
    'Дело 4418 · чтение переписки при открытом телефоне · ждём кворум, 63 из 100',
    'Дело 4419 · кто выносит мусор, если пакет с его стороны · 56 к 44',
    'Дело 4420 · рабочие письма в оплаченном отпуске · 81 к 19 · виновен ответчик',
    'Дело 4421 · кот спит на кровати или нет · собрано 12 присяжных'
  ];

  var lines = FALLBACK.slice();
  var tText = $('#tickerText');
  if (tText) {
    var ti = 0;
    tText.textContent = lines[0];
    setInterval(function () {
      tText.classList.add('swap');
      setTimeout(function () {
        ti = (ti + 1) % lines.length;
        tText.textContent = lines[ti];
        tText.classList.remove('swap');
      }, 320);
    }, 4200);
  }

  /* ---------- живые данные с сервера, если он есть ---------- */
  fetch('/api/stats').then(function (r) {
    if (!r.ok) throw 0;
    return r.json();
  }).then(function (s) {
    var live = [];

    (s.recent || []).forEach(function (v) {
      var win = v.winner === 'tie' ? 'ничья' : 'права сторона ' + (v.winner === 'a' ? 'А' : 'Б');
      live.push('Вердикт · ' + v.topic + ' · ' + v.pct_a + ' к ' + v.pct_b + ' · ' + win);
    });
    (s.waiting || []).forEach(function (w) {
      live.push('В суде · ' + w.topic + ' · собрано ' + w.votes + ' из ' + w.jury_size);
    });

    if (live.length) lines = live;

    var badge = $('.tag-live');
    if (badge && s.live != null) badge.textContent = 'идёт ' + s.live + ' заседаний';

    // сервер поднят, значит приложение доступно: показываем ссылку
    var nav = $('.nav');
    if (nav && !$('#liveAppLink')) {
      var a = document.createElement('a');
      a.id = 'liveAppLink';
      a.href = 'court.html';
      a.className = 'btn btn-sm btn-ink';
      a.textContent = 'Войти в суд';
      nav.appendChild(a);
    }
    var dr = $('.drawer .drawer-cta');
    if (dr) {
      var b = document.createElement('a');
      b.href = 'court.html';
      b.className = 'btn btn-block btn-ink';
      b.style.marginTop = '8px';
      b.textContent = 'Войти в суд';
      dr.appendChild(b);
    }
  }).catch(function () { /* статичная раздача, живём на примерах */ });

  /* ---------- волны в карточке дела ---------- */
  $$('.wavelet').forEach(function (w) {
    for (var i = 0; i < 26; i++) {
      var bar = document.createElement('i');
      bar.style.height = (22 + Math.abs(Math.sin(i * 1.9)) * 70) + '%';
      w.appendChild(bar);
    }
  });

  /* ---------- анимация полосы вердикта ---------- */
  function countUp(el, target, dur) {
    var t0 = performance.now();
    function step(now) {
      var p = Math.min(1, (now - t0) / dur);
      el.textContent = Math.round(target * (1 - Math.pow(1 - p, 4))) + '%';
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  var splitbar = $('#splitbar');
  if (splitbar) {
    var fired = false;
    var runSplit = function () {
      if (fired) return;
      fired = true;
      var a = Number(splitbar.dataset.a || 71);
      $('.sa', splitbar).style.transform = 'scaleX(' + (a / 100) + ')';
      $('.sb', splitbar).style.transform = 'scaleX(' + ((100 - a) / 100) + ')';
      countUp($('#pctA'), a, 1200);
      countUp($('#pctB'), 100 - a, 1200);
    };

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries, obs) {
        entries.forEach(function (en) { if (en.isIntersecting) { runSplit(); obs.disconnect(); } });
      }, { threshold: 0.4 }).observe(splitbar);
    } else {
      runSplit();
    }
  }

  /* ---------- появление блоков ---------- */
  var risers = $$('.rise');
  if (risers.length && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add('seen'); io.unobserve(en.target); }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    risers.forEach(function (el, i) {
      el.style.setProperty('--i', String(i % 6));
      io.observe(el);
    });
  } else {
    risers.forEach(function (el) { el.classList.add('seen'); });
  }

  /* ---------- FAQ: открыт только один ---------- */
  var faqs = $$('.faq details');
  faqs.forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open) return;
      faqs.forEach(function (o) { if (o !== d) o.open = false; });
    });
  });

  /* ---------- запись в бету ---------- */
  var form = $('#waitlist');
  if (form) {
    var email = $('#email', form);
    var errBox = $('#emailErr', form);
    var okBox = $('#formOk');
    var submit = $('#submitBtn', form);
    var counter = $('#signupCount');
    var valid = function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); };

    email.addEventListener('input', function () {
      email.setAttribute('aria-invalid', 'false');
      errBox.classList.remove('on');
    });

    function done(v, total) {
      if (counter && total) counter.textContent = String(total);
      form.style.display = 'none';
      if (okBox) {
        okBox.classList.add('on');
        $('#okEmail', okBox).textContent = v;
        okBox.setAttribute('tabindex', '-1');
        okBox.focus();
      }
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();

      var v = email.value.trim();
      if (!valid(v)) {
        email.setAttribute('aria-invalid', 'true');
        errBox.textContent = v ? 'Проверь адрес, похоже на опечатку.' : 'Без почты мы не сможем позвать тебя в бету.';
        errBox.classList.add('on');
        return email.focus();
      }

      var role = $('#role', form) ? $('#role', form).value : '';
      var label = submit.textContent;
      submit.disabled = true;
      submit.textContent = 'Отправляем…';

      try {
        var res = await fetch('/api/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: v, role: role })
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Не отправилось');
        done(v, data.total);
      } catch (err) {
        // сервера нет: не врём про успех, отдаём человеку почту
        submit.disabled = false;
        submit.textContent = label;
        errBox.textContent = 'Сервер не отвечает. Напиши на hello@verdict.app, добавим руками.';
        errBox.classList.add('on');
      }
    });
  }
})();
