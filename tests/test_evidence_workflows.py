import copy
import importlib.util
import json
import os
import shutil
import subprocess
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fetch_daily_ebm import PILLARS, get_pillar_for_date, refresh_today_briefing
from focused_lessons import GATE_START_DATE
from recent_lessons import build_recent_templates
from pipeline import lesson_generation
from pipeline.validate_lesson import _read_bundle


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(importlib.util.find_spec("yaml") and shutil.which("bash") and shutil.which("jq"),
                     "Install the pipeline requirements, bash and jq to test workflow steps")
class EvidenceWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.output = self.root / "output"

    def workflow(self, name):
        import yaml
        path = ROOT / ".github" / "workflows" / f"{name}.yml"
        return yaml.load(path.read_text(), Loader=yaml.BaseLoader)

    def bash(self, script, **env):
        self.output.write_text("")
        return subprocess.run(["bash", "-eu", "-c", script], cwd=self.root, text=True, capture_output=True,
                              env={**os.environ, "GITHUB_OUTPUT": str(self.output), **env})

    def test_default_dispatch_skips_current_data_but_force_rebuilds(self):
        workflow = self.workflow("evidence_pipeline")
        self.assertEqual(workflow["on"]["workflow_dispatch"]["inputs"]["force"]["default"], "false")
        step = next(step for step in workflow["jobs"]["build"]["steps"] if step.get("id") == "snapshot")
        directory = self.root / "data" / "pipeline"
        directory.mkdir(parents=True)
        today = datetime.now(timezone.utc).date().isoformat()
        (directory / "briefing.json").write_text(f'{{"date":"{today}"}}')
        (directory / "evidence.parquet").write_text("fixture")
        for force, expected in [("false", "false"), ("true", "true")]:
            with self.subTest(force=force):
                result = self.bash(step["run"], EVENT="workflow_dispatch", FORCE=force)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"run={expected}", self.output.read_text().splitlines())

    def test_noop_dispatch_recovers_stale_pages_but_cron_noop_does_not(self):
        step = self.workflow("pages")["jobs"]["check-publication"]["steps"][0]
        script = """
        gh() { printf 'false\n'; }
        curl() { printf '{"date":"%s"}\n' "$LIVE_DATE"; }
        """ + step["run"]
        today = datetime.now(timezone.utc).date().isoformat()
        for event, live_date, expected in [("workflow_dispatch", "2020-01-01", "true"),
                                           ("workflow_dispatch", today, "false"),
                                           ("schedule", "2020-01-01", "false")]:
            with self.subTest(event=event, live_date=live_date):
                result = self.bash(script, UPSTREAM_EVENT=event, UPSTREAM_RUN="1", GITHUB_REPOSITORY="test/repo",
                                   UPSTREAM_NAME="Daily Cardiology Evidence Pipeline", LIVE_DATE=live_date)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(self.output.read_text().strip(), f"publish={expected}")

    def test_pages_serializes_build_and_deploy_after_publication_gate(self):
        wrapper = self.workflow("pages")
        self.assertNotIn("concurrency", wrapper)
        publish = wrapper["jobs"]["publish-site"]
        self.assertEqual(publish["needs"], "check-publication")
        self.assertEqual(publish["if"], "needs.check-publication.outputs.publish == 'true'")
        self.assertEqual(publish["concurrency"], {"group": "deploy-pages", "cancel-in-progress": "false"})
        self.assertEqual(publish["uses"], "./.github/workflows/pages_publish.yml")

    def test_pages_deploy_waits_for_build_and_uses_its_attempts_artifact(self):
        workflow = self.workflow("pages_publish")
        self.assertIn("workflow_call", workflow["on"])
        build, deploy = workflow["jobs"]["build"], workflow["jobs"]["deploy"]
        name = "github-pages-${{ github.run_attempt }}"
        upload = build["steps"][-1]
        self.assertEqual(upload["uses"], "actions/upload-pages-artifact@v3")
        self.assertEqual(upload["with"]["name"], name)
        self.assertEqual(build["outputs"]["artifact_name"], name)
        self.assertEqual(deploy["needs"], "build")
        self.assertNotIn("concurrency", deploy)
        self.assertNotIn("if", deploy)
        (step,) = deploy["steps"]
        self.assertEqual(step["uses"], "actions/deploy-pages@v4")
        self.assertEqual(step["with"]["artifact_name"], "${{ needs.build.outputs.artifact_name }}")

    def test_daily_refresh_validates_changed_lesson_before_commit(self):
        workflow = self.workflow("daily_refresh")
        self.assertEqual(workflow["on"]["push"]["branches"], ["main"])
        steps = workflow["jobs"]["refresh-daily-pillar"]["steps"]
        build, = [i for i, step in enumerate(steps) if "--refresh-if-needed" in step.get("run", "")]
        gate, = [i for i, step in enumerate(steps) if "pipeline.validate_lesson" in step.get("run", "")]
        commit, = [i for i, step in enumerate(steps) if "git commit" in step.get("run", "")]
        self.assertLess(build, gate)
        self.assertLess(gate, commit)
        self.assertNotIn("continue-on-error", steps[gate])
        script = 'git() { return "$DIFF_STATUS"; }\npython3() { return 42; }\n' + steps[gate]["run"]
        self.assertEqual(self.bash(script, DIFF_STATUS="0").returncode, 0)
        self.assertEqual(self.bash(script, DIFF_STATUS="1").returncode, 42)

    def test_pages_blocks_direct_merge_and_carryover_without_editing_legacy_or_evidence(self):
        steps = self.workflow("pages_publish")["jobs"]["build"]["steps"]
        assets, gate = [step["run"] for step in steps if "run" in step]
        self.assertNotIn("continue-on-error", next(step for step in steps if "pipeline.validate_lesson" in step.get("run", "")))
        for asset in ("index.html", "icon.svg", "manifest.json", "clinical_distractors.js", "case_quiz.js",
                      "clinical_mcq.js", "device_profile.js", "sync_config.js", "cloud_sync.js",
                      "search_ranking.js", "evidence_feed.js", "offline.js"):
            (self.root / asset).touch()
        data = self.root / "data"
        evidence = data / "pipeline"
        evidence.mkdir(parents=True)
        (evidence / "briefing.json").write_text('{"date":"2026-11-27"}')
        (evidence / "evidence.parquet").touch()
        pipeline = self.root / "pipeline"
        pipeline.mkdir()
        for module in ("validate_lesson.py", "lesson_generation.py", "lesson_sources.py", "ingest.py"):
            shutil.copy(ROOT / "pipeline" / module, pipeline)
        for module in ROOT.glob("*.py"):
            shutil.copy(module, self.root)
        shutil.copytree(ROOT / "lessons", self.root / "lessons")
        path = data / "briefings.js"
        rotation = data / "rotation_state.json"
        (data / "quiz_sets.js").write_text('window.EBM_QUIZ_SETS = {"sets": {}};\n')
        dates = [datetime.strptime(d, "%Y-%m-%d").date()
                 for d in (GATE_START_DATE, "2026-11-26", "2026-11-27", "2026-11-28")]
        with patch.object(lesson_generation, "fetch_article", return_value=None):
            rollout, prior, first, second = [lesson_generation.build_open_lesson(get_pillar_for_date(d), d.isoformat())
                                             for d in dates]
        legacy = {"id": "legacy", "date": "2026-11-23", "contents": "unchanged"}
        bad = copy.deepcopy(first)
        bad["quiz_items"][0]["answer"] = "0.94"

        templates = build_recent_templates(PILLARS)
        key = str(first["pillar_id"])

        def write(latest, *rows, fallbacks=templates, last_updated=None):
            state = {"last_updated": last_updated or latest["date"]}
            rotation.write_text(json.dumps(state))
            path.write_text("window.EBM_BRIEFINGS_DATA = " + json.dumps(
                {"rotation_state": state, "briefings": [latest, *rows], "focused_lessons": fallbacks}) + ";")

        def assert_blocked(message=f"{first['id']}: Every quiz key"):
            originals = path.read_bytes(), rotation.read_bytes()
            result = self.bash(gate)
            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertIn(message, result.stderr)
            self.assertFalse((self.root / "site" / "data" / "briefings.js").exists())
            self.assertEqual((path.read_bytes(), rotation.read_bytes()), originals)

        git_env = dict(GIT_AUTHOR_NAME="Test", GIT_AUTHOR_EMAIL="test@example.invalid",
                       GIT_COMMITTER_NAME="Test", GIT_COMMITTER_EMAIL="test@example.invalid")

        def git(script):
            result = self.bash(script, **git_env)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout.strip()

        write(first, prior, rollout, legacy)
        git("git init -qb main && git add *.py pipeline/ data/briefings.js data/rotation_state.json"
            " && git commit -qm 'Published lesson' && git switch -qc direct-merge")
        write(bad, prior, rollout, legacy)
        git("git commit -qam 'Direct bundle edit' && git switch -q main"
            " && git merge -q --no-ff direct-merge -m 'Merge direct bundle update'")
        result = self.bash(assets)
        self.assertEqual(result.returncode, 0, result.stderr)
        evidence_staged = self.root / "site" / "data" / "pipeline" / "briefing.json"
        self.assertEqual(evidence_staged.read_bytes(), (evidence / "briefing.json").read_bytes())
        assert_blocked()
        write(second, bad, prior, rollout, legacy)
        assert_blocked()

        bad_template = copy.deepcopy(templates[key])
        bad_template["quiz_items"][0]["answer"] = "0.94"
        write(second, first, prior, rollout, legacy, fallbacks={**templates, key: bad_template})
        assert_blocked(f"Fallback pillar {key}: Every quiz key")

        write(second, first, prior, rollout, legacy, fallbacks={k: v for k, v in templates.items() if k != key})
        assert_blocked(f"Missing fallback lesson for rotation pillar(s): {key}")
        write(legacy, last_updated=rollout["date"])
        assert_blocked("Missing scheduled lesson")
        write(first, prior, rollout, legacy, last_updated=second["date"])
        assert_blocked(f"Missing scheduled lesson for rotation date {second['date']}")

        write(second, first, prior, rollout, legacy)
        catalog = self.root / "focused_lessons.py"
        with catalog.open("a") as source:
            source.write('\nLESSONS[1][0]["recommendation"] = ("Edited", "Edited")\n')
        rotation.write_text('{"last_updated":"2026-01-01"}')
        result = self.bash(gate)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Rotation file does not match the lesson bundle", result.stderr)
        write(second, first, rollout, legacy)
        result = self.bash(gate)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Validated 3 dated archive lessons.", result.stdout)
        self.assertEqual((self.root / "site" / "data" / "briefings.js").read_bytes(), path.read_bytes())
        self.assertEqual(_read_bundle(path)["briefings"][-1], legacy)

    def test_rollout_regenerates_today_without_modifying_past_entries(self):
        day = datetime.strptime(GATE_START_DATE, "%Y-%m-%d").date()
        legacy = {"id": "pre-pipeline-past", "date": "2026-11-23", "pillar_id": 8}
        pid = get_pillar_for_date(day)["id"]
        today = {"id": f"ebm-{day}-p{pid}-focused", "date": day.isoformat(), "pillar_id": pid,
                 "lesson_format": "single_guideline"}
        working = self.root / "briefings.js"
        rotation = self.root / "rotation_state.json"
        rotation.write_text(json.dumps({"last_updated": day.isoformat()}))
        working.write_text("window.EBM_BRIEFINGS_DATA = " + json.dumps({"briefings": [today, legacy]}) + ";")
        with patch.multiple("fetch_daily_ebm", BRIEFINGS_JS_PATH=working, ROTATION_STATE_PATH=rotation), \
                patch("fetch_daily_ebm._today_vn", return_value=day), \
                patch.object(lesson_generation, "fetch_article", return_value=None):
            result = refresh_today_briefing()
        self.assertFalse(result["already_up_to_date"])
        self.assertTrue(result["briefing"]["lesson_provenance"])
        bundle = _read_bundle(working)
        self.assertEqual(bundle["briefings"], [result["briefing"], legacy])
        self.assertEqual(bundle["lesson_gate_start"], GATE_START_DATE)
