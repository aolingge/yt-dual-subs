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


def request():
    return {"videoId": "speechde001", "language": "de", "positionMs": 0,
            "cues": [{"start": 0, "dur": 4000, "text": "Hallo Welt", "tokens": ["Hallo", "Welt"]}]}


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
