from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import packaged_host


class PackagedHostDispatchTests(unittest.TestCase):
    def test_default_entry_delegates_to_optional_health_checked_launcher(self):
        with patch.object(sys, "argv", ["host.exe"]):
            with patch("scripts.optional_server_launcher.main", return_value=0) as launcher:
                self.assertEqual(packaged_host.main(["--root", "C:/MAC Analyzer/Папка"]), 0)
                launcher.assert_called_once_with()
                self.assertEqual(sys.argv, ["host.exe", "--root", "C:/MAC Analyzer/Папка"])

    def test_server_mode_uses_embedded_html_but_keeps_explicit_writable_data_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(sys, "argv", ["host.exe"]):
                with patch.object(sys, "frozen", True, create=True):
                    with patch.object(sys, "_MEIPASS", temporary, create=True):
                        with patch("server.main", return_value=0) as serve:
                            args = ["--server-mode", "--root", "C:/MAC Analyzer/Папка", "--port", "9001", "--shutdown-token", "secret"]
                            self.assertEqual(packaged_host.main(args), 0)
                            serve.assert_called_once_with()
                            self.assertEqual(sys.argv[1:], [
                                "--root", "C:/MAC Analyzer/Папка", "--port", "9001", "--shutdown-token", "secret",
                                "--app-file", str(Path(temporary) / "dist" / "MAC-Analyzer-Pro-Next.html"),
                            ])


if __name__ == "__main__":
    unittest.main()
