// Shared by the page bridge and the isolated renderer. No network or audio work.
((root) => {
  "use strict";
  const MAX_TEXT = 2000;
  const segmenters = new Map();
  function normalize(s, language) {
    const text = s.normalize("NFKC");
    try { return text.toLocaleLowerCase(language === "auto" ? undefined : language); }
    catch (_e) { return text.toLowerCase(); }
  }

  function tokens(text, language) {
    if (typeof text !== "string" || text.length > MAX_TEXT) return [];
    try {
      const locale = language === "auto" ? undefined : language;
      if (!segmenters.has(locale)) {
        segmenters.set(locale, new Intl.Segmenter(locale, { granularity: "word" }));
        if (segmenters.size > 8) segmenters.delete(segmenters.keys().next().value);
      }
      return [...segmenters.get(locale).segment(text)]
        .filter((p) => p.isWordLike)
        .map((p) => ({ text: p.segment, index: p.index, key: normalize(p.segment, language) }));
    } catch (_e) {
      return [...text.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu)]
        .map((m) => ({ text: m[0], index: m.index, key: normalize(m[0], language) }));
    }
  }

  // Attach punctuation/spacing to spans without altering the selected text.
  function piecesAt(text, parts, times) {
    return parts.map((p, i) => ({ t: times[i],
      u: text.slice(i === 0 ? 0 : p.index,
        i + 1 < parts.length ? parts[i + 1].index : text.length) }));
  }

  // Offsets must actually describe each lexical word. A segment containing a
  // whole phrase with one timestamp is not a set of individual word times.
  function captionPieces(cue, language) {
    if (!cue || !Array.isArray(cue.words) || cue.words.length > 256) return null;
    const text = String(cue.text || "");
    const parts = tokens(text, language);
    if (!parts.length) return null;
    const timed = [];
    let previous = -Infinity;
    for (const w of cue.words) {
      if (!w || !Number.isFinite(w.t) || w.t < previous) return null;
      previous = w.t;
      const words = tokens(String(w.u || ""), language);
      if (words.length > 1) return null;
      if (words.length) timed.push({ key: words[0].key, t: w.t, e: w.e });
    }
    if (timed.length !== parts.length ||
        parts.some((p, i) => p.key !== timed[i].key)) return null;
    const end = Number.isFinite(cue.end) ? cue.end : cue.start + cue.dur;
    if (!Number.isFinite(cue.start) || !Number.isFinite(end) ||
        timed.some((w) => w.t < cue.start - 100 || w.t >= end)) return null;
    const pieces = piecesAt(text, parts, timed.map((w) => w.t));
    if (cue.wordTimingSource === "audio") {
      if (timed.some((w, i) => !Number.isFinite(w.e) || w.e <= w.t || w.e > end ||
          (i + 1 < timed.length && w.e > timed[i + 1].t))) return null;
      pieces.forEach((p, i) => { p.e = timed[i].e; });
    }
    return pieces;
  }

  // This is display-only estimation, never written into the raw caption cues.
  function estimate(cue, language) {
    if (!cue) return null;
    const end = Number.isFinite(cue.end) ? cue.end : cue.start + cue.dur;
    if (!Number.isFinite(cue.start) || !Number.isFinite(end) || end <= cue.start) return null;
    const text = String(cue.text || "");
    const parts = tokens(text, language);
    if (!parts.length) return null;
    const weights = parts.map((p, i) => {
      const following = text.slice(p.index + p.text.length,
        i + 1 < parts.length ? parts[i + 1].index : text.length);
      return Math.min(10, Math.max(2, [...p.text].length)) +
        (/[,.!?;:。，！？；：]/u.test(following) ? 2 : 0);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let progress = 0;
    const times = weights.map((w) => {
      const t = cue.start + (end - cue.start) * progress / total;
      progress += w;
      return t;
    });
    return piecesAt(text, parts, times);
  }

  function lowerBound(words, time) {
    let lo = 0, hi = words.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (words[mid].t < time) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // Transfer only an unambiguous contiguous lexical match near this cue. ASR
  // revisions and missing/changed words must not silently invent exact times.
  function align(cues, donorCues, language) {
    const timed = [];
    const seen = new Set();
    for (const cue of donorCues) {
      if (!Array.isArray(cue.words)) continue;
      for (const w of cue.words) {
        if (!w || !Number.isFinite(w.t)) continue;
        const parts = tokens(String(w.u || ""), language);
        if (parts.length !== 1) continue;
        const key = parts[0].key;
        const identity = w.t + " " + key;
        if (!seen.has(identity)) { seen.add(identity); timed.push({ t: w.t, key }); }
      }
    }
    timed.sort((a, b) => a.t - b.t);
    let count = 0;
    for (const cue of cues) {
      if (captionPieces(cue, language)) continue;
      const parts = tokens(String(cue.text || ""), language);
      if (!parts.length || parts.length > 128 || !Number.isFinite(cue.start) ||
          !(cue.dur > 0)) continue;
      const from = lowerBound(timed, cue.start - 1200);
      const to = lowerBound(timed, cue.start + cue.dur + 1200);
      if (to - from > 256) continue;
      let match = -1, ambiguous = false;
      for (let i = from; i + parts.length <= to; i++) {
        if (parts.every((p, j) => p.key === timed[i + j].key)) {
          if (match !== -1) { ambiguous = true; break; }
          match = i;
        }
      }
      if (match < 0 || ambiguous) continue;
      const times = parts.map((_p, i) => timed[match + i].t);
      // Do not carry a word from the preceding/following caption into this one.
      if (times.some((t) => t < cue.start || t >= cue.start + cue.dur)) continue;
      cue.words = piecesAt(cue.text, parts, times);
      cue.wordTimingSource = "automatic";
      count++;
    }
    return count;
  }

  // Audio results must describe this exact sentence/window. Native and matched
  // caption timings keep priority. Partial/weak/foreign results never replace
  // the existing complete sentence with invented timestamps.
  function applyAudio(cues, segments, language) {
    if (!Array.isArray(cues) || !Array.isArray(segments) || segments.length > 5000) return 0;
    const byStart = new Map();
    for (const segment of segments) {
      if (!segment || typeof segment.text !== "string" || segment.text.length > MAX_TEXT ||
          !Number.isFinite(segment.start) || !Number.isFinite(segment.dur) || segment.dur <= 0 ||
          !Array.isArray(segment.words) || !segment.words.length || segment.words.length > 256 ||
          segment.words.some((w) => !w || !Number.isFinite(w.score) || w.score < 0.12 || w.score > 1)) continue;
      const end = segment.start + segment.dur;
      const candidate = { ...segment, end, wordTimingSource: "audio" };
      if (!captionPieces(candidate, language)) continue;
      byStart.set(segment.start + "\0" + end + "\0" + segment.text, candidate);
    }
    let count = 0;
    for (const cue of cues) {
      if (captionPieces(cue, language)) continue;
      const end = Number.isFinite(cue.end) ? cue.end : cue.start + cue.dur;
      const candidate = byStart.get(cue.start + "\0" + end + "\0" + cue.text);
      if (!candidate) continue;
      cue.words = candidate.words.map((w) => ({ t: w.t, e: w.e, u: w.u, score: w.score }));
      cue.wordTimingSource = "audio";
      count++;
    }
    return count;
  }

  const api = Object.freeze({ tokens, captionPieces, estimate, align, applyAudio });
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YtdsWordTiming = api;
})(typeof window === "object" ? window : globalThis);
