"""Verbatim PubMed abstract passages with selected numeric blanks."""

import re


EXCERPTS = {
    "26551272": (
        "We randomly assigned 9361 persons with a systolic blood pressure of [[130]] mm Hg or higher and an increased cardiovascular risk, but without diabetes, to a systolic blood-pressure target of less than [[120]] mm Hg (intensive treatment) or a target of less than [[140]] mm Hg (standard treatment).",
    ),
    "36876740": (
        "A total of [[13,970]] patients underwent randomization; 6992 were assigned to the bempedoic acid group and 6978 to the placebo group.",
        "The median duration of follow-up was [[40.6]] months.",
    ),
    "30266608": (
        "The primary endpoint was the mean difference in angina severity at [[6]] months (assessed by the Seattle Angina Questionnaire summary score).",
        "One hundred fifty-one (39%) patients without angiographically obstructive CAD were randomized (n = [[76]] intervention group; n = [[75]] blinded control group).",
    ),
    "31556978": (
        "We enrolled 9006 patients, and [[7119]] underwent randomization after [[3]] months.",
        "After 3 months of treatment with ticagrelor plus aspirin, patients who had not had a major bleeding event or ischemic event continued to take ticagrelor and were randomly assigned to receive aspirin or placebo for [[1]] year.",
    ),
    "36027570": (
        "We randomly assigned [[6263]] patients with heart failure and a left ventricular ejection fraction of more than [[40%]] to receive dapagliflozin (at a dose of 10 mg once daily) or matching placebo, in addition to usual therapy.",
        "Over a median of [[2.3]] years, the primary outcome occurred in 512 of 3131 patients (16.4%) in the dapagliflozin group and in 610 of 3132 patients (19.5%) in the placebo group (hazard ratio, [[0.82]]; 95% confidence interval [CI], 0.73 to 0.92; P<0.001).",
    ),
    "34449189": (
        "In this double-blind trial, we randomly assigned 5988 patients with class II-IV heart failure and an ejection fraction of more than [[40%]] to receive empagliflozin (10 mg once daily) or placebo, in addition to usual therapy.",
        "Over a median of [[26.2]] months, a primary outcome event occurred in 415 of 2997 patients (13.8%) in the empagliflozin group and in 511 of 2991 patients (17.1%) in the placebo group (hazard ratio, [[0.79]]; 95% confidence interval [CI], 0.69 to 0.90; P<0.001).",
    ),
    "32865375": (
        "In 135 centers, 2789 patients with early atrial fibrillation (median time since diagnosis, [[36]] days) underwent randomization.",
        "The trial was stopped for efficacy at the third interim analysis after a median of [[5.1]] years of follow-up per patient.",
    ),
    "30152252": (
        "In all patients, antibiotic treatment was administered intravenously for at least [[10]] days.",
        "The primary composite outcome occurred in 24 patients (12.1%) in the intravenously treated group and in 18 (9.0%) in the orally treated group (between-group difference, [[3.1]] percentage points; 95% confidence interval, -3.4 to 9.6; P=0.40), which met noninferiority criteria.",
    ),
    "32871100": (
        "In this phase 3, randomised, double-blind, placebo-controlled trial (EXPLORER-HCM) in 68 clinical cardiovascular centres in 13 countries, patients with hypertrophic cardiomyopathy with an LVOT gradient of [[50]] mm Hg or greater and New York Heart Association (NYHA) class II-III symptoms were assigned (1:1) to receive mavacamten (starting at 5 mg) or placebo for [[30]] weeks.",
    ),
    "26308684": (
        "A primary end-point event occurred in 18%, 34%, and 28% of the participants in these groups, respectively, and in [[31%]] of the pooled-monotherapy group (the two monotherapy groups combined).",
        "The hazard ratio for the primary end point in the combination-therapy group versus the pooled-monotherapy group was [[0.50]] (95% confidence interval [CI], 0.35 to 0.72; P<0.001).",
    ),
    "32970396": (
        "We randomly assigned 4304 participants with an estimated glomerular filtration rate (GFR) of [[25]] to [[75]] ml per minute per 1.73 m2 of body-surface area and a urinary albumin-to-creatinine ratio (with albumin measured in milligrams and creatinine measured in grams) of [[200]] to 5000 to receive dapagliflozin (10 mg once daily) or placebo.",
    ),
}


def build_source_quiz(pmid, marked_passages=None):
    passages, items = [], []
    for marked in EXCERPTS.get(pmid, ()) if marked_passages is None else marked_passages:
        quote = marked.replace("[[", "").replace("]]", "")
        passages.append(quote)
        for index, match in enumerate(re.finditer(r"\[\[([^\[\]]+)\]\]", marked)):
            answer = match[1]
            number = answer.rstrip("%").replace(",", "")
            decimals = len(number.partition(".")[2])
            step = max(10 ** -decimals, round(float(number) / 10, decimals))
            suffix = "%" if answer.endswith("%") else ""
            offsets = (-1, 1, 2) if float(number) >= step else (1, 2, 3)
            grouping = "," if "," in answer else ""
            distractors = [f"{float(number) + n * step:{grouping}.{decimals}f}{suffix}" for n in offsets]
            items.append({"pmid": pmid, "quote": quote, "answer": answer,
                          "start": match.start() - 4 * index, "distractors": distractors})
    return {"quiz_source_texts": {pmid: passages}, "quiz_items": items}
