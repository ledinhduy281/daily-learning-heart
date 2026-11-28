const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {main} = require("../generate_quiz_sets.js");
const CaseQuiz = require("../case_quiz.js");
const ClinicalQuiz = require("../clinical_mcq.js");
const {course, lesson: template} = require("./fixtures/socratic_course.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-sets-"));
fs.mkdirSync(path.join(root, "data"));
const date = "2026-12-01", id = "ebm-2026-12-01-p2-focused";
const pmid = template.primary_source.pmid;
const excerpts = template.quiz_source_texts[pmid];
const caseQuote = course().items.find(q => q.type === "case").quote;
const ckdQuote = caseQuote + " There was no heterogeneity by CKD status.";
const lesson = {...template, id, date, quiz_source_texts: {...template.quiz_source_texts, [pmid]: [excerpts[0], caseQuote, excerpts[1], ckdQuote]}};
const nextDate = "2026-12-02", nextId = "ebm-2026-12-02-p2-focused";
const dataPath = path.join(root, "data", "briefings.js");
const setPath = path.join(root, "data", "quiz_sets.js");
const publishLessons = briefings => fs.writeFileSync(dataPath, "window.EBM_BRIEFINGS_DATA = " + JSON.stringify({briefings}) + ";");
publishLessons([lesson]);
const philosophy = fs.readFileSync(require.resolve("../docs/quiz_philosophy.md"), "utf8");
const reply = obj => ({ok: true, status: 200, headers: {get: () => null}, json: async () => ({choices: [{message: {content: JSON.stringify(obj)}}]})});
const requestBody = options => {
  const body = JSON.parse(options.body);
  assert.equal(body.response_format.type, "json_object");
  assert.ok(body.messages.some(m => /reply with a single JSON object\./i.test(m.content)));
  return body;
};

function fakeGroq(faults = [], roundOffset = 0, source = lesson) {
  const calls = [];
  let round = -1, questions, submitted, repaired = 0;
  const prefixes = ["A. ", "(B) ", "C) ", "D: "];
  return {calls, fetchImpl: async (url, options) => {
    const body = requestBody(options);
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer test-only-placeholder");
    const [system, user] = body.messages.map(m => m.content);
    const estimated = Math.ceil(Buffer.byteLength(options.body) / 3) + body.max_tokens;
    if (system.startsWith("Independently answer")) {
      assert.ok(!user.includes('"answer"'), "independent re-solve never sees the key");
      assert.match(system, /ONLY its cited excerpt/);
      assert.match(system, /the first must support the key finding in the correct option/);
      assert.match(system, /Cardiovascular events are not cardiovascular mortality/);
      assert.match(system, /exact clinical endpoint, population, effect direction, comparator, magnitude and time frame/);
      assert.match(system, /supported as written in BOTH languages/);
      assert.match(system, /Solve the questions before reading the proposed explanations/);
      assert.match(system, /every claim must be supported as written by that question’s cited excerpts/);
      assert.match(system, /Verify every claimed effect figure in both stems/);
      assert.match(system, /the same endpoint, threshold, comparator and population/);
      assert.match(system, /reject a subgroup figure applied to someone outside/);
      assert.match(system, /relative increase BY a percent as an absolute risk rising TO that percent/);
      assert.match(system, /List every defensible option/);
      const numbered = [...user.matchAll(/^Q(\d+): (.*)$/gm)];
      const slots = numbered.map(m => Number(m[1]));
      const batch = slots.map(n => submitted[n - 1]);
      for (const [i, q] of batch.entries()) {
        assert.ok(user.includes(`Vietnamese stem: ${q.stem_vi}`));
        assert.ok(q.options.every(o => user.includes(`EN: ${o.en} | VI: ${o.vi}`)));
        assert.ok(user.includes(`Q${slots[i]} explanations:\nEN: ${q.explanation_en}\nVI: ${q.explanation_vi}`));
      }
      assert.deepEqual(numbered.map(m => m[2]), batch.map(q => q.stem_en));
      assert.deepEqual([...user.matchAll(/^Cited excerpt: (.+)$/gm)].map(m => m[1]),
        batch.map(q => [].concat(q.excerpt).map(n => `[${n}]`).join(", ")));
      const cited = [...new Set(batch.flatMap(q => q.excerpt))];
      assert.deepEqual(user.split("\n\nQUESTIONS:\n")[0],
        "EXCERPTS:\n" + cited.map(n => `[${n}] ${source.quiz_source_texts[pmid][n - 1]}`).join("\n"));
      assert.ok(!user.match(/^[A-D]\. (?:\([A-D]\)|[A-D][.)])/m), "the solver sees only one option letter");
      calls.push({mode: "solve", slots, estimated});
      return reply({
        answers: batch.map((q, i) => faults[round] === "repair" && repaired === 1 && slots[i] === 1 ? ["D"] :
          faults[round] === "multi-key" && !repaired ? [[q.answer, "D"], [], q.answer][slots[i] - 1] : [q.answer]),
        explanations: batch.map((q, i) => faults[round] === "explanations" && !repaired
          ? [{en: false, vi: true}, {en: true, vi: false}, {en: true}][slots[i] - 1] :
          {en: true, vi: true, primary: faults[round] !== "primary-verdict" || repaired > 0}),
      });
    }
    assert.match(system, /Set "excerpt" to the 1-based integer index/);
    assert.match(system, /put the excerpt that supports the key finding in the correct option first/);
    assert.match(system, /Do not include a quote field/);
    assert.match(system, /Every number in a stem, option, or explanation must appear exactly as written in a cited excerpt/);
    assert.match(system, /Never use the keyed estimate’s confidence limits or other figures from the excerpt reporting the keyed estimate as distractors/);
    assert.match(system, /Do not calculate differences, convert HR or RR to percentages \(e\.g\. 30% from HR 0\.70\), or round/);
    assert.match(system, /in option text or explanations \(never say "Answer A"\)/);
    assert.match(system, /exactly 4 options\. Do not prefix or mention option letters in option text/);
    assert.match(system, /All four options must be distinct in each language/);
    assert.match(system, /If any stem, option, or explanation includes "40 mg once daily", cite \[1\]/);
    assert.match(system, /\[2\] gives "hazard ratio 0\.70"\. Use the reported estimate, not a percentage derived from it/);
    assert.match(system, /Do not offer its CI bounds 0\.61 or 0\.82 as distractors/);
    assert.match(system, /"0\.70" and "reported hazard ratio 0\.70" are the same answer, not distinct options/);
    const repair = user.match(/^REPAIR SLOTS: (.*)$/m)?.[1];
    assert.equal(system.includes(philosophy), !repair, "only initial case generation includes the full philosophy");
    if (!repair) {
      repaired = 0;
      submitted = [];
      questions = course(++round + 1 + roundOffset).items.filter(i => i.type === "case").slice(0, 3);
      assert.match(system, /exactly 3 bilingual clinical application case questions \(no theory questions\)/);
    } else repaired++;
    const requested = repair && JSON.parse(repair);
    const slots = requested ? requested.map(p => p.slot) : [1, 2, 3];
    calls.push({mode: repair ? "repair" : "generate", slots, estimated});
    assert.equal(body.max_tokens, slots.length * 850);
    const prior = JSON.parse(user.split("PRIOR STEMS (do not repeat): ").at(-1));
    assert.ok(prior.length <= 24 && prior.every(s => s.length <= 100));
    const result = slots.map(n => {
      const q = structuredClone(questions[n - 1]);
      q.excerpt = lesson.quiz_source_texts[pmid].indexOf(q.quote) + 1;
      q.options = q.options.map((o, j) => ({vi: prefixes[j] + o.vi, en: prefixes[j] + o.en}));
      delete q.quote;
      if (faults[round] === "theory") q.type = "theory";
      if (faults[round] === "repair" && !repaired) {
        if (n === 1) {
          q.explanation_en = "The abstract reports a hazard ratio of 9.98.";
          q.options[0] = {en: "Fewer primary cardiovascular events. ".repeat(7) + "End of the rejected option.", vi: q.options[0].vi};
        }
        if (n === 2) q.options[1] = q.options[0];
      }
      if (faults[round] === "explanations" && !repaired && n < 3) {
        q.excerpt = excerpts.length + 1;
        if (n === 1) q.explanation_en = "Only patients with CKD benefited.";
        else q.explanation_vi = "Lợi ích giới hạn ở bệnh nhân có bệnh thận mạn.";
        assert.equal(CaseQuiz.rejectReason({...q, quote: ckdQuote}, CaseQuiz.grounding(lesson)), "",
          "the lexical check alone cannot verify the subgroup effect");
      }
      submitted[n - 1] = {...q, options: questions[n - 1].options};
      if (faults[round] === "indices") {
        if (repaired) q.excerpt = n === 1 ? "2" : "[2]";
        else if (n === 1) q.excerpt = "2.5";
        else if (n === 2) Object.assign(q, {excerpt: "2", quote: excerpts[1]});
        else q.excerpt = "E2";
      }
      if (faults[round] === "count" && repaired) {
        q.excerpt = ["[2]", "E1"];
        submitted[n - 1].excerpt = [2, 1];
      }
      if (["answer-first", "primary-verdict"].includes(faults[round]) && n === 1) {
        q.excerpt = [1, 2];
        q.options[0] = {en: "0.70", vi: "0.70"};
        Object.assign(submitted[n - 1], {excerpt: [2, 1], options: [q.options[0], ...questions[n - 1].options.slice(1)]});
      }
      if (["completion", "partial", "ambiguous"].includes(faults[round]) && !repaired) {
        if (n === 1) {
          q.stem_en = "An older adult who meets STAREE eligibility asks what the study reported for atorvastatin 40 mg daily versus placebo.";
          q.stem_vi = "Một người cao tuổi đủ tiêu chí STAREE hỏi kết quả của atorvastatin 40 mg/ngày so với giả dược.";
          q.explanation_en = "The hazard ratio for primary cardiovascular events was 0.70 with atorvastatin 40 mg daily versus placebo.";
          q.explanation_vi = "Tỉ số nguy cơ của biến cố tim mạch chính là 0,70 với atorvastatin 40 mg/ngày so với giả dược.";
          if (faults[round] === "completion") {
            q.explanation_en += " The finding was in community-dwelling adults.";
            q.explanation_vi += " Kết quả này ghi nhận ở người sống tại cộng đồng.";
            assert.deepEqual(CaseQuiz.unsupportedClaims({...q, quote: caseQuote}), ["community_dwelling"]);
          }
          if (faults[round] === "partial") q.stem_en += " She asks specifically about the 40 mg strength.";
          Object.assign(submitted[n - 1], {
            stem_en: q.stem_en, stem_vi: q.stem_vi, explanation_en: q.explanation_en, explanation_vi: q.explanation_vi,
            excerpt: faults[round] === "ambiguous" ? 2 : [2, 1],
          });
        }
        if (n === 2) q.explanation_en = "The study reported a 30% reduction in primary cardiovascular events.";
      }
      if (["count-completion", "effects-completion"].includes(faults[round]) && n === 1) {
        q.explanation_en = "The trial included 9971 participants and reported fewer primary cardiovascular events with atorvastatin.";
        if (faults[round] === "effects-completion") {
          q.stem_en += " The trial included 9971 participants.";
          assert.equal(CaseQuiz.rejectReason({...q, quote: caseQuote}, {pmid, excerpts: [caseQuote]}), "effects");
        }
        Object.assign(submitted[n - 1], {stem_en: q.stem_en, explanation_en: q.explanation_en, excerpt: [2, 3]});
      }
      if (faults[round] === "claims-completion" && n === 1) {
        q.explanation_en += " The finding was in community-dwelling adults.";
        assert.equal(CaseQuiz.rejectReason({...q, quote: caseQuote}, {pmid, excerpts: [caseQuote]}), "claims");
        Object.assign(submitted[n - 1], {explanation_en: q.explanation_en, excerpt: [2, 1]});
      }
      if (["option-dose-completion", "explanation-dose-completion"].includes(faults[round]) && n === 1) {
        if (faults[round] === "option-dose-completion") {
          q.options = q.options.map((option, i) => i !== 1 ? option : {
            en: "More events with atorvastatin 40 mg once daily",
            vi: "Nhiều biến cố hơn với atorvastatin 40 mg/ngày",
          });
        } else {
          q.explanation_en += " The atorvastatin regimen was 40 mg once daily.";
          q.explanation_vi += " Phác đồ atorvastatin là 40 mg/ngày.";
        }
        assert.equal(CaseQuiz.rejectReason({...q, quote: caseQuote}, {pmid, excerpts: [caseQuote]}),
          faults[round] === "option-dose-completion" ? "dose" : "numbers");
        const expected = submitted[n - 1];
        if (faults[round] === "option-dose-completion") expected.options = expected.options.map((option, i) => i === 1 ? q.options[i] : option);
        Object.assign(expected, {explanation_en: q.explanation_en, explanation_vi: q.explanation_vi, excerpt: [2, 1]});
      }
      if (faults[round] === "log-explanation" && n === 1 && !repaired) {
        q.explanation_en = "The source reports fewer primary cardiovascular events. ".repeat(7) + "A final unsupported figure is 30%.";
      }
      return q;
    });
    if (faults[round] === "count") {
      if (!repaired) return reply({questions: result.slice(0, 2)});
      assert.deepEqual(requested, [{slot: 3, reason: "count"}]);
    }
    if (faults[round] === "oversized" && !repaired) {
      return reply({questions: [{...result[0], type: "theory"}, result[0], result[0], result[1], result[2]]});
    }
    return reply({questions: result});
  }};
}
const env = {GROQ_API_KEY: "test-only-placeholder"};
const read = () => {
  const s = {window: {}};
  vm.runInNewContext(fs.readFileSync(setPath, "utf8"), s);
  return s.window.EBM_QUIZ_SETS.sets;
};
const quiet = () => {};

(async () => {
  assert.equal(await main({root, env: {}, date, log: quiet}), 0, "no key: nothing to do");
  assert.ok(!fs.existsSync(setPath));

  const arniScope = {window: {}};
  vm.runInNewContext(fs.readFileSync(require.resolve("../data/briefings.js"), "utf8"), arniScope);
  const arni = {...arniScope.window.EBM_BRIEFINGS_DATA.focused_lessons["5"], date, id};
  assert.equal(arni.primary_source.pmid, "43012096");
  const arniExcerpts = arni.quiz_source_texts["43012096"];
  assert.match(arniExcerpts[2], /hyperkalaemia >5\.5\s+mmol\/L/);
  assert.deepEqual(Array.from(arniExcerpts.flatMap(CaseQuiz.doses)), [], "the ARNI source does not cite a drug dose");
  const arniCase = {...course().items.find(q => q.type === "case"), quote: arniExcerpts[1],
    stem_en: "A patient with heart failure has potassium of 4.7 mEq/L and creatinine of 1.4 mg/dL.",
    stem_vi: "Bệnh nhân này bị suy tim và có kali 4,7 mmol/L.",
  };
  assert.deepEqual(CaseQuiz.unsupportedDoses(arniCase), []);
  assert.deepEqual(CaseQuiz.unsupportedStemNumbers(arniCase), []);
  for (const [lang, stem] of [
    ["en", "A patient has heart failure. In the trial, median potassium was 4.5 mmol/L."],
    ["en", "A patient has heart failure. Potassium 4.5 mmol/L was the group baseline."],
    ["vi", "Bệnh nhân bị suy tim. Kali 4,5 mmol/L là trung vị của nhóm thử nghiệm."],
  ]) {
    assert.deepEqual(CaseQuiz.unsupportedStemNumbers({...arniCase, ["stem_" + lang]: stem}), ["4.5"],
      "a study lab result needs citation even after a patient vignette");
  }
  assert.deepEqual(CaseQuiz.unsupportedStemNumbers({...arniCase,
    stem_en: "A patient has heart failure. Her potassium is 4.7 mmol/L.",
  }), [], "the patient's own lab result remains exempt");
  for (const [lang, stem] of [
    ["en", "For this patient, the trial requires K+ < 5.0 mEq/L."],
    ["en", "A patient's potassium must be under 5.0 mmol/L."],
    ["en", "A patient's potassium eligibility cutoff is 5.0 mg/dL."],
    ["vi", "Bệnh nhân này chỉ đủ điều kiện nếu kali dưới 5,0 mmol/L."],
    ["en", "The trial used potassium of 5.0 mmol/L to define hyperkalaemia."],
  ]) {
    const cutoff = {...arniCase, ["stem_" + lang]: stem};
    assert.deepEqual(CaseQuiz.unsupportedDoses(cutoff), [], "a lab threshold is not a dose");
    assert.deepEqual(CaseQuiz.unsupportedStemNumbers(cutoff), ["5"], "an uncited lab cutoff cannot be a vignette measurement");
  }
  assert.deepEqual(CaseQuiz.unsupportedStemNumbers({...arniCase, quote: arniExcerpts[2],
    stem_en: "This patient asks about the reported hyperkalaemia threshold of >5.5 mmol/L.",
  }), [], "a cited lab threshold passes");
  publishLessons([arni]);
  let arniPrompt, virtualTime = 0;
  assert.equal(await main({root, env, date, log: quiet, budgetMs: 1, now: () => virtualTime,
    fetchImpl: async (_, request) => {
      arniPrompt = JSON.parse(request.body).messages;
      virtualTime++;
      return reply({});
    },
  }), 0);
  assert.match(arniPrompt[1].content, /hyperkalaemia >5\.5\s+mmol\/L/);
  assert.doesNotMatch(arniPrompt[0].content, /If any stem, option, or explanation includes|regimen excerpt second/);
  assert.match(arniPrompt[0].content, /Fictional patient lab values in a stem do not need a regimen citation, but study thresholds must be supported/);
  const pci = {...arniScope.window.EBM_BRIEFINGS_DATA.briefings.find(b => b.id === "ebm-2026-11-28-p3-focused"), date, id};
  assert.equal(pci.primary_source.pmid, "42747372");
  const pciQuote = pci.quiz_source_texts["42747372"][1];
  const pciItem = {
    type: "case", pmid: "42747372", excerpt: 2, answer: "A",
    stem_en: "A patient undergoing PCI asks how imaging guidance compares with angiography alone for target lesion failure.",
    stem_vi: "Một bệnh nhân chuẩn bị PCI hỏi hướng dẫn bằng hình ảnh so với chụp mạch đơn thuần ảnh hưởng thế nào đến thất bại tổn thương đích.",
    explanation_en: "The meta-analysis found a lower relative risk of target lesion failure with imaging guidance.",
    explanation_vi: "Phân tích gộp ghi nhận nguy cơ tương đối của thất bại tổn thương đích thấp hơn khi có hướng dẫn bằng hình ảnh.",
    options: [
      {en: "RR 0.72", vi: "RR 0,72"}, {en: "RR 0.73", vi: "RR 0,73"},
      {en: "RR 0.85", vi: "RR 0,85"}, {en: "The risk was unchanged", vi: "Nguy cơ không đổi"},
    ],
  };
  const pciGround = CaseQuiz.grounding(pci);
  assert.equal(CaseQuiz.rejectReason({...pciItem, quote: pciQuote}, pciGround), "ambiguous");
  const qualitative = {...pciItem, options: [
    pciItem.options[0], pciItem.options[3],
    {en: "The risk was higher", vi: "Nguy cơ cao hơn"},
    {en: "The outcome was not measured", vi: "Kết cục không được đo lường"},
  ]};
  assert.equal(CaseQuiz.rejectReason({...qualitative, quote: pciQuote}, pciGround), "");
  const pciCase = {...qualitative, quote: pciQuote};
  const verdict = q => CaseQuiz.rejectReason(q, pciGround);
  const vessel = {
    ...pciCase,
    stem_en: "A 72-year-old woman with diabetes is scheduled for PCI. What effect did imaging guidance have on target vessel revascularization compared with angiography guidance?",
    stem_vi: "Bệnh nhân nữ 72 tuổi có đái tháo đường sẽ được PCI. Hướng dẫn bằng hình ảnh nội mạch ảnh hưởng thế nào đến tái thông mạch đích so với hướng dẫn bằng chụp mạch?",
    explanation_en: "Imaging-guided PCI reduced target vessel revascularization (RR: 0.69) compared with angiography-guided PCI.",
    explanation_vi: "PCI có hướng dẫn bằng hình ảnh nội mạch giảm tái thông mạch đích (RR 0,69) so với PCI hướng dẫn bằng chụp mạch.",
    options: [{en: "Reduces target vessel revascularization", vi: "Giảm tái thông mạch đích"}, ...qualitative.options.slice(1)],
  };
  assert.equal(verdict(vessel), "", "the exact endpoint, estimate, and comparator pass");
  assert.equal(verdict({...vessel,
    stem_en: vessel.stem_en.replace("target vessel", "target lesion"),
    explanation_en: vessel.explanation_en.replace("target vessel", "target lesion"),
    options: [{...vessel.options[0], en: "Reduces target lesion revascularization"}, ...vessel.options.slice(1)],
  }), "endpoint", "the live case used target lesion revascularization for the target vessel result");
  assert.equal(verdict({...vessel, stem_vi: vessel.stem_vi.replace("tái thông mạch đích", "tái thông tổn thương đích")}), "endpoint");
  assert.equal(verdict({...pciCase, options: [{en: "Target lesion failure", vi: "Tái can thiệp mạch mục tiêu"}, ...pciCase.options.slice(1)]}),
    "endpoint", "the live key translated target lesion failure as target vessel revascularization");
  assert.equal(verdict({...vessel, explanation_en: vessel.explanation_en.replace("0.69", "0.72"),
    explanation_vi: vessel.explanation_vi.replace("0,69", "0,72")}), "endpoint",
  "a figure appearing in the same quote must still belong to the named endpoint");
  assert.equal(verdict({...vessel, explanation_vi: vessel.explanation_vi.replace("chụp mạch", "nhiễu ảnh")}), "comparator");
  assert.equal(verdict({...vessel, stem_vi: vessel.stem_vi.replace("Hướng dẫn bằng hình ảnh nội mạch", "Chỉ định nội mạch")}), "comparator");
  assert.equal(verdict({...vessel, quote: pci.quiz_source_texts["42747372"][0]}), "endpoint", "a population-only citation does not support the named endpoint");

  const cardiacMortality = {
    ...pciCase,
    stem_en: "A patient with a history of myocardial infarction asks how imaging-guided PCI affects cardiac mortality compared with angiography-guided PCI.",
    stem_vi: "Một bệnh nhân có tiền sử nhồi máu cơ tim hỏi PCI hướng dẫn bằng hình ảnh nội mạch ảnh hưởng thế nào đến tử vong tim so với PCI hướng dẫn bằng chụp mạch.",
    explanation_en: "Imaging-guided PCI reduced cardiac mortality (RR 0.73) compared with angiography-guided PCI.",
    explanation_vi: "PCI hướng dẫn bằng hình ảnh nội mạch giảm tử vong tim (RR 0,73) so với PCI hướng dẫn bằng chụp mạch.",
    options: [{en: "Reduces cardiac mortality", vi: "Giảm tử vong tim"}, ...pciCase.options.slice(1)],
  };
  assert.equal(verdict(cardiacMortality), "", "a prior MI is vignette background, even in the same sentence as the question");
  assert.equal(verdict({...cardiacMortality,
    stem_en: cardiacMortality.stem_en.replace("affects cardiac mortality", "affects myocardial infarction"),
    stem_vi: cardiacMortality.stem_vi.replace("đến tử vong tim", "đến nhồi máu cơ tim"),
  }), "endpoint", "MI in the question still has to match the keyed result");
  assert.equal(verdict({...cardiacMortality,
    explanation_en: "The meta-analysis reported fewer cardiac deaths with imaging-guided PCI (RR 0.73) than with angiography-guided PCI.",
  }), "", "cardiac deaths and cardiac mortality identify the same cited endpoint");
  assert.equal(verdict({...vessel,
    options: [{...vessel.options[0], en: "Fewer target vessel revascularizations"}, ...vessel.options.slice(1)],
  }), "", "plural revascularizations match the singular endpoint in the excerpt");
  assert.equal(verdict({...vessel,
    options: [{...vessel.options[0], en: "Fewer target lesion revascularizations"}, ...vessel.options.slice(1)],
  }), "endpoint", "pluralizing an unsupported endpoint does not make it equivalent");
  const infarctions = {
    ...cardiacMortality,
    stem_en: cardiacMortality.stem_en.replace("affects cardiac mortality", "affects myocardial infarctions"),
    stem_vi: cardiacMortality.stem_vi.replace("đến tử vong tim", "đến nhồi máu cơ tim"),
    explanation_en: cardiacMortality.explanation_en.replace("cardiac mortality (RR 0.73)", "myocardial infarctions (RR 0.86)"),
    explanation_vi: cardiacMortality.explanation_vi.replace("tử vong tim (RR 0,73)", "nhồi máu cơ tim (RR 0,86)"),
    options: [{en: "Fewer myocardial infarctions", vi: "Giảm nhồi máu cơ tim"}, ...pciCase.options.slice(1)],
  };
  assert.equal(verdict(infarctions), "", "plural infarctions in the stem, key and explanation match cited myocardial infarction");
  assert.equal(verdict({...cardiacMortality,
    stem_en: "A patient asks how imaging-guided PCI affects recurrence of prior MI compared with angiography-guided PCI.",
    stem_vi: "Một bệnh nhân hỏi PCI hướng dẫn bằng hình ảnh nội mạch ảnh hưởng thế nào đến tái phát nhồi máu cơ tim từng mắc so với PCI hướng dẫn bằng chụp mạch.",
  }), "endpoint", "a recurrence question still names the endpoint");
  assert.equal(verdict({...infarctions,
    stem_en: infarctions.stem_en.replace("affects myocardial infarctions", "affects recurrence of a prior MI"),
    stem_vi: infarctions.stem_vi.replace("đến nhồi máu cơ tim", "đến tái phát nhồi máu cơ tim"),
  }), "effects", "the pooled MI result does not establish the effect on recurrence");
  assert.equal(verdict({...infarctions,
    stem_en: infarctions.stem_en.replace("compared with", "specifically in prior MI patients compared with"),
  }), "effects", "the pooled MI estimate does not support a prior-MI subgroup");
  assert.equal(verdict({...infarctions,
    stem_vi: infarctions.stem_vi.replace("so với", "ở những bệnh nhân có tiền sử nhồi máu cơ tim so với"),
  }), "effects", "the same unsupported subgroup must also fail in Vietnamese");
  assert.equal(verdict({...cardiacMortality,
    stem_en: "A patient with prior MI, and stroke as the outcome, asks how imaging-guided PCI compares with angiography-guided PCI.",
    stem_vi: "Một bệnh nhân có tiền sử nhồi máu cơ tim, với đột quỵ là kết cục, hỏi PCI hướng dẫn bằng hình ảnh nội mạch so với PCI hướng dẫn bằng chụp mạch.",
  }), "endpoint", "a history filter cannot cross the comma into the outcome");

  const lad = {
    ...pciCase,
    stem_en: "A 70-year-old man with stable angina undergoes PCI for a de novo lesion in the left anterior descending artery. According to the meta-analysis, what relative risk of target lesion failure does intracoronary imaging guidance provide compared with angiography guidance?",
    stem_vi: "Một bệnh nhân nam 70 tuổi bị đau thắt ngực ổn định được PCI cho tổn thương mới ở động mạch liên thất trước. Theo phân tích gộp, nguy cơ tương đối của thất bại tổn thương đích khi hướng dẫn bằng hình ảnh nội mạch so với chụp mạch là bao nhiêu?",
    explanation_en: "The meta-analysis reported a lower risk of target lesion failure (RR 0.72) with intracoronary imaging compared with angiography guidance.",
    explanation_vi: "Phân tích gộp ghi nhận nguy cơ thất bại tổn thương đích thấp hơn (RR 0,72) khi hướng dẫn bằng hình ảnh nội mạch so với chụp mạch.",
  };
  assert.equal(verdict(lad), "", "a fictional LAD vignette can ask for the pooled estimate");
  for (const [lang, phrase] of [["en", "for patients like him"], ["en", "for patients like her"],
    ["en", "in a patient like this"], ["vi", "đối với bệnh nhân như anh ấy"],
    ["vi", "đối với bệnh nhân như ông ấy"], ["vi", "ở bệnh nhân này"]]) {
    const stem = "stem_" + lang, explanation = "explanation_" + lang;
    assert.equal(verdict({...lad, [stem]: lad[stem].replace("?", " " + phrase + "?")}), "projection", phrase);
    assert.equal(verdict({...lad, [explanation]: lad[explanation].replace(/\.$/, " " + phrase + ".")}), "projection", phrase);
    assert.equal(verdict({...lad, options: [{...lad.options[0], [lang]: lad.options[0][lang] + " " + phrase}, ...lad.options.slice(1)]}),
      "projection", phrase);
  }
  const limitationEn = " The pooled result is not an individual estimate for patients like him.";
  const limitationVi = " Từ kết quả gộp không thể ước tính nguy cơ ở bệnh nhân này.";
  assert.equal(verdict({...lad, explanation_en: lad.explanation_en + limitationEn, explanation_vi: lad.explanation_vi + limitationVi}),
    "", "a pooled result can be followed by an explicit personalized-risk caveat");
  assert.equal(verdict({...lad,
    explanation_en: lad.explanation_en + limitationEn.replace(".", ", but the RR for patients like him is 0.72."),
  }), "projection", "a caveat does not excuse a subsequent individualized claim");
  for (const [lang, claim] of [
    ["en", " Although this is not an individual estimate, for patients like him the RR is 0.72."],
    ["vi", " Mặc dù đây không phải là ước tính cá nhân, ở bệnh nhân này RR là 0,72."],
  ]) {
    const field = "explanation_" + lang;
    assert.equal(verdict({...lad, [field]: lad[field] + claim}), "projection",
      "a concessive clause does not exempt the personalized estimate in the main clause");
  }

  const withImaging = {
    ...cardiacMortality,
    stem_en: "A 72-year-old female with a history of cardiovascular disease will undergo PCI with or without intracoronary imaging guidance. What relative risk for cardiac mortality did the study report?",
    stem_vi: "Bệnh nhân nữ 72 tuổi, tiền sử bệnh tim mạch, sẽ được PCI có hoặc không có hướng dẫn bằng hình ảnh nội mạch. Nghiên cứu báo cáo RR cho tử vong tim là bao nhiêu?",
    options: [{en: "RR 0.73", vi: "RR 0,73"}, ...pciCase.options.slice(1)],
  };
  assert.equal(verdict(withImaging), "comparator", "the live case substituted with-or-without imaging for angiography");
  for (const [field, search, replacement] of [
    ["stem_en", "angiography-guided PCI", "PCI with no imaging guidance"],
    ["stem_vi", "PCI hướng dẫn bằng chụp mạch", "PCI không có hướng dẫn bằng hình ảnh nội mạch"],
    ["explanation_en", "angiography-guided PCI", "PCI without imaging"],
  ]) {
    assert.equal(verdict({...cardiacMortality, [field]: cardiacMortality[field].replace(search, replacement)}), "comparator");
  }
  assert.equal(verdict({...cardiacMortality,
    stem_en: cardiacMortality.stem_en.replace("angiography-guided PCI", "angiography-guided PCI without imaging"),
    stem_vi: cardiacMortality.stem_vi.replace("PCI hướng dẫn bằng chụp mạch", "PCI hướng dẫn bằng chụp mạch không dùng hình ảnh nội mạch"),
  }), "", "explicit angiography guidance may clarify that no intracoronary imaging was used");
  for (const [field, search, replacement] of [
    ["stem_vi", "tử vong tim", "tử vong tim mạch"],
    ["explanation_vi", "tử vong tim", "tử vong tim mạch"],
    ["explanation_en", "cardiac mortality", "cardiovascular mortality"],
  ]) {
    assert.equal(verdict({...cardiacMortality, [field]: cardiacMortality[field].replace(search, replacement)}), "endpoint");
  }
  assert.equal(verdict({...cardiacMortality, options: [{en: "Reduces cardiac mortality", vi: "Giảm tử vong tim mạch"}, ...pciCase.options.slice(1)]}),
    "endpoint", "cardiovascular mortality is not the Vietnamese equivalent of cardiac mortality");
  const cardiovascularMortality = {
    ...cardiacMortality,
    stem_en: cardiacMortality.stem_en.replace("cardiac mortality", "cardiovascular mortality"),
    explanation_en: cardiacMortality.explanation_en.replace("cardiac mortality", "cardiovascular mortality"),
    stem_vi: cardiacMortality.stem_vi.replace("tử vong tim", "tử vong tim mạch"),
    explanation_vi: cardiacMortality.explanation_vi.replace("tử vong tim", "tử vong tim mạch"),
    options: [{en: "Reduces cardiovascular mortality", vi: "Giảm tử vong tim mạch"}, ...pciCase.options.slice(1)],
  };
  assert.equal(verdict(cardiovascularMortality), "endpoint", "bilingual agreement does not ground a different endpoint");
  for (const term of ["mortality from cardiovascular causes", "death from cardiovascular causes"]) {
    const item = {...cardiacMortality,
      stem_en: cardiacMortality.stem_en.replace("cardiac mortality", term),
      stem_vi: cardiacMortality.stem_vi.replace("tử vong tim", "tử vong do nguyên nhân tim mạch"),
    };
    assert.equal(verdict(item), "endpoint", term + " is not cardiac mortality");
  }
  const cardiovascularQuote = pciQuote.replace("cardiac mortality", "cardiovascular mortality");
  assert.equal(CaseQuiz.rejectReason({...cardiovascularMortality, quote: cardiovascularQuote}, {...pciGround, excerpts: [cardiovascularQuote]}),
    "", "cardiovascular mortality passes when the cited excerpt actually names it");

  const mortality = {...pciCase,
    stem_en: "A 66-year-old patient is scheduled for PCI. What is the relative risk for all-cause mortality with imaging guidance compared with angiography?",
    stem_vi: "Bệnh nhân 66 tuổi được lên kế hoạch PCI. Nguy cơ tương đối về tử vong toàn nguyên khi hướng dẫn bằng hình ảnh nội mạch so với chụp mạch là bao nhiêu?",
    explanation_en: "The meta-analysis reports a relative risk of 0.82 for all-cause mortality with imaging guidance.",
    explanation_vi: "Phân tích gộp báo cáo nguy cơ tương đối 0,82 cho tử vong toàn nguyên khi hướng dẫn bằng hình ảnh nội mạch.",
    options: [
      {en: "RR 0.82", vi: "RR 0.82"}, {en: "RR 0.95", vi: "RR 0.95"},
      {en: "RR 1.00", vi: "RR 1.00"}, {en: "No difference", vi: "Không có sự khác biệt"},
    ],
  };
  assert.equal(verdict(mortality), "duplicate-options", "the live case presented the null effect twice");
  assert.equal(verdict({...mortality, options: [...mortality.options.slice(0, 3),
    {en: "No significant difference", vi: "Không khác biệt có ý nghĩa thống kê"}]}), "",
  "no statistical significance is not identical to a point estimate of exactly one");
  for (const duplicate of [{en: "Null", vi: "No data"}, {en: "No data", vi: "Không khác biệt"}]) {
    assert.equal(verdict({...mortality, options: [...mortality.options.slice(0, 2),
      {en: "HR 1.0", vi: "HR = 1,0 (không thay đổi)"}, duplicate]}), "duplicate-options",
    "a semantic duplicate in only one language still rejects the case");
  }
  publishLessons([pci]);
  const pciLogs = [];
  let pciCalls = 0;
  virtualTime = 0;
  assert.equal(await main({root, env, date, log: m => pciLogs.push(m), budgetMs: 1, now: () => virtualTime,
    fetchImpl: async (_, request) => {
      const [system] = requestBody(request).messages;
      assert.match(system.content, /root JSON object must have exactly one key, "questions"/);
      assert.match(system.content, /Do not offer its CI bounds 0\.61 or 0\.85 as distractors/);
      assert.match(system.content, /Do not use another endpoint’s effect size/);
      assert.match(system.content, /target lesion failure .*target lesion revascularization .*target vessel revascularization/);
      assert.match(system.content, /Translate angiography guidance as hướng dẫn bằng chụp mạch/);
      assert.match(system.content, /Do not offer both RR\/HR = 1\.00 and “no difference”/);
      if (++pciCalls === 1) return reply({questions: [pciItem]});
      virtualTime++;
      return reply({items: [pciItem]});
    },
  }), 0);
  assert.match(pciLogs.join("\n"), /ambiguous;.*"option":2,"figures":\["0\.73"\]/);
  assert.match(pciLogs.join("\n"), /ambiguous;.*"option":3,"figures":\["0\.85"\]/);
  assert.match(pciLogs.join("\n"), /got no questions array \(root=object; keys=\["items"\]\)/);
  publishLessons([lesson]);
  console.log("ARNI prompt: potassium threshold is not a regimen; fictional lab concentrations need no regimen citation: OK");

  const oversized = fakeGroq(["oversized"], 900);
  const oversizedLogs = [];
  assert.equal(await main({root, env, date, fetchImpl: oversized.fetchImpl, log: m => oversizedLogs.push(m)}), 3);
  assert.deepEqual(oversized.calls.slice(0, 2).map(({mode, slots}) => [mode, ...slots]), [
    ["generate", 1, 2, 3], ["solve", 1, 2, 3],
  ], "salvage three valid items from five without sending a repair");
  assert.match(oversizedLogs.join("\n"), /expected 3, got 5/);
  assert.match(oversizedLogs.join("\n"), /Rejected case item 1: shape/);
  assert.match(oversizedLogs.join("\n"), /Rejected case item 2: duplicate/);
  fs.unlinkSync(setPath);

  const original = course(901).items.filter(q => q.type === "case").slice(0, 3)
    .map(({quote, ...q}) => ({...q, excerpt: lesson.quiz_source_texts[pmid].indexOf(quote) + 1}));
  const spare = {...original[0], stem_en: original[0].stem_en + " Consider the same trial comparison.",
    stem_vi: original[0].stem_vi + " Xét cùng phép so sánh trong thử nghiệm."};
  const lastSpare = {...original[0], stem_en: original[0].stem_en + " Consider the comparison again.",
    stem_vi: original[0].stem_vi + " Xem lại phép so sánh này."};
  const finalRepairCalls = [];
  const finalRepairLogs = [];
  let generation = 0;
  virtualTime = 0;
  assert.equal(await main({root, env, date, log: m => finalRepairLogs.push(m), budgetMs: 1, now: () => virtualTime,
    fetchImpl: async (_, request) => {
      const [system, user] = requestBody(request).messages.map(m => m.content);
      if (!system.startsWith("Independently answer")) {
        finalRepairCalls.push("generation");
        const invalid = {...original[0], type: "theory"};
        return reply({questions: [[], [invalid, ...original.slice(1)], [invalid], [original[0], spare, lastSpare]][++generation]});
      }
      const stems = [...user.matchAll(/^Q\d+: (.*)$/gm)].map(([, stem]) => stem);
      finalRepairCalls.push(stems);
      if (stems.includes(spare.stem_en)) return reply({answers: []});
      if (stems.includes(lastSpare.stem_en)) virtualTime++;
      return reply({answers: stems.map(stem => stem === original[0].stem_en ? [] : ["A"]),
        explanations: stems.map(() => ({en: true, vi: true, primary: true}))});
    },
  }), 1, "verifier rejection and a malformed spare verdict on the final repair do not discard verified items or the remaining spare");
  assert.deepEqual(finalRepairCalls, ["generation", original.slice(1).map(q => q.stem_en),
    "generation", "generation", [original[0].stem_en], [spare.stem_en], [lastSpare.stem_en]]);
  assert.match(finalRepairLogs.join("\n"), /resolve;.*"expectedCount":1,"answerCount":0/);
  assert.deepEqual(Array.from(read()[id][0].items, q => q.stem_en),
    [lastSpare.stem_en, original[1].stem_en, original[2].stem_en]);
  fs.unlinkSync(setPath);

  const g = fakeGroq(["repair", "indices", "count"]);
  const logs = [];
  assert.equal(await main({root, env, date, fetchImpl: g.fetchImpl, log: m => logs.push(m)}), 3);
  const sets = read()[id];
  assert.equal(sets.length, 3);
  for (const set of sets) {
    assert.equal(set.items.length, 3);
    assert.ok(set.items.every(q => q.type === "case"));
    assert.ok(CaseQuiz.validateCaseSet(lesson, set));
    assert.ok(!CaseQuiz.validateCaseSet(lesson, {...set, items: set.items.slice(1)}));
    assert.ok(!CaseQuiz.validateCaseSet(lesson, {...set, items: set.items.map(q => ({...q, type: "theory"}))}));
    assert.ok(set.items.every(q => CaseQuiz.citedExcerpts(q).includes(caseQuote)), "the cited index yields the exact source text");
  }
  assert.deepEqual(JSON.parse(JSON.stringify(sets[2].items[2].quotes)), [caseQuote, excerpts[0]]);
  assert.ok(!Object.hasOwn(sets[2].items[2], "quote"), "a dual citation stores both exact excerpts");
  assert.ok(sets[0].items.every(q => q.quote === caseQuote), "the single-excerpt artifact shape is unchanged");
  assert.ok(!fs.readFileSync(setPath, "utf8").includes(env.GROQ_API_KEY));
  assert.deepEqual(g.calls.map(({mode, slots}) => [mode, ...slots]), [
    ["generate", 1, 2, 3], ["solve", 3], ["repair", 1, 2], ["solve", 1, 2], ["repair", 1], ["solve", 1],
    ["generate", 1, 2, 3], ["solve", 3], ["repair", 1, 2], ["solve", 1, 2],
    ["generate", 1, 2, 3], ["solve", 1, 2], ["repair", 3], ["solve", 3],
  ]);
  assert.ok(logs.some(m => /Rejected case item 1: numbers; stem=.+; value=\["9\.98"\]/.test(m)));
  const numericRejection = logs.find(m => m.startsWith("Rejected case item 1: numbers;"));
  const evidence = JSON.parse(numericRejection.split("; evidence=")[1]);
  assert.equal(evidence.excerpt, 2);
  assert.equal(evidence.answer, "A");
  assert.equal(evidence.keyedOption.en, "Fewer primary cardiovascular events. ".repeat(7) + "End of the rejected option.");
  assert.equal(evidence.keyedOption.vi, course(1).items.find(q => q.type === "case").options[0].vi);
  let expectedTotal = 0;
  assert.deepEqual(logs.flatMap(m => {
    const tokens = m.match(/token budget: estimated=(\d+).*running total=(\d+)$/);
    return tokens ? [tokens.slice(1).map(Number)] : [];
  }), g.calls.map(({estimated}) => [estimated, expectedTotal += estimated]));
  assert.ok(logs.some(m => /Rejected case item 2: options; stem=.+; value=.*"duplicate":\[1,2\].*"value":"/.test(m)));
  assert.ok(logs.some(m => /Rejected case item 1: resolve; stem=.+; value=\{"expected":"A","got":\["D"\]\}/.test(m)));
  assert.ok(logs.some(m => m.includes('"excerpt":"2.5"') && m.includes("case item 1: quote")));
  assert.ok(logs.some(m => m.includes('"excerpt":"2","quote":') && m.includes("case item 2: quote")));
  assert.ok(logs.includes("Groq case response count: expected 3, got 2."));
  console.log("Excerpt references: numeric, string, bracketed and E-prefixed indices resolve verbatim; invalid citations and missing slots are repaired: OK");
  const never = async () => assert.fail("unnecessary model call");
  assert.equal(await main({root, env, date, fetchImpl: never, log: quiet}), 0, "three valid sets are left alone");
  const saved = {...read(), [id]: sets.slice(0, 2)};
  fs.writeFileSync(setPath, "window.EBM_QUIZ_SETS = " + JSON.stringify({sets: saved}) + ";");
  const topUp = fakeGroq([], 100);
  assert.equal(await main({root, env, date, fetchImpl: topUp.fetchImpl, log: quiet}), 3);
  assert.deepEqual(topUp.calls.map(({mode}) => mode), ["generate", "solve"], "two valid sets leave only one to generate");
  assert.deepEqual(JSON.stringify(read()[id].slice(0, 2)), JSON.stringify(saved[id]));
  const fullArtifact = fs.readFileSync(setPath, "utf8");
  let unexpectedRequests = 0;
  assert.equal(await main({root, env, date, log: quiet, fetchImpl: async () => {
    unexpectedRequests++;
    return badModel();
  }}), 0);
  assert.equal(unexpectedRequests, 0, "later slots do not call Groq after reaching three valid sets");
  assert.equal(fs.readFileSync(setPath, "utf8"), fullArtifact);
  console.log("Normal refresh: retains valid case sets, tops up only the missing pack, and makes zero Groq calls at 3/3: OK");
  assert.equal(await main({root, env, date: nextDate, fetchImpl: never, log: quiet}), 0, "no lesson for that date");
  const nextLesson = {...lesson, id: nextId, date: nextDate};
  publishLessons([lesson, nextLesson]);
  const broken = fakeGroq(Array(6).fill("theory"));
  assert.equal(await main({root, env, date: nextDate, fetchImpl: broken.fetchImpl, log: quiet}), 0);
  assert.equal(broken.calls.length, 18, "at most two repairs per case");
  assert.ok(broken.calls.every(c => c.mode !== "solve"));
  assert.equal(read()[nextId], undefined, "neither theory sets nor partial sets are published");
  assert.ok(ClinicalQuiz.sourceCourse(nextLesson).items.every(q => q.type === "theory"));
  assert.equal(read()[id].length, 3, "earlier lessons keep their sets");

  const upstreamLogs = [];
  const rateLimit = () => new Response(JSON.stringify({error: {message: "Rate limit reached"}}),
    {status: 429, headers: {"Retry-After": "0.001"}});
  const badModel = () => new Response(JSON.stringify({error: {
    message: `Unknown model for ${env.GROQ_API_KEY}\nAuthorization: Bearer gsk_another_credential\n${"x".repeat(500)}`,
    debug: "DO NOT LOG THE FULL BODY",
  }}), {status: 400});
  const failures = [
    rateLimit, badModel,
    () => new Response("DO NOT LOG THE FULL BODY", {status: 413, statusText: "Content Too Large"}),
    () => { throw new Error(`fetch failed for ${env.GROQ_API_KEY}`, {cause: {code: "ENOTFOUND"}}); },
    badModel, badModel, badModel,
  ];
  const before = fs.readFileSync(setPath, "utf8");
  await main({root, env, date: nextDate, fetchImpl: async (_, options) => {
    requestBody(options);
    return failures.shift()();
  }, log: m => upstreamLogs.push(m)});
  assert.equal(failures.length, 0, "a 429 still retries the same generation phase");
  const diagnostics = upstreamLogs.join("\n");
  assert.match(diagnostics, /Groq case request failed \(HTTP 429, model=openai\/gpt-oss-120b, request_bytes=\d+, max_tokens=2550\): Rate limit reached/);
  assert.match(diagnostics, /HTTP 400[^\n]+: Unknown model for \[REDACTED\] Authorization: \[REDACTED\]/);
  assert.match(diagnostics, /HTTP 413[^\n]+: Content Too Large/);
  assert.match(diagnostics, /no HTTP response[^\n]+: fetch failed for \[REDACTED\] — ENOTFOUND/);
  assert.ok(!diagnostics.includes(env.GROQ_API_KEY));
  assert.doesNotMatch(diagnostics, /gsk_another_credential|DO NOT LOG THE FULL BODY|x{401}/);
  assert.equal(upstreamLogs.filter(m => m.includes("token budget:")).length, 7, "count every actual HTTP attempt");
  assert.equal(upstreamLogs.filter(m => m.includes("rate limits:")).length, 6, "every HTTP response logs quota data");
  assert.equal(upstreamLogs.filter(m => !/token budget:|rate limits:/.test(m)).length, 8);
  assert.match(upstreamLogs.at(-1), /rejected: \{"upstream":6\}/);
  assert.equal(fs.readFileSync(setPath, "utf8"), before, "upstream failures leave previously published sets intact");
  let time = 0;
  const paced = [];
  await main({root, env, date: nextDate, log: quiet, now: () => time, wait: async ms => {time += ms;},
    fetchImpl: async (_, options) => {
      const body = requestBody(options);
      paced.push({time, body});
      if (paced.length === 1) return new Response(JSON.stringify({error: {message: "Requested 2300. Please try again in 690ms."}}), {status: 429});
      if (paced.length === 2) return new Response(JSON.stringify({error: {code: "json_validate_failed"}}), {
        status: 400, headers: {"x-ratelimit-remaining-tokens": "10", "x-ratelimit-reset-tokens": "10s"},
      });
      if (paced.length === 3) return new Response(JSON.stringify({error: {message: "Failed to generate JSON."}}), {status: 400});
      return badModel();
    }});
  assert.deepEqual(paced.slice(0, 4).map(p => [p.time, p.body.temperature]), [[0, 0.7], [690, 0.7], [10690, 0.2], [10690, 0.7]]);
  assert.deepEqual(paced[2].body, {...paced[1].body, temperature: 0.2}, "JSON retry preserves the request except for temperature");
  let deadlineCalls = 0;
  await main({root, env, date: nextDate, log: quiet, now: () => 0, budgetMs: 1000,
    wait: async () => assert.fail("a wait past the workflow budget is forbidden"),
    fetchImpl: async () => {
      deadlineCalls++;
      return new Response(JSON.stringify({error: {message: "Please try again in 17.2s."}}), {status: 429});
    }});
  assert.equal(deadlineCalls, 1, "a delayed retry cannot run past the job deadline");
  assert.equal(fs.readFileSync(setPath, "utf8"), before);
  console.log("Groq upstream diagnostics: HTTP status, redacted error, retry, transport failure, and no publish: OK");
  const rerunEnv = {...env, REGENERATE_QUIZ_SETS: "true"};
  const primaryModel = "openai/gpt-oss-120b", fallbackModel = "openai/gpt-oss-20b";
  const tpd = () => new Response(JSON.stringify({error: {
    message: "Rate limit reached on tokens per day (TPD): Limit 200000, Used 199803, Requested 1089. Please try again in 6m25.344s.",
  }}), {status: 429, headers: {"Retry-After": "385", "x-ratelimit-remaining-tokens": "0"}});
  for (const capDuring of ["generate", "solve"]) {
    const primary = fakeGroq([], 200), fallback = fakeGroq([], 300);
    const calls = [], failoverLogs = [];
    const options = {root, env: {...rerunEnv, GROQ_FALLBACK_MODELS: fallbackModel}, date, log: m => failoverLogs.push(m),
      wait: async () => assert.fail("neither model should wait on a daily limit"),
      fetchImpl: async (url, request) => {
        const body = requestBody(request);
        const stage = body.messages[0].content.startsWith("Independently answer") ? "solve" : "generate";
        assert.equal(body.reasoning_effort, "low");
        assert.equal(body.include_reasoning, false);
        calls.push([body.model, stage]);
        if (body.model === primaryModel) {
          if (capDuring === "generate" || primary.calls.length === 3) return tpd();
          return primary.fetchImpl(url, request);
        }
        assert.equal(body.model, fallbackModel);
        if (capDuring === "solve" && fallback.calls.length === 2) return tpd();
        return fallback.fetchImpl(url, request);
      }};
    const expectedModels = capDuring === "generate" ? Array(3).fill(fallbackModel) : [primaryModel, fallbackModel];
    assert.equal(await main(options), expectedModels.length);
    assert.deepEqual(calls, capDuring === "generate" ? [
      [primaryModel, "generate"],
      ...expectedModels.flatMap(model => [[model, "generate"], [model, "solve"]]),
    ] : [
      [primaryModel, "generate"], [primaryModel, "solve"],
      [primaryModel, "generate"], [primaryModel, "solve"],
      [fallbackModel, "generate"], [fallbackModel, "solve"], [fallbackModel, "generate"],
    ]);
    const published = Array.from(read()[id]);
    assert.deepEqual(published.map(set => set.model), expectedModels);
    assert.ok(published.every(set => CaseQuiz.validateCaseSet(lesson, set)));
    assert.deepEqual(failoverLogs.filter(m => m.startsWith("Validated quiz case set ")),
      published.map(set => `Validated quiz case set ${set.set_id}; model=${set.model}`));
    assert.match(failoverLogs.join("\n"), /switching to openai\/gpt-oss-20b for generation and re-solve/);
    if (capDuring === "solve") assert.match(failoverLogs.join("\n"), /daily token limit for openai\/gpt-oss-20b; stopping quiz generation/);
  }
  console.log("Groq daily limit: switch both stages once, record pack provenance, and preserve completed packs if both models cap out: OK");
  const thirdModel = "qwen/qwen3.8-27b";
  const primaryWithHeaders = fakeGroq([], 480), third = fakeGroq([], 490);
  const quotaCalls = [], quotaLogs = [];
  assert.equal(await main({root, env: rerunEnv, date, log: m => quotaLogs.push(m),
    wait: async () => assert.fail("known daily shortages and daily 429s should switch without waiting"),
    fetchImpl: async (url, request) => {
      const body = requestBody(request);
      quotaCalls.push(body.model);
      if (body.model === fallbackModel) return tpd();
      if (body.model === thirdModel) {
        assert.equal(body.reasoning_effort, "low");
        assert.equal(body.reasoning_format, "hidden");
        assert.equal("include_reasoning" in body, false);
        return third.fetchImpl(url, request);
      }
      assert.equal(body.model, primaryModel);
      const response = await primaryWithHeaders.fetchImpl(url, request);
      return {...response, headers: new Headers({
        "x-ratelimit-remaining-tokens": "8000", "x-ratelimit-reset-tokens": "1ms",
        "x-ratelimit-remaining-requests": primaryWithHeaders.calls.length === 2 ? "1" : "41",
        "x-ratelimit-reset-requests": "23h59m",
        "x-ratelimit-remaining-tokens-day": String([4500, 6500, 1000][primaryWithHeaders.calls.length - 1]),
        "x-ratelimit-reset-tokens-day": "23h",
        "x-ratelimit-remaining-requests-minute": "5", "x-ratelimit-reset-requests-minute": "57s",
      })};
    },
  }), 3);
  assert.deepEqual(quotaCalls, [primaryModel, primaryModel, primaryModel, fallbackModel, thirdModel, thirdModel, thirdModel, thirdModel]);
  assert.deepEqual(primaryWithHeaders.calls.map(call => call.mode), ["generate", "solve", "generate"]);
  assert.ok(primaryWithHeaders.calls[2].estimated < 6500, "daily balance covers the generation request alone");
  assert.deepEqual(Array.from(read()[id], set => set.model), [primaryModel, thirdModel, thirdModel]);
  assert.match(quotaLogs.join("\n"), /Groq re-solve skipped for openai\/gpt-oss-120b: known daily quota cannot cover the request/);
  const loggedQuota = quotaLogs.find(m => m.includes("rate limits:") && m.includes(primaryModel));
  assert.deepEqual(JSON.parse(loggedQuota.slice(loggedQuota.indexOf("{"))), {
    requestsDay: {remaining: 41, limit: null, reset: "23h59m"},
    tokensMinute: {remaining: 8000, limit: null, reset: "1ms"},
    tokensDay: {remaining: 4500, limit: null, reset: "23h"},
    requestsMinute: {remaining: 5, limit: null, reset: "57s"},
    retryAfterSeconds: null,
  });
  assert.ok(quotaLogs.some(m => m.includes("rate limits:") && m.includes("HTTP 429")));
  console.log("Groq quota: log day/minute headers, skip a model short on known daily tokens, and publish with the third model: OK");
  for (const model of [primaryModel, fallbackModel, thirdModel]) {
    const cleanRun = fakeGroq([], 500);
    const budgetLogs = [];
    assert.equal(await main({root, env: {...rerunEnv, GROQ_MODEL: model}, date, fetchImpl: cleanRun.fetchImpl,
      log: m => budgetLogs.push(m)}), 3);
    assert.ok(Array.from(read()[id]).every(set => set.model === model));
    const estimated = cleanRun.calls.reduce((total, call) => total + call.estimated, 0);
    assert.ok(budgetLogs.some(m => m.endsWith(`model=${model}; model total=${estimated}; running total=${estimated}`)));
    console.log(`Groq first-pass three-set estimate, ${model}: ${estimated} tokens across ${cleanRun.calls.length} calls`);
  }
  const oldIds = read()[id].map(s => s.set_id);
  const fresh = fakeGroq(["explanations"], 10);
  const explanationLogs = [];
  assert.equal(await main({root, env: rerunEnv, date, fetchImpl: fresh.fetchImpl, log: m => explanationLogs.push(m)}), 3,
    "forced regeneration replaces today's sets even when all three already validate");
  assert.deepEqual(fresh.calls.slice(0, 4).map(({mode, slots}) => [mode, ...slots]),
    [["generate", 1, 2, 3], ["solve", 1, 2, 3], ["repair", 1, 2, 3], ["solve", 1, 2, 3]]);
  assert.deepEqual(explanationLogs.filter(m => m.includes(": explanation;")).map(m => m.split("; evidence=")[0].replace(/; stem=.*; value=/, ": ")), [
    'Rejected case item 1: explanation: ["en"]',
    'Rejected case item 2: explanation: ["vi"]',
    'Rejected case item 3: explanation: ["vi"]',
  ]);
  assert.ok(read()[id].flatMap(s => s.items).every(q => q.quote !== ckdQuote),
    "contradictory explanations and unverified slots were replaced");
  console.log("Independent re-solve: rejects contradictory or unverified bilingual explanations and repairs their slots: OK");
  const newIds = read()[id].map(s => s.set_id);
  assert.ok(newIds.every(id => !oldIds.includes(id)));
  const store = read();
  store[nextId] = store[id].map((s, i) => ({...s, set_id: `next-${i}`}));
  store[nextId][0].items[0].options[0].vi = "Giảm tử vong do tim mạch";
  store[nextId][1].items[0].explanation_en = "The trial reduced cardiovascular mortality.";
  fs.writeFileSync(setPath, "window.EBM_QUIZ_SETS = " + JSON.stringify({sets: store}) + ";");
  const offline = async () => badModel();
  assert.equal(await main({root, env: rerunEnv, date: nextDate, fetchImpl: offline, log: quiet}), 0);
  assert.deepEqual(Array.from(read()[nextId], s => s.set_id), ["next-2"],
    "failed regeneration keeps the still-valid set and unpublishes the invalid ones");
  assert.equal(await main({root, env, date: nextDate, fetchImpl: offline, log: quiet}), 0);
  assert.deepEqual(Array.from(read()[id], s => s.set_id), Array.from(newIds), "regeneration does not rewrite prior lessons");
  console.log("Daily rebuild: forced replacement, valid fallback, and invalid set removal: OK");
  for (const [fault, expectedSlots] of [["completion", [1, 3]], ["partial", [1, 3]], ["ambiguous", [3]]]) {
    assert.match(excerpts[0], /40 mg once daily/);
    assert.match(caseQuote, /hazard ratio, 0\.70/);
    const source = fault === "completion" ? lesson : {...lesson, quiz_source_texts: {[pmid]:
      [...lesson.quiz_source_texts[pmid], fault === "partial" ? "Participants received atorvastatin 40 mg."
        : "Participants in the atorvastatin arm received 40 mg once daily."]}};
    publishLessons([source]);
    const mock = fakeGroq([fault], 50, source);
    const rejections = [];
    assert.equal(await main({root, env: rerunEnv, date, fetchImpl: mock.fetchImpl, log: m => rejections.push(m)}), 3);
    assert.deepEqual(mock.calls.slice(1, 3).map(({mode, slots}) => [mode, ...slots]), [
      ["solve", ...expectedSlots], ["repair", ...[1, 2, 3].filter(n => !expectedSlots.includes(n))],
    ], "only grounded items reach the solver; only failed slots reach repair");
    const items = read()[id][0].items;
    if (fault !== "ambiguous") assert.deepEqual(Array.from(items[0].quotes), [caseQuote, excerpts[0]]);
    else assert.equal(items[0].quote, caseQuote, "ambiguous item is replaced, not auto-completed");
    assert.ok(rejections.some(m => /Rejected case item 2: numbers;.*value=\["30"\]/.test(m)));
  }
  publishLessons([lesson]);
  for (const fault of ["multi-key", "answer-first", "primary-verdict", "log-explanation"]) {
    const mock = fakeGroq([fault], 90);
    const logs = [];
    assert.equal(await main({root, env: rerunEnv, date, fetchImpl: mock.fetchImpl, log: m => logs.push(m)}), 3);
    if (fault === "multi-key") {
      assert.deepEqual(mock.calls[2].slots, [1, 2, 3], "multiple, missing and malformed keys all require repair");
      assert.ok(logs.filter(m => /Rejected case item \d: resolve/.test(m)).length === 3);
    } else if (fault === "answer-first" || fault === "primary-verdict") {
      assert.deepEqual(mock.calls[1].slots, [1, 2, 3]);
      if (fault === "primary-verdict") {
        assert.deepEqual(mock.calls[2].slots, [1], "a missing primary finding verdict requires repair");
        assert.match(logs.find(m => m.startsWith("Rejected case item 1:")), /citation-order/);
      }
      assert.deepEqual(Array.from(read()[id][0].items[0].quotes), [caseQuote, excerpts[0]]);
    } else {
      const entry = logs.find(m => /Rejected case item 1: numbers/.test(m));
      const evidence = JSON.parse(entry.split("; evidence=")[1]);
      assert.equal(evidence.explanations.en, "The source reports fewer primary cardiovascular events. ".repeat(7) + "A final unsupported figure is 30%.");
      assert.ok(evidence.explanations.vi);
    }
  }
  console.log("Independent solver rejects non-singleton keys; numeric answer citations are reordered; full explanations are logged: OK");
  const countMock = fakeGroq(["count-completion"], 60);
  assert.equal(await main({root, env: rerunEnv, date, fetchImpl: countMock.fetchImpl, log: quiet}), 3);
  assert.deepEqual(countMock.calls[1].slots, [1, 2, 3], "a missing enrollment count doesn't require a repair");
  assert.deepEqual(Array.from(read()[id][0].items[0].quotes), [caseQuote, excerpts[1]]);
  for (const [fault, background] of [["effects-completion", excerpts[1]], ["claims-completion", excerpts[0]],
    ["option-dose-completion", excerpts[0]], ["explanation-dose-completion", excerpts[0]]]) {
    const mock = fakeGroq([fault], 70);
    assert.equal(await main({root, env: rerunEnv, date, fetchImpl: mock.fetchImpl, log: quiet}), 3);
    assert.deepEqual(mock.calls[1].slots, [1, 2, 3], "a grounding failure resolved by the second citation doesn't require a repair");
    assert.deepEqual(Array.from(read()[id][0].items[0].quotes), [caseQuote, background]);
  }
  console.log("Citation completion: qualifying population and enrollment count also complete after claims or effects failures: OK");
  console.log("Citation completion: STAREE population and regimen supported; partial matches ignored; absent 30% and true ambiguity rejected: OK");
  console.log("Case-only generation: three cases per set, selective repairs, independent re-solve, no-key theory fallback: OK");
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(root, {recursive: true, force: true}));
