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
  const DOSE = /\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|μg|g|ml|mmol|iu|ui|units?|đơn vị)(?![\p{L}\p{N}])(?:\s*\/\s*(?:kg|m2|m²|min|phút|h|hr|giờ|day|ngày|d)(?![\p{L}\p{N}]))*/giu;
  // Lab concentrations and eGFR in a vignette are not doses (mmol/L, mg/dL, mL/min); rates such as mg/min still are.
  const LAB = /\d+(?:[.,]\d+)?\s?(?:(?:mg|g|mmol|µmol|μmol|mcg|µg|μg|ng|pg)\s*\/\s*d?l|ml\s*\/\s*min(?:\s*\/\s*1[.,]73\s*m(?:2|²))?)(?![\p{L}])/giu;
  // The app shuffles options, so explanations must not name them by letter.
  const LETTERS = [/(?:[Oo]ptions?|[Cc]hoices?|[Aa]nswers?|[Đđ]áp án|[Pp]hương án|[Ll]ựa chọn|[Cc]họn)\s*\(?[A-D]\)?(?![\p{L}\p{N}])/u,
    /(?:^|[^\p{L}\p{N}])[A-D](?:\s*(?:,|and|và|or|hoặc)\s*[A-D])*\s+(?:(?:is|are|là)\s+)?(?:correct|incorrect|wrong|right|đúng|sai)(?![\p{L}])/u];
  const UNIT_ALIASES = {'phút': 'min', 'giờ': 'h', hr: 'h', 'ngày': 'day', d: 'day', 'm²': 'm2', 'μg': 'mcg', 'µg': 'mcg', ui: 'iu',
    unit: 'units', 'đơn vị': 'units'};
  const doseKey = d => squash(d).toLowerCase().replace(/,/g, '.').replace(/\s*\/\s*/g, '/').replace(/(\d)\s+/, '$1')
    .replace(/[\p{L}²]+(?: vị)?/gu, u => UNIT_ALIASES[u] || u);
  // "A and C give…" names options; "stages B and C" or "class A or B" names a clinical grade.
  const LETTER_LIST = /(?:^|[^\p{L}\p{N}])((?:[Ss]tages?|[Cc]lass(?:es)?|[Tt]ypes?|[Gg]rades?|[Gg]iai đoạn|[Nn]hóm|[Pp]hân độ|[Ll]oại|[Mm]ức)\s+)?[A-D](?:\s*(?:,|and|và|or|hoặc)\s*[A-D])+(?![\p{L}\p{N}])/gu;
  const namesOptions = e => LETTERS.some(r => r.test(e)) || [...String(e).matchAll(LETTER_LIST)].some(m => !m[1]);
  const doses = s => String(s).replace(LAB, ' ').match(DOSE) || [];
  const text = (v, [min, max]) => typeof v === 'string' && squash(v).length >= min && v.length <= max;

  function grounding(lesson) {
    const source = lesson && lesson.primary_source || {};
    const pmid = typeof source.pmid === 'string' ? source.pmid : '';
    const excerpts = (lesson && lesson.quiz_source_texts && lesson.quiz_source_texts[pmid] || [])
      .filter(t => typeof t === 'string' && t.trim());
    return {pmid, kind: source.kind || '', title: source.title || source.name || '', excerpts};
  }

  // Numbers in the correct option and explanations must come from the source or the stem; "excerpt 2" / "[2]" are references.
  function unsupportedNumbers(item, ground) {
    const allowed = new Set(numbers([ground.title, ...ground.excerpts, item.stem_vi, item.stem_en].join(' ')));
    const correct = item.options[KEYS.indexOf(item.answer)];
    const refs = /\[\s*\d+\s*\]|\b(?:excerpts?|trích đoạn|đoạn trích|trích dẫn|câu trích|phần trích|đoạn)\s*(?:số\s*)?\[?\d+\]?/giu;
    return [correct.vi, correct.en, item.explanation_vi, item.explanation_en]
      .flatMap(c => numbers(String(c).replace(refs, ' '))).filter(n => !allowed.has(n));
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
    if (unsupportedNumbers(item, ground).length) return 'numbers';
    if ([item.explanation_vi, item.explanation_en].some(namesOptions)) return 'letters';
    const everything = [item.stem_vi, item.stem_en, item.explanation_vi, item.explanation_en,
      ...item.options.flatMap(o => [o.vi, o.en])].join('\n');
    const quotedDoses = new Set(doses(quote).map(doseKey));
    return doses(everything).every(d => quotedDoses.has(doseKey(d))) ? '' : 'dose';
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

  const COURSE_VERSION = 2;
  const FORMATS = ['predict', 'explain', 'critique', 'apply', 'connect'];
  const TIERS = ['easy', 'medium', 'hard'];
  const LANGS = ['vi', 'en'];
  const PRACTICE_PER_SKILL = 3;

  function validateCourse(lesson, set) {
    if (lesson?.quiz_mode !== 'source_excerpt' || set?.version !== COURSE_VERSION || typeof set.set_id !== 'string' || !set.set_id.trim() ||
        !Array.isArray(set.skills) || set.skills.length < 4 || set.skills.length > 10 ||
        !Array.isArray(set.items) || !set.skills.every(s => s && LANGS.every(l => text(s[l], [3, 100])))) return null;
    const {skills, items} = set;
    const ground = grounding(lesson);
    const diagnosis = items.filter(i => i?.phase === 'diagnostic');
    if (diagnosis.length < 3 || diagnosis.length > 5 ||
        items.length !== diagnosis.length + skills.length * (PRACTICE_PER_SKILL + 1) + 1) return null;
    if (!LANGS.every(l => new Set(skills.map(s => squash(s[l]).toLowerCase())).size === skills.length)) return null;
    const seen = {vi: new Set(), en: new Set()}, covered = {diagnostic: new Set(), final: new Set()};
    const practice = skills.map(() => []);
    const cleaned = [];
    let tier = -1, phase = 0, integration = 0;
    for (const item of items) {
      const cited = {...ground, title: '', excerpts: [item?.quote]};
      if (!item || typeof item.quote !== 'string' || !ground.excerpts.some(e => e.includes(item.quote)) ||
          rejectReason(item, cited) ||
          !FORMATS.includes(item.format) || !TIERS.includes(item.tier)) return null;
      const p = ['diagnostic', 'practice', 'final'].indexOf(item.phase);
      const t = TIERS.indexOf(item.tier);
      if (p < phase) return null;
      phase = p;
      const idx = item.skill;
      if (idx === null) {
        if (p !== 2 || item.format !== 'connect' || ++integration > 1) return null;
      } else {
        if (!Number.isInteger(idx) || !skills[idx]) return null;
        if (p === 1) practice[idx].push(item.tier);
        else {
          if (covered[item.phase].has(idx)) return null;
          covered[item.phase].add(idx);
        }
      }
      if (p === 0) {
        if (t < tier) return null;
        tier = t;
      }
      for (const l of LANGS) {
        const stem = squash(item['stem_' + l]).toLowerCase();
        const hint = item['hint_' + l];
        const answer = squash(item.options[KEYS.indexOf(item.answer)][l]).toLowerCase();
        if (seen[l].has(stem) || (p === 1 &&
            (!text(hint, [12, 300]) || !hint.trim().endsWith('?') || namesOptions(hint) ||
             squash(hint).toLowerCase().includes(answer) || squash(hint).toLowerCase() === stem ||
             doses(hint).some(d => !doses(item.quote).map(doseKey).includes(doseKey(d)))))) return null;
        seen[l].add(stem);
      }
      const base = clean(item);
      if (rejectReason(base, cited)) return null;
      cleaned.push({...base, quote: item.quote, phase: item.phase, skill: idx, format: item.format, tier: item.tier,
        ...(p === 1 ? {hint_vi: squash(item.hint_vi), hint_en: squash(item.hint_en)} : {})});
    }
    if (diagnosis[0].tier !== 'easy' || tier !== 2 || integration !== 1 || covered.final.size !== skills.length ||
        practice.some(t => t.length !== PRACTICE_PER_SKILL || t.filter(d => d === 'hard').length < 2) ||
        !['theory', 'case'].every(t => items.some(i => i.type === t)) ||
        !FORMATS.every(f => items.some(i => i.format === f))) return null;
    return {version: COURSE_VERSION, set_id: set.set_id, model: set.model,
      skills: skills.map(s => ({vi: squash(s.vi), en: squash(s.en)})), items: cleaned};
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

  function startCourse(course) {
    return {stage: 'diagnostic', index: 0, attempts: 0, result: '', review: false, used: [],
      skills: course.skills.map(() => ({level: 0, checks: [], last: -1})), final: []};
  }

  function courseQuestion(course, state, lang) {
    const item = course.items[state?.index];
    return item ? question(item, lang, 0, state.index, '', item.tier, '', []) : null;
  }

  function nextPractice(course, state, revisit) {
    const practice = course.items.map((item, i) => ({...item, i})).filter(q => q.phase === 'practice');
    if (state.remediation?.length) {
      const candidates = practice.filter(q => state.remediation.includes(q.skill) && q.tier === 'hard');
      const next = candidates.find(q => !state.used.includes(q.i)) ||
        candidates.find(q => q.i !== state.index) || candidates[0];
      Object.assign(state, {stage: 'practice', index: next.i, review: false, coached: true});
      return;
    }
    let candidates = practice.filter(q => !state.used.includes(q.i));
    const practiceCount = state.used.filter(i => course.items[i].phase === 'practice').length;
    const spaced = practiceCount % 3 === 2;
    const focus = Number.isInteger(state.focus) ? state.focus : revisit;
    const reviews = spaced ? candidates.filter(q => {
      const s = state.skills[q.skill];
      return s.last >= 0 && s.last < state.used.length - 2 && s.level > 0;
    }) : [];
    if (reviews.length && focus == null) candidates = reviews;
    else if (candidates.some(q => q.skill === focus)) candidates = candidates.filter(q => q.skill === focus);
    const requested = candidates.filter(q => q.tier === state.prefer);
    if (requested.length) candidates = requested;
    const placement = q => practiceCount === 0 && state.skills[q.skill].diagnostic === false ? 0 : 1;
    candidates.sort((a, b) => placement(a) - placement(b) || state.skills[a.skill].level - state.skills[b.skill].level ||
      state.skills[a.skill].last - state.skills[b.skill].last);
    const next = candidates[0];
    state.stage = next ? 'practice' : 'exhausted';
    state.index = next?.i ?? -1;
    state.review = Boolean(next && reviews.some(q => q.i === next.i));
    state.coached = Boolean(next && revisit === next.skill);
    delete state.focus;
    delete state.prefer;
  }

  function courseTurn(course, previous, action, value, lang) {
    if (!previous || action === 'restart') return startCourse(course);
    const state = JSON.parse(JSON.stringify(previous));
    const item = course.items[state.index];
    if (state.stage === 'practice' && action === 'focus' && course.skills[value]) {
      state.focus = value;
      if (!state.attempts && !state.result && state.used.every(i => course.items[i].phase === 'diagnostic')) {
        nextPractice(course, state, null);
      }
      return state;
    }
    if (state.stage === 'practice' && (value === 'medium' || value === 'hard') && action === 'difficulty') {
      state.prefer = value;
      return state;
    }
    if (!item) return state;
    const skill = state.skills[item.skill];
    if (action === 'next' && state.result) {
      const result = state.result;
      Object.assign(state, {attempts: 0, result: '', review: false});
      if (state.stage === 'diagnostic' && course.items[state.index + 1]?.phase === 'diagnostic') {
        state.index++;
      } else if (state.stage === 'final' && course.items[state.index + 1]?.phase === 'final') {
        state.index++;
      } else if (state.stage === 'final' && state.final.every(attempt => attempt.correct)) {
        Object.assign(state, {stage: 'mastered', index: -1});
      } else if (state.stage !== 'final' && !state.remediation?.length && state.skills.every(s => s.level >= 4)) {
        Object.assign(state, {stage: 'final', index: course.items.findIndex(q => q.phase === 'final'), final: []});
      } else {
        if (state.stage === 'final') {
          const missed = state.final.filter(attempt => !attempt.correct);
          const affected = missed.map(attempt => course.items[attempt.index].skill);
          state.remediation = affected.includes(null) ? state.skills.map((_, i) => i) : affected;
          for (const i of state.remediation) state.skills[i].level = 3;
          state.final = [];
          state.finalFailed = true;
        }
        nextPractice(course, state, result === 'wrong' || result === 'told' ? item.skill : null);
      }
      return state;
    }
    if (state.result || (action !== 'answer' && action !== 'tell') ||
        (action === 'answer' && !KEYS.includes(value)) || (action === 'tell' && state.stage !== 'practice')) return state;
    const correct = action === 'answer' && courseQuestion(course, state, lang).correct_key === value;
    const independent = correct && state.attempts === 0 && !state.used.includes(state.index);
    if (state.stage === 'practice' && action === 'answer' && !correct && !state.attempts) {
      state.attempts = 1;
      if (state.review && skill) { skill.level = Math.max(0, skill.level - 1); skill.checks = []; }
      return state;
    }
    if (state.stage === 'practice' && state.remediation?.includes(item.skill) && correct && !state.attempts) {
      skill.level = 4;
      state.remediation = state.remediation.filter(i => i !== item.skill);
    } else if (state.stage !== 'final' && skill && independent && !state.remediation?.includes(item.skill)) {
      skill.checks.push({level: TIERS.indexOf(item.tier) + 2, unprompted: !state.coached});
      if (skill.checks.length >= 2) {
        for (let target = 4; target > skill.level; target--) {
          const qualifying = skill.checks.filter(check => check.level >= target);
          if (qualifying.length >= 2 && qualifying.some(check => check.unprompted)) {
            skill.level = target;
            break;
          }
        }
      }
    }
    if (skill) skill.last = state.used.length;
    if (state.stage === 'diagnostic') skill.diagnostic = correct;
    if (!state.used.includes(state.index)) state.used.push(state.index);
    if (state.stage === 'final') state.final.push({index: state.index, correct});
    state.result = action === 'tell' ? 'told' : correct ? 'correct' : 'wrong';
    return state;
  }

  return {grounding, clean, rejectReason, unsupportedNumbers, validItem, validateSet, validateCourse,
    question, subskill, startCourse, courseQuestion, courseTurn, AI_NOTE, LIMITS, COURSE_VERSION, PRACTICE_PER_SKILL};
})();
if (typeof module !== 'undefined') module.exports = CaseQuiz;
