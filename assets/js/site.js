/* Вердикт — поведение лендинга. Работает с реальным API, без подделок. */
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
    burger.addEventListener('click', function () {
      setDrawer(!drawer.classList.contains('on'));
    });
    $$('a', drawer).forEach(function (a) {
      a.addEventListener('click', function () { setDrawer(false); });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setDrawer(false); });
    window.addEventListener('resize', function () { if (window.innerWidth > 760) setDrawer(false); });
  }

  /* ---------- волны в карточке дела ---------- */
  $$('.wavelet').forEach(function (w) {
    for (var i = 0; i < 26; i++) {
      var bar = document.createElement('i');
      bar.style.height = (22 + Math.abs(Math.sin(i * 1.9)) * 70) + '%';
      w.appendChild(bar);
    }
  });

  /* ---------- полоса вердикта в примере ---------- */
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
    } else { runSplit(); }
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

  /* ---------- если уже вошёл, кнопки ведут в суд ---------- */
  fetch('/api/auth/me', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.user) return;
      $$('[data-cta]').forEach(function (a) {
        a.setAttribute('href', 'app.html');
        a.textContent = 'Открыть суд';
      });
    })
    .catch(function () { /* сервер не запущен: лендинг всё равно читается */ });

  /* ---------- список беты: настоящие заявки ---------- */
  var counter = $('#signupCount');
  if (counter) {
    fetch('/api/waitlist/count')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) counter.textContent = String(d.count); })
      .catch(function () { counter.textContent = '—'; });
  }

  var form = $('#waitlist');
  if (form) {
    var email = $('#email', form);
    var errBox = $('#emailErr', form);
    var okBox = $('#formOk');
    var submit = $('#submitBtn', form);
    var valid = function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); };

    email.addEventListener('input', function () {
      email.setAttribute('aria-invalid', 'false');
      errBox.classList.remove('on');
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var v = email.value.trim();
      if (!valid(v)) {
        email.setAttribute('aria-invalid', 'true');
        errBox.textContent = v ? 'Проверь адрес, похоже на опечатку.' : 'Без почты мы не позовём тебя в бету.';
        errBox.classList.add('on');
        email.focus();
        return;
      }

      var label = submit.textContent;
      submit.disabled = true;
      submit.textContent = 'Отправляем…';

      try {
        var res = await fetch('/api/waitlist', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: v,
            role: $('#role', form) ? $('#role', form).value : 'other',
            city: $('#city', form) ? $('#city', form).value.trim() : ''
          })
        });
        var data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Не отправилось.');

        if (counter && data.count) counter.textContent = String(data.count);
        form.style.display = 'none';
        if (okBox) {
          okBox.classList.add('on');
          $('#okEmail', okBox).textContent = v;
          if (data.already) $('#okNote', okBox).textContent = 'Ты уже был в списке, второй раз не добавили.';
          okBox.setAttribute('tabindex', '-1');
          okBox.focus();
        }
      } catch (err) {
        submit.disabled = false;
        submit.textContent = label;
        errBox.textContent = err.message === 'Failed to fetch'
          ? 'Сервер не отвечает. Запусти бэкенд командой npm start.'
          : err.message;
        errBox.classList.add('on');
      }
    });
  }
})();
