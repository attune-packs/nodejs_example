"""Offline release checks, including real Node.js action subprocesses."""

import functools
import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[1]


class ReleaseTests(unittest.TestCase):
    def test_complete_mit_license(self):
        # https://opensource.org/license/mit, retaining the original attribution.
        license_bytes = (ROOT / "LICENSE").read_bytes()
        self.assertEqual(
            hashlib.sha256(license_bytes).hexdigest(),
            "19c3c4853b1e6ef6a7dabf41fdf427e44579637de81c40cd91b2275257f5d935",
        )
        self.assertEqual(
            license_bytes.splitlines()[2], b"Copyright (c) 2025 Attune Automation"
        )

    def test_manifest_and_package_version(self):
        manifest = yaml.safe_load((ROOT / "pack.yaml").read_text())
        self.assertEqual(manifest["license"], "MIT")
        self.assertEqual(manifest["version"], "1.0.1")
        package = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(package["version"], manifest["version"])

    def test_yaml_syntax(self):
        for path in ROOT.rglob("*.yaml"):
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertIsInstance(yaml.safe_load(path.read_text()), dict)
        for path in (ROOT / ".github/workflows").glob("*.yml"):
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertIsInstance(yaml.safe_load(path.read_text()), dict)

    def test_javascript_syntax(self):
        for directory in ("actions", "sensors"):
            for path in (ROOT / directory).glob("*.js"):
                with self.subTest(path=path.relative_to(ROOT)):
                    subprocess.run(["node", "--check", str(path)], check=True)

    def run_action(self, name, parameters):
        result = subprocess.run(
            ["node", str(ROOT / "actions" / f"{name}.js")],
            input=json.dumps(parameters) + "\n",
            text=True,
            capture_output=True,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_hello_default(self):
        self.assertEqual(self.run_action("hello", {}), {"message": "Hello, Node.js"})

    def test_hello_custom(self):
        self.assertEqual(
            self.run_action("hello", {"name": "License check"}),
            {"message": "Hello, License check"},
        )

    def test_counter_default(self):
        result = self.run_action("read_counter", {})
        self.assertEqual(result["counter"], 0)
        self.assertEqual(result["rule_ref"], "unknown")

    def test_counter_custom(self):
        result = self.run_action("read_counter", {"counter": 42, "rule_ref": "test.rule"})
        self.assertEqual(result["counter"], 42)
        self.assertEqual(result["rule_ref"], "test.rule")

    def test_http_real_loopback_request(self):
        with tempfile.TemporaryDirectory() as directory:
            body = "release HTTP smoke\n"
            Path(directory, "index.html").write_text(body)
            handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                result = self.run_action(
                    "http_example", {"url": f"http://127.0.0.1:{server.server_port}/"}
                )
                self.assertEqual(result["status_code"], 200)
                self.assertEqual(result["snippet"], body)
                self.assertTrue(result["success"])
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
