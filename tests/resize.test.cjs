const test = require('node:test');
const assert = require('node:assert/strict');
const { mountContent } = require('./harness.cjs');

async function mounted() {
  const page = await mountContent({
    playerWidth: 900, playerHeight: 506, overlayHeight: 120,
    settings: { overlayWidthPct: 60, posMode: 'custom', posXpct: 50, posYpct: 90 }
  });
  const overlay = page.overlayEl();
  overlay.getBoundingClientRect = () => ({
    left: 180, right: 720, top: 300, bottom: 420, width: 540, height: 120
  });
  return { page, overlay,
    left: overlay.children.find((child) => child.hasClass('ytds-resize-left')),
    right: overlay.children.find((child) => child.hasClass('ytds-resize-right')) };
}

test('custom widths scale with the player, allow full-player width, and reset to auto', async () => {
  const { page, overlay, right } = await mounted();
  const configs = page.outbound.filter((item) => item.type === 'config').length;
  assert.equal(overlay.offsetWidth, 540);
  page.resizePlayer(640, 360);
  assert.equal(overlay.offsetWidth, 384);
  page.changeSettings({ overlayWidthPct: 200 });
  assert.equal(overlay.style.width, '96%');
  page.setFullscreen(true).resizePlayer(1920, 1080);
  assert.ok(overlay.offsetWidth > 1100, 'a manual width is not limited by the old automatic cap');
  right.dispatch('dblclick');
  assert.equal(overlay.style.width, '');
  assert.equal(overlay.style.maxWidth, '');
  assert.equal(overlay.offsetWidth, 1100);
  assert.equal(page.storageWrites.at(-1).overlayWidthPct, 0);
  assert.equal(page.outbound.filter((item) => item.type === 'config').length, configs);
});

test('left-edge resize keeps the opposite edge fixed and saves only at release', async () => {
  const { page, overlay, left } = await mounted();
  left.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 180 });
  left.dispatch('pointermove', { pointerId: 1, clientX: 182 });
  assert.equal(overlay.style.width, '60%', 'minor pointer jitter is ignored');
  left.dispatch('pointerup', { pointerId: 1 });
  assert.equal(page.storageWrites.length, 0, 'a bare grip click does not write settings');
  left.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 180 });
  left.dispatch('pointermove', { pointerId: 1, clientX: 270 });
  assert.equal(overlay.style.width, '50%');
  assert.equal(parseFloat(overlay.style.left) + overlay.offsetWidth / 2, 720);
  assert.equal(page.storageWrites.length, 0);
  left.dispatch('pointerup', { pointerId: 2 });
  assert.equal(page.storageWrites.length, 0, 'another pointer cannot finish this resize');
  left.dispatch('pointerup', { pointerId: 1 });
  left.dispatch('lostpointercapture', { pointerId: 1 });
  assert.equal(page.storageWrites.length, 1, 'capture loss after release cannot save twice');
  const saved = page.storageWrites[0];
  assert.equal(saved.overlayWidthPct, 50);
  assert.equal(saved.posYpct, 90);
  assert.equal(saved.origSize, undefined, 'resizing does not change chosen font sizes');
});

test('right-edge resize stays inside the player and enforces a minimum width', async () => {
  const { page, overlay, right } = await mounted();
  right.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 720 });
  right.dispatch('pointermove', { pointerId: 1, clientX: 2000 });
  assert.ok(parseFloat(overlay.style.left) + overlay.offsetWidth / 2 <= 892);
  right.dispatch('pointermove', { pointerId: 1, clientX: -2000 });
  assert.equal(overlay.style.width, '20%');
  assert.equal(parseFloat(overlay.style.left) - overlay.offsetWidth / 2, 180);
  right.dispatch('pointercancel', { pointerId: 1 });
  assert.equal(overlay.hasClass('ytds-resizing'), false);
  assert.equal(page.storageWrites.length, 1);
});

test('keyboard width adjustments and reset stay separate from position changes', async () => {
  const { page, overlay, right } = await mounted();
  right.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(overlay.style.width, '62%');
  assert.deepEqual({ ...page.storageWrites[0] }, { overlayWidthPct: 62 });
  right.dispatch('dblclick');
  assert.equal(overlay.style.width, '');
  assert.equal(page.storageWrites.at(-1).overlayWidthPct, 0);
});
