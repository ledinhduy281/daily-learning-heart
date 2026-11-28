const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {webcrypto, createHash} = require('node:crypto');
const SearchRanking = require('../search_ranking');
const ClinicalQuiz = require('../clinical_mcq');
const CaseQuiz = require('../case_quiz');
const teachingSections = require('./fixtures/chat_teaching_sections.json');

const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const object = html.slice(html.indexOf('    const EbmChat = {') + '    const EbmChat = '.length, html.indexOf('    window.EbmChat = EbmChat;')).trim().replace(/;$/, '');
function checkMultilineComposer() {
  assert.match(html, /<textarea\b[^>]*\bid="chatInputField"/);
  const start = object.indexOf('        Dom.chatInputField.addEventListener("keydown"');
  const end = object.indexOf('        document.addEventListener("keydown"', start);
  const node = () => ({addEventListener(event, handler) {this[event] = handler;}});
  const field = node(), form = node(), sent = [];
  form.requestSubmit = () => form.submit({preventDefault() {}});
  vm.runInNewContext(`(function () { ${object.slice(start, end)} })`, {
    Dom: {chatInputField: field, chatInputForm: form}
  }).call({sendQuestion: query => sent.push(query)});

  field.value = 'How many patients were included in the PCI meta-analysis?\nA\n1\nB\n2\nC\n3\nD\n4';
  const event = {key: 'Enter', preventDefault() {}};
  field.keydown({...event, shiftKey: true});
  field.keydown({...event, isComposing: true});
  assert.deepEqual(sent, []);
  field.keydown(event);
  assert.deepEqual(sent, [field.value]);
}

async function checkFocusedPastedQuestions() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../data/briefings.js'), 'utf8'), {window});
  vm.runInNewContext(fs.readFileSync(require.resolve('../data/quiz_sets.js'), 'utf8'), {window});
  const bundle = window.EBM_BRIEFINGS_DATA;
  const pci = bundle.briefings.find(b => b.id === 'ebm-2026-11-28-p3-focused');
  for (const lang of ['en', 'vi']) Object.assign(pci.teaching[lang], teachingSections[lang]);
  const sandbox = vm.createContext({window, SearchRanking, ClinicalQuiz, CaseQuiz});
  vm.runInContext(html.slice(html.indexOf('    const SocraticTutor = {'), html.indexOf('    window.SocraticTutor = SocraticTutor;')), sandbox);
  const chat = vm.runInContext(`(${object})`, sandbox);
  const live = [{pmid: '1', title: 'Unrelated live result'}];
  for (const [lang, question, count, notice] of [
    ['en', 'How many patients were included in the intracoronary imaging-guided PCI meta-analysis?',
      /24[ ,]634/, 'Local chat does not grade pasted questions.'],
    ['vi', 'Phân tích gộp PCI hướng dẫn bằng hình ảnh nội mạch gồm bao nhiêu bệnh nhân?',
      /24\.634/, 'Chat cục bộ không chấm câu hỏi dán vào.']
  ]) {
    for (const options of ['A. 12,452\nB. 24,634\nC. 17,235\nD. 13,845',
      'A\n17,235\nB\n13,845\nC\n12,452\nD\n24,634']) {
      const {markdown, sources} = await chat.composeClientDeterministicAnswer(
        `${question}\n${options}`, pci, live, null, lang
      );
      assert.ok(markdown.startsWith(notice));
      assert.match(markdown, /Use the lesson quiz|Dùng bài trắc nghiệm/);
      assert.match(markdown, count);
      assert.doesNotMatch(markdown, /\*\*[A-D]\*\*|12,452|17,235|13,845/);
      assert.equal(sources.length, 1);
      assert.equal(sources[0].pmid, '42747372');
    }
  }
  const mechanism = [
    ['en', 'What is the difference between stent underexpansion and malapposition?', /underexpansion[^.]+stent/i],
    ['vi', 'Stent nở chưa đủ và áp thành không hoàn toàn khác nhau như thế nào?', /nở không đủ và áp thành kém/i]
  ];
  for (const [lang, question, explanation] of mechanism) {
    const {markdown} = await chat.composeClientDeterministicAnswer(
      `${question}\nA. First\nB. Second\nC. Third\nD. Fourth`, pci, [], null, lang
    );
    assert.match(markdown, explanation);
    assert.ok(pci.teaching[lang].mechanism.some(paragraph => markdown.includes(paragraph)), markdown);
  }
  for (const [lang, question, evidence] of [
    ['en', 'How many patients need to be treated to prevent one target lesion failure?', /does not (?:provide an NNT|give the detail needed to calculate NNT)/],
    ['vi', 'Cần điều trị bao nhiêu bệnh nhân để ngăn một thất bại tổn thương đích?', /Không suy ra NNT|không cho đủ chi tiết để tính NNT/],
    ['vi', 'Có bao nhiêu bệnh nhân cần được điều trị để ngăn một biến cố (NNT)?', /Không suy ra NNT|không cho đủ chi tiết để tính NNT/],
    ['en', 'How can absolute benefit be derived from the relative risk of target lesion failure?', /baseline risk, a time horizon and a relevant population/],
    ['vi', 'Làm sao suy ra lợi ích tuyệt đối từ nguy cơ tương đối?', /nguy cơ nền, thời gian theo dõi và tính tương đồng với quần thể nghiên cứu/],
    ['en', 'What was the relative risk of target lesion failure?', /target lesion failure[: (]+RR 0\.72/],
    ['vi', 'Nguy cơ tương đối của thất bại tổn thương đích là bao nhiêu?', /thất bại tổn thương đích[, (]+RR 0,72/],
    ['en', 'What was the mean follow-up in the intracoronary imaging-guided PCI meta-analysis?', /22 months/],
    ['vi', 'Thời gian theo dõi trung bình trong phân tích gộp PCI là bao lâu?', /22 tháng/]
  ]) {
    const {markdown} = await chat.composeClientDeterministicAnswer(
      `${question}\nA. First\nB. Second\nC. Third\nD. Fourth`, pci, [], null, lang
    );
    assert.match(markdown, evidence);
    assert.doesNotMatch(markdown, /\*\*[A-D]\*\*/);
  }
  for (const question of [
    'How many patients did the PCI meta-analysis include?',
    'How many patients did the meta-analysis include in trials evaluating imaging guidance to prevent stent thrombosis?'
  ]) {
    const {markdown} = await chat.composeClientDeterministicAnswer(
      `${question}\nA. First\nB. Second\nC. Third\nD. Fourth`, pci, [], null, 'en'
    );
    assert.match(markdown, /24[ ,]634/);
    assert.doesNotMatch(markdown, /NNT/);
  }
  const ckd = Object.values(bundle.focused_lessons).find(b => b.primary_source?.pmid === '42842238');
  for (const [lang, question, evidence] of [
    ['en', 'What was the relative risk of kidney failure from intensive blood pressure lowering in CKD?', /kidney failure \(RR 0\.97/],
    ['vi', 'Nguy cơ tương đối của suy thận khi hạ huyết áp tích cực ở CKD là bao nhiêu?', /suy thận \(RR 0,97/]
  ]) {
    const {markdown} = await chat.composeClientDeterministicAnswer(
      `${question}\nA. First\nB. Second\nC. Third\nD. Fourth`, ckd, [], null, lang
    );
    assert.match(markdown, evidence);
    assert.doesNotMatch(markdown, /RR 0[.,]85/);
  }
  for (const [lang, question, rr, absolute] of [
    ['en', 'What was the absolute risk reduction and relative risk of cardiovascular events from intensive blood pressure lowering?', 'RR 0.85', '4.3 events per 1000 person-years'],
    ['vi', 'Mức giảm nguy cơ tuyệt đối và nguy cơ tương đối của biến cố tim mạch khi hạ huyết áp tích cực là bao nhiêu?', 'RR 0,85', '4,3 biến cố/1000 người-năm']
  ]) {
    const {markdown} = await chat.composeClientDeterministicAnswer(
      `${question}\nA. First\nB. Second\nC. Third\nD. Fourth`, ckd, [], null, lang
    );
    assert.ok(markdown.includes(rr), markdown);
    assert.ok(markdown.includes(absolute), markdown);
  }
  const bproad = Object.values(bundle.focused_lessons).find(b => b.primary_source?.pmid === '43020520');
  for (const [lang, question] of [
    ['en', 'How many participants were included in the BPROAD cognitive ancillary study?'],
    ['vi', 'Nghiên cứu phụ về nhận thức BPROAD gồm bao nhiêu người tham gia?']
  ]) {
    const {markdown} = await chat.composeClientDeterministicAnswer(
      `${question}\nA. First\nB. Second\nC. Third\nD. Fourth`, bproad, [], null, lang
    );
    assert.match(markdown, /12 434/);
    assert.doesNotMatch(markdown, /6219/);
  }
  const staree = Object.values(bundle.focused_lessons).find(b => b.primary_source?.pmid === '42670961');
  for (const [lang, question, evidence] of [
    ['en', 'What was the reported absolute risk of serious adverse events in STAREE?', /Serious adverse events were 2\.7% in each group/],
    ['vi', 'STAREE báo cáo nguy cơ tuyệt đối của biến cố bất lợi nghiêm trọng là bao nhiêu?', /Biến cố bất lợi nghiêm trọng là 2,7% ở mỗi nhóm/]
  ]) {
    const {markdown} = await chat.composeClientDeterministicAnswer(
      `${question}\nA. First\nB. Second\nC. Third\nD. Fourth`, staree, [], null, lang
    );
    assert.match(markdown, evidence);
  }
  const guideline = {lesson_format: 'single_source', quiz_status: 'awaiting_physician_excerpts'};
  const {markdown} = await chat.composeClientDeterministicAnswer(
    'Which is correct?\nA. First\nB. Second\nC. Third\nD. Fourth', guideline, [], null, 'en'
  );
  assert.match(markdown, /no quiz until a physician enters its recommendation lines/);
  const archive = bundle.briefings.find(b => b.id === 'ebm-2026-11-23-p8-main');
  assert.equal(archive.lesson_format, 'single_guideline');
  for (const [lang, notice] of [
    ['en', 'No source-supported questions are available for this lesson.'],
    ['vi', 'Bài này chưa có câu hỏi đối chiếu được với nguồn gốc.']
  ]) {
    const reply = await chat.composeClientDeterministicAnswer(
      'Which is true of myosin inhibition?\nA. Alpha\nB. Beta\nC. Gamma\nD. Delta', archive, [], null, lang
    );
    assert.ok(reply.markdown.includes(notice));
    assert.doesNotMatch(reply.markdown, /Use the lesson quiz|Dùng bài trắc nghiệm/);
  }
}

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
    chatInputField: {...node(), focus() {}}, chatMessagesList: messages, chatHistoryList: node()
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
  let historyId;
  if (button.startsWith('history-')) {
    historyId = chat.currentSessionId;
    chat.appendMessage('user', 'heart from history');
    chat.createNewSession(false);
  }
  const originalId = chat.currentSessionId;
  const firstRequest = nextRequest();
  const firstReply = chat.sendQuestion('heart first');
  const first = await firstRequest;
  assert.equal(first.url, serverAvailable ? '/api/chat' : 'https://sync.test/exec');
  assert.ok(visible.some(message => message.markdownText === 'heart first'));
  assert.equal(Dom.btnSendChat.disabled, true);

  const reopened = button === 'history-open-active';
  const opened = button === 'history-open';
  const deleted = button.startsWith('history-delete');
  const targetId = reopened || button === 'history-delete-active' ? originalId : historyId;
  const response = answer => ({
    ok: true, headers: {get: () => 'application/json'}, json: async () => ({ok: true, answer_markdown: answer})
  });
  if (reopened) chat.toggleHistoryDrawer(true);
  if (opened || reopened || deleted) {
    let stopped = false;
    Dom.chatHistoryList.click({
      target: {closest: selector => selector === '[data-del-sid]'
        ? (deleted ? {dataset: {delSid: targetId}} : null)
        : {dataset: {sid: targetId}}},
      stopPropagation() {stopped = true;}
    });
    assert.equal(stopped, deleted);
  } else {
    Dom[button].click();
  }
  if (reopened) {
    assert.equal(chat.isHistoryOpen, false);
    assert.equal(chat.currentSessionId, originalId);
    assert.equal(first.signal.aborted, false);
    assert.equal(chat.isBusy, true);
    assert.equal(Dom.btnSendChat.disabled, true);
    assert.ok(visible.some(message => message.markdownText === 'heart first'));
    assert.ok(visible.some(message => message.className === 'chat-msg assistant'));
    assert.deepEqual(toasts, []);

    first.resolve(response('Continued answer'));
    await firstReply;
    assert.equal(chat.isBusy, false);
    assert.equal(Dom.btnSendChat.disabled, false);
    assert.equal(visible.at(-1).markdownText, 'Continued answer');
    const original = JSON.parse(saved).find(session => session.id === originalId);
    assert.equal(original.messages.at(-1).markdownText, 'Continued answer');
    assert.equal(requests.length, 1);
    return;
  }
  assert.equal(first.signal.aborted, true);
  if (opened || button === 'history-delete-active') {
    assert.equal(chat.currentSessionId, historyId);
    assert.equal(visible.at(-1).markdownText, 'heart from history');
  } else if (deleted) {
    assert.equal(chat.currentSessionId, originalId);
    assert.equal(visible.at(-1).markdownText, 'heart first');
  } else {
    assert.notEqual(chat.currentSessionId, originalId);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].role, 'assistant');
  }
  assert.equal(Dom.btnSendChat.disabled, false);
  assert.ok(visible.every(message => !message.className));
  const cleared = button === 'btnClearChat';
  if (opened || deleted) {
    assert.match(toasts.at(-1), lang === 'en'
      ? (deleted ? /Reply canceled.*Conversation deleted/ : /Reply canceled.*Conversation opened/)
      : (deleted ? /hủy câu trả lời.*xóa cuộc trò chuyện/ : /hủy câu trả lời.*mở cuộc trò chuyện/));
  } else {
    assert.match(toasts.at(-1), lang === 'en'
      ? (cleared ? /Reply canceled.*cleared/ : /Reply canceled.*new conversation/)
      : (cleared ? /hủy câu trả lời và xóa/ : /hủy câu trả lời và bắt đầu/));
  }

  const followingRequest = nextRequest();
  const secondReply = chat.sendQuestion('heart second');
  const second = await followingRequest;
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
  assert.equal(sessions.some(session => session.id === originalId), !cleared && button !== 'history-delete-active');
  if (deleted) assert.ok(sessions.every(session => session.id !== targetId));
}

async function checkWithoutAbortSignalAny() {
  const nativeAny = AbortSignal.any;
  delete AbortSignal.any;
  try {
    assert.equal(AbortSignal.any, undefined);
    await check('ok');
    await check('abort');
    await checkCancellation('history-open', 'en', true);
    await checkCancellation('history-delete', 'vi', false);

    const reply = new AbortController();
    const calls = [];
    const chat = vm.runInNewContext(`(${object})`, {
      AbortController, AbortSignal, CHAT_SYNONYMS: {}, CLIENT_GUIDELINE_QUERIES: {},
      fetch: async (url, {signal}) => {
        calls.push({path: new URL(url).pathname, signal});
        if (calls.length === 1) return {ok: true, json: async () => ({esearchresult: {idlist: ['123']}})};
        reply.abort();
        return {ok: false};
      }
    });
    await chat.fetchLivePubMedAbstracts('heart failure', {pillar_id: 1}, reply.signal);
    assert.deepEqual(calls.map(call => call.path), ['/entrez/eutils/esearch.fcgi', '/entrez/eutils/efetch.fcgi']);
    assert.ok(calls.every(call => call.signal.aborted));
  } finally {
    AbortSignal.any = nativeAny;
  }
}

(async () => {
  checkMultilineComposer();
  await checkFocusedPastedQuestions();
  for (const mode of ['ok', 'unset', 'http', 'network', 'json', 'empty', 'rejected', 'device_cap', 'invalid_device', 'abort', 'no_crypto', 'hash_failure']) await check(mode);
  console.log('Browser chat proxy checks passed (success, unset, HTTP/network/JSON/empty/rejected/timeout fallback).');
  await checkCancellation('btnNewChat', 'en', true);
  await checkCancellation('btnNewChatFromDrawer', 'vi', false);
  await checkCancellation('btnClearChat', 'en', false);
  await checkCancellation('btnClearChat', 'vi', true);
  console.log('Chat cancellation: New and Clear abort the active reply, reject stale results, and keep the next reply active (VI/EN).');
  await checkCancellation('history-open', 'en', true);
  await checkCancellation('history-open', 'vi', false);
  await checkCancellation('history-delete', 'en', false);
  await checkCancellation('history-delete-active', 'vi', true);
  console.log('Chat history cancellation: opening saved conversations and deleting active or inactive entries cancels replies and shows the correct VI/EN notice.');
  await checkCancellation('history-open-active', 'en', true);
  await checkCancellation('history-open-active', 'vi', false);
  console.log('Selecting active chat history closes the drawer without interrupting the pending reply (VI/EN).');
  await checkWithoutAbortSignalAny();
  console.log('Without AbortSignal.any: PubMed requests run, and cancellation and proxy timeouts still work.');
})().catch(error => { console.error(error); process.exitCode = 1; });
