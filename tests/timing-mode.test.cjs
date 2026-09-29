const test = require('node:test');
const assert = require('node:assert/strict');
const { mountContent } = require('./harness.cjs');

const cue = { start: 0, dur: 4000, text: 'Hallo schöne Welt.', trans: '你好，美丽的世界。' };
const segment = () => ({ index: 0, start: 0, dur: 4000, text: cue.text, words: [
  { t: 200, e: 600, u: 'Hallo', score: .9 },
  { t: 1300, e: 1800, u: 'schöne', score: .8 },
  { t: 2600, e: 3100, u: 'Welt', score: .85 }
] });
const live = (p) => p.outbound.filter((m) => m.type === 'word-timing-config');

test('automatic mode asks the page to match automatic captions', async () => {
  const p = await mountContent({ cues: [{ ...cue }] });
  const config = p.outbound.find((m) => m.type === 'config');
  assert.equal(config.useWordTiming, true);
  assert.equal(config.useAutoMatch, true);
});

test('approximate follow-along highlights captions but never fetches another track', async () => {
  const p = await mountContent({ cues: [{ ...cue }], settings: { timingMode: 'approximate' } });
  const config = p.outbound.find((m) => m.type === 'config');
  assert.equal(config.useWordTiming, true, 'caption word times still highlight');
  assert.equal(config.useAutoMatch, false, 'no automatic caption track is fetched');
});

test('changing the mode reaches the running page without a reload', async () => {
  const p = await mountContent({ cues: [{ ...cue }] });
  const before = live(p).length;
  p.changeSettings({ timingMode: 'approximate' });
  assert.equal(live(p).length, before + 1);
  assert.equal(live(p).at(-1).useAutoMatch, false);
  assert.equal(live(p).at(-1).useWordTiming, true);
  p.changeSettings({ timingMode: 'audio' });
  assert.equal(live(p).at(-1).useAutoMatch, true, 'audio mode may match automatic captions again');
});

test('approximate mode keeps audio alignment results out of the page', async () => {
  const approximate = await mountContent({ cues: [{ ...cue }], settings: { timingMode: 'approximate' } });
  approximate.seekTo(1.5);
  assert.equal(approximate.request({ type: 'applyAudioTiming',
    record: { videoId: 'sample', sourceLang: 'de', version: 2, segments: [segment()] } }).count, 0);
  assert.equal(approximate.status().wordTiming, 'estimated');
  const auto = await mountContent({ cues: [{ ...cue }] });
  auto.seekTo(1.5);
  const record = { videoId: 'sample', sourceLang: 'de', version: 2, segments: [segment()],
    cuesKey: auto.request({ type: 'audioIdentity' }).cuesKey };
  assert.equal(auto.request({ type: 'applyAudioTiming', record }).count, 1);
  assert.equal(auto.status().wordTiming, 'audio');
});

test('the mode is a saved setting shared by the popup and the page', async () => {
  const content = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'content.js'), 'utf8');
  const popup = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'popup.js'), 'utf8');
  assert.match(content, /timingMode: "auto"/);
  assert.match(popup, /timingMode: "auto"/);
});

test('the popup can see whether an analysis is running, finished or failed', async () => {
  const p = await mountContent({ cues: [{ ...cue }] });
  assert.equal(p.status().audioJob, '');
  assert.deepEqual({ ...p.request({ type: 'audioJobState', state: 'running' }) }, { ok: true, audioJob: 'running' });
  assert.equal(p.status().audioJob, 'running');
  p.request({ type: 'audioJobState', state: 'done' });
  assert.equal(p.status().audioJob, 'done');
  p.request({ type: 'audioJobState', state: 'failed' });
  assert.equal(p.status().audioJob, 'failed');
  p.request({ type: 'audioJobState', state: 'nonsense' });
  assert.equal(p.status().audioJob, '', 'only known states are accepted');
});

// Caption times already in the cue: the fallback an audio failure must land on.
const timed = () => ({ start: 0, dur: 4000, text: cue.text, trans: cue.trans, words: [
  { t: 0, u: 'Hallo' }, { t: 1300, u: 'schöne' }, { t: 2600, u: 'Welt' }] });

test('a failed analysis leaves the caption timing and the translation usable', async () => {
  const p = await mountContent({ cues: [timed()] });
  p.at(0.2);
  assert.equal(p.status().wordTiming, 'captions');
  assert.deepEqual({ ...p.request({ type: 'audioJobState', state: 'failed' }) }, { ok: true, audioJob: 'failed' });
  p.at(1.5);
  assert.equal(p.activeWordIdx(), 1, 'the video clock still drives the highlight');
  assert.equal(p.status().wordTiming, 'captions', 'a failure never claims audio timing');
  const overlay = p.overlayEl();
  assert.match(overlay.children[1].textContent, /Hallo schöne Welt/);
  assert.match(overlay.children[0].textContent, /美丽的世界/);
});

test('the highlight follows video time at any playback rate', async () => {
  const p = await mountContent({ cues: [timed()] });
  p.at(0.2);
  assert.equal(p.activeWordIdx(), 0);
  p.video.playbackRate = 2;
  p.at(1.5);
  assert.equal(p.activeWordIdx(), 1, 'double speed still highlights the word at this video time');
  p.video.playbackRate = .5;
  p.at(2.9);
  assert.equal(p.activeWordIdx(), 2);
});
