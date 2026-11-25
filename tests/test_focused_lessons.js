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
  assert.equal(Dom.evolutionPipelineRow.className, "focused-recommendation");
  assert.equal(Dom.guidelinePipelineSociety.textContent, "ESC/ERS");
  assert.equal(Dom.guidelineComparisonBanner.innerHTML, fallback.guideline_evolution.current_guideline.name);
  assert.ok(Dom.evolutionPipelineRow.innerHTML.includes(fallback.guideline_evolution[isVi ? "recommendation_vi" : "recommendation_en"]));
  for (const key of ["context", "evolution", "application"]) {
    assert.ok(fallback.teaching[isVi ? "vi" : "en"][key].every(
      paragraph => Dom.evolutionPipelineRow.innerHTML.includes(paragraph)
    ));
  }
  const disclaimer = fallback[isVi ? "disclaimer_vi" : "disclaimer_en"];
  assert.match(disclaimer, isVi ? /^Chỉ dùng cho mục đích học tập/ : /^For education only/);
  assert.ok(fallback[isVi ? "part1_vi_markdown" : "part2_en_markdown"].endsWith(`*${disclaimer}*`));
  assert.ok(fallback[isVi ? "part1_vi_markdown" : "part2_en_markdown"].includes(labels[isVi ? "vi" : "en"]));
}
context.formatFullDdMmYyyy = iso => iso.split("-").reverse().join("/");
const recent = bundle.focused_lessons[2];
assert.equal(recent.lesson_format, "single_source");
context.renderEvolutionPipeline(recent, false);
assert.equal(Dom.guidelinePipelineSociety.textContent, "N Engl J Med");
assert.equal(Dom.guidelineComparisonBanner.innerHTML, recent.primary_source.name);
assert.ok(recent.teaching.en.summary.every(paragraph => Dom.evolutionPipelineRow.innerHTML.includes(paragraph)));
const legacy = bundle.briefings.find(b => b.id === "ebm-2026-11-14-p9-main");
context.t = key => key;
context.formatInlineRich = text => text;
context.renderGuidelineRefBox = (_, __, highlighted) => highlighted ? "current" : "prior";
context.renderEvolutionPipeline(legacy, false);
assert.equal(Dom.evolutionPipelineRow.className, "evolution-pipeline");
assert.match(Dom.evolutionPipelineRow.innerHTML, /pipeline-step-box current/);
context.renderEvolutionPipeline(fallback, true);
assert.equal(Dom.evolutionPipelineRow.className, "focused-recommendation");
const today = bundle.briefings.find(b => b.lesson_format === "single_source");
Object.assign(App, {todayDate: today.date, todayPillarId: today.pillar_id});
App.briefings = [ { ...today, lesson_format: undefined }, today ];
assert.equal(context.getTodaySingleBriefing(), today);
App.todayPillarId = 9;
App.todayDate = "2026-11-14";
App.briefings = bundle.briefings.filter(b => b.id !== fallback.id);
assert.equal(context.getTodaySingleBriefing().date, "2026-11-14");
Dom.trialsGridDeck = {};
vm.runInContext(html.slice(html.indexOf("    function renderGuidelineRefBox("),
    html.indexOf("    function renderEvolutionPipeline(")), context);
vm.runInContext(html.slice(html.indexOf("    function renderFocusedBlockB("),
    html.indexOf("    function renderPearls(")), context);
context.renderTrialsMatrix(fallback, false);
assert.ok(Dom.trialsGridDeck.innerHTML.includes("AMBITION"));
assert.ok(Dom.trialsGridDeck.innerHTML.includes(fallback.teaching.en.interpretation[0]));
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
  for (const key of ["design", "findings", "interpretation"]) {
    assert.ok(fallback.teaching[isVi ? "vi" : "en"][key].every(
      paragraph => Dom.trialsGridDeck.innerHTML.includes(paragraph)
    ));
  }
  assert.match(Dom.trialsGridDeck.innerHTML, licensed);
  assert.match(Dom.trialsGridDeck.innerHTML, /creativecommons.org/);
}
context.renderTrialsMatrix({ ...fallback, supporting_evidence: bundle.focused_lessons[8].supporting_evidence }, false);
assert.equal(Dom.trialsGridDeck.textContent, "No matched study is available.");
Dom.pearlsStackDeck = {};
context.t = key => key;
context.formatInlineRich = text => text;
vm.runInContext(html.slice(html.indexOf("    function renderPearls("),
    html.indexOf("    function renderSources(")), context);
for (const isVi of [true, false]) {
  context.renderPearls(fallback, isVi);
  const notes = fallback.teaching[isVi ? "vi" : "en"];
  assert.equal(Dom.pearlsStackDeck.innerHTML.match(/class="pearl-row"/g).length, 4);
  assert.ok([...notes.guideline_pearls, ...notes.evidence_pearls].every(
    text => Dom.pearlsStackDeck.innerHTML.includes(text)
  ));
}
context.renderPearls({...fallback, teaching: undefined}, false);
assert.equal(Dom.pearlsStackDeck.innerHTML, "");
App.todayDate = "2026-11-27";
const saved = context.getFocusedTemplateBriefing("2026-11-26", 1);
assert.equal(context.getFocusedTemplateBriefing("2026-11-24", 9), null);
App.mode = "history";
App.savedGlobalMode = true;
App.searchQuery = "";
App.user = {bookmarked_ids: [saved.id, "ebm-2026-11-30-p9-focused", "ebm-2026-11-31-p9-focused", "missing"]};
assert.ok(!App.briefings.some(b => b.id === saved.id));
assert.equal(context.getHistoryScopeBriefings().length, 1);
assert.equal(context.getHistoryScopeBriefings()[0].id, saved.id);
assert.equal(context.getHistoryScopeBriefings()[0].title_en, saved.title_en);
App.todayDate = "2026-12-01";
assert.equal(context.findArchiveBriefing("ebm-2026-11-31-p9-focused"), null);
let opened;
context.selectBriefing = b => { opened = b; };
vm.runInContext(html.slice(html.indexOf("    window.onSelectBriefingItem ="),
    html.indexOf("    function selectBriefing(")), context);
window.onSelectBriefingItem(saved.id);
assert.equal(opened.id, saved.id);
const published = {...saved, title_en: "Published edition"};
App.briefings = [published, ...App.briefings];
assert.equal(context.findArchiveBriefing(saved.id), published);
const quizNodes = {socraticTutorSection: {}, quizUnavailable: {}};
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
assert.equal(quizNodes.socraticTutorSection.hidden, true);
assert.equal(quizNodes.quizUnavailable.hidden, false);
assert.match(quizNodes.quizUnavailable.textContent, /nguồn gốc|source-supported/);
console.log("Focused guideline selection and browser rendering passed");
