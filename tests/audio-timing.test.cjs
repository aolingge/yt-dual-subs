const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const timing = require('../word-timing.js');
const { mountContent } = require('./harness.cjs');
const videoId = 'speechde001';
const cue = { start: 0, dur: 4000, text: 'Hallo schöne Welt.', trans: '你好，美丽的世界。' };
const segment = () => ({ index: 0, start: 0, dur: 4000, text: cue.text, words: [
  { t: 200, e: 600, u: 'Hallo', score: .9 },
  { t: 1300, e: 1800, u: 'schöne', score: .8 },
  { t: 2600, e: 3100, u: 'Welt', score: .85 }
] });

test('audio alignment preserves the complete original and exposes real word ends', () => {
  const cues = [{ ...cue }];
  assert.equal(timing.applyAudio(cues, [segment()], 'de'), 1);
  assert.equal(cues[0].wordTimingSource, 'audio');
  const pieces = timing.captionPieces(cues[0], 'de');
  assert.equal(pieces.map(p => p.u).join(''), cue.text);
  assert.deepEqual(pieces.map(p => p.e), [600, 1800, 3100]);
  const native = [{ ...cue, words: [{ t: 0, u: 'Hallo ' }, { t: 500, u: 'schöne ' }, { t: 1000, u: 'Welt.' }] }];
  assert.equal(timing.applyAudio(native, [segment()], 'de'), 0);
  assert.equal(native[0].words[1].t, 500);
});

test('changed text/windows, weak confidence, incomplete words and overlapping audio ends are rejected', () => {
  const invalid = [
    { ...segment(), text: 'Hallo andere Welt.' },
    { ...segment(), dur: 4100 },
    { ...segment(), words: segment().words.slice(0, 2) },
    { ...segment(), words: segment().words.map(w => ({ ...w, score: .01 })) },
    { ...segment(), words: segment().words.map(w => ({ ...w, score: .20 })) },
    { ...segment(), words: segment().words.map((w, i) => ({ ...w, e: i === 0 ? 1500 : w.e })) },
    { ...segment(), words: segment().words.map((w, i) => ({ ...w, e: i === 2 ? 5000 : w.e })) }
  ];
  for (const entry of invalid) {
    const cues = [{ ...cue }];
    assert.equal(timing.applyAudio(cues, [entry], 'de'), 0);
    assert.equal(cues[0].words, undefined);
  }
});

test('late audio follows playback, silence, pause and seek without changing translations, reveal or SRT', async () => {
  const player = await mountContent({ videoId, cues: [{ ...cue }], settings: { revealMode: 'manual' } });
  player.runtimeMessage({ type: 'revealTranslation' });
  const before = player.read();
  const srt = await player.exportOriginal();
  player.seekTo(1.5);
  const reply = player.request({ type: 'applyAudioTiming', record: {
    videoId, sourceLang: 'de', cuesKey: player.request({ type: 'audioIdentity' }).cuesKey,
    version: 2, segments: [segment()] } });
  assert.equal(reply.count, 1);
  assert.equal(player.status().wordTiming, 'audio');
  assert.equal(player.activeWordIdx(), 1);
  assert.deepEqual(player.read(), before);
  assert.equal(player.overlayEl().hasClass('ytds-reveal-manual'), false);
  player.seekTo(.9);
  assert.equal(player.activeWordIdx(), -1, 'silence has no spoken word');
  player.video.paused = true;
  player.seekTo(2.7);
  assert.equal(player.activeWordIdx(), 2);
  player.changeSettings({ offsetMs: -1200 });
  assert.equal(player.activeWordIdx(), 1);
  assert.deepEqual(await player.exportOriginal(), srt);
  player.updateTranslation([{ ...cue, trans: '新译文' }], null, true);
  player.seekTo(1.5);
  player.changeSettings({ offsetMs: 0 });
  assert.equal(player.status().wordTiming, 'audio', 'late track updates reuse audio display metadata');
});

test('audio context includes only missing timing and delayed results cannot apply after video or language changes', async () => {
  const player = await mountContent({ videoId, cues: [{ ...cue }] });
  const track = { videoId, sourceLang: 'de', cuesKey: player.request({ type: 'audioIdentity' }).cuesKey,
    version: 2, segments: [segment()] };
  assert.equal(player.request({ type: 'audioContext' }).cues.length, 1);
  assert.equal(player.request({ type: 'applyAudioTiming', record: { ...track, sourceLang: 'en' } }).ok, false);
  player.request({ type: 'applyAudioTiming', record: track });
  assert.equal(player.request({ type: 'audioContext' }).cues.length, 0);
  player.navigate('otherde0001');
  assert.equal(player.request({ type: 'applyAudioTiming', record: track }).ok, false);
});

test('a caption track identity changes with text, boundaries and order', () => {
  const track = [{ start: 0, end: 4000, text: 'Hallo Welt' }, { start: 5000, end: 9000, text: 'Guten Tag' }];
  const key = timing.timingKey(track);
  assert.match(key, /^[0-9a-f]{8}$/);
  assert.equal(timing.timingKey(track.map(c => ({ ...c }))), key, 'the same track keeps its key');
  assert.equal(timing.timingKey([{ start: 0, dur: 4000, text: 'Hallo Welt' },
    { start: 5000, dur: 4000, text: 'Guten Tag' }]), key, 'dur and end describe the same cue');
  assert.notEqual(timing.timingKey([{ ...track[0], text: 'Hallo Welt!' }, track[1]]), key);
  assert.notEqual(timing.timingKey([{ ...track[0], start: 100, end: 4100 }, track[1]]), key);
  assert.notEqual(timing.timingKey([track[1], track[0]]), key);
  assert.equal(timing.timingKey([]), timing.timingKey([]));
});

test('alignment results for other subtitles are refused and reported, never applied', async () => {
  const player = await mountContent({ videoId, cues: [{ ...cue }] });
  const identity = player.request({ type: 'audioIdentity' });
  assert.equal(identity.ok, true);
  assert.equal(identity.videoId, videoId);
  assert.match(identity.cuesKey, /^[0-9a-f]{8}$/);
  assert.equal(player.request({ type: 'audioContext' }).cuesKey, identity.cuesKey);
  const foreign = player.request({ type: 'applyAudioTiming',
    record: { videoId, sourceLang: 'de', cuesKey: 'ffffffff', version: 2, segments: [segment()] } });
  assert.equal(foreign.count, 0, 'a record from another track is not applied');
  assert.equal(player.status().audioStale, true, 'the UI can tell why nothing was applied');
  assert.equal(player.status().wordTiming, 'estimated');
  const current = player.request({ type: 'applyAudioTiming',
    record: { videoId, sourceLang: 'de', cuesKey: identity.cuesKey, version: 2, segments: [segment()] } });
  assert.equal(current.count, 1);
  assert.equal(player.status().wordTiming, 'audio');
  assert.equal(player.status().audioStale, false, 'a matching record clears the notice');
  // Switching the track changes the identity the alignment page polls.
  player.navigate('otherde0001');
  player.sendCues({ cues: [{ start: 0, dur: 3000, text: 'Andere Worte hier', trans: '别的词' }],
    sourceLang: 'de', videoId: 'otherde0001' });
  const changed = player.request({ type: 'audioIdentity' });
  assert.equal(changed.videoId, 'otherde0001');
  assert.notEqual(changed.cuesKey, identity.cuesKey);
});

test('word times are applied only to the sentence they were measured on', async () => {
  // Two identical sentences at different positions: text alone cannot say which
  // one a result belongs to, so the track position decides.
  const player = await mountContent({ videoId, cues: [{ ...cue }, { ...cue, start: 5000 }] });
  const key = player.request({ type: 'audioIdentity' }).cuesKey;
  const shifted = { ...segment(), index: 1, start: 5000,
    words: segment().words.map(w => ({ ...w, t: w.t + 5000, e: w.e + 5000 })) };
  const reply = player.request({ type: 'applyAudioTiming', record: {
    videoId, sourceLang: 'de', cuesKey: key, version: 2, segments: [shifted] } });
  assert.equal(reply.count, 1);
  const missing = player.request({ type: 'audioContext' }).cues;
  assert.equal(missing.length, 1, 'only the other sentence still needs word times');
  assert.equal(missing[0].index, 0, 'the sentence left without times states its own position');
  // A position that does not exist in this track is refused, not clamped.
  const outside = player.request({ type: 'applyAudioTiming', record: {
    videoId, sourceLang: 'de', cuesKey: key, version: 2,
    segments: [{ ...segment(), index: 7 }] } });
  assert.equal(outside.count, 0);
});

test('word times that arrive late replace the pace measured without them', async () => {
  const player = await mountContent({ videoId, cues: [{ ...cue }, { ...cue, start: 8000 }] });
  const real = player.timing;
  let calls = 0;
  player.timing = Object.freeze({ ...real,
    pace(...args) { calls += 1; return real.pace(...args); } });
  // The track is measured when it changes, not once per rendered frame.
  player.at(8.1);
  const first = calls;
  player.at(8.2);
  player.at(8.3);
  assert.equal(calls, first, 'playback does not rescan the track for every frame');
  assert.ok(first <= 1, 'the track is measured at most once');
  // Word times landing on the first sentence change what the track looks like,
  // so the sentence still playing is measured again instead of being rendered
  // with the rate that was guessed before those times existed.
  const key = player.request({ type: 'audioIdentity' }).cuesKey;
  assert.equal(player.request({ type: 'applyAudioTiming', record: { videoId, sourceLang: 'de',
    cuesKey: key, version: 2, segments: [segment()] } }).count, 1);
  player.at(8.4);
  assert.equal(calls, first + 1, 'real word times are measured again instead of reusing the estimate');
});

test('local cache serializes partial results and keys them by track and offset', async () => {
  let saved = {};
  const listeners = [];
  const sandbox = { YtdsWordTiming: timing, chrome: {
    runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } },
    storage: { local: { async get() { return saved; }, async set(value) { saved = value; } },
      sync: { set() { assert.fail('audio must not write sync storage'); } } }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'audio-cache.js'), 'utf8'), sandbox);
  const save = (segments, extra = {}) => new Promise(resolve => listeners[0]({ type: 'saveAudioTiming',
    record: { videoId, sourceLang: 'de', cuesKey: 'deadbeef', model: 'oliverguhr/wav2vec2-base-german-cv9',
      version: 2, offsetMs: 0, segments, ...extra } }, {}, resolve));
  const second = { ...segment(), index: 1, start: 5000, words: segment().words.map(w => ({ ...w, t: w.t + 5000, e: w.e + 5000 })) };
  await Promise.all([save([segment()]), save([second])]);
  assert.equal(saved.audioTimingCacheV1[0].segments.length, 2);
  const result = await save([{ ...second, words: [] }]);
  assert.equal(result.ok, false, 'an all-invalid batch is refused, never stored as success');
  assert.equal(saved.audioTimingCacheV1[0].segments.length, 2, 'and it cannot erase earlier times');
  // A different subtitle track or audio offset is a different result, never a merge.
  await save([segment()], { cuesKey: 'cafebabe' });
  await save([segment()], { offsetMs: 60_000 });
  assert.equal(saved.audioTimingCacheV1.length, 3);
  // The arrays come from the vm realm, so compare joined text, not prototypes.
  assert.equal(saved.audioTimingCacheV1.map(r => r.cuesKey).join(','), 'deadbeef,cafebabe,deadbeef');
  assert.equal(saved.audioTimingCacheV1.map(r => r.offsetMs).join(','), '0,0,60000');
  assert.equal(saved.audioTimingCacheV1.every(r => r.version === 2 && r.model), true);
  // An incomplete record is refused instead of being stored as a success.
  for (const extra of [{ cuesKey: '' }, { version: 0 }, { model: '' }, { offsetMs: -1 }]) {
    assert.equal((await save([segment()], extra)).ok, false);
  }
  assert.equal(saved.audioTimingCacheV1.length, 3);
});
