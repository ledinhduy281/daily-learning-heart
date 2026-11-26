# Daily Learning Heart

Daily Learning Heart (Xem Tim Mỗi Ngày) is a free community project for physicians learning evidence-based cardiology. The app presents Vietnamese and English briefings that connect guideline changes to landmark studies. It is for education, not diagnosis, prescribing, or patient-specific decisions.

## Run locally

Clone the repository and run these commands from its root. Use Python 3.12 to match GitHub Actions. No AI account, API key, or additional packages are needed for the normal reading, search, and scheduled refresh paths.

| Mode | Command | What it serves |
| --- | --- | --- |
| Static site | `python3 -m http.server 8080 --bind 127.0.0.1` | Bundled briefings, archive search, and browser-side features |
| Local app server | `python3 fetch_daily_ebm.py --serve --port 8088` | The same site plus local APIs and automatic daily refresh |

Open `http://127.0.0.1:8080/` or `http://127.0.0.1:8088/` in your browser. Static hosting (such as GitHub Pages) does not run the Python APIs. The local server is for development and personal use, not a public production server.

No account is required: progress is stored in a device profile in both modes. The local server no longer offers legacy password reset or demo sign-in.

## Read and search

- Browse the daily or archived briefing, then switch between Vietnamese and English.
- Search the archive with a topic, abbreviation, or trial name such as `FINEARTS-HF`. The browser ranks bundled briefings locally using bilingual term normalization and BM25. This search does not contact PubMed or an AI provider.
- Use PubMed verification to find indexed publications and identifiers. The in-app educational Q&A can combine bundled evidence with live PubMed and, for relevant drug queries, openFDA. Live lookups require internet access and may be incomplete or unavailable.
- Use the review quiz to practice reasoning about the selected topic. Check questionable answers against the original sources. See the [AI guide](AGENTS.md#what-uses-ai-today) for optional model use in Q&A and quizzes.

## Apps Script deployment

Optional AI chat uses `backend/apps_script/Chat.gs`; keep `GROQ_API_KEY` in Script Properties only. Chat permits 30 requests per device per Vietnam calendar day, with a global hard ceiling of 100 (the optional `CHAT_DAILY_CAP` property can lower it). The browser derives a chat-only ID as lowercase hex SHA-256 of `dlh-chat-v1:` plus the lowercase persisted device profile UUID; it never sends the raw UUID to chat, since that UUID also serves as the default cloud-sync bearer key. The server accepts only 64 lowercase hex characters and hashes the chat ID again for storage, salted with the existing `PEPPER` property when available. No new script property is required. If Web Crypto hashing is unavailable or fails, or the proxy refuses or fails, the browser keeps the deterministic fallback. Device IDs are client-controlled: this limits ordinary device use, not a determined caller rotating IDs.

The Review Quiz tab builds theory questions directly from the lesson's verbatim excerpts, without a model. It adds the first published set of three clinical application questions when one is available. **Tạo câu hỏi mới bằng AI** swaps only the clinical cases for another pre-generated set, without a browser model call, up to twice per device per Vietnam calendar day. If no case set passes, theory remains available where the lesson has suitable source material.

The [owner's Socratic tutoring philosophy](docs/quiz_philosophy.md) is part of the clinical-case prompt used by [`generate_quiz_sets.js`](generate_quiz_sets.js). With the `GROQ_API_KEY` secret (optional `GROQ_MODEL` variable), the [daily refresh](.github/workflows/daily_refresh.yml) generates up to three sets of three bilingual clinical application questions from the day's single source. The generator independently re-solves the cases without seeing their keys. [`case_quiz.js`](case_quiz.js) checks counts, bilingual fields, exact quotes, and medical number/dose constraints before publication and again in the browser. Cases are labeled AI-written and not physician-reviewed.

Practice shows one question at a time. On the first miss, a narrower question guides a retry; on the second miss, the quiz shows the explanation and exact source excerpt. Progress and the skill map are saved on the device. Two independent checks are required to raise a skill level; spaced repeats and the final assessment are review, not independent mastery checks. When there are enough questions to space the repeats, the final assessment follows practice and spaced review.

## Daily refresh

The scheduled [GitHub Actions workflow](.github/workflows/daily_refresh.yml) refreshes around 06:00 Vietnam time, with catch-up runs. From 2026-11-25, each daily lesson is built from one primary source for its pillar in [`recent_lessons.py`](recent_lessons.py). Every source was published online within `SOURCE_WINDOW_DAYS` (92 days, about three months) of the catalog edition date, and the publisher rejects a lesson whose source falls outside that window. Block A summarizes the source; Block B reads the same source closely (design, results, limits) and shows the same citation box. The workflow commits the updated bundle and rotation state. If the bundle has no daily edition, the browser uses the prebuilt template for the same pillar. Lessons dated before 2026-11-25 keep the earlier guideline-plus-trial format from [`focused_lessons.py`](focused_lessons.py) in the archive.

The bilingual walkthroughs for the recent sources are in [`lessons/recent/`](lessons/recent/). Each file starts with the source PMID; the publisher checks it and that both languages contain every section. These are teaching drafts, not physician-reviewed guidance.

Quizzes use only verbatim text from the cited source. For trials, meta-analyses, and statements, the excerpts come from the PubMed abstract, with the PMID and the publisher's copyright line shown next to them. Guideline lessons have no quiz until a physician enters verbatim recommendation lines from the guideline PDF in `PHYSICIAN_LINES` in `recent_lessons.py`, each with its Class, Level, and page or table. The lesson then shows those lines and quizzes on them. Do not infer a recommendation from a title, an abstract, or an older guideline.

To refresh the catalog for a new three-month window, choose one source per pillar in the priority order below, add its walkthrough under `lessons/recent/`, update `RECENT_EDITION_DATE`, and bump `RECENT_LESSON_VERSION`.

For these walkthroughs, keyless local chat can show relevant lesson text for pasted questions but does not grade the answer choices. Use the in-app lesson quiz for answers linked to verbatim source excerpts. For a longer excerpt, select **Detailed** or put “Explain in detail” after a blank line below the choices.

Source priority for eligible cardiology sources is ESC/AHA/ACC guideline, systematic review/meta-analysis, landmark RCT, real-world cohort/registry, then expert consensus (`SOURCE_KINDS` in `recent_lessons.py`). A lower-tier source is not presented as a guideline. Running the refresh locally can update these tracked files:

```sh
python3 fetch_daily_ebm.py --refresh-if-needed
```

To look up PubMed metadata without regenerating the bundle:

```sh
python3 fetch_daily_ebm.py --verify-pubmed 'FINEARTS-HF Solomon NEJM 2024'
```

Do not use the bare `python3 fetch_daily_ebm.py` command for the free refresh path. It selects optional model-based generation. The app must remain usable with no paid AI service; see the [AI guide](AGENTS.md) for the difference between search, refresh, and optional generation.

## Daily evidence pipeline

The [daily evidence workflow](.github/workflows/evidence_pipeline.yml) has GitHub fallback slots at 00:13, 00:47, 01:26 and 02:08 UTC and can also start after the curated pillar refresh. GitHub can delay or miss its scheduled events, so the owner can enable the independent, free Apps Script watchdog below. Runs skip ingestion once both files for today's UTC date are on `main`. To rebuild explicitly, choose **Actions → Daily Cardiology Evidence Pipeline → Run workflow** on `main` and enable **force**. Ingestion uses public APIs without API keys or paid services.

### Enable the free watchdog (repository owner)

After merging the workflow changes:

1. In GitHub, go to **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**. Set the resource owner to `ledinhduy281`, choose **Only select repositories → daily-learning-heart**, and grant **Actions: Read and write** only (GitHub includes read-only Metadata automatically). Set an expiration and renew the token before it expires.
2. In the existing Apps Script project, add a script file named **Evidence** and paste [`backend/apps_script/Evidence.gs`](backend/apps_script/Evidence.gs) into it. In **Project Settings → Script Properties**, set **GITHUB_DISPATCH_TOKEN** to the token. Do not paste it into code, GitHub, or chat.
3. Save the script. In the editor select **installEvidenceTrigger**, click **Run** once, and authorize it. Confirm an hourly time-driven trigger for **dispatchStaleHeartSnapshots_** under **Triggers**. This does not require replacing the existing web app deployment or changing its URL.
4. Check **Executions** in Apps Script and the repository **Actions** tab after the next run between 00:00 and 06:00 UTC. A healthy day may have no watchdog dispatch because both snapshots are current. If the log reports HTTP 401 or 403, check the token's expiration and repository permissions.

The trigger checks the public Pages evidence date in UTC and the pillar rotation date on `main` in Vietnam time. It checks once an hour from 00:00 through 05:59 UTC and requests only missing or stale workflows. At most 24 URL Fetch calls per day are made by this trigger, within the free Apps Script quota. A watchdog dispatch that finds evidence already on `main` can repair a stale Pages deployment without re-ingesting the data.

| Layer | What it does |
| --- | --- |
| Raw JSON | Fetches recent cardiology publication metadata from PubMed E-utilities, recently updated ClinicalTrials.gov API v2 registrations, and openFDA labels for selected cardiovascular drugs. Responses and source status are stored under `raw/date=YYYY-MM-DD/` (UTC). Calls are capped and transient errors are retried. |
| Bronze Parquet | Normalizes identifiers, titles, dates and source-specific metadata into one typed Parquet file per source under `bronze/date=YYYY-MM-DD/`. Raw and bronze snapshots are available as Actions artifacts for 14 days. |
| dbt on DuckDB | Staging unifies the three files; intermediate models deduplicate by source and identifier (PMID for PubMed), apply one pillar-inspired topic tag, and rank records with separate evidence and relevance scores. Evidence uses publication type and a selected-journal list; relevance uses topic matches and recency at the snapshot date. Scores are browsing heuristics, not clinical quality grades. The mart retains source IDs and links. |
| Published data | `dbt build` checks keys, required fields, categories and score ranges. The export is then checked against [the briefing JSON Schema](pipeline/briefing.schema.json). Only a passing run commits [briefing JSON](https://ledinhduy281.github.io/daily-learning-heart/data/pipeline/briefing.json) (up to ten ranked records per source) and [mart Parquet](https://ledinhduy281.github.io/daily-learning-heart/data/pipeline/evidence.parquet) (all deduplicated records) to `data/pipeline/`. An outage marks the affected source unavailable; if all fail, the mart is empty, or validation fails, the previous snapshot remains in place. |
| App | The **Daily cardiology evidence** panel reads the same relative JSON URL from the local server and static site. It shows the snapshot date, provenance and any source outage. After a successful online visit, the app shell and last valid snapshot can be opened offline on the same browser and origin. If the JSON has never loaded or storage is unavailable, the existing bilingual briefing remains available; the pipeline does not replace it. |

To build a snapshot locally with Python 3.12:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r pipeline/requirements.txt
python -m pipeline.run --work-dir ../heart-evidence
# Optional: preview this snapshot with either local app mode.
mkdir -p data/pipeline
cp ../heart-evidence/publish/briefing.json ../heart-evidence/publish/evidence.parquet data/pipeline/
```

The [site workflow](.github/workflows/pages.yml) deploys the allowed static assets after changes to `main`, a successful curated refresh, a successful evidence publish job, or a recovery dispatch when Pages is stale. Already-current scheduled evidence runs that skip the publish job do not redeploy the site. Use **Settings → Pages → Build and deployment → Source → GitHub Actions**. The deployment handoff via `workflow_run` is needed because bot commits made with `GITHUB_TOKEN` do not trigger push workflows. Raw/bronze snapshots and backend files are not part of the deployed site.

### Lesson source extraction

[`pipeline.lesson_sources.fetch_article`](pipeline/lesson_sources.py) takes a PMID and resolves it to open-access JATS XML via [Europe PMC](https://europepmc.org/RestfulWebService). It requires matching article IDs and an explicit CC BY 4.0 or CC0 license URI before returning text. A browsable article or PubMed abstract alone is not reuse permission. Results include authors, a DOI, the source and license URLs, and location-tagged passages from explicit recommendation sections or tables and structured abstracts. The scheduled lesson records how each part was sourced in `lesson_provenance`. A guideline passage is included only if it exactly matches the curated English recommendation or its editor-approved `recommendation_excerpt_sha256` (SHA-256 of the whitespace-normalized passage text); full text access is not a clinical match.

Run `python3 -m pipeline.lesson_coverage` for a JSON report of full-text and recommendation-match coverage for the ten active rotation guidelines. It distinguishes API failures from cases where no supported reusable copy was found through Europe PMC; it does not check publisher websites.

Curated lesson text and quiz excerpts are drawn from cited sources but have not yet been reviewed by a physician. The app labels them this way in Vietnamese and English. Provenance describes where the material came from, not clinical approval.

`python3 -m pipeline.validate_lesson` checks every dated lesson from the November 24, 2026 rollout onward and the bundled offline fallback templates. Earlier archive entries are labeled as legacy and left unchanged. The refresh matches the new edition against the curated catalog before committing. Pages checks recorded citations, provenance, and quiz excerpts without consulting the current catalog, and stages evidence assets separately. Validation is read-only; a failure leaves the last successful deployment live. Clinical claims still need human review.

## Repository guide

| Path | Role |
| --- | --- |
| [`index.html`](index.html) · [`design.md`](design.md) | Browser app and design guidelines |
| [`search_ranking.js`](search_ranking.js) · [`search_ranking.py`](search_ranking.py) | Browser and backend search ranking |
| [`fetch_daily_ebm.py`](fetch_daily_ebm.py) · [`crawl_cardiology_news.py`](crawl_cardiology_news.py) | Local server, refresh, and PubMed retrieval |
| [`pillar_library.py`](pillar_library.py) · [`build_seed_briefings.py`](build_seed_briefings.py) | Curated briefing library and seed-bundle generator |
| [`data/briefings.js`](data/briefings.js) · [`data/rotation_state.json`](data/rotation_state.json) | Published briefing bundle and refresh state |
| [`pipeline/`](pipeline/) · [`evidence_feed.js`](evidence_feed.js) | Evidence ingestion, transforms, contract, and browser loader |
| [Architecture and data contract](AGENT_IMPLEMENTATION_PLAN.md) | Rotation, record fields, and how to change the app |
| [Editorial prompt](PROMPT.md) · [Example briefing](expected_output.md) | Evidence standards and the expected format |
| [AI guide](AGENTS.md) | Instructions for coding agents and limits of in-app AI |

## Checks

```sh
python3 -m unittest discover -s tests
for test in tests/*.js; do node "$test"; done
```

Install `pipeline/requirements.txt` first to include the dbt integration tests; the remaining checks do not need extra Python packages.

For browser changes, check both languages, a narrow viewport, and the static mode without API keys. Keep real patient information out of the app, local stores, and external queries.
