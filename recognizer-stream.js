// YT Dual Subs — one live recognition session (extension side).
//
// This is the piece that turns a stream of captured PCM into captions while the
// video keeps playing. Three things make it more than a wrapper around the HTTP
// calls:
//
//   * it never sends audio it cannot place on the video timeline. Until the
//     page has reported where the video is, frames are held, not stamped with
//     an invented time.
//   * it follows the bridge's own revision counter and hands every batch of
//     NEW OR CHANGED sentences to the caller, so the overlay can correct a
//     sentence in place instead of appending a duplicate.
//   * when the timeline jumps (a seek, a rate change, a resume after a pause)
//     it says so, and the bridge starts a new stream rather than stitching two
//     separated pieces of sound into one sentence.
(function () {
  "use strict";
  if (globalThis.YtdsRecognizerStream) return;

  const FLUSH_PACKETS = 8;         // send as soon as this many packets wait
  const FLUSH_INTERVAL_MS = 400;   // ...or this long, whichever comes first
  const MAX_QUEUED_PACKETS = 32;   // beyond this we are behind: drop, and say so
  const POLL_WAIT_SECONDS = 1;
  const MAX_FLUSH_FAILURES = 3;

  class RecognizerSession {
    /**
     * @param {{
     *   bridge: object,                    // createClient(...) result
     *   clock: object,                     // MediaClock
     *   platform?: string, videoKey: string, captionAvailability: string,
     *   sourceLanguage?: string, title?: string, url?: string,
     *   durationMs?: number, hasAudioTrack?: boolean,
     *   sampleRate: number, channels?: number,
     *   framesPerPacket?: number,
     *   onUpdate?: (payload: object) => void,
     *   onState?: (payload: object) => void,
     *   now?: () => number,
     * }} options
     */
    constructor(options) {
      const settings = options || {};
      if (!settings.bridge) throw new Error("RecognizerSession needs a bridge client");
      if (!settings.clock) throw new Error("RecognizerSession needs a media clock");
      this.bridge = settings.bridge;
      this.clock = settings.clock;
      this.platform = settings.platform || "";
      this.videoKey = settings.videoKey || "";
      this.captionAvailability = settings.captionAvailability || "";
      this.sourceLanguage = settings.sourceLanguage || "auto";
      this.title = settings.title || "";
      this.url = settings.url || "";
      this.durationMs = settings.durationMs;
      this.hasAudioTrack = settings.hasAudioTrack !== false;
      this.sampleRate = Math.max(1, Math.round(Number(settings.sampleRate) || 48000));
      this.channels = settings.channels === 2 ? 2 : 1;
      this.framesPerPacket = settings.framesPerPacket;
      this.onUpdate = typeof settings.onUpdate === "function" ? settings.onUpdate : () => {};
      this.onState = typeof settings.onState === "function" ? settings.onState : () => {};
      this.now = typeof settings.now === "function" ? settings.now : () => Date.now();

      this.sessionId = "";
      this.revision = 0;
      this.status = "";
      this.cues = [];
      this.sequence = 0;
      this.sampleIndex = 0;
      this.queued = [];
      this.dropped = 0;
      this.flushFailures = 0;
      this.stopped = false;
      this.startedAt = this.now();
      this.lastFlushAt = 0;
      this.writeChain = Promise.resolve();
      this.timer = null;
      this.restartPending = false;
      this.epoch = this.clock.epoch || 0;
      this.audioStartMs = null;
    }

    start() {
      const audioStartMs = this.clock.ready ? this.clock.mediaAt(this.now()) : null;
      this.audioStartMs = audioStartMs;
      const fields = {
        platform: this.platform,
        videoKey: this.videoKey,
        captionAvailability: this.captionAvailability,
        sourceKind: "tab_capture",
        sourceLanguage: this.sourceLanguage,
        timelineEpoch: this.epoch,
        title: this.title,
        url: this.url,
        durationMs: this.durationMs,
        hasAudioTrack: this.hasAudioTrack,
        playbackRate: this.clock.rate,
      };
      if (this.clock.ready) fields.audioStartMs = Math.max(0, Math.round(audioStartMs));
      const opened = this.bridge.createSession(fields).then((session) => {
        if (this.stopped) return session;
        this.sessionId = session && session.sessionId ? session.sessionId : "";
        this.status = "recognizing";
        this.emitState("running");
        // A refused session is a normal answer, not a failure: the bridge is
        // telling us this video has captions and recognition must not run.
        if (!this.sessionId || session.recognize === false) {
          this.stopped = true;
          this.stopTimer();
          this.emitState("refused", { reason: (session && session.reason) || "refused" });
        }
        return session;
      });
      this.queue(opened);
      this.timer = setInterval(() => this.tick(), FLUSH_INTERVAL_MS);
      if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
      return opened;
    }

    /**
     * The page reports where the video is. Every report goes through the media
     * clock; a jump or a rate change is carried to the bridge with the next
     * packet, so the bridge never measures a new stream against the old one.
     */
    observe(report) {
      const verdict = this.clock.observe(report);
      if (verdict.restarted) {
        this.pendingVerdict = verdict;
        this.restartPending = true;
      }
      this.epoch = verdict.epoch;
      return verdict;
    }

    get mediaMs() {
      return this.clock.ready ? this.clock.mediaAt(this.now()) : null;
    }

    /**
     * One block of captured audio. `atMs` is the wall-clock instant the block
     * was captured; the media time it belongs to is asked of the clock here and
     * nowhere else.
     */
    pushPcm(bytes, options) {
      if (this.stopped) return { queued: 0, mediaMs: null };
      const settings = options || {};
      if (settings.awaitingClock) return { queued: 0, mediaMs: null };
      const atMs = Number.isFinite(Number(settings.atMs)) ? Number(settings.atMs) : this.now();
      const mediaMs = this.clock.mediaAt(atMs);
      if (mediaMs === null) {
        // No page report has arrived yet. Holding the audio is harmless; the
        // stream is continuous, so nothing is lost by waiting a moment.
        return { queued: 0, mediaMs: null, waiting: true };
      }
      const verdict = this.pendingVerdict || null;
      const built = globalThis.YtdsBridge.packetize(bytes, {
        sampleRate: this.sampleRate,
        channels: this.channels,
        framesPerPacket: this.framesPerPacket,
        language: this.sourceLanguage,
        // The counter belongs to the SESSION, not to the current stream: the
        // bridge compares a packet against the position it last buffered, and
        // it is the declared epoch (and the media time this packet announces)
        // that tells it a new stream has begun.
        firstSampleIndex: this.sampleIndex,
        firstSequence: this.sequence,
        audioStartMs: Math.max(0, Math.round(mediaMs)),
        timelineEpoch: this.epoch,
        playbackRate: this.clock.rate,
      });
      this.pendingVerdict = null;
      this.sampleIndex = built.nextSampleIndex;
      this.sequence += built.packets.length;
      for (const packet of built.packets) this.queued.push(packet);
      if (this.queued.length > MAX_QUEUED_PACKETS) {
        // The recognizer cannot keep up with the video. Dropping the OLDEST
        // audio keeps what is being said now, which is what a viewer reads;
        // the count is reported so nothing pretends the transcript is whole.
        const excess = this.queued.length - MAX_QUEUED_PACKETS;
        this.queued.splice(0, excess);
        this.dropped += excess;
      }
      return { queued: this.queued.length, mediaMs, dropped: this.dropped };
    }

    tick() {
      if (this.stopped) return;
      if (this.queued.length) this.flush();
      this.poll();
    }

    /** Send everything waiting, in the bridge's own 16-packet batches. */
    flush() {
      if (!this.sessionId || !this.queued.length) return Promise.resolve();
      const batch = this.queued.splice(0, globalThis.YtdsBridge.MAX_PACKETS_PER_REQUEST);
      this.lastFlushAt = this.now();
      const work = () => this.bridge.sendAudio(this.sessionId, batch).then((response) => {
        this.consume(response);
      }).catch((error) => {
        // The batch could not be delivered, so put it back: dropping audio that
        // was never recognized would leave a hole in the transcript that
        // nothing later could fill.
        if (batch.length) this.queued.unshift(...batch);
        this.flushFailures += 1;
        this.emitState("degraded", { message: String(error && error.message || error), failures: this.flushFailures });
        if (this.flushFailures >= MAX_FLUSH_FAILURES) {
          this.emitState("failed", { message: String(error && error.message || error) });
        }
      });
      this.queue(work);
      // The caller needs a promise for THIS batch, not just for the chain: a
      // caller that awaits the chain itself would race with its own work.
      return work;
    }

    /** Ask for everything recognized since the last revision we saw. */
    poll(waitSeconds) {
      if (!this.sessionId) return Promise.resolve(null);
      const wait = waitSeconds === undefined ? POLL_WAIT_SECONDS : waitSeconds;
      const work = () => this.bridge.transcript(this.sessionId, this.revision, wait)
        .then((response) => { this.consume(response); return response; })
        .catch(() => null);
      return this.queue(work);
    }

    /**
     * The bridge answers with the segments changed since `revision`. Cues are
     * merged by sentence, and only genuinely new or corrected ones are handed
     * on: a revision that changes nothing must not make the overlay stutter.
     */
    consume(response) {
      if (!response) return { added: 0, updated: 0 };
      this.revision = Math.max(this.revision, Number(response.revision) || 0);
      if (response.status) this.status = response.status;
      const merged = globalThis.YtdsBridge.mergeSegments(this.cues, response.segments);
      this.cues = merged.cues;
      if (merged.added || merged.updated) {
        this.onUpdate({
          cues: this.cues.slice(),
          added: merged.added,
          updated: merged.updated,
          revision: this.revision,
          status: this.status,
        });
      }
      return merged;
    }

    /** Stop feeding audio and let the recognizer publish its final utterance. */
    async finish() {
      if (this.stopped) return { cues: this.cues, revision: this.revision, status: this.status };
      const sessionId = this.sessionId;
      if (!sessionId) {
        this.stopped = true;
        this.stopTimer();
        return { cues: this.cues, revision: this.revision, status: this.status };
      }
      const work = async () => {
        // Everything still queued belongs to this session, and the session id
        // is cleared on the way out: a flush that ran after that would post to
        // /v1/session//audio and lose the audio silently.
        try {
          if (this.queued.length) await this.flush();
          const response = await this.bridge.finish(sessionId);
          this.consume(response);
        } catch (_e) { /* the tail is best effort; the cues so far stand */ }
        // Drain: the last utterance is only published once the bridge knows no
        // more audio is coming.
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const response = await this.bridge.transcript(sessionId, this.revision, 1).catch(() => null);
          const merged = this.consume(response);
          if (response && (response.status === "ready" || response.status === "empty") &&
              !merged.added && !merged.updated) break;
        }
        try { await this.bridge.close(sessionId); } catch (_e) { /* best effort */ }
        this.sessionId = "";
      };
      await this.queue(work);
      this.stopped = true;
      this.stopTimer();
      this.emitState("stopped");
      return { cues: this.cues, revision: this.revision, status: this.status };
    }

    stopTimer() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }

    /** Serialize writes: one request in flight, always in order. */
    queue(work) {
      const next = this.writeChain.then(() => work());
      this.writeChain = next.catch(() => {});
      return next;
    }

    emitState(state, extra) {
      this.onState(Object.assign({
        state,
        sessionId: this.sessionId,
        revision: this.revision,
        status: this.status,
        cueCount: this.cues.length,
        dropped: this.dropped,
      }, extra || {}));
    }
  }

  globalThis.YtdsRecognizerStream = {
    RecognizerSession,
    FLUSH_PACKETS,
    FLUSH_INTERVAL_MS,
    MAX_QUEUED_PACKETS,
    MAX_FLUSH_FAILURES,
  };
})();
