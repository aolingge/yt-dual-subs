// background.js — translation service worker
// Routes cross-origin translation requests here so host_permissions apply
// and content scripts never hit page-CORS restrictions.

importScripts("bridge-vault.js", "settings.js");
Promise.resolve(YtdsSettings.startSync()).catch(() => {}); // retry on the next settings request
importScripts("word-timing.js", "audio-cache.js", "bridge-client.js");
importScripts("study-export.js", "study-store.js");
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === "sync" && changes.bridgeToken?.newValue !== undefined) {
    // An older installation on another device can reintroduce a synchronized
    // token. Never import it over the private vault; remove the remote copy.
    Promise.resolve(chrome.storage.sync.remove("bridgeToken")).catch(() => {});
  }
});

const CACHE = new Map();          // key: `${sl}\u0000${tl}\u0000${text}` -> translated string
const CACHE_MAX = 2000;           // simple LRU-ish cap
const INFLIGHT = new Map();      // native preview and cue mode may ask for the same sentence
const TRANSLATION_CONCURRENCY = 4, TRANSLATION_QUEUE_MAX = 64;
let translationActive = 0, translationRetryAt = 0;
const translationQueue = [];

function translationSlot(operation) {
  if (translationQueue.length >= TRANSLATION_QUEUE_MAX) return Promise.reject(new Error("translate queue full"));
  return new Promise((resolve, reject) => {
    const run = () => {
      translationActive++;
      const task = Date.now() < translationRetryAt
        ? Promise.reject(new Error("translate http 429 (cooldown)")) : operation();
      task.then(resolve, reject).finally(() => {
        translationActive--;
        const next = translationQueue.shift();
        if (next) next();
      });
    };
    if (translationActive < TRANSLATION_CONCURRENCY) run();
    else translationQueue.push(run);
  });
}

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
    const res = await fetch(url, { method: "GET", credentials: "omit", redirect: "error",
      signal: controller ? controller.signal : undefined });
    // The deadline also covers the body. Headers alone do not free a slot.
    const data = res.ok ? await res.json() : null;
    return { res, data };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function translate(text, targetLang, sourceLang) {
  if (typeof text !== "string" || text.length > 8192 || typeof targetLang !== "string" ||
      targetLang.length > 32 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(targetLang)) {
    throw new Error("invalid translation request");
  }
  if (!text.trim()) return "";
  if (String(sourceLang || "").toLowerCase() === targetLang.toLowerCase()) return text;
  // YouTube's track language is more reliable than automatic detection for a
  // short subtitle. Screen-caption fallback has no track and stays on auto.
  const sl = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(sourceLang || "")
    ? sourceLang : "auto";
  const key = `${sl}\u0000${targetLang}\u0000${text}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);
  if (Date.now() < translationRetryAt) throw new Error("translate http 429 (cooldown)");

  const url =
    "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx&sl=" + encodeURIComponent(sl) +
    "&tl=" + encodeURIComponent(targetLang) +
    "&dt=t&q=" + encodeURIComponent(text);

  const request = translationSlot(async () => {
    let answer;
    try {
      answer = await fetchOnce(url);
    } catch (err) {
      // Timeout or network failure: try exactly once more, then give up.
      answer = await fetchOnce(url);
    }
    const { res, data } = answer;
    if (!res.ok) {
      if (res.status === 429) {
        const retry = res.headers?.get?.("Retry-After");
        const seconds = retry && Number.isFinite(Number(retry)) ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
        translationRetryAt = Date.now() + Math.min(300000, Math.max(60000, (seconds || 0) * 1000));
      }
      throw new Error("translate http " + res.status);
    }
    let out = "";
    if (Array.isArray(data) && Array.isArray(data[0])) {
      for (const seg of data[0]) {
        if (seg && typeof seg[0] === "string") out += seg[0];
      }
    }
    out = out.trim();
    if (!out || out.length > 32768) throw new Error("translate bad response");
    cacheSet(key, out);
    return out;
  });
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
    metrics: recog.metrics || {},
    warning: recog.warning || "",
    audioInput: recog.audioInput || { state: "idle" },
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

const STARTUP_RETRY_DELAYS_MS = [750, 2500, 7000];
const RELOAD_GUARD_MS = 30000;
const RECOVERY_STORAGE_KEY = "ytdsRecoveryStatusV1";
let startupRetryIndex = 0;
let startupRetryTimer = null;
const reloadGuards = new Map();
let recoveryStatus = {
  state: "idle",
  at: 0,
  source: "",
  tabId: null,
  url: "",
  reason: "",
  attempt: 0,
  version: ""
};

function recoverySnapshot() {
  return { ...recoveryStatus };
}

function persistRecoveryStatus(next) {
  recoveryStatus = { ...recoveryStatus, ...next, at: Date.now(), version: extensionVersion() };
  try {
    chrome.storage?.local?.set?.({ [RECOVERY_STORAGE_KEY]: recoverySnapshot() }, () => {
      void chrome.runtime.lastError;
    });
  } catch (_e) { /* diagnostics must never block recovery */ }
}

function extensionVersion() {
  try {
    return String(chrome.runtime.getManifest?.().version || "");
  } catch (_e) {
    return "";
  }
}

function pageIsCurrent(reply) {
  const expected = extensionVersion();
  // Chrome always exposes the manifest in the service worker. The fallback is
  // only for reduced test doubles that predate the version handshake.
  if (!expected) return reply?.ok === true;
  return reply?.ok === true && String(reply.version || "") === expected;
}

function reloadYouTubeTab(tab) {
  if (typeof chrome.tabs.reload !== "function" || tab?.id == null) return;
  const now = Date.now();
  const key = tab.id;
  const url = String(tab.url || "");
  const prior = reloadGuards.get(key);
  if (prior && prior.url === url && now - prior.at < RELOAD_GUARD_MS) return;
  reloadGuards.set(key, { url, at: now });
  persistRecoveryStatus({ state: "reloading", source: "probe", tabId: key, url, reason: "content-unavailable", attempt: startupRetryIndex });
  try {
    chrome.tabs.reload(key, () => { void chrome.runtime.lastError; });
  } catch (_e) { /* a closing tab is harmless */ }
}

// A restored YouTube tab can outlive the content-script context that was
// injected before the browser closed (or before an extension update). Probe
// only YouTube tabs and reload the ones that do not answer with the current
// extension version; healthy tabs keep their playback state and are left alone.
function probeYouTubeTab(tab) {
  if (tab?.id == null || tab.status === "loading") return;
  sendTab(tab.id, { type: "status" }).then((reply) => {
    if (pageIsCurrent(reply)) {
      reloadGuards.delete(tab.id);
      persistRecoveryStatus({ state: "healthy", source: "probe", tabId: tab.id, url: tab.url || "", reason: "", attempt: startupRetryIndex });
      return;
    }
    if (reply && reply.ok === true) {
      persistRecoveryStatus({ state: "failed", source: "probe", tabId: tab.id, url: tab.url || "", reason: "stale-version", attempt: startupRetryIndex });
    } else {
      persistRecoveryStatus({ state: "failed", source: "probe", tabId: tab.id, url: tab.url || "", reason: "content-unavailable", attempt: startupRetryIndex });
    }
    reloadYouTubeTab(tab);
  });
}

function scheduleStartupRetry() {
  if (startupRetryTimer !== null || startupRetryIndex >= STARTUP_RETRY_DELAYS_MS.length) return;
  const delay = STARTUP_RETRY_DELAYS_MS[startupRetryIndex++];
  startupRetryTimer = setTimeout(() => {
    startupRetryTimer = null;
    repairYouTubeTabs();
  }, delay);
}

function repairYouTubeTabs() {
  if (!chrome.tabs || typeof chrome.tabs.query !== "function") {
    persistRecoveryStatus({ state: "failed", source: "startup", reason: "tabs-api-unavailable", attempt: startupRetryIndex });
    return;
  }
  try {
    chrome.tabs.query({ url: ["https://www.youtube.com/*"] }, (tabs) => {
      if (chrome.runtime.lastError) {
        persistRecoveryStatus({ state: "failed", source: "startup", reason: "tabs-query-failed", attempt: startupRetryIndex });
        return;
      }
      const list = Array.isArray(tabs) ? tabs : [];
      if (!list.length) persistRecoveryStatus({ state: "waiting", source: "startup", reason: "tabs-not-restored", attempt: startupRetryIndex });
      for (const tab of list) probeYouTubeTab(tab);
      // onStartup can run before session-restored tabs exist. Keep checking
      // briefly so a late-restored YouTube page is repaired without a manual
      // refresh; the bounded schedule avoids a permanent background poll.
      if (!list.length || list.some((tab) => tab?.status === "loading")) {
        scheduleStartupRetry();
      }
    });
  } catch (_e) { /* browser shutdown can close the tabs API mid-query */ }
}

function startRecoveryPasses() {
  startupRetryIndex = 0;
  if (startupRetryTimer !== null) {
    clearTimeout(startupRetryTimer);
    startupRetryTimer = null;
  }
  persistRecoveryStatus({ state: "starting", source: "startup", reason: "", attempt: 0 });
  repairYouTubeTabs();
}

chrome.runtime.onStartup?.addListener(startRecoveryPasses);
chrome.runtime.onInstalled?.addListener((details) => {
  if (details?.reason === "update") {
    persistRecoveryStatus({ state: "starting", source: "update", reason: "", attempt: 0 });
    startRecoveryPasses();
  }
});
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo?.status === "complete" && tab?.url?.startsWith("https://www.youtube.com/")) {
    probeYouTubeTab({ ...tab, id: tabId });
  }
});

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
  recog.metrics = msg.metrics || {};
  recog.warning = msg.warning || "";
  recog.audioInput = msg.audioInput || { state: "idle" };
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

async function readBridgeConfig() {
  return YtdsSettings.getBridgeConfig();
}

let recorderReady;
function restoreRecorder() {
  if (!recorderReady) recorderReady = (async () => {
    if (!await hasOffscreenDocument()) return;
    try {
      const reply = await chrome.runtime.sendMessage({ type: "recogOffscreenStatus" });
      const status = reply?.status;
      if (reply?.ok && Number.isInteger(status?.tabId) &&
          ["starting", "running", "degraded", "failed", "stopping"].includes(status.state)) {
        recog = { ...recog, tabId: status.tabId, videoKey: status.videoKey || "",
          state: status.state, message: status.message || "", cueCount: status.cueCount || 0,
          revision: status.revision || 0, dropped: status.dropped || 0, sampleRate: status.sampleRate || 0,
          metrics: status.metrics || {}, warning: status.warning || "",
          audioInput: status.audioInput || { state: "idle" } };
      }
    } catch (_e) { /* the document may have closed while the worker woke up */ }
  })();
  return recorderReady;
}

async function recogHealth(config) {
  config = config || await readBridgeConfig();
  if (!config.bridgeBase || !config.bridgeToken) {
    return { ok: false, code: "not_configured", message: "missing bridge address or token" };
  }
  try {
    const base = YtdsBridge.baseUrlOf(config.bridgeBase);
    const origin = new URL(base).protocol + "//" + new URL(base).hostname + "/*";
    if (!await chrome.permissions.contains({ origins: [origin] })) {
      return { ok: false, code: "permission_required" };
    }
    const client = YtdsBridge.createClient({ base, token: config.bridgeToken });
    const health = await client.health();
    if (!health || health.ok !== true || health.service !== "deutsch-overlay-bridge" ||
        health.protocolVersion !== YtdsBridge.PROTOCOL_VERSION) {
      return { ok: false, code: "bad_response" };
    }
    return {
      ok: true,
      modelReady: !!(health && health.modelReady),
      engine: (health && health.engine) || "",
      languages: (health && health.languages) || [],
      // The public health endpoint does not authenticate the bearer token.
      tokenVerified: false,
    };
  } catch (err) {
    return { ok: false, code: (err && err.code) || "unreachable" };
  }
}

// Starting capture: the order matters. The page is asked first and must answer
// "no captions"; the offscreen document is created before the short-lived
// stream id is requested, then the page is rechecked before consumption.
let recogStartPending = false;
let recogEpoch = 0;
async function recogStart(msg) {
  if (recogStartPending) return { ok: false, code: "busy" };
  recogStartPending = true;
  try { return await startRecognition(msg); }
  finally { recogStartPending = false; }
}

async function startRecognition(msg) {
  const epoch = recogEpoch;
  const tabId = msg && msg.tabId != null ? msg.tabId : null;
  if (tabId == null) return { ok: false, code: "no_tab", message: "no active tab" };
  if (["running", "starting", "degraded", "stopping"].includes(recog.state)) {
    return { ok: false, code: "busy", message: "a recognition session is already running" };
  }
  const context = await readPageContext(tabId);
  if (!context) return { ok: false, code: "no_page", message: "the page did not answer" };
  // The local bridge emits a German intermediate translation. The content
  // script may translate that line again through the normal bounded provider
  // when the viewer selected another display language, so the display target
  // must not be used as the bridge's capability gate.
  if (context.captionAvailability !== "absent") {
    return { ok: false, code: "captions", message: String(context.captionAvailability || "unknown") };
  }
  const config = await readBridgeConfig(tabId);
  if (!config.bridgeBase || !config.bridgeToken) {
    return { ok: false, code: "not_configured", message: "missing bridge address or token" };
  }
  const probe = await recogHealth(config);
  if (!probe.ok) return probe;
  // A health request can outlive a navigation or a newly loaded caption track.
  const latest = await readPageContext(tabId);
  if (epoch !== recogEpoch) return { ok: false, code: "cancelled" };
  if (!latest || latest.videoId !== context.videoId || latest.captionAvailability !== "absent") {
    return { ok: false, code: "captions_changed" };
  }

  recog = Object.assign(recog, {
    state: "starting", message: "", tabId,
    videoKey: context.videoId || "", cueCount: 0, dropped: 0, revision: 0,
    metrics: {}, warning: "", audioInput: { state: "waiting" },
  });
  deliverToTab(tabId, { type: "recognitionState", state: "starting", message: "" });

  let answer;
  try {
    if (epoch !== recogEpoch) return { ok: false, code: "cancelled" };
    await ensureOffscreenDocument();
    if (epoch !== recogEpoch) { await closeOffscreenDocument(); return { ok: false, code: "cancelled" }; }
    // Creation/capture can take time too. Verify the video immediately before
    // consuming the stream and publishing any credentials to the recorder.
    const finalContext = await readPageContext(tabId);
    if (epoch !== recogEpoch || !finalContext || finalContext.videoId !== latest.videoId ||
        finalContext.captionAvailability !== "absent") {
      answer = { ok: false, code: epoch !== recogEpoch ? "cancelled" : "captions_changed" };
    } else {
      // The ID expires after a few seconds; obtain it after document creation.
      let streamId;
      try { streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }); }
      catch (_e) { answer = { ok: false, code: "capture" }; }
      if (!answer && epoch === recogEpoch) {
        const consumeContext = await readPageContext(tabId);
        if (!consumeContext || consumeContext.videoId !== finalContext.videoId ||
            consumeContext.captionAvailability !== "absent") {
          answer = { ok: false, code: "captions_changed" };
        }
      }
      if (!answer && epoch === recogEpoch) {
        answer = await chrome.runtime.sendMessage({
          type: "recogOffscreenStart", streamId,
          context: Object.assign({}, finalContext, config, { videoKey: finalContext.videoId, tabId }),
        });
      }
    }
  } catch (_e) { answer = { ok: false, code: "failed" }; }
  if (epoch !== recogEpoch) {
    await closeOffscreenDocument();
    return { ok: false, code: "cancelled" };
  }
  if (!answer || !answer.ok) {
    const code = (answer && (answer.code || answer.reason)) || "failed";
    recog = Object.assign(recog, { state: "failed", message: code, tabId: null });
    deliverToTab(tabId, { type: "recognitionState", state: "failed", message: code });
    await closeOffscreenDocument();
    return answer || { ok: false, code: "failed" };
  }
  return { ok: true, sampleRate: answer.sampleRate };
}

async function recogStop() {
  recogEpoch++;
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

// The page moved on to another video while a capture was running: the audio in
// flight belongs to the video that is gone, so the new video does not inherit
// its captions. The overlay is told to forget them before the session ends, so
// the user never sees the previous video's sentences over the new one.
async function recogAbandon(msg, sender) {
  if (recog.tabId == null) return { ok: false, reason: "idle" };
  if (sender && sender.tab && sender.tab.id != null && sender.tab.id !== recog.tabId) {
    return { ok: false, reason: "other_tab" };
  }
  recog.cueCount = 0;
  recog.revision = 0;
  deliverToTab(recog.tabId, { type: "clearRecognized" });
  return recogStop();
}

// A captured video that goes away leaves nothing to recognize. Guarded because
// a reduced chrome stand-in (tests) may carry no tabs API at all.
if (chrome.tabs && chrome.tabs.onRemoved && chrome.tabs.onRemoved.addListener) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    restoreRecorder().then(() => { if (recog.tabId === tabId) return recogStop(); }).catch(() => {});
  });
}

function extensionSender(sender, paths) {
  // Empty URLs exist only in reduced API stand-ins. Real senders have a URL
  // supplied by Chrome, which a page cannot forge in its message payload.
  if (!sender?.url) return !sender?.tab;
  return paths.some(path => sender.url.split(/[?#]/)[0] === chrome.runtime.getURL(path)) &&
    (!sender.id || sender.id === chrome.runtime.id);
}

function handleMessage(msg, sender, sendResponse) {
  if (!msg) return;
  if (["getBridgeConfig", "recogStart", "recogStop", "recogHealth"].includes(msg.type) &&
      !extensionSender(sender, ["popup.html"])) {
    sendResponse({ ok: false, code: "forbidden" }); return;
  }
  if (["recogState", "recognizedCues", "recogStopped"].includes(msg.type) &&
      (!extensionSender(sender, [OFFSCREEN_PATH]) || recog.tabId == null ||
       (msg.videoKey && msg.videoKey !== recog.videoKey))) {
    sendResponse({ ok: false, code: "forbidden" }); return;
  }
  if (msg.type === "mediaReport" && (!sender?.tab || msg.target === "offscreen")) {
    sendResponse({ ok: false, code: "forbidden" }); return;
  }
  if (msg.type === "recoveryStatus") {
    try {
      chrome.storage?.local?.get?.(RECOVERY_STORAGE_KEY, (saved) => {
        const stored = saved && saved[RECOVERY_STORAGE_KEY];
        sendResponse({ ok: true, recovery: stored && typeof stored === "object"
          ? { ...recoverySnapshot(), ...stored } : recoverySnapshot() });
      });
      return true;
    } catch (_e) {
      sendResponse({ ok: true, recovery: recoverySnapshot() });
      return;
    }
  }
  if (msg.type === "saveSettings") {
    if (!extensionSender(sender, ["popup.html"]) && (Object.hasOwn(msg.patch || {}, "bridgeToken") || Object.hasOwn(msg.patch || {}, "bridgeBase"))) {
      sendResponse({ ok: false, error: "Bridge settings require the extension popup" });
      return;
    }
    YtdsSettings.enqueue(msg.patch)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // persist locally before acknowledging, even if the popup closes
  }
  if (msg.type === "getBridgeConfig") {
    readBridgeConfig().then((config) => sendResponse({ ok: true, ...config }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg && msg.type === "translate") {
    translate(msg.text, msg.targetLang, msg.sourceLang)
      .then((translated) => sendResponse({ ok: true, translated }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async response
  }
  if (msg.type === "recogHealth") {
    recogHealth().then(sendResponse).catch((err) =>
      sendResponse({ ok: false, code: "failed", message: String((err && err.message) || err) }));
    return true;
  }
  if (msg.type === "recogRetry") {
    if (!extensionSender(sender, ["popup.html"])) {
      sendResponse({ ok: false, code: "forbidden_origin" }); return;
    }
    (async () => {
      await restoreRecorder();
      const context = await readPageContext(msg.tabId);
      if (recog.tabId !== msg.tabId || !context || context.videoId !== msg.videoId ||
          context.captionAvailability !== "absent") return { ok: false, code: "captions_changed" };
      return chrome.runtime.sendMessage({ type: "recogOffscreenRetry", target: "offscreen",
        segmentId: msg.segmentId, timelineEpoch: msg.timelineEpoch });
    })().then(sendResponse).catch(err => sendResponse({ ok: false, code: err?.code || "failed" }));
    return true;
  }
  if (msg.type === "recogSettings") {
    if (!extensionSender(sender, ["popup.html"])) {
      sendResponse({ ok: false, code: "forbidden_origin" });
      return;
    }
    (async () => {
      const config = await readBridgeConfig();
      const health = await recogHealth(config);
      if (!health.ok) return health;
      const client = YtdsBridge.createClient({ base: config.bridgeBase, token: config.bridgeToken });
      return msg.patch ? client.updateSettings(msg.patch) : client.getSettings();
    })().then(sendResponse).catch(err => sendResponse({ ok: false, code: err?.code || "failed" }));
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
  if (msg.type === "recognitionAbandoned") {
    recogAbandon(msg, sender).then(sendResponse).catch(() => sendResponse({ ok: false }));
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
}
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (["recogStart", "recogStop", "recogStatus", "mediaReport", "recognitionAbandoned",
    "recogState", "recognizedCues", "recogStopped"].includes(msg?.type)) {
    restoreRecorder().then(() => handleMessage(msg, sender, reply)).catch(() => reply({ ok: false, code: "failed" }));
    return true;
  }
  return handleMessage(msg, sender, reply);
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
