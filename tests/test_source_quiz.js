const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {spawnSync} = require("node:child_process");
const quiz = require("../clinical_mcq.js");
const scope = {window: {}};
vm.runInNewContext(fs.readFileSync(require.resolve("../data/briefings.js"), "utf8"), scope);
const bundle = scope.window.EBM_BRIEFINGS_DATA;
const lessons = Object.values(bundle.focused_lessons);
const lesson = lessons[8], item = lesson.quiz_items[0];
for (const mutation of [{quote: ""}, {pmid: "bad"}, {pmid: "32871100"}, {answer: "000"},
    {start: item.start + 1}, {distractors: [item.answer, "12%", "13%"]},
    {distractors: ["1.0%", "1.00%", "13%"]}]) {
  assert.equal(quiz.hasSourceItems({...lesson, quiz_items: [{...item, ...mutation}]}), false);
}
assert.equal(quiz.hasSourceItems({...lesson, quiz_source_texts: {}}), false);
assert.equal(quiz.hasSourceItems({...lesson, supporting_evidence: {...lesson.supporting_evidence, recommendation_id: "other"}}), false);
assert.ok(bundle.briefings.every(b => !quiz.hasSourceItems(b)));
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
const nodes = Object.fromEntries(["btnOpenSocraticHeader", "socraticTutorSection", "socraticChoicesWrap", "socraticChoicesGrid"]
  .map(id => [id, {style: {}}]));
const tutor = vm.runInNewContext(tutorCode + ";SocraticTutor", {
  App: {selected: lesson, currentLang: "en"}, ClinicalQuiz: quiz, escapeHtml: String,
  document: {getElementById: id => nodes[id]},
});
tutor.renderProgressDashboard = () => {};
const highlightedChoices = state => {
  tutor.getSession = () => ({...state, started: true});
  tutor.renderUI();
  return Array.from(nodes.socraticChoicesGrid.innerHTML.matchAll(/class="socratic-choice-btn is-revealed-correct" data-choice-key="([A-D])"/g), m => m[1]);
};
assert.deepEqual(highlightedChoices(first.state), []);
assert.deepEqual(highlightedChoices(revealed.state), []);
assert.deepEqual(highlightedChoices(wrong.state), ["B"]);
tutor.saveStore = () => {};
tutor.replacePendingQuestion(wrong.state, q, "en");
assert.deepEqual(highlightedChoices(wrong.state), []);

const modified = structuredClone(first.state);
modified.current_question.options[0].text = "999";
const rejected = quiz.turn(lesson, modified, "en", "answer", "", "A");
assert.equal(rejected.state.revealed_source_pmid, undefined);
assert.equal(rejected.eval, "partial");

const py = spawnSync("python3", ["-c",
  "import json,sys; from clinical_mcq import build_mcq; print(json.dumps([build_mcq(b, 1, i, l) for b in json.load(sys.stdin) for l in ['vi','en'] for i in range(len(b['quiz_items']))]))"],
  {input: JSON.stringify(lessons), encoding: "utf8"});
assert.equal(py.status, 0, py.stderr);
assert.deepEqual(lessons.flatMap(b => ["vi", "en"].flatMap(l => b.quiz_items.map((_, i) => quiz.build(b, 1, i, l)))),
  JSON.parse(py.stdout));
console.log("Validated source quiz: malformed items and saved keys rejected; bilingual Python/browser questions match");
