const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {createHash} = require('node:crypto');
const deviceId = '12345678-1234-4123-8123-123456789abc';
const hash = (id, pepper = '') => createHash('sha256').update(pepper + ':' + id.toLowerCase()).digest('hex');

const source = fs.readFileSync(require.resolve('../backend/apps_script/Chat.gs'), 'utf8');
function setup(properties = {GROQ_API_KEY: 'test-only-placeholder'}) {
  const state = {properties, calls: [], logs: [], status: 200, now: Date.parse('2026-11-22T03:00:00Z'), locked: false, canLock: true,
    body: JSON.stringify({choices: [{message: {content: '<think>private reasoning</think> Answer.'}}]})};
  const sandbox = {
    Date: class extends Date {constructor(...args){super(...(args.length?args:[state.now]));}},
    PropertiesService: {getScriptProperties: () => ({
      getProperty: name => state.properties[name] || null,
      getProperties: () => ({...state.properties}),
      setProperty: (name,value) => {assert.ok(state.locked);state.properties[name]=value;},
      deleteProperty: name => {assert.ok(state.locked);delete state.properties[name];}
    })},
    LockService: {getScriptLock: () => ({tryLock: () => {state.locked=state.canLock;return state.canLock;},releaseLock: () => {assert.ok(state.locked);state.locked=false;}})},
    Utilities: {DigestAlgorithm: {SHA_256: 'sha256'}, Charset: {UTF_8: 'utf8'},
      computeDigest: (algorithm, value, charset) => Array.from(createHash(algorithm).update(value, charset).digest(), b => b > 127 ? b - 256 : b),
      formatDate: (date, timezone, format) => {
      assert.equal(timezone, 'Asia/Ho_Chi_Minh'); assert.equal(format, 'yyyy-MM-dd'); return new Date(date.getTime()+7*3600000).toISOString().slice(0,10);
    }},
    ContentService: {MimeType: {JSON: 'json'}, createTextOutput: text => ({
      getContent: () => text, setMimeType(type) { assert.equal(type, 'json'); return this; }
    })},
    UrlFetchApp: {fetch: (url, options) => {
      assert.equal(state.locked,false);
      assert.ok(Number(state.properties['chat_daily_'+new Date(state.now+7*3600000).toISOString().slice(0,10)])>0);
      state.calls.push({url, options});
      if (state.throw) throw Error('sensitive upstream failure');
      return {getResponseCode: () => state.status, getContentText: () => state.body};
    }},
    Logger: {log: text => state.logs.push(text)}
  };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  state.request = changes => {
    const body = sandbox.chatHandle_({action: 'chat', device_id: deviceId, question: 'Explain heart failure.', history: [], context: 'Guideline evidence', lang: 'en', ...changes}).getContent();
    for (const value of ['test-only-placeholder', deviceId, hash(deviceId, properties.PEPPER || ''), properties.PEPPER].filter(Boolean)) assert.ok(!body.includes(value));
    return JSON.parse(body);
  };
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
capped.now+=7*3600000;
assert.equal(capped.request().error,'daily_cap');assert.equal(capped.calls.length,1);
assert.equal(capped.properties['chat_daily_2026-11-22'],'1');
capped.now+=24*3600000;
assert.equal(capped.request().ok,true);assert.equal(capped.calls.length,2);
assert.equal(capped.properties['chat_daily_2026-11-22'],undefined);
assert.equal(capped.properties['chat_daily_2026-11-23'],'1');
assert.equal(capped.locked,false);
const busy=setup();busy.canLock=false;
assert.equal(busy.request().error,'busy');assert.equal(busy.calls.length,0);
const defaults = setup();
defaults.properties.chat_daily_2026_ignored='keep';
defaults.properties['chat_daily_2026-11-22']='300';
assert.equal(defaults.request().error, 'daily_cap');
assert.equal(defaults.locked,false);assert.equal(defaults.properties.chat_daily_2026_ignored,'keep');
for (const mode of ['http', 'empty', 'invalid', 'throw']) {
  const s = setup();
  if (mode === 'http') { s.status = 500; s.body = 'test-only-placeholder'; }
  if (mode === 'empty') s.body = JSON.stringify({choices: [{message: {content: '<think>only reasoning</think>'}}]});
  if (mode === 'invalid') s.body = 'invalid JSON';
  if (mode === 'throw') s.throw = true;
  assert.deepEqual(s.request(), {ok: false, error: 'upstream'});
  assert.equal(s.properties['chat_daily_2026-11-22'],'1');assert.equal(s.locked,false);
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
assert.equal(payload.reasoning_effort, 'low');
assert.equal(payload.include_reasoning, false);
assert.ok(!('reasoning_format' in payload));
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
assert.ok(!('reasoning_effort' in JSON.parse(custom.calls[0].options.payload)));
assert.ok(!('include_reasoning' in JSON.parse(custom.calls[0].options.payload)));
const ossOverride = setup({GROQ_API_KEY: 'test-only-placeholder', GROQ_MODEL: 'openai/gpt-oss-20b'});
ossOverride.request();
assert.equal(JSON.parse(ossOverride.calls[0].options.payload).reasoning_effort, 'low');
assert.equal(JSON.parse(ossOverride.calls[0].options.payload).include_reasoning, false);
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
for (const device_id of [undefined, null, '', 42, {}, 'x'.repeat(1000), '../invalid', deviceId + '\n']) {
  const invalid = setup();
  assert.equal(invalid.request({device_id}).error, 'invalid_device_id');
  assert.equal(invalid.calls.length, 0);
  assert.equal(Object.keys(invalid.properties).length, 1);
}
const devices = setup({GROQ_API_KEY: 'test-only-placeholder', PEPPER: 'private-test-salt'});
for (let i = 0; i < 30; i++) assert.equal(devices.request().ok, true);
assert.equal(devices.request({device_id: deviceId.toUpperCase()}).error, 'device_daily_cap');
assert.equal(devices.calls.length, 30);
assert.equal(devices.request({device_id: '22345678-1234-4123-8123-123456789abc'}).ok, true);
assert.equal(devices.properties['chat_daily_2026-11-22'], '31');
const oldDeviceKey = 'chat_device_2026-11-22_' + hash(deviceId, 'private-test-salt');
assert.equal(devices.properties[oldDeviceKey], '30');
assert.ok(!JSON.stringify(devices.properties).includes(deviceId));
devices.now = Date.parse('2026-11-22T17:00:00Z');
assert.equal(devices.request().ok, true);
assert.equal(devices.properties[oldDeviceKey], undefined);
assert.equal(devices.properties['chat_daily_2026-11-22'], undefined);
assert.equal(devices.properties['chat_daily_2026-11-23'], '1');
const global = setup({GROQ_API_KEY: 'test-only-placeholder', CHAT_DAILY_CAP: '999'});
for (let i = 0; i < 300; i++) assert.equal(global.request({device_id: i.toString(16).padStart(8, '0') + '-1234-4123-8123-123456789abc'}).ok, true);
assert.equal(global.request().error, 'daily_cap');
assert.equal(global.calls.length, 300);
console.log('Apps Script chat proxy checks passed (validation, device/global caps, daily reset, privacy, upstream, prompts, testChat).');
