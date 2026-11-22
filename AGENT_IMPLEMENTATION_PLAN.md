# Architecture and data contract

This document describes the implemented architecture. It replaces the initial rollout checklist; it is not a list of pending features.

## Request and publishing paths

| Path | Data flow |
| --- | --- |
| Read and search the archive | [`index.html`](index.html) loads [`data/briefings.js`](data/briefings.js); [`search_ranking.js`](search_ranking.js) scores archive matches in the browser. Keep the shared ranking behavior aligned with [`search_ranking.py`](search_ranking.py). |
| Check a source or ask an educational question | The browser can query PubMed directly; the local server offers API routes including `/api/pubmed-verify` and `/api/chat`. Q&A ranks relevant briefings and can supplement them with live PubMed abstracts and openFDA drug-label information. |
| Publish a daily briefing | The [workflow](.github/workflows/daily_refresh.yml) calls `fetch_daily_ebm.py --refresh-if-needed`. The refresh starts with the scheduled pillar's curated briefing, queries PubMed for recent guideline candidates, and merges available publication metadata. It also looks up selected landmark trial identifiers. |
| Rebuild the initial bundle | [`build_seed_briefings.py`](build_seed_briefings.py) rebuilds the seed dataset from [`pillar_library.py`](pillar_library.py). It overwrites the local bundle; do not use it as a substitute for daily refresh. |

The browser uses the published bundle without Python. [`fetch_daily_ebm.py`](fetch_daily_ebm.py) also serves static assets and local API routes for rotation status, refresh, review tutoring, and feedback. Data stored in a browser is scoped to that browser and site origin; local server data is not a shared cloud database. Do not publish server state, keys, or user data with static assets.

## Rotation

The pillars cycle in order, anchored to November 16, 2026 (pillar 1). For a given date, the pillar ID is `((date - anchor).days % 10) + 1` (using Python's modulo). For example, November 15 maps to pillar 10 and November 17 maps to pillar 2. The scheduled refresh uses the Vietnam calendar date; the server's schedule/status logic also accounts for the 06:00 cutoff. Do not make the selected pillar depend on which refreshes succeeded.

| ID | Pillar |
| --- | --- |
| 1 | Hypertension & Risk Factors |
| 2 | Dyslipidemia & Atherosclerosis |
| 3 | Medical Coronary Artery Disease & Microvascular Disease |
| 4 | Antithrombotic Therapy |
| 5 | Comprehensive Heart Failure & Cardiogenic Shock |
| 6 | Arrhythmia, Electrophysiology & Syncope |
| 7 | Valvular Heart Disease & Infective Endocarditis |
| 8 | Specific Cardiomyopathies, Pericardial Disease & ACHD |
| 9 | Pulmonary Vascular Disease, VTE & Aortic Disease |
| 10 | Cross-Specialty Cardiology & Diagnostics |

## Briefing bundle

The bundle assigns a JSON payload to `window.EBM_BRIEFINGS_DATA`. It includes `briefings`, `pillars`, `rotation_state`, and generation metadata. [`data/rotation_state.json`](data/rotation_state.json) is the backend's refresh state, including the last updated date and nearby pillar IDs. Keep the bundle and state in sync when changing the refresh.

| Briefing fields | Meaning |
| --- | --- |
| `id`, `date`, `pillar_id`, `pillar_name`, `pillar_vi` | Stable identity, ISO calendar date, and pillar metadata |
| `title_vi/en`, `topic_focus_vi/en`, `part1_vi_markdown`, `part2_en_markdown` | Bilingual titles, focus, and lesson text; English content is not guaranteed on all records |
| `guideline_evolution` | Prior/current references and comparison `steps` for Block A |
| `landmark_trials` | Block B entries with endpoints, reported statistics when available, and bilingual implications and cautions |
| `pearls`, `pubmed_anchors` | Teaching points and bibliographic references, such as PMIDs or DOIs |
| `verified_step0`, `model_used`, `live_crawled_guidelines`, `last_guideline_crawl_at` | Process and provenance metadata, not a clinical approval stamp |

Structured fields can be absent from older or model-generated records. Do not assume every record has both languages, a live match, or all trial statistics. The regular guideline refresh publishes the structured briefing, not a general news feed of `crawled_articles`. Use the canonical `date` rather than a stored display label for date comparisons.

## Change checklist

1. Change the curated source or generator instead of hand-editing generated output as the sole fix.
2. Keep search behavior consistent across browser and Python; use the existing search tests for ranking changes.
3. Verify the static and local API paths separately. A Markdown or data change does not require an AI API call.
4. When a live result changes a citation, check the publication against both language versions. A metadata lookup does not automatically reconcile an older teaching narrative with a newer guideline.
