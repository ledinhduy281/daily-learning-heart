/* Source-bound mirror of clinical_distractors.py. */
const ClinicalDistractors = (() => {
  const endpointVi={
    'CV Death or First HF Hospitalization':'Tử vong tim mạch hoặc nhập viện suy tim lần đầu',
    'Worsening HF or Cardiovascular Death':'Suy tim nặng lên hoặc tử vong tim mạch',
    'Total Worsening HF Events & Cardiovascular Death':'Tổng số biến cố suy tim nặng lên và tử vong tim mạch',
    'CV Death, Stroke, or Hospitalization for Worsening HF or ACS':'Tử vong tim mạch, đột quỵ hoặc nhập viện vì suy tim nặng lên hay hội chứng mạch vành cấp',
    '12-Month Freedom from Procedural Failure, AT/AF Recurrence, AAD, or Repeat Ablation':'Không thất bại thủ thuật, tái phát nhịp nhanh nhĩ/rung nhĩ, dùng thuốc chống loạn nhịp hoặc triệt đốt lại trong 12 tháng'
  };
  function cards(primary,lang,numericAlternatives) {
    const en=lang==='en',suffix=en?'en':'vi',trials=primary.landmark_trials||[],steps=primary.guideline_evolution?.steps||[],result=[];
    const clean=s=>{const t=String(s||'').split(/\s+/).join(' ').trim();return t.includes('...')||t.includes('…')?'':t;};
    const normalized=s=>clean(s).toLowerCase().replace(/đ/g,'d').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim();
    function safety(text) {
      const patterns=en?[[/\bDo not initiate\b/i,'Initiate'],[/\bNever discontinue\b/i,'Discontinue'],[/\bNever withdraw\b/i,'Withdraw'],[/(^|;\s*)avoid\b/i,'$1Use']]:[[/Không được dừng/i,'Có thể dừng'],[/Tuyệt đối không ngừng/i,'Có thể ngừng'],[/Tuyệt đối không khởi trị/i,'Có thể khởi trị'],[/Không kê đơn/i,'Có thể kê đơn'],[/Không khởi trị/i,'Có thể khởi trị'],[/tránh phối hợp/i,'có thể phối hợp']];
      for (const clause of text.split(';')) for (const [pattern,replacement] of patterns) if (pattern.test(clause.trim())) return clause.trim().replace(pattern,replacement);
      return '';
    }
    const traps=[];
    for (const t of trials) {
      const caution=clean(t['caution_'+suffix]),changed=safety(caution),source=t.name||'';
      if (changed) traps.push(['safety',`${source}: ${changed.split(';')[0].trim()}`,en?`This reverses the safety instruction for ${source}: ${caution}`:`Lựa chọn này đảo ngược lưu ý an toàn của ${source}: ${caution}`]);
    }
    for (const p of primary.pearls||[]) {
      const fact=clean(p['text_'+suffix]),changed=safety(fact);
      if (changed) traps.push(['safety',`${en?'Clinical practice':'Thực hành lâm sàng'}: ${changed.split(';')[0].trim()}`,en?`The clinical pearl instead states: ${fact}`:`Điểm thực hành nêu điều ngược lại: ${fact}`]);
    }
    for (const drug of Array.isArray(primary.drugs)?primary.drugs:[]) {
      if (!drug || typeof drug!=='object') continue;
      const fact=clean(drug['contraindication_'+suffix]||drug['caution_'+suffix]),changed=safety(fact),name=drug.name||'';
      if (changed) traps.push(['safety',`${name}: ${changed.split(';')[0].trim()}`,en?`${name}: ${fact}`:`Lưu ý của ${name}: ${fact}`]);
    }
    function endpointSignature(label) {
      const patterns=[['death',/death|mortality|mace/i],['stroke',/stroke|mace/i],['mi',/infarction|\bmi\b|mace/i],['hf',/\bhf\b|heart failure/i],['bleeding',/bleed|barc/i],['function',/pvo2|functional|oxygen uptake/i],['quality',/kccq|quality/i],['rhythm',/af recurrence|procedural failure|ablation/i],['renal',/renal|kidney/i],['septal',/septal/i],['bp',/blood pressure|mmhg/i]];
      return patterns.filter(([,p])=>p.test(label)).map(([key])=>key).join(',');
    }
    function finish(kind,question,correct,source,distractors) {
      if (!correct) return;
      correct=clean(correct).replace(/[.!?]+$/,'')+'.';
      const chosen=[],seen=new Set([normalized(correct)]);
      for (const distinct of [true,false]) {
        for (const [typ,raw,reason] of distractors) {
          const text=clean(raw)?clean(raw).replace(/[.!?]+$/,'')+'.':'';
          if (!text || seen.has(normalized(text)) || (distinct && chosen.some(x=>x[0]===typ))) continue;
          chosen.push([typ,text,reason]);seen.add(normalized(text));
          if (chosen.length===3) break;
        }
        if (chosen.length===3) break;
      }
      const variants=numericAlternatives(correct);
      if (chosen.length<3 && variants) for (const [text,parameter] of variants.slice(1)) {
        if (!seen.has(normalized(text))) {
          const reason=en?`The reported parameter is ${variants[0][1]}, not ${parameter}.`:`Thông số được báo cáo là ${variants[0][1]}, không phải ${parameter}.`;
          chosen.push(['numeric',text,reason]);seen.add(normalized(text));
        }
        if (chosen.length===3) break;
      }
      if (chosen.length!==3) return;
      result.push({kind,question,texts:[correct,...chosen.map(x=>x[1])],reasons:[correct.startsWith(`${source}: `)?correct:`${source}: ${correct}`,...chosen.map(x=>x[2])],types:['correct',...chosen.map(x=>x[0])]});
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
          distractors.push(['population',wrong,en?`This substitutes ${other} for the ${population} population described for ${name}.`:`Lựa chọn này đổi quần thể ${population} của ${name} thành ${other}.`]);
        }
      }
      for (const other of trials) {
        const otherEndpoint=clean(other.endpoint_label);
        if (other!==t && endpointSignature(endpoint) && endpointSignature(otherEndpoint) && endpointSignature(otherEndpoint)!==endpointSignature(endpoint)) {
          const otherLabel=en?otherEndpoint:(endpointVi[otherEndpoint]||otherEndpoint);
          const wrong=en?`${name}: The primary endpoint was “${otherLabel}” (${value}).`:`${name}: Tiêu chí chính là “${otherLabel}” (${value}).`;
          const reason=en?`“${otherEndpoint}” belongs to ${other.name}; ${name} reports “${endpoint}”.`:`“${otherEndpoint}” là tiêu chí của ${other.name}; ${name} báo cáo “${endpoint}”.`;
          distractors.push(['endpoint',wrong,reason]);
        }
        if (other!==t && endpoint && clean(other.value) && other.value!==value) {
          const wrong=`${other.name}: ${claim}`;
          const reason=en?`This attributes the ${name} result to ${other.name}, whose reported estimate is ${other.value}.`:`Lựa chọn này gán kết quả của ${name} cho ${other.name}; ước lượng được báo cáo của ${other.name} là ${other.value}.`;
          distractors.push(['trial_attribution',wrong,reason]);
        }
      }
      distractors.push(...traps);
      let question=en?'Which statement about trial evidence and its clinical application is correct?':'Nhận định nào đúng về chứng cứ thử nghiệm và ứng dụng lâm sàng?';
      if (/\bHFpEF\b/.test(fact) && !fact.includes('HFrEF')) question=en?'A patient has HFpEF (LVEF 55%). Which statement about trial evidence and its clinical application is correct?':'Bệnh nhân suy tim EF 55%. Nhận định nào đúng về chứng cứ thử nghiệm và ứng dụng lâm sàng?';
      finish('trial',question,correct,name,distractors);
    }
    if (steps.length>=2) {
      const old=steps[0],current=steps[steps.length-1],oldEra=old['era_label_'+suffix]||'',currentEra=current['era_label_'+suffix]||'';
      let oldFact=clean(old['desc_'+suffix]),newFact=clean(current['desc_'+suffix]);
      if (oldFact && newFact && oldFact!==newFact) {
        let question=en?'Which statement is the new practice update in the briefing’s final guideline stage?':'Trong tiến trình khuyến cáo của bản tin, đâu là cập nhật thực hành ở giai đoạn mới nhất?';
        const threshold=/\b(mPAP|PVR|SBP|DBP|LVEF|EF|eGFR|LDL-C|HbA1c|K\+)\s*([<>≤≥]=?)\s*(\d+(?:[.,]\d+)?)\s*(mmHg|WU|%|mmol\/L|mg\/dL)?/gi;
        const pairs=[];
        for (const a of newFact.matchAll(threshold)) for (const b of oldFact.matchAll(threshold)) {
          if (a[1].toLowerCase()===b[1].toLowerCase() && JSON.stringify(a.slice(2))!==JSON.stringify(b.slice(2))) pairs.push([a,b]);
        }
        const clause=text=>{const parts=text.split(/;|(?<=[.!?])\s+/);return (parts.find(p=>numericAlternatives(p))||parts[0]).trim();};
        if (pairs.length) {
          const [a,b]=pairs[0],parameter=m=>`${m[1]} ${m[2]} ${m[3]} ${m[4]||''}`.trim()+'.';
          newFact=parameter(a);oldFact=parameter(b);
          question=en?`According to ${currentEra}, which ${a[1]} threshold is recommended?`:`Theo ${currentEra}, ngưỡng ${a[1]} nào đúng?`;
        } else {newFact=clause(newFact);oldFact=clause(oldFact);}
        const prefix=en?'Recommendation: ':'Khuyến cáo: ';
        newFact=prefix+newFact;oldFact=prefix+oldFact;
        const wrong=[['old_guideline',oldFact,en?`This describes the earlier stage (${oldEra}), not the new update (${currentEra}).`:`Đây là nội dung giai đoạn trước (${oldEra}), không phải cập nhật mới (${currentEra}).`]];
        finish('guideline',question,newFact,currentEra,wrong);
      }
    }
    return result;
  }
  return {cards};
})();
if (typeof module!=='undefined') module.exports=ClinicalDistractors;
