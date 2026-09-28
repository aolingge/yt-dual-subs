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
| `inject.js` | Page-world caption request capture; original and translated track loading. |
| `content.js` | Video-clock caption rendering, sentence grouping, native-caption fallback, word lookup, drag/resize, player controls, and study messages. |
| `background.js` | Google translation requests, deduplication, caching, deadlines, and shortcut dispatch. |
| `popup.html`, `popup.css`, `popup.js` | Settings, preview, status, current-video actions, and SRT export. |
| `study.js` | Transcript browsing, saved cards, review, and JSON backup/import. |
| `content.css` | Subtitle layout, lookup card, resize grips, and native-caption suppression. |
| `_locales/` | English, Simplified Chinese, and Traditional Chinese interface strings. |
| `tests/` | Node's built-in test runner and a `node:vm` browser/extension harness. |

## Caption and translation flow

1. The page-world script observes the player's caption requests and captures the timedtext URL, including any player-provided authorization parameters.
2. Original JSON3 cues and the selected translated track are fetched in parallel. Native-caption text can appear before those requests finish.
3. The content script groups cues for readable sentences and selects the current sentence using `video.currentTime`.
4. Translated cues are paired and timestamp-checked. When needed, the service worker translates the displayed sentence through Google; pending requests can also prepare the next two sentences.
5. A translation response rechecks the current video/sentence before repainting. Old results may be cached, but must not be shown beside a different sentence.

## Preserve these behaviors

- **Original first:** displaying an available original must not wait for translation.
- **Clock alignment:** check timing after play/seek and before applying asynchronous translations.
- **Recovery:** unsuccessful guessed URLs must not replace newer player captures; include response-body timeouts.
- **Native visibility:** hide native captions only when the extension can replace them or a loaded track owns the current caption gap. Restore them if the extension context becomes invalid.
- **User interaction:** selecting words and resizing the box must not click/pause the player. Hover reveal must hide when the pointer leaves the player/window.
- **Responsive preferences:** fitting a smaller player must not overwrite saved font sizes or positions. Persist manual width as a percentage; leave room for player controls.
- **Language isolation:** translation cache keys include source language, target language, and text. Unknown source language can fall back to detection.
- **Storage:** resetting subtitle preferences must preserve saved cards. Imports merge validated cards without deleting the existing collection.
- **Export integrity:** translated/bilingual SRT must not silently omit missing or misaligned spoken lines.

## Run focused checks

With a Node.js installation that supports its built-in test runner:

```sh
node --test tests/*.test.cjs
```

For a focused check:

```sh
node --test tests/latency.test.cjs tests/startup.test.cjs
node --test tests/layout.test.cjs tests/resize.test.cjs
```

The suites execute the shipping scripts inside a VM with simulated DOM and extension APIs. They cover startup, clock alignment, source recovery, translation languages, deadlines, layout, selection, resize, shortcuts, study, and extension reloads.

**Browser validation has a separate scope.** Isolated Edge checks with synthetic YouTube fixtures exercise the actual extension UI, but are not proof that every live YouTube video works. A real translation endpoint responding once is not a latency guarantee. After behavior changes, check a captioned live video when available and report unavailable or unverified cases explicitly.

## Documentation screenshots

The images in `docs/images/` use the real v3.8.1 extension interface with an original illustrated lake scene and sample German/Chinese captions. They are demonstration fixtures, not screenshots of a live YouTube video or a user's browser profile. The word-lookup capture used the live Google endpoint.

## Submit a change

Keep changes focused, include a reproduction for bugs, update all three interface locales when adding labels, and check the behavior affected by your patch. Preserve the MIT license and original attribution. Update download links, version badges, screenshots, and release notes when they become outdated.
