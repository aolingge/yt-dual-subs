# YT Dual Subs

> Bilingual subtitles for YouTube — the original language and your translation shown together as a single, non‑overlapping layer that switches cleanly sentence by sentence.

**中文说明 → [README.zh-CN.md](README.zh-CN.md)**

A clean‑room, open‑source **Manifest V3** extension. It reads the video's real caption track, translates it, and renders both languages in one tidy overlay you can fully style and drag — no overlap, no word‑by‑word flicker.

---

## Features

- **Dual subtitles, one layer.** Original and translation each have their own area and wrap onto multiple lines when needed. YouTube's own caption layer is hidden, so the two never overlap.
- **Per‑sentence, no jitter.** Adjacent timed caption cues are joined into readable sentences and shown from the sentence start. Long pauses and excessively long unpunctuated text are split safely; screen-caption fallback cannot look ahead.
- **Sound cues hidden.** Common bracketed labels such as `[musik]` and `[音乐]` are removed from the on-screen subtitles while spoken text and ordinary brackets stay intact. SRT exports retain the original cues.
- **Two translation engines, three modes.** YouTube whole-track translation is the default; per-sentence mode uses Google's free endpoint; optional Fast display translates the current sentence through Google while YouTube loads.
- **Fully customizable.** Per‑line font, size, text colour, background colour + opacity, outline, line spacing, and which line sits on top. Live preview in the popup.
- **Draggable.** Grab the handle and drop the subtitle box anywhere on the video; it persists, double‑click to reset. Works in fullscreen.
- **One‑click toggle.** A button in the player's control bar turns the whole thing on/off (and YouTube's CC with it) — handy for videos with burned‑in subtitles.
- **Export to SRT.** Download the current video's subtitles as a standard `.srt` file — original, translation, or bilingual — straight from the popup.
- **Robust.** Survives SPA navigation, falls back to reading the on‑screen caption text if the cue fetch ever fails, and turns YouTube captions on for you automatically.

- **Survives an extension reload.** Reloading or updating the extension while a YouTube tab stays open no longer raises `Extension context invalidated` in the errors panel: the older script notices its context is dead, stops its loops and listeners quietly, and keeps rendering with built-in labels. Refresh the tab to pick up the new version.
- **Already watched? Instant.** The cues of videos you opened in this session are kept in memory, so going back to one paints its subtitles immediately while the page refreshes them in the background.
- **Subtitle sync nudge.** If the lines sit slightly early or late against the audio, the popup's sync slider shifts them by up to ±2 s. Exported SRT timing is left untouched.
- **Live status line.** The popup reports what the current tab is doing: waiting for YouTube, reading Google, how many sentences are loaded, whether the free endpoint is cooling down after a rate limit, and which version is loaded.
- **Idle when nothing changes.** The overlay stops re-rendering while the video is paused or the tab is in the background, and paints again at once after a seek or a settings change.
- **Study mode: repeat & slow down.** Replay the sentence on screen 2, 3 or 5 times, or loop it, at 0.75× / 0.6× / 0.5×; the normal rate comes back when the repeat stops. `Alt+Shift+S` repeats the current sentence at any time.
- **The word being spoken is boxed, not popped.** The sentence is always shown in full and the word currently being spoken gets a soft background box behind it, so the line stays readable while you follow the audio. Word timings only exist on auto-generated tracks; author-written captions show whole sentences.
- **Listen first, then check.** The translation line can be *always* visible, revealed on *hover* over the player, or shown only when you ask for it with `Alt+Shift+U`.
- **Starts sooner.** The caption track is seeded from the player's own track list before the player asks for it, so the first sentence can appear earlier. A guess that turns out stale is dropped silently and the normal capture path takes over.
- **Everything in the popup.** The popup's *Current video* card repeats the sentence on screen, shows or hides the translation, and steps to the previous or next sentence — the same actions as the shortcuts, without leaving the popup. It lists the keys the browser actually assigned and opens the shortcut page in one click.
- **You keep the caption switch.** *Turn YouTube captions on for me* can be turned off, and then the extension never touches the player's own CC button: you pick the track, the overlay still draws on top of it.
- **Hover reveal works in fullscreen.** The reveal follows where the pointer actually is instead of a `:hover` selector, which is permanently true once the player fills the screen.
- **Video language study.** The popup identifies the original caption-track and target languages, lets you search and jump between sentences, and saves difficult lines for replay and translation-hidden review. A study preset enables original text, translation on hover, and a 0.75× repeat speed while keeping your chosen target language.
- **Selectable subtitle text.** Drag-select and copy either line without pausing the player. Hover translation hides as soon as the pointer leaves the player or browser window.
- **Captions fit the player.** Windowed, theater, and miniplayer layouts reduce oversized text using the actual player dimensions. The native control bar always has a clear area; preset and dragged positions remain within the player. Fullscreen restores your preferred sizes, with long captions reduced further if needed. Resizing never rewrites saved sizes or positions.
- **Resizable subtitle box.** Drag the left or right grip to narrow or widen the box while keeping the opposite edge fixed. Manual widths fill both subtitle backgrounds and are saved as 20–96% of the player, including across fullscreen changes. Text reflows within the chosen width; subtitle selection and native controls keep working.
- **Word lookup on hover.** Pause over a word in the original captions for about 0.4 seconds to see a translation from the existing Google backend. Moving to another word invalidates the old result; repeated lookups use a bounded in-page cache. German words also offer a link to the German Assistant dictionary, opened only when clicked. Isolated word translations can differ from the meaning in context, so use the sentence and dictionary for ambiguous words. You can turn lookup off in Study settings.

## How it works

YouTube serves caption tracks from an `/api/timedtext` endpoint that now requires a per‑request **proof‑of‑origin token** (`pot`). An extension can't just fetch a track URL on its own — it gets an empty response. So instead:

1. A MAIN‑world script (`inject.js`) passively watches the page (XHR, `fetch`, and Resource Timing) and captures the **player's own** timedtext request, which already carries a valid `pot`.
2. It re‑fetches that exact URL as `json3` for the original cues, and again with `&tlang=` for YouTube's translation — aligned cue‑for‑cue. Pairing is also timestamp‑checked: a fragment whose start is off by more than ~1.2 s is rejected, and that sentence is translated as a whole instead, so a plausible‑looking line can never land beside the wrong original.
3. `content.js` groups adjacent cues for display, then drives the overlay off `video.currentTime`. Raw cues remain available for SRT export.
4. If the cue fetch ever fails, it falls back to reading the on‑screen caption text directly.

## Install (load unpacked)

1. **Download the latest release ZIP** from the [Releases page](https://github.com/Gythiro/yt-dual-subs/releases/latest) and unzip it. *(Prefer the command line? `git clone` works too.)*
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top‑right).
4. Click **Load unpacked** and select the unzipped folder.
5. Open a YouTube video with captions — the subtitles appear automatically (the extension turns captions on for you).

Works on Chrome, Edge, and other Chromium browsers. Requires Chrome 111+ (for the MAIN‑world content script).

**Updating:** click the reload icon on the extension's card in `chrome://extensions`, then refresh any YouTube tab that was already open — a page keeps the script it was loaded with until it is refreshed.

## Usage

- **Toolbar icon** → settings popup: target language, translation engine, line order, position, spacing, and per‑line styling, all with a live preview.
- **Control-bar button** (the caption icon next to the gear): one-click on/off. Blue = on, grey = off.
- **Alt+Shift+Y**: show/hide only the translated subtitle line. If the key is unavailable, set it under `edge://extensions/shortcuts`.
- **Drag** the subtitle box by its handle (appears top‑left when you hover the player); **double‑click** the handle to reset its position.
- **Export** (popup → *Export*): download the subtitles as an `.srt` file — choose original, translation, or bilingual.

- **Subtitles a touch early or late?** Popup → *Sync offset*: shift the cue timing by up to ±2 s. Only what you see moves; exported `.srt` timing keeps the original.
- **Something missing?** The status line at the top of the popup says whether the tab is running on YouTube's track, on Google, or still waiting, how many sentences are loaded, and whether the free endpoint is cooling down.
- **Alt+Shift+S** repeats the sentence on screen at the study rate (press again to stop). **Alt+Shift+U** shows/hides the translation line when the reveal mode is *Manual*. Both keys can be changed under `edge://extensions/shortcuts`.
- **Study mode** (popup → *Study*): repeat count, repeat speed, word box, and how the translation line is revealed.
- **Current video** (popup → *Current video*): the same four actions as the keys, as buttons — repeat the sentence on screen, show/hide the translation, previous sentence, next sentence. *Previous* restarts the sentence you are in once it is under way, and steps back to the one before when you press it within the first second of a sentence. Changing the keys themselves is a browser-side setting, so the card links straight to it and shows what the browser assigned. Turn off *Turn YouTube captions on for me* to choose the caption track yourself — the overlay keeps working on whatever you enable.
- **Video language study** (popup → *Learn languages with video*): select the original caption track in YouTube, then choose the translation target. Select *Other language code…* for a target outside the built-in list (for example `nl`, `tr`, `uk`, or `pt-BR`). Search and jump through sentences, save difficult lines, replay them, reveal their translation for self-testing, and mark them learned. Saved lines stay in this browser's extension-local storage. Export/import a JSON backup to move them; import merges without replacing existing lines. *Reset subtitle settings* leaves them alone.
- **Word lookup** (popup → *Study* → *Look up words by hovering*): pause the pointer on a word in the original video caption. Dragging to select text does not request a lookup. German Assistant opens only when you click *More in German Assistant*; hovering never opens an external site.
- **Automatic layout**: font-size sliders set the preferred full-player size. A smaller player scales the text down and wraps both lines above the controls. Extremely long text in a tiny player can be scrolled inside the subtitle area without losing words.
- **Box width** (popup → *Layout* → *Subtitle box width*): drag either side grip or use the width slider. Settings are saved when a drag ends. Double-click a side grip or select *Reset width* to return to automatic sizing; this keeps your font preferences. Focus a side grip and use the arrow keys for small width adjustments.
- **Complete bilingual SRT only.** Export checks translation timestamps too. If spoken lines are missing or misaligned, translated/bilingual export stops and reports the count; original-only export remains available.

## Translation engines

| | Whole‑sentence (`tlang`) — default | Per‑sentence (`gtx`) |
|---|---|---|
| Source | YouTube's own server‑side translation | Google Translate's free endpoint |
| Alignment | Paired by cue order and checked against timestamps | Per displayed sentence |
| Best for | When YouTube provides a translated track | When YouTube can't translate a track, or you prefer Google's wording |
| Note | Auto‑falls back to `gtx` when a track isn't translatable | Unofficial endpoint — heavy use may be rate‑limited |

Per‑sentence translation tells Google the caption track's language explicitly (e.g. `de`) instead of leaving it to auto‑detection, which has too little to work with on a few‑word subtitle; auto‑detection is used only when no track language is known (screen‑caption fallback). The cache is keyed by source language + target language + text, so one video's translation is never reused for a different source.

The original caption track is not restricted to German: English, Spanish, Japanese, Arabic, and other tracks use the same caption and translation path. Custom target codes let you try more languages, but a video needs captions and translation availability depends on YouTube or Google; no extension can guarantee every language on every video.

**Fast display** (optional): sends the current sentence to Google while waiting for YouTube's whole-track translation. Once the YouTube track arrives, later sentences use it; the already-visible sentence is not rewritten. Google rate limits or errors leave the extension waiting for YouTube. This mode sends the current sentence to Google even when YouTube translation eventually succeeds.

Every Google request is timeout-guarded: an attempt that never answers is aborted after 8 s and retried once — a hung request would otherwise occupy one of the few in-flight slots forever. A rate-limit answer (HTTP 429) is never retried; the extension backs off for 20 s, then 60 s, then 3 minutes, keeps showing whatever YouTube provides in the meantime, and clears the wait on the first successful reply.

## Limitations

- Needs a real caption track. **Burned‑in** subtitles (baked into the video pixels) can't be hidden — use the control‑bar toggle to switch the overlay off for those videos.
- The Google fallback uses an unofficial endpoint with no SLA; heavy use may be rate‑limited.
- Depends on YouTube's current behaviour; a major YouTube change may require a selector update.

## Privacy

No analytics, no tracking, no accounts. Default mode prefers YouTube and falls back to Google when translation is unavailable; per-sentence mode uses Google; Fast display uses both, sending the current sentence to Google while waiting. When hover lookup is enabled, only the hovered word is sent to Google after about 0.4 seconds. The German Assistant dictionary receives the word only when its link is clicked; no new host permissions were added. Settings are stored in `chrome.storage.sync`. Saved sentences use `chrome.storage.local` and do not sync automatically; export a backup before uninstalling the extension.

## Development

Plain vanilla JS/CSS — no build step, no dependencies.

| File | Role |
|---|---|
| `inject.js` | MAIN‑world sniffer: captures the player's pot‑bearing timedtext URL, fetches cues + translation |
| `content.js` | Overlay, cue engine, drag, control‑bar toggle, rendered‑scrape fallback |
| `background.js` | Translation service worker (Google endpoint) |
| `popup.html/.css/.js` | Settings UI with live preview |
| `study.js` | Sentence browser, local saved-list and review UI |
| `content.css` | Overlay styling + native‑caption suppression |

### Tests

`node --test` runs the source-level suite, including hover lookup delay, cache reuse, and stale-response handling. The extension also needs a browser check after loading an unpacked build because YouTube controls and pointer behavior cannot be fully simulated.

`node tests/<name>.test.cjs` — no framework, no install. The suites run the real `content.js`, `inject.js`, and `background.js` inside `node:vm` against a fake YouTube page, popup, and extension API, so they assert the shipping source instead of a copy of it. `tests/context-invalidated.test.cjs` makes that fake extension API throw `Extension context invalidated` like a real reload does, so the crash reported on `content.js:25` cannot come back silently. `tests/study.test.cjs` drives repeat, slowed playback, the word box, the reveal modes, the pointer reveal and the sentence-stepping buttons; `tests/startup.test.cjs` covers the caption track seeded from the player's own track list, and that a stale guess never falls back to scraping.

## Credits

A clean‑room reimplementation inspired by the (closed‑source, discontinued) *YouTube™ Dual Subtitles* — built from scratch without using its code, with the overlap and word‑by‑word jitter problems solved at the source.

## License

[MIT](LICENSE).
