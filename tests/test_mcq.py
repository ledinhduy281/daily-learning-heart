import copy
import unittest
from unittest.mock import patch

import fetch_daily_ebm as app
from clinical_mcq import normalized


class ClinicalMcqTests(unittest.TestCase):
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
            self.assertIn(old['desc_' + lang], str(guideline['options']))
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
