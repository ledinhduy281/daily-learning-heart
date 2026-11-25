const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const quiz=require('../clinical_mcq.js');
const context={window:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('../data/briefings.js'),'utf8'),context);
const briefings=context.window.EBM_BRIEFINGS_DATA.briefings.filter(b=>b.quiz_mode!=='source_excerpt'&&b.lesson_format!=='single_source');
const {numericTargets}=require('../clinical_distractors.js');
{
  const b=briefings.find(b=>b.id==='ebm-2026-08-23-p3-hist1');
  for(const lang of ['vi','en']) {
    const q=quiz.build(b,0,0,lang,'hard'),correct=q.options.find(o=>o.key===q.correct_key).text;
    assert.equal(q.generation.source_id,'guideline');
    assert.deepEqual(new Set(Object.values(q.distractor_types)),new Set(['numeric']));
    assert.ok(correct.includes('≤5%'));
    for(const option of q.options)assert.equal(option.text.replace(/≤\d+%/g,'≤#%'),correct.replace(/≤\d+%/g,'≤#%'));
    assert.deepEqual(new Set(q.options.map(o=>o.text.match(/≤(\d+)%/)[1])),new Set(['4','5','6','7']));
    assert.deepEqual(quiz.translate(b,q,lang==='vi'?'en':'vi').option_ids,q.option_ids);
  }
  for(const value of [null,''])assert.ok(numericTargets('Risk ≤5%.',value).some(t=>t.id==='percent:5'));
  assert.deepEqual(numericTargets('Risk ≤5%, result 10%.','10%').map(t=>t.id),['percent:10']);
  assert.deepEqual(numericTargets('Risk ≤5%.','10%'),[]);
}
for(const b of briefings)for(const lang of ['vi','en']) {
  const q=quiz.build(b,0,0,lang);
  assert.equal(q.question_kind,'guideline',`${b.id} ${lang}`);
  assert.equal(q.generation.source_id,'guideline');
  if(b.id==='ebm-2026-10-01-p10-hist3')for(const difficulty of ['easy','normal','hard']) {
    const bmi=quiz.build(b,0,0,lang,difficulty);
    assert.equal(bmi.generation.source_id,'guideline');
    assert.ok(bmi.options.find(o=>o.key===bmi.correct_key).text.includes('BMI ≥ 30'));
    assert.ok(Object.values(bmi.option_ids).some(id=>id.includes('numeric:bmi:30')));
    if(difficulty==='hard')assert.deepEqual(new Set(bmi.options.map(o=>o.text.match(/BMI ≥ (\d+)/)[1])),new Set(['25','30','35','40']));
  }
}
const parameterChanges=(q,key)=>{
  const correct=q.options.find(o=>o.key===q.correct_key).text,option=q.options.find(o=>o.key===key).text;
  const counts=text=>numericTargets(text,null,true).reduce((r,t)=>(r[t.id]=(r[t.id]||0)+1,r),{});
  const baseline=counts(correct);
  return Object.fromEntries(Object.entries(counts(option)).map(([id,n])=>[id,n-(baseline[id]||0)]).filter(([,n])=>n>0));
};
for (let variant=0;variant<3;variant++) for (const difficulty of ['easy','normal','hard']) {
  const b=briefings.find(b=>b.id==='ebm-2026-07-26-p1-hist3'),vi=quiz.build(b,1,variant,'vi',difficulty);
  const text=vi.options.map(o=>o.text).join(' ')+vi.explanation;
  assert.doesNotMatch(text,/Home SBP|Office SBP|Ambulatory|Reduction|Placebo|Sham/);
  assert.ok(text.toLowerCase().includes('huyết áp tâm thu'));
  const en=quiz.translate(b,vi,'en');assert.deepEqual(en.option_ids,vi.option_ids);
  assert.deepEqual(quiz.translate(b,en,'vi'),vi);
}
{
  const b=JSON.parse(JSON.stringify(briefings.find(b=>b.id==='ebm-2026-07-26-p1-hist3'))),q=quiz.build(b,1,1,'en');
  assert.ok(q.options.find(o=>o.key===q.correct_key).text.includes('PATHWAY-2'));
  b.landmark_trials[1].name='Tên hiển thị mới';
  assert.deepEqual(quiz.translate(b,q,'vi').generation,q.generation);
}
for (const [id,terms,common] of [
  ['ebm-2026-08-30-p3-hist2',['3 nhánh có ý nghĩa chức năng','functionally significant three-vessel disease'],['LVEF >35%']],
  ['ebm-2026-08-25-p6-hist1',['≥2 yếu tố nguy cơ','≥2 risk factors'],['LVEF <50%','CMR-LGE','LMNA','PLN','FLNC','RBM20']],
  ['ebm-2026-09-15-p7-hist1',['lịch sử','historical'],['2021','75']]
]) for (const [i,lang] of ['vi','en'].entries()) {
  const b=briefings.find(b=>b.id===id),q=quiz.build(b,0,0,lang),correct=q.options.find(o=>o.key===q.correct_key).text;
  for (const text of [b[lang==='vi'?'part1_vi_markdown':'part2_en_markdown'],correct]) for (const term of [...common,terms[i]]) assert.ok(text.replace(/≥ /g,'≥').includes(term),term);
}
for (const lang of ['vi','en']) {
  const b=briefings.find(b=>b.id==='ebm-2026-09-15-p7-hist1'),historical=lang==='en'?'historical':'lịch sử';
  const stage=b.guideline_evolution.steps.at(-1);
  for (const field of ['era_label_','title_','desc_']) {
    assert.ok(stage[field+lang].includes('2021'));
    assert.ok(stage[field+lang].toLowerCase().includes(historical));
  }
  for (const difficulty of ['easy','normal','hard']) {
    const q=quiz.build(b,0,0,lang,difficulty);
    for (const o of q.options.filter(o=>o.text.includes('75'))) {
      assert.ok(o.text.includes('2021'));
      assert.ok(o.text.toLowerCase().includes(historical));
    }
    assert.ok(q.explanation.toLowerCase().includes(historical));
  }
}
for (const lang of ['vi','en']) {
  const b=briefings.find(b=>b.id==='ebm-2026-11-20-p5-main');
  const [easy,normal,hard]=['easy','normal','hard'].map(d=>quiz.build(b,1,0,lang,d));
  assert.equal(new Set([easy.question,normal.question,hard.question]).size,3);
  assert.ok(easy.question.includes(lang==='en'?'Hint:':'Gợi ý:'));
  assert.ok(easy.question.split(':').pop().includes(easy.correct_key));
  assert.deepEqual(easy.options,normal.options);
  assert.notDeepEqual(hard.options,normal.options);
  assert.deepEqual(new Set(Object.values(hard.distractor_types)),new Set(['numeric']));
  for (const q of [easy,hard]) assert.equal(q.options.find(o=>o.key===q.correct_key).text,normal.options.find(o=>o.key===normal.correct_key).text);
}
for (const grade of ['1','2','3a','3b','3c','4','5']) for (const lang of ['vi','en']) {
  const b={landmark_trials:[{name:'Synthetic trial',value:`BARC ${grade}; NYHA 3; Killip 2; CCS 4; HR 0.56`,endpoint_label:'Bleeding',changes_en:'Adults with coronary disease.',changes_vi:'Người lớn mắc bệnh mạch vành.'}]};
  const q=quiz.build(b,1,0,lang,'hard');
  const baseline=q.options.find(o=>o.key===q.correct_key).text.replace(/HR [0-9.,]+/g,'HR #');
  for (const o of q.options) assert.equal(o.text.replace(/HR [0-9.,]+/g,'HR #'),baseline);
  assert.equal(new Set(q.options.map(o=>o.text)).size,4);
}
{
  let checked=0;
  for (const b of briefings) for (const lang of ['vi','en']) {
    for (let variant=0;variant<8;variant++) {
      const q=quiz.build(b,1,variant,lang,'hard');
      if (!q.options.find(o=>o.key===q.correct_key).text.startsWith('TWILIGHT:')) continue;
      const baseline=q.options.find(o=>o.key===q.correct_key).text.replace(/HR [0-9.,]+/g,'HR #');
      if (lang==='vi') assert.ok(baseline.includes('Chảy máu BARC loại 2, 3 hoặc 5 (tháng 3–15)'));
      for (const o of q.options) {
        assert.equal(o.text.replace(/HR [0-9.,]+/g,'HR #'),baseline);
        for (const m of o.text.matchAll(/BARC\s+(?:Type\s+)?([0-9abc ,/]+(?:or\s+\d+)?)/g)) {
          for (const grade of m[1].match(/\d+[abc]?/g)) assert.ok(['1','2','3','3a','3b','3c','4','5'].includes(grade));
        }
      }
      assert.deepEqual(quiz.translate(b,q,lang==='vi'?'en':'vi').option_ids,q.option_ids);
      checked++;
    }
  }
  assert.ok(checked>0);
}
for (const b of [...briefings,{}]) for (const lang of ['vi','en']) {
  let {state}=quiz.turn(b,{subskills:Array.from({length:4},()=>({level:0}))},lang,'start_diagnostic');
  for (let i=0;i<24 && state.phase!=='mastered';i++) ({state}=quiz.turn(b,state,lang,'answer','',state.correct_key));
  assert.equal(state.phase,'mastered',`${b.id} ${lang}`);
  assert.ok(state.required_subskills.every(i=>state.subskills[i].level>=4));
}
for (const lang of ['vi','en']) for (const reveal of ['just_tell_me','wrong']) {
  const b=briefings[0],first=quiz.turn(b,{subskills:Array.from({length:4},()=>({level:0}))},lang,'start_diagnostic');
  const shown=quiz.turn(b,first.state,lang,reveal==='wrong'?'answer':reveal,'',first.state.correct_key==='A'?'B':'A');
  assert.equal(shown.state.question_revealed,true);
  assert.equal(quiz.turn(b,shown.state,lang,'answer','',first.state.correct_key==='A'?'B':'A').state.answered_count,shown.state.answered_count);
  const out=quiz.turn(b,shown.state,lang,'answer','',first.state.correct_key);
  assert.equal(out.eval,'partial');assert.equal(out.state.correct_count,0);
  assert.equal(out.state.answered_count,shown.state.answered_count);
  assert.deepEqual(out.state.subskills,first.state.subskills);
  assert.equal(out.state.last_delta,0);assert.equal(out.state.question_revealed,false);
  assert.equal(quiz.turn(b,out.state,lang,'answer','',out.state.correct_key).state.correct_count,1);
}
for (const slot of [2,3]) {
  const b=briefings.find(b=>b.id==='ebm-2026-11-20-p5-main');
  let {state}=quiz.turn(b,{focus_idx:slot,subskills:Array.from({length:4},()=>({level:0}))},'en','harder');
  assert.equal(state.current_question.subskill_idx,1);
  ({state}=quiz.turn(b,state,'en','answer','',state.correct_key));
  assert.deepEqual(state.subskills.map(s=>s.correct||0),[0,1,0,0]);
  assert.equal(state.last_updated_idx,1);
  assert.equal(state.focus_idx,(slot+1)%4);
}
{
  const b=briefings.find(b=>b.id==='ebm-2026-11-14-p9-main');
  const primary={landmark_trials:b.landmark_trials.filter(t=>t.name.includes('Guidelines'))};
  assert.ok(primary.landmark_trials.length);
  for (const lang of ['vi','en']) assert.equal(quiz.build(primary,1,0,lang).question_kind,'appraisal');
}
for (const b of briefings) for (const lang of ['vi','en']) {
  let {state}=quiz.turn(b,{},lang,'start_diagnostic');
  const keys=[];
  for (let i=0;i<4;i++) {keys.push(state.correct_key);({state}=quiz.turn(b,state,lang,'answer','',state.correct_key));}
  assert.equal(new Set(keys).size,4,`${b.id}: ${keys}`);
}
for (const lang of ['vi','en']) {
  const b=briefings.find(b=>b.id==='ebm-2026-08-25-p6-hist1'),q=quiz.build(b,0,0,lang);
  const correct=q.options.find(o=>o.key===q.correct_key).text;
  for (const criterion of ['DCM/HNDCM','<50%','≥ 2','CMR-LGE','LMNA','FLNC','PLN','RBM20']) assert.ok(correct.includes(criterion));
}
for (const lang of ['vi','en']) {
  for (const [id,terms] of [
    ['ebm-2026-09-03-p9-hist2',['mPAP >20','PAWP ≤15','PVR >2','ERA + PDE5i',lang==='en'?'WITHOUT cardiopulmonary comorbidities':'KHÔNG có bệnh đồng mắc tim phổi']],
    ['ebm-2026-08-30-p3-hist2',['LVEF >35%','Class I','LOE A',lang==='en'?'functionally significant three-vessel disease':'3 nhánh có ý nghĩa chức năng']]
  ]) {
    const q=quiz.build(briefings.find(b=>b.id===id),0,0,lang),correct=q.options.find(o=>o.key===q.correct_key).text;
    for (const term of terms) assert.ok(correct.includes(term),term);
    assert.ok(q.explanation.includes(correct));
  }
}
{
  const b=briefings.find(b=>b.landmark_trials.some(t=>t.name==='EXPLORER-HCM'));
  for (let v=0;v<8;v++) {
    const q=quiz.build(b,1,v,'en');
    for (const o of q.options) if (q.distractor_types[o.key]==='safety' && o.text.startsWith('EXPLORER-HCM:')) {
      assert.ok(o.text.includes('Use strong') && !o.text.includes('Mandatory echocardiographic'));
    }
  }
}
const letters=new Set();
function check(q) {
  assert.deepEqual(q.options.map(o=>o.key),['A','B','C','D']);
  assert.equal(new Set(q.options.map(o=>quiz.normalized(o.text))).size,4);
  assert.ok(q.explanation.includes(q.options.find(o=>o.key===q.correct_key).text));
  assert.ok(q.explanation.includes(q.correct_key));
  assert.deepEqual(Object.keys(q.option_kinds),['A','B','C','D']);
  assert.ok(Object.values(q.option_kinds).every(k=>k===q.question_kind));
  if (['trial','guideline'].includes(q.question_kind)) {
    assert.ok(q.options.every(o=>o.text.includes(':') && !o.text.includes(';')));
    assert.ok(q.options.every(o=>o.text.endsWith('.')));
    assert.ok(q.options.every(o=>!o.text.includes('Xóa bỏ hoàn toàn định kiến')));
    if (q.question_kind==='guideline') {
      assert.ok(/khuyến cáo|ngưỡng|guideline|threshold/.test(q.question));
      assert.equal(new Set(q.options.map(o=>o.text.split(':')[0])).size,1);
      assert.ok(q.options.every(o=>/^(Khuyến cáo|Recommendation): /.test(o.text) && !/primary endpoint|Tiêu chí chính/.test(o.text)));
      assert.ok(Object.values(q.distractor_types).every(t=>['old_guideline','numeric'].includes(t)));
    } else {
      assert.ok(/thử nghiệm|trial/.test(q.question));
      assert.ok(q.options.every(o=>!/^(Khuyến cáo|Recommendation): /.test(o.text)));
      assert.ok(!Object.values(q.distractor_types).includes('old_guideline'));
    }
  }
  for (const o of q.options) assert.ok(!o.text.includes('...') && !o.text.includes('…'));
  letters.add(q.correct_key);
}
const generated=[];
for (const b of briefings) for (const lang of ['vi','en']) {
  for (let slot=0;slot<4;slot++) for (let variant=0;variant<3;variant++) {
    const q=quiz.build(b,slot,variant,lang);check(q);generated.push(q);
    const translated=quiz.translate(b,q,lang==='vi'?'en':'vi');
    assert.ok(translated,`${b.id} ${q.generation.source_id}`);
    assert.deepEqual(translated.generation,q.generation);
    assert.deepEqual(translated.option_ids,q.option_ids);
    assert.deepEqual(translated.distractor_types,q.distractor_types);
    assert.deepEqual(quiz.translate(b,translated,lang),q);
    assert.deepEqual(q,quiz.build(b,slot,variant,lang));
  }
  const first=quiz.turn(b,{subskills:Array.from({length:4},()=>({level:0}))},lang,'start_diagnostic');
  check(first.state.current_question);
  const wrong=first.state.correct_key==='A'?'B':'A';
  for (const action of ['answer','just_tell_me']) {
    const out=quiz.turn(b,{...first.state,question_index:97,attempts_on_current:19},lang,action,'',wrong);
    assert.deepEqual(out.state.current_question,first.state.current_question);
    assert.equal(out.state.correct_key,first.state.correct_key);
    assert.ok(out.reply.includes(first.state.explanation));
  }
  const right=quiz.turn(b,first.state,lang,'answer','',first.state.correct_key);
  assert.equal(right.eval,'correct');check(right.state.current_question);
}
assert.equal(letters.size,4);
{
  const primary={landmark_trials:[{name:'EMPEROR-Preserved',value:'HR 0.79',endpoint_label:'CV Death or First HF Hospitalization',changes_en:'Empagliflozin in HFpEF.'}]};
  const fact='Do not initiate finerenone if eGFR < 25 mL/min/1.73 m².';
  primary.drugs=[{name:'Finerenone',contraindication_en:fact}];
  const q=quiz.build(primary,1,0,'en');
  assert.ok(Object.values(q.distractor_types).includes('safety'));
  assert.ok(q.explanation.includes(fact));
  for (const empty of [[],null,['invalid']]) {
    primary.drugs=empty;
    const types=Object.values(quiz.build(primary,1,0,'en').distractor_types);
    assert.ok(!types.includes('safety') && types.includes('numeric'));
  }
}
for (const lang of ['vi','en']) {
  const hf=briefings.find(b=>b.pillar_id===5 && b.id.includes('-main'));
  const q=quiz.build(hf,1,0,lang),types=Object.values(q.distractor_types);
  assert.ok(types.includes('population') && types.includes('safety'));
  assert.equal(new Set(types).size,3);
  assert.ok(!types.includes('numeric'));
  assert.ok(q.question.length<150);
  const pah=briefings.find(b=>b.id==='ebm-2026-09-03-p9-hist2');
  const g=quiz.build(pah,0,0,lang);
  assert.ok(Object.values(g.distractor_types).includes('old_guideline'));
  assert.ok(new Set(Object.values(g.distractor_types)).size>=2);
  assert.ok(g.explanation.includes(pah.guideline_evolution.steps[0]['era_label_'+lang]));
}
for (const lang of ['vi','en']) {check(quiz.build({},0,0,lang));assert.ok(quiz.turn({}, {},lang,'just_tell_me').reply);}
const py=spawnSync('python3',['-c',`import json,fetch_daily_ebm as a
print(json.dumps([a._build_socratic_mcq(b,s,v,l) for b in a.load_existing_briefings() if b.get('quiz_mode') != 'source_excerpt' and b.get('lesson_format') != 'single_source' for l in ('vi','en') for s in range(4) for v in range(3)],ensure_ascii=False))`],{cwd:require('node:path').resolve(__dirname,'..'),encoding:'utf8',maxBuffer:16*1024*1024});
assert.equal(py.status,0,py.stderr);
assert.deepEqual(generated,JSON.parse(py.stdout));
const difficult=Array.from(briefings).concat({}).flatMap(b=>['vi','en'].flatMap(l=>['easy','hard'].map(d=>quiz.build(b,1,0,l,d))));
for (const b of [...briefings,{}])for(const lang of ['vi','en'])for(const difficulty of ['easy','normal','hard'])for(let slot=0;slot<4;slot++)for(let variant=0;variant<4;variant++) {
  const q=quiz.build(b,slot,variant,lang,difficulty),translated=quiz.translate(b,q,lang==='vi'?'en':'vi');
  assert.ok(translated,`${b.id} ${JSON.stringify(q.generation)}`);
  assert.deepEqual(translated.option_ids,q.option_ids);
  for(const [key,id]of Object.entries(q.option_ids))if(id.startsWith('numeric:'))assert.deepEqual(parameterChanges(q,key),parameterChanges(translated,key),`${b.id} ${id}`);
}
for(const [id,slot,variant,field]of [['ebm-2026-09-15-p7-hist1',0,0,'age:75'],['ebm-2026-07-26-p1-hist3',1,1,'mmhg:-8.7']]) {
  const b=briefings.find(b=>b.id===id);
  for(const lang of ['vi','en']) {
    const q=quiz.build(b,slot,variant,lang,'hard');assert.ok(quiz.translate(b,q,lang==='vi'?'en':'vi'));
    assert.ok(Object.entries(q.option_ids).every(([key,value])=>key===q.correct_key||value.includes(field)));
  }
}
const pyDifficult=spawnSync('python3',['-c',`import json,fetch_daily_ebm as a
print(json.dumps([a._build_socratic_mcq(b,1,0,l,d) for b in a.load_existing_briefings()+[{}] if b.get('quiz_mode') != 'source_excerpt' and b.get('lesson_format') != 'single_source' for l in ('vi','en') for d in ('easy','hard')],ensure_ascii=False))`],{cwd:require('node:path').resolve(__dirname,'..'),encoding:'utf8',maxBuffer:16*1024*1024});
assert.equal(pyDifficult.status,0,pyDifficult.stderr);
assert.deepEqual(difficult,JSON.parse(pyDifficult.stdout));
const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
const tutorContext={ClinicalQuiz:quiz,App:{selected:briefings[0],currentLang:'en'},window:{}};
vm.runInNewContext(html.slice(html.indexOf('    const SocraticTutor = {'),html.indexOf('    window.SocraticTutor = SocraticTutor;'))+'\nwindow.tutor=SocraticTutor;',tutorContext);
const tutor=tutorContext.window.tutor;
for (const b of [...briefings,{}]) for (const slot of [0,1]) {
  const original=quiz.build(b,slot,8,'vi'),translated=quiz.translate(b,original,'en');
  assert.ok(translated,b.id);
  assert.deepEqual(translated.generation,original.generation);
  assert.equal(translated.correct_key,original.correct_key);
  assert.deepEqual(quiz.translate(b,translated,'vi'),original);
}
{
  const b=briefings[0],original=quiz.build(b,1,8,'vi');
  const session={started:true,phase:'loop',focus_idx:1,diag_step:3,attempts_on_current:2,question_index:8,answered_count:8,question_revealed:true,
    current_question:original,current_options:original.options,correct_key:original.correct_key,explanation:original.explanation,
    last_question:original.question,options_lang:'vi',messages:[{role:'assistant',text:'Feedback. '+original.question},{role:'assistant',text:original.explanation}]};
  let saved=0,rendered=0;
  tutor.getSession=()=>session;tutor.saveStore=()=>saved++;tutor.renderUI=()=>rendered++;
  tutor.onLanguageChanged();
  assert.deepEqual(session.current_question,quiz.translate(b,original,'en'));
  assert.equal(session.messages.length,2);
  assert.equal(session.messages[0].text,'Feedback. '+session.current_question.question);
  assert.equal(session.messages[1].text,session.current_question.explanation);
  assert.equal(session.question_index,8);assert.equal(session.answered_count,8);assert.equal(session.question_revealed,true);
  assert.equal(saved,1);assert.equal(rendered,1);
  tutorContext.App.currentLang='vi';tutor.onLanguageChanged();
  assert.deepEqual(session.current_question,original);
  assert.equal(session.messages.length,2);
  session.current_question={...original,generation:{...original.generation,source_id:'trial:missing'}};
  session.options_lang='en';const before=JSON.stringify(session);tutor.onLanguageChanged();
  assert.equal(JSON.stringify(session),before);
}
assert.equal(quiz.translate({},null,'en'),null);
{
  const b=briefings.find(b=>b.landmark_trials.some(t=>t.name==='EXPLORER-HCM'));
  for (const lang of ['vi','en']) for (const key of 'ABCD') {
    const original=quiz.build(b,1,0,lang);
    if (key===original.correct_key) continue;
    const out=quiz.turn(b,{current_question:original},lang,'answer','',key);
    const session={...out.state,started:true,phase:'loop',options_lang:lang,messages:[{role:'assistant',text:original.question},{role:'user',text:key},{role:'assistant',text:out.reply}]};
    tutorContext.App.selected=b;tutorContext.App.currentLang=lang==='vi'?'en':'vi';
    tutor.getSession=()=>session;tutor.onLanguageChanged();
    assert.equal(session.messages[1].text,key);
    assert.equal(session.current_question.option_ids[key],original.option_ids[key]);
    assert.equal(session.current_question.distractor_types[key],original.distractor_types[key]);
    assert.ok(session.messages[2].text.includes(session.current_question.explanation));
    assert.equal(session.messages.length,3);
    assert.equal(session.question_revealed,true);
    assert.equal(session.answered_count,1);
  }
  const legacy={...quiz.build(b,1,0,'vi')};delete legacy.option_ids;
  assert.equal(quiz.translate(b,legacy,'en'),null);
}
assert.ok(html.includes('question_revealed: sess.question_revealed === true'));
for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
console.log(`JS MCQs, stored-question flows, Python parity (${generated.length} questions), SPA syntax: OK`);
