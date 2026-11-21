/* Offline mirror of clinical_mcq.py and socratic_quiz.py. No AI answer keys. */
const ClinicalQuiz = (() => {
  const distractors = typeof module !== 'undefined' ? require('./clinical_distractors.js') : ClinicalDistractors;
  const normalized = s => String(s).toLowerCase().replace(/đ/g,'d').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
  function alternatives(text) {
    let m=text.match(/\bClass\s+(IIa|IIb|III|II|I)\b/i), replacements;
    if (m) replacements=['I','IIa','IIb','III'].filter(x=>x.toLowerCase()!==m[1].toLowerCase()).slice(0,3);
    else {
      m=text.match(/[<>≤≥]=?\s*([0-9]+(?:[.,][0-9]+)?)/) || text.match(/([0-9]+(?:[.,][0-9]+)?)\s*%/) || text.match(/(?:HR|RR|OR|Win Ratio)\s+([0-9]+(?:[.,][0-9]+)?)/i);
      if (!m) return null;
      const number=Number(m[1].replace(',','.')), decimals=(m[1].split(/[.,]/)[1]||'').length;
      const delta=number<2 && decimals ? 0.1 : (decimals && number<10 ? 0.5 : (number>=20 ? 5 : 1));
      const offsets=number>=85?[-1,-2,-3]:(number>delta?[-1,1,2]:[1,2,3]);
      replacements=offsets.map(i=>(number+delta*i).toFixed(decimals).replace('.',m[1].includes(',') ? ',' : '.'));
    }
    const start=m.index+m[0].lastIndexOf(m[1]), end=start+m[1].length;
    return [[text,m[1]],...replacements.map(r=>[text.slice(0,start)+r+text.slice(end),r])];
  }
  function build(primary,slotIdx,variantIdx,lang,difficulty='normal') {
    const en=lang==='en', suffix=en?'en':'vi', pools=[[],[],[],[]];
    for (const s of primary.guideline_evolution?.steps || []) pools[0].push([s['title_'+suffix]||'',s['desc_'+suffix]||'']);
    for (const t of (primary.landmark_trials || []).filter(distractors.isTrial)) {
      if (t.value) pools[1].push([t.name||'',en?`The reported result is ${t.value}.`:`Kết quả được báo cáo là ${t.value}.`]);
      pools[3].push([t.name||'',t['caution_'+suffix]||'']);
    }
    for (const p of primary.pearls || []) pools[2].push([primary['title_'+suffix]||'',p['text_'+suffix]||'']);
    const candidates=[];
    for (const [source,raw,poolIdx] of [slotIdx%4,1,0,2,3].flatMap(i=>pools[i].map(([s,f])=>[s,f,i]))) {
      const fact=String(raw||'').split(/\s+/).join(' ').trim();
      if (!fact || fact.includes('...') || fact.includes('…')) continue;
      if (['khong duoc dung','khong ngung','khong dung cac thuoc','never withdraw','never discontinue','do not stop'].some(p=>normalized(fact).includes(p))) continue;
      const variants=alternatives(fact);
      if (variants && new Set(variants.map(([t])=>normalized(t))).size===4) candidates.push([source,variants,poolIdx]);
    }
    let question,texts,reasons,subskillIdx=null;
    if (!candidates.length) {
      question=en?'A briefing lacks the trial population and safety criteria. What is the best next step before applying its result?':'Bản tin chưa nêu quần thể nghiên cứu và tiêu chí an toàn. Cần làm gì trước khi áp dụng kết quả?';
      texts=en?['Check the full report for eligibility criteria and safety exclusions.','Use the effect estimate from another trial in the same drug class.','Use the abstract conclusion to set the starting dose.','Infer eligibility from the trial title.']:['Đối chiếu báo cáo đầy đủ về tiêu chuẩn chọn bệnh và tiêu chí loại trừ vì an toàn.','Dùng ước lượng hiệu quả từ thử nghiệm khác của cùng nhóm thuốc.','Dựa vào kết luận tóm tắt để chọn liều khởi đầu.','Suy ra tiêu chuẩn chọn bệnh từ tên thử nghiệm.'];
      reasons=en?[texts[0],'An effect estimate does not establish eligibility.','A conclusion alone does not establish dosing.','A title does not define eligibility.']:[texts[0],'Ước lượng hiệu quả không xác định tiêu chuẩn chọn bệnh.','Kết luận tóm tắt không đủ để xác định liều.','Tên thử nghiệm không xác định tiêu chuẩn chọn bệnh.'];
    } else {
      const [source,variants,idx]=candidates[variantIdx%candidates.length];
      subskillIdx=idx;
      question=en?`According to ${source}, which statement is correct?`:`Theo ${source}, nhận định nào đúng?`;
      texts=variants.map(([t])=>t);
      reasons=[en?`The briefing reports ${source}: ${texts[0]}`:`Bản tin nêu tại ${source}: ${texts[0]}`,...variants.slice(1).map(([,r])=>en?`This changes the documented parameter from ${variants[0][1]} to ${r}; the briefing does not support that value for this statement.`:`Lựa chọn này đổi thông số được ghi nhận từ ${variants[0][1]} thành ${r}; bản tin không nêu giá trị này cho nhận định trên.`)];
    }
    let types=['correct','numeric','numeric','numeric'];
    let kind=candidates.length?'fact':'appraisal';
    const cards=distractors.cards(primary,lang,alternatives),preferred=cards.filter(c=>c.kind===(slotIdx%4===0?'guideline':'trial'));
    if (preferred.length || cards.length) {
      const available=preferred.length?preferred:cards,card=available[variantIdx%available.length];
      kind=card.kind;
      subskillIdx=kind==='guideline'?0:1;
      ({question,texts,reasons,types}=card);
    }
    const briefingSeed=Array.from(String(primary.id||'')).reduce((n,c)=>n+c.codePointAt(0),0);
    let seed=briefingSeed+slotIdx*17+variantIdx*31;
    const order=[0,1,2,3];
    for (let i=3;i>0;i--) {seed=(seed*1664525+1013904223)>>>0;const j=(seed>>>16)%(i+1);[order[i],order[j]]=[order[j],order[i]];}
    let blockSeed=briefingSeed*7+Math.floor(variantIdx/4)*131;const targets=[0,1,2,3];
    for (let i=3;i>0;i--) {blockSeed=(blockSeed*1664525+1013904223)>>>0;const j=(blockSeed>>>16)%(i+1);[targets[i],targets[j]]=[targets[j],targets[i]];}
    const target=targets[variantIdx%4],correctPosition=order.indexOf(0);
    [order[target],order[correctPosition]]=[order[correctPosition],order[target]];
    const options=order.map((n,i)=>({key:'ABCD'[i],text:texts[n]})),correct_key='ABCD'[order.indexOf(0)];
    const explanation=(en?'Correct answer: ':'Đáp án đúng: ')+correct_key+'. '+reasons[0]+' '+order.map((n,i)=>n?`${'ABCD'[i]}: ${reasons[n]}`:'').filter(Boolean).join(' ');
    return {question,options,correct_key,explanation,question_kind:kind,subskill_idx:subskillIdx,option_kinds:Object.fromEntries(options.map(o=>[o.key,kind])),distractor_types:Object.fromEntries(order.map((n,i)=>['ABCD'[i],types[n]]).filter(([k])=>k!==correct_key))};
  }
  function turn(primary,input,lang,action,userAnswer='',selectedChoice='') {
    const state=JSON.parse(JSON.stringify(input)),en=lang==='en',current=state.current_question;
    const choice=String(selectedChoice||userAnswer).trim().toUpperCase().replace(/[.:)]+$/,'');
    const valid=current && ['A','B','C','D'].includes(current.correct_key) && current.options?.length===4 && current.explanation;
    if (['answer','just_tell_me'].includes(action) && !valid) return {reply:en?'Please restart the quiz; this saved question has no reliable answer rationale.':'Vui lòng bắt đầu lại bài trắc nghiệm; câu đã lưu chưa có giải thích đáp án đáng tin cậy.',state,eval:'partial'};
    const correct=valid && choice===current.correct_key;
    if (action==='just_tell_me' || (action==='answer' && !correct)) {
      Object.assign(state,{correct_key:current.correct_key,explanation:current.explanation,current_options:current.options,last_question:current.question});
      if (action==='answer' && !state.question_revealed) {state.answered_count=(state.answered_count||0)+1;state.attempts_on_current=(state.attempts_on_current||0)+1;state.streak=0;}
      Object.assign(state,{question_revealed:true,last_updated_idx:-1,last_delta:0,streak:0});
      state.last_eval=action==='answer'?'wrong':'partial';
      return {reply:(en?'Review the same question. ':'Ôn lại chính câu hỏi này. ')+current.explanation,state,eval:state.last_eval};
    }
    let feedback='';
    const evaluation=state.question_revealed?'partial':'correct';
    if (action==='start_diagnostic') {
      Object.assign(state,{phase:'diagnostic',diag_step:0,focus_idx:0,answered_count:0,correct_count:0,attempts_on_current:0,streak:0,question_index:0});
      for (const s of state.subskills||[]) Object.assign(s,{level:0,checks:0,answered:0,correct:0});
    } else if (action==='answer') {
      feedback=current.explanation+'\n\n';
      const idx=current.subskill_idx ?? ({guideline:0,trial:1}[current.question_kind]),skills=state.subskills||[];
      const earned=!state.question_revealed;
      const credit=earned && Number.isInteger(idx) && idx>=0 && idx<4 && skills.length===4;
      if (credit) {skills[idx].level=Math.min(5,Math.max(2,(skills[idx].level||0)+1));for (const k of ['checks','answered','correct']) skills[idx][k]=(skills[idx][k]||0)+1;}
      Object.assign(state,{last_updated_idx:credit?idx:-1,last_delta:credit?1:0,answered_count:(state.answered_count||0)+Number(earned),correct_count:(state.correct_count||0)+Number(earned),streak:earned?(state.streak||0)+1:0,attempts_on_current:0,focus_idx:((state.focus_idx||0)+1)%4,diag_step:Math.min(3,(state.diag_step||0)+1),question_index:(state.question_index||0)+1});
      if (state.question_index>=4 && state.phase!=='final_exam') state.phase='loop';
      if (earned && skills.length===4 && skills.every(s=>s.level>=4)) {
        if (state.phase==='final_exam') {Object.assign(state,{phase:'mastered',current_options:[],correct_key:'',explanation:'',current_question:null});return {reply:feedback+(en?'Review complete.':'Hoàn tất ôn tập.'),state,eval:'correct'};}
        state.phase='final_exam';
      }
    } else if (['harder','easier'].includes(action)) {state.difficulty=action==='harder'?'hard':'easy';state.question_index=(state.question_index||0)+1;}
    const question=build(primary,state.focus_idx||0,state.question_index||0,lang,state.difficulty||'normal');
    Object.assign(state,{current_question:question,correct_key:question.correct_key,explanation:question.explanation,current_options:question.options,last_question:question.question,options_lang:lang,question_revealed:false,last_eval:action==='answer'?evaluation:''});
    return {reply:feedback+question.question,state,eval:action==='answer'?evaluation:'start'};
  }
  return {build,turn,normalized};
})();
if (typeof module !== 'undefined') module.exports=ClinicalQuiz;
