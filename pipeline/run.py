import argparse
import datetime as dt
import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import duckdb
from jsonschema import Draft202012Validator

from pipeline.ingest import ingest

PIPELINE_DIR = Path(__file__).resolve().parent
DBT_DIR = PIPELINE_DIR / "dbt"
SCHEMA_PATH = PIPELINE_DIR / "briefing.schema.json"


def build_models(db_path, bronze_dir, run_date, work_dir):
    subprocess.run([sys.executable, "-c", "from dbt.cli.main import cli; cli()", "build",
                    "--project-dir", str(DBT_DIR), "--profiles-dir", str(DBT_DIR),
                    "--target-path", str(work_dir / "dbt-target"),
                    "--log-path", str(work_dir / "dbt-logs")],
                   env={**os.environ, "HEART_DUCKDB": str(db_path),
                        "HEART_BRONZE_DIR": str(bronze_dir), "HEART_RUN_DATE": run_date.isoformat()},
                   check=True)


def publish_files(connection, run_date, source_status, output_dir):
    result = connection.execute("""
        select * exclude (position)
        from (
            select *, row_number() over (
                partition by source
                order by relevance_score desc, evidence_score desc, source_date desc nulls last, evidence_id
            ) as position
            from evidence
        )
        where position <= 10
        order by relevance_score desc, evidence_score desc, source_date desc nulls last, evidence_id
    """)
    columns = [column[0] for column in result.description]
    items = [dict(zip(columns, row)) for row in result.fetchall()]
    briefing = json.dumps({"schema_version": 1, "date": run_date, "sources": source_status, "items": items},
                          default=dt.date.isoformat, ensure_ascii=False, indent=2) + "\n"
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER).validate(json.loads(briefing))
    output_dir.mkdir(parents=True, exist_ok=True)
    connection.execute("copy (select * from evidence order by evidence_id) to ? (format parquet)",
                       [str(output_dir / "evidence.parquet")])
    (output_dir / "briefing.json").write_text(briefing, encoding="utf-8")
    logging.info("Validated briefing JSON: %d records", len(items))


def run(work_dir, run_date):
    work_dir = work_dir.resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    db_path = work_dir / "heart.duckdb"
    with duckdb.connect(str(db_path)) as connection:
        bronze_dir, source_status = ingest(connection, work_dir, run_date)
    build_models(db_path, bronze_dir, run_date, work_dir)
    with duckdb.connect(str(db_path), read_only=True) as connection:
        publish_files(connection, run_date, source_status, work_dir / "publish")


def main():
    parser = argparse.ArgumentParser(description="Build and validate a dated cardiology evidence snapshot.")
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--date", type=dt.date.fromisoformat, default=dt.datetime.now(dt.timezone.utc).date())
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    run(args.work_dir, args.date)


if __name__ == "__main__":
    main()
