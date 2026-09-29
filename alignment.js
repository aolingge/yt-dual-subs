/* Optional local audio alignment. Runs in a dedicated extension page so popup
   closure cannot interrupt an analysis. All API destinations are fixed. */
"use strict";
const AUDIO_BASE = "http://127.0.0.1:8765";
const AUDIO_ORIGINS = ["http://127.0.0.1/*"];
const audioEl = id => document.getElementById(id);
const t = (key, fallback = "") => chrome.i18n.getMessage(key) || fallback || key;
const tabId = Number(new URLSearchParams(location.search).get("tab"));
let context = null;
let jobId = "";
let cursor = 0;
let segments = [];
let pollTimer = null;
let lastSaved = 0;
let permissionReady = false;
let starting = false;
let recordContext = null;

function tabMessage(message) {
  return new Promise(resolve => {
    if (!Number.isInteger(tabId) || tabId < 0) { resolve(null); return; }
    chrome.tabs.sendMessage(tabId, message, reply => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(reply);
    });
  });
}

function status(key, error = false, suffix = "") {
  audioEl("status").textContent = t(key) + suffix;
  audioEl("status").classList.toggle("error", error);
}

async function api(path, options = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.body instanceof File ? 120000 : 5000);
  try {
    const response = await fetch(AUDIO_BASE + path, { ...options, signal: abort.signal, credentials: "omit" });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || "alignmentFailed");
    return value;
  } catch (error) {
    if (error instanceof TypeError || error.name === "AbortError") throw new Error("helperOffline");
    throw error;
  } finally { clearTimeout(timer); }
}

function showError(error) {
  const keys = { helperOffline: "audioOffline", youtubeUnavailable: "audioYoutubeFailed",
    unsupportedLanguage: "audioUnsupported", ffmpegMissing: "audioFfmpegMissing",
    audioInvalid: "audioInvalid", audioTooLong: "audioTooLong", busy: "audioBusy",
    invalidRequest: "audioInvalidRequest", notFound: "audioJobLost", permission: "audioPermissionDenied" };
  status(keys[error.message] || "audioFailed", true);
  if (error.message === "helperOffline" || error.message === "ffmpegMissing") audioEl("setup").open = true;
}

function controls(running) {
  audioEl("start").disabled = running || !context?.cues?.length;
  audioEl("local").disabled = running || !context?.cues?.length;
  audioEl("language").disabled = running;
  audioEl("cancel").hidden = !running;
}

async function refreshContext() {
  context = await tabMessage({ type: "audioContext" });
  if (!context?.ok) { context = null; status("audioNoCues", true); controls(false); return false; }
  audioEl("videoTitle").textContent = context.title || context.videoId;
  audioEl("cueInfo").textContent = context.cues.length + " " + t("audioNeedTiming");
  const language = String(context.sourceLang).split("-")[0];
  if (["de", "en"].includes(language)) audioEl("language").value = language;
  else if (language !== "auto") { status("audioUnsupported", true); context = null; controls(false); return false; }
  if (!context.cues.length) status("audioAlreadyTimed");
  controls(false);
  return true;
}

async function saveResults() {
  if (!recordContext || !segments.length) return;
  const record = { ...recordContext, segments };
  const reply = await chrome.runtime.sendMessage({ type: "saveAudioTiming", record });
  if (!reply?.ok) throw new Error("audioCacheFailed");
  lastSaved = Date.now();
}

async function poll() {
  if (!jobId) return;
  try {
    const snapshot = await api("/jobs/" + jobId + "?after=" + cursor);
    if (snapshot.segments?.length) {
      segments.push(...snapshot.segments);
      cursor = snapshot.nextCursor;
      const reply = await tabMessage({ type: "applyAudioTiming", record: { ...recordContext, segments: snapshot.segments } });
      audioEl("delivery").textContent = reply?.ok ? t("audioDelivered") : t("audioVideoChanged");
      if (Date.now() - lastSaved > 5000) await saveResults();
    }
    audioEl("progress").hidden = false;
    audioEl("progress").value = snapshot.total ? snapshot.done / snapshot.total * 100 : 0;
    const states = { awaitingAudio: "audioStarting", queued: "audioQueued", downloadingAudio: "audioDownloading",
      decodingAudio: "audioDecoding", loadingModel: "audioModel", aligning: "audioAligning",
      done: "audioDone", cancelled: "audioCancelled" };
    const counts = snapshot.total ? ` · ${snapshot.done}/${snapshot.total} · ${t("audioAligned")} ${snapshot.aligned}` : "";
    status(states[snapshot.status] || "audioStarting", false, counts);
    if (snapshot.status === "error") {
      await saveResults();
      showError(new Error(snapshot.error));
      controls(false);
      return;
    }
    if (["done", "cancelled"].includes(snapshot.status) && cursor >= snapshot.aligned) {
      await saveResults();
      if (!snapshot.aligned && snapshot.status === "done") status("audioNoMatches", true);
      controls(false);
      return;
    }
    pollTimer = setTimeout(poll, cursor < snapshot.aligned ? 20 : 1500);
  } catch (error) { showError(error); controls(false); }
}

async function start(file) {
  if (starting) return;
  starting = true;
  controls(true);
  status("audioStarting");
  try {
    // Request directly in the user's click/change gesture, before other awaits.
    if (!permissionReady) {
      permissionReady = await chrome.permissions.request({ origins: AUDIO_ORIGINS });
      if (!permissionReady) throw new Error("permission");
    }
    if (!await refreshContext() || !context.cues.length) return;
    controls(true);
    await api("/health");
    await YtdsSettings.set({ karaoke: true });
    const request = { videoId: context.videoId, language: audioEl("language").value,
      positionMs: context.positionMs, cues: context.cues.filter(c => c.tokens.length) };
    recordContext = { videoId: context.videoId, sourceLang: context.sourceLang };
    const created = await api("/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
    jobId = created.id;
    cursor = 0; segments = []; lastSaved = 0;
    clearTimeout(pollTimer);
    if (file) await api("/jobs/" + jobId + "/audio", {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file
    });
    else await api("/jobs/" + jobId + "/start", { method: "POST" });
    await poll();
  } catch (error) { showError(error); controls(false); }
  finally { starting = false; }
}

document.documentElement.lang = chrome.i18n.getUILanguage();
document.title = "YT Dual Subs · " + t("audioOpen");
for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
audioEl("start").addEventListener("click", () => start(null));
audioEl("local").addEventListener("click", () => audioEl("audioFile").click());
audioEl("audioFile").addEventListener("change", event => {
  const file = event.target.files?.[0];
  if (file && file.size <= 512 * 1024 * 1024) start(file);
  else if (file) showError(new Error("audioTooLong"));
  event.target.value = "";
});
audioEl("cancel").addEventListener("click", async () => {
  try { if (jobId) await api("/jobs/" + jobId + "/cancel", { method: "POST" }); }
  catch (error) { showError(error); }
});
chrome.permissions.contains({ origins: AUDIO_ORIGINS }).then(value => { permissionReady = value; });
refreshContext().catch(() => { status("audioNoCues", true); controls(false); });
