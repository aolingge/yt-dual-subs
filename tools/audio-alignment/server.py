"""Optional loopback helper. Public audio + existing captions -> CTC word times.

No cookies, API keys, remote code, audio upload to a provider, or autostart.
The German model is MIT licensed: oliverguhr/wav2vec2-base-german-cv9.
CTC dynamic programming follows the PyTorch forced-alignment tutorial:
https://docs.pytorch.org/audio/main/tutorials/forced_alignment_tutorial.html
"""
from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
import wave

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
os.environ.setdefault("USE_TF", "0")

PORT = 8765
VERSION = 1
MODELS = {
    "de": ("oliverguhr/wav2vec2-base-german-cv9", "e3c2cb317c771e7fbbdfbf20be6017b8e65b232d"),
    "en": ("facebook/wav2vec2-base-960h", "main"),
}
MAX_BODY = 3 * 1024 * 1024
MAX_AUDIO = 512 * 1024 * 1024
MAX_CUES = 5000
ROOT = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".cache")) / "YT Dual Subs" / "audio-alignment"


class AlignmentError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def validate_request(data):
    if not isinstance(data, dict) or not re.fullmatch(r"[\w-]{11}", str(data.get("videoId", "")), re.ASCII):
        raise AlignmentError("invalidRequest")
    language = str(data.get("language", "")).split("-")[0].lower()
    if language not in MODELS:
        raise AlignmentError("unsupportedLanguage")
    cues = data.get("cues")
    if not isinstance(cues, list) or not 0 < len(cues) <= MAX_CUES:
        raise AlignmentError("invalidRequest")
    cleaned = []
    for cue in cues:
        if not isinstance(cue, dict):
            raise AlignmentError("invalidRequest")
        start, dur = cue.get("start"), cue.get("dur")
        text, tokens = cue.get("text"), cue.get("tokens")
        if (not isinstance(start, (int, float)) or not 0 <= start <= 86_400_000
                or not isinstance(dur, (int, float)) or not 0 < dur <= 30_000
                or not isinstance(text, str) or not 0 < len(text) <= 2000
                or not isinstance(tokens, list) or not 0 < len(tokens) <= 256
                or any(not isinstance(w, str) or not 0 < len(w) <= 120 or w not in text for w in tokens)):
            raise AlignmentError("invalidRequest")
        cleaned.append({"start": start, "dur": dur, "text": text, "tokens": tokens})
    priority = data.get("positionMs", 0)
    if not isinstance(priority, (int, float)) or not 0 <= priority <= 86_400_000:
        priority = 0
    return {"videoId": data["videoId"], "language": language, "cues": cleaned, "positionMs": priority}


def cache_key(data):
    payload = {k: data[k] for k in ("videoId", "language", "cues")}
    payload["model"] = MODELS[data["language"]]
    payload["version"] = VERSION
    return hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def ctc_words(log_probs, labels, owners, blank_id):
    """Viterbi CTC path, including blank states and repeated-letter constraints.

    Leading/trailing audio may be outside the caption. A failed or weak path is
    rejected, never filled with evenly distributed timestamps.
    """
    import numpy as np
    frames, _ = log_probs.shape
    if not labels or frames < len(labels):
        return None
    states = np.full(2 * len(labels) + 1, blank_id, dtype=np.int64)
    states[1::2] = labels
    skip = np.zeros(len(states), dtype=bool)
    skip[2:] = (states[2:] != blank_id) & (states[2:] != states[:-2])
    previous = np.full(len(states), -np.inf, dtype=np.float32)
    previous[0] = 0
    moves = np.zeros((frames, len(states)), dtype=np.uint8)
    best, end_frame, end_state = -np.inf, -1, -1
    for frame in range(frames):
        one = np.concatenate(([-np.inf], previous[:-1]))
        two = np.concatenate(([-np.inf, -np.inf], previous[:-2]))
        two[~skip] = -np.inf
        options = np.stack((previous, one, two))
        move = options.argmax(axis=0)
        current = options[move, np.arange(len(states))] + log_probs[frame, states]
        moves[frame] = move
        # Permit a start after non-captioned leading sound, without assigning
        # that sound to the first word.
        current[0] = 0
        for state in (len(states) - 2, len(states) - 1):
            if current[state] > best:
                best, end_frame, end_state = current[state], frame, state
        previous = current
    if end_frame < 0 or not np.isfinite(best):
        return None
    word_frames = [[] for _ in range(max(owners) + 1)]
    state = end_state
    for frame in range(end_frame, -1, -1):
        if state % 2:
            label_index = state // 2
            if owners[label_index] >= 0:
                word_frames[owners[label_index]].append((frame, float(np.exp(log_probs[frame, labels[label_index]]))))
        state -= int(moves[frame, state])
        if state == 0:
            break
    if state > 0 or any(not points for points in word_frames):
        return None
    words = []
    for points in word_frames:
        score = sum(p[1] for p in points) / len(points)
        if score < 0.12:
            return None
        words.append((min(p[0] for p in points), max(p[0] for p in points) + 1, score))
    if sum(w[2] for w in words) / len(words) < 0.25:
        return None
    return words


class Aligner:
    def __init__(self, root):
        self.root = root
        self.loaded = {}

    def load(self, language):
        if language in self.loaded:
            return self.loaded[language]
        import torch
        from transformers import Wav2Vec2CTCTokenizer, Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC
        torch.set_num_threads(min(4, max(1, os.cpu_count() or 1)))
        name, revision = MODELS[language]
        options = {"revision": revision, "cache_dir": str(self.root / "models"), "token": False,
                   "trust_remote_code": False}
        # Explicit classes avoid the German model's optional language-model
        # decoder and its extra dependencies. Only safetensors weights load.
        extractor = Wav2Vec2FeatureExtractor.from_pretrained(name, **options)
        tokenizer = Wav2Vec2CTCTokenizer.from_pretrained(name, **options)
        model = Wav2Vec2ForCTC.from_pretrained(name, use_safetensors=True, **options).eval()
        value = (extractor, tokenizer, model)
        self.loaded[language] = value
        return value

    def align(self, cue, audio, language):
        import numpy as np
        import torch
        extractor, tokenizer, model = self.load(language)
        vocab = tokenizer.get_vocab()
        labels, owners = [], []
        for index, word in enumerate(cue["tokens"]):
            # lower() preserves German ß. Ignore punctuation inside lexical
            # tokens; unsupported letters/numbers cannot receive real times.
            letters = [c for c in unicodedata.normalize("NFKC", word).lower() if c.isalnum()]
            letters = [c if c in vocab else c.upper() for c in letters]
            if not letters or any(c not in vocab for c in letters):
                return None
            if labels and tokenizer.word_delimiter_token in vocab:
                labels.append(vocab[tokenizer.word_delimiter_token])
                owners.append(-1)
            labels.extend(vocab[c] for c in letters)
            owners.extend([index] * len(letters))
        # Never borrow audio from a neighbouring caption. Small source timing
        # errors result in rejection rather than out-of-window word timestamps.
        first = int(cue["start"] * 16)
        last = min(len(audio), int((cue["start"] + cue["dur"]) * 16))
        waveform = audio[first:last]
        if len(waveform) < 800 or float(np.sqrt(np.mean(waveform ** 2))) < 0.0003:
            return None
        inputs = extractor(waveform, sampling_rate=16000, return_tensors="pt")
        with torch.inference_mode():
            logits = model(**inputs).logits[0]
            emissions = torch.log_softmax(logits, dim=-1).cpu().numpy()
        words = ctc_words(emissions, labels, owners, model.config.pad_token_id)
        if words is None:
            return None
        frame_ms = len(waveform) / 16 / len(emissions)
        result = []
        for word, (start, end, score) in zip(cue["tokens"], words):
            result.append({"u": word, "t": round(cue["start"] + start * frame_ms, 1),
                           "e": min(cue["start"] + cue["dur"], round(cue["start"] + end * frame_ms, 1)),
                           "score": round(score, 4)})
        return {"start": cue["start"], "dur": cue["dur"], "text": cue["text"], "words": result}


def ffmpeg_path():
    override = os.environ.get("YTDS_FFMPEG")
    if override and Path(override).is_file() and Path(override).suffix.lower() == ".exe":
        return override
    found = shutil.which("ffmpeg.exe") or shutil.which("ffmpeg")
    if found and Path(found).suffix.lower() not in (".cmd", ".bat"):
        return found
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "ffmpeg" / "ffmpeg.exe"
    if local.is_file():
        return str(local)
    raise AlignmentError("ffmpegMissing")


def decode_audio(source, output):
    import numpy as np
    command = [ffmpeg_path(), "-nostdin", "-v", "error", "-y", "-i", str(source),
               "-vn", "-ac", "1", "-ar", "16000", "-acodec", "pcm_s16le", str(output)]
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=600,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        with wave.open(str(output), "rb") as wav:
            if wav.getframerate() != 16000 or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                raise AlignmentError("audioInvalid")
            if wav.getnframes() > 16000 * 6 * 3600:
                raise AlignmentError("audioTooLong")
            return np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768
    except AlignmentError:
        raise
    except Exception:
        raise AlignmentError("audioInvalid") from None


class QuietLogger:
    def debug(self, _message): pass
    def info(self, _message): pass
    def warning(self, _message): pass
    def error(self, _message): pass


class Jobs:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.aligner = Aligner(self.root)
        self.lock = threading.Lock()
        self.worker_lock = threading.Lock()
        self.jobs = {}

    def create(self, data):
        data = validate_request(data)
        key = cache_key(data)
        with self.lock:
            for job in self.jobs.values():
                if job["key"] == key and job["status"] not in ("error", "cancelled"):
                    return job["id"]
            if sum(j["status"] not in ("done", "error", "cancelled") for j in self.jobs.values()) >= 2:
                raise AlignmentError("busy")
            job_id = secrets.token_hex(16)
            folder = self.root / "jobs" / key
            folder.mkdir(parents=True, exist_ok=True)
            job = {"id": job_id, "key": key, "data": data, "status": "awaitingAudio",
                   "done": 0, "total": len(data["cues"]), "segments": [], "cancel": False,
                   "error": "", "folder": folder}
            cache = folder / "timings.json"
            if cache.is_file():
                try:
                    result = json.loads(cache.read_text(encoding="utf-8"))
                    job.update(status="done", done=job["total"], segments=result["segments"])
                except (ValueError, KeyError):
                    pass
            self.jobs[job_id] = job
            # Keep memory bounded; persistent job results remain on disk.
            if len(self.jobs) > 12:
                for old_id, old in list(self.jobs.items()):
                    if old_id != job_id and old["status"] in ("done", "error", "cancelled"):
                        del self.jobs[old_id]
                        break
            return job_id

    def snapshot(self, job_id, after=0):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise AlignmentError("notFound")
            after = max(0, min(after, len(job["segments"])))
            segments = job["segments"][after:after + 60]
            return {"id": job_id, "status": job["status"], "done": job["done"], "total": job["total"],
                    "aligned": len(job["segments"]), "error": job["error"], "segments": segments,
                    "nextCursor": after + len(segments)}

    def start(self, job_id, source=None):
        with self.lock:
            job = self.jobs.get(job_id)
            if not job:
                raise AlignmentError("notFound")
            if job["status"] != "awaitingAudio":
                return
            job["status"] = "queued"
        threading.Thread(target=self.run, args=(job, source), daemon=True).start()

    def cancelled(self, job):
        if job["cancel"]:
            raise AlignmentError("cancelled")

    def run(self, job, source):
        try:
            with self.worker_lock:
                self.cancelled(job)
                folder, data = job["folder"], job["data"]
                wav_path = folder / "audio.wav"
                if source is None and wav_path.is_file():
                    source = wav_path
                if source is None:
                    job["status"] = "downloadingAudio"
                    source = self.download(data["videoId"], folder)
                self.cancelled(job)
                job["status"] = "decodingAudio"
                # Existing decoded audio is safe to read without in-place ffmpeg.
                if source == wav_path:
                    import numpy as np
                    with wave.open(str(wav_path), "rb") as wav:
                        audio = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(np.float32) / 32768
                else:
                    audio = decode_audio(source, wav_path)
                self.cancelled(job)
                job["status"] = "loadingModel"
                self.aligner.load(data["language"])
                self.cancelled(job)
                job["status"] = "aligning"
                position = data["positionMs"]
                # Current sentence first, then upcoming speech, then earlier.
                ordered = sorted(data["cues"], key=lambda c: (0 if c["start"] <= position < c["start"] + c["dur"]
                                 else 1 if c["start"] >= position else 2, c["start"]))
                for cue in ordered:
                    self.cancelled(job)
                    aligned = self.aligner.align(cue, audio, data["language"])
                    with self.lock:
                        if aligned:
                            job["segments"].append(aligned)
                        job["done"] += 1
                self.cancelled(job)
                cache = folder / "timings.json"
                temporary = cache.with_suffix(".tmp")
                encoded = json.dumps({"segments": job["segments"]}, ensure_ascii=False)
                temporary.write_text(encoded, encoding="utf-8")
                try:
                    temporary.replace(cache)
                except OSError as error:
                    # Windows packaged apps can redirect newly-created files
                    # to another volume even under one apparent directory.
                    if error.errno != errno.EXDEV:
                        raise
                    cache.write_text(encoded, encoding="utf-8")
                job["status"] = "done"
        except AlignmentError as error:
            job["status"] = "cancelled" if error.code == "cancelled" else "error"
            job["error"] = error.code
        except Exception as error:
            # Do not leak signed media URLs, local paths, tokens or model errors
            # into the browser, notes or logs.
            job["status"], job["error"] = "error", "alignmentFailed"
            print("Alignment failed: " + type(error).__name__, flush=True)

    def download(self, video_id, folder):
        import yt_dlp
        options = {"format": "bestaudio/best", "outtmpl": str(folder / "source.%(ext)s"),
                   "quiet": True, "no_warnings": True, "logger": QuietLogger(), "noplaylist": True,
                   "socket_timeout": 20, "retries": 1, "fragment_retries": 1,
                   "cookiefile": None, "js_runtimes": {"node": {}}, "remote_components": []}
        try:
            with yt_dlp.YoutubeDL(options) as downloader:
                info = downloader.extract_info("https://www.youtube.com/watch?v=" + video_id, download=True)
                source = Path(downloader.prepare_filename(info))
                if not source.is_file() or source.stat().st_size > MAX_AUDIO:
                    raise AlignmentError("audioTooLong")
                return source
        except AlignmentError:
            raise
        except Exception:
            raise AlignmentError("youtubeUnavailable") from None


class Handler(BaseHTTPRequestHandler):
    server_version = "YTDSAlignment/1"

    def log_message(self, _format, *_args): pass

    def origin(self):
        origin = self.headers.get("Origin", "")
        # Reject websites, opaque origins, DNS rebinding and external hosts.
        if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
            raise AlignmentError("forbidden")
        if origin and not re.fullmatch(r"chrome-extension://[a-p]{32}", origin):
            raise AlignmentError("forbidden")
        return origin

    def reply(self, value, code=200):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(code)
        origin = self.headers.get("Origin", "")
        if re.fullmatch(r"chrome-extension://[a-p]{32}", origin):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        try:
            self.origin()
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", ""))
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
            self.end_headers()
        except AlignmentError:
            self.reply({"error": "forbidden"}, 403)

    def do_GET(self):
        try:
            self.origin()
            url = urlsplit(self.path)
            if url.path == "/health":
                # The cache location is reported so "alignment works but nothing is
                # cached" can be diagnosed instead of silently re-downloading models.
                self.reply({"ok": True, "version": VERSION, "languages": list(MODELS),
                            "cacheDir": str(getattr(self.server.jobs, "root", "")),
                            "writable": getattr(self.server, "writable", None)})
            elif re.fullmatch(r"/jobs/[a-f0-9]{32}", url.path):
                after = int(parse_qs(url.query).get("after", ["0"])[0])
                self.reply(self.server.jobs.snapshot(url.path.split("/")[-1], after))
            else:
                self.reply({"error": "notFound"}, 404)
        except (ValueError, AlignmentError) as error:
            self.reply({"error": getattr(error, "code", "invalidRequest")}, 400)

    def do_POST(self):
        try:
            self.origin()
            length = int(self.headers.get("Content-Length", "0"))
            if self.path == "/jobs":
                if self.headers.get("Content-Type", "").split(";")[0] != "application/json" or not 0 < length <= MAX_BODY:
                    raise AlignmentError("invalidRequest")
                data = json.loads(self.rfile.read(length))
                self.reply({"id": self.server.jobs.create(data)})
                return
            match = re.fullmatch(r"/jobs/([a-f0-9]{32})/(start|audio|cancel)", self.path)
            if not match:
                raise AlignmentError("notFound")
            job_id, action = match.groups()
            job = self.server.jobs.jobs.get(job_id)
            if not job:
                raise AlignmentError("notFound")
            if action == "cancel":
                job["cancel"] = True
                if job["status"] == "awaitingAudio":
                    job["status"] = "cancelled"
            elif action == "start":
                self.server.jobs.start(job_id)
            else:
                if self.headers.get("Content-Type") != "application/octet-stream" or not 0 < length <= MAX_AUDIO:
                    raise AlignmentError("invalidRequest")
                if job["status"] != "awaitingAudio":
                    raise AlignmentError("busy")
                source = job["folder"] / "uploaded.audio"
                remaining = length
                with source.open("wb") as audio:
                    while remaining:
                        chunk = self.rfile.read(min(65536, remaining))
                        if not chunk:
                            raise AlignmentError("audioInvalid")
                        audio.write(chunk)
                        remaining -= len(chunk)
                self.server.jobs.start(job_id, source)
            self.reply({"ok": True})
        except (ValueError, AlignmentError) as error:
            self.reply({"error": getattr(error, "code", "invalidRequest")}, 400)


class Server(ThreadingHTTPServer):
    # Windows honours SO_REUSEADDR by letting a second process bind the same port,
    # which silently split requests between two helpers (a job created in one was
    # unknown to the other). Bind exclusively so a duplicate start fails loudly.
    allow_reuse_address = False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--cache-dir", type=Path, default=ROOT)
    args = parser.parse_args()
    jobs = Jobs(args.cache_dir)
    try:
        server = Server(("127.0.0.1", args.port), Handler)
    except OSError as error:
        print(f"Could not listen on 127.0.0.1:{args.port}: {error}.\n"
              "Another helper is probably still running: run Stop-AudioAlignment.ps1, "
              "then start Start-AudioAlignment.ps1 again.", flush=True)
        sys.exit(1)
    server.jobs = jobs
    server.writable = os.access(jobs.root, os.W_OK)
    print(f"YT Dual Subs audio alignment: http://127.0.0.1:{args.port} (Ctrl+C to stop)", flush=True)
    print(f"Cache: {jobs.root} (writable: {server.writable})", flush=True)
    if not server.writable:
        print("Warning: the cache folder is not writable, so models and results cannot be reused.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
