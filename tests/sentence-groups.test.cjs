const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function element() {
  let ownText = '';
  const el = {
    style: { setProperty(name, value) { this[name] = String(value); } },
    isConnected: false, children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); child.isConnected = true; },
    addEventListener() {}, setAttribute() {}, click() {}, remove() {}
  };
  Object.defineProperty(el, 'textContent', {
    get() { return ownText + this.children.map((child) => child.textContent).join(''); },
    set(value) { ownText = String(value == null ? '' : value); this.children = []; }
  });
  return el;
}

async function mountCues(cues, aligned = true, tcues = null,
  translationPending = false, backend = 'tlang') {
  const listeners = {};
  const timers = [];
  const timeouts = [];
  const requests = [];
  let nativeCaption = '';
  let fallbackStarted = false;
  const video = { currentTime: 0.1 };
  const player = element();
  player.querySelector = (selector) => selector === 'video' ? video : null;
  const document = {
    documentElement: { classList: { toggle() {} } },
    body: element(),
    createElement: element,
    querySelector: (selector) => selector === '#movie_player' ? player : null,
    querySelectorAll: (selector) => selector === '.ytp-caption-segment' && nativeCaption
      ? [{ textContent: nativeCaption }] : []
  };
  const window = {
    addEventListener(type, listener) { listeners[type] = listener; },
    postMessage() {}
  };
  const chrome = {
    i18n: { getMessage: () => '' },
    runtime: {
      id: 'test-extension-id',
      onMessage: { addListener(fn) { listeners.runtimeMessage = fn; } },
      sendMessage(message, done) { requests.push({ message, done }); }
    },
    storage: {
      onChanged: { addListener(fn) { listeners.storageChanged = fn; } },
      sync: {
        get(defaults, done) { done({ ...defaults, backend, fontSizeRepair20260926: true }); },
        set() {}
      }
    }
  };
  class TestURL extends URL {}
  TestURL.createObjectURL = () => 'blob:test';
  TestURL.revokeObjectURL = () => {};
  const context = vm.createContext({
    chrome, document, window, URL: TestURL, Blob,
    location: { href: 'https://www.youtube.com/watch?v=sample' },
    setTimeout(fn) { timeouts.push(fn); return timeouts.length; }, clearTimeout() {},
    setInterval(fn) { timers.push(fn); return timers.length; }, clearInterval() {}
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'word-timing.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), context);
  await new Promise(setImmediate);
  listeners.message({ source: window, data: {
    source: 'ytds-inject', type: 'cues', videoId: 'sample', aligned, cues, tcues,
    translationPending, sourceLang: 'de'
  } });
  const [translation, original] = player.children[0].children;
  return {
    requests,
    updateTranslation(nextCues, nextTcues, nextAligned, nonce) {
      listeners.message({ source: window, data: {
        source: 'ytds-inject', type: 'cues', videoId: 'sample',
        translationUpdate: true, cues: nextCues, tcues: nextTcues,
        aligned: nextAligned, nonce, sourceLang: 'de'
      } });
    },
    get cueLoopCount() { return timers.length; },
    runDebounce() { timeouts.at(-1)(); },
    changeLanguage(language) {
      listeners.storageChanged({ targetLang: { newValue: language } }, 'sync');
    },
    at(seconds) {
      video.currentTime = seconds;
      timers.at(-1)();
      return { original: original.textContent, translation: translation.textContent };
    },
    fallback(text) {
      nativeCaption = text;
      if (!fallbackStarted) {
        listeners.message({ source: window, data: {
          source: 'ytds-inject', type: 'nocues', videoId: 'sample'
        } });
        fallbackStarted = true;
      }
      timers.at(-1)();
      return { original: original.textContent, translation: translation.textContent };
    },
    exportOriginal() {
      return new Promise((resolve) => {
        listeners.runtimeMessage({ type: 'exportSrt', variant: 'orig' }, {}, resolve);
      });
    }
  };
}

test('original appears before tlang and the translation arrives without restarting the cue loop', async () => {
  const original = [
    { start: 0, dur: 1000, text: 'Guten Morgen.' },
    { start: 1000, dur: 1000, text: 'Willkommen.' }
  ];
  const player = await mountCues(original, null, null, true);
  assert.deepEqual(player.at(0.1), { original: 'Guten Morgen.', translation: '' });
  assert.equal(player.requests.length, 0);
  const loops = player.cueLoopCount;
  player.updateTranslation([
    { ...original[0], trans: '早上好。' },
    { ...original[1], trans: '欢迎。' }
  ], null, true);
  assert.equal(player.cueLoopCount, loops);
  assert.deepEqual(player.at(0.1), { original: 'Guten Morgen.', translation: '早上好。' });
});

test('failed tlang switches the active sentence to gtx', async () => {
  const cues = [{ start: 0, dur: 1000, text: 'Hallo.' }];
  const player = await mountCues(cues, null, null, true);
  assert.equal(player.requests.length, 0);
  player.updateTranslation(cues, null, null);
  assert.equal(player.requests[0].message.text, 'Hallo.');
  assert.equal(player.requests[0].message.sourceLang, 'de');
});

test('a translated track from an older config cannot replace the pending one', async () => {
  const cues = [{ start: 0, dur: 1000, text: 'Hallo.' }];
  const player = await mountCues(cues, null, null, true);
  player.updateTranslation([{ ...cues[0], trans: '过期译文' }], null, true, 0);
  assert.deepEqual(player.at(0.1), { original: 'Hallo.', translation: '' });
  assert.equal(player.requests.length, 0);
});

test('fast display shows the current Google sentence first and keeps it when YouTube arrives', async () => {
  const cues = [
    { start: 0, dur: 1000, text: 'Hello.' },
    { start: 1000, dur: 1000, text: 'Next.' }
  ];
  const player = await mountCues(cues, null, null, true, 'fast');
  assert.equal(player.requests.length, 2, 'also prepare the upcoming sentence');
  assert.equal(player.requests[0].message.text, 'Hello.');
  player.requests[0].done({ ok: true, translated: '先到的译文。' });
  assert.deepEqual(player.at(0.1), {
    original: 'Hello.', translation: '先到的译文。'
  });
  const loops = player.cueLoopCount;
  player.updateTranslation([
    { ...cues[0], trans: '整轨译文。' },
    { ...cues[1], trans: '下一句。' }
  ], null, true);
  assert.equal(player.cueLoopCount, loops);
  assert.deepEqual(player.at(0.1), {
    original: 'Hello.', translation: '先到的译文。'
  });
  assert.deepEqual(player.at(1.1), {
    original: 'Next.', translation: '下一句。'
  });
});

test('a late Google reply cannot replace the YouTube translation', async () => {
  const cues = [{ start: 0, dur: 1000, text: 'Hello.' }];
  const player = await mountCues(cues, null, null, true, 'fast');
  const lateReply = player.requests[0].done;
  player.updateTranslation([{ ...cues[0], trans: 'YouTube 译文。' }], null, true);
  lateReply({ ok: true, translated: '过期 Google 译文。' });
  assert.equal(player.at(0.1).translation, 'YouTube 译文。');
});

test('a pending Google reply can still fill the current sentence if YouTube translation fails', async () => {
  const cues = [{ start: 0, dur: 1000, text: 'Hello.' }];
  const player = await mountCues(cues, null, null, true, 'fast');
  player.updateTranslation(cues, null, null);
  assert.equal(player.requests.length, 1);
  player.requests[0].done({ ok: true, translated: 'Google 译文。' });
  assert.equal(player.at(0.1).translation, 'Google 译文。');
});

test('Google rate limiting stops fast requests for later sentences on the same video', async () => {
  const cues = [
    { start: 0, dur: 1000, text: 'First.' },
    { start: 1000, dur: 1000, text: 'Second.' }
  ];
  const player = await mountCues(cues, null, null, true, 'fast');
  player.requests[0].done({ ok: false, error: 'Error: translate http 429' });
  assert.equal(player.at(1.1).translation, '');
  assert.equal(player.requests.length, 2, 'the existing prefetch is not followed by new requests');
  player.updateTranslation([
    { ...cues[0], trans: '第一句。' },
    { ...cues[1], trans: '第二句。' }
  ], null, true);
  assert.equal(player.at(1.1).translation, '第二句。');
});

test('slow Google prefetch stays bounded while a newly active sentence starts immediately', async () => {
  const cues = Array.from({ length: 10 }, (_, i) => ({
    start: i * 1000, dur: 1000, text: `Sentence ${i}.`
  }));
  const player = await mountCues(cues, null, null, false, 'gtx');
  assert.equal(player.requests.length, 4);
  player.at(5.1);
  assert.equal(player.requests.length, 5);
  assert.equal(player.requests[4].message.text, 'Sentence 5.');
});

test('a complete aligned sentence appears from its first fragment and stays until the next sentence', async () => {
  const player = await mountCues([
    { start: 0, dur: 1000, text: 'Ich glaube', trans: '我认为' },
    { start: 1000, dur: 1000, text: 'das ist gut.', trans: '这很好。' },
    { start: 2000, dur: 1000, text: 'Wir', trans: '我们' },
    { start: 3000, dur: 1000, text: 'lernen weiter.', trans: '继续学习。' }
  ]);
  assert.deepEqual(player.at(0.1), {
    original: 'Ich glaube das ist gut.', translation: '我认为这很好。'
  });
  assert.deepEqual(player.at(1.5), {
    original: 'Ich glaube das ist gut.', translation: '我认为这很好。'
  });
  assert.deepEqual(player.at(2.1), {
    original: 'Wir lernen weiter.', translation: '我们继续学习。'
  });
});

test('German abbreviations with spaces stay in the same displayed sentence', async () => {
  const player = await mountCues([
    { start: 0, dur: 1000, text: 'Das ist z. B.', trans: '比如' },
    { start: 1000, dur: 1000, text: 'ein Beispiel.', trans: '一个例子。' }
  ]);
  assert.deepEqual(player.at(0.1), {
    original: 'Das ist z. B. ein Beispiel.', translation: '比如一个例子。'
  });
});

test('rolling automatic captions do not repeat overlapping words', async () => {
  const player = await mountCues([
    { start: 0, dur: 1500, text: 'Wir sprechen', trans: '我们说' },
    { start: 500, dur: 1500, text: 'sprechen heute', trans: '说今天' },
    { start: 1000, dur: 1000, text: 'heute über KI.', trans: '今天谈论人工智能。' }
  ]);
  assert.deepEqual(player.at(0.1), {
    original: 'Wir sprechen heute über KI.', translation: '我们说今天谈论人工智能。'
  });
});

test('a long silence prevents unrelated fragments from being joined', async () => {
  const player = await mountCues([
    { start: 0, dur: 500, text: 'Noch nicht', trans: '还没有' },
    { start: 4000, dur: 1000, text: 'fertig.', trans: '完成。' }
  ]);
  assert.deepEqual(player.at(0.1), {
    original: 'Noch nicht', translation: '还没有'
  });
  assert.deepEqual(player.at(4.1), {
    original: 'fertig.', translation: '完成。'
  });
});

test('adjacent long cues still form one sentence when there is no silence', async () => {
  const player = await mountCues([
    { start: 0, dur: 3500, text: 'Wir möchten', trans: '我们想要' },
    { start: 3500, dur: 3500, text: 'eine Lösung.', trans: '一个解决方案。' }
  ]);
  assert.deepEqual(player.at(0.1), {
    original: 'Wir möchten eine Lösung.', translation: '我们想要一个解决方案。'
  });
});

test('rolling captions do not repeat a completed previous sentence', async () => {
  const player = await mountCues([
    { start: 0, dur: 1000, text: 'Das ist gut.', trans: '这很好。' },
    { start: 800, dur: 1200, text: 'Das ist gut. Weiter geht es.', trans: '这很好。我们继续。' }
  ]);
  assert.deepEqual(player.at(0.1), {
    original: 'Das ist gut.', translation: '这很好。'
  });
  assert.deepEqual(player.at(0.9), {
    original: 'Weiter geht es.', translation: '我们继续。'
  });
});

test('a zero-duration cue does not reveal a sentence across a long silence', async () => {
  const player = await mountCues([
    { start: 0, dur: 0, text: 'Noch nicht', trans: '还没有' },
    { start: 10000, dur: 1000, text: 'fertig.', trans: '完成。' }
  ]);
  assert.equal(player.at(0.1).original, 'Noch nicht');
  assert.equal(player.at(1.5).original, '');
  assert.equal(player.at(10.1).original, 'fertig.');
});

test('two independently repeated short sentences both remain visible', async () => {
  const player = await mountCues([
    { start: 0, dur: 500, text: 'No.', trans: '不。' },
    { start: 500, dur: 500, text: 'No.', trans: '不是。' }
  ]);
  assert.deepEqual(player.at(0.1), { original: 'No.', translation: '不。' });
  assert.deepEqual(player.at(0.6), { original: 'No.', translation: '不是。' });
});

test('a changed translated prefix is not shown beside a stripped rolling sentence', async () => {
  const player = await mountCues([
    { start: 0, dur: 1000, text: 'Hello.', trans: '你好。' },
    { start: 800, dur: 1200, text: 'Hello. World.', trans: '你好，世界。' }
  ]);
  assert.equal(player.requests[0].message.text, 'World.');
  assert.deepEqual(player.at(0.9), { original: 'World.', translation: '' });
  player.requests[0].done({ ok: true, translated: '世界。' });
  assert.equal(player.at(0.9).translation, '世界。');
});

test('misaligned translation tracks translate the whole grouped sentence', async () => {
  const player = await mountCues([
    { start: 0, dur: 800, text: 'Das ist', trans: '' },
    { start: 800, dur: 800, text: 'ein Satz.', trans: '' }
  ], false, [{ start: 0, dur: 800, text: '这是' }]);
  assert.equal(player.requests[0].message.text, 'Das ist ein Satz.');
  assert.deepEqual(player.at(0.1), {
    original: 'Das ist ein Satz.', translation: ''
  });
  player.requests[0].done({ ok: true, translated: '这是一个完整的句子。' });
  assert.equal(player.at(0.1).translation, '这是一个完整的句子。');
});

test('very long unpunctuated captions split safely and SRT keeps original cue count', async () => {
  const player = await mountCues([
    { start: 0, dur: 1000, text: 'Wir reden', trans: '我们在说话' },
    { start: 13000, dur: 1000, text: 'und reden weiter', trans: '继续说话' }
  ]);
  assert.equal(player.at(0.1).original, 'Wir reden');
  assert.equal(player.at(13.1).original, 'und reden weiter');
  const exported = await player.exportOriginal();
  assert.deepEqual({ ok: exported.ok, count: exported.count, variant: exported.variant }, {
    ok: true, count: 2, variant: 'orig'
  });
});

test('subtitle lines wrap long words instead of overflowing the player', () => {
  const css = fs.readFileSync(path.join(root, 'content.css'), 'utf8');
  assert.match(css, /\.ytds-line\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.ytds-line\s*\{[^}]*box-sizing:\s*border-box/s);
});

test('standalone music cues leave a subtitle gap and do not enter display groups', async () => {
  const player = await mountCues([
    { start: 0, dur: 1000, text: 'Guten', trans: '你好' },
    { start: 1000, dur: 1000, text: '[musik]', trans: '[音乐]' },
    { start: 2000, dur: 1000, text: 'Tag.', trans: '白天。' }
  ]);
  assert.deepEqual(player.at(0.1), { original: 'Guten', translation: '你好' });
  assert.deepEqual(player.at(1.1), { original: '', translation: '' });
  assert.deepEqual(player.at(2.1), { original: 'Tag.', translation: '白天。' });
  assert.equal((await player.exportOriginal()).count, 3);
});

test('inline sound labels disappear while spoken words and translation stay', async () => {
  const player = await mountCues([
    { start: 0, dur: 1000, text: '[Musik] in diesem Teil', trans: '[音乐] 在这部分' },
    { start: 1000, dur: 1000, text: 'lernen wir.', trans: '我们学习。' }
  ]);
  assert.deepEqual(player.at(0.1), {
    original: 'in diesem Teil lernen wir.', translation: '在这部分我们学习。'
  });
});

test('ordinary bracketed dialogue is preserved', async () => {
  const player = await mountCues([
    { start: 0, dur: 1000, text: '[Hinweis] Bitte lesen.', trans: '[提示]请阅读。' }
  ]);
  assert.deepEqual(player.at(0.1), {
    original: '[Hinweis] Bitte lesen.', translation: '[提示]请阅读。'
  });
});

test('screen-caption fallback filters both standalone and inline music labels', async () => {
  const player = await mountCues([]);
  assert.deepEqual(player.fallback('[musik]'), { original: '', translation: '' });
  assert.deepEqual(player.fallback('[Musik] Hallo'), { original: 'Hallo', translation: '' });
  assert.equal(player.requests.length, 0);
});

test('switching from cue mode to a music-only fallback clears the previous spoken line', async () => {
  const player = await mountCues([
    { start: 0, dur: 1000, text: 'Hallo.', trans: '你好。' }
  ]);
  assert.equal(player.at(0.1).original, 'Hallo.');
  assert.deepEqual(player.fallback('[musik]'), { original: '', translation: '' });
});

test('parenthesized sound labels are removed without affecting the dialogue', async () => {
  const player = await mountCues([
    { start: 0, dur: 1000, text: '(Musik) Hallo.', trans: '（音乐）你好。' }
  ]);
  assert.deepEqual(player.at(0.1), { original: 'Hallo.', translation: '你好。' });
});

test('overlapping music cue does not cut off ongoing spoken caption', async () => {
  const player = await mountCues([
    { start: 0, dur: 3000, text: 'Hallo.', trans: '你好。' },
    { start: 1000, dur: 1000, text: '[Musik]', trans: '[音乐]' }
  ]);
  assert.deepEqual(player.at(1.5), { original: 'Hallo.', translation: '你好。' });
});

test('fallback replaces old translation when spoken source changes', async () => {
  const player = await mountCues([]);
  player.fallback('Hallo.');
  player.runDebounce();
  player.requests.at(-1).done({ ok: true, translated: '你好。' });
  assert.deepEqual(player.fallback('Guten Tag.'), {
    original: 'Guten Tag.', translation: ''
  });
});

test('fallback language change clears old translation and requests a fresh one', async () => {
  const player = await mountCues([]);
  player.fallback('Hallo.');
  player.runDebounce();
  const oldRequest = player.requests.at(-1);
  oldRequest.done({ ok: true, translated: '你好。' });
  player.changeLanguage('en');
  assert.deepEqual(player.fallback('Hallo.'), { original: 'Hallo.', translation: '' });
  player.runDebounce();
  assert.equal(player.requests.at(-1).message.targetLang, 'en');
  oldRequest.done({ ok: true, translated: '你好。' });
  assert.equal(player.fallback('Hallo.').translation, '');
});

test('a translation response cannot reintroduce a bracketed music label', async () => {
  const player = await mountCues([
    { start: 0, dur: 1000, text: 'Hallo.', trans: '' }
  ], null);
  assert.equal(player.requests[0].message.text, 'Hallo.');
  player.requests[0].done({ ok: true, translated: '[音乐] 你好。' });
  assert.equal(player.at(0.1).translation, '你好。');
});
