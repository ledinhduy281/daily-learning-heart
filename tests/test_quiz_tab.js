const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
assert.match(html, /id="tabReviewQuiz" role="tab" aria-controls="quizTabPanel"[^>]*>Trắc Nghiệm Ôn Tập</);
assert.match(html, /setTxt\("#tabReviewQuiz", isVi \? "Trắc Nghiệm Ôn Tập" : "Review Quiz"\)/);
assert.match(html, /id="quizTabPanel" role="tabpanel"[^>]* hidden>\s*<p[^>]*>[^<]*<\/p>\s*<section[^>]*id="socraticTutorSection"/);

const tab = (id, panel) => ({
  id,
  classList: {toggle: (_, value) => {}},
  getAttribute: () => panel,
  setAttribute(name, value) { this[name] = value; },
  addEventListener(name, handler) { this[name] = handler; },
  focus() { this.focused = true; },
});
const home = tab("tabStudyHome", "homeTabPanel");
const quiz = tab("tabReviewQuiz", "quizTabPanel");
const nodes = {homeTabPanel: {hidden: false}, quizTabPanel: {hidden: true}, socraticTutorSection: {hidden: true}};
const document = {querySelectorAll: () => [home, quiz], getElementById: id => nodes[id]};
const session = {started: false, question_index: 0};
let starts = 0;
const SocraticTutor = {
  getSession: () => session,
  startDiagnostic() { starts++; session.started = true; },
};
vm.runInNewContext([
  html.slice(html.indexOf("    function showStudyTab"), html.indexOf("    function bindAppEvents")),
  "SocraticTutor.startIfIdle = ({",
  html.match(/      startIfIdle\(\) \{[\s\S]*?\n      \},/)[0],
  "}).startIfIdle; bindStudyTabs();",
].join("\n"), {document, SocraticTutor, window: {scrollTo() {}}});

quiz.click();
assert.equal(nodes.homeTabPanel.hidden, true);
assert.equal(nodes.quizTabPanel.hidden, false);
assert.equal(starts, 0, "no source: opening the quiz tab must not start a quiz");
home.click();
nodes.socraticTutorSection.hidden = false;
home.keydown({key: "ArrowRight", preventDefault() {}});
assert.equal(quiz["aria-selected"], "true");
assert.equal(quiz.tabIndex, 0);
assert.equal(home.tabIndex, -1);
assert.equal(quiz.focused, true);
assert.equal(starts, 1);

session.question_index = 1;
home.click();
assert.equal(home["aria-selected"], "true");
assert.equal(nodes.homeTabPanel.hidden, false);
assert.equal(nodes.quizTabPanel.hidden, true);
quiz.click();
assert.equal(quiz["aria-selected"], "true");
assert.equal(nodes.quizTabPanel.hidden, false);
assert.equal(starts, 1, "returning to the quiz must not restart it");
assert.equal(session.question_index, 1);
console.log("Bilingual review tab, keyboard navigation, and in-progress quiz preservation: OK");
