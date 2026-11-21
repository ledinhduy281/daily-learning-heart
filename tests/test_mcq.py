import copy
import unittest
from unittest.mock import patch

import fetch_daily_ebm as app
from clinical_mcq import normalized


class ClinicalMcqTests(unittest.TestCase):
    def test_key_positions_vary_within_each_quiz(self):
        from socratic_quiz import turn
        for b in self.briefings:
            for lang in ('vi', 'en'):
                _, state, _ = turn(b, {}, lang, 'start_diagnostic')
                keys = []
                for _ in range(4):
                    keys.append(state['correct_key'])
                    _, state, _ = turn(b, state, lang, 'answer', selected_choice=state['correct_key'])
                self.assertEqual(set(keys), set('ABCD'), (b['id'], lang, keys))

    def test_icd_threshold_retains_population_and_risk_criteria(self):
        b = next(b for b in self.briefings if b['id'] == 'ebm-2026-08-25-p6-hist1')
        for lang in ('vi', 'en'):
            q = app._build_socratic_mcq(b, 0, 0, lang)
            correct = next(o['text'] for o in q['options'] if o['key'] == q['correct_key'])
            for criterion in ('DCM/HNDCM', '≤35%', '>35%', 'CMR-LGE', 'LMNA', 'FLNC', 'PLN', 'RBM20'):
                self.assertIn(criterion, correct)
            self.assertNotIn('threshold', q['question'])

    def test_safety_reverses_the_selected_clause(self):
        from clinical_distractors import rich_cards
        from clinical_mcq import alternatives
        b = next(b for b in self.briefings if any(t['name'] == 'EXPLORER-HCM' for t in b['landmark_trials']))
        cards = rich_cards(b, 'en', alternatives)
        traps = [text for card in cards for typ, text in zip(card['types'], card['texts']) if typ == 'safety']
        explorer = [text for text in traps if text.startswith('EXPLORER-HCM:')]
        self.assertTrue(explorer)
        self.assertTrue(all('Use strong' in text and 'Mandatory echocardiographic' not in text for text in explorer))

    @classmethod
    def setUpClass(cls):
        cls.briefings = app.load_existing_briefings()

    def assert_question(self, question):
        self.assertTrue(question['question'])
        options = question['options']
        self.assertEqual([o['key'] for o in options], list('ABCD'))
        self.assertEqual(len({normalized(o['text']) for o in options}), 4)
        correct = [o for o in options if o['key'] == question['correct_key']]
        self.assertEqual(len(correct), 1)
        self.assertIn(correct[0]['text'], question['explanation'])
        self.assertIn(question['correct_key'], question['explanation'])
        self.assertEqual(set(question['option_kinds']), set('ABCD'))
        self.assertEqual(set(question['option_kinds'].values()), {question['question_kind']})
        if question['question_kind'] in ('trial', 'guideline'):
            self.assertTrue(all(':' in o['text'] for o in options))
            self.assertTrue(all(o['text'].endswith('.') for o in options))
            self.assertTrue(all(';' not in o['text'] for o in options))
            self.assertNotIn('Xóa bỏ hoàn toàn định kiến', str(options))
            if question['question_kind'] == 'guideline':
                self.assertTrue(any(word in question['question'] for word in ('khuyến cáo', 'ngưỡng', 'guideline', 'threshold')))
                self.assertEqual(len({o['text'].split(':')[0] for o in options}), 1)
                self.assertTrue(all(o['text'].startswith(('Khuyến cáo: ', 'Recommendation: ')) for o in options))
                self.assertNotIn('primary endpoint', str(options))
                self.assertNotIn('Tiêu chí chính', str(options))
                self.assertTrue(set(question['distractor_types'].values()) <= {'old_guideline', 'numeric'})
            else:
                self.assertTrue(any(word in question['question'] for word in ('thử nghiệm', 'trial')))
                self.assertNotIn('Khuyến cáo: ', str(options))
                self.assertNotIn('Recommendation: ', str(options))
                self.assertNotIn('old_guideline', question['distractor_types'].values())
        for option in options:
            self.assertNotIn('...', option['text'])
            self.assertNotIn('…', option['text'])
            self.assertIn(option['key'] + ':', question['explanation'] if option not in correct else option['key'] + ':')
        whole = normalized(str(question))
        for banned in ['tang gap doi lieu khoi dau', 'ngung toan bo thuoc bao ve tim mach',
                       'double the initiating bolus', 'stop all cardioprotective',
                       'reserve guideline directed pharmacotherapy strictly for inpatients']:
            self.assertNotIn(banned, whole)

    def test_all_briefings_both_languages(self):
        self.assertTrue(self.briefings)
        letters = set()
        for briefing in self.briefings:
            for lang in ('vi', 'en'):
                for slot in range(4):
                    for variant in range(3):
                        with self.subTest(id=briefing['id'], lang=lang, slot=slot, variant=variant):
                            q = app._build_socratic_mcq(briefing, slot, variant, lang)
                            self.assert_question(q)
                            self.assertEqual(q, app._build_socratic_mcq(briefing, slot, variant, lang))
                            letters.add(q['correct_key'])
        self.assertEqual(letters, set('ABCD'))

    @patch('urllib.request.urlopen', side_effect=AssertionError('Quiz must stay local'))
    def test_stored_question_wrong_and_tell_me(self, network):
        for briefing in self.briefings:
            for lang in ('vi', 'en'):
                request = {'briefing_id': briefing['id'], 'lang': lang, 'action': 'start_diagnostic'}
                first = app.handle_socratic_turn(request)
                state = first['state']
                self.assert_question(state['current_question'])
                self.assertEqual(state['correct_key'], state['current_question']['correct_key'])
                self.assertEqual(state['explanation'], state['current_question']['explanation'])
                wrong_key = next(k for k in 'ABCD' if k != state['correct_key'])
                for action in ('answer', 'just_tell_me'):
                    mutated = copy.deepcopy(state)
                    mutated['question_index'] = 97
                    mutated['attempts_on_current'] = 19
                    result = app.handle_socratic_turn({**request, 'action': action, 'state': mutated, 'selected_choice': wrong_key})
                    self.assertEqual(result['correct_key'], first['correct_key'])
                    self.assertEqual(result['state']['current_question'], state['current_question'])
                    self.assertIn(state['explanation'], result['reply_markdown'])
                advanced = app.handle_socratic_turn({**request, 'action': 'answer', 'state': state, 'selected_choice': state['correct_key']})
                self.assertEqual(advanced['eval'], 'correct')
                self.assertIn(state['explanation'], advanced['reply_markdown'])
                self.assert_question(advanced['state']['current_question'])
        network.assert_not_called()

    def test_empty_and_legacy_state(self):
        for lang in ('vi', 'en'):
            self.assert_question(app._build_socratic_mcq({}, 0, 0, lang))
            result = app.handle_socratic_turn({'lang': lang, 'action': 'just_tell_me', 'state': {'correct_key': 'A'}})
            self.assertIn('restart' if lang == 'en' else 'bắt đầu lại', result['reply_markdown'])
        with patch.object(app, 'load_existing_briefings', return_value=[]):
            self.assertFalse(app.handle_socratic_turn({})['ok'])

    def test_supported_distractors_are_diverse_and_source_attributed(self):
        hf = next(b for b in self.briefings if b['pillar_id'] == 5 and '-main' in b['id'])
        pah = next(b for b in self.briefings if b['id'] == 'ebm-2026-09-03-p9-hist2')
        for lang in ('vi', 'en'):
            trial = app._build_socratic_mcq(hf, 1, 0, lang)
            self.assertIn('population', trial['distractor_types'].values())
            self.assertIn('safety', trial['distractor_types'].values())
            self.assertEqual(len(set(trial['distractor_types'].values())), 3)
            self.assertNotIn('numeric', trial['distractor_types'].values())
            self.assertLess(len(trial['question']), 150)
            guideline = app._build_socratic_mcq(pah, 0, 0, lang)
            self.assertIn('old_guideline', guideline['distractor_types'].values())
            self.assertGreaterEqual(len(set(guideline['distractor_types'].values())), 2)
            old = pah['guideline_evolution']['steps'][0]
            self.assertTrue(all('mPAP' in o['text'] for o in guideline['options']))
            self.assertTrue(any('≥ 25' in o['text'] for o in guideline['options']))
            self.assertIn(old['era_label_' + lang], guideline['explanation'])
        af = next(b for b in self.briefings if b['pillar_id'] == 6 and '-main' in b['id'])
        for lang in ('vi', 'en'):
            question = app._build_socratic_mcq(af, 1, 0, lang)
            self.assertIn('endpoint', question['distractor_types'].values())
            self.assertIn('ADVENT', question['explanation'])
            self.assertIn('safety', question['distractor_types'].values())
            if lang == 'en':
                correct = next(o['text'] for o in question['options'] if o['key'] == question['correct_key'])
                self.assertIn(af['landmark_trials'][0]['endpoint_label'], correct)
                self.assertNotIn('cuts CV death and stroke by 21%', correct)

    def test_explicit_drug_safety_and_numeric_fallback(self):
        primary = {'landmark_trials': [{'name': 'EMPEROR-Preserved', 'value': 'HR 0.79',
                   'endpoint_label': 'CV Death or First HF Hospitalization', 'changes_en': 'Empagliflozin in HFpEF.'}]}
        fact = 'Do not initiate finerenone if eGFR < 25 mL/min/1.73 m².'
        primary['drugs'] = [{'name': 'Finerenone', 'contraindication_en': fact}]
        question = app._build_socratic_mcq(primary, 1, 0, 'en')
        self.assertIn('safety', question['distractor_types'].values())
        self.assertIn(fact, question['explanation'])
        for empty in ([], None, ['invalid']):
            primary['drugs'] = empty
            question = app._build_socratic_mcq(primary, 1, 0, 'en')
            self.assertNotIn('safety', question['distractor_types'].values())
            self.assertIn('numeric', question['distractor_types'].values())


if __name__ == '__main__':
    unittest.main()
