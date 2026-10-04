const test = require('node:test');
const assert = require('node:assert/strict');
const { mountContent } = require('./harness.cjs');

test('pageshow rebuilds a detached overlay and re-arms the page bridge', async () => {
  const page = await mountContent({
    cues: [{ start: 0, dur: 2000, text: 'Hallo.', trans: '你好。' }]
  });
  const before = page.overlayEl();
  assert.ok(before, 'the initial page has an overlay');

  // A BFCache restore can bring the document back with the player subtree
  // replaced while the old content-script state still points at the detached
  // overlay. The restore hook must repair that without a full page reload.
  page.detachOverlay();
  page.outbound.length = 0;
  page.fire('pageshow', { persisted: true });

  const after = page.overlayEl();
  assert.ok(after, 'pageshow restores the overlay');
  assert.notStrictEqual(after, before, 'the detached overlay is not reused');
  assert.ok(
    page.outbound.some((message) => message.type === 'hello' || message.type === 'config'),
    'pageshow re-arms the injected page bridge'
  );
});
