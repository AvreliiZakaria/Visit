/* =========================================================
   Клиент API «Вердикта».
   Один слой над fetch: cookie-сессия, понятные ошибки,
   запись аудио через MediaRecorder, живой поток кворума.
   ========================================================= */
(function (global) {
  'use strict';

  var BASE = '/api';

  function ApiError(message, code, status) {
    var e = new Error(message);
    e.name = 'ApiError';
    e.code = code;
    e.status = status;
    return e;
  }

  async function request(method, path, body) {
    var init = { method: method, credentials: 'same-origin', headers: {} };

    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    var res;
    try {
      res = await fetch(BASE + path, init);
    } catch (_) {
      throw ApiError('Сервер не отвечает. Проверь, запущен ли бэкенд.', 'offline', 0);
    }

    if (res.status === 204) return null;

    var data = null;
    var text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    }

    if (!res.ok) {
      throw ApiError(
        (data && data.message) || 'Запрос не прошёл',
        (data && data.error) || 'http_' + res.status,
        res.status
      );
    }
    return data;
  }

  var api = {
    health: function () { return request('GET', '/health'); },

    /* ---------- аккаунт ---------- */
    register: function (email, password, ageConfirmed) {
      return request('POST', '/auth/register', {
        email: email, password: password, ageConfirmed: ageConfirmed
      });
    },
    login: function (email, password) {
      return request('POST', '/auth/login', { email: email, password: password });
    },
    logout: function () { return request('POST', '/auth/logout'); },
    me: function () { return request('GET', '/auth/me'); },
    deleteAccount: function () { return request('DELETE', '/auth/me'); },

    /* ---------- споры ---------- */
    createDispute: function (topic, consentContent) {
      return request('POST', '/disputes', { topic: topic, consentContent: consentContent });
    },
    myDisputes: function () { return request('GET', '/disputes/mine'); },
    getDispute: function (id) { return request('GET', '/disputes/' + id); },
    remind: function (id) { return request('POST', '/disputes/' + id + '/remind'); },
    publishOneSided: function (id) { return request('POST', '/disputes/' + id + '/publish-one-sided'); },

    uploadSide: function (disputeId, blob, durationMs) {
      var form = new FormData();
      var ext = (blob.type.split('/')[1] || 'webm').split(';')[0];
      form.append('audio', blob, 'side.' + ext);
      form.append('durationMs', String(Math.round(durationMs)));
      return request('POST', '/disputes/' + disputeId + '/sides', form);
    },

    /* ---------- приглашение ---------- */
    peekInvite: function (token) { return request('GET', '/disputes/invite/' + token); },
    acceptInvite: function (token) { return request('POST', '/disputes/invite/' + token + '/accept'); },

    /* ---------- жюри ---------- */
    nextCase: function () { return request('GET', '/jury/next'); },
    vote: function (disputeId, payload) { return request('POST', '/jury/' + disputeId + '/vote', payload); },
    comment: function (disputeId, body) { return request('POST', '/jury/' + disputeId + '/comment', { body: body }); },
    upvote: function (commentId) { return request('POST', '/jury/comments/' + commentId + '/upvote'); },
    comments: function (disputeId) { return request('GET', '/jury/' + disputeId + '/comments'); },

    /* ---------- деньги ---------- */
    catalog: function () { return request('GET', '/payments/catalog'); },
    checkout: function (product, disputeId) {
      return request('POST', '/payments/checkout', { product: product, disputeId: disputeId });
    },
    myPayments: function () { return request('GET', '/payments/mine'); },

    /* ---------- жалобы ---------- */
    report: function (targetType, targetId, reason, detail) {
      return request('POST', '/moderation/reports', {
        targetType: targetType, targetId: targetId, reason: reason, detail: detail
      });
    },

    /* ---------- живой кворум ---------- */
    streamDispute: function (disputeId, handlers) {
      var es = new EventSource(BASE + '/disputes/' + disputeId + '/stream');
      Object.keys(handlers || {}).forEach(function (evt) {
        es.addEventListener(evt, function (e) {
          var payload = null;
          try { payload = JSON.parse(e.data); } catch (_) {}
          handlers[evt](payload);
        });
      });
      return es;
    }
  };

  /* =========================================================
     Запись аудио: настоящий микрофон, настоящий MediaRecorder.
     ========================================================= */
  function Recorder() {
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.startedAt = 0;
    this.durationMs = 0;
    this.blob = null;
    this.analyser = null;
    this.audioCtx = null;
  }

  Recorder.supported = function () {
    return Boolean(
      global.navigator && global.navigator.mediaDevices &&
      global.navigator.mediaDevices.getUserMedia && global.MediaRecorder
    );
  };

  Recorder.prototype.pickMime = function () {
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < candidates.length; i++) {
      if (global.MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  };

  Recorder.prototype.start = async function (onLevel) {
    if (!Recorder.supported()) {
      throw ApiError('Браузер не умеет записывать звук. Открой в Chrome, Safari или Firefox.', 'no_recorder', 0);
    }

    try {
      this.stream = await global.navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (err) {
      var msg = err && err.name === 'NotAllowedError'
        ? 'Доступ к микрофону запрещён. Разреши его в настройках сайта.'
        : 'Микрофон недоступен.';
      throw ApiError(msg, 'mic_denied', 0);
    }

    var mime = this.pickMime();
    this.rec = new global.MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.blob = null;

    var self = this;
    this.rec.ondataavailable = function (e) {
      if (e.data && e.data.size) self.chunks.push(e.data);
    };

    /* Уровень сигнала для волны: рисуем то, что реально слышит микрофон. */
    if (typeof onLevel === 'function' && global.AudioContext) {
      this.audioCtx = new global.AudioContext();
      var src = this.audioCtx.createMediaStreamSource(this.stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
      var buf = new Uint8Array(this.analyser.frequencyBinCount);
      var loop = function () {
        if (!self.analyser) return;
        self.analyser.getByteFrequencyData(buf);
        var sum = 0;
        for (var i = 0; i < buf.length; i++) sum += buf[i];
        onLevel(sum / buf.length / 255);
        global.requestAnimationFrame(loop);
      };
      loop();
    }

    this.rec.start(250);
    this.startedAt = Date.now();
  };

  Recorder.prototype.stop = function () {
    var self = this;
    return new Promise(function (resolve) {
      if (!self.rec || self.rec.state === 'inactive') return resolve(null);
      self.rec.onstop = function () {
        self.durationMs = Date.now() - self.startedAt;
        self.blob = new Blob(self.chunks, { type: (self.rec.mimeType || 'audio/webm').split(';')[0] });
        self.cleanup();
        resolve({ blob: self.blob, durationMs: self.durationMs });
      };
      self.rec.stop();
    });
  };

  Recorder.prototype.cleanup = function () {
    if (this.stream) {
      this.stream.getTracks().forEach(function (t) { t.stop(); });
      this.stream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(function () {});
      this.audioCtx = null;
    }
    this.analyser = null;
  };

  /* Идентификатор устройства для антифрода. Не персональные данные, просто соль. */
  function deviceId() {
    var key = 'verdict_device';
    var v = null;
    try { v = global.localStorage.getItem(key); } catch (_) {}
    if (!v) {
      v = (global.crypto && global.crypto.randomUUID)
        ? global.crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(36).slice(2);
      try { global.localStorage.setItem(key, v); } catch (_) {}
    }
    return v;
  }

  global.VerdictAPI = api;
  global.VerdictRecorder = Recorder;
  global.verdictDeviceId = deviceId;
})(window);
