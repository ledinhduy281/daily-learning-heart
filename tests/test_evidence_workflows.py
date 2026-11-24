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

from fetch_daily_ebm import get_pillar_for_date
from pipeline import approved_lessons, lesson_generation
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
        refresh_steps = self.workflow("daily_refresh")["jobs"]["refresh-daily-pillar"]["steps"]
        gate, = [i for i, step in enumerate(refresh_steps) if "approved_lessons approve" in step.get("run", "")]
        commit, = [i for i, step in enumerate(refresh_steps) if "git commit" in step.get("run", "")]
        self.assertLess(gate, commit)
        self.assertNotIn("continue-on-error", refresh_steps[gate])
        script = """
        python3() { return 42; }
        """ + refresh_steps[gate]["run"]
        self.assertEqual(self.bash(script).returncode, 42)

    def test_pages_retains_last_valid_lesson_and_stages_current_evidence(self):
        steps = self.workflow("pages_publish")["jobs"]["build"]["steps"]
        self.assertEqual(steps[0]["with"]["fetch-depth"], "0")
        assets, stage_lessons = [step["run"] for step in steps if "run" in step]
        refresh = self.workflow("daily_refresh")["jobs"]["refresh-daily-pillar"]["steps"]
        restore = next(step["run"] for step in refresh if step.get("name") == "Restore the latest approved lesson archive")
        gate = next(step["run"] for step in refresh if "approved_lessons approve" in step.get("run", ""))
        for asset in ("index.html", "icon.svg", "manifest.json", "clinical_distractors.js",
                      "clinical_mcq.js", "device_profile.js", "sync_config.js", "cloud_sync.js",
                      "search_ranking.js", "evidence_feed.js", "offline.js"):
            (self.root / asset).touch()
        data = self.root / "data"
        evidence = data / "pipeline"
        evidence.mkdir(parents=True)
        (evidence / "briefing.json").write_text('{"date":"2026-11-27"}')
        (evidence / "evidence.parquet").touch()
        validator = self.root / "pipeline"
        validator.mkdir()
        for module in ("validate_lesson.py", "lesson_generation.py", "lesson_sources.py", "ingest.py",
                       "approved_lessons.py"):
            shutil.copy(ROOT / "pipeline" / module, validator)
        for module in ROOT.glob("*.py"):
            shutil.copy(module, self.root)
        bundle = data / "briefings.js"
        rotation_file = data / "rotation_state.json"
        manifest = data / "approved_lessons.json"
        catalog = self.root / "focused_lessons.py"
        dates = [datetime.strptime(d, "%Y-%m-%d").date() for d in ("2026-11-26", "2026-11-27")]
        with patch.object(lesson_generation, "fetch_article", return_value=None):
            first, second = [lesson_generation.build_open_lesson(get_pillar_for_date(d), d.isoformat())
                             for d in dates]
        bad = copy.deepcopy(first)
        bad["quiz_items"][0]["answer"] = "0.94"

        def write_bundle(latest, *rows):
            rotation = {"last_updated": latest["date"]}
            rotation_file.write_text(json.dumps(rotation))
            bundle.write_text("window.EBM_BRIEFINGS_DATA = " + json.dumps(
                {"rotation_state": rotation, "briefings": [latest, *rows]}) + ";")

        git_env = dict(GIT_AUTHOR_NAME="Test", GIT_AUTHOR_EMAIL="test@example.invalid",
                       GIT_COMMITTER_NAME="Test", GIT_COMMITTER_EMAIL="test@example.invalid")

        def git(script):
            result = self.bash(script, **git_env)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout.strip()

        def approve(lesson):
            return self.bash(f'date() {{ printf "%s\\n" "{lesson["date"]}"; }}\n' + gate)

        legacy = {"id": "archive-2026-11-25", "date": "2026-11-25", "pillar_id": 10}
        write_bundle(legacy)
        seed = git("git init -q && git hash-object -w data/briefings.js")
        module = validator / "approved_lessons.py"
        module.write_text(module.read_text().replace(approved_lessons.BOOTSTRAP_BLOB, seed))
        manifest.write_text(json.dumps({**approved_lessons.BOOTSTRAP, "bundle_blob": seed}))
        git("git add *.py pipeline/ data/briefings.js data/rotation_state.json data/approved_lessons.json"
            " && git commit -qm 'Bootstrap approved archive'")

        write_bundle(first, legacy)
        result = approve(first)
        self.assertEqual(result.returncode, 0, result.stderr)
        git("git commit -qam 'Approved lesson'")
        approved = bundle.read_bytes()
        write_bundle(bad)
        git("git commit -qam 'Direct bundle update'")
        with catalog.open("a") as source:
            source.write('\nLESSONS[1][0]["recommendation"] = ("Edited", "Edited")\n')
        git("git commit -qam 'Editorial change'")
        write_bundle(second, bad, legacy)
        git("git commit -qam 'New valid lesson carrying over the rejected entry'")
        self.assertNotEqual(approve(second).returncode, 0)
        rotation_file.write_text('{"last_updated":"2026-10-01"}')
        git("git commit -qam 'Rotation-only regression'")

        result = self.bash(assets + "\n" + stage_lessons, RUNNER_TEMP=str(self.root))
        self.assertEqual(result.returncode, 0, result.stderr)
        staged = self.root / "site" / "data"
        self.assertEqual((staged / "briefings.js").read_bytes(), approved)
        self.assertEqual((staged / "pipeline" / "briefing.json").read_bytes(),
                         (evidence / "briefing.json").read_bytes())
        result = self.bash(restore)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(bundle.read_bytes(), approved)
        self.assertEqual(json.loads(rotation_file.read_text())["last_updated"], first["date"])
        self.assertEqual(approve(first).returncode, 0)
        write_bundle(second, first, legacy)
        result = approve(second)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"Validated daily lesson: {second['id']}", result.stdout)
        git("git commit -qam 'Approve the next lesson from the clean archive'")

        expected = bundle.read_bytes()
        bundle.unlink()
        rotation_file.unlink()
        manifest.unlink()
        git("git commit -qam 'Remove working copies and manifest'")
        result = self.bash(stage_lessons, RUNNER_TEMP=str(self.root))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((staged / "briefings.js").read_bytes(), expected)
        result = self.bash(restore)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(bundle.read_bytes(), expected)
        self.assertEqual(json.loads(rotation_file.read_text())["last_updated"], second["date"])
        self.assertEqual(_read_bundle(bundle)["briefings"], [second, first, legacy])
        self.assertEqual(approve(second).returncode, 0)
        self.assertEqual(json.loads(manifest.read_text())["bundle_blob"], git("git hash-object data/briefings.js"))
