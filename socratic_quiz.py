"""Deterministic question lifecycle shared by API tutoring helpers."""
import copy

from clinical_mcq import build_mcq


def turn(primary, state, lang, action, user_answer='', selected_choice=''):
    en = lang == 'en'
    state = copy.deepcopy(state)
    choice = (selected_choice or user_answer).strip().upper().rstrip('.:)')
    current = state.get('current_question')
    valid = (isinstance(current, dict) and current.get('correct_key') in ('A', 'B', 'C', 'D')
             and len(current.get('options', [])) == 4 and bool(current.get('explanation')))
    if action in ('answer', 'just_tell_me') and not valid:
        return ('Please restart the quiz; this saved question has no reliable answer rationale.' if en else
                'Vui lòng bắt đầu lại bài trắc nghiệm; câu đã lưu chưa có giải thích đáp án đáng tin cậy.'), state, 'partial'
    correct = valid and choice == current['correct_key']
    if action == 'just_tell_me' or (action == 'answer' and not correct):
        state.update(correct_key=current['correct_key'], explanation=current['explanation'],
                     current_options=current['options'], last_question=current['question'])
        if action == 'answer':
            state['answered_count'] = state.get('answered_count', 0) + 1
            state['attempts_on_current'] = state.get('attempts_on_current', 0) + 1
            state['streak'] = 0
        state['last_eval'] = 'wrong' if action == 'answer' else 'partial'
        prefix = ('Review the same question. ' if en else 'Ôn lại chính câu hỏi này. ')
        return prefix + current['explanation'], state, state['last_eval']
    feedback = ''
    if action == 'start_diagnostic':
        state.update(phase='diagnostic', diag_step=0, focus_idx=0, answered_count=0,
                     correct_count=0, attempts_on_current=0, streak=0, question_index=0)
        for skill in state.get('subskills', []):
            skill.update(level=0, checks=0, answered=0, correct=0)
    elif action == 'answer':
        feedback = current['explanation'] + '\n\n'
        idx = int(state.get('focus_idx', 0)) % 4
        skills = state.get('subskills') or []
        if len(skills) == 4:
            skills[idx]['level'] = min(5, max(2, skills[idx].get('level', 0) + 1))
            for key in ('checks', 'answered', 'correct'):
                skills[idx][key] = skills[idx].get(key, 0) + 1
        state['last_updated_idx'] = idx
        state['last_delta'] = 1
        state['answered_count'] = state.get('answered_count', 0) + 1
        state['correct_count'] = state.get('correct_count', 0) + 1
        state['streak'] = state.get('streak', 0) + 1
        state['attempts_on_current'] = 0
        state['focus_idx'] = (idx + 1) % 4
        state['diag_step'] = min(3, state.get('diag_step', 0) + 1)
        state['question_index'] = state.get('question_index', 0) + 1
        if state['question_index'] >= 4 and state.get('phase') != 'final_exam':
            state['phase'] = 'loop'
        if len(skills) == 4 and all(s['level'] >= 4 for s in skills):
            if state.get('phase') == 'final_exam':
                state.update(phase='mastered', current_options=[], correct_key='', explanation='', current_question=None)
                return feedback + ('Review complete.' if en else 'Hoàn tất ôn tập.'), state, 'correct'
            state['phase'] = 'final_exam'
    elif action in ('harder', 'easier'):
        state['difficulty'] = 'hard' if action == 'harder' else 'easy'
        state['question_index'] = state.get('question_index', 0) + 1
    question = build_mcq(primary, state.get('focus_idx', 0), state.get('question_index', 0), lang, state.get('difficulty', 'normal'))
    state.update(current_question=question, correct_key=question['correct_key'], explanation=question['explanation'],
                 current_options=question['options'], last_question=question['question'], options_lang=lang,
                 last_eval='correct' if action == 'answer' else '')
    return feedback + question['question'], state, 'correct' if action == 'answer' else 'start'
