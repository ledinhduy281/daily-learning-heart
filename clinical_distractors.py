"""Conservative, source-attributed clinical distractors; no invented patient data."""
import re
import unicodedata


ENDPOINT_VI = {
    '6-Month Office SBP Change vs. Sham Procedure': 'Thay đổi huyết áp tâm thu tại phòng khám sau 6 tháng so với thủ thuật giả',
    'Home SBP Reduction: Spironolactone vs. Placebo': 'Mức giảm huyết áp tâm thu tại nhà: spironolactone so với giả dược',
    '2-Month Daytime Ambulatory SBP vs. Sham': 'Huyết áp tâm thu lưu động ban ngày sau 2 tháng so với thủ thuật giả',
    'BARC Type 2, 3, or 5 Bleeding (Months 3–15)': 'Chảy máu BARC loại 2, 3 hoặc 5 (tháng 3–15)',
    'CV Death or First HF Hospitalization': 'Tử vong tim mạch hoặc nhập viện suy tim lần đầu',
    'Worsening HF or Cardiovascular Death': 'Suy tim nặng lên hoặc tử vong tim mạch',
    'Total Worsening HF Events & Cardiovascular Death': 'Tổng số biến cố suy tim nặng lên và tử vong tim mạch',
    'CV Death, Stroke, or Hospitalization for Worsening HF or ACS': 'Tử vong tim mạch, đột quỵ hoặc nhập viện vì suy tim nặng lên hay hội chứng mạch vành cấp',
    '12-Month Freedom from Procedural Failure, AT/AF Recurrence, AAD, or Repeat Ablation': 'Không thất bại thủ thuật, tái phát nhịp nhanh nhĩ/rung nhĩ, dùng thuốc chống loạn nhịp hoặc triệt đốt lại trong 12 tháng',
}


def is_trial(entry):
    metadata = ' '.join(str(entry.get(k) or '') for k in ('name', 'value', 'p'))
    return (not re.search(r'guideline|consensus|\bClass\s+[IV]', metadata, re.I)
            and bool(re.search(r'(?:HR|RR|OR|Win Ratio)\s+\d|\d\s*(?:%|mmHg|mL|points|pts)', str(entry.get('value') or ''), re.I)))


def numeric_targets(text, shared_value=None, include_duplicates=False):
    number = r'([+-]?[0-9]+(?:[.,][0-9]+)?)'
    patterns = [
        (r'\b(HR|RR|OR|Win Ratio)\s*(?:=|:)?\s*' + number, 2, None, 0),
        (r'\b(LVEF|EF|BMI|eGFR|PVR|PAWP|mPAP|SBP|DBP|LDL-C|HbA1c|age|aged|tuổi|STS(?:-PROM)?|EuroSCORE\s*II)\s*[<>≤≥]=?\s*' + number, 2, None, re.I),
        (r'[<>≤≥]=?\s*' + number + r'\s*(?:years?|tuổi)\b', 1, 'age', re.I),
        (number + r'\s*(mmHg|WU|mL/min|mmol/L|mg/dL)\b', 1, None, re.I),
        (number + r'\s*%', 1, 'percent', 0),
        (r'\bClass\s+(IIa|IIb|III|II|I)\b', 1, 'class', re.I),
    ]
    result, spans = [], set()
    for pattern, group, field, flags in patterns:
        for match in re.finditer(pattern, text, flags):
            start, end = match.span(group)
            if (start, end) in spans:
                continue
            label = field or match.group(1 if group == 2 else 2).lower().replace(' ', '')
            label = {'ef': 'lvef', 'aged': 'age', 'tuổi': 'age'}.get(label, label)
            if label == 'percent' and shared_value:
                offset = text.rfind(shared_value)
                if offset < 0 or not offset <= start < offset + len(shared_value):
                    continue
            original = match.group(group)
            value = original.lower() if label == 'class' else f"{float(original.replace(',', '.')):.12f}".rstrip('0').rstrip('.')
            result.append({'id': f'{label}:{value}', 'start': start, 'end': end, 'value': original, 'numeric': label != 'class'})
            spans.add((start, end))
    return result if include_duplicates else [t for i, t in enumerate(result) if not any(p['id'] == t['id'] for p in result[:i])]


def rich_cards(primary, lang, numeric_alternatives, paired=True):
    en = lang == 'en'
    suffix = 'en' if en else 'vi'
    trials = [t for t in primary.get('landmark_trials') or [] if is_trial(t)]
    steps = (primary.get('guideline_evolution') or {}).get('steps') or []
    cards = []

    def trial_id(t):
        return str(t.get('id') or t.get('doi') or t.get('pmid') or (primary.get('landmark_trials') or []).index(t))

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
                                (r'Không khởi trị', 'Có thể khởi trị'), (r'tránh phối hợp', 'có thể phối hợp'),
                                (r'tránh dùng', 'có thể dùng')])
        for clause in text.split(';'):
            for pattern, replacement in patterns:
                changed, count = re.subn(pattern, replacement, clause.strip(), count=1, flags=re.I)
                if count:
                    return changed
        return ''

    traps = []
    for t in trials:
        caution = clean(t.get('caution_' + suffix))
        changed = safety(caution)
        if changed:
            changed = changed.split(';')[0].strip()
            source = t.get('name', '')
            traps.append(('safety', f'{source}: {changed}',
                          (f'This reverses the safety instruction for {source}: {caution}' if en else
                           f'Lựa chọn này đảo ngược lưu ý an toàn của {source}: {caution}'), 'safety:trial:' + trial_id(t)))
    for pearl_idx, p in enumerate(primary.get('pearls') or []):
        fact = clean(p.get('text_' + suffix))
        changed = safety(fact)
        if changed:
            changed = changed.split(';')[0].strip()
            traps.append(('safety', f'{"Clinical practice" if en else "Thực hành lâm sàng"}: {changed}', (f'The clinical pearl instead states: {fact}' if en else f'Điểm thực hành nêu điều ngược lại: {fact}'), f'safety:pearl:{pearl_idx}'))
    drugs = primary.get('drugs') or []
    for drug_idx, drug in enumerate(drugs if isinstance(drugs, list) else []):
        if not isinstance(drug, dict):
            continue
        fact = clean(drug.get('contraindication_' + suffix) or drug.get('caution_' + suffix))
        changed = safety(fact)
        if changed:
            changed = changed.split(';')[0].strip()
            name = drug.get('name', '')
            traps.append(('safety', f'{name}: {changed}', (f'{name}: {fact}' if en else f'Lưu ý của {name}: {fact}'), f'safety:drug:{drug_idx}'))

    def endpoint_signature(label):
        patterns = [('death', r'death|mortality|mace'), ('stroke', r'stroke|mace'),
                    ('mi', r'infarction|\bmi\b|mace'), ('hf', r'\bhf\b|heart failure'),
                    ('bleeding', r'bleed|barc'), ('function', r'pvo2|functional|oxygen uptake'),
                    ('quality', r'kccq|quality'), ('rhythm', r'af recurrence|procedural failure|ablation'),
                    ('renal', r'renal|kidney'), ('septal', r'septal'), ('bp', r'blood pressure|mmhg')]
        return {key for key, pattern in patterns if re.search(pattern, label, re.I)}

    def finish(kind, question, correct, source, distractors, source_id='guideline', shared_value='', fallbacks=()):
        if not correct:
            return
        correct = clean(correct).rstrip('.!?') + '.'
        candidates = [(typ, clean(text).rstrip('.!?') + '.', reason, identity)
                      for typ, text, reason, identity in distractors if clean(text)]
        groups = {}
        for target in numeric_targets(correct, shared_value):
            variants = numeric_alternatives(correct, target=target)
            if not variants:
                continue
            identities = []
            for idx, (text, parameter) in enumerate(variants[1:]):
                reason = (f'The reported parameter is {variants[0][1]}, not {parameter}.' if en else
                          f'Thông số được báo cáo là {variants[0][1]}, không phải {parameter}.')
                changed = f"{float(parameter.replace(',', '.')):.12f}".rstrip('0').rstrip('.') if target['numeric'] else parameter.lower()
                identity = f"numeric:{target['id']}:to:{changed}"
                candidates.append(('numeric', text, reason, identity))
                identities.append(identity)
            if target['numeric']:
                groups[target['id']] = identities
        candidates.extend((typ, clean(text).rstrip('.!?') + '.', reason, identity) for typ, text, reason, identity in fallbacks if clean(text))
        chosen = []
        seen = {normalized(correct)}
        for distinct in (True, False):
            for typ, text, reason, identity in candidates:
                if not text or normalized(text) in seen or (distinct and typ in [x[0] for x in chosen]):
                    continue
                chosen.append((typ, text, reason, identity))
                seen.add(normalized(text))
                if len(chosen) == 3:
                    break
            if len(chosen) == 3:
                break
        if len(chosen) != 3:
            return
        cards.append({'kind': kind, 'source_id': source_id, 'question': question, 'texts': [correct] + [x[1] for x in chosen],
                      'reasons': [correct if correct.startswith(f'{source}: ') else f'{source}: {correct}'] + [x[2] for x in chosen],
                      'types': ['correct'] + [x[0] for x in chosen], 'choice_ids': ['correct'] + [x[3] for x in chosen], 'candidates': candidates, 'numeric_groups': groups})

    for t in trials:
        name, value = t.get('name', ''), clean(t.get('value'))
        fact, endpoint = clean(t.get('changes_' + suffix)), clean(t.get('endpoint_label'))
        if not name or not value or not fact:
            continue
        if not endpoint:
            continue
        label = endpoint if en else ENDPOINT_VI.get(endpoint, endpoint)
        claim = (f'The primary endpoint was “{label}” ({value}).' if en else
                 f'Tiêu chí chính là “{label}” ({value}).')
        correct = f'{name}: {claim}'
        distractors = []
        # These are explicit trial-population labels, not inferred age/sex or comorbidity criteria.
        for population, other in [('HFpEF', 'HFrEF'), ('HFrEF', 'HFpEF')]:
            if re.search(r'\b' + population + r'\b', fact) and not re.search(r'\b' + other + r'\b', fact):
                wrong = (f'{name}: The reported result was {value} in patients with {other}.' if en else
                         f'{name}: Kết quả {value} được ghi nhận ở bệnh nhân {other}.')
                distractors.append(('population', wrong, (f'This substitutes {other} for the {population} population described for {name}.' if en else
                                                         f'Lựa chọn này đổi quần thể {population} của {name} thành {other}.'), 'population:' + population))
        for other in trials:
            other_endpoint = clean(other.get('endpoint_label'))
            if (other is not t and endpoint_signature(endpoint) and endpoint_signature(other_endpoint)
                    and endpoint_signature(other_endpoint) != endpoint_signature(endpoint)):
                other_label = other_endpoint if en else ENDPOINT_VI.get(other_endpoint, other_endpoint)
                wrong = (f'{name}: The primary endpoint was “{other_label}” ({value}).' if en else
                         f'{name}: Tiêu chí chính là “{other_label}” ({value}).')
                reason = (f'“{other_endpoint}” belongs to {other.get("name")}; {name} reports “{endpoint}”.' if en else
                          f'“{other_label}” là tiêu chí của {other.get("name")}; {name} báo cáo “{label}”.')
                distractors.append(('endpoint', wrong, reason, 'endpoint:' + trial_id(other)))
            if other is not t and endpoint and clean(other.get('value')) and other.get('value') != value:
                wrong = f'{other.get("name")}: {claim}'
                reason = (f'This attributes the {name} result to {other.get("name")}, whose reported estimate is {other.get("value")}.' if en else
                          f'Lựa chọn này gán kết quả của {name} cho {other.get("name")}; ước lượng được báo cáo của {other.get("name")} là {other.get("value")}.')
                distractors.append(('trial_attribution', wrong, reason, 'attribution:' + trial_id(other)))
        distractors.extend(traps)
        question = ('Which statement about trial evidence and its clinical application is correct?' if en else
                    'Nhận định nào đúng về chứng cứ thử nghiệm và ứng dụng lâm sàng?')
        if re.search(r'\bHFpEF\b', fact) and 'HFrEF' not in fact:
            question = ('A patient has HFpEF (LVEF 55%). Which statement about trial evidence and its clinical application is correct?' if en else
                        'Bệnh nhân suy tim EF 55%. Nhận định nào đúng về chứng cứ thử nghiệm và ứng dụng lâm sàng?')
        finish('trial', question, correct, name, distractors, 'trial:' + trial_id(t), value)

    if len(steps) >= 2:
        old, current = steps[0], steps[-1]
        old_fact, new_fact = clean(old.get('desc_' + suffix)), clean(current.get('desc_' + suffix))
        old_era = old.get('era_label_' + suffix, '')
        current_era = current.get('era_label_' + suffix, '')
        if old_fact and new_fact and old_fact != new_fact:
            question = ('Which statement is the new practice update in the briefing’s final guideline stage?' if en else
                        'Trong tiến trình khuyến cáo của bản tin, đâu là cập nhật thực hành ở giai đoạn mới nhất?')
            def clause(text):
                return text.replace(';', ',').replace('≥', '≥ ')
            new_fact, old_fact = clause(new_fact), clause(old_fact)
            prefix = 'Recommendation: ' if en else 'Khuyến cáo: '
            new_fact, old_fact = prefix + new_fact, prefix + old_fact
            wrong = [('old_guideline', old_fact, (f'This describes the earlier stage ({old_era}), not the new update ({current_era}).' if en else
                      f'Đây là nội dung giai đoạn trước ({old_era}), không phải cập nhật mới ({current_era}).'), 'old_guideline')]
            fallbacks = []
            for stage_idx, stage in enumerate(steps[1:-1], 1):
                fact = clean(stage.get('desc_' + suffix))
                era = stage.get('era_label_' + suffix, '')
                if fact:
                    fallbacks.append(('old_guideline', prefix + clause(fact),
                                      (f'This belongs to the earlier stage ({era}), not the final update ({current_era}).' if en else
                                       f'Đây là nội dung giai đoạn trước ({era}), không phải cập nhật cuối ({current_era}).'), f'old_guideline:stage:{stage_idx}'))
            attribution = (f'The initial stage ({old_era}), rather than the final stage, introduced this update: {new_fact[len(prefix):]}' if en else
                           f'Giai đoạn đầu ({old_era}), chứ không phải giai đoạn cuối, đưa ra cập nhật này: {new_fact[len(prefix):]}')
            fallbacks.append(('old_guideline', prefix + attribution,
                              (f'The briefing places this update in the final stage ({current_era}), not the initial stage ({old_era}).' if en else
                               f'Bản tin đặt cập nhật này ở giai đoạn cuối ({current_era}), không phải giai đoạn đầu ({old_era}).'), 'old_guideline:attribution'))
            finish('guideline', question, new_fact, current_era, wrong, fallbacks=fallbacks)
    if not paired:
        return cards
    peers = {c['source_id']: c for c in rich_cards(primary, 'vi' if en else 'en', numeric_alternatives, False)}
    result = []
    for card in cards:
        peer = peers.get(card['source_id'])
        if not peer:
            numeric_ids = next(iter(card['numeric_groups'].values()), [])
            by_id = {c[3]: c for c in card['candidates']}
            card['hard_choices'] = [by_id[i] for i in numeric_ids]
            card.pop('candidates')
            result.append(card)
            continue
        local = {c[3]: c for c in card['candidates']}
        remote = {c[3]: c for c in peer['candidates']}
        canonical = card if en else peer
        card['hard_choices'] = []
        for identities in canonical['numeric_groups'].values():
            if all(i in local and i in remote for i in identities):
                card['hard_choices'] = [local[i] for i in identities]
                break
        selected, seen_local, seen_remote = [], {normalized(card['texts'][0])}, {normalized(peer['texts'][0])}
        for distinct in (True, False):
            for typ, _, _, identity in canonical['candidates']:
                if identity not in local or identity not in remote or identity in selected:
                    continue
                if distinct and any(local[i][0] == typ for i in selected):
                    continue
                if normalized(local[identity][1]) in seen_local or normalized(remote[identity][1]) in seen_remote:
                    continue
                selected.append(identity)
                seen_local.add(normalized(local[identity][1]))
                seen_remote.add(normalized(remote[identity][1]))
                if len(selected) == 3:
                    break
            if len(selected) == 3:
                break
        if len(selected) == 3:
            card.update(texts=[card['texts'][0]] + [local[i][1] for i in selected],
                        reasons=[card['reasons'][0]] + [local[i][2] for i in selected],
                        types=['correct'] + [local[i][0] for i in selected], choice_ids=['correct'] + selected)
            card.pop('candidates')
            result.append(card)
    return result
