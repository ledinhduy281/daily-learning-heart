"""Bilingual editorial walkthroughs for the focused lesson catalog."""

import re
from pathlib import Path


DIRECTORY = Path(__file__).with_name("lessons")
GUIDELINE_SECTIONS = ("context", "evolution", "application")
EVIDENCE_SECTIONS = ("design", "findings", "interpretation")
PEARL_SECTIONS = ("guideline_pearls", "evidence_pearls")
SECTION_KEYS = (*GUIDELINE_SECTIONS, *EVIDENCE_SECTIONS, *PEARL_SECTIONS)
TEACHING_LABELS = {
    "vi": dict(zip(SECTION_KEYS, (
        "Vì sao câu hỏi này quan trọng", "Khuyến cáo đã thay đổi thế nào", "Áp dụng và theo dõi",
        "Nghiên cứu được thiết kế ra sao", "Kết quả thực sự cho thấy gì", "Có thể và không thể suy rộng",
        "GUIDELINE EVOLUTION", "LANDMARK TRIAL",
    )), pearls="Điểm cần nhớ khi đi buồng"),
    "en": dict(zip(SECTION_KEYS, (
        "Why this question matters", "How the recommendation evolved", "Application and monitoring",
        "How the study was designed", "What the results actually showed", "What to apply and what not to extrapolate",
        "GUIDELINE EVOLUTION", "LANDMARK TRIAL",
    )), pearls="Take-home points for rounds"),
}


def load_teaching(recommendation_id):
    path = DIRECTORY / f"{recommendation_id}.md"
    header, *languages = re.split(r"^# (vi|en)\s*\n", path.read_text(encoding="utf-8"), flags=re.M)
    guideline_pmid, trial_pmid = header.split()
    notes = {"guideline_pmid": guideline_pmid, "trial_pmid": trial_pmid}
    for index in range(0, len(languages), 2):
        lang, body = languages[index:index + 2]
        preamble, *parts = re.split(r"^## ([a-z_]+)\s*\n", body, flags=re.M)
        if preamble.strip() or tuple(parts[::2]) != SECTION_KEYS or lang in notes:
            raise ValueError(f"Invalid editorial sections in {path.name} ({lang})")
        notes[lang] = {
            key: text.strip().splitlines() if key in PEARL_SECTIONS
            else [paragraph.strip() for paragraph in text.strip().split("\n\n")]
            for key, text in zip(parts[::2], parts[1::2])
        }
    return notes


def teaching_markdown(notes, language, keys):
    labels = TEACHING_LABELS[language]
    return "".join(f"\n\n### {labels[key]}\n\n" + "\n\n".join(notes[language][key]) for key in keys)


def pearls_markdown(notes, language):
    labels = TEACHING_LABELS[language]
    items = [f"- **[{labels[key]}]** {item}" for key in PEARL_SECTIONS for item in notes[language][key]]
    return f"\n\n## {labels['pearls']}\n\n" + "\n".join(items)
