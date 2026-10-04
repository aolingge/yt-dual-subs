"use strict";
// The capture pipeline, tested without a browser.
//
// Everything here is a fake: a fake AudioContext that records an edge list, a
// fake tab stream whose tracks report when they stop, and a fake fetch for the
// bridge. What is NOT fake is offscreen.js itself — the module under test is the
// shipped file, loaded into a sandbox the same way the extension loads it. That
// is deliberate: the graph shape (one path to the speakers, one to the
// analyzer, the analyzer silent) is the part that decides whether the user
// still hears the video, and it is worth asserting edge by edge.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const loadSource = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");

const MODULES = ["bridge-client.js", "media-clock.js", "recognizer-stream.js", "capture-health.js", "offscreen.js"];

function audioNode(label, edges) {
  const node = {
    label,
    disconnect() { edges.push([label, null]); },
    connect(target) { edges.push([label, target && target.label ? target.label : "unknown"]); return target; },
  };
  return node;
}

// A tiny Web Audio stand-in: it records every connect() so a test can say
// exactly how many times the captured sound reaches the speakers.
function fakeAudio(edges) {
  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = "suspended";
      this.destination = { label: "destination" };
      this.resumed = 0;
      this.closed = 0;
      this._index = 0;
      this.audioWorklet = {
        modules: [],
        addModule: (url) => { this.audioWorklet.modules.push(url); return Promise.resolve(); },
      };
    }
    createMediaStreamSource(stream) {
      const node = audioNode("source", edges);
      node.stream = stream;
      return node;
    }
    createGain() {
      const node = audioNode("gain", edges);
      node.gain = { value: 1 };
      return node;
    }
    resume() { this.resumed += 1; this.state = "running"; return Promise.resolve(); }
    close() { this.closed += 1; this.state = "closed"; return Promise.resolve(); }
  }
  return { FakeAudioContext };
}

function fakeTracks() {
  const stopped = [];
  const handlers = new Map();
  const track = { kind: "audio", stop: () => stopped.push("audio"),
    addEventListener: (type, handler) => handlers.set(type, handler),
    removeEventListener: (type, handler) => { if (handlers.get(type) === handler) handlers.delete(type); } };
  return {
    stopped,
    end: () => handlers.get("ended")?.(),
    stream: { getTracks: () => [track] },
  };
}

// Messages the page-under-test sends out, plus the replies the harness feeds in.
function fakeChrome(sandbox) {
  const sent = [];
  const listeners = [];
  const chrome = {
    runtime: {
      lastError: null,
      getURL: (p) => "chrome-extension://fake/" + p,
      sendMessage(message, callback) {
        sent.push(message);
        if (typeof callback === "function") callback(undefined);
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
  sandbox.chrome = chrome;
  return {
    sent,
    listeners,
    byType(type) { return sent.filter((m) => m && m.type === type); },
    last(type) { const all = this.byType(type); return all.length ? all[all.length - 1] : null; },
  };
}

function load(overrides) {
  const edges = [];
  const tracks = fakeTracks();
  const audio = fakeAudio(edges);
  const calls = [];
  // The bridge, as far as this module cares: a session it can open, audio it can
  // send, and a transcript that stays empty. Reaching the network is not what
  // this file is testing.
  const fetchStub = (url, options) => {
    const method = (options && options.method) || "GET";
    calls.push({ url, method, body: options && options.body });
    const body = url.includes("/audio") ? { ok: true, segments: [], revision: 0, status: "recognizing", acceptedSamples: 0 }
      : { ok: true, sessionId: "abc12345deadbeef", protocolVersion: 1, engine: "fake", sourceLanguage: "zh", recognize: true, reason: "no_captions", message: "" };
    const payload = url.includes("/transcript")
      ? { ok: true, segments: [], revision: 0, status: "recognizing", language: "zh" }
      : body;
    // The client reads the body as text and parses it itself, exactly as a real
    // fetch response would make it do.
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(payload)),
    });
  };
  const sandbox = {
    console,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
    Promise,
    Uint8Array,
    Float32Array,
    Error,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: fetchStub,
    AbortController,
    // The worklet node class: the worklet source itself runs on the audio
    // thread, so here it only has to expose the port the module talks to.
    AudioWorkletNode: function (ctx, name, options) {
      this.label = "worklet";
      this.name = name;
      this.options = options;
      this.registered = [];
      this.port = {
        onmessage: null,
        postMessage: (msg) => { this.registered.push(msg); },
      };
      this.connect = (target) => { edges.push(["worklet", target && target.label ? target.label : "unknown"]); };
      this.disconnect = () => { edges.push(["worklet", null]); };
    },
    AudioContext: audio.FakeAudioContext,
    navigator: {
      mediaDevices: {
        lastConstraints: null,
        getUserMedia(constraints) {
          this.lastConstraints = constraints;
          return Promise.resolve(tracks.stream);
        },
      },
    },
  };
  Object.assign(sandbox, overrides || {});
  vm.createContext(sandbox);
  // offscreen.js registers its message listener while it loads, so the chrome
  // stand-in has to exist before the module is evaluated.
  const chrome = fakeChrome(sandbox);
  for (const name of MODULES) vm.runInContext(loadSource(name), sandbox, { filename: name });
  return { sandbox, edges, tracks, chrome };
}

const START_MESSAGE = {
  type: "recogOffscreenStart",
  streamId: "stream-id-1",
  context: {
    platform: "bilibili",
    videoId: "BV1#p1",
    videoKey: "BV1#p1",
    captionAvailability: "absent",
    sourceLanguage: "zh",
    bridgeBase: "http://127.0.0.1:8766",
    bridgeToken: "token",
    hasAudioTrack: true,
    currentTimeMs: 24000,
    playbackRate: 1,
    paused: true,
  },
};

function dispatch(harness, message) {
  return new Promise((resolve) => {
    for (const listener of harness.chrome.listeners) {
      const handled = listener(message, {}, resolve);
      if (handled) return;
    }
    resolve(undefined);
    return;
  });
}

test("the offscreen document answers a start request and captures the tab stream", async () => {
  const harness = load();
  const answer = await dispatch(harness, START_MESSAGE);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.sampleRate, 48000);
  const constraints = harness.sandbox.navigator.mediaDevices.lastConstraints;
  assert.equal(constraints.audio.mandatory.chromeMediaSource, "tab");
  assert.equal(constraints.audio.mandatory.chromeMediaSourceId, "stream-id-1");
  assert.equal(constraints.video, false, "audio only: the picture is already on screen");
});

test("the captured sound reaches the speakers exactly once", async () => {
  const harness = load();
  await dispatch(harness, START_MESSAGE);
  // The documented cure for tabCapture muting the tab is to play the captured
  // stream back through an AudioContext. Twice would be an echo.
  const toDestination = harness.edges.filter((edge) => edge[1] === "destination");
  const fromGain = toDestination.filter((edge) => edge[0] === "gain");
  assert.equal(fromGain.length, 1, "one path from the captured audio to the speakers");
  assert.equal(toDestination.filter((edge) => edge[0] === "source").length, 0,
    "the source must not also feed the destination directly");
});

test("the analyzer branch is fed from the same gain node and emits silence", async () => {
  const harness = load();
  await dispatch(harness, START_MESSAGE);
  assert.ok(harness.edges.some((edge) => edge[0] === "gain" && edge[1] === "worklet"),
    "the worklet listens on the same single source");
  assert.ok(harness.edges.some((edge) => edge[0] === "worklet" && edge[1] === "destination"),
    "the worklet is part of the graph, so it runs");
  // The worklet's output is silence (it fills its output channels with zero),
  // which is what keeps that second destination edge from being a second copy.
  const worklet = loadSource("pcm-worklet.js");
  assert.match(worklet, /channel\.fill\(0\)/);
});

test("a fresh AudioContext is resumed, because a suspended one is silent", async () => {
  const harness = load();
  await dispatch(harness, START_MESSAGE);
  const status = await dispatch(harness, { type: "recogOffscreenStatus" });
  assert.equal(status.ok, true);
  assert.equal(status.status.state, "running");
  assert.equal(status.status.sampleRate, 48000);
});

test("capture is refused for a video that reports captions", async () => {
  const harness = load();
  const answer = await dispatch(harness, Object.assign({}, START_MESSAGE, {
    context: Object.assign({}, START_MESSAGE.context, { captionAvailability: "present" }),
  }));
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "captions_present");
  assert.equal(harness.sandbox.navigator.mediaDevices.lastConstraints, null,
    "no stream may be opened for a video that already has subtitles");
  assert.equal(harness.chrome.last("recogState").state, "failed");
});

test("media reports move the clock, and a seek opens a new epoch", async () => {
  const harness = load();
  await dispatch(harness, START_MESSAGE);
  const first = await dispatch(harness, {
    type: "mediaReport", target: "offscreen",
    mediaMs: 24000, wallMs: Date.now(), rate: 1, paused: false,
  });
  assert.equal(first.ok, true);
  assert.equal(first.epoch, 0);
  const afterSeek = await dispatch(harness, {
    type: "mediaReport", target: "offscreen",
    mediaMs: 42000, wallMs: 101000, rate: 1, paused: false,
  });
  assert.equal(afterSeek.restarted, true, "the jump must be declared, not timed as audio");
  const status = await dispatch(harness, { type: "recogOffscreenStatus" });
  assert.equal(status.status.epoch, 1);
});

test("a report addressed to somebody else is ignored", async () => {
  const harness = load();
  await dispatch(harness, START_MESSAGE);
  const answer = await dispatch(harness, {
    type: "mediaReport", target: "elsewhere", mediaMs: 1000, wallMs: 1, rate: 1, paused: false,
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, "not_offscreen");
  const status = await dispatch(harness, { type: "recogOffscreenStatus" });
  assert.equal(status.status.epoch, 0, "a stray report must not move the timeline");
});

test("stopping closes the stream, the context and the offscreen document", async () => {
  const harness = load();
  await dispatch(harness, START_MESSAGE);
  const answer = await dispatch(harness, { type: "recogOffscreenStop" });
  assert.equal(answer.ok, true);
  assert.deepEqual(harness.tracks.stopped, ["audio"], "the capture must be released");
  assert.ok(harness.edges.some((edge) => edge[0] === "source" && edge[1] === null));
  assert.equal(harness.chrome.last("recogState").state, "");
});

test("PCM chunks from the worklet are converted to 16-bit and pushed", async () => {
  const harness = load();
  await dispatch(harness, START_MESSAGE);
  const node = harness.sandbox.__ytdsOffscreen.node;
  assert.ok(node, "the module must keep the worklet node it created");
  const floats = new Float32Array([0, 0.5, -1]);
  let pushed = null;
  // The module calls floatsToPcm16 from the shipped client and hands the bytes
  // to the session; intercepting the session is enough to see the conversion.
  const session = harness.sandbox.__ytdsOffscreen.session;
  assert.ok(session, "the module must keep the session it created");
  const original = session.pushPcm;
  session.pushPcm = (bytes, options) => { pushed = { bytes, options }; return original.call(session, bytes, options); };
  node.port.onmessage({ data: { type: "pcm", samples: floats, frames: floats.length } });
  assert.ok(pushed, "a pcm chunk must reach the session");
  assert.equal(pushed.bytes.length, 6);
  assert.deepEqual(Array.from(pushed.bytes), [0, 0, 0, 64, 0, 128],
    "0, +0.5 and -1 in signed 16-bit little-endian");
  assert.ok(Number.isFinite(pushed.options.atMs), "audio is stamped with the moment it arrived");
});

test("capture without a page position cannot send guessed audio", async () => {
  const harness = load();
  // Start with the clock never told where the video is: capture must still
  // work, but no packet may carry an invented media time.
  const answer = await dispatch(harness, {
    type: "recogOffscreenStart",
    streamId: "stream-id-2",
    context: Object.assign({}, START_MESSAGE.context, { currentTimeMs: undefined }),
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'media_not_ready');
  assert.equal(harness.sandbox.__ytdsOffscreen.session, undefined);
});

test('capture start seeds media position before first periodic report', async () => {
  const harness = load();
  const answer = await dispatch(harness, START_MESSAGE);
  assert.equal(answer.ok, true);
  assert.equal(harness.sandbox.__ytdsOffscreen.clock.snapshotMs, 24000);
  assert.equal(harness.sandbox.__ytdsOffscreen.session.audioStartMs, 24000);
});

test('missing page position refuses capture instead of inventing zero', async () => {
  const harness = load();
  const answer = await dispatch(harness, { ...START_MESSAGE,
    context: { ...START_MESSAGE.context, currentTimeMs: undefined } });
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'media_not_ready');
  assert.equal(harness.tracks.stopped.length, 1);
});

test('the popup status carries actual input health and clears the silence notice on sound', async () => {
  let now = 100000;
  const harness = load({ Date: { now: () => now } });
  await dispatch(harness, { ...START_MESSAGE, context: { ...START_MESSAGE.context, paused: false } });
  const node = harness.sandbox.__ytdsOffscreen.node;
  for (let elapsed = 0; elapsed <= 8000; elapsed += 1000) {
    now = 100000 + elapsed;
    await dispatch(harness, { type: 'mediaReport', target: 'offscreen',
      mediaMs: 24000 + elapsed, wallMs: now, rate: 1, paused: false });
    node.port.onmessage({ data: { type: 'pcm', samples: new Float32Array(4800), frames: 4800 } });
  }
  assert.equal((await dispatch(harness, { type: 'recogOffscreenStatus' })).status.audioInput.state, 'silent');
  now += 100;
  node.port.onmessage({ data: { type: 'pcm', samples: new Float32Array([0.05, -0.05]), frames: 2 } });
  assert.equal(harness.chrome.last('recogState').audioInput.state, 'signal');
  await dispatch(harness, { type: 'recogOffscreenStop' });
});

test('an ended capture releases resources and late session updates cannot restore running state', async () => {
  const harness = load();
  await dispatch(harness, START_MESSAGE);
  const oldSession = harness.sandbox.__ytdsOffscreen.session;
  const oldNode = harness.sandbox.__ytdsOffscreen.node;
  let packets = 0;
  oldSession.pushPcm = () => packets++;
  harness.tracks.end();
  assert.equal(harness.chrome.last('recogState').state, 'failed');
  assert.equal(harness.chrome.last('recogState').message, 'capture_ended');
  assert.equal(harness.tracks.stopped.length, 1);
  oldSession.emitState('running');
  oldNode.port.onmessage({ data: { type: 'pcm', samples: new Float32Array([0.5]) } });
  assert.equal(packets, 0);
  assert.equal(harness.chrome.last('recogState').message, 'capture_ended');
  await oldSession.writeChain;
  assert.equal(harness.chrome.last('recogState').state, 'failed');
});

test('a worklet callback from an old capture cannot feed a newly started session', async () => {
  const harness = load();
  await dispatch(harness, START_MESSAGE);
  const previousNode = harness.sandbox.__ytdsOffscreen.node;
  await dispatch(harness, { type: 'recogOffscreenStop' });
  await dispatch(harness, START_MESSAGE);
  let pushed = 0;
  harness.sandbox.__ytdsOffscreen.session.pushPcm = () => pushed++;
  previousNode.port.onmessage({ data: { type: 'pcm', samples: new Float32Array([0.5]) } });
  assert.equal(pushed, 0);
  await dispatch(harness, { type: 'recogOffscreenStop' });
});
