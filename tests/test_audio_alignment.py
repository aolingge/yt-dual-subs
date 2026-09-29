"""Helper algorithm/API checks; no model download, account or audio required."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import numpy as np

spec = importlib.util.spec_from_file_location("audio_server", Path(__file__).parents[1] / "tools/audio-alignment/server.py")
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


def cue(index=0, start=0, text="Hallo Welt", tokens=("Hallo", "Welt")):
    return {"index": index, "start": start, "dur": 4000, "text": text, "tokens": list(tokens)}


def request():
    return {"videoId": "speechde001", "language": "de", "positionMs": 0, "cues": [cue()]}


class AlignmentChecks(unittest.TestCase):
    def test_ctc_repeated_letters_and_nonzero_blank(self):
        # blank=3, separator=0; two adjacent identical letters need a blank.
        winners = [3, 1, 3, 1, 0, 2, 3]
        emissions = np.full((len(winners), 4), .001, dtype=np.float32)
        emissions[np.arange(len(winners)), winners] = .997
        words = server.ctc_words(np.log(emissions), [1, 1, 0, 2], [0, 0, -1, 1], 3)
        self.assertEqual([w[:2] for w in words], [(1, 4), (5, 6)])

    def test_weak_or_impossible_alignment_is_not_estimated(self):
        low = np.log(np.full((20, 10), .1, dtype=np.float32))
        self.assertIsNone(server.ctc_words(low, [1, 2, 3], [0, 0, 1], 4))
        self.assertIsNone(server.ctc_words(low[:1], [1, 2, 3], [0, 0, 1], 4))

    def test_download_input_is_fixed_video_id_and_supported_language(self):
        for value in ["http://evil.example/audio", "../../private", "speechde001&x=1"]:
            data = request()
            data["videoId"] = value
            with self.assertRaises(server.AlignmentError):
                server.validate_request(data)
        data = request()
        data["language"] = "xx"
        with self.assertRaises(server.AlignmentError):
            server.validate_request(data)

    def test_job_cache_ignores_position_but_not_original_language_or_text(self):
        first = server.validate_request(request())
        second = {**first, "positionMs": 2000}
        self.assertEqual(server.cache_key(first), server.cache_key(second))
        second = {**first, "language": "en"}
        self.assertNotEqual(server.cache_key(first), server.cache_key(second))
        with tempfile.TemporaryDirectory() as folder:
            jobs = server.Jobs(folder)
            job = jobs.create(request())
            self.assertEqual(jobs.create(request()), job)
            jobs.jobs[job]["cancel"] = True
            with self.assertRaises(server.AlignmentError):
                jobs.cancelled(jobs.jobs[job])

    def test_local_audio_offset_is_validated_and_identifies_the_job(self):
        first = server.validate_request(request())
        self.assertEqual(first["offsetMs"], 0)
        shifted = server.validate_request({**request(), "offsetMs": 9000})
        self.assertEqual(shifted["offsetMs"], 9000)
        self.assertNotEqual(server.cache_key(first), server.cache_key(shifted))
        # The playback position must not split the cache; the offset must.
        self.assertEqual(server.cache_key(first),
                         server.cache_key(server.validate_request({**request(), "positionMs": 3000})))
        for value in [-1, 86_400_001, "5", True, None]:
            with self.assertRaises(server.AlignmentError):
                server.validate_request({**request(), "offsetMs": value})

    def test_a_local_file_must_cover_the_subtitles_it_is_aligned_against(self):
        data = server.validate_request({**request(), "cues": [
            cue(0, 10_000), cue(1, 20_000, "Guten Tag", ("Guten", "Tag"))]})
        with tempfile.TemporaryDirectory() as folder:
            jobs = server.Jobs(folder)
            jobs.check_local_audio(data, 25_000, 0)          # full file for the video
            jobs.check_local_audio(data, 15_000, 10_000)     # trimmed clip with its offset
            with self.assertRaises(server.AlignmentError) as short:
                jobs.check_local_audio(data, 12_000, 0)
            self.assertEqual(short.exception.code, "audioTooShort")
            with self.assertRaises(server.AlignmentError) as shifted:
                jobs.check_local_audio(data, 5_000, 30_000)
            self.assertEqual(shifted.exception.code, "audioMismatch")
            job = jobs.create({**request(), "cues": [cue(0, 10_000)]})
            jobs.jobs[job]["audioMs"] = 25_000
            self.assertEqual(jobs.snapshot(job)["audioMs"], 25_000)

    def test_every_sentence_states_the_position_it_was_aligned_at(self):
        data = server.validate_request({**request(), "cues": [cue(0), cue(3, 5000, "Guten Tag", ("Guten", "Tag"))]})
        self.assertEqual([c["index"] for c in data["cues"]], [0, 3])
        # Without its track position a sentence cannot be placed back, and a
        # repeated or out-of-range position would apply word times measured for
        # one sentence to another one.
        for cues in ([{"start": 0, "dur": 4000, "text": "Hallo Welt", "tokens": ["Hallo", "Welt"]}],
                     [cue(0), cue(0)],
                     [cue(-1)],
                     [cue(True)],
                     [cue(server.MAX_CUES)],
                     [cue("0")]):
            with self.assertRaises(server.AlignmentError):
                server.validate_request({**request(), "cues": cues})

    def test_the_audio_a_result_belongs_to_is_part_of_the_cache_identity(self):
        # No local file means the video's public track.
        self.assertEqual(server.validate_request(request())["audioId"], "video")
        file_a = "local:1234-0123456789abcdef"
        file_b = "local:1234-fedcba9876543210"
        self.assertNotEqual(server.cache_key(server.validate_request({**request(), "audioId": file_a})),
                            server.cache_key(server.validate_request({**request(), "audioId": file_b})))
        self.assertNotEqual(server.cache_key(server.validate_request(request())),
                            server.cache_key(server.validate_request({**request(), "audioId": file_a})))
        for value in ["", "local:", "local:1-ZZZZ", "video ", "http://evil.example/a.wav", 7, None]:
            with self.assertRaises(server.AlignmentError):
                server.validate_request({**request(), "audioId": value})

    def test_only_a_complete_result_for_the_same_audio_is_reused(self):
        data = server.validate_request(request())
        segments = [{"index": 0, "start": 0, "dur": 4000, "text": "Hallo Welt",
                     "words": [{"u": "Hallo", "t": 0, "e": 1000, "score": .9}]}]
        with tempfile.TemporaryDirectory() as folder:
            jobs = server.Jobs(folder)
            job = jobs.create(data)
            key = jobs.jobs[job]["key"]
            cache = jobs.jobs[job]["folder"] / "timings.json"
            # An interrupted run, another track, another audio file and a broken
            # payload must all align again instead of being reported as done.
            for written in ({"segments": segments},
                            {"complete": True, "key": "other", "audioId": "video", "total": 1, "segments": segments},
                            {"complete": True, "key": key, "audioId": "local:1-0123456789abcdef", "total": 1, "segments": segments},
                            {"complete": True, "key": key, "audioId": "video", "total": 1, "segments": "nope"}):
                cache.write_text(json.dumps(written), encoding="utf-8")
                fresh = server.Jobs(folder)
                again = fresh.create(data)
                self.assertNotEqual(fresh.snapshot(again)["status"], "done", written)
            cache.write_text(json.dumps({"complete": True, "key": key, "audioId": "video",
                                         "total": 1, "segments": segments}), encoding="utf-8")
            fresh = server.Jobs(folder)
            again = fresh.create(data)
            snapshot = fresh.snapshot(again)
            self.assertEqual(snapshot["status"], "done")
            self.assertEqual(snapshot["aligned"], 1)

    def test_a_trimmed_file_is_windowed_in_audio_time_and_mapped_back(self):
        cue = {"start": 10_000, "dur": 4000}
        self.assertEqual(server.cue_window(cue, 0, 16000 * 60), (10_000, 160_000, 224_000))
        # Clip starting at video 5 s: the caption is 5 s into the file.
        self.assertEqual(server.cue_window(cue, 5_000, 16000 * 60), (10_000, 80_000, 144_000))
        # A caption straddling the clip start stays inside the audio.
        straddle = {"start": 4_000, "dur": 4000}
        self.assertEqual(server.cue_window(straddle, 5_000, 16000 * 60), (5_000, 0, 48_000))
        # Never read past the end of the file.
        self.assertEqual(server.cue_window(cue, 5_000, 90_000)[2], 90_000)
        # A caption that ends before the clip starts is not aligned at all,
        # rather than being read with negative sample indices.
        self.assertIsNone(server.cue_window({"start": 0, "dur": 4000}, 5_000, 16000 * 60))

    def test_adjacent_captions_share_no_audio_and_keep_video_time(self):
        # Each caption is aligned on its own window, so a word can neither be
        # counted twice nor be borrowed from the neighbouring chunk.
        samples = 16000 * 2
        first = server.cue_window({"start": 0, "dur": 1000}, 0, samples)
        second = server.cue_window({"start": 1000, "dur": 1000}, 0, samples)
        self.assertEqual(first, (0, 0, 16000))
        self.assertEqual(second, (1000, 16000, 32000))
        self.assertEqual(first[2], second[1], "the windows touch without overlapping")
        # Frames of each window map back to that caption's own video time.
        self.assertEqual(first[0], 0)
        self.assertEqual(second[0], 1000)
        # A caption running past the end of the file is clipped to the file,
        # never widened, so its last words stay inside the audio.
        clipped = server.cue_window({"start": 1500, "dur": 3000}, 0, samples)
        self.assertEqual(clipped, (1500, 24000, 32000))
        self.assertIsNone(server.cue_window({"start": 9000, "dur": 1000}, 0, samples))

    def test_health_reports_where_results_are_cached(self):
        with tempfile.TemporaryDirectory() as folder:
            http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            http.jobs = server.Jobs(folder)
            http.writable = True
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            try:
                health = json.load(urllib.request.urlopen(f"http://127.0.0.1:{http.server_port}/health"))
                self.assertEqual(health["cacheDir"], str(Path(folder)))
                self.assertTrue(health["writable"])
                # The model identity is part of a cached result's validity.
                self.assertEqual(health["models"]["de"], server.MODELS["de"][0])
                self.assertIsInstance(health["version"], int)
            finally:
                http.shutdown()
                http.server_close()

    def test_second_helper_cannot_share_the_port(self):
        # On Windows SO_REUSEADDR lets a second process bind the same port, which
        # silently split requests between two helpers; binding must stay exclusive.
        self.assertFalse(server.Server.allow_reuse_address)
        with tempfile.TemporaryDirectory() as folder:
            first = server.Server(("127.0.0.1", 0), server.Handler)
            first.jobs = server.Jobs(folder)
            try:
                with self.assertRaises(OSError):
                    server.Server(("127.0.0.1", first.server_port), server.Handler)
            finally:
                first.server_close()

    def test_http_rejects_web_origins_rebinding_and_non_json_posts(self):
        with tempfile.TemporaryDirectory() as folder:
            http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
            http.jobs = server.Jobs(folder)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{http.server_port}"
            try:
                self.assertTrue(json.load(urllib.request.urlopen(base + "/health"))["ok"])
                for headers in [{"Origin": "https://evil.example"}, {"Origin": "null"}, {"Host": "evil.example"}]:
                    with self.assertRaises(urllib.error.HTTPError):
                        urllib.request.urlopen(urllib.request.Request(base + "/health", headers=headers))
                with self.assertRaises(urllib.error.HTTPError):
                    urllib.request.urlopen(urllib.request.Request(base + "/jobs", data=b"{}", headers={"Content-Type": "text/plain"}))
                origin = "chrome-extension://" + "a" * 32
                health = urllib.request.urlopen(urllib.request.Request(base + "/health", headers={"Origin": origin}))
                self.assertEqual(health.headers["Access-Control-Allow-Origin"], origin)
            finally:
                http.shutdown()
                http.server_close()


if __name__ == "__main__":
    unittest.main()
