/* Клиент API «Вердикта». Сессия хранится в httpOnly-cookie сервера. */
(function (global) {
  'use strict';
  var BASE = '/api';

  function ApiError(message, code, status) {
    var e = new Error(message); e.name = 'ApiError'; e.code = code; e.status = status; return e;
  }

  async function request(method, path, body) {
    var init = { method: method, credentials: 'same-origin', headers: {} };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    var res;
    try { res = await fetch(BASE + path, init); }
    catch (_) { throw ApiError('Сервер не отвечает. Запусти npm run dev.', 'offline', 0); }
    var text = await res.text(), data = null;
    if (text) { try { data = JSON.parse(text); } catch (_) { data = { raw: text }; } }
    if (!res.ok) throw ApiError((data && data.message) || 'Запрос не прошёл', (data && data.error) || 'http_' + res.status, res.status);
    return data;
  }

  function deviceId() {
    var key = 'verdict_device', value = null;
    try { value = localStorage.getItem(key); } catch (_) {}
    if (!value) {
      value = global.crypto && global.crypto.randomUUID ? global.crypto.randomUUID() : String(Date.now()) + Math.random();
      try { localStorage.setItem(key, value); } catch (_) {}
    }
    return value;
  }

  var api = {
    health: function () { return request('GET', '/health'); },
    register: function (email, password, ageConfirmed) { return request('POST', '/auth/register', { email: email, password: password, ageConfirmed: ageConfirmed }); },
    login: function (email, password) { return request('POST', '/auth/login', { email: email, password: password }); },
    logout: function () { return request('POST', '/auth/logout'); },
    me: function () { return request('GET', '/auth/me'); },
    deleteAccount: function () { return request('DELETE', '/auth/me'); },

    createDispute: function (topic, consentContent) { return request('POST', '/disputes', { topic: topic, consentContent: !!consentContent }); },
    myDisputes: function () { return request('GET', '/disputes/mine'); },
    getDispute: function (id) { return request('GET', '/disputes/' + encodeURIComponent(id)); },
    remind: function (id) { return request('POST', '/disputes/' + id + '/remind'); },
    publishOneSided: function (id) { return request('POST', '/disputes/' + id + '/publish-one-sided'); },
    uploadSide: function (disputeId, blob, durationMs) {
      var fd = new FormData();
      var ext = (blob.type || 'audio/webm').split('/')[1].split(';')[0];
      fd.append('audio', blob, 'side.' + ext);
      fd.append('durationMs', String(Math.round(durationMs)));
      return request('POST', '/disputes/' + disputeId + '/sides', fd);
    },
    peekInvite: function (token) { return request('GET', '/disputes/invite/' + encodeURIComponent(token)); },
    acceptInvite: function (token) { return request('POST', '/disputes/invite/' + encodeURIComponent(token) + '/accept'); },

    nextCase: function () { return request('GET', '/jury/next'); },
    vote: function (disputeId, payload) { return request('POST', '/jury/' + disputeId + '/vote', payload); },
    comment: function (disputeId, body) { return request('POST', '/jury/' + disputeId + '/comment', { body: body }); },
    upvote: function (commentId) { return request('POST', '/jury/comments/' + commentId + '/upvote'); },
    comments: function (disputeId) { return request('GET', '/jury/' + disputeId + '/comments'); },
    report: function (type, targetId, reason, detail) { return request('POST', '/moderation/reports', { targetType: type, targetId: targetId, reason: reason, detail: detail }); },

    catalog: function () { return request('GET', '/payments/catalog'); },
    checkout: function (product, disputeId) { return request('POST', '/payments/checkout', { product: product, disputeId: disputeId }); },
    myPayments: function () { return request('GET', '/payments/mine'); },
    streamDispute: function (id, handlers) {
      var es = new EventSource(BASE + '/disputes/' + id + '/stream');
      Object.keys(handlers || {}).forEach(function (name) { es.addEventListener(name, function (event) { var data; try { data = JSON.parse(event.data); } catch (_) {} handlers[name](data); }); });
      return es;
    }
  };

  function Recorder() { this.stream = null; this.rec = null; this.chunks = []; this.startedAt = 0; this.audioCtx = null; this.analyser = null; }
  Recorder.supported = function () { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && global.MediaRecorder); };
  Recorder.prototype.pickMime = function () {
    var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < types.length; i++) if (global.MediaRecorder.isTypeSupported(types[i])) return types[i];
    return '';
  };
  Recorder.prototype.start = async function (onLevel) {
    if (!Recorder.supported()) throw ApiError('Браузер не умеет записывать звук. Используй Chrome или Edge.', 'no_recorder', 0);
    try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (err) { throw ApiError(err.name === 'NotAllowedError' ? 'Разреши доступ к микрофону в браузере.' : 'Микрофон недоступен.', 'mic_denied', 0); }
    var mime = this.pickMime(); this.rec = new global.MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined); this.chunks = [];
    var self = this; this.rec.ondataavailable = function (e) { if (e.data && e.data.size) self.chunks.push(e.data); };
    if (onLevel && global.AudioContext) {
      this.audioCtx = new global.AudioContext(); var source = this.audioCtx.createMediaStreamSource(this.stream); this.analyser = this.audioCtx.createAnalyser(); this.analyser.fftSize = 512; source.connect(this.analyser);
      var buf = new Uint8Array(this.analyser.frequencyBinCount);
      (function loop() { if (!self.analyser) return; self.analyser.getByteFrequencyData(buf); var sum = 0; for (var i = 0; i < buf.length; i++) sum += buf[i]; onLevel(sum / buf.length / 255); requestAnimationFrame(loop); })();
    }
    this.rec.start(250); this.startedAt = Date.now();
  };
  Recorder.prototype.stop = function () {
    var self = this; return new Promise(function (resolve) {
      if (!self.rec || self.rec.state === 'inactive') return resolve(null);
      self.rec.onstop = function () { var ms = Date.now() - self.startedAt; var blob = new Blob(self.chunks, { type: (self.rec.mimeType || 'audio/webm').split(';')[0] }); self.cleanup(); resolve({ blob: blob, durationMs: ms }); };
      self.rec.stop();
    });
  };
  Recorder.prototype.cleanup = function () { if (this.stream) { this.stream.getTracks().forEach(function (t) { t.stop(); }); this.stream = null; } if (this.audioCtx) { this.audioCtx.close().catch(function () {}); this.audioCtx = null; } this.analyser = null; };

  global.VerdictAPI = api;
  global.VerdictRecorder = Recorder;
  global.verdictDeviceId = deviceId;
})(window);
