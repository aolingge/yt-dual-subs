const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const timing = require('../word-timing.js');
const { mountContent } = require('./harness.cjs');
const videoId = 'speechde001';
const cue = { start: 0, dur: 4000, text: 'Hallo schöne Welt.', trans: '你好，美丽的世界。' };
const segment = () => ({ start: 0, dur: 4000, text: cue.text, words: [
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
  const reply = player.request({ type: 'applyAudioTiming', record: { videoId, sourceLang: 'de', segments: [segment()] } });
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
  assert.equal(player.request({ type: 'audioContext' }).cues.length, 1);
  assert.equal(player.request({ type: 'applyAudioTiming', record: { videoId, sourceLang: 'en', segments: [segment()] } }).ok, false);
  player.request({ type: 'applyAudioTiming', record: { videoId, sourceLang: 'de', segments: [segment()] } });
  assert.equal(player.request({ type: 'audioContext' }).cues.length, 0);
  player.navigate('otherde0001');
  assert.equal(player.request({ type: 'applyAudioTiming', record: { videoId, sourceLang: 'de', segments: [segment()] } }).ok, false);
});

test('local cache serializes partial results and merges jobs without any sync-storage writes', async () => {
  let saved = {};
  const listeners = [];
  const sandbox = { YtdsWordTiming: timing, chrome: {
    runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } },
    storage: { local: { async get() { return saved; }, async set(value) { saved = value; } },
      sync: { set() { assert.fail('audio must not write sync storage'); } } }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'audio-cache.js'), 'utf8'), sandbox);
  const save = segments => new Promise(resolve => listeners[0]({ type: 'saveAudioTiming', record: { videoId, sourceLang: 'de', segments } }, {}, resolve));
  const second = { ...segment(), start: 5000, words: segment().words.map(w => ({ ...w, t: w.t + 5000, e: w.e + 5000 })) };
  await Promise.all([save([segment()]), save([second])]);
  assert.equal(saved.audioTimingCacheV1[0].segments.length, 2);
  const result = await save([{ ...second, words: [] }]);
  assert.equal(result.count, 2, 'invalid partial results cannot erase earlier times');
});
