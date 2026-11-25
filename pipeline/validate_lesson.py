"""Fail publication unless the dated lesson satisfies its source contract."""

import argparse
import hashlib
import json
import re
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

from clinical_mcq import validated_source_items
from fetch_daily_ebm import PILLARS, get_pillar_for_date
from focused_lessons import (
    GATE_START_DATE, GUIDELINE_SOCIETIES, TEACHING_MIN_VERSION, TEACHING_START_DATE,
    _citation_url, build_focused_lesson, focused_markdown, select_guideline,
)
from focused_teaching import PEARL_SECTIONS, SECTION_KEYS
from pipeline.lesson_generation import CURATED, CURATED_LABELS, LICENSED, _append_markdown
from pipeline.lesson_sources import LICENSES
from recent_lessons import (
    RECENT_LESSON_VERSION, RECENT_START_DATE, SECTIONS as RECENT_SECTIONS, SOURCE_KINDS, SOURCE_WINDOW_DAYS, WINDOW_DAYS_BY_VERSION,
    build_recent_lesson, citation_url, is_recent, recent_markdown,
)

LEGACY_CURATED_LABELS = {
    "vi": "Nội dung tuyển chọn, đã được người biên tập rà soát",
    "en": "Curated, human-reviewed content",
}


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


def _recorded_wording(supplied, fields):
    for field in fields:
        value = supplied.get(field)
        _require(isinstance(value, str) and value.strip() and "\n" not in value and "\r" not in value,
                 f"Missing or invalid recorded wording: {field}")


def _validate_teaching(lesson, guideline, evidence):
    notes = lesson.get("teaching")
    _require(isinstance(notes, dict) and set(notes) == {"guideline_pmid", "trial_pmid", "vi", "en"}
             and notes["guideline_pmid"] == guideline["pmid"] and notes["trial_pmid"] == evidence["pmid"],
             "The walkthrough must match the cited guideline and study")
    for lang, minimum in (("vi", 1050), ("en", 420)):
        sections = notes[lang]
        _require(isinstance(sections, dict) and set(sections) == set(SECTION_KEYS),
                 f"Missing {lang} teaching sections")
        for key in SECTION_KEYS:
            paragraphs = sections[key]
            _require(isinstance(paragraphs, list) and len(paragraphs) >= (1 if key in PEARL_SECTIONS else 2)
                     and all(isinstance(p, str) and p.strip() and "\n" not in p and "\r" not in p for p in paragraphs),
                     f"Incomplete {lang} teaching section: {key}")
        _require(3 <= sum(len(sections[key]) for key in PEARL_SECTIONS) <= 5,
                 f"Expected three to five {lang} takeaways")
        _require(sum(len(p.split()) for key in SECTION_KEYS for p in sections[key]) >= minimum,
                 f"The {lang} walkthrough is too short for an in-depth lesson")


def _recorded_sources(lesson, evolution, evidence):
    guideline = evolution.get("current_guideline") or {}
    _require(set(evolution) == {"current_guideline", "recommendation_id", "recommendation_vi", "recommendation_en"}
             and set(guideline) == {"name", "society", "year", "pmid", "doi"}
             and guideline["society"] in GUIDELINE_SOCIETIES and not lesson.get("live_crawled_guidelines"),
             "Block A must contain exactly one approved primary guideline and recommendation")
    _recorded_wording(evolution, ("recommendation_id", "recommendation_vi", "recommendation_en"))
    _recorded_wording(guideline, ("name", "year"))
    _require_citation_identifier(guideline)
    _require(evidence and evidence.get("guideline_pmid") == guideline["pmid"]
             and evidence.get("recommendation_id") == evolution["recommendation_id"]
             and not lesson.get("landmark_trials")
             and not any(guideline[key] and evidence.get(key) == guideline[key] for key in ("pmid", "doi")),
             "Block B evidence does not match the recorded recommendation")
    _recorded_wording(evidence, ("name", "journal", "result", *(f"{field}_{lang}"
                       for field in ("population", "supports", "limits") for lang in ("vi", "en"))))
    citations = []
    _require_citation_identifier(evidence)
    for source in (guideline, evidence):
        citations.append({"title": source["name"], "pmid": source["pmid"], "doi": source["doi"],
                          "url": _citation_url(source["pmid"], source["doi"])})
    anchors = lesson.get("pubmed_anchors")
    _require(isinstance(anchors, list) and anchors[:2] == citations and len(anchors) in {2, 3},
             "Missing, extra, or mismatched lesson citation")
    if len(anchors) == 3:
        safety = anchors[2]
        _recorded_wording(safety, ("title", "url"))
        url = urlsplit(safety["url"])
        _require(set(safety) == {"title", "source", "url"} and safety["source"] == "DailyMed"
                 and url.scheme == "https" and url.netloc == "dailymed.nlm.nih.gov" and url.path,
                 "Missing, extra, or mismatched lesson citation")
        return safety
    return None


def _validate_recent_lesson(lesson, pillar, lesson_date, *, recorded, fallback):
    pid = pillar["id"]
    _require(lesson.get("id") == f"ebm-{lesson_date}-p{pid}-focused"
             and lesson.get("date") == lesson_date and lesson.get("pillar_id") == pid
             and (lesson.get("lesson_version") == RECENT_LESSON_VERSION
                  or recorded and lesson.get("lesson_version") in WINDOW_DAYS_BY_VERSION)
             and lesson.get("content_source") == "recent_source_rotation" and lesson.get("model_used") == "none",
             "Lesson does not match the scheduled pillar and date")
    source = lesson.get("primary_source") or {}
    _require(set(source) == {"id", "kind", "label", "name", "journal", "online_date", "pmid", "doi", "url", "window_days"}
             and source["kind"] in SOURCE_KINDS
             and source["window_days"] == WINDOW_DAYS_BY_VERSION[lesson["lesson_version"]]
             and isinstance(source["pmid"], str) and re.fullmatch(r"[1-9][0-9]{0,8}", source["pmid"])
             and isinstance(source["doi"], str) and source["doi"].startswith("10.")
             and source["url"] == citation_url(source),
             "Block A and Block B must cite exactly one primary source")
    _recorded_wording(source, ("name", "journal"))
    edition = lesson.get("curated_edition_date")
    _require(isinstance(edition, str) and RECENT_START_DATE <= edition <= lesson_date
             and is_recent(source, edition, source["window_days"]),
             f"Primary source must be published within {SOURCE_WINDOW_DAYS} days before the catalog edition")
    _require(lesson.get("pubmed_anchors") == [{"title": source["name"], "pmid": source["pmid"],
                                               "doi": source["doi"], "url": source["url"]}],
             "Missing, extra, or mismatched lesson citation")
    _require(not any(lesson.get(key) for key in ("guideline_evolution", "supporting_evidence", "landmark_trials",
                                                  "live_crawled_guidelines")),
             "A single-source lesson must not mix in another guideline or study")
    notes = lesson.get("teaching") or {}
    _require(set(notes) == {"pmid", "vi", "en"} and notes["pmid"] == source["pmid"],
             "The walkthrough must match the primary source")
    for lang in ("vi", "en"):
        sections = notes[lang]
        _require(isinstance(sections, dict) and set(sections) == set(RECENT_SECTIONS)
                 and all(isinstance(sections[key], list) and sections[key]
                         and all(isinstance(p, str) and p.strip() and "\n" not in p for p in sections[key])
                         for key in RECENT_SECTIONS) and 2 <= len(sections["pearls"]) <= 5,
                 f"Incomplete {lang} walkthrough")
    excerpts = lesson.get("source_excerpts")
    _require(isinstance(excerpts, list), "Invalid source excerpts")
    for excerpt in excerpts:
        _require(isinstance(excerpt, dict) and excerpt.get("pmid") == source["pmid"] and excerpt.get("url") == source["url"]
                 and isinstance(excerpt.get("text"), str) and excerpt["text"].strip(), "Excerpt is linked to the wrong source")
        if excerpt.get("kind") == "physician_entered":
            _require(set(excerpt) == {"kind", "pmid", "url", "text", "class", "level", "locator"}
                     and all(isinstance(excerpt[key], str) and excerpt[key].strip() for key in ("class", "level", "locator")),
                     "Physician-entered guideline lines need Class, Level, and page or table")
        else:
            _require(excerpt.get("kind") == "pubmed_abstract" and source["kind"] != "guideline"
                     and set(excerpt) == {"kind", "pmid", "url", "text", "copyright"} and isinstance(excerpt["copyright"], str),
                     "Guideline lessons may quote only physician-entered recommendation lines")
    kinds = {excerpt["kind"] for excerpt in excerpts}
    _require(len(kinds) <= 1 and lesson.get("lesson_provenance") == {
        "primary_source": "pubmed_metadata", "teaching": "curated_unreviewed", "excerpts": next(iter(kinds), None),
    }, "Lesson provenance does not match its content")
    items = lesson.get("quiz_items")
    texts = [excerpt["text"] for excerpt in excerpts]
    if items:
        _require(lesson.get("quiz_mode") == "source_excerpt" and "quiz_status" not in lesson
                 and lesson.get("quiz_source_texts") == {source["pmid"]: texts}
                 and len(validated_source_items(lesson)) == len(items),
                 "Every quiz key must occur at its marked offset in a quoted source excerpt")
    else:
        _require(items == [] and source["kind"] == "guideline" and not excerpts
                 and lesson.get("quiz_status") == "awaiting_physician_excerpts"
                 and "quiz_mode" not in lesson and "quiz_source_texts" not in lesson,
                 "Only a guideline without physician-entered lines may omit its quiz")
    for lang, field in (("vi", "part1_vi_markdown"), ("en", "part2_en_markdown")):
        _recorded_wording(lesson, (f"disclaimer_{lang}", f"title_{lang}"))
        _require(lesson.get(field) == recent_markdown(lesson, lang), f"{lang} Markdown does not match the cited lesson")
    if not recorded or fallback:
        canonical = build_recent_lesson(pillar, lesson_date)
        if fallback:
            canonical = {**canonical, "id": lesson["id"], "date": lesson["date"]}
        _require(lesson == canonical, "Lesson does not match the approved recent-source catalog")


def validate_lesson(lesson, pillar, lesson_date, *, recorded=False, fallback=False):
    pid = pillar["id"]
    if lesson_date >= RECENT_START_DATE or lesson.get("lesson_format") == "single_source":
        _require(lesson.get("lesson_format") == "single_source",
                 "Lessons from the recent-source edition must cite one recent primary source")
        return _validate_recent_lesson(lesson, pillar, lesson_date, recorded=recorded, fallback=fallback)
    _require(lesson.get("id") == f"ebm-{lesson_date}-p{pid}-focused"
             and lesson.get("date") == lesson_date and lesson.get("pillar_id") == pid
             and lesson.get("lesson_format") == "single_guideline",
             "Lesson does not match the scheduled pillar and date")
    evolution = dict(lesson.get("guideline_evolution") or {})
    recommendation = evolution.pop("licensed_recommendation", None)
    evidence = dict(lesson.get("supporting_evidence") or {})
    excerpts = evidence.pop("licensed_excerpts", {})
    if recorded:
        safety = _recorded_sources(lesson, evolution, evidence)
        canonical = {}
    else:
        canonical = build_focused_lesson(pillar, lesson_date)
        _require(evolution == canonical["guideline_evolution"] and not lesson.get("live_crawled_guidelines"),
                 "Block A must contain exactly one approved primary guideline and recommendation")
        _require(lesson.get("pubmed_anchors") == canonical["pubmed_anchors"],
                 "Missing, extra, or mismatched lesson citation")
        _require_citation_identifier(evolution["current_guideline"])
        _require(evidence and evidence == canonical.get("supporting_evidence") and not lesson.get("landmark_trials"),
                 "Block B evidence does not match the approved recommendation, population, and limits")
        _require_citation_identifier(evidence)
    if fallback or lesson_date >= TEACHING_START_DATE or "teaching" in lesson:
        _require(type(lesson.get("lesson_version")) is int and lesson["lesson_version"] >= TEACHING_MIN_VERSION,
                 "Daily lesson is missing the in-depth edition")
        _validate_teaching(lesson, evolution["current_guideline"], evidence)
        if not recorded:
            _require(lesson["teaching"] == canonical.get("teaching"),
                     "Walkthrough does not match the approved editorial catalog")
    if recommendation is not None:
        _excerpt(recommendation, evolution["current_guideline"], "recommendation")
        if not recorded:
            approved = select_guideline(pid)
            _require(recommendation["text"] == evolution["recommendation_en"]
                     or hashlib.sha256(recommendation["text"].encode()).hexdigest() == approved.get("recommendation_excerpt_sha256"),
                     "Licensed guideline passage does not match the approved recommendation")

    roles = {"population": "methods", "result": "results", "limits": "limitations",
             "methods_and_results": "methods_and_results"}
    _require(isinstance(excerpts, dict) and excerpts.keys() <= roles.keys(),
             "Invalid licensed evidence excerpt roles")
    for key, excerpt in excerpts.items():
        _excerpt(excerpt, evidence, roles[key])

    provenance = lesson.get("lesson_provenance") or {}
    if fallback:
        _require(lesson.get("curated_edition_date") == lesson_date and not provenance
                 and recommendation is None and not excerpts, "Fallback must be a curated lesson template")
    else:
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
    quiz = {"mode": CURATED, "excerpt_roles": []} if fallback else provenance.get("quiz") or {}
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
                 and (recorded or (items == canonical.get("quiz_items")
                                   and lesson.get("quiz_source_texts") == canonical.get("quiz_source_texts"))),
                 "Curated quiz does not match the approved lesson")

    for lang, field in (("vi", "part1_vi_markdown"), ("en", "part2_en_markdown")):
        if recorded:
            _recorded_wording(lesson, (f"disclaimer_{lang}",))
            canonical[f"disclaimer_{lang}"] = lesson[f"disclaimer_{lang}"]
            canonical[field] = focused_markdown({"guideline_evolution": evolution, "supporting_evidence": evidence,
                                                "teaching": lesson.get("teaching"),
                                                f"disclaimer_{lang}": lesson[f"disclaimer_{lang}"]}, lang, safety)
        if not fallback:
            _append_markdown(canonical, lang, recommendation, excerpts)
        supplied = lesson.get(field)
        if recorded and not fallback and isinstance(supplied, str):
            supplied = re.sub(rf"^\*{re.escape(LEGACY_CURATED_LABELS[lang])}\*$",
                              f"*{CURATED_LABELS[lang]}*", supplied, flags=re.MULTILINE)
        _require(supplied == canonical[field], f"{lang} Markdown does not match the cited lesson")


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
    state = bundle["rotation_state"]
    if rotation_state is not None:
        _require(rotation_state == state, "Rotation file does not match the lesson bundle")
    if expected_date is None:
        last = date.fromisoformat(state["last_updated"])
        dates = {date.fromisoformat(lesson["date"]) for lesson in governed}
        _require(not dates or max(dates) <= last, "Rotation date does not match the latest lesson")
        _require(last < date.fromisoformat(GATE_START_DATE) or last in dates,
                 f"Missing scheduled lesson for rotation date {last}")
    elif governed:
        _require(state["last_updated"] == expected_date, "Rotation date does not match the latest lesson")
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
    if expected_date is None:
        templates = bundle.get("focused_lessons", {})
        _require(isinstance(templates, dict), "Invalid fallback lesson collection")
        pillars = {str(pillar["id"]): pillar for pillar in PILLARS}
        missing = pillars.keys() - templates.keys()
        _require(not missing, f"Missing fallback lesson for rotation pillar(s): {', '.join(sorted(missing, key=int))}")
        for key, template in templates.items():
            try:
                _require(key in pillars, "Invalid fallback pillar")
                validate_lesson(template, pillars[key], date.fromisoformat(template["date"]).isoformat(),
                                recorded=True, fallback=True)
            except (ValueError, KeyError, TypeError, AttributeError) as exc:
                raise ValueError(f"Fallback pillar {key}: {exc}") from exc
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
