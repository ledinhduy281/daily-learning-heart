const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {normalize, score} = require('../search_ranking.js');
const context = {window:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('../data/briefings.js'),'utf8'), context);
const data = context.window.EBM_BRIEFINGS_DATA.briefings;
assert.equal(normalize('Đái tháo đường'), 'dai thao duong');
assert.equal(score({}, ''), 0);
assert.equal(score({title_en:'safety'}, 'AF'), 0);
for (const [q,accented] of [['suy tim','suy tim'], ['tang huyet ap','tăng huyết áp'], ['rung nhi','rung nhĩ']]) {
  const ranked = [...data].sort((a,b)=>score(b,q)-score(a,q));
  assert.ok(normalize(ranked[0].title_vi).includes(normalize(accented)));
  for (const b of data) assert.equal(score(b,q),score(b,accented));
}
for (const [q,full] of [['AF','atrial fibrillation'],['HFpEF','heart failure with preserved ejection fraction'],['HFrEF','heart failure with reduced ejection fraction'],['ACS','acute coronary syndrome'],['SGLT2i','sglt2 inhibitors'],['ARNI','angiotensin receptor neprilysin inhibitor'],['GDMT','guideline directed medical therapy']]) {
  for (const b of data) assert.equal(score(b,q),score(b,full));
  assert.ok(data.some(b=>score(b,q)>0));
}
for (const key of ['title_en','guideline_evolution','landmark_trials','drug_names','pearls']) assert.ok(score({[key]:'finerenone'},'finerenone') > score({part2_en_markdown:'finerenone'},'finerenone'));
// Compile the actual SPA script without requiring a browser DOM.
const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
const start=html.indexOf('      scoreBriefing(b, query) {');
const end=html.indexOf('      async translateSnippetToVi',start);
const hypertension=data.find(b=>b.pillar_id===1 && b.id.includes('-main'));
const af=data.find(b=>b.pillar_id===6 && b.id.includes('-main'));
const tutor=vm.runInNewContext(`({${html.slice(start,end)}})`,{SearchRanking:require('../search_ranking.js'),App:{selected:hypertension}});
const noContext=vm.runInNewContext(`({${html.slice(start,end)}})`,{SearchRanking:require('../search_ranking.js'),App:{selected:null}});
for (const q of ['rung nhĩ','rung nhi','AF']) {
  assert.equal(score(hypertension,q),0);
  assert.ok(tutor.scoreBriefing(af,q)>tutor.scoreBriefing(hypertension,q));
  assert.equal(tutor.scoreBriefing(hypertension,q),noContext.scoreBriefing(hypertension,q));
}
for (const q of ['','the','today']) assert.equal(tutor.scoreBriefing(hypertension,q)-noContext.scoreBriefing(hypertension,q),60);
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
console.log('JS search tests and SPA syntax: OK');
