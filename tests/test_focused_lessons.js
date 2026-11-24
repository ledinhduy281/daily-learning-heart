const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(root, "data/briefings.js"), "utf8"), { window });
const bundle = window.EBM_BRIEFINGS_DATA;
const App = { todayPillarId: 9, todayDate: "2026-11-24", briefings: bundle.briefings };
const Dom = { guidelineComparisonBanner: { style: {} }, evolutionPipelineRow: {} };
const context = vm.createContext({ window, App, Dom, renderGuidelineRefBox: (guideline, _, highlighted) => {
  assert.equal(highlighted, true);
  return guideline.name;
} });
vm.runInContext(html.slice(html.indexOf("    function getTodaySingleBriefing()"),
    html.indexOf("    function getHistoryScopeBriefings()")), context);
vm.runInContext(html.slice(html.indexOf("    function renderEvolutionPipeline("),
    html.indexOf("    function renderTrialsMatrix(")), context);
context.escapeHtml = s => s;

const fallback = context.getTodaySingleBriefing();
assert.equal(fallback.id, "ebm-2026-11-24-p9-focused");
assert.equal(fallback.guideline_evolution.current_guideline.pmid, "36017548");
for (const isVi of [true, false]) {
  context.renderEvolutionPipeline(fallback, isVi);
  assert.equal(Dom.guidelineComparisonBanner.innerHTML, fallback.guideline_evolution.current_guideline.name);
  assert.ok(Dom.evolutionPipelineRow.innerHTML.includes(fallback.guideline_evolution[isVi ? "recommendation_vi" : "recommendation_en"]));
  const disclaimer = fallback[isVi ? "disclaimer_vi" : "disclaimer_en"];
  assert.match(disclaimer, isVi ? /^Chỉ dùng cho mục đích học tập/ : /^For education only/);
  assert.ok(fallback[isVi ? "part1_vi_markdown" : "part2_en_markdown"].endsWith(`*${disclaimer}*`));
}
App.briefings = [ { ...fallback, lesson_format: undefined }, fallback ];
assert.equal(context.getTodaySingleBriefing(), fallback);
App.todayDate = "2026-11-14";
App.briefings = bundle.briefings;
assert.equal(context.getTodaySingleBriefing().date, "2026-11-14");
Dom.trialsGridDeck = {};
vm.runInContext(html.slice(html.indexOf("    function renderTrialsMatrix("),
    html.indexOf("    function renderPearls(")), context);
context.renderTrialsMatrix(fallback, false);
assert.ok(Dom.trialsGridDeck.innerHTML.includes("AMBITION"));
assert.ok(Dom.trialsGridDeck.innerHTML.includes(fallback.supporting_evidence.limits_en));
assert.ok(Dom.trialsGridDeck.innerHTML.includes("/26308684/"));
context.renderTrialsMatrix({ ...fallback, supporting_evidence: bundle.focused_lessons[8].supporting_evidence }, false);
assert.equal(Dom.trialsGridDeck.textContent, "No matched study is available.");
console.log("Focused guideline selection and browser rendering passed");
