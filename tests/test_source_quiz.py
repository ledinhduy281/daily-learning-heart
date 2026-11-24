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
        published = [b for b in app.load_existing_briefings() if b.get("quiz_mode") == "source_excerpt"]
        for lesson in [*self.templates.values(), *published]:
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

    def test_review_asks_only_one_blank_per_passage_and_does_not_wrap(self):
        for lesson in (self.templates["1"], self.lesson):
            state = {"subskills": [{"level": 0, "checks": 0} for _ in range(4)]}
            _, state, _ = turn(lesson, state, "en", "start_diagnostic")
            quotes = set()
            while state["current_question"]:
                question = state["current_question"]
                self.assertNotIn(question["source_quote"], quotes)
                quotes.add(question["source_quote"])
                reply, state, _ = turn(lesson, state, "en", "answer", selected_choice=question["correct_key"])
                self.assertIn(question["source_quote"], reply)
            self.assertEqual(quotes, {item["quote"] for item in lesson["quiz_items"]})
            self.assertEqual(state["phase"], "complete")
            self.assertEqual(state["correct_count"], len(quotes))
            self.assertEqual(state["subskills"][1]["checks"], len(quotes))
            self.assertEqual(state["current_options"], [])
            self.assertIn("Review complete.", reply)
            _, state, _ = turn(lesson, state, "en", "answer", selected_choice="A")
            self.assertEqual(state["correct_count"], len(quotes))

    def test_revealed_single_passage_finishes_without_mastery_credit(self):
        lesson = self.templates["1"]
        _, state, _ = turn(lesson, {}, "vi", "start_diagnostic")
        _, told, _ = turn(lesson, state, "vi", "just_tell_me")
        _, complete, result = turn(lesson, told, "vi", "answer", selected_choice=state["correct_key"])
        self.assertEqual(result, "partial")
        self.assertEqual(complete["phase"], "complete")
        self.assertEqual(complete["correct_count"], 0)

    def test_resumes_legacy_duplicate_passage_without_consuming_old_choice(self):
        first, second = self.lesson["quiz_items"]
        lesson = {**self.lesson, "quiz_items": [first, first, second]}
        old = build_mcq(lesson, 1, 1, "en")
        saved = {"question_index": 1, "current_question": old, "correct_count": 1}
        reply, resumed, result = turn(lesson, saved, "en", "answer", selected_choice=old["correct_key"])
        self.assertEqual(result, "partial")
        self.assertEqual(resumed["correct_count"], 1)
        self.assertEqual(resumed["current_question"]["source_quote"], second["quote"])
        self.assertEqual(reply, resumed["last_question"])
        _, final, _ = turn(lesson, resumed, "en", "answer", selected_choice=resumed["correct_key"])
        self.assertEqual(final["correct_count"], 2)
        self.assertEqual(final["phase"], "complete")
        retry = build_mcq(lesson, 2, 2, "en")
        saved.update(question_index=2, current_question=retry, question_revealed=True, attempts_on_current=1)
        _, resumed, _ = turn(lesson, saved, "en", "answer", selected_choice=retry["correct_key"])
        self.assertEqual(resumed["phase"], "diagnostic")
        self.assertEqual(resumed["current_question"]["source_quote"], retry["source_quote"])
        self.assertTrue(resumed["question_revealed"])
        self.assertEqual(resumed["attempts_on_current"], 1)
        _, complete, _ = turn(lesson, resumed, "en", "answer", selected_choice=resumed["correct_key"])
        self.assertEqual(complete["phase"], "complete")
        self.assertEqual(complete["correct_count"], 1)
