'use strict';

/**
 * Живые обновления через Server-Sent Events.
 * Присяжные подтягиваются постепенно, и сторонам важно видеть счётчик кворума
 * без перезагрузки. SSE достаточно: поток односторонний, переподключение
 * браузер делает сам, вебсокеты и лишняя зависимость не нужны.
 */

const channels = new Map();

function subscribe(disputeId, res) {
  let set = channels.get(disputeId);
  if (!set) {
    set = new Set();
    channels.set(disputeId, set);
  }
  set.add(res);
  res.on('close', function () {
    set.delete(res);
    if (!set.size) channels.delete(disputeId);
  });
}

function publish(disputeId, event, payload) {
  const set = channels.get(disputeId);
  if (!set || !set.size) return;
  const chunk = 'event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n';
  for (const res of set) {
    try { res.write(chunk); } catch (_) { set.delete(res); }
  }
}

function listenerCount(disputeId) {
  const set = channels.get(disputeId);
  return set ? set.size : 0;
}

module.exports = { subscribe, publish, listenerCount };
