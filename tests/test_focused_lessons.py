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

    def test_block_b_matches_recommendation_before_source_priority(self):
        hcm = lessons.select_guideline(8)
        match = lessons.select_supporting_evidence(hcm)
        self.assertEqual(match["pmid"], "32871100")
        wrong_topic = {**match, "recommendation_id": "inflammatory-arrhythmia",
                       "source_kind": "systematic_review_meta_analysis", "pmid": "90001"}
        wrong_guideline = {**wrong_topic, "recommendation_id": match["recommendation_id"], "guideline_pmid": "90000"}
        self.assertIsNone(lessons.select_supporting_evidence(hcm, [wrong_topic, wrong_guideline]))
        self.assertEqual(lessons.select_supporting_evidence(hcm, [wrong_topic, match]), match)
        better = {**wrong_topic, "recommendation_id": match["recommendation_id"]}
        self.assertEqual(lessons.select_supporting_evidence(hcm, [match, better]), better)

    def test_every_pillar_has_a_traceable_match_and_archive_mismatch_is_removed(self):
        payload = read_bundle(app.BRIEFINGS_JS_PATH)
        for lesson in payload["focused_lessons"].values():
            evidence = lesson["supporting_evidence"]
            guideline = lesson["guideline_evolution"]
            self.assertEqual(evidence["recommendation_id"], guideline["recommendation_id"])
            self.assertEqual(evidence["guideline_pmid"], guideline["current_guideline"]["pmid"])
            self.assertEqual(evidence["pmid"], lesson["pubmed_anchors"][1]["pmid"])
            for lang in ("vi", "en"):
                for field in ("supports", "population", "limits"):
                    self.assertTrue(evidence[f"{field}_{lang}"])
        for date in ("2026-11-13", "2026-11-23"):
            corrected = next(b for b in payload["briefings"] if b["id"] == f"ebm-{date}-p8-main")
            self.assertIn("obstructive hypertrophic cardiomyopathy", corrected["title_en"])
            self.assertEqual(corrected["guideline_evolution"]["current_guideline"]["pmid"], "37622657")
            self.assertEqual(corrected["supporting_evidence"]["name"], "EXPLORER-HCM")
            self.assertNotIn("SEQUOIA-HCM", corrected["part2_en_markdown"])

    def test_hcm_archive_cites_mavacamten_interruption_threshold(self):
        archive = lessons.build_hcm_archive_edition(app.PILLARS[7], "2026-11-23")
        recommendation = archive["guideline_evolution"]
        self.assertIn("LVEF) dưới 50%", recommendation["recommendation_vi"])
        self.assertIn("LVEF) falls below 50%", recommendation["recommendation_en"])
        self.assertEqual(archive["pubmed_anchors"][-1]["source"], "DailyMed")

    def test_poet_population_lists_eligible_pathogens(self):
        evidence = lessons.build_focused_lesson(app.PILLARS[6], "2026-11-24")["supporting_evidence"]
        self.assertEqual(evidence["pmid"], "30152252")
        for pathogen in ("Enterococcus faecalis", "Staphylococcus aureus"):
            self.assertIn(pathogen, evidence["population_vi"])
            self.assertIn(pathogen, evidence["population_en"])
        self.assertIn("liên cầu", evidence["population_vi"])
        self.assertIn("tụ cầu coagulase âm tính", evidence["population_vi"])
        self.assertIn("streptococci", evidence["population_en"])
        self.assertIn("coagulase-negative staphylococci", evidence["population_en"])

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

    def test_scheduled_refresh_preserves_same_day_model_drafts(self):
        today = datetime.date(2026, 11, 24)
        drafts = [
            {"id": f"draft-{pid}", "date": today.isoformat(), "pillar_id": pid,
             "model_used": "test-model", "content_source": app.MODEL_DRAFT_CONTENT_SOURCE}
            for pid in (app.get_pillar_for_date(today)["id"], 1)
        ]
        with TemporaryDirectory() as directory, patch.object(app, "_today_vn", return_value=today), \
                patch.object(app, "BRIEFINGS_JS_PATH", Path(directory) / "briefings.js"), \
                patch.object(app, "ROTATION_STATE_PATH", Path(directory) / "rotation_state.json"):
            app.save_briefings_js(drafts, {})
            result = app.refresh_today_briefing()
            self.assertEqual(app.load_existing_briefings(), [result["briefing"], *drafts])
            self.assertTrue(app.refresh_today_briefing()["already_up_to_date"])

    def test_focused_lesson_without_source_questions_cannot_start_generic_quiz(self):
        lesson = lessons.build_focused_lesson(app.PILLARS[8], "2026-11-24", source_quiz=False)
        for briefings in ([lesson], [{"id": "legacy-main", "pillar_id": 9}]):
            with patch.object(app, "load_existing_briefings", return_value=briefings), \
                    patch.object(app, "_today_vn", return_value=datetime.date(2026, 11, 25)):
                response = app.handle_socratic_turn(
                    {"briefing_id": lesson["id"], "action": "start_diagnostic"}, source_only=True)
                self.assertFalse(response["ok"])
                self.assertIn("No source-supported questions", response["error"])
