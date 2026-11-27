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
const lesson = {...template, id, date, quiz_source_texts: {...template.quiz_source_texts, [pmid]: [excerpts[0], caseQuote, excerpts[1], ckdQuote]}};
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

function fakeGroq(faults = [], roundOffset = 0, source = lesson) {
  const calls = [];
  let round = -1, questions, submitted, repaired = 0;
  const prefixes = ["A. ", "(B) ", "C) ", "D: "];
  return {calls, fetchImpl: async (url, options) => {
    const body = requestBody(options);
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-only-placeholder");
    const [system, user] = body.messages.map(m => m.content);
    const estimated = Math.ceil(Buffer.byteLength(options.body) / 3) + body.max_tokens;
    if (system.startsWith("Independently answer")) {
      assert.ok(!user.includes('"answer"'), "independent re-solve never sees the key");
      assert.match(system, /ONLY its cited excerpt/);
      assert.match(system, /the first must support the key finding in the correct option/);
      assert.match(system, /Cardiovascular events are not cardiovascular mortality/);
      assert.match(system, /exact clinical endpoint, population, effect direction, comparator, magnitude and time frame/);
      assert.match(system, /supported as written in BOTH languages/);
      assert.match(system, /Solve the questions before reading the proposed explanations/);
      assert.match(system, /every claim must be supported as written by that question’s cited excerpts/);
      assert.match(system, /Verify every claimed effect figure in both stems/);
      assert.match(system, /the same endpoint, threshold, comparator and population/);
      assert.match(system, /reject a subgroup figure applied to someone outside/);
      assert.match(system, /relative increase BY a percent as an absolute risk rising TO that percent/);
      assert.match(system, /List every defensible option/);
      const numbered = [...user.matchAll(/^Q(\d+): (.*)$/gm)];
      const slots = numbered.map(m => Number(m[1]));
      const batch = slots.map(n => submitted[n - 1]);
      for (const [i, q] of batch.entries()) {
        assert.ok(user.includes(`Vietnamese stem: ${q.stem_vi}`));
        assert.ok(q.options.every(o => user.includes(`EN: ${o.en} | VI: ${o.vi}`)));
        assert.ok(user.includes(`Q${slots[i]} explanations:\nEN: ${q.explanation_en}\nVI: ${q.explanation_vi}`));
      }
      assert.deepEqual(numbered.map(m => m[2]), batch.map(q => q.stem_en));
      assert.deepEqual([...user.matchAll(/^Cited excerpt: (.+)$/gm)].map(m => m[1]),
        batch.map(q => [].concat(q.excerpt).map(n => `[${n}]`).join(", ")));
      const cited = [...new Set(batch.flatMap(q => q.excerpt))];
      assert.deepEqual(user.split("\n\nQUESTIONS:\n")[0],
        "EXCERPTS:\n" + cited.map(n => `[${n}] ${source.quiz_source_texts[pmid][n - 1]}`).join("\n"));
      assert.ok(!user.match(/^[A-D]\. (?:\([A-D]\)|[A-D][.)])/m), "the solver sees only one option letter");
      calls.push({mode: "solve", slots, estimated});
      return reply({
        answers: batch.map((q, i) => faults[round] === "repair" && repaired === 1 && slots[i] === 1 ? ["D"] :
          faults[round] === "multi-key" && !repaired ? [[q.answer, "D"], [], q.answer][slots[i] - 1] : [q.answer]),
        explanations: batch.map((q, i) => faults[round] === "explanations" && !repaired
          ? [{en: false, vi: true}, {en: true, vi: false}, {en: true}][slots[i] - 1] :
          {en: true, vi: true, primary: faults[round] !== "primary-verdict" || repaired > 0}),
      });
    }
    assert.match(system, /Set "excerpt" to the 1-based integer index/);
    assert.match(system, /put the excerpt that supports the key finding in the correct option first/);
    assert.match(system, /Do not include a quote field/);
    assert.match(system, /Every number in a stem, option, or explanation must appear exactly as written in a cited excerpt/);
    assert.match(system, /Never use the keyed estimate’s confidence limits or other figures from the excerpt reporting the keyed estimate as distractors/);
    assert.match(system, /Do not calculate differences, convert HR or RR to percentages \(e\.g\. 30% from HR 0\.70\), or round/);
    assert.match(system, /in option text or explanations \(never say "Answer A"\)/);
    assert.match(system, /exactly 4 options\. Do not prefix or mention option letters in option text/);
    assert.match(system, /All four options must be distinct in each language/);
    assert.match(system, /If any stem, option, or explanation includes "40 mg", cite \[1\]/);
    assert.match(system, /\[2\] gives "hazard ratio 0\.70"\. Use the reported estimate, not a percentage derived from it/);
    assert.match(system, /Do not offer its CI bounds 0\.61 or 0\.82 as distractors/);
    assert.match(system, /"0\.70" and "reported hazard ratio 0\.70" are the same answer, not distinct options/);
    const repair = user.match(/^REPAIR SLOTS: (.*)$/m)?.[1];
    assert.equal(system.includes(philosophy), !repair, "only initial case generation includes the full philosophy");
    if (!repair) {
      repaired = 0;
      submitted = [];
      questions = course(++round + 1 + roundOffset).items.filter(i => i.type === "case").slice(0, 3);
      assert.match(system, /exactly 3 bilingual clinical application case questions \(no theory questions\)/);
    } else repaired++;
    const requested = repair && JSON.parse(repair);
    const slots = requested ? requested.map(p => p.slot) : [1, 2, 3];
    calls.push({mode: repair ? "repair" : "generate", slots, estimated});
    assert.equal(body.max_tokens, slots.length * 850);
    const prior = JSON.parse(user.split("PRIOR STEMS (do not repeat): ").at(-1));
    assert.ok(prior.length <= 24 && prior.every(s => s.length <= 100));
    const result = slots.map(n => {
      const q = structuredClone(questions[n - 1]);
      q.excerpt = lesson.quiz_source_texts[pmid].indexOf(q.quote) + 1;
      q.options = q.options.map((o, j) => ({vi: prefixes[j] + o.vi, en: prefixes[j] + o.en}));
      delete q.quote;
      if (faults[round] === "theory") q.type = "theory";
      if (faults[round] === "repair" && !repaired) {
        if (n === 1) {
          q.explanation_en = "The abstract reports a hazard ratio of 9.98.";
          q.options[0] = {en: "Fewer primary cardiovascular events. ".repeat(7) + "End of the rejected option.", vi: q.options[0].vi};
        }
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
      if (faults[round] === "indices") {
        if (repaired) q.excerpt = n === 1 ? "2" : "[2]";
        else if (n === 1) q.excerpt = "2.5";
        else if (n === 2) Object.assign(q, {excerpt: "2", quote: excerpts[1]});
        else q.excerpt = "E2";
      }
      if (faults[round] === "count" && repaired) {
        q.excerpt = ["[2]", "E1"];
        submitted[n - 1].excerpt = [2, 1];
      }
      if (["answer-first", "primary-verdict"].includes(faults[round]) && n === 1) {
        q.excerpt = [1, 2];
        q.options[0] = {en: "0.70", vi: "0.70"};
        Object.assign(submitted[n - 1], {excerpt: [2, 1], options: [q.options[0], ...questions[n - 1].options.slice(1)]});
      }
      if (["completion", "partial", "ambiguous"].includes(faults[round]) && !repaired) {
        if (n === 1) {
          q.stem_en = "An older adult who meets STAREE eligibility asks what the study reported for atorvastatin 40 mg daily versus placebo.";
          q.stem_vi = "Một người cao tuổi đủ tiêu chí STAREE hỏi kết quả của atorvastatin 40 mg/ngày so với giả dược.";
          q.explanation_en = "The hazard ratio for primary cardiovascular events was 0.70 with atorvastatin 40 mg daily versus placebo.";
          q.explanation_vi = "Tỉ số nguy cơ của biến cố tim mạch chính là 0,70 với atorvastatin 40 mg/ngày so với giả dược.";
          if (faults[round] === "completion") {
            q.explanation_en += " The finding was in community-dwelling adults.";
            q.explanation_vi += " Kết quả này ghi nhận ở người sống tại cộng đồng.";
            assert.deepEqual(CaseQuiz.unsupportedClaims({...q, quote: caseQuote}), ["community_dwelling"]);
          }
          if (faults[round] === "partial") q.stem_en += " She asks specifically about the 40 mg strength.";
          Object.assign(submitted[n - 1], {
            stem_en: q.stem_en, stem_vi: q.stem_vi, explanation_en: q.explanation_en, explanation_vi: q.explanation_vi,
            excerpt: faults[round] === "ambiguous" ? 2 : [2, 1],
          });
        }
        if (n === 2) q.explanation_en = "The study reported a 30% reduction in primary cardiovascular events.";
      }
      if (["count-completion", "effects-completion"].includes(faults[round]) && n === 1) {
        q.explanation_en = "The trial included 9971 participants and reported fewer primary cardiovascular events with atorvastatin.";
        if (faults[round] === "effects-completion") {
          q.stem_en += " The trial included 9971 participants.";
          assert.equal(CaseQuiz.rejectReason({...q, quote: caseQuote}, {pmid, excerpts: [caseQuote]}), "effects");
        }
        Object.assign(submitted[n - 1], {stem_en: q.stem_en, explanation_en: q.explanation_en, excerpt: [2, 3]});
      }
      if (faults[round] === "claims-completion" && n === 1) {
        q.explanation_en += " The finding was in community-dwelling adults.";
        assert.equal(CaseQuiz.rejectReason({...q, quote: caseQuote}, {pmid, excerpts: [caseQuote]}), "claims");
        Object.assign(submitted[n - 1], {explanation_en: q.explanation_en, excerpt: [2, 1]});
      }
      if (["option-dose-completion", "explanation-dose-completion"].includes(faults[round]) && n === 1) {
        if (faults[round] === "option-dose-completion") {
          q.options = q.options.map((option, i) => i !== 1 ? option : {
            en: "More events with atorvastatin 40 mg once daily",
            vi: "Nhiều biến cố hơn với atorvastatin 40 mg/ngày",
          });
        } else {
          q.explanation_en += " The atorvastatin regimen was 40 mg once daily.";
          q.explanation_vi += " Phác đồ atorvastatin là 40 mg/ngày.";
        }
        assert.equal(CaseQuiz.rejectReason({...q, quote: caseQuote}, {pmid, excerpts: [caseQuote]}),
          faults[round] === "option-dose-completion" ? "dose" : "numbers");
        const expected = submitted[n - 1];
        if (faults[round] === "option-dose-completion") expected.options = expected.options.map((option, i) => i === 1 ? q.options[i] : option);
        Object.assign(expected, {explanation_en: q.explanation_en, explanation_vi: q.explanation_vi, excerpt: [2, 1]});
      }
      if (faults[round] === "log-explanation" && n === 1 && !repaired) {
        q.explanation_en = "The source reports fewer primary cardiovascular events. ".repeat(7) + "A final unsupported figure is 30%.";
      }
      return q;
    });
    if (faults[round] === "count") {
      if (!repaired) return reply({questions: result.slice(0, 2)});
      assert.deepEqual(requested, [{slot: 3, reason: "count"}]);
    }
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

  const g = fakeGroq(["repair", "indices", "count"]);
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
    assert.ok(set.items.every(q => CaseQuiz.citedExcerpts(q).includes(caseQuote)), "the cited index yields the exact source text");
  }
  assert.deepEqual(JSON.parse(JSON.stringify(sets[2].items[2].quotes)), [caseQuote, excerpts[0]]);
  assert.ok(!Object.hasOwn(sets[2].items[2], "quote"), "a dual citation stores both exact excerpts");
  assert.ok(sets[0].items.every(q => q.quote === caseQuote), "the single-excerpt artifact shape is unchanged");
  assert.ok(!fs.readFileSync(setPath, "utf8").includes(env.GROQ_API_KEY));
  assert.deepEqual(g.calls.map(({mode, slots}) => [mode, ...slots]), [
    ["generate", 1, 2, 3], ["solve", 3], ["repair", 1, 2], ["solve", 1, 2], ["repair", 1], ["solve", 1],
    ["generate", 1, 2, 3], ["solve", 3], ["repair", 1, 2], ["solve", 1, 2],
    ["generate", 1, 2, 3], ["solve", 1, 2], ["repair", 3], ["solve", 3],
  ]);
  assert.ok(logs.some(m => /Rejected case item 1: numbers; stem=.+; value=\["9\.98"\]/.test(m)));
  const numericRejection = logs.find(m => m.startsWith("Rejected case item 1: numbers;"));
  const evidence = JSON.parse(numericRejection.split("; evidence=")[1]);
  assert.equal(evidence.excerpt, 2);
  assert.equal(evidence.answer, "A");
  assert.equal(evidence.keyedOption.en, "Fewer primary cardiovascular events. ".repeat(7) + "End of the rejected option.");
  assert.equal(evidence.keyedOption.vi, course(1).items.find(q => q.type === "case").options[0].vi);
  let expectedTotal = 0;
  assert.deepEqual(logs.flatMap(m => {
    const tokens = m.match(/token budget: estimated=(\d+).*running total=(\d+)$/);
    return tokens ? [tokens.slice(1).map(Number)] : [];
  }), g.calls.map(({estimated}) => [estimated, expectedTotal += estimated]));
  assert.ok(logs.some(m => /Rejected case item 2: options; stem=.+; value=.*"duplicate":\[1,2\].*"value":"/.test(m)));
  assert.ok(logs.some(m => /Rejected case item 1: resolve; stem=.+; value=\{"expected":"A","got":\["D"\]\}/.test(m)));
  assert.ok(logs.some(m => m.includes('"excerpt":"2.5"') && m.includes("case item 1: quote")));
  assert.ok(logs.some(m => m.includes('"excerpt":"2","quote":') && m.includes("case item 2: quote")));
  assert.ok(logs.includes("Groq case response count: expected 3, got 2."));
  console.log("Excerpt references: numeric, string, bracketed and E-prefixed indices resolve verbatim; invalid citations and missing slots are repaired: OK");
  const never = async () => assert.fail("unnecessary model call");
  assert.equal(await main({root, env, date, fetchImpl: never, log: quiet}), 0, "three valid sets are left alone");
  const saved = {...read(), [id]: sets.slice(0, 2)};
  fs.writeFileSync(setPath, "window.EBM_QUIZ_SETS = " + JSON.stringify({sets: saved}) + ";");
  const topUp = fakeGroq([], 100);
  assert.equal(await main({root, env, date, fetchImpl: topUp.fetchImpl, log: quiet}), 3);
  assert.deepEqual(topUp.calls.map(({mode}) => mode), ["generate", "solve"], "two valid sets leave only one to generate");
  assert.deepEqual(JSON.stringify(read()[id].slice(0, 2)), JSON.stringify(saved[id]));
  const fullArtifact = fs.readFileSync(setPath, "utf8");
  let unexpectedRequests = 0;
  assert.equal(await main({root, env, date, log: quiet, fetchImpl: async () => {
    unexpectedRequests++;
    return badModel();
  }}), 0);
  assert.equal(unexpectedRequests, 0, "later slots do not call Groq after reaching three valid sets");
  assert.equal(fs.readFileSync(setPath, "utf8"), fullArtifact);
  console.log("Normal refresh: retains valid case sets, tops up only the missing pack, and makes zero Groq calls at 3/3: OK");
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
  assert.equal(upstreamLogs.filter(m => m.includes("token budget:")).length, 7, "count every actual HTTP attempt");
  assert.equal(upstreamLogs.filter(m => m.includes("rate limits:")).length, 6, "every HTTP response logs quota data");
  assert.equal(upstreamLogs.filter(m => !/token budget:|rate limits:/.test(m)).length, 8);
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
  const primaryModel = "openai/gpt-oss-120b", fallbackModel = "openai/gpt-oss-20b";
  const tpd = () => new Response(JSON.stringify({error: {
    message: "Rate limit reached on tokens per day (TPD): Limit 200000, Used 199803, Requested 1089. Please try again in 6m25.344s.",
  }}), {status: 429, headers: {"Retry-After": "385", "x-ratelimit-remaining-tokens": "0"}});
  for (const capDuring of ["generate", "solve"]) {
    const primary = fakeGroq([], 200), fallback = fakeGroq([], 300);
    const calls = [], failoverLogs = [];
    const options = {root, env: {...rerunEnv, GROQ_FALLBACK_MODELS: fallbackModel}, date, log: m => failoverLogs.push(m),
      wait: async () => assert.fail("neither model should wait on a daily limit"),
      fetchImpl: async (url, request) => {
        const body = requestBody(request);
        const stage = body.messages[0].content.startsWith("Independently answer") ? "solve" : "generate";
        assert.equal(body.reasoning_effort, "low");
        assert.equal(body.include_reasoning, false);
        calls.push([body.model, stage]);
        if (body.model === primaryModel) {
          if (capDuring === "generate" || primary.calls.length === 3) return tpd();
          return primary.fetchImpl(url, request);
        }
        assert.equal(body.model, fallbackModel);
        if (capDuring === "solve" && fallback.calls.length === 2) return tpd();
        return fallback.fetchImpl(url, request);
      }};
    const expectedModels = capDuring === "generate" ? Array(3).fill(fallbackModel) : [primaryModel, fallbackModel];
    assert.equal(await main(options), expectedModels.length);
    assert.deepEqual(calls, capDuring === "generate" ? [
      [primaryModel, "generate"],
      ...expectedModels.flatMap(model => [[model, "generate"], [model, "solve"]]),
    ] : [
      [primaryModel, "generate"], [primaryModel, "solve"],
      [primaryModel, "generate"], [primaryModel, "solve"],
      [fallbackModel, "generate"], [fallbackModel, "solve"], [fallbackModel, "generate"],
    ]);
    const published = Array.from(read()[id]);
    assert.deepEqual(published.map(set => set.model), expectedModels);
    assert.ok(published.every(set => CaseQuiz.validateCaseSet(lesson, set)));
    assert.deepEqual(failoverLogs.filter(m => m.startsWith("Validated quiz case set ")),
      published.map(set => `Validated quiz case set ${set.set_id}; model=${set.model}`));
    assert.match(failoverLogs.join("\n"), /switching to openai\/gpt-oss-20b for generation and re-solve/);
    if (capDuring === "solve") assert.match(failoverLogs.join("\n"), /daily token limit for openai\/gpt-oss-20b; stopping quiz generation/);
  }
  console.log("Groq daily limit: switch both stages once, record pack provenance, and preserve completed packs if both models cap out: OK");
  const thirdModel = "qwen/qwen3.8-27b";
  const primaryWithHeaders = fakeGroq([], 480), third = fakeGroq([], 490);
  const quotaCalls = [], quotaLogs = [];
  assert.equal(await main({root, env: rerunEnv, date, log: m => quotaLogs.push(m),
    wait: async () => assert.fail("known daily shortages and daily 429s should switch without waiting"),
    fetchImpl: async (url, request) => {
      const body = requestBody(request);
      quotaCalls.push(body.model);
      if (body.model === fallbackModel) return tpd();
      if (body.model === thirdModel) {
        assert.equal(body.reasoning_effort, "low");
        assert.equal(body.reasoning_format, "hidden");
        assert.equal("include_reasoning" in body, false);
        return third.fetchImpl(url, request);
      }
      assert.equal(body.model, primaryModel);
      const response = await primaryWithHeaders.fetchImpl(url, request);
      return {...response, headers: new Headers({
        "x-ratelimit-remaining-tokens": "8000", "x-ratelimit-reset-tokens": "1ms",
        "x-ratelimit-remaining-requests": "41", "x-ratelimit-reset-requests": "23h59m",
        "x-ratelimit-remaining-tokens-day": "4500", "x-ratelimit-reset-tokens-day": "23h",
        "x-ratelimit-remaining-requests-minute": "5", "x-ratelimit-reset-requests-minute": "57s",
      })};
    },
  }), 3);
  assert.deepEqual(quotaCalls, [primaryModel, primaryModel, fallbackModel, thirdModel, thirdModel, thirdModel, thirdModel]);
  assert.deepEqual(Array.from(read()[id], set => set.model), [primaryModel, thirdModel, thirdModel]);
  assert.match(quotaLogs.join("\n"), /skipped for openai\/gpt-oss-120b: known daily quota cannot cover one set/);
  const loggedQuota = quotaLogs.find(m => m.includes("rate limits:") && m.includes(primaryModel));
  assert.deepEqual(JSON.parse(loggedQuota.slice(loggedQuota.indexOf("{"))), {
    requestsDay: {remaining: 41, limit: null, reset: "23h59m"},
    tokensMinute: {remaining: 8000, limit: null, reset: "1ms"},
    tokensDay: {remaining: 4500, limit: null, reset: "23h"},
    requestsMinute: {remaining: 5, limit: null, reset: "57s"},
    retryAfterSeconds: null,
  });
  assert.ok(quotaLogs.some(m => m.includes("rate limits:") && m.includes("HTTP 429")));
  console.log("Groq quota: log day/minute headers, skip a model short on known daily tokens, and publish with the third model: OK");
  for (const model of [primaryModel, fallbackModel, thirdModel]) {
    const cleanRun = fakeGroq([], 500);
    const budgetLogs = [];
    assert.equal(await main({root, env: {...rerunEnv, GROQ_MODEL: model}, date, fetchImpl: cleanRun.fetchImpl,
      log: m => budgetLogs.push(m)}), 3);
    assert.ok(Array.from(read()[id]).every(set => set.model === model));
    const estimated = cleanRun.calls.reduce((total, call) => total + call.estimated, 0);
    assert.ok(budgetLogs.some(m => m.endsWith(`model=${model}; model total=${estimated}; running total=${estimated}`)));
    console.log(`Groq first-pass three-set estimate, ${model}: ${estimated} tokens across ${cleanRun.calls.length} calls`);
  }
  const oldIds = read()[id].map(s => s.set_id);
  const fresh = fakeGroq(["explanations"], 10);
  const explanationLogs = [];
  assert.equal(await main({root, env: rerunEnv, date, fetchImpl: fresh.fetchImpl, log: m => explanationLogs.push(m)}), 3,
    "forced regeneration replaces today's sets even when all three already validate");
  assert.deepEqual(fresh.calls.slice(0, 4).map(({mode, slots}) => [mode, ...slots]),
    [["generate", 1, 2, 3], ["solve", 1, 2, 3], ["repair", 1, 2, 3], ["solve", 1, 2, 3]]);
  assert.deepEqual(explanationLogs.filter(m => m.includes(": explanation;")).map(m => m.split("; evidence=")[0].replace(/; stem=.*; value=/, ": ")), [
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
  for (const [fault, expectedSlots] of [["completion", [1, 3]], ["partial", [1, 3]], ["ambiguous", [3]]]) {
    assert.match(excerpts[0], /40 mg once daily/);
    assert.match(caseQuote, /hazard ratio, 0\.70/);
    const source = fault === "completion" ? lesson : {...lesson, quiz_source_texts: {[pmid]:
      [...lesson.quiz_source_texts[pmid], fault === "partial" ? "Participants received atorvastatin 40 mg."
        : "Participants in the atorvastatin arm received 40 mg once daily."]}};
    publishLessons([source]);
    const mock = fakeGroq([fault], 50, source);
    const rejections = [];
    assert.equal(await main({root, env: rerunEnv, date, fetchImpl: mock.fetchImpl, log: m => rejections.push(m)}), 3);
    assert.deepEqual(mock.calls.slice(1, 3).map(({mode, slots}) => [mode, ...slots]), [
      ["solve", ...expectedSlots], ["repair", ...[1, 2, 3].filter(n => !expectedSlots.includes(n))],
    ], "only grounded items reach the solver; only failed slots reach repair");
    const items = read()[id][0].items;
    if (fault !== "ambiguous") assert.deepEqual(Array.from(items[0].quotes), [caseQuote, excerpts[0]]);
    else assert.equal(items[0].quote, caseQuote, "ambiguous item is replaced, not auto-completed");
    assert.ok(rejections.some(m => /Rejected case item 2: numbers;.*value=\["30"\]/.test(m)));
  }
  publishLessons([lesson]);
  for (const fault of ["multi-key", "answer-first", "primary-verdict", "log-explanation"]) {
    const mock = fakeGroq([fault], 90);
    const logs = [];
    assert.equal(await main({root, env: rerunEnv, date, fetchImpl: mock.fetchImpl, log: m => logs.push(m)}), 3);
    if (fault === "multi-key") {
      assert.deepEqual(mock.calls[2].slots, [1, 2, 3], "multiple, missing and malformed keys all require repair");
      assert.ok(logs.filter(m => /Rejected case item \d: resolve/.test(m)).length === 3);
    } else if (fault === "answer-first" || fault === "primary-verdict") {
      assert.deepEqual(mock.calls[1].slots, [1, 2, 3]);
      if (fault === "primary-verdict") {
        assert.deepEqual(mock.calls[2].slots, [1], "a missing primary finding verdict requires repair");
        assert.match(logs.find(m => m.startsWith("Rejected case item 1:")), /citation-order/);
      }
      assert.deepEqual(Array.from(read()[id][0].items[0].quotes), [caseQuote, excerpts[0]]);
    } else {
      const entry = logs.find(m => /Rejected case item 1: numbers/.test(m));
      const evidence = JSON.parse(entry.split("; evidence=")[1]);
      assert.equal(evidence.explanations.en, "The source reports fewer primary cardiovascular events. ".repeat(7) + "A final unsupported figure is 30%.");
      assert.ok(evidence.explanations.vi);
    }
  }
  console.log("Independent solver rejects non-singleton keys; numeric answer citations are reordered; full explanations are logged: OK");
  const countMock = fakeGroq(["count-completion"], 60);
  assert.equal(await main({root, env: rerunEnv, date, fetchImpl: countMock.fetchImpl, log: quiet}), 3);
  assert.deepEqual(countMock.calls[1].slots, [1, 2, 3], "a missing enrollment count doesn't require a repair");
  assert.deepEqual(Array.from(read()[id][0].items[0].quotes), [caseQuote, excerpts[1]]);
  for (const [fault, background] of [["effects-completion", excerpts[1]], ["claims-completion", excerpts[0]],
    ["option-dose-completion", excerpts[0]], ["explanation-dose-completion", excerpts[0]]]) {
    const mock = fakeGroq([fault], 70);
    assert.equal(await main({root, env: rerunEnv, date, fetchImpl: mock.fetchImpl, log: quiet}), 3);
    assert.deepEqual(mock.calls[1].slots, [1, 2, 3], "a grounding failure resolved by the second citation doesn't require a repair");
    assert.deepEqual(Array.from(read()[id][0].items[0].quotes), [caseQuote, background]);
  }
  console.log("Citation completion: qualifying population and enrollment count also complete after claims or effects failures: OK");
  console.log("Citation completion: STAREE population and regimen supported; partial matches ignored; absent 30% and true ambiguity rejected: OK");
  console.log("Case-only generation: three cases per set, selective repairs, independent re-solve, no-key theory fallback: OK");
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, {recursive: true, force: true}));
