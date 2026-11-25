const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto, createHash} = require('node:crypto');

const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const object = html.slice(html.indexOf('    const EbmChat = {') + '    const EbmChat = '.length, html.indexOf('    window.EbmChat = EbmChat;')).trim().replace(/;$/, '');
async function check(mode) {
  const calls = [], messages = [], timers = [];
  let removed = false, cleared = false, refreshed = 0;
  const primary = {pillar_id: 5, guideline_evolution: {current_guideline: {name: 'Test guideline'}, steps: Array(5).fill({title_en: 'Step', desc_en: 'x'.repeat(200)})}, landmark_trials: Array(4).fill({name: 'Trial', changes_en: 'Evidence'}), pearls: Array(5).fill({text_en: 'Pearl'}), part2_en_markdown: 'x'.repeat(10000)};
  const priorHistory = Array(6).fill({role: 'user', content: 'x'.repeat(600)});
  const sandbox = {
    window: {EBM_SYNC_ENDPOINT: mode === 'unset' ? '' : 'http://mock.local/chat',
      crypto: mode === 'no_crypto' ? undefined : mode === 'hash_failure' ? {subtle: {digest: async () => {throw new Error('hash failed');}}} : webcrypto},
    TextEncoder,
    deviceStore: {profile: {device_id: '12345678-1234-4123-8123-123456789abc'}},
    App: {currentLang: 'en', serverAvailable: false, briefings: [primary], selected: primary},
    Dom: {btnSendChat: {}, chatInputField: {focus() {}}, chatMessagesList: {appendChild() {}, scrollHeight: 10}},
    document: {createElement: () => ({remove() { removed = true; }})},
    _SC_MEDICAL_RE: /heart/, isFileOrigin: () => true,
    AbortSignal,
    AbortController, setTimeout: (fn, ms) => { assert.equal(ms, 20000); timers.push(fn); return 1; },
    clearTimeout: () => { cleared = true; },
    fetch: async (endpoint, options) => {
      calls.push({endpoint, options});
      if (mode === 'network') throw new TypeError('offline');
      if (mode === 'abort') { timers[0](); assert.equal(options.signal.aborted, true); throw new Error('aborted'); }
      return {ok: mode !== 'http', json: async () => {
        if (mode === 'json') throw new SyntaxError('invalid');
        return mode === 'ok' ? {ok: true, answer_markdown: '**AI answer**'} :
          mode === 'empty' ? {ok: true, answer_markdown: ' '} : {ok: false, error: mode === 'device_cap' ? 'device_daily_cap' : mode === 'invalid_device' ? 'invalid_device_id' : 'daily_cap'};
      }};
    }
  };
  const chat = vm.runInNewContext(`(${object})`, sandbox);
  Object.assign(chat, {
    loadSessions: () => { assert.equal(chat.isBusy,false);refreshed++; },
    getRecentHistory: () => priorHistory, appendMessage: (...args) => messages.push(args),
    isMedicalOrCardiologyQuery: () => true, scoreBriefing: () => 1,
    fetchLivePubMedAbstracts: async () => [{pmid: '123', title: 'Test', snippet: 'Study'}],
    fetchOpenFdaDrugNote: async () => null,
    composeClientDeterministicAnswer: async () => ({markdown: 'Local answer', sources: [{pmid: '123'}]})
  });
  await chat.sendQuestion('heart failure');
  const answer = messages.at(-1);
  assert.equal(answer[1], mode === 'ok' ? '**AI answer**' : 'Local answer');
  assert.equal(answer[2][0].pmid, '123');
  assert.equal(answer[3].includes('AI (Groq)'), mode === 'ok');
  assert.equal(chat.isBusy, false); assert.equal(sandbox.Dom.btnSendChat.disabled, false); assert.ok(removed);
  assert.equal(refreshed,1);
  if (['unset', 'no_crypto', 'hash_failure'].includes(mode)) assert.equal(calls.length, 0);
  else {
    assert.equal(calls.length, 1); assert.ok(cleared);
    const {options} = calls[0], request = JSON.parse(options.body);
    assert.equal(options.headers['Content-Type'], 'text/plain'); assert.equal(options.redirect, 'follow');
    assert.equal(request.action, 'chat'); assert.equal(request.history.length, 4);
    assert.equal(request.device_id, createHash('sha256').update('dlh-chat-v1:' + sandbox.deviceStore.profile.device_id.toLowerCase()).digest('hex'));
    assert.ok(!options.body.includes(sandbox.deviceStore.profile.device_id));
    assert.ok(request.history.every(m => m.content.length === 500));
    assert.ok(request.context.length <= 6000); assert.match(request.context, /GUIDELINE:.*Test guideline/);
    assert.match(request.context, /PUBMED:.*123/);
  }
}

async function checkCancellation(button, lang, serverAvailable) {
  const node = () => ({addEventListener(event, handler) {this[event] = handler;}});
  const visible = [];
  const messages = {
    set innerHTML(_) {visible.length = 0;},
    appendChild(child) {visible.push(child);}
  };
  const Dom = {
    btnCloseChat: node(), btnExpandChat: node(), btnNewChat: node(), btnNewChatFromDrawer: node(),
    btnClearChat: node(), btnSendChat: {}, chatQuickPrompts: node(), chatInputForm: node(),
    chatInputField: {focus() {}}, chatMessagesList: messages
  };
  const requests = [], toasts = [];
  let saved;
  let notifyRequest;
  const nextRequest = () => new Promise(resolve => {notifyRequest = resolve;});
  const briefing = {id: 'cardiology', pillar_id: 1};
  const chat = vm.runInNewContext(`(${object})`, {
    Dom, App: {currentLang: lang, selected: briefing, briefings: [briefing], serverAvailable},
    window: {EBM_SYNC_ENDPOINT: 'https://sync.test/exec', crypto: webcrypto},
    deviceStore: {profile: {device_id: '12345678-1234-4123-8123-123456789abc'}},
    document: {addEventListener() {}, createElement: () => ({
      remove() {const index = visible.indexOf(this); if (index >= 0) visible.splice(index, 1);}
    })},
    _SC_MEDICAL_RE: /heart/, isFileOrigin: () => false, getAuthHeaders: headers => headers,
    CHAT_SESSIONS_KEY: 'chat', safeStorageGet: () => saved, safeStorageSet: (_key, value) => {saved = value;},
    showToast: message => toasts.push(message),
    t: () => 'Current conversation cleared.', getPillarDisplayName: () => 'Pillar',
    TextEncoder, AbortController, AbortSignal, setTimeout, clearTimeout,
    fetch: (url, {signal}) => new Promise(resolve => {
      const request = {url, signal, resolve};
      requests.push(request);
      notifyRequest(request);
    })
  });
  Object.assign(chat, {
    renderHistoryDrawer() {},
    renderMessageDom(message) {visible.push(message);},
    isMedicalOrCardiologyQuery: () => true, scoreBriefing: () => 1,
    fetchLivePubMedAbstracts: async () => [], fetchOpenFdaDrugNote: async () => null,
    composeClientDeterministicAnswer: async () => ({markdown: 'Local answer', sources: []})
  });
  chat.bindEvents();
  chat.createNewSession(false);
  const originalId = chat.currentSessionId;
  const firstRequest = nextRequest();
  const firstReply = chat.sendQuestion('heart first');
  const first = await firstRequest;
  assert.equal(first.url, serverAvailable ? '/api/chat' : 'https://sync.test/exec');
  assert.ok(visible.some(message => message.markdownText === 'heart first'));
  assert.equal(Dom.btnSendChat.disabled, true);

  Dom[button].click();
  assert.equal(first.signal.aborted, true);
  assert.notEqual(chat.currentSessionId, originalId);
  assert.equal(Dom.btnSendChat.disabled, false);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].role, 'assistant');
  const cleared = button === 'btnClearChat';
  assert.match(toasts.at(-1), lang === 'en'
    ? (cleared ? /Reply canceled.*cleared/ : /Reply canceled.*new conversation/)
    : (cleared ? /hủy câu trả lời và xóa/ : /hủy câu trả lời và bắt đầu/));

  const followingRequest = nextRequest();
  const secondReply = chat.sendQuestion('heart second');
  const second = await followingRequest;
  const response = answer => ({
    ok: true, headers: {get: () => 'application/json'}, json: async () => ({ok: true, answer_markdown: answer})
  });
  // Simulate a transport that delivers the old response despite being aborted.
  first.resolve(response('Stale answer'));
  await firstReply;
  assert.equal(second.signal.aborted, false);
  assert.equal(chat.isBusy, true);
  assert.equal(Dom.btnSendChat.disabled, true);
  assert.equal(requests.length, 2);

  second.resolve(response('Fresh answer'));
  await secondReply;
  assert.equal(chat.isBusy, false);
  assert.equal(Dom.btnSendChat.disabled, false);
  assert.equal(visible.at(-1).markdownText, 'Fresh answer');
  const sessions = JSON.parse(saved);
  assert.ok(sessions.every(session => session.messages.every(message => message.markdownText !== 'Stale answer')));
  assert.equal(sessions.some(session => session.id === originalId), !cleared);
}

(async () => {
  for (const mode of ['ok', 'unset', 'http', 'network', 'json', 'empty', 'rejected', 'device_cap', 'invalid_device', 'abort', 'no_crypto', 'hash_failure']) await check(mode);
  console.log('Browser chat proxy checks passed (success, unset, HTTP/network/JSON/empty/rejected/timeout fallback).');
  await checkCancellation('btnNewChat', 'en', true);
  await checkCancellation('btnNewChatFromDrawer', 'vi', false);
  await checkCancellation('btnClearChat', 'en', false);
  await checkCancellation('btnClearChat', 'vi', true);
  console.log('Chat cancellation: New and Clear abort the active reply, reject stale results, and keep the next reply active (VI/EN).');
})().catch(error => { console.error(error); process.exitCode = 1; });
