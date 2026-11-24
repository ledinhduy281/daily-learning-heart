"""Fetch licensed JATS passages for editorially identified lesson sources."""

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from pipeline.ingest import get_json


EUROPE_PMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/"
PMID = re.compile(r"[1-9][0-9]{0,8}")
PMCID = re.compile(r"PMC[1-9][0-9]*")
XLINK = "{http://www.w3.org/1999/xlink}href"
LANG = "{http://www.w3.org/XML/1998/namespace}lang"
LICENSES = {
    "https://creativecommons.org/licenses/by/4.0/",
    "https://creativecommons.org/publicdomain/zero/1.0/",
}
MAX_XML_BYTES = 5_000_000


@dataclass(frozen=True)
class Passage:
    locator: str
    role: str
    text: str


@dataclass(frozen=True)
class Article:
    pmid: str
    pmcid: str
    doi: str
    title: str
    authors: tuple
    license_url: str
    passages: tuple

    @property
    def url(self):
        return f"https://pmc.ncbi.nlm.nih.gov/articles/{self.pmcid}/"


def _text(element):
    return " ".join("".join(element.itertext()).split()) if element is not None else ""


def _license(meta):
    declared = set()
    for license_el in meta.findall("./permissions/license"):
        if re.search(r"\ball rights reserved\b|\bnot permitted without\b", _text(license_el), re.I):
            return None
        refs = []
        for el in license_el.iter():
            if el.tag.rsplit("}", 1)[-1] == "license_ref":
                refs.append(_text(el))
            href = el.get(XLINK, "")
            if href and (el is license_el or href.startswith(
                ("https://creativecommons.org/", "http://creativecommons.org/")
            )):
                refs.append(href)
        if not refs:
            return None
        declared.update("https://" + url.split("://", 1)[1].rstrip("/") + "/"
                        if url.startswith(("https://", "http://")) else url for url in refs)
    return next(iter(declared)) if len(declared) == 1 and declared <= LICENSES else None


def _passages(article):
    parents = {child: node for node in article.iter() for child in node}

    def reusable(element):
        rights = {"permissions", "license", "license_ref", "copyright-statement", "copyright-holder", "copyright-year"}

        def marks_rights(node):
            return node.tag.rsplit("}", 1)[-1] in rights

        if any(marks_rights(node) for node in element.iter()):
            return False
        while (element := parents.get(element)) is not None:
            if any(marks_rights(child) for child in element):
                return False
        return True

    for i, sec in enumerate(article.findall("./body//sec"), 1):
        heading = _text(sec.find("title"))
        if (re.fullmatch(r"(?:key |specific )?recommendations?(?:\s+(?:for|on)\s+.+)?", heading, re.I)
                or re.search(r":\s*recommendations?$", heading, re.I)):
            for j, el in enumerate(sec.findall("./p") + sec.findall("./list/list-item/p"), 1):
                if reusable(el) and (value := _text(el)):
                    yield Passage(f"body/sec[{i}]/recommendation[{j}]", "recommendation", value)
    for i, table in enumerate(article.findall("./body//table-wrap"), 1):
        if not reusable(table):
            continue
        caption = _text(table.find("caption"))
        if not re.match(r"recommendations?\b", caption, re.I):
            continue
        headers = table.findall("./table/thead/tr")
        if len(headers) != 1:
            continue
        columns = list(headers[0])
        if any(col.tag not in ("td", "th") or col.get("colspan", "1") != "1"
               or col.get("rowspan", "1") != "1" for col in columns):
            continue
        positions = [j for j, col in enumerate(columns) if _text(col).casefold() in ("recommendation", "recommendations")]
        if len(positions) != 1:
            continue
        col = positions[0]
        rows = table.findall("./table/tbody/tr")
        if any(cell.get("rowspan", "1") != "1" for row in rows for cell in row):
            continue
        for j, row in enumerate(rows, 1):
            cells = list(row)
            if (len(cells) == len(columns) and all(c.tag in ("td", "th") and c.get("colspan", "1") == "1" for c in cells)
                    and (value := _text(cells[col]))):
                yield Passage(f"body/table[{i}]/row[{j}]/col[{col + 1}]", "recommendation", value)
    for i, abstract in enumerate(article.findall("./front/article-meta/abstract"), 1):
        if abstract.get("abstract-type") not in (None, "abstract") or abstract.get(LANG, "en") != "en":
            continue
        for j, sec in enumerate(abstract.findall("sec"), 1):
            heading = _text(sec.find("title")).casefold().rstrip(":")
            role = {
                "design, setting, and participants": "methods", "methods": "methods",
                "methods and results": "methods_and_results", "results": "results",
                "limitations": "limitations",
            }.get(heading)
            if role:
                for k, p in enumerate(sec.findall("p"), 1):
                    if reusable(p) and (value := _text(p)):
                        yield Passage(f"abstract[{i}]/sec[{j}]/p[{k}]", role, value)


def parse_article(xml, pmid, pmcid):
    """Return only explicitly reuse-licensed articles with matching source IDs."""
    if len(xml) > MAX_XML_BYTES or re.search(rb"<!ENTITY\b", xml, re.I):
        raise ValueError("Unsupported article XML")
    article = ET.fromstring(xml)
    meta = article.find("./front/article-meta")
    if article.tag != "article" or meta is None:
        raise ValueError("Expected a JATS article")
    if article.get(LANG, "en") != "en":
        return None
    ids = {}
    for el in meta.findall("article-id"):
        kind = el.get("pub-id-type")
        value = _text(el)
        if kind in ("pmc", "pmcid") and value:
            ids.setdefault("pmcid", set()).add(value if value.startswith("PMC") else f"PMC{value}")
        elif kind in ("pmid", "doi") and value:
            ids.setdefault(kind, set()).add(value)
    if ids.get("pmid") != {pmid} or ids.get("pmcid") != {pmcid}:
        raise ValueError("Article identifiers do not match")
    license_url = _license(meta)
    title = _text(meta.find("./title-group/article-title"))
    dois = ids.get("doi", set())
    authors = tuple(filter(None, (
        _text(author.find("collab")) or " ".join(filter(None, (
            _text(author.find("name/given-names")), _text(author.find("name/surname")),
        ))) for author in meta.findall("./contrib-group/contrib[@contrib-type='author']")
    )))
    if not license_url or not title or not authors or len(dois) != 1:
        return None
    return Article(pmid, pmcid, next(iter(dois)), title, authors, license_url, tuple(_passages(article)))


def fetch_article(pmid):
    """Resolve a PubMed ID to an open Europe PMC article, not to its abstract alone."""
    if not PMID.fullmatch(pmid):
        raise ValueError("Invalid PubMed ID")
    result = get_json(EUROPE_PMC + "search", {
        "query": f"SRC:MED AND EXT_ID:{pmid} AND OPEN_ACCESS:Y", "format": "json",
    })
    matches = {
        row["pmcid"] for row in result["resultList"]["result"]
        if row.get("source") == "MED" and row.get("pmid") == pmid and PMCID.fullmatch(row.get("pmcid") or "")
    }
    if len(matches) != 1:
        return None
    pmcid = matches.pop()
    request = Request(f"{EUROPE_PMC}{pmcid}/fullTextXML", headers={
        "User-Agent": "DailyLearningHeart/1.0 (+https://github.com/ledinhduy281/daily-learning-heart)",
        "Accept": "application/xml",
    })
    try:
        with urlopen(request, timeout=25) as response:
            xml = response.read(MAX_XML_BYTES + 1)
    except HTTPError as exc:
        if exc.code in (404, 410):
            return None
        raise
    return parse_article(xml, pmid, pmcid)
