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
  const render = runInNewContext(`(${renderer})`, {
    App, navigator, EvidenceFeed: { sourceLink },
    document: {
      createElement: () => ({ append() {} }),
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { replaceChildren() {} });
        return elements.get(id);
      },
    },
  });
  const downloadHidden = () => {
    render();
    return elements.get("dailyEvidenceDownload").hidden;
  };
  assert.equal(downloadHidden(), false, "online network snapshot offers the download");
  navigator.onLine = false;
  assert.equal(downloadHidden(), true, "going offline hides the download even with a live snapshot");
  navigator.onLine = true;
  App.evidenceFeed.fromCache = true;
  assert.equal(downloadHidden(), true, "cached fallback hides the download even when online");
  console.log("Evidence feed checks passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
