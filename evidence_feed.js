(function (root, factory) {
  "use strict";
  const feed = factory();
  if (typeof module === "object" && module.exports) module.exports = feed;
  else root.EvidenceFeed = feed;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const path = "data/pipeline/briefing.json";
  const key = "ebm_evidence_feed_v1";
  const idPatterns = {
    pubmed: /^[0-9]+$/,
    clinicaltrials: /^NCT[0-9]{8}$/,
    openfda: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
  };

  function sourceLink(item) {
    const id = item.source_id;
    if (typeof id !== "string" || !Object.hasOwn(idPatterns, item.source) || !idPatterns[item.source].test(id)) {
      return null;
    }
    if (item.source === "pubmed") return `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
    if (item.source === "clinicaltrials") return `https://clinicaltrials.gov/study/${id}`;
    return `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${id}`;
  }

  function valid(payload) {
    return payload?.schema_version === 1 && typeof payload.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(payload.date) &&
      Object.keys(idPatterns).every(source => {
        const status = payload.sources?.[source];
        return ["ok", "unavailable"].includes(status?.status) &&
          Number.isInteger(status.records) && status.records >= 0;
      }) &&
      Array.isArray(payload.items) && payload.items.length > 0 && payload.items.length <= 30 &&
      payload.items.every(item => item && typeof item.title === "string" && item.title.trim() && sourceLink(item));
  }

  async function load({ fetcher = globalThis.fetch, storage } = {}) {
    try {
      const response = await fetcher(path, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Briefing not available");
      const payload = await response.json();
      if (!valid(payload)) throw new Error("Invalid briefing");
      try { storage?.setItem(key, JSON.stringify(payload)); } catch (_) {}
      return { payload, fromCache: false };
    } catch (_) {
      try {
        const cached = JSON.parse(storage?.getItem(key) || "null");
        if (valid(cached)) return { payload: cached, fromCache: true };
      } catch (_) {}
      return null;
    }
  }

  return { load, sourceLink };
});
