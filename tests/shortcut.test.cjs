const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function element() {
  return {
    style: { setProperty(name, value) { this[name] = String(value); } },
    textContent: '',
    isConnected: false,
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); child.isConnected = true; },
    addEventListener() {},
    setAttribute() {}
  };
}

async function loadContent(saved) {
  const writes = [];
  const messages = [];
  const listeners = {};
  const player = element();
  player.querySelector = () => null;
  const chrome = {
    i18n: { getMessage: () => '' },
    runtime: { id: 'test-extension-id', onMessage: { addListener(fn) { listeners.message = fn; } },
      sendMessage(msg, done) { writes.push(msg.patch); done({ ok: true }); } },
    storage: {
      onChanged: { addListener(fn) { listeners.storageChanged = fn; } },
      local: { get(_key, done) { done({}); } },
      sync: {
        // Keep highlight migration separate from these shortcut/font checks.
        get(defaults, done) { done({ ...defaults, karaokeStyleV2: true, ...saved }); },
        set(value) { writes.push(value); }
      }
    }
  };
  const document = {
    documentElement: { classList: { toggle() {} } },
    createElement: element,
    querySelectorAll() { return []; },
    querySelector(selector) { return selector === '#movie_player' ? player : null; }
  };
  const context = {
    chrome, document, URL,
    location: { href: 'https://www.youtube.com/watch?v=sample' },
    window: { addEventListener() {}, postMessage(message) { messages.push(message); } },
    setTimeout() { return 1; }, clearTimeout() {},
    setInterval() { return 1; }, clearInterval() {}
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'settings.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), sandbox);
  await new Promise(setImmediate);
  return { writes, messages, listeners, player };
}

test('style changes do not refetch captions and a language change requests them once', async () => {
  const { messages, listeners } = await loadContent({ fontSizeRepair20260926: true });
  assert.equal(messages.filter((message) => message.type === 'config').length, 1);
  listeners.storageChanged({ origColor: { newValue: '#abc123' } }, 'sync');
  assert.equal(messages.filter((message) => message.type === 'config').length, 1);
  listeners.storageChanged({ karaokeBg: { newValue: '#008080' },
    karaokeTextColor: { newValue: '#ffffff' }, karaokeOpacity: { newValue: 1 } }, 'sync');
  assert.equal(messages.filter((message) => message.type === 'config').length, 1,
    'changing highlight style leaves the loaded caption track in place');
  listeners.storageChanged({ targetLang: { newValue: 'de' } }, 'sync');
  assert.equal(messages.filter((message) => message.type === 'config').length, 2);
});

test('Alt+Shift+Y command is registered and sent only to the active tab', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.commands['toggle-translation'].suggested_key.default, 'Alt+Shift+Y');
  const listeners = {};
  const sent = [];
  const chrome = {
    runtime: { id: 'test-extension-id', onMessage: { addListener(fn) { listeners.message = fn; } } },
    commands: { onCommand: { addListener(fn) { listeners.command = fn; } } },
    tabs: {
      onRemoved: { addListener() {} },
      query(query, done) {
        assert.equal(query.active, true);
        done([{ id: 42 }]);
      },
      sendMessage(id, message, done) { sent.push({ id, message }); done(); }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), {
    chrome, Map, importScripts() {}, YtdsSettings: { startSync() {} }
  });
  listeners.command('unrelated');
  assert.equal(sent.length, 0);
  listeners.command('toggle-translation');
  assert.deepEqual(sent.map(({ id, message }) => [id, message.type]), [[42, 'toggleTranslation']]);
});

test('oversized saved fonts are repaired once and translation toggles both ways', async () => {
  const { writes, listeners, player } = await loadContent({
    origSize: 44, transSize: 38, showTranslation: true
  });
  const overlay = player.children[0];
  const [translation, original] = overlay.children;
  assert.equal(original.style.fontSize, '22px');
  assert.equal(translation.style.fontSize, '24px');
  assert.equal(writes[0].origSize, 22);
  assert.equal(writes[0].transSize, 24);
  assert.equal(writes[0].fontSizeRepair20260926, true);

  const responses = [];
  listeners.message({ type: 'toggleTranslation' }, {}, (reply) => responses.push(reply.visible));
  assert.equal(translation.style.display, 'none');
  assert.equal(original.style.display, '');
  listeners.message({ type: 'toggleTranslation' }, {}, (reply) => responses.push(reply.visible));
  assert.equal(translation.style.display, '');
  assert.deepEqual(responses, [false, true]);
  assert.deepEqual(writes.slice(1).map((value) => value.showTranslation), [false, true]);
});

test('later deliberate font choices are preserved', async () => {
  const { writes, player } = await loadContent({
    origSize: 44, transSize: 38, fontSizeRepair20260926: true
  });
  assert.equal(player.children[0].children[1].style.fontSize, '44px');
  assert.equal(player.children[0].children[0].style.fontSize, '38px');
  assert.equal(writes.length, 0);
});

test('first shortcut press restores a previously hidden translation', async () => {
  const { writes, listeners, player } = await loadContent({
    showTranslation: false, fontSizeRepair20260926: true
  });
  const translation = player.children[0].children[0];
  assert.equal(translation.style.display, 'none');
  let reply;
  listeners.message({ type: 'toggleTranslation' }, {}, (result) => { reply = result; });
  assert.equal(translation.style.display, '');
  assert.equal(reply.visible, true);
  assert.equal(writes[0].showTranslation, true);
});
