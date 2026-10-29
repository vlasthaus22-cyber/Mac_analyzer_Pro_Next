import re
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class OptionalHostApiDocsTests(unittest.TestCase):
    def test_every_literal_optional_host_api_route_is_documented(self):
        server = (ROOT / "server.py").read_text(encoding="utf-8")
        documentation = (ROOT / "docs" / "OPTIONAL_HOST_API.md").read_text(encoding="utf-8")
        route_literals = set(re.findall(r"[\"'](/api/[A-Za-z0-9_./-]+)[\"']", server))
        missing = sorted(route for route in route_literals if route not in documentation)
        self.assertEqual(missing, [], "Document every literal optional-host route")
        self.assertIn("`GET /api/snapshots/{snapshot_id}/devices?", documentation)
        self.assertIn("`PUT /api/snapshots/{snapshot_id}`", documentation)
        self.assertIn("`DELETE /api/snapshots/{snapshot_id}`", documentation)


if __name__ == "__main__":
    unittest.main()
