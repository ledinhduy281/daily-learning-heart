"""Local bilingual, field-weighted BM25 retrieval (no external services)."""
import json
import math
import re
import unicodedata
from collections import Counter


def normalize(text):
    return ''.join(c for c in unicodedata.normalize('NFD', str(text).lower().replace('đ', 'd'))
                   if unicodedata.category(c) != 'Mn')


# Each group is one clinical concept, not a bag of loosely related treatments.
CONCEPTS = [
    ('disease', 'Heart Failure', ['hf', 'heart failure', 'suy tim']),
    ('disease', 'Heart Failure, Diastolic', ['hfpef', 'heart failure with preserved ejection fraction', 'suy tim phan suat tong mau bao ton']),
    ('disease', 'Heart Failure, Systolic', ['hfref', 'heart failure with reduced ejection fraction', 'suy tim phan suat tong mau giam']),
    ('disease', 'Hypertension', ['hypertension', 'high blood pressure', 'tang huyet ap', 'tha']),
    ('disease', 'Atrial Fibrillation', ['af', 'atrial fibrillation', 'rung nhi']),
    ('disease', 'Acute Coronary Syndrome', ['acs', 'acute coronary syndrome', 'hoi chung mach vanh cap']),
    ('intervention', 'Sodium-Glucose Transporter 2 Inhibitors', ['sglt2i', 'sglt2', 'sglt2 inhibitors', 'uc che sglt2']),
    ('intervention', 'Angiotensin Receptor Antagonists', ['arni', 'angiotensin receptor neprilysin inhibitor', 'sacubitril valsartan']),
    ('intervention', '', ['gdmt', 'guideline directed medical therapy', 'dieu tri noi khoa toi uu']),
]
STOP = set('the and or for with what how why about this that in of to a an la va cho cua ve co moi nhat dieu tri'.split())


def contains(text, phrase):
    return bool(re.search(r'(?<!\w)' + re.escape(phrase) + r'(?!\w)', text))


def terms(query):
    q = normalize(query)
    groups = []
    for _, _, aliases in sorted(CONCEPTS, key=lambda c: -max(map(len, c[2]))):
        if any(contains(q, a) for a in aliases):
            groups.append(aliases)
            for alias in sorted(aliases, key=len, reverse=True):
                q = re.sub(r'(?<!\w)' + re.escape(alias) + r'(?!\w)', ' ', q)
    groups.extend([[t] for t in dict.fromkeys(re.findall(r'[a-z0-9]+', q)) if t not in STOP and len(t) > 1])
    return groups


def fields(b):
    def value(keys):
        return ' '.join(json.dumps(b.get(k, ''), ensure_ascii=False) for k in keys)
    return [(value(['title_vi', 'title_en', 'topic_focus_vi', 'topic_focus_en', 'pillar_vi', 'pillar_name']), 6),
            (value(['guideline_evolution', 'landmark_trials', 'drugs', 'drug_names', 'pearls']), 4),
            (value(['part1_vi_markdown', 'part2_en_markdown', 'snippet']), 1)]


def score(b, query):
    groups = terms(query)
    if not groups:
        return 0
    docs = [(normalize(s), w) for s, w in fields(b)]
    counts = [Counter(re.findall(r'[a-z0-9]+', s)) for s, _ in docs]
    total = 0
    covered = 0
    for aliases in groups:
        best = 0
        for alias in aliases:
            ts = re.findall(r'[a-z0-9]+', alias)
            tf = sum(w * min((c[t] for t in ts), default=0) / (0.25 + 0.75 * max(1, sum(c.values())) / 100)
                     for (s, w), c in zip(docs, counts) if len(ts) == 1 or contains(s, alias))
            best = max(best, math.log(2) * tf * 2.2 / (tf + 1.2))
        if best:
            covered += 1
        total += best * 10
    if covered == len(groups):
        total += 20
    phrase = normalize(query).strip()
    phrases = groups[0] if len(groups) == 1 else [phrase]
    if phrase and any(contains(s, p) for s, _ in docs for p in phrases):
        total += 12
    return round(total)
