// ============================================================================
// YT Dual Subs — the local recognizer bridge (extension side).
//
// A video with no caption track still has audio. "Deutsch Overlay" on this
// machine can recognize that audio with its own local models, and this module
// is the client half of the wire protocol it speaks:
//
//   GET  /v1/health                      is a recognizer listening?
//   POST /v1/session                     may we recognize this video at all?
//   POST /v1/session/<id>/audio          here is more PCM
//   POST /v1/session/<id>/transcript     what have you recognized since <rev>?
//   POST /v1/session/<id>/finish         no more audio is coming
//   DELETE /v1/session/<id>              forget this session
//
// Three rules from the task this code exists to satisfy:
//
//  * The bridge is asked to recognize ONLY after the page positively reported
//    that the video has no usable caption track. "unknown" is not "absent":
//    a caption track that arrives a second later must win, so the extension
//    never starts from a guess.
//  * A caption's time comes from the VIDEO's own clock. The page publishes the
//    media time its next sample corresponds to (``audioStartMs``) and bumps
//    ``timelineEpoch`` whenever that mapping breaks (seek, rate change, part
//    change); the bridge maps samples onto media time with it. Nothing here
//    ever uses "when the recognizer answered" as a time.
//  * A missing translation still shows the original. A segment whose
//    translation failed keeps its recognized text on the original line.
//
// The module is deliberately pure: no DOM, no chrome API, no timer of its own.
// It takes a ``fetch``-shaped function so the tests can drive it with canned
// answers, and it returns the cue format the overlay already renders:
//
//   { start: ms, dur: ms, text: string, trans?: string, end: ms }
// ============================================================================
(function () {
  if (globalThis.YtdsBridge) return;

  const PROTOCOL_VERSION = 1;
  const DEFAULT_BASE = "http://127.0.0.1:8766";
  // The bridge refuses more than 16 packets in one request, and one packet may
  // not exceed 1 MiB of base64 (~12 s of 16-bit 16 kHz mono). Staying under
  // both is the client's job.
  const MAX_PACKETS_PER_REQUEST = 16;
  const MAX_PCM_BASE64_CHARS = 1 << 20;
  // 1 s of 16 kHz mono 16-bit PCM is 32 000 bytes -> ~42 667 base64 chars.
  const PACKET_FRAMES = 16000;
  const HEALTH_TIMEOUT_MS = 2500;
  const REQUEST_TIMEOUT_MS = 8000;
  const MAX_RESPONSE_TEXT_CHARS = 4 << 20;
  // The transcript poll waits server-side for new text; a shorter wait keeps a
  // stopped bridge from stalling the caller for long.
  const POLL_WAIT_SECONDS = 10;

  // The caption-availability verdicts the protocol accepts. Only ABSENT opens
  // the door; UNKNOWN is treated exactly like PRESENT by the bridge.
  const CAPTIONS_PRESENT = "present";
  const CAPTIONS_ABSENT = "absent";
  const CAPTIONS_UNKNOWN = "unknown";

  const TERMINAL_STATUSES = new Set(["ready", "empty"]);

  // ------------------------------------------------------------------ helpers

  function baseUrlOf(value) {
    const text = String(value == null ? "" : value).trim().replace(/\/+$/, "");
    if (!text) return DEFAULT_BASE;
    const candidate = /^https?:\/\//i.test(text) ? text : "http://" + text;
    let parsed;
    try {
      if (typeof URL === "function") parsed = new URL(candidate);
      else {
        const match = candidate.match(/^(https?):\/\/((?:\[[^\]]+\])|[^/:?#]+)(?::(\d+))?(\/[^?#]*)?(?:\?([^#]*))?(?:#(.*))?$/i);
        if (!match) throw new Error("bad URL");
        parsed = { protocol: match[1].toLowerCase() + ":", hostname: match[2],
          username: "", password: "", search: match[5] ? "?" + match[5] : "",
          hash: match[6] ? "#" + match[6] : "", pathname: match[4] || "/",
          toString: () => candidate };
      }
    } catch (_e) {
      throw new BridgeError("invalid_base", "bridge address is not a valid URL");
    }
    // Recognition is deliberately local-only: the bearer token must never be
    // sent to a remote host or a URL with a hidden redirect/path.
    const host = String(parsed.hostname || "").toLowerCase();
    const loopback = host === "127.0.0.1" || host === "localhost";
    if (!loopback || !/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password ||
        parsed.search || parsed.hash || parsed.pathname !== "/") {
      throw new BridgeError("invalid_base", "bridge address must be a loopback HTTP URL");
    }
    return parsed.toString().replace(/\/+$/, "");
  }

  // A bridge token is a secret, so anything it might leak into is a bug. This
  // masker exists for logs and error text only: both ends stay so a human can
  // match it against the file the bridge wrote, and every character between
  // them is replaced so the log itself is never a usable credential.
  function maskToken(token) {
    const text = String(token || "");
    if (!text) return "";
    if (text.length <= 6) return "*".repeat(text.length);
    return text.slice(0, 3) + "*".repeat(text.length - 6) + text.slice(-3);
  }

  class BridgeError extends Error {
    constructor(code, message, status) {
      super(message || code);
      this.name = "BridgeError";
      this.code = code || "internal";
      this.status = status || 0;
    }
  }

  function bridgeErrorFrom(status, payload) {
    const error = payload && payload.error ? payload.error : null;
    const code = /^[a-z][a-z0-9_]{0,63}$/.test(error?.code || "") ? error.code : "http_" + status;
    return new BridgeError(
      code,
      "bridge request failed: " + code, // server text can contain credentials or private details
      status
    );
  }

  // A JSON POST carrying Authorization is never a simple request, so the
  // browser preflights it; the bridge answers OPTIONS for extension origins.
  function request(fetchImpl, url, options, timeoutMs) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    const init = Object.assign({}, options);
    init.redirect = "error"; // A loopback service must never redirect credentials.
    if (controller) init.signal = controller.signal;
    if (init.method && init.method !== "GET" && typeof init.body === "string") {
      init.headers = Object.assign(
        { "Content-Type": "application/json" },
        init.headers || {}
      );
    }
    return Promise.resolve()
      .then(() => fetchImpl(url, init))
      .then((response) =>
        response.text().then((text) => {
          if (typeof text === "string" && text.length > MAX_RESPONSE_TEXT_CHARS) {
            throw new BridgeError("response_too_large", "bridge response exceeded the size limit");
          }
          let payload = null;
          if (text) {
            try { payload = JSON.parse(text); } catch (_e) { payload = null; }
          }
          if (!response.ok) throw bridgeErrorFrom(response.status, payload);
          if (payload === null) throw new BridgeError("bad_response", "bridge sent no JSON");
          return payload;
        })
      )
      .catch((error) => {
        if (error instanceof BridgeError) throw error;
        if (error && error.name === "AbortError") {
          throw new BridgeError("timeout", "the bridge did not answer in time");
        }
        throw new BridgeError("offline", "no local recognizer answered at " + url);
      })
      .finally(() => { if (timer) clearTimeout(timer); });
  }

  // ------------------------------------------------------------------ base64

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  // Base64 of raw bytes. ``btoa`` exists in every extension context, but the
  // encoding is spelled out so the tests can run it without a DOM.
  function bytesToBase64(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let out = "";
    for (let i = 0; i < data.length; i += 3) {
      const b0 = data[i];
      const b1 = data[i + 1];
      const b2 = data[i + 2];
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
      out += b1 === undefined ? "=" : B64[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
      out += b2 === undefined ? "=" : B64[b2 & 63];
    }
    return out;
  }

  // Signed 16-bit little-endian PCM, clamped rather than wrapped: a wrapped
  // sample is a click, a clamped one is inaudible in a recognition buffer.
  function floatsToPcm16(samples) {
    const data = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    const out = new Uint8Array(data.length * 2);
    for (let i = 0; i < data.length; i++) {
      const value = data[i];
      const scaled = value <= -1 ? -32768 : value >= 1 ? 32767 : Math.round(value * 32768);
      const clamped = scaled < -32768 ? -32768 : scaled > 32767 ? 32767 : scaled;
      const unsigned = clamped < 0 ? clamped + 65536 : clamped;
      out[i * 2] = unsigned & 0xff;
      out[i * 2 + 1] = (unsigned >> 8) & 0xff;
    }
    return out;
  }

  // ------------------------------------------------------------- protocol bits

  /**
   * The request that opens a session. ``captionAvailability`` must be the
   * page's own verdict, never a default.
   */
  function sessionRequest(fields) {
    const request_ = {
      protocolVersion: PROTOCOL_VERSION,
      platform: String(fields.platform || ""),
      videoKey: String(fields.videoKey || ""),
      captionAvailability: fields.captionAvailability,
      sourceKind: fields.sourceKind || "tab_capture",
      sourceLanguage: fields.sourceLanguage || "auto",
      // The local OPUS bridge currently exposes German only. The target is
      // still sent explicitly so an unsupported future selection is rejected
      // by the bridge instead of silently receiving German text.
      translationTarget: fields.translationTarget || "de",
      timelineEpoch: Number(fields.timelineEpoch || 0),
      title: fields.title || "",
      url: fields.url || "",
      hasAudioTrack: fields.hasAudioTrack === undefined ? true : !!fields.hasAudioTrack,
      client: fields.client || "yt-dual-subs",
    };
    if (fields.audioStartMs !== undefined && fields.audioStartMs !== null) {
      request_.audioStartMs = Math.max(0, Math.round(Number(fields.audioStartMs) || 0));
    }
    if (fields.playbackRate) request_.playbackRate = Number(fields.playbackRate);
    if (fields.durationMs) request_.durationMs = Math.round(Number(fields.durationMs));
    if (fields.sampledPackets) request_.sampledPackets = fields.sampledPackets;
    if (fields.observedTextChars) request_.observedTextChars = fields.observedTextChars;
    return request_;
  }

  /**
   * Group bytes into packets the bridge will accept: at most 16 packets per
   * request and at most ~1 MiB of base64 each.
   *
   * ``sampleRate`` and ``channels`` describe the PCM as submitted; the bridge
   * resamples to its own rate and keeps the stream position in THESE units.
   */
  function packetize(bytes, options) {
    const settings = options || {};
    const sampleRate = Math.max(1, Math.round(Number(settings.sampleRate) || 16000));
    const channels = settings.channels === 2 ? 2 : 1;
    const bytesPerFrame = 2 * channels;
    const framesPerPacket = Math.min(
      Math.max(1, Math.round(Number(settings.framesPerPacket) || PACKET_FRAMES)),
      Math.floor(MAX_PCM_BASE64_CHARS / 4 * 3 / bytesPerFrame)
    );
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const wholeFrames = Math.floor(data.length / bytesPerFrame) * bytesPerFrame;
    const packets = [];
    let sampleIndex = Math.max(0, Math.round(Number(settings.firstSampleIndex) || 0));
    let sequence = Math.max(0, Math.round(Number(settings.firstSequence) || 0));
    for (let offset = 0; offset < wholeFrames; offset += framesPerPacket * bytesPerFrame) {
      const end = Math.min(offset + framesPerPacket * bytesPerFrame, wholeFrames);
      const slice = data.subarray(offset, end);
      const frames = (end - offset) / bytesPerFrame;
      packets.push({
        sequence,
        sampleIndex,
        pcm: bytesToBase64(slice),
        encoding: "pcm_s16le",
        sampleRate,
        channels,
        language: settings.language || "auto",
        audioStartMs: settings.audioStartMs === undefined ? null : settings.audioStartMs,
        timelineEpoch: settings.timelineEpoch === undefined ? null : settings.timelineEpoch,
        playbackRate: settings.playbackRate === undefined ? null : settings.playbackRate,
        final: false,
      });
      sampleIndex += frames;
      sequence += 1;
    }
    return { packets, droppedBytes: data.length - wholeFrames, nextSampleIndex: sampleIndex };
  }

  function chunkPackets(packets, perRequest) {
    const size = Math.max(1, Math.min(perRequest || MAX_PACKETS_PER_REQUEST, MAX_PACKETS_PER_REQUEST));
    const batches = [];
    for (let i = 0; i < packets.length; i += size) batches.push(packets.slice(i, i + size));
    return batches;
  }

  // ------------------------------------------------------------- cue building

  function clampText(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  // Keep raw model/provider text separate from display cleanup. Punctuation
  // and line structure must remain recoverable for review and export.
  function rawText(value) {
    return String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim();
  }

  /**
   * One recognized segment -> one cue.
   *
   * The translation, when it exists, rides on the cue as ``trans`` exactly
   * like an aligned page caption, so the overlay's own order rule decides which
   * line is on top. A segment whose translation failed keeps the original text
   * and simply has no translation line, which is what "translation failed,
   * still show the original" means on screen.
   */
  function cueFromSegment(segment) {
    if (!segment || typeof segment !== "object") return null;
    const text = clampText(segment.original);
    const german = clampText(segment.german);
    const start = segment.startMs, end = segment.endMs;
    // Malformed media coordinates cannot be repaired with arrival time or 0.
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start ||
        end > 86400000 || !text || text.length > 2000 || german.length > 2000) return null;
    const startMs = Math.round(start), endMs = Math.round(end);
    if (endMs <= startMs) return null;
    const epoch = segment.timelineEpoch === undefined ? 0 : segment.timelineEpoch;
    const revision = segment.revision === undefined ? 0 : segment.revision;
    if (!Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(revision) || revision < 0) return null;
    const cue = {
      id: String(segment.segmentId || ""),
      start: startMs,
      dur: Math.max(0, endMs - startMs),
      end: endMs,
      text,
      revision,
      epoch,
      provisional: !!segment.provisional,
      // A German rendering of a Chinese sentence is a translation, not the
      // uploader's caption, and it does not carry per-word times: the source
      // word times belong to the Chinese audio and must never be shown as
      // German pronunciation timing.
      sourceLang: String(segment.sourceLanguage || ""),
      backend: String(segment.translationBackend || ""),
      // Empty on revisions without usable timing, so a text revision clears
      // old words instead of retaining timings from a different transcript.
      words: [],
      wordTimingSource: "recognition",
      rawOriginal: rawText(segment.rawOriginal || text),
      uncertain: segment.uncertain === true,
      uncertaintyReasons: Array.isArray(segment.uncertaintyReasons)
        ? segment.uncertaintyReasons.filter(reason => ["low_log_probability", "possible_non_speech", "scores_unavailable", "low_word_probability"].includes(reason)) : [],
      translationGroupIds: Array.isArray(segment.translationGroupIds)
        ? segment.translationGroupIds.slice(0, 3).map(String) : [],
    };
    if (!segment.provisional && Array.isArray(segment.words) && segment.words.length <= 256) {
      let previous = startMs;
      const words = [];
      for (const word of segment.words) {
        if (!word || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs) ||
            word.startMs < previous || word.endMs <= word.startMs || word.endMs > endMs ||
            !clampText(word.text) || !Number.isFinite(word.probability) ||
            word.probability < 0.25 || word.probability > 1) { words.length = 0; break; }
        words.push({ u: clampText(word.text), t: word.startMs, e: word.endMs, s: "recognition" });
        previous = word.endMs;
      }
      cue.words = words;
    }
    if (german && german !== text) {
      cue.trans = german;
      cue.translationFailed = !!segment.translationFailed;
    } else if (german && german === text) {
      // German source: the recognized text IS the answer, so there is nothing
      // to translate and nothing to mark as missing.
      cue.translationFailed = false;
    } else {
      // The translation did not arrive. The cue still carries the recognized
      // original — never the other way round — and is marked so the caller can
      // retry it instead of showing an empty second line.
      cue.translationFailed = !!segment.translationFailed;
    }
    return cue;
  }

  /**
   * Merge newly polled segments into the caption list.
   *
   * The bridge revises a segment in place (same ``segmentId``, higher
   * ``revision``): the original text appears first, the translation follows.
   * A revision therefore REPLACES the cue it belongs to instead of adding a
   * second line, and an older revision that arrives late never overwrites a
   * newer one.
   */
  const removedRevisions = new WeakMap();
  function mergeSegments(cues, segments) {
    // Most polls carry status/metrics only. Preserve the list and its removal
    // history without indexing, allocating or sorting the entire transcript.
    if (!segments || !segments.length) return { cues: cues || [], added: 0, updated: 0 };
    const byId = new Map();
    const tombstones = new Map(removedRevisions.get(cues) || []);
    for (const cue of cues || []) {
      const key = cue.epoch + ":" + (cue.id || "start:" + cue.start);
      byId.set(key, cue);
    }
    let added = 0;
    let updated = 0;
    for (const segment of segments || []) {
      if (segment?.removed === true && typeof segment.segmentId === "string" &&
          Number.isSafeInteger(segment.timelineEpoch) && segment.timelineEpoch >= 0 &&
          Number.isSafeInteger(segment.revision) && segment.revision >= 0) {
        const key = segment.timelineEpoch + ":" + segment.segmentId;
        const existing = byId.get(key);
        if (segment.revision > (tombstones.get(key) ?? -1) &&
            (!existing || segment.revision > (existing.revision || 0))) {
          tombstones.set(key, segment.revision);
          if (existing) { byId.delete(key); updated += 1; }
        }
        continue;
      }
      const cue = cueFromSegment(segment);
      if (!cue) continue;
      const key = cue.epoch + ":" + (cue.id || "start:" + cue.start);
      if ((tombstones.get(key) ?? -1) >= cue.revision) continue;
      const existing = byId.get(key);
      if (existing) {
        // Keep the newer revision; drop a stale one rather than letting a late
        // answer flicker the line back to its untranslated text. The same
        // revision is not news either: re-reading a segment the overlay is
        // already showing must not make the line repaint or the poller keep
        // asking for something that will never change.
        if ((existing.revision || 0) >= (cue.revision || 0)) continue;
        const merged = Object.assign({}, existing, cue);
        if (!cue.trans && existing.trans && cue.text === existing.text &&
            cue.sourceLang === existing.sourceLang) {
          // A revision that only carries the original must not erase a
          // translation already shown for the same segment.
          merged.trans = existing.trans;
          merged.translationFailed = existing.translationFailed;
        } else if (!cue.trans) {
          delete merged.trans;
        }
        byId.set(key, merged);
        updated += 1;
      } else {
        byId.set(key, cue);
        added += 1;
      }
    }
    while (tombstones.size > 10000) tombstones.delete(tombstones.keys().next().value);
    if (!added && !updated) {
      const list = cues || [];
      removedRevisions.set(list, tombstones);
      return { cues: list, added, updated };
    }
    const list = [...byId.values()];
    list.sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
    removedRevisions.set(list, tombstones);
    return { cues: list, added, updated };
  }

  /**
   * Cues that are still only an original line and may gain a translation.
   *
   * Only a provisional cue or one whose translation has not been decided yet
   * counts: a cue the bridge already marked as failed has had its attempt, so
   * the caller polls for the rest of the batch instead of waiting on it.
   */
  function pendingTranslation(cues) {
    return (cues || []).some(
      (cue) =>
        cue.provisional ||
        (!cue.trans && !cue.translationFailed && cue.sourceLang && cue.sourceLang !== "de")
    );
  }

  const SRT_TIME = (ms) => {
    const total = Math.max(0, Math.round(Number(ms) || 0));
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor((total % 3600000) / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return (
      String(hours).padStart(2, "0") + ":" +
      String(minutes).padStart(2, "0") + ":" +
      String(seconds).padStart(2, "0") + "," +
      String(millis).padStart(3, "0")
    );
  };

  /**
   * Recognized captions as an SRT file. The German line is written FIRST so a
   * player that shows every block shows the translation above the original,
   * the same order the overlay uses on Bilibili.
   *
   * Two players read the first line differently — VLC takes it as the primary
   * subtitle, a plain text editor as the translation — but the ORDER is the
   * promise: German above, original below. A machine that renders it the other
   * way would be showing the Chinese line where the German one was asked for.
   */
  function toSrt(cues) {
    const list = (cues || []).slice().sort((a, b) => a.start - b.start);
    const blocks = [];
    list.forEach((cue, index) => {
      const text = clampText(cue.text);
      const trans = clampText(cue.trans);
      if (!text && !trans) return;
      const endMs = Math.max(cue.start + 1, cue.end || cue.start + (cue.dur || 0));
      const lines = [];
      if (trans) lines.push(trans);
      if (text && text !== trans) lines.push(text);
      blocks.push(
        String(index + 1) + "\n" + SRT_TIME(cue.start) + " --> " + SRT_TIME(endMs) + "\n" +
        lines.join("\n")
      );
    });
    return blocks.length ? blocks.join("\n\n") + "\n" : "";
  }

  // ------------------------------------------------------------------- client

  /**
   * A client for one bridge base URL. ``fetchImpl`` is injected so the tests can
   * run without a network; every method resolves to parsed JSON or throws a
   * BridgeError carrying the bridge's own error code.
   */
  function createClient(options) {
    const settings = options || {};
    const fetchImpl = settings.fetch || (typeof fetch === "function" ? fetch : null);
    if (!fetchImpl) throw new Error("bridge client needs fetch");
    const base = baseUrlOf(settings.base);
    const token = String(settings.token == null ? "" : settings.token);

    const headers = () => (token ? { Authorization: "Bearer " + token } : {});
    const url = (path) => base + path;

    return {
      base,
      token,
      health() {
        // /v1/health is the one route the bridge serves without a token, but it
        // is sent anyway: a bridge behind a stricter guard must still answer,
        // and an unauthenticated probe that silently failed would look like an
        // offline service.
        return request(
          fetchImpl,
          url("/v1/health"),
          { method: "GET", headers: headers() },
          HEALTH_TIMEOUT_MS
        );
      },
      getSettings() {
        return request(fetchImpl, url("/v1/settings"),
          { method: "GET", headers: headers() }, REQUEST_TIMEOUT_MS);
      },
      updateSettings(patch) {
        return request(fetchImpl, url("/v1/settings"),
          { method: "POST", headers: headers(), body: JSON.stringify(patch) }, REQUEST_TIMEOUT_MS);
      },
      retrySegment(sessionId, segmentId, timelineEpoch) {
        return request(fetchImpl, url("/v1/session/" + encodeURIComponent(sessionId) + "/retry"),
          { method: "POST", headers: headers(), body: JSON.stringify({ segmentId, timelineEpoch }) }, REQUEST_TIMEOUT_MS);
      },
      createSession(fields) {
        return request(
          fetchImpl,
          url("/v1/session"),
          { method: "POST", headers: headers(), body: JSON.stringify(sessionRequest(fields)) },
          REQUEST_TIMEOUT_MS
        );
      },
      sendAudio(sessionId, packets, extra) {
        const body = Object.assign(
          { packets: packets || [], flush: false, streamComplete: false },
          extra || {}
        );
        return request(
          fetchImpl,
          url("/v1/session/" + encodeURIComponent(sessionId) + "/audio"),
          { method: "POST", headers: headers(), body: JSON.stringify(body) },
          REQUEST_TIMEOUT_MS
        );
      },
      transcript(sessionId, sinceRevision, waitSeconds) {
        return request(
          fetchImpl,
          url("/v1/session/" + encodeURIComponent(sessionId) + "/transcript"),
          {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({
              sinceRevision: Math.max(0, Math.round(Number(sinceRevision) || 0)),
              waitSeconds: Math.max(0, Math.min(25, Number(waitSeconds) || 0)),
            }),
          },
          // A server-side wait can legitimately outlast the default timeout.
          REQUEST_TIMEOUT_MS + Math.min(25, Number(waitSeconds) || 0) * 1000
        );
      },
      finish(sessionId, packets) {
        return request(
          fetchImpl,
          url("/v1/session/" + encodeURIComponent(sessionId) + "/finish"),
          {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ packets: packets || [], flush: true, streamComplete: true }),
          },
          REQUEST_TIMEOUT_MS
        );
      },
      close(sessionId) {
        return request(
          fetchImpl,
          url("/v1/session/" + encodeURIComponent(sessionId)),
          { method: "DELETE", headers: headers() },
          HEALTH_TIMEOUT_MS
        );
      },
    };
  }

  /**
   * Speak the whole protocol for one video: open, send, poll, finish.
   *
   * The caller supplies the audio as already-encoded PCM (whoever has the
   * AudioContext does the decoding) and a ``onUpdate`` callback for captions as
   * they change. Nothing here reads a clock: every time in the result comes
   * from the bridge, which took it from the video timeline the caller declared.
   */
  async function recognize(options) {
    const client = createClient(options);
    let cues = [];
    const audio = options.audio || {};
    const log = typeof options.onEvent === "function" ? options.onEvent : () => {};

    const session = await client.createSession({
      platform: options.platform,
      videoKey: options.videoKey,
      captionAvailability: options.captionAvailability,
      sourceKind: options.sourceKind || "tab_capture",
      sourceLanguage: options.sourceLanguage || "auto",
      translationTarget: options.translationTarget || "de",
      timelineEpoch: options.timelineEpoch || 0,
      audioStartMs: options.audioStartMs,
      playbackRate: options.playbackRate,
      title: options.title,
      url: options.url,
      durationMs: options.durationMs,
      hasAudioTrack: options.hasAudioTrack,
      sampledPackets: options.sampledPackets,
      observedTextChars: options.observedTextChars,
    });
    log({ type: "session", session });
    if (session.recognize === false) {
      // The bridge is the second gate: a video with captions never reaches the
      // recognizer even if the caller asked for it.
      return { cues, revision: 0, status: "refused", reason: session.reason, session };
    }

    const sessionId = session.sessionId;
    const submitted = packetize(audio.bytes || new Uint8Array(0), {
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      audioStartMs: options.audioStartMs,
      timelineEpoch: options.timelineEpoch || 0,
      playbackRate: options.playbackRate,
      language: options.sourceLanguage || "auto",
      firstSampleIndex: options.firstSampleIndex || 0,
      firstSequence: 0,
    });
    let revision = 0;
    let status = "recognizing";
    let translationBackend = "";
    const report = (response) => {
      if (!response) return { added: 0, updated: 0 };
      revision = Math.max(revision, Number(response.revision) || 0);
      status = response.status || status;
      translationBackend = response.translationBackend || translationBackend;
      const merged = mergeSegments(cues, response.segments);
      cues = merged.cues;
      if (merged.added || merged.updated) {
        log({ type: "cues", cues: cues.slice(), added: merged.added, updated: merged.updated, status });
      }
      return merged;
    };

    try {
      const batches = chunkPackets(submitted.packets, MAX_PACKETS_PER_REQUEST);
      for (let i = 0; i < batches.length; i++) {
        const last = i === batches.length - 1;
        // Poll while the audio is still going in, so the first lines can be
        // shown before the file has finished uploading.
        const polled = await client.transcript(sessionId, revision, 0);
        report(polled);
        report(await client.sendAudio(sessionId, batches[i], { flush: false }));
      }
      report(await client.finish(sessionId));
      // Drain the tail: the final utterance can only be published once the
      // segmenter has been told no more audio is coming.
      for (let attempt = 0; attempt < 240; attempt++) {
        const response = await client.transcript(sessionId, revision, attempt < 8 ? 1 : POLL_WAIT_SECONDS);
        const merged = report(response);
        if (response && response.status && TERMINAL_STATUSES.has(response.status) && !merged.added && !merged.updated) {
          status = response.status;
          break;
        }
        if (response && response.status && TERMINAL_STATUSES.has(response.status)) status = response.status;
      }
    } finally {
      if (!options.keepSession) {
        try { await client.close(sessionId); } catch (_e) { /* closing is best effort */ }
      }
    }

    return { cues, revision, status, translationBackend, session, droppedBytes: submitted.droppedBytes };
  }

  globalThis.YtdsBridge = {
    PROTOCOL_VERSION,
    DEFAULT_BASE,
    MAX_PACKETS_PER_REQUEST,
    MAX_PCM_BASE64_CHARS,
    PACKET_FRAMES,
    POLL_WAIT_SECONDS,
    CAPTIONS_PRESENT,
    CAPTIONS_ABSENT,
    CAPTIONS_UNKNOWN,
    BridgeError,
    baseUrlOf,
    maskToken,
    bytesToBase64,
    floatsToPcm16,
    sessionRequest,
    packetize,
    chunkPackets,
    cueFromSegment,
    mergeSegments,
    pendingTranslation,
    toSrt,
    SRT_TIME,
    createClient,
    recognize,
  };
})();
