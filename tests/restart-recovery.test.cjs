const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function mount() {
  const listeners = { startup: null, installed: null, message: null };
  const queries = [];
  const reloads = [];
  const timers = [];
  const tabs = [
    { id: 1, status: 'complete', url: 'https://www.youtube.com/watch?v=healthy' },
    { id: 2, status: 'complete', url: 'https://www.youtube.com/watch?v=stale' },
    { id: 3, status: 'loading', url: 'https://www.youtube.com/watch?v=loading' }
  ];
  const queryResults = [];
  const localStore = {};
  const replies = new Map([
    [1, { ok: true, version: '3.12.0' }],
    [2, undefined],
  ]);
  const chrome = {
    runtime: {
      lastError: undefined,
      getManifest() { return { version: '3.12.0' }; },
      onMessage: { addListener(fn) { listeners.message = fn; } },
      onStartup: { addListener(fn) { listeners.startup = fn; } },
      onInstalled: { addListener(fn) { listeners.installed = fn; } }
    },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      query(filter, done) {
        queries.push(filter);
        done(queryResults.length ? queryResults.shift() : tabs);
      },
      sendMessage(id, _message, done) {
        if (!replies.has(id)) chrome.runtime.lastError = new Error('content script unavailable');
        done(replies.get(id));
        chrome.runtime.lastError = undefined;
      },
      reload(id, done) {
        reloads.push(id);
        done?.();
      },
      onUpdated: { addListener(fn) { listeners.updated = fn; } }
    },
    storage: {
      local: {
        get(_key, done) { done({ ...localStore }); },
        set(values, done) { Object.assign(localStore, values); done?.(); }
      }
    }
  };
  vm.runInNewContext(source, {
    chrome,
    fetch: async () => ({ ok: true, json: async () => [] }),
    importScripts() {},
    YtdsSettings: { startSync() {}, enqueue() { return Promise.resolve(); } },
    Promise, Map, Set, Object, Array, String, Number, Boolean, Error, JSON,
    console,
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout(id) { if (timers[id - 1]) timers[id - 1].fn = null; },
    setInterval, clearInterval, Date
  });
  return {
    listeners, queries, reloads, tabs, queryResults, replies, timers, localStore,
    message(msg) {
      return new Promise((resolve) => listeners.message(msg, {}, resolve));
    },
    runNextTimer() {
      const timer = timers.find((entry) => typeof entry.fn === 'function');
      if (timer) timer.fn();
    }
  };
}

test('browser startup repairs only YouTube tabs whose content context is gone', async () => {
  const api = mount();
  api.listeners.startup();
  await new Promise(setImmediate);
  assert.equal(api.queries.length, 1);
  assert.equal(api.queries[0].url.length, 1);
  assert.equal(api.queries[0].url[0], 'https://www.youtube.com/*');
  assert.deepEqual(api.reloads, [2]);
});

test('an extension update runs the same targeted recovery pass', async () => {
  const api = mount();
  api.listeners.installed({ reason: 'update' });
  await new Promise(setImmediate);
  assert.equal(api.queries.length, 1);
  assert.deepEqual(api.reloads, [2]);
});

test('a healthy response from an older content script is repaired', async () => {
  const api = mount();
  api.replies.set(1, { ok: true, version: '3.11.0' });
  api.replies.set(2, { ok: true, version: '3.12.0' });
  api.listeners.startup();
  await new Promise(setImmediate);
  assert.deepEqual(api.reloads, [1]);
});

test('startup retries after the session query is temporarily empty', async () => {
  const api = mount();
  api.queryResults.push([]);
  api.listeners.startup();
  await new Promise(setImmediate);
  assert.equal(api.queries.length, 1);
  api.runNextTimer();
  await new Promise(setImmediate);
  assert.equal(api.queries.length, 2);
  assert.deepEqual(api.reloads, [2]);
});

test('a second probe in the same recovery window does not reload repeatedly', async () => {
  const api = mount();
  api.listeners.startup();
  await new Promise(setImmediate);
  api.listeners.updated(2, { status: 'complete' }, api.tabs[1]);
  await new Promise(setImmediate);
  assert.deepEqual(api.reloads, [2]);
});

test('recovery diagnostics retain the latest state and failure reason', async () => {
  const api = mount();
  api.replies.set(1, undefined);
  api.replies.set(2, undefined);
  api.listeners.startup();
  await new Promise(setImmediate);

  const report = await api.message({ type: 'recoveryStatus' });
  assert.equal(report.ok, true);
  assert.equal(report.recovery.state, 'reloading');
  assert.equal(report.recovery.reason, 'content-unavailable');
  assert.equal(report.recovery.tabId, 2);
});
