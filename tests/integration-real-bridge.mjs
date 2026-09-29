// A real end-to-end pass over the browser path, with the actual desktop bridge
// and the models it already has on disk.
//
//   node tests/integration-real-bridge.mjs
//
// The browser-side modules (bridge-client, media-clock, recognizer-stream) are
// run in a vm sandbox exactly as the extension loads them, the bridge is spawned
// from the deutschapp virtual environment, and a real speech sample is pushed
// through the protocol in chunks smaller than the model's own frame. Nothing
// here is a stub: the transcript, the translation and the timestamps are what
// the desktop engine actually produced.

import { readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const extension = dirname(here);
const desktop = "E:\\codemain\\deautschapp";
const python = join(desktop, ".venv", "Scripts", "python.exe");
const sample = join(desktop, ".superpowers", "samples", "zh.wav");

const failures = [];
const check = (condition, message, detail) => {
  if (condition) {
    console.log("  ok   " + message);
  } else {
    failures.push(message);
    console.log("  FAIL " + message + (detail === undefined ? "" : "  -> " + JSON.stringify(detail)));
  }
};

const state = join(tmpdir(), "ytds-bridge-e2e-" + process.pid);
rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });

console.log("bridge: " + python + " -m deutsch_overlay.browser_cli --port 0");
const server = spawn(python, ["-m", "deutsch_overlay.browser_cli", "--port", "0"], {
  cwd: desktop,
  env: { ...process.env, DEUTSCH_OVERLAY_STATE: state },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });

const handshakePath = join(state, "bridge.json");
const deadline = Date.now() + 120000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let handshake = null;
while (Date.now() < deadline) {
  try {
    const text = readFileSync(handshakePath, "utf8");
    handshake = JSON.parse(text);
    break;
  } catch (_e) {
    await sleep(500);
  }
}
if (!handshake) {
  console.error("the bridge never wrote its handshake; output was:\n" + serverLog);
  server.kill();
  process.exit(1);
}
console.log("bridge: " + handshake.url + " (pid " + handshake.pid + ")\n");

// ---------------------------------------------------------------- load the client

const load = (name) => readFileSync(join(extension, name), "utf8");
const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, Math,
  JSON, Object, Array, Number, String, Boolean, Set, Map, Error, Uint8Array, Float32Array, ArrayBuffer,
  TextEncoder, TextDecoder, fetch: globalThis.fetch };
vm.createContext(sandbox);
for (const name of ["bridge-client.js", "media-clock.js", "recognizer-stream.js"]) {
  vm.runInContext(load(name), sandbox, { filename: name });
}
const YtdsBridge = sandbox.YtdsBridge;
const YtdsMediaClock = sandbox.YtdsMediaClock;
const RecognizerSession = sandbox.YtdsRecognizerStream.RecognizerSession;

check(!!YtdsBridge && !!YtdsMediaClock && !!RecognizerSession, "the browser modules loaded");
check(handshake.protocolVersion === YtdsBridge.PROTOCOL_VERSION,
  "the handshake speaks the protocol this client speaks",
  { bridge: handshake.protocolVersion, client: YtdsBridge.PROTOCOL_VERSION });

const client = YtdsBridge.createClient({ base: handshake.url, token: handshake.token, fetch: globalThis.fetch });
const health = await client.health();
check(health.service === "deutsch-overlay-bridge", "the health answer identifies the bridge", health.service);
check(Array.isArray(health.languages) && health.languages.includes("zh"),
  "the bridge can recognize Chinese", health.languages);

// ---------------------------------------------------------------- the audio

function readWav(path) {
  const bytes = readFileSync(path);
  const channels = bytes.readUInt16LE(22);
  const rate = bytes.readUInt32LE(24);
  const bits = bytes.readUInt16LE(34);
  const dataAt = 12 + 8 + 16 + (bytes.readUInt32LE(16) > 16 ? bytes.readUInt32LE(16) - 16 : 0);
  if (bits !== 16 || channels !== 1) throw new Error("the sample must be 16-bit mono");
  return { rate, samples: bytes.subarray(dataAt) };
}

const germanSample = join(desktop, ".superpowers", "samples", "de.wav");
const chinese = readWav(sample);
const seconds = chinese.samples.length / 2 / chinese.rate;
console.log("audio: " + sample + " (" + seconds.toFixed(2) + " s at " + chinese.rate + " Hz)\n");

// A 22.05 kHz source, in chunks far smaller than a model frame: the desktop
// resampler is the only thing standing between this and the recognizer.

async function run(question) {
  const updates = [];
  let states = [];
  const audio = question.sample ? readWav(question.sample) : chinese;
  const clock = new YtdsMediaClock.MediaClock({});
  const session = new RecognizerSession({
    bridge: client,
    clock,
    platform: question.platform,
    videoKey: question.videoKey,
    captionAvailability: question.captionAvailability,
    sourceLanguage: question.sourceLanguage,
    title: question.title,
    url: "https://www.bilibili.com/video/" + question.videoKey,
    durationMs: question.durationMs,
    hasAudioTrack: true,
    sampleRate: audio.rate,
    channels: 1,
    framesPerPacket: 22050,
    onUpdate: (update) => updates.push(update),
    onState: (state) => states.push(state),
  });
  // The page reports where the video is BEFORE the session is created: the
  // bridge insists on an audioStartMs for tab capture, because a caption that
  // cannot be placed on the video timeline is worse than no caption at all.
  session.observe({
    mediaMs: Number.isFinite(question.mediaMs) ? question.mediaMs : 900000,
    wallMs: Date.now(),
    rate: 1,
    paused: false,
    epoch: question.epoch || 1,
  });
  const started = await session.start();
  if (started && started.recognize === false) {
    return { started, updates, states, cues: session.cues, finished: { cues: session.cues } };
  }
  if (question.feed) {
    const chunk = Math.round(audio.rate / 10) * 2; // 100 ms of source audio
    let sent = 0;
    for (let offset = 0; offset < audio.samples.length; offset += chunk) {
      const slice = audio.samples.subarray(offset, Math.min(offset + chunk, audio.samples.length));
      await session.pushPcm(new Uint8Array(slice), { atMs: Date.now() });
      sent += 1;
      if (sent % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await session.tick();
  }
  const finished = await session.finish();
  return { started, updates, states, cues: session.cues, finished };
}

// 1. a video with captions is refused, and no audio is sent for it.
const refused = await run({
  platform: "bilibili", videoKey: "BV1xx#p1", captionAvailability: "present",
  sourceLanguage: "zh", title: "has captions", durationMs: 600000, feed: false,
});
check(refused.started && refused.started.recognize === false,
  "a video that reports captions is refused a session", refused.started);
check(refused.started.reason === "captions_present",
  "the refusal names the caption track as the reason", refused.started.reason);
check(refused.cues.length === 0, "a refused session produces no cues");
check(!refused.states.includes("running"), "a refused session never reports itself running", refused.states);

// 2. an unknown caption verdict is refused just as strictly: the bridge has no
//    proof the video is captionless, and a second copy of existing subtitles is
//    worse than no recognition at all.
const unknown = await run({
  platform: "bilibili", videoKey: "BV1xx#p2", captionAvailability: "unknown",
  sourceLanguage: "zh", title: "unknown", durationMs: 600000, feed: false,
});
check(unknown.started && unknown.started.recognize === false, "an unknown caption verdict is refused",
  unknown.started);
check(unknown.started.reason === "captions_unknown", "the unknown verdict is reported as such",
  unknown.started.reason);

// 3. a video with no captions gets recognized, translated and timed.
//    The video starts at 15 minutes, so the first cue must land there and not at
//    zero: the media time comes from the page, not from when the model finished.
const mediaMs = 900000;
const live = await run({
  platform: "bilibili", videoKey: "BV1xx#p3", captionAvailability: "absent",
  sourceLanguage: "zh", title: "no captions", durationMs: 900000, feed: true,
  mediaMs,
});
check(live.updates.length > 0, "recognition produced caption updates", live.updates.length);
check(live.cues.length > 0, "recognition produced cues", live.cues.length);
if (live.cues.length) {
  const first = live.cues[0];
  console.log("\n    first cue: [" + first.start + ", " + first.end + "] " +
    JSON.stringify(first.text) + " -> " + JSON.stringify(first.trans) + "\n");
  check(first.start >= mediaMs - 1000 && first.start < mediaMs + seconds * 1000,
    "the caption is timed against the video's own timeline, not from zero", first.start);
  check(typeof first.text === "string" && first.text.length > 0, "the original text is kept", first.text);
  check(first.trans !== undefined && first.trans !== null && first.trans !== "",
    "the German translation is attached", first.trans);
  check(first.translationFailed === false, "the translation reported success", first.translationFailed);
  const ordered = live.cues.every((cue, index) => index === 0 || live.cues[index - 1].end <= cue.end + 1);
  check(ordered, "the cues arrive in time order");
  check(live.cues.every((cue) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start),
    "every cue has a real interval");
  check(live.cues.every((cue) => cue.trans || cue.translationFailed),
    "a cue is either translated or marked as a failed translation, never left hanging");
}
const seen = live.states.map((entry) => entry.state);
check(seen.includes("running"), "the session reported itself running", seen);
check(seen[seen.length - 1] === "stopped", "the session reported itself stopped", seen);
check(!seen.includes("degraded") && !seen.includes("failed"),
  "no audio was lost on the way to the recognizer", seen);
check(live.cues.every((cue) => cue.start >= mediaMs - 1000),
  "no cue was placed before the audio the page reported");
check(Array.isArray(live.finished.cues) && live.finished.cues.length === live.cues.length,
  "finish drains the same transcript the updates built");

// 4. German audio is recognized as German and not translated into German. The
//    bridge is not told to translate: German is the target, so there is nothing
//    to do (and a bilingual pair would be the same line twice).
const german = await run({
  platform: "youtube", videoKey: "abc#p1", captionAvailability: "absent",
  sourceLanguage: "de", title: "german", durationMs: 900000, feed: true, mediaMs: 60000,
  sample: germanSample,
});
check(german.cues.length > 0, "a German video with no captions is still recognized",
  { cues: german.cues.length, updates: german.updates.length, states: german.states.map((s) => s.state) });
check(german.cues.every((cue) => !cue.trans || cue.trans === cue.text),
  "a German video is not translated into German",
  german.cues.map((cue) => cue.trans));
if (german.cues.length) {
  console.log("    first cue: [" + german.cues[0].start + ", " + german.cues[0].end + "] " +
    JSON.stringify(german.cues[0].text) + "\n");
  check(german.cues[0].start >= 59000 && german.cues[0].start < 60000 + 4000,
    "the German caption is timed against the video's timeline too", german.cues[0].start);
}

server.kill();
console.log("\n" + (failures.length ? "FAILED: " + failures.length + " check(s)" : "all checks passed"));
if (failures.length) {
  console.log("server said:\n" + serverLog);
  process.exit(1);
}
process.exit(0);
