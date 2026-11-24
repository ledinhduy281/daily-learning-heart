"""Report licensed full-text coverage for the active cardiology rotation."""

import json
from concurrent.futures import ThreadPoolExecutor

from focused_lessons import LESSONS, select_guideline
from pipeline.lesson_generation import LOOKUP_ERRORS, _recommendation
from pipeline.lesson_sources import fetch_article


def guideline_coverage():
    def check(pillar):
        lesson = select_guideline(pillar)
        society, year, pmid, doi, title = lesson["guideline"]
        row = {"pillar": pillar, "society": society, "year": year, "pmid": pmid, "doi": doi, "title": title}
        try:
            article = fetch_article(pmid)
        except LOOKUP_ERRORS as exc:
            return {**row, "status": "lookup_error", "error": str(exc)}
        if not article:
            return {**row, "status": "no_supported_licensed_full_text"}
        if article.pmid != pmid or article.doi.casefold() != doi.casefold():
            return {**row, "status": "identifier_mismatch"}
        return {
            **row, "status": "licensed_full_text", "url": article.url, "license_url": article.license_url,
            "recommendation_matched": bool(_recommendation(article, lesson)),
        }

    with ThreadPoolExecutor(max_workers=3) as workers:
        return list(workers.map(check, sorted(LESSONS)))


if __name__ == "__main__":
    print(json.dumps(guideline_coverage(), ensure_ascii=False, indent=2))
