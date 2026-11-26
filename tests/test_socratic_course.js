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
  s => {s.items.filter(q => q.phase === "practice").forEach(q => {q.type = "theory";});},
  s => {s.items.filter(q => q.phase === "practice" && q.skill === 1).forEach(q => {q.type = "theory";});},
  s => {s.items.filter(q => q.phase === "practice" && q.skill === 1).forEach(q => {q.type = "case";});},
  s => {s.items.filter(q => q.phase === "final").forEach(q => {q.type = "theory";});},
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
const missedSkill = bank.items[unlocked.index].skill;
const lowerTier = bank.items.findIndex(q => q.phase === "practice" && q.skill === missedSkill && q.tier === "medium");
const hardAlternative = bank.items.findIndex((q, i) => q.phase === "practice" && q.skill === missedSkill &&
  q.tier === "hard" && i !== remediated.index);
const retakeState = {...remediated, revealed: {...remediated.revealed}};
delete retakeState.revealed[lowerTier];
const tierBank = structuredClone(bank);
tierBank.items[lowerTier].type = tierBank.items[unlocked.index].type;
assert.equal(CaseQuiz.courseTurn(tierBank, retakeState, "next", undefined, "vi").index, failed.index,
  "an unrevealed easier item of the same kind cannot replace a hard final");
delete retakeState.revealed[hardAlternative];
const retakeStart = turn(retakeState, "next");
assert.equal(retakeStart.index, hardAlternative, "an unrevealed hard practice item replaces the revealed hard final");
assert.equal(bank.items[failed.index].tier, "hard", "with no unrevealed equivalent, use a spaced hard item");
assert.ok(failed.index in failed.revealed);
while (failed.stage === "final") failed = advance(failed);
assert.equal(failed.stage, "mastered", "only the new attempt determines the retake result");

const hardDiagnostic = bank.items.findIndex(q => q.phase === "diagnostic" && q.tier === "hard");
const diagnosticSkill = bank.items[hardDiagnostic].skill;
let diagnosticRetake = unlocked;
const diagnosticSkillFinal = bank.items.findIndex(q => q.phase === "final" && q.skill === diagnosticSkill);
while (diagnosticRetake.stage === "final") {
  diagnosticRetake = advance(diagnosticRetake, diagnosticRetake.index !== diagnosticSkillFinal);
}
diagnosticRetake = turn(diagnosticRetake, "next");
while (diagnosticRetake.stage === "practice") diagnosticRetake = advance(diagnosticRetake);
for (let i = 0; i < diagnosticSkill; i++) diagnosticRetake = advance(diagnosticRetake);
assert.ok(!(hardDiagnostic in diagnosticRetake.revealed));
assert.equal(diagnosticRetake.index, diagnosticSkillFinal, "even a hard unrevealed diagnostic cannot replace a hard final");

const caseOnlyFinal = structuredClone(bank);
const onlyCaseIndex = unlocked.index;
for (const [i, item] of caseOnlyFinal.items.entries()) {
  if (i !== onlyCaseIndex && (item.phase === "final" || item.skill === missedSkill)) item.type = "theory";
}
assert.equal(caseOnlyFinal.items[onlyCaseIndex].type, "case");
const caseRetake = {...retakeState, revealed: {...retakeState.revealed}};
const caseTurn = (state, action, value) => CaseQuiz.courseTurn(caseOnlyFinal, state, action, value, "vi");
let mixed = caseTurn(caseRetake, "next");
assert.notEqual(mixed.index, hardAlternative, "an unrevealed theory item cannot replace the only clinical case");
assert.notEqual(mixed.index, onlyCaseIndex, "defer a case disclosed too recently");
while (mixed.stage === "final") {
  mixed = caseTurn(caseTurn(mixed, "answer", CaseQuiz.courseQuestion(caseOnlyFinal, mixed, "vi").correct_key), "next");
}
assert.equal(mixed.stage, "mastered");
assert.ok(mixed.final.some(a => caseOnlyFinal.items[a.index].type === "case" && a.correct));
assert.deepEqual(new Set(mixed.final.map(a => caseOnlyFinal.items[a.index].skill)), new Set([0, 1, 2, 3, null]));

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
  socraticPhaseBadge: {}, labelStartSocratic: {}, labelNewQuizSet: {}, btnNewQuizSet: {style: {}},
};
const App = {currentLang: "vi", selected: {...lesson, lesson_format: "legacy", id: "course-demo"}};
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
const data = {window: {}};
vm.runInNewContext(fs.readFileSync(require.resolve("../data/briefings.js"), "utf8"), data);
const today = data.window.EBM_BRIEFINGS_DATA.briefings.find(b => b.id === "ebm-2026-11-26-p1-focused");
const local = ClinicalQuiz.sourceCourse(today);
assert.equal(local.items.length, 4);
assert.ok(local.items.every(q => !q.ai_generated && today.quiz_source_texts[q.pmid].includes(q.quote)));
App.selected = today;
App.currentLang = "vi";
const legacyTheory = {started: true, answered_count: 2, correct_count: 1,
  subskills: [{id: "risk", level: 2, checks: 2}], messages: [{role: "user", text: "Selected B"}]};
tutor.store[today.id] = legacyTheory;
tutor.saveStore();
tutor.renderUI();
assert.equal(nodes.labelStartSocratic.textContent, "Bắt đầu ôn tập");
tutor.startIfIdle();
const localKey = tutor.sessionKey(1, today);
assert.notEqual(localKey, today.id);
assert.deepEqual(JSON.parse(saved)[today.id], legacyTheory, "auto-starting the offline course preserves the previous session");
const localState = () => tutor.store[localKey].course;
const localQuestion = () => CaseQuiz.courseQuestion(local, localState(), App.currentLang);
const badChoice = localQuestion().options.find(o => o.key !== localQuestion().correct_key).key;
tutor.courseAction("answer", badChoice);
assert.match(markup(), /Chưa đúng\. Thử lại:/);
assert.doesNotMatch(markup(), /<blockquote>|pubmed\.ncbi/);
App.currentLang = "en";
tutor.onLanguageChanged();
assert.match(markup(), /Not quite\. Try again:/);
tutor.courseAction("answer", badChoice);
assert.match(markup(), /Incorrect after two attempts/);
assert.ok(markup().includes(`<blockquote>“${escape(local.items[0].quote)}”</blockquote>`));
tutor.courseAction("next");
for (let i = 1; i < local.items.length; i++) {
  tutor.courseAction("answer", localQuestion().correct_key);
  tutor.courseAction("next");
}
assert.equal(localState().skills[0].level, 3);
assert.match(markup(), /Spaced review/);
tutor.courseAction("answer", localQuestion().correct_key);
tutor.courseAction("next");
assert.equal(localState().stage, "final");
assert.match(markup(), /Question 1\/4/);
for (const _ of local.items) {
  tutor.courseAction("answer", localQuestion().correct_key);
  tutor.courseAction("next");
}
assert.equal(localState().stage, "mastered");
assert.equal(localState().skills[0].level, 3, "spaced repeats and final checks never confer independent mastery");
console.log("Socratic quiz: strict schema, independent checks, hints, spaced review, assessment, bilingual rendering, and resume: OK");
console.log("Offline Socratic theory: four source questions, delayed reveal, spaced review, and final without AI: OK");
