import copy
import json
import subprocess
import sys
import unittest
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fetch_daily_ebm import PILLARS, get_pillar_for_date
from focused_lessons import build_focused_templates
from pipeline import lesson_generation
from pipeline.validate_lesson import validate_bundle
from test_lesson_generation import GUIDELINE, GUIDELINE_PMID, PILLAR, RESULT, TRIAL, TRIAL_PMID, article


REPO = Path(__file__).resolve().parents[1]
DATE = "2026-11-26"


class LessonGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with patch.object(lesson_generation, "fetch_article", return_value=None):
            cls.curated = lesson_generation.build_open_lesson(PILLAR, DATE)
            cls.earlier = [lesson_generation.build_open_lesson(get_pillar_for_date(date.fromisoformat(day)), day)
                           for day in ("2026-11-24", "2026-11-25")]
        cls.templates = build_focused_templates(PILLARS)
        with patch.object(lesson_generation, "fetch_article", side_effect=[
            None, article(TRIAL_PMID, TRIAL["doi"], [("results", RESULT)]),
        ]):
            cls.licensed = lesson_generation.build_open_lesson(PILLAR, DATE)

    def bundle(self, lesson):
        return {"rotation_state": {"last_updated": DATE}, "briefings": copy.deepcopy([lesson, *self.earlier]),
                "focused_lessons": self.templates}

    def test_curated_and_licensed_lessons_pass_without_changing_archive(self):
        for lesson in (self.curated, self.licensed):
            with self.subTest(source=lesson["content_source"]):
                bundle = self.bundle(lesson)
                bundle["briefings"].extend([
                    {"date": "2026-11-23", "legacy": True},
                    {"date": DATE, "content_source": "model_draft"},
                ])
                self.assertEqual(validate_bundle(bundle, DATE), lesson["id"])

    def test_blocks_second_guideline_off_topic_trial_missing_citation_and_wrong_key(self):
        mutations = (
            ("exactly one", lambda b: b["guideline_evolution"].update(prior_guideline={"pmid": "5"})),
            ("exactly one", lambda b: b["guideline_evolution"]["current_guideline"].update(refs=[{"pmid": "5"}])),
            ("does not match", lambda b: b["supporting_evidence"].update(recommendation_id="other-topic")),
            ("mismatched lesson citation", lambda b: b["supporting_evidence"].update(pmid="12345")),
            ("citation", lambda b: b["pubmed_anchors"].pop()),
            ("quiz key", lambda b: b["quiz_items"][0].update(answer="0.94")),
            ("Markdown", lambda b: b.update(part2_en_markdown=b["part2_en_markdown"] + "\nAnother guideline.")),
        )
        for message, mutate in mutations:
            with self.subTest(message=message):
                bundle = self.bundle(self.curated)
                mutate(bundle["briefings"][0])
                with self.assertRaisesRegex(ValueError, message):
                    validate_bundle(bundle)

    def test_pages_uses_recorded_sources_but_refresh_matches_the_catalog(self):
        society, year, pmid, doi, name = GUIDELINE["guideline"]
        for lesson in (self.curated, self.licensed):
            bundle = self.bundle(lesson)
            archived = copy.deepcopy(bundle)
            with self.subTest(source=lesson["content_source"]), patch.dict(
                GUIDELINE, guideline=(society, year, pmid, doi, name + " (corrected)"), recommendation=("Mới", "New")
            ), patch.dict(TRIAL, name="Corrected trial title", pmid="12345"):
                self.assertEqual(validate_bundle(bundle), 3)
                self.assertEqual(bundle, archived)
                with self.assertRaisesRegex(ValueError, "approved primary guideline"):
                    validate_bundle(bundle, DATE)

    def test_rejects_a_self_consistent_quiz_with_an_unlicensed_quote(self):
        bundle = self.bundle(self.licensed)
        lesson = bundle["briefings"][0]
        item, = lesson["quiz_items"]
        wrong_quote = item["quote"] + " An invented sentence."
        lesson["quiz_source_texts"][TRIAL_PMID] = [wrong_quote]
        item["quote"] = wrong_quote
        with self.assertRaisesRegex(ValueError, "not drawn from a licensed lesson excerpt"):
            validate_bundle(bundle)

    def test_blank_doi_uses_pubmed_in_both_markdown_blocks(self):
        society, year, pmid, _, name = GUIDELINE["guideline"]
        with patch.dict(GUIDELINE, guideline=(society, year, pmid, " ", name)), \
                patch.dict(TRIAL, doi=""), patch.object(lesson_generation, "fetch_article", return_value=None):
            lesson = lesson_generation.build_open_lesson(PILLAR, DATE)
            self.assertEqual(validate_bundle(self.bundle(lesson), DATE), lesson["id"])
        for field in ("part1_vi_markdown", "part2_en_markdown"):
            for source_pmid in (GUIDELINE_PMID, TRIAL_PMID):
                self.assertIn(f"](https://pubmed.ncbi.nlm.nih.gov/{source_pmid}/)", lesson[field])
            self.assertNotIn("https://doi.org/", lesson[field])

    def test_rejects_canonical_source_with_neither_citation_identifier(self):
        society, year, _, _, name = GUIDELINE["guideline"]
        for source, change in ((GUIDELINE, {"guideline": (society, year, "", "", name)}),
                               (TRIAL, {"pmid": "", "doi": " "})):
            with self.subTest(source=source), patch.dict(source, change), \
                    patch.object(lesson_generation, "fetch_article", return_value=None):
                lesson = lesson_generation.build_open_lesson(PILLAR, DATE)
                with self.assertRaisesRegex(ValueError, "non-empty PMID or DOI"):
                    validate_bundle(self.bundle(lesson))

    def test_rejects_missing_attribution_on_a_licensed_excerpt(self):
        bundle = self.bundle(self.licensed)
        bundle["briefings"][0]["supporting_evidence"]["licensed_excerpts"]["result"].pop("license_url")
        with self.assertRaisesRegex(ValueError, "citation, attribution, or license"):
            validate_bundle(bundle)

    def test_current_or_future_lessons_cannot_use_legacy_archive_exemption(self):
        for legacy_date in (DATE, "2026-11-27"):
            with self.subTest(legacy_date=legacy_date):
                bundle = self.bundle(self.curated)
                legacy = bundle["briefings"][0]
                if legacy_date != DATE:
                    legacy = {"id": "future-legacy", "date": legacy_date}
                    bundle["briefings"].append(legacy)
                    bundle["rotation_state"]["last_updated"] = legacy_date
                else:
                    legacy.pop("lesson_provenance")
                with self.assertRaisesRegex(ValueError, "Dated lesson is missing provenance"):
                    validate_bundle(bundle)

    def test_legacy_rows_are_not_validated_or_modified(self):
        bundle = {"briefings": [{"date": "2026-11-23", "legacy": True}],
                  "rotation_state": {"last_updated": "2026-11-23"}, "focused_lessons": self.templates}
        previous = copy.deepcopy(bundle)
        self.assertEqual(validate_bundle(bundle), 0)
        self.assertEqual(bundle, previous)

    def test_cli_exits_nonzero_for_invalid_publish_candidate(self):
        bundle = self.bundle(self.curated)
        with TemporaryDirectory() as directory:
            path = Path(directory) / "briefings.js"

            def run():
                path.write_text(f"window.EBM_BRIEFINGS_DATA = {json.dumps(bundle)};")
                return subprocess.run(
                    [sys.executable, "-m", "pipeline.validate_lesson", "--bundle", str(path), "--date", DATE],
                    capture_output=True, text=True, cwd=REPO,
                )

            result = run()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Validated daily lesson", result.stdout)
            bundle["briefings"][0]["pubmed_anchors"] = []
            result = run()
            self.assertEqual(result.returncode, 1)
            self.assertIn(f"Daily lesson publication blocked: {self.curated['id']}: Missing, extra, or mismatched lesson citation",
                          result.stderr)
