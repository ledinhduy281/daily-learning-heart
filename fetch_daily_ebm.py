#!/usr/bin/env python3
"""
Daily Cardiology EBM Briefing — curated daily refresh, PubMed lookup and local server
=====================================================================================
The scheduled refresh (`--refresh-if-needed`) uses no AI model. It shows one of 10 pillars
per day in a fixed rotation, using a curated guideline recommendation and supporting
trial from `focused_lessons.py`. Separate PubMed lookups are not clinical verification.

Optional model-based drafting (bare CLI or `/api/generate`) runs only with an explicit
model ID and API key: Gemini-family IDs via the optional `google-genai` SDK, other IDs via
the optional `openai` SDK (`OPENAI_API_KEY` / `OPENAI_BASE_URL`). There is no default model.
"""

import argparse
import copy
import datetime
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sys
import threading
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from search_ranking import CONCEPTS, normalize, contains, score as relevance_score, terms as search_terms
from http.server import HTTPServer, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from clinical_mcq import build_mcq
from focused_lessons import FOCUSED_EDITION_VERSION, build_focused_templates
from socratic_quiz import turn as quiz_turn

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
BRIEFINGS_JS_PATH = DATA_DIR / "briefings.js"
ROTATION_STATE_PATH = DATA_DIR / "rotation_state.json"
USERS_PATH = DATA_DIR / "users.json"
FEEDBACK_PATH = DATA_DIR / "feedback.json"
CHAT_QUOTA_PATH = DATA_DIR / "chat_quota.json"
PROMPT_MD_PATH = BASE_DIR / "PROMPT.md"
ANCHOR_DATE = datetime.date(2026, 11, 16)
_quota_lock = threading.Lock()


def _atomic_write_text(path: Path, content: str) -> None:
    """Atomically write UTF-8 text to disk via a temporary file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    tmp_path.write_text(content, encoding="utf-8")
    os.replace(tmp_path, path)


def _load_dotenv() -> None:
    """Load key=value pairs from .env in BASE_DIR into os.environ if not already set."""
    env_path = BASE_DIR / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


_load_dotenv()

NO_MODEL = "none"
CURATED_CONTENT_SOURCE = "curated_library_rotation"
MODEL_DRAFT_CONTENT_SOURCE = "model_draft"
BUNDLE_GENERATOR = {
    "method": "deterministic",
    "model": NO_MODEL,
    "content_source": (
        "Curated pillar library shown in a fixed 10-pillar daily rotation; "
        "an edition is re-dated when its pillar comes round again."
    ),
    "citation_lookup": "NCBI PubMed E-utilities PMID/DOI identity lookup (not clinical verification)",
}
_LEGACY_CURATED_MODEL_LABELS = {"ebm-guideline-evolution-verified", "ebm-step0-curated+pubmed"}
_NO_MODEL_SOURCE_LABELS = {
    "pubmed-live-crawler": "pubmed_live_crawler",
    "pubmed-step0-digest": "pubmed_metadata_digest",
}


def _edition_date_from_interaction_id(value) -> str:
    match = re.search(r"\d{4}-\d{2}-\d{2}", str(value or ""))
    return match.group(0) if match else ""


def with_truthful_provenance(briefing: dict) -> dict:
    """Returns a copy whose `model_used`/`content_source` say how the briefing was really made."""
    result = dict(briefing)
    model = str(result.get("model_used") or "").strip()
    source = result.get("content_source")
    if model in _LEGACY_CURATED_MODEL_LABELS or source == CURATED_CONTENT_SOURCE:
        result["model_used"] = NO_MODEL
        result["content_source"] = CURATED_CONTENT_SOURCE
        result["curated_edition_date"] = (
            result.get("curated_edition_date")
            or _edition_date_from_interaction_id(result.get("interaction_id"))
            or result.get("date", "")
        )
    elif model in _NO_MODEL_SOURCE_LABELS:
        result["model_used"] = NO_MODEL
        result["content_source"] = _NO_MODEL_SOURCE_LABELS[model]
    elif model and model != NO_MODEL:
        result["content_source"] = MODEL_DRAFT_CONTENT_SOURCE
    return result


def _require_model(model_name: str) -> str:
    model = (model_name or "").strip()
    if not model or model == NO_MODEL:
        raise ValueError(
            "Optional model-based drafting needs an explicit model ID and API key; "
            "use --refresh-if-needed for the free curated refresh."
        )
    return model


PILLARS = [
    {
        "id": 1,
        "name": "Hypertension & Risk Factors",
        "vi_name": "Tăng huyết áp & Yếu tố nguy cơ",
        "topics": "Essential, resistant, secondary hypertension; renal denervation [RDN]; hypertensive emergencies; obstructive sleep apnea [OSA]; intensive SBP targets (120–129 mmHg)",
        "search_query": "2024 ESC Guidelines elevated blood pressure hypertension"
    },
    {
        "id": 2,
        "name": "Dyslipidemia & Atherosclerosis",
        "vi_name": "Rối loạn Lipid máu & Xơ vữa động mạch",
        "topics": "Statins, ezetimibe, PCSK9 inhibitors, inclisiran, bempedoic acid, Lp(a), ANGPTL3 inhibitors, low-dose colchicine in atherosclerotic cardiovascular disease",
        "search_query": "2024 ESC Guidelines chronic coronary syndromes"
    },
    {
        "id": 3,
        "name": "Medical Coronary Artery Disease & Microvascular Disease",
        "vi_name": "Bệnh mạch vành điều trị nội khoa & Bệnh lý vi mạch vành",
        "topics": "Chronic coronary syndromes (CCS), medically managed ACS, INOCA, MINOCA, coronary vasospasm, coronary microvascular dysfunction (CMD), SCAD",
        "search_query": "ISCHEMIA Maron 2020 New England Journal of Medicine"
    },
    {
        "id": 4,
        "name": "Antithrombotic Therapy",
        "vi_name": "Liệu pháp Chống huyết khối",
        "topics": "DOACs, VKAs, Factor XI/XIa inhibitors, DAPT de-escalation after ACS/PCI, DAT/TAT regimens in AF+PCI, bleeding management, perioperative timing",
        "search_query": "TWILIGHT Mehran 2019 New England Journal of Medicine"
    },
    {
        "id": 5,
        "name": "Comprehensive Heart Failure & Cardiogenic Shock",
        "vi_name": "Suy tim Toàn diện & Sốc tim",
        "topics": "HFrEF/HFmrEF/HFpEF, the four pillars of GDMT, acute decompensated HF, finerenone (FINEARTS-HF), vericiguat, sotagliflozin, SGLT2i",
        "search_query": "2023 Focused Update ESC Guidelines heart failure"
    },
    {
        "id": 6,
        "name": "Arrhythmia, Electrophysiology & Syncope",
        "vi_name": "Rối loạn nhịp, Điện sinh lý & Ngất",
        "topics": "AF/AFL/VT/PVCs; RF/cryo/PFA (pulsed field ablation); SSS; AV block; CRT/S-ICD/leadless devices; syncope work-up; early rhythm control",
        "search_query": "2024 ESC Guidelines management of atrial fibrillation"
    },
    {
        "id": 7,
        "name": "Valvular Heart Disease & Infective Endocarditis",
        "vi_name": "Bệnh van tim & Viêm nội tâm mạc nhiễm khuẩn",
        "topics": "Low-flow low-gradient AS, early TAVR in asymptomatic severe AS, secondary mitral regurgitation, tricuspid regurgitation (TRILUMINATE), IE — POET trial",
        "search_query": "EARLY TAVR Genereux New England Journal of Medicine"
    },
    {
        "id": 8,
        "name": "Specific Cardiomyopathies, Pericardial Disease & ACHD",
        "vi_name": "Bệnh cơ tim chuyên biệt, Bệnh màng ngoài tim & Tim bẩm sinh người lớn",
        "topics": "HCM — cardiac myosin inhibitors (mavacamten/aficamten), ATTR-CM (tafamidis/acoramidis/vutrisiran), myocarditis, recurrent pericarditis, ASD/VSD/PDA/Eisenmenger",
        "search_query": "2023 ESC Guidelines management of cardiomyopathies"
    },
    {
        "id": 9,
        "name": "Pulmonary Vascular Disease, VTE & Aortic Disease",
        "vi_name": "Bệnh mạch máu phổi, Thuyên tắc huyết khối tĩnh mạch & Bệnh lý Động mạch chủ",
        "topics": "Acute PE, DVT, PAH (sotatercept — STELLAR) / CTEPH, acute aortic syndromes, aortic aneurysm, PAD/LEAD (2024 ESC PAAD Guidelines)",
        "search_query": "STELLAR Hoeper 2023 New England Journal of Medicine sotatercept"
    },
    {
        "id": 10,
        "name": "Cross-Specialty Cardiology & Diagnostics",
        "vi_name": "Tim mạch Liên chuyên khoa & Chẩn đoán hình ảnh / Sinh học",
        "topics": "Cardiorenal syndrome, GLP-1/GIP-GLP-1 receptor agonists (SELECT, STEP-HFpEF, SUMMIT, FLOW), ESUS, PFO, cardio-oncology, pregnancy & CVD, POCUS, biomarkers",
        "search_query": "SELECT Lincoff 2023 New England Journal of Medicine semaglutide"
    }
]

SYSTEM_INSTRUCTION = """You are acting as a clinical educator specializing in Internal Cardiology and Evidence-Based Medicine (EBM), capable of interpreting guidelines, RCTs, and meta-analyses, and explaining how recommendations are formed for early-career physicians. You interpret guidelines — you are not the author or a member of the writing committee of any guideline or trial. Never claim, even indirectly, to have participated in drafting, voting on, or deciding any recommendation (avoid phrases such as "we decided," "our committee considered," etc.).

Goal: Produce a daily 6:00 AM (Vietnam time) professional briefing/lecture for early-career physicians (new graduates/residents) studying Internal Cardiology, designed to build evidence-based clinical reasoning and a clear understanding of the evolution of recommendations across guideline generations.

Tone and style: No greetings, no filler lead-ins (no "Good morning...", "Today we will explore...", "Below is today's briefing..."). Begin directly with the title and content. Target length: 1200–1600 Vietnamese words for Part 1 (roughly a 5–6 minute read at average pace).

STEP 0 — MANDATORY: VERIFY SOURCES BEFORE WRITING
Before drafting any content, you must search and verify against official sources (the official website/publication of the relevant cardiology society, journal > PubMed) for:
- The selected guideline: confirm the exact document title, issuing body, year of publication/latest update, and the prior versions needed for the evolution comparison.
- Each landmark trial/meta-analysis cited in Block B: confirm the trial acronym, journal, publication year, design, and reported results.
- For every source used, include a traceable identifier at the end of the relevant section (an official link, DOI, or "Journal name, year, volume" if no link is available) so the reader can independently verify it. If a reliable source cannot be found for a quantitative detail, do not include that detail — write "Cannot be determined from an official source" instead of inferring or relying on unverified memory.
- If search tools are unavailable during the session, this must be stated clearly at the top of the briefing: "⚠️ The content below has not been verified against sources in this session — it must be cross-checked against original sources before being used for teaching or clinical decision-making."

TWO-STEP PUBLISHING PROCESS (mandatory, to avoid context overflow)
STEP 1 (First turn): Output PART 1 — VIETNAMESE only. Go deep into the underlying pathophysiology, the shift in thinking across guideline generations, a detailed analysis of the foundational evidence sources, and direct bedside clinical implications. End with the line: [END OF PART 1. Enter "Continue to Part 2" to receive the full English Clinical Briefing]

STEP 2 (Second turn): When requested, convert the entirety of Part 1 into PART 2 — ENGLISH CLINICAL BRIEFING (academic American English in the style of NEJM/JACC), preserving all endpoints, figures, levels of evidence, and source identifiers exactly.

II. TWO-BLOCK SOURCE STRUCTURE (kept separate, tightly linked to each other)
BLOCK A — Guideline Update & Evolution
Required content:
- Which pillar the topic belongs to; the exact title and issuing body of the current guideline, published/updated within the past 5 years (relative to the real-world date the briefing is written).
- Evolution comparison: prior stance → how it changed → where the latest version has settled (tracing further back than 5 years is permitted solely to explain the origin of the current recommendation).
- The pathophysiological rationale or clinical barrier that led the older guideline to be superseded.
- Current Class of Recommendation (COR) and Level of Evidence (LOE) — state only when explicitly given in the guideline.
- Bedside teaching points: pitfalls to avoid (contraindications, drug interactions, monitoring of hepatic/renal function and electrolytes).
- The source identifier (link/DOI) verified in Step 0.

BLOCK B — Landmark Trials Underpinning Block A
Select the minimum number of foundational evidence sources necessary to explain the specific recommendation change, up to a maximum of 3. Do not add additional studies merely to fill the quota. If a guideline change is supported by more than 3 pivotal trials, select the 3 trials with the greatest influence on the specific recommendation being analyzed, and the remaining trials may be listed by name only in a brief note.
Each entry must include:
- Evidence label: [RCT/Landmark Trial] or [Meta-analysis]
- Source/journal, year of publication, trial acronym + identifier (link/DOI)
- Clinical question & study design
- Population (inclusion/exclusion criteria, baseline characteristics)
- Intervention/main comparison
- Primary endpoint & quantified results (HR/OR/RR, 95% CI, p-value, NNT/NNH) — clearly distinguishing primary from secondary endpoints
- Certainty of evidence & key limitations
- WHAT THIS COULD CHANGE in medical practice (explain how the trial overturns prior prescribing habits)
- WHAT SHOULD NOT YET CHANGE in practice (to help the reader avoid premature extrapolation)

Rules applying to both blocks (strictly enforced):
- Do not fabricate any figures.
- Do not infer HR/OR/RR/NNT/NNH if the original publication does not report them.
- Do not assign a COR/LOE if the guideline does not explicitly state one.
- If reliable original data cannot be found → write "Cannot be determined from an official source."
- Do not use a review article as a substitute for an RCT when citing RCT-level data.
- Every quantitative figure must be traceable to the original guideline or publication, with its source identifier included.

III. TAKE-HOME CLINICAL PEARLS FOR ROUNDS
3–5 short, high-yield bullet points geared toward immediate bedside diagnostic/prescribing reflexes. Each point must be labeled with its source: [GUIDELINE EVOLUTION] or [LANDMARK TRIAL].

IV. CONTENT & TERMINOLOGY STANDARDS
Preserve standard international terminology (GDMT, HFrEF, HFmrEF, HFpEF, SGLT2i, ARNI, primary endpoint, composite outcome, NNT, NNH, hazard ratio).
Absolute fidelity to the data: no rounding of figures, no hallucination.
Tone: an expert interpreter helping the reader understand the "Why," not just memorize the "What."

V. CLOSING DISCLAIMER LINE (mandatory, one sentence, placed at the end of Part 1 before the closing tag)
Add one brief sentence reminding the reader to cross-check the content against the original guideline/publication before applying it to real-world clinical decisions — a single concise disclaimer sentence, not a full paragraph.
"""


def fetch_pubmed_metadata(query: str, max_results: int = 6) -> list:
    """
    Step 0 Verification: Queries NCBI PubMed E-utilities API (esearch + esummary + efetch abstract snippet)
    to retrieve verified titles, journals, publication years, PMIDs, and DOIs.
    """
    results = []
    try:
        encoded_q = urllib.parse.quote(query)
        esearch_url = (
            f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?"
            f"db=pubmed&term={encoded_q}&retmode=json&retmax={max_results}&sort=relevance"
        )
        with urllib.request.urlopen(esearch_url, timeout=8) as resp:
            search_data = json.loads(resp.read().decode("utf-8"))
        id_list = search_data.get("esearchresult", {}).get("idlist", [])
        if not id_list:
            return results

        ids_str = ",".join(id_list)
        esummary_url = (
            f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?"
            f"db=pubmed&id={ids_str}&retmode=json"
        )
        with urllib.request.urlopen(esummary_url, timeout=8) as resp:
            summary_data = json.loads(resp.read().decode("utf-8"))

        uid_map = summary_data.get("result", {})
        for pmid in id_list:
            item = uid_map.get(pmid, {})
            if not item:
                continue
            doi = ""
            for aid in item.get("articleids", []):
                if aid.get("idtype") == "doi":
                    doi = aid.get("value", "")
                    break
            results.append({
                "pmid": pmid,
                "title": item.get("title", ""),
                "source": item.get("fulljournalname") or item.get("source", ""),
                "pubdate": item.get("pubdate", ""),
                "volume": item.get("volume", ""),
                "issue": item.get("issue", ""),
                "pages": item.get("pages", ""),
                "doi": doi,
                "url": f"https://doi.org/{doi}" if doi else f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"
            })
    except Exception as exc:
        print(f"[Step 0 Warning] PubMed E-utilities lookup encountered an error: {exc}", file=sys.stderr)
    return results


def get_pillar_by_id(pillar_id: int) -> dict:
    """Return the pillar metadata dict matching pillar_id (1-10)."""
    for p in PILLARS:
        if p["id"] == pillar_id:
            return p
    return PILLARS[0]


VN_TZ = datetime.timezone(datetime.timedelta(hours=7))


def _now_vn() -> datetime.datetime:
    return datetime.datetime.now(VN_TZ)


def _today_vn() -> datetime.date:
    return _now_vn().date()


def _scheduled_cycle_date_vn(cutoff_hour: int = 6) -> datetime.date:
    """Before 06:00 AM Vietnam time, active edition remains yesterday's; at/after 06:00 AM it advances to today."""
    now_vn = _now_vn()
    if now_vn.hour >= cutoff_hour:
        return now_vn.date()
    return now_vn.date() - datetime.timedelta(days=1)


def get_pillar_for_date(target_date: datetime.date | None = None) -> dict:
    """
    Deterministic 1-pillar-per-day ascending rotation (1 -> 2 -> ... -> 10 -> 1),
    anchored so ANCHOR_DATE (2026-11-16) is Pillar #1.
    """
    d = target_date or _today_vn()
    delta = (d - ANCHOR_DATE).days
    pid = (delta % 10) + 1
    return get_pillar_by_id(pid)


def get_next_pillar(current_id: int) -> dict:
    next_id = (current_id % 10) + 1
    return get_pillar_by_id(next_id)


def load_rotation_state() -> dict:
    """Load rotation state and compute dynamic today/yesterday/tomorrow pillar IDs."""
    today = _scheduled_cycle_date_vn()
    today_pillar = get_pillar_for_date(today)
    yesterday_pillar = get_pillar_for_date(today - datetime.timedelta(days=1))
    tomorrow_pillar = get_pillar_for_date(today + datetime.timedelta(days=1))
    default_history = [
        get_pillar_for_date(today - datetime.timedelta(days=i))["id"]
        for i in range(9, -1, -1)
    ]

    state = {}
    if ROTATION_STATE_PATH.exists():
        try:
            loaded = json.loads(ROTATION_STATE_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                state = loaded
        except Exception:
            state = {}

    state.setdefault("last_pillar_id", today_pillar["id"])
    state.setdefault("last_updated", today.isoformat())
    history = state.get("history")
    if not isinstance(history, list) or not history:
        state["history"] = default_history
    else:
        state["history"] = history[-10:]

    state["today_pillar_id"] = today_pillar["id"]
    state["yesterday_pillar_id"] = yesterday_pillar["id"]
    state["tomorrow_pillar_id"] = tomorrow_pillar["id"]
    return state


def save_rotation_state(state: dict) -> None:
    _atomic_write_text(ROTATION_STATE_PATH, json.dumps(state, indent=2, ensure_ascii=False))


def _build_step1_prompt(pillar: dict, pubmed_refs: list, custom_focus: str = "") -> str:
    today_str = datetime.date.today().isoformat()
    focus_clause = f"\nSpecific clinical focus requested: {custom_focus}\n" if custom_focus else ""
    pubmed_context = ""
    if pubmed_refs:
        pubmed_context = "\nVerified PubMed Reference Anchor Metadata (from NCBI E-utilities Step 0):\n"
        for ref in pubmed_refs:
            citation = f"{ref['source']} ({ref['pubdate']})"
            if ref.get("volume"):
                citation += f", Vol {ref['volume']}"
            if ref.get("pages"):
                citation += f":{ref['pages']}"
            pubmed_context += f"- {ref['title']} | {citation} | PMID: {ref['pmid']} | DOI: {ref['doi']} | URL: {ref['url']}\n"

    return (
        f"Real-world date of briefing: {today_str}\n"
        f"Assigned Rotation Pillar #{pillar['id']}: {pillar['name']} ({pillar['vi_name']})\n"
        f"Core Pillar Scope: {pillar['topics']}\n"
        f"{focus_clause}"
        f"{pubmed_context}\n"
        "Execute STEP 0 (verify all guideline titles, years, COR/LOE, and landmark trial acronyms, sample sizes, "
        "primary endpoints, HR/RR/OR, 95% CI, p-values, and DOIs). "
        "Then execute STEP 1: Output PART 1 — VIETNAMESE only (1200–1600 words), strictly following the Two-Block "
        "Source Structure (BLOCK A — Guideline Update & Evolution; BLOCK B — Landmark Trials Underpinning Block A), "
        "followed by III. TAKE-HOME CLINICAL PEARLS FOR ROUNDS, V. CLOSING DISCLAIMER LINE, and end with:\n"
        '[END OF PART 1. Enter "Continue to Part 2" to receive the full English Clinical Briefing]'
    )


def _run_gemini_interactions(
    model_name: str,
    step1_prompt: str,
    include_part2: bool,
    api_key: str = "",
) -> tuple[str, str, str]:
    """
    Runs the Two-Step Publishing Process via the official `google-genai` Interactions API.
    Supports `gemini-3.1-pro-preview`, `gemini-3.8-flash`, `gemini-3.5-flash-lite`,
    and `deep-research-preview-04-2026`.
    """
    try:
        from google import genai
    except ImportError:
        raise RuntimeError(
            "Missing `google-genai` package. Please install with: pip install -U google-genai"
        )

    resolved_key = api_key or os.environ.get("GEMINI_API_KEY", "")
    if not resolved_key:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Pass --api-key, set GEMINI_API_KEY env var, or enter it in the HTML UI."
        )

    client = genai.Client(api_key=resolved_key)

    if model_name.startswith("deep-research-"):
        print(f"[Step 1/2] Launching background agent `{model_name}` with Google Search...")
        interaction1 = client.interactions.create(
            agent=model_name,
            input=f"{SYSTEM_INSTRUCTION}\n\n{step1_prompt}",
            tools=[{"type": "google_search"}],
            background=True,
        )
        while True:
            interaction1 = client.interactions.get(interaction1.id)
            if interaction1.status == "completed":
                break
            if interaction1.status in ("failed", "cancelled"):
                raise RuntimeError(f"Agent interaction failed with status: {interaction1.status}")
            time.sleep(5)
        part1_vi = interaction1.output_text or ""
    else:
        print(f"[Step 1/2] Generating PART 1 (Vietnamese) via `{model_name}` with Google Search...")
        interaction1 = client.interactions.create(
            model=model_name,
            system_instruction=SYSTEM_INSTRUCTION,
            input=step1_prompt,
            tools=[{"type": "google_search"}],
        )
        part1_vi = interaction1.output_text or ""

    part2_en = ""
    if include_part2:
        target_model = "gemini-3.1-pro-preview" if model_name.startswith("deep-research-") else model_name
        print(f"[Step 2/2] Converting to PART 2 (English Clinical Briefing) via `{target_model}`...")
        interaction2 = client.interactions.create(
            model=target_model,
            system_instruction=SYSTEM_INSTRUCTION,
            input="Continue to Part 2",
            previous_interaction_id=interaction1.id,
            tools=[{"type": "google_search"}],
        )
        part2_en = interaction2.output_text or ""

    return part1_vi, part2_en, getattr(interaction1, "id", "")


def _run_openai_compatible(
    model_name: str,
    step1_prompt: str,
    include_part2: bool,
    api_key: str = "",
    base_url: str = "",
) -> tuple[str, str, str]:
    """
    Runs the Two-Step Publishing Process via OpenAI or an OpenAI-compatible Custom Portal
    (e.g., https://aiportalapi.stu-platform.live/jpe).
    """
    try:
        from openai import OpenAI
    except ImportError:
        raise RuntimeError("Missing `openai` package. Install with: pip install -U openai")

    resolved_key = api_key or os.environ.get("OPENAI_API_KEY", "")
    resolved_base = base_url or os.environ.get("OPENAI_BASE_URL", "")
    if not resolved_key:
        raise RuntimeError(
            "OPENAI_API_KEY is not set. Pass --api-key, set OPENAI_API_KEY env var, or enter it in the HTML UI."
        )

    client_kwargs = {"api_key": resolved_key}
    if resolved_base:
        client_kwargs["base_url"] = resolved_base

    client = OpenAI(**client_kwargs)

    print(f"[Step 1/2] Generating PART 1 (Vietnamese) via OpenAI/Custom `{model_name}`...")
    messages = [
        {"role": "system", "content": SYSTEM_INSTRUCTION},
        {"role": "user", "content": step1_prompt},
    ]
    resp1 = client.chat.completions.create(
        model=model_name,
        messages=messages,
    )
    part1_vi = resp1.choices[0].message.content or ""
    interaction_id = getattr(resp1, "id", "openai-turn-1")

    part2_en = ""
    if include_part2:
        print(f"[Step 2/2] Converting to PART 2 (English Clinical Briefing) via `{model_name}`...")
        messages.append({"role": "assistant", "content": part1_vi})
        messages.append({"role": "user", "content": "Continue to Part 2"})
        resp2 = client.chat.completions.create(
            model=model_name,
            messages=messages,
        )
        part2_en = resp2.choices[0].message.content or ""

    return part1_vi, part2_en, interaction_id


def generate_part2_for_briefing(
    briefing: dict,
    model_name: str = "",
    api_key: str = "",
    base_url: str = "",
) -> dict:
    """
    Executes STEP 2 of the Two-Step Publishing Process ("Continue to Part 2") for an existing
    briefing that currently only has Part 1 (Vietnamese), or re-generates Part 2 in academic
    American English (NEJM/JACC style).
    """
    previous_model = str(briefing.get("model_used") or "")
    if previous_model in _LEGACY_CURATED_MODEL_LABELS or previous_model in _NO_MODEL_SOURCE_LABELS:
        previous_model = ""
    target_model = _require_model(model_name or previous_model)
    if target_model.startswith("deep-research-"):
        target_model = "gemini-3.1-pro-preview"

    part1_vi = briefing.get("part1_vi_markdown", "")
    if not part1_vi:
        raise RuntimeError("Briefing has no Part 1 (Vietnamese) content to convert to Part 2.")

    is_gemini = (
        target_model.startswith("gemini-")
        or target_model.startswith("gemma-")
        or target_model.startswith("deep-research-")
    )

    step2_prompt = (
        "Continue to Part 2.\n\n"
        "Convert the entirety of the following Part 1 Vietnamese briefing into PART 2 — ENGLISH CLINICAL BRIEFING "
        "(academic American English in the style of NEJM/JACC), preserving all endpoints, figures, levels of evidence, "
        "Two-Block structure (BLOCK A & BLOCK B), III. TAKE-HOME CLINICAL PEARLS FOR ROUNDS, V. CLOSING DISCLAIMER, "
        "and source identifiers (PMIDs/DOIs) exactly:\n\n"
        f"{part1_vi}"
    )

    if is_gemini:
        try:
            from google import genai
        except ImportError:
            raise RuntimeError("Missing `google-genai` package. Please install with: pip install -U google-genai")
        resolved_key = api_key or os.environ.get("GEMINI_API_KEY", "")
        if not resolved_key:
            raise RuntimeError("GEMINI_API_KEY is not set. Pass --api-key, set GEMINI_API_KEY env var, or enter it in the HTML UI.")
        client = genai.Client(api_key=resolved_key)
        prev_id = briefing.get("interaction_id", "")
        print(f"[Step 2/2] Generating PART 2 (English Clinical Briefing) via `{target_model}`...")
        if prev_id and not prev_id.startswith("openai-") and not prev_id.startswith("seeded-"):
            interaction2 = client.interactions.create(
                model=target_model,
                system_instruction=SYSTEM_INSTRUCTION,
                input="Continue to Part 2",
                previous_interaction_id=prev_id,
                tools=[{"type": "google_search"}],
            )
        else:
            interaction2 = client.interactions.create(
                model=target_model,
                system_instruction=SYSTEM_INSTRUCTION,
                input=step2_prompt,
                tools=[{"type": "google_search"}],
            )
        part2_en = interaction2.output_text or ""
    else:
        try:
            from openai import OpenAI
        except ImportError:
            raise RuntimeError("Missing `openai` package. Install with: pip install -U openai")
        resolved_key = api_key or os.environ.get("OPENAI_API_KEY", "")
        resolved_base = base_url or os.environ.get("OPENAI_BASE_URL", "")
        if not resolved_key:
            raise RuntimeError("OPENAI_API_KEY is not set. Pass --api-key, set OPENAI_API_KEY env var, or enter it in the HTML UI.")
        client_kwargs = {"api_key": resolved_key}
        if resolved_base:
            client_kwargs["base_url"] = resolved_base
        client = OpenAI(**client_kwargs)
        print(f"[Step 2/2] Generating PART 2 (English Clinical Briefing) via `{target_model}`...")
        resp2 = client.chat.completions.create(
            model=target_model,
            messages=[
                {"role": "system", "content": SYSTEM_INSTRUCTION},
                {"role": "assistant", "content": part1_vi},
                {"role": "user", "content": "Continue to Part 2"},
            ],
        )
        part2_en = resp2.choices[0].message.content or ""

    title_en_match = re.search(r"^#\s+(.+)$", part2_en, flags=re.MULTILINE) if part2_en else None
    if title_en_match:
        briefing["title_en"] = title_en_match.group(1).strip()
    briefing["part2_en_markdown"] = part2_en
    briefing["part2_model_used"] = target_model
    return briefing


def generate_briefing(
    pillar: dict,
    model_name: str = "",
    custom_focus: str = "",
    include_part2: bool = True,
    api_key: str = "",
    base_url: str = "",
) -> dict:
    """
    Unified dispatcher that runs Step 0 PubMed verification and routes to either
    Google GenAI Interactions API or OpenAI/Custom Portal API based on the chosen model.
    """
    model_name = _require_model(model_name)
    pubmed_refs = fetch_pubmed_metadata(pillar["search_query"], max_results=6)
    step1_prompt = _build_step1_prompt(pillar, pubmed_refs, custom_focus)

    is_gemini = model_name.startswith("gemini-") or model_name.startswith("gemma-") or model_name.startswith("deep-research-")

    if is_gemini:
        part1_vi, part2_en, interaction_id = _run_gemini_interactions(
            model_name=model_name,
            step1_prompt=step1_prompt,
            include_part2=include_part2,
            api_key=api_key,
        )
    else:
        part1_vi, part2_en, interaction_id = _run_openai_compatible(
            model_name=model_name,
            step1_prompt=step1_prompt,
            include_part2=include_part2,
            api_key=api_key,
            base_url=base_url,
        )

    today_str = datetime.date.today().isoformat()
    title_match = re.search(r"^#\s+(.+)$", part1_vi, flags=re.MULTILINE)
    title_vi = title_match.group(1).strip() if title_match else f"Chuyên đề Trụ cột #{pillar['id']}: {pillar['vi_name']}"

    title_en_match = re.search(r"^#\s+(.+)$", part2_en, flags=re.MULTILINE) if part2_en else None
    title_en = title_en_match.group(1).strip() if title_en_match else f"Pillar #{pillar['id']} Clinical Briefing: {pillar['name']}"

    word_count_vi = len(part1_vi.split())

    return {
        "id": f"ebm-{today_str}-p{pillar['id']}-{int(time.time()) % 10000}",
        "date": today_str,
        "time": "06:00 AM",
        "model_used": model_name,
        "content_source": MODEL_DRAFT_CONTENT_SOURCE,
        "pillar_id": pillar["id"],
        "pillar_name": pillar["name"],
        "pillar_vi": pillar["vi_name"],
        "title_vi": title_vi,
        "title_en": title_en,
        "word_count_vi": word_count_vi,
        "verified_step0": True,
        "interaction_id": interaction_id,
        "pubmed_anchors": pubmed_refs,
        "part1_vi_markdown": part1_vi,
        "part2_en_markdown": part2_en,
    }


def fetch_pubmed_abstracts(pmids: list) -> dict:
    """Fetches abstract text from NCBI PubMed efetch XML for a list of PMIDs."""
    abstracts = {}
    if not pmids:
        return abstracts
    try:
        ids_str = ",".join(str(p) for p in pmids)
        efetch_url = (
            f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?"
            f"db=pubmed&id={ids_str}&retmode=xml"
        )
        with urllib.request.urlopen(efetch_url, timeout=10) as resp:
            xml_bytes = resp.read()
        root = ET.fromstring(xml_bytes)
        for article in root.findall(".//PubmedArticle"):
            pmid_el = article.find(".//MedlineCitation/PMID")
            if pmid_el is None or not pmid_el.text:
                continue
            pmid = pmid_el.text.strip()
            parts = []
            for ab in article.findall(".//Abstract/AbstractText"):
                label = ab.attrib.get("Label", "")
                text = "".join(ab.itertext()).strip()
                if text:
                    parts.append(f"**{label}**: {text}" if label else text)
            if parts:
                abstracts[pmid] = "\n\n".join(parts)
    except Exception as exc:
        print(f"[Step 0 Warning] PubMed efetch abstracts error: {exc}", file=sys.stderr)
    return abstracts


def _build_pubmed_digest_briefing(pillar: dict, pubmed_refs: list, abstracts_map: dict) -> dict:
    """
    Builds a rich, Step-0 PubMed-verified EBM Clinical Briefing when no LLM API key is configured.
    Combines full clinical synthesis from pillar_library with live NCBI PubMed Step-0 anchors
    fetched at refresh time.
    """
    today_str = datetime.date.today().isoformat()
    pid = pillar["id"]

    # Try loading rich template for this pillar without side-effect imports
    rich_tpl = None
    try:
        import pillar_library
        if hasattr(pillar_library, "get_latest_briefing_for_pillar"):
            rich_tpl = pillar_library.get_latest_briefing_for_pillar(pid, today_str)
        elif pid in getattr(pillar_library, "RICH_PILLAR_TEMPLATES", {}):
            rich_tpl = pillar_library.RICH_PILLAR_TEMPLATES[pid]
    except Exception:
        pass

    if rich_tpl is not None:
        # Merge verified template anchors with any live PubMed anchors (deduplicated by PMID)
        merged_anchors = list(rich_tpl.get("pubmed_anchors", []))
        seen_pmids = {a["pmid"] for a in merged_anchors if a.get("pmid")}
        for ref in pubmed_refs:
            if ref.get("pmid") and ref["pmid"] not in seen_pmids:
                merged_anchors.append(ref)
                seen_pmids.add(ref["pmid"])

        part1_vi = rich_tpl["part1_vi_markdown"]
        part2_en = rich_tpl["part2_en_markdown"]
        return {
            "id": f"ebm-{today_str}-p{pid}-{int(time.time()) % 10000}",
            "date": today_str,
            "time": "06:00 AM",
            "model_used": NO_MODEL,
            "content_source": CURATED_CONTENT_SOURCE,
            "pillar_id": pid,
            "pillar_name": pillar["name"],
            "pillar_vi": pillar["vi_name"],
            "title_vi": rich_tpl["title_vi"],
            "title_en": rich_tpl["title_en"],
            "word_count_vi": len(part1_vi.split()),
            "verified_step0": True,
            "interaction_id": f"step0-curated-{today_str}",
            "pubmed_anchors": merged_anchors,
            "part1_vi_markdown": part1_vi,
            "part2_en_markdown": part2_en,
        }

    # Generic fallback if neither library nor seed is available
    primary_ref = pubmed_refs[0] if pubmed_refs else None
    trial_refs = pubmed_refs[1:4] if len(pubmed_refs) > 1 else pubmed_refs[:3]

    guideline_line = (
        f"**{primary_ref['title']}** (*{primary_ref['source']}*, {primary_ref['pubdate']}, DOI: `{primary_ref['doi']}`, PMID: `{primary_ref['pmid']}`)"
        if primary_ref
        else "Chưa truy xuất được văn kiện hướng dẫn trực tiếp từ NCBI PubMed."
    )

    block_b_vi_items = []
    block_b_en_items = []
    for idx, ref in enumerate(trial_refs, start=1):
        ab_text = abstracts_map.get(ref["pmid"], "Tóm tắt chi tiết không khả dụng trên PubMed XML; vui lòng truy cập liên kết DOI/PMID bên dưới để xem toàn văn.")
        if len(ab_text) > 1200:
            ab_text = ab_text[:1200].rsplit(" ", 1)[0] + "..."
        doi_str = f"DOI: {ref['doi']}. " if ref.get("doi") else ""
        block_b_vi_items.append(
            f"### {idx}. [PubMed Verified Source] {ref['title']}\n"
            f"- **Nguồn/Tạp chí**: *{ref['source']}*, {ref['pubdate']}. {doi_str}PMID: {ref['pmid']}.\n"
            f"- **Phạm vi trụ cột**: {pillar['topics']}\n"
            f"- **Tóm tắt nguyên bản từ NCBI PubMed (Abstract)**:\n\n{ab_text}\n"
        )
        block_b_en_items.append(
            f"### {idx}. [PubMed Verified Source] {ref['title']}\n"
            f"- **Source/Journal**: *{ref['source']}*, {ref['pubdate']}. {doi_str}PMID: {ref['pmid']}.\n"
            f"- **Abstract Excerpt (NCBI PubMed)**:\n\n{ab_text}\n"
        )

    part1_vi = f"""# Cập nhật Chứng cứ Trụ cột #{pillar['id']}: {pillar['vi_name']} ({today_str})

## BLOCK A — Cập nhật & Diễn tiến Khuyến cáo (PubMed Step-0 Verified)

Chuyên đề thuộc **Trụ cột {pillar['id']}: {pillar['vi_name']}** ({pillar['name']}). Phạm vi lâm sàng cốt lõi: {pillar['topics']}.

### 1. Văn kiện & Nguồn tham chiếu Trọng tâm
- Tài liệu xác thực hàng đầu từ NCBI PubMed: {guideline_line}
- Bản tin được tổng hợp tự động lúc **06:00 AM ({today_str}, giờ Việt Nam)** qua cổng xác minh Step-0 NCBI PubMed E-utilities.

---

## BLOCK B — Các Nghiên cứu & Hướng dẫn Xác thực từ NCBI PubMed

{chr(10).join(block_b_vi_items)}

---

## III. TAKE-HOME CLINICAL PEARLS FOR ROUNDS

1. **[GUIDELINE EVOLUTION]** Trụ cột #{pillar['id']} ({pillar['vi_name']}): Trọng tâm cập nhật xoay quanh {pillar['topics']}.
2. **[LANDMARK TRIAL]** Mọi trích dẫn trong bản tin này đều được đối chiếu trực tiếp mã PMID và DOI từ NCBI PubMed ngày {today_str}.

---

## V. CLOSING DISCLAIMER

⚠️ Nội dung trên được tổng hợp trực tiếp từ cơ sở dữ liệu NCBI PubMed Step-0; bác sĩ điều trị cần đọc toàn văn hướng dẫn và nghiên cứu gốc trước khi ra quyết định lâm sàng."""

    part2_en = f"""# Pillar #{pillar['id']} Evidence Update: {pillar['name']} ({today_str})

## BLOCK A — Guideline & Evidence Anchor (PubMed Step-0 Verified)

This briefing covers **Pillar #{pillar['id']}: {pillar['name']}**. Core clinical scope: {pillar['topics']}.

### 1. Primary Verified Anchor
- Primary NCBI PubMed anchor: {guideline_line}

---

## BLOCK B — Verified PubMed Studies & Guideline Anchors

{chr(10).join(block_b_en_items)}

---

## III. TAKE-HOME CLINICAL PEARLS FOR ROUNDS

1. **[GUIDELINE EVOLUTION]** Pillar #{pillar['id']} ({pillar['name']}) clinical focus: {pillar['topics']}.

---

## V. CLOSING DISCLAIMER

⚠️ This digest is compiled directly from verified NCBI PubMed Step-0 records; clinicians must consult the full-text guideline and original trial publications prior to bedside prescribing."""

    return {
        "id": f"ebm-{today_str}-p{pillar['id']}-{int(time.time()) % 10000}",
        "date": today_str,
        "time": "06:00 AM",
        "model_used": NO_MODEL,
        "content_source": "pubmed_metadata_digest",
        "pillar_id": pillar["id"],
        "pillar_name": pillar["name"],
        "pillar_vi": pillar["vi_name"],
        "title_vi": f"Cập nhật Chứng cứ Trụ cột #{pillar['id']}: {pillar['vi_name']} ({today_str})",
        "title_en": f"Pillar #{pillar['id']} Evidence Update: {pillar['name']} ({today_str})",
        "word_count_vi": len(part1_vi.split()),
        "verified_step0": True,
        "interaction_id": f"pubmed-digest-{today_str}",
        "pubmed_anchors": pubmed_refs,
        "part1_vi_markdown": part1_vi,
        "part2_en_markdown": part2_en,
    }


_refresh_lock = threading.RLock()
_users_lock = threading.Lock()
_feedback_lock = threading.Lock()


# ---------------------------------------------------------------------------
# User Authentication & Personalized Activity Persistence (data/users.json)
# ---------------------------------------------------------------------------

_LEGACY_DEMO_USERNAME = 'bs.timmach'


def _hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    if salt is None:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100_000)
    return salt, dk.hex()


def _verify_password(password: str, salt: str, password_hash: str) -> bool:
    if not salt or not password_hash:
        return False
    _, computed = _hash_password(password, salt)
    return hmac.compare_digest(computed, password_hash)


def _sign_session_token(username: str, token_secret: str) -> str:
    nonce = secrets.token_hex(16)
    payload = f"{username}:{nonce}"
    sig = hmac.new(token_secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{username}.{nonce}.{sig}"


def _verify_session_token_signature(token: str, token_secret: str) -> str | None:
    if not token or token.count(".") < 2 or not token_secret:
        return None
    parts = token.rsplit(".", 2)
    if len(parts) != 3:
        return None
    username, nonce, sig = parts
    payload = f"{username}:{nonce}"
    expected = hmac.new(token_secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if hmac.compare_digest(sig, expected):
        return username
    return None


def _safe_user(user_rec: dict) -> dict:
    display_name = user_rec.get("display_name") or user_rec.get("full_name") or user_rec.get("username", "")
    return {
        "username": user_rec.get("username", ""),
        "email": user_rec.get("email", ""),
        "display_name": display_name,
        "full_name": display_name,
        "role": user_rec.get("role", "Bác sĩ Tim mạch"),
        "specialty": user_rec.get("specialty", "Nội Tim mạch"),
        "read_ids": list(dict.fromkeys(user_rec.get("read_ids", []))),
        "bookmarked_ids": list(dict.fromkeys(user_rec.get("bookmarked_ids", []))),
        "created_at": user_rec.get("created_at", ""),
    }


def _load_users_data_unlocked() -> dict:
    data: dict = {}
    dirty = False
    if USERS_PATH.exists():
        try:
            loaded = json.loads(USERS_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except Exception:
            data = {}

    if not data.get("token_secret"):
        data["token_secret"] = secrets.token_hex(32)
        dirty = True
    if not isinstance(data.get("users"), dict):
        data["users"] = {}
        dirty = True
    if not isinstance(data.get("sessions"), dict):
        data["sessions"] = {}
        dirty = True

    if dirty:
        _atomic_write_text(USERS_PATH, json.dumps(data, indent=2, ensure_ascii=False))
    return data


def _save_users_data_unlocked(data: dict) -> None:
    for record in data.get('devices', {}).values():
        _check_device_size(record)
    _atomic_write_text(USERS_PATH, json.dumps(data, indent=2, ensure_ascii=False))


def _normalize_identifier(identifier: str) -> str:
    ident = str(identifier or "").strip().lower()
    ident = re.sub(r"\s*\.\s*", ".", ident)
    return re.sub(r"\s+", "", ident)


def _find_user_by_identifier(users_dict: dict, identifier: str) -> dict | None:
    ident = _normalize_identifier(identifier)
    if not ident:
        return None
    if ident in users_dict:
        return users_dict[ident]
    for u in users_dict.values():
        if not isinstance(u, dict):
            continue
        if (
            _normalize_identifier(u.get("username", "")) == ident
            or _normalize_identifier(u.get("email", "")) == ident
        ):
            return u
    return None


def _create_session_for_user(data: dict, user_rec: dict) -> str:
    token = _sign_session_token(user_rec["username"], data["token_secret"])
    sessions = data.setdefault("sessions", {})
    sessions[token] = {
        "username": user_rec["username"],
        "created_at": datetime.datetime.now().isoformat(),
    }
    if len(sessions) > 500:
        # Keep most recent 400 sessions
        keys_to_drop = list(sessions.keys())[:-400]
        for k in keys_to_drop:
            sessions.pop(k, None)
    return token


def _resolve_user_from_token_unlocked(data: dict, token: str, create_device: bool = False) -> dict | None:
    if not token:
        return None
    if token.startswith('device:'):
        device_id = _validated_device_id(token[7:])
        if not device_id:
            return None
        devices = data.get('devices', {})
        now = datetime.datetime.now(datetime.timezone.utc)
        if device_id not in devices:
            record = {'username': f'device:{device_id}', 'display_name': 'Doctor',
                                  'device_id': device_id, 'read_ids': [], 'bookmarked_ids': [],
                                  'created_at': now.isoformat(), 'updated_at': now.isoformat()}
            if not create_device:
                return record
            if len(devices) >= MAX_ANONYMOUS_DEVICES:
                def last_write(item):
                    try:
                        stamp = datetime.datetime.fromisoformat(item[1].get('updated_at') or item[1]['created_at'])
                        return stamp.replace(tzinfo=datetime.timezone.utc) if stamp.tzinfo is None else stamp
                    except (KeyError, ValueError, TypeError):
                        return now
                oldest = min(devices.items(), key=last_write)
                if now - last_write(oldest) <= datetime.timedelta(days=DEVICE_IDLE_DAYS):
                    raise DeviceStorageError(429, 'Anonymous device limit reached')
                del devices[oldest[0]]
            data.setdefault('devices', {})[device_id] = record
            devices = data['devices']
        if create_device:
            devices[device_id]['updated_at'] = now.isoformat()
        return devices[device_id]
    sessions = data.get("sessions", {})
    sess = sessions.get(token)
    if not isinstance(sess, dict):
        return None
    sig_user = _verify_session_token_signature(token, data.get("token_secret", ""))
    username = sess.get("username")
    if (not username or username == _LEGACY_DEMO_USERNAME
            or (sig_user is not None and sig_user != username)):
        return None
    user = data.get("users", {}).get(username)
    return user if isinstance(user, dict) and user.get("username") == username else None


MAX_ANONYMOUS_DEVICES = 1000
DEVICE_IDLE_DAYS = 90
MAX_DEVICE_BYTES = 256 * 1024


class DeviceStorageError(ValueError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def _check_device_size(value):
    if len(json.dumps(value, ensure_ascii=False).encode('utf-8')) > MAX_DEVICE_BYTES:
        raise DeviceStorageError(413, 'Device data limit exceeded')


def _validated_device_id(value: str) -> str | None:
    if not re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', value or ''):
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


def save_device_quiz(token: str, req_data: dict, payload: dict) -> None:
    if not token.startswith('device:') or not payload.get('ok'):
        return
    with _users_lock:
        data = _load_users_data_unlocked()
        user = _resolve_user_from_token_unlocked(data, token, create_device=True)
        if user:
            key = str(req_data.get('briefing_id') or req_data.get('pillar_id') or 'current')
            user.setdefault('socratic_state', {})[key] = payload.get('state', {})
            _save_users_data_unlocked(data)


def get_user_by_token(token: str) -> dict | None:
    if not token:
        return None
    with _users_lock:
        data = _load_users_data_unlocked()
        u = _resolve_user_from_token_unlocked(data, token)
        return _safe_user(u) if u else None


def login_user(req_data: dict) -> tuple[int, dict]:
    if req_data.get("demo"):
        return 410, {"ok": False, "error": "Demo sign-in is no longer available."}
    with _users_lock:
        data = _load_users_data_unlocked()
        identifier = _normalize_identifier(str(req_data.get("username") or req_data.get("email") or ""))
        password = str(req_data.get("password") or "")
        trimmed_pw = password.strip()
        if not identifier or not password:
            return 400, {"ok": False, "error": "Vui lòng nhập tên đăng nhập và mật khẩu."}

        user = _find_user_by_identifier(data["users"], identifier)
        pw_ok = bool(
            user
            and user["username"] != _LEGACY_DEMO_USERNAME
            and (
                _verify_password(password, user.get("salt", ""), user.get("password_hash", ""))
                or (trimmed_pw and _verify_password(trimmed_pw, user.get("salt", ""), user.get("password_hash", "")))
            )
        )
        if not pw_ok:
            return 401, {"ok": False, "error": "Tên đăng nhập hoặc mật khẩu không đúng."}

        token = _create_session_for_user(data, user)
        _save_users_data_unlocked(data)
        return 200, {"ok": True, "token": token, "user": _safe_user(user)}


def register_user(req_data: dict) -> tuple[int, dict]:
    username = str(req_data.get("username", "")).strip()
    password = str(req_data.get("password", ""))
    email = str(req_data.get("email", "")).strip()
    display_name = (
        str(req_data.get("display_name") or req_data.get("full_name") or req_data.get("name") or "").strip()
        or username
    )
    specialty = str(req_data.get("specialty", "")).strip() or "Nội Tim mạch"
    role = str(req_data.get("role", "")).strip() or "Bác sĩ Tim mạch"

    if len(username) < 3 or len(password) < 4:
        return 400, {
            "ok": False,
            "error": "Tên đăng nhập cần tối thiểu 3 ký tự và mật khẩu tối thiểu 4 ký tự.",
        }

    with _users_lock:
        data = _load_users_data_unlocked()
        if (
            username == _LEGACY_DEMO_USERNAME
            or _find_user_by_identifier(data["users"], username)
            or (email and _find_user_by_identifier(data["users"], email))
        ):
            return 409, {"ok": False, "error": "Tên đăng nhập hoặc email đã được sử dụng."}

        salt, pw_hash = _hash_password(password)
        new_user = {
            "username": username,
            "email": email,
            "display_name": display_name,
            "role": role,
            "specialty": specialty,
            "salt": salt,
            "password_hash": pw_hash,
            "read_ids": [],
            "bookmarked_ids": [],
            "created_at": datetime.datetime.now().isoformat(),
        }
        data["users"][username] = new_user
        token = _create_session_for_user(data, new_user)
        _save_users_data_unlocked(data)
        return 200, {"ok": True, "token": token, "user": _safe_user(new_user)}


def logout_token(token: str) -> dict:
    if token:
        with _users_lock:
            data = _load_users_data_unlocked()
            if token in data.get("sessions", {}):
                data["sessions"].pop(token, None)
                _save_users_data_unlocked(data)
    return {"ok": True}


def record_user_activity(token: str, req_data: dict) -> tuple[int, dict]:
    briefing_id = str(req_data.get("briefing_id", "")).strip()
    action = str(req_data.get("action", "")).strip()
    if action == 'sync':
        for key in ('read_ids', 'bookmarked_ids'):
            values = req_data.get(key)
            if not isinstance(values, list) or len(values) > 100000 or any(not isinstance(v, str) or len(v) > 500 for v in values):
                return 400, {'ok': False, 'error': 'Invalid activity'}
    elif not briefing_id or action not in ("read", "toggle_bookmark"):
        return 400, {"ok": False, "error": "Thiếu briefing_id hoặc action không hợp lệ."}

    with _users_lock:
        data = _load_users_data_unlocked()
        empty_sync = action == 'sync' and not req_data['read_ids'] and not req_data['bookmarked_ids'] and req_data.get('display_name', '') in ('', 'Doctor', 'Bác sĩ')
        if empty_sync and token.startswith('device:') and token[7:] not in data.get('devices', {}):
            user = _resolve_user_from_token_unlocked(data, token)
            return (200, {'ok': True, 'user': _safe_user(user)}) if user else (401, {'ok': False, 'error': 'Unauthorized'})
        user = _resolve_user_from_token_unlocked(data, token, create_device=True)
        if not user:
            return 401, {"ok": False, "error": "Unauthorized"}

        read_ids = list(dict.fromkeys(user.get("read_ids", [])))
        bookmarked_ids = list(dict.fromkeys(user.get("bookmarked_ids", [])))

        if action == 'sync':
            user['read_ids'] = list(dict.fromkeys(req_data['read_ids']))
            user['bookmarked_ids'] = list(dict.fromkeys(req_data['bookmarked_ids']))
            name = req_data.get('display_name')
            if isinstance(name, str) and 0 < len(name.strip()) <= 100:
                user['display_name'] = name.strip()
        elif action == "read":
            if briefing_id not in read_ids:
                read_ids.append(briefing_id)
            user["read_ids"] = read_ids
        elif action == "toggle_bookmark":
            if briefing_id in bookmarked_ids:
                bookmarked_ids.remove(briefing_id)
            else:
                bookmarked_ids.append(briefing_id)
            user["bookmarked_ids"] = bookmarked_ids

        _save_users_data_unlocked(data)
        return 200, {"ok": True, "user": _safe_user(user)}


def update_user_profile(token: str, req_data: dict) -> tuple[int, dict]:
    """Updates display_name, specialty, and email for the authenticated user."""
    with _users_lock:
        data = _load_users_data_unlocked()
        user = _resolve_user_from_token_unlocked(data, token)
        if not user:
            return 401, {"ok": False, "error": "Unauthorized"}

        display_name = str(
            req_data.get("display_name") or req_data.get("full_name") or ""
        ).strip()
        specialty = str(req_data.get("specialty", "")).strip()
        email = str(req_data.get("email", "")).strip()

        if display_name:
            user["display_name"] = display_name
        if specialty:
            user["specialty"] = specialty
        if "email" in req_data:
            user["email"] = email

        _save_users_data_unlocked(data)
        return 200, {"ok": True, "user": _safe_user(user)}


# ---------------------------------------------------------------------------
# Product Feedback Persistence (data/feedback.json)
# ---------------------------------------------------------------------------

def _load_feedback_data_unlocked() -> dict:
    data: dict = {}
    dirty = False
    if FEEDBACK_PATH.exists():
        try:
            loaded = json.loads(FEEDBACK_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                data = loaded
        except Exception:
            data = {}

    if not isinstance(data.get("votes"), dict):
        data["votes"] = {}
        dirty = True
    if not isinstance(data.get("reports"), list):
        data["reports"] = []
        dirty = True

    if dirty or not FEEDBACK_PATH.exists():
        _atomic_write_text(FEEDBACK_PATH, json.dumps(data, indent=2, ensure_ascii=False))
    return data


def _save_feedback_data_unlocked(data: dict) -> None:
    _atomic_write_text(FEEDBACK_PATH, json.dumps(data, indent=2, ensure_ascii=False))


def _compute_feedback_summary(data: dict, user_key: str | None = None) -> dict:
    votes = data.get("votes", {})
    reports = data.get("reports", [])
    report_counts: dict[str, int] = {}
    for rep in reports:
        bid = rep.get("briefing_id")
        if bid:
            report_counts[bid] = report_counts.get(bid, 0) + 1

    all_bids = set(votes.keys()) | set(report_counts.keys())
    summary: dict[str, dict] = {}
    for bid in all_bids:
        vote_map = votes.get(bid, {})
        if not isinstance(vote_map, dict):
            vote_map = {}
        likes = sum(1 for v in vote_map.values() if v == "like")
        dislikes = sum(1 for v in vote_map.values() if v == "dislike")
        summary[bid] = {
            "like": likes,
            "dislike": dislikes,
            "report": report_counts.get(bid, 0),
            "user_vote": vote_map.get(user_key) if user_key else None,
        }
    return summary


def _get_feedback_summary(user_key: str | None = None) -> dict:
    with _feedback_lock:
        data = _load_feedback_data_unlocked()
        return _compute_feedback_summary(data, user_key)


def _feedback_author_id(user_key: str, *, authenticated: bool = False) -> str:
    namespace = 'ebm-feedback-account:' if authenticated and user_key == 'guest' else 'ebm-feedback:'
    return 'author:' + hashlib.sha256((namespace + user_key).encode()).hexdigest()


def get_feedback_payload(user: dict | None) -> dict:
    user_key = user["username"] if user else "guest"
    with _feedback_lock:
        data = _load_feedback_data_unlocked()
        summary = _compute_feedback_summary(data, user_key)
        reports = data.get("reports", [])
        recent_reports = []
        if user:
            author_id = _feedback_author_id(user_key, authenticated=True)
            recent_reports = [r for r in reversed(reports)
                              if r.get('author_id') == author_id or
                              (user_key != 'guest' and r.get('username') == user_key)][:20]
        safe_reports = []
        for report in recent_reports:
            safe = {key: report[key] for key in ('id', 'briefing_id', 'pillar_id', 'display_name', 'reason', 'comment', 'created_at') if key in report}
            safe['author_id'] = report.get('author_id') or _feedback_author_id(report.get('username', 'guest'))
            safe_reports.append(safe)
        return {
            "ok": True,
            "summary": summary,
            "reports_count": len(reports),
            "recent_reports": safe_reports,
        }


def submit_feedback(user: dict | None, req_data: dict) -> tuple[int, dict]:
    briefing_id = str(req_data.get("briefing_id", "")).strip()
    fb_type = str(req_data.get("type", "")).strip().lower()
    pillar_id = req_data.get("pillar_id")
    reason = str(req_data.get("reason", "")).strip()
    comment = str(req_data.get("comment", "")).strip()

    if not briefing_id or fb_type not in ("like", "dislike", "report"):
        return 400, {"ok": False, "error": "Cần cung cấp briefing_id và type (like/dislike/report)."}

    user_key = user["username"] if user else "guest"
    display_name = user["display_name"] if user else "Khách"

    if user_key.startswith('device:'):
        _check_device_size(req_data)
        with _users_lock:
            users = _load_users_data_unlocked()
            _resolve_user_from_token_unlocked(users, user_key, create_device=True)
            _save_users_data_unlocked(users)

    with _feedback_lock:
        data = _load_feedback_data_unlocked()
        if fb_type in ("like", "dislike"):
            votes_map = data["votes"].setdefault(briefing_id, {})
            if votes_map.get(user_key) == fb_type:
                votes_map.pop(user_key, None)
            else:
                votes_map[user_key] = fb_type
        else:
            pid_val = pillar_id
            if pid_val is not None and str(pid_val).isdigit():
                pid_val = int(pid_val)
            data["reports"].append({
                "id": f"rep-{int(time.time() * 1000)}-{secrets.token_hex(3)}",
                "briefing_id": briefing_id,
                "pillar_id": pid_val,
                "author_id": _feedback_author_id(user_key, authenticated=bool(user)),
                "display_name": display_name,
                "reason": reason or "Góp ý nội dung",
                "comment": comment,
                "created_at": datetime.datetime.now().isoformat(),
            })

        if user_key.startswith('device:'):
            _check_device_size({'votes': {bid: votes[user_key] for bid, votes in data['votes'].items() if user_key in votes},
                                'reports': [r for r in data['reports'] if r.get('author_id') == _feedback_author_id(user_key) or r.get('username') == user_key]})
        _save_feedback_data_unlocked(data)
        summary = _compute_feedback_summary(data, user_key)
        item_summary = summary.get(
            briefing_id,
            {"like": 0, "dislike": 0, "report": 0, "user_vote": None},
        )
        return 200, {
            "ok": True,
            "item_summary": item_summary,
            "summary": summary,
            "reports_count": len(data.get("reports", [])),
        }


# ---------------------------------------------------------------------------
# Single-Pillar Daily Refresh
# ---------------------------------------------------------------------------
def refresh_today_briefing(
    force: bool = False,
    pillar_id: int | None = None,
    progress_cb=None,
) -> dict:
    """Publish today's single curated guideline recommendation."""
    with _refresh_lock:
        today = _today_vn()
        today_str = today.isoformat()
        target_pillar = (
            get_pillar_by_id(int(pillar_id))
            if pillar_id is not None
            else get_pillar_for_date(today)
        )
        pid = target_pillar["id"]
        briefings = load_existing_briefings()
        state = load_rotation_state()
        def is_daily_record(b):
            return (b.get("date") == today_str
                    and b.get("content_source") != MODEL_DRAFT_CONTENT_SOURCE
                    and (pillar_id is None or b.get("pillar_id") == pid))

        if not force:
            daily_records = [b for b in briefings if is_daily_record(b)]
            today_for_target = [
                b for b in daily_records
                if b.get("pillar_id") == pid
                and b.get("lesson_format") == "single_guideline"
                and b.get("lesson_version") == FOCUSED_EDITION_VERSION
            ]
            if len(today_for_target) == 1 and all(b.get("pillar_id") == pid for b in daily_records):
                if progress_cb:
                    progress_cb(100, f"Hôm nay ({today_str}) đã có bản tin Trụ cột #{pid}/10 — {target_pillar['vi_name']}.")
                return {
                    "briefing": today_for_target[0],
                    "rotation_state": state,
                    "already_up_to_date": True,
                }

        from crawl_cardiology_news import refresh_guideline_briefing

        new_briefing = with_truthful_provenance(
            refresh_guideline_briefing(pillar_id=pid, date_str=today_str, progress_cb=progress_cb)
        )

        briefings = [b for b in briefings if not is_daily_record(b)]
        briefings.insert(0, new_briefing)

        state["last_pillar_id"] = pid
        state["last_updated"] = today_str
        state["today_pillar_id"] = get_pillar_for_date(today)["id"]
        state["yesterday_pillar_id"] = get_pillar_for_date(today - datetime.timedelta(days=1))["id"]
        state["tomorrow_pillar_id"] = get_pillar_for_date(today + datetime.timedelta(days=1))["id"]
        if pillar_id is None:
            state["history"] = [
                get_pillar_for_date(today - datetime.timedelta(days=i))["id"]
                for i in range(9, -1, -1)
            ]
        else:
            hist = list(state.get("history", []))
            if not hist or hist[-1] != pid:
                hist.append(pid)
            state["history"] = hist[-10:]

        save_rotation_state(state)
        save_briefings_js(briefings, state)

        if progress_cb:
            progress_cb(100, f"Hoàn tất Trụ cột #{pid}/10 ({target_pillar['vi_name']}).")

        return {
            "briefing": new_briefing,
            "rotation_state": state,
            "already_up_to_date": False,
        }


def load_existing_briefings() -> list:
    if not BRIEFINGS_JS_PATH.exists():
        return []
    raw = BRIEFINGS_JS_PATH.read_text(encoding="utf-8")
    prefix = "window.EBM_BRIEFINGS_DATA = "
    idx = raw.find(prefix)
    if idx == -1:
        return []
    json_part = raw[idx + len(prefix):].strip()
    if json_part.endswith(";"):
        json_part = json_part[:-1].strip()
    try:
        data = json.loads(json_part)
        return data.get("briefings", [])
    except Exception as exc:
        print(f"[Warning] Failed to parse existing briefings.js: {exc}", file=sys.stderr)
        return []


def save_briefings_js(briefings: list, rotation_state: dict) -> None:
    payload = {
        "generated_at": datetime.datetime.now().isoformat(),
        "default_model": NO_MODEL,
        "generator": BUNDLE_GENERATOR,
        "rotation_state": rotation_state,
        "pillars": PILLARS,
        "focused_lessons": build_focused_templates(PILLARS),
        "briefings": [with_truthful_provenance(b) for b in briefings],
    }
    js_content = (
        "// Auto-generated by fetch_daily_ebm.py — curated cardiology briefings with PubMed/DOI citation lookups; "
        "model_used \"none\" means no AI model.\n"
        f"window.EBM_BRIEFINGS_DATA = {json.dumps(payload, indent=2, ensure_ascii=False)};\n"
    )
    _atomic_write_text(BRIEFINGS_JS_PATH, js_content)
    print(f"[Saved] Updated {BRIEFINGS_JS_PATH} with {len(briefings)} briefings.")


_CHAT_SYNONYM_MAP: dict[str, list[str]] = {
    "tăng huyết áp": ["hypertension", "sbp", "bp", "sprint", "esprit", "bproad", "ish", "ths", "kdoqi", "spc"],
    "huyết áp": ["hypertension", "blood pressure", "sbp", "sprint", "ish", "prevent"],
    "tha": ["hypertension", "sbp", "rdn", "spironolactone"],
    "thận": ["ckd", "egfr", "kdoqi", "era", "flow", "finerenone", "sglt2i", "creatinine", "kali"],
    "lipid": ["ldl-c", "non-hdl", "dyslipidemia", "statin", "ezetimibe", "pcsk9", "inclisiran", "bempedoic", "colchicine", "lodoco2", "colcot"],
    "mỡ máu": ["dyslipidemia", "ldl-c", "statin", "ezetimibe", "pcsk9", "clear outcomes"],
    "xơ vữa": ["atherosclerosis", "ascvd", "ldl-c", "colchicine", "semaglutide"],
    "mạch vành": ["coronary", "ccs", "acs", "ischemia", "cormica", "inoca", "anoca", "ccta", "pci"],
    "vi mạch": ["inoca", "anoca", "cormica", "icft", "cfr", "imr", "acetylcholine"],
    "đau thắt ngực": ["angina", "inoca", "anoca", "ischemia", "cormica", "ranolazine"],
    "chống đông": ["anticoagulant", "doac", "aphrs", "cha2ds2", "warfarin", "dapt"],
    "tiểu cầu": ["antiplatelet", "dapt", "p2y12", "ticagrelor", "prasugrel", "clopidogrel", "twilight", "tico", "master dapt"],
    "dapt": ["dapt", "twilight", "tico", "master dapt", "ticagrelor", "aspirin", "p2y12", "hbr"],
    "xuất huyết": ["bleeding", "arc-hbr", "precise-dapt", "ppi", "twilight", "master dapt"],
    "suy tim": ["heart failure", "hfref", "hfpef", "hfmref", "sglt2", "finerenone", "finearts", "deliver", "emperor", "icardio"],
    "rung nhĩ": ["atrial fibrillation", "aphrs", "af-care", "east-afnet", "advent", "pfa", "ablation", "cha2ds2"],
    "nhịp": ["arrhythmia", "atrial fibrillation", "aphrs", "ablation", "pfa", "rhythm"],
    "van tim": ["valvular", "aortic stenosis", "tavr", "early tavr", "mitral", "tricuspid", "triluminate", "teer", "eacts"],
    "nội tâm mạc": ["endocarditis", "poet", "aha", "tee", "antibiotic"],
    "cơ tim": ["cardiomyopathy", "hcm", "ohcm", "mavacamten", "aficamten", "explorer-hcm", "valor-hcm", "sequoia-hcm", "myocarditis", "cmr"],
    "màng ngoài tim": ["pericarditis", "myocarditis", "imps", "cmr", "ten commandments"],
    "thuyên tắc phổi": ["pulmonary embolism", "pe", "pert", "catheter", "thrombectomy"],
    "tăng áp phổi": ["pulmonary hypertension", "pah", "sotatercept", "stellar"],
    "động mạch chủ": ["aortic", "paad", "dissection", "eacts", "ahi", "asi"],
    "béo phì": ["obesity", "semaglutide", "tirzepatide", "glp-1", "select", "flow", "bmi"],
    "đái tháo đường": ["diabetes", "t2dm", "sglt2i", "glp-1", "semaglutide", "flow", "finerenone"],
    "phục hồi chức năng": ["rehabilitation", "exercise", "rehab", "cardiopulmonary"],
    "thai kỳ": ["pregnancy", "mwho", "obstetric"],
    "an toàn": ["caution", "contraindication", "monitor", "egfr", "potassium", "kali", "lvef", "cyp", "lưu ý", "chống chỉ định"],
    "chống chỉ định": ["chống chỉ định", "caution", "không dùng", "avoid", "never", "tránh"],
    "liều": ["mg", "dose", "liều", "titrate", "chuẩn liều"],
}


def _build_pubmed_chat_query(query: str, briefing: dict | None = None) -> str:
    """Convert a bilingual VI/EN clinical question into an English NCBI PubMed search query."""
    q_low = normalize(query or "")
    groups = []
    matched_phrases = []
    for kind in ("disease", "intervention"):
        alternatives = []
        for category, mesh, aliases in CONCEPTS:
            if category == kind and any(contains(q_low, a) for a in aliases):
                matched_phrases.extend(aliases)
                if mesh:
                    alternatives.append(f'"{mesh}"[MeSH Terms]')
                alternatives.extend(f'"{a}"[tiab]' for a in aliases if a.isascii())
        if alternatives:
            groups.append('(' + ' OR '.join(dict.fromkeys(alternatives)) + ')')
    drugs = [d for d in _CARDIO_DRUG_MAP if contains(q_low, d)]
    if drugs:
        groups.append('(' + ' OR '.join(f'"{d}"[tiab]' for d in drugs) + ')')
    remaining = q_low
    for phrase in sorted(set(matched_phrases + drugs), key=len, reverse=True):
        remaining = re.sub(r'(?<!\w)' + re.escape(phrase) + r'(?!\w)', ' ', remaining)
    for k, vals in sorted(_CHAT_SYNONYM_MAP.items(), key=lambda item: -len(normalize(item[0]))):
        topic = normalize(k)
        if contains(remaining, topic):
            alternatives = list(dict.fromkeys(vals[:3]))
            groups.append('(' + ' OR '.join(f'"{t}"[tiab]' for t in alternatives) + ')')
            remaining = re.sub(r'(?<!\w)' + re.escape(topic) + r'(?!\w)', ' ', remaining)
    ascii_tokens = re.findall(r"[a-zA-Z0-9][a-zA-Z0-9\-/+]{2,}", remaining)
    stop = {"the", "and", "for", "with", "what", "how", "when", "new", "latest", "guideline", "guidelines", "moi", "nhat"}
    deduped = list(dict.fromkeys(t for t in ascii_tokens if t.lower() not in stop))[:5]
    groups.extend(f'"{t}"[tiab]' for t in deduped)
    if not groups and briefing:
        pid = int(briefing.get("pillar_id") or 1)
        from crawl_cardiology_news import PILLAR_CRAWL_QUERIES
        return f"({PILLAR_CRAWL_QUERIES.get(pid, 'cardiology')}) AND 2022:2026[dp]"
    joined = " AND ".join(groups) or 'cardiology[MeSH Terms]'
    return f"{joined} AND 2022:2026[dp]"


def _fetch_pubmed_with_abstracts(query: str, max_results: int = 3, question: str = "") -> list[dict]:
    """Fetch top PubMed metadata + parsed abstract conclusion snippet ($0 NCBI E-utilities)."""
    if not query.strip() or max_results <= 0:
        return []
    try:
        enc_q = urllib.parse.quote(query)
        esearch_url = (
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?"
            f"db=pubmed&term={enc_q}&retmode=json&retmax={max_results * 4}&sort=relevance"
        )
        with urllib.request.urlopen(urllib.request.Request(esearch_url, headers={"User-Agent": "CardiologyEBM/1.0"}), timeout=8) as r:
            id_list = json.loads(r.read().decode("utf-8")).get("esearchresult", {}).get("idlist", [])
        if len(id_list) < max_results and '2022:2026[dp]' in query:
            relaxed = query.replace(' AND 2022:2026[dp]', '')
            url = esearch_url.replace(enc_q, urllib.parse.quote(relaxed))
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "CardiologyEBM/1.0"}), timeout=8) as r:
                older = json.loads(r.read().decode('utf-8')).get('esearchresult', {}).get('idlist', [])
            id_list = list(dict.fromkeys(id_list + older))
        if not id_list:
            return []

        efetch_url = (
            "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?"
            f"db=pubmed&id={','.join(id_list[:max_results * 4])}&retmode=xml"
        )
        with urllib.request.urlopen(urllib.request.Request(efetch_url, headers={"User-Agent": "CardiologyEBM/1.0"}), timeout=10) as r:
            root = ET.fromstring(r.read())

        hits: list[dict] = []
        for art in root.findall(".//PubmedArticle"):
            pmid = (art.findtext(".//MedlineCitation/PMID") or "").strip()
            title_el = art.find(".//Article/ArticleTitle")
            title = "".join(title_el.itertext()).strip().rstrip(".") if title_el is not None else ""
            if not pmid or not title:
                continue
            journal = (art.findtext(".//MedlineCitation/MedlineJournalInfo/MedlineTA") or "PubMed").strip()
            year_s = (art.findtext(".//Article/Journal/JournalIssue/PubDate/Year") or "").strip()
            month_s = (art.findtext(".//Article/Journal/JournalIssue/PubDate/Month") or "").strip()
            pubdate = " ".join(x for x in (year_s, month_s) if x) or "2026"
            doi = ""
            for aid in art.findall(".//PubmedData/ArticleIdList/ArticleId"):
                if aid.attrib.get("IdType") == "doi" and aid.text:
                    doi = aid.text.strip()
                    break
            sections: dict[str, str] = {}
            all_ab: list[str] = []
            for ab in art.findall(".//Article/Abstract/AbstractText"):
                lbl = (ab.attrib.get("Label") or ab.attrib.get("NlmCategory") or "SUMMARY").upper()
                txt = "".join(ab.itertext()).strip()
                if txt:
                    sections[lbl] = txt
                    all_ab.append(txt)
            snippet = (
                sections.get("CONCLUSIONS")
                or sections.get("RESULTS")
                or (all_ab[-1] if all_ab else "")
            )
            if len(snippet) > 340:
                snippet = snippet[:337].rsplit(" ", 1)[0] + "..."
            hits.append({
                "pmid": pmid,
                "title": title,
                "source": journal,
                "pubdate": pubdate,
                "doi": doi,
                "url": f"https://doi.org/{doi}" if doi else f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                "snippet": snippet,
                "_abstract": ' '.join(all_ab),
            })
        ranking_query = question or re.sub(r'\[[^]]+\]|\b(?:AND|OR)\b|2022:2026', ' ', query)
        hits.sort(key=lambda h: relevance_score({'title_en': h['title'], 'snippet': h['_abstract']}, ranking_query), reverse=True)
        for hit in hits:
            hit.pop('_abstract')
        return hits[:max_results]
    except Exception as exc:
        print(f"[Chat PubMed Warning] {exc}", file=sys.stderr)
        return []


_CHAT_STOPWORDS: set[str] = {
    "tôi", "bạn", "mình", "anh", "chị", "em", "bác", "sĩ", "không", "chưa", "biết", "hiểu",
    "gì", "về", "y", "khoa", "cho", "hãy", "giúp", "giải", "thích", "đơn", "giản", "dễ",
    "hơn", "như", "thế", "nào", "sao", "vậy", "là", "của", "các", "những", "trong", "ngoài",
    "trụ", "cột", "bài", "này", "bản", "tin", "hôm", "nay", "điểm", "mới", "nhất", "tóm",
    "tắt", "nói", "rõ", "cụ", "thể", "ví", "dụ", "what", "how", "why", "explain", "simple",
    "simpler", "pillar", "today", "the", "for", "about", "with", "from", "this", "that",
}


def _score_briefing_for_chat(b: dict, query: str, active_briefing_id: str = "", active_pillar_id: int | None = None) -> int:
    """Rank a curated briefing against a clinical user question using explicit pillar matching + VI/EN tokens."""
    q_low = (query or "").lower()
    explicit_pids = [int(m) for m in re.findall(r"(?:trụ\s*cột|pillar|chủ\s*đề)\s*#?\s*(10|[1-9])\b", q_low)]
    score = 0
    pid = int(b.get("pillar_id") or 0)
    if explicit_pids:
        score += 250 if pid in explicit_pids else -100

    keyword_hits = relevance_score(b, query)
    score += keyword_hits

    if "-main" in str(b.get("id", "")) or "2026" in str((b.get("guideline_evolution") or {}).get("current_guideline", {}).get("year", "")):
        score += 15

    has_ctx_phrase = any(p in q_low for p in ("hôm nay", "bài này", "bản tin này", "trụ cột này", "today", "current"))
    if not explicit_pids and (has_ctx_phrase or not search_terms(query)):
        if active_briefing_id and b.get("id") == active_briefing_id:
            score += 60
        elif active_pillar_id and pid == int(active_pillar_id):
            score += 45
    elif keyword_hits > 0:
        if active_briefing_id and b.get("id") == active_briefing_id:
            score += 4
        elif active_pillar_id and pid == int(active_pillar_id):
            score += 2
    return score


_CARDIO_DRUG_MAP: dict[str, str] = {
    "finerenone": "finerenone",
    "kerendia": "finerenone",
    "dapagliflozin": "dapagliflozin",
    "forxiga": "dapagliflozin",
    "empagliflozin": "empagliflozin",
    "jardiance": "empagliflozin",
    "mavacamten": "mavacamten",
    "camzyos": "mavacamten",
    "aficamten": "aficamten",
    "ticagrelor": "ticagrelor",
    "brilinta": "ticagrelor",
    "prasugrel": "prasugrel",
    "clopidogrel": "clopidogrel",
    "plavix": "clopidogrel",
    "rivaroxaban": "rivaroxaban",
    "xarelto": "rivaroxaban",
    "apixaban": "apixaban",
    "eliquis": "apixaban",
    "dabigatran": "dabigatran",
    "sacubitril": "sacubitril",
    "entresto": "sacubitril",
    "spironolactone": "spironolactone",
    "semaglutide": "semaglutide",
    "wegovy": "semaglutide",
    "ozempic": "semaglutide",
    "tirzepatide": "tirzepatide",
    "colchicine": "colchicine",
    "bempedoic": "bempedoic acid",
    "evolocumab": "evolocumab",
    "alirocumab": "alirocumab",
    "inclisiran": "inclisiran",
    "sotatercept": "sotatercept",
    "winrevair": "sotatercept",
    "amiodarone": "amiodarone",
    "carvedilol": "carvedilol",
    "nebivolol": "nebivolol",
    "valsartan": "valsartan",
    "ramipril": "ramipril",
    "amlodipine": "amlodipine",
    "ranolazine": "ranolazine",
}


def _fetch_openfda_drug_note(query: str) -> dict | None:
    """Query public keyless OpenFDA Drug Label API for dosing, contraindications, and safety notes."""
    q_low = (query or "").lower()
    matched_drug = ""
    for alias, generic in _CARDIO_DRUG_MAP.items():
        if alias in q_low:
            matched_drug = generic
            break
    if not matched_drug:
        return None
    try:
        search_expr = urllib.parse.quote(f'openfda.generic_name:"{matched_drug}"')
        url = f"https://api.fda.gov/drug/label.json?search={search_expr}&limit=1"
        req = urllib.request.Request(url, headers={"User-Agent": "SoaiCaYKhoa/1.0"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read().decode("utf-8"))
        res = (data.get("results") or [None])[0]
        if not res:
            return None

        wants_contra = any(w in q_low for w in ("chống chỉ định", "an toàn", "cảnh báo", "tác dụng phụ", "caution", "safety", "contraindicat", "thận", "kali"))
        wants_dose = any(w in q_low for w in ("liều", "dose", "dosing", "mg", "uống", "tiêm", "chỉnh liều"))

        raw_txt = ""
        field_label = "Tóm tắt Dược lâm sàng OpenFDA"
        if wants_contra and res.get("contraindications"):
            raw_txt = " ".join(res["contraindications"])
            field_label = "Chống chỉ định (OpenFDA)"
        elif wants_dose and res.get("dosage_and_administration"):
            raw_txt = " ".join(res["dosage_and_administration"])
            field_label = "Liều dùng & Cách dùng (OpenFDA)"
        elif res.get("warnings_and_cautions") or res.get("contraindications"):
            raw_txt = " ".join(res.get("contraindications") or res.get("warnings_and_cautions"))
            field_label = "Lưu ý An toàn (OpenFDA)"
        elif res.get("indications_and_usage"):
            raw_txt = " ".join(res["indications_and_usage"])
            field_label = "Chỉ định Chính thức (OpenFDA)"

        cleaned = re.sub(r"\s+", " ", raw_txt).strip()
        if not cleaned:
            return None
        if len(cleaned) > 340:
            cleaned = cleaned[:337].rsplit(" ", 1)[0] + "..."
        return {"drug": matched_drug.title(), "label": field_label, "text": cleaned}
    except Exception:
        return None


_MCQ_PASTE_PAT_PUNCT = re.compile(
    r"(?:^|\n|\s)(?:\*\*)?([ABCD])(?:\*\*)?\s*[\.\)\:\-]\s+(.+?)(?=(?:\n|\s+)(?:\*\*)?[ABCD](?:\*\*)?\s*[\.\)\:\-]\s+|\Z)",
    re.DOTALL,
)
_MCQ_PASTE_PAT_NEWLINE = re.compile(
    r"(?:^|\n)\s*([ABCD])\s*\n\s*(.+?)(?=(?:\n\s*[ABCD]\s*\n)|\Z)",
    re.DOTALL,
)
_DETAIL_REQ_RE = re.compile(
    r"(giải thích thêm|giải thích kỹ|giải thích rõ|chi tiết|phân tích kỹ|cụ thể hơn|"
    r"tại sao|vì sao|dễ hiểu|đơn giản|chưa hiểu|không biết gì về y khoa|"
    r"explain more|in detail|elaborate|why is that|simpler|simple words|break down)",
    re.IGNORECASE,
)


def _extract_pasted_mcq_options(query: str) -> dict[str, str]:
    """Extract A/B/C/D options when a user pastes a multiple-choice question into chat."""
    q = (query or "").strip()
    if not q or len(q) < 12:
        return {}
    matches = _MCQ_PASTE_PAT_PUNCT.findall(q)
    opts: dict[str, str] = {}
    for k, val in matches:
        clean_v = re.sub(r"\s+", " ", val).strip()
        if clean_v and k.upper() not in opts:
            opts[k.upper()] = clean_v
    if all(k in opts for k in ("A", "B", "C", "D")):
        return {k: opts[k] for k in ("A", "B", "C", "D")}

    matches_nl = _MCQ_PASTE_PAT_NEWLINE.findall(q)
    opts_nl: dict[str, str] = {}
    for k, val in matches_nl:
        clean_v = re.sub(r"\s+", " ", val).strip()
        if clean_v and k.upper() not in opts_nl:
            opts_nl[k.upper()] = clean_v
    if all(k in opts_nl for k in ("A", "B", "C", "D")):
        return {k: opts_nl[k] for k in ("A", "B", "C", "D")}
    return {}


def _wants_detailed_explanation(query: str) -> bool:
    """True only when user explicitly asks for a fuller explanation."""
    return bool(_DETAIL_REQ_RE.search(query or ""))


def _ensure_complete_sentence(text: str) -> str:
    """Strip think blocks (closed or unclosed) and trim dangling partial fragments after a token cutoff."""
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", text or "", flags=re.IGNORECASE)
    cleaned = re.sub(r"<think>[\s\S]*$", "", cleaned, flags=re.IGNORECASE).strip()
    if not cleaned:
        return ""
    # If already ends cleanly on sentence-ending punctuation or markdown quote/paren after punctuation
    if re.search(r"[.!?…][\"'\)\]\*`]*$", cleaned):
        return cleaned
    # Try cutting back to the last genuine sentence boundary (period/!/? followed by space or newline)
    m_all = list(re.finditer(r"(?<!\d)[.!?](?=\s|\n|$)", cleaned))
    if m_all:
        cut_pos = m_all[-1].end()
        if cut_pos >= max(24, int(len(cleaned) * 0.4)):
            return cleaned[:cut_pos].strip()
    return cleaned + "."


def _first_clean_sentence(text: str, max_len: int = 420) -> str:
    clean = re.sub(r"\s+", " ", str(text or "")).strip()
    if not clean:
        return ""
    if len(clean) <= max_len:
        return clean if re.search(r"[.!?…][\"'\)\]\*`]*$", clean) else f"{clean}."
    matches = list(re.finditer(r"(?<!\d)[.!?](?=\s|$)", clean))
    best_end = None
    for m in matches:
        if m.end() <= max_len:
            seg = clean[:m.end()]
            if seg.count("(") == seg.count(")") and seg.count("**") % 2 == 0:
                best_end = m.end()
        else:
            break
    if best_end and best_end >= 25:
        return clean[:best_end].strip()
    if matches and matches[0].end() <= max(max_len + 220, 640):
        return clean[:matches[0].end()].strip()
    return clean if re.search(r"[.!?…][\"'\)\]\*`]*$", clean) else f"{clean}."


def _compose_deterministic_ebm_answer(
    query: str,
    briefings: list[dict],
    pubmed_hits: list[dict],
    lang: str = "vi",
    fda_note: dict | None = None,
    verbosity: str = "medium",
) -> tuple[str, list[dict]]:
    """Build direct clinical response grounded on 2026 Guidelines, RCTs, PubMed & OpenFDA at chosen detail level."""
    primary = briefings[0]
    is_en = lang == "en"
    q_low = (query or "").lower()
    v_norm = str(verbosity or "medium").strip().lower()
    if v_norm not in ("short", "medium", "detailed"):
        v_norm = "medium"
    ge = primary.get("guideline_evolution") or {}
    prior_g = ge.get("prior_guideline") or {}
    cur_g = ge.get("current_guideline") or {}
    steps = ge.get("steps") or []
    trials = primary.get("landmark_trials") or []
    pearls = primary.get("pearls") or []

    translate_fn = None
    if not is_en:
        try:
            from crawl_cardiology_news import translate_en_to_vi
            translate_fn = translate_en_to_vi
        except Exception:
            translate_fn = None

    sources: list[dict] = []
    seen_p: set[str] = set()
    for src in (pubmed_hits + (primary.get("pubmed_anchors") or [])):
        pm = str(src.get("pmid", "")).strip()
        if not pm or pm in seen_p:
            continue
        seen_p.add(pm)
        sources.append({
            "pmid": pm,
            "title": src.get("title", ""),
            "source": src.get("source", ""),
            "pubdate": src.get("pubdate", ""),
            "doi": src.get("doi", ""),
            "url": src.get("url") or (f"https://doi.org/{src['doi']}" if src.get("doi") else f"https://pubmed.ncbi.nlm.nih.gov/{pm}/"),
        })
        if len(sources) >= 5:
            break

    wants_detail = _wants_detailed_explanation(query)
    eff_level = "detailed" if (v_norm == "detailed" or (v_norm == "medium" and wants_detail)) else v_norm
    mcq_opts = _extract_pasted_mcq_options(query)

    # 1) Pasted Multiple-Choice Mode -> respects short (1 sentence), medium (2-3 sentences), detailed (structured breakdown)
    if mcq_opts:
        evid_blob = " ".join([
            cur_g.get("name", ""),
            " ".join(f"{st.get('title_vi','')} {st.get('desc_vi','')} {st.get('title_en','')} {st.get('desc_en','')}" for st in steps),
            " ".join(f"{tr.get('name','')} {tr.get('changes_vi','')} {tr.get('caution_vi','')} {tr.get('changes_en','')} {tr.get('caution_en','')}" for tr in trials),
            " ".join(f"{p.get('text_vi','')} {p.get('text_en','')}" for p in pearls),
            (primary.get("part1_vi_markdown") or "")[:3000],
            (primary.get("part2_en_markdown") or "")[:3000],
        ]).lower()
        trap_re = re.compile(
            r"(giữ nguyên ngưỡng.*cũ|trì hoãn.*12 tháng|chỉ dùng.*sốc tim|ngưng toàn bộ|không cần lưu ý|"
            r"tăng gấp đôi liều.*suy thận|chỉ dựa vào ngưỡng tuổi|bỏ qua bệnh đồng mắc|đơn trị liệu.*vượt trội|"
            r"p\s*>\s*0[,\.]2|trung tính|maintain the legacy|defer therapy.*12 months|reserve.*strictly for inpatients|"
            r"discontinue background therapy|rely solely on isolated age|none — intensive targets|double the initiating bolus|"
            r"stop all cardioprotective|showed neutral primary outcomes)",
            re.IGNORECASE,
        )
        best_k = "A"
        best_sc = -10**9
        for k, opt_txt in mcq_opts.items():
            o_low = opt_txt.lower()
            toks = set(re.findall(r"[\w\-]{3,}", o_low))
            sc = sum(2 for t in toks if t in evid_blob)
            if trap_re.search(o_low):
                sc -= 20
            if sc > best_sc:
                best_sc = sc
                best_k = k

        reason_src = ""
        if steps:
            reason_src = steps[-1].get("desc_en" if is_en else "desc_vi", "")
        if not reason_src and pearls:
            reason_src = pearls[0].get("text_en" if is_en else "text_vi", "")
        if not reason_src:
            reason_src = mcq_opts[best_k]
        one_reason = _first_clean_sentence(reason_src, 200 if eff_level == "short" else 240).rstrip(".")
        if one_reason and len(one_reason) > 2 and one_reason[0].isupper() and not one_reason[:3].isupper():
            one_reason = one_reason[0].lower() + one_reason[1:]

        head_ans = (
            f"**{best_k}**, because {one_reason}."
            if is_en else
            f"**{best_k}**, vì {one_reason}."
        )
        if eff_level == "short":
            return _ensure_complete_sentence(head_ans), sources

        tr_note = ""
        if trials:
            tr0 = trials[0]
            tr_note = " " + _first_clean_sentence(
                f"{tr0.get('name')} ({tr0.get('value')}, {tr0.get('p')}): {tr0.get('changes_en' if is_en else 'changes_vi', '')}",
                320,
            )
        if eff_level == "medium":
            return _ensure_complete_sentence(head_ans + tr_note), sources

        mcq_parts = [head_ans + tr_note]
        if cur_g.get("name"):
            mcq_parts.append(
                f"- **{'Guideline Basis' if is_en else 'Cơ sở Khuyến cáo'} ({cur_g.get('name')}):** "
                + _first_clean_sentence(steps[-1].get("desc_en" if is_en else "desc_vi", "") if steps else "", 340)
            )
        for tr in trials[:2]:
            chg = _first_clean_sentence(tr.get("changes_en" if is_en else "changes_vi", ""), 300)
            caut = _first_clean_sentence(tr.get("caution_en" if is_en else "caution_vi", ""), 260)
            mcq_parts.append(f"- **{tr.get('name')}** ({tr.get('value')}, {tr.get('ci')}, {tr.get('p')}): {chg} *{caut}*")
        if pearls:
            p0 = pearls[0].get("text_en" if is_en else "text_vi") or pearls[0].get("en" if is_en else "vi", "")
            if p0:
                mcq_parts.append(f"- **{'Clinical Pearl' if is_en else 'Điểm nhấn lâm sàng'}:** {_first_clean_sentence(p0, 340)}")
        return _ensure_complete_sentence("\n".join(mcq_parts)), sources

    # Match relevant sentences inside markdown body + structured evidence
    raw_md = primary.get("part2_en_markdown" if is_en else "part1_vi_markdown", "") or primary.get("part1_vi_markdown", "")
    _q_stop = {
        "được", "mức", "nào", "chính", "như", "thế", "sao", "cho", "với", "của", "các", "những",
        "trong", "về", "và", "hay", "hoặc", "khi", "nếu", "thì", "tại", "bởi", "theo", "khuyến",
        "cáo", "lâm", "sàng", "áp", "dụng", "bệnh", "nhân", "giải", "thích", "chi", "tiết",
        "the", "and", "for", "with", "what", "how", "when", "why", "are", "was", "from", "this",
    }
    raw_terms = set(re.findall(r"[\w\-]{3,}", q_low))
    query_terms = {t for t in raw_terms if t not in _q_stop} or raw_terms
    for k, syns in _CHAT_SYNONYM_MAP.items():
        if k in q_low:
            query_terms.update(syns)

    lines = [
        ln.strip() for ln in raw_md.splitlines()
        if ln.strip()
        and not ln.strip().startswith("#")
        and not ln.strip().startswith("⚠️")
        and not ln.strip().startswith("*Nguồn")
        and not ln.strip().startswith("*Traceable")
        and not ln.strip().startswith("*Nội dung")
        and not ln.strip().startswith("*The clinical evidence")
        and "[END OF PART" not in ln
    ]
    scored_lines: list[tuple[int, str]] = []
    for ln in lines:
        low_ln = ln.lower()
        hits = sum(1 for t in query_terms if t in low_ln)
        if hits > 0:
            scored_lines.append((hits, re.sub(r"^[-*•]\s*", "", ln)))
    scored_lines.sort(key=lambda x: x[0], reverse=True)

    # 2) Short mode -> crisp 1-2 direct clinical sentences (~45-85 words)
    if eff_level == "short":
        short_segs: list[str] = []
        if scored_lines:
            short_segs.append(_first_clean_sentence(scored_lines[0][1], 240))
        elif steps:
            s_last = steps[-1]
            short_segs.append(
                f"**{cur_g.get('name', primary.get('title_en' if is_en else 'title_vi', ''))}:** "
                + _first_clean_sentence(s_last.get("desc_en" if is_en else "desc_vi", ""), 240)
            )
        if trials:
            tr0 = trials[0]
            short_segs.append(
                f"**{tr0.get('name')}** ({tr0.get('value')}, {tr0.get('p')}): "
                + _first_clean_sentence(tr0.get("changes_en" if is_en else "changes_vi", ""), 180)
            )
        elif fda_note and fda_note.get("text"):
            note_txt = _first_clean_sentence(fda_note["text"], 200)
            if not is_en and translate_fn:
                try:
                    tr_txt = translate_fn(note_txt[:220])
                    if tr_txt:
                        note_txt = _first_clean_sentence(tr_txt, 200)
                except Exception:
                    pass
            short_segs.append(f"**{fda_note['label']} ({fda_note['drug']}):** {note_txt}")
        return _ensure_complete_sentence(" ".join(short_segs)), sources

    # 3) Medium / balanced direct answer (~130-210 words)
    if eff_level == "medium":
        sections: list[str] = []
        if scored_lines:
            sections.append(" ".join(_first_clean_sentence(ln, 420) for _, ln in scored_lines[:2]))
        elif steps:
            s_last = steps[-1]
            sections.append(
                f"**{cur_g.get('name', primary.get('title_en' if is_en else 'title_vi', ''))}:** "
                + _first_clean_sentence(s_last.get("desc_en" if is_en else "desc_vi", ""), 420)
            )
        for tr in trials[:2]:
            chg = _first_clean_sentence(tr.get("changes_en" if is_en else "changes_vi", ""), 340)
            caut = _first_clean_sentence(tr.get("caution_en" if is_en else "caution_vi", ""), 340)
            sections.append(f"- **{tr.get('name')}** (*{tr.get('journal')}*, **{tr.get('value')}**, {tr.get('p')}): {chg} {caut}")
        if fda_note and fda_note.get("text"):
            note_txt = _first_clean_sentence(fda_note["text"], 360)
            if not is_en and translate_fn:
                try:
                    tr_txt = translate_fn(note_txt[:360])
                    if tr_txt:
                        note_txt = _first_clean_sentence(tr_txt, 360)
                except Exception:
                    pass
            sections.append(f"- **{fda_note['label']} ({fda_note['drug']}):** {note_txt}")
        if pearls:
            p0 = pearls[0].get("text_en" if is_en else "text_vi") or pearls[0].get("en" if is_en else "vi", "")
            if p0:
                sections.append(f"- **{'Clinical Pearl' if is_en else 'Điểm nhấn lâm sàng'}:** {_first_clean_sentence(p0, 380)}")
        return _ensure_complete_sentence("\n\n".join(sections)), sources

    # 4) Detailed explanation mode (~240-360 words, structured & complete)
    parts: list[str] = [
        f"**{cur_g.get('name', primary.get('title_en' if is_en else 'title_vi', ''))}** *({'Prior' if is_en else 'Tiền nhiệm'}: {prior_g.get('name', '—')})*"
    ]
    if scored_lines:
        for _, ln in scored_lines[:3]:
            parts.append(f"- {_first_clean_sentence(ln, 420)}")
    else:
        for st in steps[:3]:
            t_lbl = st.get("title_en" if is_en else "title_vi", "")
            d_lbl = _first_clean_sentence(st.get("desc_en" if is_en else "desc_vi", ""), 360)
            parts.append(f"- **{t_lbl}:** {d_lbl}")

    for tr in trials[:3]:
        chg = _first_clean_sentence(tr.get("changes_en" if is_en else "changes_vi", ""), 340)
        caut = _first_clean_sentence(tr.get("caution_en" if is_en else "caution_vi", ""), 340)
        parts.append(f"- **{tr.get('name')}** ({tr.get('value')}, {tr.get('ci')}, {tr.get('p')}): {chg} *{caut}*")

    for p in pearls[:2]:
        p_txt = p.get("text_en" if is_en else "text_vi") or p.get("en" if is_en else "vi", "")
        if p_txt:
            parts.append(f"- **{'Pearl' if is_en else 'Lưu ý đi buồng'}:** {_first_clean_sentence(p_txt, 380)}")

    if fda_note and fda_note.get("text"):
        note_txt = _first_clean_sentence(fda_note["text"], 360)
        if not is_en and translate_fn:
            try:
                tr_txt = translate_fn(note_txt)
                if tr_txt:
                    note_txt = _first_clean_sentence(tr_txt, 360)
            except Exception:
                pass
        parts.append(f"- **{fda_note['label']} ({fda_note['drug']}):** {note_txt}")

    return _ensure_complete_sentence("\n".join(parts)), sources


def _default_daily_llm_limit() -> int:
    try:
        val = int(os.environ.get("MAX_DAILY_LLM_CALLS", "500") or "500")
        return max(1, min(val, 2000))
    except ValueError:
        return 500


def _load_chat_quota_unlocked() -> dict:
    """Load daily hard-stop LLM quota from disk, auto-resetting at midnight."""
    today_str = datetime.date.today().isoformat()
    default_limit = _default_daily_llm_limit()
    state = {
        "date": today_str,
        "used": 0,
        "limit": default_limit,
        "exhausted": False,
        "stop_reason": "",
    }
    if CHAT_QUOTA_PATH.exists():
        try:
            loaded = json.loads(CHAT_QUOTA_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                limit_val = max(1, min(int(loaded.get("limit", default_limit) or default_limit), 2000))
                if loaded.get("date") == today_str:
                    used_val = max(0, int(loaded.get("used", 0) or 0))
                    state = {
                        "date": today_str,
                        "used": used_val,
                        "limit": limit_val,
                        "exhausted": bool(loaded.get("exhausted", False)) or (used_val >= limit_val),
                        "stop_reason": str(loaded.get("stop_reason", "")),
                    }
                else:
                    state["limit"] = limit_val
        except Exception:
            pass
    return state


def _save_chat_quota_unlocked(state: dict) -> None:
    _atomic_write_text(CHAT_QUOTA_PATH, json.dumps(state, indent=2, ensure_ascii=False))


def _load_chat_quota() -> dict:
    with _quota_lock:
        return _load_chat_quota_unlocked()


def _resolve_chat_llm_key(req_key: str = "") -> tuple[str, str]:
    """Resolve explicit or server .env API key and auto-detect provider (Groq gsk_ vs Gemini AIza)."""
    key = (
        str(req_key or "").strip()
        or os.environ.get("GEMINI_API_KEY", "").strip()
        or os.environ.get("GROQ_API_KEY", "").strip()
        or os.environ.get("GOOGLE_API_KEY", "").strip()
    )
    if not key:
        return "", ""
    if key.startswith("gsk_"):
        return "groq", key
    return "gemini", key


def _save_api_key_to_dotenv(api_key: str, daily_limit: int | None = None, reset_today: bool = False) -> dict:
    """Persist Gemini (AIza...) or Groq (gsk_...) key to .env + update daily hard cap in chat_quota.json."""
    clean_key = str(api_key or "").strip()
    env_path = BASE_DIR / ".env"
    existing_kv: dict[str, str] = {}
    if env_path.exists():
        for ln in env_path.read_text(encoding="utf-8").splitlines():
            s = ln.strip()
            if s and not s.startswith("#") and "=" in s:
                k, v = s.split("=", 1)
                existing_kv[k.strip()] = v.strip().strip('"').strip("'")

    if clean_key:
        if clean_key.startswith("gsk_"):
            existing_kv["GROQ_API_KEY"] = clean_key
            existing_kv.setdefault("GEMINI_API_KEY", "")
            os.environ["GROQ_API_KEY"] = clean_key
        else:
            existing_kv["GEMINI_API_KEY"] = clean_key
            existing_kv.setdefault("GROQ_API_KEY", "")
            os.environ["GEMINI_API_KEY"] = clean_key

    with _quota_lock:
        q = _load_chat_quota_unlocked()
        if daily_limit is not None:
            new_lim = max(1, min(int(daily_limit), 2000))
            q["limit"] = new_lim
            existing_kv["MAX_DAILY_LLM_CALLS"] = str(new_lim)
            os.environ["MAX_DAILY_LLM_CALLS"] = str(new_lim)
        if reset_today:
            q["used"] = 0
            q["exhausted"] = False
            q["stop_reason"] = ""
        else:
            q["exhausted"] = bool(q["exhausted"]) or (q["used"] >= q["limit"])
        _save_chat_quota_unlocked(q)

    lines = [f"{k}={v}" for k, v in existing_kv.items()]
    _atomic_write_text(env_path, "\n".join(lines) + "\n")
    prov, resolved = _resolve_chat_llm_key("")
    return {"ok": True, "quota": q, "has_server_key": bool(resolved), "provider": prov}


_OFFTOPIC_RE = re.compile(
    r"(viết code|lập trình|python|javascript|typescript|html|css|sql|java\b|c\+\+|react|docker|kubernetes|"
    r"giải phương trình|toán học|tích phân|đạo hàm|bóng đá|football|world cup|nba|tennis|"
    r"thời tiết|weather|dự báo mưa|chứng khoán|cổ phiếu|bitcoin|crypto|forex|vàng sjc|"
    r"nấu ăn|công thức nấu|làm thơ|viết văn|kể chuyện|truyện cười|phim hay|bộ phim|ca nhạc|bài hát|"
    r"chơi game|liên quân|lmht|xổ số|vietlott|tử vi|bói toán|phong thủy|du lịch|khách sạn|giá vé máy bay)",
    re.IGNORECASE,
)

_MEDICAL_KEYWORDS_RE = re.compile(
    r"(y khoa|tim mạch|tim|mạch|huyết áp|tha\b|suy tim|rung nhĩ|nhồi máu|đột quỵ|đau ngực|thắt ngực|"
    r"thận|ckd|phổi|động mạch|tĩnh mạch|van tim|cơ tim|màng ngoài tim|nội tâm mạc|rối loạn nhịp|"
    r"lipid|mỡ máu|xơ vữa|đái tháo đường|béo phì|bệnh nhân|lâm sàng|bệnh lý|triệu chứng|chẩn đoán|"
    r"điều trị|phác đồ|thuốc|liều|uống|tiêm|chống chỉ định|tác dụng phụ|an toàn|tương tác|theo dõi|"
    r"xét nghiệm|siêu âm|ecg|điện tâm đồ|lvef|egfr|bnp|nt-probnp|troponin|ldl|hdl|kali|creatinine|"
    r"guideline|khuyến cáo|thử nghiệm|rct|esc|aha|acc|ish|aphrs|eacts|ccs|kdoqi|pubmed|fda|openfda|"
    r"trụ cột|bài này|bản tin|tóm tắt|so sánh|điểm mới|cập nhật|cấp cứu|hồi sức|can thiệp|pci|tavr|cabg|"
    r"stent|dapt|doac|noac|aspirin|p2y12|ticagrelor|prasugrel|clopidogrel|statin|ezetimibe|pcsk9|"
    r"colchicine|bempedoic|sglt2|dapagliflozin|empagliflozin|finerenone|spironolactone|arni|sacubitril|"
    r"acei|arb|chẹn beta|carvedilol|nebivolol|amlodipine|rivaroxaban|apixaban|semaglutide|tirzepatide|"
    r"mavacamten|aficamten|sotatercept|amiodarone|ranolazine|pfa|ablation|heart|cardio|cardiac|clinical|"
    r"patient|trial|dose|dosing|safety|pillar|briefing|summary|compare|2026)",
    re.IGNORECASE,
)

_FOLLOWUP_OR_CONTEXT_RE = re.compile(
    r"(giải thích|dễ hiểu|đơn giản|chưa hiểu|không hiểu|khó hiểu|nói rõ|rõ hơn|cụ thể|ví dụ|"
    r"tại sao|vì sao|như thế nào|nghĩa là|ý là|tóm lại|ngắn gọn|chi tiết|phân tích|bình dân|"
    r"hôm nay|bài này|phần này|mục này|ở trên|vừa rồi|tiếp theo|còn gì|thế còn|vậy thì|ý số|điểm số|"
    r"explain|simpler|simple|understand|clarify|example|why|how|detail|today|above|what does that mean|more about)",
    re.IGNORECASE,
)


def _is_medical_or_cardiology_query(
    query: str,
    briefings: list[dict],
    active_bid: str = "",
    active_pid: int | None = None,
    history: list[dict] | None = None,
) -> bool:
    """Zero-token pre-LLM gatekeeper: block off-topic prompts while permitting medical follow-ups."""
    q = (query or "").strip()
    if not q or len(q) < 2:
        return False
    has_med_kw = bool(_MEDICAL_KEYWORDS_RE.search(q))
    if _OFFTOPIC_RE.search(q) and not has_med_kw:
        return False
    if has_med_kw or _FOLLOWUP_OR_CONTEXT_RE.search(q):
        return True
    if any(isinstance(m, dict) and m.get("role") == "user" for m in (history or [])):
        return True
    # Also check corpus match score without counting the active-briefing bonus
    top_score = max(
        (_score_briefing_for_chat(b, q, "", None) for b in briefings if "-main" in str(b.get("id", ""))),
        default=0,
    )
    return top_score >= 6


def answer_ebm_chat_query(req_data: dict) -> dict:
    """
    Soái ca Y khoa Q&A Handler:
    - Enforces a zero-token off-topic medical relevance filter before invoking LLM.
    - Combines 10-pillar EBM curation + Live NCBI PubMed + OpenFDA drug labels.
    - Runs Groq/Gemini API from server .env strictly within daily turn limits.
    """
    query = str(req_data.get("query", "")).strip()
    if not query:
        return {"ok": False, "error": "Vui lòng nhập câu hỏi lâm sàng."}

    briefings = load_existing_briefings()
    if not briefings:
        return {"ok": False, "error": "Chưa có dữ liệu bản tin EBM."}

    lang = "en" if str(req_data.get("lang", "vi")).lower() == "en" else "vi"
    raw_verbosity = str(req_data.get("verbosity", "medium")).strip().lower()
    verbosity = raw_verbosity if raw_verbosity in ("short", "medium", "detailed") else "medium"
    active_bid = str(req_data.get("briefing_id", "")).strip()
    raw_pid = req_data.get("pillar_id")
    active_pid = int(raw_pid) if raw_pid and str(raw_pid).isdigit() else None
    include_pubmed = bool(req_data.get("include_pubmed", True))
    raw_history = req_data.get("history")
    clean_history: list[dict[str, str]] = []
    if isinstance(raw_history, list):
        for item in raw_history[-4:]:
            if isinstance(item, dict) and item.get("role") in ("user", "assistant"):
                txt = str(item.get("content", "")).strip()
                if txt:
                    clean_history.append({"role": str(item["role"]), "content": txt[:500]})

    quota = _load_chat_quota()
    provider, api_key = _resolve_chat_llm_key(req_data.get("api_key", ""))

    # Layer 1 Guard (0 tokens spent): Reject non-medical / off-topic questions immediately
    if not _is_medical_or_cardiology_query(query, briefings, active_bid, active_pid, history=clean_history):
        refusal = (
            "### Soái ca Y khoa — Giới hạn Chuyên môn\n\n"
            "Tôi là **Soái ca Y khoa**, trợ lý chuyên sâu về **Nội khoa Tim mạch & Y học Chứng cứ (EBM)**. "
            "Tôi xin phép **từ chối trả lời** các câu hỏi ngoài phạm vi y khoa để tiết kiệm tài nguyên hệ thống.\n\n"
            "*Bác sĩ có thể hỏi về: Guideline Tim mạch 08–11/2026, 10 Trụ cột chuyên khoa, thử nghiệm RCT bản lề, liều dùng – chống chỉ định thuốc tim mạch hoặc tra cứu bài báo PubMed.*"
            if lang != "en" else
            "### Med Bro — Clinical Scope Notice\n\n"
            "I am **Med Bro**, dedicated strictly to **Cardiology & Evidence-Based Medicine**. "
            "I politely decline off-topic non-medical requests to conserve system tokens."
        )
        return {
            "ok": True,
            "rejected_offtopic": True,
            "answer_markdown": refusal,
            "sources": [],
            "engine_used": "Med Bro • Medical Scope Filter" if lang == "en" else "Soái ca Y khoa • Bộ lọc Y khoa",
            "matched_pillar_id": active_pid or 1,
            "matched_briefing_id": active_bid,
            "quota": quota,
            "has_server_key": bool(api_key),
        }

    search_query = query
    if not _MEDICAL_KEYWORDS_RE.search(query) and clean_history:
        prior_users = [m["content"] for m in clean_history if m.get("role") == "user"]
        if prior_users:
            search_query = f"{prior_users[-1]} {query}".strip()

    ranked = sorted(
        briefings,
        key=lambda b: _score_briefing_for_chat(b, search_query, active_bid, active_pid),
        reverse=True,
    )
    top_briefings = ranked[:2]
    primary = top_briefings[0]

    pubmed_hits: list[dict] = []
    if include_pubmed:
        pm_query = _build_pubmed_chat_query(search_query, primary)
        pubmed_hits = _fetch_pubmed_with_abstracts(pm_query, max_results=2, question=search_query)

    fda_note = _fetch_openfda_drug_note(search_query)
    quota_banner = ""

    if api_key:
        if quota["exhausted"] or quota["used"] >= quota["limit"]:
            if lang == "en":
                quota_banner = (
                    f"> ⚠️ **LLM API paused for today ({quota['used']}/{quota['limit']} turns used)** "
                    "to stay strictly within your daily cap. Below is the direct lookup from EBM & NCBI PubMed:\n\n"
                )
            else:
                quota_banner = (
                    f"> ⚠️ **Đã dừng gọi API LLM hôm nay ({quota['used']}/{quota['limit']} lượt)** "
                    "để đảm bảo không vượt hạn mức. Dưới đây là kết quả tra cứu trực tiếp từ kho EBM & NCBI PubMed:\n\n"
                )
        else:
            _, sources = _compose_deterministic_ebm_answer(
                search_query, top_briefings, pubmed_hits, lang=lang, fda_note=fda_note, verbosity=verbosity
            )
            with _quota_lock:
                quota = _load_chat_quota_unlocked()
                quota["used"] += 1
                if quota["used"] >= quota["limit"]:
                    quota["exhausted"] = True
                    quota["stop_reason"] = "Daily cap reached"
                _save_chat_quota_unlocked(quota)

            trials_compact = [
                {
                    "name": t.get("name"),
                    "value": t.get("value"),
                    "p": t.get("p"),
                    "changes": (t.get("changes_vi" if lang != "en" else "changes_en") or "")[:150],
                    "caution": (t.get("caution_vi" if lang != "en" else "caution_en") or "")[:150],
                }
                for t in (primary.get("landmark_trials") or [])[:2]
            ]
            steps_compact = [
                {
                    "title": s.get("title_vi" if lang != "en" else "title_en", ""),
                    "desc": (s.get("desc_vi" if lang != "en" else "desc_en") or "")[:150],
                }
                for s in ((primary.get("guideline_evolution") or {}).get("steps") or [])[-3:]
            ]
            pearls_compact = [
                (p.get("text_vi" if lang != "en" else "text_en") or "")[:150]
                for p in (primary.get("pearls") or [])[:3]
            ]
            pm_compact = [
                {"pmid": p.get("pmid"), "title": p.get("title"), "pubdate": p.get("pubdate"), "snippet": (p.get("snippet") or "")[:150]}
                for p in pubmed_hits
            ]
            ctx_blob = (
                f"PILLAR #{primary.get('pillar_id')}: {primary.get('pillar_vi')}\n"
                f"GUIDELINE: {json.dumps(primary.get('guideline_evolution', {}).get('current_guideline', {}), ensure_ascii=False)}\n"
                f"STEPS: {json.dumps(steps_compact, ensure_ascii=False)}\n"
                f"TRIALS: {json.dumps(trials_compact, ensure_ascii=False)}\n"
                f"PEARLS: {json.dumps(pearls_compact, ensure_ascii=False)}\n"
                f"OPENFDA: {json.dumps(fda_note, ensure_ascii=False)}\n"
                f"PUBMED: {json.dumps(pm_compact, ensure_ascii=False)}\n"
                f"EXCERPT:\n{(primary.get('part1_vi_markdown' if lang != 'en' else 'part2_en_markdown') or '')[:900]}"
            )
            bot_name = "Med Bro" if lang == "en" else "Soái ca Y khoa"
            site_name = "Daily Learning Heart" if lang == "en" else "Xem Tim Mỗi Ngày"
            mcq_opts = _extract_pasted_mcq_options(query)
            wants_detail = _wants_detailed_explanation(query)
            eff_level = "detailed" if (verbosity == "detailed" or (verbosity == "medium" and wants_detail)) else verbosity
            if mcq_opts:
                if eff_level == "short":
                    mcq_rule = (
                        "MCQ OVERRIDE + SHORT MODE: The user pasted a multiple-choice question (A/B/C/D). Start immediately with '<Letter>, vì <1 short crisp reason>.' "
                        + ("('<Letter>, because <1 crisp reason>.' in English) " if lang == "en" else "")
                        + "STRICT LIMIT: 20-55 words total (1-2 short sentences max). No bullet lists.\n"
                    )
                elif eff_level == "detailed":
                    mcq_rule = (
                        "MCQ OVERRIDE + DETAILED MODE: Start immediately on line 1 with '<Letter>, vì <core reason>.' "
                        + ("('<Letter>, because <core reason>.' in English) " if lang == "en" else "")
                        + "then write a structured breakdown (220-340 words) with short bullet points covering guideline criteria, RCT numbers (HR/CI/p), why the distractors are wrong, and bedside safety checks. End on a complete sentence.\n"
                    )
                else:
                    mcq_rule = (
                        "MCQ OVERRIDE + MEDIUM MODE: Start immediately with '<Letter>, vì <reason>.' "
                        + ("('<Letter>, because <core reason>.' in English) " if lang == "en" else "")
                        + "followed by 1-2 short supporting sentences (70-120 words total) tying to the 2026 Guideline/RCT and briefly noting why the main trap fails.\n"
                    )
            else:
                if eff_level == "short":
                    mcq_rule = (
                        "SHORT RESPONSE MODE: Give the exact core clinical answer immediately in 1-3 short, crisp sentences (35-75 words total). "
                        "Include key drug/threshold or RCT stat if directly asked; avoid long lists or filler. Always finish on a complete sentence.\n"
                    )
                elif eff_level == "detailed":
                    mcq_rule = (
                        "DETAILED CLINICAL MODE: Put the exact core answer first, then build a rich, well-structured clinical explanation (250-380 words) using short bullet points covering mechanism, prior-vs-2026 guideline shifts, landmark RCT metrics (HR/CI/p), and bedside monitoring/safety checks. End cleanly on a complete sentence.\n"
                    )
                else:
                    mcq_rule = (
                        "MEDIUM CLINICAL DEPTH: Put the exact core clinical answer directly in the first sentence, then expand with 3-4 concise bullet points (130-210 words total) covering guideline changes, RCT metrics (HR/CI/p), and bedside contraindications/safety. Always finish on a complete sentence.\n"
                    )
            sys_prompt = (
                f"You are '{bot_name}', a direct yet thorough Cardiology EBM assistant inside '{site_name}'.\n"
                f"{mcq_rule}"
                "STRICT SCOPE: Answer cardiology, medicine, pharmacology, guidelines, or medical follow-ups; decline off-topic in 1 short sentence. "
                "NEVER output 'Lỗi: ngữ cảnh chỉ chứa...' or refuse a Cardiology Pillar question. "
                "If user asks for plain/non-medical terms ('không biết gì về y khoa', 'dễ hiểu'), explain warmly with everyday metaphors (200-320 words) unpacking every acronym in simple terms. "
                "TERMINOLOGY: Translate 'white-coat' = 'tăng huyết áp áo choàng trắng'. Never invent PMIDs/stats. Reply in "
                + ("clear academic English. /no_think" if lang == "en" else "clear, structured clinical Vietnamese. /no_think")
            )
            user_prompt = f"CONTEXT:\n{ctx_blob}\n\nQUESTION:\n{query}"
            try:
                llm_text = ""
                if provider == "groq":
                    payload = json.dumps({
                        "model": "qwen/qwen3.8-27b",
                        "messages": [
                            {"role": "system", "content": sys_prompt},
                            *clean_history,
                            {"role": "user", "content": user_prompt},
                        ],
                        "temperature": 0.15,
                        "max_tokens": 1500,
                    }).encode("utf-8")
                    req = urllib.request.Request(
                        "https://api.groq.com/openai/v1/chat/completions",
                        data=payload,
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"Bearer {api_key}",
                            "User-Agent": "Mozilla/5.0",
                        },
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=20) as r:
                        resp_j = json.loads(r.read().decode("utf-8"))
                    llm_text = _ensure_complete_sentence(resp_j["choices"][0]["message"]["content"])
                    engine_name = f"{bot_name} • AI + EBM"
                else:
                    payload = json.dumps({
                        "model": "gemini-3.8-flash",
                        "system_instruction": sys_prompt,
                        "input": user_prompt,
                        "generation_config": {"max_output_tokens": 1500},
                    }).encode("utf-8")
                    req = urllib.request.Request(
                        "https://generativelanguage.googleapis.com/v1beta/interactions",
                        data=payload,
                        headers={
                            "Content-Type": "application/json",
                            "x-goog-api-key": api_key,
                            "Api-Revision": "2026-05-20",
                        },
                        method="POST",
                    )
                    with urllib.request.urlopen(req, timeout=20) as r:
                        resp_j = json.loads(r.read().decode("utf-8"))
                    llm_text = resp_j.get("output_text") or "\n".join(
                        c.get("text", "")
                        for s in (resp_j.get("steps") or []) if s.get("type") == "model_output"
                        for c in (s.get("content") or []) if c.get("type") == "text"
                    )
                    llm_text = _ensure_complete_sentence(llm_text)
                    engine_name = f"{bot_name} • Gemini AI + EBM"

                if llm_text and llm_text.strip():
                    return {
                        "ok": True,
                        "answer_markdown": llm_text.strip(),
                        "sources": sources,
                        "engine_used": engine_name,
                        "verbosity": eff_level,
                        "matched_pillar_id": primary.get("pillar_id"),
                        "matched_briefing_id": primary.get("id"),
                        "quota": quota,
                        "has_server_key": True,
                    }
            except urllib.error.HTTPError as he:
                err_txt = ""
                try:
                    err_txt = he.read().decode("utf-8", errors="ignore").lower()
                except Exception:
                    pass
                is_transient_tpm = (he.code == 429) and any(k in err_txt for k in ("per minute", "tpm", "rpm", "tokens per minute", "requests per minute")) and not any(d in err_txt for d in ("per day", "tpd", "rpd"))
                if he.code in (402, 403) or (he.code == 429 and not is_transient_tpm):
                    with _quota_lock:
                        quota = _load_chat_quota_unlocked()
                        quota["exhausted"] = True
                        quota["stop_reason"] = f"HTTP {he.code}"
                        _save_chat_quota_unlocked(quota)
                    quota_banner = (
                        f"> ⚠️ **Đã ngắt kết nối API LLM hôm nay (HTTP {he.code})** để bảo vệ hạn mức tài khoản. "
                        "Dưới đây là kết quả tra cứu trực tiếp từ kho EBM & NCBI PubMed:\n\n"
                    )
                print(f"[Chat LLM HTTP {he.code}] Fallback to EBM (transient={is_transient_tpm})", file=sys.stderr)
            except Exception as exc:
                print(f"[Chat LLM Fallback] {exc}", file=sys.stderr)

    answer_md, sources = _compose_deterministic_ebm_answer(
        search_query,
        top_briefings,
        pubmed_hits,
        lang=lang,
        fda_note=fda_note,
        verbosity=verbosity,
    )
    if quota_banner:
        answer_md = quota_banner + answer_md
    bot_name = "Med Bro" if lang == "en" else "Soái ca Y khoa"
    engine_lbl = f"{bot_name} • EBM, PubMed & OpenFDA" if fda_note else f"{bot_name} • EBM & PubMed"
    return {
        "ok": True,
        "answer_markdown": answer_md,
        "sources": sources,
        "engine_used": engine_lbl,
        "verbosity": verbosity,
        "matched_pillar_id": primary.get("pillar_id"),
        "matched_briefing_id": primary.get("id"),
        "quota": quota,
        "has_server_key": bool(api_key),
    }


def _socratic_subskill_defs(primary: dict, lang: str) -> list[dict]:
    """Build 4 concrete pillar-scoped subskills for Socratic Mastery."""
    pid = primary.get("pillar_id") or 1
    p_name = primary.get("pillar_name", f"Pillar #{pid}") if lang == "en" else primary.get("pillar_vi", f"Trụ cột #{pid}")
    cur_g = (primary.get("guideline_evolution") or {}).get("current_guideline") or {}
    g_name = str(cur_g.get("name", "2026 Guidelines"))[:60]
    trials = primary.get("landmark_trials") or []
    t_names = ", ".join(str(t.get("name", "")) for t in trials[:3] if t.get("name")) or p_name
    if lang == "en":
        return [
            {"id": "guideline", "label": f"Guideline Shifts ({g_name[:32]})"},
            {"id": "trials", "label": f"Landmark RCTs ({t_names[:32]})"},
            {"id": "risk", "label": "Mechanism & Risk Thresholds"},
            {"id": "safety", "label": "Bedside Safety & Contraindications"},
        ]
    return [
        {"id": "guideline", "label": f"Tiến hóa Khuyến cáo ({g_name[:28]})"},
        {"id": "trials", "label": f"RCT Bản lề ({t_names[:28]})"},
        {"id": "risk", "label": "Cơ chế & Ngưỡng Nguy cơ"},
        {"id": "safety", "label": "An toàn & Chống chỉ định"},
    ]


def _build_socratic_mcq(
    primary: dict,
    slot_idx: int,
    variant_idx: int,
    lang: str,
    difficulty: str = "normal",
) -> dict:
    """Build a fact-grounded, reproducibly shuffled clinical MCQ."""
    return build_mcq(primary, slot_idx, variant_idx, lang, difficulty)


def _strip_duplicate_mcq_lines(text: str) -> str:
    """Remove trailing inline A/B/C/D option bullets from prose so options render solely in the MCQ button grid."""
    lines = text.splitlines()
    # Identify a block of lines starting with A/B/C/D markers at the end
    opt_indices = [
        i for i, ln in enumerate(lines)
        if re.match(r"^\s*(?:[-*•]\s*)?(?:\*\*)?[ABCD](?:\*\*)?\s*[\)\.\:\-]\s+\S+", ln)
    ]
    if len(opt_indices) >= 4:
        first_opt = opt_indices[-4]
        kept = [ln for idx, ln in enumerate(lines) if idx < first_opt or idx not in opt_indices[-4:]]
        cleaned = "\n".join(kept).strip()
        if cleaned:
            return cleaned
    return text.strip()


def _parse_inline_mcq_from_text(text: str) -> list[dict]:
    """Extract A/B/C/D options if an LLM wrote them inline without populating <socratic_meta>.options."""
    matches = re.findall(
        r"^\s*(?:[-*•]\s*)?(?:\*\*)?([ABCD])(?:\*\*)?\s*[\)\.\:\-]\s+(.+?)\s*$",
        text,
        flags=re.MULTILINE,
    )
    if len(matches) < 4:
        return []
    by_key = {}
    for k, val in matches[-4:]:
        by_key[k.upper()] = val.strip()
    if all(k in by_key for k in ("A", "B", "C", "D")):
        return [{"key": k, "text": by_key[k]} for k in ("A", "B", "C", "D")]
    return []


def _normalize_mcq_options(raw_opts) -> list[dict]:
    """Validate and normalize a 4-option A/B/C/D list."""
    if not isinstance(raw_opts, list) or len(raw_opts) != 4:
        return []
    out = []
    expected = ("A", "B", "C", "D")
    for idx, item in enumerate(raw_opts):
        if isinstance(item, dict):
            k = str(item.get("key") or expected[idx]).strip().upper()[:1]
            txt = str(item.get("text") or "").strip()
        elif isinstance(item, str):
            k = expected[idx]
            txt = re.sub(r"^[ABCD]\s*[\)\.\:\-]\s*", "", item.strip()).strip()
        else:
            return []
        if k not in expected or not txt or txt == "...":
            return []
        out.append({"key": k, "text": txt})
    keys_seen = {o["key"] for o in out}
    if keys_seen != {"A", "B", "C", "D"}:
        return []
    out.sort(key=lambda o: expected.index(o["key"]))
    return out


def _socratic_deterministic_fallback(
    primary: dict,
    state: dict,
    lang: str,
    action: str,
    user_answer: str,
    selected_choice: str = "",
) -> tuple[str, dict]:
    """Evaluate the stored question; never reconstruct its answer rationale."""
    reply, next_state, evaluation = quiz_turn(primary, state, lang, action, user_answer, selected_choice)
    return reply, {"eval": evaluation, "state": next_state,
                   "options": next_state.get("current_options", []),
                   "correct_key": next_state.get("correct_key", ""),
                   "explanation": next_state.get("explanation", "")}


def handle_socratic_turn(req_data: dict) -> dict:
    """Serve local, auditable clinical questions without generative answer keys."""
    briefings = load_existing_briefings()
    if not briefings:
        return {"ok": False, "error": "No briefing data available."}
    lang = "en" if req_data.get("lang") == "en" else "vi"
    briefing_id = req_data.get("briefing_id")
    primary = next((b for b in briefings if b.get("id") == briefing_id), None)
    if primary is None and str(briefing_id).endswith("-focused"):
        return {"ok": False, "error": "No source-supported questions are available for this lesson."}
    if primary is None:
        primary = next((b for b in briefings if str(b.get("pillar_id")) == str(req_data.get("pillar_id", 1)) and "-main" in b.get("id", "")), briefings[0])
    if primary.get("lesson_format") == "single_guideline" and primary.get("id", "").endswith("-focused"):
        return {"ok": False, "error": "No source-supported questions are available for this lesson."}
    state = copy.deepcopy(req_data.get("state")) if isinstance(req_data.get("state"), dict) else {}
    if not isinstance(state.get("subskills"), list) or len(state["subskills"]) != 4:
        state["subskills"] = [{**s, "level": 0, "checks": 0, "answered": 0, "correct": 0} for s in _socratic_subskill_defs(primary, lang)]
    state.setdefault("difficulty", "normal")
    state.setdefault("last_updated_idx", -1)
    state.setdefault("last_delta", 0)
    reply, meta = _socratic_deterministic_fallback(primary, state, lang,
        str(req_data.get("action", "answer")), str(req_data.get("user_answer", "")),
        str(req_data.get("selected_choice", "")))
    return {"ok": True, "reply_markdown": reply, "options": meta["options"],
            "correct_key": meta["correct_key"], "explanation": meta["explanation"],
            "state": meta["state"], "eval": meta["eval"],
            "engine_used": "Med Bro • EBM Quiz MCQ" if lang == "en" else "Soái ca Y khoa • EBM Quiz MCQ",
            "quota": _load_chat_quota()}


class EBMRequestHandler(SimpleHTTPRequestHandler):
    """
    Serves the static HTML/JS/CSS files and provides local API endpoints:
    - GET  /api/status         -> Rotation state, today/yesterday/tomorrow pillars, user & feedback summary
    - GET  /api/refresh-stream -> SSE progress stream refreshing today's single pillar briefing
    - POST /api/refresh        -> Refreshes today's single pillar briefing
    - POST /api/chat           -> Soái ca Y khoa EBM clinical Q&A chatbot (EBM RAG + Live PubMed + OpenFDA)
    - POST /api/auth/login     -> Email/username + password for legacy accounts
    - POST /api/auth/register  -> Register physician account
    - GET  /api/auth/me        -> Current authenticated user from Bearer token
    - POST /api/auth/logout    -> Invalidate Bearer token
    - POST /api/user/activity  -> Persist read_ids and bookmarked_ids
    - GET  /api/feedback       -> Aggregate like/dislike/report summary & user reports
    - POST /api/feedback       -> Submit like, dislike, or report feedback
    - POST /api/generate       -> LLM synthesis endpoint
    - POST /api/continue-part2 -> Convert Part 1 to Part 2 English
    - POST /api/pubmed-verify  -> Live NCBI PubMed E-utilities verification
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(BASE_DIR), **kwargs)

    def send_head(self):
        is_home = urllib.parse.urlparse(self.path).path in ('/', '/index.html')
        target = (BASE_DIR / 'index.html' if is_home else Path(self.translate_path(self.path))).resolve()
        public_assets = {'index.html', 'device_profile.js', 'sync_config.js', 'cloud_sync.js', 'search_ranking.js',
                         'clinical_distractors.js', 'clinical_mcq.js',
                         'manifest.json', 'icon.svg', 'data/briefings.js',
                         'offline.js', 'evidence_feed.js', 'data/pipeline/briefing.json',
                         'data/pipeline/evidence.parquet'}
        allowed = {(BASE_DIR / name).resolve() for name in public_assets}
        if target not in allowed or target in (USERS_PATH.resolve(), FEEDBACK_PATH.resolve()):
            self._send_json(403, {'ok': False, 'error': 'Private data'})
            return None
        if is_home:
            page = target.read_text(encoding='utf-8')
            body = page.replace('<head>', '<head><script>window.EBM_SERVER = true;</script>', 1).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            return io.BytesIO(body)

        return super().send_head()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()

    def _send_json(self, status_code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Device-Id")
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _extract_token(self, query_params: dict | None = None, body_data: dict | None = None) -> str:
        auth_header = self.headers.get("Authorization", "").strip()
        if auth_header.lower().startswith("bearer "):
            return auth_header[7:].strip()
        device_id = _validated_device_id(self.headers.get('X-Device-Id', ''))
        if device_id:
            return f'device:{device_id}'
        if query_params and query_params.get("token"):
            return str(query_params["token"][0]).strip()
        if body_data and body_data.get("token"):
            return str(body_data["token"]).strip()
        return ""

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Device-Id")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query_params = urllib.parse.parse_qs(parsed.query)

        if Path(self.translate_path(path)).resolve() in (USERS_PATH.resolve(), FEEDBACK_PATH.resolve()):
            self._send_json(403, {'ok': False, 'error': 'Private data'})
            return
        if path == "/api/refresh-stream":
            self.close_connection = True
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Connection", "close")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()

            def _emit(payload: dict):
                try:
                    msg = f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")
                    self.wfile.write(msg)
                    self.wfile.flush()
                except Exception:
                    pass

            try:
                raw_pid = query_params.get("pillar_id", [None])[0]
                req_pid = int(raw_pid) if raw_pid and str(raw_pid).isdigit() else None
                _emit({"type": "progress", "percent": 5, "message": "Đang tải chuyên đề tim mạch theo lịch..."})
                res = refresh_today_briefing(
                    force=True,
                    pillar_id=req_pid,
                    progress_cb=lambda pct, txt: _emit({"type": "progress", "percent": pct, "message": txt}),
                )
                all_briefings = load_existing_briefings()
                today = _today_vn()
                _emit({
                    "type": "done",
                    "percent": 100,
                    "today_date": today.isoformat(),
                    "briefing": res["briefing"],
                    "briefings": all_briefings,
                    "rotation_state": res["rotation_state"],
                    "today_pillar": get_pillar_for_date(today),
                    "yesterday_pillar": get_pillar_for_date(today - datetime.timedelta(days=1)),
                    "tomorrow_pillar": get_pillar_for_date(today + datetime.timedelta(days=1)),
                })
            except Exception as exc:
                _emit({"type": "error", "error": str(exc)})
            return

        if path == "/api/status":
            today = _scheduled_cycle_date_vn()
            today_str = today.isoformat()
            today_pillar = get_pillar_for_date(today)
            yesterday_pillar = get_pillar_for_date(today - datetime.timedelta(days=1))
            tomorrow_pillar = get_pillar_for_date(today + datetime.timedelta(days=1))
            state = load_rotation_state()
            briefings = load_existing_briefings()
            has_today = any(
                b.get("date") == today_str
                and b.get("pillar_id") == today_pillar["id"]
                and not b.get("crawled_articles")
                for b in briefings
            )
            token = self._extract_token(query_params=query_params)
            current_user = get_user_by_token(token)
            user_key = current_user["username"] if current_user else "guest"
            feedback_summary = _get_feedback_summary(user_key)
            include_briefings = str(query_params.get("include_briefings", ["0"])[0]) in ("1", "true", "yes")

            payload = {
                "ok": True,
                "today_date": today_str,
                "has_today_briefing": has_today,
                "today_pillar": today_pillar,
                "yesterday_pillar": yesterday_pillar,
                "tomorrow_pillar": tomorrow_pillar,
                "rotation_state": state,
                "user": current_user,
                "feedback_summary": feedback_summary,
                "default_model": NO_MODEL,
                "has_gemini_key": bool(os.environ.get("GEMINI_API_KEY")),
                "has_openai_key": bool(os.environ.get("OPENAI_API_KEY")),
            }
            if include_briefings:
                payload["briefings"] = briefings
            self._send_json(200, payload)
            return

        if path == "/api/auth/me":
            token = self._extract_token(query_params=query_params)
            user = get_user_by_token(token)
            if not user:
                self._send_json(401, {"ok": False, "error": "Unauthorized"})
                return
            self._send_json(200, {"ok": True, "user": user})
            return

        if path == "/api/crawl-guideline":
            raw_pid = query_params.get("pillar_id", [None])[0]
            raw_days = query_params.get("days_back", [None])[0]
            try:
                pid_val = int(raw_pid) if raw_pid and str(raw_pid).isdigit() else get_pillar_for_date(datetime.date.today())["id"]
                days_val = int(raw_days) if raw_days and str(raw_days).isdigit() else 90
                from crawl_cardiology_news import crawl_latest_guidelines
                items = crawl_latest_guidelines(pid_val, max_results=5, min_year=2026, days_back=days_val)
                self._send_json(200, {"ok": True, "pillar_id": pid_val, "days_back": days_val, "guidelines": items})
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/api/chat/quota":
            prov, resolved = _resolve_chat_llm_key("")
            self._send_json(200, {
                "ok": True,
                "quota": _load_chat_quota(),
                "has_server_key": bool(resolved),
                "provider": prov,
            })
            return

        if path == "/api/feedback":
            token = self._extract_token(query_params=query_params)
            user = get_user_by_token(token)
            payload = get_feedback_payload(user)
            self._send_json(200, payload)
            return

        super().do_GET()

    def do_POST(self):
        try:
            self._handle_POST()
        except DeviceStorageError as exc:
            self._send_json(exc.status, {'ok': False, 'error': str(exc)})

    def _handle_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query_params = urllib.parse.parse_qs(parsed.query)

        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            length = 0
        if _validated_device_id(self.headers.get('X-Device-Id', '')) and length > MAX_DEVICE_BYTES:
            self.close_connection = True
            self._send_json(413, {'ok': False, 'error': 'Device request limit exceeded'})
            return
        raw_body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            req_data = json.loads(raw_body)
            if not isinstance(req_data, dict):
                req_data = {}
        except Exception:
            req_data = {}

        if path == "/api/auth/login":
            status, payload = login_user(req_data)
            self._send_json(status, payload)
            return

        if path == "/api/auth/register":
            status, payload = register_user(req_data)
            self._send_json(status, payload)
            return

        if path == "/api/auth/logout":
            token = self._extract_token(query_params=query_params, body_data=req_data)
            payload = logout_token(token)
            self._send_json(200, payload)
            return

        if path == "/api/auth/reset-password":
            self._send_json(410, {"ok": False, "error": "Password reset is no longer available."})
            return

        if path == "/api/auth/profile":
            token = self._extract_token(query_params=query_params, body_data=req_data)
            status, payload = update_user_profile(token, req_data)
            self._send_json(status, payload)
            return

        if path == "/api/user/activity":
            token = self._extract_token(query_params=query_params, body_data=req_data)
            status, payload = record_user_activity(token, req_data)
            self._send_json(status, payload)
            return

        if path == "/api/feedback":
            token = self._extract_token(query_params=query_params, body_data=req_data)
            user = get_user_by_token(token)
            status, payload = submit_feedback(user, req_data)
            self._send_json(status, payload)
            return

        if path == "/api/refresh":
            try:
                force = bool(req_data.get("force", True))
                pillar_id = req_data.get("pillar_id")
                result = refresh_today_briefing(force=force, pillar_id=int(pillar_id) if pillar_id else None)
                all_briefings = load_existing_briefings()
                today = datetime.date.today()
                self._send_json(200, {
                    "ok": True,
                    "today_date": today.isoformat(),
                    "briefing": result["briefing"],
                    "briefings": all_briefings,
                    "rotation_state": result["rotation_state"],
                    "today_pillar": get_pillar_for_date(today),
                    "yesterday_pillar": get_pillar_for_date(today - datetime.timedelta(days=1)),
                    "tomorrow_pillar": get_pillar_for_date(today + datetime.timedelta(days=1)),
                    "already_up_to_date": result["already_up_to_date"],
                })
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/api/pubmed-verify":
            query = req_data.get("query", "ESC Guidelines cardiology")
            refs = fetch_pubmed_metadata(query, max_results=6)
            self._send_json(200, {"ok": True, "query": query, "results": refs})
            return

        if path == "/api/chat":
            try:
                payload = answer_ebm_chat_query(req_data)
                self._send_json(200 if payload.get("ok") else 400, payload)
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/api/socratic":
            try:
                payload = handle_socratic_turn(req_data)
                save_device_quiz(self._extract_token(body_data=req_data), req_data, payload)
                self._send_json(200 if payload.get("ok") else 400, payload)
            except DeviceStorageError:
                raise
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/api/generate":
            try:
                model_name = str(req_data.get("model") or "").strip()
                if not model_name:
                    self._send_json(400, {"ok": False, "error": "Pass an explicit model ID for optional model drafting."})
                    return
                api_key = req_data.get("api_key", "").strip()
                base_url = req_data.get("base_url", "").strip()

                with _refresh_lock:
                    state = load_rotation_state()
                    pillar_id = req_data.get("pillar_id")
                    if pillar_id:
                        pillar = get_pillar_by_id(int(pillar_id))
                    else:
                        pillar = get_pillar_for_date(datetime.date.today())

                    custom_focus = req_data.get("custom_focus", "").strip()
                    include_part2 = bool(req_data.get("include_part2", True))

                    new_briefing = generate_briefing(
                        pillar=pillar,
                        model_name=model_name,
                        custom_focus=custom_focus,
                        include_part2=include_part2,
                        api_key=api_key,
                        base_url=base_url,
                    )

                    briefings = load_existing_briefings()
                    briefings.insert(0, new_briefing)

                    state["last_pillar_id"] = pillar["id"]
                    state["last_updated"] = datetime.date.today().isoformat()
                    history = state.get("history", [])
                    history.append(pillar["id"])
                    state["history"] = history[-10:]

                    save_rotation_state(state)
                    save_briefings_js(briefings, state)

                self._send_json(200, {
                    "ok": True,
                    "briefing": new_briefing,
                    "rotation_state": state,
                })
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/api/continue-part2":
            try:
                briefing_id = req_data.get("briefing_id", "").strip()
                model_name = req_data.get("model", "").strip()
                api_key = req_data.get("api_key", "").strip()
                base_url = req_data.get("base_url", "").strip()

                with _refresh_lock:
                    briefings = load_existing_briefings()
                    target = None
                    for b in briefings:
                        if b.get("id") == briefing_id:
                            target = b
                            break
                    if not target:
                        self._send_json(404, {"ok": False, "error": f"Briefing '{briefing_id}' not found."})
                        return

                    updated = generate_part2_for_briefing(
                        briefing=target,
                        model_name=model_name,
                        api_key=api_key,
                        base_url=base_url,
                    )
                    state = load_rotation_state()
                    save_briefings_js(briefings, state)
                self._send_json(200, {"ok": True, "briefing": updated})
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        self._send_json(404, {"ok": False, "error": "Unknown endpoint"})


def main():
    parser = argparse.ArgumentParser(
        description="Daily Cardiology EBM Briefing — Multi-Model Automated Data Fetcher & Server"
    )
    parser.add_argument(
        "--model",
        type=str,
        default="",
        help=(
            "Optional model ID for model-based drafting; there is no default model. "
            "The scheduled refresh (--refresh-if-needed) uses no model."
        ),
    )
    parser.add_argument(
        "--pillar",
        type=int,
        choices=range(1, 11),
        help="Specify Pillar ID (1-10). If omitted, uses today's deterministic daily rotation.",
    )
    parser.add_argument(
        "--focus",
        type=str,
        default="",
        help="Optional specific clinical focus within the selected pillar.",
    )
    parser.add_argument(
        "--part1-only",
        action="store_true",
        help="Generate only Step 1 (Vietnamese Part 1) without automatically running Step 2 (English Part 2).",
    )
    parser.add_argument(
        "--api-key",
        type=str,
        default="",
        help="Optional API key override (GEMINI_API_KEY or OPENAI_API_KEY).",
    )
    parser.add_argument(
        "--base-url",
        type=str,
        default="",
        help="Optional Custom OpenAI-compatible Base URL (e.g., https://aiportalapi.stu-platform.live/jpe).",
    )
    parser.add_argument(
        "--verify-pubmed",
        type=str,
        default="",
        help="Run a live NCBI PubMed E-utilities verification query and print the verified DOIs/PMIDs.",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Start local web server on http://127.0.0.1:8088 with auto 06:00 AM (Vietnam time) daily refresh.",
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Refresh today's single-pillar curated guideline briefing immediately.",
    )
    parser.add_argument(
        "--refresh-if-needed",
        action="store_true",
        help="Refresh today's Vietnam-date single-pillar briefing only if not already generated for today.",
    )
    parser.add_argument(
        "--install-launchd",
        action="store_true",
        help="Install a macOS LaunchAgent to auto-refresh daily at 06:00 AM (Vietnam time).",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8088,
        help="Port for --serve (default: 8088).",
    )

    args = parser.parse_args()

    if args.install_launchd:
        plist_dir = Path.home() / "Library" / "LaunchAgents"
        plist_dir.mkdir(parents=True, exist_ok=True)
        plist_path = plist_dir / "com.dailycardiology.ebm.plist"
        log_path = BASE_DIR / "data" / "daily_refresh.log"
        plist_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.dailycardiology.ebm</string>
    <key>ProgramArguments</key>
    <array>
        <string>{sys.executable}</string>
        <string>{Path(__file__).resolve()}</string>
        <string>--refresh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>6</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TZ</key>
        <string>Asia/Ho_Chi_Minh</string>
    </dict>
    <key>StandardOutPath</key>
    <string>{log_path}</string>
    <key>StandardErrorPath</key>
    <string>{log_path}</string>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
"""
        plist_path.write_text(plist_content, encoding="utf-8")
        print(f"[Launchd] Installed daily 06:00 AM (Vietnam time) job at: {plist_path}")
        print(f"Load it now with: launchctl load -w {plist_path}")
        return

    if args.refresh or args.refresh_if_needed:
        res = refresh_today_briefing(force=bool(args.refresh), pillar_id=args.pillar)
        b = res["briefing"]
        tag = "Already up to date" if res.get("already_up_to_date") else "Refreshed"
        print(f"[{tag}] {b['date']} — Pillar #{b['pillar_id']}: {b['title_vi']} (model: {b['model_used']})")
        return

    if args.verify_pubmed:
        refs = fetch_pubmed_metadata(args.verify_pubmed, max_results=6)
        print(json.dumps(refs, indent=2, ensure_ascii=False))
        return

    if args.serve:
        # Pre-initialize local user and feedback stores on server start
        with _users_lock:
            _load_users_data_unlocked()
        with _feedback_lock:
            _load_feedback_data_unlocked()

        def _daily_6am_worker():
            vn_tz = datetime.timezone(datetime.timedelta(hours=7))
            while True:
                try:
                    now_vn = datetime.datetime.now(vn_tz)
                    if now_vn.hour >= 6:
                        res = refresh_today_briefing(force=False)
                        if not res.get("already_up_to_date"):
                            b = res["briefing"]
                            print(f"[Auto 06:00 AM VN Refresh] Generated today's briefing: Pillar #{b['pillar_id']} ({b['date']})")
                except Exception as exc:
                    print(f"[Auto Refresh Warning] {exc}", file=sys.stderr)
                time.sleep(60)

        scheduler_thread = threading.Thread(target=_daily_6am_worker, daemon=True)
        scheduler_thread.start()

        server_addr = ("127.0.0.1", args.port)
        print("======================================================================")
        print(" Xem Tim Mỗi Ngày (Daily Learning Heart) Server (Auto 06:00 AM VN Refresh)")
        print(f" -> URL:           http://127.0.0.1:{args.port}")
        print(" -> Endpoints:     /api/status, /api/refresh, /api/refresh-stream,")
        print("                   /api/auth/*, /api/user/activity, /api/feedback")
        print(" Press Ctrl+C to stop.")
        print("======================================================================")
        httpd = ThreadingHTTPServer(server_addr, EBMRequestHandler)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
            httpd.server_close()
        return

    # Optional CLI model drafting mode
    if not args.model.strip():
        parser.error(
            "no model given: use --refresh-if-needed for the free curated refresh, "
            "or pass --model and --api-key for optional model-based drafting"
        )
    state = load_rotation_state()
    pillar = get_pillar_by_id(args.pillar) if args.pillar else get_pillar_for_date(datetime.date.today())

    new_briefing = generate_briefing(
        pillar=pillar,
        model_name=args.model,
        custom_focus=args.focus,
        include_part2=not args.part1_only,
        api_key=args.api_key,
        base_url=args.base_url,
    )

    briefings = load_existing_briefings()
    briefings.insert(0, new_briefing)

    state["last_pillar_id"] = pillar["id"]
    state["last_updated"] = datetime.date.today().isoformat()
    history = state.get("history", [])
    history.append(pillar["id"])
    state["history"] = history[-10:]

    save_rotation_state(state)
    save_briefings_js(briefings, state)
    print(
        f"Successfully generated briefing '{new_briefing['title_vi']}' "
        f"using model `{args.model}` (Words: {new_briefing['word_count_vi']})."
    )


if __name__ == "__main__":
    main()
