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
  tracks: [],
  title: 'a video with no captions',
  url: 'https://www.bilibili.com/video/BV1',
  durationMs: 60000,
};
const CONFIGURED = { ok: true, bridgeBase: 'http://127.0.0.1:8766', bridgeToken: 'token' };

function load(options = {}) {
  const sent = [];
  const listeners = {};
  const state = { contexts: [], created: [], closed: 0, streamIdCalls: [] };

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
        state.created.push(document);
        state.contexts = [{ contextType: 'OFFSCREEN_DOCUMENT' }];
      },
      async closeDocument() { state.closed += 1; state.contexts = []; },
    },
    commands: { onCommand: { addListener() {} } },
  };

  let context = null;
  const sandbox = {
    chrome,
    Map, Promise, JSON, Date, Math, Object, Array, Number, String, Boolean, Set, Error,
    setTimeout, clearTimeout, setInterval, clearInterval, console,
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    importScripts(...names) {
      for (const name of names) {
        if (name === 'bridge-client.js') vm.runInContext(BRIDGE, context, { filename: name });
      }
    },
    YtdsSettings: { startSync() {}, enqueue: async () => {}, get: async () => ({}) },
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

test('a page that reports captions never gets an offscreen document or a stream id', async () => {
  const harness = load({ answer: pageAnswer(Object.assign({}, CONTEXT, { captionAvailability: 'present' })) });
  const answer = await harness.ask({ type: 'recogStart', tabId: 42 });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'captions');
  assert.equal(harness.state.streamIdCalls.length, 0, 'no capture may be requested');
  assert.equal(harness.state.created.length, 0, 'no offscreen document may be created');
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
  const harness = load({ answer: pageAnswer(CONTEXT, { ok: true, bridgeBase: '', bridgeToken: '' }) });
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
  assert.deepEqual(asked, ['recognitionContext', 'status', 'recognitionState']);
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
  const answer = await harness.ask({ type: 'recognizedCues', videoKey: 'BV1#p1', cues, sourceLang: 'zh' }, { tab: { id: 7 } });
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
  const harness = load({ answer: pageAnswer(CONTEXT, { ok: true, bridgeBase: '', bridgeToken: '' }) });
  const answer = await harness.ask({ type: 'recogHealth' });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'not_configured');
});
