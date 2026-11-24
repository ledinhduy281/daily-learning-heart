"""Curated cardiology topics and their primary guidelines for daily rotation."""

import datetime

from focused_evidence import EVIDENCE

# Organization prefixes apply to guidelines, not to evidence about a recommendation.
SOURCE_PRIORITY = ("guideline", "systematic_review_meta_analysis", "landmark_rct",
                   "real_world_cohort_registry", "expert_consensus")
GUIDELINE_SOCIETIES = {"ESC", "ACC/AHA"}

LESSONS = {
    1: [{
        "recommendation_id": "sbp-target",
        "guideline": ("ESC", 2024, "39210715", "10.1093/eurheartj/ehae178",
                      "2024 ESC Guidelines for the management of elevated blood pressure and hypertension"),
        "title": ("Huyết áp tâm thu khi điều trị: mục tiêu và khả năng dung nạp", "On-treatment systolic blood pressure: target and tolerability"),
        "recommendation": ("ESC hướng đến huyết áp tâm thu 120–129 mmHg khi điều trị nếu dung nạp được. Khả năng dung nạp là điều kiện, không phải chi tiết tùy chọn.",
                           "ESC recommends an on-treatment systolic blood pressure target of 120–129 mmHg if tolerated. Tolerability is part of the recommendation."),
    }],
    2: [{
        "recommendation_id": "bempedoic-statin-intolerance",
        "guideline": ("ESC", 2025, "40878289", "10.1093/eurheartj/ehaf190",
                      "2025 Focused Update of the 2019 ESC/EAS Guidelines for the management of dyslipidaemias"),
        "title": ("Axit bempedoic khi không thể dùng statin", "Bempedoic acid when statins cannot be used"),
        "recommendation": ("Bản cập nhật ESC/EAS khuyến cáo axit bempedoic để đạt mục tiêu LDL-C ở người không thể dùng statin.",
                           "The ESC/EAS update recommends bempedoic acid to achieve the LDL-C goal in patients unable to take statins."),
    }],
    3: [{
        "recommendation_id": "anoca-functional-testing",
        "guideline": ("ESC", 2024, "39210710", "10.1093/eurheartj/ehae177",
                      "2024 ESC Guidelines for the management of chronic coronary syndromes"),
        "title": ("Đau thắt ngực không do tắc nghẽn: xét nghiệm chức năng mạch vành", "Angina without obstruction: coronary functional testing"),
        "recommendation": ("ESC khuyến cáo xét nghiệm chức năng mạch vành xâm lấn ở người được chọn còn triệu chứng dù đã điều trị, khi nghi ngờ ANOCA/INOCA, để xác định kiểu rối loạn có thể điều trị.",
                           "ESC recommends invasive coronary functional testing in selected patients with suspected ANOCA/INOCA who remain symptomatic despite treatment, to identify treatable endotypes."),
    }],
    4: [{
        "recommendation_id": "post-acs-monotherapy",
        "guideline": ("ESC", 2023, "37622654", "10.1093/eurheartj/ehad191",
                      "2023 ESC Guidelines for the management of acute coronary syndromes"),
        "title": ("Kháng tiểu cầu đơn trị sau hội chứng vành cấp", "Single antiplatelet therapy after acute coronary syndromes"),
        "recommendation": ("ESC nêu có thể cân nhắc ưu tiên thuốc ức chế P2Y12 đơn trị sau 3–6 tháng kháng tiểu cầu kép ở người không có biến cố và không có nguy cơ thiếu máu cục bộ cao.",
                           "ESC advises considering single antiplatelet therapy, preferably a P2Y12 inhibitor, after 3–6 months of dual therapy in event-free patients who are not at high ischaemic risk."),
    }],
    5: [{
        "recommendation_id": "hf-lvef-above-40-sglt2",
        "guideline": ("ESC", 2023, "37622666", "10.1093/eurheartj/ehad195",
                      "2023 Focused Update of the 2021 ESC Guidelines for the diagnosis and treatment of acute and chronic heart failure"),
        "title": ("Thuốc ức chế SGLT2 trong suy tim có phân suất tống máu trên 40%", "SGLT2 inhibition in heart failure with ejection fraction above 40%"),
        "recommendation": ("Bản cập nhật ESC khuyến cáo dapagliflozin hoặc empagliflozin ở người suy tim có phân suất tống máu giảm nhẹ hoặc bảo tồn để giảm nhập viện do suy tim hoặc tử vong tim mạch.",
                           "The ESC update recommends dapagliflozin or empagliflozin in heart failure with mildly reduced or preserved ejection fraction to reduce heart failure hospitalization or cardiovascular death."),
    }, {
        "recommendation_id": "hfpef-sglt2",
        "guideline": ("ACC/AHA", 2022, "35363499", "10.1161/CIR.0000000000001063",
                      "2022 AHA/ACC/HFSA Guideline for the Management of Heart Failure: A Report of the American College of Cardiology/American Heart Association Joint Committee on Clinical Practice Guidelines"),
        "title": ("Ức chế SGLT2 trong suy tim có phân suất tống máu bảo tồn", "SGLT2 inhibition in heart failure with preserved ejection fraction"),
        "recommendation": ("AHA/ACC/HFSA nêu thuốc ức chế SGLT2 có thể có lợi ở người suy tim có phân suất tống máu bảo tồn để giảm nhập viện do suy tim và tử vong tim mạch.",
                           "AHA/ACC/HFSA states that SGLT2 inhibitors can be beneficial in HFpEF to reduce heart failure hospitalizations and cardiovascular mortality."),
    }],
    6: [{
        "recommendation_id": "early-af-rhythm-control",
        "guideline": ("ESC", 2024, "39210723", "10.1093/eurheartj/ehae176",
                      "2024 ESC Guidelines for the management of atrial fibrillation developed in collaboration with the European Association for Cardio-Thoracic Surgery (EACTS)"),
        "title": ("Kiểm soát nhịp sớm ở người mới được chẩn đoán rung nhĩ", "Early rhythm control after an atrial fibrillation diagnosis"),
        "recommendation": ("ESC nêu cân nhắc kiểm soát nhịp trong vòng 12 tháng từ chẩn đoán ở một số người có rung nhĩ và nguy cơ biến cố tim mạch.",
                           "ESC advises considering rhythm control within 12 months of diagnosis in selected patients with atrial fibrillation at risk of cardiovascular events."),
    }],
    7: [{
        "recommendation_id": "stable-endocarditis-oral-stepdown",
        "guideline": ("ESC", 2023, "37622656", "10.1093/eurheartj/ehad193",
                      "2023 ESC Guidelines for the management of endocarditis"),
        "title": ("Chuyển sang kháng sinh uống ở viêm nội tâm mạc đã ổn định", "Oral antibiotic step-down in stable endocarditis"),
        "recommendation": ("ESC cho phép cân nhắc điều trị ngoại trú bằng kháng sinh đường uống ở trường hợp viêm nội tâm mạc bên trái được chọn, đã điều trị tĩnh mạch ban đầu và ổn định lâm sàng.",
                           "ESC advises considering outpatient oral antibiotic treatment for selected clinically stable patients with left-sided endocarditis after an initial intravenous course."),
    }],
    8: [{
        "recommendation_id": "mavacamten-obstructive-hcm",
        "guideline": ("ESC", 2023, "37622657", "10.1093/eurheartj/ehad194",
                      "2023 ESC Guidelines for the management of cardiomyopathies"),
        "title": ("Ức chế myosin trong bệnh cơ tim phì đại tắc nghẽn", "Myosin inhibition in obstructive hypertrophic cardiomyopathy"),
        "recommendation": ("ESC nêu cân nhắc mavacamten bổ sung cho người trưởng thành còn triệu chứng do tắc nghẽn đường ra thất trái dù dùng điều trị ban đầu phù hợp, với theo dõi siêu âm tim.",
                           "ESC advises considering add-on mavacamten for adults with symptomatic left ventricular outflow tract obstruction despite appropriate initial treatment, with echocardiographic monitoring."),
    }],
    9: [{
        "recommendation_id": "initial-pah-combination",
        "guideline": ("ESC", 2022, "36017548", "10.1093/eurheartj/ehac237",
                      "2022 ESC/ERS Guidelines for the diagnosis and treatment of pulmonary hypertension"),
        "title": ("Điều trị phối hợp ban đầu trong tăng áp động mạch phổi", "Initial combination treatment in pulmonary arterial hypertension"),
        "recommendation": ("ESC/ERS khuyến cáo khởi đầu phối hợp thuốc đối kháng thụ thể endothelin và thuốc ức chế PDE5 ở người tăng áp động mạch phổi nguy cơ thấp hoặc trung bình, không có bệnh đồng mắc tim phổi, thuộc các nhóm căn nguyên được chỉ định trong hướng dẫn.",
                           "ESC/ERS recommends an initial endothelin receptor antagonist plus a PDE5 inhibitor in patients with low- or intermediate-risk PAH without cardiopulmonary comorbidities in the guideline's specified aetiologic groups."),
    }],
    10: [{
        "recommendation_id": "t2d-ckd-sglt2",
        "guideline": ("ESC", 2023, "37622663", "10.1093/eurheartj/ehad192",
                      "2023 ESC Guidelines for the management of cardiovascular disease in patients with diabetes"),
        "title": ("Ức chế SGLT2 trong bệnh thận mạn kèm đái tháo đường típ 2", "SGLT2 inhibition in chronic kidney disease and type 2 diabetes"),
        "recommendation": ("ESC khuyến cáo thuốc ức chế SGLT2 ở người đái tháo đường típ 2 kèm bệnh thận mạn với eGFR từ 20 mL/phút/1,73 m² để giảm nguy cơ bệnh tim mạch và suy thận.",
                           "ESC recommends an SGLT2 inhibitor in type 2 diabetes with CKD and eGFR at least 20 mL/min/1.73 m² to reduce cardiovascular and kidney failure risk."),
    }],
}


FOCUSED_EDITION_DATE = "2026-11-24"
FOCUSED_EDITION_VERSION = 2


def source_priority(kind):
    return SOURCE_PRIORITY.index(kind)


def select_guideline(pillar_id):
    eligible = [lesson for lesson in LESSONS[pillar_id] if lesson["guideline"][0] in GUIDELINE_SOCIETIES]
    return min(eligible, key=lambda lesson: (-lesson["guideline"][1], lesson["guideline"][2]))


def select_supporting_evidence(lesson, candidates=EVIDENCE):
    guideline_pmid = lesson["guideline"][2]
    recommendation_id = lesson["recommendation_id"]
    eligible = [
        candidate for candidate in candidates
        if candidate["guideline_pmid"] == guideline_pmid
        and candidate["recommendation_id"] == recommendation_id
        and candidate["pmid"] != guideline_pmid
        and candidate["source_kind"] in SOURCE_PRIORITY
        and all(len(candidate[field]) == 2 and all(candidate[field])
                for field in ("supports", "population", "limits"))
    ]
    return min(eligible, key=lambda candidate: (source_priority(candidate["source_kind"]), candidate["pmid"]), default=None)


def build_focused_lesson(pillar, date_str):
    datetime.date.fromisoformat(date_str)
    pid = pillar["id"]
    lesson = select_guideline(pid)
    society, year, pmid, doi, name = lesson["guideline"]
    guideline = {"name": name, "society": society, "year": str(year), "pmid": pmid, "doi": doi}
    briefing = {
        "id": f"ebm-{date_str}-p{pid}-focused",
        "date": date_str,
        "time": "06:00 AM",
        "pillar_id": pid,
        "pillar_name": pillar["name"],
        "pillar_vi": pillar["vi_name"],
        "content_source": "curated_library_rotation",
        "curated_edition_date": FOCUSED_EDITION_DATE,
        "model_used": "none",
        "verified_step0": False,
        "lesson_format": "single_guideline",
        "lesson_version": FOCUSED_EDITION_VERSION,
        "guideline_evolution": {"current_guideline": guideline, "recommendation_id": lesson["recommendation_id"]},
        "pubmed_anchors": [
            {"title": name, "pmid": pmid, "doi": doi, "url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/"}
        ],
    }
    evidence = select_supporting_evidence(lesson)
    if evidence:
        briefing["supporting_evidence"] = {
            **{key: value for key, value in evidence.items() if key not in ("supports", "population", "limits")},
            **{f"{key}_{lang}": evidence[key][i] for key in ("supports", "population", "limits")
               for i, lang in enumerate(("vi", "en"))},
        }
        briefing["pubmed_anchors"].append({
            "title": evidence["name"], "pmid": evidence["pmid"], "doi": evidence["doi"],
            "url": f"https://pubmed.ncbi.nlm.nih.gov/{evidence['pmid']}/",
        })
    for i, lang in enumerate(("vi", "en")):
        title, recommendation = (lesson[key][i] for key in ("title", "recommendation"))
        briefing[f"title_{lang}"] = title
        briefing[f"topic_focus_{lang}"] = title
        briefing["guideline_evolution"][f"recommendation_{lang}"] = recommendation
        block, disclaimer = (
            ("Khuyến cáo trọng tâm", "Chỉ dùng cho mục đích học tập. Đối chiếu tài liệu gốc trước khi áp dụng.")
            if lang == "vi" else
            ("Focused guideline recommendation", "For education only. Consult the original source before applying.")
        )
        body = f"## Block A — {block}\n\n**[{name}](https://doi.org/{doi})**\n\n{recommendation}"
        if evidence:
            heading = "Nghiên cứu bổ trợ" if lang == "vi" else "Supporting evidence"
            body += (
                f"\n\n## Block B — {heading}\n\n"
                f"**[{evidence['name']}](https://doi.org/{evidence['doi']})** — {evidence['journal']}\n\n"
                f"{evidence['population'][i]} {evidence['supports'][i]} ({evidence['result']}). {evidence['limits'][i]}"
            )
        briefing["part1_vi_markdown" if lang == "vi" else "part2_en_markdown"] = f"{body}\n\n*{disclaimer}*"
    briefing["word_count_vi"] = len(briefing["part1_vi_markdown"].split())
    return briefing


def build_focused_templates(pillars):
    return {str(p["id"]): build_focused_lesson(p, FOCUSED_EDITION_DATE) for p in pillars}


def build_hcm_archive_edition(pillar, date_str):
    briefing = build_focused_lesson(pillar, date_str)
    briefing["id"] = f"ebm-{date_str}-p8-main"
    briefing["curated_edition_date"] = "2026-11-13"
    briefing["guideline_evolution"]["steps"] = [
        {"era_label_vi": "Điều trị ban đầu", "era_label_en": "Initial treatment",
         "desc_vi": "Điều trị ban đầu tập trung vào kiểm soát triệu chứng bằng thuốc chẹn beta hoặc chẹn kênh canxi phù hợp.",
         "desc_en": "Initial treatment focuses on symptom control with appropriate beta-blockade or calcium channel blockade."},
        {"era_label_vi": "ESC 2023", "era_label_en": "ESC 2023",
         "desc_vi": "ESC 2023 nêu cân nhắc mavacamten bổ sung nếu vẫn có triệu chứng do tắc nghẽn dù điều trị ban đầu, với theo dõi siêu âm tim (Class IIa).",
         "desc_en": "ESC 2023 advises considering add-on mavacamten with echocardiographic monitoring for symptomatic obstruction despite initial treatment (Class IIa)."},
    ]
    evidence = briefing["supporting_evidence"]
    briefing["landmark_trials"] = [{
        "name": evidence["name"], "journal": evidence["journal"], "pmid": evidence["pmid"],
        "doi": evidence["doi"], "endpoint_label": "Exercise capacity and NYHA class at 30 weeks",
        "value": "37% vs. 17%", "ci": "Difference +19.4 pp (95% CI 8.7 to 30.1)", "p": "p = 0.0005",
        "changes_vi": evidence["supports_vi"], "changes_en": evidence["supports_en"],
        "caution_vi": "Bắt buộc theo dõi siêu âm tim; tránh dùng cùng thuốc ức chế mạnh CYP2C19.",
        "caution_en": "Mandatory echocardiographic monitoring; avoid strong CYP2C19 inhibitors.",
    }]
    return briefing
