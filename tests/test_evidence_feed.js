const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { load, sourceLink } = require("../evidence_feed");

const payload = {
  schema_version: 1, date: "2026-01-20",
  sources: {
    pubmed: { status: "ok", records: 1 },
    clinicaltrials: { status: "ok", records: 0 },
    openfda: { status: "unavailable", records: 0 },
  },
  items: [{ source: "pubmed", source_id: "12345678", title: "Heart failure trial",
            source_url: "javascript:alert(1)" }],
};

async function main() {
  const cache = new Map();
  const storage = { setItem: (key, value) => cache.set(key, value), getItem: key => cache.get(key) };
  const online = async path => {
    assert.equal(path, "data/pipeline/briefing.json");
    return { ok: true, json: async () => payload };
  };
  const missing = async () => ({ ok: false, status: 404 });
  const offline = async () => { throw new TypeError("Offline"); };
  const badJSON = async () => ({ ok: true, json: async () => ({ ...payload, schema_version: 2 }) });

  assert.equal(await load({ fetcher: missing, storage }), null);
  assert.deepEqual(await load({ fetcher: online, storage }), { payload, fromCache: false });
  assert.deepEqual(await load({ fetcher: offline, storage }), { payload, fromCache: true });
  assert.deepEqual(await load({ fetcher: badJSON, storage }), { payload, fromCache: true });
  assert.equal(sourceLink(payload.items[0]), "https://pubmed.ncbi.nlm.nih.gov/12345678/");
  assert.equal(sourceLink({ source: "pubmed", source_id: "../bad" }), null);
  assert.equal(sourceLink({ source: "toString", source_id: "123" }), null);

  const html = readFileSync(require.resolve("../index.html"), "utf8");
  const renderer = html.match(/function renderDailyEvidence\(\) \{[\s\S]*?\n    \}/)[0];
  const elements = new Map();
  const navigator = { onLine: true };
  const App = { evidenceFeed: { payload, fromCache: false }, currentLang: "en" };
  const node = () => ({
    children: [], attrs: {}, listeners: {},
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
    setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(k, f) { this.listeners[k] = f; },
  });
  const render = runInNewContext(`(${renderer})`, {
    App, navigator, EvidenceFeed: { sourceLink },
    formatFullDdMmYyyy: iso => iso.split("-").reverse().join("/"),
    document: {
      createElement: node,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, node());
        return elements.get(id);
      },
    },
  });
  const many = { ...payload, items: [
    ...Array.from({ length: 7 }, (_, i) => ({ source: "pubmed", source_id: String(10000000 + i), title: `PubMed ${i}`, source_date: "2026-01-19" })),
    ...Array.from({ length: 3 }, (_, i) => ({ source: "clinicaltrials", source_id: `NCT0000000${i}`, title: `Trial ${i}` })),
  ] };
  App.evidenceFeed = { payload: many, fromCache: false };
  render();
  const filters = () => elements.get("dailyEvidenceFilters").children;
  const rows = () => elements.get("dailyEvidenceList").children;
  assert.deepEqual(filters().map(b => b.children[0]), ["All", "PubMed", "ClinicalTrials.gov"], "filters list only sources with items");
  assert.deepEqual(filters().map(b => b.children[1].textContent), [10, 7, 3], "filters show counts");
  assert.equal(filters()[0].attrs["aria-pressed"], "true");
  assert.equal(rows().length, 5, "five items by default");
  assert.equal(elements.get("dailyEvidenceMore").hidden, false);
  assert.equal(elements.get("dailyEvidenceMore").textContent, "Show more (5)");
  const meta = rows()[0].children[0].children[0];
  assert.equal(meta.children[0].textContent, "PubMed");
  assert.equal(meta.children[1].textContent, "19/01/2026", "source date shown as dd/mm/yyyy");
  elements.get("dailyEvidenceMore").onclick();
  assert.equal(rows().length, 10);
  assert.equal(elements.get("dailyEvidenceMore").hidden, true);
  filters()[2].listeners.click();
  assert.equal(rows().length, 3, "source filter narrows the list");
  assert.equal(rows()[0].children[0].children[0].children.length, 1, "missing date is omitted");
  App.currentLang = "vi";
  App.evidenceView = { source: "openfda", limit: 5 };
  render();
  assert.equal(App.evidenceView.source, "all", "empty filter falls back to all");
  assert.equal(elements.get("dailyEvidenceMore").textContent, "Xem thêm (5)");
  assert.equal(elements.get("dailyEvidenceDownloadLabel").textContent, "Tải Parquet");
  App.currentLang = "en";
  App.evidenceView = null;
  App.evidenceFeed = { payload, fromCache: false };
  const downloadHidden = () => {
    render();
    return elements.get("dailyEvidenceDownload").hidden;
  };
  assert.equal(downloadHidden(), false, "online network snapshot offers the download");
  navigator.onLine = false;
  assert.equal(downloadHidden(), false, "live loopback data offers the download even when offline");
  navigator.onLine = true;
  App.evidenceFeed.fromCache = true;
  assert.equal(downloadHidden(), true, "cached fallback hides the download even when online");
  console.log("Evidence feed checks passed (filters, counts, five items, show more, dates, VI/EN, download).");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
