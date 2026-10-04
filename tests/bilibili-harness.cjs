'use strict';
// ============================================================================
// Test harness for the Bilibili side of the extension.
//
// It boots the REAL `site.js` (isolated world) and the REAL
// `bilibili-page.js` (page world) inside throw-away VM contexts, with a tiny
// DOM and a controllable pair of network hooks, so the tests exercise the
// shipping code instead of a copy of it.
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function read(name) {
  return fs.readFileSync(path.join(ROOT, name), 'utf8');
}

// ---- a DOM just big enough for the selectors the two scripts use -----------

function matchesSimple(el, simple) {
  const sel = simple.trim();
  if (!sel) return false;
  const idMatch = sel.match(/^#([\w-]+)$/);
  if (idMatch) return el.id === idMatch[1];
  const clsMatch = sel.match(/^\.([\w-]+)$/);
  if (clsMatch) return el.hasClass(clsMatch[1]);
  const attrMatch = sel.match(/^([\w-]+)?\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
  if (attrMatch) {
    if (attrMatch[1] && el.tagName !== attrMatch[1].toUpperCase()) return false;
    const value = el.getAttribute(attrMatch[2]);
    if (value == null) return false;
    return attrMatch[3] === undefined ? true : value === attrMatch[3];
  }
  if (/^[\w-]+$/.test(sel)) return el.tagName === sel.toUpperCase();
  return false;
}

function matches(el, selector) {
  return String(selector).split(',').some((part) => matchesSimple(el, part));
}

function walk(el, out) {
  for (const child of el.children) {
    out.push(child);
    walk(child, out);
  }
  return out;
}

function node(tag, opts = {}) {
  const classes = new Set(String(opts.className || '').split(/\s+/).filter(Boolean));
  const attrs = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    id: opts.id || '',
    children: [],
    parentElement: null,
    isConnected: true,
    innerText: opts.innerText || '',
    textContent: opts.textContent || '',
    style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
    listeners: Object.create(null),
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
    },
    hasClass: (name) => classes.has(name),
    get className() { return [...classes].join(' '); },
    set className(value) {
      classes.clear();
      String(value || '').split(/\s+/).filter(Boolean).forEach((n) => classes.add(n));
    },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    removeAttribute(name) { attrs.delete(name); },
    hasAttribute(name) { return attrs.has(name); },
    addEventListener(type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    removeEventListener() {},
    appendChild(child) { child.parentElement = el; el.children.push(child); return child; },
    insertBefore(child) { child.parentElement = el; el.children.unshift(child); return child; },
    remove() {
      if (el.parentElement) {
        const i = el.parentElement.children.indexOf(el);
        if (i >= 0) el.parentElement.children.splice(i, 1);
      }
      el.isConnected = false;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540 }),
    querySelector(sel) { return walk(el, []).find((x) => matches(x, sel)) || null; },
    querySelectorAll(sel) { return walk(el, []).filter((x) => matches(x, sel)); },
    closest(sel) {
      let cur = el;
      while (cur) {
        if (matches(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    click() { (el.listeners.click || []).forEach((fn) => fn({ type: 'click' })); },
    contains(other) { return other === el || walk(el, []).indexOf(other) >= 0; },
  };
  return el;
}

// A Bilibili watch page: the video box, the control bar and the native
// caption container, with the class names verified from the player bundle.
function bilibiliDom({ captionText = '今天我们来聊聊怎么学习德语。', controlsHidden = false } = {}) {
  const documentElement = node('html');
  const body = node('body');
  const player = node('div', { id: 'bilibili-player', className: 'bpx-player-container' });
  const videoWrap = node('div', { className: 'bpx-player-video-wrap' });
  const video = node('video');
  video.paused = false;
  video.readyState = 4;
  video.currentTime = 1.5;
  const dmWrap = node('div', { className: 'bpx-player-dm-mask-wrap' });
  const controlWrap = node('div', { className: 'bpx-player-control-wrap' });
  const controlsRight = node('div', { className: 'bpx-player-control-bottom-right' });
  const subtitlesButton = node('button', { className: 'bpx-player-ctrl-btn' });
  subtitlesButton.setAttribute('aria-label', '字幕');
  const subtitleWrap = node('div', { className: 'bpx-player-subtitle-wrap' });
  subtitleWrap.innerText = captionText;
  subtitleWrap.textContent = captionText;
  controlsRight.appendChild(subtitlesButton);
  controlWrap.appendChild(controlsRight);
  videoWrap.appendChild(video);
  player.appendChild(videoWrap);
  player.appendChild(dmWrap);
  player.appendChild(controlWrap);
  player.appendChild(subtitleWrap);
  if (controlsHidden) player.setAttribute('data-ctrl-hidden', 'true');
  body.appendChild(player);
  documentElement.appendChild(body);

  const document = {
    documentElement,
    body,
    title: '测试视频_哔哩哔哩_bilibili',
    listeners: Object.create(null),
    querySelector: (sel) => documentElement.querySelector(sel),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    createElement: (tag) => node(tag),
    addEventListener(type, fn) { (document.listeners[type] = document.listeners[type] || []).push(fn); },
    removeEventListener() {},
  };

  return { document, documentElement, body, player, videoWrap, video, controlWrap, controlsRight, subtitlesButton, subtitleWrap };
}

// ---- isolated world: site.js ----------------------------------------------

function mountSite(url, dom) {
  const parts = new URL(url);
  const timers = [];
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.location = {
    href: url,
    hostname: parts.hostname,
    pathname: parts.pathname,
    search: parts.search,
  };
  sandbox.document = (dom || bilibiliDom()).document;
  sandbox.URL = URL;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.setInterval = (fn) => { timers.push(fn); return timers.length; };
  sandbox.clearInterval = () => {};
  sandbox.addEventListener = () => {};
  sandbox.console = console;
  vm.createContext(sandbox);
  vm.runInContext(read('site.js'), sandbox, { filename: 'site.js' });
  return { site: sandbox.YtdsSite, sandbox, timers };
}

// ---- page world: bilibili-page.js -----------------------------------------

// `respond(url)` returns one of:
//   { body: "<text>" }                  a 200 text response
//   { buffer: Uint8Array }              a 200 binary response
//   { status: 404 }                     an error status
//   { throws: "message" }               a network failure
//   undefined                           -> 404
function mountReader({
  url = 'https://www.bilibili.com/video/BV1xx411c7mD/?p=1',
  initialState = null,
  respond = null,
  dom = null,
} = {}) {
  const parts = new URL(url);
  const messages = [];
  const requests = [];
  const timers = [];
  const deferred = [];
  const listeners = Object.create(null);

  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.location = {
    href: url,
    hostname: parts.hostname,
    pathname: parts.pathname,
    search: parts.search,
    toString() { return url; },
  };
  sandbox.document = (dom || bilibiliDom()).document;
  sandbox.URL = URL;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.TextDecoder = TextDecoder;
  sandbox.Uint8Array = Uint8Array;
  sandbox.ArrayBuffer = ArrayBuffer;
  sandbox.atob = (text) => Buffer.from(text, 'base64').toString('binary');
  sandbox.console = console;
  sandbox.postMessage = (message) => { messages.push(message); };
  sandbox.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms, fired: false }); return timers.length; };
  sandbox.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  sandbox.PerformanceObserver = class { constructor() {} observe() {} disconnect() {} };
  sandbox.XMLHttpRequest = class { open() {} send() {} };
  if (initialState) sandbox.__INITIAL_STATE__ = initialState;

  sandbox.fetch = (input, init) => {
    const target = String(input);
    const spec = respond ? respond(target) : null;
    requests.push({ url: target, credentials: init && init.credentials });
    if (!spec) return Promise.resolve(fakeResponse(404, ''));
    if (spec.throws) return Promise.reject(new Error(spec.throws));
    if (spec.defer) {
      return new Promise((resolve) => { deferred.push({ url: target, resolve }); });
    }
    return Promise.resolve(fakeResponse(spec.status || 200, spec.body || '', spec.buffer));
  };

  vm.createContext(sandbox);
  vm.runInContext(read('bilibili-page.js'), sandbox, { filename: 'bilibili-page.js' });
  // Inside a VM context, `window` is the context's global proxy rather than the
  // raw sandbox object, and the reader checks `evt.source === window`. Use the
  // context's own `window` as the event source so that check behaves as it does
  // in a real page.
  const pageWindow = vm.runInContext('window', sandbox);

  const api = {
    sandbox,
    messages,
    requests,
    timers,
    readState: () => sandbox.__INITIAL_STATE__,
    /** Every message the reader posted to content.js, in order. */
    posted: (type) => messages.filter((m) => (type ? m.type === type : true)),
    last: (type) => {
      const list = api.posted(type);
      return list.length ? list[list.length - 1] : null;
    },
    /** Ask the reader to start, exactly as content.js does. */
    configure(extra = {}) {
      const data = {
        source: 'ytds-content',
        type: 'config',
        targetLang: 'de',
        trackId: '',
        nonce: 1,
        ...extra,
      };
      (listeners.message || []).forEach((fn) => fn({ source: pageWindow, data }));
      return api;
    },
    /** Simulate the page navigating to another part or video. */
    navigate(nextUrl) {
      const next = new URL(nextUrl);
      sandbox.location.href = nextUrl;
      sandbox.location.pathname = next.pathname;
      sandbox.location.search = next.search;
      sandbox.location.hostname = next.hostname;
      return api;
    },
    dispatchMessage(data) {
      (listeners.message || []).forEach((fn) => fn({ source: pageWindow, data }));
    },
    runTimers() {
      const pending = timers.filter((t) => !t.fired && !t.cleared);
      pending.forEach((t) => { t.fired = true; t.fn(); });
      return pending.length;
    },
    /** Number of requests the reader started but that are still unanswered. */
    deferredCount: () => deferred.length,
    /** Answer a deferred request (the first one whose URL matches). */
    release(match, spec = {}) {
      const i = deferred.findIndex((d) => (typeof match === 'function' ? match(d.url) : d.url.includes(match)));
      if (i < 0) throw new Error('no deferred request matching ' + match);
      const [entry] = deferred.splice(i, 1);
      entry.resolve(fakeResponse(spec.status || 200, spec.body || '', spec.buffer));
      return api;
    },
  };
  return api;
}

function fakeResponse(status, body, buffer) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    arrayBuffer: async () => buffer || new Uint8Array(0).buffer,
    clone() { return this; },
  };
}

/** Let every pending promise callback run. */
async function flush(times = 4) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
}

module.exports = { read, node, bilibiliDom, mountSite, mountReader, flush, ROOT };
