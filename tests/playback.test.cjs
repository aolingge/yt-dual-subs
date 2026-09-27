// Behaviour of the playback path: subtitle sync offset, pausing, the Google
// rate-limit cooldown, the per-video memory cache, and the status snapshot the
// popup reads. Every case runs the real content.js through tests/harness.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');

const { mountContent, MANIFEST_VERSION } = require('./harness.cjs');

const TWO = [
  { start: 0, dur: 1000, text: 'Erste.' },
  { start: 1000, dur: 1000, text: 'Zweite.' }
];

test('the sync offset decides which sentence is on screen', async () => {
  const plain = await mountContent({ cues: TWO, aligned: true });
  assert.equal(plain.at(0.6).original, 'Erste.');

  const shifted = await mountContent({ cues: TWO, aligned: true, settings: { offsetMs: 500 } });
  assert.equal(shifted.at(0.6).original, 'Zweite.');

  // dragging the slider while the video plays re-renders without waiting for a tick
  shifted.changeSettings({ offsetMs: 0 });
  assert.equal(shifted.read().original, 'Erste.');
});

test('a paused or backgrounded player stops re-rendering, but a seek still does', async () => {
  const player = await mountContent({
    cues: [{ start: 0, dur: 2000, text: 'A.' }, { start: 2000, dur: 2000, text: 'B.' }],
    aligned: true
  });
  assert.equal(player.at(0.5).original, 'A.');

  player.setPaused(true);
  player.at(2.5);
  assert.equal(player.read().original, 'A.', 'a paused tick must not repaint');

  assert.equal(player.seekTo(2.5).original, 'B.', 'a seek forces one repaint');

  player.setPaused(false);
  player.setHidden(true);
  player.at(0.5);
  assert.equal(player.read().original, 'B.', 'a hidden tab must not repaint');

  player.setHidden(false);
  player.seekTo(0.5);
  assert.equal(player.read().original, 'A.');
});

test('a rate-limited Google endpoint cools down, then tries again with a longer wait', async () => {
  const cues = [0, 1, 2, 3, 4, 5].map((i) => ({ start: i * 1000, dur: 1000, text: `Satz ${i}.` }));
  const player = await mountContent({ cues, aligned: true });
  player.at(0.1);
  const burst = player.requests.length;
  assert.equal(burst, 4, 'the active sentence plus a three-sentence window');

  player.respond(0, { ok: false, error: 'translate http 429' });
  assert.equal(player.status().cooldownSec, 20);

  player.at(1.1);
  assert.equal(player.requests.length, burst, 'inside the cooldown nothing is sent');

  player.advance(21000);
  player.at(2.1);
  assert.equal(player.requests.length, burst + 1, 'after the cooldown it tries again');
  const after = player.requests.length;

  player.respond(burst, { ok: false, error: 'translate http 429' });
  assert.equal(player.status().cooldownSec, 60, 'the wait backs off on the second limit');
  assert.equal(player.requests.length, after);

  // a longer wait, then a successful reply clears the ladder for the rest of the video
  player.advance(61000);
  player.at(3.1);
  assert.ok(player.requests.length > after, 'the longer wait also expires');
  player.respond(after, { ok: true, translated: '好。' });
  assert.equal(player.status().cooldownSec, 0);
});

test('returning to a video repaints from memory before the page refetches it', async () => {
  const cues = [
    { start: 0, dur: 1000, text: 'Hallo.', trans: '你好。' },
    { start: 1000, dur: 1000, text: 'Tschüss.', trans: '再见。' }
  ];
  const player = await mountContent({ cues, aligned: true, videoId: 'aaa' });
  assert.deepEqual(player.at(0.1), { original: 'Hallo.', translation: '你好。' });
  assert.equal(player.status().cached, false);

  player.navigate('bbb');
  player.sendCues({
    videoId: 'bbb', aligned: true,
    cues: [{ start: 0, dur: 1000, text: 'Neu.', trans: '新。' }]
  });
  assert.equal(player.at(0.1).original, 'Neu.');

  player.navigate('aaa');
  assert.deepEqual(player.read(), { original: 'Hallo.', translation: '你好。' });
  assert.equal(player.status().cached, true, 'the repaint came from memory');
});

test('a cached video whose target language changed keeps the original but drops the stale translation', async () => {
  const cues = [{ start: 0, dur: 1000, text: 'Hallo.', trans: '你好。' }];
  const player = await mountContent({ cues, aligned: true, videoId: 'aaa' });
  assert.equal(player.at(0.1).translation, '你好。');

  player.changeLanguage('de');
  player.navigate('bbb');
  player.navigate('aaa');

  assert.deepEqual(player.read(), { original: 'Hallo.', translation: '' });
  assert.equal(player.status().pending, true, 'the new language is still on its way');
});

test('while YouTube translation is pending, only fast display warms Google ahead', async () => {
  const cues = [0, 1, 2, 3, 4].map((i) => ({ start: i * 1000, dur: 1000, text: `Satz ${i}.` }));

  const patient = await mountContent({
    cues, aligned: null, translationPending: true, backend: 'tlang'
  });
  patient.at(0.1);
  assert.equal(patient.requests.length, 0, 'the whole-track mode waits instead of guessing');

  const fast = await mountContent({
    cues, aligned: null, translationPending: true, backend: 'fast'
  });
  assert.equal(fast.requests.length, 1, 'only the sentence on screen');

  fast.advance(3500);
  fast.at(1.1);
  assert.equal(fast.requests.length, 4, 'one for the new sentence plus a two-ahead window');
});

test('the status snapshot describes what the page is doing', async () => {
  const cues = [{ start: 0, dur: 1000, text: 'Hallo.', trans: '你好。' }];
  const player = await mountContent({ cues, aligned: true });
  player.at(0.1);

  const snapshot = player.status();
  // spread out of the vm realm so deepEqual compares values, not prototypes
  assert.deepEqual({ ...snapshot }, {
    ok: true, version: MANIFEST_VERSION, videoId: 'sample', enabled: true,
    backend: 'tlang', targetLang: 'zh-CN', sourceLang: 'de',
    mode: 'cues', source: 'youtube', transSource: 'youtube', cueCount: 1,
    pending: false, cached: false, cooldownSec: 0
  });

  const off = await mountContent({ cues, aligned: true, settings: { enabled: false } });
  assert.equal(off.status().enabled, false);
  assert.equal(off.status().mode, 'off');
  assert.equal(off.status().source, 'none');
});
