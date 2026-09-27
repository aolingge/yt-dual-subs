// Contracts between the files that must stay in step: the shared settings
// defaults, the popup's element ids, and the localization keys. These are the
// mistakes no runtime test can catch, because they only show up as a blank
// control or an untranslated label in the popup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function defaultsOf(source) {
  const start = source.indexOf('const DEFAULTS = {');
  assert.notEqual(start, -1, 'DEFAULTS literal not found');
  let depth = 0;
  let i = source.indexOf('{', start);
  const from = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) { i++; break; }
  }
  return vm.runInNewContext('(' + source.slice(from, i) + ')');
}

test('the content script and the popup agree on every setting and its default', () => {
  const content = defaultsOf(read('content.js'));
  const popup = defaultsOf(read('popup.js'));
  // spread out of the vm realm so the comparison is about values
  assert.deepEqual({ ...content }, { ...popup });
});

test('every element the popup script touches exists in the popup markup', () => {
  const ids = new Set([...read('popup.html').matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const referenced = new Set();
  for (const file of ['popup.js', 'study.js']) {
    for (const m of read(file).matchAll(/\$\("([^"]+)"\)|\$study\("([^"]+)"\)|getElementById\("([^"]+)"\)/g)) {
      referenced.add(m[1] || m[2] || m[3]);
    }
  }
  assert.ok(referenced.size > 10, 'the popup wiring was actually scanned');
  assert.deepEqual([...referenced].filter((id) => !ids.has(id)).sort(), []);
});

test('every localized string the extension asks for exists in all three locales', () => {
  const locales = {};
  for (const name of ['en', 'zh_CN', 'zh_TW']) {
    locales[name] = JSON.parse(read(path.join('_locales', name, 'messages.json')));
  }
  const asked = new Set();
  for (const m of read('popup.html').matchAll(/data-i18n(?:-html|-title|-aria)?="([^"]+)"/g)) {
    asked.add(m[1]);
  }
  for (const file of ['popup.js', 'study.js', 'content.js']) {
    for (const m of read(file).matchAll(/\bt\(\s*["']([A-Za-z0-9_]+)["']/g)) asked.add(m[1]);
  }
  assert.ok(asked.size > 20, 'the localization scan found the UI strings');
  const missing = [];
  for (const key of asked) {
    for (const name of Object.keys(locales)) if (!locales[name][key]) missing.push(`${name}:${key}`);
  }
  assert.deepEqual(missing.sort(), []);
});

test('the manifest keeps a three-part version the popup can display', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});
