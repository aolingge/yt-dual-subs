/* Optional local audio alignment. Runs in a dedicated extension page so popup
   closure cannot interrupt an analysis. All API destinations are fixed. */
"use strict";
const AUDIO_BASE = "http://127.0.0.1:8767";
const AUDIO_ORIGINS = ["http://127.0.0.1/*"];
// Result format this build applies: 2 adds the track position of every
// sentence and the audio fingerprint to the helper's cache identity.
const AUDIO_RECORD_VERSION = 2;
const audioEl = id => document.getElementById(id);
const t = (key, fallback = "", subs = []) => chrome.i18n.getMessage(key, subs) || fallback || key;
const tabId = Number(new URLSearchParams(location.search).get("tab"));
let context = null;
let jobId = "";
let cursor = 0;
let segments = [];
let applied = 0;
let pollTimer = null;
let lastSaved = 0;
let permissionReady = false;
let starting = false;
let recordContext = null;
let lastIdentityCheck = 0;

// Milliseconds typed by the user for a trimmed local file, else 0.
function offsetMs() {
  const value = Number(audioEl("offset").value);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : 0;
}

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

// The popup reads its status from the video tab, so the page that owns the job
// reports progress and failure there instead of only in its own window.
function setJobState(state) {
  if (recordContext) tabMessage({ type: "audioJobState", state });
}

async function api(path, options = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), options.body instanceof File ? 120000 : 5000);
  try {
    const response = await fetch(AUDIO_BASE + path, { ...options, signal: abort.signal, credentials: "omit", redirect: "error" });
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
    audioTooShort: "audioTooShort", audioMismatch: "audioMismatch",
    invalidRequest: "audioInvalidRequest", notFound: "audioJobLost", permission: "audioPermissionDenied" };
  status(keys[error.message] || "audioFailed", true);
  if (error.detail) audioEl("delivery").textContent = error.detail;
  if (error.message === "helperOffline" || error.message === "ffmpegMissing") audioEl("setup").open = true;
}

function controls(running) {
  audioEl("start").disabled = running || !context?.cues?.length;
  audioEl("local").disabled = running || !context?.cues?.length;
  audioEl("language").disabled = running;
  audioEl("offset").disabled = running;
  audioEl("cancel").hidden = !running;
}

async function refreshContext() {
  context = await tabMessage({ type: "audioContext" });
  if (!context?.ok) { context = null; status("audioNoCues", true); controls(false); return false; }
  audioEl("videoTitle").textContent = context.title || context.videoId;
  audioEl("cueInfo").textContent = context.cues.length + " " + t("audioNeedTiming");
  if (context.audioStale) audioEl("delivery").textContent = t("audioStaleCache");
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

// Length of the subtitles that were sent for alignment, for the "your file is
// shorter than the subtitles" hint.
function captionEndMs() {
  const ends = (context?.cues || []).map(c => (Number(c.start) || 0) + (Number(c.dur) || 0));
  return ends.length ? Math.max(...ends) : 0;
}

function captionEndSeconds() {
  return Math.round(captionEndMs() / 1000);
}

// Ask the browser for a local file's duration before uploading it. The helper
// checks the decoded audio again; this only makes a mistyped offset or a clip
// that stops early visible immediately instead of after a long model run.
function fileDurationMs(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const probe = document.createElement("audio");
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      probe.removeAttribute("src");
      resolve(value);
    };
    probe.preload = "metadata";
    probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? Math.round(probe.duration * 1000) : 0);
    probe.onerror = () => done(0);
    probe.src = url;
    setTimeout(() => done(0), 5000);
  });
}

// Identity of the audio a job belongs to: the video's public track, or a local
// file described by its size and the hash of its first 4 MiB. The helper
// recomputes it from the bytes it receives, so replacing the file produces a
// new job instead of reusing word times measured on the previous recording.
const AUDIO_HEAD_BYTES = 4 * 1024 * 1024;
async function audioIdentity(file) {
  if (!file) return "video";
  const digest = await crypto.subtle.digest("SHA-256", await file.slice(0, AUDIO_HEAD_BYTES).arrayBuffer());
  const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  return "local:" + file.size + "-" + hex.slice(0, 16);
}

// The job belongs to the video and subtitle track it started from. Polling the
// tab's identity lets a switched video or track stop the work instead of
// burning CPU on results that may no longer be applied.
async function staleJob() {
  if (Date.now() - lastIdentityCheck < 1000) return "";
  lastIdentityCheck = Date.now();
  const identity = await tabMessage({ type: "audioIdentity" });
  if (!identity?.ok) return "audioVideoChanged";
  if (identity.videoId !== recordContext.videoId) return "audioVideoChanged";
  if (identity.cuesKey !== recordContext.cuesKey) return "audioSubtitlesChanged";
  return "";
}

async function stopStale(reason) {
  try { await api("/jobs/" + jobId + "/cancel", { method: "POST" }); } catch (_e) { /* job may be gone */ }
  jobId = "";
  status(reason, true);
  controls(false);
}

async function poll() {
  if (!jobId) return;
  try {
    const reason = await staleJob();
    if (reason) { await stopStale(reason); return; }
    const snapshot = await api("/jobs/" + jobId + "?after=" + cursor);
    if (snapshot.segments?.length) {
      segments.push(...snapshot.segments);
      cursor = snapshot.nextCursor;
      const reply = await tabMessage({ type: "applyAudioTiming", record: { ...recordContext, segments: snapshot.segments } });
      // Nothing applied must never read as delivered: the highlight would keep
      // showing estimated times while the page claims the audio result is in.
      if (!reply?.ok) audioEl("delivery").textContent = t("audioVideoChanged");
      else if (Number(reply.count)) { applied += Number(reply.count); audioEl("delivery").textContent = t("audioDelivered"); }
      else audioEl("delivery").textContent = t("audioStaleCache");
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
      setJobState("failed");
      const error = new Error(snapshot.error);
      if (snapshot.error === "audioTooShort" && snapshot.audioMs) {
        error.detail = t("audioLengthDetail", "", [Math.round(snapshot.audioMs / 1000), captionEndSeconds()]);
      }
      showError(error);
      controls(false);
      return;
    }
    if (["done", "cancelled"].includes(snapshot.status) && cursor >= snapshot.aligned) {
      await saveResults();
      setJobState("done");
      if (!snapshot.aligned && snapshot.status === "done") status("audioNoMatches", true);
      // The helper finished, but the page refused every sentence: that is not
      // a success, and the popup must be able to say what to do about it.
      else if (!applied) status("audioStaleCache", true);
      controls(false);
      return;
    }
    pollTimer = setTimeout(poll, cursor < snapshot.aligned ? 20 : 1500);
  } catch (error) { setJobState("failed"); showError(error); controls(false); }
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
    const health = await api("/health");
    if (health.service !== "yt-dual-subs-alignment") throw new Error("helperOffline");
    // A helper of an older result format cannot produce track-locked word
    // times, and its results would be refused silently after a full model run.
    // Restarting the helper from this folder is the fix, so say so before it
    // starts rather than after it finishes.
    if (!(Number(health.version) >= AUDIO_RECORD_VERSION)) {
      audioEl("status").textContent = t("audioHelperOld",
        "The local helper is older than this extension build. Restart it from tools/Start-AudioAlignment.cmd, then retry.");
      audioEl("status").classList.add("error");
      audioEl("setup").open = true;
      controls(false);
      return;
    }
    const language = audioEl("language").value;
    const offset = file ? offsetMs() : 0;
    if (file) {
      const duration = await fileDurationMs(file);
      if (duration && offset + duration + 250 < captionEndMs()) {
        const error = new Error("audioTooShort");
        error.detail = t("audioLengthDetail", "", [Math.round((offset + duration) / 1000), captionEndSeconds()]);
        throw error;
      }
    }
    await YtdsSettings.set({ karaoke: true });
    const request = { videoId: context.videoId, language, offsetMs: offset,
      positionMs: context.positionMs, audioId: await audioIdentity(file),
      cues: context.cues.filter(c => c.tokens.length) };
    // The result is only valid for this video, these subtitles, this model,
    // this helper version and this audio offset — all of them identify the job.
    recordContext = { videoId: context.videoId, sourceLang: context.sourceLang,
      cuesKey: context.cuesKey, model: health.models?.[language] || "",
      version: Number(health.version) || 0, offsetMs: offset };
    const created = await api("/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
    jobId = created.id;
    cursor = 0; segments = []; applied = 0; lastSaved = 0; lastIdentityCheck = Date.now();
    setJobState("running");
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
  setJobState("done");
});
// Closing the page ends the analysis, so the video tab must stop claiming that
// alignment is still running.
window.addEventListener("beforeunload", () => { if (jobId) setJobState("failed"); });
chrome.permissions.contains({ origins: AUDIO_ORIGINS }).then(value => { permissionReady = value; });
refreshContext().catch(() => { status("audioNoCues", true); controls(false); });
