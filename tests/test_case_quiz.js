const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const CaseQuiz = require("../case_quiz.js");
const quiz = require("../clinical_mcq.js");


const scope = {window: {}};
vm.runInNewContext(fs.readFileSync(require.resolve("../data/briefings.js"), "utf8"), scope);
const lesson = scope.window.EBM_BRIEFINGS_DATA.focused_lessons["2"];
const pmid = lesson.primary_source.pmid;
const quote = lesson.quiz_source_texts[pmid].find(t => t.includes("hazard ratio"));
const options = labels => labels.map(t => ({vi: t, en: t}));
const theory = {type: "theory", pmid, quote, answer: "B",
  stem_vi: "Trong STAREE, hazard ratio của biến cố tim mạch chính với atorvastatin là bao nhiêu?",
  stem_en: "In STAREE, what was the hazard ratio for a primary cardiovascular event with atorvastatin?",
  options: options(["1.10", "0.70", "0.50", "0.94"]),
  explanation_vi: "Abstract báo cáo hazard ratio 0.70 cho biến cố tim mạch chính.",
  explanation_en: "The abstract reports a hazard ratio of 0.70 for the primary cardiovascular event."};
const kase = {...theory, type: "case", answer: "A",
  stem_vi: "Bà 74 tuổi sống tại cộng đồng, chưa có bệnh tim mạch, hỏi atorvastatin có giảm biến cố tim mạch không. Câu trả lời nào đúng với STAREE?",
  stem_en: "A 74-year-old community-dwelling woman without cardiovascular disease asks whether atorvastatin lowers cardiovascular events. Which answer fits STAREE?",
  options: options(["It reduced primary cardiovascular events", "It had no effect on events", "It increased events", "It was not tested"]),
  explanation_vi: "STAREE ghi nhận ít biến cố tim mạch chính hơn với atorvastatin (hazard ratio 0.70).",
  explanation_en: "STAREE recorded fewer primary cardiovascular events with atorvastatin (hazard ratio 0.70)."};

assert.equal(CaseQuiz.validateSet(lesson, [theory, kase]).length, 2);
assert.deepEqual(CaseQuiz.validateSet(lesson, [theory, theory]), [], "a set needs both theory and case questions");
for (const broken of [
  {quote: quote.replace("0.70", "0.65")}, {pmid: "12345"}, {type: "other"}, {answer: "E"},
  {options: options(["1.10", "0.70", "0.50"])}, {options: options(["1.10", "0.70", "0.70", "0.94"])},
  {explanation_en: "The hazard ratio was 0.55, a large effect."},
  {stem_en: "Give atorvastatin 80 mg to a 74-year-old woman; what is the hazard ratio reported in STAREE?"},
  {stem_vi: "Ngắn"},
]) assert.equal(CaseQuiz.validItem({...theory, ...broken}, CaseQuiz.grounding(lesson)), false, JSON.stringify(broken));
assert.equal(CaseQuiz.validItem({...kase, stem_en: "Short case?"}, CaseQuiz.grounding(lesson)), false);
const rateQuote = "Amiodarone was infused at 1 mg/min for six hours in every participant of the trial.";
const rateGround = {...CaseQuiz.grounding(lesson), excerpts: [rateQuote]};
const rateCase = {...kase, quote: rateQuote, explanation_vi: "Abstract cho biết tốc độ truyền amiodarone trong thử nghiệm.",
  explanation_en: "The abstract gives the amiodarone infusion rate used in the trial."};
const rateWithAnswer = {...rateCase, options: options(["1 mg/min", "0.8", "0.5", "0.3"])};
assert.equal(CaseQuiz.rejectReason({...rateWithAnswer, stem_en: kase.stem_en + " She received amiodarone 1 mg/min."}, rateGround), "");
assert.equal(CaseQuiz.rejectReason({...rateWithAnswer, stem_en: kase.stem_en + " She received amiodarone 1 mg/min.",
  stem_vi: kase.stem_vi + " Bà được truyền amiodarone 1 mg/phút."}, rateGround), "", "a translated rate unit is the same rate");
assert.equal(CaseQuiz.rejectReason({...rateWithAnswer, stem_en: kase.stem_en + " She received a 1 mg bolus of amiodarone."}, rateGround),
  "dose", "a bolus is not the quoted infusion rate");
const regimen = lesson.quiz_source_texts[pmid].find(t => t.includes("40 mg once daily"));
const dailyDose = {...kase, quote: regimen, explanation_en: "The trial used the reported regimen.",
  explanation_vi: "Nghiên cứu sử dụng liều được báo cáo.", options: options(["The reported trial regimen", "An alternative regimen", "No regimen", "Unknown regimen"]),
  stem_vi: kase.stem_vi + " Bà hỏi về atorvastatin 40\u202fmg/ngày."};
for (const dose of ["40 mg once daily", "40 mg daily", "40 mg per day", "40 mg"]) {
  assert.equal(CaseQuiz.rejectReason({...dailyDose, stem_en: kase.stem_en + " She asks about atorvastatin " + dose + "."},
    CaseQuiz.grounding(lesson)), "", dose);
}
for (const dose of ["80 mg daily", "40 mg/kg/day", "40 mg twice daily", "40 mg/min"]) {
  assert.equal(CaseQuiz.rejectReason({...dailyDose, stem_en: kase.stem_en + " She asks about atorvastatin " + dose + "."},
    CaseQuiz.grounding(lesson)), "dose", dose);
}
const stagesQuote = quote + " Heart failure stages B and C were included.";
assert.equal(CaseQuiz.rejectReason({...kase, quote: stagesQuote, explanation_en: "Heart failure stages B and C both fit; the hazard ratio was 0.70."},
  {...CaseQuiz.grounding(lesson), excerpts: [stagesQuote]}), "", "grounded clinical stage letters are not option references");
for (const e of ["A and C give unsupported estimates.", "Options B, C and D are not supported.", "B and C are wrong here.", "B is correct because the abstract says so.", "Đáp án A sai vì abstract không nói vậy."])
  assert.equal(CaseQuiz.rejectReason({...kase, explanation_en: e}, CaseQuiz.grounding(lesson)), "letters", e);
assert.equal(CaseQuiz.rejectReason({...kase, explanation_en: "A 74-year-old woman fits the population; the hazard ratio was 0.70."},
  CaseQuiz.grounding(lesson)), "claims", "the vignette alone cannot ground a population claim");
const labCase = {...kase, stem_en: kase.stem_en + " LDL 3.2 mmol/L, creatinine 1.1 mg/dL, eGFR 58 mL/min/1.73 m2."};
assert.equal(CaseQuiz.rejectReason(labCase, CaseQuiz.grounding(lesson)), "", "lab values are not doses");
assert.equal(CaseQuiz.rejectReason({...kase, stem_en: kase.stem_en + " She receives amiodarone 1 mg/min."},
  CaseQuiz.grounding(lesson)), "dose", "an infusion rate missing from the quote is a dose");
assert.equal(CaseQuiz.validItem({...theory, quote: quote.replace(/ /g, "\u00a0")}, CaseQuiz.grounding(lesson)), true);
const durationQuote = "The source reports a blood pressure of 120 mm Hg at the end of five years of follow-up.";
const durationGround = {...CaseQuiz.grounding(lesson), excerpts: [durationQuote]};
const durationItem = {...theory, quote: durationQuote, options: options(["110", "120", "125", "130"]),
  explanation_en: "The 5-year measurement was 120mmHg.", explanation_vi: "Kết quả được báo cáo là 120 mm Hg sau 5 năm."};
assert.equal(CaseQuiz.rejectReason(durationItem, durationGround), "", "duration words and spacing do not change the numeric value");
assert.equal(CaseQuiz.rejectReason({...durationItem, explanation_en: "The value was documented after seven years."}, durationGround), "numbers");
assert.deepEqual(CaseQuiz.unsupportedNumbers({...durationItem, explanation_en: "The value reflected a 7-year assessment."}, durationGround), ["7"]);

const eventQuote = "Intensive BP lowering reduced the risk of cardiovascular events by 15% per 10-mm Hg lower SBP (relative risk [RR], 0.85; 95% CI, 0.81-0.89), without heterogeneity by CKD status.";
const liveCase = {
  type: "case", pmid: "42842238", quote: eventQuote, answer: "A",
  stem_vi: "Bệnh nhân 62 tuổi có tiền sử tăng huyết áp và bệnh thận mãn tính giai đoạn 3. Bác sĩ quyết định hạ huyết áp tâm thu (SBP) xuống mức <130 mmHg (điều trị hạ huyết áp tích cực). Dựa trên kết quả của nghiên cứu, bệnh nhân này sẽ có lợi ích gì so với việc duy trì SBP ở mức tiêu chuẩn 140 mmHg?",
  stem_en: "A 62‑year‑old patient with hypertension and stage 3 chronic kidney disease is being considered for intensive systolic blood pressure lowering to <130 mmHg versus standard control at 140 mmHg. According to the study, what benefit does the intensive strategy provide for this patient?",
  explanation_vi: "Trích đoạn 2 cho biết hạ huyết áp tích cực giảm nguy cơ sự kiện tim mạch 15% cho mỗi 10 mmHg giảm SBP, không phụ thuộc vào tình trạng CKD. Vì vậy, bệnh nhân này sẽ được hưởng lợi tương tự.",
  explanation_en: "Excerpt 2 states that intensive BP lowering reduces cardiovascular event risk by 15% per 10‑mmHg SBP reduction, regardless of CKD status. Hence the patient gains that benefit.",
  options: [
    {vi: "Giảm nguy cơ tử vong do tim mạch khoảng 15% cho mỗi 10 mmHg giảm SBP", en: "Reduces cardiovascular mortality risk by about 15% per 10 mmHg SBP reduction"},
    {vi: "Giảm nguy cơ suy thận tiến triển 30%", en: "Reduces risk of CKD progression by 30%"},
    {vi: "Giảm nguy cơ suy tim cấp tính 20%", en: "Reduces risk of acute heart failure by 20%"},
    {vi: "Giảm nguy cơ tai biến mạch máu não 10%", en: "Reduces risk of stroke by 10%"},
  ],
};
const eventGround = {pmid: liveCase.pmid, title: "Cardiovascular mortality", excerpts: [eventQuote, "Other excerpt: mortality and stroke."]};
assert.equal(CaseQuiz.rejectReason(liveCase, eventGround), "claims", "the exact live case must not conflate events and mortality");
const eventOption = {vi: "Giảm biến cố tim mạch 15% cho mỗi 10 mmHg giảm SBP", en: "Reduces cardiovascular events by 15% per 10 mmHg SBP reduction"};
const grounded = {...liveCase, options: [eventOption, ...liveCase.options.slice(1)]};
assert.equal(CaseQuiz.rejectReason(grounded, eventGround), "", "translated equivalents and ungrounded distractors are allowed");
const ckdComparison = {...grounded,
  options: [{vi: "Không, lợi ích tương tự bất kể CKD", en: "No, benefit is similar regardless of CKD status"}, ...grounded.options.slice(1)],
  explanation_en: "Excerpt 2 notes a 15% reduction in cardiovascular events with intensive BP lowering and reports no heterogeneity by CKD status, indicating the benefit is similar for patients with and without CKD. Hence the correct answer is that there is no difference.",
  explanation_vi: "Trích đoạn 2 chỉ ra rằng giảm huyết áp mạnh hơn giảm nguy cơ sự kiện tim mạch 15% và không có sự khác biệt về độ đồng nhất (heterogeneity) theo tình trạng CKD, nghĩa là lợi ích tương tự ở cả hai nhóm. Vì vậy đáp án đúng là không có sự khác biệt.",
};
assert.equal(CaseQuiz.rejectReason(ckdComparison, eventGround), "", "CKD status supports both groups in the published comparison");
const expandedCkd = {...ckdComparison,
  explanation_vi: "Lợi ích tương tự ở bệnh nhân có bệnh thận mạn và bệnh nhân không có bệnh thận mạn.",
};
assert.equal(CaseQuiz.rejectReason(expandedCkd, eventGround), "", "bệnh thận mạn is CKD, not a male population");
assert.deepEqual(CaseQuiz.unsupportedClaims({...expandedCkd,
  explanation_vi: "Bệnh nhân hỏi ăn mì có làm thay đổi lợi ích không."}), [], "mì is not the clinical abbreviation MI");
assert.ok(CaseQuiz.unsupportedClaims({...expandedCkd, explanation_vi: "Trích đoạn báo cáo giảm MI."}).includes("myocardial_infarction"),
  "a genuine standalone clinical acronym still counts in Vietnamese");
assert.ok(CaseQuiz.unsupportedClaims({...expandedCkd, explanation_en: "The trial enrolled one man."}).includes("men"),
  "man still denotes the population in English");
assert.ok(CaseQuiz.unsupportedClaims({...expandedCkd,
  quote: "Lợi ích tương tự ở bệnh nhân có bệnh thận mạn và bệnh nhân không có bệnh thận mạn.",
  explanation_en: "The benefit was seen in a man with CKD."}).includes("men"), "Vietnamese source text does not supply the English population");
assert.deepEqual(CaseQuiz.unsupportedClaims({...expandedCkd,
  explanation_en: "The wording is not a criticism of the study's management."}), [], "MI and man do not match inside other words");
for (const [field, explanation] of [
  ["explanation_en", "The treatment reduced cardiovascular events but not cardiovascular mortality."],
  ["explanation_en", "The excerpt reports cardiovascular events, not cardiovascular mortality."],
  ["explanation_vi", "Trích đoạn nói về biến cố tim mạch, không phải tử vong do tim mạch."],
  ["explanation_en", "There was no cardiovascular mortality benefit."],
]) {
  assert.equal(CaseQuiz.rejectReason({...grounded, [field]: explanation}, eventGround), "claims",
    "negation does not ground an outcome absent from the excerpt");
}
for (const [lang, value, claim] of [
  ["vi", liveCase.options[0].vi, "mortality"], ["en", liveCase.options[0].en, "cardiovascular_mortality"],
  ["en", "Risk of myocardial infarction was reduced.", "myocardial_infarction"],
  ["vi", "Giảm nguy cơ đột quỵ và nhập viện.", "hospitalization"],
  ["vi", "Chỉ áp dụng cho phụ nữ mắc bệnh thận mạn.", "women"],
  ["en", "Applies only in patients with stage 3 CKD.", "stage 3"],
  ["en", "The absolute risk reduction was 15%.", "absolute_risk_reduction"],
]) {
  const tested = {...grounded, [`explanation_${lang}`]: value};
  assert.equal(CaseQuiz.rejectReason(tested, eventGround), "claims", value);
  assert.ok(CaseQuiz.unsupportedClaims(tested).includes(claim), value);
}
const viOnly = {...grounded, options: [{...eventOption, vi: liveCase.options[0].vi}, ...grounded.options.slice(1)]};
assert.equal(CaseQuiz.rejectReason(viOnly, eventGround), "claims", "a wrong endpoint in either language invalidates the option");
const eventLesson = {quiz_mode: "source_excerpt", primary_source: {pmid: liveCase.pmid}, quiz_source_texts: {[liveCase.pmid]: eventGround.excerpts}};
const otherItems = [2, 3].map(i => ({...grounded, stem_vi: grounded.stem_vi + ` (Tình huống ${i})`,
  stem_en: grounded.stem_en + ` (Vignette ${i})`}));
const eventSet = {version: CaseQuiz.CASE_SET_VERSION, set_id: "2026-11-26-grounding-regression"};
assert.ok(CaseQuiz.validateCaseSet(eventLesson, {...eventSet, items: [grounded, ...otherItems]}));
assert.equal(CaseQuiz.validateCaseSet(eventLesson, {...eventSet, items: [liveCase, ...otherItems]}), null,
  "the browser cannot attach the already published pack with the bad case");
console.log("Bilingual clinical claims: exact live mortality mismatch, unsupported populations and qualifiers rejected: OK");

const withdrawnRenalCase = {
  "type": "case",
  "pmid": "42842238",
  "quote": "Intensive BP lowering increased risk of 30% or greater and 40% or greater declines by 42% (RR, 1.42; 95% CI, 1.28-1.58) and 47% (RR, 1.47; 95% CI, 1.30-1.66).",
  "answer": "A",
  "stem_vi": "Một bệnh nhân 55 tuổi không có bệnh thận mạn đang được điều trị hạ huyết áp mạnh (giảm SBP 12 mmHg). Bác sĩ lo ngại về nguy cơ suy giảm chức năng thận. Theo phân tích, nguy cơ suy giảm eGFR ≥30 % so với tiêu chuẩn tăng bao nhiêu phần trăm?",
  "stem_en": "A 55‑year‑old patient without chronic kidney disease is undergoing intensive blood pressure lowering (12 mmHg SBP reduction). The physician worries about kidney function decline. According to the meta‑analysis, the risk of a ≥30% eGFR decline compared with standard treatment increases by how many percent?",
  "explanation_vi": "Trích đoạn 3 cho biết hạ huyết áp mạnh làm tăng nguy cơ suy giảm eGFR ≥30 % lên 42 % (RR 1.42).",
  "explanation_en": "Excerpt 3 reports that intensive BP lowering raises the risk of a ≥30% eGFR decline by 42% (RR 1.42).",
  "options": [
    {
      "vi": "42 %",
      "en": "42%"
    },
    {
      "vi": "15 %",
      "en": "15%"
    },
    {
      "vi": "0 % (không thay đổi)",
      "en": "0% (no change)"
    },
    {
      "vi": "-15 % (giảm)",
      "en": "-15% (decrease)"
    }
  ]
};
const renalGround = {pmid: withdrawnRenalCase.pmid, title: "", excerpts: [withdrawnRenalCase.quote]};
assert.equal(CaseQuiz.rejectReason(withdrawnRenalCase, renalGround), "claims", "the withdrawn case adds an unnamed eGFR endpoint");
assert.ok(CaseQuiz.unsupportedClaims(withdrawnRenalCase).includes("egfr"));
const unresolved = CaseQuiz.unsupportedCaseEffects(withdrawnRenalCase);
assert.ok(unresolved.includes("without_ckd not covered by the citation"));
assert.ok(unresolved.includes("eGFR endpoint not cited"));
assert.ok(unresolved.includes("absolute risk level 42%"));
const scopedQuote = "Among patients with CKD, intensive BP lowering increased risk of an eGFR decline of at least 30% by 42% (RR, 1.42).";
const scopedGround = {...renalGround, excerpts: [scopedQuote]};
const scopedCase = {...withdrawnRenalCase, quote: scopedQuote,
  explanation_vi: "Hạ huyết áp tích cực làm tăng 42% nguy cơ suy giảm eGFR ≥30% (RR 1.42).",
};
assert.equal(CaseQuiz.rejectReason(scopedCase, scopedGround), "effects", "a CKD-only result cannot answer a non-CKD vignette");
assert.equal(CaseQuiz.rejectReason({...scopedCase,
  stem_en: scopedCase.stem_en.replace(" without chronic kidney disease", ""),
  stem_vi: scopedCase.stem_vi.replace(" không có bệnh thận mạn", ""),
}, scopedGround), "effects", "a CKD-only result requires the vignette to establish CKD");
const applicable = {...scopedCase,
  stem_en: scopedCase.stem_en.replace("without chronic kidney disease", "with chronic kidney disease"),
  stem_vi: scopedCase.stem_vi.replace("không có bệnh thận mạn", "có bệnh thận mạn"),
};
assert.equal(CaseQuiz.rejectReason(applicable, scopedGround), "", "the endpoint, subgroup, and relative effect are all cited");
for (const [field, explanation] of [
  ["explanation_vi", withdrawnRenalCase.explanation_vi],
  ["explanation_en", "The excerpt says that the risk increased to 42%."],
  ["explanation_en", "The excerpt reports HR 1.42 for the decline."],
]) {
  assert.equal(CaseQuiz.rejectReason({...applicable, [field]: explanation}, scopedGround), "effects",
    "an absolute risk or different ratio is not a relative risk increase");
}
assert.equal(CaseQuiz.rejectReason({...applicable, stem_en: applicable.stem_en + " The trial reported a 17% increase."},
  scopedGround), "effects", "an effect in the vignette does not support itself");
assert.equal(CaseQuiz.rejectReason({...applicable, stem_en: applicable.stem_en + " The trial reported 17 deaths."},
  scopedGround), "effects", "an absolute trial count in the stem must come from the excerpt");
const mismatchedThreshold = {...withdrawnRenalCase,
  options: [{en: "47%", vi: "47%"}, {en: "42%", vi: "42%"}, ...withdrawnRenalCase.options.slice(2)],
};
assert.ok(CaseQuiz.unsupportedCaseEffects(mismatchedThreshold).includes("47% belongs to a different decline threshold"),
  "the 47% estimate cannot answer the 30% threshold even though both values appear in the same excerpt");
const matchedRenalCase = {...withdrawnRenalCase,
  stem_en: "A clinician reviews the intensive blood pressure lowering meta-analysis. What is the reported effect on the risk of a decline of at least 30%?",
  stem_vi: "Một bác sĩ xem phân tích về hạ huyết áp tích cực. Can thiệp có tác động thế nào đến nguy cơ suy giảm ít nhất 30%?",
  explanation_en: "Intensive BP lowering increased the risk of a decline of at least 30% by 42% (RR 1.42).",
  explanation_vi: "Hạ huyết áp tích cực làm tăng 42% nguy cơ suy giảm ít nhất 30% (RR 1,42).",
};
assert.equal(CaseQuiz.rejectReason(matchedRenalCase, renalGround), "", "the paired 42% and RR 1.42 both apply to the 30% threshold");
for (const [field, matching, wrong] of [["explanation_en", "RR 1.42", "RR 1.47"], ["explanation_vi", "RR 1,42", "RR 1,47"]]) {
  const swapped = {...matchedRenalCase, [field]: matchedRenalCase[field].replace(matching, wrong)};
  assert.equal(CaseQuiz.rejectReason(swapped, renalGround), "effects", "RR 1.47 belongs to the 40% threshold, not 30%");
}
const baselines = {...matchedRenalCase,
  stem_en: "For a 63-year-old patient with EF 55%, BP 138/84 mmHg and eGFR 58, what effect on the risk of a decline of at least 30% was reported?",
  stem_vi: "Với bệnh nhân 63 tuổi có phân suất tống máu 55%, huyết áp 138/84 mmHg và eGFR 58, nghiên cứu báo cáo tác động nào đến nguy cơ suy giảm ít nhất 30%?",
};
assert.equal(CaseQuiz.rejectReason(baselines, renalGround), "", "uncited patient measurements are not study results, even in a risk question");
assert.equal(CaseQuiz.rejectReason({...baselines, stem_vi: baselines.stem_vi.normalize("NFD")}, renalGround), "",
  "Vietnamese baseline measurements match in both composed and decomposed Unicode");
const baselineOption = {
  en: "For this 63-year-old patient with EF 55%, BP 138/84 mmHg and eGFR 58, the reported risk increase was 42%.",
  vi: "Với bệnh nhân 63 tuổi có phân suất tống máu 55%, huyết áp 138/84 mmHg và eGFR 58, nguy cơ được báo cáo tăng 42%.",
};
const repeatedBaselines = {...baselines, options: [baselineOption, ...baselines.options.slice(1)]};
assert.ok(CaseQuiz.rejectReason(repeatedBaselines, renalGround), "a keyed option cannot use uncited measurements as evidence");
const followUp = "The trial found an EF of 55% at follow-up.";
assert.equal(CaseQuiz.rejectReason({...baselines, explanation_en: followUp}, renalGround), "effects",
  "the explanation must cite follow-up EF even when it equals the patient's baseline EF");
assert.equal(CaseQuiz.rejectReason({...baselines, options: [{...baselines.options[0], en: followUp}, ...baselines.options.slice(1)]}, renalGround), "effects",
  "the option must cite follow-up EF even when it equals the patient's baseline EF");
for (const [lang, claim] of [["en", "The study reported a risk of 55%."], ["vi", "Nghiên cứu báo cáo nguy cơ là 55%."]]) {
  const options = [{...baselines.options[0], [lang]: claim}, ...baselines.options.slice(1)];
  assert.equal(CaseQuiz.rejectReason({...baselines, options}, renalGround), "effects", "a baseline figure does not support a study effect");
}
for (const [lang, result] of [["en", " The study's event rate was 17%."], ["vi", " Tỷ lệ biến cố là 17%."], ["en", " The trial reported RR 1.25."]]) {
  const field = "stem_" + lang;
  assert.equal(CaseQuiz.rejectReason({...baselines, [field]: baselines[field] + result}, renalGround), "effects",
    "study rates and ratios in the stem still require support");
}
console.log("Clinical effects: withdrawn eGFR case, unsupported populations, absolute risk wording, and wrong measures rejected: OK");

const generated = {...lesson, generated_quiz: {set_id: "s1", items: [theory, kase]}};
assert.equal(quiz.sourceQuestionCount(generated), 2, "a generated set replaces the default questions");
for (const lang of ["vi", "en"]) {
  const q0 = quiz.reviewQuestion(generated, 0, 0, lang, "normal"), q1 = quiz.reviewQuestion(generated, 0, 1, lang, "normal");
  assert.match(q0.question, lang === "vi" ? /^Lý thuyết/ : /^Theory/);
  assert.match(q1.question, lang === "vi" ? /^Tình huống lâm sàng/ : /^Clinical case/);
  assert.equal(q0.options.find(o => o.key === q0.correct_key).text, "0.70");
  assert.ok(q1.explanation.includes(CaseQuiz.AI_NOTE[lang]) && q1.explanation.includes(quote));
  assert.equal(q1.subskill_idx, 3);
  assert.equal(quiz.translate(generated, q1, lang === "vi" ? "en" : "vi").correct_key, q1.correct_key);
}
let state = quiz.turn(generated, {subskills: [0, 1, 2, 3].map(() => ({level: 0}))}, "vi", "start_diagnostic").state;
for (let i = 0; i < 2; i++) state = quiz.turn(generated, state, "vi", "answer", state.correct_key).state;
assert.equal(state.phase, "complete");
assert.equal(state.correct_count, 2);

const invalidSet = {...lesson, generated_quiz: {set_id: "s2", items: [theory]}};
assert.equal(quiz.sourceQuestionCount(invalidSet), quiz.sourceQuestionCount(lesson), "an invalid set falls back to the verbatim quiz");
const daily = {...lesson, case_quiz_items: [kase, {...kase, quote: "invented"}]};
assert.equal(quiz.sourceQuestionCount(daily), quiz.sourceQuestionCount(lesson) + 1, "valid daily case items follow the verbatim quiz");
const guideline = {...scope.window.EBM_BRIEFINGS_DATA.focused_lessons["1"], quiz_items: [], quiz_status: "awaiting_physician_excerpts"};
assert.equal(quiz.hasSourceItems({...guideline, generated_quiz: {set_id: "s3", items: [theory, kase]}}), false);

const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
const tutorCode = html.match(/const SocraticTutor = \{[\s\S]*?\n    \};/)[0];
const escapeHtmlCode = html.match(/    function escapeHtml\(str\) \{[\s\S]*?\n    \}/)[0];
const escapeHtml = vm.runInNewContext(escapeHtmlCode + ";escapeHtml");
const nodes = {btnNewQuizSet: {style: {}}, labelNewQuizSet: {}};
const App = {selected: generated};
const tutor = vm.runInNewContext(escapeHtmlCode + "\n" + tutorCode + ";SocraticTutor", {
  App, CaseQuiz, ClinicalQuiz: quiz, document: {getElementById: id => nodes[id]},
});
const publishedLesson = {...lesson, id: "daily-fixture"};
const published = Array.from({length: 3}, (_, i) => ({version: CaseQuiz.CASE_SET_VERSION, set_id: `set-${i}`,
  items: Array.from({length: 3}, (_, j) => ({...kase, stem_en: kase.stem_en + ` (Case ${i}-${j})`,
    stem_vi: kase.stem_vi + ` (Ca ${i}-${j})`}))}));
const storage = new Map();
const publishedTutor = vm.runInNewContext(tutorCode + ";SocraticTutor", {
  CaseQuiz, ClinicalQuiz: quiz,
  window: {EBM_QUIZ_SETS: {sets: {[publishedLesson.id]: published}},
    localStorage: {getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v)}},
});
const {quizSets} = publishedTutor;
const fresh = {...publishedLesson};
const offlineTheory = quiz.sourceCourse(fresh).items;
assert.ok(offlineTheory.length >= 3 && offlineTheory.every(q => q.type === "theory"));
const firstBank = quiz.sourceCourse(quizSets.attach(fresh));
assert.equal(firstBank.items.length, offlineTheory.length + 3, "fresh devices start with theory plus three cases");
assert.equal(quizSets.remaining(fresh), 2, "loading the default set is free");
assert.equal(storage.has(quizSets.pressKey), false);
const firstSet = fresh.generated_quiz;
const secondSet = quizSets.openNext(fresh);
assert.notEqual(secondSet.set_id, firstSet.set_id);
assert.deepEqual(quiz.sourceCourse(fresh).items.filter(q => q.type === "theory"), offlineTheory, "the new-set button swaps only the cases");
assert.equal(quizSets.attach({...publishedLesson}).generated_quiz.set_id, secondSet.set_id, "reload resumes the chosen set");
assert.equal(quizSets.remaining(fresh), 1);
assert.ok(quizSets.openNext(fresh));
assert.equal(quizSets.openNext(fresh), null);
assert.equal(quizSets.pressesLeft(), 0);
assert.equal(quizSets.attach({id: "no-published-set"}).generated_quiz, undefined);
storage.clear();
const first = quizSets.attach({...publishedLesson});
assert.equal(quizSets.openNext(first).set_id, "set-1");
published.splice(0, 3, published[1], {...published[0], set_id: "replacement-a"}, {...published[2], set_id: "replacement-b"});
const resumed = quizSets.attach({...publishedLesson});
assert.equal(resumed.generated_quiz.set_id, "set-1", "refill preserves the selected retained set");
assert.equal(quizSets.pressesLeft(), 1, "resuming does not spend a press");
assert.equal(quizSets.openNext(resumed).set_id, "replacement-a");
assert.equal(quizSets.openNext(resumed), null, "deduplication does not restore used quota");

storage.set(quizSets.key, JSON.stringify({[publishedLesson.id]: {index: 1}}));
storage.set(quizSets.pressKey, JSON.stringify({date: quizSets.today(), used: 1}));
publishedTutor.store[publishedLesson.id + "#set-1"] = {course: {compact: true}};
assert.equal(quizSets.attach({...publishedLesson}).generated_quiz.set_id, "set-1", "legacy index migrates from the retained course's ID");
assert.equal(quizSets.pressesLeft(), 1);
assert.equal(JSON.parse(storage.get(quizSets.key))[publishedLesson.id].selected, "set-1");
console.log("Quiz pack selection: refill and legacy migration preserve retained set and daily quota: OK");

tutor.quizSets.attach = b => b;
tutor.quizSets.available = () => [generated.generated_quiz];
tutor.quizSourceLabel = () => "";
tutor.renderProgressDashboard = () => {};
for (const lang of ["vi", "en"]) {
  const vi = lang === "vi";
  const first = quiz.turn(generated, {}, lang, "start_diagnostic").state;
  const wrongKey = first.current_options.find(o => o.key !== first.correct_key).key;
  const retry = quiz.turn(generated, first, lang, "answer", wrongKey);
  const hint = tutor.renderTranscriptMessage({role: "assistant", text: retry.reply, source_pmid: retry.state.revealed_source_pmid}, retry.state, 2, vi);
  assert.match(hint, vi ? /Chưa đúng\. Thử lại:/ : /Not quite\. Try again:/);
  assert.doesNotMatch(hint, /Correct answer|Đáp án đúng|<blockquote>|pubmed\.ncbi/);
  assert.equal(retry.state.question_revealed, false);
  assert.equal(retry.state.question_index, first.question_index);
  assert.equal(retry.state.attempts_on_current, 1);
  assert.deepEqual(retry.state.current_options, first.current_options);
  const secondMiss = quiz.turn(generated, retry.state, lang, "answer", wrongKey);
  assert.ok(secondMiss.reply.includes(quote));
  assert.equal(secondMiss.state.revealed_source_pmid, pmid);
  assert.equal(secondMiss.state.question_revealed, true);
  assert.equal(secondMiss.state.answered_count, 1);
  const assisted = quiz.turn(generated, retry.state, lang, "answer", first.correct_key);
  assert.equal(assisted.state.question_index, 1);
  assert.equal(assisted.state.correct_count, 0);
  assert.equal(assisted.eval, "partial");

  const turn = quiz.turn(generated, first, lang, "answer", first.correct_key);
  const saved = {role: "assistant", text: turn.reply, source_pmid: turn.state.revealed_source_pmid};
  const markup = tutor.renderTranscriptMessage(saved, turn.state, 2, vi);
  const [feedback, questionCard] = markup.split('<div class="socratic-transcript-card socratic-question-card">');
  assert.match(feedback, vi ? /<h2>Đáp án đúng: [A-D]\.<\/h2>/ : /<h2>Correct answer: [A-D]\.<\/h2>/);
  assert.ok(feedback.includes(escapeHtml(theory["explanation_" + lang])));
  assert.ok(feedback.includes(`<blockquote>“${escapeHtml(quote)}”</blockquote>`));
  assert.ok(feedback.includes(`href="https://pubmed.ncbi.nlm.nih.gov/${pmid}/"`));
  assert.ok(feedback.includes(CaseQuiz.AI_NOTE[lang]));
  assert.ok(!feedback.includes(escapeHtml(kase["stem_" + lang])));
  assert.match(questionCard, vi ? /<h2>Câu 2\/2 · Tình huống lâm sàng<\/h2>/ : /<h2>Question 2\/2 · Clinical case<\/h2>/);
  assert.ok(questionCard.includes(escapeHtml(kase["stem_" + lang])));
  assert.doesNotMatch(questionCard, /<blockquote>|<a href=/);
  const complete = quiz.turn(generated, turn.state, lang, "answer", turn.state.correct_key);
  const completion = tutor.renderTranscriptMessage({role: "assistant", text: complete.reply}, complete.state, 2, vi);
  assert.match(completion, vi ? /Hoàn tất ôn tập\./ : /Review complete\./);
  assert.doesNotMatch(completion, /socratic-question-card/);
  App.currentLang = lang;
  tutor.getSession = () => turn.state;
  for (const remaining of [2, 0]) {
    tutor.quizSets.remaining = () => remaining;
    tutor.renderUI();
    assert.equal(nodes.btnNewQuizSet.disabled, remaining === 0);
    assert.equal(nodes.labelNewQuizSet.textContent,
      vi ? `Tạo câu hỏi mới bằng AI (còn ${remaining} lượt)` : `New AI questions (${remaining} left)`);
  }
}
console.log("Case quiz checks passed (grounding, fallback, mixed set, bilingual, AI label).");
