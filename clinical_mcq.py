"""Fact-preserving clinical MCQs: change one explicit threshold, class, or estimate."""
import re
import unicodedata

from clinical_distractors import is_trial, rich_cards, numeric_targets


def normalized(text):
    text = unicodedata.normalize('NFD', str(text).lower().replace('đ', 'd'))
    return re.sub(r'\W+', ' ', ''.join(c for c in text if unicodedata.category(c) != 'Mn')).strip()


def alternatives(text, numeric_only=False, target=None):
    """Return one documented fact and three single-variable, plausible near misses."""
    target = target or next((t for t in numeric_targets(text) if t['numeric'] or not numeric_only), None)
    if not target:
        return None
    start, end, original = target['start'], target['end'], target['value']
    if not target['numeric']:
        replacements = [x for x in ['I', 'IIa', 'IIb', 'III'] if x.lower() != original.lower()][:3]
    else:
        number = float(original.replace(',', '.'))
        decimals = len(re.split('[.,]', original)[1]) if re.search('[.,]', original) else 0
        delta = 0.1 if number < 2 and decimals else (0.5 if decimals and number < 10 else (5 if number >= 20 else 1))
        offsets = (-1, 1, 2) if number > delta else (1, 2, 3)
        if number >= 85:
            offsets = (-1, -2, -3)
        values = [number + delta * i for i in offsets]
        replacements = [f'{v:.{decimals}f}'.replace('.', ',' if ',' in original else '.') for v in values]
    return [(text, original)] + [(text[:start] + r + text[end:], r) for r in replacements]


def validated_source_items(primary):
    sources, rows = primary.get('quiz_source_texts'), primary.get('quiz_items')
    if primary.get('quiz_mode') != 'source_excerpt' or not isinstance(sources, dict) or not isinstance(rows, list):
        return []
    evolution = primary.get('guideline_evolution') or {}
    guideline = (evolution.get('current_guideline') or {}).get('pmid')
    evidence = primary.get('supporting_evidence') or {}
    allowed = {guideline}
    if (guideline and evolution.get('recommendation_id') and evidence.get('guideline_pmid') == guideline
            and evidence.get('recommendation_id') == evolution['recommendation_id']):
        allowed.add(evidence.get('pmid'))
    items = []
    for i, item in enumerate(rows):
        if not isinstance(item, dict):
            continue
        pmid, quote, answer, start, choices = (item.get(k) for k in ('pmid', 'quote', 'answer', 'start', 'distractors'))
        if not isinstance(pmid, str) or not re.fullmatch(r'[1-9][0-9]{0,8}', pmid) or pmid not in allowed:
            continue
        source = sources.get(pmid)
        if not isinstance(source, list) or not isinstance(quote, str) or not quote.strip() or quote not in source:
            continue
        if not isinstance(answer, str) or not answer or type(start) is not int or start < 0:
            continue
        end = start + len(answer)
        if quote[start:end] != answer or (start and quote[start - 1].isalnum()) or (end < len(quote) and quote[end].isalnum()):
            continue
        if not any(m.start() == start and m[0] == answer for m in re.finditer(r'[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?%?', quote)):
            continue
        if not isinstance(choices, list) or len(choices) != 3 or not all(
            isinstance(c, str) and re.fullmatch(r'[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?%?', c)
            and c.endswith('%') == answer.endswith('%') for c in choices
        ):
            continue
        if len({float(c.rstrip('%').replace(',', '')) for c in [answer, *choices]}) != 4:
            continue
        items.append((i, item))
    return items


def build_source_review_question(primary, slot_idx, question_index, lang, difficulty):
    sources = {}
    for i, item in validated_source_items(primary):
        sources.setdefault(item['quote'], f'source:{i}')
    if 0 <= question_index < len(sources):
        question = _source_mcq(primary, slot_idx, question_index, lang, difficulty, list(sources.values())[question_index])
        question['generation']['review_order'] = True
        return question
    return None


def matches_source_question(current, canonical):
    return bool(canonical and current['generation'].get('source_id') == canonical['generation']['source_id']
                and all(current.get(k) == canonical[k] for k in ('options', 'correct_key', 'source_quote', 'source_pmid')))


def migrate_source_review(primary, state, lang):
    current = state.get('current_question')
    ref = current.get('generation') if isinstance(current, dict) else None
    index = state.get('question_index', 0)
    if (not isinstance(ref, dict) or ref.get('review_order') or type(index) is not int or index < 0
            or ref.get('variant_idx') != index or type(ref.get('slot_idx')) is not int):
        return None
    slot, difficulty = ref['slot_idx'], ref.get('difficulty', 'normal')
    expected = build_source_review_question(primary, slot, index, lang, difficulty)
    if matches_source_question(current, expected):
        return index, expected, True, False
    old = _source_mcq(primary, slot, index, lang, difficulty, None)
    if not matches_source_question(current, old):
        return None
    passed = validated_source_items(primary)[:index]
    index = len({item['quote'] for _, item in passed})
    question = build_source_review_question(primary, slot, index, lang, difficulty)
    revealed = bool(state.get('question_revealed') is True and question and question['source_quote'] == current['source_quote'])
    return index, question, False, revealed


def _source_mcq(primary, slot_idx, variant_idx, lang, difficulty, source_id):
    items = [(f'source:{i}', item) for i, item in validated_source_items(primary)]
    available = [(i, item) for i, item in items if i == source_id] if source_id else items
    if not available:
        return None
    key, item = available[variant_idx % len(available)]
    answer, quote, start, pmid = (item[k] for k in ('answer', 'quote', 'start', 'pmid'))
    texts = [answer, *item['distractors']]
    offset = (variant_idx + variant_idx // 4) % 4
    order = [(i - offset) % 4 for i in range(4)]
    en = lang == 'en'
    correct = 'ABCD'[offset]
    prompt = 'Complete the verbatim source excerpt' if en else 'Điền vào chỗ trống trong trích đoạn nguyên văn'
    explanation = 'Correct answer' if en else 'Đáp án đúng'
    kind = 'guideline' if pmid == primary['guideline_evolution']['current_guideline']['pmid'] else 'trial'
    idx = 0 if kind == 'guideline' else 1
    return {
        'question': f'{prompt} (PMID {pmid}): {quote[:start]}____{quote[start + len(answer):]}',
        'options': [{'key': 'ABCD'[i], 'text': texts[n]} for i, n in enumerate(order)],
        'correct_key': correct,
        'explanation': f'{explanation}: {correct}. “{quote}” (PMID {pmid})',
        'source_quote': quote, 'source_pmid': pmid,
        'option_ids': {'ABCD'[i]: str(n) for i, n in enumerate(order)},
        'generation': {'slot_idx': slot_idx, 'variant_idx': variant_idx, 'source_id': key, 'difficulty': difficulty},
        'question_kind': kind, 'difficulty': difficulty, 'subskill_idx': idx,
        'required_subskills': sorted({0 if row['pmid'] == primary['guideline_evolution']['current_guideline']['pmid'] else 1
                                      for _, row in items}),
        'option_kinds': {c: kind for c in 'ABCD'},
        'distractor_types': {c: 'numeric' for c in 'ABCD' if c != correct},
    }


def build_mcq(primary, slot_idx, variant_idx, lang, difficulty='normal', source_id=None):
    if primary.get('quiz_mode') == 'source_excerpt':
        return _source_mcq(primary, int(slot_idx), int(variant_idx), lang, difficulty, source_id)
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

    peer_suffix = 'vi' if en else 'en'
    peer_facts = [
        [s.get('desc_' + peer_suffix, '') for s in ge.get('steps') or []],
        [(f'Kết quả được báo cáo là {t.get("value") or ""}.' if en else f'The reported result is {t.get("value") or ""}.') for t in trials if t.get('value')],
        [p.get('text_' + peer_suffix, '') for p in primary.get('pearls') or []],
        [t.get('caution_' + peer_suffix, '') for t in trials],
    ]

    slot = int(slot_idx) % 4
    candidates = []
    for source, fact, pool_idx, entry_idx in [(s, f, i, j) for i in (slot, 1, 0, 2, 3) for j, (s, f) in enumerate(pools[i])]:
        fact = ' '.join(str(fact or '').split())
        if not fact or '...' in fact or '…' in fact:
            continue
        if any(phrase in normalized(fact) for phrase in ('khong duoc dung', 'khong ngung', 'khong dung cac thuoc', 'never withdraw', 'never discontinue', 'do not stop')):
            continue
        peer = ' '.join(str(peer_facts[pool_idx][entry_idx] or '').split())
        local_targets = {t['id']: t for t in numeric_targets(fact)}
        remote_targets = {t['id']: t for t in numeric_targets(peer)}
        canonical = local_targets if en else remote_targets
        shared = [local_targets[i] for i in canonical if i in local_targets and i in remote_targets]
        variants = alternatives(fact, target=shared[0]) if shared else None
        if variants and len({normalized(t) for t, _ in variants}) == 4:
            candidates.append((source, variants, pool_idx, f'fact:{pool_idx}:{entry_idx}', shared))
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
        source, variants, subskill_idx, selected_id, shared = (available or candidates)[int(variant_idx) % len(available or candidates)]
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
    hard_choices = None
    if available:
        card = available[int(variant_idx) % len(available)]
        hard_choices = card['hard_choices']
        selected_id = card['source_id']
        kind = card['kind']
        subskill_idx = 0 if kind == 'guideline' else 1
        question, texts, reasons, types, choice_ids = (card[k] for k in ('question', 'texts', 'reasons', 'types', 'choice_ids'))
    if source_id and selected_id != source_id:
        return None
    if difficulty == 'hard':
        target = next((t for t in shared if t['numeric']), None) if candidates else None
        variants = alternatives(texts[0], target=target) if hard_choices is None and target else None
        if hard_choices:
            texts = [texts[0]] + [c[1] for c in hard_choices]
            reasons = [reasons[0]] + [c[2] for c in hard_choices]
            types = ['correct'] + [c[0] for c in hard_choices]
            choice_ids = ['correct'] + [c[3] for c in hard_choices]
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
