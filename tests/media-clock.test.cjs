'use strict';

// Media time for captured audio (media-clock.js).
//
// The rule under test is the one the task book is strictest about: a caption's
// time comes from the video timeline, never from a clock reading or from when
// an answer arrived. Everything here checks that the clock says "I don't know"
// instead of guessing, and that it tells the caller when the mapping broke.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'media-clock.js'), 'utf8');

function load() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'media-clock.js' });
  return sandbox.YtdsMediaClock;
}

test('an unobserved clock admits it does not know the media time', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  assert.equal(clock.ready, false);
  assert.equal(clock.mediaAt(1000), null);
  assert.equal(clock.predict(1000), null);
});

test('nothing is invented from wall-clock time alone', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  // A long time passes with no page report: the clock must stay silent.
  assert.equal(clock.mediaAt(0), null);
  assert.equal(clock.mediaAt(600000), null);
  assert.equal(clock.ready, false);
});

test('the first report is the authority and is not called a jump', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const verdict = clock.observe({ mediaMs: 90000, wallMs: 5000, rate: 1, paused: false });
  assert.equal(verdict.epoch, 0);
  assert.equal(verdict.jumped, false);
  assert.equal(verdict.rateChanged, false);
  assert.equal(clock.ready, true);
  assert.equal(clock.mediaAt(5000), 90000);
});

test('between reports the position is carried at the reported rate', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  clock.observe({ mediaMs: 90000, wallMs: 5000, rate: 1, paused: false });
  assert.equal(clock.mediaAt(6000), 91000);
  clock.observe({ mediaMs: 91000, wallMs: 6000, rate: 2, paused: false });
  // 500 ms of wall time at double speed is one second of video.
  assert.equal(clock.mediaAt(6500), 92000);
});

test('a paused video does not advance while wall time does', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  clock.observe({ mediaMs: 90000, wallMs: 5000, rate: 1, paused: true });
  assert.equal(clock.mediaAt(8000), 90000);
  assert.equal(clock.mediaAt(60000), 90000);
});

test('a jump beyond tolerance opens a new epoch', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  clock.observe({ mediaMs: 90000, wallMs: 5000, rate: 1, paused: false });
  const verdict = clock.observe({ mediaMs: 300000, wallMs: 5100, rate: 1, paused: false });
  assert.equal(verdict.jumped, true);
  assert.equal(verdict.restarted, true);
  assert.equal(verdict.epoch, 1);
  assert.equal(clock.epoch, 1);
  // The new epoch is the authority immediately: later audio times off it.
  assert.equal(clock.mediaAt(5200), 300100);
});

test('a small disagreement stays in the same epoch', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  clock.observe({ mediaMs: 90000, wallMs: 5000, rate: 1, paused: false });
  const verdict = clock.observe({ mediaMs: 90200, wallMs: 5100, rate: 1, paused: false });
  assert.equal(verdict.jumped, false);
  assert.equal(verdict.restarted, false);
  assert.equal(clock.epoch, 0);
});

test('a rate change opens a new epoch without calling it a seek', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  clock.observe({ mediaMs: 90000, wallMs: 5000, rate: 1, paused: false });
  const verdict = clock.observe({ mediaMs: 90000, wallMs: 5000, rate: 1.5, paused: false });
  assert.equal(verdict.rateChanged, true);
  assert.equal(verdict.restarted, true);
  assert.equal(verdict.jumped, false);
  assert.equal(clock.epoch, 1);
});

test('a seek while paused is caught even though the pause hides drift', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  clock.observe({ mediaMs: 90000, wallMs: 5000, rate: 1, paused: true });
  // One millisecond of movement while paused already contradicts the page.
  const verdict = clock.observe({ mediaMs: 90001, wallMs: 9000, rate: 1, paused: true });
  assert.equal(verdict.jumped, true);
  assert.equal(clock.epoch, 1);
});

test('a long pause and resume restarts the stream without inventing an epoch', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  clock.observe({ mediaMs: 90000, wallMs: 5000, rate: 1, paused: false });
  clock.observe({ mediaMs: 90500, wallMs: 5500, rate: 1, paused: true });
  const verdict = clock.observe({ mediaMs: 90500, wallMs: 12000, rate: 1, paused: false });
  assert.equal(verdict.resumed, true);
  assert.equal(verdict.restarted, true);
  assert.equal(verdict.jumped, false);
  assert.equal(verdict.rateChanged, false);
  assert.equal(clock.epoch, 0);
});

test('a declared page epoch wins and is adopted', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  clock.observe({ mediaMs: 90000, wallMs: 5000, rate: 1, paused: false, epoch: 4 });
  assert.equal(clock.epoch, 4);
  const verdict = clock.observe({ mediaMs: 90000, wallMs: 5050, rate: 1, paused: false, epoch: 5 });
  assert.equal(verdict.jumped, true);
  assert.equal(verdict.epoch, 5);
});

test('a malformed report is refused instead of poisoning the mapping', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  const verdict = clock.observe({ mediaMs: NaN, wallMs: 5000 });
  assert.equal(verdict.jumped, false);
  assert.equal(clock.ready, false);
  const stillClosed = clock.observe({ mediaMs: 1000 });
  assert.equal(stillClosed.jumped, false);
  assert.equal(clock.ready, false);
});

test('reset forgets everything, including the epoch', () => {
  const { MediaClock } = load();
  const clock = new MediaClock();
  clock.observe({ mediaMs: 90000, wallMs: 5000, rate: 2, paused: false });
  clock.reset();
  assert.equal(clock.ready, false);
  assert.equal(clock.epoch, 0);
  assert.equal(clock.rate, 1);
  assert.equal(clock.paused, true);
  assert.equal(clock.mediaAt(9999), null);
});
