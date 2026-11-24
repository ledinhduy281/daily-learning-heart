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

    def test_pages_deploy_waits_for_build_and_uses_its_attempts_artifact(self):
        jobs = self.workflow("pages")["jobs"]
        build, deploy = jobs["build"], jobs["deploy"]
        name = "github-pages-${{ github.run_attempt }}"
        upload = build["steps"][-1]
        self.assertEqual(build["needs"], "check-publication")
        self.assertEqual(build["if"], "needs.check-publication.outputs.publish == 'true'")
        self.assertEqual(upload["uses"], "actions/upload-pages-artifact@v3")
        self.assertEqual(upload["with"]["name"], name)
        self.assertEqual(build["outputs"]["artifact_name"], name)
        self.assertEqual(deploy["needs"], "build")
        self.assertEqual(deploy["concurrency"]["group"], "deploy-pages")
        self.assertNotIn("if", deploy)
        (step,) = deploy["steps"]
        self.assertEqual(step["uses"], "actions/deploy-pages@v4")
        self.assertEqual(step["with"]["artifact_name"], "${{ needs.build.outputs.artifact_name }}")
