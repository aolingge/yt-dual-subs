// Regression tests for the reported crash:
//   Uncaught Error: Extension context invalidated.
//   extensions/<id>/content.js (anonymous function):25:1
//
// The user reloads the extension from edge://extensions while a YouTube tab
// stays open (which the extension's own update instructions tell them to do).
// The page keeps the OLD content script: its listeners and timers are alive,
// but its extension context is dead, so EVERY chrome.* call throws "Extension
// context invalidated". Line 25 was the i18n wrapper t(), which runs on render
// paths (the drag grip's label, the CC button's label), so the throw escaped a
// synchronous handler as an uncaught error.
//
// Here the fake chrome API is made to throw exactly like the real one, and the
// content script must survive: no exception, no repeated requests, and a page
// that keeps rendering with built-in fallback labels.
const test = require('node:test');
const assert = require('node:assert');
const { mountContent } = require('./harness.cjs');

const HANDLE_TITLE = '拖动移动字幕 · 双击复位';

// The newest overlay is children[2] of the overlay container: [trans, orig, handle].
function newestOverlay(api) {
  return api.player.children[api.player.children.length - 1];
}
const handleTitle = (api) => newestOverlay(api).children[2].title;

const CUES = [
  { start: 0, dur: 1000, text: 'Hallo.' },
  { start: 2100, dur: 1000, text: 'Wie geht es dir?' }
];

test('an i18n call that throws cannot break the overlay render path', async () => {
  const api = await mountContent({ cues: CUES, i18nThrows: true });

  // The overlay still renders, and the label falls back to the built-in string
  // instead of escaping as an uncaught error from t().
  assert.equal(api.read().original, 'Hallo.');
  assert.equal(handleTitle(api), HANDLE_TITLE);

  // SPA navigation re-creates the overlay through the same render path.
  assert.doesNotThrow(() => api.navigate('next'));
  assert.equal(handleTitle(api), HANDLE_TITLE);
  assert.equal(api.status().ok, true);
});

test('after a reload the cue loop stops itself instead of throwing', async () => {
  const api = await mountContent({ cues: CUES });
  const beforeRequests = api.requests.length;
  assert.equal(api.status().mode, 'cues');

  api.killContext();
  assert.equal(api.contextDead, true);

  // The next tick would call chrome.* — it must stop the loop quietly instead.
  assert.doesNotThrow(() => api.at(2.5));
  assert.equal(api.requests.length, beforeRequests);
  assert.equal(api.status().mode, 'off');

  // liveVersion() reads chrome.runtime.getManifest, which also throws now.
  assert.equal(api.status().version, '');
});

test('a translation reply that lands after the reload is ignored', async () => {
  const api = await mountContent({ cues: CUES, backend: 'gtx' });
  assert.ok(api.requests.length > 0, 'expected a free-endpoint request');
  assert.equal(api.read().translation, '');

  api.killContext();

  // The background reply arrives for the dead context: no crash, no text.
  assert.doesNotThrow(() => api.respond(0, { ok: true, translated: '你好。' }));
  assert.equal(api.read().translation, '');
});

test('a stored setting is written while alive but survives a dead context', async () => {
  const api = await mountContent({ cues: CUES });

  // Control: with a live context the CC toggle persists its new value.
  api.runtimeMessage({ type: 'toggleTranslation' });
  assert.equal(api.storageWrites.length, 1);
  assert.deepEqual({ ...api.storageWrites[0] }, { showTranslation: false });

  // After a reload the same click must not throw out of the handler.
  api.killContext();
  assert.doesNotThrow(() => api.runtimeMessage({ type: 'toggleTranslation' }));
  assert.equal(api.storageWrites.length, 1, 'dead context must not record a write');
  assert.equal(api.status().ok, true);
});

test('a re-injection into a dead context does nothing instead of throwing', async () => {
  // Boot straight into a dead context: content.js bails out at load, so no
  // listener, timer or overlay is registered and nothing throws.
  const api = await mountContent({ cues: CUES, dead: true });
  assert.equal(api.requests.length, 0);
  assert.equal(api.player.children.length, 0);
  assert.equal(api.status(), null);
});
