// YT Dual Subs — media time for captured audio (extension side).
//
// The browser hands out tab audio as a continuous PCM stream; the video page
// knows where the sound is on the video timeline. Neither one alone gives a
// caption a time. This module is the join between them, and it is deliberately
// deaf to every clock except the video's own:
//
//   * `video.currentTime` is the authority. A snapshot is the page saying "at
//     this instant the media was HERE".
//   * between snapshots the position is carried forward at the playback rate
//     the page also reported — that is a measurement of the video, not a clock
//     reading, and it is thrown away the moment a newer snapshot contradicts
//     it.
//   * the moment snapshots stop agreeing with each other, the mapping is
//     broken and the epoch is bumped, so the recognizer can never be handed a
//     caption that stitches two separated pieces of sound into one sentence.
//
// Nothing here uses Date.now() as a source of media time. Wall-clock time is
// only ever a coordinate for comparing one snapshot with the next.
(function () {
  "use strict";
  if (globalThis.YtdsMediaClock) return;

  const DEFAULT_TOLERANCE_MS = 350;
  const DEFAULT_MIN_GAP_MS = 1500;
  const RATE_EPSILON = 0.001;

  class MediaClock {
    /**
     * @param {{toleranceMs?: number, minGapMs?: number}} [options]
     */
    constructor(options) {
      const settings = options || {};
      this.toleranceMs = Math.max(0, Number(settings.toleranceMs));
      if (!isFinite(this.toleranceMs) || !this.toleranceMs) this.toleranceMs = DEFAULT_TOLERANCE_MS;
      this.minGapMs = Math.max(0, Number(settings.minGapMs));
      if (!isFinite(this.minGapMs) || !this.minGapMs) this.minGapMs = DEFAULT_MIN_GAP_MS;

      this.snapshotMs = null;   // media ms at the moment of the last page report
      this.atMs = null;         // wall ms of that same report
      this.rate = 1;
      this.paused = true;
      this.epoch = 0;
    }

    /** Has the page told us anything at all yet? */
    get ready() {
      return this.snapshotMs !== null && this.atMs !== null;
    }

    /**
     * Accept one report from the page.
     *
     * @param {{mediaMs: number, wallMs: number, rate?: number, paused?: boolean,
     *          epoch?: number}} report
     * @returns {{epoch: number, jumped: boolean, rateChanged: boolean,
     *            resumed: boolean, restarted: boolean}}
     */
    observe(report) {
      const mediaMs = Number(report && report.mediaMs);
      const wallMs = Number(report && report.wallMs);
      if (!isFinite(mediaMs) || !isFinite(wallMs)) {
        return this.verdict(false, false, false, false);
      }
      const rate = Number(report.rate);
      const nextRate = isFinite(rate) && rate > 0 ? rate : 1;
      const paused = !!report.paused;
      const declared = report.epoch;

      if (!this.ready) {
        this.snapshotMs = mediaMs;
        this.atMs = wallMs;
        this.rate = nextRate;
        this.paused = paused;
        if (isFinite(Number(declared))) this.epoch = Math.max(0, Math.round(Number(declared)));
        return this.verdict(false, false, false, true);
      }

      const rateChanged = Math.abs(nextRate - this.rate) > RATE_EPSILON;
      const predicted = this.predict(wallMs);
      // While paused the media does not move, so a mismatch means the page
      // jumped somewhere else (a seek, a part change) rather than drifted.
      const drifted = Math.abs(mediaMs - predicted) > this.toleranceMs ||
        (paused && Math.abs(mediaMs - predicted) > 0);
      const jumped = drifted || (isFinite(Number(declared)) && Math.round(Number(declared)) !== this.epoch);
      const resumed = this.paused && !paused;
      const gapMs = resumed ? Math.max(0, wallMs - this.atMs) : 0;

      if (jumped || rateChanged) this.epoch += 1;
      if (isFinite(Number(declared)) && Math.round(Number(declared)) > this.epoch) {
        this.epoch = Math.round(Number(declared));
      }
      this.snapshotMs = mediaMs;
      this.atMs = wallMs;
      this.rate = nextRate;
      this.paused = paused;

      // Returning from a pause is a restart in its own right once the pause was
      // long enough to hide a real discontinuity under it: the sound we are
      // about to receive does not continue the sound we stopped receiving.
      const restarted = jumped || rateChanged || (resumed && gapMs >= this.minGapMs);
      return this.verdict(jumped, rateChanged, resumed && gapMs >= this.minGapMs, restarted);
    }

    /**
     * The media time a piece of audio arriving NOW belongs to. Null until the
     * page has reported once: guessing would put a caption at the wrong second,
     * and a missing caption is better than a wrong one.
     *
     * @param {number} nowMs wall-clock instant the audio arrived
     */
    mediaAt(nowMs) {
      if (!this.ready) return null;
      return this.predict(Number(nowMs));
    }

    /** What the page's own report implies the position is at `wallMs`. */
    predict(wallMs) {
      if (!this.ready) return null;
      const elapsed = Math.max(0, Number(wallMs) - this.atMs);
      if (this.paused) return this.snapshotMs;
      return this.snapshotMs + elapsed * this.rate;
    }

    /**
     * How far the audio may sit from the last report before the mapping stops
     * being believable. Computed from the tolerance the clock was built with.
     */
    get slackMs() {
      return this.toleranceMs;
    }

    reset() {
      this.snapshotMs = null;
      this.atMs = null;
      this.rate = 1;
      this.paused = true;
      this.epoch = 0;
    }

    verdict(jumped, rateChanged, resumed, restarted) {
      return {
        epoch: this.epoch,
        jumped: !!jumped,
        rateChanged: !!rateChanged,
        resumed: !!resumed,
        restarted: !!restarted,
      };
    }
  }

  globalThis.YtdsMediaClock = { MediaClock, DEFAULT_TOLERANCE_MS, DEFAULT_MIN_GAP_MS };
})();
