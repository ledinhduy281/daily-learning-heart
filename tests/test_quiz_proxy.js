const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const {createHash} = require("node:crypto");
const read = f => fs.readFileSync(require.resolve("../backend/apps_script/" + f), "utf8");
const deviceId = "abcdef0123456789".repeat(4);
const scope = {window: {}};
vm.runInNewContext(fs.readFileSync(require.resolve("../data/briefings.js"), "utf8"), scope);
const lesson = scope.window.EBM_BRIEFINGS_DATA.focused_lessons["2"];
const pmid = lesson.primary_source.pmid, excerpts = lesson.quiz_source_texts[pmid];
const quote = excerpts.find(t => t.includes("hazard ratio"));
const opts = l => l.map(t => ({vi: t, en: t}));
const theory = {type: "theory", pmid, quote, answer: "B", stem_vi: "Hazard ratio của biến cố tim mạch chính trong STAREE là bao nhiêu?",
  stem_en: "What was the hazard ratio for a primary cardiovascular event in STAREE?", options: opts(["1.10", "0.70", "0.50", "0.94"]),
  explanation_vi: "Abstract báo cáo hazard ratio 0.70.", explanation_en: "The abstract reports a hazard ratio of 0.70."};
const kase = {...theory, type: "case", answer: "A",
  stem_vi: "Bà 74 tuổi chưa có bệnh tim mạch hỏi atorvastatin có giảm biến cố tim mạch không; câu nào đúng với STAREE?",
  stem_en: "A 74-year-old woman without cardiovascular disease asks whether atorvastatin lowers events; which fits STAREE?",
  options: opts(["Fewer primary events", "No effect", "More events", "Not tested"])};
const reply = obj => JSON.stringify({choices: [{message: {content: JSON.stringify(obj)}}]});

function setup(properties = {GROQ_API_KEY: "test-only-placeholder", PEPPER: "pep"}) {
  const state = {properties, calls: [], locked: false, now: Date.parse("2026-11-25T03:00:00Z"),
    replies: [{status: 200, body: reply({questions: [theory, kase, {...kase, quote: "invented text that is not in the source"}]})},
      {status: 200, body: reply({answers: ["B", "A"]})}]};
  const sandbox = {
    Date: class extends Date {constructor(...a) {super(...(a.length ? a : [state.now]));}},
    PropertiesService: {getScriptProperties: () => ({
      getProperty: n => state.properties[n] || null, getProperties: () => ({...state.properties}),
      setProperty: (n, v) => {assert.ok(state.locked); state.properties[n] = v;},
      deleteProperty: n => {assert.ok(state.locked); delete state.properties[n];}})},
    LockService: {getScriptLock: () => ({tryLock: () => (state.locked = true), releaseLock: () => {state.locked = false;}})},
    Utilities: {DigestAlgorithm: {SHA_256: "sha256"}, Charset: {UTF_8: "utf8"},
      computeDigest: (a, v, c) => Array.from(createHash(a).update(v, c).digest(), b => b > 127 ? b - 256 : b),
      formatDate: d => new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10)},
    ContentService: {MimeType: {JSON: "json"}, createTextOutput: t => ({getContent: () => t, setMimeType() { return this; }})},
    UrlFetchApp: {fetch: (url, options) => {
      assert.equal(state.locked, false);
      state.calls.push(JSON.parse(options.payload));
      const r = state.replies[(state.calls.length - 1) % state.replies.length];
      return {getResponseCode: () => r.status, getContentText: () => r.body};
    }}
  };
  vm.createContext(sandbox);
  vm.runInContext(read("CaseQuiz.gs") + "\n;globalThis.CaseQuiz = CaseQuiz;\n" + read("Quiz.gs"), sandbox);
  state.request = (changes = {}) => {
    const body = sandbox.quizHandle_({action: "quiz", device_id: deviceId, lang: "vi",
      lesson: {pmid, kind: "landmark_rct", title: lesson.primary_source.name, excerpts}, ...changes}).getContent();
    assert.ok(!body.includes("test-only-placeholder") && !body.includes(deviceId));
    return JSON.parse(body);
  };
  return state;
}

let s = setup();
let r = s.request();
assert.equal(r.ok, true);
assert.deepEqual(r.items.map(i => i.type), ["theory", "case"], "invented quotes are dropped");
assert.ok(r.items.every(i => i.ai_generated));
assert.equal(r.remaining, 1);
assert.equal(s.calls.length, 2, "one generation call plus one independent re-solve");
assert.ok(!JSON.stringify(s.calls[1].messages).includes('"answer"'), "the re-solve call does not see the answer key");
assert.equal(s.calls[0].response_format.type, "json_object");
assert.equal(s.request().remaining, 0);
assert.deepEqual(s.request(), {ok: false, error: "device_daily_cap", remaining: 0}, "max two presses per device per day");
assert.equal(s.calls.length, 4);
assert.equal(s.request({device_id: "1".repeat(64)}).ok, true, "other devices keep their own two presses");
s.now += 24 * 3600000;
assert.equal(s.request().ok, true, "the cap resets on the next Vietnam day");
assert.ok(!Object.keys(s.properties).some(k => k.includes("2026-11-25")), "old counters are cleaned up");
assert.ok(!Object.keys(s.properties).some(k => k.startsWith("chat_")), "quiz presses do not use the chat quota");

s = setup();
s.replies = [{status: 200, body: reply({questions: [theory, kase]})}, {status: 200, body: reply({answers: ["C", "A"]})}];
assert.deepEqual(s.request(), {ok: false, error: "invalid_output", remaining: 1}, "a set fails if re-solving disagrees on all theory items");

s = setup();
s.replies = [{status: 500, body: ""}];
assert.deepEqual(s.request(), {ok: false, error: "upstream"});
assert.equal(s.request().ok, false);
assert.equal(Number(Object.entries(s.properties).find(([k]) => k.startsWith("quiz_device_"))[1]), 0, "upstream failures refund the press");

s = setup();
s.replies = [{status: 200, body: reply({questions: [theory, kase]})}, {status: 429, body: ""}];
assert.deepEqual(s.request(), {ok: false, error: "upstream"}, "a failed re-solve call is an upstream failure");
assert.equal(Number(Object.entries(s.properties).find(([k]) => k.startsWith("quiz_device_"))[1]), 0, "a failed re-solve refunds the press");
assert.equal(Number(Object.entries(s.properties).find(([k]) => k.startsWith("quiz_daily_"))[1]), 0);

s = setup();
s.replies = [{status: 200, body: "not json"}];
assert.deepEqual(s.request(), {ok: false, error: "upstream"});
assert.equal(Number(Object.entries(s.properties).find(([k]) => k.startsWith("quiz_device_"))[1]), 0, "a thrown upstream error refunds the press");

s = setup({GROQ_API_KEY: "test-only-placeholder", PEPPER: "pep", QUIZ_DAILY_CAP: "1"});
assert.equal(s.request().ok, true);
assert.equal(s.request({device_id: "2".repeat(64)}).error, "daily_cap");

assert.equal(setup({}).request().error, "not_configured");
for (const bad of [{device_id: "x"}, {lesson: {pmid: "1", kind: "landmark_rct", title: "t", excerpts: []}},
  {lesson: {pmid: pmid, kind: "blog", title: "t", excerpts}}, {lesson: {pmid, kind: "landmark_rct", title: "t", excerpts: ["x".repeat(1501)]}},
  {lesson: {pmid, kind: "landmark_rct", title: "t", excerpts: Array(9).fill(quote)}}]) {
  s = setup();
  assert.equal(s.request(bad).ok, false);
  assert.equal(s.calls.length, 0);
}
const code = read("Code.gs");
assert.ok(code.includes("request.action === 'quiz' && typeof quizHandle_ === 'function') return quizHandle_(request);"));
console.log("Apps Script quiz proxy checks passed (grounding, re-solve, 2 presses per device, refunds, caps, routing).");
