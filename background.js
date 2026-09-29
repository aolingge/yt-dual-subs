// background.js — translation service worker
// Routes cross-origin translation requests here so host_permissions apply
// and content scripts never hit page-CORS restrictions.

importScripts("settings.js");
YtdsSettings.startSync();
importScripts("word-timing.js", "audio-cache.js", "bridge-client.js");

const CACHE = new Map();          // key: `${sl}\u0000${tl}\u0000${text}` -> translated string
const CACHE_MAX = 2000;           // simple LRU-ish cap
const INFLIGHT = new Map();      // native preview and cue mode may ask for the same sentence

function cacheGet(key) {
  if (!CACHE.has(key)) return undefined;
  const v = CACHE.get(key);
  CACHE.delete(key);              // refresh recency
  CACHE.set(key, v);
  return v;
}

function cacheSet(key, val) {
  CACHE.set(key, val);
  if (CACHE.size > CACHE_MAX) {
    // drop oldest
    const firstKey = CACHE.keys().next().value;
    CACHE.delete(firstKey);
  }
}

// Unofficial, key-free Google Translate endpoint (same one most free tools use).
// Returns a nested array; translated chunks live at data[0][i][0].

// A request that never settles would hold one of the content script's few
// in-flight slots forever, so every attempt gets its own deadline. One retry
// covers a dropped connection; a rate-limit answer is never retried, because
// that only deepens the limit.
const REQUEST_TIMEOUT_MS = 4000;

async function fetchOnce(url) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, { method: "GET", signal: controller ? controller.signal : undefined });
    // The deadline also covers the body. Headers alone do not free a slot.
    const data = res.ok ? await res.json() : null;
    return { res, data };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function translate(text, targetLang, sourceLang) {
  // YouTube's track language is more reliable than automatic detection for a
  // short subtitle. Screen-caption fallback has no track and stays on auto.
  const sl = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(sourceLang || "")
    ? sourceLang : "auto";
  const key = `${sl}\u0000${targetLang}\u0000${text}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);

  const url =
    "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx&sl=" + encodeURIComponent(sl) +
    "&tl=" + encodeURIComponent(targetLang) +
    "&dt=t&q=" + encodeURIComponent(text);

  const request = (async () => {
    let answer;
    try {
      answer = await fetchOnce(url);
    } catch (err) {
      // Timeout or network failure: try exactly once more, then give up.
      answer = await fetchOnce(url);
    }
    const { res, data } = answer;
    if (!res.ok) throw new Error("translate http " + res.status);
    let out = "";
    if (Array.isArray(data) && Array.isArray(data[0])) {
      for (const seg of data[0]) {
        if (seg && typeof seg[0] === "string") out += seg[0];
      }
    }
    out = out.trim();
    if (out) cacheSet(key, out);
    return out;
  })();
  INFLIGHT.set(key, request);
  try { return await request; }
  finally { if (INFLIGHT.get(key) === request) INFLIGHT.delete(key); }
}

// ---------------------------------------------------------------------------
// On-device recognition: capture orchestration
// ---------------------------------------------------------------------------
// The service worker is the only context that can do all three of these things:
//
//   * call tabCapture.getMediaStreamId() after the popup's click (the click is
//     the grant; a content script can never call this API),
//   * own the offscreen document that holds the audio graph, and
//   * reach both the video page and the offscreen document with messages.
//
// The audio path itself lives in the offscreen document, because a graph hosted
// by the popup would die with the popup.
const OFFSCREEN_PATH = "offscreen.html";
const OFFSCREEN_JUSTIFICATION = "capture the current tab's audio to recognize speech locally";

let recog = {
  state: "", message: "", tabId: null, videoKey: "", cueCount: 0,
  dropped: 0, revision: 0, sampleRate: 0,
};

function recorderSnapshot() {
  return {
    state: recog.state,
    message: recog.message,
    // The tab a capture belongs to: the popup shows a session only for the tab
    // it is about, and stopping has to reach the right page.
    tabId: recog.tabId,
    videoKey: recog.videoKey,
    cueCount: recog.cueCount,
    dropped: recog.dropped,
    revision: recog.revision,
    sampleRate: recog.sampleRate,
  };
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) return false;
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
    });
    return !!(contexts && contexts.length);
  } catch (_e) {
    return false;
  }
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return true;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification: OFFSCREEN_JUSTIFICATION,
  });
  return true;
}

async function closeOffscreenDocument() {
  if (!(await hasOffscreenDocument())) return;
  try { await chrome.offscreen.closeDocument(); } catch (_e) { /* already gone */ }
}

function sendTab(tabId, message) {
  return new Promise((resolve) => {
    if (tabId == null) { resolve(null); return; }
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(response);
      });
    } catch (_e) { resolve(null); }
  });
}

function deliverToTab(tabId, message) {
  sendTab(tabId, message).then(() => {});
}

// Cue batches and state are pushed, not polled: the page has no idea a capture
// is running, and a status poll cannot carry a whole transcript.
function deliverCues(msg) {
  const tabId = recog.tabId;
  if (tabId == null) return;
  recog.cueCount = Array.isArray(msg.cues) ? msg.cues.length : 0;
  if (Number.isFinite(Number(msg.revision))) recog.revision = Number(msg.revision);
  deliverToTab(tabId, {
    type: "recognizedCues",
    videoId: msg.videoKey || recog.videoKey || "",
    cues: msg.cues || [],
    sourceLang: msg.sourceLang || "zh",
  });
}

function applyRecorderState(msg) {
  const next = String(msg.state || "");
  recog.state = next;
  recog.message = String(msg.message || "");
  if (msg.videoKey) recog.videoKey = String(msg.videoKey);
  if (Number.isFinite(Number(msg.cueCount))) recog.cueCount = Number(msg.cueCount);
  if (Number.isFinite(Number(msg.dropped))) recog.dropped = Number(msg.dropped);
  deliverToTab(recog.tabId, {
    type: "recognitionState",
    state: next,
    message: recog.message,
    cueCount: recog.cueCount,
  });
}

// The page's timeline reports are for the recorder and for nobody else. Reports
// from a tab that is not the one being captured are dropped, so a second video
// open in another tab can never stamp its time onto this transcript.
async function relayMediaReport(msg, sender) {
  if (recog.tabId == null) return { ok: false, reason: "idle" };
  if (sender && sender.tab && sender.tab.id != null && sender.tab.id !== recog.tabId) {
    return { ok: false, reason: "other_tab" };
  }
  try {
    await chrome.runtime.sendMessage(Object.assign({}, msg, { target: "offscreen" }));
  } catch (_e) { /* the recorder decides what a lost report means */ }
  return { ok: true };
}

async function readPageContext(tabId) {
  const answer = await sendTab(tabId, { type: "recognitionContext" });
  return answer && answer.ok ? answer.context : null;
}

async function readBridgeConfig(tabId) {
  const answer = await sendTab(tabId, { type: "status" });
  return {
    bridgeBase: (answer && answer.bridgeBase) || "",
    bridgeToken: (answer && answer.bridgeToken) || "",
  };
}

async function recogHealth() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs && tabs[0];
  const config = tab && tab.id != null ? await readBridgeConfig(tab.id) : { bridgeBase: "", bridgeToken: "" };
  if (!config.bridgeBase || !config.bridgeToken) {
    return { ok: false, code: "not_configured", message: "missing bridge address or token" };
  }
  const client = YtdsBridge.createClient({ base: config.bridgeBase, token: config.bridgeToken });
  try {
    const health = await client.health();
    return {
      ok: true,
      modelReady: !!(health && health.modelReady),
      engine: (health && health.engine) || "",
      languages: (health && health.languages) || [],
      warning: (health && health.warning) || "",
    };
  } catch (err) {
    return { ok: false, code: (err && err.code) || "unreachable", message: String((err && err.message) || err) };
  }
}

// Starting capture: the order matters. The page is asked first and must answer
// "no captions"; only then is a stream id requested (a call that needs the
// popup's click) and the offscreen document created to consume it.
async function recogStart(msg) {
  const tabId = msg && msg.tabId != null ? msg.tabId : null;
  if (tabId == null) return { ok: false, code: "no_tab", message: "no active tab" };
  if (recog.state === "running" || recog.state === "starting") {
    return { ok: false, code: "busy", message: "a recognition session is already running" };
  }
  const context = await readPageContext(tabId);
  if (!context) return { ok: false, code: "no_page", message: "the page did not answer" };
  if (context.captionAvailability !== "absent") {
    return { ok: false, code: "captions", message: String(context.captionAvailability || "unknown") };
  }
  const config = await readBridgeConfig(tabId);
  if (!config.bridgeBase || !config.bridgeToken) {
    return { ok: false, code: "not_configured", message: "missing bridge address or token" };
  }

  recog = Object.assign(recog, {
    state: "starting", message: "", tabId,
    videoKey: context.videoId || "", cueCount: 0, dropped: 0, revision: 0,
  });
  deliverToTab(tabId, { type: "recognitionState", state: "starting", message: "" });

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    recog = Object.assign(recog, { state: "failed", message: "capture_refused", tabId: null });
    deliverToTab(tabId, { type: "recognitionState", state: "failed", message: "capture_refused" });
    return { ok: false, code: "capture", message: String((err && err.message) || err) };
  }

  await ensureOffscreenDocument();
  const answer = await chrome.runtime.sendMessage({
    type: "recogOffscreenStart",
    streamId,
    context: Object.assign({}, context, config),
  });
  if (!answer || !answer.ok) {
    recog = Object.assign(recog, { state: "failed", message: (answer && answer.reason) || "failed", tabId: null });
    deliverToTab(tabId, { type: "recognitionState", state: "failed", message: (answer && answer.reason) || "failed" });
    await closeOffscreenDocument();
    return answer || { ok: false, code: "failed" };
  }
  return { ok: true, sampleRate: answer.sampleRate };
}

async function recogStop() {
  const tabId = recog.tabId;
  recog = Object.assign(recog, { state: "stopping" });
  deliverToTab(tabId, { type: "recognitionState", state: "stopping", message: "" });
  try {
    await chrome.runtime.sendMessage({ type: "recogOffscreenStop" });
  } catch (_e) { /* nothing to stop */ }
  recog = Object.assign(recog, { state: "", message: "", tabId: null });
  deliverToTab(tabId, { type: "recognitionState", state: "", message: "" });
  await closeOffscreenDocument();
  return { ok: true };
}

// A captured tab that goes away leaves nothing to recognize. Guarded because a
// reduced chrome stand-in (tests) may carry no tabs API at all.
if (chrome.tabs && chrome.tabs.onRemoved && chrome.tabs.onRemoved.addListener) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (recog.tabId === tabId) recogStop();
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "saveSettings") {
    YtdsSettings.enqueue(msg.patch)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // persist locally before acknowledging, even if the popup closes
  }
  if (msg && msg.type === "translate") {
    translate(msg.text, msg.targetLang, msg.sourceLang)
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }
  if (msg.type === "recogHealth") {
    recogHealth(msg).then(sendResponse).catch((err) =>
      sendResponse({ ok: false, code: "failed", message: String((err && err.message) || err) }));
    return true;
  }
  if (msg.type === "recogStart") {
    recogStart(msg).then(sendResponse).catch((err) =>
      sendResponse({ ok: false, code: "failed", message: String((err && err.message) || err) }));
    return true;
  }
  if (msg.type === "recogStop") {
    recogStop(msg).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "recogStatus") {
    sendResponse({ ok: true, recorder: recorderSnapshot() });
    return;
  }
  // The recorder and the video page only ever talk through here: the page
  // cannot open an audio capture, and the offscreen document cannot find the
  // tab.
  if (msg.type === "mediaReport") {
    relayMediaReport(msg, sender).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "recogState") {
    applyRecorderState(msg);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "recognizedCues") {
    deliverCues(msg);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "recogStopped") {
    const tabId = recog.tabId;
    recog = Object.assign(recog, { state: "", message: "", tabId: null });
    deliverToTab(tabId, { type: "recognitionState", state: "", message: "" });
    sendResponse({ ok: true });
    return;
  }
});

// Keyboard shortcuts -> content.js. Each command maps to one message type; an
// unknown command (or a non-YouTube tab with no content script) is ignored.
const COMMAND_MESSAGES = {
  "toggle-translation": "toggleTranslation",
  "repeat-sentence": "repeatSentence",
  "reveal-translation": "revealTranslation"
};

chrome.commands.onCommand.addListener((command) => {
  const type = COMMAND_MESSAGES[command];
  if (!type) return;
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs || tabs[0]?.id == null) return;
    chrome.tabs.sendMessage(tabs[0].id, { type }, () => {
      // A non-YouTube tab has no content script to receive the command.
      void chrome.runtime.lastError;
    });
  });
});
