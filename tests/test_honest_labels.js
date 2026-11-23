const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");

const html = readFileSync(`${__dirname}/../index.html`, "utf8");

function extract(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${startMarker}`);
  const end = html.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end of ${startMarker}`);
  return html.slice(start, end + endMarker.length);
}

const i18nSource = extract("const I18N = {", "\n    };");
const helpers = [
  extract("function t(key) {", "\n    }"),
  extract("function tt(key, vars = {}) {", "\n    }"),
  extract("function briefingHasCitation(b) {", "\n    }"),
  extract("function rotationNoticeFor(b) {", "\n    }"),
  extract("function formatFullDdMmYyyy(iso) {", "\n    }"),
].join("\n");
const context = { App: { currentLang: "vi" } };
runInNewContext(`${i18nSource}\n${helpers}\nthis.I18N = I18N; this.rotationNoticeFor = rotationNoticeFor; this.briefingHasCitation = briefingHasCitation;`, context);
const { I18N, rotationNoticeFor, briefingHasCitation } = context;

assert.equal(I18N.vi.citationFound, "Đã tìm thấy trích dẫn");
assert.equal(I18N.en.citationFound, "Citation found");
assert.match(I18N.vi.citationFoundHint, /không phải thẩm định lâm sàng/);
assert.match(I18N.en.citationFoundHint, /not clinical verification/);
assert.match(I18N.vi.heroLead, /giáo trình xoay vòng/);
assert.match(I18N.en.heroLead, /rotating curriculum/);
assert.equal(I18N.vi.verifiedPubMed, undefined);
assert.equal(I18N.en.verifiedPubMed, undefined);

for (const lang of ["vi", "en"]) {
  for (const [key, value] of Object.entries(I18N[lang])) {
    assert.doesNotMatch(value, /\bverified\b|xác thực|cardiologist|bác sĩ tim mạch (đã )?(duyệt|thẩm định)/i, `${lang}.${key}`);
  }
}

for (const phrase of [
  "Xác thực NCBI PubMed", "Verified NCBI", "Step-0 Verified", "Nguồn Trích Dẫn Xác Thực",
  "Verified Traceable Sources", "are verified via", "đều đã đối chiếu mã PMID/DOI", "xác thực PubMed Step-0",
]) {
  assert.equal(html.includes(phrase), false, `index.html still contains "${phrase}"`);
}
assert.match(html, /id="articleVerifiedBadge"[^>]*><i class="fa-solid fa-link"><\/i> Đã tìm thấy trích dẫn<\/span>/);
assert.match(html, /id="articleRotationNotice" hidden/);

const redated = {
  date: "2026-11-22", content_source: "curated_library_rotation", curated_edition_date: "2026-11-12",
  pubmed_anchors: [{ pmid: "12345678" }],
};
assert.equal(
  rotationNoticeFor(redated),
  "Giáo trình xoay vòng: bài này được soạn sẵn ngày 12/11/2026 và hiển thị lại với ngày hôm nay khi đến lượt Trụ cột này; đây không phải tin mới trong ngày.",
);
context.App.currentLang = "en";
assert.match(rotationNoticeFor(redated), /^Rotating curriculum: this edition was written on 12\/11\/2026 .*not news from today\.$/);
assert.equal(rotationNoticeFor({ ...redated, curated_edition_date: "2026-11-22" }), "");
assert.equal(rotationNoticeFor({ ...redated, content_source: "model_draft" }), "");
assert.equal(briefingHasCitation(redated), true);
assert.equal(briefingHasCitation({ pubmed_anchors: [{ title: "No identifier" }] }), false);
assert.equal(briefingHasCitation({}), false);

console.log("honest label tests passed");
