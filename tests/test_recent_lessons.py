import copy
import unittest
from unittest.mock import patch

import recent_lessons
from fetch_daily_ebm import PILLARS
from pipeline.validate_lesson import validate_lesson
from recent_lessons import (RECENT_EDITION_DATE, SOURCES, build_recent_lesson, build_recent_templates,
                            is_recent, source_age_days)

PRIORITY = {"guideline": 0, "systematic_review_meta_analysis": 1, "landmark_rct": 2,
            "real_world_cohort_registry": 3, "expert_consensus": 4}


class RecentLessonTests(unittest.TestCase):
    def test_every_pillar_has_one_primary_source_from_the_last_three_months(self):
        self.assertEqual(sorted(SOURCES), list(range(1, 11)))
        for pid, source in SOURCES.items():
            with self.subTest(pid=pid):
                self.assertIn(source["kind"], PRIORITY)
                self.assertTrue(is_recent(source))
                self.assertGreaterEqual(source["online_date"], "2026-08-24")
        self.assertFalse(is_recent({**SOURCES[2], "online_date": "2022-08-27"}))
        self.assertEqual(source_age_days(SOURCES[10]), 13)

    def test_lessons_and_templates_pass_the_gate_in_both_languages(self):
        for pillar in PILLARS:
            lesson = build_recent_lesson(pillar, "2026-11-26")
            with self.subTest(pid=pillar["id"]):
                validate_lesson(lesson, pillar, "2026-11-26")
                source = lesson["primary_source"]
                self.assertEqual([a["pmid"] for a in lesson["pubmed_anchors"]], [source["pmid"]])
                for field in ("part1_vi_markdown", "part2_en_markdown"):
                    block_a, block_b = lesson[field].split("## Block B")
                    for block in (block_a, block_b):
                        self.assertIn(f"https://pubmed.ncbi.nlm.nih.gov/{source['pmid']}/", block)
                        self.assertIn(f"https://doi.org/{source['doi']}", block)
                for key in ("vi", "en"):
                    self.assertTrue(all(lesson["teaching"][key][s] for s in recent_lessons.SECTIONS))
        templates = build_recent_templates(PILLARS)
        for pillar in PILLARS:
            validate_lesson(templates[str(pillar["id"])], pillar, RECENT_EDITION_DATE, fallback=True)

    def test_intracoronary_imaging_walkthrough_keeps_depth_in_block_a(self):
        lesson = build_recent_lesson(PILLARS[2], "2026-11-28")
        self.assertEqual(lesson["primary_source"]["pmid"], "42747372")
        for lang, field in (("vi", "part1_vi_markdown"), ("en", "part2_en_markdown")):
            with self.subTest(lang=lang):
                notes = lesson["teaching"][lang]
                block_a, block_b = lesson[field].split("## Block B")
                for keys, block, other in ((recent_lessons.BLOCK_A_SECTIONS, block_a, block_b),
                                           (recent_lessons.BLOCK_B_SECTIONS, block_b, block_a)):
                    for key in keys:
                        self.assertIn(f"### {recent_lessons.SECTION_LABELS[lang][key]}\n", block)
                        for paragraph in notes[key]:
                            self.assertIn(paragraph, block)
                            self.assertNotIn(paragraph, other)
                for excerpt in lesson["source_excerpts"]:
                    self.assertIn("> " + excerpt["text"], block_b.replace(r"\[", "[").replace(r"\]", "]"))
        self.assertGreaterEqual(sum(len(p.split()) for key in recent_lessons.BLOCK_A_SECTIONS
                                    for p in lesson["teaching"]["vi"][key]), 1200)

    def test_recorded_walkthrough_rejects_partial_and_mismatched_depth(self):
        pillar, day = PILLARS[2], "2026-11-28"
        lesson = build_recent_lesson(pillar, day)
        del lesson["teaching"]["en"]["mechanism"]
        with self.assertRaisesRegex(ValueError, "Incomplete en walkthrough"):
            validate_lesson(lesson, pillar, day, recorded=True)
        for key in recent_lessons.BLOCK_A_SECTIONS[2:]:
            del lesson["teaching"]["en"][key]
        with self.assertRaisesRegex(ValueError, "must have matching sections"):
            validate_lesson(lesson, pillar, day, recorded=True)

    def test_quizzes_quote_the_pubmed_abstract_and_guidelines_wait_for_physician_lines(self):
        for pillar in PILLARS:
            lesson = build_recent_lesson(pillar, "2026-11-26")
            source = lesson["primary_source"]
            with self.subTest(pid=pillar["id"]):
                if source["kind"] == "guideline":
                    self.assertEqual(lesson["quiz_items"], [])
                    self.assertEqual(lesson["quiz_status"], "awaiting_physician_excerpts")
                    self.assertEqual(lesson["source_excerpts"], [])
                    continue
                texts = lesson["quiz_source_texts"][source["pmid"]]
                self.assertEqual(texts, [e["text"] for e in lesson["source_excerpts"]])
                for item in lesson["quiz_items"]:
                    self.assertEqual(item["pmid"], source["pmid"])
                    self.assertIn(item["quote"], texts)
                    self.assertEqual(item["quote"][item["start"]:item["start"] + len(item["answer"])], item["answer"])

    def test_physician_lines_need_class_level_and_locator(self):
        pillar = PILLARS[4]
        line = {"text": "Example recommendation for [[2]] groups.", "class": "I", "level": "A", "locator": "Table 4"}
        with patch.dict(recent_lessons.PHYSICIAN_LINES, {SOURCES[5]["id"]: (line,)}), \
                patch.dict(SOURCES, {5: {**SOURCES[5], "kind": "guideline", "quiz": (), "physician_lines": (line,)}}):
            lesson = build_recent_lesson(pillar, "2026-11-26")
            self.assertEqual(lesson["source_excerpts"][0]["class"], "I")
            self.assertEqual(lesson["quiz_items"][0]["answer"], "2")
            validate_lesson(lesson, pillar, "2026-11-26", recorded=True)
            broken = copy.deepcopy(lesson)
            broken["source_excerpts"][0]["locator"] = " "
            with self.assertRaises(ValueError):
                validate_lesson(broken, pillar, "2026-11-26", recorded=True)

    def test_archived_lessons_survive_a_catalog_version_bump(self):
        lesson = build_recent_lesson(PILLARS[1], "2026-11-26")
        with patch("pipeline.validate_lesson.RECENT_LESSON_VERSION", 6), \
                patch.dict("pipeline.validate_lesson.WINDOW_DAYS_BY_VERSION", {6: 60}):
            validate_lesson(lesson, PILLARS[1], "2026-11-26", recorded=True)
            with self.assertRaises(ValueError):
                validate_lesson(lesson, PILLARS[1], "2026-11-26")
        widened = copy.deepcopy(lesson)
        widened["primary_source"]["window_days"] = 100
        with self.assertRaises(ValueError):
            validate_lesson(widened, PILLARS[1], "2026-11-26", recorded=True)

    def test_local_chat_does_not_grade_pasted_questions_on_recent_lessons(self):
        import fetch_daily_ebm as app
        lesson = build_recent_lesson(PILLARS[6], "2026-11-26")
        query = "Which is true about antibiotic duration in endocarditis?\nA. Longer\nB. Response-tailored\nC. None\nD. All"
        for lang, notice in (("en", "does not grade"), ("vi", "không chấm")):
            answer, _ = app._compose_deterministic_ebm_answer(query, [lesson], [], lang)
            self.assertIn(notice, answer)
            self.assertNotRegex(answer, r"(?i)\b(correct answer|đáp án đúng)\b")
        with patch.dict(SOURCES, {3: {**SOURCES[3], "kind": "guideline", "quiz": ()}}):
            guideline = build_recent_lesson(PILLARS[2], "2026-11-26")
        answer, _ = app._compose_deterministic_ebm_answer(query, [guideline], [], "en")
        self.assertIn("no quiz until a physician", answer)
        self.assertNotIn("Use the lesson quiz", answer)

    def test_local_chat_reads_both_pci_teaching_blocks(self):
        import fetch_daily_ebm as app
        lesson = build_recent_lesson(PILLARS[2], "2026-11-28")
        options = "\nA. First\nB. Second\nC. Third\nD. Fourth"
        for lang, question, section in (
            ("en", "How many patients were included in the intracoronary imaging-guided PCI meta-analysis?", "design"),
            ("vi", "Phân tích gộp PCI hướng dẫn bằng hình ảnh nội mạch gồm bao nhiêu bệnh nhân?", "design"),
            ("en", "What is the difference between stent underexpansion and malapposition?", "mechanism"),
            ("vi", "Stent nở chưa đủ và áp thành không hoàn toàn khác nhau như thế nào?", "mechanism"),
        ):
            with self.subTest(lang=lang, section=section):
                answer, _ = app._compose_deterministic_ebm_answer(question + options, [lesson], [], lang)
                paragraph = lesson["teaching"][lang][section][0 if section == "design" else 2]
                self.assertIn(paragraph, answer)
        for lang, question, evidence in (
            ("en", "How many patients need to be treated to prevent one target lesion failure?", "does not provide an NNT"),
            ("vi", "Cần điều trị bao nhiêu bệnh nhân để ngăn một thất bại tổn thương đích?", "Không suy ra NNT"),
            ("en", "What was the relative risk of target lesion failure?", "RR 0.72 (95% CI, 0.61–0.85)"),
            ("vi", "Nguy cơ tương đối của thất bại tổn thương đích là bao nhiêu?", "RR 0,72 (KTC 95% 0,61–0,85)"),
        ):
            with self.subTest(lang=lang, question=question):
                answer, _ = app._compose_deterministic_ebm_answer(question + options, [lesson], [], lang)
                self.assertIn(evidence, answer)
                self.assertNotRegex(answer, r"24[.,]634|\*\*[A-D]\*\*")

    def test_gate_rejects_stale_or_extra_sources(self):
        pillar = PILLARS[1]
        lesson = build_recent_lesson(pillar, "2026-11-26")
        stale = copy.deepcopy(lesson)
        stale["primary_source"]["online_date"] = "2022-08-27"
        extra = copy.deepcopy(lesson)
        extra["pubmed_anchors"].append({**extra["pubmed_anchors"][0], "pmid": "36017548"})
        legacy = copy.deepcopy(lesson)
        legacy["supporting_evidence"] = {"pmid": "26551272"}
        for broken in (stale, extra, legacy):
            with self.assertRaises(ValueError):
                validate_lesson(broken, pillar, "2026-11-26", recorded=True)


if __name__ == "__main__":
    unittest.main()
