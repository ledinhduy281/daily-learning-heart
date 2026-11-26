const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const CaseQuiz = require("../case_quiz.js");
const ClinicalQuiz = require("../clinical_mcq.js");
const {course, lesson} = require("./fixtures/socratic_course.js");

const payload = course();
const bank = CaseQuiz.validateCourse(lesson, payload);
assert.ok(bank);
for (const corrupt of [
  s => {s.items.pop();},
  s => {s.items[0].quote = s.items[0].quote.replace(" ", "  ");},
  s => {s.items[0].pmid = "1234";},
  s => {s.items[0].tier = "hard";},
  s => {s.items[1].stem_vi = s.items[0].stem_vi;},
  s => {s.items[4].hint_en = s.items[4].options[0].en + "?";},
  s => {s.items[4].hint_vi = "";},
  s => {s.items[4].skill = 1;},
  s => {s.items.at(-1).skill = 3;},
]) {
  const invalid = structuredClone(payload);
  corrupt(invalid);
  assert.equal(CaseQuiz.validateCourse(lesson, invalid), null);
}

const current = (state, lang = "vi") => CaseQuiz.courseQuestion(bank, state, lang);
const turn = (state, action, value) => CaseQuiz.courseTurn(bank, state, action, value, "vi");
const answer = (state, correct = true) => {
  const q = current(state);
  return turn(state, "answer", correct ? q.correct_key : q.options.find(o => o.key !== q.correct_key).key);
};
const advance = (state, correct = true) => turn(answer(state, correct), "next");

let state = turn(null, "restart");
assert.equal(current(state).correct_key, current(state, "en").correct_key);
for (let i = 0; i < 4; i++) {
  assert.equal(state.stage, "diagnostic");
  assert.deepEqual(turn(state, "tell"), state, "no teaching in diagnostic");
  state = advance(state);
}
assert.equal(state.stage, "practice");
assert.ok(state.skills.every(s => s.level === 0), "one diagnostic response cannot raise a level");
let placed = turn(null, "restart");
for (let i = 0; i < 4; i++) placed = advance(placed, i !== 2);
assert.equal(bank.items[placed.index].skill, 2, "diagnostic misses prioritize the first practice skill");
assert.equal(bank.items[turn(placed, "focus", 0).index].skill, 0, "the learner can override the proposed starting skill");
const first = state.index;
const wrong = answer(state, false);
assert.equal(wrong.index, first);
assert.equal(wrong.attempts, 1);
assert.equal(wrong.result, "");
assert.deepEqual(turn(wrong, "next"), wrong, "must retry before moving on");
const retryCorrect = answer(wrong);
assert.equal(retryCorrect.result, "correct");
assert.deepEqual(retryCorrect.skills.map(s => s.level), [0, 0, 0, 0], "assisted retry earns no skill credit");
const twoMisses = answer(wrong, false);
assert.equal(twoMisses.result, "wrong");
const retest = turn(twoMisses, "next");
assert.notEqual(retest.index, first, "retests with a distinct question");
assert.equal(bank.items[retest.index].skill, bank.items[first].skill);
assert.equal(retest.coached, true);

let review, unlocked = state;
while (unlocked.stage === "practice") {
  if (unlocked.review && !review) review = unlocked;
  unlocked = advance(unlocked);
}
assert.ok(review, "practice interleaves a spaced check without announcing it");
const reviewedSkill = bank.items[review.index].skill;
assert.equal(answer(review, false).skills[reviewedSkill].level, review.skills[reviewedSkill].level - 1);
assert.equal(unlocked.stage, "final");
assert.ok(unlocked.skills.every(s => s.level === 4), "two hard correct checks establish independent performance");
let failed = advance(unlocked, false);
while (failed.stage === "final") failed = advance(failed);
assert.ok(failed.finalFailed && failed.stage !== "mastered");
assert.ok(failed.skills.some(s => s.level < 4));
assert.equal(failed.stage, "final_review");
assert.deepEqual(failed.final, [{index: unlocked.index, correct: false}]);
const reviewState = failed;
failed = turn(failed, "next");
assert.equal(failed.stage, "practice", "a failed assessment leads to remediation even when the hard bank was used");
assert.deepEqual(failed.final, []);
const originalChecks = failed.skills[bank.items[failed.index].skill].checks.length;
const staleReview = {...failed, revealed: {...failed.revealed, [failed.index]: failed.history.length}};
assert.equal(answer(staleReview).skills[bank.items[failed.index].skill].level, 3,
  "a correct answer immediately after disclosure cannot restore the level");
const remediated = answer(failed);
assert.equal(remediated.skills[bank.items[failed.index].skill].checks.length, originalChecks, "a replay is not a new independent check");
failed = turn(remediated, "next");
assert.equal(failed.stage, "final", "renewed proficiency unlocks a fresh attempt");
assert.deepEqual(failed.final, []);
assert.notEqual(failed.index, unlocked.index, "retake substitutes a question whose answer was not revealed");
assert.equal(bank.items[failed.index].skill, bank.items[unlocked.index].skill);
assert.ok(!(failed.index in failed.revealed));
const retakeStart = failed;
while (failed.stage === "final") failed = advance(failed);
assert.equal(failed.stage, "mastered", "only the new attempt determines the retake result");

let integrationMiss = unlocked;
while (bank.items[integrationMiss.index].skill !== null) integrationMiss = advance(integrationMiss);
const integrationIndex = integrationMiss.index;
const originalIntegrationKey = current(integrationMiss).correct_key;
let integrationRetake = turn(advance(integrationMiss, false), "next");
const missedIntegrationAt = integrationRetake.revealed[integrationIndex];
const firstRemediation = integrationRetake;
integrationRetake = advance(integrationRetake, false);
integrationRetake = advance(integrationRetake, false);
assert.equal(integrationRetake.skills[bank.items[firstRemediation.index].skill].level, 3);
assert.notEqual(integrationRetake.index, firstRemediation.index, "just-revealed practice cannot be used again immediately");
while (integrationRetake.stage === "practice") integrationRetake = advance(integrationRetake);
assert.equal(integrationRetake.stage, "final");
while (integrationRetake.index !== integrationIndex && integrationRetake.stage === "final") {
  integrationRetake = advance(integrationRetake);
}
assert.equal(integrationRetake.index, integrationIndex, "retake still checks the integration skill");
assert.ok(new Set(integrationRetake.history.slice(missedIntegrationAt)).size >= 2);
assert.notEqual(current(integrationRetake).correct_key, originalIntegrationKey, "a reused integration item has reshuffled choices");
const prematureIntegration = {...integrationRetake,
  revealed: {...integrationRetake.revealed, [integrationIndex]: integrationRetake.history.length}};
assert.equal(advance(prematureIntegration).stage, "final_review", "an unspaced answer cannot pass the final");
assert.equal(advance(integrationRetake).stage, "mastered");
while (unlocked.stage === "final") unlocked = advance(unlocked);
assert.equal(unlocked.stage, "mastered");
assert.equal(unlocked.final.length, bank.skills.length + 1);

const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
const tutorCode = html.match(/const SocraticTutor = \{[\s\S]*?\n    \};/)[0];
const escapeHtml = html.match(/    function escapeHtml\(str\) \{[\s\S]*?\n    \}/)[0];
const escape = vm.runInNewContext(escapeHtml + ";escapeHtml");
const nodes = {
  socraticCourse: {hidden: true}, socraticTutorSection: {toggleAttribute() {}},
  socraticPhaseBadge: {}, labelNewQuizSet: {}, btnNewQuizSet: {style: {}},
};
const App = {currentLang: "vi", selected: {...lesson, id: "course-demo"}};
let saved;
const sandbox = {App, CaseQuiz, ClinicalQuiz, SOCRATIC_STATE_KEY: "socratic",
  window: {EBM_QUIZ_SETS: {sets: {[App.selected.id]: [payload, course(2), course(3)]}}},
  document: {getElementById: id => nodes[id], querySelector: () => null},
  safeStorageGet: () => saved, safeStorageSet: (_, value) => { saved = value; },
};
const buildTutor = () => {
  const tutor = vm.runInNewContext(escapeHtml + "\n" + tutorCode + ";SocraticTutor", {...sandbox});
  tutor.loadStore();
  tutor.quizSourceLabel = () => "";
  return tutor;
};
let tutor = buildTutor();
tutor.renderUI();
assert.equal(nodes.socraticCourse.hidden, false);
assert.equal(nodes.labelNewQuizSet.textContent, "Tạo câu hỏi mới bằng AI (còn 2 lượt)");
tutor.startIfIdle();
const key = tutor.sessionKey(1, App.selected);
const markup = () => nodes.socraticCourse.innerHTML;
assert.match(markup(), /Câu 1\/4/);
assert.doesNotMatch(markup(), /Bản đồ kỹ năng|<blockquote>/);
for (let i = 0; i < 4; i++) {
  tutor.courseAction("answer", current(tutor.store[key].course).correct_key);
  tutor.courseAction("next");
}
assert.match(markup(), /Bản đồ kỹ năng/);
assert.match(markup(), /0\/5/);
const question = current(tutor.store[key].course);
const wrongKey = question.options.find(o => o.key !== question.correct_key).key;
tutor.courseAction("answer", wrongKey);
assert.match(markup(), /Chưa đúng\. Thử lại:/);
assert.doesNotMatch(markup(), /<blockquote>|pubmed\.ncbi/);
tutor = buildTutor();
App.currentLang = "en";
tutor.onLanguageChanged();
assert.match(markup(), /Not quite\. Try again:/);
assert.match(markup(), /Skill map/);
tutor.courseAction("answer", wrongKey);
assert.match(markup(), /Incorrect after two attempts/);
assert.match(markup(), /<blockquote>|pubmed\.ncbi/);
assert.doesNotMatch(markup(), /data-course-action="answer"/);
for (const lang of ["vi", "en"]) {
  App.currentLang = lang;
  tutor.store[key] = {course: reviewState};
  tutor.renderUI();
  const missedIndex = reviewState.final[0].index;
  const missed = bank.items[missedIndex];
  const correct = missed.options["ABCD".indexOf(missed.answer)][lang];
  assert.match(markup(), lang === "vi" ? /Câu chưa đúng trong bài kiểm tra/ : /Missed assessment questions/);
  assert.ok(markup().includes(missed["stem_" + lang]));
  assert.ok(!markup().includes(bank.items[missedIndex + 1]["stem_" + lang]));
  assert.ok(markup().includes(correct));
  assert.ok(markup().includes(missed["explanation_" + lang]));
  assert.ok(markup().includes(`<blockquote>“${escape(missed.quote)}”</blockquote>`));
  tutor.courseAction("next");
  assert.equal(tutor.store[key].course.stage, "practice");
  assert.doesNotMatch(markup(), /<blockquote>/);
  tutor.store[key] = {course: retakeStart};
  tutor.renderUI();
  assert.match(markup(), lang === "vi" ? /Câu 1\/5/ : /Question 1\/5/);
  assert.ok(markup().includes(bank.items[retakeStart.index]["stem_" + lang]));
  assert.doesNotMatch(markup(), /<blockquote>/);
}
console.log("Socratic quiz: strict schema, independent checks, hints, spaced review, assessment, bilingual rendering, and resume: OK");
