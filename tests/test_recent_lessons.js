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
  trialsGridDeck: {}, pearlsStackDeck: {} };
const context = vm.createContext({ window, Dom, App: { currentLang: "vi" }, t: key => key, formatInlineRich: s => s });
const slice = (start, end) => vm.runInContext(html.slice(html.indexOf(`    function ${start}(`),
  html.indexOf(`    function ${end}(`)), context);
slice("escapeHtml", "formatDoiUrl");
slice("formatDoiUrl", "safeChatSourceUrl");
vm.runInContext(html.slice(html.indexOf("    function formatFullDdMmYyyy("), html.indexOf("\n    }\n", html.indexOf("    function formatFullDdMmYyyy(")) + 6), context);
slice("renderGuidelineRefBox", "renderPearls");
slice("renderPearls", "renderSources");

const lessons = Object.values(bundle.focused_lessons);
assert.equal(lessons.length, 10);
const refBox = /<div class="guideline-ref-box current">[\s\S]*?\n\s+<\/div>/;
for (const lesson of lessons) for (const isVi of [true, false]) {
  const source = lesson.primary_source;
  assert.equal(lesson.lesson_format, "single_source");
  context.renderEvolutionPipeline(lesson, isVi);
  context.renderTrialsMatrix(lesson, isVi);
  const blockA = Dom.guidelineComparisonBanner.innerHTML, blockB = Dom.trialsGridDeck.innerHTML;
  assert.match(blockA, refBox, lesson.id);
  assert.equal(blockB.match(refBox)[0], blockA.match(refBox)[0], `${lesson.id}: Block B citation must match Block A`);
  assert.doesNotMatch(blockB, /trial-box-header|trial-journal-tag/);
  for (const html of [blockA, blockB]) {
    assert.ok(html.includes(`https://pubmed.ncbi.nlm.nih.gov/${source.pmid}/`));
    assert.ok(html.includes(`https://doi.org/${source.doi}`));
    assert.ok(html.includes(source.online_date.split("-").reverse().join("/")));
  }
  const notes = lesson.teaching[isVi ? "vi" : "en"];
  assert.ok(notes.summary.every(p => Dom.evolutionPipelineRow.innerHTML.includes(context.escapeHtml(p))));
  for (const key of ["design", "findings", "limits"]) {
    assert.ok(notes[key].every(p => blockB.includes(context.escapeHtml(p))), `${lesson.id} ${key}`);
  }
  for (const excerpt of lesson.source_excerpts) assert.ok(blockB.includes(context.escapeHtml(excerpt.text)));
  assert.equal(/No quiz yet|Chưa có quiz/.test(blockB), source.kind === "guideline", lesson.id);
  context.renderPearls(lesson, isVi);
  assert.ok(notes.pearls.every(p => Dom.pearlsStackDeck.innerHTML.includes(p)), lesson.id);
}
assert.equal(context.renderSourceExcerpt({ kind: "pubmed_abstract", pmid: "1", url: "https://evil.example/", text: "x" }, true), "");
const physician = context.renderSourceExcerpt({ kind: "physician_entered", pmid: "42661420", text: "Line",
  url: "https://pubmed.ncbi.nlm.nih.gov/42661420/", class: "I", level: "A", locator: "Table 3" }, false);
assert.match(physician, /Class I · Level A · Table 3/);
console.log("recent lesson rendering ok");
