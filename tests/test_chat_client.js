const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const object = html.slice(html.indexOf('    const EbmChat = {') + '    const EbmChat = '.length, html.indexOf('    window.EbmChat = EbmChat;')).trim().replace(/;$/, '');
async function check(mode) {
  const calls = [], messages = [], timers = [];
  let removed = false, cleared = false;
  const primary = {pillar_id: 5, guideline_evolution: {current_guideline: {name: 'Test guideline'}, steps: Array(5).fill({title_en: 'Step', desc_en: 'x'.repeat(200)})}, landmark_trials: Array(4).fill({name: 'Trial', changes_en: 'Evidence'}), pearls: Array(5).fill({text_en: 'Pearl'}), part2_en_markdown: 'x'.repeat(10000)};
  const priorHistory = Array(6).fill({role: 'user', content: 'x'.repeat(600)});
  const sandbox = {
    window: {EBM_SYNC_ENDPOINT: mode === 'unset' ? '' : 'http://mock.local/chat'},
    App: {currentLang: 'en', serverAvailable: false, briefings: [primary], selected: primary},
    Dom: {btnSendChat: {}, chatInputField: {focus() {}}, chatMessagesList: {appendChild() {}, scrollHeight: 10}},
    document: {createElement: () => ({remove() { removed = true; }})},
    _SC_MEDICAL_RE: /heart/, isFileOrigin: () => true,
    AbortController, setTimeout: (fn, ms) => { assert.equal(ms, 20000); timers.push(fn); return 1; },
    clearTimeout: () => { cleared = true; },
    fetch: async (endpoint, options) => {
      calls.push({endpoint, options});
      if (mode === 'network') throw new TypeError('offline');
      if (mode === 'abort') { timers[0](); assert.equal(options.signal.aborted, true); throw new Error('aborted'); }
      return {ok: mode !== 'http', json: async () => {
        if (mode === 'json') throw new SyntaxError('invalid');
        return mode === 'ok' ? {ok: true, answer_markdown: '**AI answer**'} :
          mode === 'empty' ? {ok: true, answer_markdown: ' '} : {ok: false, error: 'daily_cap'};
      }};
    }
  };
  const chat = vm.runInNewContext(`(${object})`, sandbox);
  Object.assign(chat, {
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
  if (mode === 'unset') assert.equal(calls.length, 0);
  else {
    assert.equal(calls.length, 1); assert.ok(cleared);
    const {options} = calls[0], request = JSON.parse(options.body);
    assert.equal(options.headers['Content-Type'], 'text/plain'); assert.equal(options.redirect, 'follow');
    assert.equal(request.action, 'chat'); assert.equal(request.history.length, 4);
    assert.ok(request.history.every(m => m.content.length === 500));
    assert.ok(request.context.length <= 6000); assert.match(request.context, /GUIDELINE:.*Test guideline/);
    assert.match(request.context, /PUBMED:.*123/);
  }
}
(async () => {
  for (const mode of ['ok', 'unset', 'http', 'network', 'json', 'empty', 'rejected', 'abort']) await check(mode);
  console.log('Browser chat proxy checks passed (success, unset, HTTP/network/JSON/empty/rejected/timeout fallback).');
})().catch(error => { console.error(error); process.exitCode = 1; });
