// popup.js
// Locally stage settings, then batch browser sync writes; content.js applies them live.
// The live preview uses the SAME font map + rgba/outline logic as content.js.

// ---- shared settings model (MUST match content.js DEFAULTS) --------------
const DEFAULTS = {
  enabled: true,
  targetLang: "zh-CN",
  backend: "tlang",            // "tlang" | "gtx" | "fast"
  order: "orig-top",           // "orig-top" | "trans-top"
  rowGap: 4,
  overlayWidthPct: 0,          // 0 = automatic, otherwise 20–96% of the player
  position: "bottom",          // "top" | "center" | "bottom"
  offsetMs: 0,                 // subtitle sync nudge, ms (+ = show later)
  // study aids (see the "study mode" section below)
  repeatCount: 0,              // 0 = off, N = play each sentence N times, -1 = loop
  studyRate: 0.75,             // playback rate used while repeating a sentence
  karaoke: true,               // prefer caption word times; optional labeled estimate
  karaokeApproximate: true,
  // where word times may come from: "auto" (captions, matching automatic captions,
  // then estimation) | "approximate" (no extra fetch, no audio model) | "audio"
  // (verified local audio alignment as well)
  timingMode: "auto",
  karaokeBg: "#ffd65c",
  karaokeTextColor: "#161616",
  karaokeOpacity: 0.95,
  wordLookup: true,            // translate a word after a short mouse hover
  revealMode: "always",        // translation visibility: "always" | "hover" | "manual"
  autoCaptions: true,          // turn YouTube's own CC on for you when the page loads
  posMode: "preset",           // "preset" | "custom"
  posXpct: 50,
  posYpct: 90,
  // original line
  showOriginal: true,
  origFont: "system",
  origSize: 22,
  origColor: "#ffffff",
  origBg: "#080808",
  origBgOpacity: 0.6,
  origStroke: "#000000",
  origStrokeOpacity: 0,
  // translation line
  showTranslation: true,
  transFont: "system",
  transSize: 24,
  transColor: "#ffe98a",
  transBg: "#080808",
  transBgOpacity: 0.6,
  transStroke: "#000000",
  transStrokeOpacity: 0,
  // Bilibili only: the hand-picked caption track ("<videoKey>|<lan>", empty =
  // automatic) and the last track list the page reported (JSON, for the
  // manual switch). They are stored with the other settings so the choice
  // survives a reload, and are reset per video by the reader.
  bbTrackId: "",
  bbTracks: "",
  // The local Deutsch Overlay bridge. Empty base URL means "not configured":
  // the recognition controls stay disabled rather than probing a port that is
  // probably not there.
  bridgeBase: "",
  bridgeToken: ""
};

// Font key -> font-family stack (shared with content.js render).
const FONT_STACKS = {
  system:  'system-ui, -apple-system, "Segoe UI", sans-serif',
  roboto:  'Roboto, "YouTube Noto", sans-serif',
  noto:    '"Noto Sans", "YouTube Noto", sans-serif',
  arial:   'Arial, Helvetica, sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  times:   '"Times New Roman", Times, serif',
  mono:    '"Courier New", ui-monospace, monospace',
  cjk:     '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif'
};
function fontStack(key) { return FONT_STACKS[key] || FONT_STACKS.system; }

// ---- color helpers (tolerant of #rgb / #rrggbb) --------------------------
function hexToRgb(hex) {
  let h = String(hex || "").trim().replace(/^#/, "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}
function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  let a = Number(alpha);
  if (!isFinite(a)) a = 1;
  a = Math.max(0, Math.min(1, a));
  return `rgba(${r},${g},${b},${a})`;
}
function outlineShadow(strokeHex, strokeOpacity) {
  const a = Number(strokeOpacity);
  if (!isFinite(a) || a <= 0) return "0 1px 2px rgba(0,0,0,0.9)";
  const c = rgba(strokeHex, a);
  const o = 1.2;
  return [
    `-${o}px -${o}px 0 ${c}`, `0 -${o}px 0 ${c}`, `${o}px -${o}px 0 ${c}`,
    `${o}px 0 0 ${c}`, `${o}px ${o}px 0 ${c}`, `0 ${o}px 0 ${c}`,
    `-${o}px ${o}px 0 ${c}`, `-${o}px 0 0 ${c}`
  ].join(", ");
}

const $ = (id) => document.getElementById(id);
let state = { ...DEFAULTS };
let activeLine = "trans";        // which line the tab editor is bound to
let exportVariant = "bi";        // SRT export content: "bi" | "orig" | "trans" (local, not stored)

// The popup is opened over some tab, and its settings belong to THAT tab's site:
// Bilibili keeps its own target language and line order. This document lives on
// the extension origin, where site.js's own host detection says nothing, so the
// adapter is chosen from the active tab's URL instead.
let site = globalThis.YtdsSite ? YtdsSite.forPlatform("youtube") : null;
let lastStatus = null;
let biliNotice = '';   // one-off line in the Bilibili card, replaced by the next poll
const toStore = (patch) => (site ? site.toStore(patch) : patch);
const fromStore = (record) => (site ? site.fromStore(record) : record);
const platformOfUrl = (url) => (globalThis.YtdsSite && YtdsSite.platformOfUrl
  ? YtdsSite.platformOfUrl(url) : "youtube");

// ---- i18n ----------------------------------------------------------------
// Safe wrapper: returns the localized message, or the fallback if the key is
// missing/empty so the hardcoded markup keeps working in any environment.
function t(key, fallback) {
  try {
    const m = chrome.i18n && chrome.i18n.getMessage(key);
    if (m) return m;
  } catch (_e) { /* ignore */ }
  return fallback;
}

// Sync offset is stored in ms but shown in seconds: "+0.5s" = lines appear half
// a second later, "-0.5s" = half a second earlier.
function formatOffset(ms) {
  const v = (Number(ms) || 0) / 1000;
  if (!v) return "0.0s";
  return (v > 0 ? "+" : "-") + Math.abs(v).toFixed(1) + "s";
}

// Walk the DOM once and fill every data-i18n* attribute. Only overwrite when
// the looked-up message is non-empty, so a missing key leaves the hardcoded
// fallback text in place.
function applyI18n() {
  // Keep the document language in sync with the actual UI locale so screen
  // readers / hyphenation match the rendered text (default_locale is "en").
  try {
    const ui = chrome.i18n && chrome.i18n.getUILanguage();
    if (ui) document.documentElement.lang = ui;
  } catch (_e) { /* ignore */ }
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.dataset.i18n);
    if (m) el.textContent = m;
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-html"));
    if (m) el.innerHTML = m;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-title"));
    if (m) el.title = m;
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-aria"));
    if (m) el.setAttribute("aria-label", m);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const m = chrome.i18n.getMessage(el.getAttribute("data-i18n-placeholder"));
    if (m) el.setAttribute("placeholder", m);
  });
}

// per-line key prefixing so one set of controls edits either line.
// The per-tab "show this line" label is resolved live via t() in
// bindLineControls so it follows the active locale.
const LINE = {
  trans: {
    show: "showTranslation", font: "transFont", size: "transSize",
    color: "transColor", bg: "transBg", bgOpacity: "transBgOpacity",
    stroke: "transStroke", strokeOpacity: "transStrokeOpacity"
  },
  orig: {
    show: "showOriginal", font: "origFont", size: "origSize",
    color: "origColor", bg: "origBg", bgOpacity: "origBgOpacity",
    stroke: "origStroke", strokeOpacity: "origStrokeOpacity"
  }
};

// ---- persistence ---------------------------------------------------------
function setKey(key, val) {
  state[key] = val;
  const o = {}; o[key] = val;
  persistSettings(o);
  paintPreview();
}

async function persistSettings(patch) {
  const message = $("settingsMsg");
  try {
    await YtdsSettings.set(toStore(patch));
    if (message) message.hidden = true;
    return true;
  } catch (_e) {
    if (message) {
      message.textContent = t("settingsSaveFailed", "设置保存失败，请重新打开扩展后重试。");
      message.hidden = false;
    }
    return false;
  }
}

// ---- live preview (mirrors content.js styleOverlay) ----------------------
function paintPreview() {
  const highlight = $("karaokeStyle");
  if (highlight) {
    highlight.style.setProperty("--ytds-karaoke-bg", rgba(state.karaokeBg, state.karaokeOpacity));
    highlight.style.setProperty("--ytds-karaoke-color", state.karaokeTextColor);
    highlight.style.setProperty("--ytds-karaoke-border", state.karaokeBg);
    highlight.disabled = !state.karaoke;
  }
  const ov = $("prevOverlay"), o = $("prevOrig"), t = $("prevTrans");
  if (!ov || !o || !t) return;

  ov.style.flexDirection = state.order === "trans-top" ? "column" : "column-reverse";
  ov.style.width = state.overlayWidthPct > 0 ? state.overlayWidthPct + "%" : "";
  ov.classList.toggle("ytds-fixed-width", state.overlayWidthPct > 0);
  ov.style.gap = (Number(state.rowGap) || 0) / 2 + "px"; // preview is ~half scale

  // scale font sizes to the compact preview strip (~half of player px)
  o.style.fontFamily = fontStack(state.origFont);
  o.style.fontSize = Math.max(9, Math.round(state.origSize / 2)) + "px";
  o.style.color = state.origColor;
  o.style.background = rgba(state.origBg, state.origBgOpacity);
  o.style.textShadow = outlineShadow(state.origStroke, state.origStrokeOpacity);
  o.style.display = state.showOriginal ? "" : "none";

  t.style.fontFamily = fontStack(state.transFont);
  t.style.fontSize = Math.max(9, Math.round(state.transSize / 2)) + "px";
  t.style.color = state.transColor;
  t.style.background = rgba(state.transBg, state.transBgOpacity);
  t.style.textShadow = outlineShadow(state.transStroke, state.transStrokeOpacity);
  t.style.display = state.showTranslation ? "" : "none";

  const pv = $("preview");
  if (pv) {
    const frame = pv.querySelector(".preview-frame");
    if (frame) {
      frame.style.justifyContent =
        state.position === "top" ? "flex-start" :
        state.position === "center" ? "center" : "flex-end";
    }
    pv.style.opacity = state.enabled ? "1" : "0.4";
  }
}

// ---- segmented controls --------------------------------------------------
function paintSegs() {
  const sync = (sel, val) =>
    document.querySelectorAll(sel + " button").forEach((b) => {
      const on = b.dataset.val === val;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on)); // expose state to screen readers
    });
  sync("#backend", state.backend);
  sync("#order", state.order);
  // a custom (dragged) position highlights no preset
  sync("#position", state.posMode === "custom" ? "__none__" : state.position);
  // study card: data-val is a string, so compare numbers as strings
  sync("#repeatCount", String(state.repeatCount));
  sync("#studyRate", String(state.studyRate));
  sync("#revealMode", state.revealMode);
}

// ---- export (SRT download) -----------------------------------------------
// The export variant is a transient choice (not persisted, so it stays out of
// the shared DEFAULTS contract between popup.js and content.js).
function paintExportSeg() {
  document.querySelectorAll("#exportVariant button").forEach((b) => {
    const on = b.dataset.val === exportVariant;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

// Active tab id only — the tab id needs no "tabs" permission. We avoid reading
// tab.url (which would) and instead detect a non-YouTube page by a null reply
// from sendToTab (no content script there to answer).
function getActiveTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(tabs && tabs[0]);
      });
    } catch (_e) { resolve(null); }
  });
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }   // no content script
        resolve(resp);
      });
    } catch (_e) { resolve(null); }
  });
}

// ---- page status ---------------------------------------------------------
// The content script answers {type:"status"} with a small snapshot of what the
// video page is doing; this turns it into one readable line, so a blank or slow
// translation line is explainable instead of mysterious.
function statusText(s) {
  if (!s) {
    return t("statusNoReplyAny",
      "没有收到页面状态：如果这是 YouTube 或 B 站视频页，请刷新一次页面。");
  }
  const bili = s.platform === "bilibili";
  if (!s.enabled) return t("statusOff", "扩展已关闭，字幕不会显示。");
  const parts = [];
  if (s.mode === "cues") {
    parts.push(bili
      ? t("statusCuesBili", "字幕源：B 站中文字幕轨")
      : t("statusCues", "字幕源：YouTube 字幕轨"));
  }
  else if (s.mode === "scrape") parts.push(t("statusScrape", "字幕源：画面字幕（即时显示／字幕轨加载中）"));
  else {
    parts.push(bili
      ? t("statusIdleBili", "等待 B 站中文字幕轨；可在下方切换字幕轨或导入 SRT")
      : t("statusIdle", "等待视频提供字幕；请检查 YouTube 的 CC 开关和字幕轨"));
  }
  if (s.cueCount) parts.push(s.cueCount + " " + t("statusLines", "句"));
  if (s.mode === "cues") {
    const lang = String(s.sourceLang || "auto");
    parts.push(t("statusSourceLanguage", "原文轨") + "：" + lang);
  }
  if (s.transSource === "youtube") parts.push(t("statusTransYoutube", "译文：YouTube 整轨"));
  else if (s.transSource === "google") parts.push(t("statusTransGoogle", "译文：Google 免费接口"));
  else if (s.transSource === "waiting") parts.push(t("statusTransWaiting", "译文：等待中"));
  if (s.cached) parts.push(t("statusCached", "本视频已即时恢复"));
  if (s.cooldownSec > 0) {
    parts.push(t("statusCooldown", "Google 接口限流中，稍后自动重试") +
      " (" + s.cooldownSec + "s)");
  }
  return parts.join(" · ");
}

// ---- Bilibili panel ------------------------------------------------------
// Only shown when the active tab is a Bilibili video page. It carries the two
// things that are specific to that site: which Chinese caption track to read
// (bound to THIS video and part), and why the overlay currently has no caption.
const BB_REASON_KEYS = {
  unsupported_page: "bbUnsupportedPage",
  loading: "bbLoading",
  need_login: "bbNeedLogin",
  no_track: "bbNoTrack",
  not_chinese: "bbNotChinese",
  fetch_failed: "bbFetchFailed",
  import_missing: "bbImportMissing"
};

function parseTracks(json) {
  try {
    const list = JSON.parse(json || "[]");
    return Array.isArray(list) ? list : [];
  } catch (_e) { return []; }
}

function renderBiliCard(s) {
  const card = $("biliCard");
  if (!card) return;
  const on = !!s && s.platform === "bilibili";
  card.hidden = !on;
  if (!on) return;

  const select = $("bbTrack");
  if (select) {
    const current = String(s.manualTrack || "");
    const wanted = [[
      "", t("bbTrackAuto", "自动（优先人工中文轨）")
    ]].concat(parseTracks(s.tracks).map((tr) => {
      const doc = String(tr.doc || tr.lan || "");
      return [String(tr.lan || ""), tr.ai ? doc + " · " + t("bbTrackAiTag", "自动生成") : doc];
    }));
    // Rebuild only when the list or the selection actually changed: the popup
    // polls every 1.5 s and must not fight the user's open dropdown.
    const signature = JSON.stringify(wanted) + "|" + current;
    if (select.dataset.sig !== signature) {
      select.dataset.sig = signature;
      select.textContent = "";
      for (const [value, label] of wanted) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
      }
      select.value = wanted.some(([value]) => value === current) ? current : "";
    }
  }

  const el = $("bbStatus");
  if (el) {
    const bound = String(s.importName || "");
    const reason = bound ? "" : String(s.nocuesReason || "");
    const key = BB_REASON_KEYS[reason];
    // Which source is on screen wins over why the page has nothing: text that
    // came from the recognizer (or a file) is the reason there are subtitles at
    // all, and calling it the uploader's captions would be a lie.
    let text = "";
    if (s.cueSource === "recognized") {
      text = t("bbRecognizedActive", "字幕来自本机语音识别") +
        (s.recognitionCueCount ? "（" + s.recognitionCueCount + " " + t("statusLines", "句") + "）" : "");
    } else if (bound) {
      text = t("bbImportActive", "字幕来自导入的文件") + "：" + bound +
        (s.importCount ? "（" + s.importCount + " " + t("statusLines", "句") + "）" : "");
    } else if (key) {
      text = t(key, "");
    }
    const detail = reason === "fetch_failed" ? String(s.nocuesDetail || "") : "";
    const line = [text, detail].filter(Boolean).join("　");
    if (el.textContent !== line) el.textContent = line;
    el.hidden = !line;
  }

  const clear = $("bbClear");
  if (clear) clear.disabled = !String(s.importName || "").length;
}

// The file is read in the popup and handed to the content script as text: the
// extension never uploads it, and the page never sees a File object.
async function onImportFile(file) {
  if (!file) return;
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;
  let text = "";
  try { text = await file.text(); } catch (_e) { text = ""; }
  if (!text) { setBiliNotice(t("bbImportUnreadable", "无法读取该文件。")); return; }
  const resp = await sendToTab(tab.id, { type: "importSrt", name: file.name, text });
  if (!resp || !resp.ok) {
    setBiliNotice(t("bbImportFailed", "导入失败：") + String((resp && resp.reason) || "unknown"));
    return;
  }
  setBiliNotice(t("bbImportDone", "已导入") + "：" + resp.name + "（" + resp.count + " " +
    t("statusLines", "句") + "）");
  refreshStatus();
}

async function onClearImport() {
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;
  await sendToTab(tab.id, { type: "clearSrt" });
  setBiliNotice(t("bbImportCleared", "已解除本地字幕绑定。"));
  refreshStatus();
}

// A one-off message in the Bilibili card's status line, replaced by the next
// poll on the next status refresh.
function setBiliNotice(text) {
  const el = $("bbStatus");
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
  biliNotice = text;
  setTimeout(() => { if (biliNotice === text) { biliNotice = ""; refreshStatus(); } }, 4000);
}

// The pick is stored as "<videoKey>|<lan>", so a choice made on one part can
// never be applied to another part or another video.
function onBiliTrackChange() {
  const select = $("bbTrack");
  const videoId = lastStatus && lastStatus.videoId;
  if (!select || !videoId) return;
  const value = select.value ? videoId + "|" + select.value : "";
  if (String(state.bbTrackId || "") === value) return;
  state.bbTrackId = value;
  persistSettings({ bbTrackId: value });
}

// ---- on-device recognition card ------------------------------------------
// The button is the user gesture the browser requires before a tab may be
// captured, so it is never enabled by anything except this card, and only when
// the page itself reported that the video has NO usable caption track. Every
// other answer — captions found, captions unknown, reader said nothing — leaves
// it disabled with the reason spelled out, because starting recognition over an
// existing caption set would show the user two different subtitles at once.
function recogGateText(s) {
  if (!s) return t("recogNoPage", "没有收到页面状态：请刷新视频页面。");
  if (s.captionAvailability === "absent") return "";
  if (s.captionAvailability === "present") {
    return t("recogHasCaptions", "该视频已有字幕轨，不需要语音识别。");
  }
  return t("recogUnknownCaptions", "还没有确认该视频有没有字幕轨，请先播放几秒或切换一次字幕轨。");
}

async function renderRecognizerCard(s, tabId) {
  const base = $("bridgeBase");
  const token = $("bridgeToken");
  const state = s && s.recognitionState ? String(s.recognitionState) : "";
  // A capture belongs to one tab. Looking at another video must not show the
  // first one's session, and the stop button must belong to what is on screen.
  const background = await sendToBackground({ type: "recogStatus" });
  const recorder = (background && background.recorder) || null;
  const otherTab = !!(recorder && recorder.tabId != null && tabId != null && recorder.tabId !== tabId);
  const shown = otherTab ? "" : state;
  const running = shown === "running" || shown === "starting";
  const configured = !!String((s && s.bridgeBase) || "").trim() &&
    !!String((s && s.bridgeToken) || "").trim();

  if (base && base.value !== String((s && s.bridgeBase) || "")) base.value = String((s && s.bridgeBase) || "");
  if (token && token.value !== String((s && s.bridgeToken) || "")) token.value = String((s && s.bridgeToken) || "");

  const start = $("recogStart");
  const stop = $("recogStop");
  const test = $("recogTest");
  const gate = recogGateText(s);
  if (start) {
    start.hidden = running;
    start.disabled = !configured || !gate || otherTab;
  }
  if (stop) stop.hidden = !running;
  if (test) test.disabled = !configured;

  const el = $("recogStatus");
  if (el) {
    const parts = [];
    if (otherTab) parts.push(t("recogOtherTab", "另一个标签页正在识别，请先在那里停止。"));
    else if (s && s.recognitionMessage) parts.push(String(s.recognitionMessage));
    else if (gate) parts.push(gate);
    else if (running) parts.push(t("recogRunning", "正在识别当前标签页的音频…"));
    else if (shown === "failed") parts.push(t("recogFailed", "语音识别失败。"));
    else if (!configured) parts.push(t("recogNotConfigured", "先填写本机服务地址和令牌。"));
    else parts.push(t("recogReady", "可以开始：该视频没有字幕轨。"));
    const line = parts.filter(Boolean).join("　");
    if (el.textContent !== line) el.textContent = line;
    el.hidden = !line;
  }
}

// One connection probe, on demand: a green line here means the machine is
// reachable and the token is right, which is the only thing that makes the
// recognition button meaningful.
async function onRecogTest() {
  const el = $("recogStatus");
  if (el) { el.textContent = t("recogTesting", "正在检查本机服务…"); el.hidden = false; }
  const resp = await sendToBackground({ type: "recogHealth" });
  if (!el) return;
  if (resp && resp.ok) {
    el.textContent = t("recogHealthOk", "已连接本机服务") +
      (resp.engine ? "（" + resp.engine + "）" : "") +
      (resp.languages && resp.languages.length ? " · " + resp.languages.join("/") : "");
  } else {
    el.textContent = t("recogHealthFail", "连接失败：") +
      String((resp && (resp.message || resp.code)) || "unreachable");
  }
  el.hidden = false;
}

async function onRecogStart() {
  const start = $("recogStart");
  if (start) start.disabled = true;
  const tab = await getActiveTab();
  if (!tab || tab.id == null) return;
  const resp = await sendToBackground({ type: "recogStart", tabId: tab.id });
  if (!resp || !resp.ok) {
    const el = $("recogStatus");
    if (el) {
      el.textContent = t("recogStartFail", "无法开始语音识别：") +
        String((resp && (resp.message || resp.reason || resp.code)) || "failed");
      el.hidden = false;
    }
  }
  refreshStatus();
}

async function onRecogStop() {
  await sendToBackground({ type: "recogStop" });
  refreshStatus();
}

function onBridgeFieldChange() {
  const patch = {
    bridgeBase: String($("bridgeBase")?.value || "").trim(),
    bridgeToken: String($("bridgeToken")?.value || "").trim()
  };
  if (state.bridgeBase === patch.bridgeBase && state.bridgeToken === patch.bridgeToken) return;
  state.bridgeBase = patch.bridgeBase;
  state.bridgeToken = patch.bridgeToken;
  persistSettings(patch);
  refreshStatus();
}

function sendToBackground(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    } catch (_e) { resolve(null); }
  });
}

async function refreshStatus() {
  const el = $("statusLine");
  if (!el) return;
  const tab = await getActiveTab();
  const resp = (tab && tab.id != null)
    ? await sendToTab(tab.id, { type: "status" }) : null;
  lastStatus = resp;
  el.textContent = statusText(resp);
  el.hidden = false;
  renderBiliCard(resp);
  await renderRecognizerCard(resp, tab && tab.id);
  const timing = $("karaokeStatus");
  const labels = {
    captions: t("karaokeStatusCaptions", "跟读：使用原字幕词时间"),
    automatic: t("karaokeStatusAutomatic", "跟读：已匹配同语言自动字幕词时间"),
    "automatic-partial": t("karaokeStatusAutomaticPartial", "跟读：部分词匹配自动字幕，其余为估算"),
    audio: t("karaokeStatusAudio", "跟读：使用音频对齐词时间"),
    estimated: t("karaokeStatusEstimated", "近似跟读：按音节、标点和本视频语速估算，不代表精确语音时间"),
    unavailable: t("karaokeStatusUnavailable", "此句无可靠词时间，显示完整句子"),
    waiting: t("karaokeStatusWaiting", "跟读：等待带有时间的原文字幕"),
    off: t("karaokeStatusOff", "逐词跟读已关闭")
  };
  const parts = [];
  if (resp) parts.push(labels[resp.wordTiming] || labels.waiting);
  // The audio model runs outside the page, so its progress and its failures have
  // to be reported separately from what the highlighted word times came from.
  if (resp && resp.audioJob === "running") parts.push(t("karaokeStatusAudioRunning", "音频对齐处理中…"));
  else if (resp && resp.audioJob === "failed") {
    parts.push(t("karaokeStatusAudioFailed", "音频对齐失败：确认本机辅助程序在运行，然后重新对齐"));
  }
  if (resp && resp.audioStale) {
    parts.push(t("karaokeStatusAudioStale", "原有的音频对齐结果已不适用于当前字幕，需要重新对齐"));
  }
  const timingText = parts.length ? parts.join(" · ") : "";
  if (timing && timing.textContent !== timingText) timing.textContent = timingText;
}

function startStatus() {
  refreshStatus();
  const timer = setInterval(refreshStatus, 1500);   // live while the popup is open
  window.addEventListener("unload", () => clearInterval(timer));
}

function showExportMsg(text, kind) {  const el = $("exportMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
  el.hidden = !text;
}

async function onExportClick() {
  const btn = $("exportBtn");
  const label = btn.textContent;
  showExportMsg("", null);
  btn.disabled = true;
  btn.textContent = t("exportWorking", "正在生成…");
  try {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) {
      showExportMsg(t("exportNotYoutube", "请在 YouTube 视频页面使用导出。"), "err");
      return;
    }
    const resp = await sendToTab(tab.id, { type: "exportSrt", variant: exportVariant });
    if (resp == null) {
      showExportMsg(t("exportNotYoutube", "请在 YouTube 视频页面使用导出。"), "err");
    } else if (resp.ok) {
      showExportMsg(t("exportDone", "已下载字幕") + " (" + (resp.count || 0) + ")", "ok");
    } else if (resp.reason === "notrans") {
      showExportMsg(t("exportNoTrans", "这个视频拿不到译文，试试「整句翻译」或换个目标语言。"), "err");
    } else if (resp.reason === "partial") {
      showExportMsg(t("exportPartial", "译文缺失，已停止导出以免错行。") +
        " (" + resp.missing + ")", "err");
    } else {
      showExportMsg(t("exportNoCues", "没有可下载的字幕，先播放几秒让字幕加载，再试一次。"), "err");
    }
  } catch (_e) {
    showExportMsg(t("exportFailed", "导出失败，刷新页面后重试。"), "err");
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---- per-line tab editor -------------------------------------------------
function bindLineControls() {
  const m = LINE[activeLine];
  $("lineShowLabel").textContent =
    t("lineShow", activeLine === "trans" ? "显示译文" : "显示原文");
  $("lineShow").checked = !!state[m.show];
  $("lineFont").value = state[m.font];
  $("lineSize").value = state[m.size];
  $("lineSizeV").textContent = state[m.size] + "px";
  $("lineColor").value = state[m.color];
  $("lineBg").value = state[m.bg];
  $("lineStroke").value = state[m.stroke];
  $("lineBgOpacity").value = state[m.bgOpacity];
  $("lineBgOpacityV").textContent = Math.round(state[m.bgOpacity] * 100) + "%";
  $("lineStrokeOpacity").value = state[m.strokeOpacity];
  $("lineStrokeOpacityV").textContent = Math.round(state[m.strokeOpacity] * 100) + "%";

  let activeTabId = "";
  document.querySelectorAll("#lineTabs .tab").forEach((b) => {
    const on = b.dataset.line === activeLine;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on)); // expose tab state to screen readers
    if (on) activeTabId = b.id;
  });
  // point the panel at whichever tab is now active
  const panel = $("lineEditor");
  if (panel && activeTabId) panel.setAttribute("aria-labelledby", activeTabId);
}

// ---- bind whole UI from state -------------------------------------------
function bindUI() {
  $("enabled").checked = state.enabled;
  const targetSelect = $("targetLang");
  const listedTarget = Array.from(targetSelect.options).some((option) =>
    option.value === state.targetLang);
  targetSelect.value = listedTarget ? state.targetLang : "__custom__";
  $("targetLangCustomRow").hidden = listedTarget;
  if (!listedTarget) $("targetLangCustom").value = state.targetLang;
  $("rowGap").value = state.rowGap;
  $("rowGapV").textContent = state.rowGap + "px";
  paintWidthControl();
  $("offsetMs").value = state.offsetMs;
  $("offsetMsV").textContent = formatOffset(state.offsetMs);
  $("karaoke").checked = state.karaoke;
  $("karaokeApproximate").checked = state.karaokeApproximate;
  $("timingMode").value = state.timingMode;
  $("karaokeBg").value = state.karaokeBg;
  $("karaokeTextColor").value = state.karaokeTextColor;
  $("karaokeOpacity").value = state.karaokeOpacity;
  $("karaokeOpacityV").textContent = Math.round(state.karaokeOpacity * 100) + "%";
  $("wordLookup").checked = state.wordLookup;
  $("autoCaptions").checked = state.autoCaptions;
  paintSegs();
  paintExportSeg();
  bindLineControls();
  paintPreview();
}

function paintWidthControl() {
  const value = Number(state.overlayWidthPct) || 0;
  $("overlayWidthPct").value = value > 0 ? value : 92;
  $("overlayWidthPctV").textContent = value > 0 ? value + "%" : t("widthAuto", "自动");
}

// ---- wire events ---------------------------------------------------------
function wire() {
  $("enabled").addEventListener("change", (e) => setKey("enabled", e.target.checked));
  $("targetLang").addEventListener("change", (e) => {
    const custom = e.target.value === "__custom__";
    $("targetLangCustomRow").hidden = !custom;
    if (custom) $("targetLangCustom").focus();
    else {
      $("targetLangMessage").textContent = t("targetCustomHint",
        "列表外可输入语言代码；可用性取决于字幕轨和翻译服务。");
      $("targetLangMessage").classList.remove("err");
      setKey("targetLang", e.target.value);
    }
  });
  const applyCustomTarget = async () => {
    const code = $("targetLangCustom").value.trim();
    const message = $("targetLangMessage");
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(code)) {
      message.textContent = t("targetCustomInvalid", "请输入有效语言代码，例如 nl、tr 或 pt-BR。");
      message.classList.add("err");
      return;
    }
    try {
      if (!await persistSettings({ targetLang: code })) throw new Error("Settings were not saved");
      state.targetLang = code;
      bindUI();
      message.textContent = t("targetCustomDone", "目标语言已设置：") + " " + code;
      message.classList.remove("err");
    } catch (_e) {
      message.textContent = t("targetCustomSaveFailed", "保存目标语言失败，请重试。");
      message.classList.add("err");
    }
  };
  $("targetLangApply").addEventListener("click", applyCustomTarget);
  $("targetLangCustom").addEventListener("keydown", (event) => {
    if (event.key === "Enter") applyCustomTarget();
  });

  // backend info tooltip
  $("backendInfo").addEventListener("click", () => {
    const tip = $("backendTip");
    const open = tip.hidden;
    tip.hidden = !open;
    $("backendInfo").setAttribute("aria-expanded", String(open));
  });

  // segmented: backend / order
  document.querySelectorAll("#backend button").forEach((b) =>
    b.addEventListener("click", () => { setKey("backend", b.dataset.val); paintSegs(); }));
  document.querySelectorAll("#order button").forEach((b) =>
    b.addEventListener("click", () => { setKey("order", b.dataset.val); paintSegs(); }));

  // position presets also force posMode = "preset"
  document.querySelectorAll("#position button").forEach((b) =>
    b.addEventListener("click", () => {
      state.position = b.dataset.val;
      state.posMode = "preset";
      persistSettings({ position: state.position, posMode: "preset" });
      paintSegs(); paintPreview();
    }));
  $("resetPos").addEventListener("click", () => {
    setKey("posMode", "preset"); paintSegs();
  });
  $("overlayWidthPct").addEventListener("input", (event) => {
    setKey("overlayWidthPct", Number(event.target.value));
    paintWidthControl();
  });
  $("resetWidth").addEventListener("click", () => {
    setKey("overlayWidthPct", 0); paintWidthControl();
  });

  // row gap
  $("rowGap").addEventListener("input", (e) => {
    $("rowGapV").textContent = e.target.value + "px";
    setKey("rowGap", +e.target.value);
  });

  // subtitle sync offset (ms -> seconds label; + delays, - advances)
  $("offsetMs").addEventListener("input", (e) => {
    const ms = +e.target.value;
    $("offsetMsV").textContent = formatOffset(ms);
    setKey("offsetMs", ms);
  });

  // current-video quick actions (same effects as the keyboard shortcuts)
  ["repeat", "reveal", "prev", "next"].forEach((kind) => {
    const btn = $("live" + kind[0].toUpperCase() + kind.slice(1));
    if (btn) btn.addEventListener("click", () => runLiveAction(kind));
  });
  $("autoCaptions").addEventListener("change", (e) => setKey("autoCaptions", e.target.checked));
  $("openShortcuts").addEventListener("click", openShortcutsPage);

  // study card: repeat count / repeat rate / translation reveal / karaoke
  document.querySelectorAll("#repeatCount button").forEach((b) =>
    b.addEventListener("click", () => { setKey("repeatCount", +b.dataset.val); paintSegs(); }));
  document.querySelectorAll("#studyRate button").forEach((b) =>
    b.addEventListener("click", () => { setKey("studyRate", +b.dataset.val); paintSegs(); }));
  document.querySelectorAll("#revealMode button").forEach((b) =>
    b.addEventListener("click", () => { setKey("revealMode", b.dataset.val); paintSegs(); }));
  $("karaoke").addEventListener("change", (e) => setKey("karaoke", e.target.checked));
  $("audioAlignmentBtn").addEventListener("click", async () => {
    const tab = await getActiveTab();
    const context = tab?.id != null ? await sendToTab(tab.id, { type: "audioContext" }) : null;
    if (!context?.ok) {
      showLiveMsg(t("liveNoCue", "这个视频还没有字幕：先播放几秒，或换一个视频。"), "err");
      return;
    }
    chrome.tabs.create({ url: chrome.runtime.getURL("alignment.html") + "?tab=" + tab.id }, () => {
      if (chrome.runtime.lastError) showLiveMsg(t("liveFailed", "操作没生效，刷新页面后再试一次。"), "err");
      else window.close();
    });
  });
  $("karaokeApproximate").addEventListener("change", (e) => setKey("karaokeApproximate", e.target.checked));
  $("timingMode").addEventListener("change", (e) => {
    const mode = e.target.value;
    setKey("timingMode", mode);
    // "approximate" means no audio model and no automatic-caption matching, so
    // turning it on without the estimate would leave nothing to highlight.
    if (mode === "approximate" && !state.karaokeApproximate) {
      state.karaokeApproximate = true;
      $("karaokeApproximate").checked = true;
      setKey("karaokeApproximate", true);
    }
  });
  $("karaokeBg").addEventListener("input", (e) => setKey("karaokeBg", e.target.value));
  $("karaokeTextColor").addEventListener("input", (e) => setKey("karaokeTextColor", e.target.value));
  $("karaokeOpacity").addEventListener("input", (e) => {
    $("karaokeOpacityV").textContent = Math.round(+e.target.value * 100) + "%";
    setKey("karaokeOpacity", +e.target.value);
  });
  $("wordLookup").addEventListener("change", (e) => setKey("wordLookup", e.target.checked));

  // tabs
  document.querySelectorAll("#lineTabs .tab").forEach((b) =>
    b.addEventListener("click", () => { activeLine = b.dataset.line; bindLineControls(); }));  // per-line controls write to the ACTIVE line's keys
  $("lineShow").addEventListener("change", (e) => setKey(LINE[activeLine].show, e.target.checked));
  $("lineFont").addEventListener("change", (e) => setKey(LINE[activeLine].font, e.target.value));
  $("lineSize").addEventListener("input", (e) => {
    $("lineSizeV").textContent = e.target.value + "px";
    setKey(LINE[activeLine].size, +e.target.value);
  });
  $("lineColor").addEventListener("input", (e) => setKey(LINE[activeLine].color, e.target.value));
  $("lineBg").addEventListener("input", (e) => setKey(LINE[activeLine].bg, e.target.value));
  $("lineStroke").addEventListener("input", (e) => setKey(LINE[activeLine].stroke, e.target.value));
  $("lineBgOpacity").addEventListener("input", (e) => {
    $("lineBgOpacityV").textContent = Math.round(+e.target.value * 100) + "%";
    setKey(LINE[activeLine].bgOpacity, +e.target.value);
  });
  $("lineStrokeOpacity").addEventListener("input", (e) => {
    $("lineStrokeOpacityV").textContent = Math.round(+e.target.value * 100) + "%";
    setKey(LINE[activeLine].strokeOpacity, +e.target.value);
  });

  // export (SRT download)
  document.querySelectorAll("#exportVariant button").forEach((b) =>
    b.addEventListener("click", () => { exportVariant = b.dataset.val; paintExportSeg(); }));
  $("exportBtn").addEventListener("click", onExportClick);

  // reset all
  $("reset").addEventListener("click", () => {
    state = { ...DEFAULTS };
    persistSettings(DEFAULTS);
    bindUI();
    showLiveMsg("", null);
  });
}

// ---- current video: quick actions ---------------------------------------
// Everything the shortcuts can do is also a button here, so the popup alone is
// enough to drive the video that is already open.
const LIVE_ACTIONS = {
  repeat: { type: "repeatSentence" },
  reveal: { type: "revealTranslation" },
  prev: { type: "stepSentence", delta: -1 },
  next: { type: "stepSentence", delta: 1 }
};

function showLiveMsg(text, kind) {
  const el = $("liveMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.remove("ok", "err");
  if (kind) el.classList.add(kind);
  el.hidden = !text;
}

async function runLiveAction(kind) {
  const action = LIVE_ACTIONS[kind];
  if (!action) return;
  showLiveMsg("", null);
  const tab = await getActiveTab();
  const resp = (tab && tab.id != null) ? await sendToTab(tab.id, action) : null;
  if (resp == null) {
    showLiveMsg(t("liveNotYoutube", "请在 YouTube 视频页面使用。"), "err");
    return;
  }
  if (!resp.ok) {
    if (resp.reason === "nocue") {
      showLiveMsg(t("liveNoCue", "这个视频还没有字幕：先播放几秒，或换一个视频。"), "err");
    } else if (resp.reason === "mode") {
      showLiveMsg(t("liveRevealManual", "把「译文显示」设为「按键」，这个按钮才起作用。"), "err");
    } else {
      showLiveMsg(t("liveFailed", "操作没生效，刷新页面后再试一次。"), "err");
    }
    return;
  }
  if (kind === "repeat") {
    showLiveMsg(resp.repeating
      ? t("liveRepeating", "正在复读本句") +
        (isFinite(resp.count) && resp.count > 0 ? " ×" + resp.count : "")
      : t("liveRepeatOff", "已停止复读"), "ok");
  } else if (kind === "reveal") {
    showLiveMsg(resp.revealed
      ? t("liveRevealed", "译文已显示") : t("liveHidden", "译文已隐藏"), "ok");
  } else {
    const n = resp.count ? " (" + (resp.index + 1) + "/" + resp.count + ")" : "";
    showLiveMsg((kind === "prev"
      ? t("livePrevDone", "已回到上一句") : t("liveNextDone", "已跳到下一句")) + n, "ok");
  }
}

// ---- shortcuts (read-only here; the browser owns the key bindings) -------
function browserShortcutsUrl() {
  const ua = String(navigator.userAgent || "");
  return /Edg\//.test(ua) ? "edge://extensions/shortcuts" : "chrome://extensions/shortcuts";
}

function fillShortcuts() {
  const list = $("shortcutList");
  if (!list || !chrome.commands || !chrome.commands.getAll) return;
  chrome.commands.getAll((cmds) => {
    if (chrome.runtime.lastError || !cmds) return;
    list.textContent = "";
    cmds.filter((c) => [
      "toggle-translation", "repeat-sentence", "reveal-translation"
    ].includes(c.name)).forEach((c) => {
      const li = document.createElement("li");
      const kbd = document.createElement("kbd");
      kbd.textContent = c.shortcut || t("shortcutNone", "未设置");
      if (!c.shortcut) li.classList.add("none");
      const name = document.createElement("span");
      name.textContent = c.description || c.name;
      li.appendChild(kbd);
      li.appendChild(name);
      list.appendChild(li);
    });
  });
}

function openShortcutsPage() {
  const url = browserShortcutsUrl();
  try {
    chrome.tabs.create({ url }, () => {
      // Browsers may refuse their own settings pages from an extension context.
      if (chrome.runtime.lastError) {
        showLiveMsg(t("shortcutManual", "请在地址栏打开：") + " " + url, "err");
        return;
      }
      window.close();                 // the video tab is in front again
    });
  } catch (_e) {
    showLiveMsg(t("shortcutManual", "请在地址栏打开：") + " " + url, "err");
  }
}

// ---- version footer ------------------------------------------------------
function showVersion() {
  try {
    const v = chrome.runtime.getManifest().version;
    if (v && $("version")) $("version").textContent = v;
  } catch (_e) { /* ignore */ }
}

// ---- boot ----------------------------------------------------------------
YtdsSettings.onChanged((changes, area) => {
  if (area !== "sync") return;
  const logical = fromStore(changes);
  if (!("overlayWidthPct" in logical)) return;
  state.overlayWidthPct = logical.overlayWidthPct.newValue || 0;
  paintWidthControl(); paintPreview();
});
applyI18n();                       // localize static markup before first paint
(function boot() {
  // Settings are read and written for the site the user is actually looking at,
  // so changing a Bilibili video to German can never rewrite the YouTube choice.
  getActiveTab().then((tab) => {
    site = YtdsSite.forPlatform(platformOfUrl(tab && tab.url));
    YtdsSettings.get(toStore({ ...DEFAULTS, ...site.siteDefaults() }), (got) => {
      const stored = fromStore(got);
      state = { ...DEFAULTS, ...site.siteDefaults(), ...stored };
      // migrate legacy global bgOpacity onto per-line defaults
      if (typeof stored.bgOpacity === "number") {
        if (typeof stored.origBgOpacity !== "number") state.origBgOpacity = stored.bgOpacity;
        if (typeof stored.transBgOpacity !== "number") state.transBgOpacity = stored.bgOpacity;
      }
      showVersion();
      bindUI();
      wire();
      fillShortcuts();           // show the keys the browser actually assigned
      const track = $("bbTrack");
      if (track) track.addEventListener("change", onBiliTrackChange);
      const importBtn = $("bbImport");
      const fileInput = $("bbFile");
      const clearBtn = $("bbClear");
      if (importBtn && fileInput) {
        importBtn.addEventListener("click", () => { fileInput.value = ""; fileInput.click(); });
        fileInput.addEventListener("change", () => {
          const picked = fileInput.files && fileInput.files[0];
          if (picked) onImportFile(picked);
        });
      }
      if (clearBtn) clearBtn.addEventListener("click", onClearImport);
      const recogStart = $("recogStart");
      const recogStop = $("recogStop");
      const recogTest = $("recogTest");
      if (recogStart) recogStart.addEventListener("click", onRecogStart);
      if (recogStop) recogStop.addEventListener("click", onRecogStop);
      if (recogTest) recogTest.addEventListener("click", onRecogTest);
      for (const id of ["bridgeBase", "bridgeToken"]) {
        const field = $(id);
        if (field) field.addEventListener("change", onBridgeFieldChange);
      }
      startStatus();
    });
  });
})();
