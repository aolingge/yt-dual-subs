# Development

[Back to the README](../README.md)

YT Dual Subs is a Manifest V3 extension written in plain JavaScript and CSS. No package installation, build step, API key, or project server is required to load it.

## Load a checkout

1. Clone this repository.
2. Open `edge://extensions` or `chrome://extensions` and enable Developer mode.
3. Select **Load unpacked** and choose the repository folder containing `manifest.json`.
4. After source edits, reload the extension and refresh existing YouTube tabs.

Use an isolated browser profile for automated checks. Keep personal browser profiles, credentials, and downloaded study material out of the repository.

## File map

| File | Responsibility |
| --- | --- |
| `inject.js` | Page-world caption capture; original/translated track loading and optional same-language automatic timing track. |
| `word-timing.js`, `word-timing-page.js` | Unicode word segmentation, timestamp validation, conservative lexical matching (full-sentence match, anchored fragments, local pace), audio-result validation, and display-only estimation. A record is accepted only for the sentence position it was measured at and only in one record version, so word times cannot be inherited by a re-ordered track or by an older algorithm's output. The page copy has identical code under a different filename, so Chromium runs it in both worlds at `document_start`. |
| `audio-cache.js` | Bounded local cache of audio-derived word times, keyed by video id, source language, caption-track hash, model/helper version, audio start offset and — for an imported file — the audio's own identity (byte size plus the SHA-256 of its first 4 MiB). Only a result the helper marked complete counts as a hit. Loaded only by the worker. |
| `alignment.html`, `alignment.js`, `alignment.css` | Optional analysis page: starts a local-helper job, imports a matching local media file together with its video start time, shows progress and failures, and cancels jobs whose video or track changed. |
| `tools/audio-alignment/`, `tools/Start-AudioAlignment.*`, `tools/Stop-AudioAlignment.ps1` | Optional Python helper (loopback HTTP, anonymous audio download, FFmpeg decoding, Wav2Vec2 CTC alignment, disk cache) plus install/start/stop scripts. Not needed for captions. |
| `settings.js` | Shared preference reads/live changes and durable local staging; the existing worker merges sync writes with quota backoff. |
| `content.js` | Video-clock caption rendering, sentence grouping, native-caption fallback, word lookup, drag/resize, player controls, and study messages. |
| `background.js` | Google translation requests, deduplication, caching, deadlines, preference-save messages, and shortcut dispatch. |
| `popup.html`, `popup.css`, `popup.js` | Settings, preview, status, current-video actions, and SRT export. |
| `study.js` | Transcript browsing, saved cards, review, and JSON backup/import. |
| `content.css` | Subtitle layout, lookup card, resize grips, and native-caption suppression. |
| `_locales/` | English, Simplified Chinese, and Traditional Chinese interface strings. |
| `tests/` | Node's built-in test runner and a `node:vm` browser/extension harness. |

## Caption and translation flow

1. The page-world script observes the player's caption requests and captures the timedtext URL, including any player-provided authorization parameters.
2. Both worlds inject at `document_start`; the content script loads saved settings and waits for the player through a temporary DOM observer, then starts native-caption preview without waiting for `DOMContentLoaded`. Original cues race the player's copied JSON3/XML response against a JSON3 fetch. Repeated configs share a pending original request for the same exact URL; a fresh player token can still recover a stuck request. The current original track is cached in page memory; transient failures retry up to three times, with a longer delay for rate limits. Track discovery continues for slower player initialization. Translation loads independently.
3. The content script groups cues for readable sentences and selects the current sentence using `video.currentTime`.
4. Translated cues are paired and timestamp-checked. After a 350ms head start, Google can prepare the current and next two sentences while the translated track is pending, including while paused. Each Google attempt has a 4-second deadline, with one retry for a network failure.
5. A translation response rechecks the current video/sentence before repainting. Native fallback serializes changing text into the latest request; a translated prefix may remain within the same growing sentence, marked with an ellipsis. Different sentences, seeks, languages, and videos invalidate old replies. Failed stable text can retry; rate limits respect cooldowns.
6. Word highlighting prefers native caption word times. Missing times are matched against a same-language ASR track in the background by the configured mode: `auto` fetches and matches that track, `approximate` never fetches it, and `audio` additionally accepts verified audio results. A cue whose whole text matches one unique contiguous donor run takes that run's times; otherwise reliable contiguous fragments (at least two consecutive words, one diagonal in donor order, times inside the cue) become anchors and only the words between them are estimated. Repeated phrases matched on more than one diagonal, ambiguous full matches, donor times outside the cue window and changed words are rejected instead of force-timed. Matching normalizes case, numbers (`1.000`/`1,000`/`1 000`/`1000`, `1,5`/`1.5`, `19:30`/`19.30` — the caption tokenizer merges both the digit groups of a thousands separator and the two halves of a clock before comparing) and dotted abbreviations (`z. B.`/`z.b.`) for comparison only; displayed text is sliced from the original cue, so a merged number still shows the characters the caption contained. Each piece keeps its provenance, so a mixed cue reports `automatic-partial` with per-word `caption`/`estimated` flags and is never labelled exact.
7. If enabled, approximate progress distributes words by syllable count, punctuation pauses and a pace measured from the video's timed captions. The estimate prefers a **local** pace from known word starts within 12s of the cue (widening once to 45s, with outlier rejection), then the video-wide median, then a per-language default; that video-wide rate samples one interval per syllable, skips cues with fewer than four syllables, and rejects values outside `[median/2.5, median*2.5]`, so a single long gap or an outlier cue cannot decide it. The pace is computed once per caption track and reused while playback advances, and the memo is invalidated again when word times arrive for cues that were previously untimed. Pace samples exclude the final word's unknown duration and punctuation pauses, so trailing caption silence does not slow the estimate. Short cues compress all estimated starts within the cue; long cues retain the 1.4× stretch cap. Its badge stays visible and the popup identifies the source.
8. Optional audio alignment fills the remaining cues from the video's own audio: the analysis page creates a helper job for the current video id, language and caption text plus the auto caption track's identity, then polls it. Every cue states its position in the subtitle track and the helper echoes it back. Results arrive as per-word `{start, end, score}` sets, are validated against stored cues (`applyAudio`) and applied only to the sentence that still sits at that position and whose video id, source language and caption-track hash still match; a record in a different format version, with a missing or mismatched position, or from a helper older than this build is refused rather than applied. Cues are queued in playback order (the current sentence first, then upcoming, then earlier), a caption is aligned only inside its own window in audio time, and a reliably detected gap longer than the pause threshold clears the highlight instead of holding the previous word. The stored result is identified by the video or the imported file's own identity (size plus the hash of its first 4 MiB, recomputed by the helper from the bytes it receives), so replacing the file or changing the start offset produces a different result instead of reusing the previous one; only a result the helper marked complete counts as a cache hit, and a stale one is refused and reported instead of applied. Switching video or subtitle track cancels the job. Captions, highlighting and translation never wait for the helper, and every word keeps a start and an end.

Whole-track translations share pending/successful requests in a bounded current-video cache keyed by source track and target language. A translated-track HTTP 429 sets a 20-second page-wide cooldown that config changes, fresh player tokens, and navigation do not reset. Original loading and sentence translation do not wait for it; later configs can retry after the deadline.

Chromium can skip the second injection of the same script URL at one injection stage even when the execution worlds differ. Use distinct timing filenames for the two worlds. After editing `word-timing.js`, run `cp word-timing.js word-timing-page.js`; the structure suite verifies that their contents match. This needs no build step or dependency. See Chromium's [script injection implementation](https://github.com/chromium/chromium/blob/main/extensions/renderer/user_script_injector.cc).

## Preserve these behaviors

- **Original first:** displaying an available original must not wait for translation.
- **Early startup:** missing `<html>` or player nodes at injection must be safe. Stop the temporary boot observer once ready; respect a saved disabled setting. Native preview may begin before the rest of the page is parsed.
- **Clock alignment:** check timing after play/seek and before applying asynchronous translations.
- **Recovery:** unsuccessful guessed URLs must not replace newer player captures; include response-body timeouts.
- **Native visibility:** hide native captions only when the extension can replace them or a loaded track owns the current caption gap. Restore them if the extension context becomes invalid.
- **User interaction:** selecting words and resizing the box must not click/pause the player. Hover reveal must hide when the pointer leaves the player/window.
- **Responsive preferences:** fitting a smaller player must not overwrite saved font sizes or positions. Persist manual width as a percentage; leave room for player controls.
- **Language isolation:** translation cache keys include source language, target language, and text. Unknown source language can fall back to detection.
- **Storage:** popup/content scripts send preference patches to the worker through `settings.js`; only the worker writes sync preferences. `settingsPendingV1` locally stages edits and the next allowed sync time. Immediate local events update overlays, and delayed sync events must not overwrite pending values or repeat those updates. Writes are serialized, coalesced after 250ms, and spaced by at least 2.5s across worker restarts. Minute/hour quota failures wait 61s/3601s; suspended workers resume on their next activation. Resetting preferences preserves saved cards. Imports merge validated cards without deleting the existing collection.
- **Export integrity:** translated/bilingual SRT must not silently omit missing or misaligned spoken lines.
- **Timing provenance:** retain native/matched metadata through grouping and video caches. Estimated times are rendering data, never inserted into raw cues or SRT. Late timing updates must not restart sentence repeat, hide a manually revealed translation, or discard a pending fast translation.
- **Timing sources stay distinguishable:** a sentence mixing sourced and estimated times must report that mix (never a full match), keep the per-word flags through grouping and cache merges, and let the popup name the source. The mode setting is the only switch that decides whether another caption track is fetched or audio results are accepted; approximate mode must remain fully usable with no helper running.
- **Audio results are bound, not inherited:** never apply a record whose position, video id, source language, caption-track hash, model/version, audio identity or audio start offset differs from the loaded track, and never accept one in an older result format. Report that state instead of silently ignoring it, and cancel the running job when the video or track changes. A helper failure or absence must leave captions, highlighting and translation intact.
- **Local pace is cached, not recomputed:** measure the pace once per caption track (invalidated by a new cue list, and by word times arriving for cues that were untimed when it was measured) rather than scanning the whole track on every render tick.

## Run focused checks

With a Node.js installation that supports its built-in test runner:

```sh
node --test tests/*.test.cjs
```

For a focused check:

```sh
node --test tests/latency.test.cjs tests/startup.test.cjs
node --test tests/layout.test.cjs tests/resize.test.cjs
node --test tests/word-timing.test.cjs tests/study.test.cjs
node --test tests/timing-mode.test.cjs tests/audio-timing.test.cjs
node --test tests/settings.test.cjs
```

The optional helper's own checks need no model download, account, or audio file:

```sh
python -m unittest discover -s tests -p "test_*.py"
```

Run it with `tools/audio-alignment/.venv/Scripts/python.exe` after `tools/Start-AudioAlignment.ps1 -SetupOnly`.

The suites execute the shipping scripts inside a VM with simulated DOM and extension APIs. They cover early startup before the player/root exist, duplicate config requests, translated-track cooldowns, clock alignment, source recovery, translation languages, deadlines, layout, selection, resize, shortcuts, study, extension reloads, and staged preference recovery after sync quotas or worker suspension.

**Browser validation has a separate scope.** Isolated Edge checks with synthetic YouTube fixtures exercise the actual extension UI, but are not proof that every live YouTube video works. A real translation endpoint responding once is not a latency guarantee. After behavior changes, check a captioned live video when available and report unavailable or unverified cases explicitly.

**Audio-alignment verification status.** The helper, the German model and the full caption→audio→video-time path were exercised on this machine against real German speech (12 public-domain Thorsten recordings, 78 words): every word received a start and an end, times stayed inside each caption window, and shuffled transcripts were rejected. The extension-side path was then driven end to end against the real helper process and a real local audio file — position echo, complete-and-identified cache entry, reuse without re-uploading, `audioMismatch` refusal, and a different start offset producing a different result — and re-aligning the same captions with the extension's tokenizer reproduced all 78 recorded times exactly, so the round-2 changes moved no model boundary. Absolute per-word error against human-checked word boundaries is **not** verified, only one speaker was covered, and the anonymous YouTube audio download could not be exercised end to end here because the network proxy truncated every media stream. See [AUDIO_ALIGNMENT.md](AUDIO_ALIGNMENT.md#what-has-actually-been-verified) before describing accuracy, and never present estimated or audio-derived times as measured speech.

## Documentation screenshots

Most images in `docs/images/` use the real v3.8.1 interface with an original illustrated lake scene and sample German/Chinese captions. `spoken-word-highlighting.png` shows v3.9.0 with controlled caption timestamps and a real playing media clock. `high-contrast-subtitles.png` and `highlight-style-settings.png` show v3.9.1's actual overlay and Chinese highlight controls over a controlled bright-paper scene. These are demonstration fixtures, not live YouTube screenshots or measured alignment to German speech. The original word-lookup capture used the live Google endpoint; the v3.9.0 regression fixture stubs lookup responses.

## Submit a change

Keep changes focused, include a reproduction for bugs, update all three interface locales when adding labels, and check the behavior affected by your patch. Preserve the MIT license and original attribution. Update download links, version badges, screenshots, and release notes when they become outdated.
