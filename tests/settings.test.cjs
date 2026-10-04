const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'settings.js'), 'utf8');
const KEY = 'settingsPendingV1';
const copy = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(setImmediate);

function mount({ local = {}, sync = {}, vault = {}, failSync = null, failLocal = false } = {}) {
  let now = 10000, seq = 0;
  const timers = new Map(), listeners = [], attempts = [], notices = [];
  const emit = (changes, area) => { for (const fn of listeners) fn(copy(changes), area); };
  const read = (data, keys, done) => {
    const value = typeof keys === 'string' ? { [keys]: data[keys] }
      : { ...(keys || {}), ...data };
    const answer = copy(value);
    if (done) { done(answer); return; }
    return Promise.resolve(answer);
  };
  const write = (data, patch, area) => {
    const changes = {};
    for (const [key, value] of Object.entries(copy(patch))) {
      changes[key] = { oldValue: data[key], newValue: value };
      data[key] = value;
    }
    emit(changes, area);
  };
  const chrome = {
    runtime: { lastError: undefined,
      sendMessage(msg, done) {
        if (msg.type === 'getBridgeConfig') {
          worker.getBridgeConfig().then(config => done({ ok: true, ...config })); return;
        }
        worker.enqueue(msg.patch).then(() => done({ ok: true }),
          (error) => done({ ok: false, error: String(error) }));
      } },
    storage: {
      onChanged: { addListener(fn) { listeners.push(fn); } },
      local: {
        get: (keys, done) => read(local, keys, done),
        async set(patch) {
          if (failLocal) throw new Error('local storage failure');
          write(local, patch, 'local');
        }
      },
      sync: {
        get: (keys, done) => read(sync, keys, done),
        async set(patch) {
          attempts.push({ time: now, values: copy(patch) });
          if (failSync) throw new Error(failSync);
          write(sync, patch, 'sync');
        },
        remove(keys) { for (const key of keys) delete sync[key]; }
      }
    }
  };
  function context() {
    const realm = vm.createContext({ chrome,
      YtdsBridgeVault: { read: async () => vault.token, write: async token => { vault.token = token; } },
      Date: class extends Date { static now() { return now; } },
      setTimeout(fn, delay) { const id = ++seq; timers.set(id, { at: now + delay, fn }); return id; },
      clearTimeout(id) { timers.delete(id); } });
    vm.runInContext(source, realm);
    return realm.YtdsSettings;
  }
  const worker = context();
  const client = context();
  client.onChanged((changes) => notices.push(copy(changes)));
  const api = {
    worker, client, local, sync, vault, attempts, notices,
    newClient: context,
    setFailSync(value) { failSync = value; },
    remote(patch) { write(sync, patch, 'sync'); },
    async advance(ms) {
      const end = now + ms;
      await settle();
      while (true) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = Math.max(now, due[1].at); timers.delete(due[0]); due[1].fn();
        await settle();
      }
      now = end; await settle();
    },
    suspend() { timers.clear(); }
  };
  return api;
}

const get = (client, defaults = {}) => new Promise(resolve => client.get(defaults, resolve));

test('legacy default highlight palette migrates once and later user edits survive', async () => {
  const defaults = { karaokeBg: '#ffd65c', karaokeTextColor: '#ffffff',
    karaokeOpacity: 0.95, karaokeStyleV2: false };
  const p = mount({ sync: { karaokeBg: '#ffd65c', karaokeTextColor: '#161616', karaokeOpacity: 0.95 } });
  assert.equal((await get(p.client, defaults)).karaokeTextColor, '#ffffff');
  await p.advance(300);
  assert.equal(p.sync.karaokeStyleV2, true);
  assert.equal(p.sync.karaokeTextColor, '#ffffff');
  await p.client.set({ karaokeTextColor: '#161616' });
  assert.equal((await get(p.newClient(), defaults)).karaokeTextColor, '#161616',
    'a deliberate later edit is not migrated a second time');
});

test('custom highlight palettes are preserved during the one-time style upgrade', async () => {
  const defaults = { karaokeBg: '#ffd65c', karaokeTextColor: '#ffffff',
    karaokeOpacity: 0.95, karaokeStyleV2: false };
  for (const patch of [{ karaokeBg: '#aaffaa' }, { karaokeOpacity: 0.6 }, { karaokeTextColor: '#202020' }]) {
    const palette = { karaokeBg: '#ffd65c', karaokeTextColor: '#161616', karaokeOpacity: 0.95, ...patch };
    const p = mount({ sync: palette });
    const current = await get(p.client, defaults);
    assert.equal(current.karaokeTextColor, palette.karaokeTextColor);
    assert.equal(current.karaokeBg, palette.karaokeBg);
    assert.equal(current.karaokeOpacity, palette.karaokeOpacity);
    await p.advance(300);
    assert.equal(p.sync.karaokeStyleV2, true);
    assert.equal(p.sync.karaokeTextColor, palette.karaokeTextColor);
  }
});

test('hundreds of slider edits apply locally and coalesce into one sync write', async () => {
  const p = mount();
  await p.worker.startSync();
  await get(p.client, { karaokeOpacity: 0.95 });
  for (let i = 0; i < 200; i++) await p.client.set({ karaokeOpacity: i / 200 });
  assert.equal(p.attempts.length, 0);
  assert.equal(p.notices.at(-1).karaokeOpacity.newValue, 0.995, 'live preview does not wait for sync');
  assert.equal((await get(p.newClient())).karaokeOpacity, 0.995, 'a reopened popup sees the last edit');
  await p.advance(250);
  assert.equal(p.attempts.length, 1);
  assert.equal(p.sync.karaokeOpacity, 0.995);
  assert.deepEqual(p.local[KEY].values, {});
});

test('sustained edits stay below both sync quotas and the interval survives worker restart', async () => {
  const p = mount();
  for (let i = 0; i < 70; i++) {
    await p.worker.enqueue({ overlayWidthPct: i });
    await p.advance(300);
  }
  await p.advance(3000);
  assert.ok(p.attempts.length <= 10);
  for (let i = 1; i < p.attempts.length; i++) {
    assert.ok(p.attempts[i].time - p.attempts[i - 1].time >= 2500);
  }
  const lastAt = p.attempts.at(-1).time;
  p.suspend();
  const restarted = mount({ local: p.local, sync: p.sync });
  await restarted.worker.enqueue({ overlayWidthPct: 92 });
  await restarted.advance(Math.max(0, lastAt + 2499 - 10000));
  assert.equal(restarted.attempts.length, 0, 'persisted sync deadline applies to a new worker');
});

test('minute quota failure keeps preferences readable and retries after worker reactivation', async () => {
  const p = mount({ failSync: 'This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.' });
  await p.worker.enqueue({ karaokeBg: '#ffffff', karaokeTextColor: '#000000' });
  await p.advance(250);
  assert.equal(p.attempts.length, 1);
  assert.equal(p.local[KEY].values.karaokeBg, '#ffffff');
  await p.advance(60000);
  assert.equal(p.attempts.length, 1, 'do not deepen the quota failure');
  p.suspend();
  const restarted = mount({ local: p.local, sync: p.sync });
  assert.equal((await get(restarted.client)).karaokeBg, '#ffffff');
  await restarted.worker.startSync();
  await restarted.advance(p.local[KEY].nextSyncAt - 10000);
  assert.equal(restarted.sync.karaokeTextColor, '#000000');
  assert.deepEqual(restarted.local[KEY].values, {});
});

test('hour quota failure waits an hour while retaining later edits', async () => {
  const p = mount({ failSync: 'MAX_WRITE_OPERATIONS_PER_HOUR quota' });
  await p.worker.enqueue({ origSize: 22 });
  await p.advance(250);
  await p.worker.enqueue({ origSize: 26 });
  await p.advance(3600000);
  assert.equal(p.attempts.length, 1);
  p.setFailSync(null);
  await p.advance(1000);
  assert.equal(p.sync.origSize, 26);
});

test('pending edits mask stale sync events and acknowledge sync only once', async () => {
  const p = mount({ sync: { karaokeOpacity: 0.95, targetLang: 'zh-CN' } });
  await get(p.client);
  await p.client.set({ karaokeOpacity: 1 });
  p.remote({ karaokeOpacity: 0.2, targetLang: 'de' });
  assert.equal(p.notices.length, 2);
  assert.deepEqual(p.notices[1], { targetLang: { oldValue: 'zh-CN', newValue: 'de' } });
  await p.advance(250);
  assert.equal(p.notices.length, 2, 'syncing the staged value must not reapply or refetch it');
  assert.equal(p.sync.karaokeOpacity, 1);
  p.remote({ karaokeOpacity: 0.5 });
  assert.equal(p.notices.at(-1).karaokeOpacity.newValue, 0.5);
});

test('staging never deletes saved sentence cards and reports local write failure', async () => {
  const cards = [{ original: 'Hallo.' }];
  const p = mount({ local: { studyCardsV1: cards } });
  await p.client.set({ origSize: 22, karaoke: true });
  await p.advance(250);
  assert.deepEqual(p.local.studyCardsV1, cards);
  const failed = mount({ failLocal: true });
  await assert.rejects(failed.client.set({ origSize: 28 }), /local storage failure/);
  assert.equal(failed.local[KEY], undefined, 'failed writes must not be acknowledged as saved');
});

test('only scalar preference patches enter the settings queue', async () => {
  const p = mount();
  await assert.rejects(p.worker.enqueue({ studyCardsV1: ['not a preference'], origSize: Infinity }), /Invalid/);
  assert.equal(p.local[KEY], undefined);
});

test('settings queue accepts only known keys and safe ranges', async () => {
  const p = mount();
  await assert.rejects(p.worker.enqueue({ unknownPreference: true }), /Invalid/);
  await assert.rejects(p.worker.enqueue({ origSize: 1000 }), /Invalid/);
  await assert.rejects(p.worker.enqueue({ bridgeBase: 'https://example.com:8766', bridgeToken: 'secret' }), /Invalid/);
  await p.worker.enqueue({ bridgeBase: '127.0.0.1:8766', bridgeToken: 'secret', bbGermanLayoutV1: true });
  assert.equal(p.local[KEY].values.bridgeBase, '127.0.0.1:8766');
});

test('legacy token migrates from sync and pending into the private vault', async () => {
  const p = mount({ sync: { bridgeBase: 'http://127.0.0.1:8766', bridgeToken: 'old-test-token' },
    local: { [KEY]: { values: { bridgeToken: 'new-test-token', origSize: 24 }, nextSyncAt: 0 } } });
  await p.worker.startSync();
  assert.equal(p.sync.bridgeToken, undefined);
  assert.equal(p.vault.token, 'new-test-token');
  assert.equal(p.local.bridgeConfigV1.bridgeToken, undefined);
  assert.equal(p.local[KEY].values.bridgeToken, undefined);
  assert.equal((await p.worker.getBridgeConfig()).bridgeToken, 'new-test-token');
  assert.equal((await get(p.client)).bridgeToken, undefined, 'page settings do not request credentials');
  assert.equal((await get(p.newClient(), { bridgeToken: '' })).bridgeToken, 'new-test-token');
  await p.advance(250);
  assert.equal(p.sync.origSize, 24);
  assert.ok(p.attempts.every(a => !Object.hasOwn(a.values, 'bridgeToken')));
});

test('legacy local token wins over sync and private empty token cannot be resurrected', async () => {
  const p = mount({ local: { bridgeConfigV1: { bridgeToken: 'local-test-token' } },
    sync: { bridgeToken: 'sync-test-token' } });
  await p.worker.startSync();
  assert.equal(p.vault.token, 'local-test-token');
  assert.deepEqual(p.local.bridgeConfigV1, {});
  const cleared = mount({ vault: { token: '' }, local: { bridgeConfigV1: { bridgeToken: 'stale-local' } } });
  await cleared.worker.startSync();
  assert.equal(cleared.vault.token, '');
});

test('token changes and clearing never enter sync, including after restart', async () => {
  const p = mount();
  await p.worker.enqueue({ bridgeBase: 'http://localhost:8766', bridgeToken: 'test-token' });
  assert.equal((await p.worker.getBridgeConfig()).bridgeBase, 'http://localhost:8766', 'use staged address immediately');
  assert.equal(p.local[KEY].values.bridgeToken, undefined);
  await p.advance(250);
  await p.worker.enqueue({ bridgeToken: '' });
  const restarted = mount({ local: p.local, vault: p.vault, sync: { ...p.sync, bridgeToken: 'stale-test-token' } });
  await restarted.worker.startSync();
  assert.equal((await restarted.worker.getBridgeConfig()).bridgeToken, '');
  assert.equal(restarted.sync.bridgeToken, undefined);
});

test('recognition language accepts supported speech languages only', async () => {
  const p = mount();
  await p.worker.enqueue({ recognitionLanguage: 'de' });
  assert.equal(p.local[KEY].values.recognitionLanguage, 'de');
  await assert.rejects(p.worker.enqueue({ recognitionLanguage: 'translated-to-German' }), /Invalid settings patch/);
  assert.equal(p.local[KEY].values.recognitionLanguage, 'de');
});
