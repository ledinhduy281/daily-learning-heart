import importlib.util
import os
import shutil
import subprocess
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory


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
        gate, = [i for i, step in enumerate(refresh_steps) if "pipeline.validate_lesson" in step.get("run", "")]
        commit, = [i for i, step in enumerate(refresh_steps) if "git commit" in step.get("run", "")]
        self.assertLess(gate, commit)
        self.assertNotIn("continue-on-error", refresh_steps[gate])
        script = """
        git() { return "$DIFF_STATUS"; }
        python3() { return 42; }
        """ + refresh_steps[gate]["run"]
        self.assertEqual(self.bash(script, DIFF_STATUS="0").returncode, 0)
        self.assertEqual(self.bash(script, DIFF_STATUS="1").returncode, 42)

    def test_pages_retains_last_valid_lesson_and_stages_current_evidence(self):
        steps = self.workflow("pages_publish")["jobs"]["build"]["steps"]
        self.assertEqual(steps[0]["with"]["fetch-depth"], "0")
        assets, gate = [step["run"] for step in steps if "run" in step]
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
        (validator / "validate_lesson.py").write_text(
            "from pathlib import Path\n"
            "if Path('data/briefings.js').read_text() != Path('recommendation.txt').read_text():\n"
            "    raise SystemExit(1)\n"
        )
        bundle = data / "briefings.js"
        catalog = self.root / "recommendation.txt"
        bundle.write_text("Original approved recommendation")
        catalog.write_bytes(bundle.read_bytes())
        git_env = dict(GIT_AUTHOR_NAME="Test", GIT_AUTHOR_EMAIL="test@example.invalid",
                       GIT_COMMITTER_NAME="Test", GIT_COMMITTER_EMAIL="test@example.invalid")
        result = self.bash("git init -q && git add data/briefings.js pipeline/validate_lesson.py recommendation.txt"
                           " && git commit -qm 'Approved lesson'", **git_env)
        self.assertEqual(result.returncode, 0, result.stderr)
        bundle.write_text("Invalid direct submission")
        result = self.bash("git commit -qam 'Direct bundle update'", **git_env)
        self.assertEqual(result.returncode, 0, result.stderr)
        catalog.write_text("New editorial wording")
        result = self.bash("git commit -qam 'Editorial change'", **git_env)
        self.assertEqual(result.returncode, 0, result.stderr)

        result = self.bash(assets + "\n" + gate)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Skipping invalid lesson bundle", result.stdout)
        staged = self.root / "site" / "data"
        self.assertEqual((staged / "briefings.js").read_text(), "Original approved recommendation")
        self.assertEqual((staged / "pipeline" / "briefing.json").read_bytes(),
                         (evidence / "briefing.json").read_bytes())
