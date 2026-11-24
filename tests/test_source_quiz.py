import copy
import datetime
import unittest
from unittest.mock import patch

import fetch_daily_ebm as app
from clinical_mcq import build_mcq, validated_source_items
from focused_lessons import build_focused_templates
from socratic_quiz import turn


class SourceQuizTests(unittest.TestCase):
    def setUp(self):
        self.templates = build_focused_templates(app.PILLARS)
        self.lesson = self.templates["9"]

    def test_all_topics_have_source_backed_questions_in_both_languages(self):
        for lesson in self.templates.values():
            items = validated_source_items(lesson)
            self.assertGreaterEqual(len(items), 2)
            self.assertEqual(len(items), len(lesson["quiz_items"]))
            for lang in ("vi", "en"):
                for variant, (_, item) in enumerate(items):
                    question = build_mcq(lesson, 1, variant, lang)
                    answer = next(o["text"] for o in question["options"] if o["key"] == question["correct_key"])
                    self.assertEqual(answer, item["answer"])
                    self.assertIn(item["quote"], question["explanation"])
                    self.assertIn("____", question["question"])
                    self.assertNotIn(item["quote"], question["question"])

    def test_rejects_missing_source_mismatched_pmid_wrong_answer_offset_and_duplicate_choices(self):
        base = self.lesson["quiz_items"][0]
        for mutation in (
            {"quote": ""}, {"quote": base["quote"] + "."}, {"pmid": "not-a-pmid"},
            {"pmid": "32871100"}, {"answer": "000"}, {"start": base["start"] + 1},
            {"distractors": [base["answer"], "12%", "13%"]},
            {"distractors": ["1.0%", "1.00%", "13%"]},
        ):
            lesson = {**self.lesson, "quiz_items": [{**base, **mutation}]}
            self.assertIsNone(build_mcq(lesson, 1, 0, "en"), mutation)
        self.assertIsNone(build_mcq({**self.lesson, "quiz_source_texts": {}}, 1, 0, "en"))
        wrong = {**self.lesson["supporting_evidence"], "recommendation_id": "unrelated"}
        self.assertFalse(validated_source_items({**self.lesson, "supporting_evidence": wrong}))

    def test_reveal_rebuilds_saved_key_and_rejects_a_modified_question(self):
        _, state, _ = turn(self.lesson, {}, "en", "start_diagnostic")
        self.assertNotIn("revealed_source_pmid", state)
        question = state["current_question"]
        reply, next_state, _ = turn(self.lesson, state, "en", "answer", selected_choice=question["correct_key"])
        self.assertIn(question["source_quote"], reply)
        self.assertEqual(next_state["revealed_source_pmid"], "26308684")
        altered = copy.deepcopy(state)
        altered["current_question"]["options"][0]["text"] = "999"
        reply, rejected, result = turn(self.lesson, altered, "en", "answer", selected_choice="A")
        self.assertEqual(result, "partial")
        self.assertIn("restart", reply)
        self.assertNotIn("revealed_source_pmid", rejected)

    def test_served_quiz_rejects_archives_and_supports_scheduled_static_fallback(self):
        old = {"id": "archive", "pillar_id": 9}
        with patch.object(app, "_today_vn", return_value=datetime.date(2026, 11, 24)), \
                patch.object(app, "load_existing_briefings", return_value=[old]):
            args = {"lang": "en", "action": "start_diagnostic", "briefing_id": old["id"]}
            self.assertFalse(app.handle_socratic_turn(args, source_only=True)["ok"])
            self.assertFalse(app.handle_socratic_turn({**args, "briefing_id": "unknown"}, source_only=True)["ok"])
            with patch.object(app, "_load_chat_quota", return_value={}):
                focused = app.handle_socratic_turn({**args, "briefing_id": "ebm-2026-11-24-p9-focused"}, source_only=True)
            self.assertTrue(focused["ok"])
            self.assertIn("____", focused["reply_markdown"])
