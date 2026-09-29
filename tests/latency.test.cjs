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

test('default translation fallback starts within 0.4 seconds of a pending track', async () => {
  const p = await mountContent({ cues: originals, aligned: null, translationPending: true });
  p.advance(400).tick();
  assert.ok(p.requests.some(r => r.message.text === 'Erste.'));
  assert.ok(p.requests.some(r => r.message.text === 'Zweite.'));
});

test('pausing to wait does not stop loading the pending current translation', async () => {
  const p = await mountContent({ cues: originals, aligned: null, translationPending: true });
  p.setPaused(true);
  p.advance(400).tick();
  assert.ok(p.requests.some(r => r.message.text === 'Erste.'));
  p.respond(0, { ok: true, translated: '第一句。' });
  assert.equal(p.read().translation, '第一句。');
});

test('incremental native captions share one request and retain a useful translated prefix', async () => {
  const p = await mountContent({ skipCues: true, initialNativeCaption: 'Wir machen' });
  p.runTimeouts();
  assert.equal(p.requests.length, 1);
  p.native('Wir machen einen').tick(); p.runTimeouts();
  p.native('Wir machen einen Spaziergang.').tick(); p.runTimeouts();
  assert.equal(p.requests.length, 1, 'word additions queue the latest text instead of flooding Google');
  p.respond(0, { ok: true, translated: '我们进行' });
  assert.equal(p.read().translation, '我们进行 …');
  p.runTimeouts();
  assert.equal(p.requests.length, 2);
  assert.equal(p.requests[1].message.text, 'Wir machen einen Spaziergang.');
  p.respond(1, { ok: true, translated: '我们去散步。' });
  assert.equal(p.read().translation, '我们去散步。');
});

test('fallback retries a failed stable caption but respects the rate-limit cooldown', async () => {
  const p = await mountContent({ skipCues: true, initialNativeCaption: 'Hallo.' });
  p.runTimeouts();
  p.respond(0, { ok: false, error: 'network failure' });
  p.advance(1100).tick(); p.runTimeouts();
  assert.equal(p.requests.length, 2, 'unchanged native text may recover from a network failure');
  p.respond(1, { ok: false, error: 'translate http 429' });
  p.advance(1000).tick(); p.runTimeouts();
  assert.equal(p.requests.length, 2);
  p.advance(20000).tick(); p.runTimeouts();
  assert.equal(p.requests.length, 3);
});

test('a rate limit still cools down after the native caption changes sentences', async () => {
  const p = await mountContent({ skipCues: true, initialNativeCaption: 'Hallo.' });
  p.runTimeouts();
  p.native('Eine andere Aussage.').tick();
  p.respond(0, { ok: false, error: 'translate http 429' });
  p.advance(1000).tick(); p.runTimeouts();
  assert.equal(p.requests.length, 1, 'a sentence change must not bypass the endpoint cooldown');
  p.advance(20000).tick(); p.runTimeouts();
  assert.equal(p.requests.length, 2);
  assert.equal(p.requests[1].message.text, 'Eine andere Aussage.');
});

test('an incremental fallback reply is still discarded after an unrelated sentence or seek', async () => {
  const p = await mountContent({ skipCues: true, initialNativeCaption: 'Wir machen' });
  p.runTimeouts();
  p.native('Ganz andere Wörter.').tick(); p.runTimeouts();
  assert.equal(p.requests.length, 1, 'unrelated word changes also keep network requests bounded');
  p.respond(0, { ok: true, translated: '错误的旧译文。' });
  assert.equal(p.read().translation, '');
  p.runTimeouts();
  p.fire('seeking');
  p.respond(1, { ok: true, translated: '跳转前的旧译文。' });
  assert.equal(p.read().translation, '');
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
