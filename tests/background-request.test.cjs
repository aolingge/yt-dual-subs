// The Google fallback in background.js: one deadline per attempt, exactly one
// retry for a dropped connection, and never a retry for a rate-limit answer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const tick = () => new Promise(setImmediate);

class FakeAbortController {
  constructor() {
    this.signal = {
      aborted: false, listeners: [],
      addEventListener(type, listener) { if (type === 'abort') this.listeners.push(listener); }
    };
  }
  abort() {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    for (const listener of this.signal.listeners) listener();
  }
}

// withTimers injects a controllable clock so a request that never settles can be
// driven past its 8000 ms deadline without waiting.
function mountBackground(fetch, { withTimers = false } = {}) {
  const listeners = {};
  const timers = [];
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listeners.message = fn; } }, lastError: undefined },
    commands: { onCommand: { addListener() {} } },
    tabs: { query() {}, sendMessage() {} }
  };
  const sandbox = { chrome, fetch, Map };
  if (withTimers) {
    sandbox.AbortController = FakeAbortController;
    sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; };
    sandbox.clearTimeout = (id) => { if (id >= 1 && timers[id - 1]) timers[id - 1].cleared = true; };
  }
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), sandbox);
  const request = (text) => new Promise((resolve) => {
    listeners.message({ type: 'translate', text, targetLang: 'zh-CN', sourceLang: 'de' },
      {}, resolve);
  });
  return { request, timers };
}

test('a dropped connection is retried exactly once and every deadline is cleared', async () => {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    if (urls.length === 1) throw new Error('network down');
    return { ok: true, status: 200, json: async () => [[['你好。']]] };
  };
  const { request, timers } = mountBackground(fetch, { withTimers: true });
  const reply = await request('Hallo.');

  assert.deepEqual({ ...reply }, { ok: true, translated: '你好。' });
  assert.equal(urls.length, 2);
  assert.equal(timers.length, 2, 'one deadline per attempt');
  assert.deepEqual(timers.map((timer) => timer.cleared), [true, true]);
});

test('a rate-limit answer is reported at once and never retried', async () => {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return { ok: false, status: 429, json: async () => null };
  };
  const { request } = mountBackground(fetch, { withTimers: true });
  const reply = await request('Hallo.');

  assert.equal(reply.ok, false);
  assert.match(reply.error, /429/);
  assert.equal(urls.length, 1, 'retrying a rate limit only deepens it');
});

test('a hung request is aborted at its deadline, retried once, then gives up', async () => {
  const started = [];
  const fetch = (url, init) => new Promise((_resolve, reject) => {
    started.push(url);
    const signal = init && init.signal;
    if (!signal) return;                                     // never settles
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const { request, timers } = mountBackground(fetch, { withTimers: true });
  const pending = request('Hallo.');
  await tick();

  assert.equal(started.length, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 8000);

  timers[0].fn();                                            // the deadline fires
  await tick();
  assert.equal(started.length, 2, 'exactly one retry');
  assert.equal(timers[0].cleared, true);

  timers[1].fn();
  await tick();
  const reply = await pending;
  assert.equal(reply.ok, false);
  assert.match(reply.error, /aborted/);
  assert.equal(started.length, 2, 'and then it stops trying');
});
