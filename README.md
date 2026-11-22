# Daily Learning Heart

Daily Learning Heart (Xem Tim Mỗi Ngày) is a free community project for physicians learning evidence-based cardiology. The app presents Vietnamese and English briefings that connect guideline changes to landmark studies. It is for education, not diagnosis, prescribing, or patient-specific decisions.

## Run locally

Clone the repository and run these commands from its root. Use Python 3.12 to match GitHub Actions. No AI account, API key, or additional packages are needed for the normal reading, search, and scheduled refresh paths.

| Mode | Command | What it serves |
| --- | --- | --- |
| Static site | `python3 -m http.server 8080 --bind 127.0.0.1` | Bundled briefings, archive search, and browser-side features |
| Local app server | `python3 fetch_daily_ebm.py --serve --port 8088` | The same site plus local APIs and automatic daily refresh |

Open `http://127.0.0.1:8080/` or `http://127.0.0.1:8088/` in your browser. Static hosting (such as GitHub Pages) does not run the Python APIs. The local server is for development and personal use, not a public production server.

## Read and search

- Browse the daily or archived briefing, then switch between Vietnamese and English.
- Search the archive with a topic, abbreviation, or trial name such as `FINEARTS-HF`. The browser ranks bundled briefings locally using bilingual term normalization and BM25. This search does not contact PubMed or an AI provider.
- Use PubMed verification to find indexed publications and identifiers. The in-app educational Q&A can combine bundled evidence with live PubMed and, for relevant drug queries, openFDA. Live lookups require internet access and may be incomplete or unavailable.
- Use the review quiz to practice reasoning about the selected topic. Check questionable answers against the original sources. See the [AI guide](AGENTS.md#what-uses-ai-today) for optional model use in Q&A and quizzes.

## Daily refresh

The scheduled [GitHub Actions workflow](.github/workflows/daily_refresh.yml) refreshes around 06:00 Vietnam time, with catch-up runs. It builds one briefing for the scheduled pillar from the curated library and PubMed lookups, then commits the updated briefing bundle and rotation state if they changed. Running the same command locally can update these tracked files:

```sh
python3 fetch_daily_ebm.py --refresh-if-needed
```

To look up PubMed metadata without regenerating the bundle:

```sh
python3 fetch_daily_ebm.py --verify-pubmed 'FINEARTS-HF Solomon NEJM 2024'
```

Do not use the bare `python3 fetch_daily_ebm.py` command for the free refresh path. It selects optional model-based generation. The app must remain usable with no paid AI service; see the [AI guide](AGENTS.md) for the difference between search, refresh, and optional generation.

## Repository guide

| Path | Role |
| --- | --- |
| [`index.html`](index.html) · [`design.md`](design.md) | Browser app and design guidelines |
| [`search_ranking.js`](search_ranking.js) · [`search_ranking.py`](search_ranking.py) | Browser and backend search ranking |
| [`fetch_daily_ebm.py`](fetch_daily_ebm.py) · [`crawl_cardiology_news.py`](crawl_cardiology_news.py) | Local server, refresh, and PubMed retrieval |
| [`pillar_library.py`](pillar_library.py) · [`build_seed_briefings.py`](build_seed_briefings.py) | Curated briefing library and seed-bundle generator |
| [`data/briefings.js`](data/briefings.js) · [`data/rotation_state.json`](data/rotation_state.json) | Published briefing bundle and refresh state |
| [Architecture and data contract](AGENT_IMPLEMENTATION_PLAN.md) | Rotation, record fields, and how to change the app |
| [Editorial prompt](PROMPT.md) · [Example briefing](expected_output.md) | Evidence standards and the expected format |
| [AI guide](AGENTS.md) | Instructions for coding agents and limits of in-app AI |

## Checks

```sh
python3 -m unittest discover -s tests
node tests/test_search.js
```

For browser changes, check both languages, a narrow viewport, and the static mode without API keys. Keep real patient information out of the app, local stores, and external queries.
