/* Checks Groq-written quiz sets against the lesson's verbatim excerpts. Shared by the browser and generate_quiz_sets.js. */
const CaseQuiz = (() => {
  const KEYS = ['A', 'B', 'C', 'D'];
  const LIMITS = {items: 8, quote: [20, 700], stem: [20, 900], caseStem: 60, option: [1, 300], explanation: [20, 900]};
  const AI_NOTE = {
    vi: 'Câu hỏi do AI (Groq) soạn từ trích đoạn nguồn, chưa được bác sĩ duyệt.',
    en: 'Written by AI (Groq) from the source excerpt; not physician-reviewed.'
  };
  const squash = s => String(s).replace(/\s+/g, ' ').trim();
  const numbers = s => (String(s).replace(/\b(\d{1,3})(?:[ \u00a0\u202f]\d{3})+(?!\d)/g, m => m.replace(/\s/g, ''))
    .match(/\d+(?:[.,]\d+)*/g) || []).map(n => n.replace(/,/g, '.')).map(n => /^[1-9]\d{0,2}(?:\.\d{3})+$/.test(n) ? n.replace(/\./g, '') : n);
  const DOSE = /\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|μg|g|ml|mmol|iu|ui|units?|đơn vị)(?![\p{L}\p{N}])(?!\s*\/\s*(?:d?l|min)(?![\p{L}]))/giu;
  const text = (v, [min, max]) => typeof v === 'string' && squash(v).length >= min && v.length <= max;

  function grounding(lesson) {
    const source = lesson && lesson.primary_source || {};
    const pmid = typeof source.pmid === 'string' ? source.pmid : '';
    const excerpts = (lesson && lesson.quiz_source_texts && lesson.quiz_source_texts[pmid] || [])
      .filter(t => typeof t === 'string' && t.trim());
    return {pmid, kind: source.kind || '', title: source.title || source.name || '', excerpts};
  }

  function rejectReason(item, ground) {
    if (!item || typeof item !== 'object' || !['theory', 'case'].includes(item.type)) return 'shape';
    if (item.pmid !== ground.pmid || !/^[1-9][0-9]{0,8}$/.test(ground.pmid)) return 'pmid';
    if (!text(item.quote, LIMITS.quote)) return 'quote';
    const quote = squash(item.quote);
    if (!ground.excerpts.some(e => squash(e).includes(quote))) return 'quote';
    const stemMin = item.type === 'case' ? [LIMITS.caseStem, LIMITS.stem[1]] : LIMITS.stem;
    if (!['vi', 'en'].every(l => text(item['stem_' + l], stemMin) && text(item['explanation_' + l], LIMITS.explanation))) return 'text';
    if (!Array.isArray(item.options) || item.options.length !== 4 || !KEYS.includes(item.answer)) return 'options';
    if (!item.options.every(o => o && text(o.vi, LIMITS.option) && text(o.en, LIMITS.option))) return 'options';
    for (const l of ['vi', 'en']) if (new Set(item.options.map(o => squash(o[l]).toLowerCase())).size !== 4) return 'options';
    const correct = item.options[KEYS.indexOf(item.answer)];
    const allowed = new Set(numbers([...ground.excerpts, item.stem_vi, item.stem_en].join(' ')));
    const claims = [correct.vi, correct.en, item.explanation_vi, item.explanation_en];
    if (!claims.every(c => numbers(c).every(n => allowed.has(n)))) return 'numbers';
    const everything = [item.stem_vi, item.stem_en, item.explanation_vi, item.explanation_en,
      ...item.options.flatMap(o => [o.vi, o.en])].join('\n');
    const quotedDoses = new Set((quote.match(DOSE) || []).map(d => squash(d).toLowerCase().replace(/\s/g, '')));
    return (everything.match(DOSE) || []).every(d => quotedDoses.has(squash(d).toLowerCase().replace(/\s/g, ''))) ? '' : 'dose';
  }

  const validItem = (item, ground) => !rejectReason(item, ground);

  function clean(item) {
    const pick = (o, l) => squash(o[l]);
    return {type: item.type, pmid: item.pmid, quote: squash(item.quote), answer: item.answer,
      stem_vi: squash(item.stem_vi), stem_en: squash(item.stem_en),
      explanation_vi: squash(item.explanation_vi), explanation_en: squash(item.explanation_en),
      options: item.options.map(o => ({vi: pick(o, 'vi'), en: pick(o, 'en')})), ai_generated: true};
  }

  function validateSet(lesson, items) {
    const ground = grounding(lesson);
    const valid = (Array.isArray(items) ? items : []).slice(0, LIMITS.items).filter(i => validItem(i, ground)).map(clean);
    const types = new Set(valid.map(i => i.type));
    return types.has('theory') && types.has('case') ? valid : [];
  }

  const subskill = (item, sourceKind) => item.type === 'case' ? 3 : sourceKind === 'guideline' ? 0 : 1;

  function question(item, lang, slotIdx, variantIdx, sourceId, difficulty, sourceKind, required) {
    const l = lang === 'en' ? 'en' : 'vi', en = l === 'en';
    const offset = (variantIdx + Math.floor(variantIdx / 4)) % 4, correctIdx = KEYS.indexOf(item.answer);
    const order = KEYS.map((_, j) => (j - offset + correctIdx + 4) % 4);
    const correct = KEYS[order.indexOf(correctIdx)];
    const label = item.type === 'case' ? (en ? 'Clinical case' : 'Tình huống lâm sàng') : (en ? 'Theory' : 'Lý thuyết');
    return {
      question: `${label} (PMID ${item.pmid}): ${item['stem_' + l]}`,
      options: KEYS.map((key, j) => ({key, text: item.options[order[j]][l]})), correct_key: correct,
      explanation: `${en ? 'Correct answer' : 'Đáp án đúng'}: ${correct}. ${item['explanation_' + l]} “${item.quote}” (PMID ${item.pmid}). ${AI_NOTE[l]}`,
      source_quote: item.quote, source_pmid: item.pmid, ai_generated: true, case_type: item.type,
      option_ids: Object.fromEntries(KEYS.map((key, j) => [key, String(order[j])])),
      generation: {slot_idx: slotIdx, variant_idx: variantIdx, source_id: sourceId, difficulty},
      question_kind: item.type === 'case' ? 'case' : 'theory', difficulty, subskill_idx: subskill(item, sourceKind),
      required_subskills: required
    };
  }

  return {grounding, rejectReason, validItem, validateSet, question, subskill, AI_NOTE, LIMITS};
})();
if (typeof module !== 'undefined') module.exports = CaseQuiz;
