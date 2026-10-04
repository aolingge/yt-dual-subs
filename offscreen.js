// offscreen.js — the tab-audio capture pipeline
//
// Capturing a tab takes its sound out of the speakers; the documented cure is
// to play the captured stream back through an AudioContext of our own. That
// graph has to outlive the popup (closing the popup would otherwise stop the
// recording), and it needs Web Audio that a service worker does not have — so
// it lives here, in an offscreen document the service worker creates on demand.
//
// The graph, and why it has these exact edges:
//
//     stream ──> MediaStreamSource ──> GainNode ──┬──> destination   (the user
//                                                  │                  hears it)
//                                                  └──> PcmChunker     (we
//                                                          │           hear it)
//                                                          v
//                                                mono s16le chunks
//
//   * ONE source, routed through a gain node, so the captured stream reaches the
//     speakers exactly once. Routing the source to both the worklet and the
//     destination would be the shortest way to an echo.
//   * the worklet emits silence, so the analysis branch adds no second copy.
//   * `ctx.resume()` is required: a fresh AudioContext may start suspended, and
//     a suspended context is a silent one.
//
// Media time is NOT invented here. The content script reports `video.currentTime`
// every 250 ms and on every play/pause/seek/rate change; MediaClock carries that
// position forward at the reported rate between reports and throws it away the
// moment a report contradicts it.
(function () {
  "use strict";

  let ctx = null;
  let stream = null;
  let source = null;
  let gain = null;
  let node = null;
  let clock = null;
  let session = null;
  let status = { state: "", message: "", videoKey: "", cueCount: 0 };
  let lastReport = null;
  let health = null;
  let healthTimer = null;
  let inputState = "";
  let trackHandlers = [];

  // The two objects a test needs to reach: the session (what the transcript is
  // made of) and the worklet node (where the audio comes in). Exposed for the
  // test harness only — nothing in the extension reads this.
  const debug = {};
  Object.defineProperty(globalThis, "__ytdsOffscreen", { value: debug, configurable: true });

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(response);
        });
      } catch (_e) { resolve(null); }
    });
  }

  function report(state, extra) {
    status = Object.assign({}, status, extra || {}, { state, audioInput: inputSnapshot() });
    send(Object.assign({ type: "recogState", state }, status));
  }

  function inputSnapshot() {
    return health ? health.snapshot({ nowMs: Date.now(), contextState: ctx?.state,
      mediaFresh: !!clock?.ready && Date.now() - clock.atMs <= 2500 }) : { state: "idle" };
  }

  function updateInputState() {
    const next = inputSnapshot().state;
    if (next !== inputState) {
      inputState = next;
      report(status.state);
    }
  }

  function captureEnded(activeSession) {
    if (session !== activeSession) return;
    session = null;
    teardown();
    report("failed", { message: "capture_ended" });
    // Keep captions already shown; discard late callbacks from this session.
    activeSession.finish().catch(() => {});
  }

  function teardown() {
    if (healthTimer !== null) { clearInterval(healthTimer); healthTimer = null; }
    for (const [track, handler] of trackHandlers) track.removeEventListener?.("ended", handler);
    trackHandlers = [];
    health = null;
    inputState = "";
    if (node) {
      try { node.port.postMessage({ type: "stop" }); } catch (_e) { /* already gone */ }
      try { node.disconnect(); } catch (_e) { /* already gone */ }
      node = null;
    }
    if (source) { try { source.disconnect(); } catch (_e) { /* already gone */ } source = null; }
    if (gain) { try { gain.disconnect(); } catch (_e) { /* already gone */ } gain = null; }
    if (stream) {
      for (const track of stream.getTracks()) { try { track.stop(); } catch (_e) { /* already gone */ } }
      stream = null;
    }
    if (ctx) {
      try { ctx.close(); } catch (_e) { /* already closed */ }
      ctx = null;
    }
    if (clock) { clock.reset(); }
  }

  async function openContext() {
    // No sampleRate option: the graph runs at the output device's rate, which is
    // the only rate Web Audio supports, and offscreen.js reports that rate back
    // so the bridge resamples from the truth instead of a guess.
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule("pcm-worklet.js");
    return ctx;
  }

  async function start(message) {
    if (session) return { ok: true, alreadyRunning: true };
    const info = message.context || {};
    status = { state: "starting", message: "", videoKey: info.videoKey || "", cueCount: 0,
      tabId: Number.isInteger(info.tabId) ? info.tabId : null, metrics: {}, warning: "" };
    if (info.captionAvailability !== "absent") {
      // Belt and braces: the popup gates the button, and the content script
      // gates the batch, but capture must not begin on a video that has
      // captions even if a message arrives from somewhere else.
      report("failed", { message: "captions_present", videoKey: info.videoKey || "" });
      return { ok: false, reason: "captions_present" };
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: message.streamId,
          },
        },
        video: false,
      });
    } catch (err) {
      report("failed", { message: "capture_" + String((err && err.name) || "failed"), videoKey: info.videoKey || "" });
      return { ok: false, reason: "capture", message: String((err && err.message) || err) };
    }

    try {
      await openContext();
    } catch (err) {
      teardown();
      report("failed", { message: "audio_context_failed", videoKey: info.videoKey || "" });
      return { ok: false, reason: "audio_context", message: String((err && err.message) || err) };
    }

    source = ctx.createMediaStreamSource(stream);
    gain = ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    // The captured sound goes back out to the user, once. See the graph note.
    gain.connect(ctx.destination);

    clock = new globalThis.YtdsMediaClock.MediaClock({});
    // Seed from the page context rechecked immediately before capture. A
    // recorder can open before its first periodic media report arrives.
    if (Number.isFinite(info.currentTimeMs) && info.currentTimeMs >= 0) {
      clock.observe({ mediaMs: info.currentTimeMs, wallMs: Date.now(),
        rate: info.playbackRate, paused: info.paused });
    } else if (lastReport && lastReport.videoId === info.videoKey) {
      clock.observe(lastReport);
    }
    if (!clock.ready) {
      teardown();
      report("failed", { message: "media_not_ready" });
      return { ok: false, reason: "media_not_ready" };
    }
    // One packet per second of audio at the context's rate. The bridge's own
    // packet cap is what limits a request, not this.
    const framesPerPacket = Math.max(1600, Math.round(ctx.sampleRate));
    health = new globalThis.YtdsCaptureHealth.CaptureHealth();
    health.playback({ paused: clock.paused, epoch: clock.epoch, atMs: Date.now() });
    const activeSession = new globalThis.YtdsRecognizerStream.RecognizerSession({
      bridge: globalThis.YtdsBridge.createClient({ base: info.bridgeBase, token: info.bridgeToken }),
      clock,
      platform: info.platform || "",
      videoKey: info.videoKey || "",
      captionAvailability: info.captionAvailability || "unknown",
      sourceLanguage: info.sourceLanguage || "zh",
      translationTarget: info.bridgeTranslationTarget || "de",
      title: info.title || "",
      url: info.url || "",
      durationMs: info.durationMs,
      hasAudioTrack: info.hasAudioTrack !== false,
      sampleRate: ctx.sampleRate,
      channels: 1,
      framesPerPacket,
      onUpdate: (payload) => {
        if (session !== activeSession) return;
        send({
          type: "recognizedCues",
          videoKey: info.videoKey || "",
          cues: payload.cues,
          revision: payload.revision,
          status: payload.status,
          added: payload.added,
          updated: payload.updated,
          sourceLang: info.sourceLanguage || "zh",
        });
      },
      onState: (payload) => {
        if (session !== activeSession) return;
        report(payload.state, {
          message: payload.message || "",
          videoKey: info.videoKey || "",
          cueCount: payload.cueCount || 0,
          dropped: payload.dropped || 0,
          metrics: payload.metrics || {},
          warning: payload.warning || "",
        });
      },
    });
    session = activeSession;

    const activeNode = new AudioWorkletNode(ctx, "pcm-chunker", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: "max",
      processorOptions: { flushMs: 100, language: info.sourceLanguage || "zh" },
    });
    node = activeNode;
    node.port.onmessage = (event) => {
      const data = event && event.data;
      if (!data || data.type !== "pcm" || !data.samples?.length ||
          session !== activeSession || node !== activeNode) return;
      health.observe(data.samples, Date.now());
      updateInputState();
      const bytes = globalThis.YtdsBridge.floatsToPcm16(data.samples);
      session.pushPcm(bytes, { atMs: Date.now() });
    };
    debug.node = node;
    debug.session = session;
    debug.ctx = ctx;
    debug.clock = clock;
    // The chunker's own output is silence, so this edge carries no audio.
    gain.connect(node);
    node.connect(ctx.destination);
    for (const track of stream.getTracks()) {
      if (track.kind !== "audio") continue;
      const handler = () => captureEnded(activeSession);
      track.addEventListener?.("ended", handler);
      trackHandlers.push([track, handler]);
    }

    await ctx.resume();
    if (session !== activeSession) return { ok: false, reason: "capture_ended" };
    try {
      const opened = await session.start();
      if (!opened?.sessionId || opened.recognize === false) {
        throw new YtdsBridge.BridgeError(opened?.recognize === false ? "captions_present" : "bad_response");
      }
    } catch (err) {
      teardown();
      session = null; // a failed connection must not make the next start "alreadyRunning"
      const code = (err && err.code) || "bridge_unreachable";
      report("failed", { message: code, videoKey: info.videoKey || "" });
      return { ok: false, reason: "bridge", code };
    }
    if (session !== activeSession) return { ok: false, reason: "capture_ended" };
    report("running", { videoKey: info.videoKey || "", message: "" });
    healthTimer = setInterval(updateInputState, 500);
    if (healthTimer && typeof healthTimer.unref === "function") healthTimer.unref();
    return { ok: true, sampleRate: ctx.sampleRate };
  }

  async function stop() {
    const cues = session ? session.cues : [];
    if (session) {
      try { await session.finish(); } catch (_e) { /* the cues so far stand */ }
      session = null;
    }
    teardown();
    report("", { message: "", videoKey: "" });
    send({ type: "recogStopped", cues, cueCount: cues.length });
    return { ok: true, cueCount: cues.length };
  }

  async function handleReport(message) {
    if (!clock || !message) return { ok: false };
    if (message.event === "stop") { await stop(); return { ok: true, stopped: true }; }
    lastReport = {
      mediaMs: Number(message.mediaMs),
      wallMs: Number(message.wallMs),
      rate: Number(message.rate),
      paused: !!message.paused,
      epoch: message.epoch,
    };
    if (!Number.isFinite(lastReport.mediaMs) || !Number.isFinite(lastReport.wallMs)) return { ok: false };
    const verdict = session ? session.observe(lastReport) : clock.observe(lastReport);
    health?.playback({ paused: clock.paused, epoch: clock.epoch, atMs: Date.now() });
    updateInputState();
    return { ok: true, epoch: verdict ? verdict.epoch : 0, restarted: !!(verdict && verdict.restarted) };
  }

  function snapshot() {
    return {
      state: status.state,
      message: status.message,
      videoKey: status.videoKey,
      tabId: status.tabId ?? null,
      cueCount: session ? session.cues.length : status.cueCount || 0,
      revision: session ? session.revision : 0,
      dropped: session ? session.dropped : 0,
      sampleRate: ctx ? ctx.sampleRate : 0,
      cues: session ? session.cues : [],
      epoch: clock ? clock.epoch : 0,
      metrics: session ? session.metrics : status.metrics || {},
      warning: session ? session.warning : status.warning || "",
      audioInput: inputSnapshot(),
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    if (!["mediaReport", "recogOffscreenStart", "recogOffscreenStop", "recogOffscreenStatus", "recogOffscreenRetry"].includes(message.type)) return;
    if (sender?.tab || (sender?.url && sender.url !== chrome.runtime.getURL("background.js"))) {
      sendResponse({ ok: false, reason: "forbidden" }); return;
    }
    if (message.type === "mediaReport") {
      // The panel's reports arrive on every tick, so the cheapest known-answer
      // check comes first: a report for another target is simply not ours.
      if (message.target !== "offscreen") { sendResponse({ ok: false, reason: "not_offscreen" }); return; }
      handleReport(message).then(sendResponse).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (message.type === "recogOffscreenRetry") {
      if (!session?.sessionId || message.timelineEpoch !== session.epoch) {
        sendResponse({ ok: false, code: "conflict" }); return;
      }
      session.queue(() => session.bridge.retrySegment(session.sessionId, message.segmentId, message.timelineEpoch))
        .then(sendResponse).catch(err => sendResponse({ ok: false, code: err?.code || "failed" }));
      return true;
    }
    if (message.type === "recogOffscreenStart") {
      start(message).then(sendResponse).catch(async () => {
        const previous = session;
        session = null;
        teardown();
        if (previous) { try { await previous.finish(); } catch (_e) {} }
        report("failed", { message: "audio_context_failed" });
        sendResponse({ ok: false, reason: "audio_context" });
      });
      return true;
    }
    if (message.type === "recogOffscreenStop") {
      stop().then(sendResponse).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (message.type === "recogOffscreenStatus") {
      sendResponse({ ok: true, status: snapshot() });
      return;
    }
  });
})();
