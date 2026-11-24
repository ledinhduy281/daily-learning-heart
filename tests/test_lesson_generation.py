import hashlib
import unittest
from urllib.error import URLError
from unittest.mock import patch

from clinical_mcq import validated_source_items
from focused_lessons import LESSONS, select_guideline, select_supporting_evidence
from pillar_library import PILLARS
from pipeline import lesson_coverage, lesson_generation
from pipeline.lesson_sources import Article, Passage


PILLAR = PILLARS[0]
GUIDELINE = select_guideline(PILLAR["id"])
TRIAL = select_supporting_evidence(GUIDELINE)
GUIDELINE_PMID, GUIDELINE_DOI = GUIDELINE["guideline"][2:4]
TRIAL_PMID = TRIAL["pmid"]
RECOMMENDATION = "Synthetic recommendation fixture: keep the test threshold at 110 mmHg under the stated condition."
RESULT = "In this synthetic test fixture, the primary outcome had a hazard ratio of 0.55 (95% CI, 0.35 to 0.72)."
LICENSE = "https://creativecommons.org/licenses/by/4.0/"


def article(pmid, doi, passages):
    return Article(pmid, "PMC12345", doi, "Synthetic article fixture", ("An Author",), LICENSE,
                   tuple(Passage(f"fixture/{i}", role, text) for i, (role, text) in enumerate(passages)))


class LessonGenerationTests(unittest.TestCase):
    @patch.object(lesson_generation, "fetch_article")
    def test_generation_uses_exact_reviewed_guideline_and_matched_trial(self, fetch):
        fetch.side_effect = {
            GUIDELINE_PMID: article(GUIDELINE_PMID, GUIDELINE_DOI, [
                ("recommendation", "Unrelated recommendation."),
                ("recommendation", RECOMMENDATION),
            ]),
            TRIAL_PMID: article(TRIAL_PMID, TRIAL["doi"], [
                ("methods", "The synthetic fixture enrolled consenting adults."),
                ("results", RESULT),
            ]),
        }.__getitem__
        reviewed = {**GUIDELINE, "recommendation_excerpt_sha256": hashlib.sha256(RECOMMENDATION.encode()).hexdigest()}
        with patch.dict(LESSONS, {1: [reviewed]}):
            lesson = lesson_generation.build_open_lesson(PILLAR, "2026-11-26")
        self.assertEqual(lesson["content_source"], "licensed_source_rotation")
        self.assertEqual(lesson["guideline_evolution"]["licensed_recommendation"]["text"], RECOMMENDATION)
        self.assertEqual(lesson["guideline_evolution"]["recommendation_vi"], GUIDELINE["recommendation"][0])
        self.assertEqual(lesson["supporting_evidence"]["licensed_excerpts"]["result"]["text"], RESULT)
        self.assertEqual(lesson["supporting_evidence"]["limits_en"], TRIAL["limits"][1])
        self.assertEqual(lesson["lesson_provenance"]["block_b"]["limits"], "curated")
        self.assertEqual(lesson["lesson_provenance"]["quiz"], {"mode": "licensed_excerpt", "excerpt_roles": ["result"]})
        _, item = validated_source_items(lesson)[0]
        self.assertEqual((item["pmid"], item["answer"], item["quote"]), (TRIAL_PMID, "0.55", RESULT))
        for field in ("part1_vi_markdown", "part2_en_markdown"):
            self.assertIn(RESULT, lesson[field])
            self.assertIn(RECOMMENDATION, lesson[field])
            self.assertIn(LICENSE, lesson[field])
            self.assertNotIn("Unrelated recommendation", lesson[field])

    @patch.object(lesson_generation, "fetch_article")
    def test_trial_can_supply_excerpt_when_guideline_is_unavailable(self, fetch):
        fetch.side_effect = [None, article(TRIAL_PMID, TRIAL["doi"], [("results", RESULT)])]
        lesson = lesson_generation.build_open_lesson(PILLAR, "2026-11-26")
        self.assertIsNone(lesson["lesson_provenance"]["block_a"]["recommendation_excerpt"])
        self.assertEqual(lesson["lesson_provenance"]["quiz"]["mode"], "licensed_excerpt")

    @patch.object(lesson_generation, "fetch_article")
    def test_guideline_can_supply_quiz_when_no_licensed_trial_excerpt_matches(self, fetch):
        fetch.side_effect = [
            article(GUIDELINE_PMID, GUIDELINE_DOI, [("recommendation", RECOMMENDATION)]), None,
        ]
        reviewed = {**GUIDELINE, "recommendation": (GUIDELINE["recommendation"][0], RECOMMENDATION)}
        with patch.dict(LESSONS, {1: [reviewed]}):
            lesson = lesson_generation.build_open_lesson(PILLAR, "2026-11-26")
        self.assertEqual(lesson["lesson_provenance"]["quiz"]["excerpt_roles"], ["recommendation"])
        _, item = validated_source_items(lesson)[0]
        self.assertEqual((item["pmid"], item["answer"]), (GUIDELINE_PMID, "110"))

    @patch.object(lesson_generation, "fetch_article")
    def test_failure_and_conflicting_doi_keep_the_same_curated_pair(self, fetch):
        fetch.side_effect = [URLError("offline"), article(TRIAL_PMID, "10.1234/wrong", [("results", RESULT)])]
        with self.assertLogs(lesson_generation.LOGGER, level="WARNING"):
            lesson = lesson_generation.build_open_lesson(PILLAR, "2026-11-26")
        self.assertEqual(lesson["content_source"], "curated_library_rotation")
        self.assertEqual(lesson["supporting_evidence"]["pmid"], TRIAL_PMID)
        self.assertEqual(lesson["lesson_provenance"]["quiz"]["mode"], "curated")
        self.assertTrue(validated_source_items(lesson))
        self.assertIn("Curated from the cited source — not yet physician-reviewed", lesson["part2_en_markdown"])
        self.assertIn("Biên soạn từ nguồn trích dẫn — chưa được bác sĩ duyệt", lesson["part1_vi_markdown"])

    @patch.object(lesson_coverage, "fetch_article")
    def test_coverage_separates_licensed_unmatched_unavailable_and_errors(self, fetch):
        def lookup(pmid):
            if pmid == GUIDELINE_PMID:
                return article(pmid, GUIDELINE_DOI, [("recommendation", RECOMMENDATION)])
            if pmid == select_guideline(2)["guideline"][2]:
                raise URLError("offline")
            return None

        fetch.side_effect = lookup
        rows = lesson_coverage.guideline_coverage()
        self.assertEqual([row["pillar"] for row in rows], list(range(1, 11)))
        self.assertEqual(rows[0]["status"], "licensed_full_text")
        self.assertFalse(rows[0]["recommendation_matched"])
        self.assertEqual(rows[1]["status"], "lookup_error")
        self.assertEqual(rows[2]["status"], "no_supported_licensed_full_text")
