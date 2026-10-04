// PCM health is separate from ASR confidence: sound is not proof of speech.
(function () {
  "use strict";
  if (globalThis.YtdsCaptureHealth) return;
  const SIGNAL_FLOOR = 1 / 32768;
  class CaptureHealth {
    constructor() {
      this.frames = 0;
      this.peak = 0;
      this.rms = 0;
      this.activeSince = null;
      this.lastPacketAt = null;
      this.lastSignalAt = null;
      this.paused = true;
      this.epoch = null;
    }
    playback({ paused, epoch, atMs }) {
      if (!Number.isFinite(atMs)) return;
      if (this.paused !== !!paused || this.epoch !== epoch) {
        this.activeSince = paused ? null : atMs;
        this.lastPacketAt = null;
        this.lastSignalAt = null;
        this.peak = this.rms = 0;
      }
      this.paused = !!paused;
      this.epoch = epoch;
    }
    observe(samples, atMs) {
      if (!samples?.length || !Number.isFinite(atMs)) return;
      let peak = 0, sum = 0, count = 0;
      for (const sample of samples) {
        if (!Number.isFinite(sample)) continue;
        const value = Math.max(-1, Math.min(1, sample));
        peak = Math.max(peak, Math.abs(value));
        sum += value * value;
        count += 1;
      }
      if (!count) return;
      this.frames = Math.min(Number.MAX_SAFE_INTEGER, this.frames + count);
      this.peak = peak;
      this.rms = Math.sqrt(sum / count);
      this.lastPacketAt = atMs;
      if (!this.paused && peak >= SIGNAL_FLOOR) this.lastSignalAt = atMs;
    }
    snapshot({ nowMs, contextState, mediaFresh = true }) {
      const elapsed = at => at === null ? 0 : Math.max(0, nowMs - at);
      const silenceMs = this.paused ? 0 : elapsed(this.lastSignalAt ?? this.activeSince);
      let state;
      if (this.paused) state = "paused";
      else if (!mediaFresh) state = "waiting_media";
      else if (contextState !== "running") state = "suspended";
      else if (elapsed(this.lastPacketAt ?? this.activeSince) >= 3000) state = "missing";
      else if (silenceMs >= 8000) state = "silent";
      else if (this.lastSignalAt !== null && elapsed(this.lastSignalAt) < 1500) state = "signal";
      else state = "waiting";
      return { state, frames: this.frames, peak: this.peak, rms: this.rms,
        silenceMs: Number.isFinite(silenceMs) ? Math.round(silenceMs) : 0 };
    }
  }
  globalThis.YtdsCaptureHealth = { CaptureHealth };
})();
