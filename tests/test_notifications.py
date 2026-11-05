import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch

from backend.services.integrations import notifications
from scripts.optional_sqlite_store import initialize_database


class NotificationServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.database = Path(self.temp.name) / "host.db"
        self.secret_path = str(Path(self.temp.name) / "config" / "secrets.dpapi")
        initialize_database(self.database)

    def tearDown(self):
        self.temp.cleanup()

    def test_channels_are_disabled_and_secrets_never_enter_sqlite_settings(self):
        channels = notifications.load_settings(str(self.database))
        self.assertEqual(set(channels), {"email", "telegram", "slack"})
        self.assertFalse(any(channel["enabled"] for channel in channels.values()))
        with patch.object(notifications, "_load_secret_file", return_value={}), patch(
            "backend.services.integrations.notification_secrets.save_secrets", return_value={"email": True, "slack": False, "telegram": False},
        ) as save_secrets:
            result = notifications.update_channel(
                str(self.database), self.secret_path, "email",
                {"enabled": True, "host": "smtp.example.test", "port": 587, "sender": "analyzer@example.test", "recipients": ["ops@example.test"]},
                {"password": "example-password"},
            )
        self.assertTrue(result["settings"]["enabled"])
        self.assertTrue(result["secretsConfigured"])
        save_secrets.assert_called_once()
        with closing(sqlite3.connect(self.database)) as connection:
            stored = connection.execute("SELECT config_json FROM notification_settings WHERE channel='email'").fetchone()[0]
        self.assertNotIn("example-password", stored)

    def test_config_rejects_arbitrary_slack_hosts_and_requires_tls_email_fields(self):
        with self.assertRaises(ValueError):
            notifications.normalize_settings("slack", {"enabled": True, "webhookUrl": "https://attacker.test/services/secret"})
        with self.assertRaises(ValueError):
            notifications.normalize_settings("email", {"enabled": True, "host": "smtp.example.test"})
        config = notifications.normalize_settings("email", {"host": "SMTP.EXAMPLE.TEST", "port": 70000, "security": "ssl"})
        self.assertEqual(config["port"], 65535)
        self.assertEqual(config["host"], "smtp.example.test")
        self.assertEqual(config["security"], "ssl")

    def test_test_message_requires_an_enabled_saved_channel_and_contains_no_device_data(self):
        sender = lambda *args: None
        with self.assertRaisesRegex(ValueError, "включите и сохраните"):
            notifications.send_test(str(self.database), self.secret_path, "slack", secrets_loader=lambda _path: {}, sender=sender)
        notifications.save_settings(str(self.database), "telegram", {"enabled": True, "chatId": "room-1"})
        delivered = []
        result = notifications.send_test(str(self.database), self.secret_path, "telegram", secrets_loader=lambda _path: {"telegram": {"botToken": "dummy"}}, sender=lambda *args: delivered.append(args))
        self.assertTrue(result["ok"])
        self.assertIn("Данные оборудования не включены", delivered[0][4])
        self.assertNotIn("001122334455", delivered[0][4])

    def test_automatic_delivery_only_sends_enabled_channels_and_limits_summary(self):
        notifications.save_settings(str(self.database), "telegram", {"enabled": True, "chatId": "room-1"})
        sent = []
        results = notifications.send_enabled(
            str(self.database), self.secret_path,
            {"title": "Analysis", "message": "Done", "deviceCount": 7, "fileName": "local.xlsx", "ip": "10.0.0.1"},
            secrets_loader=lambda _path: {"telegram": {"botToken": "dummy"}},
            sender=lambda *args: sent.append(args),
        )
        self.assertEqual(results, {"telegram": "sent"})
        self.assertEqual(len(sent), 1)
        self.assertIn("local.xlsx", sent[0][4])
        self.assertIn("Устройства: 7", sent[0][4])
        self.assertNotIn("10.0.0.1", sent[0][4])

    def test_http_payloads_use_fixed_telegram_host_and_reject_redirects(self):
        captured = []
        with patch.object(notifications, "build_opener") as build_opener:
            opener = build_opener.return_value
            telegram_response = opener.open.return_value.__enter__.return_value
            telegram_response.status = 200
            telegram_response.read.return_value = b'{"ok":true,"result":{"message_id":1}}'
            notifications._post_json("https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/sendMessage", {"text": "safe"})
            captured.append(opener.open.call_args.args[0])
        self.assertEqual(captured[0].full_url, "https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/sendMessage")
        self.assertIsInstance(notifications._NoRedirect(), notifications.HTTPRedirectHandler)
        request = notifications.Request("https://api.telegram.org/sendMessage")
        self.assertIsNone(notifications._NoRedirect().redirect_request(
            request, object(), 302, "Found", {}, "https://attacker.test/collect",
        ))

    def test_telegram_http_200_is_not_a_success_unless_bot_api_says_ok_true(self):
        for body in (b'{"ok":false,"description":"chat not found"}', b'{"description":"missing ok"}', b"not-json"):
            with self.subTest(body=body), patch.object(notifications, "build_opener") as build_opener:
                response = build_opener.return_value.open.return_value.__enter__.return_value
                response.status = 200
                response.read.return_value = body
                with self.assertRaises(OSError):
                    notifications._post_json(
                        "https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/sendMessage",
                        {"chat_id": "room", "text": "summary"},
                        require_telegram_success=True,
                    )

    def test_slack_http_200_is_success_only_with_documented_ok_body(self):
        with patch.object(notifications, "build_opener") as build_opener:
            response = build_opener.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = b"ok\n"
            notifications._post_json(
                "https://hooks.slack.com/services/unit-test/abcdefghijklmnopqrstuvwx",
                {"text": "summary"},
                require_slack_success=True,
            )

        for body in (b"channel_not_found", b"", b"not ok"):
            with self.subTest(body=body), patch.object(notifications, "build_opener") as build_opener:
                response = build_opener.return_value.open.return_value.__enter__.return_value
                response.status = 200
                response.read.return_value = body
                with self.assertRaises(OSError):
                    notifications._post_json(
                        "https://hooks.slack.com/services/unit-test/abcdefghijklmnopqrstuvwx",
                        {"text": "summary"},
                        require_slack_success=True,
                    )

    def test_channel_dispatch_enables_provider_specific_delivery_checks(self):
        cases = (
            (
                "telegram",
                {"chatId": "room-1"},
                {"botToken": "123456:abcdefghijklmnopqrstuvwxyz"},
                "https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/sendMessage",
                "require_telegram_success",
            ),
            (
                "slack",
                {},
                {"webhookUrl": "https://hooks.slack.com/services/unit-test/abcdefghijklmnopqrstuvwx"},
                "https://hooks.slack.com/services/unit-test/abcdefghijklmnopqrstuvwx",
                "require_slack_success",
            ),
        )
        for channel, config, secret, expected_url, success_flag in cases:
            with self.subTest(channel=channel), patch.object(notifications, "_post_json") as post_json:
                notifications._send_channel(channel, config, secret, "Subject", "Summary")
                self.assertEqual(post_json.call_args.args[0], expected_url)
                self.assertTrue(post_json.call_args.kwargs[success_flag])

    def test_smtp_supports_starttls_and_implicit_tls_with_certificate_context(self):
        for security, smtp_name in (("starttls", "SMTP"), ("ssl", "SMTP_SSL")):
            with self.subTest(security=security):
                config = {
                    "host": "smtp.example.test", "port": 587, "security": security,
                    "sender": "app@example.test", "recipients": ["ops@example.test"], "username": "",
                }
                client = Mock()
                manager = MagicMock()
                manager.__enter__.return_value = client
                with patch.object(notifications.smtplib, smtp_name, return_value=manager) as transport:
                    notifications._send_email(config, {}, "Subject", "Safe summary")
                if security == "ssl":
                    self.assertIn("context", transport.call_args.kwargs)
                    client.starttls.assert_not_called()
                else:
                    client.starttls.assert_called_once()
                    self.assertEqual(client.ehlo.call_count, 2)
                client.send_message.assert_called_once()

if __name__ == "__main__":
    unittest.main()
