const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('the original and translated tracks start together and the original is posted first', async () => {
  const listeners = {};
  const requests = [];
  const posted = [];
  const fetch = (url) => new Promise((resolve) => requests.push({ url, resolve }));
  const window = {
    fetch,
    addEventListener(type, listener) { listeners[type] = listener; },
    postMessage(message) { posted.push(message); }
  };
  class XMLHttpRequest {
    open(_method, url) { this.url = url; }
    send() {}
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8'), {
    window, fetch, XMLHttpRequest, URL,
    location: { href: 'https://www.youtube.com/watch?v=sample' },
    performance: { getEntriesByType: () => [] },
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {}
  });

  listeners.message({ source: window, data: {
    source: 'ytds-content', type: 'config', targetLang: 'zh-CN',
    useTlang: true, nonce: 1
  } });
  const xhr = new XMLHttpRequest();
  xhr.open('GET', 'https://www.youtube.com/api/timedtext?v=sample&lang=de&pot=token');
  xhr.send();
  assert.equal(requests.length, 2);
  const original = requests.find((request) => !new URL(request.url).searchParams.has('tlang'));
  const translated = requests.find((request) => new URL(request.url).searchParams.has('tlang'));
  assert.ok(original);
  assert.ok(translated);

  const response = (text) => ({ ok: true, text: async () => JSON.stringify({
    events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: text }] }]
  }) });
  original.resolve(response('Hallo.'));
  await new Promise(setImmediate);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].cues[0].text, 'Hallo.');
  assert.equal(posted[0].translationPending, true);
  assert.equal(posted[0].sourceLang, 'de');

  translated.resolve(response('你好。'));
  await new Promise(setImmediate);
  assert.equal(posted.length, 2);
  assert.equal(posted[1].translationUpdate, true);
  assert.equal(posted[1].cues[0].trans, '你好。');
  assert.equal(posted[1].sourceLang, 'de');
  assert.equal(posted[1].nonce, 1);
});

test('equal cue counts do not accept a translation fragment with the wrong time', async () => {
  const listeners = {};
  const requests = [];
  const posted = [];
  const fetch = (url) => new Promise((resolve) => requests.push({ url, resolve }));
  const window = {
    fetch,
    addEventListener(type, listener) { listeners[type] = listener; },
    postMessage(message) { posted.push(message); }
  };
  class XMLHttpRequest {
    open(_method, url) { this.url = url; }
    send() {}
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8'), {
    window, fetch, XMLHttpRequest, URL,
    location: { href: 'https://www.youtube.com/watch?v=sample' },
    performance: { getEntriesByType: () => [] },
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {}
  });
  listeners.message({ source: window, data: {
    source: 'ytds-content', type: 'config', targetLang: 'zh-CN',
    useTlang: true, nonce: 1
  } });
  const xhr = new XMLHttpRequest();
  xhr.open('GET', 'https://www.youtube.com/api/timedtext?v=sample&lang=de&pot=token');
  xhr.send();
  const original = requests.find((r) => !new URL(r.url).searchParams.has('tlang'));
  const translated = requests.find((r) => new URL(r.url).searchParams.has('tlang'));
  const response = (events) => ({ ok: true, text: async () => JSON.stringify({ events }) });
  const event = (start, text) => ({ tStartMs: start, dDurationMs: 1000,
    segs: [{ utf8: text }] });
  original.resolve(response([event(0, 'Hallo.'), event(3000, 'Tschüss.') ]));
  await new Promise(setImmediate);
  translated.resolve(response([event(0, '你好。'), event(6000, '再见。')]));
  await new Promise(setImmediate);
  assert.equal(posted[1].aligned, true);
  assert.equal(posted[1].cues[0].trans, '你好。');
  assert.equal(posted[1].cues[1].trans, '');
});

// A player whose CC menu has "de" selected, so inject.js may seed the source URL
// from the track list instead of waiting for the player's own timedtext request.
function seedSetup() {
  const listeners = {};
  const requests = [];
  const posted = [];
  const fetch = (url) => new Promise((resolve) => requests.push({ url, resolve }));
  const player = {
    getOption(area, name) {
      if (area !== 'captions') return null;
      if (name === 'track') return { languageCode: 'de', vssId: '.de', kind: '' };
      if (name === 'tracklist') {
        return [{
          languageCode: 'de', vssId: '.de', kind: '',
          baseUrl: 'https://www.youtube.com/api/timedtext?v=sample&lang=de'
        }];
      }
      return null;
    }
  };
  const document = {
    getElementById: (id) => (id === 'movie_player' ? player : null),
    querySelector: () => null
  };
  const window = {
    fetch,
    addEventListener(type, listener) { listeners[type] = listener; },
    postMessage(message) { posted.push(message); }
  };
  class XMLHttpRequest {
    open(_method, url) { this.url = url; }
    send() {}
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8'), {
    window, fetch, XMLHttpRequest, URL, document,
    location: { href: 'https://www.youtube.com/watch?v=sample' },
    performance: { getEntriesByType: () => [] },
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {}
  });
  return { listeners, requests, posted, window, XMLHttpRequest };
}

test('the source track is seeded from the player before it is captured on the wire', () => {
  const { listeners, requests, window } = seedSetup();
  assert.equal(requests.length, 0, 'nothing requested until the page is configured');

  listeners.message({ source: window, data: {
    source: 'ytds-content', type: 'config', targetLang: 'zh-CN',
    useTlang: true, nonce: 1
  } });

  assert.equal(requests.length, 2, 'the guessed track is fetched without the sniffer');
  const original = requests.find((r) => !new URL(r.url).searchParams.has('tlang'));
  assert.ok(original, 'the original track is requested');
  assert.equal(new URL(original.url).searchParams.get('lang'), 'de');
});

test('a stale seeded guess never switches the page to scrape mode', async () => {
  const { listeners, requests, posted, window, XMLHttpRequest } = seedSetup();
  listeners.message({ source: window, data: {
    source: 'ytds-content', type: 'config', targetLang: 'zh-CN',
    useTlang: true, nonce: 1
  } });

  // The guess is unsigned/stale: the fetch fails.
  requests.find((r) => !new URL(r.url).searchParams.has('tlang'))
    .resolve({ ok: false, status: 404, text: async () => '' });
  await new Promise(setImmediate);
  assert.equal(posted.length, 0, 'no "nocues" from a guess — that would scrape');

  // The player's own request then arrives and must still work.
  const xhr = new XMLHttpRequest();
  xhr.open('GET', 'https://www.youtube.com/api/timedtext?v=sample&lang=de&pot=2');
  xhr.send();
  assert.equal(requests.length, 4, 'the real capture refetches both tracks');
  const original = requests.filter((r) => !new URL(r.url).searchParams.has('tlang')).pop();
  original.resolve({ ok: true, text: async () => JSON.stringify({
    events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Hallo.' }] }]
  }) });
  await new Promise(setImmediate);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].cues[0].text, 'Hallo.');
  assert.equal(posted[0].translationPending, true);
});
