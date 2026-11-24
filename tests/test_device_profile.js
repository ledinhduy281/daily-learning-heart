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
  const storage=new Storage(),profile=create(storage,crypto);
  const original=JSON.stringify([...storage.values]);
  const draft=profile.fork();
  assert.deepEqual(draft.profile.read_ids,[]);
  draft.rename('Draft name');draft.activity(['draft read'],['draft bookmark']);
  assert.equal(JSON.stringify([...storage.values]),original);
  assert.notEqual(profile.profile.display_name,'Draft name');
  assert.deepEqual(profile.profile.read_ids,[]);
  assert.equal(draft.profile.display_name,'Draft name');
  assert.throws(()=>draft.importJSON('{bad JSON'));
  assert.equal(JSON.stringify([...storage.values]),original);
}
{
  const shared = new Storage(), a = create(shared, crypto), b = create(shared, crypto);
  a.activity(['a'], ['a']); a.set('ebm_ui_lang', 'en'); a.rename('New name');
  b.activity(['b'], ['b']); b.set('ebm_font_scale', '1.2');
  assert.deepEqual(JSON.parse(a.exportJSON()).bookmarked_ids, ['a','b']);
  assert.deepEqual(JSON.parse(a.exportJSON()).read_ids, ['a','b']);
  const restored = create(shared, crypto);
  assert.deepEqual(restored.profile.read_ids, ['a','b']);
  assert.deepEqual(restored.profile.bookmarked_ids, ['a','b']);
  assert.equal(restored.profile.display_name, 'New name');
  assert.equal(restored.get('ebm_ui_lang'), 'en');
  assert.equal(restored.get('ebm_font_scale'), '1.2');
  restored.activity(['a','b'], ['b']);
  assert.deepEqual(create(shared, crypto).profile.bookmarked_ids, ['b']);
  assert.deepEqual(JSON.parse(a.exportJSON()).bookmarked_ids, ['b']);
}
calls = 0;
{
  const shared = new Storage(), first = create(shared, crypto), stale = create(shared, crypto);
  first.activity(['shared'], ['shared']);
  assert.deepEqual(JSON.parse(stale.exportJSON()).bookmarked_ids, ['shared']);
  stale.activity(['new'], []);
  assert.deepEqual(create(shared, crypto).profile.bookmarked_ids, ['shared']);
  assert.deepEqual(create(shared, crypto).profile.read_ids, ['shared', 'new']);
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
  ebm_cloud_users_db: JSON.stringify({
    'doctor@example.com': {email: 'doctor@example.com', password: 'private-password', full_name: 'Legacy Doctor', read_ids: ['email-read'], bookmarked_ids: ['email-saved'], streak: 5, quiz: {score: 4, token: 'quiz-secret'}, language: 'en', ui_prefs: {theme: 'dark', email: 'doctor@example.com'}},
    'other@example.com': {email: 'other@example.com', full_name: 'Other Doctor', read_ids: ['other-read'], bookmarked_ids: ['other-saved'], quiz: {score: 99}}
  }),
  ebm_progress_by_user: JSON.stringify({'other@example.com': {read_ids: ['other-read']}}),
  ebm_ui_lang: 'en',
  ebm_socratic_state_v1: JSON.stringify({1: {streak: 3}})
});
const migrated = create(legacy, crypto);
assert.deepEqual(migrated.profile.read_ids, ['email-read']);
assert.deepEqual(migrated.profile.bookmarked_ids, ['email-saved']);
assert.equal(migrated.profile.display_name, 'Bác sĩ');
assert.equal(migrated.get('ebm_ui_lang'), 'en');
assert.equal(JSON.parse(migrated.get('ebm_quiz_progress')).score, 4);
assert.equal(migrated.get('ebm_streak'), '5');
assert.deepEqual(JSON.parse(migrated.get('ebm_ui_prefs')), {theme: 'dark'});
assert.ok(!/private-password|private-session|@|Legacy Doctor|Other Doctor|other-read|other-saved|token|quiz-secret/.test(migrated.exportJSON()));
assert.ok(legacy.getItem('ebm_cloud_users_db').includes('private-password'));
{
  const legacyHistory = {
    soaica_chat_sessions_v1: JSON.stringify([{id: 'old-chat', title: 'Old chat', pillarId: 1, updatedAt: '2026-11-19T00:00:00Z',
      messages: [{id: 'old-message', role: 'user', markdownText: 'My saved question', sources: [], engineLabel: ''}]}]),
    soaica_chat_verbosity_v1: 'detailed',
    soaica_daily_quota_v1: JSON.stringify({date: '2026-11-19', used: 7, limit: 500, exhausted: false, stop_reason: ''}),
    ebm_offline_feedback: JSON.stringify({lesson: {likes: 1, dislikes: 0, reports: 1, user_reaction: 'like', user_reported: true}})
  };
  const oldStorage = new Storage({...legacyHistory, ebm_cloud_current_user: 'doctor',
    ebm_cloud_users_db: JSON.stringify({doctor: {password: 'not-portable', progress: {soaica_chat_verbosity_v1: 'short'}}})});
  const upgraded = create(oldStorage, crypto);
  const exported = upgraded.exportJSON();
  assert.deepEqual(JSON.parse(exported).progress, legacyHistory);
  const reloaded = create(oldStorage, crypto), restored = create(new Storage(), crypto);
  restored.importJSON(exported);
  for (const [key, value] of Object.entries(legacyHistory)) {
    assert.equal(reloaded.get(key), value);
    assert.equal(restored.get(key), value);
    assert.equal(oldStorage.getItem(key), value);
  }
  const malformed = create(new Storage({...legacyHistory, soaica_chat_sessions_v1: '[{"id":"bad","messages":[null]}]',
    soaica_chat_verbosity_v1: 'extra', soaica_daily_quota_v1: '{"used":[]}',
    ebm_offline_feedback: '{"lesson":{"likes":[],"user_reaction":"bad"}}', ebm_ui_lang: 'en'}), crypto);
  assert.deepEqual(JSON.parse(malformed.exportJSON()).progress, {ebm_ui_lang: 'en'});
  for (const mode of ['merge', 'replace']) {
    upgraded.importJSON(create(new Storage(), crypto).exportJSON(), mode);
    assert.equal(create(oldStorage, crypto).get('soaica_chat_verbosity_v1'), mode === 'replace' ? null : 'detailed');
  }
}
const oldCopy = create(new Storage({[KEY]: JSON.stringify({...device.profile, display_name: 'Legacy Doctor', progress: {
  ebm_legacy_users_progress: legacy.getItem('ebm_cloud_users_db'),
  ebm_progress_by_user: legacy.getItem('ebm_progress_by_user'),
  ebm_quiz_progress: JSON.stringify({score: 4, email: 'doctor@example.com', full_name: 'Legacy Doctor', token: 'private-session'})
}})}), crypto);
assert.ok(!/@|Legacy Doctor|Other Doctor/.test(oldCopy.exportJSON()));
oldCopy.rename('Chosen name');
assert.equal(JSON.parse(oldCopy.exportJSON()).display_name, 'Chosen name');
assert.ok(!/@|Legacy Doctor|Other Doctor|private-session|token|legacy_users|progress_by_user/.test(oldCopy.exportJSON()));
oldCopy.rename('Legacy Doctor');
assert.equal(JSON.parse(oldCopy.exportJSON()).display_name, 'Legacy Doctor');
const noActive = create(new Storage({ebm_cloud_users_db: legacy.getItem('ebm_cloud_users_db')}), crypto);
assert.deepEqual(noActive.profile.read_ids, []);
assert.ok(!/@|Legacy Doctor|Other Doctor/.test(noActive.exportJSON()));
const before = migrated.exportJSON();
for (const bad of ['{}', 'null', 'not-json', JSON.stringify({...device.profile, device_id: '../bad'}),
  JSON.stringify({...device.profile, read_ids: [null]}),
  JSON.stringify({...device.profile, progress: {ebm_auth_token: 'bad'}}),
  backup.replace('"version": 1', '"__proto__": {}, "version": 1')]) assert.throws(() => migrated.importJSON(bad));
assert.equal(migrated.exportJSON(), before);
{
  const targetStorage = new Storage(), target = create(targetStorage, crypto);
  const snapshot = targetStorage.getItem(KEY);
  for (const [key, value] of [
    ['ebm_socratic_state_v1', {1: {messages: {bad: true}}}],
    ['ebm_socratic_state_v1', {1: {messages: [null]}}],
    ['ebm_socratic_state_v1', {1: {subskills: {}}}],
    ['ebm_socratic_state_v1', {1: {current_options: null}}],
    ['ebm_socratic_state_v1', {1: {started: 'yes'}}],
    ['ebm_socratic_state_v1', []],
    ['soaica_chat_sessions_v1', [{id: 'broken', messages: {}}]],
    ['soaica_chat_sessions_v1', [{id: 'broken', messages: [{sources: [null]}]}]],
    ['soaica_chat_sessions_v1', [{id: 'broken', messages: [{sources: {}}]}]],
    ['soaica_chat_sessions_v1', [{id: 'broken', messages: [{engineLabel: []}]}]],
    ['soaica_daily_quota_v1', {used: []}],
    ['ebm_offline_user_activity', {read_ids: [null]}],
    ['ebm_ui_prefs', []], ['ebm_offline_feedback', []],
    ['ebm_offline_feedback', {lesson: {like: []}}]
  ]) {
    for (const mode of ['merge', 'replace']) {
      assert.throws(() => target.importJSON(JSON.stringify({...JSON.parse(backup), progress: {[key]: JSON.stringify(value)}}), mode));
      assert.equal(targetStorage.getItem(KEY), snapshot);
      assert.deepEqual(target.profile.read_ids, []);
    }
  }
  assert.throws(() => target.importJSON(JSON.stringify({...JSON.parse(backup), progress: {ebm_socratic_state_v1: 'not json'}})));
  target.importJSON(JSON.stringify({...JSON.parse(backup), progress: {ebm_socratic_state_v1: '{}', soaica_chat_sessions_v1: '[]'}}));
  assert.equal(target.get('ebm_socratic_state_v1'), '{}');
}
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
  const storage=new Storage(),first=create(storage,crypto),second=create(storage,crypto),key='ebm_socratic_state_v1';
  first.set(key,JSON.stringify({1:{answered_count:0},2:{answered_count:0}}));
  const source=html.match(/const SocraticTutor = \{[\s\S]*?\n    \};/)[0];
  const getter=html.match(/function safeStorageGet\([^\n]+/)[0];
  const tab=deviceStore=>vm.runInNewContext(`${getter}\n${source};SocraticTutor`,{
    deviceStore,SOCRATIC_STATE_KEY:key,safeStorageSet:(key,value)=>deviceStore.set(key,value),
    App:{currentLang:'en'},getPillarDisplayName:()=> 'Pillar'
  });
  const a=tab(first),b=tab(second);a.loadStore();b.loadStore();
  a.store[1].answered_count=1;a.saveStore();second.snapshot();
  b.store[2].answered_count=1;b.saveStore();
  assert.equal(JSON.parse(second.get(key))[1].answered_count,1);
  assert.equal(JSON.parse(second.get(key))[2].answered_count,1);
  a.store[1].answered_count=2;a.saveStore();
  assert.equal(JSON.parse(first.get(key))[2].answered_count,1);
  delete a.store[2];a.saveStore();b.saveStore();
  assert.equal(JSON.parse(second.get(key))[1].answered_count,2);
  assert.equal(JSON.parse(second.get(key))[2],undefined);
  first.set(key,'{invalid');b.loadStore();assert.equal(Object.keys(b.store).length,0);
  first.remove(key);b.loadStore();b.saveStore();assert.equal(second.get(key),'{}');

  first.set(key,JSON.stringify({8:{answered_count:1,correct_count:1}}));
  const c=tab(second),oldTab=tab(first);
  a.loadStore();b.loadStore();c.loadStore();oldTab.loadStore();
  const lesson={id:'first-lesson',pillar_id:8};
  const migrated=a.getSession(8,lesson);
  migrated.answered_count=2;
  migrated.correct_count=2;
  a.saveStore();
  assert.equal(b.getSession(8,lesson).correct_count,2);
  assert.equal(c.getSession(8,{id:'second-lesson',pillar_id:8}).correct_count,0);
  const saved=JSON.parse(first.snapshot().progress[key]);
  assert.equal(saved['first-lesson'].correct_count,2);
  assert.equal(saved['second-lesson'],undefined);
  assert.equal(saved[8],undefined);
  oldTab.store[8]={answered_count:2,correct_count:1};
  oldTab.saveStore();
  assert.equal(JSON.parse(first.get(key))[8].answered_count,2);
  c.loadStore();
  const newcomer=c.getSession(8,{id:'second-lesson',pillar_id:8});
  assert.equal(newcomer.answered_count,0);
  assert.equal(newcomer.correct_count,0);
  assert.equal(c.getSession(8,lesson).correct_count,2);
  assert.equal(JSON.parse(first.snapshot().progress[key])[8],undefined);
}
{
  const profile = create(new Storage(), crypto), key = 'ebm_socratic_state_v1';
  const a = {id: 'ebm-2026-11-24-p9-focused', pillar_id: 9, quiz_mode: 'source_excerpt'};
  const b = {...a, id: 'ebm-2026-12-04-p9-focused'};
  profile.set(key, JSON.stringify({9: {lesson_id: a.id, correct_count: 1}}));
  const source = html.match(/const SocraticTutor = \{[\s\S]*?\n    \};/)[0];
  const context = {App: {currentLang: 'en', selected: a}, SOCRATIC_STATE_KEY: key,
    getPillarDisplayName: () => 'Pillar', safeStorageGet: () => profile.get(key),
    safeStorageSet: (_, value) => profile.set(key, value)};
  const tutor = vm.runInNewContext(`${source};SocraticTutor`, context);
  tutor.loadStore();
  assert.equal(tutor.getSession(9).correct_count, 1);
  context.App.selected = b;
  assert.equal(tutor.getSession(9).correct_count, 0);
  tutor.getSession(9).answered_count = 1;
  tutor.saveStore();
  tutor.loadStore();
  context.App.selected = a;
  assert.equal(tutor.getSession(9).correct_count, 1);
  context.App.selected = b;
  assert.equal(tutor.getSession(9).answered_count, 1);
  assert.deepEqual(Object.keys(JSON.parse(profile.get(key))).sort(), [a.id, b.id, 'legacy-migrated:9']);
}
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
    safeStorageGet:key=>profile.get(key),safeStorageSet:(key,value)=>profile.set(key,value),ClinicalQuiz:require('../clinical_mcq.js')
  });
  let generated = 0;
  const fresh = require('../clinical_mcq.js').build(app.selected,0,0,'vi');
  tutor.buildDeterministicMcq = () => {generated++;return fresh;};
  tutor.loadStore();
  let session = tutor.getSession();
  for (const key of ['last_question','current_options','correct_key','explanation','messages']) {
    assert.deepEqual(JSON.parse(JSON.stringify(session[key])),second[key]);
  }
  assert.equal(generated,0);
  for (const explanation of [undefined, '', '   ']) {
    const progress={answered_count:12,correct_count:9,streak:3,diag_step:4,focus_idx:1,attempts_on_current:2,
      subskills:[0,1,2,3].map(i=>({level:i+1,checks:4,answered:3,correct:2}))};
    const legacy={...second,...progress,messages:second.messages.map(m=>({...m})),explanation,current_question:undefined,question_revealed:true};
    tutor.store={1:legacy};
    const before=generated;
    const repaired=tutor.getSession();
    assert.equal(repaired.started,true);
    assert.equal(repaired.phase,'loop');
    assert.equal(repaired.question_revealed,false);
    assert.equal(generated,before+1);
    for(const key of Object.keys(progress).filter(k=>k!=='subskills'))assert.equal(repaired[key],progress[key]);
    assert.deepEqual(Array.from(repaired.subskills,s=>({level:s.level,checks:s.checks,answered:s.answered,correct:s.correct})),progress.subskills);
    assert.deepEqual(JSON.parse(JSON.stringify(repaired.messages.slice(0,-1))),second.messages);
    assert.equal(repaired.messages.at(-1).text,fresh.question);
    assert.equal(repaired.current_question,fresh);
    assert.equal(require('../clinical_mcq.js').turn(app.selected,repaired,'vi','answer','',fresh.correct_key).eval,'correct');
    tutor.loadStore();
    const saved=tutor.getSession();
    assert.equal(saved.answered_count,12);
    assert.equal(saved.current_question.explanation,fresh.explanation);
    assert.equal(saved.messages.length,second.messages.length+1);
    assert.equal(generated,before+1);
  }
  {
    const build=tutor.buildDeterministicMcq;
    const question={...fresh,required_subskills:[0,1]};
    tutor.buildDeterministicMcq=()=>question;
    tutor.store={1:{...pending('resumed'),phase:'diagnostic',diag_step:3,answered_count:3,correct_count:3,
      explanation:'',subskills:[0,1,2,3].map(()=>({level:1,answered:1,correct:1,checks:1}))}};
    const resumed=tutor.getSession();
    assert.equal(resumed.question_index,3);
    assert.equal(resumed.diag_step,3);
    assert.equal(resumed.phase,'diagnostic');
    assert.equal(resumed.answered_count,3);
    tutor.loadStore();
    const saved=tutor.getSession();
    assert.equal(saved.question_index,3);
    const result=require('../clinical_mcq.js').turn(app.selected,saved,'vi','answer','',question.correct_key);
    assert.equal(result.state.question_index,4);
    assert.equal(result.state.answered_count,4);
    assert.equal(result.state.phase,'loop');
    tutor.store={1:{...pending('indexed'),phase:'diagnostic',diag_step:3,question_index:7}};
    assert.equal(tutor.getSession().question_index,7);
    tutor.buildDeterministicMcq=build;
  }
  const recoverable={...second,last_question:fresh.question,current_options:fresh.options,correct_key:fresh.correct_key,explanation:'',current_question:{...fresh,explanation:''}};
  tutor.store={1:recoverable};
  const restored=tutor.getSession();
  assert.equal(restored.started,true);
  assert.equal(restored.current_question.explanation,fresh.explanation);
  assert.equal(restored.explanation,fresh.explanation);
  assert.equal(require('../clinical_mcq.js').turn(app.selected,restored,'vi','answer','',fresh.correct_key).eval,'correct');
  for (const broken of [
    {...second,current_options:[...first.current_options,...second.current_options]},
    {...second,current_options:[]},
    {...second,correct_key:''}
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
  const translated = require('../clinical_mcq.js').translate(app.selected,fresh,'en');
  tutor.renderUI = () => {};
  tutor.onLanguageChanged();
  assert.equal(session.explanation,translated.explanation);
  assert.deepEqual(session.current_question.option_ids,fresh.option_ids);
  assert.equal(session.options_lang,'en');
  assert.equal(session.messages.at(-1).text,session.last_question);
  tutor.store = {};
  const before = generated;
  assert.deepEqual(Array.from(tutor.getSession().current_options),[]);
  assert.equal(generated,before);
  for (const question of ['', '   ', undefined]) {
    tutor.store = {1:{started:true,phase:'diagnostic',last_question:question,current_options:[],correct_key:'',messages:[]}};
    assert.equal(tutor.getSession().messages.length,0);
    assert.equal(tutor.getSession().started,false);
    assert.equal(generated,before);
  }
  tutor.store = {1:{started:true,phase:'mastered',last_question:'',current_options:[],messages:[]}};
  assert.equal(tutor.getSession().started,true);

  const legacy = {...second, correct_count: 4, subskills: [{level: 4}]};
  profile.set("ebm_socratic_state_v1", JSON.stringify({1: legacy}));
  tutor.loadStore();
  app.selected = {id: "first-lesson", pillar_id: 1};
  const adopted = tutor.getSession();
  assert.equal(adopted.lesson_id, app.selected.id);
  assert.equal(adopted.last_question, legacy.last_question);
  assert.equal(adopted.correct_count, 4);
  assert.equal(adopted.subskills[0].level, 4);
  const saved = JSON.parse(profile.get("ebm_socratic_state_v1"));
  assert.equal(saved[1], undefined);
  assert.equal(saved[app.selected.id].lesson_id, app.selected.id);
  tutor.loadStore();
  assert.equal(tutor.getSession().correct_count, adopted.correct_count);
  assert.equal(tutor.getSession().last_question, adopted.last_question);
  assert.equal(tutor.getSession(1, {id: "second-lesson", pillar_id: 1}).started, false);
}
{
  const malicious = '<img src=x onerror="throw 1">';
  const escapeCode = html.match(/function escapeHtml\(str\) \{([\s\S]*?)\n    \}/)[0];
  const urlCode = html.match(/function safeChatSourceUrl\(value\) \{([\s\S]*?)\n    \}/)[0];
  const markdownCode = html.match(/function renderChatMarkdown\(value\) \{[\s\S]*?\n    \}/)[0];
  const scope = {URL, document: {createElement() {return {children: [], appendChild(x) {this.children.push(x);}, addEventListener() {}};}}, Dom: {chatMessagesList: {appendChild() {}}}, App: {currentLang: 'en'}};
  vm.runInNewContext(`${escapeCode}\n${urlCode}\n${markdownCode}`, scope);
  const render = html.match(/      renderMessageDom\(msgObj\) \{[\s\S]*?\n      \},/)[0].slice(0,-1);
  const fn = vm.runInNewContext(`({${render}}).renderMessageDom`, scope);
  const dom = fn({role: 'assistant', markdownText: malicious});
  assert.equal(dom.children[0].innerHTML, `<p>${scope.escapeHtml(malicious)}</p>`);
  const restored = fn({id:malicious,role:'assistant',markdownText:malicious,engineLabel:malicious,sources:[null,{pmid:'123',title:malicious,pubdate:malicious,url:'javascript:alert(1)'}]});
  const link=restored.children[1].children[0];
  assert.equal(link.textContent,`↗ PMID 123 • ${malicious}`);
  assert.equal(link.title,malicious);assert.equal(link.innerHTML,undefined);
  assert.equal(restored.children[1].innerHTML,undefined);
  assert.equal(restored.children[2].children[0].textContent,malicious);
  assert.equal(restored.children[2].innerHTML,undefined);
  assert.equal(fn({role:malicious,markdownText:malicious}).className,'chat-msg assistant');
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
{
  const local = create(new Storage({soaica_chat_sessions_v1: JSON.stringify([{id: 'legacy-chat', messages: [{role: 'user', markdownText: 'Saved'}]}])}), crypto);
  const noop = () => {};
  const chat = {
    currentSessionId: '', messages: [], renderQuotaBadge: noop, renderVerbosityLabels: noop,
    renderHistoryDrawer: noop, updateContext: noop, renderCurrentMessages: noop,
    pushWelcomeMessage() { local.set('soaica_chat_sessions_v1', '[]'); }, createNewSession() { assert.fail('Lost saved chat'); }
  };
  for (const method of ['onLanguageChanged', 'loadSessions']) {
    const [, source] = html.match(new RegExp(`      ${method}\\(\\) \\{([\\s\\S]*?)\\n      \\},`));
    vm.runInNewContext(`(function() {${source}})`, {
      App: {currentLang: 'vi'}, Dom: {}, document: {getElementById: () => null},
      CHAT_SESSIONS_KEY: 'soaica_chat_sessions_v1', safeStorageGet: key => local.get(key)
    }).call(chat);
  }
  assert.equal(chat.currentSessionId, 'legacy-chat');
  assert.equal(chat.messages[0].markdownText, 'Saved');
}
{
  const app = {mode: 'today', user: {}}, lesson = {id: 'today'};
  const reads = [];
  const noop = () => {};
  const init = vm.runInNewContext(`(${html.match(/function renderAllViewsAfterAuth\([^)]*\) \{[\s\S]*?\n    \}/)[0]})`, {
    App: app, applyLocalizationChrome: noop, renderUserWorkspace: noop, renderDailyRotationBanner: noop,
    renderPillarsTiles: noop, renderModeSpecificPanels: noop, getTodaySingleBriefing: () => lesson,
    findArchiveBriefing: id => app.briefings.find(b => b.id === id),
    selectBriefing: (...args) => select(...args)
  });
  const select = vm.runInNewContext(`(${html.match(/function selectBriefing\(briefing, [^\n]+\n[\s\S]*?\n    \}/)[0]})`, {
    App: app, renderBriefingsList: noop, renderPillarsTiles: noop, displayCurrentBriefing: noop,
    recordBriefingRead: id => reads.push(id), fetchFeedbackForBriefing: noop, window: {}
  });
  init();
  assert.equal(app.selected, lesson);
  assert.deepEqual(reads, []);
  const current={id:'older lesson'};
  app.briefings=[lesson,current];app.selected=current;
  init(true);
  assert.equal(app.selected,current);assert.deepEqual(reads,[]);
  select(lesson);
  assert.deepEqual(reads, ['today']);
}
{
  const noop=()=>{};
  const chat={currentSessionId:'active',renderCurrentMessages:noop,renderHistoryDrawer:noop};
  const source=html.match(/      loadSessions\(\) \{([\s\S]*?)\n      \},/)[1];
  const load=vm.runInNewContext(`(function(){${source}})`,{
    CHAT_SESSIONS_KEY:'chats',safeStorageGet:()=>JSON.stringify([{id:'first',messages:[]},{id:'active',messages:[{role:'user',markdownText:'Stay here'}]}])
  });
  load.call(chat);
  assert.equal(chat.currentSessionId,'active');assert.equal(chat.messages[0].markdownText,'Stay here');
  let preserved=false,loaded=0;
  const refresh=vm.runInNewContext(`(${html.match(/function refreshCloudProfile\(\) \{[\s\S]*?\n    \}/)[0]})`,{
    setAuthenticatedUser:noop,SocraticTutor:{loadStore:noop},EbmChat:{loadSessions:()=>loaded++,loadQuota:noop,loadVerbosity:noop},
    loadOfflineFeedbackStore:noop,deviceStore:{get:()=>null},UI_LANG_KEY:'lang',
    renderAllViewsAfterAuth:value=>preserved=value,renderProfileHistory:noop
  });
  refresh();assert.equal(preserved,true);assert.equal(loaded,1);
}
{
  const key='soaica_chat_sessions_v1', local=create(new Storage(),crypto);
  const active={id:'streaming',messages:[{role:'user',markdownText:'Question'}]};
  const inactive={id:'inactive',updatedAt:'2026-11-20T00:00:00Z',messages:[{role:'user',markdownText:'Old inactive conversation'}]};
  local.set(key,JSON.stringify([active,inactive]));
  const chat={isBusy:true,currentSessionId:active.id,sessions:[active,inactive],messages:[...active.messages,{role:'assistant',markdownText:'Finished answer'}],renderHistoryDrawer:()=>{}};
  local.importJSON(JSON.stringify({...JSON.parse(local.exportJSON()),progress:{[key]:JSON.stringify([active,{...inactive,updatedAt:'2026-11-22T00:00:00Z',messages:[{role:'user',markdownText:'Updated inactive conversation'}]},{id:'remote',messages:[{role:'user',markdownText:'Remote conversation'}]}])}}));
  const source=html.match(/      saveSessions\(\) \{([\s\S]*?)\n      \},/)[1];
  const save=vm.runInNewContext(`(function(){${source}})`,{App:{selected:{pillar_id:1}},CHAT_SESSIONS_KEY:key,safeStorageGet:k=>local.get(k),safeStorageSet:(k,v)=>local.set(k,v)});
  save.call(chat);
  const saved=JSON.parse(local.get(key));
  assert.equal(saved.find(s=>s.id==='remote').messages[0].markdownText,'Remote conversation');
  assert.equal(saved.find(s=>s.id==='inactive').messages[0].markdownText,'Updated inactive conversation');
  assert.equal(chat.sessions.find(s=>s.id==='inactive').messages[0].markdownText,'Updated inactive conversation');
  assert.equal(saved.find(s=>s.id==='streaming').messages.at(-1).markdownText,'Finished answer');
  assert.equal(chat.currentSessionId,'streaming');
}
{
  const key='soaica_chat_sessions_v1',local=create(new Storage(),crypto);
  const only={id:'only',messages:[{role:'user',markdownText:'Delete me'}]};
  local.set(key,JSON.stringify([only]));
  const scope={App:{selected:{pillar_id:1}},Dom:{chatMessagesList:{}},CHAT_SESSIONS_KEY:key,
    safeStorageGet:k=>local.get(k),safeStorageSet:(k,v)=>local.set(k,v)};
  const method=name=>{
    const source=html.match(new RegExp(`      ${name}\\(([^\\n]*)\\) \\{([\\s\\S]*?)\\n      \\},`));
    return vm.runInNewContext(`(function(${source[1]}){${source[2]}})`,scope);
  };
  const chat={isBusy:false,sessions:[only],currentSessionId:'only',messages:only.messages,
    saveSessions:method('saveSessions'),createNewSession:method('createNewSession'),
    renderHistoryDrawer:()=>{},toggleHistoryDrawer:()=>{},
    pushWelcomeMessage(){this.messages.push({role:'assistant',markdownText:'Welcome'});this.saveSessions();}};
  method('deleteSession').call(chat,'only');
  assert.notEqual(chat.currentSessionId,'only');
  assert.ok(JSON.parse(local.get(key)).every(s=>s.id!=='only'));
  const replacement=chat.currentSessionId;
  local.set(key,JSON.stringify([only,...JSON.parse(local.get(key))]));
  chat.saveSessions();
  assert.ok(JSON.parse(local.get(key)).every(s=>s.id!=='only'));
  assert.equal(chat.currentSessionId,replacement);
}
async function checkProfilePanel() {
  const markup = html.slice(html.indexOf('id="myAccountModal"'), html.indexOf('id="btnBackToTop"'));
  assert.match(markup, /<input[^>]+id="profileDeviceId"[^>]+readonly/);
  assert.match(markup, /<input type="file" id="progressImportFile"/);
  assert.match(markup, /id="cloudEmailSection" hidden/);
  assert.match(markup, /<input[^>]+type="email"/);

  const profile = create(new Storage(), crypto);
  profile.activity(['old', 'saved', 'new', 'missing'], ['saved']);
  const briefings = ['old', 'saved', 'new'].map((id, index) => ({
    id, title_vi: `VI ${id}`, title_en: `EN ${id}`, pillar_id: index + 1, date: '2026-11-22'
  }));
  const element = () => ({
    children: [], listeners: {}, append(...children) { this.children.push(...children); },
    replaceChildren() { this.children = []; },
    addEventListener(event, listener) { this.listeners[event] = listener; }
  });
  const App = {currentLang: 'vi', briefings};
  const opened = [], toasts = [], copied = [];
  const Dom = {
    profileHistoryList: element(), profileReadCount: {}, profileSavedCount: {},
    profileDeviceId: {value: profile.profile.device_id, focus() {}, select() { this.selected = true; }}
  };
  const navigator = {clipboard: {writeText: async text => copied.push(text)}};
  let fallbackCopies = 0;
  const document = {createElement: element, execCommand(command) {
    assert.equal(command, 'copy');
    assert.equal(Dom.profileDeviceId.selected, true);
    return ++fallbackCopies === 1;
  }};
  const context = vm.createContext({
    App, Dom, deviceStore: profile, navigator, document, cleanHeadline: title => title,
    findArchiveBriefing: id => App.briefings.find(b => b.id === id),
    formatShortDdMm: () => '22/11',
    t: key => (App.currentLang === 'vi'
      ? {filterSaved: 'Đã lưu', filterRead: 'Đã đọc'}
      : {filterSaved: 'Saved', filterRead: 'Read'})[key],
    openProfileBriefing: briefing => opened.push(briefing), showToast: message => toasts.push(message)
  });
  for (const name of ['renderProfileHistory', 'copyProfileDeviceId']) {
    const [source] = html.match(new RegExp(`(?:async )?function ${name}\\(\\) \\{[\\s\\S]*?\\n    \\}`));
    vm.runInContext(source, context);
  }
  context.renderProfileHistory();
  assert.equal(Dom.profileReadCount.textContent, '4');
  assert.equal(Dom.profileSavedCount.textContent, '1');
  const items = () => Dom.profileHistoryList.children;
  assert.deepEqual(items().map(button => button.children[0].textContent), [
    '#2 • 22/11 — VI saved', '#3 • 22/11 — VI new', '#1 • 22/11 — VI old'
  ]);
  assert.deepEqual(items().map(button => button.children[1].textContent), ['Đã lưu', 'Đã đọc', 'Đã đọc']);
  items()[1].listeners.click();
  assert.equal(opened[0], briefings[2]);
  App.currentLang = 'en';
  context.renderProfileHistory();
  assert.equal(items()[0].children[0].textContent, '#2 • 22/11 — EN saved');
  assert.equal(items()[0].children[1].textContent, 'Saved');
  profile.activity([], []);
  context.renderProfileHistory();
  assert.equal(Dom.profileReadCount.textContent, '0');
  assert.equal(Dom.profileSavedCount.textContent, '0');
  assert.match(items()[0].textContent, /No read or saved briefings/);

  await context.copyProfileDeviceId();
  assert.deepEqual(copied, [profile.profile.device_id]);
  assert.equal(toasts.at(-1), 'Device ID copied.');
  navigator.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); };
  await context.copyProfileDeviceId();
  assert.equal(toasts.at(-1), 'Device ID copied.');
  await context.copyProfileDeviceId();
  assert.equal(toasts.at(-1), 'Copy the selected ID manually.');
  console.log('Profile recent items/counts, bilingual history, read-only ID, file restore control, and clipboard fallback: OK');
}

async function checkStreams() {
  {
    for (const change of ['none','reset','replace','question']) {
      const tutorCode=html.match(/const SocraticTutor = \{[\s\S]*?\n    \};/)[0];
      const quiz=require('../clinical_mcq.js'),primary={id:'first',pillar_id:1},other={id:'second',pillar_id:1};
      const question=quiz.build(primary,0,0,'vi');
      let stored,release,entered;
      const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
      const app={currentLang:'vi',selected:primary,serverAvailable:true};
      const tutor=vm.runInNewContext(`${tutorCode};SocraticTutor`,{
        App:app,SOCRATIC_STATE_KEY:'ebm_socratic_state_v1',getPillarDisplayName:()=> 'Pillar',
        ClinicalQuiz:{...quiz,translate:(b,q)=>({...q,question:'Translated second question',explanation:'Translated rationale'})},
        safeStorageGet:()=>stored,safeStorageSet:(key,value)=>{stored=value;},isFileOrigin:()=>false,getAuthHeaders:x=>x,
        document:{getElementById:()=>null,querySelectorAll:()=>[],createElement:()=>({remove(){}})},
        fetch:async()=>{entered();await gate;return {ok:true,headers:{get:()=> 'application/json'},json:async()=>({
          ok:true,reply_markdown:'Graded first question',state:{answered_count:1,correct_count:1}
        })};}
      });
      tutor.renderUI=()=>{};
      const record=()=>({started:true,phase:'diagnostic',question_index:0,answered_count:0,correct_count:0,
        last_question:question.question,current_question:question,current_options:question.options,correct_key:question.correct_key,
        explanation:question.explanation,options_lang:'vi',messages:[{role:'assistant',text:question.question}]});
      tutor.store={first:record()};
      assert.equal(tutor.getSession(1,other).started,false);
      Object.assign(tutor.getSession(1,other),record());
      tutor.getSession(1,primary);tutor.saveStore();
      const original=tutor.store.first,sessionId=original.session_id;
      const pending=tutor.callSocraticApi('answer',question.correct_key,question.correct_key);await started;
      app.selected=other;tutor.curPillarId=1;app.currentLang='en';tutor.onLanguageChanged();
      assert.equal(tutor.store.first,original);tutor.loadStore();assert.equal(tutor.store.first,original);
      assert.equal(tutor.store.second.last_question,'Translated second question');
      if(change==='reset') {
        app.selected=primary;tutor.curPillarId=1;tutor.callSocraticApi=async()=>{};
        await tutor.startDiagnostic();assert.notEqual(tutor.store.first.session_id,sessionId);
      } else if(change==='replace') {
        tutor.store.first={...original,messages:[],correct_count:7};tutor.saveStore();
      } else if(change==='question') {
        original.question_id=tutor.newQuizId();original.messages=[];tutor.saveStore();
      }
      const before=JSON.stringify(tutor.store.first);
      release();await pending;
      if(change==='none') {
        assert.equal(tutor.store.first,original);assert.equal(JSON.parse(stored).first.correct_count,1);
        assert.ok(JSON.parse(stored).first.messages.some(m=>m.text==='Graded first question'));
      } else assert.equal(JSON.stringify(tutor.store.first),before);
      assert.equal(JSON.parse(stored).second.last_question,'Translated second question');
      assert.ok(!JSON.parse(stored).second.messages.some(m=>m.text==='Graded first question'));
    }
  }
  {
    const store = new Storage(), profile = create(store, crypto);
    const app = {serverAvailable: true, user: {read_ids: [], bookmarked_ids: []}};
    let requests = 0, failure = false, notice = '';
    const body = html.match(/async function syncDeviceActivity\(\) \{([\s\S]*?)\n    \}/)[1];
    const sync = vm.runInNewContext(`(async function() {${body}})`, {
      App: app, deviceStore: profile, getAuthHeaders: value => value,
      tt: key => key, showToast: text => {notice = text;},
      fetch: async () => {requests++; if (failure === 'network') throw Error('offline'); return {ok: !failure};}
    });
    await sync();
    assert.equal(requests, 0);
    profile.activity(['lesson'], []);
    failure = true;
    await sync();
    assert.equal(requests, 1);
    assert.equal(notice, 'toastDeviceSyncError');
    assert.equal(app.serverAvailable, true);
    assert.deepEqual(create(store, crypto).profile.read_ids, ['lesson']);
    failure = 'network'; notice = '';
    await sync();
    assert.equal(notice, '');
    failure = false;
    await sync();
    assert.equal(app.deviceSyncFailed, false);
    assert.equal(profile.get('ebm_device_server_synced'), '1');
    profile.activity([], []);
    await sync();
    assert.equal(requests, 4);
    assert.ok(html.includes('tên hiển thị, lịch sử đọc và dấu trang cũng được gửi tới máy chủ'));
    assert.ok(html.includes('your display name, reading history and bookmarks are also sent to the server'));
  }
  {
    const body = html.match(/async function syncDeviceActivity\(\) \{([\s\S]*?)\n    \}/)[1];
    const local = new Storage(), receiver = create(local, crypto), replacingTab = create(local, crypto);
    const emptyBackup = create(new Storage(), crypto).exportJSON();
    let serverCopy, fail = false, requests = 0;
    const runSync = deviceStore => vm.runInNewContext(`(async function() {${body}})`, {
      App: {serverAvailable: true, user: {}}, deviceStore, getAuthHeaders: value => value,
      tt: key => key, showToast() {},
      fetch: async (_path, {body}) => {
        requests++;
        if (fail) return {ok: false};
        serverCopy = JSON.parse(body);
        return {ok: true};
      }
    })();
    receiver.activity(['read'], ['saved']);
    await runSync(receiver);
    assert.deepEqual(serverCopy.read_ids, ['read']);
    assert.deepEqual(serverCopy.bookmarked_ids, ['saved']);
    assert.equal(JSON.parse(receiver.exportJSON()).progress.ebm_device_server_synced, undefined);
    replacingTab.importJSON(emptyBackup, 'replace');
    assert.equal(JSON.parse(replacingTab.exportJSON()).progress.ebm_legacy_server_migrated, undefined);
    fail = true;
    await runSync(replacingTab);
    assert.equal(requests, 2);
    assert.deepEqual(serverCopy.bookmarked_ids, ['saved']);
    fail = false;
    await runSync(create(local, crypto));
    assert.deepEqual(serverCopy, {action: 'sync', read_ids: [], bookmarked_ids: [], display_name: 'Bác sĩ'});
    const fresh = create(new Storage(), crypto);
    const foreignBackup = {...JSON.parse(emptyBackup), progress: {ebm_device_server_synced: '1'}};
    for (const mode of ['merge', 'replace']) {
      fresh.importJSON(JSON.stringify(foreignBackup), mode);
      await runSync(fresh);
      assert.equal(requests, 3);
    }
  }
  {
    const shared = new Storage(), first = create(shared, crypto), stale = create(shared, crypto);
    first.activity(['one'], ['one']);
    const app = {serverAvailable: true, user: {read_ids: [], bookmarked_ids: []}};
    let sent;
    const body = html.match(/async function syncDeviceActivity\(\) \{([\s\S]*?)\n    \}/)[1];
    const sync = vm.runInNewContext(`(async function() {${body}})`, {
      App: app, deviceStore: stale, getAuthHeaders: value => value,
      fetch: async (url, options) => {sent = JSON.parse(options.body); return {ok: true};}
    });
    await sync();
    assert.deepEqual(sent.read_ids, ['one']);
    assert.deepEqual(sent.bookmarked_ids, ['one']);
    assert.deepEqual(app.user.bookmarked_ids, ['one']);
    first.activity(['one', 'two'], []);
    await sync();
    assert.deepEqual(sent.read_ids, ['one', 'two']);
    assert.deepEqual(sent.bookmarked_ids, []);
  }
  {
    const tutorCode = html.match(/const SocraticTutor = \{[\s\S]*?\n    \};/)[0];
    let stored;
    const startButton = {addEventListener(event,handler) {this.click=handler;}};
    const tutor = vm.runInNewContext(`${tutorCode}; SocraticTutor`,{
      App:{currentLang:'en',selected:{pillar_id:1}},SOCRATIC_STATE_KEY:'ebm_socratic_state_v1',
      getPillarDisplayName:()=> 'Pillar',safeStorageGet:()=>stored,safeStorageSet:(key,value)=>{stored=value;},
      document:{getElementById:id=>id==='btnStartSocratic'?startButton:null,querySelectorAll:()=>[],createElement:()=>({remove() {}})}
    });
    const question = 'Diagnostic question 1?';
    const options = ['A','B','C','D'].map(key=>({key,text:`Choice ${key}`}));
    tutor.buildDeterministicMcq = () => {throw Error('Unexpected recovery at diagnostic start');};
    tutor.renderUI = () => {tutor.getSession();};
    let responses = 0;
    tutor.runClientSocratic = async (briefing,session,action) => {
      assert.equal(action,'start_diagnostic');
      assert.equal(session.messages.length,0);
      assert.equal(session.last_question,'');
      assert.equal(session.explanation,'');
      assert.equal(session.current_options.length,0);
      responses++;
      return {reply:question,state:{last_question:question,current_options:options,correct_key:'B',explanation:'Diagnostic explanation'}};
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await tutor.startDiagnostic();
      const session = tutor.getSession();
      assert.equal(session.messages.length,1);
      assert.equal(session.messages[0].text,question);
      assert.equal(session.last_question,question);
      assert.deepEqual(session.current_options,options);
      assert.equal(session.correct_key,'B');
    }
    assert.equal(responses,2);
    stored = JSON.stringify({1:{...tutor.getSession(),started:true,last_question:'',current_options:[],correct_key:'',explanation:'',messages:[]}});
    tutor.store = {};
    tutor.loadStore();
    const interrupted = tutor.getSession();
    assert.equal(interrupted.started,false);
    assert.equal(interrupted.messages.length,0);
    let restarted;
    const startDiagnostic = tutor.startDiagnostic.bind(tutor);
    tutor.startDiagnostic = () => {restarted=startDiagnostic();return restarted;};
    tutor.bindEvents();
    startButton.click();
    assert.ok(restarted);
    await restarted;
    assert.equal(responses,3);
    assert.equal(tutor.getSession().messages.length,1);
    assert.equal(tutor.getSession().messages[0].text,question);
    assert.equal(tutor.getSession().started,true);
  }
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
checkProfilePanel().then(checkStreams).catch(error => {console.error(error); process.exitCode = 1;});
