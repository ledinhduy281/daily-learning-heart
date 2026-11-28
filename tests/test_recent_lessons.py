import copy
import json
import unittest
from pathlib import Path
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

    def test_pillar_9_aortic_surgery_walkthrough_keeps_depth_and_generic_heading(self):
        lesson = build_recent_lesson(PILLARS[8], RECENT_EDITION_DATE)
        self.assertEqual(lesson["primary_source"]["pmid"], "42910416")
        for lang, field, expected_heading in (
            ("vi", "part1_vi_markdown", "Cơ chế và bối cảnh lâm sàng"),
            ("en", "part2_en_markdown", "Mechanism and clinical rationale"),
        ):
            with self.subTest(lang=lang):
                notes = lesson["teaching"][lang]
                block_a, block_b = lesson[field].split("## Block B")
                self.assertIn(f"### {expected_heading}\n", block_a)
                self.assertNotIn("chụp mạch", block_a.lower())
                self.assertNotIn("angiography", block_a.lower())
                for keys, block, other in ((recent_lessons.BLOCK_A_SECTIONS, block_a, block_b),
                                           (recent_lessons.BLOCK_B_SECTIONS, block_b, block_a)):
                    for key in keys:
                        label = recent_lessons.section_label(lang, key, lesson["primary_source"])
                        self.assertIn(f"### {label}\n", block)
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
        sections = json.loads((Path(__file__).parent / "fixtures" / "chat_teaching_sections.json").read_text())
        for lang, notes in sections.items():
            lesson["teaching"][lang].update(notes)
        options = "\nA. First\nB. Second\nC. Third\nD. Fourth"
        for lang, question, evidence in (
            ("en", "How many patients were included in the intracoronary imaging-guided PCI meta-analysis?", r"24[ ,]634"),
            ("en", "How many patients did the PCI meta-analysis include?", r"24[ ,]634"),
            ("en", "How many patients did the meta-analysis include in trials evaluating imaging guidance to prevent stent thrombosis?", r"24[ ,]634"),
            ("vi", "Phân tích gộp PCI hướng dẫn bằng hình ảnh nội mạch gồm bao nhiêu bệnh nhân?", r"24\.634"),
            ("en", "What is the difference between stent underexpansion and malapposition?", r"Underexpansion is not malapposition"),
            ("vi", "Stent nở chưa đủ và áp thành không hoàn toàn khác nhau như thế nào?", r"nở không đủ và áp thành kém"),
            ("en", "How many patients need to be treated to prevent one target lesion failure?", "does not provide an NNT"),
            ("vi", "Cần điều trị bao nhiêu bệnh nhân để ngăn một thất bại tổn thương đích?", "Không suy ra NNT"),
            ("vi", "Có bao nhiêu bệnh nhân cần được điều trị để ngăn một biến cố (NNT)?", "Không suy ra NNT"),
            ("en", "How can absolute benefit be derived from the relative risk of target lesion failure?", "baseline risk, a time horizon and a relevant population"),
            ("en", "How do I calculate absolute benefit using the relative risk of target lesion failure?", "baseline risk, a time horizon and a relevant population"),
            ("vi", "Làm sao suy ra lợi ích tuyệt đối từ nguy cơ tương đối?", "nguy cơ nền, thời gian theo dõi và tính tương đồng với quần thể nghiên cứu"),
            ("vi", "Làm sao tính lợi ích tuyệt đối với nguy cơ tương đối?", "nguy cơ nền, thời gian theo dõi và tính tương đồng với quần thể nghiên cứu"),
            ("en", "What was the relative risk of target lesion failure?", r"target lesion failure[: (]+RR 0\.72"),
            ("vi", "Nguy cơ tương đối của thất bại tổn thương đích là bao nhiêu?", r"thất bại tổn thương đích[, (]+RR 0,72"),
            ("en", "What was the mean follow-up in the intracoronary imaging-guided PCI meta-analysis?", r"22 months"),
            ("vi", "Thời gian theo dõi trung bình trong phân tích gộp PCI là bao lâu?", r"22 tháng"),
        ):
            with self.subTest(lang=lang, question=question):
                answer, _ = app._compose_deterministic_ebm_answer(question + options, [lesson], [], lang)
                self.assertRegex(answer, evidence)
                self.assertNotRegex(answer, r"\*\*[A-D]\*\*")

    def test_local_chat_can_find_reported_absolute_event_rates(self):
        import fetch_daily_ebm as app
        lesson = build_recent_lesson(PILLARS[1], "2026-11-27")
        options = "\nA. First\nB. Second\nC. Third\nD. Fourth"
        for lang, question, evidence in (
            ("en", "What was the reported absolute risk of serious adverse events in STAREE?", "Serious adverse events were 2.7% in each group"),
            ("vi", "STAREE báo cáo nguy cơ tuyệt đối của biến cố bất lợi nghiêm trọng là bao nhiêu?", "Biến cố bất lợi nghiêm trọng là 2,7% ở mỗi nhóm"),
        ):
            with self.subTest(lang=lang):
                answer, _ = app._compose_deterministic_ebm_answer(question + options, [lesson], [], lang)
                self.assertIn(evidence, answer)

    def test_local_chat_returns_conversion_requirements_and_reported_rr(self):
        import fetch_daily_ebm as app
        lesson = build_recent_lesson(PILLARS[2], "2026-11-28")
        for lang, question, requirement, estimate in (
            ("en", "How can absolute benefit be calculated using a relative risk of target lesion failure?", "requires a baseline risk", "RR 0.72"),
            ("en", "How can absolute benefit for target lesion failure be calculated using the pooled relative risk?", "requires a baseline risk", "RR 0.72"),
            ("en", "How do I calculate absolute benefit for target lesion failure in patients with complex lesions using the pooled relative risk?", "requires a baseline risk", "RR 0.72"),
            ("vi", "Làm sao tính lợi ích tuyệt đối với nguy cơ tương đối của thất bại tổn thương đích?", "cần biết nguy cơ nền", "RR 0,72"),
            ("vi", "Làm sao tính lợi ích tuyệt đối cho thất bại tổn thương đích từ nguy cơ tương đối gộp?", "cần biết nguy cơ nền", "RR 0,72"),
            ("vi", "Làm sao tính lợi ích tuyệt đối cho tử vong do tim từ nguy cơ tương đối gộp?", "cần biết nguy cơ nền", "0,73"),
        ):
            with self.subTest(lang=lang):
                answer, _ = app._compose_deterministic_ebm_answer(question + "\nA. First\nB. Second\nC. Third\nD. Fourth", [lesson], [], lang)
                self.assertIn(requirement, answer)
                self.assertIn(estimate, answer)
                self.assertIn(lesson["teaching"][lang]["limits"][0], answer)

    def test_local_chat_preserves_study_limits_for_subgroup_conversions(self):
        import fetch_daily_ebm as app
        lesson = build_recent_lesson(PILLARS[2], "2026-11-28")
        for lang, question, requirement in (
            ("en", "How do I calculate absolute benefit for complex lesions using the pooled relative risk?", "requires a baseline risk"),
            ("vi", "Tính lợi ích tuyệt đối ở nhóm tổn thương phức tạp từ nguy cơ tương đối gộp như thế nào?", "cần biết nguy cơ nền"),
        ):
            with self.subTest(lang=lang):
                answer, _ = app._compose_deterministic_ebm_answer(question + "\nA. First\nB. Second\nC. Third\nD. Fourth", [lesson], [], lang)
                self.assertIn(requirement, answer)
                self.assertIn(lesson["teaching"][lang]["limits"][0], answer)

    def test_local_chat_matches_the_requested_risk_endpoint(self):
        import fetch_daily_ebm as app
        lesson = next(b for b in build_recent_templates(PILLARS).values() if b["primary_source"]["pmid"] == "42842238")
        for lang, question, expected in (
            ("en", "What was the relative risk of kidney failure from intensive blood pressure lowering in CKD?", "kidney failure (RR 0.97"),
            ("vi", "Nguy cơ tương đối của suy thận khi hạ huyết áp tích cực ở CKD là bao nhiêu?", "suy thận (RR 0,97"),
            ("en", "How do I calculate absolute benefit using a relative risk of 0.97 for kidney failure?", "kidney failure (RR 0.97"),
            ("vi", "Làm sao tính lợi ích tuyệt đối với nguy cơ tương đối 0,97 cho suy thận?", "suy thận (RR 0,97"),
        ):
            with self.subTest(lang=lang):
                answer, _ = app._compose_deterministic_ebm_answer(question + "\nA. First\nB. Second\nC. Third\nD. Fourth", [lesson], [], lang)
                self.assertIn(expected, answer)
                self.assertNotRegex(answer, r"RR 0[.,]85")
        for lang, question, expected in (
            ("en", "How do I calculate absolute benefit using the relative risk of 30% or greater eGFR decline?", "RR 1.42"),
            ("en", "What was the relative risk of 30% or higher eGFR decline?", "RR 1.42"),
            ("en", "What was the relative risk of 30% or greater eGFR decline in the study?", "RR 1.42"),
            ("vi", "Tỉ số nguy cơ cho các biến cố tim mạch là bao nhiêu?", "RR 0,85"),
        ):
            with self.subTest(lang=lang):
                answer, _ = app._compose_deterministic_ebm_answer(question + "\nA. First\nB. Second\nC. Third\nD. Fourth", [lesson], [], lang)
                self.assertIn(expected, answer)
        answer, _ = app._compose_deterministic_ebm_answer(
            "How do I calculate absolute benefit using the relative risk of a 30% or greater reduction in cardiovascular events?\nA. First\nB. Second\nC. Third\nD. Fourth",
            [lesson], [], "en",
        )
        self.assertNotIn("RR 1.42", answer)
        for lang, question in (
            ("en", "What were the risk ratios for cardiovascular events and kidney failure?"),
            ("vi", "Tỉ số nguy cơ của biến cố tim mạch và suy thận là bao nhiêu?"),
        ):
            with self.subTest(lang=lang):
                answer, _ = app._compose_deterministic_ebm_answer(question + "\nA. First\nB. Second\nC. Third\nD. Fourth", [lesson], [], lang)
                self.assertRegex(answer, r"RR 0[.,]85")
                self.assertRegex(answer, r"RR 0[.,]97")

    def test_local_chat_finds_total_enrollment_before_arm_counts(self):
        import fetch_daily_ebm as app
        lesson = next(b for b in build_recent_templates(PILLARS).values() if b["primary_source"]["pmid"] == "43020520")
        for lang, question in (
            ("en", "How many participants were included in the BPROAD cognitive ancillary study?"),
            ("en", "How many BPROAD cognitive study participants were randomized across both groups?"),
            ("en", "How many BPROAD cognitive study participants were assigned to treatment overall?"),
            ("vi", "Nghiên cứu phụ về nhận thức BPROAD gồm bao nhiêu người tham gia?"),
            ("vi", "BPROAD có bao nhiêu người được phân vào cả hai nhóm?"),
        ):
            with self.subTest(lang=lang):
                answer, _ = app._compose_deterministic_ebm_answer(question + "\nA. First\nB. Second\nC. Third\nD. Fourth", [lesson], [], lang)
                self.assertIn("12 434", answer)
                self.assertNotIn("6219", answer)
        for lang, question, expected in (
            ("en", "How many BPROAD participants received intensive treatment?", "6219 participants in the intensive group"),
            ("en", "How many BPROAD participants were assigned to the intensive group in total?", "6219 participants in the intensive group"),
            ("vi", "BPROAD có bao nhiêu người được phân vào nhóm điều trị tích cực?", "6219 người ở nhóm tích cực"),
            ("vi", "BPROAD tổng cộng có bao nhiêu người được phân vào nhóm điều trị tích cực?", "6219 người ở nhóm tích cực"),
        ):
            with self.subTest(lang=lang):
                answer, _ = app._compose_deterministic_ebm_answer(question + "\nA. First\nB. Second\nC. Third\nD. Fourth", [lesson], [], lang)
                self.assertIn(expected, answer)
        poet = next(b for b in build_recent_templates(PILLARS).values() if b["primary_source"]["pmid"] == "42663314")
        for lang, question, expected in (
            ("en", "How many patients were assigned to the tailored arm in POET II?", "255 tailored"),
            ("vi", "POET II có bao nhiêu người được phân vào nhóm điều chỉnh?", "255 điều chỉnh"),
        ):
            with self.subTest(lang=lang):
                answer, _ = app._compose_deterministic_ebm_answer(question + "\nA. First\nB. Second\nC. Third\nD. Fourth", [poet], [], lang)
                self.assertIn(expected, answer)

    def test_local_chat_keeps_reported_absolute_and_relative_risk_together(self):
        import fetch_daily_ebm as app
        lesson = next(b for b in build_recent_templates(PILLARS).values() if b["primary_source"]["pmid"] == "42842238")
        for lang, question, rr, absolute in (
            ("en", "What was the absolute risk reduction and relative risk of cardiovascular events from intensive blood pressure lowering?", "RR 0.85", "4.3 events per 1000 person-years"),
            ("en", "What absolute risk reduction and relative risk of cardiovascular events did the authors calculate?", "RR 0.85", "4.3 events per 1000 person-years"),
            ("vi", "Mức giảm nguy cơ tuyệt đối và nguy cơ tương đối của biến cố tim mạch khi hạ huyết áp tích cực là bao nhiêu?", "RR 0,85", "4,3 biến cố/1000 người-năm"),
        ):
            with self.subTest(lang=lang):
                answer, _ = app._compose_deterministic_ebm_answer(question + "\nA. First\nB. Second\nC. Third\nD. Fourth", [lesson], [], lang)
                self.assertIn(rr, answer)
                self.assertIn(absolute, answer)

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
