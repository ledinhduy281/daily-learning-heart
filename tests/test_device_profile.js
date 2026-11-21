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
}
let calls = 0;
const id = 'a9876543-1234-4123-8123-123456789abc';
const crypto = {randomUUID() { calls++; return id; }};
const storage = new Storage();
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
assert.ok(!Object.hasOwn(JSON.parse(backup), 'device_id'));
assert.ok(!backup.includes(id));
const imported = create(new Storage(), {randomUUID: () => 'b9876543-1234-4123-8123-123456789abc'});
imported.importJSON(backup);
assert.notEqual(imported.profile.device_id, id);
const localId = imported.profile.device_id;
imported.importJSON(JSON.stringify(device.profile));
assert.equal(imported.profile.device_id, localId);
assert.deepEqual(imported.profile.progress, device.profile.progress);
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
  const malicious = '<img src=x onerror="throw 1">';
  const escapeCode = html.match(/function escapeHtml\(str\) \{([\s\S]*?)\n    \}/)[0];
  const urlCode = html.match(/function safeChatSourceUrl\(value\) \{([\s\S]*?)\n    \}/)[0];
  const scope = {URL, document: {createElement() {return {children: [], appendChild(x) {this.children.push(x);}, addEventListener() {}};}}, App: {currentLang: 'en'}};
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
