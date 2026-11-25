"""One recent primary source per pillar, published within three months of the catalog edition."""

import datetime
import re
from pathlib import Path

from focused_quiz import build_source_quiz

RECENT_EDITION_DATE = "2026-11-25"
RECENT_START_DATE = "2026-11-25"
RECENT_LESSON_VERSION = 5
SOURCE_WINDOW_DAYS = 92
SOURCE_KINDS = ("guideline", "systematic_review_meta_analysis", "landmark_rct",
                "real_world_cohort_registry", "expert_consensus")
SECTIONS = ("summary", "design", "findings", "limits", "pearls")
DIRECTORY = Path(__file__).with_name("lessons") / "recent"
NEJM = "Copyright © 2026 Massachusetts Medical Society."

SOURCE_LABELS = {
    "vi": {"guideline": "Guideline", "systematic_review_meta_analysis": "Tổng quan hệ thống & phân tích gộp",
           "landmark_rct": "Thử nghiệm ngẫu nhiên có đối chứng", "real_world_cohort_registry": "Đoàn hệ / sổ bộ thực tế",
           "expert_consensus": "Đồng thuận chuyên gia"},
    "en": {"guideline": "Guideline", "systematic_review_meta_analysis": "Systematic review & meta-analysis",
           "landmark_rct": "Randomized controlled trial", "real_world_cohort_registry": "Real-world cohort / registry",
           "expert_consensus": "Expert consensus"},
}
SECTION_LABELS = {
    "vi": {"summary": "Nguồn này hỏi gì và kết luận gì", "design": "Thiết kế và cách đọc",
           "findings": "Kết quả chính", "limits": "Giới hạn áp dụng", "pearls": "Điểm cần nhớ khi đi buồng"},
    "en": {"summary": "What this source asks and concludes", "design": "Design and how to read it",
           "findings": "Main results", "limits": "Limits of application", "pearls": "Take-home points for rounds"},
}


def _source(pid, slug, kind, pmid, doi, name, journal, online_date, title, quiz=(), copyright="", label=""):
    return dict(pillar_id=pid, id=slug, kind=kind, pmid=pmid, doi=doi, name=name, journal=journal,
                online_date=online_date, title=title, quiz=quiz, copyright=copyright, label=label,
                physician_lines=())


SOURCES = {s["pillar_id"]: s for s in (
    _source(1, "esc-2026-cvd-ckd", "guideline", "42661426", "10.1093/eurheartj/ehag098",
            "2026 ESC Guidelines for the management of cardiovascular disease and chronic kidney disease, in collaboration with the European Renal Association (ERA)",
            "Eur Heart J", "2026-08-28",
            ("Guideline ESC 2026: bệnh tim mạch và bệnh thận mạn", "2026 ESC guideline: cardiovascular disease and chronic kidney disease"),
            label="ESC/ERA"),
    _source(2, "staree-atorvastatin-older-adults", "landmark_rct", "42670961", "10.1056/NEJMoa2607314",
            "Atorvastatin, Cardiovascular Events, and Disability-free Survival in Older Adults (STAREE)",
            "N Engl J Med", "2026-08-29",
            ("Atorvastatin phòng ngừa tiên phát ở người từ 70 tuổi (STAREE)", "Atorvastatin for primary prevention in adults aged 70 or older (STAREE)"),
            quiz=(
                "Community-dwelling adults at least [[70]] years of age with no history of cardiovascular disease, diabetes, or dementia were randomly assigned in a 1:1 ratio to receive atorvastatin at a dose of [[40]] mg once daily or identical placebo.",
                "A total of [[9971]] participants were enrolled: 4984 were assigned to receive atorvastatin and 4987 to receive placebo.",
                "After a median of [[5.9]] years, a primary cardiovascular event had occurred in 297 participants (10.9 events per 1000 person-years) in the atorvastatin group and in 412 participants (15.5 events per 1000 person-years) in the placebo group (hazard ratio, [[0.70]]; 95% confidence interval [CI], 0.61 to 0.82; P<0.001).",
            ), copyright=NEJM),
    _source(3, "esc-2026-cardiac-rehabilitation", "guideline", "42661418", "10.1093/eurheartj/ehag099",
            "2026 ESC Guidelines on cardiac rehabilitation", "Eur Heart J", "2026-08-28",
            ("Guideline ESC 2026: phục hồi chức năng tim", "2026 ESC guideline: cardiac rehabilitation"), label="ESC"),
    _source(4, "af-pci-antithrombotic-ipd-nma", "systematic_review_meta_analysis", "42669062", "10.1093/eurheartj/ehag740",
            "Antithrombotic therapy after percutaneous coronary intervention in patients with atrial fibrillation: an individual patient data network meta-analysis",
            "Eur Heart J", "2026-08-30",
            ("Kháng huyết khối sau PCI ở người rung nhĩ: phân tích gộp dữ liệu từng bệnh nhân", "Antithrombotic therapy after PCI in atrial fibrillation: individual patient data meta-analysis"),
            quiz=(
                "Six trials ([[10,634]] patients) comparing DOAC plus P2Y12 inhibitor (4,083), VKA plus single antiplatelet therapy (SAPT, 1,247), VKA plus DAPT (3,715), and DOAC plus DAPT (1,589) were included.",
                "However, [[14]]-day landmark analysis showed an increased risk of myocardial infarction and definite/probable stent thrombosis in patients receiving DOAC plus P2Y12 inhibitor or VKA plus SAPT in the early phase after PCI.",
                "DOAC plus P2Y12 inhibitor reduced intracranial hemorrhage compared with VKA plus DAPT ([[0.21]], 0.07-0.64).",
            ), copyright="© The Author(s) 2026. Published by Oxford University Press on behalf of the European Society of Cardiology. All rights reserved."),
    _source(5, "esc-2026-heart-failure", "guideline", "42661420", "10.1093/eurheartj/ehag100",
            "2026 ESC Guidelines for the management of heart failure", "Eur Heart J", "2026-08-28",
            ("Guideline ESC 2026: suy tim", "2026 ESC guideline: heart failure"), label="ESC"),
    _source(6, "laac-high-risk-af-ipd-ma", "systematic_review_meta_analysis", "43018508", "10.1016/j.jacc.2026.09.033",
            "Left Atrial Appendage Closure in Atrial Fibrillation Patients With High Risk of Stroke and Bleeding: An Individual Participant Data Meta-Analysis of Randomized Trials",
            "J Am Coll Cardiol", "2026-10-29",
            ("Đóng tiểu nhĩ trái ở rung nhĩ nguy cơ cao: phân tích gộp dữ liệu từng người", "Left atrial appendage closure in high-risk atrial fibrillation: individual participant data meta-analysis"),
            quiz=(
                "Bibliographic databases and trial registries through August 5, 2026, were searched for randomized trials comparing percutaneous LAAC with contemporary medical therapy in populations with a trial-level mean CHA2DS2-VASc score ≥[[4]].",
                "CLOSURE-AF (Left Atrial Appendage CLOSURE in Patients With Atrial Fibrillation Compared to Medical Therapy) and PRAGUE-17 (Left Atrial Appendage Closure vs. Novel Anticoagulation Agents in Atrial Fibrillation) contributed [[1,290]] participants (647 assigned to LAAC and 643 to control).",
                "The primary efficacy outcome occurred in 142 LAAC participants (21.9%) and 133 control subjects (20.7%) (adjusted HR: [[0.98]]; 95% CI: 0.77-1.24; P = 0.842).",
            ), copyright="Copyright © 2026 American College of Cardiology Foundation. Published by Elsevier Inc. All rights reserved."),
    _source(7, "poet-ii-response-tailored-antibiotics", "landmark_rct", "42663314", "10.1056/NEJMoa2607887",
            "Response-Tailored or Standard-Duration Antibiotic Treatment for Infective Endocarditis (POET II)",
            "N Engl J Med", "2026-08-28",
            ("Kháng sinh theo đáp ứng hay đủ thời gian chuẩn trong viêm nội tâm mạc (POET II)", "Response-tailored or standard-duration antibiotics for endocarditis (POET II)"),
            quiz=(
                "The primary safety end point was a composite of death from any cause, unplanned cardiac surgery, or symptomatic embolic events within 6 months after randomization (tested for noninferiority; margin, [[7.5]] percentage points).",
                "A total of [[508]] patients underwent randomization, with 255 assigned to response-tailored therapy and 253 to standard-duration therapy.",
                "Relapse occurred in 13 patients ([[5.1%]]) with tailored therapy and in 4 patients ([[1.6%]]) with standard therapy (P = 0.04).",
            ), copyright=NEJM),
    _source(8, "attr-cm-gene-silencer-ma", "systematic_review_meta_analysis", "42669065", "10.1001/jama.2026.17246",
            "Gene Silencer Therapy in Transthyretin Amyloid Cardiomyopathy: A Meta-Analysis of Outcomes Trials",
            "JAMA", "2026-08-30",
            ("Thuốc làm im lặng gene trong bệnh cơ tim amyloid transthyretin: phân tích gộp", "Gene silencer therapy in transthyretin amyloid cardiomyopathy: meta-analysis"),
            quiz=(
                "A total of 2 studies (HELIOS-B and CARDIO-TTRansform) met the inclusion criteria and included [[2086]] patients with ATTR-CM.",
                "Gene-silencing therapy reduced the primary end point by [[19%]] (RR, [[0.81]]; 95% CI, 0.69-0.94; P = .006), with no heterogeneity between trials (P for heterogeneity = .27).",
                "Treatment effects on primary end points differed according to baseline stabilizer use, with significant benefits observed among patients not receiving background stabilizer therapy (RR, [[0.69]]; 95% CI, 0.57-0.85) and no significant incremental benefit observed for those receiving concomitant stabilizer at baseline (RR, [[0.97]]; 95% CI, 0.77-1.23; P for heterogeneity = .03).",
            )),
    _source(9, "aha-2026-aortic-surgery-team", "expert_consensus", "42910416", "10.1161/CIR.0000000000001490",
            "Multidisciplinary Collaboration in the Performance of Aortic Surgery: A Scientific Statement From the American Heart Association",
            "Circulation", "2026-10-22",
            ("Phối hợp đa chuyên khoa trong phẫu thuật động mạch chủ: tuyên bố khoa học AHA", "Multidisciplinary collaboration in aortic surgery: AHA scientific statement"),
            quiz=(
                "This scientific statement is intended to approach the patient undergoing aortic surgery from [[3]] different viewpoints: that of the surgeon, the anesthesiologist, and the perfusionist.",
            ), label="AHA"),
    _source(10, "aha-acc-2026-perioperative", "guideline", "42804570", "10.1161/CIR.0000000000001472",
            "2026 AHA/ACC/ACS/ASNC/HRS/SCA/SCCT/SCMR/SVM Guideline for Perioperative Cardiovascular Management for Noncardiac Surgery",
            "Circulation", "2026-09-28",
            ("Guideline AHA/ACC 2026: xử trí tim mạch chu phẫu cho phẫu thuật ngoài tim", "2026 AHA/ACC guideline: perioperative cardiovascular management for noncardiac surgery"),
            label="AHA/ACC"),
)}


def source_age_days(source, edition_date=RECENT_EDITION_DATE):
    return (datetime.date.fromisoformat(edition_date) - datetime.date.fromisoformat(source["online_date"])).days


def is_recent(source, edition_date=RECENT_EDITION_DATE):
    return 0 <= source_age_days(source, edition_date) <= SOURCE_WINDOW_DAYS


def load_recent_teaching(slug):
    path = DIRECTORY / f"{slug}.md"
    header, *languages = re.split(r"^# (vi|en)\s*\n", path.read_text(encoding="utf-8"), flags=re.M)
    notes = {"pmid": header.strip()}
    for index in range(0, len(languages), 2):
        lang, body = languages[index:index + 2]
        preamble, *parts = re.split(r"^## ([a-z_]+)\s*\n", body, flags=re.M)
        if preamble.strip() or tuple(parts[::2]) != SECTIONS or lang in notes:
            raise ValueError(f"Invalid editorial sections in {path.name} ({lang})")
        notes[lang] = {
            key: text.strip().splitlines() if key == "pearls"
            else [paragraph.strip() for paragraph in text.strip().split("\n\n")]
            for key, text in zip(parts[::2], parts[1::2])
        }
    if set(notes) != {"pmid", "vi", "en"}:
        raise ValueError(f"{path.name} must have Vietnamese and English sections")
    return notes


def citation_url(source):
    return f"https://pubmed.ncbi.nlm.nih.gov/{source['pmid']}/"


def source_excerpts(source):
    if source["physician_lines"]:
        return [{"kind": "physician_entered", "pmid": source["pmid"], "url": citation_url(source),
                 "text": line["text"].replace("[[", "").replace("]]", ""),
                 "class": line["class"], "level": line["level"], "locator": line["locator"]}
                for line in source["physician_lines"]]
    return [{"kind": "pubmed_abstract", "pmid": source["pmid"], "url": citation_url(source),
             "text": marked.replace("[[", "").replace("]]", ""), "copyright": source["copyright"]}
            for marked in source["quiz"]]


def quiz_passages(source):
    if source["kind"] == "guideline":
        return tuple(line["text"] for line in source["physician_lines"])
    return source["quiz"]


def _escape(text):
    return re.sub(r"([\\`*_{}\[\]<>#|])", r"\\\1", text)


def citation_line(source, lang):
    labels = SOURCE_LABELS[lang]
    online = "Đăng trực tuyến" if lang == "vi" else "Published online"
    return (f"**[{_escape(source['name'])}](https://doi.org/{source['doi']})**\n\n"
            f"{labels[source['kind']]} · {source['journal']} · {online} {source['online_date']} · "
            f"[PubMed {source['pmid']}]({citation_url(source)})")


def excerpt_markdown(excerpt, lang):
    if excerpt["kind"] == "physician_entered":
        label = "Dòng khuyến cáo do bác sĩ nhập (nguyên văn)" if lang == "vi" else "Physician-entered recommendation line (verbatim)"
        meta = f"Class {_escape(excerpt['class'])} · Level {_escape(excerpt['level'])} · {_escape(excerpt['locator'])}"
    else:
        label = "Trích nguyên văn từ abstract PubMed (tiếng Anh)" if lang == "vi" else "Verbatim from the PubMed abstract"
        meta = f"[PubMed {excerpt['pmid']}]({excerpt['url']})" + (f" · {_escape(excerpt['copyright'])}" if excerpt["copyright"] else "")
    return f"\n\n**{label}**\n\n> {_escape(excerpt['text'])}\n\n{meta}"


def recent_markdown(lesson, lang):
    source, notes = lesson["primary_source"], lesson["teaching"][lang]
    labels = SECTION_LABELS[lang]
    curated = ("Biên soạn từ nguồn trích dẫn — chưa được bác sĩ duyệt" if lang == "vi"
               else "Curated from the cited source — not yet physician-reviewed")

    def sections(keys):
        return "".join(f"\n\n### {labels[key]}\n\n" + "\n\n".join(notes[key]) for key in keys)

    a = "Nguồn chính" if lang == "vi" else "Primary source"
    b = "Đọc kỹ cùng nguồn" if lang == "vi" else "Close reading of the same source"
    body = f"## Block A — {a}\n\n{citation_line(source, lang)}\n\n*{curated}*" + sections(("summary",))
    body += f"\n\n## Block B — {b}\n\n{citation_line(source, lang)}\n\n*{curated}*" + sections(("design", "findings", "limits"))
    body += "".join(excerpt_markdown(excerpt, lang) for excerpt in lesson["source_excerpts"])
    body += f"\n\n## {labels['pearls']}\n\n" + "\n".join(f"- {pearl}" for pearl in notes["pearls"])
    return f"{body}\n\n*{lesson[f'disclaimer_{lang}']}*"


def build_recent_lesson(pillar, date_str):
    datetime.date.fromisoformat(date_str)
    pid = pillar["id"]
    source = SOURCES[pid]
    public = {key: source[key] for key in ("id", "kind", "label", "name", "journal", "online_date", "pmid", "doi")}
    excerpts = source_excerpts(source)
    lesson = {
        "id": f"ebm-{date_str}-p{pid}-focused",
        "date": date_str,
        "time": "06:00 AM",
        "pillar_id": pid,
        "pillar_name": pillar["name"],
        "pillar_vi": pillar["vi_name"],
        "content_source": "recent_source_rotation",
        "curated_edition_date": RECENT_EDITION_DATE,
        "model_used": "none",
        "verified_step0": False,
        "lesson_format": "single_source",
        "lesson_version": RECENT_LESSON_VERSION,
        "primary_source": {**public, "url": citation_url(source), "window_days": SOURCE_WINDOW_DAYS},
        "teaching": load_recent_teaching(source["id"]),
        "source_excerpts": excerpts,
        "pubmed_anchors": [{"title": source["name"], "pmid": source["pmid"], "doi": source["doi"],
                            "url": citation_url(source)}],
        "lesson_provenance": {
            "primary_source": "pubmed_metadata",
            "teaching": "curated_unreviewed",
            "excerpts": excerpts[0]["kind"] if excerpts else None,
        },
    }
    passages = quiz_passages(source)
    if passages:
        lesson["quiz_mode"] = "source_excerpt"
        lesson.update(build_source_quiz(source["pmid"], passages))
    else:
        lesson["quiz_status"] = "awaiting_physician_excerpts"
        lesson["quiz_items"] = []
    for i, lang in enumerate(("vi", "en")):
        lesson[f"title_{lang}"] = source["title"][i]
        lesson[f"topic_focus_{lang}"] = source["title"][i]
        lesson[f"disclaimer_{lang}"] = ("Chỉ dùng cho mục đích học tập. Đối chiếu tài liệu gốc trước khi áp dụng."
                                        if lang == "vi" else "For education only. Consult the original source before applying.")
    lesson["part1_vi_markdown"] = recent_markdown(lesson, "vi")
    lesson["part2_en_markdown"] = recent_markdown(lesson, "en")
    lesson["word_count_vi"] = len(lesson["part1_vi_markdown"].split())
    return lesson


def build_recent_templates(pillars):
    return {str(p["id"]): build_recent_lesson(p, RECENT_EDITION_DATE) for p in pillars}
