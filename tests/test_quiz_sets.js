const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {main} = require("../generate_quiz_sets.js");
const CaseQuiz = require("../case_quiz.js");
const {course, lesson: template} = require("./fixtures/socratic_course.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-sets-"));
fs.mkdirSync(path.join(root, "data"));
const date = "2026-12-01", id = "ebm-2026-12-01-p2-focused";
const lesson = {...template, id, date};
const nextDate = "2026-12-02", nextId = "ebm-2026-12-02-p2-focused";
const dataPath = path.join(root, "data", "briefings.js");
const setPath = path.join(root, "data", "quiz_sets.js");
const publishLessons = briefings => fs.writeFileSync(dataPath, "window.EBM_BRIEFINGS_DATA = " + JSON.stringify({briefings}) + ";");
publishLessons([lesson]);
const philosophy = fs.readFileSync(require.resolve("../docs/quiz_philosophy.md"), "utf8");
const reply = obj => ({ok: true, status: 200, headers: {get: () => null}, json: async () => ({choices: [{message: {content: JSON.stringify(obj)}}]})});

function fakeGroq(faults = []) {
  const calls = [];
  let batch = -1, candidate;
  return {calls, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-only-placeholder");
    const [system, user] = body.messages.map(m => m.content);
    if (system.startsWith("Answer each")) {
      assert.ok(!user.includes('"answer"'), "the re-solve call does not see the key");
      assert.match(system, /ONLY its cited excerpt/);
      const stems = [...user.matchAll(/^Q\d+: (.*)$/gm)].map(m => m[1]);
      assert.deepEqual(stems, candidate.items.map(item => item.stem_en));
      assert.deepEqual([...user.matchAll(/^Cited excerpt: \[(\d+)\]$/gm)].map(m => Number(m[1])),
        candidate.items.map(item => item.excerpt));
      const answers = candidate.items.map(item => item.answer);
      if (faults[batch] === "resolve") answers[0] = "D";
      return reply({answers});
    }
    assert.ok(system.includes(philosophy), "the complete committed philosophy is embedded");
    const phase = system.match(/phase \("(diagnostic|practice|final)"\)/)[1];
    if (phase === "diagnostic") candidate = structuredClone(course(++batch + 1));
    let questions = candidate.items.filter(i => i.phase === phase).map(i => ({...i, quote: undefined}));
    if (phase === "practice") {
      const target = user.match(/REQUESTED SKILL INDICES: ([0-9]), ([0-9])/).slice(1).map(Number);
      questions = questions.filter(q => target.includes(q.skill));
    }
    if (phase === "diagnostic") {
      if (faults[batch] === "quote") questions[0].quote = "Paraphrased, not an exact excerpt.";
      if (faults[batch] === "numbers") questions[0].explanation_en = "The abstract reports a hazard ratio of 9.98.";
      if (faults[batch] === "dose") questions[1].stem_en += " She takes atorvastatin 80 mg.";
      if (faults[batch] === "count") questions.pop();
    }
    return reply({skills: candidate.skills, questions});
  }};
}
const env = {GROQ_API_KEY: "test-only-placeholder"};
const read = () => {
  const s = {window: {}};
  vm.runInNewContext(fs.readFileSync(setPath, "utf8"), s);
  return s.window.EBM_QUIZ_SETS.sets;
};
const quiet = () => {};

(async () => {
  assert.equal(await main({root, env: {}, date, log: quiet}), 0, "no key: nothing to do");
  assert.ok(!fs.existsSync(setPath));

  const g = fakeGroq(["quote", "numbers", "resolve"]);
  const logs = [];
  assert.equal(await main({root, env, date, fetchImpl: g.fetchImpl, log: m => logs.push(m)}), 3);
  const sets = read()[id];
  assert.equal(sets.length, 3);
  for (const set of sets) {
    assert.equal(set.items.length, 21);
    assert.ok(CaseQuiz.validateCourse(lesson, set));
    assert.ok(set.items.some(i => i.type === "case") && set.items.some(i => i.type === "theory"));
    assert.ok(set.items.every(i => i.ai_generated && i.pmid === lesson.primary_source.pmid &&
      lesson.quiz_source_texts[i.pmid].includes(i.quote)));
  }
  assert.equal(new Set(sets.map(s => s.set_id)).size, 3, "set ids are unique");
  const allItems = sets.flatMap(s => s.items);
  assert.equal(new Set(allItems.map(i => i.stem_en)).size, allItems.length, "no repeats");
  assert.ok(logs.some(m => /"quote":1/.test(m) && /"resolve":1/.test(m) && /"numbers":1/.test(m)), logs.join("\n"));
  assert.ok(!fs.readFileSync(setPath, "utf8").includes("test-only-placeholder"));
  assert.equal(g.calls[0].response_format.type, "json_object");

  const never = async () => assert.fail("the generator must not call the model");
  assert.equal(await main({root, env, date, fetchImpl: never, log: quiet}), 0, "three valid sets are left alone");
  assert.equal(await main({root, env, date: nextDate, fetchImpl: never, log: quiet}), 0, "no lesson for that date");

  publishLessons([lesson, {...lesson, id: nextId, date: nextDate}]);
  const broken = fakeGroq(["dose", "count", "count", "count", "count", "count"]);
  assert.equal(await main({root, env, date: nextDate, fetchImpl: broken.fetchImpl, log: m => logs.push(m)}), 0);
  assert.ok(logs.some(m => /"dose":1/.test(m) && /"count":5/.test(m)), logs.join("\n"));
  assert.equal(read()[nextId], undefined, "partial sets are never published");
  assert.equal(read()[id].length, 3, "earlier lessons keep their sets");
  console.log("Socratic course generation: philosophy, no-key mode, schema, re-solve, three mixed sets, and no partial sets: OK");
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, {recursive: true, force: true}));
