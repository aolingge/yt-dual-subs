// ============================================================================
// YT Dual Subs — Bilibili caption reader (MAIN world).
//
// Same role as inject.js plays for YouTube, for the Bilibili web player: find
// the current Chinese caption track, fetch its cue body, and post it to
// content.js in the engine's existing message format.
//
// It runs in the page's own world, so it can read the page's data and reuse the
// page's own requests. Verified against the live site and the public player
// bundle (core 4.10.4) on 2026-09-29:
//   * track METADATA  : //api.bilibili.com/x/player/wbi/v2        (JSON)
//                       //api.bilibili.com/x/v2/subtitle/web/view (protobuf)
//   * cue BODY        : the track's subtitle_url (classic CDN JSON)
//   * part identity   : /video/<BV...>/?p=N  ->  "<BV...>#pN"
//
// Reading captions requires the viewer's own logged-in session, so we never
// extract, copy or export cookies: we either observe the request the player
// itself made, or replay the same public endpoint from the page with the
// page's own credentials. No login, membership or access restriction is
// bypassed, and no account data leaves the page.
// ============================================================================
(function () {
  if (window.__ytdsBiliLoaded) return;
  window.__ytdsBiliLoaded = true;

  const META_JSON_RE = /\/x\/player\/(?:wbi\/)?v2\b/;
  const META_PB_RE = /\/x\/v2\/subtitle\/web\/view\b/;
  const CUE_HINT_RE = /subtitle/i;

  // ---- state ---------------------------------------------------------------
  let config = null;              // last {config} message from content.js
  let configNonce = 0;
  let key = videoKey();           // "<bvid>#p<N>"
  let bvid = bvidOf(key);
  let partNo = partFromLocation();
  let aid = null;
  let cid = null;
  let metaAnswered = false;       // a metadata response was seen (any source)
  let tracks = [];                // normalized track metadata with URLs
  let playerChosenLan = "";       // track the player itself fetched a body for
  const cueCache = new Map();     // subtitle url -> cue array
  const pendingUrls = new Set();  // url -> fetch in flight
  let postedSig = "";             // de-duplicates repeated posts of the same data
  let postedTracksSig = "";       // same, for the track-list post
  let retryTimer = null;
  let retryStep = 0;
  let seq = 0;                    // monotonic: lets a stale reply lose
  let evalToken = 0;              // the newest evaluation owns the page state

  // ---- video identity (MUST match site.js videoKey exactly) ----------------
  function videoKey() {
    let path = "", search = "";
    try { path = location.pathname || ""; search = location.search || ""; } catch (_e) { return ""; }
    const m = path.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    if (!m) return "";
    let p = 1;
    try { p = parseInt(new URLSearchParams(search).get("p"), 10) || 1; } catch (_e) { p = 1; }
    return m[1] + "#p" + p;
  }

  function bvidOf(videoId) {
    return videoId ? String(videoId).split("#")[0] : "";
  }

  // Which part (分P) the URL is showing. Every per-part lookup needs this; the
  // engine's video identity carries it too, so the two can never disagree.
  function partFromLocation() {
    try { return parseInt(new URLSearchParams(location.search || "").get("p"), 10) || 1; }
    catch (_e) { return 1; }
  }

  function refreshKey() {
    const next = videoKey();
    if (next === key) return false;
    key = next;
    // A new video or part must never inherit the previous one's track list,
    // cue bodies or chosen track.
    bvid = bvidOf(key); partNo = partFromLocation();
    aid = null; cid = null;
    metaAnswered = false; tracks = []; playerChosenLan = "";
    cueCache.clear(); pendingUrls.clear(); postedSig = ""; postedTracksSig = "";
    retryStep = 0;
    evalToken++;                  // cancel whatever the previous part was doing
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    return true;
  }

  // ---- protobuf (bilibili.subtitle.SubtitleViewReply) ----------------------
  function readVarint(bytes, pos) {
    let out = 0, shift = 0, byte = 0;
    do {
      if (pos >= bytes.length) throw new Error("varint eof");
      byte = bytes[pos++];
      out += (byte & 0x7f) * Math.pow(2, shift);
      shift += 7;
    } while (byte & 0x80);
    return [out, pos];
  }

  function eachField(bytes, visit) {
    let pos = 0;
    while (pos < bytes.length) {
      let tag; [tag, pos] = readVarint(bytes, pos);
      const field = tag >>> 3, wire = tag & 7;
      if (wire === 0) {
        let v; [v, pos] = readVarint(bytes, pos);
        visit(field, wire, v);
      } else if (wire === 2) {
        let len; [len, pos] = readVarint(bytes, pos);
        const slice = bytes.subarray(pos, pos + len);
        pos += len;
        visit(field, wire, slice);
      } else if (wire === 5) { pos += 4; }
      else if (wire === 1) { pos += 8; }
      else throw new Error("bad wire type " + wire);
    }
  }

  function utf8(bytes) {
    try { return new TextDecoder("utf-8").decode(bytes); } catch (_e) { return ""; }
  }

  // field numbers verified from the player bundle — see the schema recorded in
  // docs/BILIBILI.md. Only the fields we actually use are decoded.
  function decodeSubtitleItem(bytes) {
    const t = { id_str: "", lan: "", lan_doc: "", subtitle_url: "", type: 0,
      ai_type: 0, ai_status: 0, role: 0 };
    eachField(bytes, (f, w, v) => {
      if (w !== 2 && f !== 1 && f !== 7 && f !== 9 && f !== 10 && f !== 11) return;
      if (f === 1 && w === 0) t.id = v;
      else if (f === 2) t.id_str = utf8(v);
      else if (f === 3) t.lan = utf8(v);
      else if (f === 4) t.lan_doc = utf8(v);
      else if (f === 5) t.subtitle_url = utf8(v);
      else if (f === 7 && w === 0) t.type = v;
      else if (f === 9 && w === 0) t.ai_type = v;
      else if (f === 10 && w === 0) t.ai_status = v;
      else if (f === 11 && w === 0) t.role = v;
    });
    return t;
  }

  function decodeSubtitleView(buf) {
    const out = { subtitles: [] };
    eachField(buf, (f, w, v) => {
      if (f !== 1 || w !== 2) return;
      eachField(v, (f2, w2, v2) => {
        if (f2 === 3 && w2 === 2) out.subtitles.push(decodeSubtitleItem(v2));
      });
    });
    return out;
  }

  // ---- subtitle url de-obfuscation ----------------------------------------
  // Copied faithfully from the player bundle. Only URLs on
  // //subtitle.bilibili.com/<encoded> are rewritten onto aisubtitle.hdslb.com;
  // every other URL (the classic i0.hdslb.com CDN) is kept exactly as given —
  // that "keep the raw URL" branch is what makes ordinary CC tracks work.
  const OBF = [
    ['nP](wOFRvU.+<fjS{jn-!$D|Dz&",zT`', '=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`'],
    ['Bn"q~|albg@]Go~ACgyDvKnd+)_D}^&J?', "Cu~L!xs~f^&r@'vh=q]q{eeng*sEg^kp#J"]
  ];

  function xorString(value, secret) {
    let out = "";
    for (let i = 0; i < value.length; i++) {
      out += String.fromCharCode(value.charCodeAt(i) ^
        secret.charCodeAt(i % secret.length));
    }
    return out;
  }

  function decodeSubtitleUrl(raw) {
    const url = String(raw || "");
    const m = /\/\/subtitle\.bilibili\.com\/([^?]+)/.exec(url);
    if (!m) return url;
    let path = m[1];
    try { path = decodeURIComponent(path); } catch (_e) { /* keep raw */ }
    for (const [prefix, secret] of OBF) {
      let decoded = "";
      try { decoded = xorString(path, secret + "bilibili"); } catch (_e) { decoded = ""; }
      if (!decoded.startsWith(prefix)) continue;
      const rest = decoded.split(prefix)[1];
      if (!rest) continue;
      const query = url.indexOf("?") >= 0 ? url.slice(url.indexOf("?") + 1) : "";
      return "//aisubtitle.hdslb.com" + rest + (query ? "?" + query : "");
    }
    return url;
  }

  // ---- track normalization / selection ------------------------------------
  function num(value, fallback) {
    const n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  function normalizeTrack(t) {
    if (!t || typeof t !== "object") return null;
    return {
      id: String(t.id_str || t.idStr || t.id || ""),
      lan: String(t.lan || ""),
      lanDoc: String(t.lan_doc || t.lanDoc || ""),
      url: decodeSubtitleUrl(t.subtitle_url || t.subtitleUrl || ""),
      type: num(t.type, 0),                 // 0 = CC (human), 1 = AI
      aiType: num(t.ai_type !== undefined ? t.ai_type : t.aiType, 0),
      aiStatus: num(t.ai_status !== undefined ? t.ai_status : t.aiStatus, 0),
      role: num(t.role, 0)
    };
  }

  // Combine the language id AND the metadata: the track name alone is not a
  // reliable signal, and danmaku / title / comment text is never consulted.
  const ZH_LAN_RE = /^(zh|cmn|yue|wuu|nan|hak|gan|hsn|lzh)(-|$)/i;
  const ZH_DOC_RE = /中文|简体|繁體|繁体|汉语|漢語|普通话|國語|国语|粤语|粵語|chinese|mandarin|cantonese/i;

  function isChineseTrack(t) {
    return ZH_LAN_RE.test(t.lan) || ZH_DOC_RE.test(t.lanDoc);
  }

  // Lower rank wins. Human original first, then auto-generated; an AI track
  // whose ai_type says it is a *translation into* Chinese is an original only
  // as a last resort, because it is generated from another language.
  function zhRank(t) {
    let r = 0;
    if (t.aiType === 1) r += 200;
    if (t.type === 1) r += 40;
    if (t.aiStatus === 2) r += 5;                 // "assist" tracks are partial
    if (t.role === 1) r -= 4;                     // Main role
    const lan = t.lan.toLowerCase();
    if (/^(zh-hans|zh-cn|zh-sg|zh-my)$/.test(lan)) r += 0;
    else if (/^(zh-hant|zh-tw|zh-hk|zh-mo)$/.test(lan)) r += 8;
    else r += 4;
    if (/简体/.test(t.lanDoc)) r -= 1;
    if (/繁體|繁体/.test(t.lanDoc)) r += 3;
    return r;
  }

  function selectTrack() {
    const zh = tracks.filter((t) => isChineseTrack(t) && t.url);
    if (!zh.length) return null;
    // (1) an explicit choice made through the extension always wins
    if (config && config.trackId) {
      const hit = zh.find((t) => t.id === config.trackId || t.lan === config.trackId);
      if (hit) return hit;
    }
    // (2) a track the player itself fetched a body for = the user's own pick
    if (playerChosenLan) {
      const hit = zh.find((t) => t.lan === playerChosenLan);
      if (hit) return hit;
    }
    // (3) otherwise rank: human Chinese original before auto-generated
    return zh.slice().sort((a, b) => zhRank(a) - zhRank(b))[0];
  }

  // ---- cue body parsing ----------------------------------------------------
  const TIME_KEYS_FROM = ["from", "start", "startTime", "start_time", "tStartMs", "t"];
  const TIME_KEYS_TO = ["to", "end", "endTime", "end_time"];
  // A DURATION is not an end time: json3-style bodies carry `dDurationMs`
  // alongside `tStartMs`, and reading it as the end would collapse every cue.
  const TIME_KEYS_DUR = ["dDurationMs", "duration", "dur"];
  const TEXT_KEYS = ["content", "text", "body", "utf8", "value"];

  function firstOf(obj, keys) {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") return { key: k, value: obj[k] };
    }
    return null;
  }

  function cleanText(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/\r\n?/g, "\n")
      .replace(/\n+/g, " ")          // one cue stays one line; no content is lost
      .replace(/[ \t\u00a0]+/g, " ")
      .trim();
  }

  // Bilibili's classic body is { body: [ { from, to, content } ] } in SECONDS.
  // The live cue-body schema could not be observed while logged out, so this
  // accepts the shapes the player could plausibly use and decides the unit from
  // the values themselves rather than assuming one.
  function parseCueBody(text) {
    const raw = String(text || "").replace(/^\uFEFF/, "").trim();
    if (!raw) return null;
    let data = null;
    try { data = JSON.parse(raw); } catch (_e) { return null; }
    let list = null;
    if (Array.isArray(data)) list = data;
    else if (data && Array.isArray(data.body)) list = data.body;
    else if (data && Array.isArray(data.events)) list = data.events;
    else if (data && Array.isArray(data.subtitles)) list = data.subtitles;
    if (!list) return null;

    const staged = [];
    let msEvidence = 0, secEvidence = 0;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const from = firstOf(item, TIME_KEYS_FROM);
      const to = firstOf(item, TIME_KEYS_TO);
      const dur = firstOf(item, TIME_KEYS_DUR);
      if (!from) continue;
      let textValue = firstOf(item, TEXT_KEYS);
      if (!textValue && Array.isArray(item.segs)) {
        textValue = { key: "segs", value: item.segs.map((s) => s && s.utf8).join("") };
      }
      if (!textValue) continue;
      const start = Number(from.value);
      const end = to ? Number(to.value) : NaN;
      if (!isFinite(start)) continue;
      // Field names that state the unit outright. `duration`/`dur` are ambiguous
      // and only shape the end, they never decide the unit for the whole body.
      const msHint = from.key === "tStartMs" || from.key === "startTime" ||
        (to && to.key === "endTime") || (dur && dur.key === "dDurationMs");
      if (msHint) msEvidence++;
      else if (!Number.isInteger(start)) secEvidence++;
      staged.push({
        start,
        end: isFinite(end) ? end : NaN,
        dur: dur ? Number(dur.value) : NaN,
        text: cleanText(textValue.value)
      });
    }
    if (!staged.length) return null;

    // Unit decision: an explicit ms-style key or a huge magnitude means ms.
    let useMs = msEvidence > 0;
    if (!useMs) {
      let maxValue = 0;
      for (const c of staged) {
        maxValue = Math.max(maxValue, c.start);
        if (isFinite(c.end)) maxValue = Math.max(maxValue, c.end);
        if (isFinite(c.dur)) maxValue = Math.max(maxValue, c.start + c.dur);
      }
      if (secEvidence === 0 && Number.isInteger(maxValue) && maxValue > 86400) useMs = true;
    }

    const cues = [];
    const seen = new Set();
    for (const c of staged) {
      const startMs = Math.round(useMs ? c.start : c.start * 1000);
      if (!isFinite(startMs) || startMs < 0) continue;
      let endMs = startMs;
      if (isFinite(c.end)) endMs = Math.round(useMs ? c.end : c.end * 1000);
      else if (isFinite(c.dur)) endMs = startMs + Math.round(useMs ? c.dur : c.dur * 1000);
      if (!c.text) continue;
      // Duplicate / overlapping display rows for the same instant collapse to
      // one cue; the engine groups adjacent cues into readable sentences later.
      const sig = startMs + "\u0000" + c.text;
      if (seen.has(sig)) continue;
      seen.add(sig);
      cues.push({ start: startMs, dur: Math.max(0, endMs - startMs), text: c.text });
    }
    if (!cues.length) return null;
    cues.sort((a, b) => a.start - b.start);
    return { cues, unit: useMs ? "ms" : "s" };
  }

  // ---- posting to content.js ----------------------------------------------
  function post(message) {
    try { window.postMessage({ source: "ytds-inject", ...message }, "*"); }
    catch (_e) { /* the page is going away */ }
  }

  function postCues(track, cues) {
    const sig = key + "|" + configNonce + "|" + track.id + "|" + cues.length +
      "|" + (cues[0] ? cues[0].start : "");
    if (sig === postedSig) return;
    postedSig = sig;
    post({
      type: "cues",
      videoId: key,
      nonce: configNonce,
      cues,
      tcues: null,          // Bilibili has no translated caption track
      aligned: null,
      // No site-supplied translation exists, so the extension's own queue must
      // translate immediately instead of waiting for one that will never come.
      translationPending: false,
      sourceLang: track.lan || "zh-CN",
      trackId: track.id,
      trackDoc: track.lanDoc
    });
  }

  // The caption tracks this page offers, as metadata only. Sent so the popup
  // can offer a manual switch even when no track could be loaded (for instance
  // when the list is only visible to a signed-in viewer), and so the user can
  // see WHICH Chinese track (human vs auto-generated) was picked.
  function postTracks() {
    if (!key || !tracks.length) return;
    const sig = key + "|" + configNonce + "|tracks|" +
      tracks.map((t) => t.lan + ":" + t.id + ":" + (t.url ? 1 : 0)).join(",");
    if (sig === postedTracksSig) return;
    postedTracksSig = sig;
    post({
      type: "tracks",
      videoId: key,
      nonce: configNonce,
      tracks: tracks.map((t) => ({
        lan: t.lan,
        lanDoc: t.lanDoc,
        idStr: t.id,
        aiType: t.aiType,
        hasUrl: !!t.url
      }))
    });
  }

  function postNoCues(reason, detail) {
    const sig = key + "|" + configNonce + "|nocues|" + reason + "|" + (detail || "");
    if (sig === postedSig) return;
    postedSig = sig;
    post({
      type: "nocues",
      videoId: key,
      nonce: configNonce,
      reason,
      detail: detail || "",
      sourceLang: "zh-CN"
    });
  }

  // ---- metadata -----------------------------------------------------------
  function ssrTracks() {
    try {
      const st = window.__INITIAL_STATE__;
      const vd = st && st.videoData;
      if (!vd) return [];
      // A soft navigation to another BV leaves a stale state behind; never let
      // it describe the wrong video.
      if (bvid && vd.bvid && vd.bvid !== bvid) return [];
      const list = vd.subtitle && vd.subtitle.list;
      return Array.isArray(list) ? list : [];
    } catch (_e) { return []; }
  }

  function ssrPart() {
    try {
      const st = window.__INITIAL_STATE__;
      const vd = st && st.videoData;
      if (!vd) return null;
      if (bvid && vd.bvid && vd.bvid !== bvid) return null;
      const pages = Array.isArray(vd.pages) ? vd.pages : [];
      const hit = pages.find((x) => Number(x.page) === partNo);
      return {
        aid: st.aid || vd.aid || null,
        cid: (hit && hit.cid) || null
      };
    } catch (_e) { return null; }
  }

  function adoptTracks(list, fromApi) {
    const next = [];
    for (const raw of list || []) {
      const t = normalizeTrack(raw);
      if (t && t.lan) next.push(t);
    }
    if (!next.length) {
      // The player's API is the authority on what can actually be read, so an
      // empty answer clears what the page state had claimed. The NOT-answer case
      // is different: a list that is merely URL-less still proves which
      // languages exist, and that is how "log in to read these" is told apart
      // from "this video has no Chinese track".
      if (fromApi && tracks.length) { tracks = []; postTracks(); }
      return;
    }
    // Prefer a source that actually carries URLs; the SSR list is often
    // URL-less while it still proves which languages exist.
    const withUrl = next.filter((t) => t.url).length;
    if (fromApi || !tracks.some((t) => t.url) || withUrl) tracks = next;
    postTracks();
  }

  function rememberHeader(url) {
    // The player's own subtitle request carries the part it is asking about.
    const parsed = parseQuery(url);
    const a = parsed.aid || parsed.pid;
    const c = parsed.cid || parsed.oid;
    if (a && c) { aid = Number(a) || aid; cid = Number(c) || cid; }
  }

  function parseQuery(url) {
    const out = {};
    try {
      const q = String(url).split("?")[1];
      if (!q) return out;
      for (const pair of q.split("&")) {
        const i = pair.indexOf("=");
        if (i <= 0) continue;
        out[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
      }
    } catch (_e) { /* ignore */ }
    return out;
  }

  // ---- fetching -----------------------------------------------------------
  const ORIGINAL_FETCH = window.fetch ? window.fetch.bind(window) : null;

  function hostOf(url) {
    try {
      return new URL(url, location.href).hostname;
    } catch (_e) { return ""; }
  }

  function credentialMode(url) {
    // The Bilibili API needs the page's own session; the caption CDN must NOT
    // be asked for credentials or the cross-origin request is rejected.
    return /(^|\.)bilibili\.com$/i.test(hostOf(url)) ? "include" : "omit";
  }

  async function requestText(url) {
    if (!ORIGINAL_FETCH) throw new Error("no fetch");
    const res = await ORIGINAL_FETCH(url, {
      credentials: credentialMode(url),
      headers: { Accept: "application/json, text/plain, */*" }
    });
    if (!res || !res.ok) throw new Error("subtitle http " + (res ? res.status : "?"));
    return res.text();
  }

  async function fetchCuesFor(track) {
    if (cueCache.has(track.url)) return cueCache.get(track.url);
    if (pendingUrls.has(track.url)) return null;
    pendingUrls.add(track.url);
    const mySeq = ++seq;
    try {
      const text = await requestText(track.url);
      const parsed = parseCueBody(text);
      if (!parsed) throw new Error("subtitle body not understood");
      cueCache.set(track.url, parsed.cues);
      return parsed.cues;
    } finally {
      pendingUrls.delete(track.url);
      if (mySeq !== seq) { /* a newer evaluation owns the result */ }
    }
  }

  // ---- the single decision point ------------------------------------------
  function scheduleRetry() {
    if (retryTimer || !config) return;
    if (retryStep >= 6) return;                 // bounded: never retry forever
    const wait = [400, 800, 1500, 2500, 4000, 6000][retryStep] || 6000;
    retryStep++;
    retryTimer = setTimeout(() => { retryTimer = null; evaluate("retry"); }, wait);
  }

  // What we know about this part's tracks, even when we have no usable URLs.
  function knownTracks() {
    if (tracks.length) return tracks;
    const ssr = ssrTracks();
    return Array.isArray(ssr) ? ssr.map(normalizeTrack) : [];
  }

  function needLoginOrNoTrack() {
    const known = knownTracks();
    if (known.length) {
      // The page lists tracks, so "nothing at all" is not the truth: either one
      // of them is Chinese and we could not get its URL, or the video simply
      // has no Chinese track. Those are different problems for the viewer.
      return known.some(isChineseTrack) ? "need_login" : "not_chinese";
    }
    return metaAnswered ? "no_track" : "loading";
  }

  async function evaluate() {
    if (!config) return;
    refreshKey();
    if (!key) { postNoCues("unsupported_page", location.pathname); return; }
    // Every path below can await. A newer evaluation (or a part switch, which
    // bumps the token inside refreshKey) invalidates this one, so a slow reply
    // can never publish the previous part's captions under the new part's key.
    const token = ++evalToken;
    const alive = () => token === evalToken;

    // Resolve the part when the page state is usable; the player's own request
    // header is authoritative and overwrites this when it arrives.
    const ssr = ssrPart();
    if (ssr) {
      if (ssr.aid && !aid) aid = Number(ssr.aid) || null;
      if (ssr.cid && !cid) cid = Number(ssr.cid) || null;
    }

    // Ask for the metadata ourselves when the player has not done it (yet).
    if (!metaAnswered && aid && cid) {
      const mySeq = ++seq;
      try {
        const text = await requestText("//api.bilibili.com/x/player/wbi/v2?aid=" +
          encodeURIComponent(aid) + "&cid=" + encodeURIComponent(cid));
        if (mySeq === seq) handleJsonMetadata(text);
      } catch (_e) {
        if (mySeq === seq && retryStep < 3) scheduleRetry();
      }
      if (!alive()) return;
    }

    const track = selectTrack();
    if (!track) {
      if (!alive()) return;
      const reason = needLoginOrNoTrack();
      if (reason === "loading") {
        if (retryStep < 6) { scheduleRetry(); return; }
        // Out of attempts: say what happened instead of spinning forever.
        postNoCues("fetch_failed", "track metadata did not answer");
        return;
      }
      postNoCues(reason, knownTracks().map((t) => t.lan + " " + t.lanDoc).join(", "));
      return;
    }

    let cues = cueCache.get(track.url);
    if (!cues) {
      try {
        cues = await fetchCuesFor(track);
      } catch (err) {
        // Never present a failure as a permanent spinner: say what happened.
        if (alive()) postNoCues("fetch_failed", String((err && err.message) || err));
        return;
      }
    }
    if (!alive()) return;
    // null means an identical request is already in flight; that one publishes.
    if (cues === null) return;
    if (!cues.length) { postNoCues("fetch_failed", "empty caption body"); return; }
    postCues(track, cues);
  }

  function handleJsonMetadata(text) {
    let json = null;
    try { json = JSON.parse(text); } catch (_e) { return; }
    const sub = json && json.code === 0 && json.data && json.data.subtitle;
    metaAnswered = true;
    if (!sub || !Array.isArray(sub.subtitles)) { evaluate("metadata"); return; }
    adoptTracks(sub.subtitles, true);
    evaluate("metadata");
  }

  function handleProtobufMetadata(buffer) {
    let decoded = null;
    try { decoded = decodeSubtitleView(new Uint8Array(buffer)); } catch (_e) { return; }
    metaAnswered = true;
    if (decoded && Array.isArray(decoded.subtitles)) adoptTracks(decoded.subtitles, true);
    evaluate("metadata");
  }

  // A cue body the player fetched itself: cache it, and remember which track it
  // was, because that is the user's own track selection.
  function handleCueBody(url, text) {
    const parsed = parseCueBody(text);
    if (!parsed) return;
    cueCache.set(url, parsed.cues);
    const hit = tracks.find((t) => t.url && (t.url === url || url.indexOf(t.url) === 0 ||
      t.url.indexOf(url) === 0));
    if (hit) playerChosenLan = hit.lan;
    postedSig = "";                    // force a re-post now that we have cues
    evaluate("player-body");
  }

  function isInterestingUrl(url) {
    return META_JSON_RE.test(url) || META_PB_RE.test(url) || CUE_HINT_RE.test(url);
  }

  // ---- network hooks ------------------------------------------------------
  function handleResponse(url, body, responseType) {
    try {
      if (META_PB_RE.test(url)) {
        if (body instanceof ArrayBuffer) handleProtobufMetadata(body);
        else if (body && body.byteLength) handleProtobufMetadata(body);
        else if (typeof body === "string") { try { handleProtobufMetadata(base64ToBuffer(body)); } catch (_e) {} }
        return;
      }
      if (META_JSON_RE.test(url)) {
        rememberHeader(url);
        if (typeof body === "string") handleJsonMetadata(body);
        else if (body && typeof body === "object") handleJsonMetadata(JSON.stringify(body));
        return;
      }
      if (CUE_HINT_RE.test(url) && typeof body === "string" &&
          /[{[]/.test(body.slice(0, 64))) {
        handleCueBody(url, body);
      }
    } catch (_e) { /* never break the page's own request */ }
  }

  function base64ToBuffer(text) {
    const bin = atob(text);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function installXhrHook() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto || proto.__ytdsHooked) return;
    proto.__ytdsHooked = true;
    const origOpen = proto.open;
    const origSend = proto.send;
    proto.open = function (method, url) {
      try { this.__ytdsUrl = String(url || ""); } catch (_e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    proto.send = function () {
      try {
        const url = this.__ytdsUrl;
        if (url && isInterestingUrl(url)) {
          this.addEventListener("load", () => {
            try {
              const type = this.responseType;
              const body = type === "arraybuffer" ? this.response
                : type === "json" ? this.response
                : type === "" || type === "text" ? this.responseText : null;
              if (body !== null && body !== undefined) handleResponse(url, body, type);
            } catch (_e) { /* ignore */ }
          });
        }
      } catch (_e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }

  function installFetchHook() {
    if (!window.fetch || window.fetch.__ytdsHooked) return;
    const hooked = function (input, init) {
      const promise = ORIGINAL_FETCH ? ORIGINAL_FETCH(input, init) : window.fetch(input, init);
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url && isInterestingUrl(url)) {
          promise.then((res) => {
            try {
              const copy = res.clone();
              if (META_PB_RE.test(url)) copy.arrayBuffer().then(handleProtobufMetadata, () => {});
              else copy.text().then((t) => handleResponse(url, t, ""), () => {});
            } catch (_e) { /* ignore */ }
          }, () => {});
        }
      } catch (_e) { /* ignore */ }
      return promise;
    };
    hooked.__ytdsHooked = true;
    window.fetch = hooked;
  }

  // Last resort: the player may fetch a caption body through a transport we did
  // not hook. The resource timing entry still names the URL, so we can replay
  // the same public request ourselves.
  function installResourceObserver() {
    if (typeof PerformanceObserver === "undefined") return;
    try {
      const seen = new Set();
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const url = entry && entry.name;
          if (!url || seen.has(url) || !CUE_HINT_RE.test(url)) continue;
          seen.add(url);
          if (!tracks.some((t) => t.url === url)) continue;   // only known tracks
          if (cueCache.has(url)) continue;
          requestText(url).then((text) => handleCueBody(url, text), () => {});
        }
      });
      observer.observe({ type: "resource", buffered: true });
    } catch (_e) { /* unsupported: the XHR/fetch hooks still cover the normal path */ }
  }

  // ---- messages from content.js -------------------------------------------
  window.addEventListener("message", (evt) => {
    if (evt.source !== window) return;
    const d = evt.data;
    if (!d || d.source !== "ytds-content") return;

    if (d.type === "config") {
      config = {
        targetLang: String(d.targetLang || ""),
        trackId: d.trackId ? String(d.trackId) : ""
      };
      configNonce = typeof d.nonce === "number" ? d.nonce : configNonce;
      retryStep = 0;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      refreshKey();
      evaluate("config");
      return;
    }

    if (d.type === "export-request") {
      // The extension holds the translations; we only supply the original cues.
      const track = selectTrack();
      const cues = track ? cueCache.get(track.url) : null;
      post({
        type: "exportdata",
        exportId: d.exportId,
        ok: !!(cues && cues.length),
        cues: cues || [],
        tcues: null,
        aligned: null,
        sourceLang: track ? track.lan : "zh-CN"
      });
    }
  }, false);

  installXhrHook();
  installFetchHook();
  installResourceObserver();

  // The page may already have loaded its metadata before this script ran.
  try {
    const ssr = ssrTracks();
    if (Array.isArray(ssr) && ssr.length) adoptTracks(ssr, false);
  } catch (_e) { /* ignore */ }
})();
