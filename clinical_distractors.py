"""Conservative, source-attributed clinical distractors; no invented patient data."""
import re
import unicodedata


ENDPOINT_VI = {
    'CV Death or First HF Hospitalization': 'Tử vong tim mạch hoặc nhập viện suy tim lần đầu',
    'Worsening HF or Cardiovascular Death': 'Suy tim nặng lên hoặc tử vong tim mạch',
    'Total Worsening HF Events & Cardiovascular Death': 'Tổng số biến cố suy tim nặng lên và tử vong tim mạch',
    'CV Death, Stroke, or Hospitalization for Worsening HF or ACS': 'Tử vong tim mạch, đột quỵ hoặc nhập viện vì suy tim nặng lên hay hội chứng mạch vành cấp',
    '12-Month Freedom from Procedural Failure, AT/AF Recurrence, AAD, or Repeat Ablation': 'Không thất bại thủ thuật, tái phát nhịp nhanh nhĩ/rung nhĩ, dùng thuốc chống loạn nhịp hoặc triệt đốt lại trong 12 tháng',
}


def rich_cards(primary, lang, numeric_alternatives):
    en = lang == 'en'
    suffix = 'en' if en else 'vi'
    trials = primary.get('landmark_trials') or []
    steps = (primary.get('guideline_evolution') or {}).get('steps') or []
    cards = []

    def clean(s):
        s = ' '.join(str(s or '').split())
        return '' if '...' in s or '…' in s else s

    def normalized(s):
        s = unicodedata.normalize('NFD', clean(s).lower().replace('đ', 'd'))
        return re.sub(r'[^a-z0-9]+', ' ', ''.join(c for c in s if unicodedata.category(c) != 'Mn')).strip()

    def safety(text):
        patterns = ([(r'\bDo not initiate\b', 'Initiate'), (r'\bNever discontinue\b', 'Discontinue'),
                     (r'\bNever withdraw\b', 'Withdraw'), (r'(^|;\s*)avoid\b', r'\1Use')]
                    if en else [(r'Không được dừng', 'Có thể dừng'), (r'Tuyệt đối không ngừng', 'Có thể ngừng'),
                                (r'Tuyệt đối không khởi trị', 'Có thể khởi trị'), (r'Không kê đơn', 'Có thể kê đơn'),
                                (r'Không khởi trị', 'Có thể khởi trị'), (r'tránh phối hợp', 'có thể phối hợp')])
        for pattern, replacement in patterns:
            changed, count = re.subn(pattern, replacement, text, count=1, flags=re.I)
            if count:
                return changed
        return ''

    traps = []
    for t in trials:
        caution = clean(t.get('caution_' + suffix))
        changed = safety(caution)
        if changed:
            source = t.get('name', '')
            traps.append(('safety', f'{source}: {changed}',
                          (f'This reverses the safety instruction for {source}: {caution}' if en else
                           f'Lựa chọn này đảo ngược lưu ý an toàn của {source}: {caution}')))
    for p in primary.get('pearls') or []:
        fact = clean(p.get('text_' + suffix))
        changed = safety(fact)
        if changed:
            traps.append(('safety', changed, (f'The clinical pearl instead states: {fact}' if en else f'Điểm thực hành nêu điều ngược lại: {fact}')))
    drugs = primary.get('drugs') or []
    for drug in drugs if isinstance(drugs, list) else []:
        if not isinstance(drug, dict):
            continue
        fact = clean(drug.get('contraindication_' + suffix) or drug.get('caution_' + suffix))
        changed = safety(fact)
        if changed:
            name = drug.get('name', '')
            traps.append(('safety', f'{name}: {changed}', (f'{name}: {fact}' if en else f'Lưu ý của {name}: {fact}')))

    def endpoint_signature(label):
        patterns = [('death', r'death|mortality|mace'), ('stroke', r'stroke|mace'),
                    ('mi', r'infarction|\bmi\b|mace'), ('hf', r'\bhf\b|heart failure'),
                    ('bleeding', r'bleed|barc'), ('function', r'pvo2|functional|oxygen uptake'),
                    ('quality', r'kccq|quality'), ('rhythm', r'af recurrence|procedural failure|ablation'),
                    ('renal', r'renal|kidney'), ('septal', r'septal'), ('bp', r'blood pressure|mmhg')]
        return {key for key, pattern in patterns if re.search(pattern, label, re.I)}

    def finish(kind, question, correct, source, distractors):
        if not correct:
            return
        chosen = []
        seen = {normalized(correct)}
        for distinct in (True, False):
            for item in distractors:
                typ, text, reason = item
                text = clean(text)
                if not text or normalized(text) in seen or (distinct and typ in [x[0] for x in chosen]):
                    continue
                chosen.append((typ, text, reason))
                seen.add(normalized(text))
                if len(chosen) == 3:
                    break
            if len(chosen) == 3:
                break
        variants = numeric_alternatives(correct)
        if len(chosen) < 3 and variants:
            for text, parameter in variants[1:]:
                if normalized(text) not in seen:
                    reason = (f'The reported parameter is {variants[0][1]}, not {parameter}.' if en else
                              f'Thông số được báo cáo là {variants[0][1]}, không phải {parameter}.')
                    chosen.append(('numeric', text, reason))
                    seen.add(normalized(text))
                if len(chosen) == 3:
                    break
        if len(chosen) != 3:
            return
        cards.append({'kind': kind, 'question': question, 'texts': [correct] + [x[1] for x in chosen],
                      'reasons': [(f'{source}: {correct}' if en else f'{source}: {correct}')] + [x[2] for x in chosen],
                      'types': ['correct'] + [x[0] for x in chosen]})

    for t in trials:
        name, value = t.get('name', ''), clean(t.get('value'))
        fact, endpoint = clean(t.get('changes_' + suffix)), clean(t.get('endpoint_label'))
        if not name or not value or not fact:
            continue
        label = endpoint if en else ENDPOINT_VI.get(endpoint, endpoint)
        correct = ((f'The primary endpoint was “{label}” ({value}).' if en else
                    f'Tiêu chí chính là “{label}” ({value}).') if endpoint else f'{fact} ({value})')
        distractors = []
        # These are explicit trial-population labels, not inferred age/sex or comorbidity criteria.
        for population, other in [('HFpEF', 'HFrEF'), ('HFrEF', 'HFpEF')]:
            if re.search(r'\b' + population + r'\b', fact) and not re.search(r'\b' + other + r'\b', fact):
                wrong = re.sub(r'\b' + population + r'\b', other, f'{fact} ({value})')
                distractors.append(('population', wrong, (f'This substitutes {other} for the {population} population described for {name}.' if en else
                                                         f'Lựa chọn này đổi quần thể {population} của {name} thành {other}.')))
        for other in trials:
            other_endpoint = clean(other.get('endpoint_label'))
            if (other is not t and endpoint_signature(endpoint) and endpoint_signature(other_endpoint)
                    and endpoint_signature(other_endpoint) != endpoint_signature(endpoint)):
                other_label = other_endpoint if en else ENDPOINT_VI.get(other_endpoint, other_endpoint)
                wrong = (f'{name}: the primary endpoint was “{other_label}” ({value}).' if en else
                         f'{name}: tiêu chí chính là “{other_label}” ({value}).')
                reason = (f'“{other_endpoint}” belongs to {other.get("name")}; {name} reports “{endpoint}”.' if en else
                          f'“{other_endpoint}” là tiêu chí của {other.get("name")}; {name} báo cáo “{endpoint}”.')
                distractors.append(('endpoint', wrong, reason))
            if other is not t and endpoint and clean(other.get('value')) and other.get('value') != value:
                wrong = f'{other.get("name")}: {correct}'
                reason = (f'This attributes the {name} result to {other.get("name")}, whose reported estimate is {other.get("value")}.' if en else
                          f'Lựa chọn này gán kết quả của {name} cho {other.get("name")}; ước lượng được báo cáo của {other.get("name")} là {other.get("value")}.')
                distractors.append(('trial_attribution', wrong, reason))
        distractors.extend(traps)
        question = f'Which statement correctly describes {name}?' if en else f'Nhận định nào đúng về thử nghiệm {name}?'
        if re.search(r'\bHFpEF\b', fact) and 'HFrEF' not in fact:
            question = (f'A patient has HFpEF (LVEF 55%). Which statement about {name} is correct?' if en else
                        f'Bệnh nhân suy tim EF 55%. Nhận định nào đúng về thử nghiệm {name}?')
        finish('trial', question, correct, name, distractors)

    if len(steps) >= 2:
        old, current = steps[0], steps[-1]
        old_fact, new_fact = clean(old.get('desc_' + suffix)), clean(current.get('desc_' + suffix))
        old_era = old.get('era_label_' + suffix, '')
        current_era = current.get('era_label_' + suffix, '')
        if old_fact and new_fact and old_fact != new_fact:
            question = ('Which statement is the new practice update in the briefing’s final guideline stage?' if en else
                        'Trong tiến trình khuyến cáo của bản tin, đâu là cập nhật thực hành ở giai đoạn mới nhất?')
            wrong = [('old_guideline', old_fact, (f'This describes the earlier stage ({old_era}), not the new update ({current_era}). It may remain valid but is not the new development asked for.' if en else
                      f'Đây là nội dung giai đoạn trước ({old_era}), không phải cập nhật mới ({current_era}). Nội dung này có thể vẫn đúng nhưng không phải bước cập nhật được hỏi.'))]
            # Explicitly wrong trial/endpoint attribution is not a competing valid guideline statement.
            for card in cards:
                for typ, text, reason in zip(card['types'][1:], card['texts'][1:], card['reasons'][1:]):
                    if typ in ('endpoint', 'safety', 'population', 'trial_attribution'):
                        wrong.append((typ, text, reason))
            finish('guideline', question, new_fact, current_era, wrong)
    return cards
