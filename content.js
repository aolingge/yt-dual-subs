// content.js — isolated world.
// Renders YouTube bilingual subtitles as a single non-overlapping layer.
//
// Two paths:
//   (A) CUE MODE  — inject.js (MAIN world) captures the player's pot-bearing
//       timedtext URL, fetches json3 cues (+ optional tlang translation aligned
//       cue-for-cue), and posts them here. We drive an overlay off currentTime,
//       switching PER-SENTENCE (no per-word jitter).
//   (B) NATIVE PREVIEW / FALLBACK — mirror rendered captions immediately while
//       the track loads, then let the timestamp-driven cue mode take over.
(() => {
  "use strict";

  // ---- guard against double injection (mirror inject.js) -------------------
  // In normal MV3 operation this runs once per document, but an extension
  // reload (or a future move to programmatic injection) could re-run it; the
  // guard prevents accumulating listeners / cue loops / duplicate overlays.
  if (window.__ytdsContentLoaded) return;
  window.__ytdsContentLoaded = true;

  // ---- i18n ----------------------------------------------------------------
  // Safe wrapper around chrome.i18n.getMessage: returns the localized string,
  // or the supplied fallback if i18n is unavailable / the key is missing, so
  // nothing breaks if a message is absent.
  //
  // The try/catch is not decoration. When the extension is reloaded or updated
  // while a YouTube tab stays open, this older content script keeps running but
  // its context is dead: EVERY chrome.* call then throws "Extension context
  // invalidated". This wrapper runs on render paths (drag handle, CC button
  // label), so the throw used to escape as an "Uncaught Error: Extension
  // context invalidated." reported against this very line.
  const t = (k, fb) => {
    try { return (chrome.i18n && chrome.i18n.getMessage(k)) || fb; }
    catch (_e) { return fb; }
  };

  // ---- extension-context guard --------------------------------------------
  // Latched once chrome.* has proven dead. Each loop checks this at its own
  // top and stops ITSELF (calling the stoppers here would touch timers that are
  // not initialized yet when this runs at load time).
  let extGone = false;
  function extAlive() {
    if (!extGone) {
      try {
        if (chrome.runtime && chrome.runtime.id) return true;
      } catch (_e) { /* invalidated */ }
      extGone = true;
    }
    document.documentElement?.classList.toggle("ytds-rendering", false);
    return false;
  }

  // Storage writes must never throw: several run from click handlers and timers.
  function saveSettings(patch) {
    YtdsSettings.set(patch).catch(() => { if (!extAlive()) extGone = true; });
  }

  // Background round-trips must never throw either. Returns false when the
  // message could not be handed to the worker (context gone).
  function askBackground(message, done) {
    if (extGone) return false;
    try { chrome.runtime.sendMessage(message, done); return true; }
    catch (_e) { extGone = true; return false; }
  }

  // Injected while the extension context is ALREADY dead (a reload racing this
  // injection): every chrome.* call below — including addListener — would throw
  // at load. Nothing useful can run in that state, so bail out.
  if (!extAlive()) return;

  // ---- shared settings model (MUST match popup.js DEFAULTS) ----------------
  const DEFAULTS = {
    enabled: true,
    targetLang: "zh-CN",
    backend: "tlang",            // "tlang" | "gtx" | "fast"
    order: "orig-top",           // which line on top: "orig-top" | "trans-top"
    rowGap: 4,                   // px between the two lines
    overlayWidthPct: 0,          // 0 = automatic, otherwise 20–96% of the player
    position: "bottom",          // preset anchor: "top" | "center" | "bottom"
    offsetMs: 0,                 // subtitle sync nudge, ms (+ = show later)
    // study aids (see the "study mode" section below)
    repeatCount: 0,              // 0 = off, N = play each sentence N times, -1 = loop
    studyRate: 0.75,             // playback rate used while repeating a sentence
    karaoke: true,               // prefer caption word times; optional labeled estimate
    karaokeApproximate: true,
    karaokeBg: "#ffd65c",
    karaokeTextColor: "#161616",
    karaokeOpacity: 0.95,
    wordLookup: true,            // translate a word after a short mouse hover
    revealMode: "always",        // translation visibility: "always" | "hover" | "manual"
    autoCaptions: true,          // turn YouTube's own CC on for you when the page loads
    posMode: "preset",           // "preset" | "custom" (custom set by dragging)
    posXpct: 50,                 // % of player width  (overlay center x) when custom
    posYpct: 90,                 // % of player height (overlay center y) when custom
    // original line
    showOriginal: true,
    origFont: "system",
    origSize: 22,
    origColor: "#ffffff",
    origBg: "#080808",
    origBgOpacity: 0.6,
    origStroke: "#000000",
    origStrokeOpacity: 0,        // 0 => no outline
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

  // Font key -> font-family stack (shared with popup preview).
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
  function fontStack(key) {
    return FONT_STACKS[key] || FONT_STACKS.system;
  }

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
  // Build a multi-direction text-shadow "ring" to fake an outline. Falls back
  // to the soft drop-shadow when opacity is 0 (matches content.css default).
  function outlineShadow(strokeHex, strokeOpacity) {
    const a = Number(strokeOpacity);
    if (!isFinite(a) || a <= 0) return "0 1px 2px rgba(0,0,0,0.9)";
    const c = rgba(strokeHex, a);
    const o = 1.2; // px
    return [
      `-${o}px -${o}px 0 ${c}`,
      `0 -${o}px 0 ${c}`,
      `${o}px -${o}px 0 ${c}`,
      `${o}px 0 0 ${c}`,
      `${o}px ${o}px 0 ${c}`,
      `0 ${o}px 0 ${c}`,
      `-${o}px ${o}px 0 ${c}`,
      `-${o}px 0 0 ${c}`
    ].join(", ");
  }
  function clampPct(v) {
    let n = Number(v);
    if (!isFinite(n)) n = 50;
    return Math.max(2, Math.min(98, n));
  }

  let settings = { ...DEFAULTS };

  // overlay
  let overlay = null;
  let origEl = null;
  let transEl = null;
  let handleEl = null;
  let resizeHandles = [];
  let resizeGesture = null;

  // drag bookkeeping (listeners live on the handle, so they die with overlay)
  let dragging = false;
  let dragMoved = false;       // true once the pointer actually moved past threshold
  let dragGrabDx = 0;          // pointer-to-overlay-center offset captured on grab
  let dragGrabDy = 0;
  let dragStartX = 0;          // pointerdown coords (for movement-threshold check)
  let dragStartY = 0;
  let dragSaveTimer = null;
  const DRAG_THRESHOLD = 3;    // px the pointer must move before it counts as a drag

  // cue mode
  let cueList = null;        // raw json3 cues, retained for SRT export
  let displayCueList = null; // adjacent raw cues joined into readable sentences
  let tcueList = null;       // aligned translation cues OR null (timestamp fallback)
  let cueAligned = null;     // boolean | null
  let cueVideoId = "";       // videoId the cues belong to
  let cueSourceLang = "auto"; // original track language for short-sentence translation
  let translationPending = false; // original cues arrived; tlang is still loading
  let pendingSince = 0;          // when the current tlang wait began (0 = not waiting)
  let fastPreviewIdx = -1;      // current sentence shown via gtx while tlang loads
  // A 429 used to switch the free endpoint off for the whole video. Now it only
  // pauses it: the cooldown grows (20s -> 60s -> 180s) and the first success
  // resets the ladder, so "fast" mode can recover by itself on a long video.
  let gtxCooldownUntil = 0;     // ms timestamp; gtx is skipped before this
  let gtxBackoffStep = 0;       // index into GTX_BACKOFF_MS
  let cueTimer = null;       // currentTime-driven loop
  let activeCueIdx = -1;     // index of currently shown cue
  let cueDirty = false;      // force exactly one tick (seek / paused settings change)
  let cueEpoch = 0;          // bumped each (re)start/teardown; invalidates in-flight gtx
  const transCache = new Map(); // key `${videoId} ${idx}` -> translated text
  const transInflight = new Map(); // cue idx -> epoch of its in-flight gtx request
  const transRetryAt = new Map(); // delay network-error retries, avoid a tick-rate burst
  const PREFETCH_AHEAD = 3;     // keep gtx bursts small; the active cue goes first
  const PREFETCH_AHEAD_PENDING = 2; // narrower window while tlang is still loading
  const PENDING_GOOGLE_AFTER_MS = 350; // a brief head start, then warm the visible sentence
  const GTX_BACKOFF_MS = [20000, 60000, 180000]; // 429 cooldown ladder
  const MAX_GTX_INFLIGHT = 4;    // active requests bypass this prefetch-only cap
  const ZERO_DUR_FLOOR_MS = 1000; // min visible window for a trailing zero-dur cue
  const PREV_RESTART_MS = 1000;   // "previous sentence" restarts the current one first
  // Per-video cue cache (memory only, never persisted): returning to a video we
  // already loaded paints its subtitles instantly while inject.js re-fetches in
  // the background. Bounded by video count and by cue volume.
  let usedVideoCache = false;   // current cues (or their original) came from the cache
  const videoCueCache = new Map(); // videoId -> {cues,tcues,aligned,sourceLang,targetLang,pending}
  const VIDEO_CACHE_MAX = 4;
  const VIDEO_CACHE_MAX_CUES = 3000;

  // study mode state (repeat / slow playback / karaoke / reveal)
  let repeatCueIdx = -1;        // sentence being repeated, -1 = not repeating
  let repeatDoneIdx = -1;       // sentence whose repeat turns are used up
  let repeatLeft = 0;           // extra plays left (Infinity = until stopped)
  let manualRepeat = false;     // started by the shortcut while the setting is off
  let rateBeforeRepeat = 1;     // playbackRate to restore when the repeat ends
  let weSetRate = false;        // only restore a rate the extension changed
  let revealShown = false;      // "manual" reveal: shown for the current sentence
  let hoverHideTimer = 0;       // "hover" reveal: hides once the pointer goes idle
  let wordSpans = null;         // karaoke spans of the original line, or null
  let wordTimingSource = "waiting";
  let wordTimes = null;         // parallel word start times (raw track ms)
  let activeWordIdx = -1;       // highlighted word index
  let overlayResizeObserver = null;
  let overlayLayoutFrame = 0;
  let wordPopup = null;
  let wordPopupWord = null;
  let wordPopupMeaning = null;
  let wordPopupMeta = null;
  let wordPopupLink = null;
  let wordLookupTimer = 0;
  let wordLookupHideTimer = 0;
  let wordLookupSeq = 0;
  let wordLookupIntent = "";
  const wordLookupCache = new Map();
  const WORD_LOOKUP_DELAY_MS = 420;
  const WORD_LOOKUP_CACHE_MAX = 300;

  // fallback (rendered-scrape) mode
  let pollTimer = null;
  let nativeCaptionObserver = null;
  let nativeCaptionPlayer = null;
  let nativeSkipText = null; // static native text still left over during SPA navigation
  let debounceTimer = null;
  let lastSource = "";
  let lastTransSource = "";
  let lastReqToken = 0;
  let fallbackInflight = null;
  let fallbackRetryAt = 0;
  let fallbackTranslation = "";
  const DEBOUNCE_MS = 120;

  // bookkeeping
  let currentVideoId = videoIdFromLocation();
  let nocuesFallback = false;   // true once we've committed to scrape mode
  let configNonce = 0;          // monotonic; echoed by inject.js to reject stale replies

  // export (SRT download) bookkeeping
  let exportSeq = 0;                  // correlation id for export-request round-trips
  const exportWaiters = new Map();   // exportId -> { resolve, timer }

  // ---- settings ------------------------------------------------------------
  function loadSettings() {
    return new Promise((resolve) => {
      // A dead context throws synchronously here (extension reloaded with this
      // page open); fall back to DEFAULTS rather than rejecting the boot chain.
      if (!extAlive()) { resolve(); return; }
      const apply = (got) => {
        const { fontSizeRepair20260926, ...saved } = got;
        settings = { ...DEFAULTS, ...saved };
        // Existing installations may have an enlarged 44px subtitle setting.
        // Repair it once; later changes through the popup remain the user's choice.
        if (!fontSizeRepair20260926) {
          const repaired = { fontSizeRepair20260926: true };
          if (Number(settings.origSize) > 32) {
            settings.origSize = DEFAULTS.origSize;
            repaired.origSize = settings.origSize;
          }
          if (Number(settings.transSize) > 32) {
            settings.transSize = DEFAULTS.transSize;
            repaired.transSize = settings.transSize;
          }
          saveSettings(repaired);
        }
        // migrate legacy global bgOpacity -> per-line bg opacities if present
        // and the per-line keys were never set.
        if (typeof got.bgOpacity === "number") {
          if (typeof got.origBgOpacity !== "number") settings.origBgOpacity = got.bgOpacity;
          if (typeof got.transBgOpacity !== "number") settings.transBgOpacity = got.bgOpacity;
        }
        resolve();
      };
      try {
        YtdsSettings.get({ ...DEFAULTS, fontSizeRepair20260926: false }, apply);
      } catch (_e) {
        extGone = true;
        resolve();                      // keep DEFAULTS; the page still renders
      }
    });
  }

  // ONLY these keys require re-requesting cues from inject.js; every other key
  // is a pure style/position change that applies live via styleOverlay(). This
  // positive set is the single source of truth for the re-cue decision.
  const RECUE_KEYS = new Set(["backend", "targetLang"]);

  YtdsSettings.onChanged((changes, area) => {
    if (area !== "sync") return;
    let needRecue = false;
    let enabledChanged = false;
    for (const k of Object.keys(changes)) {
      if (k in settings) {
        const oldV = settings[k];
        settings[k] = changes[k].newValue;
        if (k === "enabled" && oldV !== settings[k]) enabledChanged = true;
        if (RECUE_KEYS.has(k) && oldV !== settings[k]) {
          needRecue = true;
        }
      }
    }
    applyStateToDom(false);
    if (overlay) styleOverlay();   // position/fonts/colors/bg/stroke/sizes apply live
    // The sync offset decides which cue belongs on screen right now, so re-render
    // once (even while paused) instead of waiting for the next playback tick.
    if ("offsetMs" in changes && cueTimer) {
      cueDirty = true;
      cueTick();
    }
    // Study settings apply to the sentence playing right now, so react at once.
    if ("repeatCount" in changes || "studyRate" in changes) {
      if (!repeatTarget()) stopRepeat();
      else if (repeatCueIdx !== -1) startRepeat(repeatCueIdx);
    }
    if ("revealMode" in changes) {
      revealShown = false;            // a new mode starts hidden again
      applyRevealState();
    }
    if ("wordLookup" in changes || "targetLang" in changes) hideWordLookup();
    if ("karaoke" in changes && !settings.karaoke) {
      try {
        window.postMessage({ source: "ytds-content", type: "word-timing-config",
          useWordTiming: false }, "*");
      } catch (_e) { /* ignore */ }
    }
    if ("karaoke" in changes || "karaokeApproximate" in changes || "revealMode" in changes) {
      activeCueIdx = -1;              // re-render the current sentence
      cueDirty = true;
      cueTick();
    }
    if ("enabled" in changes || "autoCaptions" in changes) syncCaptions();
    // backend / targetLang changed: re-request cues from inject.js
    if (needRecue && settings.enabled) {
      transCache.clear();
      transInflight.clear();
      transRetryAt.clear();
      fastPreviewIdx = -1;
      gtxCooldownUntil = 0;
      gtxBackoffStep = 0;
      // The current cue loop is now running against stale translation data
      // (old tlang alignment / old gtx cache). Drop the translation source and
      // bump the epoch so the loop degrades cleanly (no wrong-but-plausible
      // lines) and stale in-flight gtx callbacks are ignored until fresh cues
      // arrive from inject.js.
      tcueList = null;
      cueAligned = null;
      cueEpoch++;
      if (cueTimer) {
        activeCueIdx = -1;          // force re-render of translation on next tick
        setTranslation("", "");
      }
      if (pollTimer) {
        lastReqToken++;             // old fallback translation is for stale settings
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = null;
        fallbackInflight = null;
        fallbackRetryAt = 0;
        fallbackTranslation = "";
        lastTransSource = "";
        setTranslation("", "");
        if (lastSource) scheduleTranslate(lastSource);
      }
    }
    // Style changes need no network work. A toggle or translation setting
    // change asks for cues once, after the old translation has been invalidated.
    if (settings.enabled && (enabledChanged || needRecue ||
        ("karaoke" in changes && settings.karaoke))) sendConfig();
  });

  // ---- generic helpers -----------------------------------------------------
  function videoIdFromLocation() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("v") || "";
    } catch (_e) {
      return "";
    }
  }

  function getPlayer() {
    return document.querySelector("#movie_player") ||
           document.querySelector(".html5-video-player");
  }

  function getVideo() {
    const p = getPlayer();
    return (p && p.querySelector("video")) ||
           document.querySelector("video.html5-main-video") ||
           document.querySelector("video");
  }

  // Remove only known sound-description tags, not arbitrary bracketed speech.
  // Apply this to display text; raw json3 cues stay intact for SRT export.
  const SOUND_LABELS = new Set([
    "musik", "music", "musik spielt", "music playing",
    "hintergrundmusik", "background music", "音乐", "音樂",
    "背景音乐", "背景音樂", "applaus", "applause", "掌声", "掌聲",
    "lachen", "gelächter", "laughter", "laughing", "笑声", "笑聲",
    "gesang", "singing", "歌声", "歌聲", "geräusch", "geräusche",
    "sound effect", "sound effects", "音效"
  ]);
  function stripSoundDescriptions(value) {
    return String(value || "")
      .replace(/\[([^\]\r\n]{1,60})\]|【([^】\r\n]{1,60})】|［([^］\r\n]{1,60})］|\(([^)\r\n]{1,60})\)|（([^）\r\n]{1,60})）/g,
        (match, square, corner, wide, paren, fullParen) => {
          const label = (square || corner || wide || paren || fullParen)
            .replace(/\s+/g, " ").trim().toLowerCase();
          return SOUND_LABELS.has(label) ? "" : match;
        })
      .replace(/\s+/g, " ").trim();
  }

  // Read the currently displayed native caption text (fallback path).
  // Read ONLY .ytp-caption-segment (the combined node would duplicate text).
  function readNativeCaption(clean = true) {
    const segs = document.querySelectorAll(".ytp-caption-segment");
    if (!segs.length) return "";
    let parts = [];
    segs.forEach((s) => {
      const t = s.textContent.trim();
      if (t) parts.push(t);
    });
    const text = parts.join(" ");
    return clean ? stripSoundDescriptions(text) : text;
  }

  // ---- overlay -------------------------------------------------------------
  function ensureOverlay() {
    const player = getPlayer();
    if (!player) return null;
    if (overlay && overlay.isConnected) return overlay;

    overlay = document.createElement("div");
    overlay.id = "ytds-overlay";
    // Keep page translators (Immersive Translate, Chrome/Edge built-in) out of
    // the subtitle box. Both honour .notranslate and translate="no"; without
    // these the overlay's text is treated as ordinary page text and gets
    // translated a second time, on top of our own translation.
    overlay.classList.add("notranslate");
    overlay.setAttribute("translate", "no");
    transEl = document.createElement("div");
    transEl.className = "ytds-line ytds-trans";
    transEl.setAttribute("dir", "auto");
    origEl = document.createElement("div");
    origEl.className = "ytds-line ytds-orig";
    origEl.setAttribute("dir", "auto");
    // Text is selectable, but selecting it must not click/pause the player.
    for (const line of [transEl, origEl]) {
      for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick"]) {
        line.addEventListener(type, (event) => event.stopPropagation());
      }
    }
    origEl.addEventListener("pointermove", onOriginalPointerMove);
    origEl.addEventListener("pointerleave", scheduleWordLookupHide);
    origEl.addEventListener("pointerdown", hideWordLookup);

    overlay.appendChild(transEl);
    overlay.appendChild(origEl);
    buildHandle();                  // drag grip (its listeners die with overlay)
    buildResizeHandles();
    player.appendChild(overlay);
    styleOverlay();
    if (typeof ResizeObserver !== "undefined") {
      overlayResizeObserver = new ResizeObserver(scheduleOverlayLayout);
      overlayResizeObserver.observe(player);
      overlayResizeObserver.observe(overlay);
    }
    return overlay;
  }

  // A small round grip in the overlay's top-left corner. Drag listeners are
  // attached only to it (plus pointer capture), so removing the overlay removes
  // every listener with no document-level leaks across SPA navigation.
  function buildHandle() {
    handleEl = document.createElement("div");
    handleEl.className = "ytds-handle";
    handleEl.title = t("handleTitle", "拖动移动字幕 · 双击复位");
    handleEl.setAttribute("aria-label", t("handleAria", "拖动移动字幕，双击复位"));
    handleEl.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3' +
      'M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3"/></svg>';

    handleEl.addEventListener("pointerdown", onHandlePointerDown);
    handleEl.addEventListener("pointermove", onHandlePointerMove);
    handleEl.addEventListener("pointerup", onHandlePointerUp);
    handleEl.addEventListener("pointercancel", onHandlePointerUp);
    handleEl.addEventListener("dblclick", onHandleDblClick);

    overlay.appendChild(handleEl);
  }

  function onHandlePointerDown(e) {
    if (resizeGesture) return;
    const player = getPlayer();
    if (!player) return;
    dragging = true;
    dragMoved = false;              // no real movement yet — a bare click won't persist
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    // Record the offset between the pointer and the overlay's CURRENT center so
    // the grabbed point stays under the cursor (no first-move teleport). The
    // handle sits at the overlay's top-left corner, ~half the box away from
    // center, so without this the box would jump when the drag begins.
    if (overlay) {
      const orect = overlay.getBoundingClientRect();
      dragGrabDx = e.clientX - (orect.left + orect.width / 2);
      dragGrabDy = e.clientY - (orect.top + orect.height / 2);
    } else {
      dragGrabDx = 0;
      dragGrabDy = 0;
    }
    handleEl.classList.add("ytds-dragging");
    try { handleEl.setPointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    e.preventDefault();
    e.stopPropagation();
  }

  function onHandlePointerMove(e) {
    if (!dragging) return;
    const player = getPlayer();
    if (!player) return;
    // Ignore sub-threshold jitter so a plain click never flips to custom mode.
    if (!dragMoved) {
      if (Math.abs(e.clientX - dragStartX) < DRAG_THRESHOLD &&
          Math.abs(e.clientY - dragStartY) < DRAG_THRESHOLD) {
        return;
      }
      dragMoved = true;
    }
    const rect = player.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    // Subtract the grab offset so the overlay center tracks the point the user
    // actually grabbed rather than snapping the center onto the cursor.
    const cx = e.clientX - dragGrabDx;
    const cy = e.clientY - dragGrabDy;
    const xpct = clampPct(((cx - rect.left) / rect.width) * 100);
    const ypct = clampPct(((cy - rect.top) / rect.height) * 100);
    settings.posMode = "custom";
    settings.posXpct = xpct;
    settings.posYpct = ypct;
    applyPosition();                // smooth live feedback; no storage write
    e.preventDefault();
  }

  function onHandlePointerUp(e) {
    if (!dragging) return;
    dragging = false;
    handleEl.classList.remove("ytds-dragging");
    try { handleEl.releasePointerCapture(e.pointerId); } catch (_e) { /* ignore */ }
    // Only persist when a REAL drag happened. A bare click (no movement) must
    // not flip posMode to custom or move the box, and must not race the
    // dblclick reset (which clears this timer anyway).
    if (!dragMoved) return;
    // persist ONCE (coalesced) at the end of the gesture
    if (dragSaveTimer) clearTimeout(dragSaveTimer);
    dragSaveTimer = setTimeout(() => {
      dragSaveTimer = null;
      saveSettings({
        posMode: "custom",
        posXpct: settings.posXpct,
        posYpct: settings.posYpct
      });
    }, 60);
  }

  function onHandleDblClick(e) {
    e.preventDefault();
    e.stopPropagation();
    // Cancel any pending drag-save timer; otherwise the still-pending write from
    // the preceding pointerup(s) fires ~60ms later and clobbers this reset back
    // to a custom position. Also drop any in-progress drag state.
    if (dragSaveTimer) { clearTimeout(dragSaveTimer); dragSaveTimer = null; }
    dragging = false;
    dragMoved = false;
    settings.posMode = "preset";
    applyPosition();
    saveSettings({ posMode: "preset" });
  }

  function configuredWidthPct() {
    const value = Number(settings.overlayWidthPct);
    return Number.isFinite(value) && value > 0
      ? Math.max(20, Math.min(96, value)) : 0;
  }

  function applyOverlayWidth() {
    if (!overlay) return;
    const value = configuredWidthPct();
    overlay.style.width = value ? value + "%" : "";
    overlay.style.maxWidth = value ? "none" : "";
    overlay.classList.toggle("ytds-fixed-width", !!value);
    for (const handle of resizeHandles) {
      handle.setAttribute("aria-valuenow", String(value || 92));
      handle.setAttribute("aria-valuetext", value ? value + "%" : t("widthAuto", "自动"));
    }
  }

  function resetOverlayWidth() {
    resizeGesture = null;
    overlay?.classList.remove("ytds-resizing");
    settings.overlayWidthPct = 0;
    applyOverlayWidth();
    scheduleOverlayLayout();
    saveSettings({ overlayWidthPct: 0 });
  }

  function buildResizeHandles() {
    resizeHandles = [];
    for (const side of ["left", "right"]) {
      const handle = document.createElement("div");
      handle.className = "ytds-resize-handle ytds-resize-" + side;
      handle.tabIndex = 0;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-valuemin", "20");
      handle.setAttribute("aria-valuemax", "96");
      handle.title = side === "left"
        ? t("resizeLeft", "拖动左边调整字幕宽度 · 双击恢复默认")
        : t("resizeRight", "拖动右边调整字幕宽度 · 双击恢复默认");
      handle.setAttribute("aria-label", handle.title);
      handle.addEventListener("pointerdown", (event) => {
        if (dragging || resizeGesture || event.button !== 0) return;
        const player = getPlayer();
        const rect = player?.getBoundingClientRect?.();
        const box = overlay?.getBoundingClientRect?.();
        if (!rect?.width || !rect.height || !box) return;
        hideWordLookup();
        resizeGesture = {
          handle, side, pointerId: event.pointerId, moved: false,
          startX: event.clientX, startWidth: box.width,
          fixedX: side === "left" ? box.right : box.left,
          yPct: settings.posMode === "custom" ? clampPct(settings.posYpct)
            : clampPct((box.top + box.height / 2 - rect.top) / rect.height * 100)
        };
        overlay.classList.add("ytds-resizing");
        try { handle.setPointerCapture(event.pointerId); } catch (_e) { /* ignore */ }
        event.preventDefault();
        event.stopPropagation();
      });
      handle.addEventListener("pointermove", onResizePointerMove);
      handle.addEventListener("pointerup", finishResize);
      handle.addEventListener("pointercancel", finishResize);
      handle.addEventListener("lostpointercapture", finishResize);
      handle.addEventListener("dblclick", (event) => {
        event.preventDefault(); event.stopPropagation(); resetOverlayWidth();
      });
      handle.addEventListener("click", (event) => event.stopPropagation());
      handle.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const rect = getPlayer()?.getBoundingClientRect?.();
        if (!rect?.width || !overlay) return;
        const current = configuredWidthPct() || overlay.offsetWidth / rect.width * 100;
        const direction = (event.key === "ArrowRight" ? 1 : -1) * (side === "right" ? 1 : -1);
        settings.overlayWidthPct = Math.round(Math.max(20, Math.min(96, current + direction * 2)) * 10) / 10;
        applyOverlayWidth(); scheduleOverlayLayout();
        saveSettings({ overlayWidthPct: settings.overlayWidthPct });
        event.preventDefault(); event.stopPropagation();
      });
      resizeHandles.push(handle);
      overlay.appendChild(handle);
    }
  }

  function onResizePointerMove(event) {
    const gesture = resizeGesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const delta = event.clientX - gesture.startX;
    if (!gesture.moved && Math.abs(delta) < DRAG_THRESHOLD) return;
    const player = getPlayer();
    const rect = player?.getBoundingClientRect?.();
    if (!rect?.width || !rect.height) return;
    gesture.moved = true;
    const room = gesture.side === "left"
      ? gesture.fixedX - rect.left - 8 : rect.right - gesture.fixedX - 8;
    const width = Math.max(rect.width * 0.2, Math.min(rect.width * 0.96, room,
      gesture.startWidth + delta * (gesture.side === "left" ? -1 : 1)));
    settings.overlayWidthPct = Math.round(width / rect.width * 1000) / 10;
    const renderedWidth = rect.width * settings.overlayWidthPct / 100;
    const center = gesture.fixedX + renderedWidth / 2 * (gesture.side === "left" ? -1 : 1);
    settings.posMode = "custom";
    settings.posXpct = clampPct((center - rect.left) / rect.width * 100);
    settings.posYpct = gesture.yPct;
    applyOverlayWidth();
    applyPosition();
    scheduleOverlayLayout();
    event.preventDefault();
    event.stopPropagation();
  }

  function finishResize(event) {
    const gesture = resizeGesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    resizeGesture = null;
    overlay?.classList.remove("ytds-resizing");
    try { gesture.handle.releasePointerCapture(gesture.pointerId); } catch (_e) { /* ignore */ }
    if (gesture.moved) {
      saveSettings({ overlayWidthPct: settings.overlayWidthPct, posMode: "custom",
        posXpct: settings.posXpct, posYpct: settings.posYpct });
    }
    event.stopPropagation();
  }

  // Reserve the native controls even while they are faded out, so showing them
  // does not move the subtitles or put selectable text on top of their buttons.
  function playerBottomInset(player, rect) {
    const controls = player.querySelector(".ytp-chrome-bottom");
    const controlsRect = controls?.getBoundingClientRect?.();
    const measured = controlsRect && controlsRect.height > 0 &&
      controlsRect.top >= rect.top && controlsRect.top < rect.bottom
      ? rect.bottom - controlsRect.top + 12 : 0;
    return Math.min(rect.height * 0.35, Math.max(48, rect.height * 0.08, measured));
  }

  function scheduleOverlayLayout() {
    if (!overlay || overlayLayoutFrame) return;
    if (typeof window.requestAnimationFrame !== "function") {
      layoutOverlay();
      return;
    }
    overlayLayoutFrame = window.requestAnimationFrame(() => {
      overlayLayoutFrame = 0;
      layoutOverlay();
    });
  }

  // Saved sizes describe the preferred full-player typography. Only rendered
  // sizes change in a smaller player; storage and the popup sliders stay intact.
  function layoutOverlay() {
    if (!overlay || !origEl || !transEl) return;
    const player = getPlayer();
    const rect = player?.getBoundingClientRect?.();
    if (!rect || !rect.width || !rect.height) return;
    const original = Math.max(1, Number(settings.origSize) || DEFAULTS.origSize);
    const translated = Math.max(1, Number(settings.transSize) || DEFAULTS.transSize);
    const largest = Math.max(settings.showOriginal ? original : 0,
      settings.showTranslation ? translated : 0, 1);
    const fullElement = document.fullscreenElement;
    const fullscreen = fullElement === player || fullElement?.contains?.(player) ||
      player.classList.contains("ytp-fullscreen");
    const windowedCap = Math.max(10, Math.min(rect.width * 0.028, rect.height * 0.055));
    let scale = fullscreen ? 1 : Math.min(1, windowedCap / largest);
    const availableHeight = Math.max(24, rect.height - playerBottomInset(player, rect) - 28);
    const budget = Math.min(availableHeight, rect.height * 0.45);
    // Release any previous emergency scroll limit before measuring the new cue.
    overlay.style.maxHeight = "";
    overlay.style.overflowY = "";
    const sizeLines = () => {
      origEl.style.fontSize = Math.max(10, Math.round(original * scale * 10) / 10) + "px";
      transEl.style.fontSize = Math.max(10, Math.round(translated * scale * 10) / 10) + "px";
      overlay.style.gap = Math.round((Number(settings.rowGap) || 0) * scale * 10) / 10 + "px";
    };
    sizeLines();
    // Wrapping is discontinuous: measure the actual lines after each reduction,
    // rather than estimating a character count (important for CJK and Arabic).
    for (let pass = 0; pass < 6 && overlay.offsetHeight > budget; pass++) {
      if ((!settings.showOriginal || parseFloat(origEl.style.fontSize) <= 10) &&
          (!settings.showTranslation || parseFloat(transEl.style.fontSize) <= 10)) break;
      scale *= Math.min(0.9, budget / overlay.offsetHeight);
      sizeLines();
    }
    // A pathological paragraph in a tiny miniplayer remains accessible by
    // scrolling, without covering the control bar or clipping text away.
    if (overlay.offsetHeight > availableHeight) {
      overlay.style.maxHeight = availableHeight + "px";
      overlay.style.overflowY = "auto";
    }
    applyPosition();
  }

  // Apply positioning after text wrapping, and also during live drag feedback.
  function applyPosition() {
    if (!overlay) return;
    if (settings.posMode === "custom") {
      overlay.classList.remove("ytds-pos-bottom", "ytds-pos-center", "ytds-pos-top");
      const x = clampPct(settings.posXpct);
      const y = clampPct(settings.posYpct);
      overlay.style.left = x + "%";
      overlay.style.top = y + "%";
      overlay.style.bottom = "auto";
      overlay.style.transform = "translate(-50%, -50%)";
    } else {
      // preset: hand control back to the CSS classes
      overlay.style.left = "";
      overlay.style.top = "";
      overlay.style.bottom = "";
      overlay.style.transform = "";
      overlay.classList.remove("ytds-pos-bottom", "ytds-pos-center", "ytds-pos-top");
      overlay.classList.add("ytds-pos-" + settings.position);
    }
    const player = getPlayer();
    const rect = player?.getBoundingClientRect?.();
    if (!rect || !rect.width || !rect.height) return;
    const edge = 14;
    const height = overlay.offsetHeight || 0;
    const width = overlay.offsetWidth || (configuredWidthPct()
      ? rect.width * configuredWidthPct() / 100 : Math.min(rect.width * 0.92, 1100));
    const bottom = rect.height - playerBottomInset(player, rect);
    const clampY = (center) => Math.max(edge + height / 2,
      Math.min(center, bottom - height / 2));
    if (settings.posMode === "custom") {
      const halfWidth = width / 2;
      overlay.style.left = Math.max(halfWidth + 8,
        Math.min(rect.width * clampPct(settings.posXpct) / 100,
          rect.width - halfWidth - 8)) + "px";
      overlay.style.top = clampY(rect.height * clampPct(settings.posYpct) / 100) + "px";
    } else if (settings.position === "bottom") {
      overlay.style.bottom = playerBottomInset(player, rect) + "px";
    } else if (settings.position === "center") {
      overlay.style.top = clampY(rect.height / 2) + "px";
    } else {
      overlay.style.top = Math.max(edge,
        Math.min(rect.height * 0.08, bottom - height)) + "px";
    }
  }

  function styleOverlay() {
    if (!overlay) return;
    applyOverlayWidth();
    overlay.style.setProperty("--ytds-karaoke-bg", rgba(settings.karaokeBg, settings.karaokeOpacity));
    overlay.style.setProperty("--ytds-karaoke-color", settings.karaokeTextColor);
    overlay.style.setProperty("--ytds-karaoke-border", settings.karaokeBg);

    // spacing + order
    overlay.style.gap = (Number(settings.rowGap) || 0) + "px";
    if (settings.order === "trans-top") {
      overlay.style.flexDirection = "column";         // trans first (on top)
    } else {
      overlay.style.flexDirection = "column-reverse"; // orig first (on top)
    }

    // original line
    origEl.style.fontFamily = fontStack(settings.origFont);
    origEl.style.fontSize = settings.origSize + "px";
    origEl.style.color = settings.origColor;
    origEl.style.background = rgba(settings.origBg, settings.origBgOpacity);
    origEl.style.textShadow = outlineShadow(settings.origStroke, settings.origStrokeOpacity);

    // translation line
    transEl.style.fontFamily = fontStack(settings.transFont);
    transEl.style.fontSize = settings.transSize + "px";
    transEl.style.color = settings.transColor;
    transEl.style.background = rgba(settings.transBg, settings.transBgOpacity);
    transEl.style.textShadow = outlineShadow(settings.transStroke, settings.transStrokeOpacity);

    // per-line visibility
    origEl.style.display = settings.showOriginal ? "" : "none";
    transEl.style.display = settings.showTranslation ? "" : "none";
    overlay.classList.toggle("ytds-word-lookup-on", !!settings.wordLookup);

    applyPosition();
    updateEmptyState();
    applyRevealState();
  }

  function removeOverlay() {
    document.documentElement?.classList.toggle("ytds-rendering", false);
    destroyWordPopup();
    resizeGesture = null;
    resizeHandles = [];
    if (overlayResizeObserver) { overlayResizeObserver.disconnect(); overlayResizeObserver = null; }
    if (overlayLayoutFrame) {
      window.cancelAnimationFrame?.(overlayLayoutFrame);
      overlayLayoutFrame = 0;
    }
    if (dragSaveTimer) { clearTimeout(dragSaveTimer); dragSaveTimer = null; }
    dragging = false;
    if (overlay) { overlay.remove(); overlay = null; } // removes handle + its listeners
    origEl = null;
    transEl = null;
    handleEl = null;
  }

  // Text of a line. The original line may be split into karaoke <span>s, and
  // parent.textContent is not reliable for the empty/non-empty decision in
  // every engine, so count the children when there are any.
  function lineText(el) {
    if (!el) return "";
    if (el.children && el.children.length) {
      let out = "";
      for (const child of el.children) out += child.textContent || "";
      return out;
    }
    return el.textContent || "";
  }

  // Hide the container only when there is no VISIBLE content. A line counts as
  // empty if its layer is turned off (showOriginal/showTranslation) OR it has
  // no text — so a disabled-but-non-empty layer does not keep the box open.
  function updateEmptyState() {
    if (!overlay) return;
    const oEmpty = !settings.showOriginal || !lineText(origEl);
    const tEmpty = !settings.showTranslation || !lineText(transEl);
    overlay.classList.toggle("ytds-empty", oEmpty && tEmpty);
    updateNativeSuppression();
    scheduleOverlayLayout();
  }

  function updateNativeSuppression() {
    // Keep native captions as a safety net until we can display their text.
    // A loaded track owns its silent gaps too; recognized sound-only native
    // captions must remain filtered instead of leaking through an empty box.
    const hasText = (settings.showOriginal && !!lineText(origEl)) ||
      (settings.showTranslation && !!lineText(transEl));
    const ownsTrack = !!cueTimer || !!(pollTimer && readNativeCaption(false));
    document.documentElement?.classList.toggle("ytds-rendering",
      settings.enabled && !extGone && (hasText || ownsTrack));
  }

  // ---- reveal modes (study: listen first, check the translation on demand) --
  function revealModeValue() {
    return settings.revealMode === "hover" || settings.revealMode === "manual"
      ? settings.revealMode : "always";
  }

  // "hover" reveal is driven from JS instead of a CSS :hover rule. In fullscreen
  // the player fills the viewport, so :hover on it is permanently true and says
  // nothing about where the pointer is; a move-then-idle deadline behaves the
  // same windowed and fullscreen (and keeps working if YouTube swaps the node).
  const HOVER_HOLD_MS = 2500;

  function clearHoverReveal() {
    if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = 0; }
    if (overlay) overlay.classList.remove("ytds-pointer-on");
  }

  function applyRevealState() {
    if (!overlay) return;
    const mode = revealModeValue();
    // "hover": visible only while the pointer is over the player and recently
    // moved. Leaving the player clears it immediately, including mid-sentence.
    overlay.classList.toggle("ytds-reveal-hover", mode === "hover");
    if (mode !== "hover") clearHoverReveal();
    // "manual": hidden until the reveal shortcut is pressed for THIS sentence.
    overlay.classList.toggle("ytds-reveal-hidden",
      mode === "manual" && !revealShown);
  }

  // The translation stays up for HOVER_HOLD_MS after the last pointer move, then
  // fades out — like YouTube's control bar, so "listen first" still holds.
  function onPointerMove(e) {
    if (!overlay || revealModeValue() !== "hover") return;
    const player = getPlayer();
    if (!player) { clearHoverReveal(); return; }
    const r = player.getBoundingClientRect();
    if (!r || !r.width || !r.height) { clearHoverReveal(); return; }
    if (e.clientX < r.left || e.clientX > r.right ||
        e.clientY < r.top || e.clientY > r.bottom) {
      clearHoverReveal();
      hideWordLookup();
      return;
    }
    overlay.classList.add("ytds-pointer-on");
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(() => {
      hoverHideTimer = 0;
      if (overlay) overlay.classList.remove("ytds-pointer-on");
    }, HOVER_HOLD_MS);
  }

  function onWindowPointerOut(e) {
    if (!e.relatedTarget) {
      if (revealModeValue() === "hover") clearHoverReveal();
      hideWordLookup();
    }
  }

  function clearWordSpans() {
    wordSpans = null;
    wordTimes = null;
    activeWordIdx = -1;
    wordTimingSource = "waiting";
    if (overlay) overlay.classList.remove("ytds-karaoke-estimated");
  }

  function setOriginal(text) {
    if (!ensureOverlay()) return;
    hideWordLookup();
    clearWordSpans();
    origEl.textContent = "";
    appendLookupSegments(origEl, stripSoundDescriptions(text));
    updateEmptyState();
  }

  // Keep the original text selectable while giving each word its own hover
  // target. Separators are spans too, so lineText() still sees the full sentence.
  function segmentCaptionWords(text) {
    if (!text) return [];
    try {
      const locale = cueSourceLang === "auto" ? undefined : cueSourceLang;
      return [...new Intl.Segmenter(locale, { granularity: "word" }).segment(text)]
        .map((part) => ({ text: part.segment, word: !!part.isWordLike }));
    } catch (_e) {
      return [...text.matchAll(/[\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+/gu)]
        .map((match) => ({ text: match[0], word: /^[\p{L}\p{M}\p{N}]/u.test(match[0]) }));
    }
  }

  function appendLookupSegments(parent, text) {
    for (const piece of segmentCaptionWords(text)) {
      const span = document.createElement("span");
      span.className = piece.word && piece.text.length <= 64
        ? "ytds-lookup-word" : "ytds-lookup-sep";
      span.textContent = piece.text;
      parent.appendChild(span);
    }
  }

  function hideWordLookup() {
    if (wordLookupTimer) { clearTimeout(wordLookupTimer); wordLookupTimer = 0; }
    if (wordLookupHideTimer) { clearTimeout(wordLookupHideTimer); wordLookupHideTimer = 0; }
    wordLookupSeq++;
    wordLookupIntent = "";
    if (wordPopup) wordPopup.hidden = true;
  }

  function destroyWordPopup() {
    hideWordLookup();
    if (wordPopup) wordPopup.remove();
    wordPopup = wordPopupWord = wordPopupMeaning = wordPopupMeta = wordPopupLink = null;
  }

  function scheduleWordLookupHide() {
    if (wordLookupTimer) {
      clearTimeout(wordLookupTimer);
      wordLookupTimer = 0;
      wordLookupSeq++;
      wordLookupIntent = "";
    }
    if (!wordLookupHideTimer) {
      wordLookupHideTimer = setTimeout(() => {
        wordLookupHideTimer = 0;
        hideWordLookup();
      }, 180);
    }
  }

  function ensureWordPopup() {
    const player = getPlayer();
    if (!player) return null;
    if (wordPopup && wordPopup.isConnected && wordPopup.parentElement === player) return wordPopup;
    if (wordPopup) wordPopup.remove();
    wordPopup = document.createElement("div");
    wordPopup.className = "ytds-word-popup notranslate";
    wordPopup.setAttribute("translate", "no");
    wordPopup.setAttribute("role", "group");
    wordPopup.setAttribute("aria-label", t("wordLookupAria", "字幕单词查询"));
    wordPopup.hidden = true;
    wordPopupWord = document.createElement("strong");
    wordPopupWord.className = "ytds-word-popup-word";
    wordPopupMeaning = document.createElement("div");
    wordPopupMeaning.className = "ytds-word-popup-meaning";
    wordPopupMeta = document.createElement("small");
    wordPopupMeta.className = "ytds-word-popup-meta";
    wordPopupLink = document.createElement("a");
    wordPopupLink.className = "ytds-word-popup-link";
    wordPopupLink.textContent = t("wordLookupGodic", "德语助手详查 ↗");
    wordPopupLink.target = "_blank";
    wordPopupLink.rel = "noopener noreferrer";
    wordPopup.appendChild(wordPopupWord);
    wordPopup.appendChild(wordPopupMeaning);
    wordPopup.appendChild(wordPopupMeta);
    wordPopup.appendChild(wordPopupLink);
    for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick"]) {
      wordPopup.addEventListener(type, (event) => event.stopPropagation());
    }
    wordPopup.addEventListener("pointerenter", () => {
      if (wordLookupHideTimer) { clearTimeout(wordLookupHideTimer); wordLookupHideTimer = 0; }
    });
    wordPopup.addEventListener("pointerleave", scheduleWordLookupHide);
    player.appendChild(wordPopup);
    return wordPopup;
  }

  function showWordPopup(word, meaning, sourceLang, targetLang, x, y) {
    const popup = ensureWordPopup();
    const player = getPlayer();
    if (!popup || !player) return;
    wordPopupWord.textContent = word;
    wordPopupMeaning.textContent = meaning;
    wordPopupMeta.textContent = (sourceLang === "auto" ? "?" : sourceLang) +
      " → " + targetLang + " · " + t("wordLookupMachineHint", "Google 单词直译");
    const german = /^de(?:-|$)/i.test(sourceLang);
    wordPopupLink.hidden = !german;
    if (german) {
      wordPopupLink.href = "https://www.godic.net/dicts/de/" + encodeURIComponent(word);
    }
    popup.hidden = false;
    const rect = player.getBoundingClientRect();
    const width = popup.offsetWidth || 270;
    const height = popup.offsetHeight || 105;
    const left = Math.min(Math.max(x - rect.left + 12, 8),
      Math.max(8, rect.width - width - 8));
    const below = y - rect.top + 16;
    const bottom = rect.height - playerBottomInset(player, rect);
    const top = below + height > bottom
      ? Math.max(8, Math.min(y - rect.top - height - 14, bottom - height)) : below;
    popup.style.left = left + "px";
    popup.style.top = top + "px";
  }

  function cacheWordLookup(key, translation) {
    wordLookupCache.delete(key);
    wordLookupCache.set(key, {
      translation, expires: translation ? Infinity : Date.now() + 30000
    });
    if (wordLookupCache.size > WORD_LOOKUP_CACHE_MAX) {
      wordLookupCache.delete(wordLookupCache.keys().next().value);
    }
  }

  function lookupHoveredWord(seq, key, word, sourceLang, targetLang, x, y) {
    wordLookupTimer = 0;
    if (seq !== wordLookupSeq || key !== wordLookupIntent) return;
    const cached = wordLookupCache.get(key);
    if (cached && cached.expires > Date.now()) {
      showWordPopup(word, cached.translation || t("wordLookupUnavailable", "暂时查不到译义"),
        sourceLang, targetLang, x, y);
      return;
    }
    showWordPopup(word, t("wordLookupLoading", "正在查词…"),
      sourceLang, targetLang, x, y);
    const handedOff = askBackground({
      type: "translate", text: word, sourceLang, targetLang
    }, (reply) => {
      const translation = reply && reply.ok && typeof reply.translated === "string"
        ? reply.translated.trim() : "";
      cacheWordLookup(key, translation);
      if (seq !== wordLookupSeq || key !== wordLookupIntent) return;
      showWordPopup(word, translation || t("wordLookupUnavailable", "暂时查不到译义"),
        sourceLang, targetLang, x, y);
    });
    if (!handedOff) hideWordLookup();
  }

  function onOriginalPointerMove(event) {
    if (!settings.enabled || !settings.wordLookup || !settings.showOriginal || event.buttons) {
      hideWordLookup();
      return;
    }
    const target = event.target;
    if (!target || !target.classList || !target.classList.contains("ytds-lookup-word")) {
      scheduleWordLookupHide();
      return;
    }
    const piece = segmentCaptionWords(target.textContent || "").find((part) => part.word);
    const word = piece && piece.text.trim();
    if (!word || word.length > 64) { scheduleWordLookupHide(); return; }
    if (wordLookupHideTimer) { clearTimeout(wordLookupHideTimer); wordLookupHideTimer = 0; }
    const sourceLang = cueSourceLang;
    const targetLang = settings.targetLang;
    const key = sourceLang + "\u0000" + targetLang + "\u0000" + word;
    if (key === wordLookupIntent) return;
    hideWordLookup();
    wordLookupIntent = key;
    const seq = wordLookupSeq;
    wordLookupTimer = setTimeout(() => lookupHoveredWord(seq, key, word,
      sourceLang, targetLang, event.clientX, event.clientY), WORD_LOOKUP_DELAY_MS);
  }

  // ---- karaoke: word-level highlight ---------------------------------------
  // Real caption offsets take priority. Estimation is visibly labeled and is
  // computed only for rendering, so exports and cached source times stay intact.
  function buildWordPieces(cue) {
    if (!settings.karaoke || !cue || !window.YtdsWordTiming) return null;
    const clean = { ...cue, text: stripSoundDescriptions(cue.text),
      words: Array.isArray(cue.words)
        ? cue.words.map((w) => w && ({ ...w, u: stripSoundDescriptions(w.u) })) : null };
    const pieces = window.YtdsWordTiming.captionPieces(clean, cueSourceLang);
    if (pieces) return { pieces, source: cue.wordTimingSource || "captions" };
    const estimated = settings.karaokeApproximate
      ? window.YtdsWordTiming.estimate(clean, cueSourceLang) : null;
    return estimated ? { pieces: estimated, source: "estimated" } : null;
  }

  function setOriginalWithWords(cue) {
    if (!ensureOverlay()) return;
    hideWordLookup();
    const plan = buildWordPieces(cue);
    if (!plan) {
      setOriginal(cue ? cue.text : "");
      wordTimingSource = settings.karaoke && cue ? "unavailable" : "waiting";
      return;
    }
    clearWordSpans();
    wordTimingSource = plan.source;
    overlay.classList.toggle("ytds-karaoke-estimated", plan.source === "estimated");
    origEl.setAttribute("data-ytds-timing-label", t("karaokeEstimatedBadge", "近似跟读"));
    origEl.textContent = "";              // drop the previous text/spans
    const spans = [];
    const times = [];
    for (const p of plan.pieces) {
      for (const part of segmentCaptionWords(p.u)) {
        const span = document.createElement("span");
        span.className = part.word ? "ytds-w ytds-lookup-word" : "ytds-lookup-sep";
        span.textContent = part.text;
        origEl.appendChild(span);
        if (part.word) { spans.push(span); times.push(p.t); }
      }
    }
    wordSpans = spans;
    wordTimes = times;
    updateEmptyState();
  }

  // Index of the word being spoken at display time t (offset already applied).
  function wordIdxAt(t) {
    if (!wordTimes || !wordTimes.length) return -1;
    let ans = -1;
    for (let i = 0; i < wordTimes.length; i++) {
      if (wordTimes[i] <= t) ans = i; else break;
    }
    return ans;
  }

  function highlightWord(k) {
    if (!wordSpans || k === activeWordIdx) return;
    if (activeWordIdx >= 0 && wordSpans[activeWordIdx]) {
      wordSpans[activeWordIdx].classList.remove("ytds-w-on");
    }
    activeWordIdx = wordSpans[k] ? k : -1;
    if (activeWordIdx >= 0) wordSpans[activeWordIdx].classList.add("ytds-w-on");
  }

  function setTranslation(text, forSource) {
    if (!ensureOverlay()) return;
    transEl.textContent = stripSoundDescriptions(text);
    if (arguments.length > 1) lastTransSource = forSource || "";
    updateEmptyState();
  }

  // ---- in-player quick toggle (YouTube control bar) ------------------------
  // A small button in the player's right-controls that flips the whole
  // extension on/off without opening the popup — handy when a video has
  // burned-in subtitles and the overlay would just overlap them.
  let toggleBtn = null;
  let controlsObserver = null;

  function ensureToggleButton(retries) {
    const player = getPlayer();
    const rc = player && player.querySelector(".ytp-right-controls");
    if (!rc) {                              // controls not ready yet — retry briefly
      if (retries > 0) setTimeout(() => ensureToggleButton(retries - 1), 500);
      return;
    }
    if (toggleBtn && toggleBtn.isConnected) { updateToggleState(); return; }
    toggleBtn = document.createElement("button");
    toggleBtn.className = "ytp-button ytds-toggle notranslate";
    toggleBtn.type = "button";
    toggleBtn.setAttribute("translate", "no");
    toggleBtn.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<rect x="2.6" y="5.5" width="18.8" height="13" rx="2.6" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8"></rect>' +
      '<rect x="5.6" y="9.2" width="7" height="1.8" rx="0.9" fill="currentColor"></rect>' +
      '<rect x="5.6" y="13" width="11" height="1.8" rx="0.9" fill="currentColor"></rect>' +
      "</svg>";
    toggleBtn.addEventListener("click", onToggleClick, true);
    rc.insertBefore(toggleBtn, rc.firstChild);   // leftmost of the right group
    updateToggleState();
    observeControls(rc);
  }

  function onToggleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    settings.enabled = !settings.enabled;   // optimistic
    updateToggleState();                     // instant button feedback
    applyStateToDom();                       // add/remove overlay immediately
    syncCaptions();                          // turn YouTube CC on/off to match
    saveSettings({ enabled: settings.enabled });
  }

  function updateToggleState() {
    if (!toggleBtn) return;
    const on = !!settings.enabled;
    toggleBtn.classList.toggle("ytds-on", on);
    toggleBtn.setAttribute("aria-pressed", on ? "true" : "false");
    const label =
      (on ? t("toggleTurnOff", "关闭双语字幕") : t("toggleTurnOn", "开启双语字幕")) +
      " (YT Dual Subs)";
    toggleBtn.setAttribute("aria-label", label);
    toggleBtn.title = label;
  }

  // Re-inject the button if YouTube ever rebuilds/clears its right-controls.
  function observeControls(rc) {
    if (controlsObserver) return;
    controlsObserver = new MutationObserver(() => {
      if (!toggleBtn || !toggleBtn.isConnected) {
        toggleBtn = null;
        ensureToggleButton(0);
      }
    });
    controlsObserver.observe(rc, { childList: true });
  }

  // ---- auto-enable YouTube's caption track ---------------------------------
  // The overlay needs the player to actually FETCH a timedtext track (that is
  // how inject.js gets the pot-bearing URL). So when the extension is on we turn
  // YouTube's CC on for the user by clicking the native button; turning the
  // extension off restores it — but only if WE were the ones who turned it on.
  let weEnabledCC = false;

  function ensureCaptionsOn(retries) {
    if (!settings.enabled || !settings.autoCaptions) return;
    const cc = document.querySelector(".ytp-subtitles-button");
    if (!cc || cc.getAttribute("aria-pressed") === null ||
        cc.getAttribute("aria-disabled") === "true") {
      if (retries > 0) setTimeout(() => ensureCaptionsOn(retries - 1),
        retries > 10 ? 200 : 600);
      return;                                   // button / state not ready yet
    }
    if (cc.getAttribute("aria-pressed") !== "true") {
      cc.click();
      weEnabledCC = true;
    }
  }

  function restoreCaptionsIfWeEnabled() {
    if (!weEnabledCC) return;
    weEnabledCC = false;
    const cc = document.querySelector(".ytp-subtitles-button");
    if (cc && cc.getAttribute("aria-pressed") === "true") cc.click();
  }

  function syncCaptions() {
    // autoCaptions off = leave YouTube's own CC switch alone; the user turns it
    // on when they want subtitles, and we still render our overlay on top.
    if (settings.enabled && settings.autoCaptions) ensureCaptionsOn(20);
    else restoreCaptionsIfWeEnabled();
  }

  // =========================================================================
  // CUE MODE
  // =========================================================================

  // binary search: greatest index whose start <= t. -1 if none.
  function findCueIdx(t) {
    if (!displayCueList || !displayCueList.length) return -1;
    let lo = 0, hi = displayCueList.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (displayCueList[mid].start <= t) { ans = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return ans;
  }

  // Find the cue active at time t, tolerant of overlapping/zero-dur cues.
  // findCueIdx gives the greatest-start candidate; if t is past that cue's
  // effective end we walk back to catch an earlier, longer cue still covering t
  // before declaring a gap. Returns the cue index or -1.
  function activeCueIdxAt(t) {
    let idx = findCueIdx(t);
    if (idx < 0) return -1;
    // Walk back over earlier cues whose (sorted) start <= t in case a longer
    // earlier cue still covers t. Bounded scan keeps this cheap.
    for (let i = idx; i >= 0; i--) {
      const c = displayCueList[i];
      if (t < c.end) return i;       // c covers t (end is the effective end)
      // If even the latest-starting candidate (i === idx) has ended, an
      // earlier cue might still be open (overlap); keep walking a small window.
      if (idx - i > 8) break;        // safety bound; cues rarely overlap deeply
    }
    return -1;                        // genuine gap
  }

  function startCueLoop() {
    stopCueLoop();
    stopRepeat();                     // a new loop must not inherit a slowed rate
    repeatDoneIdx = -1;
    activeCueIdx = -1;
    cueEpoch++;                       // invalidate any in-flight gtx callbacks
    revealShown = false;
    ensureOverlay();
    // Clear any leftover text (e.g. last scraped fallback line, or a previous
    // cue) so a start during a gap does not leave a stale line on screen.
    setOriginal("");
    setTranslation("", "");
    applyRevealState();
    cueTimer = setInterval(cueTick, 60);
    cueDirty = true;                  // one tick even if we start paused/hidden
    cueTick();                        // render the active cue NOW (no blank frame)
  }

  function stopCueLoop() {
    if (cueTimer) { clearInterval(cueTimer); cueTimer = null; }
    activeCueIdx = -1;
  }

  // ---- sentence repeat + slow playback (study mode) ------------------------
  function studyRateValue() {
    const r = Number(settings.studyRate);
    return isFinite(r) && r > 0.1 && r <= 2 ? r : 1;
  }

  function repeatTarget() {
    const n = Number(settings.repeatCount) || 0;
    if (!n) return 0;                        // off
    return n < 0 ? Infinity : Math.max(1, Math.round(n));
  }

  // The shortcut must work even while the repeat setting is off: it then plays
  // the current sentence twice, without changing the saved setting.
  function repeatTargetNow() {
    return manualRepeat ? 2 : repeatTarget();
  }

  function applyStudyRate() {
    const video = getVideo();
    if (!video) return;
    const want = studyRateValue();
    if (!weSetRate) {
      rateBeforeRepeat = Number(video.playbackRate) || 1;
      weSetRate = true;
    }
    if (Math.abs(Number(video.playbackRate) - want) > 0.001) {
      video.playbackRate = want;
    }
  }

  function startRepeat(idx) {
    const cue = displayCueList && displayCueList[idx];
    if (!cue) return;
    repeatCueIdx = idx;
    repeatLeft = repeatTargetNow();
    applyStudyRate();
  }

  // Restore the user's own playback rate when the repeat ends (only if WE were
  // the ones who changed it — a rate the user set by hand is never clobbered).
  function stopRepeat(restore) {
    if (repeatCueIdx === -1 && !weSetRate) return;
    repeatCueIdx = -1;
    repeatLeft = 0;
    manualRepeat = false;
    const video = getVideo();
    if (restore !== false && weSetRate && video) {
      video.playbackRate = rateBeforeRepeat;
    }
    weSetRate = false;
  }

  // Drive the repeat: slow the sentence down, rewind to its own audio window
  // once it ends, and stop when the count is used up. RAW cue times are used on
  // purpose — the sync offset shifts the display, never the audio we replay.
  // A finished sentence is remembered, otherwise its own rewound start would
  // re-arm it on the next tick and it would never leave the loop.
  function repeatTick(idx, video, t) {
    if (!repeatTargetNow()) {                 // repeat turned off (or never on)
      if (repeatCueIdx !== -1) stopRepeat();
      return;
    }
    if (repeatCueIdx !== -1) {                // a sentence is being repeated
      const cue = displayCueList[repeatCueIdx];
      if (!cue) { stopRepeat(); return; }
      // lastEnd is the sentence's OWN spoken end; end may be stretched to the
      // next cue for SRT purposes. t past it means it was fully spoken.
      const end = Number(cue.lastEnd) || Number(cue.end) ||
        (cue.start + ZERO_DUR_FLOOR_MS);
      if (t < end) return;                    // still inside this sentence
      if (repeatLeft <= 1) {
        const done = repeatCueIdx;
        stopRepeat();                         // turns used up: keep playing on
        repeatDoneIdx = done;
        return;
      }
      if (repeatLeft !== Infinity) repeatLeft--;
      try {
        video.currentTime = cue.start / 1000;  // replays this sentence
      } catch (_e) {
        stopRepeat();
      }
      return;
    }
    if (idx < 0) return;                      // gap between sentences
    if (idx === repeatDoneIdx) return;        // this one already had its turns
    repeatDoneIdx = -1;                       // a different sentence: stale now
    startRepeat(idx);
  }

  function cueTick() {
    if (!settings.enabled || !displayCueList) return;
    if (!extAlive()) { stopCueLoop(); return; }   // extension reloaded; stop quietly
    const video = getVideo();
    if (!video) return;
    // Paused (or backgrounded) playback cannot change which line belongs on
    // screen, so skip the work — except for the single forced tick after a
    // seek, a video change or a settings change (cueDirty).
    if ((video.paused || document.hidden) && !cueDirty) {
      // Pausing to wait for a translation must not stop loading it.
      if (!document.hidden && activeCueIdx >= 0) prefetchFrom(activeCueIdx);
      return;
    }
    cueDirty = false;
    // User sync nudge: + makes each line appear later, - earlier. Only the cue
    // engine honours it; the scraped fallback mirrors YouTube's own layer and
    // the SRT export deliberately keeps the original timing.
    const t = video.currentTime * 1000 + (Number(settings.offsetMs) || 0);

    const idx = activeCueIdxAt(t);

    // Study mode runs on EVERY tick: repeat has to notice the sentence END, and
    // the karaoke highlight moves while the same sentence stays on screen.
    repeatTick(idx, video, t);
    if (idx >= 0 && idx === activeCueIdx) {
      if (translationPending && pendingGoogleAllowed()) gtxRequest(idx);
      prefetchFrom(idx);                  // fill released slots even within one sentence
      if (wordSpans) highlightWord(wordIdxAt(t));
      return;                             // same sentence — no re-render, no jitter
    }

    if (idx < 0) {
      if (activeCueIdx !== -1) {
        activeCueIdx = -1;
        setOriginal("");
        setTranslation("", "");
      }
      return;
    }

    activeCueIdx = idx;

    const cue = displayCueList[idx];
    setOriginalWithWords(cue);
    revealShown = false;                  // a new sentence starts hidden again
    applyRevealState();
    renderTranslationForCue(idx, cue);
    prefetchFrom(idx);                    // warm upcoming translations (gtx mode)
    if (wordSpans) highlightWord(wordIdxAt(t));
  }

  function renderTranslationForCue(idx, cue) {
    const origText = cue.text;

    if (translationPending) {
      // Fast mode races Google immediately; whole-track mode starts its Google
      // backup after a brief wait. Both only paint the sentence on screen.
      const cached = transCache.get(cueVideoId + " " + idx);
      if (cached !== undefined) {
        setTranslation(cached, origText);
        fastPreviewIdx = idx;
      } else {
        setTranslation("", "");
        if (pendingGoogleAllowed()) gtxRequest(idx);
      }
      return;
    }

    // (1) Join the aligned tlang fragments for this whole sentence. If any
    // fragment lacks a translation, use the existing gtx path for the group.
    if (cueAligned === true && cue.trans && !cue.transIncomplete) {
      setTranslation(cue.trans, origText);
      return;
    }

    // (1b) tlang present but MISALIGNED (length mismatch): positional indexing
    // would paint wrong-but-plausible lines, so match by timestamp instead.
    // Pick the tcue whose start is closest to this cue's start within a
    // tolerance; if none qualifies, fall through to the gtx/cache path.
    // One misaligned tcue cannot represent a multi-fragment sentence; ask gtx
    // to translate that complete sentence instead of showing a partial line.
    if (tcueList && cueAligned === false && cue.rawCount === 1) {
      const m = nearestTcue(cue.start);
      if (m) {
        setTranslation(m.text, origText);
        return;
      }
      // no good timestamp match -> fall through (do NOT index positionally)
    }

    // (2) gtx backend (or no usable tlang data): cache by (videoId, idx).
    const key = cueVideoId + " " + idx;
    const cached = transCache.get(key);
    if (cached !== undefined) {
      setTranslation(cached, origText);
      return;
    }
    // Never leave the preceding sentence's translation beside this original.
    // Prefetch usually means this blank state is not visible to the user.
    setTranslation("", "");
    gtxRequest(idx);
  }

  function hasDirectTranslation(idx) {
    const cue = displayCueList && displayCueList[idx];
    if (!cue) return false;
    if (cueAligned === true && cue.trans && !cue.transIncomplete) return true;
    return !!(tcueList && cueAligned === false && cue.rawCount === 1 &&
      nearestTcue(cue.start));
  }

  // Fire a gtx translation for one cue, deduped by cache + in-flight set, caching
  // the result and painting it iff that cue is still active. Shared by the active
  // (on-demand) path and the look-ahead prefetch.
  function gtxBlocked() { return Date.now() < gtxCooldownUntil; }

  function pendingGoogleAllowed() {
    return !translationPending || settings.backend === "fast" ||
      (!!pendingSince && Date.now() - pendingSince >= PENDING_GOOGLE_AFTER_MS);
  }

  function gtxRequest(idx) {
    if (!displayCueList || gtxBlocked() || !extAlive()) return;
    const cue = displayCueList[idx];
    if (!cue || !cue.text) return;
    if (Date.now() < (transRetryAt.get(idx) || 0)) return;
    const key = cueVideoId + " " + idx;
    if (transCache.has(key) || transInflight.has(idx)) return;
    const reqVid = cueVideoId;
    const reqEpoch = cueEpoch;
    transInflight.set(idx, reqEpoch);
    const handed = askBackground(
      { type: "translate", text: cue.text, targetLang: settings.targetLang,
        sourceLang: cueSourceLang },
      (resp) => {
        // Release the slot first and only when it is still OURS: a stale reply
        // must not cancel a newer request for the same index, and the old
        // early return here leaked the slot and blocked that index for good.
        if (transInflight.get(idx) === reqEpoch) transInflight.delete(idx);
        if (reqEpoch !== cueEpoch) return;          // loop restarted / re-config
        if (reqVid !== cueVideoId) return;          // navigated away
        if (!extAlive() || chrome.runtime.lastError) return;  // worker asleep / reloaded
        if (resp && resp.ok && resp.translated) {
          gtxCooldownUntil = 0;                     // endpoint healthy again
          gtxBackoffStep = 0;
          transRetryAt.delete(idx);
          transCache.set(key, resp.translated);
          // A reply can land between clock ticks or immediately after a seek.
          // Reconcile with the VIDEO clock before touching either visible line.
          const video = getVideo();
          const currentIdx = video ? activeCueIdxAt(video.currentTime * 1000 +
            (Number(settings.offsetMs) || 0)) : -1;
          if (currentIdx !== activeCueIdx) {
            cueDirty = true;
            cueTick();
          }
          if (currentIdx === idx && activeCueIdx === idx &&
              (translationPending || !hasDirectTranslation(idx))) {
            setTranslation(resp.translated, cue.text);
            if (translationPending) fastPreviewIdx = idx;
          }
        } else if (resp && /\b429\b/.test(String(resp.error))) {
          // Rate limited. Instead of switching the free endpoint off for the
          // rest of the video, pause it for a growing cooldown and let a later
          // tick retry — one burst must not cost the whole video.
          const wait = GTX_BACKOFF_MS[Math.min(gtxBackoffStep, GTX_BACKOFF_MS.length - 1)];
          gtxBackoffStep++;
          gtxCooldownUntil = Date.now() + wait;
          console.warn("[YT Dual Subs] translation endpoint rate limited (" +
            resp.error + "); retrying in " + Math.round(wait / 1000) + "s");
        } else {
          transRetryAt.set(idx, Date.now() + 5000);
        }
        // Other failures leave the cache empty for a later attempt.
      }
    );
    // A dead context never hands the message over: release the slot we just
    // took, so a phantom in-flight request cannot block this index for good.
    if (!handed && transInflight.get(idx) === reqEpoch) transInflight.delete(idx);
  }

  // Warm upcoming cues' gtx translations so the translation line is ready the
  // moment a sentence appears — fixes the ~1s lag when tlang is unavailable.
  // Prefetch only groups without a complete direct translation. In particular,
  // a multi-fragment sentence cannot use just one misaligned tlang cue.
  // Window-bounded to stay gentle on the endpoint. Fast mode warms two upcoming
  // sentences immediately; whole-track mode does so after a 0.35s grace period.
  function prefetchFrom(startIdx) {
    if (!settings.enabled || !displayCueList || gtxBlocked()) return;
    let ahead = PREFETCH_AHEAD;
    if (translationPending) {
      if (!pendingGoogleAllowed()) return;
      ahead = PREFETCH_AHEAD_PENDING;
    }
    const from = Math.max(0, startIdx);
    const to = Math.min(displayCueList.length - 1, from + ahead);
    for (let i = from; i <= to; i++) {
      if (transInflight.size >= MAX_GTX_INFLIGHT) break;
      const c = displayCueList[i];
      if (cueAligned === true && c.trans && !c.transIncomplete) continue;
      if (cueAligned === false && c.rawCount === 1 && nearestTcue(c.start)) continue;
      gtxRequest(i);
    }
  }

  // Timestamp-match a translation cue for a given original start (ms), used
  // only when orig/tlang counts differ (cueAligned === false). Returns the
  // closest tcue within tolerance, or null.
  function nearestTcue(startMs) {
    if (!tcueList || !tcueList.length) return null;
    let best = null, bestDelta = Infinity;
    for (const tc of tcueList) {
      const d = Math.abs(tc.start - startMs);
      if (d < bestDelta) { bestDelta = d; best = tc; }
    }
    // Only trust a match within ~1.2s; re-segmentation shifts starts a little
    // but a far-off match is almost certainly the wrong sentence.
    if (best && bestDelta <= 1200 && best.text) return best;
    return null;
  }

  // Compute an effective end for each (already start-sorted) cue. Handles
  // zero/near-zero-duration cues (extend to the next cue's start, or a floor
  // for the final cue) so they are not treated as a permanent gap.
  function computeCueEnds(list) {
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      let end = c.start + (c.dur > 0 ? c.dur : 0);
      if (c.dur <= 0) {
        if (i + 1 < list.length) end = list[i + 1].start;
        else end = c.start + ZERO_DUR_FLOOR_MS;
        // guard against a non-positive window if the next cue shares the start
        if (end <= c.start) end = c.start + ZERO_DUR_FLOOR_MS;
      }
      c.end = end;
    }
  }

  // json3 events are often fragments (and ASR events can repeat earlier words).
  // Build display-only groups; keep cueList raw so SRT export remains unchanged.
  const SENTENCE_MAX_CHARS = 180;
  const SENTENCE_MAX_MS = 12000;
  const SENTENCE_GAP_MS = 1600;
  // Abbreviations whose period does NOT end a sentence, matched at the end of
  // the text, case-insensitively and tolerant of the spaced German form
  // ("u. a." as well as "u.a."). German is the main use case here, so the list
  // is German-heavy. Deliberately absent: "etc." / "usw.", which end sentences
  // often enough that always merging them would lose more than it gains.
  const ABBREV_END_RE = new RegExp(
    "\\b(?:" +
      "z\\.\\s?b|u\\.\\s?a|d\\.\\s?h|u\\.\\s?u|z\\.\\s?z|o\\.\\s?ä|i\\.\\s?d\\.\\s?r|" +
      "bzw|ca|vgl|ggf|evtl|inkl|zzgl|sog|max|min|Mio|Mrd|Std|Jh|Nr|Abs|Art|Bd|" +
      "Kap|Abb|Tab|Anm|Aufl|Bsp|Dr|Prof|Mr|Mrs|Ms|St|vs|approx" +
    ")\\.$", "i");

  // German dates and units put an ordinal right before the break ("am 3. Mai",
  // "am 1. Januar") and ASR breaks there happily, so that period is treated as
  // non-final — but only when the NEXT fragment really continues with a month,
  // weekday or unit word. A sentence that ends in a plain number ("Das kostet
  // 5.") therefore still keeps its own line.
  const ORDINAL_FOLLOW_RE = new RegExp(
    "^(?:Januar|Februar|März|April|Juni|Juli|August|September|Oktober|November|" +
    "Dezember|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|" +
    "Uhr|Kapitel|Etage|Stock|Jan|Feb|Mär|Apr|Jun|Jul|Aug|Sep|Sept|Okt|Nov|Dez)\\b",
    "i");

  // Sentence-final punctuation, optionally followed by closing quotes/brackets.
  // The closer set must include the German/Swiss quotes („ … “, « … » and
  // ‹ … ›): without them a fragment ending „Hallo.“ was not recognised as a
  // sentence end at all and got merged with the next sentence.
  const SENTENCE_END_RE = /[.!?。！？؟۔॥।։።፧]["'”’“„«»‹›」』】〕）)\]]*$/;
  const UNSPACED_END_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]$/u;
  const UNSPACED_START_RE = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

  function endsSentence(text, nextText) {
    const s = String(text || "").trim();
    if (!s) return false;
    if (ABBREV_END_RE.test(s)) return false;
    if (/\d\.$/.test(s) && nextText &&
        ORDINAL_FOLLOW_RE.test(String(nextText).trim())) return false;
    return SENTENCE_END_RE.test(s);
  }

  function appendCaptionText(left, right) {
    if (!right) return left;
    // These scripts normally join written fragments without spaces. Inserting
    // English-style spaces into Japanese kana or Thai captions changes the text.
    const noSpace = /^[,.;:!?。，、！？；：؟۔॥।։።፧)\]}]/.test(right) ||
      UNSPACED_END_RE.test(left) || UNSPACED_START_RE.test(right);
    return left + (noSpace ? "" : " ") + right;
  }

  function joinCaptionText(left, right) {
    const a = String(left || "").replace(/\s+/g, " ").trim();
    const b = String(right || "").replace(/\s+/g, " ").trim();
    if (!a) return b;
    if (!b || a === b || a.endsWith(b)) return a;
    if (b.startsWith(a)) return b;

    const aw = a.split(" "), bw = b.split(" ");
    for (let n = Math.min(aw.length, bw.length); n >= 1; n--) {
      if (aw.slice(-n).join(" ").toLowerCase() === bw.slice(0, n).join(" ").toLowerCase()) {
        return appendCaptionText(a, bw.slice(n).join(" "));
      }
    }
    // Translated CJK cues often overlap by one or two characters, not words.
    for (let n = Math.min(a.length, b.length); n >= 1; n--) {
      if (a.slice(-n) === b.slice(0, n) &&
          (n >= 2 || /[\u3400-\u9fff]/.test(a.slice(-1)))) {
        return appendCaptionText(a, b.slice(n));
      }
    }
    return appendCaptionText(a, b);
  }

  function stripRollingPrefix(previous, next) {
    const before = String(previous || "").replace(/\s+/g, " ").trim();
    const after = String(next || "").replace(/\s+/g, " ").trim();
    return before && after.startsWith(before) ? after.slice(before.length).trim() : after;
  }

  function buildDisplayCues(rawCues) {
    const groups = [];
    let current = null;
    for (const cue of rawCues) {
      if (!cue.text) continue;
      const cleanText = stripSoundDescriptions(cue.text);
      const cleanTrans = stripSoundDescriptions(cue.trans);
      if (!cleanText) {
        // A pure sound cue is a visible gap, not a bridge between two phrases.
        // Preserve a spoken cue's full duration when the sound cue overlaps it.
        if (current) groups.push(current);
        current = null;
        continue;
      }
      // A zero-duration json3 event is extended to the next cue for SRT, but
      // that must not make display groups span an arbitrarily long silence.
      const cueEnd = cue.dur > 0 ? cue.end :
        Math.min(cue.end, cue.start + ZERO_DUR_FLOOR_MS);
      // A rolling ASR event may repeat the just-completed sentence before
      // adding the next one. Do not swallow a separately spoken identical cue.
      const rolling = current && endsSentence(current.text) &&
        cue.start <= current.lastEnd + 200 &&
        cleanText.length > current.text.length && cleanText.startsWith(current.text);
      const text = rolling ? stripRollingPrefix(current.text, cleanText) : cleanText;
      // If tlang revised the wording/punctuation, its prefix is not reliable;
      // retranslate only the new source sentence instead of showing a mismatch.
      const trans = rolling
        ? (current.trans && cleanTrans && cleanTrans.startsWith(current.trans)
          ? stripRollingPrefix(current.trans, cleanTrans) : "")
        : cleanTrans;
      if (!text) {
        current = { ...current, end: Math.max(current.end, cueEnd),
          lastStart: cue.start, lastEnd: cueEnd };
        continue;
      }
      const nextText = joinCaptionText(current && current.text, text);
      const gap = current ? cue.start - current.lastEnd : 0;
      // A word-timed ASR track hands us ONE WORD per event. Those must never be
      // shown one word at a time: merge the whole sentence and let the karaoke
      // highlight show which word is being spoken. A pause between two words is
      // therefore not a sentence break for such a track.
      const wordLevel = Array.isArray(cue.words) && cue.words.length > 0 &&
        !/\s/.test(cleanText);
      const split = current && (endsSentence(current.text, text) ||
        (!wordLevel && gap > SENTENCE_GAP_MS) ||
        cue.start - current.start > SENTENCE_MAX_MS ||
        nextText.length > SENTENCE_MAX_CHARS);
      if (!current || split) {
        if (current) groups.push(current);
        current = {
          start: cue.start, end: cueEnd, text, trans: trans || "",
          transIncomplete: !trans, rawCount: 1,
          // Word timings are kept only while the grouping stays 1:1 with the
          // raw cue: a rolling ASR revision or an overlap-merge would place the
          // highlight on the wrong word, so those groups clear them.
          words: rolling ? null : (cue.words || null),
          wordTimingSource: cue.wordTimingSource || "captions",
          rolling: !!rolling,
          lastStart: cue.start, lastEnd: cueEnd
        };
      } else {
        current = {
          ...current,
          end: Math.max(current.end, cueEnd),
          text: nextText,
          trans: joinCaptionText(current.trans, trans),
          transIncomplete: current.transIncomplete || !trans,
          rawCount: current.rawCount + 1,
          words: !rolling && !current.rolling && current.words && cue.words
            ? current.words.concat(cue.words) : null,
          wordTimingSource: current.wordTimingSource === "automatic" ||
            cue.wordTimingSource === "automatic" ? "automatic" : "captions",
          rolling: current.rolling || !!rolling,
          lastStart: cue.start, lastEnd: cueEnd
        };
      }
    }
    if (current) groups.push(current);
    return groups;
  }

  // ---- per-video cue cache (memory only) -----------------------------------
  // YouTube re-uses one document for every navigation, but reloading a video we
  // opened earlier still costs a full timedtext round-trip. Keeping the parsed
  // cues for the last few videos lets that case paint immediately; inject.js
  // keeps fetching in the background and its reply refreshes what is on screen.
  function rememberCues() {
    if (!cueList || !cueList.length || !cueVideoId) return;
    if (cueList.length > VIDEO_CACHE_MAX_CUES) return;   // don't pin a huge track
    videoCueCache.delete(cueVideoId);                    // refresh recency
    videoCueCache.set(cueVideoId, {
      cues: cueList.map((c) => ({
        start: c.start, dur: c.dur, text: c.text, trans: c.trans || "",
        wordTimingSource: c.wordTimingSource || "captions",
        words: Array.isArray(c.words)
          ? c.words.map((w) => w && { t: w.t, u: w.u }) : null
      })),
      tcues: Array.isArray(tcueList)
        ? tcueList.map((c) => ({ start: c.start, dur: c.dur, text: c.text }))
        : null,
      aligned: cueAligned,
      sourceLang: cueSourceLang,
      targetLang: settings.targetLang,
      pending: translationPending
    });
    while (videoCueCache.size > VIDEO_CACHE_MAX) {
      videoCueCache.delete(videoCueCache.keys().next().value);   // oldest first
    }
  }

  // Paint a cached video's cues right away. Returns true when something was
  // shown. A cached entry for a DIFFERENT target language keeps only the
  // original line and waits for the fresh whole-track translation (instead of
  // firing one Google request per sentence).
  function restoreCachedCues() {
    const cached = videoCueCache.get(currentVideoId);
    if (!cached || !cached.cues || !cached.cues.length) return false;
    const sameLang = cached.targetLang === settings.targetLang;
    const cues = cached.cues.map((c) => ({
      start: c.start, dur: c.dur, text: c.text,
      wordTimingSource: c.wordTimingSource || "captions",
      trans: sameLang ? c.trans : "",
      words: Array.isArray(c.words)
        ? c.words.map((w) => w && { t: w.t, u: w.u }) : null
    }));
    cueList = cues;
    computeCueEnds(cueList);
    displayCueList = buildDisplayCues(cueList);
    if (!displayCueList.length) {
      cueList = null;
      displayCueList = null;
      return false;
    }
    videoCueCache.delete(currentVideoId);                // refresh recency
    videoCueCache.set(currentVideoId, cached);

    cueAligned = sameLang ? cached.aligned : null;
    tcueList = (sameLang && cached.aligned === false && Array.isArray(cached.tcues))
      ? cached.tcues.slice().sort((a, b) => a.start - b.start)
      : null;
    cueVideoId = currentVideoId;
    cueSourceLang = cached.sourceLang || "auto";
    // Still waiting on YouTube whenever the cached set had no translation yet or
    // the target language changed; that also keeps gtx prefetch behind the
    // "only after a visible wait" rule.
    translationPending = !sameLang || !!cached.pending;
    pendingSince = translationPending ? Date.now() : 0;
    fastPreviewIdx = -1;
    usedVideoCache = true;
    startCueLoop();
    return true;
  }

  function onCues(data) {
    if (data.videoId && data.videoId !== currentVideoId) return; // stale (videoId)
    if (typeof data.nonce === "number" && data.nonce !== configNonce) return; // stale (nonce)
    const updateTranslation = !!data.translationUpdate && !!cueList &&
      cueVideoId === (data.videoId || currentVideoId);
    const keepFastPreview = updateTranslation &&
      translationPending && fastPreviewIdx === activeCueIdx &&
      !!transEl?.textContent;
    nocuesFallback = false;
    stopFallback();                 // cue mode wins; stop scraping

    // cues arrive in json3 EVENT ORDER, with the aligned translation already
    // paired onto each cue as cue.trans (done in inject.js BEFORE any sort).
    // We sort the SINGLE cue array here; because the translation rides on the
    // cue, sorting can never desync orig vs translation.
    cueList = Array.isArray(data.cues) ? data.cues.slice() : [];
    cueList.sort((a, b) => a.start - b.start);
    computeCueEnds(cueList);
    displayCueList = buildDisplayCues(cueList);
    if (!updateTranslation) {
      transCache.clear();
      transInflight.clear();
      transRetryAt.clear();
      fastPreviewIdx = -1;
      gtxCooldownUntil = 0;
      gtxBackoffStep = 0;
    }

    cueAligned = data.aligned;
    translationPending = !!data.translationPending;
    pendingSince = translationPending ? Date.now() : 0;
    // Keep tcueList only for the misaligned timestamp-match fallback. When
    // aligned, cue.trans is authoritative and tcueList is unused.
    tcueList = (cueAligned === false && Array.isArray(data.tcues))
      ? data.tcues.slice().sort((a, b) => a.start - b.start)
      : null;
    cueVideoId = data.videoId || currentVideoId;
    cueSourceLang = data.sourceLang || "auto";
    usedVideoCache = false;         // fresh data from the page has taken over

    if (!cueList.length) { onNoCues(data); return; }
    if (updateTranslation) {
      // Keep the current original line and timer in place. Only the translated
      // text changes when the second whole-track request completes.
      const video = getVideo();
      const idx = video
        ? activeCueIdxAt(video.currentTime * 1000 + (Number(settings.offsetMs) || 0))
        : -1;
      if (data.wordTimingUpdate && idx >= 0 && idx === activeCueIdx &&
          lineText(origEl) === displayCueList[idx].text) {
        setOriginalWithWords(displayCueList[idx]);
        highlightWord(wordIdxAt(video.currentTime * 1000 + (Number(settings.offsetMs) || 0)));
      }
      if (idx !== activeCueIdx || idx < 0 ||
          lineText(origEl) !== displayCueList[idx].text) {
        // Do not advance activeCueIdx without repainting the original: that
        // would permanently pair the preceding original with this translation.
        activeCueIdx = -1;
        cueDirty = true;
        if (idx < 0) { setOriginal(""); setTranslation("", ""); }
        cueTick();
      } else {
        if (!(keepFastPreview && fastPreviewIdx === idx &&
              lineText(origEl) === displayCueList[idx].text)) {
          fastPreviewIdx = -1;
          renderTranslationForCue(idx, displayCueList[idx]);
        }
        prefetchFrom(idx);
      }
    } else {
      startCueLoop();
    }
    rememberCues();                 // in-memory only, for instant SPA re-visits
  }

  // =========================================================================
  // FALLBACK MODE (v1 rendered-scrape)
  // =========================================================================
  function extendsNativeCaption(previous, next) {
    if (!previous || !next.startsWith(previous) || endsSentence(previous, next)) return false;
    const suffix = next.slice(previous.length);
    return /^[\s,.;:!?。，、！？；：]/.test(suffix) || UNSPACED_END_RE.test(previous);
  }

  function scheduleTranslate(text) {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (fallbackInflight || gtxBlocked() || Date.now() < fallbackRetryAt) return;
    const timer = setTimeout(() => {
      if (debounceTimer !== timer) return;
      debounceTimer = null;
      if (!pollTimer || text !== lastSource || text === lastTransSource || fallbackInflight ||
          gtxBlocked() || Date.now() < fallbackRetryAt) return;
      const token = lastReqToken;
      const pending = { token, text };
      fallbackInflight = pending;
      const handed = askBackground(
        { type: "translate", text, targetLang: settings.targetLang, sourceLang: cueSourceLang },
        (resp) => {
          const ownsSlot = fallbackInflight === pending;
          if (ownsSlot) fallbackInflight = null;
          if (!extAlive() || !pollTimer) return;
          const rateLimited = resp && /\b429\b/.test(String(resp.error));
          // A changed sentence does not remove the endpoint's rate limit.
          if (ownsSlot && rateLimited) {
            gtxCooldownUntil = Date.now() + GTX_BACKOFF_MS[Math.min(gtxBackoffStep++, GTX_BACKOFF_MS.length - 1)];
          }
          if (token !== lastReqToken) {
            if (ownsSlot && lastSource) scheduleTranslate(lastSource);
            return;
          }
          if (readNativeCaption() !== lastSource) fallbackTick();
          if (token !== lastReqToken ||
              (text !== lastSource && !extendsNativeCaption(text, lastSource))) return;
          if (!chrome.runtime.lastError && resp && resp.ok && resp.translated) {
            fallbackRetryAt = 0;
            gtxCooldownUntil = 0;
            gtxBackoffStep = 0;
            // Only accept a prefix of this same sentence; never regress a newer result.
            if (!lastTransSource || text.length >= lastTransSource.length) {
              fallbackTranslation = resp.translated;
              setTranslation(resp.translated + (text === lastSource ? "" : " …"), text);
            }
          } else if (!rateLimited) fallbackRetryAt = Date.now() + 1000;
          if (lastSource && lastSource !== lastTransSource) scheduleTranslate(lastSource);
        }
      );
      if (!handed && fallbackInflight === pending) {
        fallbackInflight = null;
        fallbackRetryAt = Date.now() + 1000;
      }
    }, DEBOUNCE_MS);
    debounceTimer = timer;
  }

  function fallbackTick() {
    if (!settings.enabled) return;
    if (!extAlive()) { stopFallback(); return; }  // extension reloaded; stop quietly
    if (!ensureOverlay()) return;       // document_start may precede the player
    watchNativeCaptions();
    if (nativeSkipText !== null) {
      if (readNativeCaption(false) === nativeSkipText) { updateNativeSuppression(); return; }
      nativeSkipText = null;
    }
    const text = readNativeCaption();
    if (text === lastSource) {
      updateNativeSuppression();
      if (text && text !== lastTransSource && !fallbackInflight && !debounceTimer) scheduleTranslate(text);
      return;
    }
    const continuing = extendsNativeCaption(lastSource, text);
    lastSource = text;
    if (!continuing) {
      lastReqToken++;
      fallbackRetryAt = 0;
      fallbackTranslation = "";
      setTranslation("", "");
    } else if (lastTransSource) {
      setTranslation(fallbackTranslation + " …", lastTransSource);
    }

    if (!text) {
      if (debounceTimer) clearTimeout(debounceTimer);
      setOriginal("");
      return;
    }

    setOriginal(text);
    scheduleTranslate(text);
  }

  function startFallback() {
    if (pollTimer) return;
    ensureOverlay();
    pollTimer = setInterval(fallbackTick, 120);
    fallbackTick();                       // do not wait for a timer or watchdog
  }

  function watchNativeCaptions() {
    const player = getPlayer();
    if (player === nativeCaptionPlayer || typeof MutationObserver === "undefined") return;
    if (nativeCaptionObserver) nativeCaptionObserver.disconnect();
    nativeCaptionPlayer = player;
    if (!player) return;
    const selector = ".ytp-caption-window-container, .caption-window, .ytp-caption-segment";
    const containsCaption = (node, nested = false) => {
      const el = node && (node.nodeType === 3 ? node.parentElement : node);
      return !!(el && (el.closest?.(selector) || (nested && el.querySelector?.(selector))));
    };
    nativeCaptionObserver = new MutationObserver((records) => {
      if (!pollTimer) return;
      // Ignore our own overlay writes; otherwise observing the player recurses.
      if (records.some((r) => containsCaption(r.target) ||
          [...r.addedNodes, ...r.removedNodes].some((n) => containsCaption(n, true)))) {
        nativeSkipText = null; // fresh native DOM can contain the same words on the new video
        fallbackTick();
      }
    });
    nativeCaptionObserver.observe(player, { subtree: true, childList: true, characterData: true });
  }

  function stopFallback() {
    if (nativeCaptionObserver) { nativeCaptionObserver.disconnect(); nativeCaptionObserver = null; }
    nativeCaptionPlayer = null;
    nativeSkipText = null;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    lastSource = "";
    lastTransSource = "";
    lastReqToken++;
    fallbackInflight = null;
    fallbackRetryAt = 0;
    fallbackTranslation = "";
  }

  function onNoCues(data) {
    if (data && data.videoId && data.videoId !== currentVideoId) return;
    if (data && typeof data.nonce === "number" && data.nonce !== configNonce) return;
    const wasCueMode = !!cueList || !!cueTimer;
    nocuesFallback = true;
    stopCueLoop();
    if (wasCueMode) {
      cueEpoch++;
      transInflight.clear();
      transRetryAt.clear();
      setOriginal("");
      setTranslation("", "");
    }
    cueList = null;
    displayCueList = null;
    tcueList = null;
    cueVideoId = "";
    cueSourceLang = data?.sourceLang || "auto";
    translationPending = false;
    fastPreviewIdx = -1;
    if (settings.enabled) startFallback();
  }

  // =========================================================================
  // EXPORT (SRT download)
  // =========================================================================
  // Triggered from the popup via chrome.tabs.sendMessage. We build an .srt from
  // the cue data and download it via a Blob + <a download> (no extra permission).

  // Snapshot for the popup's status line. Descriptive only: it reports what this
  // page is doing right now — including which service the visible translation
  // came from — so a slow or blank translation line becomes explainable instead
  // of mysterious.
  function pageStatus() {
    let mode = "off";
    if (cueTimer) mode = "cues";
    else if (pollTimer) mode = "scrape";

    let transSource = "none";
    const cue = (activeCueIdx >= 0 && displayCueList)
      ? displayCueList[activeCueIdx] : null;
    if (cue) {
      if (translationPending && fastPreviewIdx === activeCueIdx) transSource = "google";
      else if (cue.trans) transSource = "youtube";
      else if (transCache.has(cueVideoId + " " + activeCueIdx)) transSource = "google";
      else if (translationPending) transSource = "waiting";
      else transSource = "google";
    } else if (pollTimer) {
      transSource = lastTransSource ? "google" : "waiting";
    }

    return {
      ok: true,
      version: liveVersion(),
      videoId: currentVideoId,
      enabled: !!settings.enabled,
      backend: settings.backend,
      targetLang: settings.targetLang,
      sourceLang: cueSourceLang,
      mode,                                 // cues | scrape | off
      source: cueVideoId ? "youtube" : (lastSource ? "native" : "none"),
      transSource,                          // youtube | google | waiting | none
      wordTiming: !settings.enabled || !settings.karaoke ? "off" : wordTimingSource,
      cueCount: displayCueList ? displayCueList.length : 0,
      pending: !!translationPending,
      cached: !!usedVideoCache,
      cooldownSec: Math.max(0, Math.ceil((gtxCooldownUntil - Date.now()) / 1000))
    };
  }

  // Version of the LIVE extension, or "" when this content script's context is
  // dead (extension reloaded with the page open) — that read throws too.
  function liveVersion() {
    try {
      return (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "";
    } catch (_e) {
      return "";
    }
  }

  function studyEntry(index) {
    const cue = displayCueList && displayCueList[index];
    if (!cue) return null;
    const cached = transCache.get(cueVideoId + " " + index);
    const activeText = index === activeCueIdx ? lineText(transEl) : "";
    return {
      index,
      start: cue.start,
      text: cue.text,
      trans: activeText || (!cue.transIncomplete ? cue.trans : "") || cached || ""
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === "studyCues") {
      if (!displayCueList || !displayCueList.length) {
        sendResponse({ ok: false, reason: "nocue" });
        return;
      }
      const query = String(msg.query || "").trim().slice(0, 100).toLocaleLowerCase();
      const requestedOffset = Number(msg.offset);
      const requestedLimit = Number(msg.limit);
      const offset = Number.isFinite(requestedOffset)
        ? Math.max(0, Math.floor(requestedOffset)) : 0;
      const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(80, Math.floor(requestedLimit))) : 40;
      const indices = [];
      for (let i = 0; i < displayCueList.length; i++) {
        if (!query || displayCueList[i].text.toLocaleLowerCase().includes(query)) indices.push(i);
      }
      sendResponse({
        ok: true, videoId: currentVideoId, title: videoTitle(),
        sourceLang: cueSourceLang, total: indices.length,
        entries: indices.slice(offset, offset + limit).map(studyEntry)
      });
      return;
    }
    if (msg.type === "studyCurrent") {
      const video = getVideo();
      const index = video && displayCueList
        ? activeCueIdxAt(video.currentTime * 1000 + (Number(settings.offsetMs) || 0))
        : -1;
      const cue = studyEntry(index);
      sendResponse(cue
        ? { ok: true, videoId: currentVideoId, title: videoTitle(),
            sourceLang: cueSourceLang, cue }
        : { ok: false, reason: "nocue" });
      return;
    }
    if (msg.type === "studySeek") {
      const index = Number(msg.index);
      const video = getVideo();
      if (msg.videoId !== currentVideoId || !Number.isInteger(index) ||
          index < 0 || !displayCueList || index >= displayCueList.length || !video) {
        sendResponse({ ok: false, reason: "nocue" });
        return;
      }
      if (msg.expectedStart != null) {
        const expectedStart = Number(msg.expectedStart);
        if (!Number.isFinite(expectedStart) ||
            Math.abs(expectedStart - displayCueList[index].start) > 200) {
          sendResponse({ ok: false, reason: "changed" });
          return;
        }
      }
      stopRepeat();
      repeatDoneIdx = -1;
      try { video.currentTime = displayCueList[index].start / 1000; }
      catch (_e) { sendResponse({ ok: false, reason: "seek" }); return; }
      activeCueIdx = -1;
      cueDirty = true;
      cueTick();
      sendResponse({ ok: true, index });
      return;
    }
    if (msg.type === "status") {
      sendResponse(pageStatus());
      return;
    }
    if (msg.type === "repeatSentence") {
      // The shortcut toggles the loop on whatever sentence is on screen, and it
      // works even while the saved repeat count is off (it then plays twice).
      if (repeatCueIdx !== -1 && repeatCueIdx === activeCueIdx) {
        stopRepeat();
        sendResponse({ ok: true, repeating: false });
        return;
      }
      if (activeCueIdx < 0 || !displayCueList) {
        sendResponse({ ok: false, reason: "nocue" });
        return;
      }
      manualRepeat = !repeatTarget();
      repeatDoneIdx = -1;             // the shortcut always re-arms this sentence
      startRepeat(activeCueIdx);
      const video = getVideo();
      const cue = displayCueList[activeCueIdx];
      if (video && cue) {
        try {
          video.currentTime = cue.start / 1000;   // restart the sentence
        } catch (_e) { /* ignore */ }
      }
      sendResponse({ ok: true, repeating: true, count: repeatTargetNow() });
      return;
    }
    if (msg.type === "revealTranslation") {
      if (revealModeValue() !== "manual") {
        sendResponse({ ok: false, reason: "mode" });
        return;
      }
      revealShown = !revealShown;
      applyRevealState();
      sendResponse({ ok: true, revealed: revealShown });
      return;
    }
    if (msg.type === "stepSentence") {
      // Popup buttons: jump to the previous / next sentence. Pressing "previous"
      // mid-sentence restarts that sentence first (what every media player does);
      // press it again to actually step back.
      const video = getVideo();
      if (!video || !displayCueList || !displayCueList.length) {
        sendResponse({ ok: false, reason: "nocue" });
        return;
      }
      const back = Number(msg.delta) < 0;
      const t = video.currentTime * 1000 + (Number(settings.offsetMs) || 0);
      let idx = activeCueIdx >= 0 ? activeCueIdx : findCueIdx(t);
      if (idx < 0) idx = 0;
      else if (back) {
        const cur = displayCueList[idx];
        if (t - Number(cur.start) <= PREV_RESTART_MS) idx = Math.max(0, idx - 1);
      } else {
        idx = Math.min(displayCueList.length - 1, idx + 1);
      }
      const cue = displayCueList[idx];
      stopRepeat();
      repeatDoneIdx = -1;
      try {
        video.currentTime = Number(cue.start) / 1000;
      } catch (_e) { /* ignore */ }
      activeCueIdx = -1;                 // force a repaint of the new sentence
      cueDirty = true;
      cueTick();
      sendResponse({ ok: true, index: idx, count: displayCueList.length });
      return;
    }
    if (msg.type === "toggleTranslation") {
      settings.showTranslation = !settings.showTranslation;
      if (overlay) styleOverlay();
      saveSettings({ showTranslation: settings.showTranslation });
      sendResponse({ ok: true, visible: settings.showTranslation });
      return;
    }
    if (msg.type !== "exportSrt") return;          // not ours — ignore
    handleExport(msg.variant)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, reason: "nocues" }));
    return true;                                            // async reply
  });

  // Ask inject.js for a COMPLETE bilingual cue set. inject reuses the captured
  // pot-bearing URL to fetch the whole-track translation, so the download is
  // complete even when the live overlay runs in gtx mode. Resolves with the
  // inject reply, or { ok:false } on timeout.
  function requestExportData(targetLang) {
    return new Promise((resolve) => {
      const exportId = ++exportSeq;
      const timer = setTimeout(() => {
        exportWaiters.delete(exportId);
        resolve({ ok: false });
      }, 9000);
      exportWaiters.set(exportId, { resolve, timer });
      try {
        window.postMessage(
          { source: "ytds-content", type: "export-request", targetLang, exportId },
          "*"
        );
      } catch (_e) {
        clearTimeout(timer);
        exportWaiters.delete(exportId);
        resolve({ ok: false });
      }
    });
  }

  function resolveExportData(d) {
    const w = exportWaiters.get(d.exportId);
    if (!w) return;
    clearTimeout(w.timer);
    exportWaiters.delete(d.exportId);
    w.resolve(d);
  }

  // ms -> "HH:MM:SS,mmm"
  function srtTime(ms) {
    let n = Math.round(Number(ms));
    if (!isFinite(n) || n < 0) n = 0;
    const h = Math.floor(n / 3600000);
    const m = Math.floor((n % 3600000) / 60000);
    const s = Math.floor((n % 60000) / 1000);
    const ms3 = n % 1000;
    const p = (v, w) => String(v).padStart(w, "0");
    return p(h, 2) + ":" + p(m, 2) + ":" + p(s, 2) + "," + p(ms3, 3);
  }

  // Build SRT text from start-sorted cues (ends computed). Returns {text,count}.
  // "orig" | "trans" | "bi"; bilingual line order follows the user's order pref.
  function buildSrt(cues, variant) {
    const out = [];
    let n = 0;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      let body;
      if (variant === "orig") {
        body = (c.text || "").trim();
      } else if (variant === "trans") {
        body = (c.trans || "").trim();
      } else {
        const o = (c.text || "").trim();
        const tr = (c.trans || "").trim();
        const top = settings.order === "trans-top" ? tr : o;
        const bottom = settings.order === "trans-top" ? o : tr;
        body = [top, bottom].filter(Boolean).join("\n");
      }
      if (!body) continue;
      n++;
      let end = (c.end != null)
        ? c.end
        : c.start + (c.dur > 0 ? c.dur : ZERO_DUR_FLOOR_MS);
      // Trim overlap: auto-generated (ASR) tracks use rolling cues whose windows
      // overlap the next one, so a strict player would show two lines at once.
      // Clamp each end to the next cue's start. Manual tracks don't overlap, so
      // this leaves them untouched. (cues is start-sorted; the next array item is
      // the right boundary even if it was skipped above for an empty body.)
      const next = cues[i + 1];
      if (next && next.start > c.start && end > next.start) end = next.start;
      out.push(String(n), srtTime(c.start) + " --> " + srtTime(end), body, "");
    }
    return { text: out.join("\n"), count: n };
  }

  function videoTitle() {
    const el = document.querySelector(
      "h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string"
    );
    if (el && el.textContent.trim()) return el.textContent.trim();
    return (document.title || "").replace(/\s*-\s*YouTube\s*$/i, "").trim();
  }

  function srtFilename(variant) {
    const vid = cueVideoId || currentVideoId || "";
    let title = videoTitle() || vid || "youtube";
    title = title.replace(/[\\/:*?"<>|\n\r\t]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
    const tag = variant === "orig" ? "orig"
              : variant === "trans" ? settings.targetLang
              : settings.targetLang + "+orig";
    return title + (vid ? " [" + vid + "]" : "") + "." + tag + ".srt";
  }

  function triggerDownload(text, filename) {
    try {
      // Prepend a BOM so editors/players detect UTF-8 (matters for CJK text).
      const blob = new Blob(["\ufeff" + text], { type: "application/x-subrip;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(url); a.remove(); } catch (_e) { /* ignore */ } }, 2000);
      return true;
    } catch (_e) {
      return false;
    }
  }

  // When orig/tlang counts differ, match by timestamp at most once per translated
  // cue. Duplicating one translation across two original lines is misleading.
  function fillTransByTimestamp(cues, tcues) {
    if (!tcues || !tcues.length) return;
    const used = new Set();
    for (const c of cues) {
      if (!stripSoundDescriptions(c.text).trim()) continue;
      let bestIndex = -1, bd = Infinity;
      for (let i = 0; i < tcues.length; i++) {
        if (used.has(i)) continue;
        const tc = tcues[i];
        const d = Math.abs(tc.start - c.start);
        if (d < bd) { bd = d; bestIndex = i; }
      }
      if (bestIndex >= 0 && bd <= 1200 && tcues[bestIndex].text) {
        c.trans = tcues[bestIndex].text;
        used.add(bestIndex);
      }
    }
  }

  // Main export entry. Returns a serializable result for the popup:
  //   { ok:true, count, variant } | { ok:false, reason:"nocues"|"notrans"|"partial" }
  async function handleExport(variant) {
    const v = (variant === "orig" || variant === "trans") ? variant : "bi";

    // ORIGINAL: the live cue list already holds the full original track.
    if (v === "orig") {
      if (!cueList || !cueList.length) return { ok: false, reason: "nocues" };
      const built = buildSrt(cueList, "orig");
      if (!built.count) return { ok: false, reason: "nocues" };
      return triggerDownload(built.text, srtFilename("orig"))
        ? { ok: true, count: built.count, variant: "orig" }
        : { ok: false, reason: "nocues" };
    }

    // TRANSLATION / BILINGUAL.
    let cues = null;
    // Fast path: the live overlay already has a fully-aligned tlang translation.
    if (cueAligned === true && cueList && cueList.length && cueList.some((c) => c.trans)) {
      cues = cueList;
    } else {
      // Fetch a complete paired set from inject (works in any backend mode).
      const data = await requestExportData(settings.targetLang);
      if (data && data.ok && Array.isArray(data.cues) && data.cues.length) {
        cues = data.cues.slice().sort((a, b) => a.start - b.start);
        computeCueEnds(cues);
        if (data.aligned === false && Array.isArray(data.tcues)) {
          fillTransByTimestamp(cues, data.tcues.slice().sort((a, b) => a.start - b.start));
        }
      } else if (cueList && cueList.length) {
        cues = cueList;                 // at least try whatever the overlay holds
      }
    }

    if (!cues || !cues.length) return { ok: false, reason: "nocues" };
    if (!cues.some((c) => c.trans)) return { ok: false, reason: "notrans" };
    const missing = cues.filter((c) =>
      stripSoundDescriptions(c.text).trim() && !(c.trans || "").trim()).length;
    if (missing) return { ok: false, reason: "partial", missing };

    const built = buildSrt(cues, v);
    if (!built.count) return { ok: false, reason: "notrans" };
    return triggerDownload(built.text, srtFilename(v))
      ? { ok: true, count: built.count, variant: v }
      : { ok: false, reason: "notrans" };
  }

  // =========================================================================
  // BRIDGE <- inject.js
  // =========================================================================
  function onInjectMessage(evt) {
    if (evt.source !== window) return;
    const d = evt.data;
    if (!d || d.source !== "ytds-inject") return;
    // Export replies are handled even when the overlay is disabled (they are a
    // direct response to a user-initiated download, not the live cue stream).
    if (d.type === "exportdata") { resolveExportData(d); return; }
    if (!settings.enabled) return;

    if (d.type === "cues") onCues(d);
    else if (d.type === "nocues") onNoCues(d);
  }

  function sendConfig() {
    try {
      const nonce = ++configNonce;
      window.postMessage({
        source: "ytds-content",
        type: "config",
        targetLang: settings.targetLang,
        useTlang: settings.backend !== "gtx",
        useWordTiming: !!settings.karaoke,
        nonce
      }, "*");
    } catch (_e) { /* ignore */ }
  }

  // =========================================================================
  // STATE / TEARDOWN / SPA NAV
  // =========================================================================
  function teardownAll() {
    stopCueLoop();
    stopRepeat();                     // restore the user's own playback rate
    stopFallback();
    removeOverlay();
    cueList = null;
    displayCueList = null;
    tcueList = null;
    cueAligned = null;
    cueVideoId = "";
    cueSourceLang = "auto";
    translationPending = false;
    pendingSince = 0;
    fastPreviewIdx = -1;
    repeatDoneIdx = -1;
    gtxCooldownUntil = 0;
    gtxBackoffStep = 0;
    activeCueIdx = -1;
    nocuesFallback = false;
    clearHoverReveal();
    transInflight.clear();
    transRetryAt.clear();
    cueEpoch++;                       // invalidate any in-flight gtx callbacks
  }

  function applyStateToDom(requestCues = true) {
    ensureToggleButton(10);            // keep the control-bar toggle present + in sync
    document.documentElement?.classList.toggle("ytds-active", !!settings.enabled);
    if (!settings.enabled) {
      teardownAll();
    } else {
      // Native captions bridge startup immediately; cue mode takes over once ready.
      ensureOverlay();
      if (!cueTimer) startFallback();
      if (requestCues) sendConfig();
    }
  }

  function onNav() {
    const staleNative = videoIdFromLocation() !== currentVideoId ? readNativeCaption(false) : "";
    currentVideoId = videoIdFromLocation();
    transCache.clear();
    weEnabledCC = false;        // fresh video — re-evaluate caption state
    teardownAll();
    ensureToggleButton(10);     // control-bar toggle persists across videos
    if (settings.enabled) {
      ensureOverlay();
      restoreCachedCues();      // already watched: paint immediately, then refresh
      if (!cueTimer) {
        nativeSkipText = staleNative || null;
        startFallback();
      }
      sendConfig();             // ask inject.js for cues on the new video
      syncCaptions();           // auto-turn on YouTube CC so subs actually show
    }
  }

  // A seek, a video change or a tab switch can leave the overlay showing the
  // line from before the jump. Those events do not bubble, but a capture-phase
  // listener on window still sees them; the tick itself is skipped while paused
  // unless cueDirty is set here.
  function onPlaybackJump(event) {
    if (pollTimer && (event?.type === "seeking" || event?.type === "seeked")) {
      lastReqToken++;
      fallbackInflight = null;
      fallbackRetryAt = 0;
      fallbackTranslation = "";
      setTranslation("", "");
    }
    cueDirty = true;
    cueTick();
    if (pollTimer) fallbackTick();
  }

  // single listener instances (added once; never accumulate)
  window.addEventListener("yt-navigate-finish", onNav, true);
  window.addEventListener("message", onInjectMessage, false);
  window.addEventListener("seeked", onPlaybackJump, true);
  window.addEventListener("seeking", onPlaybackJump, true);
  window.addEventListener("play", onPlaybackJump, true);
  window.addEventListener("playing", onPlaybackJump, true);
  window.addEventListener("loadedmetadata", onPlaybackJump, true);
  window.addEventListener("visibilitychange", onPlaybackJump, true);
  window.addEventListener("pointermove", onPointerMove, true);
  window.addEventListener("pointerout", onWindowPointerOut, true);
  window.addEventListener("resize", scheduleOverlayLayout, true);
  window.addEventListener("fullscreenchange", scheduleOverlayLayout, true);

  // ---- boot ----------------------------------------------------------------
  loadSettings().then(() => {
    // document_start can precede both <html> and the player. Start as soon as
    // the player exists, without waiting for the rest of YouTube to parse.
    let observer;
    const boot = () => {
      if (!extAlive()) { observer?.disconnect(); return; }
      if (!document.documentElement || (settings.enabled && !getPlayer())) return;
      observer?.disconnect();
      applyStateToDom();
      syncCaptions();
    };
    if (!document.documentElement || (settings.enabled && !getPlayer())) {
      observer = new MutationObserver(boot);
      observer.observe(document, { childList: true, subtree: true });
    }
    boot();
  });
})();
