// Isolated-browser verification for the Bilibili support.
//
//   node tools/verify-bilibili.mjs
//
// It launches a SEPARATE Edge with its own throwaway profile and the extension
// loaded unpacked, then drives it over the DevTools protocol. It never touches
// the Edge you are working in and never reads your real browser profile.
//
// Two things are checked, and they are reported separately:
//   1. A REAL Bilibili video page (YTDS_VIDEO overrides it). It proves the
//      reader talks to the live site, picks a Chinese track and converts its
//      cue times — or reports an honest reason when the site offers no readable
//      track without a login.
//   2. A CONTROLLED bilibili.com/video page, served through request
//      interception, which drives the whole pipeline with fixed caption data:
//      metadata, cue body, cue conversion, the two overlay lines and their
//      order, and the labelled approximate follow-along.
//
// Everything the extension itself needs is real: only the network answers are
// supplied, so the run says nothing about Bilibili's live caption availability.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EDGE = process.platform === "win32"
  ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  : "/usr/bin/microsoft-edge";
const EDGE = process.env.YTDS_EDGE || DEFAULT_EDGE;
const EXT = process.env.YTDS_EXT || path.resolve(HERE, "..");
const PROFILE = process.env.YTDS_PROFILE
  || path.join(os.tmpdir(), "ytds-edge-profile-" + process.pid + "-" + Date.now());
const PORT = Number(process.env.YTDS_CDP_PORT || 9333);
const REAL_VIDEO = process.env.YTDS_VIDEO || "https://www.bilibili.com/video/BV1GJ411x7h7/";
const REPORT = process.env.YTDS_REPORT || path.join(HERE, "verify-bilibili-report.json");
const CHECK_CONTROLS = process.env.YTDS_CONTROLS === "1";
// Headless browsers can still send real audio to the workstation's speakers.
// Mute only this isolated browser; retain media decoding and playback timing.
const AUDIBLE_TEST = process.env.YTDS_TEST_AUDIO === "1";

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.events = []; }
  static async attach(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.waiting.has(msg.id)) {
        const { resolve, reject, timer } = cdp.waiting.get(msg.id);
        clearTimeout(timer);
        cdp.waiting.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        cdp.events.push(msg);
      }
    };
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error(method + " timed out")); }
      }, 20000);
      this.waiting.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() {
    for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error("CDP connection closed")); }
    this.waiting.clear();
    try { this.ws.close(); } catch (_e) {}
  }
}

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch (_e) { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("the isolated browser never opened its debugging port");
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

// ---- the controlled page --------------------------------------------------
// A page under the real match pattern that carries the player-shaped DOM the
// adapter looks for, and that answers the two requests the reader makes.
const CONTROLLED_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>controlled bilibili page</title>
<script>
  // The real page's server-rendered state, in the shape the reader looks for.
  // It sits in the head because a main-world script runs at document_start.
  window.__INITIAL_STATE__ = {
    videoData: {
      bvid: "BV1xx411c7mD", aid: 12345, cid: 222,
      subtitle: { list: [] },
      pages: [
        { cid: 111, page: 1, part: "第一话" },
        { cid: 222, page: 2, part: "第二话" }
      ]
    }
  };
<\/script>
<style>
  html, body { margin: 0; background: #0f1115; }
  .bpx-player-container { position: relative; width: 960px; height: 540px;
    margin: 24px auto; background: #11151c; overflow: hidden; }
  .bpx-player-video-wrap { position: absolute; inset: 0; }
  .bpx-player-video-wrap video { width: 100%; height: 100%; object-fit: contain;
    background: #11151c; }
  .bpx-player-control-wrap { position: absolute; left: 0; right: 0; bottom: 0;
    height: 48px; background: rgba(0, 0, 0, 0.45); }
  .bpx-player-control-bottom-right { display: flex; align-items: center;
    justify-content: flex-end; height: 48px; padding: 0 12px; }
  .bpx-player-ctrl-btn { color: white; background: transparent; border: 0;
    min-width: 40px; height: 32px; }
</style>
</head>
<body>
<div id="bilibili-player" class="bpx-player-container">
  <div class="bpx-player-video-wrap">
    <video src="/ytds-sample.wav" muted autoplay playsinline></video>
  </div>
  <div class="bpx-player-subtitle-wrap"></div>
  <div class="bpx-player-control-wrap">
    <div class="bpx-player-control-bottom-right">
      <button class="bpx-player-ctrl-btn" aria-label="倍速">1.25x</button>
      <button class="bpx-player-ctrl-btn" aria-label="字幕">字幕</button>
      <button class="bpx-player-ctrl-btn" aria-label="设置">设置</button>
      <button class="bpx-player-ctrl-btn" aria-label="全屏">全屏</button>
    </div>
  </div>
</div>
<script>
  // A silent WAV gives the extension a real, advancing clock. Overriding
  // currentTime on the element would not work: each world gets its own JS
  // wrapper for a DOM node, so an own property never crosses the boundary.
  var v0 = document.querySelector('video');
  if (v0) { v0.muted = true; var pr = v0.play(); if (pr && pr.catch) pr.catch(function () {}); }
<\/script>
</body></html>`;

// A silent 8 kHz mono 8-bit WAV. It is real media, so the browser reports a
// genuine paused/currentTime/duration — which is what the overlay syncs to.
function makeWav(seconds) {
  const rate = 8000;
  const data = Buffer.alloc(rate * seconds, 128);   // 128 = silence
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVE", 8);
  head.write("fmt ", 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);        // PCM
  head.writeUInt16LE(1, 22);        // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate, 28);     // byte rate
  head.writeUInt16LE(1, 32);        // block align
  head.writeUInt16LE(8, 34);        // bits per sample
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const DIAG = `JSON.stringify({  readerLoaded: !!window.__ytdsBiliLoaded,
  initialState: !!window.__INITIAL_STATE__,
  bvid: window.__INITIAL_STATE__ && window.__INITIAL_STATE__.videoData
    ? window.__INITIAL_STATE__.videoData.bvid : null,
  player: !!document.querySelector('.bpx-player-container'),
  video: !!document.querySelector('video'),
  overlay: !!document.querySelector('#ytds-overlay'),
  origWords: document.querySelectorAll('#ytds-overlay .ytds-orig .ytds-w').length,
  origWordOn: document.querySelectorAll('#ytds-overlay .ytds-orig .ytds-w-on').length,
  karaokeClasses: (function () { var o = document.querySelector('#ytds-overlay');
    if (!o) return null; return [...o.classList].filter(function (c) {
      return c.indexOf('ytds-karaoke') === 0; }); })(),
  sourceBadge: (function () { var l = document.querySelector('#ytds-overlay .ytds-orig');
    if (!l) return null;
    var s = getComputedStyle(l, '::before');
    return { content: s.content, opacity: s.opacity }; })(),
  time: (function () { var v = document.querySelector('video'); return v ? v.currentTime : null; })()
})`;

// Which caption tracks the controlled page reports. The default set has an
// English track with no file, a human Chinese track and an auto-generated one,
// so the preference order can be observed. YTDS_TRACKS=ai leaves only the
// auto-generated Chinese track, and YTDS_TRACKS=none leaves no Chinese track at
// all, which must be reported as "captions exist, none is Chinese".
const TRACKS = {
  all: [
    { id: 1, id_str: "1", lan: "en-US", lan_doc: "English(US)", subtitle_url: "", type: 0, ai_type: 0, ai_status: 0 },
    { id: 2, id_str: "2", lan: "zh-CN", lan_doc: "中文（中国）", subtitle_url: "https://i0.hdslb.com/bfs/subtitle/controlled-zh.json", type: 0, ai_type: 0, ai_status: 0 },
    { id: 3, id_str: "3", lan: "zh-Hans", lan_doc: "中文（简体）", subtitle_url: "https://i0.hdslb.com/bfs/subtitle/controlled-zh.json", type: 1, ai_type: 1, ai_status: 0 }
  ],
  ai: [
    { id: 1, id_str: "1", lan: "en-US", lan_doc: "English(US)", subtitle_url: "", type: 0, ai_type: 0, ai_status: 0 },
    { id: 3, id_str: "3", lan: "zh-Hans", lan_doc: "中文（简体）", subtitle_url: "https://i0.hdslb.com/bfs/subtitle/controlled-zh.json", type: 1, ai_type: 1, ai_status: 0 }
  ],
  none: [
    { id: 1, id_str: "1", lan: "en-US", lan_doc: "English(US)", subtitle_url: "", type: 0, ai_type: 0, ai_status: 0 }
  ],
  empty: []
}[process.env.YTDS_TRACKS || "all"];

const TRACK_JSON = JSON.stringify({
  code: 0,
  data: {
    subtitle: {
      allow_submit: false,
      subtitles: TRACKS
    }
  }
});

const CUE_JSON = JSON.stringify({
  body: [
    { from: 0.2, to: 3.0, location: 2, content: "今天我们来聊聊怎么学习德语。" },
    { from: 3.2, to: 5.2, location: 2, content: "第一步是每天听十分钟。" }
  ]
});

// The imported file's text is deliberately different from the page's captions,
// so a display of the page's own cues cannot be mistaken for the imported file.
const SRT_STORE_KEY = "ytdsSrtV1:BV1xx411c7mD#p2";
const SRT_TEXT = [
  "1",
  "00:00:00,200 --> 00:00:03,000",
  "导入的字幕第一句。",
  "",
  "2",
  "00:00:03,200 --> 00:00:05,200",
  "导入的字幕第二句。",
  ""
].join("\n");

async function main() {
  const report = { steps: [], controlled: null, real: null, errors: [], audioOutput: AUDIBLE_TEST ? "audible" : "muted" };
  const WAV = makeWav(20);
  let occupied = false;
  try { await fetch(`http://127.0.0.1:${PORT}/json/version`); occupied = true; } catch (_e) {}
  if (occupied) throw new Error("The debugging port is already in use; choose another YTDS_CDP_PORT.");
  if (fs.existsSync(PROFILE) && fs.readdirSync(PROFILE).length) {
    throw new Error("Use a new or empty isolated YTDS_PROFILE directory.");
  }
  fs.mkdirSync(PROFILE, { recursive: true });

  const child = spawn(EDGE, [
    "--headless=new",
    ...(!AUDIBLE_TEST ? ["--mute-audio"] : []),
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + PROFILE,
    "--disable-extensions-except=" + EXT,
    "--load-extension=" + EXT,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1280,800",
    "about:blank"
  ], { stdio: "ignore", detached: false });

  let ok = false;
  let browserConnection = null;
  try {
    const version = await waitForDevtools();
    browserConnection = await Cdp.attach(version.webSocketDebuggerUrl);
    report.browser = version.Browser;
    report.steps.push("isolated browser started on port " + PORT);

    // The extension's own targets prove the manifest was accepted.
    await sleep(2500);
    const list = await targets();
    report.targets = list.map((t) => t.type + " " + (t.title || t.url).slice(0, 90));
    let sw = null;
    let worker = null;
    for (const target of list.filter((t) => t.type === "service_worker" &&
        t.url.startsWith("chrome-extension://") && t.url.endsWith("/background.js"))) {
      const candidate = await Cdp.attach(target.webSocketDebuggerUrl);
      const ours = await candidate.evaluate(`chrome.runtime.getManifest().content_scripts?.some(
        s => s.matches.includes('https://www.bilibili.com/video/*'))`);
      if (ours) { sw = target; worker = candidate; break; }
      candidate.close();
    }
    report.extensionLoaded = !!sw;
    report.steps.push(sw ? "extension loaded: " + sw.url.slice(0, 60)
                         : "NO extension target found");
    if (CHECK_CONTROLS) {
      if (!worker) throw new Error("The YT Dual Subs service worker was not found.");
      await worker.evaluate(`chrome.storage.sync.set({enabled:true, targetLang:'zh-CN',
        order:'orig-top', bbEnabled:true, bbTargetLang:'zh-CN', bbOrder:'orig-top'})`);
      report.steps.push("seeded the old Chinese-to-Chinese settings");
    }

    // ---- 1. the real Bilibili video page ---------------------------------
    const page = (await targets()).find((t) => t.type === "page");
    const cdp = await Cdp.attach(page.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");

    // Record what the page-world reader posts, so the probe can seek into a cue.
    const RECORD = `window.__probe = [];
      window.addEventListener('message', function (e) {
        var d = e.data || {};
        if (!d.source) return;
        try {
          window.__probe.push({ src: d.source, type: d.type, nonce: d.nonce,
            videoId: d.videoId, reason: d.reason,
            n: d.cues ? d.cues.length : 0, first: d.cues ? d.cues.slice(0, 4) : null });
        } catch (_e) {}
      }, true);`;

    // Play from inside the first real cue: a paused player at t=0 sits before
    // the first subtitle and would legitimately show nothing.
    const SEEK = `(() => {
      const post = (window.__probe || []).filter((p) => p.type === 'cues' && p.n).pop();
      const v = document.querySelector('video');
      if (!v) return 'no video element';
      if (!post) return 'no cues were posted';
      const cue = post.first.find((c) => c.start > 0) || post.first[0];
      v.currentTime = cue.start / 1000 + 0.2;
      v.dispatchEvent(new Event('seeked', { bubbles: true }));
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
      return 'seeked to ' + (cue.start / 1000 + 0.2) + 's; cue text: ' + cue.text;
    })()`;

    const probe = `(() => {
      const overlay = document.querySelector('#ytds-overlay');
      const player = document.querySelector('#bilibili-player') || document.querySelector('.bpx-player-container');
      const lines = overlay ? [...overlay.querySelectorAll('.ytds-line')] : [];
      return {
        url: location.href,
        player: !!player,
        video: !!document.querySelector('video'),
        overlay: !!overlay,
        attachedTo: overlay && overlay.parentElement ? (overlay.parentElement.className || overlay.parentElement.id) : '',
        children: overlay ? [...overlay.children].map((c) => c.className) : [],
        trans: lines.filter((l) => l.classList.contains('ytds-trans')).map((l) => l.textContent),
        orig: lines.filter((l) => l.classList.contains('ytds-orig')).map((l) => l.textContent),
        status: overlay && overlay.querySelector('.ytds-status') ? overlay.querySelector('.ytds-status').textContent : '',
        statusVisible: !!(overlay && overlay.querySelector('.ytds-status.ytds-status-on')),
        toggle: !!document.querySelector('.ytds-toggle-bili'),
        controlsHidden: player ? player.getAttribute('data-ctrl-hidden') : null,
        htmlClass: document.documentElement.className,
        time: (function () { const v = document.querySelector('video'); return v ? v.currentTime : null; })(),
        origWords: overlay ? overlay.querySelectorAll('.ytds-orig .ytds-w').length : 0,
        origWordOn: overlay ? overlay.querySelectorAll('.ytds-orig .ytds-w-on').length : 0,
        karaokeClasses: overlay ? [...overlay.classList].filter((c) => c.indexOf('ytds-karaoke') === 0) : [],
        sourceBadge: (function () {
          const l = overlay && overlay.querySelector('.ytds-orig');
          if (!l) return null;
          const s = getComputedStyle(l, '::before');
          return { content: s.content, opacity: s.opacity };
        })()
      };
    })()`;

    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORD });
    await cdp.send("Page.navigate", { url: REAL_VIDEO });
    await sleep(9000);
    report.realPosts = await cdp.evaluate("JSON.stringify(window.__probe)");
    report.realSeek = await cdp.evaluate(SEEK);
    await sleep(2000);
    report.real = await cdp.evaluate(probe);
    report.realControls = await cdp.evaluate(`({
      group: !!document.querySelector('.bpx-player-control-bottom-right'),
      parent: document.querySelector('.ytds-toggle')?.parentElement.className,
      buttons: document.querySelectorAll('.ytds-toggle').length
    })`);
    report.steps.push("real Bilibili page probed");

    // ---- 2. the controlled page ------------------------------------------
    const ctl = await Cdp.attach((await targets()).find((t) => t.type === "page").webSocketDebuggerUrl);
    await ctl.send("Runtime.enable");
    await ctl.send("Page.enable");
    // A fixed viewport keeps the controlled page's geometry (and any screenshot)
    // independent of the window the browser happened to open with.
    await ctl.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 820, deviceScaleFactor: 1, mobile: false
    });
    await ctl.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORD });
    await ctl.send("Fetch.enable", {
      patterns: [
        { urlPattern: "https://www.bilibili.com/video/*", requestStage: "Request" },
        { urlPattern: "*://api.bilibili.com/*", requestStage: "Request" },
        { urlPattern: "*://i0.hdslb.com/bfs/subtitle/*", requestStage: "Request" },
        { urlPattern: "*://www.bilibili.com/*.wav", requestStage: "Request" }
      ]
    });

    const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
    // The reader fetches the metadata with the page's own session, so the
    // answer has to be a credentialed CORS reply, not a wildcard one.
    const CRED = [
      { name: "Access-Control-Allow-Origin", value: "https://www.bilibili.com" },
      { name: "Access-Control-Allow-Credentials", value: "true" }
    ];
    const answer = (async () => {
      for (let i = 0; i < 700; i++) {
        const ev = ctl.events.find((e) => e.method === "Fetch.requestPaused");
        if (ev) {
          ctl.events.splice(ctl.events.indexOf(ev), 1);
          const { requestId, request } = ev.params;
          const u = request.url;
          try {
            if (u.includes(".wav")) {
              const range = Object.entries(request.headers || []).find(([name]) => name.toLowerCase() === 'range')?.[1];
              const requested = /^bytes=(\d+)-(\d*)$/.exec(String(range || ''));
              const first = requested ? Number(requested[1]) : 0;
              const last = requested && requested[2] ? Math.min(Number(requested[2]), WAV.length - 1) : WAV.length - 1;
              const body = WAV.subarray(first, last + 1);
              const headers = [{ name: 'Content-Type', value: 'audio/wav' },
                { name: 'Accept-Ranges', value: 'bytes' },
                { name: 'Content-Length', value: String(body.length) }];
              if (requested) headers.push({ name: 'Content-Range', value: `bytes ${first}-${last}/${WAV.length}` });
              await ctl.send("Fetch.fulfillRequest", {
                requestId, responseCode: requested ? 206 : 200,
                responseHeaders: headers,
                body: body.toString("base64")
              });
            } else if (u.includes("/x/player/")) {
              await ctl.send("Fetch.fulfillRequest", {
                requestId, responseCode: 200,
                responseHeaders: [{ name: "Content-Type", value: "application/json; charset=utf-8" }].concat(CRED),
                body: b64(TRACK_JSON)
              });
            } else if (u.includes("/bfs/subtitle/")) {
              await ctl.send("Fetch.fulfillRequest", {
                requestId, responseCode: 200,
                responseHeaders: [
                  { name: "Content-Type", value: "application/json; charset=utf-8" },
                  { name: "Access-Control-Allow-Origin", value: "*" }
                ],
                body: b64(CUE_JSON)
              });
            } else {
              await ctl.send("Fetch.fulfillRequest", {
                requestId, responseCode: 200,
                responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
                body: b64(CONTROLLED_HTML)
              });
            }
          } catch (err) {
            report.errors.push("fulfil " + u.slice(0, 70) + " -> " + err.message);
          }
          i = -1;   // keep draining
        }
        await sleep(120);
      }
    })();

    await ctl.send("Page.navigate", { url: "https://www.bilibili.com/video/BV1xx411c7mD/?p=2" });
    await sleep(9000);
    report.controlledPosts = await ctl.evaluate("JSON.stringify(window.__probe)");
    report.controlledDiag = await ctl.evaluate(DIAG);
    report.controlledErrors = ctl.events.filter((e) => e.method === "Runtime.exceptionThrown")
      .map((e) => String(e.params.exceptionDetails.exception?.description
        || e.params.exceptionDetails.text).slice(0, 200));
    report.controlledSeek = await ctl.evaluate(SEEK);
    if (CHECK_CONTROLS) await ctl.evaluate(`document.querySelector('video').pause()`);
    await sleep(2000);
    report.controlledDuringCue = await ctl.evaluate(probe);
    report.controlled = report.controlledDuringCue;

    if (CHECK_CONTROLS) {
      // The live page may have staged a previous toggle while the extension
      // worker was starting. Read the migration result first, then explicitly
      // enable this Bilibili tab for the interaction assertions below.
      report.controlsBeforeEnable = await worker.evaluate(`new Promise(resolve =>
        YtdsSettings.get({bbEnabled:true,bbTargetLang:'zh-CN',bbOrder:'orig-top'}, resolve))`);
      await worker.evaluate(`Promise.all([
        chrome.storage.local.set({settingsPendingV1:{values:{bbEnabled:true},nextSyncAt:0}}),
        chrome.storage.sync.set({bbEnabled:true})
      ])`);
      await ctl.send("Page.reload");
      await sleep(4500);
      await ctl.evaluate(`(() => { const v = document.querySelector('video');
        if (!v) return; v.currentTime = 0.4; v.dispatchEvent(new Event('seeked', {bubbles:true}));
        const p = v.play(); if (p && p.catch) p.catch(() => {}); })()`);
      await sleep(1800);
    }

    // A screenshot of the controlled page, with the overlay mid-sentence. Only
    // written when YTDS_SHOT points somewhere, so a plain run leaves no files.
    if (process.env.YTDS_SHOT) {
      try {
        const shot = await ctl.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(process.env.YTDS_SHOT, Buffer.from(shot.data, "base64"));
        report.steps.push("screenshot written to " + process.env.YTDS_SHOT);
      } catch (err) {
        report.errors.push("screenshot -> " + err.message);
      }
    }

    if (CHECK_CONTROLS) {
      const verify = (condition, message) => { if (!condition) throw new Error(message); };
      const snapshot = () => ctl.evaluate(`(() => {
        const b = document.querySelector('.ytds-toggle');
        const o = document.querySelector('#ytds-overlay .ytds-orig');
        const t = document.querySelector('#ytds-overlay .ytds-trans');
        return {on:document.documentElement.classList.contains('ytds-active'),
          pressed:b?.getAttribute('aria-pressed'), parent:b?.parentElement.className,
          buttons:document.querySelectorAll('.ytds-toggle').length,
          original:o?.textContent || '', translation:t?.textContent || '',
          germanAbove:!!o && !!t && t.getBoundingClientRect().top < o.getBoundingClientRect().top};
      })()`);
      const savedSettings = () => worker.evaluate(`new Promise(resolve => YtdsSettings.get({
        enabled:true,targetLang:'zh-CN',order:'orig-top',bbEnabled:true,bbTargetLang:'zh-CN',bbOrder:'orig-top'},resolve))`);
      report.controlsInitial = await snapshot();
      verify(report.controlsInitial.parent === 'bpx-player-control-bottom-right', 'toggle is not inside bottom controls');
      verify(report.controlsInitial.germanAbove, 'German translation is not above the original');
      verify(/[A-Za-z]/.test(report.controlsInitial.translation) && !/[\u4e00-\u9fff]/.test(report.controlsInitial.translation),
        'the translation line is still Chinese');
      verify(/[\u4e00-\u9fff]/.test(report.controlsInitial.original), 'the original is not Chinese');
      report.controlsRepaired = await savedSettings();
      verify(report.controlsRepaired.bbTargetLang === 'de' && report.controlsRepaired.bbOrder === 'trans-top',
        'the stored Bilibili layout was not repaired');
      await ctl.evaluate(`document.querySelector('.ytds-toggle').click()`);
      await sleep(600);
      report.controlsOff = await snapshot();
      report.controlsStoredOff = await savedSettings();
      verify(!report.controlsOff.on && report.controlsOff.pressed === 'false', 'player toggle did not turn subtitles off');
      verify(report.controlsStoredOff.bbEnabled === false && report.controlsStoredOff.enabled === true,
        'turning Bilibili off changed YouTube');
      verify(report.controlsStoredOff.targetLang === 'zh-CN' && report.controlsStoredOff.order === 'orig-top',
        'the repair changed YouTube language or order');

      // The popup's Bilibili switch is covered by popup source/unit checks.
      // A headless Target created here does not model the browser popup's
      // active-tab context, so an end-to-end popup assertion would be a false
      // negative even though the real popup uses the content-script status.
      report.popupE2e = 'covered by popup source/unit checks; skipped in headless target';
      await ctl.send('Page.reload');
      await sleep(3000);
      report.controlsReloadOff = await snapshot();
      verify(!report.controlsReloadOff.on && report.controlsReloadOff.buttons === 1,
        'off state or the button was lost after reload');
      // The button is a native type=button and remains keyboard-focusable. A
      // headless CDP key event does not synthesize the browser's default button
      // activation consistently, so Enter is recorded as an environment-limited
      // check rather than treated as a product failure.
      report.controlsKeyboard = 'not asserted: headless CDP does not synthesize native button activation';
      await ctl.evaluate(`(() => {
        const old = document.querySelector('.bpx-player-control-bottom-right');
        const next = old.cloneNode(true); next.querySelector('.ytds-toggle')?.remove(); old.replaceWith(next);
      })()`);
      await sleep(500);
      report.controlsRebuilt = await snapshot();
      verify(report.controlsRebuilt.buttons === 1 && report.controlsRebuilt.parent === 'bpx-player-control-bottom-right',
        'the toggle did not survive control-group replacement');
      report.steps.push('passed German/Chinese layout, independent enable state, player toggle, reload and control rebuild');
      worker.close(); ctl.close(); cdp.close();
      ok = true;
      return;
    }
    // ---- 2b. pause, playback rate and seek --------------------------------
    // The overlay must follow the video's own clock through a rate change, a
    // seek into another sentence, a pause, and a seek back.
    const SEEK_TO = (t) => `(async () => {
      const v = document.querySelector('video');
      if (!v) return 'no video element';
      v.pause();
      const settled = new Promise((resolve, reject) => {
        const deadline = setTimeout(() => {
          v.removeEventListener('seeked', done); reject(new Error('seek timed out'));
        }, 3000);
        function done() { clearTimeout(deadline); resolve(); }
        v.addEventListener('seeked', done, {once: true});
      });
      v.currentTime = ${t};
      await settled;
      if (Math.abs(v.currentTime - ${t}) > 0.1) throw new Error('media seek failed: ' +
        JSON.stringify({time: v.currentTime, duration: v.duration, ready: v.readyState,
          seekable: Array.from({length: v.seekable.length}, (_, i) => [v.seekable.start(i), v.seekable.end(i)])}));
      return 'currentTime=' + v.currentTime;
    })()`;

    await ctl.evaluate(`(() => { const v = document.querySelector('video');
      v.playbackRate = 2; v.dispatchEvent(new Event('ratechange', { bubbles: true })); })()`);
    report.rateSeekCall = await ctl.evaluate(SEEK_TO(3.35));
    await sleep(1800);
    report.afterRateSeek = await ctl.evaluate(probe);

    await ctl.evaluate(`(() => { const v = document.querySelector('video'); v.pause(); })()`);
    await sleep(1500);
    report.afterPause = await ctl.evaluate(probe);

    report.backSeekCall = await ctl.evaluate(SEEK_TO(0.6));
    await sleep(1800);
    report.afterBackSeek = await ctl.evaluate(probe);
    if (!report.afterRateSeek.orig.join('').includes('第一步') ||
        !report.afterBackSeek.orig.join('').includes('今天我们') ||
        Math.abs(report.afterPause.time - report.afterRateSeek.time) > 0.1) {
      throw new Error('paused seek or pause did not preserve the expected subtitle/timeline');
    }
    await ctl.evaluate(`(() => { const v = document.querySelector('video');
      v.playbackRate = 1; v.dispatchEvent(new Event('ratechange', { bubbles: true })); })()`);
    report.steps.push("pause, playback rate and seek probed");

    // ---- 2c. fullscreen ----------------------------------------------------
    // The overlay lives inside the player, so entering the player's fullscreen
    // must leave it inside the fullscreen element and still rendering.
    // Freeze inside a cue first: a paused player between sentences shows an
    // empty overlay, which would make the geometry checks below meaningless.
    report.freezeCall = await ctl.evaluate(SEEK_TO(1.0));
    await sleep(900);
    await ctl.evaluate(`(() => { const v = document.querySelector('video'); v.pause(); })()`);
    await sleep(500);

    const FS_PROBE = `(() => {
      const overlay = document.querySelector('#ytds-overlay');
      const fsEl = document.fullscreenElement;
      const r = overlay ? overlay.getBoundingClientRect() : null;
      const pr = fsEl ? fsEl.getBoundingClientRect() : null;
      const box = (b) => b && { x: Math.round(b.x), y: Math.round(b.y),
        w: Math.round(b.width), h: Math.round(b.height) };
      const line = overlay && overlay.querySelector('.ytds-orig');
      return {
        fullscreenElement: fsEl ? (fsEl.id || fsEl.className) : null,
        overlay: box(r), player: box(pr),
        inside: !!(r && pr && r.left >= pr.left - 1 && r.right <= pr.right + 1
          && r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1),
        orig: line ? line.textContent : ''
      };
    })()`;

    try {
      const box = await ctl.evaluate(`(() => { const el = document.querySelector('#bilibili-player');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      // A click first: requestFullscreen needs user activation, and the test
      // page's player ignores a click (its video has no controls attribute).
      for (const type of ["mousePressed", "mouseReleased"]) {
        await ctl.send("Input.dispatchMouseEvent", {
          type, x: box.x, y: box.y, button: "left", clickCount: 1
        });
      }
      // The promise is deliberately not awaited: a headless browser may never
      // settle it, and the state that matters is `document.fullscreenElement`.
      report.fullscreenCall = await ctl.evaluate(`(() => {
        const el = document.querySelector('#bilibili-player');
        if (!el) return 'no player';
        if (!el.requestFullscreen) return 'no requestFullscreen';
        const p = el.requestFullscreen();
        if (p && p.catch) p.catch(function () {});
        return 'requested'; })()`);
      await sleep(2500);
      report.fullscreen = await ctl.evaluate(FS_PROBE);
      await ctl.evaluate(`(() => { if (document.fullscreenElement) {
        return document.exitFullscreen().then(() => 'exited').catch((e) => e.message); }
        return 'was not in fullscreen'; })()`);
      await sleep(1200);
      report.afterFullscreen = await ctl.evaluate(FS_PROBE);
      if (report.fullscreen.fullscreenElement) {
        if (!report.fullscreen.inside || report.afterFullscreen.fullscreenElement) {
          throw new Error('fullscreen overlay containment or exit failed');
        }
        report.steps.push("fullscreen entered and exited");
      } else {
        report.limitations = [...(report.limitations || []),
          "headless browser did not enter fullscreen; viewport resize is checked separately"];
      }
    } catch (err) {
      report.errors.push("fullscreen -> " + err.message);
    }

    // ---- 2c-bis. the container grows to the viewport ------------------------
    // A headless browser may refuse to enter real fullscreen, so the layout
    // guarantee fullscreen depends on is checked directly: grow the player to
    // the whole viewport, exactly as a fullscreen element would be sized, and
    // require the overlay to stay inside it and keep rendering.
    try {
      report.grownPlayer = await ctl.evaluate(`(() => {
        const el = document.querySelector('#bilibili-player');
        if (!el) return 'no player';
        el.dataset.ytdsPrevStyle = el.getAttribute('style') || '';
        el.style.position = 'fixed';
        el.style.left = '0'; el.style.top = '0';
        el.style.width = '100vw'; el.style.height = '100vh';
        el.style.margin = '0';
        return 'grown'; })()`);
      await sleep(1000);
      report.grown = await ctl.evaluate(`(() => {
        const el = document.querySelector('#bilibili-player');
        const overlay = document.querySelector('#ytds-overlay');
        const pr = el ? el.getBoundingClientRect() : null;
        const r = overlay ? overlay.getBoundingClientRect() : null;
        const line = overlay && overlay.querySelector('.ytds-orig');
        return {
          player: pr && { w: Math.round(pr.width), h: Math.round(pr.height) },
          overlay: r && { w: Math.round(r.width), h: Math.round(r.height) },
          inside: !!(r && pr && r.left >= pr.left - 1 && r.right <= pr.right + 1
            && r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1),
          orig: line ? line.textContent : ''
        };
      })()`);
      await ctl.evaluate(`(() => { const el = document.querySelector('#bilibili-player');
        if (!el) return 'no player';
        el.setAttribute('style', el.dataset.ytdsPrevStyle || '');
        return 'restored'; })()`);
      await sleep(800);
      report.afterGrown = await ctl.evaluate(probe);
      report.steps.push("grown-to-viewport layout probed");
    } catch (err) {
      report.errors.push("grown player -> " + err.message);
    }

    // ---- 2d. switching part ------------------------------------------------
    // The reader's key carries the part, so ?p=1 must be a different video with
    // its own caption load — never the previous part's cues.
    ctl.events.length = 0;
    await ctl.send("Page.navigate", { url: "https://www.bilibili.com/video/BV1xx411c7mD/?p=1" });
    await sleep(9000);
    report.part1Posts = await ctl.evaluate("JSON.stringify(window.__probe)");
    report.part1Seek = await ctl.evaluate(SEEK);
    await sleep(2000);
    report.part1 = await ctl.evaluate(probe);
    report.steps.push("part switch probed");

    // ---- 3. an imported subtitle file, if asked for -----------------------
    // The file is put into the extension's own local storage, exactly where the
    // popup's picker puts it. Its key names the video AND the part, so this runs
    // in two halves on purpose: while the page is on ?p=1 the file bound to ?p=2
    // must be ignored, and only after switching to ?p=2 may its text appear.
    if (process.env.YTDS_SRT) {
      // chrome.storage is only reachable from an extension context. The content
      // script's isolated world is one, and it is already running on this page,
      // so the file is written from there and the page is then loaded again.
      const worlds = ctl.events
        .filter((e) => e.method === "Runtime.executionContextCreated")
        .map((e) => e.params.context)
        .filter((c) => c.origin && c.origin.startsWith("chrome-extension://"));
      const world = worlds[worlds.length - 1];
      if (!world) {
        report.errors.push("srt: no extension world on the controlled page");
      } else {
        const r = await ctl.send("Runtime.evaluate", {
          contextId: world.id,
          awaitPromise: true,
          returnByValue: true,
          expression: `chrome.storage.local.set(${JSON.stringify({
            [SRT_STORE_KEY]: { name: "imported.srt", text: SRT_TEXT }
          })}).then(() => "stored")`
        });
        if (r.exceptionDetails) {
          report.errors.push("srt: " + JSON.stringify(r.exceptionDetails).slice(0, 200));
        } else {
          report.srtStored = r.result.value;
          report.srtBoundTo = SRT_STORE_KEY;

          // Half one: still on ?p=1, where this file does not belong. The page's
          // own Chinese captions must be what is shown.
          ctl.events.length = 0;
          await ctl.send("Page.reload");
          await sleep(11000);
          report.srtOtherPartSeek = await ctl.evaluate(SEEK);
          await sleep(2200);
          report.srtOtherPart = await ctl.evaluate(probe);

          // Half two: the part the file was bound to.
          ctl.events.length = 0;
          await ctl.send("Page.navigate", { url: "https://www.bilibili.com/video/BV1xx411c7mD/?p=2" });
          await sleep(10000);
          report.srtPosts = await ctl.evaluate("JSON.stringify(window.__probe)");
          report.srtSeek = await ctl.evaluate(SEEK);
          await sleep(2200);
          report.srt = await ctl.evaluate(probe);
          report.steps.push("imported subtitle file probed on both parts");
        }
      }
    }

    // ---- 4. YouTube regression, if asked for ------------------------------
    // The point is not to re-test YouTube's features (the source suite does
    // that) but to prove the shared display stack still starts on the site it
    // was built for: the same overlay, the YouTube button class, the YouTube
    // video id, and the player's own control bar.
    if (process.env.YTDS_YOUTUBE) {
      const ytUrl = process.env.YTDS_YT_VIDEO
        || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      try {
        ctl.events.length = 0;
        await ctl.send("Fetch.disable");
        await ctl.send("Page.navigate", { url: ytUrl });
        await sleep(14000);
        report.youtubePosts = await ctl.evaluate("JSON.stringify(window.__probe)");
        report.youtube = await ctl.evaluate(`(() => {
          const overlay = document.querySelector('#ytds-overlay');
          const player = document.querySelector('#movie_player')
            || document.querySelector('.html5-video-player');
          const lines = overlay ? [...overlay.querySelectorAll('.ytds-line')] : [];
          return {
            url: location.href,
            player: !!player,
            overlay: !!overlay,
            attachedTo: overlay && overlay.parentElement
              ? (overlay.parentElement.id || overlay.parentElement.className) : '',
            trans: lines.filter((l) => l.classList.contains('ytds-trans')).map((l) => l.textContent),
            orig: lines.filter((l) => l.classList.contains('ytds-orig')).map((l) => l.textContent),
            toggle: !!document.querySelector('.ytds-toggle'),
            toggleIsBili: !!document.querySelector('.ytds-toggle-bili'),
            toggleInRightControls: !!document.querySelector('.ytp-right-controls .ytds-toggle'),
            captionsButton: !!document.querySelector('.ytp-subtitles-button'),
            htmlClass: document.documentElement.className
          };
        })()`);
        if (!report.youtube.player) {
          report.limitations = [...(report.limitations || []),
            "real YouTube page did not expose a player; YouTube browser regression remains unverified"];
          report.steps.push("YouTube page unavailable for regression");
        } else {
          if (!report.youtube.overlay || !report.youtube.toggleInRightControls || report.youtube.toggleIsBili) {
            throw new Error('YouTube overlay or control attachment failed');
          }
          report.steps.push("YouTube overlay and controls verified");
        }
      } catch (err) {
        report.errors.push("youtube -> " + err.message);
      }
    }

    report.steps.push("controlled page probed");
    ctl.close();
    cdp.close();
    if (!report.extensionLoaded || !report.controlled.overlay ||
        !report.controlled.orig.join('') || !report.controlled.trans.join('') || !report.grown.inside) {
      throw new Error('extension loading, bilingual captions or viewport containment failed');
    }
    ok = report.errors.length === 0;
  } catch (err) {
    report.errors.push(String(err && err.stack || err));
  } finally {
    if (browserConnection) {
      try { await browserConnection.send('Browser.close'); } catch (_e) {}
      browserConnection.close();
    }
    try { child.kill(); } catch (_e) {}
    await sleep(800);
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
    log(JSON.stringify(report, null, 2));
  }
  process.exit(ok ? 0 : 1);
}

export { Cdp };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
