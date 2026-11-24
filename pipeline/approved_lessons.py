"""Approve refreshed lesson bundles and stage only a verified archive."""

import argparse
import hashlib
import json
import sys
from datetime import date, timedelta
from pathlib import Path

from fetch_daily_ebm import get_pillar_for_date
from focused_lessons import build_focused_templates
from pillar_library import PILLARS
from pipeline.validate_lesson import BUNDLE_ASSIGNMENT, _read_bundle, validate_bundle, validate_lesson


MANIFEST = Path("data/approved_lessons.json")
WORKING_BUNDLE = Path("data/briefings.js")
LEGACY_HASHES = Path("data/approved_legacy_sha256.txt")
INVALID_BUNDLE = (OSError, ValueError, KeyError, TypeError, AttributeError)


def _digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _legacy_hashes():
    try:
        return set(LEGACY_HASHES.read_text(encoding="utf-8").splitlines())
    except OSError:
        return set()


def _legacy_entries(bundle):
    known = _legacy_hashes()
    return {row["id"]: digest for row in bundle["briefings"] if (digest := _digest(row)) in known}


def _rotation(bundle):
    dates = [date.fromisoformat(row["date"]) for row in bundle["briefings"]
             if row.get("content_source") != "model_draft"]
    if not dates:
        return {}
    latest = max(dates)

    def pillar(offset):
        return get_pillar_for_date(latest + timedelta(days=offset))["id"]

    return {
        "last_updated": latest.isoformat(),
        "last_pillar_id": pillar(0),
        "today_pillar_id": pillar(0),
        "yesterday_pillar_id": pillar(-1),
        "tomorrow_pillar_id": pillar(1),
        "history": [pillar(offset) for offset in range(-9, 1)],
    }


def _recover(archive, edition_date):
    legacy_hashes = _legacy_hashes()
    briefings = {}
    scheduled_dates = set()
    for bundle in (archive, _read_working()):
        rows = bundle.get("briefings") if isinstance(bundle, dict) else None
        for row in rows if isinstance(rows, list) else []:
            try:
                lesson_id = row["id"]
                if not isinstance(lesson_id, str) or not lesson_id or lesson_id in briefings:
                    continue
                lesson_date = date.fromisoformat(row["date"])
                if _digest(row) in legacy_hashes:
                    if lesson_date >= edition_date:
                        continue
                else:
                    if lesson_date in scheduled_dates:
                        continue
                    validate_lesson(row, get_pillar_for_date(lesson_date), row["date"])
            except INVALID_BUNDLE:
                continue
            briefings[lesson_id] = row
            if row.get("content_source") != "model_draft":
                scheduled_dates.add(lesson_date)
    return {
        "briefings": sorted(briefings.values(), key=lambda row: row["date"], reverse=True),
        "pillars": PILLARS,
        "focused_lessons": build_focused_templates(PILLARS),
    }


def _read_working():
    try:
        return _read_bundle(WORKING_BUNDLE)
    except INVALID_BUNDLE:
        return None


def _approved(edition_date):
    archive = None
    try:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        archive = manifest["bundle"]
        legacy = manifest["legacy"]
        if (manifest["schema_version"] != 2 or _digest({"bundle": archive, "legacy": legacy}) != manifest["sha256"]
                or legacy != _legacy_entries(archive)):
            raise ValueError("Approved archive checksum does not match")
        briefings = []
        for row in archive["briefings"]:
            if row["id"] in legacy:
                if date.fromisoformat(row["date"]) >= edition_date:
                    continue
            elif row.get("content_source") != "model_draft" and not row.get("lesson_provenance"):
                raise ValueError("Non-legacy lesson is missing provenance")
            briefings.append(row)
        return {**archive, "briefings": briefings}
    except INVALID_BUNDLE as exc:
        print(f"::warning::Recovering approved lessons: {exc}", file=sys.stderr)
        return _recover(archive, edition_date)


def _write_bundle(destination, bundle):
    rotation = _rotation(bundle)
    bundle = {key: value for key, value in bundle.items() if key != "rotation_state"}
    bundle["rotation_state"] = rotation
    destination.mkdir(parents=True, exist_ok=True)
    (destination / WORKING_BUNDLE.name).write_text(
        BUNDLE_ASSIGNMENT + json.dumps(bundle, ensure_ascii=False, indent=2) + ";\n", encoding="utf-8",
    )
    (destination / "rotation_state.json").write_text(json.dumps(rotation, indent=2), encoding="utf-8")
    return bundle


def _write_manifest(bundle):
    snapshot = {key: value for key, value in bundle.items() if key != "rotation_state"}
    payload = {"bundle": snapshot, "legacy": _legacy_entries(snapshot)}
    manifest = {"schema_version": 2, "sha256": _digest(payload), "legacy": payload["legacy"], "bundle": snapshot}
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _approve(expected_date, previous_path):
    previous = _read_bundle(previous_path)
    bundle = _read_bundle(WORKING_BUNDLE)
    if _rotation(bundle).get("last_updated") != expected_date:
        raise ValueError("Refresh edition date does not match the latest scheduled lesson")
    lesson_id = validate_bundle(bundle, expected_date=expected_date, previous=previous)
    if bundle != previous:
        print(f"Validated daily lesson: {lesson_id}")
    _write_manifest(_write_bundle(WORKING_BUNDLE.parent, bundle))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subcommands = parser.add_subparsers(dest="command", required=True)
    restore = subcommands.add_parser("restore")
    restore.add_argument("destination", type=Path)
    restore.add_argument("--date", type=date.fromisoformat, required=True)
    approve = subcommands.add_parser("approve")
    approve.add_argument("--date", required=True)
    approve.add_argument("--previous", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "restore":
            _write_bundle(args.destination, _approved(args.date))
        else:
            _approve(args.date, args.previous)
    except INVALID_BUNDLE as exc:
        parser.exit(1, f"Lesson publication blocked: {exc}\n")


if __name__ == "__main__":
    main()
