"""Fail publication unless the dated lesson satisfies its source contract."""

import argparse
import hashlib
import json
import re
from datetime import date
from pathlib import Path

from clinical_mcq import validated_source_items
from fetch_daily_ebm import get_pillar_for_date
from focused_lessons import build_focused_lesson, select_guideline
from pipeline.lesson_generation import CURATED, LICENSED, _append_markdown
from pipeline.lesson_sources import LICENSES


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _excerpt(excerpt, reference, role):
    _require(isinstance(excerpt, dict) and excerpt.get("role") == role,
             f"Invalid licensed {role} excerpt")
    _require(excerpt.get("pmid") == reference["pmid"]
             and isinstance(excerpt.get("doi"), str) and excerpt["doi"].casefold() == reference["doi"].casefold(),
             f"Licensed {role} excerpt is linked to the wrong publication")
    authors = excerpt.get("authors")
    _require(
        all(isinstance(excerpt.get(key), str) and excerpt[key].strip()
            for key in ("text", "title", "locator", "url", "license_url"))
        and excerpt["license_url"] in LICENSES
        and re.fullmatch(r"https://pmc\.ncbi\.nlm\.nih\.gov/articles/PMC[1-9][0-9]*/", excerpt["url"])
        and isinstance(authors, list) and bool(authors)
        and all(isinstance(name, str) and name.strip() for name in authors),
        f"Licensed {role} excerpt is missing its citation, attribution, or license",
    )


def validate_lesson(lesson, pillar, lesson_date):
    canonical = build_focused_lesson(pillar, lesson_date)
    _require(all(lesson.get(key) == canonical[key] for key in ("id", "date", "pillar_id", "lesson_format")),
             "Lesson does not match the scheduled pillar and date")
    evolution = dict(lesson.get("guideline_evolution") or {})
    recommendation = evolution.pop("licensed_recommendation", None)
    _require(evolution == canonical["guideline_evolution"] and not lesson.get("live_crawled_guidelines"),
             "Block A must contain exactly one approved primary guideline and recommendation")
    _require(lesson.get("pubmed_anchors") == canonical["pubmed_anchors"],
             "Missing, extra, or mismatched lesson citation")
    if recommendation is not None:
        _excerpt(recommendation, evolution["current_guideline"], "recommendation")
        approved = select_guideline(pillar["id"])
        _require(recommendation["text"] == approved["recommendation"][1]
                 or hashlib.sha256(recommendation["text"].encode()).hexdigest() == approved.get("recommendation_excerpt_sha256"),
                 "Licensed guideline passage does not match the approved recommendation")

    evidence = dict(lesson.get("supporting_evidence") or {})
    excerpts = evidence.pop("licensed_excerpts", {})
    _require(evidence and evidence == canonical.get("supporting_evidence")
             and not lesson.get("landmark_trials"),
             "Block B evidence does not match the approved recommendation, population, and limits")
    roles = {"population": "methods", "result": "results", "limits": "limitations",
             "methods_and_results": "methods_and_results"}
    _require(isinstance(excerpts, dict) and excerpts.keys() <= roles.keys(),
             "Invalid licensed evidence excerpt roles")
    for key, excerpt in excerpts.items():
        _excerpt(excerpt, evidence, roles[key])

    provenance = lesson.get("lesson_provenance") or {}
    _require(provenance.get("block_a") == {
        "summary_vi": CURATED, "summary_en": CURATED, "recommendation_excerpt": LICENSED if recommendation else None,
    } and provenance.get("block_b") == {
        "population_vi": CURATED, "population_en": CURATED, "supports": CURATED,
        "limits": CURATED, "result": CURATED, "excerpts": {key: LICENSED for key in excerpts},
    }, "Block A or Block B provenance does not match its content")
    _require(lesson.get("content_source") == ("licensed_source_rotation" if recommendation or excerpts
             else "curated_library_rotation") and lesson.get("model_used") == "none",
             "Lesson source label does not match its content")

    items = lesson.get("quiz_items")
    _require(isinstance(items, list) and bool(items) and len(validated_source_items(lesson)) == len(items),
             "Every quiz key must occur at its marked offset in its cited excerpt")
    quiz = provenance.get("quiz") or {}
    if quiz.get("mode") == LICENSED:
        authorized = {**excerpts, **({"recommendation": recommendation} if recommendation else {})}
        _require(all(any(item["pmid"] == source["pmid"] and item["quote"] in source["text"]
                         for source in authorized.values()) for item in items),
                 "Licensed quiz is not drawn from a licensed lesson excerpt")
        used = {key for key, source in authorized.items()
                if any(item["pmid"] == source["pmid"] and item["quote"] in source["text"] for item in items)}
        _require(used == set(quiz.get("excerpt_roles", ())), "Licensed quiz provenance does not match its excerpts")
    else:
        _require(quiz == {"mode": CURATED, "excerpt_roles": []}
                 and items == canonical.get("quiz_items")
                 and lesson.get("quiz_source_texts") == canonical.get("quiz_source_texts"),
                 "Curated quiz does not match the approved lesson")

    for lang, field in (("vi", "part1_vi_markdown"), ("en", "part2_en_markdown")):
        _append_markdown(canonical, lang, recommendation, excerpts)
        _require(lesson.get(field) == canonical[field], f"{lang} Markdown does not match the cited lesson")


def validate_bundle(bundle, expected_date=None, allow_predating_pipeline=False):
    briefings = bundle["briefings"]
    if allow_predating_pipeline and not any(
        "lesson_provenance" in lesson or lesson.get("content_source") == "licensed_source_rotation"
        for lesson in briefings
    ):
        return None
    lesson_date = bundle["rotation_state"]["last_updated"]
    if expected_date:
        _require(lesson_date == expected_date, f"Refresh produced {lesson_date}, expected {expected_date}")
    pillar = get_pillar_for_date(date.fromisoformat(lesson_date))
    candidates = [lesson for lesson in briefings if lesson.get("date") == lesson_date
                  and lesson.get("content_source") != "model_draft"]
    _require(len(candidates) == 1, "Expected one scheduled lesson on the dated edition")
    validate_lesson(candidates[0], pillar, lesson_date)
    return candidates[0]["id"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=Path("data/briefings.js"))
    parser.add_argument("--date", help="Require this Vietnam calendar date")
    parser.add_argument("--allow-predating-pipeline", action="store_true")
    args = parser.parse_args()
    try:
        _, marker, payload = args.bundle.read_text(encoding="utf-8").partition("window.EBM_BRIEFINGS_DATA = ")
        _require(marker, "Briefing bundle assignment is missing")
        lesson_id = validate_bundle(json.loads(payload.strip().removesuffix(";")), args.date, args.allow_predating_pipeline)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        parser.exit(1, f"Daily lesson publication blocked: {exc}\n")
    print(f"Validated daily lesson: {lesson_id}" if lesson_id else "Existing archive predates the lesson pipeline.")


if __name__ == "__main__":
    main()
