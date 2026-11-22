/* Source-bound mirror of clinical_distractors.py. */
const ClinicalDistractors = (() => {
  const endpointVi={
    '6-Month Office SBP Change vs. Sham Procedure':'Thay đổi huyết áp tâm thu tại phòng khám sau 6 tháng so với thủ thuật giả',
    'Home SBP Reduction: Spironolactone vs. Placebo':'Mức giảm huyết áp tâm thu tại nhà: spironolactone so với giả dược',
    '2-Month Daytime Ambulatory SBP vs. Sham':'Huyết áp tâm thu lưu động ban ngày sau 2 tháng so với thủ thuật giả',
    'BARC Type 2, 3, or 5 Bleeding (Months 3–15)':'Chảy máu BARC loại 2, 3 hoặc 5 (tháng 3–15)',
    'CV Death or First HF Hospitalization':'Tử vong tim mạch hoặc nhập viện suy tim lần đầu',
    'Worsening HF or Cardiovascular Death':'Suy tim nặng lên hoặc tử vong tim mạch',
    'Total Worsening HF Events & Cardiovascular Death':'Tổng số biến cố suy tim nặng lên và tử vong tim mạch',
    'CV Death, Stroke, or Hospitalization for Worsening HF or ACS':'Tử vong tim mạch, đột quỵ hoặc nhập viện vì suy tim nặng lên hay hội chứng mạch vành cấp',
    '12-Month Freedom from Procedural Failure, AT/AF Recurrence, AAD, or Repeat Ablation':'Không thất bại thủ thuật, tái phát nhịp nhanh nhĩ/rung nhĩ, dùng thuốc chống loạn nhịp hoặc triệt đốt lại trong 12 tháng'
  };
  const isTrial=t=>!/guideline|consensus|\bClass\s+[IV]/i.test(['name','value','p'].map(k=>t[k]||'').join(' ')) && /(?:HR|RR|OR|Win Ratio)\s+\d|\d\s*(?:%|mmHg|mL|points|pts)/i.test(t.value||'');
  function numericTargets(text,sharedValue=null,includeDuplicates=false) {
    const number='([+-]?[0-9]+(?:[.,][0-9]+)?)';
    const patterns=[
      [new RegExp('\\b(HR|RR|OR|Win Ratio)\\s*(?:=|:)?\\s*'+number,'g'),2,null],
      [new RegExp('\\b(LVEF|EF|BMI|eGFR|PVR|PAWP|mPAP|SBP|DBP|LDL-C|HbA1c|age|aged|tuổi|STS(?:-PROM)?|EuroSCORE\\s*II)\\s*[<>≤≥]=?\\s*'+number,'gi'),2,null],
      [new RegExp('[<>≤≥]=?\\s*'+number+'\\s*(?:years?|tuổi)\\b','gi'),1,'age'],
      [new RegExp(number+'\\s*(mmHg|WU|mL/min|mmol/L|mg/dL)\\b','gi'),1,null],
      [new RegExp(number+'\\s*%','g'),1,'percent'],
      [/\bClass\s+(IIa|IIb|III|II|I)\b/gi,1,'class']
    ];
    const result=[],spans=new Set();
    for(const [pattern,group,field] of patterns)for(const m of text.matchAll(pattern)) {
      const start=m.index+m[0].lastIndexOf(m[group]),end=start+m[group].length,span=`${start}:${end}`;
      if(spans.has(span))continue;
      let label=field||m[group===2?1:2].toLowerCase().replace(/ /g,'');
      label=({ef:'lvef',aged:'age','tuổi':'age'})[label]||label;
      if(label==='percent'&&sharedValue!==null) {const offset=text.lastIndexOf(sharedValue);if(offset<0||!(offset<=start&&start<offset+sharedValue.length))continue;}
      const original=m[group],value=label==='class'?original.toLowerCase():Number(original.replace(',','.')).toFixed(12).replace(/0+$/,'').replace(/\.$/,'');
      result.push({id:`${label}:${value}`,start,end,value:original,numeric:label!=='class'});spans.add(span);
    }
    return includeDuplicates?result:result.filter((t,i)=>result.findIndex(other=>other.id===t.id)===i);
  }
  function cards(primary,lang,numericAlternatives,paired=true) {
    const en=lang==='en',suffix=en?'en':'vi',trials=(primary.landmark_trials||[]).filter(isTrial),steps=primary.guideline_evolution?.steps||[],result=[];
    const trialId=t=>String(t.id||t.doi||t.pmid||(primary.landmark_trials||[]).indexOf(t));
    const clean=s=>{const t=String(s||'').split(/\s+/).join(' ').trim();return t.includes('...')||t.includes('…')?'':t;};
    const normalized=s=>clean(s).toLowerCase().replace(/đ/g,'d').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
    function safety(text) {
      const patterns=en?[[/\bDo not initiate\b/i,'Initiate'],[/\bNever discontinue\b/i,'Discontinue'],[/\bNever withdraw\b/i,'Withdraw'],[/(^|;\s*)avoid\b/i,'$1Use']]:[[/Không được dừng/i,'Có thể dừng'],[/Tuyệt đối không ngừng/i,'Có thể ngừng'],[/Tuyệt đối không khởi trị/i,'Có thể khởi trị'],[/Không kê đơn/i,'Có thể kê đơn'],[/Không khởi trị/i,'Có thể khởi trị'],[/tránh phối hợp/i,'có thể phối hợp'],[/tránh dùng/i,'có thể dùng']];
      for (const clause of text.split(';')) for (const [pattern,replacement] of patterns) if (pattern.test(clause.trim())) return clause.trim().replace(pattern,replacement);
      return '';
    }
    const traps=[];
    for (const t of trials) {
      const caution=clean(t['caution_'+suffix]),changed=safety(caution),source=t.name||'';
      if (changed) traps.push(['safety',`${source}: ${changed.split(';')[0].trim()}`,en?`This reverses the safety instruction for ${source}: ${caution}`:`Lựa chọn này đảo ngược lưu ý an toàn của ${source}: ${caution}`,'safety:trial:'+trialId(t)]);
    }
    for (const [pearlIdx,p] of (primary.pearls||[]).entries()) {
      const fact=clean(p['text_'+suffix]),changed=safety(fact);
      if (changed) traps.push(['safety',`${en?'Clinical practice':'Thực hành lâm sàng'}: ${changed.split(';')[0].trim()}`,en?`The clinical pearl instead states: ${fact}`:`Điểm thực hành nêu điều ngược lại: ${fact}`,`safety:pearl:${pearlIdx}`]);
    }
    for (const [drugIdx,drug] of (Array.isArray(primary.drugs)?primary.drugs:[]).entries()) {
      if (!drug || typeof drug!=='object') continue;
      const fact=clean(drug['contraindication_'+suffix]||drug['caution_'+suffix]),changed=safety(fact),name=drug.name||'';
      if (changed) traps.push(['safety',`${name}: ${changed.split(';')[0].trim()}`,en?`${name}: ${fact}`:`Lưu ý của ${name}: ${fact}`,`safety:drug:${drugIdx}`]);
    }
    function endpointSignature(label) {
      const patterns=[['death',/death|mortality|mace/i],['stroke',/stroke|mace/i],['mi',/infarction|\bmi\b|mace/i],['hf',/\bhf\b|heart failure/i],['bleeding',/bleed|barc/i],['function',/pvo2|functional|oxygen uptake/i],['quality',/kccq|quality/i],['rhythm',/af recurrence|procedural failure|ablation/i],['renal',/renal|kidney/i],['septal',/septal/i],['bp',/blood pressure|mmhg/i]];
      return patterns.filter(([,p])=>p.test(label)).map(([key])=>key).join(',');
    }
    function finish(kind,question,correct,source,distractors,sourceId='guideline',sharedValue='',fallbacks=[]) {
      if (!correct) return;
      correct=clean(correct).replace(/[.!?]+$/,'')+'.';
      const candidates=distractors.filter(([,text])=>clean(text)).map(([typ,text,reason,identity])=>[typ,clean(text).replace(/[.!?]+$/,'')+'.',reason,identity]);
      const groups={};
      for(const target of numericTargets(correct,sharedValue)) {
        const variants=numericAlternatives(correct,false,target);if(!variants)continue;
        const identities=[];
        for (const [idx,[text,parameter]] of variants.slice(1).entries()) {
          const reason=en?`The reported parameter is ${variants[0][1]}, not ${parameter}.`:`Thông số được báo cáo là ${variants[0][1]}, không phải ${parameter}.`;
          const changed=target.numeric?Number(parameter.replace(',','.')).toFixed(12).replace(/0+$/,'').replace(/\.$/,''):parameter.toLowerCase();
          const identity=`numeric:${target.id}:to:${changed}`;
          candidates.push(['numeric',text,reason,identity]);identities.push(identity);
        }
        if(target.numeric)groups[target.id]=identities;
      }
      candidates.push(...fallbacks.filter(([,text])=>clean(text)).map(([typ,text,reason,identity])=>[typ,clean(text).replace(/[.!?]+$/,'')+'.',reason,identity]));
      const chosen=[],seen=new Set([normalized(correct)]);
      for (const distinct of [true,false]) {
        for (const [typ,text,reason,identity] of candidates) {
          if (!text || seen.has(normalized(text)) || (distinct && chosen.some(x=>x[0]===typ))) continue;
          chosen.push([typ,text,reason,identity]);seen.add(normalized(text));
          if (chosen.length===3) break;
        }
        if (chosen.length===3) break;
      }
      if (chosen.length!==3) return;
      result.push({kind,source_id:sourceId,question,texts:[correct,...chosen.map(x=>x[1])],reasons:[correct.startsWith(`${source}: `)?correct:`${source}: ${correct}`,...chosen.map(x=>x[2])],types:['correct',...chosen.map(x=>x[0])],choice_ids:['correct',...chosen.map(x=>x[3])],candidates,numeric_groups:groups});
    }
    for (const t of trials) {
      const name=t.name||'',value=clean(t.value),fact=clean(t['changes_'+suffix]),endpoint=clean(t.endpoint_label);
      if (!name||!value||!fact) continue;
      if (!endpoint) continue;
      const label=en?endpoint:(endpointVi[endpoint]||endpoint);
      const claim=en?`The primary endpoint was “${label}” (${value}).`:`Tiêu chí chính là “${label}” (${value}).`;
      const correct=`${name}: ${claim}`,distractors=[];
      for (const [population,other] of [['HFpEF','HFrEF'],['HFrEF','HFpEF']]) {
        if (new RegExp(`\\b${population}\\b`).test(fact) && !new RegExp(`\\b${other}\\b`).test(fact)) {
          const wrong=en?`${name}: The reported result was ${value} in patients with ${other}.`:`${name}: Kết quả ${value} được ghi nhận ở bệnh nhân ${other}.`;
          distractors.push(['population',wrong,en?`This substitutes ${other} for the ${population} population described for ${name}.`:`Lựa chọn này đổi quần thể ${population} của ${name} thành ${other}.`,'population:'+population]);
        }
      }
      for (const other of trials) {
        const otherEndpoint=clean(other.endpoint_label);
        if (other!==t && endpointSignature(endpoint) && endpointSignature(otherEndpoint) && endpointSignature(otherEndpoint)!==endpointSignature(endpoint)) {
          const otherLabel=en?otherEndpoint:(endpointVi[otherEndpoint]||otherEndpoint);
          const wrong=en?`${name}: The primary endpoint was “${otherLabel}” (${value}).`:`${name}: Tiêu chí chính là “${otherLabel}” (${value}).`;
          const reason=en?`“${otherEndpoint}” belongs to ${other.name}; ${name} reports “${endpoint}”.`:`“${otherLabel}” là tiêu chí của ${other.name}; ${name} báo cáo “${label}”.`;
          distractors.push(['endpoint',wrong,reason,'endpoint:'+trialId(other)]);
        }
        if (other!==t && endpoint && clean(other.value) && other.value!==value) {
          const wrong=`${other.name}: ${claim}`;
          const reason=en?`This attributes the ${name} result to ${other.name}, whose reported estimate is ${other.value}.`:`Lựa chọn này gán kết quả của ${name} cho ${other.name}; ước lượng được báo cáo của ${other.name} là ${other.value}.`;
          distractors.push(['trial_attribution',wrong,reason,'attribution:'+trialId(other)]);
        }
      }
      distractors.push(...traps);
      let question=en?'Which statement about trial evidence and its clinical application is correct?':'Nhận định nào đúng về chứng cứ thử nghiệm và ứng dụng lâm sàng?';
      if (/\bHFpEF\b/.test(fact) && !fact.includes('HFrEF')) question=en?'A patient has HFpEF (LVEF 55%). Which statement about trial evidence and its clinical application is correct?':'Bệnh nhân suy tim EF 55%. Nhận định nào đúng về chứng cứ thử nghiệm và ứng dụng lâm sàng?';
      finish('trial',question,correct,name,distractors,'trial:'+trialId(t),value);
    }
    if (steps.length>=2) {
      const old=steps[0],current=steps[steps.length-1],oldEra=old['era_label_'+suffix]||'',currentEra=current['era_label_'+suffix]||'';
      let oldFact=clean(old['desc_'+suffix]),newFact=clean(current['desc_'+suffix]);
      if (oldFact && newFact && oldFact!==newFact) {
        let question=en?'Which statement is the new practice update in the briefing’s final guideline stage?':'Trong tiến trình khuyến cáo của bản tin, đâu là cập nhật thực hành ở giai đoạn mới nhất?';
        const clause=text=>text.replace(/;/g,',').replace(/≥/g,'≥ ');
        newFact=clause(newFact);oldFact=clause(oldFact);
        const prefix=en?'Recommendation: ':'Khuyến cáo: ';
        newFact=prefix+newFact;oldFact=prefix+oldFact;
        const wrong=[['old_guideline',oldFact,en?`This describes the earlier stage (${oldEra}), not the new update (${currentEra}).`:`Đây là nội dung giai đoạn trước (${oldEra}), không phải cập nhật mới (${currentEra}).`,'old_guideline']];
        const fallbacks=[];
        for(const [i,stage]of steps.slice(1,-1).entries()) {
          const fact=clean(stage['desc_'+suffix]),era=stage['era_label_'+suffix]||'';
          if(fact)fallbacks.push(['old_guideline',prefix+clause(fact),en?`This belongs to the earlier stage (${era}), not the final update (${currentEra}).`:`Đây là nội dung giai đoạn trước (${era}), không phải cập nhật cuối (${currentEra}).`,`old_guideline:stage:${i+1}`]);
        }
        const attribution=en?`The initial stage (${oldEra}), rather than the final stage, introduced this update: ${newFact.slice(prefix.length)}`:`Giai đoạn đầu (${oldEra}), chứ không phải giai đoạn cuối, đưa ra cập nhật này: ${newFact.slice(prefix.length)}`;
        fallbacks.push(['old_guideline',prefix+attribution,en?`The briefing places this update in the final stage (${currentEra}), not the initial stage (${oldEra}).`:`Bản tin đặt cập nhật này ở giai đoạn cuối (${currentEra}), không phải giai đoạn đầu (${oldEra}).`,'old_guideline:attribution']);
        finish('guideline',question,newFact,currentEra,wrong,'guideline','',fallbacks);
      }
    }
    if (!paired) return result;
    const peers=new Map(cards(primary,en?'vi':'en',numericAlternatives,false).map(c=>[c.source_id,c]));
    const matched=[];
    for (const card of result) {
      const peer=peers.get(card.source_id);
      if (!peer) {const ids=Object.values(card.numeric_groups)[0]||[],byId=new Map(card.candidates.map(c=>[c[3],c]));card.hard_choices=ids.map(i=>byId.get(i));delete card.candidates;matched.push(card);continue;}
      const local=new Map(card.candidates.map(c=>[c[3],c])),remote=new Map(peer.candidates.map(c=>[c[3],c]));
      const canonical=en?card:peer,selected=[],seenLocal=new Set([normalized(card.texts[0])]),seenRemote=new Set([normalized(peer.texts[0])]);
      card.hard_choices=[];
      for(const identities of Object.values(canonical.numeric_groups))if(identities.every(i=>local.has(i)&&remote.has(i))){card.hard_choices=identities.map(i=>local.get(i));break;}
      for (const distinct of [true,false]) {
        for (const [typ,,,identity] of canonical.candidates) {
          if (!local.has(identity)||!remote.has(identity)||selected.includes(identity)) continue;
          if (distinct && selected.some(i=>local.get(i)[0]===typ)) continue;
          if (seenLocal.has(normalized(local.get(identity)[1]))||seenRemote.has(normalized(remote.get(identity)[1]))) continue;
          selected.push(identity);seenLocal.add(normalized(local.get(identity)[1]));seenRemote.add(normalized(remote.get(identity)[1]));
          if (selected.length===3) break;
        }
        if (selected.length===3) break;
      }
      if (selected.length===3) {
        Object.assign(card,{texts:[card.texts[0],...selected.map(i=>local.get(i)[1])],reasons:[card.reasons[0],...selected.map(i=>local.get(i)[2])],types:['correct',...selected.map(i=>local.get(i)[0])],choice_ids:['correct',...selected]});
        delete card.candidates;matched.push(card);
      }
    }
    return matched;
  }
  return {cards,isTrial,numericTargets};
})();
if (typeof module!=='undefined') module.exports=ClinicalDistractors;
