// Shared harness: boots the REAL content.js inside a fake YouTube page so tests
// can drive it the way the browser does — cue messages from inject.js, storage
// changes, SPA navigation, playback position, and a controllable clock.
//
// No production code is duplicated here: content.js is executed verbatim with
// vm.runInNewContext, so every assertion exercises the shipping source.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
// Read the shipped version instead of hardcoding it, so a version bump needs no
// test edit (the status snapshot reports chrome.runtime.getManifest().version).
const MANIFEST_VERSION = JSON.parse(
  fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')
).version;

function element() {
  // Classes are tracked for real (via a Set) so tests can assert what the karaoke
  // highlight and the reveal modes put on an element, and so className and
  // classList stay consistent the way they do in the browser.
  const classes = new Set();
  const el = {
    style: {}, textContent: '', isConnected: false, children: [],
    classList: {
      add(...names) { names.forEach((n) => classes.add(n)); },
      remove(...names) { names.forEach((n) => classes.delete(n)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      get length() { return classes.size; },
      values() { return [...classes]; }
    },
    hasClass(name) { return classes.has(name); },
    classNames() { return [...classes]; },
    appendChild(child) { this.children.push(child); child.isConnected = true; },
    addEventListener() {}, setAttribute() {}, click() {}, remove() {}
  };
  Object.defineProperty(el, 'className', {
    configurable: true,
    get() { return [...classes].join(' '); },
    set(value) {
      classes.clear();
      String(value || '').split(/\s+/).filter(Boolean).forEach((n) => classes.add(n));
    }
  });
  return el;
}

// A per-mount clock: the 429 backoff and the pending-prefetch delay are the only
// time-dependent rules in content.js, and this lets a test cross them instantly.
function clock(startMs = 1700000000000) {
  let nowMs = startMs;
  const DateProxy = new Proxy(Date, {
    get(target, prop) {
      if (prop === 'now') return () => nowMs;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return {
    Date: DateProxy,
    advance(ms) { nowMs += ms; },
    get now() { return nowMs; }
  };
}

async function mountContent(options = {}) {
  const {
    cues = [], aligned = true, tcues = null, translationPending = false,
    backend = 'tlang', sourceLang = 'de', videoId = 'sample',
    settings = {}, manifestVersion = MANIFEST_VERSION, i18nThrows = false, dead = false
  } = options;

  // Extension-context death (the extension was reloaded/updated while this page
  // stayed open). Every real chrome.* call then throws "Extension context
  // invalidated." — the reported bug — so killContext() makes this fake do the
  // same, and the content script must survive it.
  const state = { dead };
  const invalidated = () => { throw new Error('Extension context invalidated.'); };

  const listeners = {};
  const timers = [];
  const timeouts = [];
  const requests = [];
  const outbound = [];
  const storageWrites = [];
  const location = { href: `https://www.youtube.com/watch?v=${videoId}` };
  const time = clock();
  let nativeCaption = '';
  let nocuesSent = false;

  const video = { currentTime: 0.1, paused: false, playbackRate: 1 };
  const player = element();
  player.querySelector = (selector) => (selector === 'video' ? video : null);
  // A full-viewport player rect, so "is the pointer on the player?" is testable
  // in windowed AND fullscreen layout (in fullscreen the rect IS the viewport).
  player.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720
  });
  const document = {
    hidden: false,
    documentElement: { classList: { toggle() {} } },
    body: element(),
    createElement: element,
    querySelector: (selector) => (selector === '#movie_player' ? player : null),
    querySelectorAll: (selector) => (selector === '.ytp-caption-segment' && nativeCaption
      ? [{ textContent: nativeCaption }] : [])
  };
  const window = {
    addEventListener(type, listener) {
      (listeners[type] = listeners[type] || []).push(listener);
    },
    postMessage(message) { outbound.push(message); }
  };
  const chrome = {
    i18n: {
      getMessage() { if (state.dead || i18nThrows) invalidated(); return ''; }
    },
    runtime: {
      get id() { return state.dead ? undefined : 'test-extension-id'; },
      onMessage: { addListener(fn) { listeners.runtimeMessage = fn; } },
      sendMessage(message, done) {
        if (state.dead) invalidated();
        requests.push({ message, done });
      },
      getManifest() {
        if (state.dead) invalidated();
        return { version: manifestVersion };
      }
    },
    storage: {
      onChanged: { addListener(fn) { listeners.storageChanged = fn; } },
      sync: {
        get(defaults, done) {
          if (state.dead) invalidated();
          done({ ...defaults, backend, fontSizeRepair20260926: true, ...settings });
        },
        set(values) {
          if (state.dead) invalidated();
          storageWrites.push(values);
        }
      }
    }
  };
  class TestURL extends URL {}
  TestURL.createObjectURL = () => 'blob:test';
  TestURL.revokeObjectURL = () => {};

  vm.runInNewContext(fs.readFileSync(path.join(root, 'content.js'), 'utf8'), {
    chrome, document, window, URL: TestURL, Blob, Date: time.Date, location,
    setTimeout(fn) { timeouts.push(fn); return timeouts.length; }, clearTimeout() {},
    setInterval(fn) { timers.push(fn); return timers.length; }, clearInterval() {}
  });
  await new Promise(setImmediate);

  // removeOverlay() detaches the previous overlay, so always read the newest
  // one instead of holding element references captured at mount time.
  // A karaoke line renders as one <span> per word, so read the concatenation of
  // the children when there are any (plain lines set textContent directly).
  function textOf(el) {
    if (!el) return '';
    if (el.children && el.children.length) {
      return el.children.map((c) => c.textContent).join('');
    }
    return el.textContent;
  }

  function overlayLines() {
    const overlay = player.children[player.children.length - 1];
    if (!overlay || overlay.children.length < 2) return { original: '', translation: '' };
    const [translation, original] = overlay.children;
    return { original: textOf(original), translation: textOf(translation) };
  }

  function post(data) {
    for (const listener of listeners.message || []) {
      listener({ source: window, data: {
        source: 'ytds-inject', videoId, sourceLang, ...data
      } });
    }
    return overlayLines();
  }

  function tick() {
    const last = timers[timers.length - 1];
    if (last) last();
    return overlayLines();
  }

  const api = {
    requests, outbound, storageWrites, timers, timeouts, video, player,
    get cueLoopCount() { return timers.length; },
    read: overlayLines,
    tick,
    at(seconds) { video.currentTime = seconds; return tick(); },
    setPaused(value) { video.paused = !!value; return api; },
    setHidden(value) { document.hidden = !!value; return api; },
    advance(ms) { time.advance(ms); return api; },
    fire(type, extra) {
      for (const listener of listeners[type] || []) listener({ type, target: window, ...extra });
      return api;
    },
    // Point the mouse at the player (clientX/clientY inside the fake rect).
    movePointer(clientX = 640, clientY = 360) {
      return api.fire('pointermove', { clientX, clientY });
    },
    seekTo(seconds) { video.currentTime = seconds; api.fire('seeked'); return overlayLines(); },
    navigate(nextVideoId) {
      location.href = `https://www.youtube.com/watch?v=${nextVideoId}`;
      api.fire('yt-navigate-finish');
      return overlayLines();
    },
    changeSettings(changes) {
      const payload = {};
      for (const [key, value] of Object.entries(changes)) payload[key] = { newValue: value };
      if (listeners.storageChanged) listeners.storageChanged(payload, 'sync');
      return api;
    },
    changeLanguage(language) { return api.changeSettings({ targetLang: language }); },
    sendCues(data) { return post({ type: 'cues', ...data }); },
    sendInject(data) { return post(data); },
    updateTranslation(nextCues, nextTcues, nextAligned, nonce) {
      return post({ type: 'cues', translationUpdate: true, cues: nextCues,
        tcues: nextTcues, aligned: nextAligned, nonce });
    },
    nocues() {
      if (!nocuesSent) { nocuesSent = true; post({ type: 'nocues' }); }
      return tick();
    },
    fallback(text) { nativeCaption = text; api.nocues(); return tick(); },
    respond(index, response) { requests[index].done(response); return api; },
    // Simulate the extension being reloaded out from under this page.
    killContext() { state.dead = true; return api; },
    get contextDead() { return state.dead; },
    runtimeMessage(msg) {
      if (listeners.runtimeMessage) listeners.runtimeMessage(msg, {}, () => {});
      return api;
    },
    // Same as runtimeMessage, but returns the reply the content script sent.
    request(msg) {
      let reply = null;
      if (listeners.runtimeMessage) {
        listeners.runtimeMessage(msg, {}, (value) => { reply = value; });
      }
      return reply;
    },
    overlayEl() { return player.children[player.children.length - 1]; },
    originalEl() {
      const overlay = api.overlayEl();
      return overlay && overlay.children.length >= 2 ? overlay.children[1] : null;
    },
    wordSpans() {
      const el = api.originalEl();
      return el && el.children ? el.children.slice() : [];
    },
    activeWordIdx() {
      return api.wordSpans().findIndex((s) => s.classList.contains('ytds-w-on'));
    },
    status() {
      let snapshot = null;
      if (listeners.runtimeMessage) {
        listeners.runtimeMessage({ type: 'status' }, {}, (value) => { snapshot = value; });
      }
      return snapshot;
    },
    exportOriginal() {
      return new Promise((resolve) => {
        listeners.runtimeMessage({ type: 'exportSrt', variant: 'orig' }, {}, resolve);
      });
    },
    exportVariant(variant) {
      return new Promise((resolve) => {
        listeners.runtimeMessage({ type: 'exportSrt', variant }, {}, resolve);
      });
    },
    runDebounce() {
      const last = timeouts[timeouts.length - 1];
      if (last) last();
      return api;
    },
    // Snapshot before running: ensureToggleButton() re-schedules itself whenever
    // the control bar is missing, so draining the live array would never end.
    runTimeouts() {
      const pending = timeouts.splice(0, timeouts.length);
      for (const fn of pending) fn();
      return api;
    },
    settle() { return new Promise(setImmediate); }
  };

  post({ type: 'cues', aligned, cues, tcues, translationPending });
  return api;
}

module.exports = { element, mountContent, MANIFEST_VERSION };
