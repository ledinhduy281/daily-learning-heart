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
    html.indexOf("    function setLanguage(")), context);
vm.runInContext(html.slice(html.indexOf("    function renderEvolutionPipeline("),
    html.indexOf("    function renderTrialsMatrix(")), context);
context.escapeHtml = s => s;
vm.runInContext(html.slice(html.indexOf("    function formatDoiUrl("),
    html.indexOf("    function safeChatSourceUrl(")), context);
assert.equal(context.formatDoiUrl("  "), "");
vm.runInContext(html.slice(html.indexOf("    function rotationNoticeFor("),
    html.indexOf("    function formatFullDdMmYyyy(")), context);
bundle.lesson_gate_start = "2026-11-24";
App.currentLang = "en";
assert.match(context.rotationNoticeFor({date: "2026-11-23"}), /Legacy archive lesson/);
App.currentLang = "vi";
assert.match(context.rotationNoticeFor({date: "2026-11-23"}), /Bài lưu trữ/);
assert.equal(context.rotationNoticeFor({date: "2026-11-24"}), "");

const fallback = context.getTodaySingleBriefing();
const labels = {
  vi: "Biên soạn từ nguồn trích dẫn — chưa được bác sĩ duyệt",
  en: "Curated from the cited source — not yet physician-reviewed"
};
assert.equal(
  context.normalizeCuratedMarkdown("## Block A\n*Curated, human-reviewed content*\n\nUnchanged"),
  `## Block A\n*${labels.en}*\n\nUnchanged`
);
assert.equal(
  context.normalizeCuratedMarkdown("*Nội dung tuyển chọn, đã được người biên tập rà soát*"),
  `*${labels.vi}*`
);
assert.equal(fallback.id, "ebm-2026-11-24-p9-focused");
assert.equal(fallback.guideline_evolution.current_guideline.pmid, "36017548");
for (const isVi of [true, false]) {
  context.renderEvolutionPipeline(fallback, isVi);
  assert.equal(Dom.guidelinePipelineSociety.textContent, "ESC/ERS");
  assert.equal(Dom.guidelineComparisonBanner.innerHTML, fallback.guideline_evolution.current_guideline.name);
  assert.ok(Dom.evolutionPipelineRow.innerHTML.includes(fallback.guideline_evolution[isVi ? "recommendation_vi" : "recommendation_en"]));
  const disclaimer = fallback[isVi ? "disclaimer_vi" : "disclaimer_en"];
  assert.match(disclaimer, isVi ? /^Chỉ dùng cho mục đích học tập/ : /^For education only/);
  assert.ok(fallback[isVi ? "part1_vi_markdown" : "part2_en_markdown"].endsWith(`*${disclaimer}*`));
  assert.ok(fallback[isVi ? "part1_vi_markdown" : "part2_en_markdown"].includes(labels[isVi ? "vi" : "en"]));
}
context.renderEvolutionPipeline(bundle.focused_lessons[2], false);
assert.equal(Dom.guidelinePipelineSociety.textContent, "ESC/EAS");
App.briefings = [ { ...fallback, lesson_format: undefined }, fallback ];
assert.equal(context.getTodaySingleBriefing(), fallback);
App.todayDate = "2026-11-14";
App.briefings = bundle.briefings.filter(b => b.id !== fallback.id);
assert.equal(context.getTodaySingleBriefing().date, "2026-11-14");
Dom.trialsGridDeck = {};
vm.runInContext(html.slice(html.indexOf("    function renderTrialsMatrix("),
    html.indexOf("    function renderPearls(")), context);
context.renderTrialsMatrix(fallback, false);
assert.ok(Dom.trialsGridDeck.innerHTML.includes("AMBITION"));
assert.ok(Dom.trialsGridDeck.innerHTML.includes(fallback.supporting_evidence.limits_en));
assert.ok(Dom.trialsGridDeck.innerHTML.includes("/26308684/"));
context.renderTrialsMatrix({...fallback, supporting_evidence: {
  ...fallback.supporting_evidence, pmid: "", doi: "10.1000/example"
}}, false);
assert.match(Dom.trialsGridDeck.innerHTML, /href="https:\/\/doi\.org\/10\.1000\/example"/);
const excerpt = {
  text: "<source text>", authors: ["An Author"], url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC12345/",
  license_url: "https://creativecommons.org/licenses/by/4.0/"
};
for (const [isVi, curated, licensed] of [
  [true, labels.vi, /Trích từ nguồn có giấy phép/],
  [false, labels.en, /Extracted from a licensed source/]
]) {
  context.renderEvolutionPipeline({...fallback, guideline_evolution: {
    ...fallback.guideline_evolution, licensed_recommendation: excerpt
  }}, isVi);
  assert.ok(Dom.evolutionPipelineRow.innerHTML.includes(curated));
  assert.match(Dom.evolutionPipelineRow.innerHTML, licensed);
  context.renderTrialsMatrix({...fallback, supporting_evidence: {
    ...fallback.supporting_evidence, licensed_excerpts: {result: excerpt}
  }}, isVi);
  assert.ok(Dom.trialsGridDeck.innerHTML.includes(curated));
  assert.match(Dom.trialsGridDeck.innerHTML, licensed);
  assert.match(Dom.trialsGridDeck.innerHTML, /creativecommons.org/);
}
context.renderTrialsMatrix({ ...fallback, supporting_evidence: bundle.focused_lessons[8].supporting_evidence }, false);
assert.equal(Dom.trialsGridDeck.textContent, "No matched study is available.");
App.todayDate = "2026-11-27";
App.mode = "history";
App.savedGlobalMode = true;
App.searchQuery = "";
App.user = {bookmarked_ids: [fallback.id, "ebm-2026-11-30-p9-focused", "ebm-2026-11-31-p9-focused", "missing"]};
assert.ok(!App.briefings.some(b => b.id === fallback.id));
assert.equal(context.getHistoryScopeBriefings().length, 1);
assert.equal(context.getHistoryScopeBriefings()[0].id, fallback.id);
assert.equal(context.getHistoryScopeBriefings()[0].title_en, fallback.title_en);
App.todayDate = "2026-12-01";
assert.equal(context.findArchiveBriefing("ebm-2026-11-31-p9-focused"), null);
let opened;
context.selectBriefing = b => { opened = b; };
vm.runInContext(html.slice(html.indexOf("    window.onSelectBriefingItem ="),
    html.indexOf("    function selectBriefing(")), context);
window.onSelectBriefingItem(fallback.id);
assert.equal(opened.id, fallback.id);
const published = {...fallback, title_en: "Published edition"};
App.briefings = [published, ...App.briefings];
assert.equal(context.findArchiveBriefing(fallback.id), published);
const quizNodes = Object.fromEntries(["btnOpenSocraticHeader", "socraticTutorSection"].map(id => [id, {style: {}}]));
const quizCode = html.match(/const SocraticTutor = \{[\s\S]*?\n    \};/)[0];
App.selected = {...fallback, quiz_mode: undefined};
context.ClinicalQuiz = require("../clinical_mcq.js");
context.document = {getElementById: id => quizNodes[id]};
const tutor = vm.runInContext(quizCode + ";SocraticTutor", context);
assert.equal(tutor.quizSourceLabel(fallback, true), labels.vi);
assert.equal(tutor.quizSourceLabel(fallback, false), labels.en);
const licensedQuiz = {lesson_provenance: {quiz: {mode: "licensed_excerpt"}}};
assert.match(tutor.quizSourceLabel(licensedQuiz, true), /Trích từ nguồn có giấy phép/);
assert.match(tutor.quizSourceLabel(licensedQuiz, false), /Extracted from a licensed source/);
tutor.getSession = () => { assert.fail("A focused lesson without excerpts should not start a generic quiz"); };
tutor.renderUI();
assert.equal(quizNodes.btnOpenSocraticHeader.style.display, "none");
assert.equal(quizNodes.socraticTutorSection.style.display, "none");
console.log("Focused guideline selection and browser rendering passed");
