import os
import tempfile
import unittest
from pathlib import Path

from backend.services.integrations import notification_secrets


class NotificationSecretStoreTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows DPAPI is required")
    def test_secrets_are_round_tripped_as_ciphertext_outside_the_sqlite_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config" / "protected.dpapi"
            secret = "dummy-bot-token-not-a-real-credential"
            notification_secrets.save_secrets(path, {"telegram": {"botToken": secret}})
            ciphertext = path.read_bytes()
            self.assertTrue(ciphertext.startswith(notification_secrets.MAGIC))
            self.assertNotIn(secret.encode(), ciphertext)
            self.assertEqual(notification_secrets.load_secrets(path), {"telegram": {"botToken": secret}})

    def test_missing_secret_file_is_empty_and_invalid_headers_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing.dpapi"
            self.assertEqual(notification_secrets.load_secrets(path), {})
            path.write_bytes(b"not-protected")
            with self.assertRaises(ValueError):
                notification_secrets.load_secrets(path)

if __name__ == "__main__":
    unittest.main()
