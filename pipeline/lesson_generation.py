"""Build the dated lesson from reusable passages and its curated clinical pairing."""

import hashlib
import logging
import re
from xml.etree.ElementTree import ParseError

from clinical_mcq import validated_source_items
from focused_lessons import build_focused_lesson, select_guideline
from focused_quiz import build_source_quiz
from pipeline.ingest import TRANSIENT_READ_ERRORS
from pipeline.lesson_sources import fetch_article


LOGGER = logging.getLogger(__name__)
CURATED = "curated"
LICENSED = "licensed_excerpt"
CURATED_LABELS = {
    "vi": "Biên soạn từ nguồn trích dẫn — chưa được bác sĩ duyệt",
    "en": "Curated from the cited source — not yet physician-reviewed",
}
LOOKUP_ERRORS = (*TRANSIENT_READ_ERRORS, ValueError, KeyError, TypeError, ParseError)


def _matching_article(reference):
    pmid = reference["pmid"]
    try:
        article = fetch_article(pmid)
    except LOOKUP_ERRORS as exc:
        LOGGER.warning("Lesson source PMID %s unavailable: %s", pmid, exc)
        return None
    if article and (article.pmid != pmid or article.doi.casefold() != reference["doi"].casefold()):
        LOGGER.warning("Lesson source PMID %s has conflicting identifiers", pmid)
        return None
    return article


def _excerpt(article, passage):
    return {
        "pmid": article.pmid, "doi": article.doi, "url": article.url,
        "title": article.title, "authors": list(article.authors), "license_url": article.license_url,
        "locator": passage.locator, "role": passage.role, "text": passage.text,
    }


def _recommendation(article, curated):
    if not article:
        return None
    # A guideline can contain hundreds of recommendations. Only replace the
    # exact editorially linked passage, never the first keyword match.
    reviewed_hash = curated.get("recommendation_excerpt_sha256")
    for passage in article.passages:
        if passage.role == "recommendation" and (
            passage.text == curated["recommendation"][1]
            or hashlib.sha256(passage.text.encode()).hexdigest() == reviewed_hash
        ):
            return _excerpt(article, passage)
    return None


def _trial_excerpts(article):
    if not article:
        return {}
    result = {}
    for passage in article.passages:
        field = {
            "methods": "population", "results": "result", "limitations": "limits",
            "methods_and_results": "methods_and_results",
        }.get(passage.role)
        if field and field not in result:
            result[field] = _excerpt(article, passage)
    return result


def _licensed_quiz(lesson, pmid, excerpts):
    # Retain editorially selected blanks when the underlying language matches.
    quiz = build_source_quiz(pmid, [
        item["quote"][:item["start"]] + "[[" + item["answer"] + "]]"
        + item["quote"][item["start"] + len(item["answer"]):]
        for item in lesson.get("quiz_items", ())
        if any(item["quote"] in excerpt["text"] for excerpt in excerpts.values())
    ])
    if not quiz["quiz_items"]:
        # A trial's explicitly reported comparative estimate is a safer blank
        # than arbitrary numbers (e.g. references or treatment doses).
        excerpt = excerpts.get("result") or excerpts.get("methods_and_results") or excerpts.get("recommendation")
        if excerpt:
            text = excerpt["text"]
            pattern = (r"(?<![\w.])([0-9]+(?:\.[0-9]+)?)\s*mm\s*Hg\b" if excerpt["role"] == "recommendation"
                       else r"\bhazard ratio(?:\s*[,=:]\s*|\s+(?:of\s+)?)([0-9]+(?:\.[0-9]+)?)(?![\w.%])")
            match = re.search(pattern, text, re.I)
            if match:
                start, end = match.span(1)
                quiz = build_source_quiz(pmid, [f"{text[:start]}[[{text[start:end]}]]{text[end:]}"])
    valid = validated_source_items({**lesson, **quiz})
    if not valid:
        return None
    quiz["quiz_items"] = [item for _, item in valid]
    quiz["quiz_source_texts"][pmid] = list(dict.fromkeys(item["quote"] for _, item in valid))
    lesson.update(quiz)
    return [key for key, excerpt in excerpts.items()
            if any(quote in excerpt["text"] for quote in quiz["quiz_source_texts"][pmid])]


def _append_markdown(lesson, language, recommendation, evidence_excerpts):
    vi = language == "vi"
    field = "part1_vi_markdown" if vi else "part2_en_markdown"
    label = CURATED_LABELS[language]
    licensed_label = "Trích từ nguồn có giấy phép (nguyên văn tiếng Anh)" if vi else "Extracted from a licensed source"

    def quote(excerpt):
        text = re.sub(r"([\\`*_{}\[\]<>#|])", r"\\\1", excerpt["text"])
        authors = re.sub(r"([\\`*_{}\[\]<>#|])", r"\\\1", ", ".join(excerpt["authors"]))
        source, license_label = ("Nguồn gốc", "Giấy phép") if vi else ("Source", "License")
        return (f"\n\n**{licensed_label}**\n\n> {text}\n\n{authors}. "
                f"[{source}]({excerpt['url']}) · [{license_label}]({excerpt['license_url']})")

    a, separator, b = lesson[field].partition("\n\n## Block B")
    end = f"\n\n*{lesson[f'disclaimer_{language}']}*"
    if not separator:
        a = a.removesuffix(end)
    else:
        b = b.removesuffix(end)
    a += f"\n\n*{label}*"
    if recommendation:
        a += quote(recommendation)
    if separator:
        b += f"\n\n*{label}*"
        b += "".join(quote(excerpt) for excerpt in evidence_excerpts.values())
    lesson[field] = a + separator + b + end


def build_open_lesson(pillar, date_str):
    lesson = build_focused_lesson(pillar, date_str)
    evolution = lesson["guideline_evolution"]
    guideline = _matching_article(evolution["current_guideline"])
    recommendation = _recommendation(guideline, select_guideline(pillar["id"]))
    if recommendation:
        evolution["licensed_recommendation"] = recommendation
    evidence = lesson.get("supporting_evidence")
    excerpts = _trial_excerpts(_matching_article(evidence)) if evidence else {}
    if excerpts:
        evidence["licensed_excerpts"] = excerpts
    quiz_sources = _licensed_quiz(lesson, evidence["pmid"], excerpts) if excerpts else None
    if not quiz_sources and recommendation:
        quiz_sources = _licensed_quiz(lesson, recommendation["pmid"], {"recommendation": recommendation})
    lesson["lesson_provenance"] = {
        "block_a": {"summary_vi": CURATED, "summary_en": CURATED,
                    "recommendation_excerpt": LICENSED if recommendation else None},
        "block_b": {"population_vi": CURATED, "population_en": CURATED, "supports": CURATED,
                    "limits": CURATED, "result": CURATED,
                    "excerpts": {key: LICENSED for key in excerpts}} if evidence else None,
        "quiz": {"mode": LICENSED if quiz_sources else CURATED if lesson.get("quiz_items") else "unavailable",
                 "excerpt_roles": quiz_sources or []},
    }
    if recommendation or excerpts:
        lesson["content_source"] = "licensed_source_rotation"
    for language in ("vi", "en"):
        _append_markdown(lesson, language, recommendation, excerpts)
    return lesson
