import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.error import HTTPError
from urllib.request import urlopen
from unittest.mock import patch

import fetch_daily_ebm as app


class EvidenceAssetTests(unittest.TestCase):
    def test_local_server_serves_only_public_pipeline_assets(self):
        with TemporaryDirectory() as directory, patch.object(app, "BASE_DIR", Path(directory)):
            output = Path(directory) / "data/pipeline"
            output.mkdir(parents=True)
            payload = {"schema_version": 1, "date": "2026-01-20"}
            (output / "briefing.json").write_text(json.dumps(payload))
            (output / "evidence.parquet").write_bytes(b"parquet")
            (output / "internal.json").write_text("{}")
            (Path(directory) / "offline.js").write_text("/* service worker */")
            with app.ThreadingHTTPServer(("127.0.0.1", 0), app.EBMRequestHandler) as server:
                thread = Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{server.server_port}"
                try:
                    with urlopen(base + "/data/pipeline/briefing.json", timeout=5) as response:
                        self.assertEqual(json.load(response), payload)
                    with urlopen(base + "/data/pipeline/evidence.parquet", timeout=5) as response:
                        self.assertEqual(response.read(), b"parquet")
                    with urlopen(base + "/offline.js", timeout=5) as response:
                        self.assertEqual(response.status, 200)
                    with self.assertRaises(HTTPError) as exc:
                        urlopen(base + "/data/pipeline/internal.json", timeout=5)
                    self.assertEqual(exc.exception.code, 403)
                finally:
                    server.shutdown()
                    thread.join()
