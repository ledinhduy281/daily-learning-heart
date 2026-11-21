import io
import json
import unittest
from unittest.mock import patch

import fetch_daily_ebm as app
from search_ranking import normalize, score


class SearchTests(unittest.TestCase):
    def test_real_briefings(self):
        data = app.load_existing_briefings()
        self.assertTrue(data)
        for query, accented in [('suy tim', 'suy tim'), ('tang huyet ap', 'tăng huyết áp'), ('rung nhi', 'rung nhĩ')]:
            with self.subTest(query=query):
                ranked = sorted(data, key=lambda b: score(b, query), reverse=True)
                self.assertIn(normalize(accented), normalize(ranked[0]['title_vi']))
                self.assertEqual([score(b, query) for b in data], [score(b, accented) for b in data])
        for abbr, term in [('AF', 'atrial fibrillation'), ('HFpEF', 'heart failure with preserved ejection fraction'), ('HFrEF', 'heart failure with reduced ejection fraction'), ('ACS', 'acute coronary syndrome'), ('SGLT2i', 'sglt2 inhibitors'), ('ARNI', 'angiotensin receptor neprilysin inhibitor'), ('GDMT', 'guideline directed medical therapy')]:
            self.assertEqual([score(b, abbr) for b in data], [score(b, term) for b in data])
            self.assertGreater(max(score(b, abbr) for b in data), 0)

    def test_fields_empty_boundaries_and_context(self):
        self.assertEqual(normalize('Đái tháo đường'), 'dai thao duong')
        self.assertEqual(score({}, ''), 0)
        self.assertEqual(score({'title_en': 'safety'}, 'AF'), 0)
        for field in ['title_en', 'guideline_evolution', 'landmark_trials', 'drug_names', 'pearls']:
            self.assertGreater(score({field: 'finerenone'}, 'finerenone'), score({'part2_en_markdown': 'finerenone'}, 'finerenone'))
        self.assertGreater(score({'title_en': 'finerenone heart failure'}, 'finerenone heart failure'), score({'title_en': 'finerenone'}, 'finerenone heart failure'))
        self.assertEqual(app._score_briefing_for_chat({'id': 'x'}, '', 'x'), 60)
        self.assertGreater(app._score_briefing_for_chat({'pillar_id': 2}, 'pillar 2'), app._score_briefing_for_chat({'pillar_id': 1}, 'pillar 2'))

    def test_pubmed_groups(self):
        q = app._build_pubmed_chat_query('suy tim SGLT2i dapagliflozin')
        self.assertIn(') AND (', q)
        self.assertIn('[MeSH Terms]', q)
        self.assertIn('[tiab]', q)
        self.assertIn('2022:2026[dp]', q)
        self.assertNotIn('AND 2026[dp]', q)

    @patch('urllib.request.urlopen')
    def test_fallback_and_rerank(self, network):
        xml = '<PubmedArticleSet>'
        for pmid, title in [('1', 'Unrelated hypertension'), ('2', 'Dapagliflozin heart failure')]:
            xml += f'<PubmedArticle><MedlineCitation><PMID>{pmid}</PMID><Article><ArticleTitle>{title}</ArticleTitle><Abstract><AbstractText>{title}</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>'
        xml += '</PubmedArticleSet>'
        network.side_effect = [io.BytesIO(json.dumps({'esearchresult': {'idlist': []}}).encode()), io.BytesIO(json.dumps({'esearchresult': {'idlist': ['1', '2']}}).encode()), io.BytesIO(xml.encode())]
        hits = app._fetch_pubmed_with_abstracts(app._build_pubmed_chat_query('suy tim dapagliflozin'), 1, 'suy tim dapagliflozin')
        self.assertEqual(hits[0]['pmid'], '2')
        self.assertNotIn('2022', network.call_args_list[1].args[0].full_url)

    @patch('urllib.request.urlopen')
    def test_network_empty_and_error(self, network):
        self.assertEqual(app._fetch_pubmed_with_abstracts(''), [])
        network.return_value = io.BytesIO(b'{"esearchresult":{"idlist":[]}}')
        self.assertEqual(app._fetch_pubmed_with_abstracts('cardiology'), [])
        network.side_effect = OSError('mock offline')
        self.assertEqual(app._fetch_pubmed_with_abstracts('cardiology'), [])


if __name__ == '__main__':
    unittest.main()
