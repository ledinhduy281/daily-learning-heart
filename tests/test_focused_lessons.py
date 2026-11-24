import datetime
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import fetch_daily_ebm as app
import focused_lessons as lessons


def read_bundle(path):
    return json.loads(path.read_text(encoding="utf-8").split("window.EBM_BRIEFINGS_DATA = ", 1)[1].strip().rstrip(";"))


class FocusedLessonTests(unittest.TestCase):
    def test_source_order_and_guideline_safeguard(self):
        self.assertEqual(lessons.SOURCE_PRIORITY, ("guideline", "systematic_review_meta_analysis",
                         "landmark_rct", "real_world_cohort_registry", "expert_consensus"))
        self.assertEqual(lessons.select_guideline(5)["guideline"][2], "37622666")
        unsupported = {"guideline": ("Other", 2099, "123", "", "")}
        with patch.dict(lessons.LESSONS, {5: [unsupported, *lessons.LESSONS[5]]}):
            self.assertEqual(lessons.select_guideline(5)["guideline"][2], "37622666")

    def test_static_templates_match_python_selection_in_every_pillar(self):
        payload = read_bundle(app.BRIEFINGS_JS_PATH)
        self.assertEqual(payload["focused_lessons"], lessons.build_focused_templates(app.PILLARS))
        for lesson in payload["focused_lessons"].values():
            self.assertEqual(lesson["lesson_format"], "single_guideline")
            guideline = lesson["guideline_evolution"]["current_guideline"]
            self.assertEqual([a["pmid"] for a in lesson["pubmed_anchors"][:1]], [guideline["pmid"]])
            self.assertNotIn("prior_guideline", lesson["guideline_evolution"])
            self.assertNotIn("live_crawled_guidelines", lesson)
            for language in ("vi", "en"):
                self.assertEqual(lesson[f"title_{language}"], lesson[f"topic_focus_{language}"])
                self.assertNotEqual(lesson[f"title_{language}"], lesson["pillar_name"])

    def test_refresh_replaces_same_day_legacy_lesson_and_is_idempotent_without_pubmed_lookup(self):
        today = datetime.date(2026, 11, 24)
        legacy = {"date": today.isoformat(), "pillar_id": app.get_pillar_for_date(today)["id"]}
        with TemporaryDirectory() as directory, patch.object(app, "_today_vn", return_value=today), \
                patch.object(app, "BRIEFINGS_JS_PATH", Path(directory) / "briefings.js"), \
                patch.object(app, "ROTATION_STATE_PATH", Path(directory) / "rotation_state.json"), \
                patch("crawl_cardiology_news.crawl_latest_guidelines", side_effect=AssertionError("Daily lookup")):
            app.save_briefings_js([legacy], {})
            first = app.refresh_today_briefing()
            second = app.refresh_today_briefing()
            self.assertFalse(first["already_up_to_date"])
            self.assertTrue(second["already_up_to_date"])
            self.assertEqual(first["briefing"], second["briefing"])
            self.assertEqual(app.load_existing_briefings(), [first["briefing"]])
