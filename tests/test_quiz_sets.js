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
const pmid = template.primary_source.pmid;
const excerpts = template.quiz_source_texts[pmid];
const caseQuote = course().items.find(q => q.type === "case").quote;
const ckdQuote = caseQuote + " There was no heterogeneity by CKD status.";
const lesson = {...template, id, date, quiz_source_texts: {...template.quiz_source_texts, [pmid]: [...excerpts, ckdQuote]}};
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

function fakeGroq(faults = [], roundOffset = 0) {
  const calls = [];
  let round = -1, questions, submitted, repaired = 0;
  const prefixes = ["A. ", "(B) ", "C) ", "D: "];
  return {calls, fetchImpl: async (url, options) => {
    const body = requestBody(options);
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-only-placeholder");
    const [system, user] = body.messages.map(m => m.content);
    if (system.startsWith("Independently answer")) {
      assert.ok(!user.includes('"answer"'), "independent re-solve never sees the key");
      assert.match(system, /ONLY its cited excerpt/);
      assert.match(system, /Cardiovascular events are not cardiovascular mortality/);
      assert.match(system, /exact clinical endpoint, population, effect direction, comparator, magnitude and time frame/);
      assert.match(system, /supported as written in BOTH languages/);
      assert.match(system, /Solve the questions before reading the proposed explanations/);
      assert.match(system, /every claim must be supported as written by the cited excerpt/);
      const numbered = [...user.matchAll(/^Q(\d+): (.*)$/gm)];
      const slots = numbered.map(m => Number(m[1]));
      const batch = slots.map(n => submitted[n - 1]);
      for (const [i, q] of batch.entries()) {
        assert.ok(user.includes(`Vietnamese stem: ${q.stem_vi}`));
        assert.ok(q.options.every(o => user.includes(`EN: ${o.en} | VI: ${o.vi}`)));
        assert.ok(user.includes(`Q${slots[i]} explanations:\nEN: ${q.explanation_en}\nVI: ${q.explanation_vi}`));
      }
      assert.deepEqual(numbered.map(m => m[2]), batch.map(q => q.stem_en));
      assert.deepEqual([...user.matchAll(/^Cited excerpt: \[(\d+)\]$/gm)].map(m => Number(m[1])), batch.map(q => q.excerpt));
      const cited = [...new Set(batch.map(q => q.excerpt))];
      assert.deepEqual(user.split("\n\nQUESTIONS:\n")[0],
        "EXCERPTS:\n" + cited.map(n => `[${n}] ${lesson.quiz_source_texts[lesson.primary_source.pmid][n - 1]}`).join("\n"));
      assert.ok(!user.match(/^[A-D]\. (?:\([A-D]\)|[A-D][.)])/m), "the solver sees only one option letter");
      calls.push({mode: "solve", slots});
      return reply({
        answers: batch.map((q, i) => faults[round] === "repair" && repaired === 1 && slots[i] === 1 ? "D" : q.answer),
        explanations: batch.map((q, i) => faults[round] === "explanations" && !repaired
          ? [{en: false, vi: true}, {en: true, vi: false}, {en: true}][slots[i] - 1] : {en: true, vi: true}),
      });
    }
    assert.ok(system.includes(philosophy), "the complete committed philosophy is embedded");
    const repair = user.match(/^REPAIR SLOTS: (.*)$/m)?.[1];
    if (!repair) {
      repaired = 0;
      submitted = [];
      questions = course(++round + 1 + roundOffset).items.filter(i => i.type === "case").slice(0, 3);
      assert.match(system, /exactly 3 bilingual clinical application case questions \(no theory questions\)/);
    } else repaired++;
    const slots = repair ? JSON.parse(repair).map(p => p.slot) : [1, 2, 3];
    calls.push({mode: repair ? "repair" : "generate", slots});
    assert.equal(body.max_tokens, slots.length * 850);
    const prior = JSON.parse(user.split("PRIOR STEMS (do not repeat): ").at(-1));
    assert.ok(prior.length <= 24 && prior.every(s => s.length <= 100));
    const result = slots.map(n => {
      const q = structuredClone(questions[n - 1]);
      q.options = q.options.map((o, j) => ({vi: prefixes[j] + o.vi, en: prefixes[j] + o.en}));
      delete q.quote;
      if (faults[round] === "theory") q.type = "theory";
      if (faults[round] === "repair" && !repaired) {
        if (n === 1) q.explanation_en = "The abstract reports a hazard ratio of 9.98.";
        if (n === 2) q.options[1] = q.options[0];
      }
      if (faults[round] === "explanations" && !repaired && n < 3) {
        q.excerpt = excerpts.length + 1;
        if (n === 1) q.explanation_en = "Only patients with CKD benefited.";
        else q.explanation_vi = "Lợi ích giới hạn ở bệnh nhân có bệnh thận mạn.";
        assert.equal(CaseQuiz.rejectReason({...q, quote: ckdQuote}, CaseQuiz.grounding(lesson)), "",
          "the lexical check alone cannot verify the subgroup effect");
      }
      submitted[n - 1] = {...q, options: questions[n - 1].options};
      return q;
    });
    return reply({questions: result});
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

  const g = fakeGroq(["repair"]);
  const logs = [];
  assert.equal(await main({root, env, date, fetchImpl: g.fetchImpl, log: m => logs.push(m)}), 3);
  const sets = read()[id];
  assert.equal(sets.length, 3);
  for (const set of sets) {
    assert.equal(set.items.length, 3);
    assert.ok(set.items.every(q => q.type === "case"));
    assert.ok(CaseQuiz.validateCaseSet(lesson, set));
    assert.ok(!CaseQuiz.validateCaseSet(lesson, {...set, items: set.items.slice(1)}));
    assert.ok(!CaseQuiz.validateCaseSet(lesson, {...set, items: set.items.map(q => ({...q, type: "theory"}))}));
    assert.ok(set.items.every(q => lesson.quiz_source_texts[q.pmid].includes(q.quote)));
  }
  assert.ok(!fs.readFileSync(setPath, "utf8").includes(env.GROQ_API_KEY));
  assert.deepEqual(g.calls.map(({mode, slots}) => [mode, ...slots]), [
    ["generate", 1, 2, 3], ["solve", 3], ["repair", 1, 2], ["solve", 1, 2], ["repair", 1], ["solve", 1],
    ["generate", 1, 2, 3], ["solve", 1, 2, 3], ["generate", 1, 2, 3], ["solve", 1, 2, 3],
  ]);
  assert.ok(logs.some(m => /Rejected case item 1: numbers; stem=.+; value=\["9\.98"\]/.test(m)));
  assert.ok(logs.some(m => /Rejected case item 2: options; stem=.+; value=.*"duplicate":\[1,2\].*"value":"/.test(m)));
  assert.ok(logs.some(m => /Rejected case item 1: resolve; stem=.+; value=\{"expected":"A","got":"D"\}/.test(m)));
  const never = async () => assert.fail("unnecessary model call");
  assert.equal(await main({root, env, date, fetchImpl: never, log: quiet}), 0, "three valid sets are left alone");
  assert.equal(await main({root, env, date: nextDate, fetchImpl: never, log: quiet}), 0, "no lesson for that date");
  const nextLesson = {...lesson, id: nextId, date: nextDate};
  publishLessons([lesson, nextLesson]);
  const broken = fakeGroq(Array(6).fill("theory"));
  assert.equal(await main({root, env, date: nextDate, fetchImpl: broken.fetchImpl, log: quiet}), 0);
  assert.equal(broken.calls.length, 18, "at most two repairs per case");
  assert.ok(broken.calls.every(c => c.mode !== "solve"));
  assert.equal(read()[nextId], undefined, "neither theory sets nor partial sets are published");
  assert.ok(ClinicalQuiz.sourceCourse(nextLesson).items.every(q => q.type === "theory"));
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
  assert.match(diagnostics, /Groq case request failed \(HTTP 429, model=openai\/gpt-oss-120b, request_bytes=\d+, max_tokens=2550\): Rate limit reached/);
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
  const rerunEnv = {...env, REGENERATE_QUIZ_SETS: "true"};
  const oldIds = read()[id].map(s => s.set_id);
  const fresh = fakeGroq(["explanations"], 10);
  const explanationLogs = [];
  assert.equal(await main({root, env: rerunEnv, date, fetchImpl: fresh.fetchImpl, log: m => explanationLogs.push(m)}), 3,
    "forced regeneration replaces today's sets even when all three already validate");
  assert.deepEqual(fresh.calls.slice(0, 4).map(({mode, slots}) => [mode, ...slots]),
    [["generate", 1, 2, 3], ["solve", 1, 2, 3], ["repair", 1, 2, 3], ["solve", 1, 2, 3]]);
  assert.deepEqual(explanationLogs.filter(m => m.includes(": explanation;")).map(m => m.replace(/; stem=.*; value=/, ": ")), [
    'Rejected case item 1: explanation: ["en"]',
    'Rejected case item 2: explanation: ["vi"]',
    'Rejected case item 3: explanation: ["vi"]',
  ]);
  assert.ok(read()[id].flatMap(s => s.items).every(q => q.quote !== ckdQuote),
    "contradictory explanations and unverified slots were replaced");
  console.log("Independent re-solve: rejects contradictory or unverified bilingual explanations and repairs their slots: OK");
  const newIds = read()[id].map(s => s.set_id);
  assert.ok(newIds.every(id => !oldIds.includes(id)));
  const store = read();
  store[nextId] = store[id].map((s, i) => ({...s, set_id: `next-${i}`}));
  store[nextId][0].items[0].options[0].vi = "Giảm tử vong do tim mạch";
  store[nextId][1].items[0].explanation_en = "The trial reduced cardiovascular mortality.";
  fs.writeFileSync(setPath, "window.EBM_QUIZ_SETS = " + JSON.stringify({sets: store}) + ";");
  const offline = async () => badModel();
  assert.equal(await main({root, env: rerunEnv, date: nextDate, fetchImpl: offline, log: quiet}), 0);
  assert.deepEqual(Array.from(read()[nextId], s => s.set_id), ["next-2"],
    "failed regeneration keeps the still-valid set and unpublishes the invalid ones");
  assert.equal(await main({root, env, date: nextDate, fetchImpl: offline, log: quiet}), 0);
  assert.deepEqual(Array.from(read()[id], s => s.set_id), Array.from(newIds), "regeneration does not rewrite prior lessons");
  console.log("Daily rebuild: forced replacement, valid fallback, and invalid set removal: OK");
  console.log("Case-only generation: three cases per set, selective repairs, independent re-solve, no-key theory fallback: OK");
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, {recursive: true, force: true}));
