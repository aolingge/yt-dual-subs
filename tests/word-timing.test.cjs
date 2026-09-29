const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const timing = require('../word-timing.js');
const { mountContent } = require('./harness.cjs');

const timed = (text, times, language = 'de') => {
  const words = timing.tokens(text, language).map((p, i) => ({ t: times[i], u: p.text }));
  return { start: 0, dur: 4000, text, words };
};

test('word-time rendering preserves punctuation, spacing and text across languages', () => {
  for (const [language, text] of [
    ['de', '„Wir gehen“, sagt sie.'], ['es', '¡Hola, mundo!'],
    ['ja', '今日は公園を歩きます。'], ['zh-CN', '我们今天一起去公园。'],
    ['ar', 'مرحبًا بكم في البيت.'], ['hi', 'हम आज घर जाते हैं।'],
    ['th', 'วันนี้เราไปสวนสาธารณะ']
  ]) {
    const parts = timing.tokens(text, language);
    const cue = timed(text, parts.map((_p, i) => i * 100), language);
    const pieces = timing.captionPieces(cue, language);
    assert.ok(pieces, language);
    assert.equal(pieces.map((p) => p.u).join(''), text, language);
    const estimated = timing.estimate(cue, language);
    assert.equal(estimated.map((p) => p.u).join(''), text, language);
    assert.ok(estimated.every((p, i) => p.t >= 0 && p.t < 4000 &&
      (!i || p.t > estimated[i - 1].t)), language);
  }
});

test('phrase offsets, missing words and invalid clocks do not count as individual word times', () => {
  const base = { start: 0, dur: 3000, text: 'Hallo schöne Welt.' };
  for (const words of [
    [{ t: 0, u: base.text }],
    [{ t: 0, u: 'Hallo' }, { t: 1000, u: 'Welt' }],
    [{ t: 0, u: 'Hallo' }, { t: NaN, u: 'schöne' }, { t: 2000, u: 'Welt' }],
    [{ t: 1000, u: 'Hallo' }, { t: 500, u: 'schöne' }, { t: 2000, u: 'Welt' }],
    [{ t: 0, u: 'Hallo' }, { t: 1000, u: 'schöne' }, { t: 3000, u: 'Welt' }]
  ]) assert.equal(timing.captionPieces({ ...base, words }, 'de'), null);
  assert.equal(timing.estimate({ ...base, dur: 0 }, 'de'), null);
  assert.equal(timing.estimate({ ...base, text: '!' }, 'de'), null);
});

test('a unique nearby automatic match transfers times while retaining the selected original text', () => {
  const cues = [{ start: 0, dur: 4000, text: '„Hallo, schöne Welt!“' }];
  const donor = [timed('hallo schöne welt', [100, 1100, 2200])];
  assert.equal(timing.align(cues, donor, 'de'), 1);
  assert.equal(cues[0].wordTimingSource, 'automatic');
  assert.deepEqual(cues[0].words.map((w) => w.t), [100, 1100, 2200]);
  assert.equal(cues[0].words.map((w) => w.u).join(''), '„Hallo, schöne Welt!“');
});

test('ambiguous repetitions, changed words, distant words and phrase-level donors are rejected', () => {
  for (const donor of [
    [timed('Hallo Welt Hallo Welt', [0, 500, 2000, 2500])],
    [timed('Hallo andere Welt', [0, 500, 1000])],
    [timed('Hallo Welt', [10000, 11000])],
    [{ start: 0, dur: 3000, text: 'Hallo Welt', words: [{ t: 0, u: 'Hallo Welt' }] }]
  ]) {
    const cues = [{ start: 0, dur: 3000, text: 'Hallo Welt' }];
    assert.equal(timing.align(cues, donor, 'de'), 0);
    assert.equal(cues[0].words, undefined);
  }
  const cues = [timed('Hallo Welt', [0, 800])];
  assert.equal(timing.align(cues, [timed('Hallo Welt', [100, 900])], 'de'), 0);
  assert.deepEqual(cues[0].words.map((w) => w.t), [0, 800], 'native times take priority');
});

test('a sentence with one different word keeps the times of the words that matched', () => {
  const text = 'Wir treffen uns morgen um zehn Uhr';
  const cues = [{ start: 0, dur: 5000, text }];
  const donor = [timed('wir treffen uns heute um zehn uhr', [0, 400, 800, 1300, 2000, 2400, 2800])];
  assert.equal(timing.align(cues, donor, 'de'), 1);
  assert.equal(cues[0].wordTimingSource, 'automatic-partial',
    'a sentence mixing matched and estimated words is never reported as a caption match');
  const times = cues[0].words.map((w) => w.t);
  assert.deepEqual([times[0], times[1], times[2], times[4], times[5], times[6]],
    [0, 400, 800, 2000, 2400, 2800], 'matched words keep their own times');
  assert.ok(times[3] > times[2] && times[3] < times[4], 'the missing word is filled between its neighbours');
  assert.deepEqual(cues[0].words.map((w) => w.s),
    ['caption', 'caption', 'caption', 'estimated', 'caption', 'caption', 'caption']);
  assert.equal(cues[0].words.map((w) => w.u).join(''), text);
});

test('leading and trailing words are filled inside their own caption', () => {
  const cues = [{ start: 2000, dur: 3000, text: 'Also wir treffen uns heute' }];
  assert.equal(timing.align(cues, [timed('treffen uns', [3000, 3400])], 'de'), 1);
  const times = cues[0].words.map((w) => w.t);
  assert.deepEqual(times.slice(2, 4), [3000, 3400], 'the matched pair keeps the donor times');
  assert.deepEqual(cues[0].words.map((w) => w.s),
    ['estimated', 'estimated', 'caption', 'caption', 'estimated']);
  assert.ok(times[0] >= 2000 && times[1] > times[0] && times[1] < times[2]);
  assert.ok(times[4] > times[3] && times[4] < 5000, 'the trailing word stays inside the caption');
});

test('a repeated phrase is left to estimation instead of being fixed to one repetition', () => {
  const cues = [{ start: 0, dur: 4000, text: 'Hallo Welt und guten Tag' }];
  const donor = [timed('hallo welt und hallo welt guten tag', [0, 500, 900, 2000, 2500, 3000, 3500])];
  assert.equal(timing.align(cues, donor, 'de'), 1);
  assert.deepEqual(cues[0].words.map((w) => w.s),
    ['estimated', 'estimated', 'estimated', 'caption', 'caption'],
    'the ambiguous phrase is not anchored to either repetition');
  assert.deepEqual(cues[0].words.slice(3).map((w) => w.t), [3000, 3500], 'the unambiguous tail is still used');
});

test('numbers and abbreviations match across caption and automatic spellings', () => {
  const cases = [
    ['Das kostet 1.000 Euro', 'das kostet 1000 euro'],
    ['etwa 1,5 Stunden', 'etwa 1.5 stunden'],
    ['Komm z. B. um 19:30 Uhr', 'komm z.b. um 19:30 uhr']
  ];
  for (const [text, donorText] of cases) {
    const cues = [{ start: 0, dur: 4000, text }];
    const donor = [timed(donorText, [100, 500, 900, 1300, 1700, 2100, 2500])];
    assert.equal(timing.align(cues, donor, 'de'), 1, `${text} should match ${donorText}`);
    assert.equal(cues[0].wordTimingSource, 'automatic');
    assert.equal(cues[0].words.map((w) => w.u).join(''), text, 'the displayed text is unchanged');
  }
});

test('an anchor found outside the caption is never carried in', () => {
  const late = [{ start: 3500, dur: 2000, text: 'Wir treffen uns morgen' }];
  assert.equal(timing.align(late, [timed('wir treffen uns morgen', [3300, 3400, 3500, 3600])], 'de'), 0);
  assert.equal(late[0].words, undefined, 'words starting before the caption are not moved into it');
  const far = [{ start: 0, dur: 4000, text: 'Wir treffen uns morgen' }];
  assert.equal(timing.align(far, [timed('wir treffen uns morgen', [8000, 8100, 8200, 8300])], 'de'), 0);
  assert.equal(far[0].words, undefined, 'a donor outside the searched window is not used');
});

test('matching respects language-specific casing without removing meaningful accents', () => {
  const cues = [{ start: 0, dur: 4000, text: 'IŞIK güzel.' }];
  assert.equal(timing.align(cues, [timed('ışık güzel', [0, 1000], 'tr')], 'tr'), 1);
  assert.equal(cues[0].words.map((w) => w.u).join(''), 'IŞIK güzel.');
  const different = [{ start: 0, dur: 4000, text: 'schöne Welt' }];
  assert.equal(timing.align(different, [timed('schone Welt', [0, 1000])], 'de'), 0);
});

test('approximate progress follows the video clock, including pause, seek and sync offset', async () => {
  const player = await mountContent({ cues: [{ start: 0, dur: 6000,
    text: 'Hallo schöne Welt.', trans: '你好，美丽的世界。' }] });
  player.at(.1);
  assert.equal(player.status().wordTiming, 'estimated');
  assert.ok(player.overlayEl().hasClass('ytds-karaoke-estimated'));
  assert.equal(player.activeWordIdx(), 0);
  const full = player.read();
  player.seekTo(5);
  assert.equal(player.activeWordIdx(), 2);
  assert.deepEqual(player.read(), full);
  player.video.paused = true;
  player.seekTo(.1);
  assert.equal(player.activeWordIdx(), 0);
  player.changeSettings({ offsetMs: 4900 });
  assert.equal(player.activeWordIdx(), 2);
  player.changeSettings({ karaokeApproximate: false });
  assert.equal(player.wordSpans().length, 0);
  assert.equal(player.status().wordTiming, 'unavailable');
  assert.deepEqual(player.read(), full);
  assert.equal(player.overlayEl().hasClass('ytds-karaoke-estimated'), false);
  player.changeSettings({ karaoke: false });
  assert.equal(player.status().wordTiming, 'off');
});

test('estimation spends time by syllables and digits instead of character length', () => {
  assert.equal(timing.syllables('Streichholzschächtelchen', 'de'), 5);
  assert.equal(timing.syllables('und', 'de'), 1);
  assert.equal(timing.syllables('Bahn', 'de'), 1);
  assert.equal(timing.syllables('1990', 'de'), 6);
  assert.equal(timing.syllables('make', 'en'), 1, 'a silent final e is not a syllable');
  assert.equal(timing.syllables('今日は', 'ja'), 3);
  const pieces = timing.estimate({ start: 0, dur: 9000,
    text: 'Wir treffen uns um 19:30 Uhr, danach gehen wir essen.' }, 'de');
  const span = (from, to) => {
    const times = pieces.map((p) => p.t);
    return times[to] - times[from];
  };
  const words = pieces.map((p) => p.u.trim());
  assert.ok(span(words.indexOf('19:'), words.indexOf('Uhr,')) >
    span(words.indexOf('uns'), words.indexOf('um')),
  'the spoken number holds more time than a short word');
});

test('estimation puts a real pause at punctuation but not inside an abbreviation', () => {
  const pieces = timing.estimate({ start: 0, dur: 6000,
    text: 'Wir treffen z. B. Anna, morgen.' }, 'de');
  const gapAfter = (word) => {
    const i = pieces.findIndex((p) => p.u.trim() === word);
    assert.ok(i >= 0 && i + 1 < pieces.length, word);
    return pieces[i + 1].t - pieces[i].t;
  };
  assert.ok(gapAfter('B.') < gapAfter('Anna,'), 'z. B. is not a sentence end');
  assert.ok(gapAfter('Anna,') > gapAfter('B.'));
  const stop = timing.estimate({ start: 0, dur: 6000, text: 'Ja. Nein.' }, 'de');
  assert.ok(stop[1].t - stop[0].t > timing.syllables('Ja', 'de') * 215,
    'a full stop adds pause time');
});

test('a cue holding trailing silence does not stretch the words across it', () => {
  const pieces = timing.estimate({ start: 0, dur: 10000, text: 'Guten Tag auch.' }, 'de');
  assert.ok(pieces.at(-1).t < 2500, 'the last word starts near its spoken time');
  const short = timing.estimate({ start: 0, dur: 400, text: 'Guten Tag auch.' }, 'de');
  assert.ok(short.every((p) => p.t >= 0 && p.t < 400), 'a short cue still fits');
  assert.ok(short[1].t < pieces[1].t, 'a short cue squeezes the words together');
});

test('a measured pace is taken from timed cues, clamped, and needs three samples', () => {
  const paced = (start, times) => ({ start, dur: 1200, text: 'Hallo schöne Welt.',
    words: [{ t: times[0], u: 'Hallo' }, { t: times[1], u: 'schöne' },
      { t: times[2], u: 'Welt' }] });
  assert.equal(timing.speakingRate([paced(0, [0, 400, 800])], 'de'), null);
  assert.equal(timing.speakingRate([paced(0, [0, 400, 800]), paced(2000, [2000, 2400, 2800])],
    'de'), null, 'two samples are not enough');
  assert.equal(Math.round(timing.speakingRate([
    paced(0, [0, 400, 800]), paced(2000, [2000, 2400, 2800]), paced(4000, [4000, 4400, 4800])],
  'de')), 200, 'each known 400ms word interval has two syllables; the last duration is unknown');
  assert.equal(timing.speakingRate([
    { start: 0, dur: 40000, text: 'Hallo schöne Welt.', words: [{ t: 0, u: 'Hallo' },
      { t: 10000, u: 'schöne' }, { t: 20000, u: 'Welt' }] },
    { start: 50000, dur: 40000, text: 'Hallo schöne Welt.', words: [{ t: 50000, u: 'Hallo' },
      { t: 60000, u: 'schöne' }, { t: 70000, u: 'Welt' }] },
    { start: 100000, dur: 40000, text: 'Hallo schöne Welt.', words: [{ t: 100000, u: 'Hallo' },
      { t: 110000, u: 'schöne' }, { t: 120000, u: 'Welt' }] }], 'de'), 500,
  'an implausible pace is clamped');
  const slow = timing.estimate({ start: 0, dur: 4000, text: 'Hallo schöne Welt.' }, 'de',
    { syllableMs: 300 });
  const fast = timing.estimate({ start: 0, dur: 4000, text: 'Hallo schöne Welt.' }, 'de',
    { syllableMs: 150 });
  assert.ok(slow[1].t > fast[1].t, 'the measured pace moves the word starts');
});

test('the video\'s own measured pace reshapes the estimate while it plays', async () => {
  const paced = (start) => ({ start, dur: 1500, text: 'Hallo schöne Welt.',
    words: [{ t: start, u: 'Hallo' }, { t: start + 600, u: 'schöne' },
      { t: start + 1200, u: 'Welt' }] });
  const untimed = { start: 0, dur: 4000, text: 'Hallo schöne Welt.' };
  const measured = await mountContent({ cues: [untimed,
    paced(100000), paced(102000), paced(104000)] });
  const plain = await mountContent({ cues: [{ ...untimed }] });
  measured.at(.7);
  plain.at(.7);
  assert.equal(measured.status().wordTiming, 'estimated');
  assert.equal(measured.activeWordIdx(), 0, 'the speaker\'s slow pace is used');
  assert.equal(plain.activeWordIdx(), 1, 'without samples the default pace applies');
});

test('all estimated words fit within a very short caption instead of piling up at its end', () => {
  const cue = { start: 2300, dur: 500,
    text: 'Wir lernen heute gemeinsam sehr ausführliche deutsche Wörter und schwierige grammatische Regeln.' };
  const pieces = timing.estimate(cue, 'de');
  assert.equal(pieces.map(p => p.u).join(''), cue.text);
  assert.ok(pieces.every(p => p.t >= cue.start && p.t < cue.start + cue.dur));
  assert.ok(pieces.every((p, i) => i === 0 || p.t > pieces[i - 1].t), 'every word has its own reachable start');
});

test('caption trailing silence and punctuation pauses cannot slow the measured word pace', () => {
  const cues = dur => [0, 6000, 12000].map(start => ({ start, dur, text: 'Hallo schöne Welt.',
    words: [{ t: start, u: 'Hallo' }, { t: start + 400, u: 'schöne' }, { t: start + 800, u: 'Welt' }] }));
  assert.equal(timing.speakingRate(cues(1200), 'de'), timing.speakingRate(cues(5000), 'de'));
  const paused = [0, 6000, 12000].map(start => ({ start, dur: 5000, text: 'Hallo, schöne große Welt.',
    words: [{ t: start, u: 'Hallo,' }, { t: start + 1400, u: 'schöne' },
      { t: start + 1800, u: 'große' }, { t: start + 2200, u: 'Welt.' }] }));
  assert.equal(timing.speakingRate(paused, 'de'), 200, 'punctuation includes a pause, not slower words');
});

test('late automatic times upgrade the current sentence without resetting reveal or translation', async () => {
  const original = { start: 0, dur: 4000, text: 'Hallo schöne Welt.', trans: '你好，美丽的世界。' };
  const player = await mountContent({ cues: [original], settings: { revealMode: 'manual' } });
  player.at(1.5);
  player.runtimeMessage({ type: 'revealTranslation' });
  assert.equal(player.overlayEl().hasClass('ytds-reveal-hidden'), false);
  const loopCount = player.cueLoopCount;
  const before = player.read();
  const cue = { ...timed(original.text, [0, 1000, 2500]),
    trans: original.trans, wordTimingSource: 'automatic' };
  player.sendCues({ cues: [cue], aligned: true, translationUpdate: true,
    wordTimingUpdate: true });
  assert.equal(player.status().wordTiming, 'automatic');
  assert.equal(player.activeWordIdx(), 1);
  assert.equal(player.cueLoopCount, loopCount);
  assert.equal(player.overlayEl().hasClass('ytds-karaoke-estimated'), false);
  assert.deepEqual(player.read(), before);
  assert.equal(player.overlayEl().hasClass('ytds-reveal-hidden'), false);
});

test('automatic timing updates preserve pending Google preview and reject an old config', async () => {
  const cue = { start: 0, dur: 4000, text: 'Hallo schöne Welt.' };
  const player = await mountContent({ cues: [cue], translationPending: true,
    aligned: null, backend: 'fast' });
  player.at(1.5);
  player.respond(0, { ok: true, translated: '快速译文。' });
  const nonce = player.outbound.at(-1).nonce;
  const upgrade = { ...timed(cue.text, [0, 1000, 2500]), wordTimingSource: 'automatic' };
  player.sendCues({ cues: [upgrade], aligned: null, translationPending: true,
    translationUpdate: true, wordTimingUpdate: true, nonce });
  assert.equal(player.read().translation, '快速译文。');
  assert.equal(player.status().pending, true);
  assert.equal(player.status().wordTiming, 'automatic');
  player.changeLanguage('fr');
  player.sendCues({ cues: [{ ...upgrade, text: 'Wrong stale caption.' }], aligned: true,
    translationUpdate: true, wordTimingUpdate: true, nonce });
  assert.equal(player.read().original, cue.text);
});

test('a partly matched sentence labels itself and marks only the estimated words', async () => {
  const cue = { start: 0, dur: 4000, text: 'Wir treffen uns morgen um zehn Uhr',
    trans: '我们明天十点见。', wordTimingSource: 'automatic-partial',
    words: [
      { t: 0, u: 'Wir ', s: 'caption' }, { t: 400, u: 'treffen ', s: 'caption' },
      { t: 800, u: 'uns ', s: 'caption' }, { t: 1300, u: 'morgen ', s: 'estimated' },
      { t: 2000, u: 'um ', s: 'caption' }, { t: 2400, u: 'zehn ', s: 'caption' },
      { t: 2800, u: 'Uhr', s: 'caption' }
    ] };
  const player = await mountContent({ cues: [cue] });
  player.at(2.5);
  assert.equal(player.status().wordTiming, 'automatic-partial');
  assert.equal(player.activeWordIdx(), 5, 'the highlight still follows the real times');
  const estimated = player.wordSpans().map((s) => s.classList.contains('ytds-w-est'));
  assert.deepEqual(estimated, [false, false, false, true, false, false, false],
    'only the estimated word is marked');
  assert.equal(player.originalEl().getAttribute('data-ytds-timing-label'), '部分匹配 + 估算');

  // "Approximate progress" off means reliable word times only, and this
  // sentence needs estimation for its gap words.
  const strict = await mountContent({ cues: [cue], settings: { karaokeApproximate: false } });
  strict.at(2.5);
  assert.equal(strict.status().wordTiming, 'unavailable');
  assert.equal(strict.activeWordIdx(), -1);
});

test('timing-source metadata survives cache restoration and estimation never changes SRT', async () => {
  const cue = { ...timed('Hallo schöne Welt.', [0, 1000, 2000]),
    trans: '你好。', wordTimingSource: 'automatic' };
  const player = await mountContent({ cues: [cue], videoId: 'first' });
  player.at(1.5);
  player.navigate('second');
  player.navigate('first');
  assert.equal(player.status().wordTiming, 'automatic');
  assert.equal(player.activeWordIdx(), 1);
  const estimated = await mountContent({ cues: [{ start: 1234, dur: 4567,
    text: 'Hallo schöne Welt.' }] });
  estimated.at(2);
  const srt = await estimated.exportOriginal();
  assert.ok(srt.ok);
  const content = await estimated.downloadedBlobs.at(-1).text();
  assert.match(content, /00:00:01,234 --> 00:00:05,801/);
  assert.match(content, /Hallo schöne Welt\./);
  assert.doesNotMatch(content, /Approximate|近似/);
});

// Boot the shipping bridge with a controllable track list and network. The
// helper loads in the same MAIN world/order as the actual manifest.
function bridge({ language = 'de', donorLanguage = 'de', useTlang = true,
  useWordTiming = true, donorVideo = 'sample', donorTranslated = false } = {}) {
  const listeners = {}, requests = [], posted = [];
  const location = { href: 'https://www.youtube.com/watch?v=sample' };
  const originalUrl = `https://www.youtube.com/api/timedtext?v=sample&lang=${language}&pot=source`;
  const donorUrl = `https://www.youtube.com/api/timedtext?v=${donorVideo}&lang=${donorLanguage}&kind=asr&pot=donor` +
    (donorTranslated ? '&tlang=de' : '');
  const player = { getOption(_module, key) {
    return key === 'tracklist' ? [{ baseUrl: originalUrl, languageCode: language, vssId: '.' + language },
      { baseUrl: donorUrl, languageCode: donorLanguage, kind: 'asr', vssId: 'a.' + donorLanguage }]
      : { languageCode: language, vssId: '.' + language };
  } };
  const fetch = (url) => new Promise((resolve) => requests.push({ url, resolve }));
  const window = { fetch,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { posted.push(structuredClone(message)); }
  };
  class XMLHttpRequest { open() {} send() {} }
  const context = vm.createContext({ window, fetch, XMLHttpRequest, URL, location,
    document: { getElementById: () => player },
    performance: { getEntriesByType: () => [] },
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {} });
  for (const name of ['word-timing.js', 'inject.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context);
  }
  const config = (nonce) => listeners.message({ source: window, data: {
    source: 'ytds-content', type: 'config', targetLang: 'zh-CN',
    useTlang, useWordTiming, nonce } });
  config(1);
  const respond = (request, events) => request.resolve({ ok: true,
    text: async () => JSON.stringify({ events }) });
  const disableTiming = () => listeners.message({ source: window, data: {
    source: 'ytds-content', type: 'word-timing-config', useWordTiming: false } });
  return { requests, posted, config, respond, location, disableTiming };
}
const flush = () => new Promise(setImmediate);
const event = (text, offsets) => ({ tStartMs: 0, dDurationMs: 4000,
  segs: offsets ? text.split(' ').map((word, i) => ({ utf8: (i ? ' ' : '') + word,
    ...(offsets[i] == null ? {} : { tOffsetMs: offsets[i] }) })) : [{ utf8: text }] });

test('automatic timing arrives independently after the original and preserves an arrived translation', async () => {
  const b = bridge();
  b.respond(b.requests.find((r) => !r.url.includes('tlang')), [event('Hallo schöne Welt.')]);
  await flush();
  assert.equal(b.posted.length, 1);
  assert.equal(b.posted[0].translationPending, true);
  const donor = b.requests.find((r) => r.url.includes('kind=asr'));
  assert.ok(donor);
  b.respond(b.requests.find((r) => r.url.includes('tlang')), [event('你好，美丽的世界。')]);
  await flush();
  assert.equal(b.posted.at(-1).cues[0].trans, '你好，美丽的世界。');
  b.respond(donor, [event('Hallo schöne Welt.', [null, 1000, 2500])]);
  await flush();
  const upgraded = b.posted.at(-1);
  assert.equal(upgraded.wordTimingUpdate, true);
  assert.equal(upgraded.translationPending, false);
  assert.equal(upgraded.cues[0].trans, '你好，美丽的世界。');
  assert.deepEqual(upgraded.cues[0].words.map((w) => w.t), [0, 1000, 2500]);
  assert.equal(upgraded.cues[0].wordTimingSource, 'automatic');
});

test('donor completion before the translation keeps the original visible and pending', async () => {
  const b = bridge();
  b.respond(b.requests.find((r) => !r.url.includes('tlang')), [event('Hallo schöne Welt.')]);
  await flush();
  b.respond(b.requests.find((r) => r.url.includes('kind=asr')),
    [event('Hallo schöne Welt.', [0, 1000, 2500])]);
  await flush();
  assert.equal(b.posted.at(-1).wordTimingUpdate, true);
  assert.equal(b.posted.at(-1).translationPending, true);
  b.respond(b.requests.find((r) => r.url.includes('tlang')), [event('你好。')]);
  await flush();
  assert.equal(b.posted.at(-1).translationPending, undefined);
  assert.equal(b.posted.at(-1).cues[0].wordTimingSource, 'automatic');
  assert.equal(b.posted.at(-1).cues[0].trans, '你好。');
});

test('wrong-language, translated, other-video and disabled timing tracks are never requested', async () => {
  for (const options of [{ donorLanguage: 'en' }, { donorTranslated: true },
    { donorVideo: 'previous' }, { useWordTiming: false }]) {
    const b = bridge(options);
    b.respond(b.requests.find((r) => !r.url.includes('tlang')), [event('Hallo schöne Welt.')]);
    await flush();
    assert.equal(b.requests.some((r) => r.url.includes('kind=asr')), false);
  }
});

test('native word offsets avoid donor requests and preserve the implicit first offset', async () => {
  const b = bridge({ useTlang: false });
  b.respond(b.requests[0], [event('Hallo schöne Welt.', [null, 1000, 2500])]);
  await flush();
  assert.equal(b.requests.length, 1);
  assert.equal(b.posted.length, 1);
  assert.deepEqual(b.posted[0].cues[0].words.map((w) => w.t), [0, 1000, 2500]);
});

test('a stale donor cannot update a new config or a newly navigated video', async () => {
  for (const navigate of [false, true]) {
    const b = bridge({ useTlang: false });
    b.respond(b.requests[0], [event('Hallo schöne Welt.')]);
    await flush();
    const donor = b.requests.find((r) => r.url.includes('kind=asr'));
    if (navigate) b.location.href = 'https://www.youtube.com/watch?v=other';
    b.config(2);
    await flush(); // a same-video config can immediately reuse the loaded original
    const count = b.posted.length;
    b.respond(donor, [event('Hallo schöne Welt.', [0, 1000, 2500])]);
    await flush();
    if (navigate) assert.equal(b.posted.length, count);
    else {
      const updates = b.posted.slice(count);
      assert.equal(updates.length, 1);
      assert.equal(updates[0].nonce, 2, 'only the current config may use a shared pending donor');
      assert.equal(updates[0].cues[0].wordTimingSource, 'automatic');
      assert.equal(b.requests.filter(r => !r.url.includes('kind=asr')).length, 1,
        'the current original is reused instead of fetched again');
    }
  }
});

test('failed donor timing leaves the complete original and translation usable', async () => {
  const b = bridge({ useTlang: false });
  b.respond(b.requests[0], [event('Hallo schöne Welt.')]);
  await flush();
  b.requests.find((r) => r.url.includes('kind=asr')).resolve({ ok: false, status: 403 });
  await flush();
  assert.equal(b.posted.length, 1);
  assert.equal(b.posted[0].cues[0].text, 'Hallo schöne Welt.');
  assert.equal(b.posted.some((p) => p.type === 'nocues'), false);
});

test('a cached donor still follows the first original post, and disabling timing avoids a refetch', async () => {
  const b = bridge({ useTlang: false });
  b.respond(b.requests[0], [event('Hallo schöne Welt.')]);
  await flush();
  b.respond(b.requests.find((r) => r.url.includes('kind=asr')),
    [event('Hallo schöne Welt.', [0, 1000, 2500])]);
  await flush();
  b.config(2);
  await flush();
  assert.equal(b.posted[2].wordTimingUpdate, undefined, 'original first, even with cached timing');
  assert.equal(b.posted[3].wordTimingUpdate, true);
  assert.equal(b.requests.filter((r) => r.url.includes('kind=asr')).length, 1);
  const requestCount = b.requests.length;
  b.disableTiming();
  await flush();
  assert.equal(b.requests.length, requestCount);
});

test('turning highlighting off discards a pending donor without disturbing original captions', async () => {
  const b = bridge({ useTlang: false });
  b.respond(b.requests[0], [event('Hallo schöne Welt.')]);
  await flush();
  const donor = b.requests.find((r) => r.url.includes('kind=asr'));
  b.disableTiming();
  b.respond(donor, [event('Hallo schöne Welt.', [0, 1000, 2500])]);
  await flush();
  assert.equal(b.posted.length, 1);
  assert.equal(b.posted[0].cues[0].text, 'Hallo schöne Welt.');
});

// ---- local pace ------------------------------------------------------------
// Seven one-syllable German words, so a word interval of N ms means exactly
// N ms per syllable and a region's real pace is known instead of assumed.
const PACED_WORDS = 'Tor Haus Buch Tag Licht Stein Wand'.split(' ');
const pacedCue = (start, stepMs, { dur = 3000, suffix = '' } = {}) => ({
  start, dur, text: PACED_WORDS.join(' ') + suffix,
  words: PACED_WORDS.map((u, i) => ({ t: start + i * stepMs, u: i ? u : u }))
});
// Slow first minute, fast second minute: the kind of change a single
// video-wide rate cannot follow. `omit` leaves a slot free for an untimed cue.
function twoSpeedTrack(omit = []) {
  const cues = [];
  for (let start = 0; start < 120000; start += 6000) {
    if (!omit.includes(start)) cues.push(pacedCue(start, start < 60000 ? 300 : 150));
  }
  return cues;
}

test('the measured pace follows a speaker who changes speed during the video', () => {
  const track = twoSpeedTrack();
  const measured = timing.pace(track, 'de');
  assert.ok(measured.samples.length > 20, 'every word interval is collected');
  assert.equal(Math.round(measured.global), 300,
    'the video-wide median cannot follow the change, which is why it is only the fallback');
  const slow = timing.localRate(measured, 30000);
  const fast = timing.localRate(measured, 90000);
  assert.ok(Math.abs(slow - 300) <= 30, `the slow region is measured locally, got ${slow}`);
  assert.ok(Math.abs(fast - 150) <= 15, `the fast region is measured locally, got ${fast}`);
  // A window straddling the change holds both rates; the middle reports the
  // dominant nearby pace instead of inventing a value between them.
  const boundary = timing.localRate(measured, 60000);
  assert.ok(boundary === 300 || boundary === 150,
    `a window over the change picks the dominant rate, got ${boundary}`);
  const early = timing.localRate(measured, 42000);
  assert.ok(Math.abs(early - 300) <= 30, `still slow just before the change, got ${early}`);
  const late = timing.localRate(measured, 78000);
  assert.ok(Math.abs(late - 150) <= 15, `already fast just after the change, got ${late}`);
});

test('a long silence inside one cue cannot move the local pace', () => {
  const track = twoSpeedTrack();
  // Four seconds of silence inside one cue that no punctuation marks: one
  // interval is an order of magnitude longer than the speaker's real pace.
  const outlier = pacedCue(30000, 300, { dur: 12000 });
  for (let i = 3; i < outlier.words.length; i++) outlier.words[i].t += 4000;
  const clean = timing.localRate(timing.pace(track, 'de'), 30000);
  const noisy = timing.localRate(timing.pace(track.concat([outlier]), 'de'), 30000);
  assert.ok(Math.abs(noisy - clean) <= 20,
    `the per-interval middle absorbs the outlier, ${clean} became ${noisy}`);
});

test('the local pace widens once and then gives up so the caller can fall back', () => {
  const single = pacedCue(0, 200);
  const measured = timing.pace([single], 'de');
  assert.equal(timing.localRate(measured, 0), 200, 'one nearby cue is enough evidence');
  assert.equal(timing.localRate(measured, 30000), 200, 'a wide window still reaches it');
  assert.equal(timing.localRate(measured, 200000), null, 'too far away to be local');
  assert.equal(timing.localRate(null, 0), null, 'nothing measured yet');
  assert.equal(timing.localRate(timing.pace([], 'de'), 0), null);
});

test('an untimed sentence is estimated at the pace measured around it', async () => {
  const words = PACED_WORDS.join(' ');
  const slow = { start: 30000, dur: 3000, text: words };
  const fast = { start: 96000, dur: 3000, text: words };
  const player = await mountContent({ cues: twoSpeedTrack([30000, 96000]).concat([slow, fast]) });
  player.at(30.75);
  const slowIdx = player.activeWordIdx();
  player.at(96.75);
  const fastIdx = player.activeWordIdx();
  assert.equal(player.status().wordTiming, 'estimated');
  assert.ok(fastIdx > slowIdx,
    `the fast sentence reaches further into the line by the same moment, ${slowIdx} vs ${fastIdx}`);
});

test('the video pace is measured once per caption track, not for every sentence', async () => {
  const words = PACED_WORDS.join(' ');
  const untimed = (start) => ({ start, dur: 3000, text: words });
  const cues = twoSpeedTrack([30000, 36000, 96000])
    .concat([untimed(30000), untimed(36000), untimed(96000)]);
  const player = await mountContent({ cues });
  const real = player.timing;
  let calls = 0;
  player.timing = Object.freeze({ ...real,
    pace(...args) { calls += 1; return real.pace(...args); } });
  player.at(30.5);
  player.at(36.5);
  player.at(96.5);
  assert.ok(calls <= 1, `playback must not rescan the track, saw ${calls} scans`);
  // A new caption track is a new measurement, not the previous video's pace.
  const replaced = twoSpeedTrack([30000]).concat([untimed(30000)]);
  player.sendCues({ cues: replaced, aligned: true, wordTimingUpdate: true });
  player.at(30.5);
  assert.equal(calls, 2, 'a replaced track is measured again');
});
