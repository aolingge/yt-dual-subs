// ============================================================================
// YT Dual Subs — platform adapter (isolated world).
//
// content.js owns everything that is the same on both sites: the overlay, the
// subtitle styles, playback sync, the study tools, the translation queue and
// the settings model. This file owns everything that is NOT: how you identify
// the current video (and part), where the player and the actually-playing
// <video> are, which container the overlay hangs off, where the native caption
// text can be read, how the native caption switch behaves, how the site tells
// us it navigated, and which settings are per-site.
//
// The YouTube branch below is the module's original behaviour, moved verbatim.
// The Bilibili branch is a parallel path built on the bpx-player class names
// verified in the player bundle — no YouTube selector, player object or button
// class is reused for Bilibili, and no bpx class is reused for YouTube.
//
// The Bilibili MAIN-world reader (bilibili-page.js) cannot see this file: it
// runs in the page's own world. It re-derives the video key from the URL with
// the same rule, which is why the key must stay purely URL-derived and must
// never depend on page-only globals such as __INITIAL_STATE__.
// ============================================================================
(function () {
  if (globalThis.YtdsSite) return;

  const host = location.hostname.replace(/^www\./, "");
  const platform = /(^|\.)bilibili\.com$/.test(host) ? "bilibili" : "youtube";
  const isBilibili = platform === "bilibili";

  // --------------------------------------------------------------------------
  // per-site settings
  // --------------------------------------------------------------------------
  // Bilibili keeps its OWN target language and line order, so switching a
  // Bilibili video to German can never rewrite the user's YouTube choice.
  // YouTube keeps the original key names: an existing installation is read
  // as-is, so no migration and no settings reset.
  //
  // These two tables are keyed by platform rather than closed over the current
  // one, because the popup runs on the extension origin — where this file's own
  // host detection says nothing about the tab being looked at — and still has to
  // read and write the settings of the right site.
  const SITE_KEY_ALIAS = { bilibili: { targetLang: "bbTargetLang", order: "bbOrder" } };
  const SITE_OVERRIDES = { bilibili: { targetLang: "de", order: "trans-top" } };

  function aliasFor(p) { return SITE_KEY_ALIAS[p] || {}; }
  function unaliasFor(p) {
    const out = {};
    const alias = aliasFor(p);
    for (const logical of Object.keys(alias)) out[alias[logical]] = logical;
    return out;
  }

  function storageKeyFor(p, logical) { return aliasFor(p)[logical] || logical; }

  function toStoreFor(p, patch) {
    const out = {};
    for (const key of Object.keys(patch || {})) out[storageKeyFor(p, key)] = patch[key];
    return out;
  }

  // Record coming out of storage (or the popup) -> logical settings. A key this
  // platform shadows is dropped, so YouTube's stored target language cannot
  // leak in as Bilibili's, and vice versa.
  function fromStoreFor(p, record) {
    const out = { ...(record || {}) };
    const alias = aliasFor(p);
    for (const logical of Object.keys(alias)) {
      const store = alias[logical];
      if (store in out) out[logical] = out[store];
      else delete out[logical];
      delete out[store];
    }
    return out;
  }

  // storage.onChanged gives storage keys. Translate them to logical names and
  // drop changes that belong to the other platform's shadowed keys.
  function logicalChangesFor(p, changes) {
    const out = {};
    const unalias = unaliasFor(p);
    const alias = aliasFor(p);
    for (const key of Object.keys(changes || {})) {
      if (unalias[key]) { out[unalias[key]] = changes[key]; continue; }
      if (alias[key]) continue;         // belongs to the other site
      out[key] = changes[key];
    }
    return out;
  }

  const ALIAS = aliasFor(platform);
  const SITE_DEFAULTS = SITE_OVERRIDES[platform] || {};
  const storageKey = (logical) => storageKeyFor(platform, logical);
  const toStore = (patch) => toStoreFor(platform, patch);
  const fromStore = (record) => fromStoreFor(platform, record);
  const logicalChanges = (changes) => logicalChangesFor(platform, changes);

  // --------------------------------------------------------------------------
  // video identity (must include the part)
  // --------------------------------------------------------------------------
  // Bilibili: /video/<BV...>/?p=N. The 1-based part number is part of the
  // identity, because two parts of one BV are different videos with different
  // captions and must never share a cue or translation cache entry.
  function bilibiliVideoKey() {
    let path = "";
    let search = "";
    try {
      path = location.pathname || "";
      search = location.search || "";
    } catch (_e) { return ""; }
    const m = path.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    if (!m) return "";
    let p = 1;
    try { p = parseInt(new URLSearchParams(search).get("p"), 10) || 1; } catch (_e) { p = 1; }
    return m[1] + "#p" + p;
  }

  function youtubeVideoKey() {
    try {
      return new URL(location.href).searchParams.get("v") || "";
    } catch (_e) {
      return "";
    }
  }

  // --------------------------------------------------------------------------
  // player / video element / overlay host
  // --------------------------------------------------------------------------
  let cachedVideo = null;

  function bilibiliPlayer() {
    return document.querySelector("#bilibili-player") ||
           document.querySelector(".bpx-player-container") ||
           document.querySelector("#playerWrap");
  }

  function pickVideo(list) {
    let best = null;
    for (const v of list) {
      if (!v) continue;
      if (!best) { best = v; continue; }
      // Prefer the element that is actually playing / holds a real source.
      const score = (x) => (!x.paused ? 4 : 0) + (x.currentTime > 0 ? 2 : 0) +
        (x.readyState >= 2 ? 1 : 0);
      if (score(v) > score(best)) best = v;
    }
    return best;
  }

  function bilibiliVideo() {
    if (cachedVideo && cachedVideo.isConnected && cachedVideo.readyState >= 2) {
      return cachedVideo;
    }
    const player = bilibiliPlayer();
    const scope = player || document;
    const list = Array.from(scope.querySelectorAll("video"));
    cachedVideo = list.length === 1 ? list[0] : (pickVideo(list) || null);
    return cachedVideo;
  }

  const API = {
    platform,
    isBilibili,
    // YouTube serves a translated caption track (tlang). Bilibili has no such
    // endpoint: its translation always comes from the extension's own
    // translation queue, so "wait for the site's translation" is never a valid
    // state there and the wait must not be entered at all.
    supportsTlang: !isBilibili,
    // Whether clicking the site's own caption button is a plain on/off toggle.
    // On Bilibili the "字幕" control opens a settings panel instead, and the
    // reader never needs the native layer, so that button is left untouched —
    // clicking it would drop a panel over the player.
    autoEnableNativeCaptions: !isBilibili,

    siteDefaults: () => SITE_DEFAULTS,
    toStore,
    fromStore,
    logicalChanges,
    storageKey,

    videoKey() {
      return isBilibili ? bilibiliVideoKey() : youtubeVideoKey();
    },

    getVideo() {
      if (isBilibili) return bilibiliVideo();
      const player = this.getPlayer();
      return (player && player.querySelector("video")) ||
             document.querySelector("video.html5-main-video") ||
             document.querySelector("video");
    },

    getPlayer() {
      if (isBilibili) {
        return bilibiliPlayer() ||
               (cachedVideo && cachedVideo.closest(".bpx-player-container")) || null;
      }
      return document.querySelector("#movie_player") ||
             document.querySelector(".html5-video-player");
    },

    // The overlay is absolutely positioned inside this element, so it must be
    // the video box itself — not a page-level wrapper that also contains the
    // send-danmaku bar and the player's surrounding chrome.
    overlayHost(player) {
      if (!isBilibili) return player;
      return (player && player.querySelector(".bpx-player-video-wrap")) ||
             document.querySelector(".bpx-player-container") || player;
    },

    // Where the in-player on/off button goes. On Bilibili the control bar's
    // button group is built by a lazily loaded chunk whose class names are not
    // in the verified bundle, so appending into .bpx-player-control-wrap could
    // alter the native bar's layout and disturb the danmaku switch or the
    // progress bar. The button therefore goes into .bpx-player-container —
    // verified present, already a positioning context — and content.css places
    // it in the video's empty top-right corner.
    controlsHost(player) {
      if (!isBilibili) return player && player.querySelector(".ytp-right-controls");
      const scope = player || bilibiliPlayer();
      return (scope && scope.classList && scope.classList.contains("bpx-player-container")
        ? scope : null) ||
        document.querySelector(".bpx-player-container");
    },

    toggleButtonClass() {
      return isBilibili ? "ytds-toggle ytds-toggle-bili notranslate"
                        : "ytp-button ytds-toggle notranslate";
    },

    // Native caption text as the user sees it. Only used as a bridge/fallback;
    // cue mode never depends on the site rendering captions.
    nativeCaptionSegments() {
      if (!isBilibili) {
        return Array.from(document.querySelectorAll(".ytp-caption-segment"))
          .map((s) => s.textContent.trim()).filter(Boolean);
      }
      const wrap = document.querySelector(".bpx-player-subtitle-wrap");
      if (!wrap) return [];
      // Read the container's own text rather than guessing an inner item class:
      // the wrap holds exactly the rendered caption lines.
      const text = (wrap.innerText || wrap.textContent || "").trim();
      return text ? text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    },

    title() {
      if (!isBilibili) {
        const h = document.querySelector(
          "h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string");
        return (h && h.textContent.trim()) || document.title.replace(/ - YouTube$/, "");
      }
      const t = document.querySelector("h1.video-title") ||
                document.querySelector(".video-title") ||
                document.querySelector("h1");
      return (t && t.textContent.trim()) || document.title.replace(/[_\-|]\s*bilibili.*$/i, "");
    },

    // ---- native caption switch --------------------------------------------
    captionsButton() {
      if (!isBilibili) return document.querySelector(".ytp-subtitles-button");
      // Bilibili's CC button lives inside the control bar's right group. We
      // locate it by its stable aria/title text instead of a class name we
      // could not verify, and fall back to null when it is not present.
      const scope = (this.getPlayer && this.getPlayer()) || document;
      const buttons = scope.querySelectorAll("button, .bpx-player-ctrl-btn");
      for (const b of buttons) {
        const label = ((b.getAttribute && (b.getAttribute("aria-label") ||
          b.getAttribute("title"))) || "").toLowerCase();
        if (!label) continue;
        if (/字幕|subtitle|caption/.test(label)) return b;
      }
      return null;
    },

    captionsAvailable(btn) {
      if (!btn) return false;
      if (!isBilibili) {
        return btn.getAttribute("aria-pressed") !== null &&
               btn.getAttribute("aria-disabled") !== "true";
      }
      return !btn.disabled;
    },

    captionsOn(btn) {
      if (!btn) return false;
      if (!isBilibili) return btn.getAttribute("aria-pressed") === "true";
      const on = ((btn.getAttribute("aria-label") || "") + " " +
        (btn.className || "")).toLowerCase();
      // --shown / "关闭字幕" style labels mean captions are currently ON.
      if (/已开启|关闭字幕|shown|active/.test(on)) return true;
      if (/已关闭|开启字幕/.test(on)) return false;
      return btn.getAttribute("aria-pressed") === "true";
    },

    clickCaptions(btn) {
      if (btn && typeof btn.click === "function") btn.click();
    },

    // Height of the native control bar inside the player, used to keep the
    // subtitles clear of it even while the bar is faded out.
    playerBottomInset(player, rect) {
      const selector = isBilibili ? ".bpx-player-control-wrap" : ".ytp-chrome-bottom";
      const controls = player && player.querySelector(selector);
      const controlsRect = controls && controls.getBoundingClientRect
        ? controls.getBoundingClientRect() : null;
      const measured = controlsRect && controlsRect.height > 0 &&
        controlsRect.top >= rect.top && controlsRect.top < rect.bottom
        ? rect.bottom - controlsRect.top + 12 : 0;
      return Math.min(rect.height * 0.35, Math.max(48, rect.height * 0.08, measured));
    },

    // ---- navigation --------------------------------------------------------
    // YouTube announces SPA navigation. Bilibili's router rewrites the URL (and
    // can also swap the player) without such an event, and a content script
    // cannot intercept the page's own pushState calls, so we combine a cheap
    // URL-string comparison with the events that always accompany a real switch.
    onNavigate(callback) {
      if (!isBilibili) {
        window.addEventListener("yt-navigate-finish", callback, true);
        return;
      }
      let last = bilibiliVideoKey();
      const check = () => {
        const now = bilibiliVideoKey();
        if (now === last) return;
        last = now;
        callback();
      };
      window.addEventListener("popstate", check, true);
      // A part switch always starts a fresh media load; the URL may already be
      // updated by then, so this is the earliest reliable signal.
      document.addEventListener("loadedmetadata", check, true);
      setInterval(check, 1000);      // string compare only — no DOM scanning
    }
  };

  globalThis.YtdsSite = API;

  // The popup lives on the extension origin, where the detection above always
  // answers "youtube" (the host is the extension id). It still has to read and
  // write the settings of the tab the user is looking at, so it asks for the
  // same adapter by platform instead. Only the settings half is site-specific
  // there: the popup never touches the page DOM.
  globalThis.YtdsSite.forPlatform = (p) => {
    const name = p === "bilibili" ? "bilibili" : "youtube";
    return {
      platform: name,
      isBilibili: name === "bilibili",
      supportsTlang: name !== "bilibili",
      siteDefaults: () => SITE_OVERRIDES[name] || {},
      toStore: (patch) => toStoreFor(name, patch),
      fromStore: (record) => fromStoreFor(name, record),
      logicalChanges: (changes) => logicalChangesFor(name, changes),
      storageKey: (logical) => storageKeyFor(name, logical)
    };
  };
  // Which platform a tab URL belongs to (the popup's only source of truth).
  globalThis.YtdsSite.platformOfUrl = (url) => {
    try {
      const host = new URL(String(url || "")).hostname.replace(/^www\./, "");
      return /(^|\.)bilibili\.com$/.test(host) ? "bilibili" : "youtube";
    } catch (_e) { return "youtube"; }
  };
})();
