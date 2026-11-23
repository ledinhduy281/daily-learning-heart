import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import build_seed_briefings
import fetch_daily_ebm as app

ROOT = Path(__file__).resolve().parents[1]
LEGACY_LABELS = {"ebm-guideline-evolution-verified", "ebm-step0-curated+pubmed", "pubmed-step0-digest", "pubmed-live-crawler"}
PAID_MODEL_MARKERS = ("gemini", "gpt-", "deep-research", "claude", "groq")


def read_bundle(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    prefix = "window.EBM_BRIEFINGS_DATA = "
    return json.loads(raw[raw.index(prefix) + len(prefix):].strip().rstrip(";"))


def assert_truthful_bundle(test: unittest.TestCase, payload: dict) -> None:
    test.assertEqual(payload["default_model"], "none")
    test.assertNotIn("available_models", payload)
    test.assertEqual(payload["generator"]["method"], "deterministic")
    test.assertEqual(payload["generator"]["model"], "none")
    test.assertIn("not clinical verification", payload["generator"]["citation_lookup"])
    metadata = json.dumps({k: v for k, v in payload.items() if k != "briefings"}).lower()
    for marker in PAID_MODEL_MARKERS:
        test.assertNotIn(marker, metadata)
    for briefing in payload["briefings"]:
        test.assertNotIn(briefing.get("model_used"), LEGACY_LABELS)
        if briefing.get("content_source") == "curated_library_rotation":
            test.assertEqual(briefing["model_used"], "none")
            test.assertRegex(briefing["curated_edition_date"], r"^\d{4}-\d{2}-\d{2}$")


def curated_without_crawl(pillar_id, date_str, *args, **kwargs):
    import pillar_library

    return pillar_library.get_latest_briefing_for_pillar(pillar_id, date_str)


class HonestMetadataTests(unittest.TestCase):
    def test_published_bundle_has_no_false_model_metadata(self):
        payload = read_bundle(ROOT / "data" / "briefings.js")
        assert_truthful_bundle(self, payload)
        self.assertTrue(all(b["content_source"] == "curated_library_rotation" for b in payload["briefings"]))
        redated = [b for b in payload["briefings"] if b["curated_edition_date"] != b["date"]]
        self.assertTrue(redated, "re-dated curriculum editions must keep their original edition date")

    def test_generator_has_no_default_or_listed_paid_models(self):
        self.assertEqual(app.NO_MODEL, "none")
        self.assertFalse(hasattr(app, "DEFAULT_MODEL"))
        self.assertFalse(hasattr(app, "AVAILABLE_MODELS"))
        with self.assertRaises(ValueError):
            app.generate_briefing(app.get_pillar_by_id(1))

    def test_save_normalizes_legacy_labels_and_keeps_real_model_drafts(self):
        briefings = [
            {"id": "a", "date": "2026-11-22", "model_used": "ebm-guideline-evolution-verified",
             "interaction_id": "ebm-verified-ebm-2026-11-12-p7-main", "part2_model_used": "some-model-id"},
            {"id": "b", "date": "2026-11-21", "model_used": "pubmed-step0-digest"},
            {"id": "c", "date": "2026-11-20", "model_used": "pubmed-live-crawler"},
            {"id": "d", "date": "2026-11-19", "model_used": "some-model-id"},
        ]
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "briefings.js"
            with patch.object(app, "BRIEFINGS_JS_PATH", path):
                app.save_briefings_js(briefings, {"last_pillar_id": 7})
            payload = read_bundle(path)
        assert_truthful_bundle(self, payload)
        a, b, c, d = payload["briefings"]
        self.assertEqual((a["model_used"], a["content_source"], a["curated_edition_date"]),
                         ("none", "curated_library_rotation", "2026-11-12"))
        self.assertEqual(a["part2_model_used"], "some-model-id")
        self.assertEqual((b["model_used"], b["content_source"]), ("none", "pubmed_metadata_digest"))
        self.assertEqual((c["model_used"], c["content_source"]), ("none", "pubmed_live_crawler"))
        self.assertEqual((d["model_used"], d["content_source"]), ("some-model-id", "model_draft"))
        self.assertEqual(briefings[0]["model_used"], "ebm-guideline-evolution-verified")

    def test_model_rewritten_english_records_its_model(self):
        captured = {}

        class FakeCompletions:
            def create(self, **kwargs):
                captured.update(kwargs)
                message = type("Message", (), {"content": "Part 2 text"})
                return type("Response", (), {"choices": [type("Choice", (), {"message": message})]})

        fake_openai = type(sys)("openai")
        fake_openai.OpenAI = lambda **kwargs: type("Client", (), {"chat": type("Chat", (), {"completions": FakeCompletions()})})
        briefing = app.with_truthful_provenance(
            {"id": "a", "date": "2026-11-22", "model_used": "ebm-guideline-evolution-verified", "part1_vi_markdown": "Nội dung"})
        with patch.dict(sys.modules, {"openai": fake_openai}):
            result = app.generate_part2_for_briefing(briefing, model_name="some-model-id", api_key="test-key")
        self.assertEqual(captured["model"], "some-model-id")
        self.assertEqual(result["model_used"], "none")
        self.assertEqual(result["part2_model_used"], "some-model-id")
        with self.assertRaises(ValueError):
            app.generate_part2_for_briefing(briefing)

    def test_curated_refresh_records_no_model_and_original_edition(self):
        with TemporaryDirectory() as tmp:
            js_path, state_path = Path(tmp) / "briefings.js", Path(tmp) / "rotation_state.json"
            with patch.object(app, "BRIEFINGS_JS_PATH", js_path), \
                 patch.object(app, "ROTATION_STATE_PATH", state_path), \
                 patch.object(app, "fetch_pubmed_metadata", return_value=[]), \
                 patch("crawl_cardiology_news.refresh_guideline_briefing", side_effect=curated_without_crawl):
                result = app.refresh_today_briefing(force=True)
            briefing = result["briefing"]
        self.assertEqual(briefing["model_used"], "none")
        self.assertEqual(briefing["content_source"], "curated_library_rotation")
        self.assertRegex(briefing["curated_edition_date"], r"^\d{4}-\d{2}-\d{2}$")

    def test_seed_builder_writes_truthful_metadata(self):
        with TemporaryDirectory() as tmp, patch.object(build_seed_briefings, "DATA_DIR", Path(tmp)):
            build_seed_briefings.main()
            assert_truthful_bundle(self, read_bundle(Path(tmp) / "briefings.js"))

    def test_bare_cli_without_model_refuses_instead_of_using_a_paid_default(self):
        with patch.object(sys, "argv", ["fetch_daily_ebm.py"]), patch("sys.stderr"):
            with self.assertRaises(SystemExit) as raised:
                app.main()
        self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
