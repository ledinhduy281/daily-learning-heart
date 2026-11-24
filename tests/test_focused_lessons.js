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
const Dom = { guidelineComparisonBanner: { style: {} }, guidelinePipelineSociety: {}, evolutionPipelineRow: {} };
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
  assert.equal(Dom.guidelinePipelineSociety.textContent, "ESC/ERS");
  assert.equal(Dom.guidelineComparisonBanner.innerHTML, fallback.guideline_evolution.current_guideline.name);
  assert.ok(Dom.evolutionPipelineRow.innerHTML.includes(fallback.guideline_evolution[isVi ? "recommendation_vi" : "recommendation_en"]));
}
context.renderEvolutionPipeline(bundle.focused_lessons[2], false);
assert.equal(Dom.guidelinePipelineSociety.textContent, "ESC/EAS");
App.briefings = [ { ...fallback, lesson_format: undefined }, fallback ];
assert.equal(context.getTodaySingleBriefing(), fallback);
App.todayDate = "2026-11-14";
App.briefings = bundle.briefings;
assert.equal(context.getTodaySingleBriefing().date, "2026-11-14");
console.log("Focused guideline selection and browser rendering passed");
