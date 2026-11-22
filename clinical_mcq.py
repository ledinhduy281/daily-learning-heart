"""Fact-preserving clinical MCQs: change one explicit threshold, class, or estimate."""
import re
import unicodedata

from clinical_distractors import is_trial, rich_cards


def normalized(text):
    text = unicodedata.normalize('NFD', str(text).lower().replace('đ', 'd'))
    return re.sub(r'\W+', ' ', ''.join(c for c in text if unicodedata.category(c) != 'Mn')).strip()


def alternatives(text):
    """Return one documented fact and three single-variable, plausible near misses."""
    match = re.search(r'\bClass\s+(IIa|IIb|III|II|I)\b', text, re.I)
    if match:
        start, end = match.span(1)
        original = match.group(1)
        replacements = [x for x in ['I', 'IIa', 'IIb', 'III'] if x.lower() != original.lower()][:3]
    else:
        match = re.search(r'[<>≤≥]=?\s*([0-9]+(?:[.,][0-9]+)?)', text)
        if not match:
            match = re.search(r'([0-9]+(?:[.,][0-9]+)?)\s*%', text)
        if not match:
            match = re.search(r'(?:HR|RR|OR|Win Ratio)\s+([0-9]+(?:[.,][0-9]+)?)', text, re.I)
        if not match:
            return None
        start, end = match.span(1)
        original = match.group(1)
        number = float(original.replace(',', '.'))
        decimals = len(re.split('[.,]', original)[1]) if re.search('[.,]', original) else 0
        delta = 0.1 if number < 2 and decimals else (0.5 if decimals and number < 10 else (5 if number >= 20 else 1))
        offsets = (-1, 1, 2) if number > delta else (1, 2, 3)
        if number >= 85:
            offsets = (-1, -2, -3)
        values = [number + delta * i for i in offsets]
        replacements = [f'{v:.{decimals}f}'.replace('.', ',' if ',' in original else '.') for v in values]
    return [(text, original)] + [(text[:start] + r + text[end:], r) for r in replacements]


def build_mcq(primary, slot_idx, variant_idx, lang, difficulty='normal', source_id=None):
    en = lang == 'en'
    suffix = 'en' if en else 'vi'
    ge = primary.get('guideline_evolution') or {}
    trials = [t for t in primary.get('landmark_trials') or [] if is_trial(t)]
    pools = [[], [], [], []]
    for step in ge.get('steps') or []:
        pools[0].append((step.get('title_' + suffix, ''), step.get('desc_' + suffix, '')))
    for trial in trials:
        name = trial.get('name', '')
        value = trial.get('value', '')
        if value:
            text = f'The reported result is {value}.' if en else f'Kết quả được báo cáo là {value}.'
            pools[1].append((name, text))
        pools[3].append((name, trial.get('caution_' + suffix, '')))
    for pearl in primary.get('pearls') or []:
        pools[2].append((primary.get('title_' + suffix, ''), pearl.get('text_' + suffix, '')))

    slot = int(slot_idx) % 4
    candidates = []
    for source, fact, pool_idx, entry_idx in [(s, f, i, j) for i in (slot, 1, 0, 2, 3) for j, (s, f) in enumerate(pools[i])]:
        fact = ' '.join(str(fact or '').split())
        if not fact or '...' in fact or '…' in fact:
            continue
        if any(phrase in normalized(fact) for phrase in ('khong duoc dung', 'khong ngung', 'khong dung cac thuoc', 'never withdraw', 'never discontinue', 'do not stop')):
            continue
        variants = alternatives(fact)
        if variants and len({normalized(t) for t, _ in variants}) == 4:
            candidates.append((source, variants, pool_idx, f'fact:{pool_idx}:{entry_idx}'))
    subskill_idx = None
    selected_id = 'appraisal'
    if not candidates:
        question = ('A briefing lacks the trial population and safety criteria. What is the best next step before applying its result?' if en else
                    'Bản tin chưa nêu quần thể nghiên cứu và tiêu chí an toàn. Cần làm gì trước khi áp dụng kết quả?')
        texts = (['Check the full report for eligibility criteria and safety exclusions.',
                  'Use the effect estimate from another trial in the same drug class.',
                  'Use the abstract conclusion to set the starting dose.',
                  'Infer eligibility from the trial title.'] if en else
                 ['Đối chiếu báo cáo đầy đủ về tiêu chuẩn chọn bệnh và tiêu chí loại trừ vì an toàn.',
                  'Dùng ước lượng hiệu quả từ thử nghiệm khác của cùng nhóm thuốc.',
                  'Dựa vào kết luận tóm tắt để chọn liều khởi đầu.',
                  'Suy ra tiêu chuẩn chọn bệnh từ tên thử nghiệm.'])
        reasons = ([texts[0], 'An effect estimate does not establish eligibility.', 'A conclusion alone does not establish dosing.', 'A title does not define eligibility.'] if en else
                   [texts[0], 'Ước lượng hiệu quả không xác định tiêu chuẩn chọn bệnh.', 'Kết luận tóm tắt không đủ để xác định liều.', 'Tên thử nghiệm không xác định tiêu chuẩn chọn bệnh.'])
    else:
        available = [c for c in candidates if c[3] == source_id] if source_id else candidates
        source, variants, subskill_idx, selected_id = (available or candidates)[int(variant_idx) % len(available or candidates)]
        question = (f'According to {source}, which statement is correct?' if en else
                    f'Theo {source}, nhận định nào đúng?')
        texts = [t for t, _ in variants]
        reasons = [
            (f'The briefing reports {source}: {texts[0]}' if en else f'Bản tin nêu tại {source}: {texts[0]}')
        ] + [(f'This changes the documented parameter from {variants[0][1]} to {r}; the briefing does not support that value for this statement.' if en else
              f'Lựa chọn này đổi thông số được ghi nhận từ {variants[0][1]} thành {r}; bản tin không nêu giá trị này cho nhận định trên.') for _, r in variants[1:]]
    types = ['correct', 'numeric', 'numeric', 'numeric']
    kind = 'fact' if candidates else 'appraisal'
    choice_ids = ['correct', 'numeric:0', 'numeric:1', 'numeric:2']
    cards = rich_cards(primary, lang, alternatives)
    required = sorted({0 if c['kind'] == 'guideline' else 1 for c in cards} if cards else {c[2] for c in candidates})
    preferred = [c for c in cards if c['kind'] == ('guideline' if slot == 0 else 'trial')]
    available = [c for c in cards if c['source_id'] == source_id] if source_id else (preferred or cards)
    if available:
        card = available[int(variant_idx) % len(available)]
        selected_id = card['source_id']
        kind = card['kind']
        subskill_idx = 0 if kind == 'guideline' else 1
        question, texts, reasons, types, choice_ids = (card[k] for k in ('question', 'texts', 'reasons', 'types', 'choice_ids'))
    if source_id and selected_id != source_id:
        return None
    if difficulty == 'hard':
        variants = alternatives(texts[0])
        if variants and len({normalized(t) for t, _ in variants}) == 4:
            texts = [t for t, _ in variants]
            reasons = [reasons[0]] + [(f'The reported parameter is {variants[0][1]}, not {r}.' if en else
                                      f'Thông số được báo cáo là {variants[0][1]}, không phải {r}.') for _, r in variants[1:]]
            types = ['correct', 'numeric', 'numeric', 'numeric']
            choice_ids = ['correct', 'numeric:0', 'numeric:1', 'numeric:2']
        question = ('Precision check — ' if en else 'Kiểm tra thông số chính xác — ') + question
    # Stable shuffle shared with the offline implementation, independent of Python's hash seed.
    briefing_seed = sum(ord(c) for c in str(primary.get('id', '')))
    seed = briefing_seed + int(slot_idx) * 17 + int(variant_idx) * 31
    order = [0, 1, 2, 3]
    for i in range(3, 0, -1):
        seed = (seed * 1664525 + 1013904223) % 4294967296
        j = (seed >> 16) % (i + 1)
        order[i], order[j] = order[j], order[i]
    # Each block of four questions uses every letter once, in a per-block shuffled order.
    block_seed = briefing_seed * 7 + (int(variant_idx) // 4) * 131
    targets = [0, 1, 2, 3]
    for i in range(3, 0, -1):
        block_seed = (block_seed * 1664525 + 1013904223) % 4294967296
        j = (block_seed >> 16) % (i + 1)
        targets[i], targets[j] = targets[j], targets[i]
    target = targets[int(variant_idx) % 4]
    correct_position = order.index(0)
    order[target], order[correct_position] = order[correct_position], order[target]
    options = [{'key': 'ABCD'[i], 'text': texts[n]} for i, n in enumerate(order)]
    correct_key = 'ABCD'[order.index(0)]
    if difficulty == 'easy':
        choices = ', '.join('ABCD'[i] for i, n in enumerate(order) if n in (0, 1))
        question += (f' Hint: compare only options {choices}.' if en else f' Gợi ý: chỉ cần so sánh hai lựa chọn {choices}.')
    explanation = ('Correct answer: ' if en else 'Đáp án đúng: ') + correct_key + '. ' + reasons[0]
    explanation += ' ' + ' '.join(f'{"ABCD"[i]}: {reasons[n]}' for i, n in enumerate(order) if n != 0)
    return {'question': question, 'options': options, 'correct_key': correct_key, 'explanation': explanation,
            'option_ids': {'ABCD'[i]: choice_ids[n] for i, n in enumerate(order)},
            'generation': {'slot_idx': int(slot_idx), 'variant_idx': int(variant_idx), 'source_id': selected_id, 'difficulty': difficulty},
            'question_kind': kind, 'difficulty': difficulty, 'subskill_idx': subskill_idx, 'required_subskills': required, 'option_kinds': {o['key']: kind for o in options},
            'distractor_types': {'ABCD'[i]: types[n] for i, n in enumerate(order) if n != 0}}


def translate_mcq(primary, current, lang):
    ref = current.get('generation') if current else None
    if not ref or not current.get('option_ids'):
        return None
    translated = build_mcq(primary, ref['slot_idx'], ref['variant_idx'], lang, ref['difficulty'], ref['source_id'])
    return translated if translated and translated['option_ids'] == current['option_ids'] else None
