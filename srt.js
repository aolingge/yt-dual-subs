// ============================================================================
// YT Dual Subs — local subtitle files (isolated world).
//
// A Bilibili video does not always come with a readable Chinese caption track:
// the uploader may never have added one, the video may only carry captions
// burned into the picture, or Bilibili may not hand the track to a viewer. The
// practical answer for those videos is a subtitle file the user already has, so
// this module turns a UTF-8 SRT file into the cue format the rest of the
// engine already speaks:
//
//   { start: ms, dur: ms, text: "今天我们来聊聊怎么学习德语。" }
//
// It is deliberately pure: no DOM, no storage, no network. content.js decides
// where a file is kept (chrome.storage.local, bound to one video AND part) and
// the popup only hands the file's text over.
//
// The file itself never leaves the machine. Only the caption TEXT is sent to
// the translation service, exactly like a caption track read from the page.
// ============================================================================
(function () {
  if (globalThis.YtdsSrt) return;

  // A local file is stored per video; the browser gives us ~10 MB of local
  // storage and this keeps one video from crowding the rest out.
  const MAX_BYTES = 2 * 1024 * 1024;
  const STORE_PREFIX = "ytdsSrtV1:";

  // "00:00:01,200 --> 00:00:03,700" (also accepts a dot as the decimal mark,
  // and the short "0:00:01.2" form some tools write).
  const TIME_RE =
    /(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/;

  // The key a file is bound to. It carries the video AND the part, so importing
  // subtitles for one part of a multi-part video can never apply to another.
  function storageKey(videoKey) { return STORE_PREFIX + String(videoKey || ""); }

  function toMs(hours, minutes, seconds, fraction) {
    const frac = String(fraction == null ? "0" : fraction).padEnd(3, "0").slice(0, 3);
    return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(frac);
  }

  // Keep the wording and the punctuation; drop the styling. SRT files routinely
  // carry <i>/<b>/<font> tags and ASS files carry {\an8}-style positioning, and
  // none of that is part of the sentence we translate.
  //
  // A tag is removed WITHOUT leaving a space behind: a styled run is still the
  // same sentence, and an inserted space would split Chinese words that were
  // never separated in the text.
  function cleanText(lines) {
    return lines.join(" ")
      .replace(/\{[^}]*\}/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  // Returns { cues, dropped } — cues are sorted, de-duplicated and in
  // milliseconds — or null when the text holds no usable cue at all.
  function parse(text) {
    const raw = String(text == null ? "" : text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    const cues = [];
    const seen = new Set();
    let dropped = 0;

    for (const block of raw.split(/\n{2,}/)) {
      const lines = block.split("\n");
      let timeAt = -1;
      for (let i = 0; i < lines.length && i < 4; i++) {
        if (TIME_RE.test(lines[i])) { timeAt = i; break; }
      }
      if (timeAt < 0) {
        if (block.trim()) dropped++;
        continue;
      }
      const m = TIME_RE.exec(lines[timeAt]);
      const startMs = toMs(m[1], m[2], m[3], m[4]);
      const endMs = toMs(m[5], m[6], m[7], m[8]);
      const body = cleanText(lines.slice(timeAt + 1));
      if (!body || !Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0) {
        dropped++;
        continue;
      }
      const signature = startMs + "\u0000" + body;
      if (seen.has(signature)) { dropped++; continue; }
      seen.add(signature);
      cues.push({ start: Math.round(startMs), dur: Math.max(0, Math.round(endMs - startMs)), text: body });
    }

    if (!cues.length) return null;
    cues.sort((a, b) => a.start - b.start || a.text.localeCompare(b.text));
    return { cues, dropped };
  }

  globalThis.YtdsSrt = {
    MAX_BYTES,
    storageKey,
    parse,
    // The engine's cue list, ready to hand to the same renderer the caption
    // track uses. The source language stays Chinese: an imported file is read
    // as the original, and the translation is made from it as usual.
    toCues(text) {
      const parsed = parse(text);
      return parsed ? parsed.cues : null;
    }
  };
})();
