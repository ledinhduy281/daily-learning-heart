const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {main} = require("../generate_quiz_sets.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-sets-"));
fs.mkdirSync(path.join(root, "data"));
const scope = {window: {}};
vm.runInNewContext(fs.readFileSync(require.resolve("../data/briefings.js"), "utf8"), scope);
const template = scope.window.EBM_BRIEFINGS_DATA.focused_lessons["2"];
const date = "2026-12-01", id = "ebm-2026-12-01-p2-focused";
const lesson = {...template, id, date};
fs.writeFileSync(path.join(root, "data/briefings.js"), "window.EBM_BRIEFINGS_DATA = " + JSON.stringify({briefings: [lesson]}) + ";");
const pmid = lesson.primary_source.pmid;
const quote = lesson.quiz_source_texts[pmid].find(t => t.includes("hazard ratio"));
const opts = l => l.map(t => ({vi: t, en: t}));
const theory = n => ({type: "theory", pmid, quote, answer: "B", options: opts(["1.10", "0.70", "0.50", "0.94"]),
  stem_vi: `Câu ${n}: hazard ratio của biến cố tim mạch chính trong STAREE là bao nhiêu?`,
  stem_en: `Item ${n}: what was the hazard ratio for a primary cardiovascular event in STAREE?`,
  explanation_vi: "Abstract báo cáo hazard ratio 0.70.", explanation_en: "The abstract reports a hazard ratio of 0.70."});
const kase = n => ({...theory(n), type: "case", answer: "A", options: opts(["Fewer primary events", "No effect", "More events", "Not tested"]),
  stem_vi: `Ca ${n}: bà 74 tuổi, LDL 3,2 mmol/L, chưa có bệnh tim mạch, hỏi atorvastatin có giảm biến cố không; câu nào đúng với STAREE?`,
  stem_en: `Case ${n}: a 74-year-old woman (LDL 3.2 mmol/L) without cardiovascular disease asks whether atorvastatin lowers events; which fits STAREE?`,
  explanation_en: "STAREE enrolled 9,971 participants and the hazard ratio was 0.70; the other options contradict this."});
const reply = obj => ({ok: true, status: 200, headers: {get: () => null}, json: async () => ({choices: [{message: {content: JSON.stringify(obj)}}]})});

// Re-solve answers come from each stem's own key, except stems listed in `wrong`.
function fakeGroq(rounds, wrong = new Set()) {
  const calls = [], keys = new Map(rounds.flat().map(i => [i.stem_en, i.answer]));
  return {calls, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-only-placeholder");
    if (body.messages[0].content.startsWith("Answer each")) {
      assert.ok(!body.messages[1].content.includes('"answer"'), "the re-solve call does not see the key");
      const stems = [...body.messages[1].content.matchAll(/^Q\d+: (.*)$/gm)].map(m => m[1]);
      return reply({answers: stems.map(st => wrong.has(st) ? "D" : keys.get(st))});
    }
    const generations = calls.filter(c => !c.messages[0].content.startsWith("Answer each")).length;
    return reply({questions: structuredClone(rounds[(generations - 1) % rounds.length])});
  }};
}
const range = (from, n, make) => Array.from({length: n}, (_, i) => make(from + i));
const env = {GROQ_API_KEY: "test-only-placeholder"};
const read = () => {
  const s = {window: {}};
  vm.runInNewContext(fs.readFileSync(path.join(root, "data/quiz_sets.js"), "utf8"), s);
  return s.window.EBM_QUIZ_SETS.sets;
};
const quiet = () => {};

(async () => {
  assert.equal(await main({root, env: {}, date, log: quiet}), 0, "no key: nothing to do");
  assert.ok(!fs.existsSync(path.join(root, "data/quiz_sets.js")));

  let g = fakeGroq([
    [...range(1, 3, theory), ...range(1, 3, kase), {...kase(9), quote: "paraphrased text that is not in the source"}],
    [...range(4, 3, theory), ...range(4, 3, kase), {...theory(8), explanation_en: "Not 1.10: the abstract reports 0.70."}],
    [...range(11, 3, theory), ...range(11, 3, kase), {...kase(7), stem_en: kase(7).stem_en + " She takes atorvastatin 80 mg."}],
    [{...theory(21), quote: undefined, excerpt: lesson.quiz_source_texts[pmid].indexOf(quote) + 1}, theory(22),
      {...kase(21), options: opts(["A. Fewer primary events", "B. No effect", "C. More events", "D. Not tested"]),
        explanation_vi: "Trích dẫn 1 cho thấy hazard ratio 0.70, nên atorvastatin giảm biến cố."}, kase(22)],
  ], new Set([kase(6).stem_en]));
  const logs = [];
  assert.equal(await main({root, env, date, fetchImpl: g.fetchImpl, log: m => logs.push(m)}), 3);
  let sets = read()[id];
  assert.equal(sets.length, 3);
  for (const set of sets) {
    assert.equal(set.items.map(i => i.type).sort().join(), "case,case,case,theory,theory,theory");
    assert.ok(set.items.every(i => !/^[A-D]\. /.test(i.choices?.[0] || i.options?.[0]?.en || "")));
    assert.ok(set.items.every(i => i.ai_generated && i.pmid === pmid && quote.includes(i.quote)));
  }
  assert.equal(new Set(sets.flatMap(s => s.items.map(i => i.stem_en))).size, sets.flatMap(s => s.items).length, "no repeats");
  assert.equal(sets.flatMap(s => s.items).filter(i => i.stem_en.startsWith("Item 8")).length, 0,
    "an explanation that repeats a wrong option's number is rejected");
  assert.ok(logs.some(m => /"quote":1/.test(m) && /"resolve":1/.test(m) && /"dose":1/.test(m) && /"numbers":1/.test(m)), logs.join("\n"));
  assert.ok(!fs.readFileSync(path.join(root, "data/quiz_sets.js"), "utf8").includes("test-only-placeholder"));
  assert.equal(g.calls[0].response_format.type, "json_object");

  g = fakeGroq([[theory(5), kase(5)]]);
  assert.equal(await main({root, env, date, fetchImpl: g.fetchImpl, log: quiet}), 0, "a lesson with 3 sets is left alone");
  assert.equal(g.calls.length, 0);

  g = fakeGroq([[...range(31, 3, theory), ...range(31, 2, kase)]]);
  assert.equal(await main({root, env, date: "2026-12-02", fetchImpl: g.fetchImpl, log: quiet}), 0, "no lesson for that date");
  fs.writeFileSync(path.join(root, "data/briefings.js"), "window.EBM_BRIEFINGS_DATA = " +
    JSON.stringify({briefings: [lesson, {...lesson, id: "ebm-2026-12-02-p2-focused", date: "2026-12-02"}]}) + ";");
  assert.equal(await main({root, env, date: "2026-12-02", fetchImpl: g.fetchImpl, log: quiet}), 0, "sets short of 3 theory + 3 case are never published");
  assert.equal(read()["ebm-2026-12-02-p2-focused"], undefined);
  assert.equal(read()[id].length, 3, "earlier lessons keep their sets");
  console.log("Quiz set generation checks passed (no key, checks, re-solve, 3 mixed sets, idempotent, no partial sets).");
})().catch(e => { console.error(e); process.exit(1); });
