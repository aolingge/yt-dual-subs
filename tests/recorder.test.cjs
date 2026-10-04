// The service worker is where the pieces meet: the popup's click, the page's
// answer about captions, the stream id and the offscreen document. None of that
// can be exercised in a real browser from here, so chrome is stood in for and
// the ordering, the gates and the routing are checked directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const BACKGROUND = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(root, 'bridge-client.js'), 'utf8');

const CONTEXT = {
  platform: 'bilibili',
  videoId: 'BV1#p1',
  captionAvailability: 'absent',
  sourceLanguage: 'zh',
  targetLang: 'de',
  bridgeTranslationTarget: 'de',
  tracks: [],
  title: 'a video with no captions',
  url: 'https://www.bilibili.com/video/BV1',
  durationMs: 60000,
};
const CONFIGURED = { ok: true, bridgeBase: 'http://127.0.0.1:8766', bridgeToken: 'token' };

function load(options = {}) {
  const sent = [];
  const listeners = {};
  const state = { contexts: options.contexts || [], created: [], closed: 0, streamIdCalls: [] };

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: null,
      getURL: (relative) => 'chrome-extension://test-extension-id/' + relative,
      getContexts: async () => state.contexts.slice(),
      sendMessage: async (message) => {
        sent.push(message);
        // The offscreen document's own reply, when the test cares about it.
        if (message.type === 'recogOffscreenStart') {
          return options.offscreen ? options.offscreen(message) : { ok: true, sampleRate: 48000 };
        }
        if (message.type === 'recogOffscreenStatus') return { ok: true, status: options.recorderStatus || {} };
        return { ok: true };
      },
      onMessage: { addListener(fn) { listeners.message = fn; } },
    },
    tabs: {
      onRemoved: { addListener() {} },
      async query() { return [{ id: 42 }]; },
      sendMessage(tabId, message, done) {
        sent.push(Object.assign({ tabId }, message));
        const answer = options.answer ? options.answer(message) : null;
        if (typeof done === 'function') done(answer);
      },
    },
    tabCapture: {
      async getMediaStreamId(query) {
        state.streamIdCalls.push(query);
        return 'stream-id-1';
      },
    },
    offscreen: {
      async createDocument(document) {
        if (options.createDocument) await options.createDocument(document);
        state.created.push(document);
        state.contexts = [{ contextType: 'OFFSCREEN_DOCUMENT' }];
      },
      async closeDocument() { state.closed += 1; state.contexts = []; },
    },
    commands: { onCommand: { addListener() {} } },
    permissions: { contains: async () => options.permission !== false },
  };

  let context = null;
  const sandbox = {
    chrome,
    Map, Promise, JSON, Date, Math, Object, Array, Number, String, Boolean, Set, Error,
    setTimeout, clearTimeout, setInterval, clearInterval, console, URL,
    fetch: options.fetch || (async () => ({ ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, service: 'deutsch-overlay-bridge',
        protocolVersion: 1, modelReady: true }) })),
    importScripts(...names) {
      for (const name of names) {
        if (name === 'bridge-client.js') vm.runInContext(BRIDGE, context, { filename: name });
      }
    },
    YtdsSettings: { startSync() {}, enqueue: async () => {}, get: async () => ({}),
      getBridgeConfig: async () => options.config || CONFIGURED },
  };
  vm.createContext(sandbox);
  context = sandbox;
  vm.runInContext(BACKGROUND, sandbox, { filename: 'background.js' });

  const ask = (message, sender) =>
    new Promise((resolve) => {
      const returned = listeners.message(message, sender || {}, resolve);
      assert.ok(returned !== false, 'the listener must keep the channel open');
    });
  const outgoing = (type, tabId) =>
    sent.filter((m) => m.type === type && (tabId === undefined || m.tabId === tabId));
  return { state, sent, ask, outgoing };
}

// Answers as the page would: a context for the context question, and the saved
// bridge settings for the status question.
function pageAnswer(context, config = CONFIGURED) {
  return (message) => {
    if (message.type === 'recognitionContext') return { ok: true, context };
    if (message.type === 'status') return config;
    return { ok: true };
  };
}

test('health reports model readiness without claiming token verification or requiring a page', async () => {
  const h = load({ answer: () => null });
  const answer = await h.ask({ type: 'recogHealth' });
  assert.equal(answer.ok, true);
  assert.equal(answer.modelReady, true);
  assert.equal(answer.tokenVerified, false);
  assert.equal(h.outgoing('status').length, 0);
});

test('missing permission and wrong service stop before audio capture', async () => {
  for (const [options, code] of [
    [{ permission: false }, 'permission_required'],
    [{ fetch: async () => ({ ok: true, text: async () => '{}' }) }, 'bad_response'],
    [{ config: { bridgeBase: 'https://example.com', bridgeToken: 'test-token' } }, 'invalid_base']
  ]) {
    const h = load({ ...options, answer: pageAnswer(CONTEXT) });
    const result = await h.ask({ type: 'recogStart', tabId: 42 });
    assert.equal(result.code, code);
    assert.equal(h.state.streamIdCalls.length, 0);
  }
});

test('content tabs cannot read or overwrite bridge credentials', async () => {
  const h = load();
  assert.equal((await h.ask({ type: 'getBridgeConfig' }, { tab: { id: 42 } })).ok, false);
  assert.equal((await h.ask({ type: 'saveSettings', patch: { bridgeToken: 'test' } }, { tab: { id: 42 } })).ok, false);
});

test('caption or video changes during health prevent capture', async () => {
  for (const next of [ { ...CONTEXT, captionAvailability: 'present' },
    { ...CONTEXT, videoId: 'other#p2' } ]) {
    let reads = 0;
    const h = load({ answer: msg => msg.type === 'recognitionContext'
      ? { ok: true, context: ++reads === 1 ? CONTEXT : next } : { ok: true } });
    const result = await h.ask({ type: 'recogStart', tabId: 42 });
    assert.equal(result.code, 'captions_changed');
    assert.equal(h.state.streamIdCalls.length, 0);
  }
});

test('concurrent starts cannot create two captures while health is pending', async () => {
  let release, fetched;
  const started = new Promise(resolve => { fetched = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const h = load({ answer: pageAnswer(CONTEXT), fetch: async () => {
    fetched(); await wait;
    return { ok: true, text: async () => JSON.stringify({ ok: true,
      service: 'deutsch-overlay-bridge', protocolVersion: 1 }) };
  } });
  const first = h.ask({ type: 'recogStart', tabId: 42 });
  await started;
  const second = await h.ask({ type: 'recogStart', tabId: 42 });
  assert.equal(second.code, 'busy');
  release();
  assert.equal((await first).ok, true);
  assert.equal(h.state.streamIdCalls.length, 1);
});

test('a page that reports captions never gets an offscreen document or a stream id', async () => {
  const harness = load({ answer: pageAnswer(Object.assign({}, CONTEXT, { captionAvailability: 'present' })) });
  const answer = await harness.ask({ type: 'recogStart', tabId: 42 });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'captions');
  assert.equal(harness.state.streamIdCalls.length, 0, 'no capture may be requested');
  assert.equal(harness.state.created.length, 0, 'no offscreen document may be created');
});

test('a non-German display target still starts local recognition for intermediate translation', async () => {
  const harness = load({ answer: pageAnswer({ ...CONTEXT, targetLang: 'zh-CN' }) });
  const answer = await harness.ask({ type: 'recogStart', tabId: 42 });
  assert.equal(answer.ok, true);
  assert.equal(harness.state.streamIdCalls.length, 1);
  assert.equal(harness.state.created.length, 1);
});

test('an unknown caption state is refused exactly like a known track', async () => {
  const harness = load({ answer: pageAnswer(Object.assign({}, CONTEXT, { captionAvailability: 'unknown' })) });
  const answer = await harness.ask({ type: 'recogStart', tabId: 42 });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'captions');
  assert.equal(harness.state.created.length, 0);
});

test('a page that never answers cannot start a capture', async () => {
  const harness = load({ answer: () => null });
  const answer = await harness.ask({ type: 'recogStart', tabId: 42 });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'no_page');
  assert.equal(harness.state.streamIdCalls.length, 0);
});

test('a missing bridge address or token stops the start before any capture', async () => {
  const harness = load({ answer: pageAnswer(CONTEXT), config: { bridgeBase: '', bridgeToken: '' } });
  const answer = await harness.ask({ type: 'recogStart', tabId: 42 });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'not_configured');
  assert.equal(harness.state.streamIdCalls.length, 0);
  assert.equal(harness.state.created.length, 0);
});

test('a no-caption video is captured through the offscreen document, in order', async () => {
  const asked = [];
  const harness = load({
    answer: (message) => {
      asked.push(message.type);
      if (message.type === 'recognitionContext') return { ok: true, context: CONTEXT };
      return CONFIGURED;
    },
  });
  const answer = await harness.ask({ type: 'recogStart', tabId: 42 });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.sampleRate, 48000);
  // The page is asked before anything is captured, so a video with captions is
  // never recorded even for a moment; the last message is the page being told
  // that capture started.
  assert.deepEqual(asked, ['recognitionContext', 'recognitionContext', 'recognitionState', 'recognitionContext', 'recognitionContext']);
  assert.equal(harness.state.streamIdCalls.length, 1);
  assert.equal(harness.state.streamIdCalls[0].targetTabId, 42);
  assert.equal(harness.state.created.length, 1);
  assert.equal(harness.state.created[0].url, 'offscreen.html');
  assert.equal(harness.state.created[0].reasons.length, 1);
  assert.equal(harness.state.created[0].reasons[0], 'USER_MEDIA');

  const starts = harness.sent.filter((m) => m.type === 'recogOffscreenStart');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].streamId, 'stream-id-1');
  assert.equal(starts[0].context.captionAvailability, 'absent');
  assert.equal(starts[0].context.videoId, 'BV1#p1');
  assert.equal(starts[0].context.videoKey, 'BV1#p1');
  assert.equal(starts[0].context.bridgeBase, 'http://127.0.0.1:8766');
  assert.equal(starts[0].context.bridgeToken, 'token');
  assert.deepEqual(harness.outgoing('recognitionState', 42).map((m) => m.state), ['starting']);
});

test('a refusal from the recorder fails the start and closes the document again', async () => {
  const harness = load({
    answer: pageAnswer(CONTEXT),
    offscreen: () => ({ ok: false, reason: 'bridge' }),
  });
  const answer = await harness.ask({ type: 'recogStart', tabId: 42 });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'bridge');
  assert.equal(harness.state.closed, 1, 'a failed capture leaves no document behind');
  const states = harness.outgoing('recognitionState', 42).map((m) => m.state);
  assert.deepEqual(states, ['starting', 'failed']);
});

test('a second start while one is running is refused as busy', async () => {
  const harness = load({ answer: pageAnswer(CONTEXT) });
  const first = await harness.ask({ type: 'recogStart', tabId: 42 });
  assert.equal(first.ok, true);
  const second = await harness.ask({ type: 'recogStart', tabId: 42 });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'busy');
});

test('a start without a tab is refused', async () => {
  const harness = load();
  const answer = await harness.ask({ type: 'recogStart' });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'no_tab');
});

test('media reports from another tab never reach the recorder', async () => {
  const harness = load({ answer: pageAnswer(CONTEXT) });
  await harness.ask({ type: 'recogStart', tabId: 42 });
  harness.sent.length = 0;
  const stranger = await harness.ask({ type: 'mediaReport', mediaMs: 5000 }, { tab: { id: 99 } });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.reason, 'other_tab');
  assert.equal(harness.sent.filter((m) => m.type === 'mediaReport').length, 0);
  const mine = await harness.ask({ type: 'mediaReport', mediaMs: 5000 }, { tab: { id: 42 } });
  assert.equal(mine.ok, true);
  const forwarded = harness.sent.filter((m) => m.type === 'mediaReport');
  assert.equal(forwarded.length, 1, 'exactly the captured tab gets through');
  assert.equal(forwarded[0].target, 'offscreen');
});

test('recognized cues are pushed to the captured tab only', async () => {
  const harness = load({ answer: pageAnswer(CONTEXT) });
  await harness.ask({ type: 'recogStart', tabId: 42 });
  harness.sent.length = 0;
  const cues = [{ start: 0, dur: 1000, text: '你好', trans: 'Hallo' }];
  const answer = await harness.ask({ type: 'recognizedCues', videoKey: 'BV1#p1', cues, sourceLang: 'zh' },
    { url: 'chrome-extension://test-extension-id/offscreen.html', id: 'test-extension-id' });
  assert.equal(answer.ok, true);
  const pushed = harness.outgoing('recognizedCues', 42);
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0].cues, cues);
  assert.equal(pushed[0].sourceLang, 'zh');
});

test('stopping asks the recorder to finish, then clears and closes', async () => {
  const harness = load({ answer: pageAnswer(CONTEXT) });
  await harness.ask({ type: 'recogStart', tabId: 42 });
  harness.sent.length = 0;
  const stopped = await harness.ask({ type: 'recogStop' });
  assert.equal(stopped.ok, true);
  assert.ok(harness.sent.some((m) => m.type === 'recogOffscreenStop'), 'the recorder is told to stop');
  assert.equal(harness.state.closed, 1);
  assert.deepEqual(harness.outgoing('recognitionState', 42).map((m) => m.state), ['stopping', '']);
  const status = await harness.ask({ type: 'recogStatus' });
  assert.equal(status.recorder.state, '');
  assert.equal(status.recorder.tabId, null);
});

test('a video change drops the session and takes its captions down first', async () => {
  const harness = load({ answer: pageAnswer(CONTEXT) });
  await harness.ask({ type: 'recogStart', tabId: 42 });
  await harness.ask({ type: 'recogState', state: 'running', cueCount: 4 });
  harness.sent.length = 0;
  // The page says: the video I was reporting for is gone.
  const answer = await harness.ask(
    { type: 'recognitionAbandoned', videoId: 'BV2#p1', previousVideoId: 'BV1#p1' },
    { tab: { id: 42 } });
  assert.equal(answer.ok, true);
  const cleared = harness.outgoing('clearRecognized', 42);
  assert.equal(cleared.length, 1, 'the overlay is told to forget the old video before anything else');
  assert.ok(harness.sent.some((m) => m.type === 'recogOffscreenStop'), 'the recorder is finished');
  assert.equal(harness.state.closed, 1);
  const status = await harness.ask({ type: 'recogStatus' });
  assert.equal(status.recorder.state, '');
  assert.equal(status.recorder.tabId, null);
  assert.equal(status.recorder.cueCount, 0);
});

test('an abandoned notice from a tab that was never captured is ignored', async () => {
  const harness = load({ answer: pageAnswer(CONTEXT) });
  await harness.ask({ type: 'recogStart', tabId: 42 });
  await harness.ask({ type: 'recogState', state: 'running' });
  harness.sent.length = 0;
  const answer = await harness.ask(
    { type: 'recognitionAbandoned', videoId: 'BV2#p1' },
    { tab: { id: 99 } });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'other_tab');
  assert.equal(harness.outgoing('clearRecognized', 42).length, 0);
  const status = await harness.ask({ type: 'recogStatus' });
  assert.equal(status.recorder.state, 'running', 'the stranger did not stop the real capture');
});

test('the recorder state is kept for the popup to read back', async () => {
  const harness = load({ answer: pageAnswer(CONTEXT) });
  await harness.ask({ type: 'recogStart', tabId: 42 });
  await harness.ask({ type: 'recogState', state: 'running', cueCount: 3, dropped: 1 });
  const status = await harness.ask({ type: 'recogStatus' });
  assert.equal(status.recorder.state, 'running');
  assert.equal(status.recorder.cueCount, 3);
  assert.equal(status.recorder.dropped, 1);
  assert.equal(status.recorder.tabId, 42);
});

test('the bridge health answer reports a missing address without pretending it is a failure of the bridge', async () => {
  const harness = load({ answer: pageAnswer(CONTEXT), config: { bridgeBase: '', bridgeToken: '' } });
  const answer = await harness.ask({ type: 'recogHealth' });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'not_configured');
});

test('video tabs cannot start/stop capture or forge offscreen state and cues', async () => {
  const h = load({ answer: pageAnswer(CONTEXT) });
  const tab = { tab: { id: 42 }, url: 'https://www.bilibili.com/video/BV1' };
  assert.equal((await h.ask({ type: 'recogStart', tabId: 42 }, tab)).code, 'forbidden');
  await h.ask({ type: 'recogStart', tabId: 42 });
  for (const type of ['recogStop', 'recogState', 'recognizedCues', 'recogStopped']) {
    assert.equal((await h.ask({ type, state: 'running', cues: [] }, tab)).code, 'forbidden');
  }
  assert.equal(h.state.closed, 0);
  assert.equal((await h.ask({ type: 'recogStatus' })).recorder.tabId, 42);
  const old = await h.ask({ type: 'recognizedCues', videoKey: 'different#p2', cues: [] },
    { url: 'chrome-extension://test-extension-id/offscreen.html' });
  assert.equal(old.code, 'forbidden');
});

test('failed offscreen creation releases the starting state and permits retry', async () => {
  let attempts = 0;
  const h = load({ answer: pageAnswer(CONTEXT), createDocument: async () => {
    if (++attempts === 1) throw new Error('document creation failed');
  } });
  assert.equal((await h.ask({ type: 'recogStart', tabId: 42 })).ok, false);
  assert.equal((await h.ask({ type: 'recogStatus' })).recorder.state, 'failed');
  assert.equal(h.state.streamIdCalls.length, 0, 'stream ID is requested only after document creation');
  assert.equal((await h.ask({ type: 'recogStart', tabId: 42 })).ok, true);
});

test('stop during document creation cancels the pending capture', async () => {
  let release;
  const h = load({ answer: pageAnswer(CONTEXT), createDocument: () => new Promise(resolve => { release = resolve; }) });
  const start = h.ask({ type: 'recogStart', tabId: 42 });
  while (!release) await new Promise(setImmediate);
  await h.ask({ type: 'recogStop' });
  release();
  assert.equal((await start).code, 'cancelled');
  assert.equal(h.state.streamIdCalls.length, 0);
  assert.equal(h.state.contexts.length, 0);
  assert.equal((await h.ask({ type: 'recogStatus' })).recorder.state, '');
});

test('captions appearing while document is created prevent capture', async () => {
  let reads = 0;
  const h = load({ answer: message => message.type === 'recognitionContext'
    ? { ok: true, context: ++reads < 3 ? CONTEXT : { ...CONTEXT, captionAvailability: 'present' } } : {} });
  assert.equal((await h.ask({ type: 'recogStart', tabId: 42 })).code, 'captions_changed');
  assert.equal(h.state.streamIdCalls.length, 0);
  assert.equal(h.state.closed, 1);
});

test('a resumed worker recovers an existing recorder instead of starting a second capture', async () => {
  const h = load({ contexts: [{ contextType: 'OFFSCREEN_DOCUMENT' }], recorderStatus: {
    tabId: 42, videoKey: CONTEXT.videoId, state: 'running', cueCount: 8, revision: 4, sampleRate: 48000
  } });
  const result = await h.ask({ type: 'recogStatus' });
  assert.equal(result.recorder.tabId, 42);
  assert.equal(result.recorder.cueCount, 8);
  assert.equal((await h.ask({ type: 'recogStart', tabId: 99 })).code, 'busy');
  assert.equal(h.state.streamIdCalls.length, 0);
  await h.ask({ type: 'recogStop' });
  assert.ok(h.outgoing('recognitionState', 42).some(message => message.state === 'stopping'));
  assert.equal(h.state.closed, 1);
});

test('live status exposes input health and bridge metrics to the popup', async () => {
  const h = load({ answer: pageAnswer(CONTEXT) });
  await h.ask({ type: 'recogStart', tabId: 42 });
  await h.ask({ type: 'recogState', state: 'running', audioInput: { state: 'silent', frames: 480000 },
    metrics: { queuedClips: 2, recognitionP95Ms: 320 }, warning: 'cpu_fallback' });
  const { recorder } = await h.ask({ type: 'recogStatus' });
  assert.equal(recorder.audioInput.state, 'silent');
  assert.equal(recorder.metrics.recognitionP95Ms, 320);
  assert.equal(recorder.warning, 'cpu_fallback');
});

test('worker recovery restores input health, metrics and warning together', async () => {
  const h = load({ contexts: [{ contextType: 'OFFSCREEN_DOCUMENT' }], recorderStatus: {
    tabId: 42, videoKey: CONTEXT.videoId, state: 'running',
    audioInput: { state: 'signal', frames: 10000 }, metrics: { queuedTranslations: 1 }, warning: 'cpu_fallback'
  } });
  const { recorder } = await h.ask({ type: 'recogStatus' });
  assert.equal(recorder.audioInput.state, 'signal');
  assert.equal(recorder.metrics.queuedTranslations, 1);
  assert.equal(recorder.warning, 'cpu_fallback');
});

test('degraded or stopping sessions cannot be replaced by a second capture', async () => {
  for (const state of ['degraded', 'stopping']) {
    const h = load({ contexts: [{ contextType: 'OFFSCREEN_DOCUMENT' }], recorderStatus: {
      tabId: 42, videoKey: CONTEXT.videoId, state
    } });
    assert.equal((await h.ask({ type: 'recogStart', tabId: 99 })).code, 'busy');
    assert.equal(h.state.streamIdCalls.length, 0);
  }
});

test('captions discovered after stream ID creation prevent audio consumption', async () => {
  let reads = 0;
  const h = load({ answer: message => message.type === 'recognitionContext'
    ? { ok: true, context: ++reads < 4 ? CONTEXT : { ...CONTEXT, captionAvailability: 'present' } } : {} });
  assert.equal((await h.ask({ type: 'recogStart', tabId: 42 })).code, 'captions_changed');
  assert.equal(h.state.streamIdCalls.length, 1);
  assert.equal(h.sent.filter(message => message.type === 'recogOffscreenStart').length, 0);
  assert.equal(h.state.closed, 1);
});

test('page senders cannot read model options, submit terminology or retry audio', async () => {
  const h = load({ answer: pageAnswer(CONTEXT) });
  const tab = { tab: { id: 42 }, url: 'https://www.bilibili.com/video/BV1' };
  for (const type of ['recogSettings', 'recogRetry']) {
    const answer = await h.ask({ type, patch: { hotwords: { zh: 'private' } }, tabId: 42 }, tab);
    assert.equal(answer.ok, false);
    assert.equal(answer.code, 'forbidden_origin');
  }
  assert.equal(h.sent.filter(m => m.type === 'recogOffscreenRetry').length, 0);
});

test('single retry rechecks the current video and native captions', async () => {
  const h = load({ answer: pageAnswer(CONTEXT) });
  await h.ask({ type: 'recogStart', tabId: 42 });
  const stale = await h.ask({ type: 'recogRetry', tabId: 42, videoId: 'other#p1', segmentId: 's', timelineEpoch: 0 });
  assert.equal(stale.code, 'captions_changed');
  const valid = await h.ask({ type: 'recogRetry', tabId: 42, videoId: CONTEXT.videoId, segmentId: 's', timelineEpoch: 0 });
  assert.equal(valid.ok, true);
  assert.equal(h.sent.filter(m => m.type === 'recogOffscreenRetry').length, 1);
});
