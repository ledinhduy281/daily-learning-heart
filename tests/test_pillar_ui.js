const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync(require.resolve("../index.html"), "utf8");
assert.match(html, /<section\b[^>]*id="pillarHistoryDiagramPanel" aria-labelledby="historySectionTitle">[\s\S]*?id="historyPillarSelect"[\s\S]*?<\/section>/);
assert.doesNotMatch(html, /tabModeHistory|btnOpenTodayPillarHistory|todaySidebarContext|pillarsTilesDeck|Chu kỳ tiến 1 → 10/);
assert.match(html, /\.rotation-slot-card\.today \.rotation-slot-kicker \{[^}]*color: var\(--color-accent-ink\);/);
assert.match(html, /\.history-node-card\.active \.history-node-transition \{[^}]*\bcolor: var\(--color-accent-ink\);/);

function source(start, end) {
  const first = html.indexOf(start);
  const last = html.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return html.slice(first, last);
}

const pillars = [
  { id: 1, name: "Hypertension", vi_name: "Tăng huyết áp" },
  { id: 2, name: "Dyslipidemia", vi_name: "Rối loạn lipid máu" },
  { id: 3, name: "Coronary disease", vi_name: "Bệnh mạch vành" },
];
const today = { id: "today", date: "2026-11-17", pillar_id: 2, title_vi: "Hôm nay" };
const older = { id: "past", date: "2026-11-07", pillar_id: 2, title_vi: "Trước đây" };
const other = { id: "unrelated", date: "2026-11-16", pillar_id: 1, title_vi: "Khác" };
const App = {
  mode: "today", currentLang: "vi", todayPillarId: 2, todayDate: today.date,
  yesterdayPillar: pillars[0], todayPillar: pillars[1], tomorrowPillar: pillars[2],
  historyPillarId: 1, pillars, briefings: [today, older, other], selected: today,
};
const Dom = {
  todayPillarHeading: {}, navRotationStatus: {}, dailyRotationBanner: {},
  historyPillarSelect: {}, historyDiagramTitle: {}, historyDiagramScopeBadge: {},
  historyDiagramTrack: { querySelector: () => null },
  historyFilterStrip: { querySelectorAll: () => [] },
  searchBriefingInput: {},
};
const window = {};
const context = vm.createContext({
  App, Dom, window,
  getPillarDisplayName: (id, isVi) => pillars.find(p => p.id === id)[isVi ? "vi_name" : "name"],
  formatShortDdMm: () => "",
  formatGuidelineTransitionChip: () => "",
  cleanHeadline: text => text,
  escapeHtml: text => text,
  getTodaySingleBriefing: () => today,
  selectBriefing: briefing => { App.selected = briefing; },
  renderUserWorkspace: () => {},
});
vm.runInContext(
  source("    const I18N = {", "\n    };") + "\n    };" +
  "\nfunction t(key) { return I18N[App.currentLang][key]; }\n" +
  source("    function populatePillarSelect()", "    window.openPillarHistory =") +
  source("    function renderPerPillarHistoryDiagram()", "    /* ========================================================================\n       SIDEBAR BRIEFINGS LIST"),
  context
);

vm.runInContext("renderDailyRotationBanner(); renderPillarHistory();", context);
assert.equal(Dom.todayPillarHeading.textContent, "Trụ cột 2: Rối loạn lipid máu");
assert.match(Dom.historyPillarSelect.innerHTML, /value="2" selected/);
assert.ok(Dom.historyDiagramTrack.innerHTML.includes('data-node-id="past"'));
assert.ok(!Dom.historyDiagramTrack.innerHTML.includes('data-node-id="unrelated"'));
window.onSelectHistoryNode("past");
assert.equal(App.selected, older);
assert.equal(App.mode, "history");
window.showTodayBriefing();
assert.equal(App.selected, today);
assert.equal(App.mode, "today");
App.currentLang = "en";
vm.runInContext("renderDailyRotationBanner(); renderPillarHistory();", context);
assert.equal(Dom.todayPillarHeading.textContent, "Pillar 2: Dyslipidemia");
assert.match(Dom.historyPillarSelect.innerHTML, /Pillar #2: Dyslipidemia/);
console.log("Bilingual pillar UI and inline history: OK");
