const test = require('node:test');
const assert = require('node:assert/strict');
const { mountContent } = require('./harness.cjs');

const cue = { start: 0, dur: 4000, text: 'Hallo schöne Welt.', trans: '你好，美丽的世界。' };
const segment = () => ({ start: 0, dur: 4000, text: cue.text, words: [
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
  const record = { videoId: 'sample', sourceLang: 'de', segments: [segment()] };
  const approximate = await mountContent({ cues: [{ ...cue }], settings: { timingMode: 'approximate' } });
  approximate.seekTo(1.5);
  assert.equal(approximate.request({ type: 'applyAudioTiming', record }).count, 0);
  assert.equal(approximate.status().wordTiming, 'estimated');
  const auto = await mountContent({ cues: [{ ...cue }] });
  auto.seekTo(1.5);
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
