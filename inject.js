// inject.js — MAIN world, document_start.
// Hooks XMLHttpRequest + fetch to capture the YouTube player's OWN
// /api/timedtext request URL (which carries a valid "pot"), then reuses that
// exact URL to fetch json3 cues — and, optionally, a tlang-aligned translation.
//
// NEVER throw into the page: every hook body is wrapped in try/catch.
(() => {
  "use strict";

  // ---- guard against double injection -------------------------------------
  if (window.__ytdsInjected) return;
  window.__ytdsInjected = true;

  const TIMEDTEXT_MARK = "/api/timedtext";
  // Use the unhooked page fetch for our requests. Otherwise a speculative
  // request is mistaken for the player's capture and can recurse or fail over.
  const pageFetch = window.fetch.bind(window);
  const extensionFetchUrls = new Set();
  const ORIGINAL_TIMEOUT_MS = 8000;
  const TRANSLATION_TIMEOUT_MS = 5000;
  const MAX_MESSAGE_CHARS = 4 * 1024 * 1024;
  const MAX_TIMEDTEXT_BODY_CHARS = 4 * 1024 * 1024;
  const ALLOWED_YOUTUBE_HOST_RE = /(^|\.)youtube\.com$/i;
  const timingTrackCache = new Map(); // bounded, document memory only
  const SOURCE_RETRY_MS = [750, 2000, 5000];
  let sourceRetryTimer = null;
  let sourceRetryStep = 0;
  let originalCache = null; // current track only; never persisted
  let originalRequest = null; // share duplicate config requests for the same URL
  const originalWaiters = new Set();
  const translationTracks = new Map(); // pending/successful current-video tracks
  let translationCooldownUntil = 0; // endpoint limit survives config/token changes
  let produceSeq = 0;

  // Most recently seen timedtext URL of any kind.
  let lastTimedtextUrl = "";
  // The player's ORIGINAL-track fetch: a timedtext URL WITHOUT a "tlang" param.
  // This is the only URL whose "pot" we may reuse.
  let sourceUrl = "";
  // The videoId that sourceUrl was captured for. produceCues bails if this no
  // longer matches the current location video, so a stale (previous-video) URL
  // can never be fetched and posted under the new videoId.
  let sourceVid = "";
  // Identity of the captured source track, IGNORING fmt/tlang. Used so our own
  // json3 re-fetches (and pot rotations on the same track) are not mistaken for
  // a brand-new source — which would otherwise re-trigger produceCues in a loop.
  let sourceKey = "";

  let currentVideoId = videoIdFromLocation();

  // True while sourceUrl came from our own early guess rather than from the
  // player's fetch. A guess may be stale/unsigned, so its failure must never
  // switch content.js to scrape mode — we just drop it and wait for the real
  // request (see produceCues).
  let sourceSpeculative = false;
  let seedTimer = null;

  // pending config from content.js (set once popup config arrives)
  let cfg = null;            // { targetLang, useTlang, useWordTiming }
  let nocuesTimer = null;    // fires if no timedtext URL shows up
  let producedForUrl = "";   // dedupe: last sourceUrl we produced cues for
  // Monotonic request token echoed back to content.js so it can drop any
  // 'cues'/'nocues' that does not correspond to its latest sendConfig().
  let reqNonce = 0;
  let sessionToken = "";

  // ---- helpers -------------------------------------------------------------
  function videoIdFromLocation() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("v") || "";
    } catch (_e) {
      return "";
    }
  }

  // tlang code map: YouTube uses zh-Hans / zh-Hant for translation targets.
  function mapTlang(code) {
    if (code === "zh-CN") return "zh-Hans";
    if (code === "zh-TW") return "zh-Hant";
    return code;
  }

  function hasTlang(url) {
    try {
      return new URL(url, location.href).searchParams.has("tlang");
    } catch (_e) {
      return /[?&]tlang=/.test(url);
    }
  }

  function isTimedtext(url) {
    if (typeof url !== "string" || !url) return false;
    try {
      const u = new URL(url, location.href);
      return u.protocol === "https:" && ALLOWED_YOUTUBE_HOST_RE.test(u.hostname || "") &&
        u.pathname === TIMEDTEXT_MARK;
    } catch (_e) { return false; }
  }

  // Track identity ignoring the params that rotate or that WE vary. "pot" (the
  // proof-of-origin token) is rotated by the player periodically for the SAME
  // track — if we kept it in the key, each rotation would look like a brand-new
  // source and re-trigger produceCues, causing the overlay to flicker. So strip
  // pot/fmt/tlang; what remains (v, lang, kind, ...) is the stable track id.
  function normKey(url) {
    try {
      const u = new URL(url, location.href);
      u.searchParams.delete("fmt");
      u.searchParams.delete("tlang");
      u.searchParams.delete("pot");
      return u.toString();
    } catch (_e) {
      return url;
    }
  }

  // Parse the "v" param off a captured timedtext URL when present; otherwise
  // fall back to the current location video id.
  function vidOfUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.searchParams.get("v") || videoIdFromLocation();
    } catch (_e) {
      return videoIdFromLocation();
    }
  }

  function langOfUrl(url) {
    try {
      return new URL(url, location.href).searchParams.get("lang") || "auto";
    } catch (_e) {
      return "auto";
    }
  }

  // Build a fetch URL from the captured source URL: preserve every param
  // (including pot + signature), force fmt=json3, drop any stray tlang.
  function buildUrl(base, tlangTarget) {
    const u = new URL(base, location.href);
    u.searchParams.delete("tlang");
    u.searchParams.set("fmt", "json3");
    if (tlangTarget) u.searchParams.set("tlang", tlangTarget);
    return u.toString();
  }

  // Parse json3 into cue objects. Robust against missing/empty segs.
  // Preserves json3 EVENT ORDER (do not sort here): the orig and tlang
  // responses are aligned cue-for-cue by event order, so the i-th surviving
  // event of the orig response corresponds to the i-th of the tlang response.
  function parseJson3(json) {
    const cues = [];
    if (!json || !Array.isArray(json.events)) return cues;
    for (const ev of json.events) {
      if (!ev || !Array.isArray(ev.segs)) continue;
      let text = "";
      let words = null;
      let prefix = "";
      for (const s of ev.segs) {
        if (!s || typeof s.utf8 !== "string") continue;
        text += s.utf8;
        // A first segment may omit its zero offset. Keep it at the event start
        // if later segments provide offsets; do not lose the first spoken word.
        const off = typeof s.tOffsetMs === "number" ? s.tOffsetMs : null;
        if (off === null || !isFinite(off)) {
          if (words && words.length) words[words.length - 1].u += s.utf8;
          else prefix += s.utf8;
          continue;
        }
        if (!words) {
          words = [];
          if (prefix.trim()) words.push({ t: ev.tStartMs || 0, u: prefix });
        }
        words.push({
          t: (typeof ev.tStartMs === "number" ? ev.tStartMs : 0) + off,
          u: s.utf8
        });
      }
      text = text.replace(/\s+/g, " ").trim();
      if (!text) continue;          // skip style/window/blank events
      const start = typeof ev.tStartMs === "number" ? ev.tStartMs : 0;
      const dur = typeof ev.dDurationMs === "number" ? ev.dDurationMs : 0;
      const cue = { start, dur, text };
      if (words) cue.words = words;
      cues.push(cue);
    }
    return cues;
  }

  // page-context fetch — same-origin youtube.com so pot/signature stay valid.
  async function fetchJson3(url, timeoutMs = ORIGINAL_TIMEOUT_MS,
    controller = typeof AbortController === "function" ? new AbortController() : null) {
    extensionFetchUrls.add(url);
    if (extensionFetchUrls.size > 50) extensionFetchUrls.delete(extensionFetchUrls.values().next().value);
    let timer;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new Error("timedtext timeout"));
      }, timeoutMs);
    });
    const request = (async () => {
      const res = await pageFetch(url, { method: "GET", credentials: "include",
        signal: controller ? controller.signal : undefined });
      if (!res.ok) throw new Error("timedtext http " + res.status);
      const length = Number(res.headers && typeof res.headers.get === "function"
        ? res.headers.get("content-length") : 0);
      if (length > MAX_TIMEDTEXT_BODY_CHARS) throw new Error("timedtext body too large");
      const txt = await res.text();
      if (!txt) throw new Error("timedtext empty body");
      if (txt.length > MAX_TIMEDTEXT_BODY_CHARS) throw new Error("timedtext body too large");
      return parseCaptionBody(txt);
    })();
    try { return await Promise.race([request, deadline]); }
    finally { clearTimeout(timer); }
  }

  // ---- bridge to content.js ------------------------------------------------
  function post(type, extra) {
    try {
      const payload = Object.assign(
        { source: "ytds-inject", type, videoId: currentVideoId, nonce: reqNonce },
        extra || {}
      );
      if (sessionToken) payload.sessionToken = sessionToken;
      if (JSON.stringify(payload).length > MAX_MESSAGE_CHARS) return;
      window.postMessage(payload, "*");
    } catch (_e) { /* never throw */ }
  }

  function clearNocuesTimer() {
    if (nocuesTimer) { clearTimeout(nocuesTimer); nocuesTimer = null; }
  }

  function clearSourceRetry() {
    if (sourceRetryTimer) { clearTimeout(sourceRetryTimer); sourceRetryTimer = null; }
  }

  function scheduleSourceRetry(error) {
    if (!cfg || sourceRetryTimer || sourceRetryStep >= SOURCE_RETRY_MS.length) return;
    const vid = currentVideoId, key = sourceKey, nonce = reqNonce;
    const delay = /\b429\b/.test(String(error)) ? 20000 : SOURCE_RETRY_MS[sourceRetryStep];
    sourceRetryStep++;
    const timer = setTimeout(() => {
      if (sourceRetryTimer !== timer) return;
      sourceRetryTimer = null;
      if (vid !== currentVideoId || nonce !== reqNonce || key !== sourceKey) return;
      if (sourceUrl && sourceVid === currentVideoId) produceCues(true);
      else { seedSourceSoon(); armNocuesTimer(); }
    }, delay);
    sourceRetryTimer = timer;
  }

  // Observe a successful player response without consuming its body. Native
  // XML and JSON3 captions feed the same parser and retain their word times.
  function parseCaptionBody(body) {
      let json = body;
      if (typeof body === "string") {
        if (body.trim().startsWith("<") && typeof DOMParser === "function") {
          const doc = new DOMParser().parseFromString(body, "text/xml");
          if (doc.querySelector("parsererror")) return;
          json = { events: [...doc.querySelectorAll("p[t], text[start]")].map((p) => {
            const legacy = p.tagName === "text";
            const start = Number(p.getAttribute(legacy ? "start" : "t")) * (legacy ? 1000 : 1);
            const dur = Number(p.getAttribute(legacy ? "dur" : "d")) * (legacy ? 1000 : 1);
            const words = [...p.querySelectorAll("s")];
            return { tStartMs: start, dDurationMs: dur,
              segs: words.length ? words.map((s) => ({ utf8: s.textContent,
                ...(s.hasAttribute("t") ? { tOffsetMs: Number(s.getAttribute("t")) } : {}) }))
                : [{ utf8: p.textContent }] };
          }) };
        } else json = JSON.parse(body);
      }
      return json;
  }

  function captureOriginalBody(url, body) {
    try {
      if (!isTimedtext(url) || hasTlang(url) || vidOfUrl(url) !== currentVideoId ||
          normKey(url) !== sourceKey) return;
      const json = parseCaptionBody(body);
      if (!parseJson3(json).length) return;
      const alreadyLoaded = originalCache?.key === sourceKey;
      originalCache = { key: sourceKey, videoId: currentVideoId, json };
      clearSourceRetry();
      let waiting = false;
      for (const waiter of originalWaiters) {
        if (waiter.key === sourceKey && waiter.videoId === currentVideoId) {
          waiting = true;
          waiter.resolve(json);
        }
      }
      if (cfg && !waiting && !alreadyLoaded) produceCues(true);
    } catch (_e) { /* failed copies must never affect the player */ }
  }

  function fetchOriginalJson(url) {
    const key = normKey(url), videoId = vidOfUrl(url);
    if (originalCache?.key === key && originalCache.videoId === videoId) return Promise.resolve(originalCache.json);
    const fetchUrl = buildUrl(url, null);
    if (originalRequest?.url === fetchUrl && originalRequest.videoId === videoId) return originalRequest.promise;
    let waiter;
    const captured = new Promise(resolve => {
      waiter = { key, videoId, resolve };
      originalWaiters.add(waiter);
    });
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const request = { url: fetchUrl, videoId };
    originalRequest = request;
    request.promise = Promise.race([captured,
      fetchJson3(fetchUrl, ORIGINAL_TIMEOUT_MS, controller).catch(error => {
        // Some native signed requests work only in their original format.
        // Retry exactly the observed URL once, without logging its signature.
        if (!sourceSpeculative && fetchUrl !== url && /empty body/.test(String(error)) &&
            videoId === currentVideoId && key === sourceKey) {
          return fetchJson3(url, ORIGINAL_TIMEOUT_MS, controller);
        }
        throw error;
      })]).finally(() => {
      originalWaiters.delete(waiter);
      controller?.abort(); // a captured body makes the duplicate unnecessary
      if (originalRequest === request) originalRequest = null;
    });
    return request.promise;
  }

  function translationTrack(url, targetLang) {
    const key = normKey(url) + " " + targetLang;
    if (translationTracks.has(key)) return translationTracks.get(key);
    if (Date.now() < translationCooldownUntil) return Promise.resolve(null);
    const request = fetchJson3(buildUrl(url, targetLang), TRANSLATION_TIMEOUT_MS)
      .then(parseJson3).catch((error) => {
        if (/\b429\b/.test(String(error))) translationCooldownUntil = Date.now() + 20000;
        return null;
      }).then((cues) => {
        if (!cues?.length && translationTracks.get(key) === request) translationTracks.delete(key);
        return cues;
      });
    translationTracks.set(key, request);
    while (translationTracks.size > 4) translationTracks.delete(translationTracks.keys().next().value);
    return request;
  }

  // Produce cues (+ optional aligned translation) from the captured source URL.
  async function produceCues(force) {
    if (!cfg || !sourceUrl) return;
    // The captured source URL must belong to the CURRENT video. Without this,
    // a config round-trip on SPA nav could refetch the previous video's URL and
    // post it stamped with the new videoId.
    if (sourceVid !== currentVideoId) return;
    if (!force && producedForUrl === sourceUrl) return;
    producedForUrl = sourceUrl;
    const run = ++produceSeq;
    clearNocuesTimer();
    clearSourceRetry();

    const vid = currentVideoId;
    const trackKey = sourceKey;
    const sourceLang = langOfUrl(sourceUrl);
    const baseUrl = sourceUrl;
    const speculative = sourceSpeculative;
    const isCurrent = () => run === produceSeq && vid === currentVideoId &&
      sourceVid === currentVideoId && trackKey === sourceKey && myNonce === reqNonce;
    // Capture the nonce NOW, at produce start. post() must stamp the reply with
    // THIS nonce, not the live global reqNonce at send-time: otherwise two
    // produces running concurrently (e.g. boot + yt-navigate-finish both send
    // config) would both be stamped with the latest nonce and both accepted by
    // content.js -> double cue-loop restart -> startup flicker.
    const myNonce = reqNonce;
    try {
      // Start the optional translation alongside the original request. The
      // original can be rendered as soon as it arrives; it need not wait for
      // YouTube to finish translating the whole track.
      const translationPromise = cfg.useTlang
        ? translationTrack(baseUrl, mapTlang(cfg.targetLang))
        : null;
      const origJson = await fetchOriginalJson(baseUrl);
      const cues = parseJson3(origJson);

      // ignore if we navigated away mid-fetch (or the source no longer matches)
      if (!isCurrent()) return;

      if (!cues.length) {
        producedForUrl = "";        // allow a retry if the track later yields cues
        if (speculative) {
          // Our guess was stale/unsigned. Drop it quietly and wait for the
          // player's own capture: posting "nocues" here would wrongly switch
          // content.js to scrape mode.
          sourceUrl = "";
          sourceVid = "";
          sourceKey = "";
          sourceSpeculative = false;
          armNocuesTimer();
          scheduleSourceRetry();
          return;
        }
        post("nocues", { nonce: myNonce, sourceLang });
        scheduleSourceRetry();
        return;
      }

      originalCache = { key: trackKey, videoId: vid, json: origJson };
      sourceRetryStep = 0;
      clearSourceRetry();

      if (translationPromise) {
        post("cues", { cues, tcues: null, aligned: null,
          translationPending: true, sourceLang, nonce: myNonce });
      } else {
        post("cues", { cues, tcues: null, aligned: null, sourceLang, nonce: myNonce });
      }

      let tcues = null;
      let aligned = null;
      let translationComplete = !translationPromise;
      // Optional word timing must not hold up the original or its translation.
      // A later update upgrades the same text without switching the user's CC.
      if (cfg.useWordTiming && cfg.useAutoMatch !== false && window.YtdsWordTiming) {
        const donorUrl = automaticTimingUrl(sourceLang, baseUrl);
        if (donorUrl && cues.some((c) => !window.YtdsWordTiming.captionPieces(c, sourceLang))) {
          timingTrack(donorUrl).then((donor) => {
            if (!isCurrent() || !cfg.useWordTiming) return;
            if (!window.YtdsWordTiming.align(cues, donor, sourceLang)) return;
            post("cues", { cues, tcues, aligned, sourceLang, nonce: myNonce,
              translationUpdate: true, wordTimingUpdate: true,
              translationPending: !translationComplete });
          }).catch(() => {});
        }
      }

      if (!translationPromise) return;
      tcues = await translationPromise;
      if (!isCurrent()) return;
      translationComplete = true;

      // Pair by event order before sorting, but reject outliers with a very
      // different timestamp. Equal event counts alone do not prove alignment.
      // Rejected fragments use the complete-sentence fallback in content.js.
      aligned = tcues ? (cues.length === tcues.length) : null;
      if (tcues && aligned) {
        for (let i = 0; i < cues.length; i++) {
          cues[i].trans = Math.abs(cues[i].start - tcues[i].start) <= 1200
            ? tcues[i].text : "";
        }
      }

      post("cues", { cues, tcues, aligned,
        translationUpdate: !!translationPromise, sourceLang, nonce: myNonce });
    } catch (_e) {
      // could not fetch/parse — let content.js fall back to scraping, but only
      // if we are still on the same video the fetch was started for.
      if (!isCurrent()) return;
      producedForUrl = "";          // allow a retry on next capture
      if (speculative) {
        sourceUrl = "";
        sourceVid = "";
        sourceKey = "";
        sourceSpeculative = false;
        armNocuesTimer();
        scheduleSourceRetry(_e);
        return;                     // the real capture will arrive shortly
      }
      post("nocues", { nonce: myNonce, sourceLang });
      scheduleSourceRetry(_e);
    }
  }

  // Produce a COMPLETE bilingual cue set for SRT export, on demand. Unlike
  // produceCues (which drives the live overlay and honours the user's backend
  // choice), this ALWAYS fetches the whole-track tlang translation by reusing
  // the captured pot-bearing source URL — so a full translation is available for
  // download even when the live overlay is running in gtx (per-sentence) mode.
  // Orig+tlang are paired by EVENT ORDER here, before content.js sorts, so the
  // translation can never desync from the original. Posts an "exportdata" reply
  // correlated by exportId; never throws into the page.
  async function produceExport(targetLang, exportId) {
    if (!sourceUrl || sourceVid !== currentVideoId) {
      post("exportdata", { ok: false, exportId });
      return;
    }
    try {
      const origJson = await fetchOriginalJson(sourceUrl);
      const cues = parseJson3(origJson);
      if (!cues.length) { post("exportdata", { ok: false, exportId }); return; }

      let tcues = null;
      let aligned = null;
      if (targetLang) {
        try {
          const transJson = await fetchJson3(buildUrl(sourceUrl, mapTlang(targetLang)));
          tcues = parseJson3(transJson);
          aligned = cues.length === tcues.length;
          if (aligned) {
            for (let i = 0; i < cues.length; i++) {
              cues[i].trans = tcues[i] &&
                Math.abs(cues[i].start - tcues[i].start) <= 1200
                ? tcues[i].text : "";
            }
          }
        } catch (_e) {
          tcues = null; aligned = null;   // translation failed; orig still usable
        }
      }

      post("exportdata", { ok: true, cues, tcues, aligned, exportId });
    } catch (_e) {
      post("exportdata", { ok: false, exportId });
    }
  }

  // Called whenever we capture a fresh source URL.
  function onSourceCaptured() {
    if (!cfg) return;               // wait for config before fetching
    produceCues(false);
  }

  // ---- early source seeding (A/B1) -----------------------------------------
  // The player fetches its original track a second or two after playback
  // starts. When the track is already known (player tracklist / the page's
  // player response), we can build the same URL earlier and take that wait off
  // the first sentence. This is best-effort: anything unexpected leaves the
  // normal capture path untouched.
  function playerEl() {
    try {
      return document.getElementById("movie_player") ||
        document.querySelector(".html5-video-player");
    } catch (_e) {
      return null;
    }
  }

  function pushTrack(out, t) {
    if (!t) return;
    const url = t.url || t.baseUrl || "";
    if (!isTimedtext(url) || hasTlang(url)) return;
    out.push({
      url,
      languageCode: t.languageCode || "",
      vssId: t.vssId || "",
      kind: t.kind || ""
    });
  }

  function trackEntries() {
    const out = [];
    try {
      const player = playerEl();
      if (player && typeof player.getOption === "function") {
        const list = player.getOption("captions", "tracklist");
        if (Array.isArray(list)) list.forEach((t) => pushTrack(out, t));
      }
    } catch (_e) { /* never throw */ }
    try {
      const pr = window.ytInitialPlayerResponse;
      const vid = pr && pr.videoDetails && pr.videoDetails.videoId;
      if (pr && vid === currentVideoId) {
        const r = pr.captions && pr.captions.playerCaptionsTracklistRenderer;
        const tracks = r && r.captionTracks;
        if (Array.isArray(tracks)) tracks.forEach((t) => pushTrack(out, t));
      }
    } catch (_e) { /* never throw */ }
    return out;
  }

  function automaticTimingUrl(language, originalUrl) {
    const normalized = String(language || "").replace(/_/g, "-").toLowerCase();
    if (!normalized || normalized === "auto") return "";
    const match = trackEntries().find((t) =>
      (t.kind === "asr" || String(t.vssId).startsWith("a.")) &&
      String(t.languageCode || langOfUrl(t.url)).replace(/_/g, "-").toLowerCase() === normalized &&
      vidOfUrl(t.url) === currentVideoId && normKey(t.url) !== normKey(originalUrl));
    return match ? match.url : "";
  }

  function timingTrack(url) {
    const key = normKey(url);
    if (timingTrackCache.has(key)) return timingTrackCache.get(key);
    const request = fetchJson3(buildUrl(url, null), TRANSLATION_TIMEOUT_MS)
      .then(parseJson3).catch(() => {
        timingTrackCache.delete(key); // later config/source capture can retry
        return [];
      });
    timingTrackCache.set(key, request);
    while (timingTrackCache.size > 4) {
      timingTrackCache.delete(timingTrackCache.keys().next().value);
    }
    return request;
  }

  // The track the player has actually selected (auto-selected or chosen by the
  // user in the CC menu). Without one we do not guess at all: picking a random
  // track could show the wrong language before the player's own fetch arrives.
  function currentTrack() {
    try {
      const player = playerEl();
      if (player && typeof player.getOption === "function") {
        const t = player.getOption("captions", "track");
        if (t) {
          return {
            languageCode: t.languageCode || "",
            vssId: t.vssId || "",
            kind: t.kind || ""
          };
        }
      }
    } catch (_e) { /* never throw */ }
    return null;
  }

  function speculativeTrackUrl() {
    const want = currentTrack();
    if (!want || (!want.vssId && !want.languageCode)) return "";
    const entries = trackEntries();
    if (!entries.length) return "";
    let hit = want.vssId ? entries.find((e) => e.vssId === want.vssId) : null;
    if (!hit) {
      hit = entries.find((e) => e.languageCode === want.languageCode &&
        (e.kind || "") === (want.kind || ""));
    }
    if (!hit) hit = entries.find((e) => e.languageCode === want.languageCode);
    return hit ? hit.url : "";
  }

  // Try to seed the source URL now, retrying briefly while the player boots.
  function seedSourceSoon(attempt) {
    const n = attempt || 0;
    if (sourceUrl || !currentVideoId) return;
    try {
      const url = speculativeTrackUrl();
      if (url) {
        noteTimedtext(url, true);
        return;
      }
    } catch (_e) { /* never throw */ }
    if (n >= 25) return;            // allow a slower player to finish initializing
    if (seedTimer) clearTimeout(seedTimer);
    seedTimer = setTimeout(() => seedSourceSoon(n + 1), 200);
  }

  // Record a timedtext URL seen on the wire (or a URL we guessed ourselves).
  function noteTimedtext(url, speculative) {
    try {
      if (!isTimedtext(url) || hasTlang(url)) return;
      const key = normKey(url);
      if (speculative) {
        // A guess only ever fills an EMPTY slot: a real capture always wins.
        if (sourceUrl || key === sourceKey) return;
        sourceUrl = url;
        sourceVid = vidOfUrl(url);
        sourceKey = key;
        sourceSpeculative = true;
        onSourceCaptured();
        return;
      }
      lastTimedtextUrl = url;
      // The player's original-track fetch — the only pot we may reuse.
      // Always keep the freshest exact URL (pot can rotate), but only treat it
      // as a NEW source (and re-produce) when the track identity changes.
      const wasSpeculative = sourceSpeculative;
      if (key !== sourceKey || url !== sourceUrl) sourceRetryStep = 0;
      sourceUrl = url;
      sourceVid = vidOfUrl(url);
      sourceSpeculative = false;
      if (wasSpeculative || key !== sourceKey || !producedForUrl) {
        sourceKey = key;
        onSourceCaptured();
      }
    } catch (_e) { /* never throw */ }
  }

  // ---- video-change reset --------------------------------------------------
  // Returns true if a change was detected and state was reset.
  function checkVideoChange() {
    try {
      const v = videoIdFromLocation();
      if (v && v !== currentVideoId) {
        currentVideoId = v;
        lastTimedtextUrl = "";
        sourceUrl = "";
        sourceVid = "";
        sourceKey = "";
        sourceSpeculative = false;
        producedForUrl = "";
        originalCache = null;
        originalRequest = null;
        translationTracks.clear();
        sourceRetryStep = 0;
        clearSourceRetry();
        produceSeq++;
        if (seedTimer) { clearTimeout(seedTimer); seedTimer = null; }
        clearNocuesTimer();
        return true;
      }
    } catch (_e) { /* never throw */ }
    return false;
  }
  setInterval(checkVideoChange, 500);

  // ---- nocues watchdog -----------------------------------------------------
  function armNocuesTimer() {
    clearNocuesTimer();
    const vid = currentVideoId;
    const nonceAtArm = reqNonce;
    nocuesTimer = setTimeout(() => {
      nocuesTimer = null;
      if (vid !== currentVideoId) return;
      if (nonceAtArm !== reqNonce) return;
      if (!sourceUrl) {
        let confirmedAbsent = false;
        try {
          const player = playerEl();
          const response = typeof player?.getPlayerResponse === "function"
            ? player.getPlayerResponse() : window.ytInitialPlayerResponse;
          const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          confirmedAbsent = response?.videoDetails?.videoId === vid &&
            response?.playabilityStatus?.status === "OK" && !trackEntries().length &&
            (tracks === undefined || (Array.isArray(tracks) && tracks.length === 0));
        } catch (_e) { /* missing page metadata remains unknown */ }
        post("nocues", confirmedAbsent ? { reason: "no_track" } : {});
        scheduleSourceRetry();
      }
    }, 6000);
  }

  // ---- receive config from content.js --------------------------------------
  window.addEventListener("message", (evt) => {
    try {
      if (evt.source !== window) return;
      const d = evt.data;
      if (!d || d.source !== "ytds-content") return;
      if (typeof d !== "object" || JSON.stringify(d).length > 64 * 1024) return;
      if (sessionToken && d.sessionToken !== sessionToken) return;
      if (d.type === "hello") {
        post("ready");
        return;
      }
      if (d.type !== "export-request" && (!Number.isSafeInteger(d.nonce) || d.nonce < 0)) return;

      if (d.type === "config") {
        if (typeof d.targetLang !== "string" || d.targetLang.length > 32 ||
            (d.useTlang !== undefined && typeof d.useTlang !== "boolean") ||
            (d.useWordTiming !== undefined && typeof d.useWordTiming !== "boolean") ||
            (d.useAutoMatch !== undefined && typeof d.useAutoMatch !== "boolean")) return;
        if (typeof d.sessionToken === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(d.sessionToken)) {
          sessionToken = d.sessionToken;
        }
        // Treat the config message as the authoritative nav signal: reset any
        // stale capture synchronously if the location video changed, rather
        // than waiting up to 500ms for the poll. This closes the cross-video
        // contamination window — produceCues will only run for a sourceUrl
        // captured for the now-current video.
        checkVideoChange();
        currentVideoId = videoIdFromLocation();
        cfg = { targetLang: d.targetLang, useTlang: !!d.useTlang,
          useWordTiming: !!d.useWordTiming, useAutoMatch: d.useAutoMatch !== false };
        // Adopt the content-supplied nonce so our posts correlate to THIS
        // sendConfig(); content.js drops any reply with an older nonce.
        if (typeof d.nonce === "number") reqNonce = d.nonce;
        clearSourceRetry();
        sourceRetryStep = 0;
        producedForUrl = "";            // force re-produce under new config
        if (sourceUrl && sourceVid === currentVideoId) {
          produceCues(true);            // already captured for this video
        } else {
          if (sourceSpeculative && sourceVid !== currentVideoId) {
            sourceUrl = "";             // stale guess from another video
            sourceVid = "";
            sourceKey = "";
            sourceSpeculative = false;
          }
          armNocuesTimer();             // wait for player's timedtext fetch
          seedSourceSoon();             // ...but try to start earlier (B1)
        }
      } else if (d.type === "word-timing-config") {
        if (d.useWordTiming !== undefined && typeof d.useWordTiming !== "boolean") return;
        if (d.useAutoMatch !== undefined && typeof d.useAutoMatch !== "boolean") return;
        // Turning highlighting off needs no refetch of the original/translation.
        if (cfg) {
          cfg.useWordTiming = !!d.useWordTiming;
          cfg.useAutoMatch = d.useAutoMatch !== false;
        }
      } else if (d.type === "export-request") {
        if (typeof d.exportId !== "string" && typeof d.exportId !== "number") return;
        if (String(d.exportId).length > 128 || typeof d.targetLang !== "string" || d.targetLang.length > 32) return;
        // On-demand SRT export: build a COMPLETE bilingual cue set regardless of
        // the live backend mode (see produceExport). Correlated by exportId.
        // Sync video state first so a just-navigated tab can't export the
        // previous video's captured URL.
        checkVideoChange();
        currentVideoId = videoIdFromLocation();
        produceExport(d.targetLang, d.exportId);
      }
    } catch (_e) { /* never throw */ }
  }, false);

  // ---- hook XMLHttpRequest --------------------------------------------------
  try {
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;

    XHR.open = function (method, url) {
      try { this.__ytdsUrl = url; } catch (_e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };

    XHR.send = function () {
      try {
        const url = this.__ytdsUrl;
        noteTimedtext(url);
        if (isTimedtext(url) && !hasTlang(url) && this.addEventListener) {
          this.addEventListener("load", () => {
            try {
              if (this.status >= 200 && this.status < 300) {
                captureOriginalBody(url, this.responseType === "json" ? this.response : this.responseText);
              }
            } catch (_e) { /* ignore */ }
          }, { once: true });
        }
      } catch (_e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  } catch (_e) { /* never throw */ }

  // ---- hook fetch -----------------------------------------------------------
  try {
    const origFetch = window.fetch;
    if (typeof origFetch === "function") {
      window.fetch = function (input, init) {
        const result = origFetch.apply(this, arguments);
        try {
          let url = "";
          if (typeof input === "string") url = input;
          else if (input && typeof input.url === "string") url = input.url;
          noteTimedtext(url);
          if (isTimedtext(url) && !hasTlang(url)) {
            result.then((res) => {
              if (res.ok && res.clone) {
                res.clone().text().then((body) => captureOriginalBody(url, body)).catch(() => {});
              }
            }).catch(() => {});
          }
        } catch (_e) { /* ignore */ }
        return result;
      };
    }
  } catch (_e) { /* never throw */ }

  // ---- robust capture via Resource Timing ----------------------------------
  // Hook-independent fallback: the player's /api/timedtext request shows up in
  // Resource Timing with its FULL url (incl. pot) regardless of whether it used
  // XHR or fetch — and even if another extension (e.g. an older dual-subtitles
  // build) has locked XMLHttpRequest.prototype.open so our XHR hook never
  // installs. This is the mechanism the rewrite was validated against.
  try {
    const scan = (entries) => {
      for (const e of entries) {
        if (e && typeof e.name === "string" && isTimedtext(e.name) &&
            !extensionFetchUrls.has(e.name)) {
          noteTimedtext(e.name);
        }
      }
    };
    try { scan(performance.getEntriesByType("resource")); } catch (_e) { /* ignore */ }
    if (typeof PerformanceObserver === "function") {
      const po = new PerformanceObserver((list) => {
        try { scan(list.getEntries()); } catch (_e) { /* ignore */ }
      });
      po.observe({ type: "resource", buffered: true });
    }
  } catch (_e) { /* never throw */ }
})();
