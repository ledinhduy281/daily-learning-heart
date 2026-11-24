import unittest
from io import BytesIO
from unittest.mock import patch

from pipeline import lesson_sources as sources


# Reduced JATS recording: Sun et al., JAMA Network Open,
# https://pmc.ncbi.nlm.nih.gov/articles/PMC12254891/ (CC BY 4.0).
PMID, PMCID = "40643915", "PMC12254891"
LICENSE = b"https://creativecommons.org/licenses/by/4.0/"
ARTICLE = b"""<article><front><article-meta>
<article-id pub-id-type="pmcid">PMC12254891</article-id>
<article-id pub-id-type="pmid">40643915</article-id>
<article-id pub-id-type="doi">10.1001/jamanetworkopen.2025.19604</article-id>
<title-group><article-title>Intensive Systolic Blood Pressure Reduction and Kidney and Cardiovascular Outcomes</article-title></title-group>
<contrib-group><contrib contrib-type="author"><name><surname>Sun</surname><given-names>Guozhe</given-names></name></contrib></contrib-group>
<permissions><license>
<ali:license_ref xmlns:ali="http://www.niso.org/schemas/ali/1.0/" specific-use="textmining">https://creativecommons.org/licenses/by/4.0/</ali:license_ref>
<license-p>This is an open access article distributed under the terms of the CC-BY License.</license-p>
</license></permissions>
<abstract><sec><title>Results</title><p>A total of 33 332 patients with a baseline eGFR of 60 mL/min/1.73 m<sup>2</sup> or greater were included in this subgroup analysis (mean [SD] age, 62.8 [9.1] years; 61.3% female). After 36 months of follow-up, in 7562 participants with eGFRs between 60 and 90 mL/min/1.73 m<sup>2</sup>, 121 participants in the intervention group and 101 in the usual care group (risk ratio, 1.17; 95% CI, 0.82-1.62; P = .36) experienced kidney outcome, which was not statistically significant. As for cardiovascular outcomes, 210 participants (2.0% per year) in the intervention group and 346 participants (3.3% per year) in the usual care group had the composite cardiovascular disease outcome, and the disparity between the 2 groups was statistically significant (hazard ratio, 0.57; 95% CI, 0.47-0.68; P &lt; .001).</p></sec></abstract>
</article-meta></front></article>"""
SEARCH = {"resultList": {"result": [{"source": "MED", "pmid": PMID, "pmcid": PMCID}]}}


class LessonSourceTests(unittest.TestCase):
    @patch.object(sources, "urlopen", return_value=BytesIO(ARTICLE))
    @patch.object(sources, "get_json", return_value=SEARCH)
    def test_fetch_resolves_exact_id_and_preserves_recorded_prose(self, search, open_xml):
        article = sources.fetch_article(PMID)
        self.assertEqual(article.url, f"https://pmc.ncbi.nlm.nih.gov/articles/{PMCID}/")
        self.assertEqual(article.authors, ("Guozhe Sun",))
        self.assertEqual(article.doi, "10.1001/jamanetworkopen.2025.19604")
        self.assertEqual(article.license_url, LICENSE.decode())
        passage, = article.passages
        self.assertEqual((passage.locator, passage.role), ("abstract[1]/sec[1]/p[1]", "results"))
        self.assertIn("1.73 m2 or greater", passage.text)
        self.assertTrue(passage.text.endswith("(hazard ratio, 0.57; 95% CI, 0.47-0.68; P < .001)."))
        self.assertIn(f"EXT_ID:{PMID} AND OPEN_ACCESS:Y", search.call_args.args[1]["query"])
        self.assertTrue(open_xml.call_args.args[0].full_url.endswith(f"/{PMCID}/fullTextXML"))

    @patch.object(sources, "urlopen")
    @patch.object(sources, "get_json", return_value={"resultList": {"result": [
        {"source": "MED", "pmid": "12345", "pmcid": PMCID},
        {"source": "MED", "pmid": PMID},
    ]}})
    def test_no_open_exact_match_does_not_fetch_full_text(self, search, open_xml):
        self.assertIsNone(sources.fetch_article(PMID))
        open_xml.assert_not_called()

    def test_cannot_quote_unknown_restricted_or_conflicting_rights(self):
        for data in (
            ARTICLE.replace(LICENSE, b""),
            ARTICLE.replace(LICENSE, b"https://creativecommons.org/licenses/by-nc-nd/4.0/"),
            ARTICLE.replace(b"This is an open access article", b"All rights reserved"),
            ARTICLE.replace(b"</permissions>", b"<license>Repository deposit only</license></permissions>"),
        ):
            with self.subTest(data=data[:80]):
                self.assertIsNone(sources.parse_article(data, PMID, PMCID))

    def test_response_identity_must_match_both_ids(self):
        with self.assertRaisesRegex(ValueError, "identifiers"):
            sources.parse_article(ARTICLE, PMID, "PMC999999")

    def test_recommendations_extracted_only_from_explicit_sections_and_cells(self):
        # Synthetic section and table structures; prose is not clinical content.
        body = b"""<body>
        <sec><title>Background</title><p>Exclude this.</p></sec>
        <sec><title>Primary prevention: Recommendations</title>
          <p>First, <bold>include</bold> the qualifier.</p>
          <list><list-item><p>Second recommendation.</p></list-item></list>
        </sec>
        <table-wrap><caption><title>Recommendations for prevention</title></caption>
          <table><thead><tr><th>Class</th><th>Recommendation</th></tr></thead>
          <tbody><tr><td>I</td><td>Preserve this condition.</td></tr>
          <tr><td colspan="2">Not a recommendation cell.</td></tr></tbody></table>
        </table-wrap></body>"""
        article = sources.parse_article(ARTICLE.replace(b"</article>", body + b"</article>"), PMID, PMCID)
        self.assertEqual(
            [passage.text for passage in article.passages if passage.role == "recommendation"],
            ["First, include the qualifier.", "Second recommendation.", "Preserve this condition."],
        )

    def test_local_permissions_exclude_third_party_recommendation(self):
        body = b"""<body><table-wrap>
        <caption><title>Recommendations</title></caption>
        <permissions><copyright-statement>All rights reserved</copyright-statement></permissions>
        <table><thead><tr><th>Recommendation</th></tr></thead>
        <tbody><tr><td>Third-party text.</td></tr></tbody></table>
        </table-wrap>
        <sec><title>Recommendations</title><p>Article-owned text.</p></sec></body>"""
        article = sources.parse_article(ARTICLE.replace(b"</article>", body + b"</article>"), PMID, PMCID)
        self.assertEqual([p.text for p in article.passages if p.role == "recommendation"], ["Article-owned text."])

    def test_table_cell_mapping_handles_row_headers_and_rejects_spans(self):
        body = b"""<body>
        <table-wrap><caption>Recommendations</caption>
          <table><thead><tr><th>Recommendation</th><th>Class</th></tr></thead>
          <tbody><tr><th>Row header recommendation.</th><td>IIa</td></tr></tbody></table>
        </table-wrap>
        <table-wrap><caption>Recommendations</caption>
          <table><thead><tr><th>Recommendation</th><th colspan="2">Evidence</th></tr></thead>
          <tbody><tr><th>Other recommendation.</th><td>IIa</td><td>B</td></tr></tbody></table>
        </table-wrap>
        <table-wrap><caption>Recommendations</caption>
          <table><thead><tr><th>Recommendation</th><th>Class</th></tr></thead>
          <tbody><tr><td rowspan="2">Ambiguous.</td><td>IIa</td></tr>
          <tr><td>B</td></tr></tbody></table>
        </table-wrap></body>"""
        article = sources.parse_article(ARTICLE.replace(b"</article>", body + b"</article>"), PMID, PMCID)
        self.assertEqual([p.text for p in article.passages if p.role == "recommendation"], ["Row header recommendation."])
