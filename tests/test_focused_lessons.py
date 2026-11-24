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

    def test_pasted_trial_question_reads_design_after_the_guideline_walkthrough(self):
        briefing = lessons.build_focused_lesson(app.PILLARS[8], "2026-11-24")
        questions = {
            "en": ("What was the primary endpoint of AMBITION?\nA. Pulmonary vascular resistance\n"
                   "B. First event of clinical failure\nC. Peak oxygen uptake\nD. Cardiovascular death alone"),
            "vi": ("Kết cục chính của AMBITION là gì?\nA. Sức cản mạch máu phổi\n"
                   "B. Thời gian đến thất bại lâm sàng đầu tiên\nC. Tiêu thụ oxy đỉnh\nD. Tử vong tim mạch riêng lẻ"),
        }
        for lang, query in questions.items():
            with self.subTest(lang=lang):
                answer, sources = app._compose_deterministic_ebm_answer(query, [briefing], [], lang, verbosity="short")
                self.assertTrue(answer.startswith("**B**"), answer)
                self.assertIn("clinical failure" if lang == "en" else "thất bại lâm sàng", answer)
                self.assertIn("26308684", {source["pmid"] for source in sources})

    def test_pasted_diagnosis_question_uses_guideline_application_not_trial_measures(self):
        briefing = lessons.build_focused_lesson(app.PILLARS[8], "2026-11-24")
        questions = {
            "en": ("Which test can distinguish group 1 PAH from left heart or lung disease?\nA. Echocardiography\n"
                   "B. Right heart catheterization\nC. Six-minute walk distance\nD. Chest radiography"),
            "vi": ("Xét nghiệm nào xác nhận PAH nhóm 1?\nA. Quãng đường đi bộ 6 phút\n"
                   "B. Thông tim phải\nC. Cộng hưởng từ tim\nD. X quang ngực"),
        }
        for lang, query in questions.items():
            with self.subTest(lang=lang):
                answer, sources = app._compose_deterministic_ebm_answer(query, [briefing], [], lang, verbosity="short")
                self.assertTrue(answer.startswith("**B**"), answer)
                self.assertIn("right heart catheterization" if lang == "en" else "thông tim phải", answer)
                self.assertIn("36017548", {source["pmid"] for source in sources})

    def test_pasted_question_with_no_matching_option_does_not_guess(self):
        briefing = lessons.build_focused_lesson(app.PILLARS[8], "2026-11-24")
        query = "Which element has atomic number 11?\nA. Yttrium\nB. Chromium\nC. Technetium\nD. Sodium"
        answer, _ = app._compose_deterministic_ebm_answer(query, [briefing], [], "en")
        self.assertIn("couldn't match one answer", answer)

    def test_pasted_english_trial_question_in_vietnamese_and_detailed_mode(self):
        briefing = lessons.build_focused_lesson(app.PILLARS[8], "2026-11-24")
        query = ("Which adverse effect was more common with combination therapy in AMBITION?\n"
                 "A. Seizures\nB. Peripheral edema\nC. Rhabdomyolysis\nD. Hyperkalemia")
        short, _ = app._compose_deterministic_ebm_answer(query, [briefing], [], "vi", verbosity="short")
        detailed, _ = app._compose_deterministic_ebm_answer(query, [briefing], [], "vi", verbosity="detailed")
        self.assertTrue(short.startswith("**B** — Peripheral edema"), short)
        self.assertTrue(detailed.startswith("**B**"), detailed)
        self.assertIn("Peripheral edema", detailed)
        self.assertIn("0.50", detailed)
        self.assertNotIn("0.50", short)

    def test_pasted_trial_question_prefers_a_matching_explanation_in_chat_language(self):
        briefing = lessons.build_focused_lesson(app.PILLARS[8], "2026-11-24")
        query = ("Which drug was used in PAH with AMBITION?\nA. Tadalafil\n"
                 "B. Selexipag\nC. Epoprostenol\nD. Macitentan")
        answer, _ = app._compose_deterministic_ebm_answer(query, [briefing], [], "en", verbosity="short")
        self.assertTrue(answer.startswith("**A**"), answer)
        self.assertIn(answer.split(" — ", 1)[1], " ".join(
            paragraph for paragraphs in briefing["teaching"]["en"].values() for paragraph in paragraphs
        ))

    def test_pasted_contraindication_question_uses_explicit_negative_evidence(self):
        briefing = lessons.build_focused_lesson(app.PILLARS[8], "2026-11-24")
        query = ("Thuốc nào chống chỉ định dùng chung với thuốc ức chế PDE5?\n"
                 "A. Atorvastatin\nB. Nitrate\nC. Metformin\nD. Paracetamol")
        answer, _ = app._compose_deterministic_ebm_answer(query, [briefing], [], "vi", verbosity="short")
        self.assertTrue(answer.startswith("**B**"), answer)
        self.assertIn("không dùng cùng nitrate", answer)

    def test_pasted_generic_stem_accepts_an_exact_lesson_statement(self):
        briefing = lessons.build_focused_lesson(app.PILLARS[8], "2026-11-24")
        statement = ("The primary endpoint was time to first clinical failure: death, hospitalization for worsening PAH, "
                     "disease progression, or unsatisfactory long-term clinical response.")
        query = (f"Which of the following is true?\nA. The groups were not randomized.\nB. {statement}\n"
                 "C. Only acute coronary syndrome was enrolled.\nD. All patients died in the first year.")
        answer, _ = app._compose_deterministic_ebm_answer(query, [briefing], [], "en", verbosity="short")
        self.assertEqual(answer, f"**B** — {statement}")
        answer, _ = app._compose_deterministic_ebm_answer(query.replace("is true?", "is false?"), [briefing], [], "en")
        self.assertIn("couldn't match one answer", answer)

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
        safety_source = archive["pubmed_anchors"][-1]
        link = f"[{safety_source['title']}]({safety_source['url']})"
        for markdown in ("part1_vi_markdown", "part2_en_markdown"):
            self.assertIn(link, archive[markdown])

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
                patch("pipeline.lesson_generation.fetch_article", return_value=None) as fetch, \
                patch("crawl_cardiology_news.crawl_latest_guidelines", side_effect=AssertionError("Daily lookup")):
            app.save_briefings_js([legacy], {})
            first = app.refresh_today_briefing()
            second = app.refresh_today_briefing()
            self.assertFalse(first["already_up_to_date"])
            self.assertTrue(second["already_up_to_date"])
            self.assertEqual(first["briefing"], second["briefing"])
            self.assertEqual(app.load_existing_briefings(), [first["briefing"]])
            self.assertEqual(first["briefing"]["lesson_provenance"]["quiz"]["mode"], "curated")
            self.assertEqual(fetch.call_count, 2)

    def test_scheduled_refresh_preserves_same_day_model_drafts(self):
        today = datetime.date(2026, 11, 24)
        drafts = [
            {"id": f"draft-{pid}", "date": today.isoformat(), "pillar_id": pid,
             "model_used": "test-model", "content_source": app.MODEL_DRAFT_CONTENT_SOURCE}
            for pid in (app.get_pillar_for_date(today)["id"], 1)
        ]
        with TemporaryDirectory() as directory, patch.object(app, "_today_vn", return_value=today), \
                patch.object(app, "BRIEFINGS_JS_PATH", Path(directory) / "briefings.js"), \
                patch.object(app, "ROTATION_STATE_PATH", Path(directory) / "rotation_state.json"), \
                patch("pipeline.lesson_generation.fetch_article", return_value=None):
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
