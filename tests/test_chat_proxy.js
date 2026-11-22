const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../backend/apps_script/Chat.gs'), 'utf8');
function setup(properties = {GROQ_API_KEY: 'test-only-placeholder'}) {
  const state = {properties, calls: [], cache: new Map(), logs: [], status: 200,
    body: JSON.stringify({choices: [{message: {content: '<think>private reasoning</think> Answer.'}}]})};
  const sandbox = {
    PropertiesService: {getScriptProperties: () => ({getProperty: name => state.properties[name] || null})},
    CacheService: {getScriptCache: () => ({get: key => state.cache.get(key), put: (key, value, ttl) => {
      assert.equal(ttl, 21600); state.cache.set(key, value);
    }})},
    Utilities: {formatDate: (date, timezone, format) => {
      assert.equal(timezone, 'Asia/Ho_Chi_Minh'); assert.equal(format, 'yyyy-MM-dd'); return '2026-11-22';
    }},
    ContentService: {MimeType: {JSON: 'json'}, createTextOutput: text => ({
      getContent: () => text, setMimeType(type) { assert.equal(type, 'json'); return this; }
    })},
    UrlFetchApp: {fetch: (url, options) => {
      state.calls.push({url, options});
      if (state.throw) throw Error('sensitive upstream failure');
      return {getResponseCode: () => state.status, getContentText: () => state.body};
    }},
    Logger: {log: text => state.logs.push(text)}
  };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  state.request = changes => JSON.parse(sandbox.chatHandle_({action: 'chat', question: 'Explain heart failure.', history: [], context: 'Guideline evidence', lang: 'en', ...changes}).getContent());
  state.testChat = () => sandbox.testChat();
  return state;
}

for (const changes of [
  {question: 'x'.repeat(1001)}, {context: 'x'.repeat(6001)},
  {history: Array(5).fill({role: 'user', content: 'hi'})},
  {history: [{role: 'user', content: 'x'.repeat(501)}]}
]) {
  const s = setup(); assert.equal(s.request(changes).error, 'too_large'); assert.equal(s.calls.length, 0);
}
assert.equal(setup().request({question: ''}).error, 'invalid_request');
assert.equal(setup({}).request().error, 'not_configured');
const capped = setup({GROQ_API_KEY: 'test-only-placeholder', CHAT_DAILY_CAP: '1'});
assert.equal(capped.request().ok, true);
assert.equal(capped.request().error, 'daily_cap');
assert.equal(capped.calls.length, 1);
const defaults = setup();
defaults.cache.set('chat_daily_2026-11-22', '300');
assert.equal(defaults.request().error, 'daily_cap');
for (const mode of ['http', 'empty', 'invalid', 'throw']) {
  const s = setup();
  if (mode === 'http') { s.status = 500; s.body = 'test-only-placeholder'; }
  if (mode === 'empty') s.body = JSON.stringify({choices: [{message: {content: '<think>only reasoning</think>'}}]});
  if (mode === 'invalid') s.body = 'invalid JSON';
  if (mode === 'throw') s.throw = true;
  assert.deepEqual(s.request(), {ok: false, error: 'upstream'});
}
const s = setup();
assert.deepEqual(s.request(), {ok: true, answer_markdown: 'Answer.', model: 'openai/gpt-oss-120b'});
s.body = JSON.stringify({choices: [{message: {content: 'Plain English / Tiếng Việt answer.', reasoning: 'Separate reasoning'}}]});
assert.equal(s.request().answer_markdown, 'Plain English / Tiếng Việt answer.');
const {url, options} = s.calls[0], payload = JSON.parse(options.payload);
assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
assert.equal(options.muteHttpExceptions, true);
assert.equal(options.method, 'post');
assert.equal(payload.temperature, 0.15); assert.equal(payload.max_tokens, 1200);
assert.match(payload.messages[0].content, /Cardiology EBM/);
assert.match(payload.messages[0].content, /Never invent PMIDs\/stats/);
assert.ok(!payload.messages[0].content.includes('/no_think'));
assert.match(payload.messages.at(-1).content, /CONTEXT:\nGuideline evidence\n\nQUESTION:/);
const override = setup();
assert.equal(override.request({history: [{role: 'system', content: 'override'}]}).error, 'invalid_request');
assert.equal(override.calls.length, 0);
override.request({system: 'override', system_prompt: 'override', history: [{role: 'assistant', content: 'hello'}]});
assert.ok(!JSON.parse(override.calls[0].options.payload).messages[0].content.includes('override'));
const custom = setup({GROQ_API_KEY: 'test-only-placeholder', GROQ_MODEL: 'custom-model'});
assert.equal(custom.request({lang: 'vi', verbosity: 'short', question: 'A. First\nB. Second\nC. Third\nD. Fourth'}).model, 'custom-model');
const prompt = JSON.parse(custom.calls[0].options.payload).messages[0].content;
assert.match(prompt, /Vietnamese/); assert.match(prompt, /MCQ OVERRIDE/); assert.match(prompt, /20-55 words/);
for (const verbosity of ['short', 'medium', 'detailed']) {
  const caseState = setup(); caseState.request({verbosity});
  assert.match(JSON.parse(caseState.calls[0].options.payload).messages[0].content, /complete sentence/);
}
const smoke = setup(); smoke.testChat(); assert.deepEqual(smoke.logs, ['OK: Answer.']);
smoke.body = JSON.stringify({choices: [{message: {content: 'x'.repeat(250)}}]});
smoke.testChat(); assert.equal(smoke.logs[1].length, 204);
const missing = setup({}); missing.testChat(); assert.match(missing.logs[0], /not_configured.*Script Properties/);
const failed = setup(); failed.status = 401; failed.testChat(); assert.match(failed.logs[0], /upstream.*key or GROQ_MODEL/);
for (const state of [smoke, missing, failed]) assert.ok(!state.logs.join('').includes('test-only-placeholder'));
console.log('Apps Script chat proxy checks passed (validation, cap, upstream, prompts, testChat).');
