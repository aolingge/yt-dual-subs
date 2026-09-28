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
  const player = { getOption(_area, name) {
    if (name === 'track') return seed ? { languageCode: 'de', vssId: '.de' } : null;
    if (name === 'tracklist') return [{ languageCode: 'de', vssId: '.de',
      baseUrl: 'https://www.youtube.com/api/timedtext?v=sample&lang=de&pot=seed' }];
  } };
  class XMLHttpRequest { open(_method, url) { this.url = url; } send() {} }
  const context = {
    URL, XMLHttpRequest,
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
  return { requests, timers, posted, capture(pot = 'real') {
    const xhr = new context.XMLHttpRequest();
    xhr.open('GET', `https://www.youtube.com/api/timedtext?v=sample&lang=de&pot=${pot}`);
    xhr.send();
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
  assert.equal(p.requests.length, 4);
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
