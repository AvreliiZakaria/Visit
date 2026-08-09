/**
 * Клиент API «Вердикта». Один слой, через который ходят все страницы.
 * Токен анонимный, лежит в localStorage. Ни почты, ни пароля.
 */
window.VerdictAPI = (function () {
  'use strict';

  var BASE = '/api';
  var TOKEN_KEY = 'verdict_token';
  var DEVICE_KEY = 'verdict_device';

  function deviceId() {
    var d = localStorage.getItem(DEVICE_KEY);
    if (!d) {
      d = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(36).slice(2);
      localStorage.setItem(DEVICE_KEY, d);
    }
    return d;
  }

  function token() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }

  function ApiError(message, code, status) {
    this.message = message;
    this.code = code;
    this.status = status;
  }
  ApiError.prototype = Object.create(Error.prototype);

  async function call(method, url, body, isForm) {
    var headers = {};
    var t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
    if (body && !isForm) headers['Content-Type'] = 'application/json';

    var res = await fetch(BASE + url, {
      method: method,
      headers: headers,
      body: !body ? undefined : (isForm ? body : JSON.stringify(body))
    });

    if (res.status === 204) return null;

    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }

    if (!res.ok) {
      throw new ApiError(
        (data && data.message) || 'Сервер ответил ошибкой.',
        (data && data.error) || 'http_' + res.status,
        res.status
      );
    }
    return data;
  }

  return {
    ApiError: ApiError,
    token: token,

    /** Живой ли бэкенд. Возвращает объект или null. */
    async health() {
      try { return await call('GET', '/health'); } catch (e) { return null; }
    },

    /** Гарантирует анонимный аккаунт и возвращает пользователя. */
    async ensureUser() {
      if (token()) {
        try { return (await call('GET', '/auth/me')).user; } catch (e) { /* токен умер, заводим новый */ }
      }
      var r = await call('POST', '/auth/anon', { deviceId: deviceId() });
      setToken(r.token);
      return r.user;
    },

    me() { return call('GET', '/auth/me'); },
    deleteMe() { return call('DELETE', '/me'); },

    createDispute(topic, consent) { return call('POST', '/disputes', { topic: topic, consent: !!consent }); },
    myDisputes() { return call('GET', '/disputes/mine'); },
    dispute(id) { return call('GET', '/disputes/' + id); },
    publishOneSided(id) { return call('POST', '/disputes/' + id + '/publish-one-sided', {}); },

    /** blob с микрофона, длительность в мс, текстовая расшифровка если есть */
    uploadSide(disputeId, label, blob, durationMs, transcript) {
      var fd = new FormData();
      var type = blob.type || '';
      var ext = type.indexOf('mp4') > -1 ? 'm4a' : type.indexOf('ogg') > -1 ? 'ogg' : 'webm';
      fd.append('audio', blob, 'side-' + label + '.' + ext);
      fd.append('durationMs', String(Math.round(durationMs)));
      if (transcript) fd.append('transcript', transcript);
      return call('POST', '/disputes/' + disputeId + '/sides/' + label + '/audio', fd, true);
    },

    byCode(code) { return call('GET', '/disputes/by-code/' + encodeURIComponent(code)); },
    claim(code) { return call('POST', '/disputes/by-code/' + encodeURIComponent(code) + '/claim', {}); },

    nextCase() { return call('GET', '/jury/next'); },
    vote(assignmentId, payload) { return call('POST', '/jury/' + assignmentId + '/vote', payload); },
    skipCase(assignmentId) { return call('POST', '/jury/' + assignmentId + '/skip', {}); },

    comments(disputeId) { return call('GET', '/comments/' + disputeId); },
    upvote(commentId) { return call('POST', '/comments/' + commentId + '/upvote', {}); },
    report(payload) { return call('POST', '/reports', payload); },

    tiers() { return call('GET', '/billing/tiers'); },
    checkout(tier, disputeId) { return call('POST', '/billing/checkout', { tier: tier, disputeId: disputeId }); },

    stats() { return call('GET', '/stats'); },
    funnel() { return call('GET', '/funnel'); },
    waitlist(email, role) { return call('POST', '/waitlist', { email: email, role: role }); },

    /** URL записи с токеном в query: заголовки в тег audio не поставить. */
    audioUrl(path) {
      var t = token();
      return path + (t ? '?token=' + encodeURIComponent(t) : '');
    }
  };
})();
