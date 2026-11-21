import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
KEY_PATTERNS = (
    r"gsk_[A-Za-z0-9_-]{20,}",
    r"sk-(?:proj-)?[A-Za-z0-9_-]{20,}",
    r"AIza[A-Za-z0-9_-]{30,}",
    r"AKIA[A-Z0-9]{16}",
    r"gh[pousr]_[A-Za-z0-9]{30,}",
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
)


class NoEmbeddedSecretsTests(unittest.TestCase):
    def test_no_credentials_in_shipped_files(self):
        files = subprocess.check_output(
            ["git", "ls-files"], cwd=ROOT, text=True
        ).splitlines()
        findings = []
        for filename in files:
            try:
                source = (ROOT / filename).read_text()
            except UnicodeError:
                continue
            for line_number, line in enumerate(source.splitlines(), 1):
                if any(re.search(pattern, line) for pattern in KEY_PATTERNS):
                    findings.append(f"{filename}:{line_number}")
        self.assertFalse(findings, "Credential locations: " + ", ".join(findings))

    def test_no_key_decoder_or_xor_blob(self):
        source = (ROOT / "index.html").read_text()
        forbidden = (r"\b_k\s*\(", r"String\.fromCharCode\([^\n]*\^",
                     r"\[(?:\s*\d+\s*,){20,}")
        for pattern in forbidden:
            self.assertFalse(re.search(pattern, source), "Key decoder/blob detected")

    def test_browser_chat_and_mcq_have_no_groq_calls(self):
        source = (ROOT / "index.html").read_text()
        self.assertFalse("api.groq.com" in source, "Browser Groq endpoint detected")
        self.assertFalse("callQuotaGuardedClientLLM" in source)
        self.assertIn("await this.composeClientDeterministicAnswer(", source)
        self.assertIn("this.buildDeterministicMcq(primary, 0, 0, lang, diff)", source)


if __name__ == "__main__":
    unittest.main()
