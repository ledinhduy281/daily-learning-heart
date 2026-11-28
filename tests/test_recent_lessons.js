const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(root, "data/briefings.js"), "utf8"), { window });
const bundle = window.EBM_BRIEFINGS_DATA;
const Dom = { guidelineComparisonBanner: { style: {} }, guidelinePipelineSociety: {}, evolutionPipelineRow: {},
  trialsSection: {}, trialsSectionHeading: {}, trialsGridDeck: {}, pearlsStackDeck: {} };
const context = vm.createContext({ window, Dom, App: { currentLang: "vi" }, t: key => key, formatInlineRich: s => s });
const slice = (start, end) => vm.runInContext(html.slice(html.indexOf(`    function ${start}(`),
  html.indexOf(`    function ${end}(`)), context);
slice("escapeHtml", "formatDoiUrl");
slice("formatDoiUrl", "safeChatSourceUrl");
vm.runInContext(html.slice(html.indexOf("    function formatFullDdMmYyyy("), html.indexOf("\n    }\n", html.indexOf("    function formatFullDdMmYyyy(")) + 6), context);
slice("renderGuidelineRefBox", "renderPearls");
slice("renderPearls", "renderSources");

const templates = Object.values(bundle.focused_lessons);
assert.equal(templates.length, 10);
const datedPci = bundle.briefings.find(lesson => lesson.id === "ebm-2026-11-28-p3-focused");
assert.ok(datedPci.teaching.vi.mechanism.length);
const datedBproad = bundle.briefings.find(lesson => lesson.id === "ebm-2026-11-25-p10-focused");
assert.ok(datedBproad.teaching.vi.mechanism.length);
const lessons = [...templates, datedPci, datedBproad];
assert.match(html, /id="trialsSection">\s*<div[^>]*id="trialsSectionHeading">\s*<span id="trialsSectionTitle">[^<]*<\/span>\s*<\/div>\s*<div[^>]*id="trialsGridDeck">/);
const refBox = /<div class="guideline-ref-box current">[\s\S]*?\n\s+<\/div>/;
for (const lesson of lessons) for (const isVi of [true, false]) {
  const source = lesson.primary_source;
  assert.equal(lesson.lesson_format, "single_source");
  context.renderEvolutionPipeline(lesson, isVi);
  context.renderTrialsMatrix(lesson, isVi);
  const blockA = Dom.guidelineComparisonBanner.innerHTML, blockB = Dom.trialsGridDeck.innerHTML;
  assert.equal(Dom.trialsSection.className, "trials-section summary-card-feature");
  assert.equal(Dom.trialsSectionHeading.className, "summary-title-line");
  assert.match(blockA, refBox, lesson.id);
  assert.equal(blockB.match(refBox)[0], blockA.match(refBox)[0], `${lesson.id}: Block B citation must match Block A`);
  assert.doesNotMatch(blockB, /trial-box-header|trial-journal-tag/);
  for (const html of [blockA, blockB]) {
    assert.ok(html.includes(`https://pubmed.ncbi.nlm.nih.gov/${source.pmid}/`));
    assert.ok(html.includes(`https://doi.org/${source.doi}`));
    assert.ok(html.includes(source.online_date.split("-").reverse().join("/")));
  }
  const notes = lesson.teaching[isVi ? "vi" : "en"];
  const walkthrough = Dom.evolutionPipelineRow.innerHTML;
  const blockAKeys = ["summary", "mechanism", "evidence_shift", "application", "pitfalls"];
  const hasDepth = Boolean(notes.mechanism);
  assert.equal((walkthrough.match(/<h3>/g) || []).length, hasDepth ? blockAKeys.length : 1, lesson.id);
  if (source.pmid === "43020520" || source.pmid === "42747372") {
    const headings = [
      isVi ? "Nguồn này nói gì" : "What this source says",
      source.pmid === "43020520"
        ? (isVi ? "Huyết áp và não: cơ chế" : "Blood pressure and the brain")
        : (isVi ? "Vì sao chụp mạch có thể bỏ sót vấn đề" : "What angiography can miss"),
      isVi ? "Bằng chứng đã thay đổi cách nghĩ ra sao" : "How evidence changed the question",
      isVi ? "Áp dụng qua một ca giả định" : "Applying the evidence to a teaching case",
      isVi ? "Những bẫy khi áp dụng" : "Pitfalls in application",
    ];
    assert.deepEqual([...walkthrough.matchAll(/<h3>(.*?)<\/h3>/g)].map(match => match[1]), headings);
  }
  for (const key of hasDepth ? blockAKeys : ["summary"]) {
    assert.ok(notes[key].every(p => walkthrough.includes(context.escapeHtml(p))), `${lesson.id} ${key}`);
    assert.ok(notes[key].every(p => !blockB.includes(context.escapeHtml(p))), `${lesson.id} ${key} stays in Block A`);
  }
  for (const key of ["design", "findings", "limits"]) {
    assert.ok(notes[key].every(p => blockB.includes(context.escapeHtml(p))), `${lesson.id} ${key}`);
  }
  for (const excerpt of lesson.source_excerpts) assert.ok(blockB.includes(context.escapeHtml(excerpt.text)));
  assert.equal(/No quiz yet|Chưa có quiz/.test(blockB), source.kind === "guideline", lesson.id);
  context.renderPearls(lesson, isVi);
  assert.ok(notes.pearls.every(p => Dom.pearlsStackDeck.innerHTML.includes(p)), lesson.id);
}
const mechanismHeading = mechanism => context.renderTeachingSections({
  ...datedBproad,
  primary_source: { ...datedBproad.primary_source, section_labels: { en: { mechanism } } }
}, false, "source_summary");
assert.match(mechanismHeading(""), /<h3>Mechanism<\/h3>/);
assert.match(mechanismHeading("<unsafe>"), /<h3>&lt;unsafe&gt;<\/h3>/);
assert.equal(context.renderSourceExcerpt({ kind: "pubmed_abstract", pmid: "1", url: "https://evil.example/", text: "x" }, true), "");
const physician = context.renderSourceExcerpt({ kind: "physician_entered", pmid: "42661420", text: "Line",
  url: "https://pubmed.ncbi.nlm.nih.gov/42661420/", class: "I", level: "A", locator: "Table 3" }, false);
assert.match(physician, /Class I · Level A · Table 3/);
console.log("recent lesson rendering ok");
