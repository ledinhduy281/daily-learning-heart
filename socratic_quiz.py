"""Deterministic question lifecycle shared by API tutoring helpers."""
import copy

from clinical_mcq import build_mcq


def turn(primary, state, lang, action, user_answer='', selected_choice=''):
    en = lang == 'en'
    state = copy.deepcopy(state)
    state.pop('revealed_source_pmid', None)
    choice = (selected_choice or user_answer).strip().upper().rstrip('.:)')
    current = state.get('current_question')
    valid = (isinstance(current, dict) and current.get('correct_key') in ('A', 'B', 'C', 'D')
             and len(current.get('options', [])) == 4 and bool(current.get('explanation')))
    if valid and primary.get('quiz_mode') == 'source_excerpt':
        ref = current.get('generation') or {}
        source = ref.get('source_id')
        slot, variant = ref.get('slot_idx'), ref.get('variant_idx')
        valid = isinstance(source, str) and source.startswith('source:') and type(slot) is int and type(variant) is int and variant >= 0
        if valid:
            canonical = build_mcq(primary, slot, variant, lang, ref.get('difficulty', 'normal'), source)
            valid = bool(canonical and all(current.get(k) == canonical[k] for k in ('options', 'correct_key', 'source_quote', 'source_pmid')))
            if valid:
                current = canonical
                state['current_question'] = canonical
    if action in ('answer', 'just_tell_me') and not valid:
        return ('Please restart the quiz; this saved question has no reliable answer rationale.' if en else
                'Vui lòng bắt đầu lại bài trắc nghiệm; câu đã lưu chưa có giải thích đáp án đáng tin cậy.'), state, 'partial'
    if action in ('answer', 'just_tell_me') and primary.get('quiz_mode') == 'source_excerpt':
        state['revealed_source_pmid'] = current['source_pmid']
    correct = valid and choice == current['correct_key']
    if action == 'just_tell_me' or (action == 'answer' and not correct):
        state.update(correct_key=current['correct_key'], explanation=current['explanation'],
                     current_options=current['options'], last_question=current['question'])
        if action == 'answer' and not state.get('question_revealed', False):
            state['answered_count'] = state.get('answered_count', 0) + 1
            state['attempts_on_current'] = state.get('attempts_on_current', 0) + 1
            state['streak'] = 0
        state.update(question_revealed=True, last_updated_idx=-1, last_delta=0, streak=0)
        state['last_eval'] = 'wrong' if action == 'answer' else 'partial'
        prefix = ('Review the same question. ' if en else 'Ôn lại chính câu hỏi này. ')
        return prefix + current['explanation'], state, state['last_eval']
    feedback = ''
    evaluation = 'partial' if state.get('question_revealed') else 'correct'
    if action == 'start_diagnostic':
        state.update(phase='diagnostic', diag_step=0, focus_idx=0, answered_count=0,
                     correct_count=0, attempts_on_current=0, streak=0, question_index=0)
        for skill in state.get('subskills', []):
            skill.update(level=0, checks=0, answered=0, correct=0)
    elif action == 'answer':
        feedback = current['explanation'] + '\n\n'
        idx = current.get('subskill_idx', {'guideline': 0, 'trial': 1}.get(current.get('question_kind')))
        skills = state.get('subskills') or []
        earned = not state.get('question_revealed', False)
        credit = earned and type(idx) is int and 0 <= idx < 4 and len(skills) == 4
        if credit:
            skills[idx]['level'] = min(5, max(2, skills[idx].get('level', 0) + 1))
            for key in ('checks', 'answered', 'correct'):
                skills[idx][key] = skills[idx].get(key, 0) + 1
        state['last_updated_idx'] = idx if credit else -1
        state['last_delta'] = 1 if credit else 0
        state['answered_count'] = state.get('answered_count', 0) + int(earned)
        state['correct_count'] = state.get('correct_count', 0) + int(earned)
        state['streak'] = state.get('streak', 0) + 1 if earned else 0
        state['attempts_on_current'] = 0
        state['focus_idx'] = (int(state.get('focus_idx', 0)) + 1) % 4
        state['diag_step'] = min(3, state.get('diag_step', 0) + 1)
        state['question_index'] = state.get('question_index', 0) + 1
        if state['question_index'] >= 4 and state.get('phase') != 'final_exam':
            state['phase'] = 'loop'
        required = current.get('required_subskills', list(range(4)))
        if earned and state['question_index'] >= 4 and len(skills) == 4 and all(skills[i]['level'] >= 4 for i in required):
            if state.get('phase') == 'final_exam':
                state.update(phase='mastered', current_options=[], correct_key='', explanation='', current_question=None)
                return feedback + ('Review complete.' if en else 'Hoàn tất ôn tập.'), state, 'correct'
            state['phase'] = 'final_exam'
    elif action in ('harder', 'easier'):
        state['difficulty'] = 'hard' if action == 'harder' else 'easy'
        state['question_index'] = state.get('question_index', 0) + 1
    question = build_mcq(primary, state.get('focus_idx', 0), state.get('question_index', 0), lang, state.get('difficulty', 'normal'))
    if not question:
        state.update(current_question=None, correct_key='', explanation='', current_options=[], last_question='')
        return ('No source-supported questions are available for this lesson.' if en else
                'Bài này chưa có câu hỏi đối chiếu được với nguồn gốc.'), state, 'partial'
    state.update(current_question=question, correct_key=question['correct_key'], explanation=question['explanation'],
                 required_subskills=question['required_subskills'],
                 current_options=question['options'], last_question=question['question'], options_lang=lang,
                 question_revealed=False, last_eval=evaluation if action == 'answer' else '')
    return feedback + question['question'], state, evaluation if action == 'answer' else 'start'
