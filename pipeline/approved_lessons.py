"""Approve refreshed lesson bundles and stage only the pinned archive."""

import argparse
import io
import json
import re
import subprocess
import sys
import tarfile
from datetime import date, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

from fetch_daily_ebm import get_pillar_for_date
from pipeline.validate_lesson import BUNDLE_ASSIGNMENT, _parse_bundle, validate_bundle


MANIFEST = Path("data/approved_lessons.json")
BOOTSTRAP_BLOB = "394f522f6cb41453740781830bd0842d63077a9a"
BOOTSTRAP = {"bundle_blob": BOOTSTRAP_BLOB, "previous_blob": None, "catalog_commit": None}


def _git(*args):
    return subprocess.run(("git", *args), check=True, capture_output=True).stdout


def _oid(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("Invalid approved lesson object ID")
    return value


def _blob(oid):
    return _git("cat-file", "blob", _oid(oid)).decode("utf-8")


def _rotation(bundle):
    lessons = [row for row in bundle["briefings"] if row.get("content_source") != "model_draft"]
    latest = max(date.fromisoformat(row["date"]) for row in lessons)
    pillar = lambda offset: get_pillar_for_date(latest + timedelta(days=offset))["id"]
    return {
        "last_updated": latest.isoformat(),
        "last_pillar_id": pillar(0),
        "today_pillar_id": pillar(0),
        "yesterday_pillar_id": pillar(-1),
        "tomorrow_pillar_id": pillar(1),
        "history": [pillar(offset) for offset in range(-9, 1)],
    }


def _render(raw, bundle, rotation):
    if bundle.get("rotation_state") == rotation:
        return raw
    payload = {**bundle, "rotation_state": rotation}
    return BUNDLE_ASSIGNMENT + json.dumps(payload, ensure_ascii=False, indent=2) + ";\n"


def _verify(manifest):
    raw = _blob(manifest["bundle_blob"])
    bundle = _parse_bundle(raw)
    rotation = _rotation(bundle)
    if manifest == BOOTSTRAP:
        if validate_bundle(bundle, allow_predating_pipeline=True) is not None:
            raise ValueError("Bootstrap archive must predate the lesson pipeline")
    else:
        catalog = _oid(manifest["catalog_commit"])
        if manifest["previous_blob"] == manifest["bundle_blob"]:
            raise ValueError("Approval cannot use its own bundle as the previous archive")
        previous = _blob(manifest["previous_blob"])
        if bundle["rotation_state"]["last_updated"] != rotation["last_updated"]:
            raise ValueError("Approved edition date does not match the latest scheduled lesson")
        with TemporaryDirectory() as target:
            target = Path(target)
            with tarfile.open(fileobj=io.BytesIO(_git("archive", catalog))) as archive:
                archive.extractall(path=target, filter="data")
            (target / "candidate.js").write_text(raw, encoding="utf-8")
            (target / "previous.js").write_text(previous, encoding="utf-8")
            result = subprocess.run(
                (sys.executable, "-m", "pipeline.validate_lesson", "--bundle", "candidate.js",
                 "--previous", "previous.js", "--date", rotation["last_updated"]),
                cwd=target, capture_output=True, text=True,
            )
            if result.returncode:
                raise ValueError(result.stderr.strip() or "Approved lesson failed validation")
    return bundle, rotation, _render(raw, bundle, rotation)


def _read_current():
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def _read_previous():
    last_change = _git("log", "--first-parent", "-1", "--format=%H", "--", str(MANIFEST)).decode().strip()
    return json.loads(_git("show", f"{_oid(last_change)}^1:{MANIFEST}"))


def _approved():
    for read in (_read_current, _read_previous, lambda: BOOTSTRAP):
        try:
            manifest = read()
            return manifest, *_verify(manifest)
        except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.CalledProcessError,
                tarfile.TarError) as exc:
            print(f"::warning::Skipping unavailable or invalid lesson manifest: {exc}", file=sys.stderr)
    raise ValueError("No approved lesson archive is available")


def _restore(destination):
    _, _, rotation, rendered = _approved()
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "briefings.js").write_text(rendered, encoding="utf-8")
    (destination / "rotation_state.json").write_text(json.dumps(rotation, indent=2), encoding="utf-8")


def _approve(expected_date):
    previous, previous_bundle, _, rendered = _approved()
    path = Path("data/briefings.js")
    raw = path.read_text(encoding="utf-8")
    if raw == rendered:
        MANIFEST.write_text(json.dumps(previous, indent=2) + "\n", encoding="utf-8")
        return
    bundle = _parse_bundle(raw)
    rotation = _rotation(bundle)
    if rotation["last_updated"] != expected_date:
        raise ValueError("Refresh edition date does not match the latest scheduled lesson")
    lesson_id = validate_bundle(bundle, expected_date=expected_date, previous=previous_bundle)
    path.write_text(_render(raw, bundle, rotation), encoding="utf-8")
    approval = {
        "bundle_blob": _git("hash-object", str(path)).decode().strip(),
        "previous_blob": previous["bundle_blob"],
        "catalog_commit": _git("rev-parse", "HEAD").decode().strip(),
    }
    MANIFEST.write_text(json.dumps(approval, indent=2) + "\n", encoding="utf-8")
    print(f"Validated daily lesson: {lesson_id}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    restore = subcommands.add_parser("restore")
    restore.add_argument("destination", type=Path)
    approve = subcommands.add_parser("approve")
    approve.add_argument("--date", required=True)
    args = parser.parse_args()
    try:
        if args.command == "restore":
            _restore(args.destination)
        else:
            _approve(args.date)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"Lesson publication blocked: {exc}\n")


if __name__ == "__main__":
    main()
