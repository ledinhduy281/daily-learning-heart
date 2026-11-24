"""Fail publication unless the dated lesson satisfies its source contract."""

import argparse
import hashlib
import json
import re
from datetime import date
from pathlib import Path

from clinical_mcq import validated_source_items
from fetch_daily_ebm import get_pillar_for_date
from focused_lessons import GATE_START_DATE, build_focused_lesson, focused_markdown, select_guideline
from pipeline.lesson_generation import CURATED, LICENSED, _append_markdown
from pipeline.lesson_sources import LICENSES


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _require_citation_identifier(reference):
    _require(any(isinstance(value, str) and value.strip()
                 for value in (reference.get("pmid"), reference.get("doi"))),
             "Each guideline and study citation must have a non-empty PMID or DOI")


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


def _recorded_wording(expected, supplied, fields):
    for field in fields:
        value = supplied.get(field)
        _require(isinstance(value, str) and value.strip() and "\n" not in value and "\r" not in value,
                 f"Missing or invalid recorded wording: {field}")
        expected[field] = value


def validate_lesson(lesson, pillar, lesson_date, *, recorded=False):
    canonical = build_focused_lesson(pillar, lesson_date)
    _require(all(lesson.get(key) == canonical[key] for key in ("id", "date", "pillar_id", "lesson_format")),
             "Lesson does not match the scheduled pillar and date")
    evolution = dict(lesson.get("guideline_evolution") or {})
    recommendation = evolution.pop("licensed_recommendation", None)
    if recorded:
        _recorded_wording(canonical["guideline_evolution"], evolution, ("recommendation_vi", "recommendation_en"))
    _require(evolution == canonical["guideline_evolution"] and not lesson.get("live_crawled_guidelines"),
             "Block A must contain exactly one approved primary guideline and recommendation")
    _require(lesson.get("pubmed_anchors") == canonical["pubmed_anchors"],
             "Missing, extra, or mismatched lesson citation")
    _require_citation_identifier(evolution["current_guideline"])
    if recommendation is not None:
        _excerpt(recommendation, evolution["current_guideline"], "recommendation")
        approved = select_guideline(pillar["id"])
        _require(recommendation["text"] == canonical["guideline_evolution"]["recommendation_en"]
                 or hashlib.sha256(recommendation["text"].encode()).hexdigest() == approved.get("recommendation_excerpt_sha256"),
                 "Licensed guideline passage does not match the approved recommendation")

    evidence = dict(lesson.get("supporting_evidence") or {})
    excerpts = evidence.pop("licensed_excerpts", {})
    if recorded and evidence and canonical.get("supporting_evidence"):
        fields = tuple(f"{field}_{lang}" for field in ("population", "supports", "limits") for lang in ("vi", "en"))
        _recorded_wording(canonical["supporting_evidence"], evidence, (*fields, "result"))
    _require(evidence and evidence == canonical.get("supporting_evidence")
             and not lesson.get("landmark_trials"),
             "Block B evidence does not match the approved recommendation, population, and limits")
    _require_citation_identifier(evidence)
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
        if recorded:
            canonical[field] = focused_markdown(canonical, lang, select_guideline(pillar["id"]).get("safety_source"))
        _append_markdown(canonical, lang, recommendation, excerpts)
        _require(lesson.get(field) == canonical[field], f"{lang} Markdown does not match the cited lesson")


BUNDLE_ASSIGNMENT = "window.EBM_BRIEFINGS_DATA = "


def _parse_bundle(raw):
    _, marker, payload = raw.partition(BUNDLE_ASSIGNMENT)
    _require(marker, "Briefing bundle assignment is missing")
    return json.loads(payload.strip().removesuffix(";"))


def _read_bundle(path):
    return _parse_bundle(path.read_text(encoding="utf-8"))


def validate_bundle(bundle, expected_date=None, *, rotation_state=None):
    governed = []
    for lesson in bundle["briefings"]:
        lesson_date = date.fromisoformat(lesson["date"]).isoformat()
        if lesson_date < GATE_START_DATE:
            continue
        if expected_date is None or (lesson_date == expected_date and lesson.get("content_source") != "model_draft"):
            governed.append(lesson)
    if expected_date:
        _require(len(governed) == 1, "Expected one scheduled lesson on the dated edition")
    if governed:
        latest = max(lesson["date"] for lesson in governed)
        _require(bundle["rotation_state"]["last_updated"] == latest, "Rotation date does not match the latest lesson")
        if rotation_state is not None:
            _require(rotation_state == bundle["rotation_state"], "Rotation file does not match the lesson bundle")
    seen = set()
    for lesson in governed:
        lesson_id = lesson.get("id")
        _require(lesson_id not in seen, "Expected one scheduled lesson on the dated edition")
        seen.add(lesson_id)
        try:
            _require(lesson.get("lesson_provenance"), "Dated lesson is missing provenance")
            validate_lesson(lesson, get_pillar_for_date(date.fromisoformat(lesson["date"])),
                            lesson["date"], recorded=expected_date is None)
        except ValueError as exc:
            raise ValueError(f"{lesson_id}: {exc}") from exc
    return governed[0]["id"] if expected_date else len(governed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=Path("data/briefings.js"))
    parser.add_argument("--date", help="Validate only this newly generated Vietnam calendar edition")
    parser.add_argument("--rotation-state", type=Path, help="Check the separate rotation state against the bundle")
    args = parser.parse_args()
    try:
        state = json.loads(args.rotation_state.read_text(encoding="utf-8")) if args.rotation_state else None
        if args.rotation_state:
            _require(isinstance(state, dict), "Invalid rotation file")
        result = validate_bundle(_read_bundle(args.bundle), args.date, rotation_state=state)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        parser.exit(1, f"Daily lesson publication blocked: {exc}\n")
    print(f"Validated daily lesson: {result}" if args.date else f"Validated {result} dated archive lessons.")


if __name__ == "__main__":
    main()
