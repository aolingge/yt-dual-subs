const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settle = () => new Promise(setImmediate);
const response = text => ({ ok: true, text: async () => JSON.stringify({
  events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: text }] }]
}) });

function mount({ seed = false } = {}) {
  const requests = [], timers = [], posted = [], listeners = {};
  let trackReady = seed;
  let now = 1700000000000;
  class Clock extends Date { static now() { return now; } }
  const player = { getOption(_area, name) {
    if (name === 'track') return trackReady ? { languageCode: 'de', vssId: '.de' } : null;
    if (name === 'tracklist') return [{ languageCode: 'de', vssId: '.de',
      baseUrl: 'https://www.youtube.com/api/timedtext?v=sample&lang=de&pot=seed' }];
  } };
  class XMLHttpRequest {
    open(_method, url) { this.url = url; }
    send() {}
    addEventListener(type, fn) { this.listeners = this.listeners || {}; this.listeners[type] = fn; }
    respond(text) {
      this.status = 200;
      this.responseText = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000,
        segs: [{ utf8: text }] }] });
      this.listeners?.load?.();
    }
  }
  const context = {
    URL, XMLHttpRequest, Date: Clock,
    location: { href: 'https://www.youtube.com/watch?v=sample' },
    document: { getElementById: () => player, querySelector: () => player },
    performance: { getEntriesByType: () => [] },
    fetch(url, init) { return new Promise(resolve => requests.push({ url, init, resolve })); },
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(data) { posted.push(data); },
    setInterval() {},
    setTimeout(fn, ms) { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].cleared = true; }
  };
  // Browser globals share the window. Separate objects used to hide the fact
  // that an extension fetch would pass through its own hook recursively.
  context.window = context;
  const sandbox = vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8'), sandbox);
  const window = vm.runInContext('window', sandbox);
  listeners.message({ source: window, data: { source: 'ytds-content', type: 'config',
    targetLang: 'zh-CN', useTlang: true, nonce: 1 } });
  return { requests, timers, posted,
    advance(ms) { now += ms; },
    enableTrack() { trackReady = true; },
    config(nonce, targetLang = 'zh-CN') {
      listeners.message({ source: window, data: { source: 'ytds-content', type: 'config',
        targetLang, useTlang: true, nonce } });
    },
    navigate(videoId) { context.location.href = `https://www.youtube.com/watch?v=${videoId}`; },
    playerFetch(url) { return context.fetch(url); },
    capture(pot = 'real', language = 'de') {
    const xhr = new context.XMLHttpRequest();
    const videoId = new URL(context.location.href).searchParams.get('v');
    xhr.open('GET', `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${language}&pot=${pot}`);
    xhr.send();
    return xhr;
  } };
}

test('our own early fetch is not a player capture and never recursively refetches itself', async () => {
  const p = mount({ seed: true });
  assert.equal(p.requests.length, 2);
  p.requests.find(r => !new URL(r.url).searchParams.has('tlang'))
    .resolve({ ok: false, status: 403 });
  await settle();
  assert.equal(p.posted.length, 0, 'an unsigned guess does not claim the real track failed');
  p.capture();
  assert.equal(p.requests.length, 3, 'the pending translation is shared with the real capture');
});

test('startup config messages share pending tracks and only the latest nonce is posted', async () => {
  const p = mount();
  p.capture();
  p.config(2);
  assert.equal(p.requests.length, 2, 'one original and one translation request');
  p.requests.find(r => !new URL(r.url).searchParams.has('tlang')).resolve(response('Hallo.'));
  await settle();
  assert.equal(p.posted.length, 1);
  assert.equal(p.posted[0].nonce, 2);
  p.requests.find(r => new URL(r.url).searchParams.has('tlang')).resolve(response('你好。'));
  await settle();
  assert.equal(p.posted.at(-1).nonce, 2);
  assert.equal(p.posted.at(-1).cues[0].trans, '你好。');
  p.config(3);
  await settle();
  assert.equal(p.requests.length, 2, 'already loaded tracks are reused');
  assert.equal(p.posted.at(-1).nonce, 3);
});

test('a translated-track 429 pauses retries across configs, targets, tokens and navigation', async () => {
  const p = mount();
  p.capture();
  p.requests.find(r => new URL(r.url).searchParams.has('tlang')).resolve({ ok: false, status: 429 });
  p.requests.find(r => !new URL(r.url).searchParams.has('tlang')).resolve({ ok: false, status: 503 });
  await settle();
  const retry = p.timers.find(t => t.ms === 750 && !t.cleared);
  retry.fn();
  assert.equal(p.requests.filter(r => new URL(r.url).searchParams.has('tlang')).length, 1);
  p.config(2, 'en');
  p.capture('rotated');
  assert.equal(p.requests.filter(r => new URL(r.url).searchParams.has('tlang')).length, 1);
  p.requests.filter(r => !new URL(r.url).searchParams.has('tlang')).at(-1).resolve(response('Erholt.'));
  await settle();
  assert.equal(p.posted.at(-1).cues[0].text, 'Erholt.', 'translation limits never block the original');
  p.navigate('next');
  p.config(3, 'en');
  p.capture('next-token');
  assert.equal(p.requests.filter(r => new URL(r.url).searchParams.has('tlang')).length, 1,
    'changing videos must not bypass the endpoint cooldown');
  p.advance(20001);
  p.config(4, 'en');
  assert.equal(p.requests.filter(r => new URL(r.url).searchParams.has('tlang')).length, 2,
    'the translated track can be requested after the cooldown');
});

test('a failed guess arriving after the real capture cannot clear or fail over the newer request', async () => {
  const p = mount({ seed: true });
  const guess = p.requests.find(r => !new URL(r.url).searchParams.has('tlang'));
  p.capture();
  guess.resolve({ ok: false, status: 403 });
  await settle();
  assert.equal(p.posted.length, 0);
  p.requests.filter(r => !new URL(r.url).searchParams.has('tlang')).at(-1).resolve(response('Hallo.'));
  await settle();
  assert.equal(p.posted[0].type, 'cues');
  assert.equal(p.posted[0].cues[0].text, 'Hallo.');
});

test('a hung original body reaches its deadline and a fresh token can recover the same track', async () => {
  const p = mount();
  p.capture();
  p.requests.find(r => !new URL(r.url).searchParams.has('tlang'))
    .resolve({ ok: true, text: () => new Promise(() => {}) });
  await settle();
  p.timers.find(t => t.ms === 8000 && !t.cleared).fn();
  await settle();
  assert.equal(p.posted[0].type, 'nocues');
  p.capture('rotated');
  const original = p.requests.filter(r => !new URL(r.url).searchParams.has('tlang')).at(-1);
  assert.equal(new URL(original.url).searchParams.get('pot'), 'rotated');
  original.resolve(response('Erholt.'));
  await settle();
  assert.equal(p.posted.at(-1).cues[0].text, 'Erholt.');
});

test('a hung whole-track translation times out without losing the original', async () => {
  const p = mount();
  p.capture();
  p.requests.find(r => !new URL(r.url).searchParams.has('tlang')).resolve(response('Hallo.'));
  await settle();
  assert.equal(p.posted[0].translationPending, true);
  p.timers.find(t => t.ms === 5000 && !t.cleared).fn();
  await settle();
  assert.equal(p.posted.length, 2);
  assert.equal(p.posted[1].translationUpdate, true);
  assert.equal(p.posted[1].cues[0].text, 'Hallo.');
  assert.equal(p.posted[1].tcues, null);
});

test('a failed source automatically retries without another player capture or page reload', async () => {
  const p = mount();
  p.capture();
  p.requests.find(r => !new URL(r.url).searchParams.has('tlang')).resolve({ ok: false, status: 503 });
  await settle();
  const retry = p.timers.find(t => t.ms === 750 && !t.cleared);
  assert.ok(retry, 'transient failure arms autonomous recovery');
  retry.fn();
  p.requests.filter(r => !new URL(r.url).searchParams.has('tlang')).at(-1).resolve(response('Erholt.'));
  await settle();
  assert.equal(p.posted.at(-1).type, 'cues');
  assert.equal(p.posted.at(-1).cues[0].text, 'Erholt.');
});

test('a player XHR body recovers full captions while the duplicate request is stuck', async () => {
  const p = mount();
  const xhr = p.capture();
  const duplicate = p.requests.find(r => !new URL(r.url).searchParams.has('tlang'));
  xhr.respond('Die ganze Satzzeile.');
  await settle();
  assert.equal(p.posted[0]?.cues?.[0]?.text, 'Die ganze Satzzeile.');
  duplicate.resolve({ ok: false, status: 403 });
  await settle();
  assert.equal(p.posted.some(message => message.type === 'nocues'), false);
});

test('capturing a fetch response keeps the player body readable and does not wait for a duplicate', async () => {
  const p = mount();
  const url = 'https://www.youtube.com/api/timedtext?v=sample&lang=de&pot=player&fmt=json3';
  const player = p.playerFetch(url);
  const body = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000,
    segs: [{ utf8: 'Direkt vom Player.' }] }] });
  p.requests.find(r => r.url === url && !r.init).resolve({ ok: true,
    clone: () => ({ text: async () => body }), text: async () => body });
  assert.equal(await (await player).text(), body);
  await settle();
  assert.equal(p.posted[0]?.cues?.[0]?.text, 'Direkt vom Player.');
});

test('changing translation language reuses loaded original data without requesting it again', async () => {
  const p = mount();
  p.capture();
  p.requests.find(r => !new URL(r.url).searchParams.has('tlang')).resolve(response('Hallo.'));
  await settle();
  const originals = p.requests.filter(r => !new URL(r.url).searchParams.has('tlang')).length;
  p.config(2, 'en');
  await settle();
  assert.equal(p.requests.filter(r => !new URL(r.url).searchParams.has('tlang')).length, originals);
  assert.equal(p.posted.at(-1).cues[0].text, 'Hallo.');
  assert.equal(p.posted.at(-1).nonce, 2);
});

test('a late body from a different source language cannot replace the selected track', async () => {
  const p = mount();
  const german = p.capture('de-token');
  p.capture('en-token', 'en');
  german.respond('Alte deutsche Spur.');
  await settle();
  assert.equal(p.posted.length, 0);
});

test('a queued retry becomes inert after navigation and rate limits wait longer', async () => {
  const p = mount();
  p.capture();
  p.requests.find(r => !new URL(r.url).searchParams.has('tlang')).resolve({ ok: false, status: 429 });
  await settle();
  const retry = p.timers.find(t => t.ms === 20000 && !t.cleared);
  assert.ok(retry, 'a 429 must not start rapid retries');
  p.navigate('next');
  p.config(2);
  const count = p.requests.length;
  retry.fn();
  assert.equal(p.requests.length, count, 'an old retry cannot fetch the previous video');
});

test('repeated source failures stop after a bounded number of automatic retries', async () => {
  const p = mount();
  p.capture();
  let finalTimerCount;
  for (let i = 0; i < 4; i++) {
    if (i === 3) finalTimerCount = p.timers.length;
    p.requests.filter(r => !new URL(r.url).searchParams.has('tlang')).at(-1)
      .resolve({ ok: false, status: 503 });
    await settle();
    if (i < 3) p.timers.filter(t => t.ms === [750, 2000, 5000][i] && !t.cleared).at(-1).fn();
  }
  assert.equal(p.requests.filter(r => !new URL(r.url).searchParams.has('tlang')).length, 4);
  assert.equal(p.timers.length, finalTimerCount, 'the final failure schedules no further request');
});

test('a selected track that appears after 1.4 seconds is still discovered automatically', () => {
  const p = mount();
  for (let i = 0; i < 7; i++) {
    const timer = p.timers.filter(t => t.ms === 200 && !t.cleared).at(-1);
    assert.ok(timer);
    timer.cleared = true;
    timer.fn();
  }
  p.enableTrack();
  p.timers.filter(t => t.ms === 200 && !t.cleared).at(-1).fn();
  assert.equal(p.requests.length, 2);
});
