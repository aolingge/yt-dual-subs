'use strict';

// One live recognition session (recognizer-stream.js).
//
// What is checked here is the part that decides what the recognizer is told:
// which audio is sent, when it is sent, what media time it is stamped with, and
// what happens to the answers. The rules come straight from the task book:
//
//  * audio is never stamped with a time the page has not reported;
//  * a caption time is the video's, not the moment an answer arrived;
//  * a seek/rate change/resume starts a new stream instead of gluing two
//    separated pieces of sound into one sentence;
//  * a revised sentence replaces the old one, and an unchanged poll changes
//    nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const sources = ['bridge-client.js', 'media-clock.js', 'recognizer-stream.js'].map((name) => ({
  name,
  text: fs.readFileSync(path.join(ROOT, name), 'utf8'),
}));

function load() {
  // The modules schedule their own flush/poll timer, so the sandbox needs the
  // timer functions a page would have; nothing else of the browser is needed.
  const sandbox = { console, setInterval, clearInterval, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  for (const file of sources) {
    vm.runInContext(file.text, sandbox, { filename: file.name });
  }
  return {
    YtdsBridge: sandbox.YtdsBridge,
    MediaClock: sandbox.YtdsMediaClock.MediaClock,
    RecognizerStream: sandbox.YtdsRecognizerStream,
  };
}

// 1 second of 16 kHz mono silence is 32000 bytes; give tests exactly that so
// the sample arithmetic is easy to read.
const SECOND = 32000;
const silence = (seconds) => new Uint8Array(Math.round(seconds * SECOND));

function segment(overrides) {
  return Object.assign(
    {
      segmentId: "abcdef12-0-0",
      revision: 1,
      sourceLanguage: "zh",
      original: "今天天气很好。",
      german: "Das Wetter ist heute schön.",
      startMs: 1200,
      endMs: 3400,
      startSample: 19200,
      endSample: 54400,
      words: [],
      translationLanguage: "de",
      translationBackend: "opus-zh-de",
      translationFailed: false,
      provisional: false,
      timelineEpoch: 0,
    },
    overrides || {}
  );
}

// A bridge client that records instead of talking. `answers` is a queue of
// transcript replies; once it is empty the last reply is reused with its
// segments removed, which is how the real bridge behaves after the stream ends.
function fakeBridge(options) {
  const settings = options || {};
  const calls = { create: [], audio: [], transcript: [], finish: [], close: [] };
  const answers = settings.answers ? settings.answers.slice() : [];
  let revision = 0;
  const empty = { ok: true, segments: [], revision: 0, status: "recognizing", language: "zh" };
  return {
    calls,
    createSession(fields) {
      calls.create.push(JSON.parse(JSON.stringify(fields)));
      return Promise.resolve({ sessionId: "abc12345deadbeef", recognize: true, reason: "no_captions" });
    },
    sendAudio(sessionId, packets) {
      calls.audio.push({ sessionId, packets: packets.slice() });
      return Promise.resolve(settings.audioAnswer ? settings.audioAnswer(packets) : empty);
    },
    transcript(sessionId, sinceRevision, waitSeconds) {
      calls.transcript.push({ sessionId, sinceRevision, waitSeconds });
      const answer = answers.length > 1 ? answers.shift() : answers[0];
      if (!answer) return Promise.resolve(Object.assign({}, empty, { revision }));
      // The real bridge bumps its revision whenever it publishes a segment, so
      // the fake does too: a caller that catches up must be able to tell
      // "nothing new" from "the same sentence again".
      const published = (answer.segments || []).reduce((top, item) => Math.max(top, Number(item.revision) || 0), 0);
      const reply = Object.assign({}, answer, { revision: Math.max(revision, sinceRevision, published) });
      revision = reply.revision;
      return Promise.resolve(reply);
    },
    finish(sessionId) {
      calls.finish.push(sessionId);
      return Promise.resolve(settings.finishAnswer || { ok: true, segments: [], revision, status: "ready" });
    },
    close(sessionId) {
      calls.close.push(sessionId);
      return Promise.resolve({ ok: true });
    },
  };
}

const loaded = load();

function newSession(bridge, clock, extra) {
  let now = 100000;
  const updates = [];
  const states = [];
  const session = new loaded.RecognizerStream.RecognizerSession(Object.assign(
    {
      bridge,
      clock,
      platform: "bilibili",
      videoKey: "BV1xx411c7mD#p1",
      captionAvailability: "absent",
      sourceLanguage: "zh",
      sampleRate: 16000,
      channels: 1,
      onUpdate: (payload) => updates.push(payload),
      onState: (payload) => states.push(payload),
      now: () => now,
    },
    extra || {}
  ));
  return {
    session,
    updates,
    states,
    at: (value) => { now = value; },
  };
}

test('audio is held, not guessed at, until the page reports the media time', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const bridge = fakeBridge();
  const { session, updates } = newSession(bridge, clock);

  const held = session.pushPcm(silence(1), { atMs: 100000 });
  assert.equal(held.waiting, true);
  assert.equal(held.mediaMs, null);
  assert.equal(session.queued.length, 0, "nothing may be sent before the time is known");

  // The page finally says where the video is.
  session.observe({ mediaMs: 12000, wallMs: 100000, rate: 1, paused: false });
  const placed = session.pushPcm(silence(1), { atMs: 100050 });
  assert.equal(placed.waiting, undefined);
  assert.equal(Math.round(placed.mediaMs), 12050);
  assert.equal(session.queued.length, 1, "1 s at the 1 s frame is one packet");
  assert.equal(updates.length, 0);
});

test('the session declares the media time the audio started at', async () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const bridge = fakeBridge();
  const { session } = newSession(bridge, clock);
  session.observe({ mediaMs: 12000, wallMs: 100000, rate: 1, paused: false });
  await session.start();
  const fields = bridge.calls.create[0];
  assert.equal(fields.captionAvailability, "absent");
  assert.equal(fields.sourceKind, "tab_capture");
  assert.equal(fields.videoKey, "BV1xx411c7mD#p1");
  assert.equal(Math.round(fields.audioStartMs), 12000);
  assert.equal(fields.playbackRate, 1);
});

test('a session opened before the clock is ready omits audioStartMs rather than inventing one', async () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const bridge = fakeBridge();
  const { session } = newSession(bridge, clock);
  await session.start();
  assert.equal("audioStartMs" in bridge.calls.create[0], false);
});

test('a refused session stops instead of feeding the recognizer', async () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const bridge = fakeBridge();
  bridge.createSession = () => Promise.resolve({ sessionId: "", recognize: false, reason: "captions_present" });
  const { session, states } = newSession(bridge, clock);
  await session.start();
  assert.equal(states[states.length - 1].state, "refused");
  assert.equal(states[states.length - 1].reason, "captions_present");
  assert.equal(session.stopped, true);
  session.stopTimer();
  const after = session.pushPcm(silence(1), { atMs: 100000 });
  assert.equal(after.queued, 0);
});

test('packets advance the page sample counter and carry the clock epoch', async () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const bridge = fakeBridge();
  const { session } = newSession(bridge, clock);
  session.observe({ mediaMs: 12000, wallMs: 100000, rate: 1, paused: false });
  await session.start();
  session.pushPcm(silence(2), { atMs: 100000 });
  session.flush();
  await session.writeChain;
  const packets = bridge.calls.audio[0].packets;
  assert.equal(packets.length, 2, "two seconds of 16 kHz audio is two packets");
  assert.equal(packets[0].sampleIndex, 0);
  assert.equal(packets[1].sampleIndex, 16000);
  assert.equal(packets[0].sequence, 0);
  assert.equal(packets[1].sequence, 1);
  assert.equal(packets[0].timelineEpoch, 0);
  assert.equal(packets[0].sampleRate, 16000);
  assert.equal(packets[0].encoding, "pcm_s16le");
  assert.equal(Math.round(packets[0].audioStartMs), 12000);
  session.stopTimer();
});

test('a seek restarts the stream at the new media time instead of shifting it', async () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const bridge = fakeBridge();
  const { session } = newSession(bridge, clock);
  session.observe({ mediaMs: 12000, wallMs: 100000, rate: 1, paused: false });
  await session.start();
  session.pushPcm(silence(1), { atMs: 100000 });
  session.flush();
  await session.writeChain;

  // The viewer seeks forward half a minute. The page reports the new place.
  session.observe({ mediaMs: 42000, wallMs: 101000, rate: 1, paused: false });
  assert.equal(session.epoch, 1);
  session.pushPcm(silence(1), { atMs: 101000 });
  session.flush();
  await session.writeChain;

  session.stopTimer();  // this test drives the polls itself

  const first = bridge.calls.audio[0].packets;
  // Flatten every batch: flush() may split the queue, and this test is about
  // the packet coordinates, not how the client happened to group them.
  const second = bridge.calls.audio.slice(1).flatMap((batch) => batch.packets);
  assert.equal(Math.round(first[0].audioStartMs), 12000);
  assert.equal(second.length, 1, "the seeked second of audio is one packet");
  assert.equal(second[0].timelineEpoch, 1, "the new stream is declared as a new epoch");
  assert.equal(Math.round(second[0].audioStartMs), 42000);
  // The sample counter belongs to the session and keeps rising across the seek;
  // the new epoch and the announced media time are what tell the bridge this is
  // a fresh stream, so it rebases instead of timing the jump as audio.
  assert.equal(second[0].sampleIndex, 16000, "the page counter is continuous across the seek");
  assert.equal(second[0].sequence, 1, "the sequence keeps rising too");
  session.stopTimer();
});

test('a rate change also starts a new stream', async () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const bridge = fakeBridge();
  const { session } = newSession(bridge, clock);
  session.observe({ mediaMs: 12000, wallMs: 100000, rate: 1, paused: false });
  await session.start();
  session.observe({ mediaMs: 12000, wallMs: 100000, rate: 1.5, paused: false });
  session.pushPcm(silence(1), { atMs: 100000 });
  session.flush();
  await session.writeChain;
  const packets = bridge.calls.audio[0].packets;
  assert.equal(packets[0].timelineEpoch, 1);
  assert.equal(packets[0].playbackRate, 1.5);
  session.stopTimer();
});

test('audio is dropped oldest-first when the recognizer falls behind, and counted', async () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const bridge = fakeBridge();
  const { session } = newSession(bridge, clock);
  session.sessionId = "abc12345deadbeef";  // no session handshake in this test
  session.observe({ mediaMs: 0, wallMs: 100000, rate: 1, paused: false });
  await session.start();
  session.stopTimer();  // the point is what builds up while nothing is sent
  // 80 s of audio, one packet per second, against a 32-packet queue.
  for (let i = 0; i < 80; i += 1) session.pushPcm(silence(1), { atMs: 100000 + i * 1000 });
  assert.equal(session.queued.length, 32);
  assert.equal(session.dropped, 48);
  assert.equal(session.queued[0].sequence, 48, "the newest audio is what survives");
  session.stopTimer();
});

test('a new or revised sentence is handed on; an unchanged poll is silent', async () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const bridge = fakeBridge({
    answers: [
      { ok: true, segments: [segment()], revision: 1, status: "recognizing", language: "zh" },
    ],
  });
  const { session, updates } = newSession(bridge, clock);
  session.sessionId = "abc12345deadbeef";  // no session handshake in this test
  session.observe({ mediaMs: 0, wallMs: 100000, rate: 1, paused: false });
  await session.start();
  session.stopTimer();  // this test drives the polls itself

  await session.poll(0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].added, 1);
  assert.equal(updates[0].cues.length, 1);
  assert.equal(updates[0].cues[0].text, "今天天气很好。");
  assert.equal(updates[0].cues[0].trans, "Das Wetter ist heute schön.");

  // Asking again returns the same sentence: nothing changed, so nothing fires.
  await session.poll(0);
  assert.equal(updates.length, 1);
  session.stopTimer();
});

test('a corrected sentence replaces the old one rather than adding a second', async () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const first = segment({ segmentId: "a-0-0", revision: 1, original: "今天天气", endMs: 2000 });
  const second = segment({
    segmentId: "a-0-0",
    revision: 2,
    original: "今天天气很好。",
    german: "Das Wetter ist heute schön.",
    endMs: 3400,
  });
  const bridge = fakeBridge({
    answers: [
      { ok: true, segments: [first], revision: 1, status: "recognizing", language: "zh" },
      { ok: true, segments: [second], revision: 2, status: "recognizing", language: "zh" },
    ],
  });
  const { session, updates } = newSession(bridge, clock);
  session.sessionId = "abc12345deadbeef";  // no session handshake in this test
  session.observe({ mediaMs: 0, wallMs: 100000, rate: 1, paused: false });
  await session.start();
  session.stopTimer();  // this test drives the polls itself
  await session.poll(0);
  await session.poll(0);
  assert.equal(session.cues.length, 1, "one sentence, not two");
  assert.equal(session.cues[0].text, "今天天气很好。");
  assert.equal(updates.length, 2);
  assert.equal(updates[1].updated, 1);
  session.stopTimer();
});

test('a failed translation still shows the original text', async () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const bridge = fakeBridge({
    answers: [
      {
        ok: true,
        segments: [segment({ translationFailed: true, german: "" })],
        revision: 1,
        status: "recognizing",
        language: "zh",
      },
    ],
  });
  const { session } = newSession(bridge, clock);
  session.sessionId = "abc12345deadbeef";  // no session handshake in this test
  session.observe({ mediaMs: 0, wallMs: 100000, rate: 1, paused: false });
  await session.start();
  session.stopTimer();  // this test drives the polls itself
  await session.poll(0);
  assert.equal(session.cues[0].text, "今天天气很好。");
  assert.equal(session.cues[0].translationFailed, true);
  assert.equal(session.cues[0].trans, undefined, "no invented German line");
  session.stopTimer();
});

test('stopping finishes the tail, then closes the session', async () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const bridge = fakeBridge({
    finishAnswer: { ok: true, segments: [segment()], revision: 1, status: "ready" },
  });
  const { session, states } = newSession(bridge, clock);
  session.observe({ mediaMs: 0, wallMs: 100000, rate: 1, paused: false });
  await session.start();
  session.pushPcm(silence(1), { atMs: 100000 });
  const result = await session.finish();
  assert.equal(bridge.calls.finish.length, 1);
  assert.equal(bridge.calls.close.length, 1);
  assert.equal(result.cues.length, 1);
  assert.equal(states[states.length - 1].state, "stopped");
  assert.equal(session.stopped, true);
  assert.equal(session.timer, null);
});

test('a bridge that stops answering degrades and then reports failure', async () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const bridge = fakeBridge();
  bridge.sendAudio = () => Promise.reject(new TypeError("fetch failed"));
  const { session, states } = newSession(bridge, clock);
  session.observe({ mediaMs: 0, wallMs: 100000, rate: 1, paused: false });
  await session.start();
  for (let i = 0; i < 3; i += 1) {
    session.pushPcm(silence(1), { atMs: 100000 });
    session.flush();
    await session.writeChain.catch(() => {});
  }
  const kinds = states.map((s) => s.state);
  assert.ok(kinds.includes("degraded"), `expected a degraded state, saw ${kinds.join(",")}`);
  assert.ok(kinds.includes("failed"), `expected a failed state, saw ${kinds.join(",")}`);
  session.stopTimer();
});


