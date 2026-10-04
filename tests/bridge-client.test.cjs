'use strict';

// The extension half of the local-recognizer bridge (bridge-client.js).
//
// Everything here is a rule the task book states, turned into something that
// fails loudly if it is ever broken again:
//
//  * recognition is only asked for once the page says the video has NO usable
//    caption track ("unknown" is not "absent");
//  * a caption's time comes from the video timeline the caller declared, never
//    from when an answer arrived;
//  * a late revision of a sentence replaces that sentence instead of adding a
//    second one;
//  * a failed translation still shows the original text;
//  * the German line is the TOP line for a Chinese video.
//
// No network, no chrome: the bridge is faked through the injected fetch.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'bridge-client.js'), 'utf8');

test('recognized source word times are validated and cleared on text-only revisions', () => {
  const bridge = load();
  const words = [{ text: 'Hallo', startMs: 1200, endMs: 2000, probability: 0.9 },
    { text: 'Welt', startMs: 2200, endMs: 3000, probability: 0.9 }];
  const cue = bridge.cueFromSegment(segment({ original: 'Hallo Welt', sourceLanguage: 'de', words }));
  assert.equal(cue.wordTimingSource, 'recognition');
  assert.equal(cue.words.length, 2);
  assert.equal(cue.words[0].t, 1200);
  assert.equal(cue.transWords, undefined);
  for (const bad of [NaN, 0.1, 1.1]) {
    assert.equal(bridge.cueFromSegment(segment({ words: [{ ...words[0], probability: bad }] })).words.length, 0);
  }
  assert.equal(bridge.cueFromSegment(segment({ words, provisional: true })).words.length, 0);
  const merged = bridge.mergeSegments([cue], [segment({ original: 'Hallo Welt!', sourceLanguage: 'de', revision: 2 })]);
  assert.equal(merged.cues[0].words.length, 0);
});

const plain = (value) => JSON.parse(JSON.stringify(value));

function load() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'bridge-client.js' });
  return sandbox.YtdsBridge;
}

// --------------------------------------------------------------- fake bridge

// Answers with canned JSON per path and records every request, so a test can
// assert what the client actually said as well as what it did with the reply.
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = (url, init) => {
    const method = (init && init.method) || "GET";
    const body = init && typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method, body, headers: (init && init.headers) || {} });
    const path_ = String(url).replace(/^https?:\/\/[^/]+/, "");
    const answer = routes[path_ + " " + method] || routes[path_] || routes.default;
    const resolved = typeof answer === "function" ? answer({ url, method, body, calls }) : answer;
    if (!resolved) return Promise.reject(new TypeError("fetch failed"));
    const status = resolved.status || 200;
    const payload = resolved.body === undefined ? {} : resolved.body;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(payload === null ? "" : JSON.stringify(payload)),
    });
  };
  return { fetchImpl, calls };
}

function sessionPayload(overrides) {
  return Object.assign(
    {
      ok: true,
      sessionId: "abcdef1234567890",
      protocolVersion: 1,
      engine: "local",
      sourceLanguage: "zh",
      recognize: true,
      reason: "no_captions",
      message: "",
      acceptedFromSample: 0,
    },
    overrides || {}
  );
}

function transcriptPayload(segments, extra) {
  return Object.assign(
    {
      ok: true,
      segments: segments || [],
      revision: (segments || []).length,
      status: "ready",
      language: "zh",
      progressMs: 0,
      translationBackend: "opus-zh-de",
    },
    extra || {}
  );
}

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

// ------------------------------------------------------------------ encoding

test('signed 16-bit PCM keeps its sign and clamps instead of wrapping', () => {
  const bridge = load();
  const bytes = bridge.floatsToPcm16(Float32Array.from([0, 0.5, -0.5, 1, -1, 2, -2]));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((i) => view.getInt16(i * 2, true)),
    [0, 16384, -16384, 32767, -32768, 32767, -32768]
  );
});

test('base64 matches the platform encoder for awkward lengths', () => {
  const bridge = load();
  for (const length of [1, 2, 3, 4, 5, 6, 7, 300]) {
    const bytes = Uint8Array.from({ length }, (_v, i) => (i * 37) % 256);
    assert.equal(bridge.bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
  }
});

test('packets stay inside the bridge limits and keep the stream position', () => {
  const bridge = load();
  // 3 s of 16 kHz mono: 96000 bytes -> two packets at the 1 s default frame.
  const bytes = new Uint8Array(16000 * 2 * 3);
  const { packets, nextSampleIndex, droppedBytes } = bridge.packetize(bytes, {
    sampleRate: 16000,
    channels: 1,
  });
  assert.equal(packets.length, 3);
  assert.equal(droppedBytes, 0);
  assert.equal(nextSampleIndex, 48000);
  assert.deepEqual(Array.from(packets, (p) => Number(p.sampleIndex)), [0, 16000, 32000]);
  assert.deepEqual(Array.from(packets, (p) => Number(p.sequence)), [0, 1, 2]);
  assert.equal(packets[0].sampleRate, 16000);
  assert.equal(packets[0].encoding, 'pcm_s16le');
  assert.ok(packets.every((p) => p.pcm.length < bridge.MAX_PCM_BASE64_CHARS));
  // Sample indices are in the SUBMITTED rate, so a 48 kHz stream counts by
  // 48000 — not by the 16 kHz the bridge recognizes at, which would invent a
  // gap on every single packet. Three seconds of 48 kHz audio needs 9 packets
  // at the 1 s frame cap, each one a second of submitted time later.
  const wide = bridge.packetize(new Uint8Array(48000 * 2 * 3), { sampleRate: 48000, channels: 1 });
  assert.equal(wide.packets.length, 9);
  assert.deepEqual(
    Array.from(wide.packets, (p) => Number(p.sampleIndex)),
    Array.from({ length: 9 }, (_v, i) => i * 16000)
  );
  assert.equal(wide.packets[0].sampleRate, 48000);
  assert.equal(wide.nextSampleIndex, 144000);
});

test('a partial frame at the end is reported, not silently sent as audio', () => {
  const bridge = load();
  const { packets, droppedBytes } = bridge.packetize(new Uint8Array(16000 * 2 + 1), {
    sampleRate: 16000,
    channels: 1,
  });
  assert.equal(droppedBytes, 1);
  assert.equal(packets.length, 1);
});

test('packets are chunked to at most 16 per request', () => {
  const bridge = load();
  const packets = Array.from({ length: 33 }, (_v, i) => ({ sequence: i }));
  assert.deepEqual(Array.from(bridge.chunkPackets(packets), (batch) => Number(batch.length)), [16, 16, 1]);
});

// ------------------------------------------------------------- session rules

test('the session request states the page verdict and the video timeline', () => {
  const bridge = load();
  const body = bridge.sessionRequest({
    platform: 'bilibili',
    videoKey: 'BV1xx411c7mD#p2',
    captionAvailability: bridge.CAPTIONS_ABSENT,
    sourceLanguage: 'zh',
    timelineEpoch: 3,
    audioStartMs: 61500,
    playbackRate: 1.5,
    title: '标题',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
    durationMs: 300000,
  });
  assert.equal(body.protocolVersion, 1);
  assert.equal(body.captionAvailability, 'absent');
  assert.equal(body.sourceKind, 'tab_capture');
  assert.equal(body.timelineEpoch, 3);
  assert.equal(body.audioStartMs, 61500);
  assert.equal(body.hasAudioTrack, true);
  assert.equal(body.translationTarget, 'de');
  // The part number is part of the identity, so two parts never share captions.
  assert.equal(body.videoKey, 'BV1xx411c7mD#p2');
});

test('a session is refused when the video has captions, and no audio is sent', async () => {
  const bridge = load();
  const { fetchImpl, calls } = fakeFetch({
    '/v1/session POST': { body: sessionPayload({ recognize: false, reason: 'captions_present' }) },
    default: { body: {} },
  });
  const result = await bridge.recognize({
    fetch: fetchImpl,
    captionAvailability: bridge.CAPTIONS_PRESENT,
    platform: 'bilibili',
    videoKey: 'BV1#p1',
    audio: { bytes: Uint8Array.from([1, 2, 3, 4]), sampleRate: 16000, channels: 1 },
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.reason, 'captions_present');
  assert.equal(result.cues.length, 0);
  assert.deepEqual(calls.map((c) => c.method), ['POST']);
});

test('an unknown caption state is sent as unknown, never upgraded to absent', () => {
  const bridge = load();
  const body = bridge.sessionRequest({
    platform: 'youtube',
    videoKey: 'dQw4w9WgXcQ',
    captionAvailability: bridge.CAPTIONS_UNKNOWN,
  });
  assert.equal(body.captionAvailability, 'unknown');
});

test('health and session calls carry the bearer token, and the mask never leaks it', async () => {
  const bridge = load();
  const token = 's3cret-token-value';
  const { fetchImpl, calls } = fakeFetch({
    '/v1/health GET': { body: { ok: true, protocolVersion: 1, modelReady: true } },
    default: { body: sessionPayload() },
  });
  const client = bridge.createClient({ fetch: fetchImpl, base: '127.0.0.1:8766', token });
  await client.health();
  assert.equal(calls[0].url, 'http://127.0.0.1:8766/v1/health');
  assert.equal(calls[0].headers.Authorization, 'Bearer ' + token);
  assert.equal(bridge.maskToken(token), 's3c************lue');
  assert.ok(!bridge.maskToken(token).includes('cret'));
});

test('the recognizer client refuses remote bridge addresses before sending a bearer token', () => {
  const bridge = load();
  assert.throws(() => bridge.createClient({ fetch() {}, base: 'https://example.com:8766', token: 'secret' }),
    /loopback HTTP URL/);
  assert.throws(() => bridge.createClient({ fetch() {}, base: 'http://127.0.0.1:8766/path', token: 'secret' }),
    /loopback HTTP URL/);
  assert.doesNotThrow(() => bridge.createClient({ fetch() {}, base: 'http://127.0.0.1:8766', token: 'secret' }));
});

test('an oversized bridge response is rejected before JSON parsing', async () => {
  const bridge = load();
  const client = bridge.createClient({
    base: 'http://127.0.0.1:8766', token: 'secret',
    fetch: () => Promise.resolve({ ok: true, text: async () => 'x'.repeat(4 * 1024 * 1024 + 1) })
  });
  await assert.rejects(client.health(), /response exceeded the size limit/);
});

test('an offline bridge becomes a clear error instead of a hang', async () => {
  const bridge = load();
  const { fetchImpl } = fakeFetch({ default: null });
  const client = bridge.createClient({ fetch: fetchImpl, base: 'http://127.0.0.1:8766', token: 't' });
  await assert.rejects(client.health(), (error) => {
    assert.equal(error.code, 'offline');
    return true;
  });
});

test('a bridge error code survives to the caller', async () => {
  const bridge = load();
  const { fetchImpl } = fakeFetch({
    default: { status: 503, body: { ok: false, error: { code: 'engine_unavailable', message: '模型准备失败' } } },
  });
  const client = bridge.createClient({ fetch: fetchImpl, base: 'http://127.0.0.1:8766', token: 't' });
  await assert.rejects(client.createSession({ platform: 'bilibili', videoKey: 'x', captionAvailability: 'absent' }), (error) => {
    assert.equal(error.code, 'engine_unavailable');
    assert.equal(error.status, 503);
    return true;
  });
});

// --------------------------------------------------------------- cue building

test('a segment becomes a cue whose time is the video timeline it was given', () => {
  const bridge = load();
  const cue = bridge.cueFromSegment(segment({ startMs: 1200, endMs: 3400 }));
  assert.equal(cue.start, 1200);
  assert.equal(cue.end, 3400);
  assert.equal(cue.dur, 2200);
  assert.equal(cue.text, '今天天气很好。');
  assert.equal(cue.trans, 'Das Wetter ist heute schön.');
  assert.equal(cue.id, 'abcdef12-0-0');
});

test('a failed translation still shows the recognized original', () => {
  const bridge = load();
  const cue = bridge.cueFromSegment(
    segment({ german: '', translationFailed: true, translationBackend: '' })
  );
  assert.equal(cue.text, '今天天气很好。');
  assert.equal(cue.trans, undefined);
  assert.equal(cue.translationFailed, true);
});

test('a German source needs no translation line', () => {
  const bridge = load();
  const cue = bridge.cueFromSegment(
    segment({ sourceLanguage: 'de', original: 'Guten Tag.', german: 'Guten Tag.' })
  );
  assert.equal(cue.text, 'Guten Tag.');
  assert.equal(cue.trans, undefined);
});

test('a later revision of one sentence replaces it instead of adding a line', () => {
  const bridge = load();
  const first = bridge.mergeSegments([], [segment({ provisional: true, german: '' })]);
  assert.equal(first.cues.length, 1);
  assert.equal(first.cues[0].trans, undefined);
  const second = bridge.mergeSegments(first.cues, [
    segment({ revision: 2, provisional: false, german: 'Das Wetter ist heute schön.' }),
  ]);
  assert.equal(second.cues.length, 1);
  assert.equal(second.added, 0);
  assert.equal(second.updated, 1);
  assert.equal(second.cues[0].trans, 'Das Wetter ist heute schön.');
  assert.equal(second.cues[0].provisional, false);
});

test('a stale revision that arrives late never overwrites newer text', () => {
  const bridge = load();
  const merged = bridge.mergeSegments(
    bridge.mergeSegments([], [segment({ revision: 4, german: 'Neue Fassung' })]).cues,
    [segment({ revision: 2, german: 'Alte Fassung' })]
  );
  assert.equal(merged.cues[0].trans, 'Neue Fassung');
  assert.equal(merged.updated, 0);
});

test('a revision without a translation keeps the translation already shown', () => {
  const bridge = load();
  const merged = bridge.mergeSegments(
    bridge.mergeSegments([], [segment({ revision: 2, german: 'Übersetzung' })]).cues,
    [segment({ revision: 3, german: '' })]
  );
  assert.equal(merged.cues[0].trans, 'Übersetzung');
});

test('a corrected original discards its old translation until the new one arrives', () => {
  const bridge = load();
  const first = bridge.mergeSegments([], [segment({ revision: 1 })]);
  const corrected = bridge.mergeSegments(first.cues, [segment({ revision: 2,
    original: '明天天气很差。', german: '' })]);
  assert.equal(corrected.cues[0].trans, undefined);
  assert.equal(corrected.cues[0].text, '明天天气很差。');
  const translated = bridge.mergeSegments(corrected.cues, [segment({ revision: 3,
    original: '明天天气很差。', german: 'Morgen wird das Wetter schlecht.' })]);
  assert.equal(translated.cues[0].trans, 'Morgen wird das Wetter schlecht.');
});

test('segment ids may recur in another epoch without overwriting its sentences', () => {
  const bridge = load();
  const merged = bridge.mergeSegments([], [segment({ timelineEpoch: 0, revision: 4 }),
    segment({ timelineEpoch: 1, revision: 1, original: '另一段话。' })]);
  assert.equal(merged.cues.length, 2);
});

test('invalid recognition coordinates are rejected instead of painting at time zero', () => {
  const bridge = load();
  for (const patch of [{ startMs: NaN }, { endMs: Infinity }, { startMs: '1200' },
    { startMs: -1 }, { endMs: 1200 }, { endMs: 86400001 },
    { timelineEpoch: -1 }, { revision: 1.2 }, { original: '', german: 'translation only' }]) {
    assert.equal(bridge.cueFromSegment(segment(patch)), null);
  }
});

test('cues stay in video order and a translation is still pending while it can arrive', () => {
  const bridge = load();
  const merged = bridge.mergeSegments([], [
    segment({ segmentId: 'b', startMs: 5000, endMs: 6000, german: '', provisional: true }),
    segment({ segmentId: 'a', startMs: 1000, german: 'Erste' }),
  ]);
  assert.deepEqual(Array.from(merged.cues, (c) => String(c.id)), ['a', 'b']);
  // A provisional cue may still gain its translation, so the caller keeps
  // polling; a cue whose translation is already decided (or failed) does not
  // hold the batch open.
  assert.equal(bridge.pendingTranslation(merged.cues), true);
  assert.equal(bridge.pendingTranslation([bridge.cueFromSegment(segment({ german: 'Ja' }))]), false);
  assert.equal(
    bridge.pendingTranslation([bridge.cueFromSegment(segment({ german: '', provisional: false, translationFailed: true }))]),
    false
  );
  assert.equal(
    bridge.pendingTranslation([bridge.cueFromSegment(segment({ german: '', provisional: true }))]),
    true
  );
});

test('a published original keeps polling until translation succeeds or explicitly fails', () => {
  const bridge = load();
  const source = bridge.cueFromSegment(segment({ german: '', provisional: false, translationFailed: false }));
  assert.equal(source.translationFailed, false);
  assert.equal(bridge.pendingTranslation([source]), true);
  const revised = bridge.mergeSegments([source], [segment({ german: 'Hallo', revision: 2 })]);
  assert.equal(bridge.pendingTranslation(revised.cues), false);
});

test('review labels preserve raw text and do not expose a fake accuracy percentage', () => {
  const cue = load().cueFromSegment(segment({ rawOriginal: '原始字形', uncertain: true,
    uncertaintyReasons: ['low_log_probability', 'scores_unavailable', 'injected'], avgLogprob: -1.4,
    translationGroupIds: ['a', 'b'] }));
  assert.equal(cue.rawOriginal, '原始字形');
  assert.equal(cue.uncertain, true);
  assert.deepEqual(Array.from(cue.uncertaintyReasons), ['low_log_probability', 'scores_unavailable']);
  assert.equal(cue.accuracy, undefined);
  assert.equal(cue.translationGroupIds.length, 2);
});

// ---------------------------------------------------------------------- SRT

test('the exported file puts the German line above the Chinese original', () => {
  const bridge = load();
  const srt = bridge.toSrt([
    bridge.cueFromSegment(segment({ startMs: 1200, endMs: 3400 })),
    bridge.cueFromSegment(
      segment({
        segmentId: 'x',
        revision: 1,
        startMs: 4000,
        endMs: 6100,
        original: '我们去看电影吧。',
        german: 'Gehen wir ins Kino.',
      })
    ),
  ]);
  assert.equal(
    srt,
    [
      '1',
      '00:00:01,200 --> 00:00:03,400',
      'Das Wetter ist heute schön.',
      '今天天气很好。',
      '',
      '2',
      '00:00:04,000 --> 00:00:06,100',
      'Gehen wir ins Kino.',
      '我们去看电影吧。',
      '',
    ].join('\n')
  );
});

test('an untranslated cue exports only the original, and an empty list exports nothing', () => {
  const bridge = load();
  const srt = bridge.toSrt([bridge.cueFromSegment(segment({ german: '', translationFailed: true }))]);
  assert.equal(srt.includes('今天天气很好。'), true);
  assert.equal(srt.split('\n')[2], '今天天气很好。');
  assert.equal(bridge.toSrt([]), '');
  assert.equal(bridge.SRT_TIME(3661001), '01:01:01,001');
});

// --------------------------------------------------------------- end to end

test('the whole protocol runs in order: session, audio, finish, then tail polls', async () => {
  const bridge = load();
  const audio = new Uint8Array(16000 * 2 * 2); // 2 s of 16 kHz mono
  let polls = 0;
  const { fetchImpl, calls } = fakeFetch({
    '/v1/session POST': { body: sessionPayload() },
    '/v1/session/abcdef1234567890/audio POST': { body: { ok: true, acceptedSamples: 32000, revision: 1 } },
    '/v1/session/abcdef1234567890/finish POST': { body: { ok: true, acceptedSamples: 32000, revision: 1 } },
    '/v1/session/abcdef1234567890/transcript POST': () => {
      polls += 1;
      if (polls === 1) return { body: transcriptPayload([]) };
      if (polls === 2) return { body: transcriptPayload([segment({ provisional: true, german: '' })], { revision: 1, status: 'recognizing' }) };
      return { body: transcriptPayload([segment({ revision: 2 })], { revision: 2, status: 'ready' }) };
    },
    '/v1/session/abcdef1234567890 DELETE': { body: { ok: true, closedSegments: 0 } },
  });
  const updates = [];
  const result = await bridge.recognize({
    fetch: fetchImpl,
    base: 'http://127.0.0.1:8766',
    token: 't',
    platform: 'bilibili',
    videoKey: 'BV1#p1',
    captionAvailability: bridge.CAPTIONS_ABSENT,
    sourceLanguage: 'zh',
    audioStartMs: 30000,
    timelineEpoch: 1,
    audio: { bytes: audio, sampleRate: 16000, channels: 1 },
    onEvent: (event) => updates.push(event),
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.cues.length, 1);
  assert.equal(result.cues[0].text, '今天天气很好。');
  assert.equal(result.cues[0].trans, 'Das Wetter ist heute schön.');
  assert.equal(result.cues[0].start, 1200);
  assert.equal(result.session.recognize, true);
  // The audio went in before the finish, and the first packet declared the
  // media time the whole stream is anchored to.
  const methods = calls.map((c) => c.method + ' ' + c.url.replace('http://127.0.0.1:8766', ''));
  assert.equal(methods[0], 'POST /v1/session');
  assert.equal(methods[methods.length - 1], 'DELETE /v1/session/abcdef1234567890');
  assert.ok(methods.indexOf('POST /v1/session/abcdef1234567890/finish') > 0);
  const firstAudio = calls.find((c) => c.url.endsWith('/audio'));
  assert.equal(firstAudio.body.packets[0].audioStartMs, 30000);
  assert.equal(firstAudio.body.packets[0].timelineEpoch, 1);
  assert.equal(firstAudio.body.packets[0].sampleIndex, 0);
  assert.equal(firstAudio.body.packets.length, 2);
  const finished = calls.find((c) => c.url.endsWith('/finish'));
  assert.equal(finished.body.streamComplete, true);
  assert.ok(updates.some((u) => u.type === 'cues' && u.cues[0].provisional === true));
  assert.ok(updates.some((u) => u.type === 'cues' && u.cues[0].trans === 'Das Wetter ist heute schön.'));
});

test('a poll that only revises a sentence reports it as an update, not a new line', async () => {
  const bridge = load();
  const audio = new Uint8Array(16000 * 2);
  let polls = 0;
  const { fetchImpl } = fakeFetch({
    '/v1/session POST': { body: sessionPayload() },
    default: { body: { ok: true, revision: 1 } },
    '/v1/session/abcdef1234567890/transcript POST': () => {
      polls += 1;
      if (polls <= 2) {
        return {
          body: transcriptPayload([segment({ revision: polls, provisional: polls === 1, german: polls === 1 ? '' : 'Satz' })], {
            revision: polls,
            status: 'recognizing',
          }),
        };
      }
      return { body: transcriptPayload([segment({ revision: 2, german: 'Satz' })], { revision: 2, status: 'ready' }) };
    },
  });
  const updates = [];
  const result = await bridge.recognize({
    fetch: fetchImpl,
    base: 'http://127.0.0.1:8766',
    token: 't',
    platform: 'youtube',
    videoKey: 'abc',
    captionAvailability: bridge.CAPTIONS_ABSENT,
    sourceLanguage: 'zh',
    audio: { bytes: audio, sampleRate: 16000, channels: 1 },
    onEvent: (event) => { if (event.type === 'cues') updates.push(event); },
  });
  assert.equal(result.cues.length, 1);
  assert.ok(updates.length >= 2);
  assert.equal(updates[updates.length - 1].updated >= 1, true);
  assert.equal(updates[updates.length - 1].added, 0);
});

test('tombstones prevent late resurrection and a newer replacement appears once', () => {
  const bridge = load();
  const cue = bridge.cueFromSegment(segment());
  const removed = { segmentId: cue.id, timelineEpoch: cue.epoch, revision: 3, removed: true };
  const first = bridge.mergeSegments([cue], [removed]);
  assert.equal(first.cues.length, 0);
  const stale = bridge.mergeSegments(first.cues, [segment({ revision: 2 })]);
  assert.equal(stale.cues.length, 0);
  const fresh = bridge.mergeSegments(stale.cues, [segment({ revision: 4 })]);
  assert.equal(fresh.cues.length, 1);
  assert.equal(bridge.mergeSegments([cue], [removed, segment({ revision: 4 })]).cues.length, 1);
});

test('empty and stale recognition polls retain list identity and removal history', () => {
  const bridge = load();
  const list = Array.from({ length: 5000 }, (_, i) =>
    bridge.cueFromSegment(segment({ segmentId: 's' + i, startMs: i * 4000, endMs: i * 4000 + 2000 })));
  assert.strictEqual(bridge.mergeSegments(list, []).cues, list);
  assert.strictEqual(bridge.mergeSegments(list, [segment({ segmentId: 's0' })]).cues, list);
  const removal = { segmentId: 'gone', timelineEpoch: 0, revision: 3, removed: true };
  assert.strictEqual(bridge.mergeSegments(list, [removal]).cues, list);
  const empty = bridge.mergeSegments(list, []).cues;
  assert.strictEqual(bridge.mergeSegments(empty, [segment({ segmentId: 'gone', revision: 2 })]).cues, list);
});

test('file recognition keeps removed sentences removed through later stale polls', async () => {
  const bridge = load();
  let polls = 0;
  const { fetchImpl } = fakeFetch({
    '/v1/session POST': { body: sessionPayload() },
    default: { body: { ok: true } },
    '/v1/session/abcdef1234567890/transcript POST': () => {
      polls++;
      const segments = polls === 1 ? [segment()] : polls === 2
        ? [{ segmentId: segment().segmentId, timelineEpoch: 0, revision: 3, removed: true }]
        : polls === 3 ? [] : [segment({ revision: 2 })];
      return { body: transcriptPayload(segments, { revision: polls, status: polls < 4 ? 'recognizing' : 'ready' }) };
    }
  });
  const result = await bridge.recognize({ fetch: fetchImpl, base: 'http://127.0.0.1:8766',
    platform: 'youtube', videoKey: 'abc', captionAvailability: 'absent',
    audio: { bytes: new Uint8Array(32000), sampleRate: 16000, channels: 1 } });
  assert.equal(result.cues.length, 0);
  assert.equal(polls, 4);
});
