const test = require('node:test');
const assert = require('node:assert/strict');
const { mountContent } = require('./harness.cjs');

const originals = [
  { start: 0, dur: 1000, text: 'Erste.' },
  { start: 1000, dur: 1000, text: 'Zweite.' }
];

test('native original is visible at boot while the track request has not answered', async () => {
  const p = await mountContent({ skipCues: true, initialNativeCaption: 'Schon sichtbar.' });
  assert.equal(p.read().original, 'Schon sichtbar.');
  assert.equal(p.status().mode, 'scrape');
  p.native('Nächste.').tick();
  assert.equal(p.read().original, 'Nächste.');
  p.sendCues({ cues: [{ start: 0, dur: 2000, text: 'Echte Spur.', trans: '完整字幕。' }], aligned: true });
  assert.deepEqual(p.read(), { original: 'Echte Spur.', translation: '完整字幕。' });
});

test('a slow whole-track translation warms the current and upcoming sentences', async () => {
  const p = await mountContent({ cues: originals, aligned: null, translationPending: true });
  assert.equal(p.requests.length, 0, 'give the direct track a short head start');
  p.advance(1600).tick();
  assert.ok(p.requests.some(r => r.message.text === 'Erste.'));
  assert.ok(p.requests.some(r => r.message.text === 'Zweite.'));
  p.respond(0, { ok: true, translated: '第一句。' });
  assert.equal(p.read().translation, '第一句。');
});

test('a track translation arriving between clock ticks paints both lines at the current time', async () => {
  const p = await mountContent({ cues: originals, aligned: null, translationPending: true });
  p.video.currentTime = 1.2; // playback moved, the periodic tick has not run
  p.updateTranslation(originals.map((c, i) => ({ ...c, trans: ['第一句。', '第二句。'][i] })), null, true);
  assert.deepEqual(p.read(), { original: 'Zweite.', translation: '第二句。' });
  p.tick();
  assert.equal(p.read().original, 'Zweite.', 'the next tick must not lock in a mismatched original');
  p.video.currentTime = 3;
  p.updateTranslation(originals.map(c => ({ ...c, trans: '译文。' })), null, true);
  assert.deepEqual(p.read(), { original: '', translation: '' }, 'a gap clears both lines');
});

test('a late sentence translation never paints after playback has moved to another sentence', async () => {
  const p = await mountContent({ cues: originals, backend: 'gtx', aligned: null });
  p.video.currentTime = 1.2;
  p.respond(0, { ok: true, translated: '过期的第一句。' });
  assert.deepEqual(p.read(), { original: 'Zweite.', translation: '' });
  p.respond(1, { ok: true, translated: '第二句。' });
  assert.equal(p.read().translation, '第二句。');
});

test('native captions are not suppressed while the overlay has no usable text or a dead context', async () => {
  const p = await mountContent({ skipCues: true });
  assert.equal(p.rootEl.hasClass('ytds-rendering'), false);
  p.native('Hallo.').tick();
  assert.equal(p.rootEl.hasClass('ytds-rendering'), true);
  p.killContext().tick();
  assert.equal(p.rootEl.hasClass('ytds-rendering'), false);
});

test('playback resumes and seeks repaint immediately rather than waiting for a timer', async () => {
  const p = await mountContent({ cues: originals, aligned: true });
  p.setPaused(true);
  p.video.currentTime = 1.2;
  p.setPaused(false).fire('playing');
  assert.equal(p.read().original, 'Zweite.');
  p.video.currentTime = 0.1;
  p.fire('seeking');
  assert.equal(p.read().original, 'Erste.');
});

test('sound-only native captions stay filtered and do not leak through an empty overlay', async () => {
  const p = await mountContent({ skipCues: true });
  p.native('[Musik]').tick();
  assert.deepEqual(p.read(), { original: '', translation: '' });
  assert.equal(p.rootEl.hasClass('ytds-rendering'), true);
});

test('SPA startup does not redisplay the preceding videos static native caption', async () => {
  const p = await mountContent({ skipCues: true, initialNativeCaption: 'Vorher.' });
  assert.equal(p.read().original, 'Vorher.');
  p.navigate('next');
  assert.deepEqual(p.read(), { original: '', translation: '' });
  p.native('Danach.').tick();
  assert.equal(p.read().original, 'Danach.');
});
