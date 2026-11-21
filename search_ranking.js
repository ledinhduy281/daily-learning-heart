/* Local bilingual field-weighted BM25, mirrored in search_ranking.py. */
const SearchRanking = (() => {
  const normalize = s => String(s ?? '').toLowerCase().replace(/đ/g, 'd').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const concepts = [
    ['hf', 'heart failure', 'suy tim'],
    ['hfpef', 'heart failure with preserved ejection fraction', 'suy tim phan suat tong mau bao ton'],
    ['hfref', 'heart failure with reduced ejection fraction', 'suy tim phan suat tong mau giam'],
    ['hypertension', 'high blood pressure', 'tang huyet ap', 'tha'],
    ['af', 'atrial fibrillation', 'rung nhi'],
    ['acs', 'acute coronary syndrome', 'hoi chung mach vanh cap'],
    ['sglt2i', 'sglt2', 'sglt2 inhibitors', 'uc che sglt2'],
    ['arni', 'angiotensin receptor neprilysin inhibitor', 'sacubitril valsartan'],
    ['gdmt', 'guideline directed medical therapy', 'dieu tri noi khoa toi uu']
  ];
  const stop = new Set('the and or for with what how why about this that in of to a an la va cho cua ve co moi nhat dieu tri tom tat giai thich toi hoi bai ban tin gi nhu the nao summarize summary explain tell me please'.split(' '));
  const contains = (s, p) => (` ${s.replace(/[^a-z0-9]+/g, ' ')} `).includes(` ${p.replace(/[^a-z0-9]+/g, ' ')} `);
  function terms(query) {
    let q = normalize(query);
    const groups = [];
    for (const aliases of [...concepts].sort((a,b) => Math.max(...b.map(x=>x.length))-Math.max(...a.map(x=>x.length)))) {
      if (aliases.some(a => contains(q,a))) {
        groups.push(aliases);
        for (const a of [...aliases].sort((a,b)=>b.length-a.length)) q = q.replace(new RegExp(`\\b${a}\\b`, 'g'), ' ');
      }
    }
    groups.push(...[...new Set(q.match(/[a-z0-9]+/g) || [])].filter(t => t.length>1 && !stop.has(t)).map(t=>[t]));
    return groups;
  }
  function score(b, query) {
    const groups = terms(query);
    if (!groups.length) return 0;
    const field = keys => normalize(keys.map(k=>JSON.stringify(b[k] ?? '')).join(' '));
    const docs = [
      [field(['title_vi','title_en','topic_focus_vi','topic_focus_en','pillar_vi','pillar_name']),6],
      [field(['guideline_evolution','landmark_trials','drugs','drug_names','pearls']),4],
      [field(['part1_vi_markdown','part2_en_markdown','snippet']),1]
    ].map(([s,w])=>({s,w,tokens:s.match(/[a-z0-9]+/g)||[]}));
    let total=0, covered=0;
    for (const aliases of groups) {
      let best=0;
      for (const a of aliases) {
        const ts=a.match(/[a-z0-9]+/g)||[];
        const tf=docs.reduce((sum,d)=>sum + ((ts.length===1 || contains(d.s,a)) ? d.w*Math.min(...ts.map(t=>d.tokens.filter(x=>x===t).length))/(0.25+0.75*Math.max(1,d.tokens.length)/100) : 0),0);
        best=Math.max(best,Math.log(2)*tf*2.2/(tf+1.2));
      }
      if (best) covered++;
      total+=best*10;
    }
    if (covered===groups.length) total+=20;
    const phrase=normalize(query).trim();
    const phrases=groups.length===1 ? groups[0] : [phrase];
    if (phrase && docs.some(d=>phrases.some(p=>contains(d.s,p)))) total+=12;
    return Math.round(total);
  }
  return { normalize, score, hasTerms: query => terms(query).length > 0 };
})();
if (typeof module !== 'undefined') module.exports = SearchRanking;
