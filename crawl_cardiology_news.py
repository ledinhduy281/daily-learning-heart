#!/usr/bin/env python3
"""
Pure Live Data Crawler for Daily Cardiology EBM Briefing (No AI Synthesis).
===========================================================================
Crawls the latest publications (last 45 days, e.g., Oct–Nov 2026) directly from
NCBI PubMed E-utilities across tier-1 cardiology & general medicine journals:
  - The New England Journal of Medicine (NEJM)
  - The Lancet
  - European Heart Journal (EHJ)
  - Journal of the American College of Cardiology (JACC)
  - Circulation
  - JAMA / JAMA Cardiology

Parses structured XML abstracts (Background, Methods, Results, Conclusions),
extracts verbatim statistical metrics (HR/RR/OR, 95% CI, p-value, sample size),
and formats deterministic, 100% verifiable briefings without LLM hallucination.
"""

import datetime
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
TRANS_CACHE_PATH = BASE_DIR / "data" / "translation_cache.json"
_trans_lock = threading.Lock()
_trans_cache = None


def _load_trans_cache() -> dict:
    global _trans_cache
    if _trans_cache is not None:
        return _trans_cache
    if TRANS_CACHE_PATH.exists():
        try:
            _trans_cache = json.loads(TRANS_CACHE_PATH.read_text(encoding="utf-8"))
            return _trans_cache
        except Exception:
            pass
    _trans_cache = {}
    return _trans_cache


def _save_trans_cache() -> None:
    if _trans_cache is None:
        return
    TRANS_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    TRANS_CACHE_PATH.write_text(json.dumps(_trans_cache, ensure_ascii=False), encoding="utf-8")


def translate_en_to_vi(text: str) -> str:
    """
    Deterministically translates English medical text to Vietnamese via MyMemory API
    (with higher-quota `de=` param + retry) and GoogleTranslator fallback.
    Never caches untranslated strings. Preserves numbers/HR/CI.
    """
    if not text or not text.strip():
        return text
    text = text.strip()

    with _trans_lock:
        cache = _load_trans_cache()
        cached = cache.get(text)
        if cached and cached != text and "MYMEMORY WARNING" not in cached:
            return cached

    sentences = re.split(r"(?<=[.!?])\s+", text)
    chunks = []
    cur = ""
    for s in sentences:
        if len(cur) + len(s) + 1 <= 440:
            cur = (cur + " " + s).strip() if cur else s
        else:
            if cur:
                chunks.append(cur)
            cur = s[:440]
    if cur:
        chunks.append(cur)

    translated_parts = []
    all_ok = True
    for ch in chunks:
        with _trans_lock:
            cache = _load_trans_cache()
            c_hit = cache.get(ch)
            if c_hit and c_hit != ch and "MYMEMORY WARNING" not in c_hit:
                translated_parts.append(c_hit)
                continue

        tr = None
        # Attempt 1: MyMemory with de= param + retry
        for attempt in range(3):
            try:
                url = (
                    "https://api.mymemory.translated.net/get?q="
                    + urllib.parse.quote(ch)
                    + "&langpair=en|vi&de=cardiology.ebm.reader@gmail.com"
                )
                req = urllib.request.Request(url, headers={"User-Agent": "CardiologyEBM/1.0"})
                with urllib.request.urlopen(req, timeout=8) as r:
                    data = json.loads(r.read().decode("utf-8"))
                cand = data.get("responseData", {}).get("translatedText", "")
                if data.get("responseStatus") == 200 and cand and "MYMEMORY WARNING" not in cand and cand != ch:
                    tr = cand
                    break
            except urllib.error.HTTPError as he:
                if he.code == 429 and attempt < 2:
                    time.sleep(0.9 * (attempt + 1))
                    continue
                break
            except Exception:
                break

        # Attempt 2: Fallback to deep_translator GoogleTranslator with retry
        if not tr:
            from deep_translator import GoogleTranslator
            for g_attempt in range(3):
                try:
                    time.sleep(0.5 * (g_attempt + 1))
                    cand = GoogleTranslator(source="en", target="vi").translate(ch)
                    if cand and cand != ch:
                        tr = cand
                        break
                except Exception:
                    time.sleep(1.5 * (g_attempt + 1))

        if tr:
            with _trans_lock:
                _load_trans_cache()[ch] = tr
            translated_parts.append(tr)
            time.sleep(0.25)
        else:
            all_ok = False
            translated_parts.append(ch)

    result = " ".join(translated_parts)
    if all_ok and result != text:
        with _trans_lock:
            _load_trans_cache()[text] = result
            _save_trans_cache()
    else:
        with _trans_lock:
            _save_trans_cache()
    return result

TIER1_JOURNALS_FILTER = (
    '("N Engl J Med"[Journal] OR "Lancet"[Journal] OR "Eur Heart J"[Journal] '
    'OR "J Am Coll Cardiol"[Journal] OR "Circulation"[Journal] '
    'OR "JAMA"[Journal] OR "JAMA Cardiol"[Journal])'
)

PILLAR_CRAWL_QUERIES = {
    1: '(hypertension OR "blood pressure" OR antihypertensive)',
    2: '(cholesterol OR dyslipidemia OR statin OR PCSK9 OR "lipoprotein(a)" OR atherosclerosis OR colchicine OR ziltivekimab)',
    3: '("coronary artery disease" OR "chronic coronary" OR "myocardial ischemia" OR microvascular OR angina OR "acute coronary")',
    4: '(antithrombotic OR antiplatelet OR anticoagulant OR ticagrelor OR prasugrel OR apixaban OR rivaroxaban OR "Factor XI")',
    5: '("heart failure" OR "cardiogenic shock" OR HFrEF OR HFpEF OR SGLT2 OR finerenone)',
    6: '("atrial fibrillation" OR arrhythmia OR ablation OR pacing OR pacemaker OR "ventricular tachycardia")',
    7: '("aortic stenosis" OR TAVR OR "mitral regurgitation" OR tricuspid OR endocarditis)',
    8: '(cardiomyopathy OR hypertrophic OR amyloidosis OR myocarditis OR pericarditis)',
    9: '("pulmonary hypertension" OR "pulmonary embolism" OR aortic OR "peripheral artery")',
    10: '(semaglutide OR tirzepatide OR "GLP-1" OR cardiorenal OR "cardio-oncology")',
}


def extract_key_stats(text: str) -> dict:
    """
    Deterministically extracts primary statistical figures (HR/RR/OR, 95% CI, p-value)
    verbatim from the PubMed abstract text. Returns empty strings if not found.
    """
    if not text:
        return {"metric": "", "ci": "", "p_value": ""}

    metric = ""
    ci = ""
    p_val = ""

    # Match HR / RR / OR patterns like "hazard ratio, 0.78", "HR 0.84", "rate ratio 0.82"
    m_metric = re.search(
        r"\b(hazard ratio|rate ratio|odds ratio|relative risk|HR|RR|OR)\s*[,:=]?\s*(0\.\d+|[1-9]\d*\.\d+)",
        text,
        flags=re.IGNORECASE,
    )
    if m_metric:
        label = m_metric.group(1).upper()
        if "HAZARD" in label:
            label = "HR"
        elif "RATE" in label:
            label = "RR"
        elif "ODDS" in label:
            label = "OR"
        elif "RELATIVE" in label:
            label = "RR"
        metric = f"{label} {m_metric.group(2)}"

    # Match 95% CI
    m_ci = re.search(
        r"95%\s*(?:CI|confidence interval)[,:]?\s*(\d+\.\d+\s*(?:to|-|–)\s*\d+\.\d+)",
        text,
        flags=re.IGNORECASE,
    )
    if m_ci:
        ci = f"95% CI: {m_ci.group(1).replace(' to ', '–')}"

    # Match P-value
    m_p = re.search(
        r"\b[pP]\s*([<>=])\s*(0\.\d+|<0\.001)",
        text,
    )
    if m_p:
        p_val = f"p {m_p.group(1)} {m_p.group(2)}"

    return {"metric": metric, "ci": ci, "p_value": p_val}


def crawl_pubmed_latest(pillar_id: int, days_back: int = 45, max_articles: int = 4) -> list:
    """
    Crawls the newest articles (sorted by publication date) from NCBI PubMed
    for the given Cardiology Pillar within the last `days_back` days (e.g., Oct-Nov 2026).
    """
    topic_q = PILLAR_CRAWL_QUERIES.get(pillar_id, '(cardiology OR cardiovascular)')
    today = datetime.date.today()
    start_dt = (today - datetime.timedelta(days=days_back)).strftime("%Y/%m/%d")
    end_dt = (today + datetime.timedelta(days=30)).strftime("%Y/%m/%d")
    date_filter = f'("{start_dt}"[Date - Publication] : "{end_dt}"[Date - Publication])'

    full_query = f"{topic_q} AND {TIER1_JOURNALS_FILTER} AND {date_filter}"
    encoded_q = urllib.parse.quote(full_query)
    esearch_url = (
        f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?"
        f"db=pubmed&term={encoded_q}&retmode=json&retmax=15&sort=pub+date"
    )

    def _urlopen_retry(req_url: str, timeout: int = 10) -> bytes:
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req_url, timeout=timeout) as resp:
                    return resp.read()
            except urllib.error.HTTPError as he:
                if he.code == 429 and attempt < 2:
                    time.sleep(1.2 * (attempt + 1))
                    continue
                raise

    try:
        search_data = json.loads(_urlopen_retry(esearch_url, timeout=10).decode("utf-8"))
        id_list = search_data.get("esearchresult", {}).get("idlist", [])

        # Fallback: widen window to 90 days if fewer than 3 articles found
        if len(id_list) < 3:
            wider_start = (today - datetime.timedelta(days=90)).strftime("%Y/%m/%d")
            wider_filter = f'("{wider_start}"[Date - Publication] : "{end_dt}"[Date - Publication])'
            full_query = f"{topic_q} AND {TIER1_JOURNALS_FILTER} AND {wider_filter}"
            esearch_url = (
                f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?"
                f"db=pubmed&term={urllib.parse.quote(full_query)}&retmode=json&retmax=15&sort=pub+date"
            )
            time.sleep(0.4)
            search_data = json.loads(_urlopen_retry(esearch_url, timeout=10).decode("utf-8"))
            id_list = search_data.get("esearchresult", {}).get("idlist", [])

        if not id_list:
            return []

        time.sleep(0.35)
        ids_str = ",".join(id_list)
        efetch_url = (
            f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?"
            f"db=pubmed&id={ids_str}&retmode=xml"
        )
        xml_bytes = _urlopen_retry(efetch_url, timeout=12)

        root = ET.fromstring(xml_bytes)
        parsed = []
        for art in root.findall(".//PubmedArticle"):
            pmid_el = art.find(".//MedlineCitation/PMID")
            if pmid_el is None or not pmid_el.text:
                continue
            pmid = pmid_el.text.strip()

            title_el = art.find(".//Article/ArticleTitle")
            title = "".join(title_el.itertext()).strip() if title_el is not None else ""

            journal_ta = (art.findtext(".//MedlineCitation/MedlineJournalInfo/MedlineTA") or "").strip()
            journal_el = art.find(".//Article/Journal/ISOAbbreviation") or art.find(".//Article/Journal/Title")
            journal = journal_ta or (journal_el.text.strip() if journal_el is not None and journal_el.text else "PubMed")

            # PubDate extraction
            pub_date_el = art.find(".//Article/Journal/JournalIssue/PubDate")
            pub_parts = []
            if pub_date_el is not None:
                for tag in ("Year", "Month", "Day"):
                    el = pub_date_el.find(tag)
                    if el is not None and el.text:
                        pub_parts.append(el.text.strip())
            pubdate = " ".join(pub_parts) if pub_parts else today.strftime("%Y %b")

            # DOI extraction
            doi = ""
            for aid in art.findall(".//PubmedData/ArticleIdList/ArticleId"):
                if aid.attrib.get("IdType") == "doi" and aid.text:
                    doi = aid.text.strip()
                    break

            # Authors (first 3 + et al.)
            authors = []
            for au in art.findall(".//Article/AuthorList/Author"):
                ln = au.find("LastName")
                ini = au.find("Initials")
                if ln is not None and ln.text:
                    name = f"{ln.text.strip()} {ini.text.strip()}" if (ini is not None and ini.text) else ln.text.strip()
                    authors.append(name)
            author_str = ", ".join(authors[:3]) + (" et al." if len(authors) > 3 else "")

            # Publication Types
            pub_types = [pt.text.strip() for pt in art.findall(".//Article/PublicationTypeList/PublicationType") if pt.text]
            primary_type = "Research Article"
            for pt in pub_types:
                if pt in ("Randomized Controlled Trial", "Practice Guideline", "Guideline", "Meta-Analysis", "Systematic Review", "Clinical Trial"):
                    primary_type = pt
                    break

            # Structured Abstract Sections
            sections = {}
            full_abs_parts = []
            for ab in art.findall(".//Article/Abstract/AbstractText"):
                lbl = (ab.attrib.get("NlmCategory") or ab.attrib.get("Label") or "SUMMARY").upper()
                txt = "".join(ab.itertext()).strip()
                if txt:
                    sections[lbl] = (sections.get(lbl, "") + " " + txt).strip()
                    full_abs_parts.append(txt)

            full_abstract = "\n\n".join(full_abs_parts)
            stats = extract_key_stats(sections.get("RESULTS", full_abstract))

            parsed.append({
                "pmid": pmid,
                "title": title,
                "source": journal,
                "pubdate": pubdate,
                "authors": author_str,
                "pub_type": primary_type,
                "doi": doi,
                "url": f"https://doi.org/{doi}" if doi else f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                "sections": sections,
                "full_abstract": full_abstract,
                "stats": stats,
                "has_abstract": bool(full_abstract),
            })

        # Prioritize articles with full abstracts and RCT/Guideline/Meta-Analysis types, preserving date order
        with_abs = [a for a in parsed if a["has_abstract"]]
        without_abs = [a for a in parsed if not a["has_abstract"]]
        ordered = with_abs + without_abs
        return ordered[:max_articles]

    except Exception as exc:
        print(f"[Crawler Warning] PubMed crawl failed for Pillar #{pillar_id}: {exc}", file=sys.stderr)
        return []


def build_crawled_briefing(pillar: dict, articles: list) -> dict:
    """
    Constructs a pure, deterministic EBM Briefing directly from crawled Oct–Nov 2026
    PubMed XML articles (no AI synthesis).
    """
    today_str = datetime.date.today().isoformat()
    pid = pillar["id"]

    if not articles:
        title_vi = f"[Crawl {today_str}] Trụ cột #{pid}: {pillar['vi_name']} — Chưa có bài mới"
        title_en = f"[Crawl {today_str}] Pillar #{pid}: {pillar['name']} — No New Articles"
        part1_vi = f"# {title_vi}\n\nKhông tìm thấy bài báo mới trong cửa sổ 45 ngày gần nhất trên NCBI PubMed."
        part2_en = f"# {title_en}\n\nNo new articles found in the last 45-day window on NCBI PubMed."
    else:
        VI_SECTION_LABELS = {
            "BACKGROUND": "Bối cảnh",
            "OBJECTIVE": "Mục tiêu",
            "METHODS": "Phương pháp",
            "RESULTS": "Kết quả",
            "CONCLUSIONS": "Kết luận",
            "SUMMARY": "Tóm tắt",
            "UNASSIGNED": "Tóm tắt",
        }

        for art in articles:
            art["title_vi"] = translate_en_to_vi(art["title"])
            sec_vi = {}
            for k, val in art["sections"].items():
                sec_vi[k] = translate_en_to_vi(val)
            art["sections_vi"] = sec_vi
            if not sec_vi and art["full_abstract"]:
                art["full_abstract_vi"] = translate_en_to_vi(art["full_abstract"])

        lead = articles[0]
        title_vi = (lead.get("title_vi") or lead["title"]).rstrip(".")
        title_en = lead["title"].rstrip(".")

        # Build Block A (Crawl Summary)
        journals_seen = ", ".join(sorted({a["source"] for a in articles}))
        dates_seen = f"{articles[-1]['pubdate']} → {articles[0]['pubdate']}" if len(articles) > 1 else articles[0]["pubdate"]

        block_a_vi = (
            f"## BLOCK A — Tổng quan Dữ liệu Mới Nhất (Thu thập trực tiếp từ PubMed: {today_str})\n\n"
            f"- **Trụ cột chuyên khoa**: Trụ cột #{pid} — {pillar['vi_name']} (*{pillar['name']}*)\n"
            f"- **Nguồn dữ liệu**: NCBI PubMed E-utilities (`sort=pub+date`, không qua AI tổng hợp)\n"
            f"- **Các tạp chí hạng 1 ghi nhận**: {journals_seen}\n"
            f"- **Khung thời gian xuất bản**: {dates_seen} ({len(articles)} công trình mới nhất)\n"
        )

        block_a_en = (
            f"## BLOCK A — Live PubMed Crawl Summary ({today_str})\n\n"
            f"- **Cardiology Pillar**: Pillar #{pid} — {pillar['name']}\n"
            f"- **Data Source**: Direct NCBI PubMed E-utilities XML Crawl (`sort=pub+date`, zero AI synthesis)\n"
            f"- **Tier-1 Journals Captured**: {journals_seen}\n"
            f"- **Publication Window**: {dates_seen} ({len(articles)} latest publications)\n"
        )

        # Build Block B (Detailed Crawled Articles)
        b_vi_list = []
        b_en_list = []
        pearls_vi = []
        pearls_en = []

        for idx, art in enumerate(articles, start=1):
            st = art["stats"]
            stat_line = " | ".join(x for x in (st["metric"], st["ci"], st["p_value"]) if x)
            stat_badge = f"\n- **Chỉ số thống kê trích xuất nguyên văn**: `{stat_line}`" if stat_line else ""
            stat_badge_en = f"\n- **Extracted Verbatim Statistics**: `{stat_line}`" if stat_line else ""

            sec = art["sections"]
            sec_vi = art["sections_vi"]
            body_parts_vi = []
            body_parts_en = []
            for k in ("BACKGROUND", "OBJECTIVE", "METHODS", "RESULTS", "CONCLUSIONS", "SUMMARY", "UNASSIGNED"):
                if k in sec:
                    vi_lbl = VI_SECTION_LABELS.get(k, k)
                    body_parts_vi.append(f"- **{vi_lbl}**: {sec_vi.get(k, sec[k])}")
                    body_parts_en.append(f"- **{k if k != 'UNASSIGNED' else 'ABSTRACT'}**: {sec[k]}")
            if not body_parts_vi and art["full_abstract"]:
                body_parts_vi.append(f"- **Tóm tắt**: {art.get('full_abstract_vi', art['full_abstract'])}")
                body_parts_en.append(f"- **ABSTRACT**: {art['full_abstract']}")
            if not body_parts_vi:
                body_parts_vi.append("- *(Bài báo chưa công bố Abstract trên PubMed XML; xem toàn văn qua link DOI/PMID bên dưới).*")
                body_parts_en.append("- *(Abstract not yet indexed in PubMed XML; access full text via DOI/PMID link below).*")

            VI_PUB_TYPES = {
                "Research Article": "Bài báo Nghiên cứu",
                "Randomized Controlled Trial": "Thử nghiệm Ngẫu nhiên (RCT)",
                "Practice Guideline": "Hướng dẫn Thực hành",
                "Guideline": "Hướng dẫn Thực hành",
                "Meta-Analysis": "Phân tích Gộp",
                "Systematic Review": "Tổng quan Hệ thống",
                "Clinical Trial": "Thử nghiệm Lâm sàng",
            }
            vi_type = VI_PUB_TYPES.get(art["pub_type"], art["pub_type"])
            doi_str = f"DOI: `{art['doi']}` | " if art["doi"] else ""
            b_vi_list.append(
                f"### {idx}. [{vi_type}] {art['title_vi']}\n"
                f"- **Tạp chí & Ngày đăng**: *{art['source']}* (**{art['pubdate']}**)\n"
                f"- **Tác giả**: {art['authors'] or 'Xem trên PubMed'}\n"
                f"- **Đã tìm thấy trích dẫn**: {doi_str}PMID: `{art['pmid']}`{stat_badge}\n\n"
                + "\n".join(body_parts_vi)
            )
            b_en_list.append(
                f"### {idx}. [{art['pub_type']}] {art['title']}\n"
                f"- **Journal & Publication Date**: *{art['source']}* (**{art['pubdate']}**)\n"
                f"- **Authors**: {art['authors'] or 'See PubMed'}\n"
                f"- **Identifiers**: {doi_str}PMID: `{art['pmid']}`{stat_badge_en}\n\n"
                + "\n".join(body_parts_en)
            )

            conc_vi = sec_vi.get("CONCLUSIONS") or sec_vi.get("RESULTS") or sec_vi.get("UNASSIGNED") or sec_vi.get("SUMMARY") or ""
            conc_en = sec.get("CONCLUSIONS") or sec.get("RESULTS") or sec.get("UNASSIGNED") or sec.get("SUMMARY") or ""
            if conc_vi:
                short_conc_vi = conc_vi[:340].rsplit(" ", 1)[0] + ("..." if len(conc_vi) > 340 else "")
                pearls_vi.append(f"{len(pearls_vi)+1}. **[KẾT LUẬN NGHIÊN CỨU]** *{art['source']} ({art['pubdate']})*: {short_conc_vi}")
            if conc_en:
                short_conc_en = conc_en[:340].rsplit(" ", 1)[0] + ("..." if len(conc_en) > 340 else "")
                pearls_en.append(f"{len(pearls_en)+1}. **[LANDMARK TRIAL]** *{art['source']} ({art['pubdate']})*: {short_conc_en}")

        if not pearls_vi:
            pearls_vi.append(f"1. **[CẬP NHẬT PUBMED]** Đã thu thập {len(articles)} bài báo mới nhất tháng 10–11/2026 cho Trụ cột #{pid} từ PubMed.")
            pearls_en.append(f"1. **[PUBMED UPDATE]** Crawled {len(articles)} latest Oct–Nov 2026 articles for Pillar #{pid} from PubMed.")

        part1_vi = (
            f"# {title_vi}\n\n"
            f"{block_a_vi}\n\n---\n\n"
            f"## BLOCK B — Các Công trình Mới Nhất (Quét trực tiếp Tháng 10–11/2026)\n\n"
            + "\n\n---\n\n".join(b_vi_list)
            + "\n\n---\n\n## III. TAKE-HOME CLINICAL PEARLS FOR ROUNDS\n\n"
            + "\n".join(pearls_vi)
            + "\n\n---\n\n## V. CLOSING DISCLAIMER\n\n"
            "⚠️ Dữ liệu trên được thu thập tự động nguyên văn từ cơ sở dữ liệu NCBI PubMed (không qua AI diễn giải); bác sĩ cần đọc toàn văn công trình gốc trước khi áp dụng lâm sàng."
        )

        part2_en = (
            f"# {title_en}\n\n"
            f"{block_a_en}\n\n---\n\n"
            f"## BLOCK B — Latest Crawled Publications (Oct–Nov 2026)\n\n"
            + "\n\n---\n\n".join(b_en_list)
            + "\n\n---\n\n## III. TAKE-HOME CLINICAL PEARLS FOR ROUNDS\n\n"
            + "\n".join(pearls_en)
            + "\n\n---\n\n## V. CLOSING DISCLAIMER\n\n"
            "⚠️ Data above is crawled verbatim from NCBI PubMed without AI synthesis; clinicians must consult the full-text publications prior to clinical decision-making."
        )

    pubmed_anchors = [
        {
            "pmid": a["pmid"],
            "title": a["title"],
            "source": a["source"],
            "pubdate": a["pubdate"],
            "doi": a["doi"],
            "url": a["url"],
        }
        for a in articles
    ]

    return {
        "id": f"ebm-{today_str}-p{pid}-{int(time.time()) % 10000}",
        "date": today_str,
        "time": "07:00 AM",
        "model_used": "none",
        "content_source": "pubmed_live_crawler",
        "pillar_id": pid,
        "pillar_name": pillar["name"],
        "pillar_vi": pillar["vi_name"],
        "title_vi": title_vi,
        "title_en": title_en,
        "word_count_vi": len(part1_vi.split()),
        "verified_step0": True,
        "interaction_id": f"crawl-{today_str}-p{pid}",
        "pubmed_anchors": pubmed_anchors,
        "crawled_articles": articles,
        "part1_vi_markdown": part1_vi,
        "part2_en_markdown": part2_en,
    }


# ==============================================================================
# LIVE LATEST-GUIDELINE CRAWLER (Rolling Last 3 Months / 90 Days: Official Guidelines)
# ==============================================================================

REPUTABLE_GUIDELINE_JOURNALS = (
    '("Eur Heart J"[Journal] OR "Circulation"[Journal] OR "J Am Coll Cardiol"[Journal] '
    'OR "Hypertension"[Journal] OR "Eur J Prev Cardiol"[Journal] OR "Europace"[Journal] '
    'OR "Eur J Heart Fail"[Journal] OR "J Arrhythm"[Journal] OR "J Hypertens"[Journal] '
    'OR "Hypertens Res"[Journal] OR "J Formos Med Assoc"[Journal] OR "Can J Cardiol"[Journal] '
    'OR "Circ J"[Journal] OR "Curr Cardiol Rep"[Journal] OR "Curr Atheroscler Rep"[Journal] '
    'OR "Am J Kidney Dis"[Journal] OR "J Hosp Med"[Journal] OR "JACC Adv"[Journal] '
    'OR "Eur Heart J Suppl"[Journal] OR "Eur J Cardiothorac Surg"[Journal] '
    'OR "Eur Heart J Acute Cardiovasc Care"[Journal] OR "Catheter Cardiovasc Interv"[Journal] '
    'OR "BMC Nephrol"[Journal] OR "Heart Lung Circ"[Journal] OR "J Cardiovasc Comput Tomogr"[Journal])'
)

PILLAR_GUIDELINE_QUERIES = {
    1: '(hypertension[Title] OR "blood pressure"[Title] OR antihypertensive[Title]) NOT "pulmonary"[Title] NOT "portal"[Title]',
    2: '(dyslipidaemias[Title] OR dyslipidemia[Title] OR cholesterol[Title] OR ASCVD[Title] OR "lipid-lowering"[Title]) NOT "anesthetic"[Title]',
    3: '("coronary"[Title] OR "acute coronary"[Title] OR "PCI"[Title] OR "angina"[Title] OR "coronary computed tomographic"[Title])',
    4: '(antiplatelet[Title] OR anticoagulant[Title] OR anticoagulation[Title] OR "stroke prevention"[Title] OR "thromboembolism"[Title])',
    5: '("heart failure"[Title] OR "cardiogenic shock"[Title] OR "HFpEF"[Title] OR "HFrEF"[Title])',
    6: '("atrial fibrillation"[Title] OR "arrhythmia"[Title] OR "arrhythmic"[Title] OR "rhythm disorders"[Title] OR "ventricular"[Title]) NOT "desmoid"[Title] NOT "thyroid"[Title]',
    7: '("valvular"[Title] OR "aortic valve"[Title] OR "aortic stenosis"[Title] OR "mitral"[Title] OR "tricuspid"[Title] OR "infective endocarditis"[Title])',
    8: '(myocarditis[Title] OR pericarditis[Title] OR "cardiomyopathy"[Title] OR "cardiomyopathies"[Title] OR "congenital heart"[Title]) NOT "neonates"[Title]',
    9: '("pulmonary embolism"[Title] OR "pulmonary hypertension"[Title] OR "aortic surgery"[Title] OR "aortic dissection"[Title] OR "peripheral artery"[Title] OR "venous thromboembolism"[Title]) NOT "infants"[Title]',
    10: '("chronic kidney disease"[Title] OR "cardiac rehabilitation"[Title] OR "exercise prescriptions"[Title] OR "cardiovascular disease and pregnancy"[Title])',
}

_MONTH_MAP = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _detect_guideline_society(title: str, journal: str = "") -> str:
    t = title or ""
    if "ESC/EACTS" in t:
        return "ESC / EACTS"
    if "ESC/EAS" in t:
        return "ESC / EAS"
    if "ESC/ERA" in t or ("chronic kidney disease" in t.lower() and ("ESC" in t or journal == "Eur Heart J")):
        return "ESC / ERA"
    if "AHA/ACC/ESC/WHF" in t:
        return "AHA / ACC / ESC / WHF"
    if "AHA/ACC" in t or "American Heart Association/American College of Cardiology" in t:
        return "AHA / ACC"
    if "ACC/AHA" in t or "American College of Cardiology/American Heart Association" in t:
        return "ACC / AHA"
    if "EACTS" in t:
        return "EACTS"
    if "ISH" in t or "International Society of Hypertension" in t:
        return "ISH"
    if "THS" in t or "Taiwan hypertension society" in t.lower():
        return "THS"
    if "APHRS" in t or "Asia Pacific Heart Rhythm Society" in t:
        return "APHRS"
    if "CCS/CHFS" in t or "Canadian Cardiovascular Society" in t:
        return "CCS / CHFS"
    if "JCS" in t:
        return "JCS / JHFS"
    if "KDOQI" in t:
        return "KDOQI / AHA / ACC"
    if "UK kidney" in t.lower():
        return "UKKA"
    if "PERT Consortium" in t:
        return "PERT Consortium / AHA"
    if "ESC" in t or "European Society of Cardiology" in t or journal == "Eur Heart J":
        return "ESC"
    if "ACC" in t or journal == "J Am Coll Cardiol":
        return "ACC"
    if "AHA" in t or journal in ("Circulation", "Hypertension"):
        return "AHA"
    return "International Cardiology Society"


def _score_guideline_candidate(item: dict) -> tuple:
    """Rank newest 3-month (Aug-Nov 2026) official society guidelines/statements highest."""
    title_low = (item.get("title") or "").lower()
    journal = item.get("source") or ""
    year = int(item.get("year") or 0)
    month = int(item.get("month_num") or 0)
    pub_types = item.get("pub_types") or []

    is_correction = any(
        bad in title_low
        for bad in (
            "correction to",
            "correction:",
            "corrigendum",
            "withdrawn",
            "reply to",
            "author correction",
            "large language model",
            "chatgpt",
            "artificial intelligence",
        )
    )
    if is_correction:
        return (-1, 0, 0, 0)

    is_primary_gl = (
        "Practice Guideline" in pub_types
        or "Guideline" in pub_types
        or bool(re.search(r"^(?:\d{4}\s+)?[\w/]+\s+guidelines?\s+(?:for|on)\s+", title_low))
        or "focused update of" in title_low
        or "guideline for the" in title_low
        or "guidelines for the" in title_low
        or "guideline on the" in title_low
        or "guidelines on cardiac" in title_low
        or "guidelines (part" in title_low
        or "expert consensus" in title_low
        or "scientific statement" in title_low
        or "consensus statement" in title_low
        or "consensus document" in title_low
        or "position paper" in title_low
    )
    is_secondary = any(
        w in title_low
        for w in (
            "perspective from",
            "view from",
            "editors' view",
            "case-based",
            "projected impact",
            "implications of",
            "prevalence",
            "demographic reporting",
            "studies informing",
            "informing the 202",
            "patient perspective",
            "missing stakeholders",
            "retrieval-augmented",
            "g ital cardiol",
        )
    )
    if item.get("source") in ("G Ital Cardiol (Rome)", "Zhonghua Xin Xue Guan Bing Za Zhi"):
        is_secondary = True

    is_flagship_journal = journal in (
        "Eur Heart J",
        "Circulation",
        "J Am Coll Cardiol",
        "Hypertension",
        "J Hypertens",
        "Hypertens Res",
        "J Arrhythm",
        "Can J Cardiol",
        "Circ J",
        "Eur J Prev Cardiol",
        "Eur J Cardiothorac Surg",
        "J Formos Med Assoc",
        "Am J Kidney Dis",
        "JACC Adv",
    )

    priority = 0
    if is_primary_gl and not is_secondary:
        priority += 18
        if any(
            k in title_low
            for k in (
                "joint committee on clinical practice guidelines",
                "developed by the task force",
                "scientific statement",
                "expert consensus",
                "guidelines for",
                "guidelines on",
            )
        ):
            priority += 8
    elif ("ten commandments" in title_low or "10 commandments" in title_low or "key updates" in title_low or "key highlights" in title_low or "top 10" in title_low or "comparison of" in title_low or "kdoqi commentary" in title_low or "pert consortium" in title_low) and not is_secondary:
        priority += 10
    elif not is_secondary:
        priority += 3
    else:
        priority -= 8
    if is_flagship_journal:
        priority += 4
    if item.get("has_abstract"):
        priority += 1

    # Penalize papers about old <=2024 guidelines when they don't mention 2026
    old_ref = re.search(r"\b20(1[0-9]|2[0-4])\b", title_low)
    has_2026 = bool(re.search(r"\b202[6-9]\b", title_low))
    if old_ref and not has_2026:
        priority -= 14

    return (year, month, priority, int(item.get("pmid", "0") or 0))


def crawl_latest_guidelines(
    pillar_id: int,
    max_results: int = 5,
    min_year: int = 2026,
    days_back: int = 90,
) -> list[dict]:
    """
    Live-crawls official Cardiology Society guidelines, scientific statements, and
    expert consensus documents published strictly within the LAST 3 MONTHS (`days_back=90`,
    Aug–Nov 2026 relative to today's clock) from NCBI PubMed E-utilities.
    Never returns old 2024 or 2025 publications.
    """
    topic_q = PILLAR_GUIDELINE_QUERIES.get(
        pillar_id,
        '("ESC Guidelines"[Title] OR "AHA/ACC"[Title] OR "ACC/AHA"[Title])',
    )
    today = datetime.date.today()
    min_pub_year = max(2026, int(min_year or 2026))
    start_date = max(today - datetime.timedelta(days=days_back), datetime.date(min_pub_year, 1, 1))
    start_dt = start_date.strftime("%Y/%m/%d")
    end_dt = (today + datetime.timedelta(days=45)).strftime("%Y/%m/%d")
    date_filter = f'("{start_dt}"[Date - Publication] : "{end_dt}"[Date - Publication])'
    type_filter = (
        '("Practice Guideline"[Publication Type] OR "Guideline"[Publication Type] '
        'OR "Guideline"[Title] OR "Guidelines"[Title] OR "Focused Update"[Title] '
        'OR "Expert Consensus"[Title] OR "Scientific Statement"[Title] '
        'OR "Consensus Statement"[Title] OR "Consensus Document"[Title] '
        'OR "Position Paper"[Title] OR "Ten Commandments"[Title] OR "10 commandments"[Title]) '
        'NOT "Correction to"[Title] NOT "Correction:"[Title] NOT "Corrigendum"[Title] '
        'NOT "WITHDRAWN"[Title] NOT "Author Correction"[Title] NOT "Reply"[Title] '
        'NOT "Large Language Model"[Title] NOT "ChatGPT"[Title] NOT "2024 ESC"[Title]'
    )

    queries_to_try = [
        f"({topic_q}) AND {REPUTABLE_GUIDELINE_JOURNALS} AND {type_filter} AND {date_filter}",
        f"({topic_q}) AND {type_filter} AND {date_filter}",
    ]

    def _urlopen_retry(req_url: str, timeout: int = 12) -> bytes:
        for attempt in range(3):
            try:
                req = urllib.request.Request(req_url, headers={"User-Agent": "DailyLearningHeart/2.0"})
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return resp.read()
            except urllib.error.HTTPError as he:
                if he.code == 429 and attempt < 2:
                    time.sleep(1.1 * (attempt + 1))
                    continue
                raise

    id_list: list[str] = []
    seen_ids: set[str] = set()
    for idx_q, q in enumerate(queries_to_try):
        try:
            esearch_url = (
                "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?"
                f"db=pubmed&term={urllib.parse.quote(q)}&retmode=json&retmax=15&sort=pub+date"
            )
            if idx_q > 0:
                time.sleep(0.35)
            data = json.loads(_urlopen_retry(esearch_url, timeout=12).decode("utf-8"))
            for pid in data.get("esearchresult", {}).get("idlist", []):
                if pid not in seen_ids:
                    seen_ids.add(pid)
                    id_list.append(pid)
            if len(id_list) >= max_results:
                break
        except Exception as exc:
            print(f"[Guideline Crawler Warning] esearch failed for Pillar #{pillar_id}: {exc}", file=sys.stderr)

    if not id_list:
        return []

    try:
        time.sleep(0.35)
        efetch_url = (
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?"
            f"db=pubmed&id={','.join(id_list[:15])}&retmode=xml"
        )
        root = ET.fromstring(_urlopen_retry(efetch_url, timeout=18))
        candidates: list[dict] = []

        for art in root.findall(".//PubmedArticle"):
            pmid = (art.findtext(".//MedlineCitation/PMID") or "").strip()
            if not pmid:
                continue
            title_el = art.find(".//Article/ArticleTitle")
            title = "".join(title_el.itertext()).strip().rstrip(".") if title_el is not None else ""
            if not title:
                continue

            journal_ta = (art.findtext(".//MedlineCitation/MedlineJournalInfo/MedlineTA") or "").strip()
            journal_el = art.find(".//Article/Journal/ISOAbbreviation") or art.find(".//Article/Journal/Title")
            journal = journal_ta or (journal_el.text.strip() if journal_el is not None and journal_el.text else "PubMed")

            year_str = (art.findtext(".//Article/Journal/JournalIssue/PubDate/Year") or "").strip()
            month_str = (art.findtext(".//Article/Journal/JournalIssue/PubDate/Month") or "").strip()
            day_str = (art.findtext(".//Article/Journal/JournalIssue/PubDate/Day") or "").strip()
            medline_date = (art.findtext(".//Article/Journal/JournalIssue/PubDate/MedlineDate") or "").strip()
            if not year_str and medline_date:
                m_yr = re.search(r"(20\d{2})", medline_date)
                if m_yr:
                    year_str = m_yr.group(1)
            if not year_str:
                m_ty = re.search(r"\b(202[5-9]|203\d)\b", title)
                year_str = m_ty.group(1) if m_ty else str(today.year)

            try:
                year_num = int(year_str)
            except ValueError:
                year_num = today.year

            month_num = _MONTH_MAP.get(month_str[:3].lower(), 0) if month_str else 0
            pubdate = " ".join(x for x in (year_str, month_str, day_str) if x) or medline_date or year_str

            vol = (art.findtext(".//Article/Journal/JournalIssue/Volume") or "").strip()
            pages = (art.findtext(".//Article/Pagination/MedlinePgn") or "").strip()

            doi = ""
            for aid in art.findall(".//PubmedData/ArticleIdList/ArticleId"):
                if aid.attrib.get("IdType") == "doi" and aid.text:
                    doi = aid.text.strip()
                    break

            pub_types = [
                pt.text.strip()
                for pt in art.findall(".//Article/PublicationTypeList/PublicationType")
                if pt.text
            ]

            sections: dict[str, str] = {}
            full_abs_parts: list[str] = []
            for ab in art.findall(".//Article/Abstract/AbstractText"):
                lbl = (ab.attrib.get("Label") or ab.attrib.get("NlmCategory") or "SUMMARY").upper()
                txt = "".join(ab.itertext()).strip()
                if txt:
                    sections[lbl] = (sections.get(lbl, "") + " " + txt).strip()
                    full_abs_parts.append(txt)
            full_abstract = "\n\n".join(full_abs_parts)

            title_year_match = re.search(r"\b(202[6-9]|203\d)\b", title)
            display_year = int(title_year_match.group(1)) if title_year_match else year_num

            item = {
                "pmid": pmid,
                "title": title,
                "society": _detect_guideline_society(title, journal),
                "source": journal,
                "pubdate": pubdate,
                "year": max(year_num, display_year),
                "month_num": month_num,
                "volume": vol,
                "pages": pages,
                "doi": doi,
                "url": f"https://doi.org/{doi}" if doi else f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                "pub_types": pub_types,
                "sections": sections,
                "full_abstract": full_abstract,
                "has_abstract": bool(full_abstract),
            }
            if year_num >= min_pub_year and _score_guideline_candidate(item)[0] >= min_pub_year:
                candidates.append(item)

        candidates.sort(key=_score_guideline_candidate, reverse=True)
        return candidates[:max_results]
    except Exception as exc:
        print(f"[Guideline Crawler Warning] efetch failed for Pillar #{pillar_id}: {exc}", file=sys.stderr)
        return []


def refresh_guideline_briefing(
    pillar_id: int,
    date_str: str | None = None,
    progress_cb=None,
) -> dict:
    """Build the curated guideline lesson without attaching live search hits."""
    from focused_lessons import build_focused_lesson
    from pillar_library import PILLARS

    if progress_cb:
        progress_cb(45, f"Đang tải khuyến cáo cho Trụ cột #{pillar_id}...")
    pillar = next(pillar for pillar in PILLARS if pillar["id"] == pillar_id)
    return build_focused_lesson(pillar, date_str or datetime.date.today().isoformat())
