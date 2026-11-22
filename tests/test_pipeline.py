import datetime as dt
import importlib.util
import json
import subprocess
import unittest
from http.client import IncompleteRead
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.error import URLError

from pipeline import ingest

RUN_DATE = dt.date(2026, 1, 20)
PMID = "12345678"
PUBMED = {"search": {"esearchresult": {"idlist": [PMID]}}, "summary": {"result": {
    "uids": [PMID, PMID], PMID: {"title": "Heart failure treatment", "sortpubdate": "2026/01/11 00:00",
                                 "source": "N Engl J Med", "pubtype": ["Randomized Controlled Trial"]},
}}}
TRIALS = {"studies": [{"protocolSection": {
    "identificationModule": {"nctId": "NCT01234567", "briefTitle": "An exercise study"},
    "conditionsModule": {"conditions": ["Atrial fibrillation"]},
    "designModule": {"studyType": "INTERVENTIONAL"},
    "statusModule": {"lastUpdatePostDateStruct": {"date": "2026-01-11"}},
}}]}
FDA = {"results": [{"set_id": "01234567-1234-4321-abcd-aaaaaaaaaaaa", "effective_time": "20251215",
                    "openfda": {"generic_name": ["Atorvastatin"]},
                    "indications_and_usage": ["Reduces LDL cholesterol"]}]}


class SourceTests(unittest.TestCase):
    def test_source_fields_and_dates(self):
        self.assertEqual(next(ingest.pubmed_records(PUBMED))[2], dt.date(2026, 1, 11))
        self.assertEqual(next(ingest.trial_records(TRIALS))[5], "Atrial fibrillation")
        self.assertEqual(next(ingest.fda_records(FDA))[2], dt.date(2025, 12, 15))
        self.assertIsNone(ingest.as_date("undated"))

    def test_retries_connection_reset_and_truncated_json(self):
        responses = [ConnectionResetError(), BytesIO(b'{"results": ['), BytesIO(b'{"results": []}')]
        with (patch.object(ingest, "urlopen", side_effect=responses) as urlopen,
              patch.object(ingest.time, "sleep")):
            self.assertEqual(ingest.get_json(ingest.FDA, {}), {"results": []})
        self.assertEqual(urlopen.call_count, 3)


@unittest.skipUnless(all(importlib.util.find_spec(name) for name in ("duckdb", "dbt", "jsonschema")),
                     "Install pipeline/requirements.txt to run dbt integration tests")
class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.work = TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.path = Path(self.work.name)

    def test_incomplete_reads_exhaust_retries_and_leave_other_sources_available(self):
        import duckdb

        with (patch.object(ingest, "fetch_pubmed", return_value=PUBMED),
              patch.object(ingest, "fetch_trials", return_value=TRIALS),
              patch.object(ingest, "urlopen", side_effect=IncompleteRead(b'{"results": [')) as urlopen,
              patch.object(ingest.time, "sleep"),
              duckdb.connect() as connection):
            _, status = ingest.ingest(connection, self.path, RUN_DATE)
        self.assertEqual(urlopen.call_count, 3)
        self.assertEqual(status["openfda"], {"status": "unavailable", "records": 0})
        self.assertEqual(status["pubmed"]["status"], "ok")
        self.assertEqual(status["clinicaltrials"]["status"], "ok")

    def test_dbt_dedupes_and_scores_a_partial_snapshot(self):
        import duckdb
        from pipeline.run import run

        with (patch.object(ingest, "fetch_pubmed", return_value=PUBMED),
              patch.object(ingest, "fetch_trials", return_value=TRIALS),
              patch.object(ingest, "fetch_fda", side_effect=URLError("fixture outage"))):
            run(self.path, RUN_DATE)
        payload = json.loads((self.path / "publish/briefing.json").read_text())
        self.assertEqual(payload["sources"]["openfda"], {"status": "unavailable", "records": 0})
        self.assertEqual([(row["source"], row["topic"], row["evidence_score"], row["relevance_score"])
                          for row in payload["items"]],
                         [("pubmed", "heart_failure", 90, 100), ("clinicaltrials", "arrhythmia", 20, 100)])
        partition = f"date={RUN_DATE}"
        self.assertEqual(json.loads((self.path / "raw" / partition / "pubmed.json").read_text()), PUBMED)
        with duckdb.connect() as conn:
            for relative, count in (
                (f"bronze/{partition}/pubmed.parquet", 2), (f"bronze/{partition}/openfda.parquet", 0),
                ("publish/evidence.parquet", 2),
            ):
                self.assertEqual(conn.execute("select count(*) from read_parquet(?)",
                                              [str(self.path / relative)]).fetchone(), (count,))

    def test_all_sources_down_does_not_publish(self):
        from pipeline.run import run

        with (patch.object(ingest, "fetch_pubmed", side_effect=URLError("fixture outage")),
              patch.object(ingest, "fetch_trials", side_effect=URLError("fixture outage")),
              patch.object(ingest, "fetch_fda", side_effect=URLError("fixture outage"))):
            with self.assertRaisesRegex(RuntimeError, "All three"):
                run(self.path, RUN_DATE)
        self.assertFalse((self.path / "publish").exists())

    def test_dbt_failure_does_not_publish(self):
        from pipeline.run import run

        empty_title = json.loads(json.dumps(PUBMED))
        empty_title["summary"]["result"][PMID]["title"] = ""
        with (patch.object(ingest, "fetch_pubmed", return_value=empty_title),
              patch.object(ingest, "fetch_trials", return_value=TRIALS),
              patch.object(ingest, "fetch_fda", return_value=FDA)):
            with self.assertRaises(subprocess.CalledProcessError):
                run(self.path, RUN_DATE)
        self.assertFalse((self.path / "publish").exists())

    def test_schema_failure_does_not_publish(self):
        import duckdb
        from jsonschema import ValidationError
        from pipeline.run import publish_files

        with duckdb.connect() as conn:
            conn.execute("create table evidence (source varchar, relevance_score int, evidence_score int, "
                         "source_date date, evidence_id varchar)")
            with self.assertRaises(ValidationError):
                publish_files(conn, RUN_DATE, {}, self.path / "publish")
        self.assertFalse((self.path / "publish").exists())
