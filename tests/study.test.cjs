// Study mode: the karaoke word box, the sentence repeat engine (with its slowed
// playback), and the translation reveal modes. Every case runs the real
// content.js through tests/harness.cjs — no production logic is re-implemented.
const test = require('node:test');
const assert = require('node:assert/strict');

const { mountContent } = require('./harness.cjs');

test('unspaced Japanese and Thai fragments join without inserted spaces', async () => {
  const japanese = await mountContent({ sourceLang: 'ja', cues: [
    { start: 0, dur: 500, text: 'こんに' },
    { start: 500, dur: 500, text: 'ちは。' }
  ], aligned: true });
  japanese.at(0.6);
  assert.equal(japanese.read().original, 'こんにちは。');

  const thai = await mountContent({ sourceLang: 'th', cues: [
    { start: 0, dur: 500, text: 'สวัส' },
    { start: 500, dur: 500, text: 'ดีครับ' }
  ], aligned: true });
  thai.at(0.6);
  assert.equal(thai.read().original, 'สวัสดีครับ');
});

test('Arabic captions retain word spaces and their source-language status', async () => {
  const player = await mountContent({ sourceLang: 'ar', cues: [
    { start: 0, dur: 500, text: 'مرحبا' },
    { start: 500, dur: 500, text: 'بك.' }
  ], aligned: true });
  player.at(0.6);
  assert.equal(player.read().original, 'مرحبا بك.');
  assert.equal(player.status().sourceLang, 'ar');
});

test('Arabic and Hindi sentence punctuation separates spoken lines', async () => {
  const arabic = await mountContent({ sourceLang: 'ar', cues: [
    { start: 0, dur: 500, text: 'كيف حالك؟' },
    { start: 500, dur: 500, text: 'أنا بخير.' }
  ], aligned: true });
  arabic.at(0.2);
  assert.equal(arabic.read().original, 'كيف حالك؟');
  arabic.at(0.7);
  assert.equal(arabic.read().original, 'أنا بخير.');

  const hindi = await mountContent({ sourceLang: 'hi', cues: [
    { start: 0, dur: 500, text: 'नमस्ते।' },
    { start: 500, dur: 500, text: 'आप कैसे हैं?' }
  ], aligned: true });
  hindi.at(0.7);
  assert.equal(hindi.read().original, 'आप कैसे हैं?');
});

const TWO = [
  { start: 0, dur: 1000, text: 'Erste.' },
  { start: 1000, dur: 1000, text: 'Zweite.' }
];

// One sentence that carries per-word times, the way an auto-generated (ASR)
// track does. Manual captions have no word times, so karaoke stays off there.
const WORDS = [{
  start: 0, dur: 3000, text: 'Hallo schöne Welt',
  words: [{ t: 0, u: 'Hallo' }, { t: 900, u: ' schöne' }, { t: 1800, u: ' Welt' }]
}];

// A word-timed track delivers ONE WORD per event, with pauses between words.
const WORD_LEVEL = [
  { start: 0, dur: 1000, text: 'Hallo', words: [{ t: 0, u: 'Hallo' }] },
  { start: 3000, dur: 1000, text: 'Welt', words: [{ t: 3000, u: 'Welt' }] }
];

test('the sentence is shown whole and only the spoken word is boxed', async () => {
  const player = await mountContent({ cues: WORDS, aligned: true });
  player.at(0.1);

  const shown = player.read();
  assert.equal(shown.original, 'Hallo schöne Welt', 'the whole sentence, not one word');

  const spans = player.wordSpans();
  assert.equal(spans.length, 3, 'one span per word');
  assert.deepEqual(spans.map((s) => s.textContent), ['Hallo', ' schöne', ' Welt']);
  spans.forEach((s) => assert.ok(s.hasClass('ytds-w'), 'every word keeps the plain look'));
  assert.equal(player.activeWordIdx(), 0);

  player.at(1.0);
  assert.equal(player.activeWordIdx(), 1, 'the box follows the voice');

  player.at(2.0);
  assert.equal(player.activeWordIdx(), 2);
  assert.equal(player.read().original, 'Hallo schöne Welt', 'still the whole sentence');
});

test('karaoke can be switched off and on again from the popup', async () => {
  const player = await mountContent({ cues: WORDS, aligned: true, settings: { karaoke: false } });
  player.at(0.1);

  assert.equal(player.wordSpans().length, 0, 'plain text, no word spans');
  assert.equal(player.read().original, 'Hallo schöne Welt');

  player.changeSettings({ karaoke: true });
  assert.equal(player.wordSpans().length, 3, 'turning it on repaints the sentence');
  assert.equal(player.activeWordIdx(), 0);
});

test('a word-timed track is merged into whole sentences', async () => {
  const player = await mountContent({ cues: WORD_LEVEL, aligned: true });
  player.at(0.1);

  assert.equal(player.status().cueCount, 1, 'the pause between words is not a break');
  assert.equal(player.read().original, 'Hallo Welt');
  assert.equal(player.activeWordIdx(), 0);

  player.at(3.2);
  assert.equal(player.activeWordIdx(), 1, 'the second word lights up when spoken');
});

test('without word times a long pause still splits the sentence', async () => {
  const plain = [
    { start: 0, dur: 1000, text: 'Hallo' },
    { start: 3000, dur: 1000, text: 'Welt' }
  ];
  const player = await mountContent({ cues: plain, aligned: true });
  player.at(0.1);
  assert.equal(player.status().cueCount, 2, 'a manual track keeps its own timing');
});

test('repeat plays the sentence again and then restores the rate', async () => {
  const player = await mountContent({
    cues: TWO, aligned: true, settings: { repeatCount: 2, studyRate: 0.5 }
  });
  player.at(0.1);
  assert.equal(player.video.playbackRate, 0.5, 'the sentence is slowed down');

  player.at(1.5);                        // past the end of "Erste."
  assert.equal(player.video.currentTime, 0, 'rewound to the start of the sentence');
  assert.equal(player.video.playbackRate, 0.5);

  player.at(1.5);                        // second turn used up
  assert.equal(player.video.playbackRate, 1, "the user's own rate comes back");
  assert.equal(player.video.currentTime, 1.5, 'playback is not rewound any more');
});

test('repeat stays out of the way when it is off', async () => {
  const player = await mountContent({ cues: TWO, aligned: true });
  player.at(0.1);
  player.at(1.5);
  assert.equal(player.video.playbackRate, 1, 'untouched');
  assert.equal(player.video.currentTime, 1.5);
});

test('the shortcut repeats the sentence on screen, even with the setting off', async () => {
  // Nothing to repeat while the extension is off (no cue list at all).
  const idle = await mountContent({ cues: TWO, aligned: true, settings: { enabled: false } });
  assert.deepEqual({ ...idle.request({ type: 'repeatSentence' }) },
    { ok: false, reason: 'nocue' });

  const player = await mountContent({ cues: TWO, aligned: true });
  player.at(0.1);
  assert.deepEqual({ ...player.request({ type: 'repeatSentence' }) },
    { ok: true, repeating: true, count: 2 });
  assert.equal(player.video.playbackRate, 0.75, 'the default study rate is used');
  assert.equal(player.video.currentTime, 0, 'the sentence restarts');

  player.at(1.5);                        // first turn done, one left
  assert.equal(player.video.currentTime, 0);
  player.at(1.5);                        // done: rate restored
  assert.equal(player.video.playbackRate, 1);

  player.at(1.5);
  assert.deepEqual({ ...player.request({ type: 'repeatSentence' }) },
    { ok: true, repeating: true, count: 2 });
  assert.deepEqual({ ...player.request({ type: 'repeatSentence' }) },
    { ok: true, repeating: false }, 'pressing it again stops');
  assert.equal(player.video.playbackRate, 1);
});

test('turning the repeat off in the popup restores the rate immediately', async () => {
  const player = await mountContent({
    cues: TWO, aligned: true, settings: { repeatCount: 3, studyRate: 0.5 }
  });
  player.at(0.1);
  assert.equal(player.video.playbackRate, 0.5);

  player.changeSettings({ repeatCount: 0 });
  assert.equal(player.video.playbackRate, 1);
});

test('the manual reveal mode hides the translation until the key is pressed', async () => {
  const player = await mountContent({ cues: TWO, aligned: true, settings: { revealMode: 'manual' } });
  player.at(0.1);
  assert.ok(player.overlayEl().classList.contains('ytds-reveal-hidden'));

  assert.deepEqual({ ...player.request({ type: 'revealTranslation' }) },
    { ok: true, revealed: true });
  assert.ok(!player.overlayEl().classList.contains('ytds-reveal-hidden'));

  player.at(1.5);                        // a new sentence hides it again
  assert.ok(player.overlayEl().classList.contains('ytds-reveal-hidden'));
});

test('the hover mode reveals on hover and ignores the key', async () => {
  const player = await mountContent({ cues: TWO, aligned: true, settings: { revealMode: 'hover' } });
  player.at(0.1);

  const overlay = player.overlayEl();
  assert.ok(overlay.classList.contains('ytds-reveal-hover'));
  assert.ok(!overlay.classList.contains('ytds-reveal-hidden'));
  assert.deepEqual({ ...player.request({ type: 'revealTranslation' }) },
    { ok: false, reason: 'mode' });
});

test('the default mode keeps the translation on screen', async () => {
  const player = await mountContent({ cues: TWO, aligned: true });
  player.at(0.1);

  const overlay = player.overlayEl();
  assert.ok(!overlay.classList.contains('ytds-reveal-hover'));
  assert.ok(!overlay.classList.contains('ytds-reveal-hidden'));
});

// ---- the popup's per-video buttons (same handlers as the shortcuts) -------
// Deliberately long cues: `previous` only jumps to the earlier sentence once the
// current one has been playing longer than PREV_RESTART_MS (1000 ms).
const STEP = [
  { start: 0, dur: 2000, text: 'Erste Zeile.' },
  { start: 2000, dur: 4000, text: 'Zweite Zeile.' }
];

test('next sentence jumps to the start of the following sentence', async () => {
  const player = await mountContent({ cues: STEP, aligned: true });
  player.at(0.1);
  assert.equal(player.read().original, 'Erste Zeile.');

  assert.deepEqual({ ...player.request({ type: 'stepSentence', delta: 1 }) },
    { ok: true, index: 1, count: 2 });
  assert.equal(player.video.currentTime, 2, 'seeked to the second sentence');
  assert.equal(player.read().original, 'Zweite Zeile.');
});

test('previous sentence restarts the current one once it is under way', async () => {
  const player = await mountContent({ cues: STEP, aligned: true });
  player.at(4.5);                                  // 2500 ms into sentence 2
  assert.equal(player.read().original, 'Zweite Zeile.');

  assert.deepEqual({ ...player.request({ type: 'stepSentence', delta: -1 }) },
    { ok: true, index: 1, count: 2 });
  assert.equal(player.video.currentTime, 2, 'back to the start of the same sentence');
});

test('previous sentence goes one back when the current one just started', async () => {
  const player = await mountContent({ cues: STEP, aligned: true });
  player.at(2.5);                                  // only 500 ms into sentence 2

  assert.deepEqual({ ...player.request({ type: 'stepSentence', delta: -1 }) },
    { ok: true, index: 0, count: 2 });
  assert.equal(player.video.currentTime, 0);
  assert.equal(player.read().original, 'Erste Zeile.');
});

test('sentence stepping answers "nocue" when no subtitles are loaded', async () => {
  const player = await mountContent({ cues: STEP, aligned: true, settings: { enabled: false } });

  assert.deepEqual({ ...player.request({ type: 'stepSentence', delta: 1 }) },
    { ok: false, reason: 'nocue' });
});

test('study list searches grouped sentences and jumps to the selected one', async () => {
  const player = await mountContent({ cues: TWO, aligned: true, sourceLang: 'de' });
  const list = player.request({ type: 'studyCues', query: 'zweite', offset: 0, limit: 40 });
  assert.equal(list.ok, true);
  assert.equal(list.sourceLang, 'de');
  assert.equal(list.total, 1);
  assert.equal(list.entries[0].index, 1);
  assert.equal(list.entries[0].text, 'Zweite.');
  assert.equal(player.request({ type: 'studySeek', videoId: 'other', index: 1 }).ok, false);
  assert.equal(player.request({ type: 'studySeek', videoId: 'sample',
    index: 1, expectedStart: 9000 }).reason, 'changed');
  assert.equal(player.request({ type: 'studySeek', videoId: 'sample', index: 1 }).ok, true);
  assert.equal(player.video.currentTime, 1);
  assert.equal(player.request({ type: 'studyCurrent' }).cue.text, 'Zweite.');
  assert.equal(player.status().sourceLang, 'de');
});

test('bilingual export refuses an incomplete translated track', async () => {
  const player = await mountContent({ cues: [
    { start: 0, dur: 1000, text: 'Erste.', trans: '第一句。' },
    { start: 1000, dur: 1000, text: 'Zweite.', trans: '' }
  ], aligned: true });
  const result = await player.exportVariant('bi');
  assert.deepEqual({ ...result }, { ok: false, reason: 'partial', missing: 1 });
});

test('export cannot reuse one translated cue for two spoken lines', async () => {
  const cues = [
    { start: 0, dur: 1000, text: 'Hallo.' },
    { start: 500, dur: 1000, text: 'Guten Morgen.' }
  ];
  const player = await mountContent({ cues, aligned: false, tcues: [] });
  const pending = player.exportVariant('bi');
  const request = player.outbound.find((message) => message.type === 'export-request');
  assert.ok(request);
  player.sendInject({
    type: 'exportdata', exportId: request.exportId, ok: true,
    aligned: false, cues, tcues: [{ start: 0, dur: 1000, text: '你好。' }]
  });
  const result = await pending;
  assert.deepEqual({ ...result }, { ok: false, reason: 'partial', missing: 1 });
});

// ---- pointer reveal (the fullscreen fix) ----------------------------------
test('hover mode reveals while the pointer is on the player and hides again', async () => {
  const player = await mountContent({ cues: TWO, aligned: true, settings: { revealMode: 'hover' } });
  player.at(0.1);

  const overlay = player.overlayEl();
  assert.ok(!overlay.classList.contains('ytds-pointer-on'));

  player.movePointer(640, 360);                     // over the player
  assert.ok(overlay.classList.contains('ytds-pointer-on'), 'revealed on pointer move');

  player.runTimeouts();                             // HOVER_HOLD_MS elapses
  assert.ok(!overlay.classList.contains('ytds-pointer-on'), 'hidden again after the hold');
});

test('a pointer move outside the player does not reveal', async () => {
  const player = await mountContent({ cues: TWO, aligned: true, settings: { revealMode: 'hover' } });
  player.at(0.1);

  player.movePointer(640, 360);
  assert.ok(player.overlayEl().classList.contains('ytds-pointer-on'));
  player.movePointer(2000, 900);                    // outside the fake player rect
  assert.ok(!player.overlayEl().classList.contains('ytds-pointer-on'));
});

test('leaving the browser window hides hover translation immediately', async () => {
  const player = await mountContent({ cues: TWO, aligned: true, settings: { revealMode: 'hover' } });
  player.movePointer(640, 360);
  assert.ok(player.overlayEl().classList.contains('ytds-pointer-on'));
  player.fire('pointerout', { relatedTarget: null });
  assert.ok(!player.overlayEl().classList.contains('ytds-pointer-on'));
});

test('the pointer listener stays inert in the other reveal modes', async () => {
  const player = await mountContent({ cues: TWO, aligned: true });   // revealMode: "always"
  player.at(0.1);

  player.movePointer(640, 360);
  assert.ok(!player.overlayEl().classList.contains('ytds-pointer-on'));
});
