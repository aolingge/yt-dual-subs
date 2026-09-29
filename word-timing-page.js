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

  // Numbers are written differently by captions and by automatic tracks: a
  // German caption writes 1000 as "1.000" while the ASR track writes "1000",
  // a decimal comma faces a decimal point, and a clock time is written "19:30"
  // in one place and "19.30" in another. The matching key therefore drops
  // thousands separators, keeps one decimal separator and writes a clock time
  // as h.mm. Only the key changes: the text that the reader sees is never
  // rewritten.
  const NUMERIC = /^\d[\d.,'\u2019\u00a0\u202f ]*\d$/u;
  const SEPARATORS = /[.,'\u2019\u00a0\u202f ]+/u;
  const CLOCK = /^(\d{1,2}):(\d{1,2})$/u;
  function numericKey(text) {
    // "19:30" and "19.30" are the same reading; both become "19.30". A colon is
    // never a thousands separator, so an unparseable clock time keeps no key.
    const clock = CLOCK.exec(text);
    if (clock) return clock[1] + "." + clock[2];
    if (!/^\d$/u.test(text) && !NUMERIC.test(text)) return null;
    if (!SEPARATORS.test(text)) return null;
    const groups = text.split(SEPARATORS);
    const last = groups[groups.length - 1];
    const dot = text.lastIndexOf(".");
    const comma = text.lastIndexOf(",");
    let decimal = false;
    if (dot !== -1 && comma !== -1) decimal = dot > comma;
    else if (groups.length === 2 && last.length !== 3) decimal = true;
    const digits = groups.join("");
    if (!decimal) return digits;
    return digits.slice(0, digits.length - last.length) + "." + last;
  }

  // German also writes thousands with a space: "1 000" is the same number as
  // "1.000" and "1000". A digit group followed by whitespace and a group of
  // exactly three digits is read as one number, so the matching key is the same
  // on the caption and the automatic side. The span is still sliced from the
  // original text, so the reader keeps seeing "1 000".
  const DIGIT_GROUP = /^\d{1,3}(?:\d{3})*$/u;
  const GROUP_GAP = /^[\s\u00a0\u202f\u2009]+$/u;
  // A clock time is one reading, but word segmentation cuts "19:30" into "19"
  // and "30". Joining the digits across the colon restores the time, so it
  // matches the "19.30" spelling of an automatic track one for one instead of
  // leaving two numbers that happen to sit next to each other.
  const CLOCK_GAP = /^\s*:\s*$/u;
  function mergeNumbers(parts, text, language) {
    const merged = [];
    for (let i = 0; i < parts.length; i++) {
      let part = parts[i];
      for (;;) {
        const next = parts[i + 1];
        if (!next) break;
        const between = text.slice(part.index + part.text.length, next.index);
        const thousands = /^\d{3}$/u.test(next.text) && GROUP_GAP.test(between) &&
          DIGIT_GROUP.test(part.text.replace(GROUP_GAP, ""));
        const clock = /^\d{1,2}$/u.test(part.text) && /^\d{1,2}$/u.test(next.text) &&
          CLOCK_GAP.test(between);
        if (!thousands && !clock) break;
        const raw = text.slice(part.index, next.index + next.text.length);
        part = { text: raw, index: part.index, key: keyOf(raw, language) };
        i++;
      }
      merged.push(part);
    }
    return merged;
  }

  // Everything word matching compares. `normalize` alone is not enough for
  // numbers, so tokens carry this key instead.
  function keyOf(text, language) {
    const base = normalize(text, language);
    return numericKey(base) || base;
  }

  function tokens(text, language) {
    if (typeof text !== "string" || text.length > MAX_TEXT) return [];
    try {
      const locale = language === "auto" ? undefined : language;
      if (!segmenters.has(locale)) {
        segmenters.set(locale, new Intl.Segmenter(locale, { granularity: "word" }));
        if (segmenters.size > 8) segmenters.delete(segmenters.keys().next().value);
      }
      return mergeNumbers([...segmenters.get(locale).segment(text)]
        .filter((p) => p.isWordLike)
        .flatMap((p) => {
          // "z. B." segments into two words while "z.B." segments into one. Both
          // spell the same two letters, so a dotted initialism is always split:
          // matching then compares letters, and the display text is untouched.
          if (!/^(?:\p{L}\.)+\p{L}?$/u.test(p.segment)) {
            return [{ text: p.segment, index: p.index, key: keyOf(p.segment, language) }];
          }
          return [...p.segment.matchAll(/\p{L}/gu)]
            .map((m) => ({ text: m[0], index: p.index + m.index, key: keyOf(m[0], language) }));
        }), text, language);
    } catch (_e) {
      return mergeNumbers([...text.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu)]
        .map((m) => ({ text: m[0], index: m.index, key: keyOf(m[0], language) })), text, language);
    }
  }

  // Attach punctuation/spacing to spans without altering the selected text.
  function piecesAt(text, parts, times) {
    return parts.map((p, i) => ({ t: times[i],
      u: text.slice(i === 0 ? 0 : p.index,
        i + 1 < parts.length ? parts[i + 1].index : text.length) }));
  }

  // Stable identity of one caption track's text and boundaries. Alignment
  // results are only valid for the subtitles they were produced from, so a
  // cache entry has to be invalidated when the track or its text changes.
  function timingKey(cues) {
    const list = Array.isArray(cues) ? cues : [];
    let hash = 2166136261;
    const feed = (value) => {
      const text = String(value);
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
    };
    feed(list.length);
    for (const cue of list) {
      const end = Number.isFinite(cue?.end) ? cue.end
        : (Number.isFinite(cue?.dur) ? cue?.start + cue.dur : cue?.start);
      feed("\u0000" + cue?.start + "|" + end + "|" + (cue?.text || ""));
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
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
      if (words.length) timed.push({ key: words[0].key, t: w.t, e: w.e, s: w.s });
    }
    // Walk both sides together. A caption track may split one number over two
    // caption words ("1" then "000") while the text reads "1 000"; joining two
    // adjacent words is allowed only when their keys spell the one text token.
    const matched = [];
    let wi = 0;
    for (const part of parts) {
      if (wi >= timed.length) return null;
      if (timed[wi].key === part.key) {
        matched.push(timed[wi]);
        wi++;
        continue;
      }
      if (wi + 1 < timed.length && timed[wi].key + timed[wi + 1].key === part.key) {
        matched.push({ key: part.key, t: timed[wi].t, e: timed[wi + 1].e, s: timed[wi].s });
        wi += 2;
        continue;
      }
      return null;
    }
    if (wi !== timed.length) return null;
    const end = Number.isFinite(cue.end) ? cue.end : cue.start + cue.dur;
    if (!Number.isFinite(cue.start) || !Number.isFinite(end) ||
        matched.some((w) => w.t < cue.start - 100 || w.t >= end)) return null;
    const pieces = piecesAt(text, parts, matched.map((w) => w.t));
    // A sentence can mix matched and estimated word times; carry the per-word
    // provenance so the reader can see which positions are actually known.
    pieces.forEach((p, i) => { if (matched[i].s) p.s = matched[i].s; });
    if (cue.wordTimingSource === "audio") {
      if (matched.some((w, i) => !Number.isFinite(w.e) || w.e <= w.t || w.e > end ||
          (i + 1 < matched.length && w.e > matched[i + 1].t))) return null;
      pieces.forEach((p, i) => { p.e = matched[i].e; });
    }
    return pieces;
  }

  // Speech duration tracks syllables, not characters: German compounds are long
  // but few syllables, and digits are short but spoken long ("1990" is
  // "neunzehnhundertneunzig"). Display-only estimation, never written back into
  // the raw caption cues.
  const VOWELS = /[aeiouyäöüáàâãéèêëíìîïóòôõúùûæœø]+/gu;
  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
  function syllables(word, language) {
    const text = String(word || "");
    if (!text) return 1;
    const cjk = text.match(CJK);
    if (cjk && cjk.length) return Math.min(8, cjk.length);
    if (/\d/u.test(text)) {
      let count = 0;
      for (const ch of text) count += /\d/u.test(ch) ? 1.5 : 0.75;
      return Math.max(1, Math.min(8, Math.round(count)));
    }
    const groups = text.toLowerCase().match(VOWELS);
    let count = groups ? groups.length : 1;
    // A silent final "e" is not a syllable in English ("make", "time").
    if (String(language || "").toLowerCase().startsWith("en") && count > 1 &&
        /[^aeiou]e$/u.test(text.toLowerCase())) count -= 1;
    return Math.max(1, Math.min(8, count));
  }

  // A pause belongs to the gap between two words, not to the word before it.
  function pauseAfter(gap, word) {
    const marks = gap.match(/[.!?。！？…,，、;；:：—–]/gu);
    if (!marks) return 0;
    const mark = marks[marks.length - 1];
    // "z. B." / "u. a." / "d. h." are abbreviations, not sentence ends: a single
    // letter never ends a sentence.
    if (mark === "." && word.length === 1 && /\p{L}/u.test(word)) return 0;
    if (".!?。！？…".includes(mark)) return 260;
    if ("—–".includes(mark)) return 180;
    if (";；:：".includes(mark)) return 160;
    return 120;
  }

  const SYLLABLE_MS = { de: 215, en: 225, nl: 215, sv: 215, da: 215, es: 200,
    fr: 205, it: 200, pt: 205, ru: 220, pl: 210, tr: 200, zh: 175, ja: 165,
    ko: 185, vi: 200, th: 200, id: 200 };
  function syllableMs(language, measured) {
    if (Number.isFinite(measured)) return Math.max(90, Math.min(500, measured));
    const code = String(language || "").toLowerCase();
    for (const key of Object.keys(SYLLABLE_MS)) {
      if (code.startsWith(key)) return SYLLABLE_MS[key];
    }
    return 205;
  }

  // This is display-only estimation, never written into the raw caption cues.
  function estimate(cue, language, options) {
    if (!cue) return null;
    const end = Number.isFinite(cue.end) ? cue.end : cue.start + cue.dur;
    if (!Number.isFinite(cue.start) || !Number.isFinite(end) || end <= cue.start) return null;
    const text = String(cue.text || "");
    const parts = tokens(text, language);
    if (!parts.length) return null;
    const perSyllable = syllableMs(language, options && options.syllableMs);
    const spans = parts.map((p, i) => {
      const following = text.slice(p.index + p.text.length,
        i + 1 < parts.length ? parts[i + 1].index : text.length);
      return { dur: syllables(p.text, language) * perSyllable,
        pause: i + 1 < parts.length ? pauseAfter(following, p.text) : 0 };
    });
    const speech = spans.reduce((sum, span) => sum + span.dur + span.pause, 0);
    if (!(speech > 0)) return null;
    // A caption cue can carry trailing silence, so never stretch the words past
    // 1.4x their natural length to fill one; squeeze them when the cue is too
    // short for its text.
    const scale = Math.min(1.4, (end - cue.start) / speech);
    let at = cue.start;
    const times = spans.map((span) => {
      const t = at;
      at += (span.dur + span.pause) * scale;
      return Math.min(t, end);
    });
    return piecesAt(text, parts, times);
  }

  function medianOf(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted.length ? sorted[sorted.length >> 1] : null;
  }

  function clampRate(value) {
    return Number.isFinite(value) ? Math.max(90, Math.min(500, value)) : null;
  }

  // One cue's measured word intervals: the time between two known word starts
  // together with the syllables spoken in that span. Caption end can include
  // seconds of silence, so the last word's duration stays unknown, and a
  // punctuation gap includes a pause rather than the speaker's word pace.
  function cueIntervals(cue, language) {
    const pieces = captionPieces(cue, language);
    if (!pieces) return null;
    const parts = tokens(String(cue.text || ""), language);
    const intervals = [];
    for (let i = 0; i + 1 < parts.length; i++) {
      const gap = cue.text.slice(parts[i].index + parts[i].text.length, parts[i + 1].index);
      if (pauseAfter(gap, parts[i].text)) continue;
      const elapsed = pieces[i + 1].t - pieces[i].t;
      if (!(elapsed > 0)) continue;
      intervals.push({ t: pieces[i].t, ms: elapsed, syl: syllables(parts[i].text, language) });
    }
    return intervals;
  }

  // The middle of the samples, with values far from it dropped first: one long
  // gap or an unusual cue must not drag the estimate, while a genuine rate
  // change inside the window still shows up as a different middle.
  function robustRate(samples) {
    const values = [];
    for (const sample of samples) if (sample.ms > 0) values.push(sample.ms);
    if (!values.length) return null;
    const middle = medianOf(values);
    const kept = values.filter((value) => value >= middle / 2.5 && value <= middle * 2.5);
    return clampRate(medianOf(kept.length ? kept : values));
  }

  // A cue needs at least this many spoken syllables to say anything about the
  // speaker's pace. Below it, one short caption would dominate the statistic.
  const PACE_MIN_SYLLABLES = 4;

  // One sampler for every pace figure, so the video-wide rate and the local rate
  // are the same statistic. An interval contributes the milliseconds one spoken
  // syllable took: a long span between two words therefore carries no more
  // weight than a short one (a duration-weighted mean let one long gap decide a
  // whole cue), and the trimming in robustRate works on a scale-free value. Cues
  // with too few syllables are left out entirely.
  function paceSamples(cues, language) {
    const samples = [];
    let contributors = 0;
    for (const cue of Array.isArray(cues) ? cues : []) {
      const intervals = cueIntervals(cue, language);
      if (!intervals) continue;
      const local = [];
      let syllables = 0;
      for (const interval of intervals) {
        const ms = interval.ms / interval.syl;
        if (!Number.isFinite(ms) || !(ms > 0)) continue;
        local.push({ t: interval.t, ms });
        syllables += interval.syl;
      }
      if (syllables < PACE_MIN_SYLLABLES) continue;
      contributors++;
      samples.push(...local);
    }
    samples.sort((a, b) => a.t - b.t);
    return { samples, contributors };
  }

  // Measure this video's own pace from cues that already carry real word times,
  // so untimed cues in the same video are estimated at the speaker's speed. The
  // same robust middle is used as for the local pace: one odd caption must not
  // move the whole video's rate, and a single long interval must not either.
  function speakingRate(cues, language, measured) {
    const data = measured || paceSamples(cues, language);
    if (data.contributors < 3) return null;
    return robustRate(data.samples);
  }

  // How close to the current sentence a measured interval still counts as
  // local, and how much evidence a window needs before it is trusted. The
  // harness in tests/word-timing.test.cjs measures how well a window of this
  // size follows a speaker who changes speed; the numbers are a sanity limit
  // chosen from that comparison, not a claim to be optimal.
  const LOCAL_WINDOW_MS = 12000;
  const LOCAL_WIDE_MS = 45000;
  const LOCAL_MIN_SAMPLES = 6;

  // Every measured word interval of the video in time order, plus the
  // video-wide rate. Built once per caption track and queried per sentence, so
  // playback never rescans the whole track for one frame.
  function pace(cues, language) {
    const measured = paceSamples(cues, language);
    return { samples: measured.samples, global: speakingRate(cues, language, measured) };
  }

  // The speaker's pace around one point in the video, so an estimate follows a
  // speaker who speeds up or slows down. Nearby intervals win; a window with
  // too little evidence widens once and then gives up, leaving the caller to
  // fall back to the video-wide rate and then to the language default.
  function localRate(videoPace, time, options) {
    if (!videoPace || !Array.isArray(videoPace.samples) || !Number.isFinite(time)) return null;
    const opts = options || {};
    const windows = [Number.isFinite(opts.window) ? opts.window : LOCAL_WINDOW_MS,
      Number.isFinite(opts.wideWindow) ? opts.wideWindow : LOCAL_WIDE_MS];
    const min = Number.isFinite(opts.minSamples) ? opts.minSamples : LOCAL_MIN_SAMPLES;
    for (const span of windows) {
      const near = videoPace.samples.filter((sample) => Math.abs(sample.t - time) <= span);
      if (near.length < min) continue;
      const rate = robustRate(near);
      if (rate !== null) return rate;
    }
    return null;
  }

  function lowerBound(words, time) {
    let lo = 0, hi = words.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (words[mid].t < time) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // Where a cue's words are looked for in the automatic track. The margin is
  // context only: an anchor still has to fall inside the cue itself.
  const ALIGN_MARGIN = 1200;
  // One repeated word is not an anchor. Two words in a row, in the right order,
  // inside the cue's own window, is the smallest fragment worth trusting.
  const ALIGN_MIN_RUN = 2;

  function donorWords(donorCues, language) {
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
    return timed;
  }

  // Contiguous runs of equal words on one diagonal: cue word j matching donor
  // word j + d. A run is a candidate anchor, not yet a fact.
  function anchorRuns(parts, timed, from, to) {
    const wanted = new Map();
    for (let j = 0; j < parts.length; j++) {
      const list = wanted.get(parts[j].key);
      if (list) list.push(j); else wanted.set(parts[j].key, [j]);
    }
    const diagonals = new Map();
    for (let i = from; i < to; i++) {
      const list = wanted.get(timed[i].key);
      if (!list) continue;
      for (const j of list) {
        const d = i - j;
        let entry = diagonals.get(d);
        if (!entry) { entry = []; diagonals.set(d, entry); }
        entry.push(j);
      }
    }
    const runs = [];
    for (const [d, list] of diagonals) {
      list.sort((a, b) => a - b);
      let start = 0;
      for (let k = 1; k <= list.length; k++) {
        if (k === list.length || list[k] !== list[k - 1] + 1) {
          if (k - start >= ALIGN_MIN_RUN) {
            runs.push({ d, jStart: list[start], jEnd: list[k - 1] + 1 });
          }
          start = k;
        }
      }
    }
    return runs;
  }

  // One cue word in the estimator's units: its syllables plus the pause its
  // trailing punctuation opens. `following` is whether a word follows it.
  function anchorWeight(text, parts, index, language, perSyllable, following) {
    const head = parts[index].index + parts[index].text.length;
    const tail = text.slice(head, index + 1 < parts.length ? parts[index + 1].index : text.length);
    return syllables(parts[index].text, language) * perSyllable +
      (following ? pauseAfter(tail, parts[index].text) : 0);
  }

  // Transfer word times from the same-language automatic track. ASR revisions
  // and missing/changed words must not silently invent exact times, so an exact
  // contiguous match is preferred and is the only thing reported as a caption
  // match. When one word differs, the words that did match still carry usable
  // times: contiguous runs become anchors and only the words between two
  // anchors are estimated, which is reported as a partial (mixed) match.
  function align(cues, donorCues, language) {
    const timed = donorWords(donorCues, language);
    if (!timed.length) return 0;
    const perSyllable = syllableMs(language);
    let count = 0;
    for (const cue of cues) {
      if (captionPieces(cue, language)) continue;
      const text = String(cue.text || "");
      const parts = tokens(text, language);
      if (!parts.length || parts.length > 128 || !Number.isFinite(cue.start) ||
          !(cue.dur > 0)) continue;
      const cueEnd = cue.start + cue.dur;
      const from = lowerBound(timed, cue.start - ALIGN_MARGIN);
      const to = lowerBound(timed, cueEnd + ALIGN_MARGIN);
      if (to - from > 256) continue;

      // The whole cue as one contiguous phrase: unambiguous only.
      let match = -1, ambiguous = false;
      for (let i = from; i + parts.length <= to; i++) {
        if (parts.every((p, j) => p.key === timed[i + j].key)) {
          if (match !== -1) { ambiguous = true; break; }
          match = i;
        }
      }
      if (ambiguous) continue;
      if (match >= 0) {
        const times = parts.map((_p, i) => timed[match + i].t);
        // Do not carry a word from the preceding/following caption into this one.
        if (times.some((t) => t < cue.start || t >= cueEnd)) continue;
        cue.words = piecesAt(text, parts, times);
        cue.wordTimingSource = "automatic";
        count++;
        continue;
      }

      // Only fragments: keep the runs whose times are usable, drop every run
      // that another place in the track could equally describe.
      const runs = anchorRuns(parts, timed, from, to);
      const anchors = [];
      for (const run of runs) {
        let previous = -Infinity, ok = true;
        for (let j = run.jStart; j < run.jEnd; j++) {
          const t = timed[j + run.d].t;
          if (t < cue.start || t >= cueEnd || t < previous) { ok = false; break; }
          previous = t;
        }
        if (!ok) continue;
        const contested = runs.some((other) => other.d !== run.d &&
          other.jStart < run.jEnd && run.jStart < other.jEnd);
        if (!contested) anchors.push(run);
      }
      if (!anchors.length) continue;
      anchors.sort((a, b) => a.jStart - b.jStart);

      const times = new Array(parts.length).fill(NaN);
      const known = new Array(parts.length).fill(false);
      for (const run of anchors) {
        for (let j = run.jStart; j < run.jEnd; j++) {
          times[j] = timed[j + run.d].t;
          known[j] = true;
        }
      }

      // Spread the words of [first, last] over (t0, t1). The anchored word
      // before the gap (lead) and after it (tail) keep their own share of the
      // interval, so a filled word never lands on top of an anchor.
      const fill = (first, last, t0, t1, lead, tail) => {
        if (last < first) return true;
        const weights = [];
        for (let j = first; j <= last; j++) {
          weights.push(anchorWeight(text, parts, j, language, perSyllable, j < last || tail > 0));
        }
        const total = lead + tail + weights.reduce((sum, w) => sum + w, 0);
        if (!(t1 > t0) || !(total > 0)) return false;
        // Never stretch an estimate to fill a silence; the highlight may wait.
        const scale = Math.min(1.4, (t1 - t0) / total);
        let at = t0 + lead * scale;
        for (let j = first; j <= last; j++) {
          times[j] = at;
          at += weights[j - first] * scale;
        }
        return true;
      };

      const first = known.indexOf(true);
      const last = known.lastIndexOf(true);
      const lead0 = anchorWeight(text, parts, first, language, perSyllable, false);
      let broken = !fill(0, first - 1, cue.start, times[first], 0, lead0);
      for (let j = first; !broken && j < last; j++) {
        if (!known[j] || known[j + 1]) continue;
        let k = j + 1;
        while (!known[k]) k++;
        broken = !fill(j + 1, k - 1, times[j], times[k],
          anchorWeight(text, parts, j, language, perSyllable, true),
          anchorWeight(text, parts, k, language, perSyllable, false));
      }
      if (!broken && last + 1 < parts.length) {
        broken = !fill(last + 1, parts.length - 1, times[last], cueEnd,
          anchorWeight(text, parts, last, language, perSyllable, true), 0);
      }
      if (broken) continue;
      if (times.some((t, j) => !Number.isFinite(t) || (j > 0 && t <= times[j - 1]))) continue;

      cue.words = piecesAt(text, parts, times)
        .map((piece, i) => ({ ...piece, s: known[i] ? "caption" : "estimated" }));
      cue.wordTimingSource = known.every(Boolean) ? "automatic" : "automatic-partial";
      count++;
    }
    return count;
  }

  // Audio results must describe this exact sentence/window, and the sentence
  // must still sit where it was when the analysis started. A segment carries the
  // position it was aligned for; a cue is only filled when its own text,
  // boundaries AND position agree, so a reordered or re-segmented track cannot
  // receive another cue's word times. Native and matched caption timings keep
  // priority. Partial/weak/foreign results never replace the existing complete
  // sentence with invented timestamps.
  function applyAudio(cues, segments, language) {
    if (!Array.isArray(cues) || !Array.isArray(segments) || segments.length > 5000) return 0;
    const byStart = new Map();
    for (const segment of segments) {
      if (!segment || typeof segment.text !== "string" || segment.text.length > MAX_TEXT ||
          !Number.isInteger(segment.index) || segment.index < 0 ||
          !Number.isFinite(segment.start) || !Number.isFinite(segment.dur) || segment.dur <= 0 ||
          !Array.isArray(segment.words) || !segment.words.length || segment.words.length > 256 ||
          segment.words.some((w) => !w || !Number.isFinite(w.score) || w.score < 0.12 || w.score > 1)) continue;
      const end = segment.start + segment.dur;
      const candidate = { ...segment, end, wordTimingSource: "audio" };
      if (!captionPieces(candidate, language)) continue;
      byStart.set(segment.start + "\0" + end + "\0" + segment.text, candidate);
    }
    let count = 0;
    for (let index = 0; index < cues.length; index++) {
      const cue = cues[index];
      if (!cue || captionPieces(cue, language)) continue;
      const end = Number.isFinite(cue.end) ? cue.end : cue.start + cue.dur;
      const candidate = byStart.get(cue.start + "\0" + end + "\0" + cue.text);
      if (!candidate || candidate.index !== index) continue;
      cue.words = candidate.words.map((w) => ({ t: w.t, e: w.e, u: w.u, score: w.score }));
      cue.wordTimingSource = "audio";
      count++;
    }
    return count;
  }

  // Alignment results only mean something for the helper version that produced
  // them: version 2 added the track position to every sentence and the audio
  // fingerprint to the helper's cache key. An older record is re-run, never
  // reused, so a stale result cannot be mistaken for a current one.
  const AUDIO_RECORD_VERSION = 2;

  const api = Object.freeze({ AUDIO_RECORD_VERSION, tokens, timingKey, syllables, captionPieces, estimate, speakingRate, pace, localRate, align, applyAudio });
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YtdsWordTiming = api;
})(typeof window === "object" ? window : globalThis);
