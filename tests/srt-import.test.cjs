'use strict';

// Local subtitle files (srt.js). A Bilibili video without a readable Chinese
// caption track is a normal case, not an edge case, so the import path is a
// first-class part of the Bilibili support: these tests pin the conversion from
// a real-world SRT file to the cue format the engine already speaks, and the
// binding key that keeps one part's file off another part.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'srt.js'), 'utf8');

// VM objects carry the VM's prototypes, so compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));

function load() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'srt.js' });
  return sandbox.YtdsSrt;
}

test('a plain SRT file becomes millisecond cues without losing the wording', () => {
  const srt = load();
  const parsed = srt.parse([
    '1',
    '00:00:01,200 --> 00:00:03,700',
    '今天我们来聊聊怎么学习德语。',
    '',
    '2',
    '00:00:03,800 --> 00:00:06,000',
    '首先，你需要每天坚持。',
    ''
  ].join('\n'));

  assert.deepEqual(plain(parsed.cues), [
    { start: 1200, dur: 2500, text: '今天我们来聊聊怎么学习德语。' },
    { start: 3800, dur: 2200, text: '首先，你需要每天坚持。' }
  ]);
  assert.equal(parsed.dropped, 0);
});

test('the parser accepts the time variants real files use', () => {
  const srt = load();
  // A dot decimal mark, a one-digit fraction (0.2s => 200ms) and an hour field
  // that is padded differently.
  const parsed = srt.parse([
    '1',
    '0:00:01.2 --> 0:00:02.5',
    '甲',
    '',
    '2',
    '01:02:03,004 --> 01:02:04,999',
    '乙',
    ''
  ].join('\n'));

  assert.deepEqual(plain(parsed.cues), [
    { start: 1200, dur: 1300, text: '甲' },
    { start: 3723004, dur: 1995, text: '乙' }
  ]);
});

test('styling tags are removed but the sentence keeps its punctuation', () => {
  const srt = load();
  const parsed = srt.parse([
    '1',
    '00:00:01,000 --> 00:00:02,000',
    '{\\an8}<i>今天</i>我们来聊聊，<font color="#fff">怎么学习德语</font>。',
    ''
  ].join('\n'));

  assert.equal(parsed.cues.length, 1);
  assert.equal(parsed.cues[0].text, '今天我们来聊聊，怎么学习德语。');
});

test('empty bodies, duplicate cues and out-of-order blocks are handled and reported', () => {
  const srt = load();
  const parsed = srt.parse([
    '1',
    '00:00:05,000 --> 00:00:06,000',
    '第二句',
    '',
    '2',
    '00:00:05,000 --> 00:00:06,500',
    '第二句',
    '',
    '3',
    '00:00:02,000 --> 00:00:03,000',
    '   ',
    '',
    '4',
    '00:00:01,000 --> 00:00:02,000',
    '第一句',
    '',
    'this block has no timing line at all',
    ''
  ].join('\n'));

  // Sorted by start, the duplicate dropped, and the empty body, the untimed
  // block and the repeated cue all counted so the popup can say what it skipped.
  assert.deepEqual(plain(parsed.cues.map((c) => c.text)), ['第一句', '第二句']);
  assert.deepEqual(plain(parsed.cues.map((c) => c.start)), [1000, 5000]);
  assert.equal(parsed.dropped, 3);
});

test('a file with no usable cue is refused instead of producing an empty track', () => {
  const srt = load();
  assert.equal(srt.parse('no timings here'), null);
  assert.equal(srt.parse(''), null);
  assert.equal(srt.parse(null), null);
  assert.equal(srt.toCues('1\n00:00:01,000 --> 00:00:02,000\n\n'), null);
});

test('a BOM and Windows line endings survive the round trip', () => {
  const srt = load();
  const parsed = srt.parse('\uFEFF1\r\n00:00:00,500 --> 00:00:01,500\r\n你好\r\n');
  assert.deepEqual(plain(parsed.cues), [{ start: 500, dur: 1000, text: '你好' }]);
});

test('the binding key carries the video and the part', () => {
  const srt = load();
  assert.equal(srt.storageKey('BV1xx411c7mD#p1'), 'ytdsSrtV1:BV1xx411c7mD#p1');
  assert.notEqual(srt.storageKey('BV1xx411c7mD#p1'), srt.storageKey('BV1xx411c7mD#p2'));
  assert.equal(srt.storageKey(''), 'ytdsSrtV1:');
});

test('the module is pure and its size limit is finite', () => {
  const srt = load();
  assert.equal(typeof srt.MAX_BYTES, 'number');
  assert.ok(srt.MAX_BYTES > 0 && srt.MAX_BYTES <= 8 * 1024 * 1024);
  // No DOM, no storage, no network: the file's text is all this needs.
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /document\.|chrome\.storage|fetch\(|XMLHttpRequest/);
});
