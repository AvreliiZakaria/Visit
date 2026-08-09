/* Вердикт — поведение лендинга. Ноль зависимостей. */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------- год в подвале ---------- */
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
    burger.addEventListener('click', function () {
      setDrawer(!drawer.classList.contains('on'));
    });
    $$('a', drawer).forEach(function (a) {
      a.addEventListener('click', function () { setDrawer(false); });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setDrawer(false);
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 760) setDrawer(false);
    });
  }

  /* ---------- тикер дел ---------- */
  var DOCKET = [
    'Дело 4417 · рыбалка в годовщину · 71 к 29 · виновен истец',
    'Дело 4418 · чтение переписки при открытом телефоне · ждём кворум, 63 из 100',
    'Дело 4419 · кто выносит мусор, если пакет с его стороны · 56 к 44',
    'Дело 4420 · рабочие письма в оплаченном отпуске · 81 к 19 · виновен ответчик',
    'Дело 4421 · кот спит на кровати или нет · собрано 12 присяжных'
  ];
  var tText = $('#tickerText');
  if (tText) {
    var ti = 0;
    tText.textContent = DOCKET[0];
    setInterval(function () {
      tText.classList.add('swap');
      setTimeout(function () {
        ti = (ti + 1) % DOCKET.length;
        tText.textContent = DOCKET[ti];
        tText.classList.remove('swap');
      }, 320);
    }, 4200);
  }

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
        entries.forEach(function (en) {
          if (en.isIntersecting) { runSplit(); obs.disconnect(); }
        });
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
        if (en.isIntersecting) {
          en.target.classList.add('seen');
          io.unobserve(en.target);
        }
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

  /* ---------- форма записи в бету ---------- */
  var form = $('#waitlist');
  if (form) {
    var email = $('#email', form);
    var errBox = $('#emailErr', form);
    var okBox = $('#formOk');
    var submit = $('#submitBtn', form);
    var counter = $('#signupCount');
    var stored = Number(localStorage.getItem('verdict_waitlist') || 0);
    var base = 1284;
    if (counter) counter.textContent = String(base + stored);

    var valid = function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); };

    email.addEventListener('input', function () {
      email.setAttribute('aria-invalid', 'false');
      errBox.classList.remove('on');
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = email.value.trim();
      if (!valid(v)) {
        email.setAttribute('aria-invalid', 'true');
        errBox.textContent = v ? 'Проверь адрес, похоже на опечатку.' : 'Без почты мы не сможем позвать тебя в бету.';
        errBox.classList.add('on');
        email.focus();
        return;
      }

      var role = $('#role', form) ? $('#role', form).value : '';
      var endpoint = (form.dataset.endpoint || '').trim();

      submit.disabled = true;
      var label = submit.textContent;
      submit.textContent = 'Отправляем…';

      var finish = function () {
        stored += 1;
        localStorage.setItem('verdict_waitlist', String(stored));
        if (counter) counter.textContent = String(base + stored);
        form.style.display = 'none';
        if (okBox) {
          okBox.classList.add('on');
          $('#okEmail', okBox).textContent = v;
          okBox.setAttribute('tabindex', '-1');
          okBox.focus();
        }
      };

      if (endpoint) {
        fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ email: v, role: role, source: 'landing' })
        }).then(finish).catch(function () {
          submit.disabled = false;
          submit.textContent = label;
          errBox.textContent = 'Не отправилось. Попробуй ещё раз через минуту.';
          errBox.classList.add('on');
        });
      } else {
        // бэкенда пока нет: открываем почтовый клиент и считаем заявку принятой
        var subj = encodeURIComponent('Хочу в бету Вердикта');
        var body = encodeURIComponent('Почта: ' + v + '\nРоль: ' + (role || 'не указана'));
        window.location.href = 'mailto:hello@verdict.app?subject=' + subj + '&body=' + body;
        setTimeout(finish, 400);
      }
    });
  }
})();
