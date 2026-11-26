const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {main} = require("../generate_quiz_sets.js");
const CaseQuiz = require("../case_quiz.js");
const ClinicalQuiz = require("../clinical_mcq.js");
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
const requestBody = options => {
  const body = JSON.parse(options.body);
  assert.equal(body.response_format.type, "json_object");
  assert.ok(body.messages.some(m => /reply with a single JSON object\./i.test(m.content)));
  return body;
};

function fakeGroq(faults = []) {
  const calls = [];
  let candidateBatch = -1, candidate;
  return {calls, fetchImpl: async (url, options) => {
    const body = requestBody(options);
    calls.push(body);
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-only-placeholder");
    const [system, user] = body.messages.map(m => m.content);
    if (system.startsWith("Answer each")) {
      assert.ok(!user.includes('"answer"'), "the re-solve call does not see the key");
      assert.match(system, /ONLY its cited excerpt/);
      const numbered = [...user.matchAll(/^Q(\d+): (.*)$/gm)];
      const start = Number(numbered[0][1]) - 1;
      assert.ok([0, 7, 14].includes(start));
      const batch = numbered.map(m => candidate.items[Number(m[1]) - 1]);
      assert.ok(batch.length > 0 && batch.length <= 7);
      assert.deepEqual(numbered.map(m => m[2]), batch.map(item => item.stem_en));
      assert.deepEqual([...user.matchAll(/^Cited excerpt: \[(\d+)\]$/gm)].map(m => Number(m[1])), batch.map(item => item.excerpt));
      const cited = [...new Set(batch.map(item => item.excerpt))];
      assert.deepEqual(user.split("\n\nQUESTIONS:\n")[0],
        "EXCERPTS:\n" + cited.map(n => `[${n}] ${lesson.quiz_source_texts[lesson.primary_source.pmid][n - 1]}`).join("\n"));
      assert.ok(!user.match(/^[A-D]\. (?:\([A-D]\)|[A-D][.)])/m), "the solver sees only one option letter");
      const answers = batch.map(item => item.answer);
      if (start === 14 && (faults[candidateBatch] === "resolve" ||
          (faults[candidateBatch] === "resolve-once" && batch.length > 1))) answers[0] = "D";
      return reply({answers});
    }
    assert.ok(system.includes(philosophy), "the complete committed philosophy is embedded");
    const phase = system.match(/phase \("(diagnostic|practice|final)"\)/)[1];
    const repair = user.match(/^REPAIR SLOTS: (.*)$/m);
    if (phase === "diagnostic" && !repair) candidate = structuredClone(course(++candidateBatch + 1));
    const prefixes = ["A. ", "(B) ", "C) ", "D: "];
    let questions = candidate.items.filter(i => i.phase === phase).map(i => ({...i, quote: undefined,
      options: i.options.map((o, j) => ({vi: prefixes[j] + o.vi, en: prefixes[j] + o.en})),
    }));
    if (phase === "practice") {
      const target = Number(user.match(/REQUESTED SKILL INDEX: ([0-9])/)[1]);
      assert.match(system, /at least one theory question and one clinical case for this skill/);
      questions = questions.filter(q => q.skill === target);
      assert.equal(body.max_tokens, repair ? JSON.parse(repair[1]).length * 850 : 2550);
      const fault = faults[candidateBatch];
      if (target === 1 && (fault === "theory-only" || fault === "case-only" ||
          (fault === "mix-once" && !system.includes("previous practice batch")))) {
        questions.forEach(q => {q.type = fault === "case-only" ? "case" : "theory";});
      }
    }
    const prior = JSON.parse(user.split("PRIOR STEMS (do not repeat): ").at(-1));
    assert.ok(prior.length <= 24 && prior.every(s => s.length <= 100));
    if (phase === "diagnostic") {
      if (faults[candidateBatch] === "quote") questions[0].quote = "Paraphrased, not an exact excerpt.";
      if (faults[candidateBatch] === "numbers") questions[0].explanation_en = "The abstract reports a hazard ratio of 9.98.";
      if (faults[candidateBatch] === "dose") questions[1].stem_en += " She takes atorvastatin 80 mg.";
      if (faults[candidateBatch] === "count") questions.pop();
      if (faults[candidateBatch] === "salvage" && !repair) questions[2].explanation_en = "The excerpt reports an invented estimate of 9.98.";
      if (faults[candidateBatch] === "length") return {
        ok: true, json: async () => ({choices: [{finish_reason: "length", message: {content: '{"questions":['}}]}),
      };
    }
    if (phase === "practice" && questions[0]?.skill === 2 && faults[candidateBatch] === "salvage" && !repair) {
      questions[0].options[1] = questions[0].options[0];
    }
    if (repair) questions = JSON.parse(repair[1]).map(({slot}) => questions[slot - 1]);
    return reply({skills: candidate.skills, questions});
  }};
}
const practiceTargets = calls => calls.flatMap(body => {
  const target = body.messages[1].content.match(/REQUESTED SKILL INDEX: (\d+)/)?.[1];
  return target == null ? [] : [Number(target)];
});
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

  const g = fakeGroq(["quote", "numbers", "resolve", "mix-once", "salvage", "resolve-once"]);
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
    for (const item of set.items) {
      for (const option of item.options) assert.doesNotMatch(option.vi + "\n" + option.en, /^(?:\([A-D]\)|[A-D][.):])/m);
    }
  }
  assert.equal(new Set(sets.map(s => s.set_id)).size, 3, "set ids are unique");
  const allItems = sets.flatMap(s => s.items);
  assert.equal(new Set(allItems.map(i => i.stem_en)).size, allItems.length, "no repeats");
  assert.ok(logs.some(m => /"quote":1/.test(m) && /"resolve":1/.test(m) && /"numbers":1/.test(m)), logs.join("\n"));
  assert.ok(!fs.readFileSync(setPath, "utf8").includes("test-only-placeholder"));
  assert.equal(g.calls[0].response_format.type, "json_object");
  const solverStarts = g.calls.filter(b => b.messages[0].content.startsWith("Answer each"))
    .map(b => Number(b.messages[1].content.match(/^Q(\d+): /m)[1]));
  assert.deepEqual(solverStarts, [1, 8, 15, 15, 15, 1, 8, 15, 1, 8, 15, 1, 8, 15, 15]);
  assert.deepEqual(practiceTargets(g.calls), [0, 1, 2, 3, 3, 3, 0, 1, 1, 2, 3, 0, 1, 2, 2, 3, 0, 1, 2, 3, 3]);
  const repairs = g.calls.flatMap(b => {
    const slots = b.messages[1].content.match(/^REPAIR SLOTS: (.*)$/m)?.[1];
    return slots ? JSON.parse(slots).map(({slot, reason}) => [slot, reason]) : [];
  });
  assert.deepEqual(repairs, [[1, "quote"], [1, "quote"], [1, "numbers"], [1, "numbers"],
    [2, "resolve"], [2, "resolve"], [3, "numbers"], [1, "options"], [2, "resolve"]]);
  assert.ok(logs.some(m => /Rejected diagnostic item 3: numbers; stem=.+; value=\["9\.98"\]/.test(m)));
  assert.ok(logs.some(m => /Rejected practice item 1: options; stem=.+; value=.*"duplicate":\[1,2\].*"value":"/.test(m)));
  assert.ok(logs.some(m => /Rejected practice item 2: resolve; stem=.+; value=\{"expected":"A","got":"D"\}/.test(m)));

  const never = async () => assert.fail("the generator must not call the model");
  assert.equal(await main({root, env, date, fetchImpl: never, log: quiet}), 0, "three valid sets are left alone");
  assert.equal(await main({root, env, date: nextDate, fetchImpl: never, log: quiet}), 0, "no lesson for that date");

  publishLessons([lesson, {...lesson, id: nextId, date: nextDate}]);
  const unmixed = fakeGroq(["theory-only", "case-only", "theory-only", "case-only", "theory-only", "case-only"]);
  assert.equal(await main({root, env, date: nextDate, fetchImpl: unmixed.fetchImpl, log: m => logs.push(m)}), 1);
  assert.deepEqual(practiceTargets(unmixed.calls), Array.from({length: 6}, () => [0, 1, 1]).flat());
  assert.equal(unmixed.calls.length, 24, "nothing beyond the failed skill is requested in each rejected round");
  assert.ok(logs.some(m => /"practice_mix":6/.test(m)));
  const [fallback] = read()[nextId];
  assert.equal(fallback.version, undefined, "publish the legacy-format fallback, not a partial course");
  assert.equal(fallback.items.length, 6);
  assert.equal(fallback.items.filter(q => q.type === "case").length, 3);
  for (const q of fallback.items) {
    assert.ok(lesson.quiz_source_texts[q.pmid].includes(q.quote));
    assert.equal(q.ai_generated, false);
  }
  const fallbackLesson = {...lesson, generated_quiz: fallback};
  assert.equal(ClinicalQuiz.sourceQuestionCount(fallbackLesson), 6);
  for (const lang of ["vi", "en"]) {
    const q = ClinicalQuiz.reviewQuestion(fallbackLesson, 0, 0, lang, "normal");
    assert.equal(q.ai_generated, false);
    assert.ok(!q.explanation.includes(CaseQuiz.AI_NOTE[lang]));
  }

  const broken = fakeGroq(["dose", "length", "count", "count", "count", "count"]);
  assert.equal(await main({root, env, date: nextDate, fetchImpl: broken.fetchImpl, log: m => logs.push(m)}), 0);
  assert.ok(logs.some(m => /"dose":1/.test(m) && /"count":5/.test(m)), logs.join("\n"));
  assert.ok(logs.some(m => /completion limit.*Groq truncated/.test(m)));
  assert.equal(read()[nextId][0].set_id, fallback.set_id, "partial sets never replace a published fallback");
  assert.equal(read()[id].length, 3, "earlier lessons keep their sets");

  const upstreamLogs = [];
  const rateLimit = () => new Response(JSON.stringify({error: {message: "Rate limit reached"}}),
    {status: 429, headers: {"Retry-After": "0.001"}});
  const badModel = () => new Response(JSON.stringify({error: {
    message: `Unknown model for ${env.GROQ_API_KEY}\nAuthorization: Bearer gsk_another_credential\n${"x".repeat(500)}`,
    debug: "DO NOT LOG THE FULL BODY",
  }}), {status: 400});
  const failures = [
    rateLimit, badModel,
    () => new Response("DO NOT LOG THE FULL BODY", {status: 413, statusText: "Content Too Large"}),
    () => { throw new Error(`fetch failed for ${env.GROQ_API_KEY}`, {cause: {code: "ENOTFOUND"}}); },
    badModel, badModel, badModel,
  ];
  const before = fs.readFileSync(setPath, "utf8");
  await main({root, env, date: nextDate, fetchImpl: async (_, options) => {
    requestBody(options);
    return failures.shift()();
  }, log: m => upstreamLogs.push(m)});
  assert.equal(failures.length, 0, "a 429 still retries the same generation phase");
  const diagnostics = upstreamLogs.join("\n");
  assert.match(diagnostics, /Groq diagnostic request failed \(HTTP 429, model=openai\/gpt-oss-120b, request_bytes=\d+, max_tokens=3400\): Rate limit reached/);
  assert.match(diagnostics, /HTTP 400[^\n]+: Unknown model for \[REDACTED\] Authorization: \[REDACTED\]/);
  assert.match(diagnostics, /HTTP 413[^\n]+: Content Too Large/);
  assert.match(diagnostics, /no HTTP response[^\n]+: fetch failed for \[REDACTED\] — ENOTFOUND/);
  assert.ok(!diagnostics.includes(env.GROQ_API_KEY));
  assert.doesNotMatch(diagnostics, /gsk_another_credential|DO NOT LOG THE FULL BODY|x{401}/);
  assert.equal(upstreamLogs.length, 8);
  assert.match(upstreamLogs.at(-1), /rejected: \{"upstream":6\}/);
  assert.equal(fs.readFileSync(setPath, "utf8"), before, "upstream failures leave previously published sets intact");
  let time = 0;
  const paced = [];
  await main({root, env, date: nextDate, log: quiet, now: () => time, wait: async ms => {time += ms;},
    fetchImpl: async (_, options) => {
      const body = requestBody(options);
      paced.push({time, body});
      if (paced.length === 1) return new Response(JSON.stringify({error: {message: "Requested 2300. Please try again in 690ms."}}), {status: 429});
      if (paced.length === 2) return new Response(JSON.stringify({error: {code: "json_validate_failed"}}), {
        status: 400, headers: {"x-ratelimit-remaining-tokens": "10", "x-ratelimit-reset-tokens": "10s"},
      });
      if (paced.length === 3) return new Response(JSON.stringify({error: {message: "Failed to generate JSON."}}), {status: 400});
      return badModel();
    }});
  assert.deepEqual(paced.slice(0, 4).map(p => [p.time, p.body.temperature]), [[0, 0.7], [690, 0.7], [10690, 0.2], [10690, 0.7]]);
  assert.deepEqual(paced[2].body, {...paced[1].body, temperature: 0.2}, "JSON retry preserves the request except for temperature");
  let deadlineCalls = 0;
  await main({root, env, date: nextDate, log: quiet, now: () => 0, budgetMs: 1000,
    wait: async () => assert.fail("a wait past the workflow budget is forbidden"),
    fetchImpl: async () => {
      deadlineCalls++;
      return new Response(JSON.stringify({error: {message: "Please try again in 17.2s."}}), {status: 429});
    }});
  assert.equal(deadlineCalls, 1, "a delayed retry cannot run past the job deadline");
  assert.equal(fs.readFileSync(setPath, "utf8"), before);
  console.log("Groq upstream diagnostics: HTTP status, redacted error, retry, transport failure, and no publish: OK");
  console.log("Socratic course generation: philosophy, no-key mode, schema, re-solve, three mixed sets, and no partial sets: OK");
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, {recursive: true, force: true}));
