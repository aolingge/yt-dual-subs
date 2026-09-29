// Optional alignment results live locally, separate from synced preferences.
// This file runs only in the service worker; reads in content.js are nonblocking.
(() => {
  "use strict";
  const KEY = "audioTimingCacheV1";
  const MAX_BYTES = 6 * 1024 * 1024;
  let pending = Promise.resolve();
  async function save(record) {
    if (!record || !/^[A-Za-z0-9_-]{11}$/.test(record.videoId || "") ||
        !/^(auto|de|en)(-[a-zA-Z0-9]+)*$/.test(record.sourceLang || "") ||
        !Array.isArray(record.segments) || record.segments.length > 5000) throw new Error("invalidAudioTiming");
    // Results are only reusable for the exact same subtitles, language, model,
    // algorithm version and audio offset that produced them.
    const wanted = YtdsWordTiming.AUDIO_RECORD_VERSION || 0;
    if (!/^[0-9a-f]{8}$/.test(record.cuesKey || "") ||
        !Number.isInteger(record.version) || record.version < (wanted || 1) ||
        typeof record.model !== "string" || !record.model.length || record.model.length > 200 ||
        !Number.isFinite(record.offsetMs) || record.offsetMs < 0) throw new Error("invalidAudioTiming");
    // Every sentence keeps the position in the track it was aligned at. The
    // batch is placed at those positions so the shared validity check runs
    // exactly as the renderer runs it: a batch the page would refuse is never
    // stored as a success.
    const cues = [];
    for (const s of record.segments) {
      if (!s || !Number.isInteger(s.index) || s.index < 0 || s.index > 5000 || cues[s.index]) {
        throw new Error("invalidAudioTiming");
      }
      cues[s.index] = { index: s.index, start: s.start, dur: s.dur, text: s.text };
    }
    if (!cues.length) throw new Error("invalidAudioTiming");
    YtdsWordTiming.applyAudio(cues, record.segments, record.sourceLang);
    const segments = cues.filter(s => s && s.wordTimingSource === "audio");
    if (!segments.length) throw new Error("invalidAudioTiming");
    const value = { videoId: record.videoId, sourceLang: record.sourceLang,
      cuesKey: record.cuesKey, model: record.model, version: record.version,
      offsetMs: record.offsetMs, segments };
    if (JSON.stringify(value).length > MAX_BYTES / 2) throw new Error("audioCacheTooLarge");
    const saved = await chrome.storage.local.get(KEY);
    // A record from an older algorithm version can never be applied again, so
    // writing new results also drops it instead of keeping dead weight.
    const records = (Array.isArray(saved[KEY]) ? saved[KEY] : [])
      .filter(r => !wanted || (Number.isInteger(r?.version) && r.version >= wanted));
    const same = r => r.videoId === value.videoId && r.sourceLang === value.sourceLang &&
      r.cuesKey === value.cuesKey && r.model === value.model && r.version === value.version &&
      r.offsetMs === value.offsetMs;
    const previous = records.find(same);
    if (Array.isArray(previous?.segments)) {
      const merged = new Map(previous.segments.map(s => [s.start + "\0" + s.text, s]));
      segments.forEach(s => merged.set(s.start + "\0" + s.text, s));
      value.segments = [...merged.values()].slice(-5000);
    }
    const next = records.filter(r => !same(r));
    next.push(value);
    while (next.length > 4 || JSON.stringify(next).length > MAX_BYTES / 2) next.shift();
    await chrome.storage.local.set({ [KEY]: next });
    return { ok: true, count: value.segments.length };
  }
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== "saveAudioTiming") return;
    pending = pending.catch(() => {}).then(() => save(msg.record));
    pending.then(reply, () => reply({ ok: false, reason: "audioCacheFailed" }));
    return true;
  });
})();
