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
assert.equal(CaseQuiz.rejectReason({...rateCase, stem_en: kase.stem_en + " She received amiodarone 1 mg/min."}, rateGround), "");
assert.equal(CaseQuiz.rejectReason({...rateCase, stem_en: kase.stem_en + " She received amiodarone 1 mg/min.",
  stem_vi: kase.stem_vi + " Bà được truyền amiodarone 1 mg/phút."}, rateGround), "", "a translated rate unit is the same rate");
assert.equal(CaseQuiz.rejectReason({...rateCase, stem_en: kase.stem_en + " She received a 1 mg bolus of amiodarone."}, rateGround),
  "dose", "a bolus is not the quoted infusion rate");
assert.equal(CaseQuiz.rejectReason({...kase, explanation_en: "Heart failure stages B and C both fit; the hazard ratio was 0.70."},
  CaseQuiz.grounding(lesson)), "", "clinical stage letters are not option references");
for (const e of ["A and C give unsupported estimates.", "Options B, C and D are not supported.", "B and C are wrong here.", "B is correct because the abstract says so.", "Đáp án A sai vì abstract không nói vậy."])
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
const published = Array.from({length: 3}, (_, i) => ({set_id: `set-${i}`, items: [theory, theory, theory, kase, kase, kase]}));
const storage = new Map();
const {quizSets} = vm.runInNewContext(tutorCode + ";SocraticTutor", {
  CaseQuiz, ClinicalQuiz: quiz,
  window: {EBM_QUIZ_SETS: {sets: {[publishedLesson.id]: published}},
    localStorage: {getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v)}},
});
const fresh = {...publishedLesson};
assert.equal(quiz.sourceQuestionCount(fresh), 3, "the source-only fallback has three questions");
assert.equal(quiz.sourceQuestionCount(quizSets.attach(fresh)), 6, "fresh devices start with the published mixed set");
assert.equal(quizSets.remaining(fresh), 2, "loading the default set is free");
assert.equal(storage.size, 0);
const firstSet = fresh.generated_quiz;
const secondSet = quizSets.openNext(fresh);
assert.notEqual(secondSet.set_id, firstSet.set_id);
assert.equal(quizSets.attach({...publishedLesson}).generated_quiz.set_id, secondSet.set_id, "reload resumes the chosen set");
assert.equal(quizSets.remaining(fresh), 1);
assert.ok(quizSets.openNext(fresh));
assert.equal(quizSets.openNext(fresh), null);
assert.equal(quizSets.pressesLeft(), 0);
assert.equal(quizSets.attach({id: "no-published-set"}).generated_quiz, undefined);

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
    assert.equal(nodes.labelNewQuizSet.textContent,
      vi ? `Tạo câu hỏi mới bằng AI (còn ${remaining} lượt)` : `New AI questions (${remaining} left)`);
  }
}
console.log("Case quiz checks passed (grounding, fallback, mixed set, bilingual, AI label).");
