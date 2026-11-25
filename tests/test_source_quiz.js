const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {spawnSync} = require("node:child_process");
const quiz = require("../clinical_mcq.js");
const scope = {window: {}};
vm.runInNewContext(fs.readFileSync(require.resolve("../data/briefings.js"), "utf8"), scope);
const bundle = scope.window.EBM_BRIEFINGS_DATA;
const published = bundle.briefings.filter(b => b.date >= bundle.lesson_gate_start);
const lessons = [...Object.values(bundle.focused_lessons), ...published];
const lesson = published.find(b => b.date === bundle.lesson_gate_start && b.lesson_format === "single_guideline");
const item = lesson.quiz_items[0];
for (const mutation of [{quote: ""}, {pmid: "bad"}, {pmid: "32871100"}, {answer: "000"},
    {start: item.start + 1}, {distractors: [item.answer, "12%", "13%"]},
    {distractors: ["1.0%", "1.00%", "13%"]}]) {
  assert.equal(quiz.hasSourceItems({...lesson, quiz_items: [{...item, ...mutation}]}), false);
}
assert.equal(quiz.hasSourceItems({...lesson, quiz_source_texts: {}}), false);
assert.equal(quiz.hasSourceItems({...lesson, supporting_evidence: {...lesson.supporting_evidence, recommendation_id: "other"}}), false);
assert.ok(bundle.briefings.filter(b => b.date < bundle.lesson_gate_start).every(b => !quiz.hasSourceItems(b)));
for (const recent of lessons.filter(b => b.lesson_format === "single_source")) {
  const guideline = recent.primary_source.kind === "guideline";
  assert.equal(quiz.hasSourceItems(recent), !guideline, recent.id);
  if (guideline) continue;
  assert.ok(recent.quiz_items.every(q => q.pmid === recent.primary_source.pmid));
  assert.equal(quiz.hasSourceItems({...recent, primary_source: {...recent.primary_source, pmid: "26308684"}}), false);
  assert.equal(quiz.build(recent, 0, 0, "en").question_kind, "trial");
}
assert.ok(published.some(b => b.date === bundle.lesson_gate_start && b.lesson_provenance && quiz.hasSourceItems(b)));
const first = quiz.turn(lesson, {}, "en", "start_diagnostic");
assert.equal(first.state.revealed_source_pmid, undefined);
const q = first.state.current_question;
assert.ok(!first.reply.includes(q.source_quote));
const revealed = quiz.turn(lesson, first.state, "en", "answer", "", q.correct_key);
assert.equal(revealed.state.revealed_source_pmid, "26308684");
assert.ok(revealed.reply.includes(q.source_quote));
const next = revealed.state.current_question;
assert.equal(next.options.find(o => o.key === "A").text, "0.60");
assert.equal(next.correct_key, "B");
assert.equal(next.options.find(o => o.key === next.correct_key).text, "0.50");
const wrong = quiz.turn(lesson, revealed.state, "en", "answer", "", "A");
assert.equal(wrong.state.current_question.question, next.question);

const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
assert.doesNotMatch(html, /\.socratic-choice-btn:hover/);
const tutorCode = html.match(/const SocraticTutor = \{[\s\S]*?\n    \};/)[0];
const sourceLabelCode = html.match(/function curatedSourceLabel\(isVi\) \{[\s\S]*?\n    \}/)[0];
const nodes = Object.fromEntries(["socraticTutorSection", "socraticChoicesWrap", "socraticChoicesGrid"]
  .map(id => [id, {style: {}}]));
let stored;
const tutor = vm.runInNewContext(sourceLabelCode + "\n" + tutorCode + ";SocraticTutor", {
  App: {selected: lesson, currentLang: "en"}, ClinicalQuiz: quiz, escapeHtml: String,
  document: {getElementById: id => nodes[id]},
  SOCRATIC_STATE_KEY: "quiz", safeStorageGet: () => stored, safeStorageSet: (_, value) => { stored = value; },
});
tutor.renderProgressDashboard = () => {};
const getSavedSession = tutor.getSession;
const saveQuizStore = tutor.saveStore;
const highlightedChoices = state => {
  tutor.getSession = () => ({...state, started: true});
  tutor.renderUI();
  return Array.from(nodes.socraticChoicesGrid.innerHTML.matchAll(/class="socratic-choice-btn is-revealed-correct" data-choice-key="([A-D])"/g), m => m[1]);
};
assert.deepEqual(highlightedChoices(first.state), []);
assert.deepEqual(highlightedChoices(revealed.state), []);
assert.deepEqual(highlightedChoices(wrong.state), ["B"]);
const complete = quiz.turn(lesson, wrong.state, "en", "answer", "", next.correct_key);
assert.equal(complete.state.phase, "complete");
assert.equal(complete.state.correct_count, 1);
assert.match(complete.reply, /Review complete\./);
assert.deepEqual(highlightedChoices(complete.state), []);
assert.equal(nodes.socraticChoicesGrid.innerHTML, "");
tutor.saveStore = () => {};
tutor.replacePendingQuestion(wrong.state, q, "en");
assert.deepEqual(highlightedChoices(wrong.state), []);

const modified = structuredClone(first.state);
modified.current_question.options[0].text = "999";
const rejected = quiz.turn(lesson, modified, "en", "answer", "", "A");
assert.equal(rejected.state.revealed_source_pmid, undefined);
assert.equal(rejected.eval, "partial");

const sprint = lessons.find(b => b.lesson_format === "single_source" && b.primary_source.kind === "expert_consensus");
assert.equal(sprint.quiz_items.length, 1);
assert.equal(quiz.sourceQuestionCount(sprint), 1);
const sprintFirst = quiz.turn(sprint, {subskills: Array.from({length: 4}, () => ({level: 0}))}, "vi", "start_diagnostic");
const sprintComplete = quiz.turn(sprint, sprintFirst.state, "vi", "answer", "", sprintFirst.state.correct_key);
assert.equal(sprintComplete.state.phase, "complete");
assert.equal(sprintComplete.state.correct_count, 1);
assert.equal(sprintComplete.state.subskills[1].checks, 1);
assert.equal(sprintComplete.state.current_question, null);
assert.equal(quiz.turn(sprint, sprintComplete.state, "vi", "answer", "", "A").state.correct_count, 1);

const shifted = {...lesson, quiz_items: [item, item, lesson.quiz_items[1]]};
const oldQuestion = quiz.build(shifted, 1, 1, "en");
const preUpdate = {...first.state, started: true, correct_count: 1, question_index: 1, current_question: oldQuestion,
  current_options: oldQuestion.options, last_question: oldQuestion.question, correct_key: oldQuestion.correct_key,
  explanation: oldQuestion.explanation, messages: [{role: "assistant", text: oldQuestion.explanation}]};
const recovered = quiz.turn(shifted, preUpdate, "en", "answer", "", oldQuestion.correct_key);
assert.equal(recovered.eval, "partial");
assert.equal(recovered.state.correct_count, 1);
assert.equal(recovered.state.current_question.source_quote, next.source_quote);
tutor.getSubskillDefs = () => [{id: "trials", label: "Trials"}];
tutor.newQuizId = () => "test-id";
tutor.store = {[shifted.id]: preUpdate};
const resumed = getSavedSession.call(tutor, 9, shifted);
assert.equal(resumed.correct_count, 1);
assert.equal(resumed.current_question.source_quote, next.source_quote);
assert.equal(resumed.messages.length, 2);
assert.equal(quiz.turn(shifted, resumed, "en", "just_tell_me").state.question_revealed, true);
const oldRetry = quiz.build(shifted, 2, 2, "en");
const retry = {...preUpdate, question_index: 2, current_question: oldRetry, current_options: oldRetry.options,
  last_question: oldRetry.question, correct_key: oldRetry.correct_key, explanation: oldRetry.explanation,
  question_revealed: true, attempts_on_current: 1};
tutor.store[shifted.id] = structuredClone(retry);
const restoredRetry = getSavedSession.call(tutor, 9, shifted);
const apiRetry = quiz.turn(shifted, retry, "en", "answer", "", oldRetry.correct_key).state;
for (const state of [restoredRetry, apiRetry]) {
  assert.equal(state.phase, "diagnostic");
  assert.equal(state.current_question.source_quote, oldRetry.source_quote);
  assert.equal(state.question_revealed, true);
  assert.equal(state.attempts_on_current, 1);
  const done = quiz.turn(shifted, state, "en", "answer", "", state.correct_key);
  assert.equal(done.state.phase, "complete");
  assert.equal(done.state.correct_count, 1);
}

const legacyQuestion = quiz.build({}, 0, 0, "en");
stored = JSON.stringify({9: {
  started: true, phase: "loop", question_index: 5, correct_count: 3, answered_count: 4, subskills: [{level: 3}],
  current_question: legacyQuestion, current_options: legacyQuestion.options, correct_key: legacyQuestion.correct_key,
  last_question: legacyQuestion.question, explanation: legacyQuestion.explanation,
  messages: [{role: "assistant", text: legacyQuestion.question}]
}});
tutor.saveStore = saveQuizStore;
tutor.loadStore();
const adopted = getSavedSession.call(tutor, 9, lesson);
assert.equal(adopted.correct_count, 3);
assert.equal(adopted.answered_count, 4);
assert.equal(adopted.subskills[0].level, 3);
assert.equal(adopted.question_index, 0);
assert.equal(adopted.last_question, q.question);
assert.equal(adopted.messages[0].text, q.question);
assert.equal(JSON.parse(stored)[9], undefined);
assert.equal(JSON.parse(stored)[lesson.id].current_question.source_quote, q.source_quote);
assert.equal(quiz.turn(lesson, adopted, "en", "answer", "", adopted.correct_key).state.correct_count, 4);

const py = spawnSync("python3", ["-c",
  "import json,sys; from clinical_mcq import build_mcq; print(json.dumps([build_mcq(b, 1, i, l) for b in json.load(sys.stdin) for l in ['vi','en'] for i in range(len(b['quiz_items']))]))"],
  {input: JSON.stringify(lessons), encoding: "utf8"});
assert.equal(py.status, 0, py.stderr);
assert.deepEqual(lessons.flatMap(b => ["vi", "en"].flatMap(l => b.quiz_items.map((_, i) => quiz.build(b, 1, i, l)))),
  JSON.parse(py.stdout));
console.log("Validated source quiz: malformed items and saved keys rejected; bilingual Python/browser questions match");
