import copy
import unittest
from unittest.mock import patch

import fetch_daily_ebm as app
from clinical_mcq import normalized


class ClinicalMcqTests(unittest.TestCase):
    def test_translation_uses_stored_question_identity_not_session_counters(self):
        from clinical_mcq import build_mcq, translate_mcq
        for b in self.briefings + [{}]:
            for slot in (0, 1):
                original = build_mcq(b, slot, 8, 'vi')
                translated = translate_mcq(b, original, 'en')
                self.assertIsNotNone(translated, b.get('id'))
                self.assertEqual(original['generation'], translated['generation'])
                self.assertEqual(original['correct_key'], translated['correct_key'])
                self.assertEqual(original, translate_mcq(b, translated, 'vi'))
        self.assertIsNone(translate_mcq({}, {}, 'en'))
        self.assertIsNone(translate_mcq({}, {'generation': {'slot_idx': 0, 'variant_idx': 8,
            'difficulty': 'normal', 'source_id': 'trial:missing'}}, 'en'))

    def test_difficulty_changes_support_and_distractor_similarity(self):
        for lang in ('vi', 'en'):
            b = next(b for b in self.briefings if b['id'] == 'ebm-2026-11-20-p5-main')
            easy, normal, hard = [app._build_socratic_mcq(b, 1, 0, lang, d) for d in ('easy', 'normal', 'hard')]
            self.assertEqual(len({q['question'] for q in (easy, normal, hard)}), 3)
            self.assertIn('Hint:' if lang == 'en' else 'Gợi ý:', easy['question'])
            self.assertIn(easy['correct_key'], easy['question'].split(':')[-1])
            self.assertEqual(easy['options'], normal['options'])
            self.assertNotEqual(hard['options'], normal['options'])
            self.assertEqual(set(hard['distractor_types'].values()), {'numeric'})
            for q in (easy, normal, hard):
                self.assertEqual(next(o['text'] for o in q['options'] if o['key'] == q['correct_key']),
                                 next(o['text'] for o in normal['options'] if o['key'] == normal['correct_key']))
        for d in ('easy', 'hard'):
            self.assertEqual(len(app._build_socratic_mcq({}, 0, 0, 'en', d)['options']), 4)

    def test_perfect_answers_finish_all_briefings_in_bounded_turns(self):
        from socratic_quiz import turn
        for b in self.briefings + [{}]:
            for lang in ('vi', 'en'):
                _, state, _ = turn(b, {'subskills': [{'level': 0} for _ in range(4)]}, lang, 'start_diagnostic')
                for _ in range(24):
                    _, state, _ = turn(b, state, lang, 'answer', selected_choice=state['correct_key'])
                    if state['phase'] == 'mastered':
                        break
                self.assertEqual(state['phase'], 'mastered', (b.get('id'), lang))
                self.assertTrue(all(state['subskills'][i]['level'] >= 4 for i in state['required_subskills']))

    def test_revealed_answers_do_not_earn_score_or_mastery(self):
        b = self.briefings[0]
        for lang in ('vi', 'en'):
            for reveal in ('just_tell_me', 'wrong'):
                req = {'briefing_id': b['id'], 'lang': lang, 'action': 'start_diagnostic'}
                first = app.handle_socratic_turn(req)
                choice = first['correct_key']
                shown = app.handle_socratic_turn({**req, 'state': first['state'],
                    'action': 'answer' if reveal == 'wrong' else reveal,
                    'selected_choice': 'B' if choice == 'A' else 'A'})
                self.assertTrue(shown['state']['question_revealed'])
                repeated = app.handle_socratic_turn({**req, 'state': shown['state'], 'action': 'answer',
                    'selected_choice': 'B' if choice == 'A' else 'A'})
                self.assertEqual(repeated['state']['answered_count'], shown['state']['answered_count'])
                out = app.handle_socratic_turn({**req, 'state': shown['state'], 'action': 'answer', 'selected_choice': choice})
                self.assertEqual(out['eval'], 'partial')
                self.assertEqual(out['state']['correct_count'], 0)
                self.assertEqual(out['state']['answered_count'], shown['state']['answered_count'])
                self.assertEqual(out['state']['subskills'], first['state']['subskills'])
                self.assertEqual(out['state']['last_delta'], 0)
                self.assertFalse(out['state']['question_revealed'])
                next_out = app.handle_socratic_turn({**req, 'state': out['state'], 'action': 'answer', 'selected_choice': out['correct_key']})
                self.assertEqual(next_out['state']['correct_count'], 1)

    def test_fallback_credits_the_actual_subskill(self):
        from socratic_quiz import turn
        b = next(b for b in self.briefings if b['id'] == 'ebm-2026-11-20-p5-main')
        for slot in (2, 3):
            initial = {'focus_idx': slot, 'subskills': [{'level': 0} for _ in range(4)]}
            _, state, _ = turn(b, initial, 'en', 'harder')
            self.assertEqual(state['current_question']['subskill_idx'], 1)
            _, state, _ = turn(b, state, 'en', 'answer', selected_choice=state['correct_key'])
            self.assertEqual([s.get('correct', 0) for s in state['subskills']], [0, 1, 0, 0])
            self.assertEqual(state['last_updated_idx'], 1)
            self.assertEqual(state['focus_idx'], (slot + 1) % 4)

    def test_guideline_items_are_not_trial_endpoints(self):
        from clinical_distractors import rich_cards
        from clinical_mcq import alternatives
        for b in self.briefings:
            for lang in ('vi', 'en'):
                cards = rich_cards(b, lang, alternatives)
                for card in cards:
                    if card['kind'] == 'trial':
                        self.assertFalse(any('ESC PAAD' in text or 'Consensus' in text for text in card['texts']))
        b = next(b for b in self.briefings if b['id'] == 'ebm-2026-11-14-p9-main')
        only_guideline = {'landmark_trials': [t for t in b['landmark_trials'] if 'Guidelines' in t['name']]}
        self.assertTrue(only_guideline['landmark_trials'])
        for lang in ('vi', 'en'):
            self.assertEqual(rich_cards(only_guideline, lang, alternatives), [])
            self.assertEqual(app._build_socratic_mcq(only_guideline, 1, 0, lang)['question_kind'], 'appraisal')

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

    def test_key_positions_do_not_follow_a_fixed_cycle(self):
        from socratic_quiz import turn
        for b in self.briefings:
            _, state, _ = turn(b, {}, 'en', 'start_diagnostic')
            idx = []
            for _ in range(16):
                idx.append('ABCD'.index(state['correct_key']))
                _, state, _ = turn(b, state, 'en', 'answer', selected_choice=state['correct_key'])
            steps = {(y - x) % 4 for x, y in zip(idx, idx[1:])}
            self.assertGreater(len(steps), 1, (b['id'], idx))

    def test_icd_threshold_retains_population_and_risk_criteria(self):
        b = next(b for b in self.briefings if b['id'] == 'ebm-2026-08-25-p6-hist1')
        for lang in ('vi', 'en'):
            q = app._build_socratic_mcq(b, 0, 0, lang)
            correct = next(o['text'] for o in q['options'] if o['key'] == q['correct_key'])
            for criterion in ('DCM/HNDCM', '<50%', '≥ 2', 'CMR-LGE', 'LMNA', 'FLNC', 'PLN', 'RBM20'):
                self.assertIn(criterion, correct)
            self.assertNotIn('threshold', q['question'])

    def test_pah_and_revascularization_keep_complete_eligibility(self):
        cases = [('ebm-2026-09-03-p9-hist2', ['mPAP >20', 'PAWP ≤15', 'PVR >2', 'ERA + PDE5i'],
                  ['KHÔNG có bệnh đồng mắc tim phổi', 'WITHOUT cardiopulmonary comorbidities']),
                 ('ebm-2026-08-30-p3-hist2', ['LVEF >35%', 'Class I', 'LOE A'],
                  ['3 nhánh có ý nghĩa chức năng', 'functionally significant three-vessel disease'])]
        for bid, common, translations in cases:
            b = next(b for b in self.briefings if b['id'] == bid)
            for lang, condition in zip(('vi', 'en'), translations):
                q = app._build_socratic_mcq(b, 0, 0, lang)
                correct = next(o['text'] for o in q['options'] if o['key'] == q['correct_key'])
                for criterion in common + [condition]:
                    self.assertIn(criterion, correct)
                self.assertIn(correct, q['explanation'])

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
