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
    if (!/^[0-9a-f]{8}$/.test(record.cuesKey || "") ||
        !Number.isInteger(record.version) || record.version < 1 ||
        typeof record.model !== "string" || !record.model.length || record.model.length > 200 ||
        !Number.isFinite(record.offsetMs) || record.offsetMs < 0) throw new Error("invalidAudioTiming");
    const checked = record.segments.map(s => ({ start: s?.start, dur: s?.dur, text: s?.text }));
    YtdsWordTiming.applyAudio(checked, record.segments, record.sourceLang);
    const segments = checked.filter(s => s.wordTimingSource === "audio");
    if (!segments.length) throw new Error("invalidAudioTiming");
    const value = { videoId: record.videoId, sourceLang: record.sourceLang,
      cuesKey: record.cuesKey, model: record.model, version: record.version,
      offsetMs: record.offsetMs, segments };
    if (JSON.stringify(value).length > MAX_BYTES / 2) throw new Error("audioCacheTooLarge");
    const saved = await chrome.storage.local.get(KEY);
    const records = Array.isArray(saved[KEY]) ? saved[KEY] : [];
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
