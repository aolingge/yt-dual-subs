const test = require('node:test');
const assert = require('node:assert/strict');
const { mountContent } = require('./harness.cjs');

test('player resizing scales displayed fonts and fullscreen restores saved sizes', async () => {
  const page = await mountContent({
    playerWidth: 900, playerHeight: 506,
    settings: { origSize: 44, transSize: 38 }
  });
  const overlay = page.overlayEl();
  const [translation, original] = overlay.children;
  const windowed = original.style.fontSize;
  assert.ok(parseFloat(windowed) < 44);
  assert.ok(parseFloat(translation.style.fontSize) < 38);
  page.resizePlayer(640, 360);
  assert.ok(parseFloat(original.style.fontSize) < parseFloat(windowed));
  page.setFullscreen(true);
  assert.equal(original.style.fontSize, '44px');
  assert.equal(translation.style.fontSize, '38px');
  page.setFullscreen(false).resizePlayer(900, 506);
  assert.equal(original.style.fontSize, windowed);
  assert.equal(page.storageWrites.length, 0, 'rendering never rewrites the chosen sizes');
});

test('saved custom positions are bounded by the player and native controls', async () => {
  const page = await mountContent({
    playerWidth: 900, playerHeight: 506, controlHeight: 50, overlayHeight: 120,
    settings: { posMode: 'custom', posXpct: 98, posYpct: 90 }
  });
  const overlay = page.overlayEl();
  assert.ok(parseFloat(overlay.style.left) + overlay.offsetWidth / 2 <= 900);
  assert.ok(parseFloat(overlay.style.top) + overlay.offsetHeight / 2 <= 506 - 50 - 4);
  page.resizePlayer(640, 360);
  assert.ok(parseFloat(overlay.style.left) + overlay.offsetWidth / 2 <= 640);
  assert.ok(parseFloat(overlay.style.top) + overlay.offsetHeight / 2 <= 360 - 50 - 4);
  assert.equal(page.storageWrites.length, 0, 'clamping does not overwrite the saved position');
});

test('layout observers are disconnected when overlays are replaced or disabled', async () => {
  const page = await mountContent();
  assert.equal(page.resizeObservers.length, 1);
  const first = page.resizeObservers[0];
  assert.equal(first.targets.size, 2);
  page.navigate('next-video');
  assert.equal(first.targets.size, 0);
  assert.equal(page.resizeObservers.length, 2);
  const second = page.resizeObservers[1];
  page.changeSettings({ enabled: false });
  assert.equal(second.targets.size, 0);
});

test('preset positions leave the native control bar clear after resizing', async () => {
  const page = await mountContent({
    playerWidth: 900, playerHeight: 506, controlHeight: 50, overlayHeight: 120
  });
  const overlay = page.overlayEl();
  assert.ok(parseFloat(overlay.style.bottom) >= 50 + 4);
  for (const position of ['top', 'center']) {
    page.changeSettings({ position });
    page.resizePlayer(640, 360);
    const top = parseFloat(overlay.style.top) - (position === 'center' ? 60 : 0);
    assert.ok(top >= 0);
    assert.ok(top + overlay.offsetHeight <= 360 - 50 - 4);
  }
});
