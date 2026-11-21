const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {create, KEY} = require('../device_profile.js');
class Storage {
  constructor(values = {}) { this.values = new Map(Object.entries(values)); }
  get length() { return this.values.size; }
  key(i) { return [...this.values.keys()][i]; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}
let calls = 0;
const id = 'a9876543-1234-4123-8123-123456789abc';
const crypto = {randomUUID() { calls++; return id; }};
const storage = new Storage();
{
  const shared = new Storage(), a = create(shared, crypto), b = create(shared, crypto);
  a.activity(['a'], ['a']); a.set('ebm_ui_lang', 'en'); a.rename('New name');
  b.activity(['b'], ['b']); b.set('ebm_font_scale', '1.2');
  const restored = create(shared, crypto);
  assert.deepEqual(restored.profile.read_ids, ['a','b']);
  assert.deepEqual(restored.profile.bookmarked_ids, ['a','b']);
  assert.equal(restored.profile.display_name, 'New name');
  assert.equal(restored.get('ebm_ui_lang'), 'en');
  assert.equal(restored.get('ebm_font_scale'), '1.2');
  restored.activity(['a','b'], ['b']);
  assert.deepEqual(create(shared, crypto).profile.bookmarked_ids, ['b']);
}
calls = 0;
let device = create(storage, crypto);
assert.equal(calls, 1);
assert.equal(device.profile.device_id, id);
device.activity(['lesson'], ['saved']);
device.set('ebm_socratic_state_v1', JSON.stringify({5: {correct_count: 3, streak: 2}}));
device.set('soaica_chat_sessions_v1', JSON.stringify([{id: 'chat', messages: ['one']}])) ;
device.set('ebm_ui_lang', 'en');
device.set('ebm_font_scale', '1.16');
device.rename('Doctor A');
device = create(storage, crypto);
assert.equal(calls, 1);
assert.deepEqual(device.profile.read_ids, ['lesson']);
assert.equal(device.get('ebm_font_scale'), '1.16');
assert.equal(JSON.parse(device.get('ebm_socratic_state_v1'))[5].streak, 2);
assert.equal(device.profile.display_name, 'Doctor A');
const backup = device.exportJSON();
{
  const quizzes = create(new Storage(), crypto);
  const old = {last_question:'old',correct_key:'A',current_options:['A','B','C','D'],explanation:'old explanation',current_question:{stem:'old'},messages:['old']};
  const incoming = {last_question:'new',correct_key:'C',current_options:['W','X','Y','Z'],explanation:'new explanation',messages:['new']};
  quizzes.set('ebm_socratic_state_v1',JSON.stringify({1:old,2:old}));
  quizzes.importJSON(JSON.stringify({...JSON.parse(backup),progress:{ebm_socratic_state_v1:JSON.stringify({1:incoming})}}));
  let state = JSON.parse(quizzes.get('ebm_socratic_state_v1'));
  assert.deepEqual(state[1],incoming); assert.deepEqual(state[2],old);
  const shared = new Storage({[KEY]:JSON.stringify(quizzes.profile)});
  const a = create(shared,crypto), b = create(shared,crypto);
  a.set('ebm_socratic_state_v1',JSON.stringify({1:incoming,2:incoming}));
  b.set('ebm_socratic_state_v1',JSON.stringify({1:old,2:old}));
  state = JSON.parse(create(shared,crypto).get('ebm_socratic_state_v1'));
  assert.deepEqual(state[1],old); assert.deepEqual(state[2],incoming);
}
{
  const chats = create(new Storage(), crypto);
  const recent = {id:'same', updatedAt:'2026-11-20T00:00:00Z', messages:['new']};
  const longer = {id:'long', messages:['one','two']};
  chats.set('soaica_chat_sessions_v1', JSON.stringify([recent,longer]));
  const incoming = {...JSON.parse(backup), progress:{soaica_chat_sessions_v1:JSON.stringify([
    {...recent, updatedAt:'2026-11-19T00:00:00Z', messages:['old']}, {id:'long',messages:['one']}, {id:'other',messages:[]}
  ])}};
  chats.importJSON(JSON.stringify(incoming));
  const merged = JSON.parse(chats.get('soaica_chat_sessions_v1'));
  assert.equal(merged.length,3); assert.deepEqual(merged.find(s=>s.id==='same'),recent);
  assert.deepEqual(merged.find(s=>s.id==='long'),longer);
  chats.importJSON(JSON.stringify(incoming));
  assert.equal(JSON.parse(chats.get('soaica_chat_sessions_v1')).length,3);
}
{
  const limited = new Storage({[KEY]: JSON.stringify(device.profile)});
  limited.setItem = () => {throw new Error('quota');};
  const failed = create(limited), previous = failed.exportJSON();
  assert.throws(() => failed.importJSON(JSON.stringify({...JSON.parse(backup), display_name:'Not saved'}), 'replace'), {code:'STORAGE_WRITE_FAILED'});
  assert.equal(failed.exportJSON(), previous);
}
assert.ok(!Object.hasOwn(JSON.parse(backup), 'device_id'));
assert.ok(!backup.includes(id));
const imported = create(new Storage(), {randomUUID: () => 'b9876543-1234-4123-8123-123456789abc'});
imported.importJSON(backup);
assert.notEqual(imported.profile.device_id, id);
const localId = imported.profile.device_id;
imported.importJSON(JSON.stringify(device.profile));
assert.equal(imported.profile.device_id, localId);
assert.deepEqual(imported.profile.progress, {...device.profile.progress, ebm_legacy_server_migrated:'1'});
assert.deepEqual(imported.profile.read_ids, ['lesson']);
imported.activity(['local'], ['local-saved']);
imported.importJSON(backup, 'merge');
assert.deepEqual(imported.profile.read_ids, ['local', 'lesson']);
imported.set('ebm_only_here', 'local');
imported.importJSON(backup, 'replace');
assert.equal(imported.get('ebm_only_here'), null);
assert.deepEqual(imported.profile.read_ids, ['lesson']);
const legacy = new Storage({
  ebm_offline_user_activity: JSON.stringify({read_ids: ['old'], bookmarked_ids: ['bookmark']}),
  ebm_cloud_current_user: 'doctor@example.com',
  ebm_auth_token: 'private-session',
  ebm_cloud_users_db: JSON.stringify({'doctor@example.com': {password: 'private-password', full_name: 'Legacy Doctor', read_ids: ['email-read'], bookmarked_ids: ['email-saved'], quiz: {score: 4}}}),
  ebm_progress_by_user: JSON.stringify({'other@example.com': {read_ids: ['other-read']}}),
  ebm_ui_lang: 'en',
  ebm_socratic_state_v1: JSON.stringify({1: {streak: 3}})
});
const migrated = create(legacy, crypto);
assert.deepEqual(migrated.profile.read_ids, ['old', 'other-read', 'email-read']);
assert.deepEqual(migrated.profile.bookmarked_ids, ['bookmark', 'email-saved']);
assert.equal(migrated.profile.display_name, 'Legacy Doctor');
assert.equal(migrated.get('ebm_ui_lang'), 'en');
assert.equal(JSON.parse(migrated.get('ebm_legacy_users_progress'))['doctor@example.com'].quiz.score, 4);
assert.ok(!/private-password|private-session/.test(migrated.exportJSON()));
assert.ok(legacy.getItem('ebm_cloud_users_db').includes('private-password'));
const before = migrated.exportJSON();
for (const bad of ['{}', 'null', 'not-json', JSON.stringify({...device.profile, device_id: '../bad'}),
  JSON.stringify({...device.profile, read_ids: [null]}),
  JSON.stringify({...device.profile, progress: {ebm_auth_token: 'bad'}}),
  backup.replace('"version": 1', '"__proto__": {}, "version": 1')]) assert.throws(() => migrated.importJSON(bad));
assert.equal(migrated.exportJSON(), before);
assert.throws(() => migrated.rename(''));
assert.throws(() => migrated.rename('x'.repeat(101)));
const unavailable = {getItem() {throw Error('denied');}, setItem() {throw Error('full');}, get length() {throw Error('denied');}};
const memory = create(unavailable, {});
assert.match(memory.profile.device_id, /^[a-f0-9-]{36}$/);
memory.set('ebm_ui_lang', 'en');
assert.equal(memory.get('ebm_ui_lang'), 'en');
const broken = create(new Storage({[KEY]: 'broken', ebm_ui_lang: 'en'}), crypto);
assert.equal(broken.get('ebm_ui_lang'), 'en');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
{
  const profile = create(new Storage(),crypto);
  const pending = label => ({
    started:true, phase:'loop', last_question:`Question ${label}?`,
    current_options:['A','B','C','D'].map(key=>({key,text:`${label} ${key}`})),
    correct_key:label==='old'?'A':'D', explanation:`Explanation ${label}`,
    messages:[{role:'assistant',text:`Question ${label}?`}]
  });
  const first = pending('old'), second = pending('imported');
  profile.set('ebm_socratic_state_v1',JSON.stringify({1:first}));
  const importQuiz = record => profile.importJSON(JSON.stringify({
    ...JSON.parse(backup), progress:{ebm_socratic_state_v1:JSON.stringify({1:record})}
  }));
  importQuiz(second);
  const tutorCode = html.match(/const SocraticTutor = \{[\s\S]*?\n    \};/)[0];
  const app = {currentLang:'vi',selected:{pillar_id:1}};
  const tutor = vm.runInNewContext(`${tutorCode}; SocraticTutor`,{
    App:app,SOCRATIC_STATE_KEY:'ebm_socratic_state_v1',getPillarDisplayName:()=> 'Pillar',
    safeStorageGet:key=>profile.get(key),safeStorageSet:(key,value)=>profile.set(key,value)
  });
  let generated = 0;
  const fresh = {question:'Replacement question?',options:pending('fresh').current_options,correct_key:'B',explanation:'Replacement explanation'};
  tutor.buildDeterministicMcq = () => {generated++;return fresh;};
  tutor.loadStore();
  let session = tutor.getSession();
  for (const key of ['last_question','current_options','correct_key','explanation','messages']) {
    assert.deepEqual(JSON.parse(JSON.stringify(session[key])),second[key]);
  }
  assert.equal(generated,0);
  for (const broken of [
    {...second,current_options:[...first.current_options,...second.current_options]},
    {...second,current_options:[]},
    {...second,correct_key:''},
    {...second,last_question:''}
  ]) {
    importQuiz(broken);
    tutor.loadStore();
    session = tutor.getSession();
    assert.equal(session.last_question,fresh.question);
    assert.deepEqual(session.current_options,fresh.options);
    assert.equal(session.correct_key,fresh.correct_key);
    assert.equal(session.explanation,fresh.explanation);
    assert.equal(session.messages.at(-1).text,fresh.question);
    const saved = JSON.parse(profile.get('ebm_socratic_state_v1'))[1];
    assert.equal(saved.last_question,fresh.question);
    assert.equal(saved.messages.at(-1).text,fresh.question);
    const before = generated;
    tutor.getSession();
    assert.equal(generated,before);
  }
  app.currentLang = 'en';
  fresh.question = 'English replacement question?';
  fresh.explanation = 'English replacement explanation';
  tutor.renderUI = () => {};
  tutor.onLanguageChanged();
  assert.equal(session.explanation,fresh.explanation);
  assert.equal(session.options_lang,'en');
  assert.equal(session.messages.at(-1).text,session.last_question);
  tutor.store = {};
  const before = generated;
  assert.deepEqual(Array.from(tutor.getSession().current_options),[]);
  assert.equal(generated,before);
}
{
  const malicious = '<img src=x onerror="throw 1">';
  const escapeCode = html.match(/function escapeHtml\(str\) \{([\s\S]*?)\n    \}/)[0];
  const urlCode = html.match(/function safeChatSourceUrl\(value\) \{([\s\S]*?)\n    \}/)[0];
  const scope = {URL, document: {createElement() {return {children: [], appendChild(x) {this.children.push(x);}, addEventListener() {}};}}, Dom: {chatMessagesList: {appendChild() {}}}, App: {currentLang: 'en'}};
  vm.runInNewContext(`${escapeCode}\n${urlCode}`, scope);
  const render = html.match(/      renderMessageDom\(msgObj\) \{[\s\S]*?\n      \},/)[0].slice(0,-1);
  const fn = vm.runInNewContext(`({${render}}).renderMessageDom`, scope);
  const dom = fn({role: 'assistant', markdownText: malicious});
  assert.equal(dom.children[0].textContent, malicious);
  assert.equal(dom.children[0].innerHTML, undefined);
  assert.equal(scope.safeChatSourceUrl('javascript:alert(1)'), '#');
  assert.equal(scope.safeChatSourceUrl('https://pubmed.ncbi.nlm.nih.gov/'), 'https://pubmed.ncbi.nlm.nih.gov/');
  const body = html.match(/const bodyHtml = ([\s\S]*?);\n              return/)[1];
  assert.ok(vm.runInNewContext(body, {...scope, m: {role:'assistant', text:malicious}}).startsWith('&lt;img'));
}
assert.ok(!/authGateOverlay|auth-locked|type="password"|\/api\/auth\/(login|register|logout|reset-password)/.test(html));
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
for (const [, key] of html.matchAll(/document.getElementById\("([^"]+)"\)/g)) assert.ok(ids.has(key), `Missing DOM id ${key}`);
const headersCode = html.match(/function getAuthHeaders\(extra = \{\}\) \{([\s\S]*?)\n    \}/)[1];
const headers = vm.runInNewContext(`(function(extra={}) {${headersCode}})`, {deviceStore: device});
assert.equal(headers()['X-Device-Id'], id);
assert.equal(headers({'Content-Type': 'application/json'})['Content-Type'], 'application/json');
const streamCode = html.match(/async function consumeApiEvents\(path, onMessage\) \{([\s\S]*?)\n    \}/)[1];
async function checkStreams() {
  const legacyStorage = new Storage({ebm_auth_token:'old-session'});
  const replacement = create(legacyStorage, crypto);
  replacement.activity(['legacy-lesson'], []);
  const staleTab = create(legacyStorage, crypto);
  replacement.importJSON(JSON.stringify({...JSON.parse(backup), read_ids:[], bookmarked_ids:[], progress:{}}), 'replace');
  assert.equal(replacement.get('ebm_legacy_server_migrated'),'1');
  assert.equal(legacyStorage.getItem('ebm_auth_token'),null);
  staleTab.set('ebm_font_scale','1.1');
  assert.deepEqual(create(legacyStorage,crypto).profile.read_ids,[]);
  const bootstrapCode = html.match(/async function bootstrapSessionAndStatus\(\) \{([\s\S]*?)\n    \}/)[1];
  const requests = [];
  const bootstrap = vm.runInNewContext(`(async function() {${bootstrapCode}})`, {
    App:{}, window:{EBM_SERVER:true,localStorage:legacyStorage},
    safeStorageGet:key=>replacement.get(key), safeStorageSet:(key,value)=>replacement.set(key,value),
    setAuthenticatedUser() {}, loadOfflineFeedbackStore() {}, renderAllViewsAfterAuth() {},
    syncDeviceActivity:async () => {}, getAuthHeaders:() => ({}), applyServerStatus() {},
    fetch:async path => {requests.push(path);return {ok:true,json:async () => ({ok:true})};}
  });
  await bootstrap();
  assert.deepEqual(requests,['/api/status']);
  const importBody = html.match(/importFile.addEventListener\("change", async \(\) => \{([\s\S]*?)\n      \}\);/)[1];
  let reloads = 0, toast = '';
  const importFile = {files: [{size:backup.length, text:async () => backup}], value:'file.json'};
  const onImport = vm.runInNewContext(`(async function() {${importBody}})`, {
    importFile, document:{getElementById:() => ({value:'replace'})}, App:{currentLang:'en'},
    window:{confirm:() => true, location:{reload() {reloads++;}}},
    deviceStore:{importJSON() {throw Object.assign(new Error('quota'), {code:'STORAGE_WRITE_FAILED'});}},
    showToast(message) {toast=message;}
  });
  await onImport();
  assert.equal(reloads,0); assert.match(toast,/browser storage/); assert.equal(importFile.value,'');
  let source, requestHeaders;
  const consume = vm.runInNewContext(`(async function(path, onMessage) {${streamCode}})`, {
    TextDecoder, getAuthHeaders: headers,
    fetch: async (path, options) => {requestHeaders = options.headers; return source;}
  });
  const encoder = new TextEncoder();
  const bytes = encoder.encode('data: {"message":"Đã lưu"}\n\ndata: {"type":"done"}\n\n');
  source = {ok: true, body: new ReadableStream({start(c) {
    c.enqueue(bytes.slice(0, 21)); c.enqueue(bytes.slice(21)); c.close();
  }})};
  const messages = [];
  await consume('/api/refresh-stream', evt => {
    const data = JSON.parse(evt.data); messages.push(data);
    if (data.type === 'done') return false;
  });
  assert.equal(messages[0].message, 'Đã lưu');
  assert.equal(messages.length, 2);
  assert.equal(requestHeaders['X-Device-Id'], id);
  source = {ok: true, body: new ReadableStream({start(c) {c.close();}})};
  await assert.rejects(() => consume('/api/refresh-stream', () => {}), /before completion/);
  source = {ok: false};
  await assert.rejects(() => consume('/api/refresh-stream', () => {}), /unavailable/);
  console.log('Device profile UUID/reuse, progress, import/export, migration, invalid/empty/storage errors, API headers/streams, static no-gate DOM, SPA syntax: OK');
}
checkStreams().catch(error => {console.error(error); process.exitCode = 1;});
