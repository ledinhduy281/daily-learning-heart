const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const quiz=require('../clinical_mcq.js');
const context={window:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('../data/briefings.js'),'utf8'),context);
const briefings=context.window.EBM_BRIEFINGS_DATA.briefings;
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
print(json.dumps([a._build_socratic_mcq(b,s,v,l) for b in a.load_existing_briefings() for l in ('vi','en') for s in range(4) for v in range(3)],ensure_ascii=False))`],{cwd:require('node:path').resolve(__dirname,'..'),encoding:'utf8',maxBuffer:16*1024*1024});
assert.equal(py.status,0,py.stderr);
assert.deepEqual(generated,JSON.parse(py.stdout));
const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(m[1]);
console.log(`JS MCQs, stored-question flows, Python parity (${generated.length} questions), SPA syntax: OK`);
