const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const scope = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'study-export.js'), 'utf8'), scope);
const api = scope.YtdsStudyExport;
test('saved links keep Bilibili parts and YouTube times', () => {
  assert.equal(api.videoLink('BV1xx411c7mD#p2', 12345), 'https://www.bilibili.com/video/BV1xx411c7mD/?p=2&t=12');
  assert.equal(api.videoLink('dQw4w9WgXcQ', 12345), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12s');
  assert.equal(api.videoLink('https://evil.example', 0), '');
  assert.equal(api.videoLink('BV1xx411c7mD#p0', 0), '');
});
test('Anki export preserves UTF-8, escapes HTML/line breaks/tabs and removes duplicates', () => {
  const card = { videoId: 'BV1xx411c7mD#p2', start: 12345, text: 'Hallo\t世界\n<script>',
    trans: '翻译 & Erklärung', title: 'Test', sourceLang: 'de', known: false };
  const tsv = api.toAnkiTsv([card, card]);
  const lines = tsv.trimEnd().split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[4].split('\t').length, 9);
  assert.match(tsv, /Hallo&#9;世界<br>&lt;script&gt;/);
  assert.match(tsv, /翻译 &amp; Erklärung/);
  assert.match(tsv, /yt_dual_subs bilibili lang_de review/);
  assert.match(tsv, /\?p=2&amp;t=12/);
});

test('persisted identity and review metadata survive correction and export', () => {
  const raw = { id: 'ytds:00000000-0000-4000-8000-000000000001', videoId: 'speechde001',
    start: 1000, index: 0, text: 'Guten Tag', rawOriginal: 'Guten Tak', uncertain: true,
    corrected: true, uncertaintyReasons: ['low_log_probability'], sourceLang: 'de' };
  const first = api.readCard(raw), edited = api.readCard({ ...raw, text: 'Guten Tag!' });
  assert.equal(first.id, raw.id);
  assert.equal(edited.id, first.id);
  assert.equal(edited.rawOriginal, raw.rawOriginal);
  assert.equal(edited.uncertain, true);
  assert.equal(edited.corrected, true);
  assert.equal(api.toAnkiTsv([first]).trimEnd().split('\n').at(-1).split('\t')[0],
    api.toAnkiTsv([edited]).trimEnd().split('\n').at(-1).split('\t')[0]);
});

test('source limits match correction and untrusted metadata is bounded', () => {
  const base = { videoId: 'speechde001', start: 1000, index: 0 };
  assert.ok(api.readCard({ ...base, text: 'x'.repeat(2000) }));
  assert.equal(api.readCard({ ...base, text: 'x'.repeat(2001) }), null);
  const normalized = api.readCard({ ...base, text: 'Hallo', rawOriginal: 'x'.repeat(9999),
    id: 'evil\tnew-column', uncertaintyReasons: ['x'.repeat(9999)], corrected: 'true' });
  assert.ok(normalized.rawOriginal.length <= 2000);
  assert.equal(normalized.corrected, false);
  assert.ok(!normalized.id.includes('\t'));
});
