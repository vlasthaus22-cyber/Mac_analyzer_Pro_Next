from __future__ import annotations

import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from backend.services.system import batch_folder_metadata as metadata


class BatchFolderMetadataTests(unittest.TestCase):
    def test_filename_date_precedes_xlsx_or_filesystem_metadata(self):
        self.assertEqual(metadata.date_from_filename("Main_2026-10-27_09-42-05.csv"), "2026-10-27T09:42:05Z")
        self.assertEqual(metadata.date_from_filename("Main_20260230.csv"), "")

    def test_xlsx_core_created_date_is_read_with_a_bounded_member(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "Main.xlsx"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("docProps/core.xml", '<cp:coreProperties xmlns:cp="urn:core" xmlns:dcterms="urn:terms"><dcterms:created>2026-10-27T09:42:05+03:00</dcterms:created></cp:coreProperties>')
            self.assertEqual(metadata.observation_date(path), {"date": "2026-10-27T06:42:05Z", "source": "xlsx.created"})

    def test_filesystem_fallback_uses_windows_creation_time_and_otherwise_modification(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "Main.csv"
            path.write_text("mac\n", encoding="utf-8")
            info = metadata.observation_date(path)
            expected_source = "filesystem.created" if os.name == "nt" else "filesystem.modified"
            self.assertEqual(info["source"], expected_source)
            self.assertTrue(info["date"].endswith("Z"))

    def test_scan_returns_metadata_only_with_sorted_relative_paths_and_role_counts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "Main"
            (root / "nested").mkdir(parents=True)
            (root / "z_2026-10-27.csv").write_text("mac\n", encoding="utf-8")
            (root / "nested" / "a.csv").write_text("mac\n", encoding="utf-8")
            (root / "ignored.exe").write_text("not an import", encoding="utf-8")
            result = metadata.scan_batch_folders({"main": str(root), "smartroom": "", "ddio": ""})
            self.assertEqual(result["folders"]["main"], {"folderName": "Main", "files": 2})
            self.assertEqual([item["relativePath"] for item in result["files"]], ["nested/a.csv", "z_2026-10-27.csv"])
            self.assertEqual(result["files"][1]["dateSource"], "filename")
            self.assertTrue(all("path" not in item and "token" not in item for item in result["files"]))
            self.assertTrue(all(str(root) not in repr(item) for item in result["files"]))

    def test_scan_rejects_missing_main_and_invalid_paths_without_echoing_paths(self):
        with self.assertRaisesRegex(ValueError, "нет поддерживаемых"):
            with tempfile.TemporaryDirectory() as temporary:
                metadata.scan_batch_folders({"main": temporary})
        secret_path = "C:/private/customer/network"
        with self.assertRaises(ValueError) as raised:
            metadata.scan_batch_folders({"main": secret_path})
        self.assertNotIn(secret_path, str(raised.exception))

    def test_scan_rejects_oversized_folder_lists_instead_of_silently_truncating(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "one.csv").write_text("mac\n", encoding="utf-8")
            with patch.object(metadata, "MAX_BATCH_FOLDER_FILES", 0):
                with self.assertRaisesRegex(ValueError, "больше 0"):
                    metadata.scan_batch_folders({"main": str(root)})


if __name__ == "__main__":
    unittest.main()
