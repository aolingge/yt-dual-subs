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
