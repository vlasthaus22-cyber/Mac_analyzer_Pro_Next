import io
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.services.workspace.cache import (  # noqa: E402
    delete_workspace_file,
    list_workspace_files,
    save_workspace_file,
    workspace_file_path,
)


class WorkspaceCacheTests(unittest.TestCase):
    def test_binary_upload_is_streamed_into_opaque_storage_and_listed_without_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            content = b"MAC,Vendor\n00:11:22:33:44:55,Acme\n"
            saved = save_workspace_file(
                directory, name=r"C:\Private\Main.csv", role="main", media_type="text/csv",
                last_modified=123, source=io.BytesIO(content), length=len(content),
            )
            self.assertEqual(saved["name"], "Main.csv")
            self.assertEqual(saved["role"], "main")
            self.assertEqual(saved["size"], len(content))
            self.assertEqual(len(saved["sha256"]), 64)
            self.assertNotIn("path", saved)
            path, metadata = workspace_file_path(directory, saved["token"])
            self.assertEqual(path.read_bytes(), content)
            self.assertEqual(metadata["sha256"], saved["sha256"])
            listing = list_workspace_files(directory)
            self.assertEqual((listing["total"], listing["bytes"]), (1, len(content)))
            self.assertNotIn("path", listing["files"][0])

    def test_upload_rejects_invalid_role_name_and_incomplete_stream(self):
        with tempfile.TemporaryDirectory() as directory:
            content = b"data"
            for kwargs in (
                {"name": "Main.csv", "role": "unknown"},
                {"name": "Main.exe", "role": "main"},
            ):
                with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                    save_workspace_file(directory, **kwargs, source=io.BytesIO(content), length=len(content))
            with self.assertRaisesRegex(ValueError, "ended before Content-Length"):
                save_workspace_file(
                    directory, name="Main.csv", role="main", source=io.BytesIO(b"a"), length=2,
                )
            self.assertEqual(list_workspace_files(directory)["total"], 0)
            path_name = save_workspace_file(
                directory, name="../Main.csv", role="main", source=io.BytesIO(content), length=len(content),
            )
            self.assertEqual(path_name["name"], "Main.csv")

    def test_file_tokens_cannot_escape_cache_and_delete_removes_only_selected_file(self):
        with tempfile.TemporaryDirectory() as directory:
            first = save_workspace_file(
                directory, name="Main.csv", role="main", source=io.BytesIO(b"first"), length=5,
            )
            second = save_workspace_file(
                directory, name="DDIO.csv", role="ddio", source=io.BytesIO(b"second"), length=6,
            )
            with self.assertRaises(FileNotFoundError):
                workspace_file_path(directory, "..\\outside")
            self.assertTrue(delete_workspace_file(directory, first["token"]))
            self.assertEqual(list_workspace_files(directory)["total"], 1)
            remaining, _ = workspace_file_path(directory, second["token"])
            self.assertEqual(remaining.read_bytes(), b"second")


if __name__ == "__main__":
    unittest.main()
