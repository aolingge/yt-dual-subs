// popup.js
// Loads/saves settings to chrome.storage.sync; content.js applies them live.
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
  transStrokeOpacity: 0
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
  chrome.storage.sync.set(o);
  paintPreview();
}

// ---- live preview (mirrors content.js styleOverlay) ----------------------
function paintPreview() {
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
    return t("statusNoReply",
      "没有收到页面状态：如果这是 YouTube 视频页，请刷新一次页面。");
  }
  if (!s.enabled) return t("statusOff", "扩展已关闭，字幕不会显示。");
  const parts = [];
  if (s.mode === "cues") parts.push(t("statusCues", "字幕源：YouTube 字幕轨"));
  else if (s.mode === "scrape") parts.push(t("statusScrape", "字幕源：画面字幕（即时显示／字幕轨加载中）"));
  else parts.push(t("statusIdle", "等待视频提供字幕；请检查 YouTube 的 CC 开关和字幕轨"));
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

async function refreshStatus() {
  const el = $("statusLine");
  if (!el) return;
  const tab = await getActiveTab();
  const resp = (tab && tab.id != null)
    ? await sendToTab(tab.id, { type: "status" }) : null;
  el.textContent = statusText(resp);
  el.hidden = false;
  const timing = $("karaokeStatus");
  const labels = {
    captions: t("karaokeStatusCaptions", "跟读：使用原字幕词时间"),
    automatic: t("karaokeStatusAutomatic", "跟读：已匹配同语言自动字幕词时间"),
    estimated: t("karaokeStatusEstimated", "近似跟读：按句子时长估算，不代表精确语音时间"),
    unavailable: t("karaokeStatusUnavailable", "此句无可靠词时间，显示完整句子"),
    waiting: t("karaokeStatusWaiting", "跟读：等待带有时间的原文字幕"),
    off: t("karaokeStatusOff", "逐词跟读已关闭")
  };
  const timingText = resp ? labels[resp.wordTiming] || labels.waiting : "";
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
      await chrome.storage.sync.set({ targetLang: code });
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
      chrome.storage.sync.set({ position: state.position, posMode: "preset" });
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
  $("karaokeApproximate").addEventListener("change", (e) => setKey("karaokeApproximate", e.target.checked));
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
    chrome.storage.sync.set(DEFAULTS);
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
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !("overlayWidthPct" in changes)) return;
  state.overlayWidthPct = changes.overlayWidthPct.newValue || 0;
  paintWidthControl(); paintPreview();
});
applyI18n();                       // localize static markup before first paint
chrome.storage.sync.get(DEFAULTS, (got) => {
  state = { ...DEFAULTS, ...got };
  // migrate legacy global bgOpacity onto per-line defaults
  if (typeof got.bgOpacity === "number") {
    if (typeof got.origBgOpacity !== "number") state.origBgOpacity = got.bgOpacity;
    if (typeof got.transBgOpacity !== "number") state.transBgOpacity = got.bgOpacity;
  }
  showVersion();
  bindUI();
  wire();
  fillShortcuts();           // show the keys the browser actually assigned
  startStatus();
});
