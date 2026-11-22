import datetime as dt
import json
import logging
import os
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

NCBI = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/"
TRIALS = "https://clinicaltrials.gov/api/v2/studies"
FDA = "https://api.fda.gov/drug/label.json"
SOURCES = ("pubmed", "clinicaltrials", "openfda")
LOGGER = logging.getLogger(__name__)


def get_json(url, params):
    request = Request(f"{url}?{urlencode(params)}", headers={
        "User-Agent": "DailyLearningHeart/1.0 (+https://github.com/ledinhduy281/daily-learning-heart)",
        "Accept": "application/json",
    })
    for attempt in range(3):
        try:
            with urlopen(request, timeout=25) as response:
                return json.load(response)
        except HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise
            retry_after = exc.headers.get("Retry-After", "")
            time.sleep(min(120, int(retry_after)) if retry_after.isdecimal() else 2 ** (attempt + 1))
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(2 ** (attempt + 1))


def fetch_pubmed(run_date):
    start = run_date - dt.timedelta(days=90)
    common = {"db": "pubmed", "retmode": "json", "tool": "daily_learning_heart"}
    if email := os.environ.get("NCBI_EMAIL"):
        common["email"] = email
    search = get_json(NCBI + "esearch.fcgi", {
        **common, "retmax": 60, "sort": "pub date",
        "term": '(cardiovascular diseases[MeSH Terms] OR cardiology[tiab] OR '
                'heart failure[tiab] OR atrial fibrillation[tiab] OR coronary artery[tiab] OR '
                'hypertension[tiab] OR cardiomyopathy[tiab] OR dyslipidemia[tiab])',
        "datetype": "pdat", "mindate": start.strftime("%Y/%m/%d"), "maxdate": run_date.strftime("%Y/%m/%d"),
    })
    ids = search["esearchresult"]["idlist"]
    if not isinstance(ids, list):
        raise ValueError("PubMed returned an invalid ID list")
    summary = None
    if ids:
        time.sleep(0.4)
        summary = get_json(NCBI + "esummary.fcgi", {**common, "id": ",".join(ids)})
    return {"search": search, "summary": summary}


def fetch_trials(run_date):
    start = run_date - dt.timedelta(days=90)
    return get_json(TRIALS, {
        "query.cond": "cardiovascular OR heart failure OR atrial fibrillation OR hypertension",
        "filter.advanced": f"AREA[LastUpdatePostDate]RANGE[{start},{run_date}]",
        "sort": "LastUpdatePostDate:desc", "pageSize": 50, "format": "json",
    })


def fetch_fda(run_date):
    start = run_date - dt.timedelta(days=365)
    drugs = ("atorvastatin", "rosuvastatin", "clopidogrel", "apixaban", "rivaroxaban",
             "sacubitril", "dapagliflozin", "empagliflozin", "amlodipine", "metoprolol")
    query = " OR ".join(f'openfda.generic_name:"{drug}"' for drug in drugs)
    try:
        return get_json(FDA, {
            "search": f"({query}) AND effective_time:[{start:%Y%m%d} TO {run_date:%Y%m%d}]",
            "limit": 50, "sort": "effective_time:desc",
        })
    except HTTPError as exc:
        if exc.code != 404:
            raise
        body = json.load(exc)
        if body.get("error", {}).get("code") != "NOT_FOUND":
            raise
        return body


def as_date(value):
    if not isinstance(value, str):
        return None
    for pattern in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return dt.datetime.strptime(value.strip(), pattern).date()
        except ValueError:
            continue
    return None


def pubmed_records(payload):
    if payload["summary"] is None:
        return
    result = payload["summary"]["result"]
    if not result["uids"]:
        raise ValueError("PubMed summary omitted all searched IDs")
    for uid in result["uids"]:
        item = result[uid]
        if "error" in item:
            continue
        yield (uid, item["title"], as_date(item.get("sortpubdate", "").split(" ")[0].replace("/", "-")),
               item.get("source") or item.get("fulljournalname"), ", ".join(item.get("pubtype", [])),
               " ".join(item.get("pubtype", [])), f"https://pubmed.ncbi.nlm.nih.gov/{uid}/")


def trial_records(payload):
    for item in payload["studies"]:
        protocol = item["protocolSection"]
        identity = protocol["identificationModule"]
        uid = identity["nctId"]
        status = protocol.get("statusModule", {})
        study_type = protocol.get("designModule", {}).get("studyType")
        conditions = " ".join(protocol.get("conditionsModule", {}).get("conditions", []))
        yield (uid, identity["briefTitle"], as_date(status.get("lastUpdatePostDateStruct", {}).get("date")),
               None, study_type, conditions, f"https://clinicaltrials.gov/study/{uid}")


def fda_records(payload):
    if payload.get("error", {}).get("code") == "NOT_FOUND":
        return
    for item in payload["results"]:
        uid = item["set_id"]
        names = item.get("openfda", {}).get("generic_name", [])
        name = names[0] if names else "Drug"
        yield (uid, f"{name} — US drug label", as_date(item.get("effective_time")), None, "Drug Label",
               " ".join(item.get("indications_and_usage", [])), f"https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid={uid}")


def ingest(connection, work_dir: Path, run_date: dt.date):
    raw_dir = work_dir / "raw" / f"date={run_date.isoformat()}"
    bronze_dir = work_dir / "bronze" / f"date={run_date.isoformat()}"
    raw_dir.mkdir(parents=True, exist_ok=True)
    bronze_dir.mkdir(parents=True, exist_ok=True)
    source_status = {}
    for source, fetch, normalize in zip(SOURCES, (fetch_pubmed, fetch_trials, fetch_fda),
                                         (pubmed_records, trial_records, fda_records)):
        raw = raw_dir / f"{source}.json"
        raw.unlink(missing_ok=True)
        try:
            payload = fetch(run_date)
            raw.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
            rows = list(normalize(payload))
        except (URLError, TimeoutError, ValueError, KeyError, TypeError, AttributeError) as exc:
            LOGGER.warning("%s ingestion failed: %s", source, exc)
            source_status[source] = {"status": "unavailable", "records": 0}
            rows = []
        else:
            source_status[source] = {"status": "ok", "records": len(rows)}
            LOGGER.info("%s: %d records", source, len(rows))

        connection.execute("""create or replace temp table source_load (
            source_id varchar, title varchar, source_date date, journal varchar,
            study_type varchar, topic_text varchar, source_url varchar
        )""")
        if rows:
            connection.executemany("insert into source_load values (?, ?, ?, ?, ?, ?, ?)", rows)
        connection.execute("copy source_load to ? (format parquet)", [str(bronze_dir / f"{source}.parquet")])

    (raw_dir / "status.json").write_text(json.dumps(source_status, indent=2) + "\n", encoding="utf-8")
    if not any(item["status"] == "ok" for item in source_status.values()):
        raise RuntimeError("All three evidence sources failed")
    return bronze_dir, source_status
