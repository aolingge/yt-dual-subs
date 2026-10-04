const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../capture-health.js'), 'utf8'), sandbox);
const { CaptureHealth } = sandbox.YtdsCaptureHealth;
const snapshot = (health, nowMs, extra = {}) => health.snapshot({ nowMs, contextState: 'running', ...extra });

test('a playing source with zero PCM is a silence notice, recovering on sound', () => {
  const health = new CaptureHealth();
  health.playback({ paused: false, epoch: 0, atMs: 1000 });
  for (let time = 1000; time <= 9000; time += 100) health.observe([0, 0], time);
  assert.equal(snapshot(health, 9000).state, 'silent');
  health.observe([0.05, -0.05], 9100);
  assert.equal(snapshot(health, 9100).state, 'signal');
  assert.equal(snapshot(health, 9100).silenceMs, 0);
  assert.ok(snapshot(health, 9100).rms > 0);
});

test('no worklet callbacks and zero samples are different conditions', () => {
  const health = new CaptureHealth();
  health.playback({ paused: false, epoch: 0, atMs: 1000 });
  assert.equal(snapshot(health, 3999).state, 'waiting');
  assert.equal(snapshot(health, 4000).state, 'missing');
  health.observe([0], 4000);
  assert.equal(snapshot(health, 4000).state, 'waiting');
});

test('pauses do not accumulate silence and resume or seek starts a new window', () => {
  const health = new CaptureHealth();
  health.playback({ paused: true, epoch: 0, atMs: 1000 });
  health.observe([0], 100000);
  assert.equal(snapshot(health, 100000).state, 'paused');
  assert.equal(snapshot(health, 100000).silenceMs, 0);
  health.playback({ paused: false, epoch: 0, atMs: 100000 });
  assert.equal(snapshot(health, 100100).state, 'waiting');
  health.playback({ paused: false, epoch: 1, atMs: 200000 });
  assert.equal(snapshot(health, 200100).state, 'waiting');
});

test('a short quiet passage is not a sustained-silence notice', () => {
  const health = new CaptureHealth();
  health.playback({ paused: false, epoch: 0, atMs: 1000 });
  health.observe([0.1], 1000);
  health.observe([0], 6000);
  assert.equal(snapshot(health, 6000).state, 'waiting');
});

test('context suspension and missing media reports are not presented as silence', () => {
  const health = new CaptureHealth();
  health.playback({ paused: false, epoch: 0, atMs: 1000 });
  assert.equal(snapshot(health, 12000, { contextState: 'suspended' }).state, 'suspended');
  assert.equal(snapshot(health, 12000, { mediaFresh: false }).state, 'waiting_media');
});

test('invalid values cannot produce a signal or nonfinite amplitude', () => {
  const health = new CaptureHealth();
  health.playback({ paused: false, epoch: 0, atMs: 1000 });
  health.observe([NaN, Infinity, -Infinity], 3500);
  assert.equal(snapshot(health, 4000).state, 'missing');
  assert.equal(snapshot(health, 4000).frames, 0);
  health.observe([2, -2, NaN], 5000);
  assert.equal(snapshot(health, 5000).peak, 1);
  assert.equal(snapshot(health, 5000).rms, 1);
});
