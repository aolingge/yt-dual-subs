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
  // Credentials belong only to the privileged popup/worker, never page defaults.
  assert.equal(content.bridgeToken, undefined);
  delete popup.bridgeBase;
  delete popup.bridgeToken;
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
  for (const html of ['popup.html', 'alignment.html']) {
    for (const m of read(html).matchAll(/data-i18n(?:-html|-title|-aria|-placeholder)?="([^"]+)"/g)) asked.add(m[1]);
  }
  for (const file of ['popup.js', 'study.js', 'content.js', 'alignment.js']) {
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

test('early page and isolated scripts use different timing paths with identical code', () => {
  const scripts = JSON.parse(read('manifest.json')).content_scripts;
  const hostOf = (s) => s.matches.join(' ');
  const pageFor = (host) => scripts.find((s) => s.world === 'MAIN' && hostOf(s).includes(host));
  const isolatedFor = (host) => scripts.find((s) => s.world !== 'MAIN' && hostOf(s).includes(host));

  // Each platform has exactly one MAIN-world reader: YouTube keeps the original
  // pair in the original order, Bilibili gets its own reader instead of a fork.
  assert.deepEqual(pageFor('youtube.com').js, ['word-timing-page.js', 'inject.js']);
  assert.deepEqual(pageFor('bilibili.com').js, ['bilibili-page.js']);

  for (const host of ['youtube.com', 'bilibili.com']) {
    const page = pageFor(host);
    const isolated = isolatedFor(host);
    assert.ok(page && isolated, 'both worlds are declared for ' + host);
    assert.equal(page.run_at, 'document_start');
    assert.equal(isolated.run_at, 'document_start');
    // site.js is the platform adapter, so it must load before the display stack.
    // srt.js is the local-file parser the adapter's import path hands text to.
    // bridge-client.js and media-clock.js are the local recognizer: the client
    // that talks to the desktop bridge and the clock that keeps recognized text
    // tied to the video's own time. The display stack itself is shared: no
    // per-platform copy of content.js.
    assert.deepEqual(isolated.js, ['site.js', 'srt.js', 'settings.js', 'word-timing.js',
      'bridge-client.js', 'media-clock.js', 'content.js']);
  }
  assert.equal(read('word-timing-page.js'), read('word-timing.js'), 'keep the page copy synchronized');
});

test('audio helper access is optional and limited to the loopback host', () => {
  const manifest = JSON.parse(read('manifest.json'));
  // storage is the base; tabCapture and offscreen are what let the user capture
  // the current tab's audio and keep hearing it while it is recognized.
  assert.deepEqual(manifest.permissions, ['storage', 'tabCapture', 'offscreen']);
  assert.deepEqual(manifest.optional_host_permissions,
    ['http://127.0.0.1/*', 'https://127.0.0.1/*', 'http://localhost/*', 'https://localhost/*']);
  assert.equal(read('alignment.js').includes('credentials: "omit"'), true);
});
