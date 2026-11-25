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
for (const e of ["Options B, C and D are not supported.", "B is correct because the abstract says so.", "Đáp án A sai vì abstract không nói vậy."])
  assert.equal(CaseQuiz.rejectReason({...kase, explanation_en: e}, CaseQuiz.grounding(lesson)), "letters", e);
assert.equal(CaseQuiz.rejectReason({...kase, explanation_en: "A 74-year-old woman fits the population; the hazard ratio was 0.70."},
  CaseQuiz.grounding(lesson)), "");
const labCase = {...kase, stem_en: kase.stem_en + " LDL 3.2 mmol/L, creatinine 1.1 mg/dL, eGFR 58 mL/min/1.73 m2."};
assert.equal(CaseQuiz.rejectReason(labCase, CaseQuiz.grounding(lesson)), "", "lab values are not doses");
assert.equal(CaseQuiz.rejectReason({...kase, stem_en: kase.stem_en + " She receives amiodarone 1 mg/min."},
  CaseQuiz.grounding(lesson)), "dose", "an infusion rate missing from the quote is a dose");
assert.equal(CaseQuiz.validItem({...theory, quote: quote.replace(/ /g, "\u00a0")}, CaseQuiz.grounding(lesson)), true);

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
console.log("Case quiz checks passed (grounding, fallback, mixed set, bilingual, AI label).");
