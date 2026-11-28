/* Checks Groq-written quiz sets against the lesson's verbatim excerpts. Shared by the browser and generate_quiz_sets.js. */
const CaseQuiz = (() => {
  const KEYS = ['A', 'B', 'C', 'D'];
  const LIMITS = {items: 8, quote: [20, 700], stem: [20, 900], caseStem: 60, option: [1, 300], explanation: [20, 900]};
  const MAX_CASE_EXCERPTS = 2;
  const AI_NOTE = {
    vi: 'Câu hỏi do AI (Groq) soạn từ trích đoạn nguồn, chưa được bác sĩ duyệt.',
    en: 'Written by AI (Groq) from the source excerpt; not physician-reviewed.'
  };
  const squash = s => String(s).replace(/\s+/g, ' ').trim();
  const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const DURATION_WORDS = new RegExp(`(?<![\\w-])(${NUMBER_WORDS.join('|')})(?=[ \\-–‑]+(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?)\\b)`, 'gi');
  const numbers = s => (String(s).replace(DURATION_WORDS, word => NUMBER_WORDS.indexOf(word.toLowerCase()))
    .replace(/\b(\d{1,3})(?:[ \u00a0\u202f]\d{3})+(?!\d)/g, m => m.replace(/\s/g, ''))
    .match(/\d+(?:[.,]\d+)*/g) || []).map(n => n.replace(/,/g, '.')).map(n =>
    /^[1-9]\d{0,2}(?:\.\d{3})+$/.test(n) ? n.replace(/\./g, '') : n.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
  const DOSE = /\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|μg|g|ml|mmol|iu|ui|units?|đơn vị)(?![\p{L}\p{N}])(?:\s*\/\s*(?:kg|m2|m²|min|phút|h|hr|giờ|day|ngày|d)(?![\p{L}\p{N}]))*(?:\s+(?:(?:once|twice)\s+daily|\d+\s+times?\s+(?:daily|per\s+day)|daily|per\s+day)(?![\p{L}\p{N}]))?/giu;
  const EN_DAILY = /\s+(?:once\s+daily|daily|per\s+day)$/i;
  // Lab concentrations and eGFR in a vignette are not doses (mmol/L, mg/dL, mL/min); rates such as mg/min still are.
  const LAB = /\d+(?:[.,]\d+)?\s*(?:(?:mg|g|mmol|µmol|μmol|mcg|µg|μg|ng|pg|mEq)\s*\/\s*d?l|ml\s*\/\s*min(?:\s*\/\s*1[.,]73\s*m(?:2|²))?)(?![\p{L}])/giu;
  const LAB_OR_DOSE = new RegExp(`(${LAB.source})|${DOSE.source}`, 'giu');
  // The app shuffles options, so explanations must not name them by letter.
  const LETTERS = [/(?:[Oo]ptions?|[Cc]hoices?|[Aa]nswers?|[Đđ]áp án|[Pp]hương án|[Ll]ựa chọn|[Cc]họn)\s*\(?[A-D]\)?(?![\p{L}\p{N}])/u,
    /(?:^|[^\p{L}\p{N}])[A-D](?:\s*(?:,|and|và|or|hoặc)\s*[A-D])*\s+(?:(?:is|are|là)\s+)?(?:correct|incorrect|wrong|right|đúng|sai)(?![\p{L}])/u];
  const UNIT_ALIASES = {'phút': 'min', 'giờ': 'h', hr: 'h', 'ngày': 'day', d: 'day', 'm²': 'm2', 'μg': 'mcg', 'µg': 'mcg', ui: 'iu',
    unit: 'units', 'đơn vị': 'units'};
  const doseKey = d => squash(d).toLowerCase().replace(EN_DAILY, '/day').replace(/,/g, '.').replace(/\s*\/\s*/g, '/').replace(/(\d)\s+/, '$1')
    .replace(/[\p{L}²]+(?: vị)?/gu, u => UNIT_ALIASES[u] || u);
  // "A and C give…" names options; "stages B and C" or "class A or B" names a clinical grade.
  const LETTER_LIST = /(?:^|[^\p{L}\p{N}])((?:[Ss]tages?|[Cc]lass(?:es)?|[Tt]ypes?|[Gg]rades?|[Gg]iai đoạn|[Nn]hóm|[Pp]hân độ|[Ll]oại|[Mm]ức)\s+)?[A-D](?:\s*(?:,|and|và|or|hoặc)\s*[A-D])+(?![\p{L}\p{N}])/gu;
  const namesOptions = e => LETTERS.some(r => r.test(e)) || [...String(e).matchAll(LETTER_LIST)].some(m => !m[1]);
  const doses = s => String(s).replace(LAB, ' ').match(DOSE) || [];
  const quotedDoseKeys = excerpts => new Set(excerpts.flatMap(q => doses(squash(q))
    .flatMap(d => [doseKey(d), doseKey(d.replace(EN_DAILY, ''))])));
  const text = (v, [min, max]) => typeof v === 'string' && squash(v).length >= min && v.length <= max;
  const claimWords = s => s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  function claimText(s) {
    const original = claimWords(s.normalize('NFC'));
    const en = original.toLowerCase().replace(/\bnon fatal\b/g, 'nonfatal');
    const vi = claimWords(en.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd'));
    return {en, vi, original};
  }
  const wholeWords = (terms, flags) => new RegExp('(?:^| )(' + terms + ')(?= |$)', flags);
  const CLAIMS = Object.entries({
    mortality: ['deaths?|died|mortality|fatal', 'tu vong|chet'],
    cardiovascular_mortality: ['(?:cardiovascular|cardiac|cv) (?:deaths?|mortality)|deaths? (?:from|due to) cardiovascular causes?', 'tu vong (?:do )?tim mach'],
    all_cause_mortality: ['all cause (?:deaths?|mortality)|death from any cause', 'tu vong (?:do )?(?:moi|tat ca cac) nguyen nhan'],
    myocardial_infarction: ['myocardial infarctions?|heart attacks?|mi', 'nhoi mau co tim|nmct', 'MI'],
    stroke: ['strokes?|cerebrovascular accidents?', 'dot quy|tai bien mach mau nao'],
    ischemic_stroke: ['isch[ae]emic strokes?', 'dot quy thieu mau(?: cuc bo)?|nhoi mau nao'],
    hemorrhagic_stroke: ['h[ae]emorrhagic strokes?|hemorrhagic strokes?', 'dot quy xuat huyet|xuat huyet nao'],
    hospitalization: ['hospitali[sz]ations?|hospitali[sz]ed|hospital admissions?|admitted to hospital', 'nhap vien|nhap benh vien'],
    heart_failure_hospitalization: ['heart failure hospitali[sz]ations?|hospitali[sz]ations? (?:for|due to) (?:heart failure|hf)', 'nhap vien (?:do|vi|vi benh) suy tim'],
    cardiovascular_events: ['(?:cardiovascular|cv) (?:adverse )?events?', 'bien co tim mach|su kien tim mach'],
    events: ['events?', 'bien co|su kien'],
    major_cardiovascular_events: ['major (?:adverse )?cardiovascular events?|mace', 'bien co tim mach lon|bien co tim mach bat loi chinh', 'MACE'],
    primary_cardiovascular_outcome: ['primary cardiovascular (?:events?|outcomes?|endpoints?)', '(?:bien co|ket cuc|tieu chi) tim mach chinh'],
    heart_failure: ['heart failure|hf', 'suy tim', 'HF'],
    kidney_decline: ['(?:decline|declines|reduction|reductions) in (?:renal|kidney) function|(?:renal|kidney) function (?:decline|declines|reduction|reductions)', 'suy giam (?:chuc nang )?than|giam chuc nang than'],
    egfr: ['egfr|estimated glomerular filtration rate', 'egfr|muc loc cau than uoc tinh|toc do loc cau than uoc tinh'],
    kidney_failure: ['kidney failure|renal failure', 'suy than'],
    ckd_progression: ['(?:ckd|chronic kidney disease) progression|progression of (?:ckd|chronic kidney disease)', 'benh than man(?: tinh)? tien trien'],
    bleeding: ['bleeding|h[ae]emorrhage|hemorrhage', 'xuat huyet|chay mau'],
    major_bleeding: ['major bleeding|major h[ae]emorrhage', 'xuat huyet (?:nang|chinh)|chay mau (?:nang|chinh)'],
    atrial_fibrillation: ['atrial fibrillation|af', 'rung nhi', 'AF'],
    diabetes: ['diabetes|diabetic', 'dai thao duong|tieu duong'],
    type_2_diabetes: ['type 2 diabetes|t2d|t2dm', '(?:dai thao duong|tieu duong) (?:type|typ|tuyp|loai) 2', 'T2D|T2DM'],
    chronic_kidney_disease: ['chronic kidney disease|ckd', 'ckd|benh than man(?: tinh)?|suy than man(?: tinh)?'],
    with_ckd: ['with (?:and without )?(?:ckd|chronic kidney disease)', '(?<!khong )co benh than man(?: tinh)?'],
    without_ckd: ['(?:with and )?without (?:ckd|chronic kidney disease)', 'khong (?:co |mac )?benh than man(?: tinh)?'],
    regardless_of_ckd: ['(?:regardless|irrespective) of (?:ckd|chronic kidney disease)(?: status)?|without heterogeneity by (?:ckd|chronic kidney disease) status|no heterogeneity by (?:ckd|chronic kidney disease) status', 'bat ke (?:tinh trang )?(?:ckd|benh than man(?: tinh)?)'],
    hypertension: ['hypertens(?:ion|ive)', 'tang huyet ap'],
    women: ['women|woman|female(?: patients?| participants?)?', 'phu nu|benh nhan nu'],
    men: ['men|man|male(?: patients?| participants?)?', 'nam gioi|benh nhan nam|dan ong'],
    older_adults: ['older adults?|elderly', 'nguoi cao tuoi|benh nhan cao tuoi'],
    children: ['children|pediatric|paediatric', 'tre em|benh nhi'],
    pregnancy: ['pregnan(?:t|cy)', 'mang thai|thai ky|thai phu'],
    community_dwelling: ['community dwelling', 'song tai cong dong'],
    primary_prevention: ['primary prevention', 'du phong tien phat'],
    secondary_prevention: ['secondary prevention', 'du phong thu phat'],
    composite_endpoint: ['composite (?:outcomes?|endpoints?)', '(?:ket cuc|tieu chi) gop'],
    nonfatal: ['nonfatal', 'khong gay tu vong'],
    reduced_ejection_fraction: ['reduced ejection fraction|hfref', 'phan suat tong mau giam', 'HFrEF|HFREF'],
    preserved_ejection_fraction: ['preserved ejection fraction|hfpef', 'phan suat tong mau bao ton', 'HFpEF|HFPEF'],
    statistically_significant: ['(?<!not )(?<!no )statistically significant', '(?<!khong )co y nghia thong ke'],
    no_statistical_significance: ['not statistically significant|no statistically significant', 'khong co y nghia thong ke'],
    absolute_risk_reduction: ['absolute risk reduction|absolute reduction in risk', 'giam nguy co tuyet doi|giam tuyet doi nguy co'],
    relative_risk_reduction: ['relative risk reduction|relative reduction in risk', 'giam nguy co tuong doi|giam tuong doi nguy co'],
    only: ['only in (?:patients|participants|adults|women|men|children)|exclusively in', 'chi o (?:benh nhan|nguoi|phu nu|nam gioi|tre em)'],
  }).map(([kind, [en, vi, acronym]]) => [kind, {en: wholeWords(en), vi: wholeWords(vi), acronym: acronym && wholeWords(acronym)}]);
  const CKD_STATUS = {
    en: wholeWords('(?:ckd|chronic kidney disease) status'),
    vi: wholeWords('tinh trang (?:ckd|benh than man(?: tinh)?)'),
  };
  const STAGE_VALUE = '([1-5][ab]?|i{1,3}|iv|v)', NYHA_VALUE = '(iv|i{1,3}|[1-4])';
  const QUALIFIERS = {
    en: [['stage', wholeWords('stage ' + STAGE_VALUE, 'g')], ['nyha', wholeWords('nyha (?:class )?' + NYHA_VALUE, 'g')]],
    vi: [['stage', wholeWords('giai doan ' + STAGE_VALUE, 'g')], ['nyha', wholeWords('nyha (?:do )?' + NYHA_VALUE, 'g')]],
  };
  const CLAIM_LANGUAGES = ['vi', 'en'];
  const qualifierClaims = (value, lang) => QUALIFIERS[lang].flatMap(([kind, re]) =>
    [...value[lang].matchAll(re)].map(([, , match]) => kind + ' ' + match));
  const matchesClaim = (re, value, lang) => re[lang].test(value[lang]) || (lang === 'vi' && re.acronym?.test(value.original));

  function unsupportedClaims(item) {
    const correct = item.options[KEYS.indexOf(item.answer)];
    const quotes = citedExcerpts(item).map(claimText);
    const found = new Set();
    const cited = new Set(quotes.flatMap(q => CLAIM_LANGUAGES.flatMap(lang => qualifierClaims(q, lang))));
    const ckdStatusCited = quotes.some(q => CLAIM_LANGUAGES.some(lang => CKD_STATUS[lang].test(q[lang])));
    for (const lang of CLAIM_LANGUAGES) {
      for (const field of [correct[lang], item['explanation_' + lang]]) {
        const claim = claimText(field);
        for (const [kind, re] of CLAIMS) {
          if (!matchesClaim(re, claim, lang) || quotes.some(q => CLAIM_LANGUAGES.some(lang => matchesClaim(re, q, lang)))) continue;
          if ((kind === 'with_ckd' || kind === 'without_ckd') && ckdStatusCited) continue;
          found.add(kind);
        }
        for (const qualifier of qualifierClaims(claim, lang)) if (!cited.has(qualifier)) found.add(qualifier);
      }
    }
    return [...found];
  }

  function grounding(lesson) {
    const source = lesson && lesson.primary_source || {};
    const pmid = typeof source.pmid === 'string' ? source.pmid : '';
    const excerpts = (lesson && lesson.quiz_source_texts && lesson.quiz_source_texts[pmid] || [])
      .filter(t => typeof t === 'string' && t.trim());
    return {pmid, kind: source.kind || '', title: source.title || source.name || '', excerpts,
      imagingPci: excerpts.some(comparesImagingPci)};
  }

  const citedExcerpts = item => item?.quotes ?? [item?.quote];
  const CITATION_REF = /\[\s*\d+\s*\]|\b(?:excerpts?|trích đoạn|đoạn trích|trích dẫn|câu trích|phần trích|đoạn)\s*(?:số\s*)?\[?\d+\]?/giu;
  const answerNumbers = value => numbers(value.replace(CITATION_REF, ' '));

  function hasSecondaryAnswer(item) {
    if (!item.quotes) return false;
    const key = item.options[KEYS.indexOf(item.answer)];
    const figures = [...answerNumbers(key.en), ...answerNumbers(key.vi)];
    const [first, second] = item.quotes.map(numbers);
    return figures.every(n => second.includes(n)) && figures.some(n => !first.includes(n));
  }

  // Numbers in the correct option and explanations must come from the source or the stem; "excerpt 2" / "[2]" are references.
  function unsupportedNumbers(item, ground) {
    const fields = item.quotes ? citedExcerpts(item) : [ground.title, ...ground.excerpts, item.stem_vi, item.stem_en];
    const allowed = new Set(fields.flatMap(numbers));
    const correct = item.options[KEYS.indexOf(item.answer)];
    return [correct.vi, correct.en, item.explanation_vi, item.explanation_en]
      .flatMap(answerNumbers).filter(n => !allowed.has(n));
  }

  const CKD_GROUP = {
    en: /\b(?:ckd|chronic kidney disease)\b/,
    vi: /\b(?:ckd|(?:benh|suy) than man(?: tinh)?)\b/,
  };
  const WITHOUT_CKD = {
    en: /\b(?:without|no|non) (?:ckd|chronic kidney disease)\b/,
    vi: /\bkhong (?:co |mac )?(?:ckd|benh than man(?: tinh)?)\b/,
  };
  const BOTH_CKD = {
    en: /\b(?:with and without|with or without) (?:ckd|chronic kidney disease)\b|\b(?:no|without) heterogeneity by (?:ckd|chronic kidney disease) status\b/,
    vi: /\bco va khong (?:co )?(?:ckd|benh than man(?: tinh)?)\b|\bkhong (?:co )?(?:khac biet(?: theo| ve)?|dong nhat) theo tinh trang (?:ckd|benh than man)\b/,
  };
  function ckdGroups(value, lang) {
    if (BOTH_CKD[lang].test(value)) return ['with_ckd', 'without_ckd'];
    const negative = WITHOUT_CKD[lang].test(value);
    return [...(negative ? ['without_ckd'] : []),
      ...(CKD_GROUP[lang].test(value.replace(WITHOUT_CKD[lang], ' ')) ? ['with_ckd'] : [])];
  }

  const PERCENT = /(\d+(?:[.,]\d+)?)\s*(%|percentage points?|điểm phần trăm|phần trăm)/giu;
  const RATIO = /\b(relative risk|risk ratio|hazard ratio|odds ratio|rr|hr|or)(?:\s*\[(?:rr|hr|or)\])?\s*[:=,]?\s*(\d+(?:[.,]\d+)?)/gi;
  const RATIO_KIND = {'relative risk': 'rr', 'risk ratio': 'rr', 'hazard ratio': 'hr', 'odds ratio': 'or'};
  function effectFigures(value, includePercent = true) {
    return [
      ...(includePercent ? [...value.matchAll(PERCENT)].map(([, n, unit]) => numbers(n)[0] + (/point|điểm/iu.test(unit) ? ' pp' : '%')) : []),
      ...[...value.matchAll(RATIO)].filter(([, measure]) => measure !== 'or')
        .map(([, measure, n]) => (RATIO_KIND[measure.toLowerCase()] || measure.toLowerCase()) + ' ' + numbers(n)[0]),
    ];
  }

  const PCI_ENDPOINT_TERMS = Object.entries({
    lesion_failure: ['target lesion failures?|tlf', 'that bai ton thuong (?:dich|muc tieu)|tlf'],
    vessel_failure: ['target vessel failures?|tvf', 'that bai mach (?:dich|muc tieu)|tvf'],
    lesion_revascularization: ['target lesion revasculari[sz]ations?|tlr', 'tai (?:thong|tuoi mau|can thiep) ton thuong (?:dich|muc tieu)|tlr'],
    vessel_revascularization: ['target vessel revasculari[sz]ations?|tvr', 'tai (?:thong|tuoi mau|can thiep) mach (?:dich|muc tieu)|tvr'],
    cardiac_death: ['cardiac (?:mortality|deaths?)|deaths? from cardiac causes?', 'tu vong (?:do )?tim(?: mach)?'],
    infarction: ['myocardial infarctions?|mis?', 'nhoi mau co tim|nmct|mi'],
    stent_thrombosis: ['stent thrombos(?:is|es)', 'huyet khoi (?:trong )?(?:stent|gia do)'],
    all_cause_death: ['all cause (?:mortality|deaths?)|deaths? from any cause', 'tu vong (?:do )?(?:moi nguyen nhan|tat ca cac nguyen nhan|toan nguyen)'],
    stroke: ['strokes?', 'dot quy|tai bien mach mau nao'],
    sudden_death: ['sudden cardiac deaths?', 'dot tu tim|tu vong tim dot ngot'],
    non_st_infarction: ['non st elevation myocardial infarctions?|nstemis?', 'nhoi mau co tim khong st chenh len|nstemi'],
  });
  const PCI_ENDPOINTS = PCI_ENDPOINT_TERMS.map(([name, [en, vi]]) => [name, {en: wholeWords(en), vi: wholeWords(vi)}]);
  const PCI_HISTORY = Object.fromEntries([
    ['en', 0, '(?:history of|prior|previous|past)', 'and|or'],
    ['vi', 1, '(?:tien su(?: mac)?|(?:da )?tung (?:bi|mac))', 'va|hoac'],
  ].map(([lang, column, prefix, joiner]) => {
    const endpoint = '(?:' + PCI_ENDPOINT_TERMS.map(([, terms]) => terms[column]).join('|') + ')';
    return [lang, wholeWords(prefix + ' ' + endpoint + '(?: (?:' + joiner + ') ' + endpoint + ')*', 'g')];
  }));
  const pciEndpoints = (field, lang, isStem = false) => {
    const normalized = claimText(field)[lang];
    const words = isStem ? normalized.replace(PCI_HISTORY[lang], ' ') : normalized;
    const found = new Set(PCI_ENDPOINTS.filter(([, patterns]) => patterns[lang].test(words)).map(([name]) => name));
    if (found.has('sudden_death')) found.delete('cardiac_death');
    if (found.has('non_st_infarction')) found.delete('infarction');
    return found;
  };
  const PCI_GUIDANCE = [
    {en: wholeWords('angiograph(?:y|ic)'), vi: wholeWords('chup (?:dong )?mach(?: vanh)?')},
    {en: wholeWords('(?:intracoronary )?imaging|ici|ivus|oct'), vi: wholeWords('hinh anh(?: noi mach)?|ici|ivus|oct')},
  ];
  const PCI_BAD_TRANSLATION = wholeWords('nhieu anh|angiograph(?:y|ic)|chi dinh noi mach|chi dan noi mach');
  const PCI = wholeWords('pci|percutaneous coronary intervention');
  const sameSet = (a, b) => a.size === b.size && [...a].every(n => b.has(n));

  function comparesImagingPci(quote) {
    const words = claimText(quote).en;
    return PCI.test(words) && PCI_GUIDANCE.every(term => term.en.test(words));
  }

  function pciEvidenceReason(item, ground) {
    if (!ground.imagingPci && !ground.excerpts.some(comparesImagingPci)) return '';
    const results = new Map();
    for (const quote of citedExcerpts(item)) {
      for (const endpoint of pciEndpoints(quote, 'en')) if (!results.has(endpoint)) results.set(endpoint, []);
      for (const [, label, values] of quote.matchAll(/([^(),]+)\(([^()]*)\)/g)) {
        for (const endpoint of pciEndpoints(label, 'en')) {
          results.set(endpoint, [...(results.get(endpoint) || []), ...effectFigures(values)]);
        }
      }
    }
    const key = item.options[KEYS.indexOf(item.answer)];
    const fields = [key, ...['stem', 'explanation'].map(name => ({en: item[name + '_en'], vi: item[name + '_vi'], isStem: name === 'stem'}))];
    const named = fields.map(({en, vi, isStem}) => [pciEndpoints(en, 'en', isStem), pciEndpoints(vi, 'vi', isStem)]);
    const expected = new Set(named.flatMap(([en]) => [...en]));
    if (named.some(([en, vi]) => !sameSet(en, vi)) || [...expected].some(endpoint => !results.has(endpoint))) return 'endpoint';
    for (const [index, field] of fields.entries()) {
      const [names] = named[index];
      if (names.size && !sameSet(names, expected)) return 'endpoint';
      for (const lang of CLAIM_LANGUAGES) {
        for (const clause of field[lang].split(STUDY_CLAUSE)) {
          const local = pciEndpoints(clause, lang, field.isStem);
          const targets = local.size ? local : expected;
          const figures = effectFigures(clause).filter(figure => /^(?:rr|hr|or) /.test(figure));
          if (targets.size && figures.some(figure => ![...targets].some(name => results.get(name)?.includes(figure)))) return 'endpoint';
        }
      }
      const en = claimText(field.en).en, vi = claimText(field.vi).vi;
      if (PCI_BAD_TRANSLATION.test(vi) || PCI_GUIDANCE.some(term => term.en.test(en) !== term.vi.test(vi))) return 'comparator';
    }
    return '';
  }

  const NULL_EFFECT = {
    en: /^(?:(?:there (?:is|was) )?no (?:difference|change|effect)|null(?: effect)?|(?:the )?risk (?:is |was )?unchanged)$/,
    vi: /^(?:khong (?:co )?(?:su )?(?:khac biet|thay doi|anh huong|tac dong)|nguy co khong doi)$/,
  };
  const NULL_RATIO = /^(rr|hr|or|relative risk|risk ratio|hazard ratio|odds ratio)\s*(?:[:=]|of\b|la\b|là\b)?\s*1(?:[.,]0+)?\s*(?:\(([^()]*)\))?[.!]?$/i;

  function hasDuplicateEffectOptions(item) {
    return CLAIM_LANGUAGES.some(lang => {
      const kinds = new Set();
      for (const option of item.options) {
        const value = squash(option[lang]);
        const ratio = value.match(NULL_RATIO);
        const kind = NULL_EFFECT[lang].test(claimText(value)[lang]) ? 'null' :
          ratio && (!ratio[2] || NULL_EFFECT[lang].test(claimText(ratio[2])[lang])) &&
          (RATIO_KIND[ratio[1].toLowerCase()] || ratio[1].toLowerCase());
        if (!kind) continue;
        if (kinds.has(kind) || kinds.has('null') || (kind === 'null' && kinds.size)) return true;
        kinds.add(kind);
      }
      return false;
    });
  }

  const ENDPOINT_CONTEXT = {
    en: /\b(?:risk|rate|declines?|decreases?|increases?|reductions?|outcomes?|endpoints?)\b/,
    vi: /\b(?:nguy co|ty le|ti le|suy giam|giam|tang|ket cuc|tieu chi)\b/,
  };
  const EFFECT_CONTEXT = {
    en: /\b(?:events?|deaths?|mortality|hospitali[sz]ations?|incidence|benefit|effect|improvement|change)\b/,
    vi: /\b(?:bien co|su kien|tu vong|nhap vien|loi ich|tac dong|hieu qua|cai thien|thay doi)\b/,
  };
  const BASELINE_MEASUREMENT = /\b(?:(lvef|ef|(?:left ventricular )?ejection fraction|phân suất tống máu(?: thất trái)?)|(egfr|estimated glomerular filtration rate|(?:tốc độ |mức )?lọc cầu thận ước tính))\s*(?:[:=]|of\b|là\b)?\s*(\d+(?:[.,]\d+)?)(?:\s*(%|phần trăm\b))?(?![\d.,]*\d)/giu;
  const REPORTED_MEASUREMENT = /\b(?:increas\w*|decreas\w*|reduc\w*|declin\w*|improv\w*|report\w*|found|showed|fell|rose|tăng|giảm|cải thiện|báo cáo|ghi nhận)(?:\s+(?:in|of|the|an?))*\s*$/iu;
  const STUDY_CLAUSE = /[!?;]|\.(?!\d)/;
  function withoutVignetteBaseline(clause, lang) {
    if (!PATIENT[lang].test(claimText(clause)[lang])) return clause;
    return clause.replace(BASELINE_MEASUREMENT, (match, ef, _egfr, _value, unit, index) =>
      (ef && !unit) || REPORTED_MEASUREMENT.test(clause.slice(0, index)) ? match : ' ');
  }
  const RESULT_COUNT = /(\d+(?:[.,]\d+|[ \u00a0\u202f]\d{3})*)\s+(?:fewer |more )?(?:cases?|events?|deaths?|participants?|hospitali[sz]ations?|studies|trường hợp|biến cố|ca tử vong|người tham gia|ca nhập viện|nghiên cứu)(?![\p{L}\p{N}])/giu;
  const RESULT_STATEMENT = /\b(?:report(?:s|ed)?|found|showed|identified|included|fewer|more|ghi nhận|cho thấy|báo cáo|xác định|bao gồm)\b/iu;
  const ABSOLUTE_RISK_LEVEL = /\b(?:increas(?:e|ed|es)|decreas(?:e|ed|es)|reduc(?:e|ed|es)|rais(?:e|ed|es)|tăng|giảm)\b[^.;!?]*?\b(?:to|lên|xuống|còn)\s+(\d+(?:[.,]\d+)?)\s*%/giu;
  const DECLINE_THRESHOLD = /(?:≥|>=|at least|ít nhất)\s*(\d+(?:[.,]\d+)?)\s*%|(\d+(?:[.,]\d+)?)\s*%\s*(?:or greater|or more|trở lên)/giu;
  const declineThresholds = text => [...text.matchAll(DECLINE_THRESHOLD)].map(([, before, after]) => numbers(before || after)[0]);
  function pairedDeclineEffects(quote) {
    const [outcomes, estimates] = quote.split(/\bdeclines by\b/i);
    const levels = declineThresholds(outcomes);
    const groups = estimates ? estimates.split(/(?:\s*,\s*(?:and\s+)?|\s+and\s+)(?=\d+(?:[.,]\d+)?\s*%)/i)
      .map(group => new Set(effectFigures(group))) : [];
    return levels.length > 1 && levels.length === groups.length ? new Map(levels.map((n, i) => [n, groups[i]])) : new Map();
  }
  const PATIENT = {
    en: /\b(?:patient|person|woman|man|adult|child)\b/,
    vi: /\b(?:benh nhan|nguoi phu nu|nguoi dan ong)\b/,
  };

  const VIGNETTE_AGE = /\b(?:aged?\s+\d{1,3}(?![\d.,])|\d{1,3}\s*(?:[-‐‑– ]\s*years?[-‐‑– ]\s*old|tuổi\b))/giu;
  const VIGNETTE_STAGE = /\b(?:stage|grade|giai đoạn|phân độ)\s+\d+(?![\d.,])/giu;
  const VIGNETTE_BP = /\b(?:bp|sbp|(?:systolic )?blood pressure|huyết áp(?: tâm thu)?)\s*(?:of |is |là |[:=]\s*)?\d+(?:\s*\/\s*\d+)?\s*mm\s*hg\b/giu;
  const LAB_CUTOFF = {
    en: /\b(?:below|above|under|over|less than|more than|greater than|at least|at most|eligible|eligibility|qualif\w*|criteri(?:a|on)|cut[- ]?offs?|thresholds?|inclusion|exclusion|requir\w*|defin\w*|must)\b/,
    vi: /\b(?:duoi|tren|nho hon|lon hon|thap hon|cao hon|it nhat|toi da|du dieu kien|dieu kien|tieu chi|nguong|yeu cau|dinh nghia|phai)\b/,
  };
  const LAB_STUDY = {
    en: /\b(?:trials?|stud(?:y|ies)|arms?|groups?|participants?|patients enrolled|medians?|means?|cohorts?)\b/,
    vi: /\b(?:nghien cuu|thu nghiem|nhom|trung vi|trung binh|doan he|nguoi tham gia)\b/,
  };
  const PATIENT_POSSESSIVE = {en: /\b(?:her|his|their)\b/, vi: /\b(?:ba|ong|co|anh) ay\b/};
  const LAB_FRAGMENT = /^\s*(?:k\+|ldl|hdl|egfr|creatinine|potassium|sodium|glucose|kali|natri)\s*[:=]?\s*\d/iu;
  const namesPatient = (text, lang) => PATIENT[lang].test(text) || lang === 'vi' && /\b(?:ba|ong) \d+ tuoi\b/.test(text);

  function unsupportedStemNumbers(item) {
    const cited = new Set(citedExcerpts(item).flatMap(numbers));
    return CLAIM_LANGUAGES.flatMap(lang => item['stem_' + lang].normalize('NFC').split(STUDY_CLAUSE).flatMap((clause, index, clauses) => {
      const worded = claimText(clause)[lang];
      const patient = namesPatient(worded, lang);
      const vignette = patient || !RESULT_STATEMENT.test(clause) && !EFFECT_CONTEXT[lang].test(worded);
      const groundedLab = /[<>≤≥]/.test(clause) || LAB_CUTOFF[lang].test(worded) || LAB_STUDY[lang].test(worded);
      const hasLab = clause.search(LAB) !== -1;
      const baseline = hasLab && groundedLab ? clause : withoutVignetteBaseline(clause, lang);
      const checked = vignette ? baseline
        .replace(VIGNETTE_AGE, ' ').replace(VIGNETTE_STAGE, ' ').replace(VIGNETTE_BP, ' ') : clause;
      const withoutNullBound = checked.replace(UPPER_BOUND, (bound, value, offset) => {
        const before = checked.slice(0, offset);
        const after = checked.slice(offset + bound.length);
        return boundValue(value) === 1 && RATIO_BEFORE_BOUND.test(before) && BOUND_END.test(after) ? ' ' : bound;
      });
      const labFragment = LAB_FRAGMENT.test(clause) && clauses.slice(0, index).some(prior => namesPatient(claimText(prior)[lang], lang));
      const patientLab = (patient || PATIENT_POSSESSIVE[lang].test(worded) || labFragment) &&
        !groundedLab && !RESULT_STATEMENT.test(clause);
      return answerNumbers(withoutNullBound.replace(LAB_OR_DOSE, (match, lab) => lab && !patientLab ? match : ' '))
        .filter(n => !cited.has(n));
    }));
  }

  const FUTURE_EVENT = {
    en: /\b(?:will|would) (?:experience|have|develop|suffer)\b/,
    vi: /\b(?:se|co the) (?:gap|mac|co|trai qua)\b/,
  };
  const PROJECTION = {
    en: /\b(?:predict\w*|project\w*|would (?:you )?expect|how many (?:\w+ ){0,4}will|over the next)\b/,
    vi: /\b(?:du doan|uoc tinh|trong \d+(?: \d+)? nam toi|bao nhieu (?:\w+ ){0,4}se)\b/,
  };
  const isProjection = (value, lang) => PROJECTION[lang].test(value) || FUTURE_EVENT[lang].test(value);
  const PERSONAL = {
    en: /\b(?:this patient|this person|this (?:woman|man|adult)|(?:her|his|your) risk|she|he|a patient)\b/,
    vi: /\b(?:benh nhan nay|nguoi nay|mot benh nhan|nguy co cua (?:ba|ong|co|anh) ay)\b/,
  };
  const COHORT = {
    en: /\b(?:hypothetical|cohort of \d|in \d+(?: \d+)* (?:patients|adults|people|participants))\b/,
    vi: /\b(?:gia dinh|nhom \d+(?: \d+)* (?:nguoi|benh nhan))\b/,
  };
  const PERSONAL_RISK = {
    en: /\b(?:(?:her|his|your|this patient s) (?:risk|incidence|event rate) (?:is|will be)|(?:risk|incidence|event rate) (?:in|for) this patient (?:is|will be))\b/,
    vi: /\b(?:nguy co|ty le|ti le) (?:cua|o) benh nhan nay (?:la|se la)\b/,
  };
  const HYPOTHETICAL_COUNT = {
    en: /\b(?:hypothetical|suppose|imagine|if)\b.*\bhow many\b/,
    vi: /\b(?:gia dinh|gia su|neu)\b.*\bbao nhieu\b/,
  };
  const PROJECTION_LIMIT = {
    en: /\b(?:(?:cannot|can t|(?:does|do|did|could) not|is unable to) (?:\w+ ){0,8}(?:predict|estimate|project|determine|tell|establish)|not (?:an? )?(?:individual|personal|patient specific) (?:risk|prediction|estimate))\b/,
    vi: /\b(?:(?:khong the|khong du de|khong dung de) (?:\w+ ){0,8}(?:du doan|uoc tinh|ngoai suy|xac dinh)|khong phai (?:la )?(?:nguy co|du doan|uoc tinh) ca nhan)\b/,
  };
  function projectionClauses(value, lang) {
    return value.split(/[!?;\r\n\u2028\u2029]|\.(?!\d)/).map(clause => claimText(clause)[lang]);
  }

  function projectsGroupResult(item) {
    const correct = item.options[KEYS.indexOf(item.answer)];
    return CLAIM_LANGUAGES.some(lang => {
      const stemClauses = projectionClauses(item['stem_' + lang], lang);
      const keyClauses = projectionClauses(correct[lang], lang);
      const limit = clause => PROJECTION_LIMIT[lang].test(clause);
      const stem = stemClauses.filter(c => !limit(c)).join(' ');
      const key = keyClauses.filter(c => !limit(c)).join(' ');
      if (stemClauses.some(limit) && !keyClauses.some(limit) &&
          stemClauses.some(c => limit(c) && isProjection(c, lang))) return true;
      const result = ENDPOINT_CONTEXT[lang].test(stem + ' ' + key) || EFFECT_CONTEXT[lang].test(stem + ' ' + key) ||
        /\b(?:hazard ratio|hr|rr|or|ti so nguy co|ty so nguy co)\b/.test(stem + ' ' + key);
      return result && (PERSONAL_RISK[lang].test(key) ||
        COHORT[lang].test(stem) && (isProjection(stem, lang) || HYPOTHETICAL_COUNT[lang].test(stem)) ||
        isProjection(stem, lang) && PERSONAL[lang].test(stem) ||
        FUTURE_EVENT[lang].test(stem) && PATIENT[lang].test(stem) ||
        isProjection(key, lang) && (COHORT[lang].test(key) || PERSONAL[lang].test(key) || PATIENT[lang].test(stemClauses.join(' '))));
    });
  }

  const UPPER_BOUND = /(?:\b(?:below|less than|under|dưới|nhỏ hơn|thấp hơn)\s+|<\s*)(\d+(?:[.,]\d+)?|one\b|một\b)/iu;
  const RATIO_BEFORE_BOUND = /(?:\b(?:hazard ratio|risk ratio|relative risk|odds ratio|HR|RR|OR)|(?:tỉ|tỷ) số nguy cơ)(?:\s+nào)?\s*\(?\s*$/iu;
  const BOUND_END = /^\s*\)?\s*(?:$|[?!.,;:]|(?:is|was|did|for|được|cho|là)(?![\p{L}\p{N}]))/iu;
  const boundValue = value => Number(numbers(value)[0] ?? 1);
  const RATE_DENOMINATOR = /(?:\bper|trên|\/)\s*\d+(?:[., \u00a0\u202f]\d{3})*\s*(?:person[\s\-–‑]*years?|người[\s\-–‑]*năm|PY)(?![\p{L}\p{N}])|\/\s*(?:1[., \u00a0\u202f]?000|100)(?![\p{L}\p{N}]|[.,]\d)/giu;
  const optionFigures = value => answerNumbers(value.normalize('NFC').replace(RATE_DENOMINATOR, ' '));

  function* reportedDistractors(item) {
    const answer = KEYS.indexOf(item.answer);
    const evidence = citedExcerpts(item).map(quote => ({
      figures: numbers(quote), ratios: effectFigures(quote, false),
    }));
    for (const lang of CLAIM_LANGUAGES) {
      const key = item.options[answer][lang];
      const keyFigures = optionFigures(key);
      const keyRatios = effectFigures(key, false);
      for (const [index, option] of item.options.entries()) {
        if (index === answer) continue;
        const offered = optionFigures(option[lang]);
        const conflicting = offered.filter(n => !keyFigures.includes(n));
        if (!conflicting.length) continue;
        const excerpts = evidence.flatMap(({figures, ratios}, i) =>
          (keyFigures.length === 1 && figures.includes(keyFigures[0]) || keyRatios.some(ratio => ratios.includes(ratio))) &&
          offered.every(n => figures.includes(n)) ? [i + 1] : []);
        if (excerpts.length) yield {lang, option: index + 1, figures: [...new Set(conflicting)], citedExcerptPositions: excerpts};
      }
    }
  }

  function unsupportedCaseEffects(item) {
    const excerpts = citedExcerpts(item);
    const evidence = excerpts.map(text => {
      const quote = claimText(text);
      return {quote, figures: effectFigures(text), numbers: numbers(text), declines: pairedDeclineEffects(text),
        ckd: CLAIM_LANGUAGES.flatMap(lang => ckdGroups(quote[lang], lang))};
    });
    const cited = new Set(evidence.flatMap(e => e.figures));
    const citedNumbers = new Set(evidence.flatMap(e => e.numbers));
    const citedCkd = new Set(evidence.flatMap(e => e.ckd));
    const citedLevels = new Set(excerpts.flatMap(q => [...q.matchAll(ABSOLUTE_RISK_LEVEL)].map(([, n]) => numbers(n)[0])));
    const pairedFigures = new Set(evidence.flatMap(e => [...e.declines.values()].flatMap(figures => [...figures])));
    const relative = [...cited].some(figure => /^(?:rr|hr|or) /.test(figure));
    const egfr = CLAIMS.find(([kind]) => kind === 'egfr')[1];
    const citedEgfr = evidence.some(e => CLAIM_LANGUAGES.some(lang => matchesClaim(egfr, e.quote, lang)));
    const correct = item.options[KEYS.indexOf(item.answer)];
    const found = new Set();
    for (const lang of CLAIM_LANGUAGES) {
      const stem = item['stem_' + lang];
      const stemWords = claimText(stem)[lang];
      const groups = ckdGroups(stemWords, lang);
      const thresholds = [...new Set(declineThresholds(stem))];
      const expectedDeclineEffects = thresholds.length === 1 ? evidence.map(e => e.declines.get(thresholds[0])).filter(Boolean) : [];
      const fitsPopulation = e => !e.ckd.length || (groups.length
        ? groups.every(group => e.ckd.includes(group)) : new Set(e.ckd).size !== 1 || !PATIENT[lang].test(stemWords));
      if (citedCkd.size === 1 && !groups.length && PATIENT[lang].test(stemWords)) {
        found.add('vignette does not establish ' + [...citedCkd][0]);
      }
      for (const group of groups) {
        if (!citedCkd.has(group)) found.add(group + ' not covered by the citation');
      }
      for (const [field, isStem] of [[stem, true], [correct[lang], false], [item['explanation_' + lang], false]]) {
        const checked = isStem ? field.normalize('NFC').split(STUDY_CLAUSE).map(clause => withoutVignetteBaseline(clause, lang)).join(';') : field;
        const clauses = checked.split(STUDY_CLAUSE);
        const figures = isStem ? clauses.flatMap(clause => {
          const normalized = claimText(clause)[lang];
          const hasEffect = ENDPOINT_CONTEXT[lang].test(normalized) || EFFECT_CONTEXT[lang].test(normalized) || RESULT_STATEMENT.test(clause);
          return effectFigures(clause, hasEffect);
        }) : effectFigures(checked);
        for (const figure of figures) {
          if (!cited.has(figure)) found.add(figure);
          else if (evidence.length > 1 && !evidence.some(e => e.figures.includes(figure) && fitsPopulation(e))) {
            found.add(figure + ' not supported for the vignette population');
          }
          if (expectedDeclineEffects.length && pairedFigures.has(figure) && !expectedDeclineEffects.some(expected => expected.has(figure))) {
            found.add(figure + ' belongs to a different decline threshold');
          }
        }
        for (const [, n] of checked.matchAll(ABSOLUTE_RISK_LEVEL)) {
          const number = numbers(n)[0];
          if (relative && cited.has(number + '%') && !citedLevels.has(number)) found.add('absolute risk level ' + number + '%');
        }
        for (const clause of clauses) {
          const normalized = claimText(clause);
          if (isStem && !citedEgfr && ENDPOINT_CONTEXT[lang].test(normalized[lang]) && matchesClaim(egfr, normalized, lang)) {
            found.add('eGFR endpoint not cited');
          }
          if (!isStem || RESULT_STATEMENT.test(clause)) {
            for (const [, count] of clause.matchAll(RESULT_COUNT)) {
              const n = numbers(count)[0];
              if (!citedNumbers.has(n)) found.add('result figure ' + n);
              else if (evidence.length > 1 && !evidence.some(e => e.numbers.includes(n) && fitsPopulation(e))) {
                found.add('result figure ' + n + ' not supported for the vignette population');
              }
            }
          }
        }
      }
    }
    return [...found];
  }

  function rejectReason(item, ground) {
    if (!item || typeof item !== 'object' || !['theory', 'case'].includes(item.type)) return 'shape';
    if (item.pmid !== ground.pmid || !/^[1-9][0-9]{0,8}$/.test(ground.pmid)) return 'pmid';
    if (item.quotes !== undefined) {
      if (item.type !== 'case' || item.quote !== undefined || !Array.isArray(item.quotes) || item.quotes.length !== MAX_CASE_EXCERPTS ||
          new Set(item.quotes).size !== item.quotes.length ||
          !item.quotes.every(q => text(q, LIMITS.quote) && ground.excerpts.includes(q))) return 'quote';
    } else if (!text(item.quote, LIMITS.quote) || !ground.excerpts.some(e => squash(e).includes(squash(item.quote)))) return 'quote';
    const stemMin = item.type === 'case' ? [LIMITS.caseStem, LIMITS.stem[1]] : LIMITS.stem;
    if (!['vi', 'en'].every(l => text(item['stem_' + l], stemMin) && text(item['explanation_' + l], LIMITS.explanation))) return 'text';
    if (!Array.isArray(item.options) || item.options.length !== 4 || !KEYS.includes(item.answer)) return 'options';
    if (!item.options.every(o => o && text(o.vi, LIMITS.option) && text(o.en, LIMITS.option))) return 'options';
    for (const l of ['vi', 'en']) if (new Set(item.options.map(o => squash(o[l]).toLowerCase())).size !== 4) return 'options';
    if (unsupportedNumbers(item, ground).length) return 'numbers';
    if ([item.explanation_vi, item.explanation_en].some(namesOptions)) return 'letters';
    if (unsupportedDoses(item).length) return 'dose';
    if (item.type !== 'case') return '';
    if (hasDuplicateEffectOptions(item)) return 'duplicate-options';
    const pciReason = pciEvidenceReason(item, ground);
    if (pciReason) return pciReason;
    if (unsupportedClaims(item).length) return 'claims';
    if (unsupportedCaseEffects(item).length) return 'effects';
    if (projectsGroupResult(item)) return 'projection';
    if (!reportedDistractors(item).next().done) return 'ambiguous';
    if (unsupportedStemNumbers(item).length) return 'stem-numbers';
    return hasSecondaryAnswer(item) ? 'citation-order' : '';
  }

  function unsupportedDoses(item) {
    const everything = [item.stem_vi, item.stem_en, item.explanation_vi, item.explanation_en,
      ...item.options.flatMap(o => [o.vi, o.en])].join('\n');
    const quoted = quotedDoseKeys(citedExcerpts(item));
    return doses(everything).filter(d => !quoted.has(doseKey(d)));
  }

  const validItem = (item, ground) => !rejectReason(item, ground);

  function clean(item) {
    const pick = (o, l) => squash(o[l]);
    const citation = item.quotes ? {quotes: item.quotes.slice()} : {quote: squash(item.quote)};
    return {type: item.type, pmid: item.pmid, ...citation, answer: item.answer,
      stem_vi: squash(item.stem_vi), stem_en: squash(item.stem_en),
      explanation_vi: squash(item.explanation_vi), explanation_en: squash(item.explanation_en),
      options: item.options.map(o => ({vi: pick(o, 'vi'), en: pick(o, 'en')})), ai_generated: item.ai_generated !== false};
  }

  function validateSet(lesson, items) {
    const ground = grounding(lesson);
    const valid = (Array.isArray(items) ? items : []).slice(0, LIMITS.items).filter(i => i?.quotes === undefined && validItem(i, ground)).map(clean);
    const types = new Set(valid.map(i => i.type));
    return types.has('theory') && types.has('case') ? valid : [];
  }

  const COURSE_VERSION = 2;
  const CASE_SET_VERSION = 3, CASES_PER_SET = 3;
  const FORMATS = ['predict', 'explain', 'critique', 'apply', 'connect'];
  const TIERS = ['easy', 'medium', 'hard'];
  const LANGS = ['vi', 'en'];
  const PRACTICE_PER_SKILL = 3;
  const hasMixedTypes = items => ['theory', 'case'].every(type => items.some(item => item?.type === type));

  function validateCaseSet(lesson, set) {
    if (lesson?.quiz_mode !== 'source_excerpt' || set?.version !== CASE_SET_VERSION ||
        typeof set.set_id !== 'string' || !set.set_id.trim() || !Array.isArray(set.items) || set.items.length !== CASES_PER_SET) return null;
    const ground = grounding(lesson);
    const seen = {vi: new Set(), en: new Set()};
    const items = [];
    for (const item of set.items) {
      if (item?.type !== 'case') return null;
      const excerpts = citedExcerpts(item);
      if (!Array.isArray(excerpts) || !excerpts.every(q => ground.excerpts.includes(q))) return null;
      const cited = {...ground, title: '', excerpts};
      if (rejectReason(item, cited)) return null;
      const parsed = {...clean(item), ...(item.quotes ? {} : {quote: item.quote}), ai_generated: true};
      for (const lang of ['vi', 'en']) {
        const key = parsed['stem_' + lang].toLowerCase();
        if (seen[lang].has(key)) return null;
        seen[lang].add(key);
      }
      items.push(parsed);
    }
    return {version: CASE_SET_VERSION, set_id: set.set_id, model: set.model, items};
  }

  function courseItemReason(item, ground) {
    const reason = rejectReason(item, {...ground, title: '', excerpts: [item?.quote]});
    if (reason) return reason;
    if (!FORMATS.includes(item.format) || !TIERS.includes(item.tier)) return 'shape';
    if (item.phase === 'practice' && LANGS.some(l => {
      const hint = item['hint_' + l];
      const answer = squash(item.options[KEYS.indexOf(item.answer)][l]).toLowerCase();
      return !text(hint, [12, 300]) || !hint.trim().endsWith('?') || namesOptions(hint) ||
        squash(hint).toLowerCase().includes(answer) || squash(hint).toLowerCase() === squash(item['stem_' + l]).toLowerCase() ||
        doses(hint).some(d => !quotedDoseKeys([item.quote]).has(doseKey(d)));
    })) return 'hint';
    return '';
  }

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
      if (!item || typeof item.quote !== 'string' || !ground.excerpts.some(e => e.includes(item.quote)) ||
          courseItemReason(item, ground)) return null;
      const p = ['diagnostic', 'practice', 'final'].indexOf(item.phase);
      const t = TIERS.indexOf(item.tier);
      if (p < phase) return null;
      phase = p;
      const idx = item.skill;
      if (idx === null) {
        if (p !== 2 || item.format !== 'connect' || ++integration > 1) return null;
      } else {
        if (!Number.isInteger(idx) || !skills[idx]) return null;
        if (p === 1) practice[idx].push(item);
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
        if (seen[l].has(stem)) return null;
        seen[l].add(stem);
      }
      const base = clean(item);
      if (rejectReason(base, {...ground, title: '', excerpts: [item.quote]})) return null;
      cleaned.push({...base, quote: item.quote, phase: item.phase, skill: idx, format: item.format, tier: item.tier,
        ...(p === 1 ? {hint_vi: squash(item.hint_vi), hint_en: squash(item.hint_en)} : {})});
    }
    if (diagnosis[0].tier !== 'easy' || tier !== 2 || integration !== 1 || covered.final.size !== skills.length ||
        practice.some(group => group.length !== PRACTICE_PER_SKILL ||
          group.filter(q => q.tier === 'hard').length < 2 || !hasMixedTypes(group)) ||
        !items.some(i => i.phase === 'final' && i.type === 'case') ||
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
    const ai = item.ai_generated !== false;
    return {
      question: `${label} (PMID ${item.pmid}): ${item['stem_' + l]}`,
      options: KEYS.map((key, j) => ({key, text: item.options[order[j]][l]})), correct_key: correct,
      explanation: `${en ? 'Correct answer' : 'Đáp án đúng'}: ${correct}. ${item['explanation_' + l]} “${item.quote}” (PMID ${item.pmid}).` +
        (ai ? ` ${AI_NOTE[l]}` : ''),
      source_quote: item.quote, source_pmid: item.pmid, ai_generated: ai, case_type: item.type,
      option_ids: Object.fromEntries(KEYS.map((key, j) => [key, String(order[j])])),
      generation: {slot_idx: slotIdx, variant_idx: variantIdx, source_id: sourceId, difficulty},
      question_kind: item.type === 'case' ? 'case' : 'theory', difficulty, subskill_idx: subskill(item, sourceKind),
      required_subskills: required
    };
  }

  function startCourse(course) {
    return {stage: course.compact ? 'practice' : 'diagnostic', ...(course.compact ? {compact: true} : {}),
      index: 0, attempts: 0, result: '', review: false, used: [], history: [], revealed: {},
      skills: course.skills.map(() => ({level: 0, checks: [], last: -1})), final: []};
  }

  function courseQuestion(course, state, lang) {
    const item = course.items[state?.index];
    const previous = (state.history || []).slice(0, state.result ? -1 : undefined);
    const variant = state.index + previous.filter(i => i === state.index).length;
    return item ? question(item, lang, 0, variant, '', item.tier, '', []) : null;
  }

  function spacedRecall(state, index) {
    if (!(index in state.revealed)) return true;
    const since = Math.max(state.revealed[index], state.history.lastIndexOf(index) + 1);
    return new Set(state.history.slice(since)).size >= 2;
  }

  function selectRecall(state, candidates) {
    return candidates.find(i => !(i in state.revealed)) ??
      candidates.find(i => spacedRecall(state, i));
  }

  function nextAssessment(course, state) {
    const slots = course.items.flatMap((q, i) => q.phase === 'final' ? [i] : []);
    if (state.final.length === slots.length) return false;
    let index = slots[state.final.length];
    if (state.finalFailed) {
      const completed = new Set(state.final.map(attempt => course.items[attempt.index].skill));
      index = undefined;
      for (const slot of slots) {
        const {skill, tier, type} = course.items[slot];
        if (completed.has(skill)) continue;
        const alternatives = skill === null ? [] : course.items.flatMap((q, i) =>
          i !== slot && q.phase !== 'diagnostic' && q.skill === skill && q.type === type &&
          TIERS.indexOf(q.tier) >= TIERS.indexOf(tier) ? [i] : [])
          .sort((a, b) => Number(state.used.includes(a)) - Number(state.used.includes(b)));
        index = selectRecall(state, [slot, ...alternatives]);
        if (index != null) break;
      }
    }
    Object.assign(state, {stage: index == null ? 'exhausted' : 'final', index: index ?? -1});
    return true;
  }

  function nextPractice(course, state, revisit) {
    const practice = course.items.map((item, i) => ({...item, i})).filter(q => q.phase === 'practice');
    if (state.remediation?.length) {
      const hard = practice.filter(q => state.remediation.includes(q.skill) && q.tier === 'hard').map(q => q.i);
      const gap = practice.map(q => q.i).filter(i => !hard.includes(i) && !state.history.slice(-2).includes(i));
      const index = selectRecall(state, hard) ?? selectRecall(state, gap);
      Object.assign(state, {stage: index == null ? 'exhausted' : 'practice', index: index ?? -1, review: false, coached: true});
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

  function compactTurn(course, previous, action, value, lang) {
    if (!previous?.compact || action === 'restart') return startCourse(course);
    const state = JSON.parse(JSON.stringify(previous));
    const item = course.items[state.index];
    if (state.stage === 'final_review' && action === 'next') {
      Object.assign(state, {stage: 'practice', index: 0, attempts: 0, result: '', review: true, replay: true, final: []});
      return state;
    }
    if (!item) return state;
    const final = state.stage === 'final', count = course.items.length;
    if (action === 'next' && state.result) {
      Object.assign(state, {attempts: 0, result: ''});
      if (final && state.final.length === count) {
        state.final = state.final.filter(a => !a.correct);
        Object.assign(state, {index: -1, stage: state.final.length ? 'final_review' : 'mastered', finalFailed: Boolean(state.final.length)});
      } else if (final) {
        state.index = (state.index + 1) % count;
      } else if (state.review && !state.replay && !state.index) {
        Object.assign(state, {stage: 'final', index: 1, review: false});
      } else if (state.index + 1 < count) {
        state.index++;
      } else if (count >= 3) {
        if (state.replay) Object.assign(state, {stage: 'final', index: 0, review: false, replay: false});
        else Object.assign(state, {index: 0, review: true});
      } else Object.assign(state, {stage: 'exhausted', index: -1});
      return state;
    }
    if (state.result || action !== 'answer' || !KEYS.includes(value)) return state;
    const correct = courseQuestion(course, state, lang).correct_key === value;
    if (!final && !correct && !state.attempts) {
      state.attempts = 1;
      return state;
    }
    if (final) state.final.push({index: state.index, correct: correct && spacedRecall(state, state.index)});
    else {
      const skill = state.skills[item.skill];
      if (!state.used.includes(state.index)) {
        state.used.push(state.index);
        const evidence = citedExcerpts(item)[0];
        if (correct && !state.attempts && !skill.checks.some(c => c.index === state.index || c.evidence === evidence)) {
          skill.checks.push({index: state.index, evidence});
          if (skill.checks.length >= 2) skill.level = item.type === 'case' ? 4 : 3;
        }
      }
      state.revealed[state.index] = state.history.length + 1;
    }
    state.history.push(state.index);
    state.result = correct ? 'correct' : 'wrong';
    return state;
  }

  function courseTurn(course, previous, action, value, lang) {
    if (course.compact) return compactTurn(course, previous, action, value, lang);
    if (!previous || action === 'restart') return startCourse(course);
    const state = JSON.parse(JSON.stringify(previous));
    state.history ??= state.used.slice();
    state.revealed ??= Object.fromEntries(state.used.filter(i => course.items[i].phase === 'practice' ||
      (state.finalFailed && course.items[i].phase === 'final')).map(i => [i, state.history.indexOf(i) + 1]));
    if (state.stage === 'final_review') {
      if (action === 'next') {
        for (const {index} of state.final) state.revealed[index] = state.history.length;
        state.final = [];
        nextPractice(course, state, null);
      }
      return state;
    }
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
      } else if (state.stage === 'final' && nextAssessment(course, state)) {
        return state;
      } else if (state.stage === 'final' && state.final.every(attempt => attempt.correct)) {
        Object.assign(state, {stage: 'mastered', index: -1});
      } else if (state.stage !== 'final' && !state.remediation?.length && state.skills.every(s => s.level >= 4)) {
        state.final = [];
        nextAssessment(course, state);
      } else if (state.stage === 'final') {
        const missed = state.final.filter(attempt => !attempt.correct);
        const affected = missed.map(attempt => course.items[attempt.index].skill);
        state.remediation = affected.includes(null) ? state.skills.map((_, i) => i) : affected;
        for (const i of state.remediation) state.skills[i].level = 3;
        Object.assign(state, {stage: 'final_review', index: -1, final: missed, finalFailed: true});
      } else {
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
    if (state.stage === 'practice' && state.remediation?.includes(item.skill) && item.tier === 'hard' &&
        correct && !state.attempts && spacedRecall(state, state.index)) {
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
    if (state.stage === 'final') state.final.push({index: state.index, correct: correct && spacedRecall(state, state.index)});
    state.history.push(state.index);
    if (state.stage === 'practice') state.revealed[state.index] = state.history.length;
    state.result = action === 'tell' ? 'told' : correct ? 'correct' : 'wrong';
    return state;
  }

  return {grounding, clean, rejectReason, courseItemReason, unsupportedNumbers, unsupportedStemNumbers, doses, unsupportedDoses, unsupportedClaims, unsupportedCaseEffects, reportedDistractors, validItem, validateSet, validateCourse,
    question, subskill, startCourse, courseQuestion, courseTurn, AI_NOTE, LIMITS, TIERS, COURSE_VERSION, PRACTICE_PER_SKILL, hasMixedTypes,
    citedExcerpts, validateCaseSet, CASE_SET_VERSION, CASES_PER_SET, MAX_CASE_EXCERPTS};
})();
if (typeof module !== 'undefined') module.exports = CaseQuiz;
