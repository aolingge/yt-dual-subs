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
| `word-timing.js`, `word-timing-page.js` | Unicode word segmentation, timestamp validation, conservative lexical matching, and display-only estimation. The page copy has identical code under a different filename, so Chromium runs it in both worlds at `document_start`. |
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
6. Word highlighting prefers native caption word times. Missing times can be matched against a same-language ASR track in the background; only a unique contiguous lexical match near the original cue is accepted. Translated tracks, other videos, ambiguous repetitions, and changed/missing words do not supply times.
7. If enabled, approximate progress distributes words by syllable count, punctuation pauses and a pace measured from the video's own timed captions (falling back to a per-language default). Its badge stays visible and the popup identifies the source. This feature does not analyze audio.

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
node --test tests/settings.test.cjs
```

The suites execute the shipping scripts inside a VM with simulated DOM and extension APIs. They cover early startup before the player/root exist, duplicate config requests, translated-track cooldowns, clock alignment, source recovery, translation languages, deadlines, layout, selection, resize, shortcuts, study, extension reloads, and staged preference recovery after sync quotas or worker suspension.

**Browser validation has a separate scope.** Isolated Edge checks with synthetic YouTube fixtures exercise the actual extension UI, but are not proof that every live YouTube video works. A real translation endpoint responding once is not a latency guarantee. After behavior changes, check a captioned live video when available and report unavailable or unverified cases explicitly.

## Documentation screenshots

Most images in `docs/images/` use the real v3.8.1 interface with an original illustrated lake scene and sample German/Chinese captions. `spoken-word-highlighting.png` shows v3.9.0 with controlled caption timestamps and a real playing media clock. `high-contrast-subtitles.png` and `highlight-style-settings.png` show v3.9.1's actual overlay and Chinese highlight controls over a controlled bright-paper scene. These are demonstration fixtures, not live YouTube screenshots or measured alignment to German speech. The original word-lookup capture used the live Google endpoint; the v3.9.0 regression fixture stubs lookup responses.

## Submit a change

Keep changes focused, include a reproduction for bugs, update all three interface locales when adding labels, and check the behavior affected by your patch. Preserve the MIT license and original attribution. Update download links, version badges, screenshots, and release notes when they become outdated.
