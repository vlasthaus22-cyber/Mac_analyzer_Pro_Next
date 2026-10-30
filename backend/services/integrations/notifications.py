"""Explicit opt-in Email, Telegram, and Slack notification delivery."""

from __future__ import annotations

from contextlib import closing
from email.message import EmailMessage
from email.utils import getaddresses
import json
import re
import smtplib
import sqlite3
import ssl
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPSHandler, HTTPRedirectHandler, Request, build_opener

CHANNELS = ("email", "telegram", "slack")
MAX_RECIPIENTS = 20
MAX_SUMMARY_BYTES = 8_192
TIMEOUT_SECONDS = 10
EMAIL_RE = re.compile(r"^[^@\s]{1,128}@[^@\s]{1,190}$")


def _text(value: Any, limit: int) -> str:
    return "".join(character for character in str(value or "") if character >= " " and character != "\x7f").strip()[:limit]


def _addresses(value: Any) -> list[str]:
    raw = value if isinstance(value, list) else str(value or "").replace(";", ",").split(",")
    found = [address.strip() for _, address in getaddresses([str(item) for item in raw])]
    if not found or len(found) > MAX_RECIPIENTS or any(not EMAIL_RE.fullmatch(item) for item in found):
        raise ValueError("Введите от 1 до 20 корректных адресов получателей")
    return list(dict.fromkeys(found))


def normalize_settings(channel: str, value: Any) -> dict[str, Any]:
    if channel not in CHANNELS:
        raise ValueError("Неизвестный канал уведомлений")
    item = value if isinstance(value, dict) else {}
    enabled = item.get("enabled") is True
    if channel == "email":
        try:
            port = int(item.get("port", 587))
        except (TypeError, ValueError):
            port = 587
        result = {
            "enabled": enabled,
            "host": _text(item.get("host"), 253).lower(),
            "port": max(1, min(port, 65535)),
            "security": "ssl" if item.get("security") == "ssl" else "starttls",
            "username": _text(item.get("username"), 254),
            "sender": _text(item.get("sender"), 254),
            "recipients": _addresses(item.get("recipients", [])) if item.get("recipients") else [],
            "useStartTls": True,
        }
        if result["host"] and ("/" in result["host"] or "://" in result["host"]):
            raise ValueError("SMTP host must be a hostname without a URL")
        if result["sender"] and not EMAIL_RE.fullmatch(result["sender"]):
            raise ValueError("Введите корректный адрес отправителя")
        if enabled and (not result["host"] or not result["sender"] or not result["recipients"]):
            raise ValueError("Для Email укажите SMTP host, отправителя и получателей")
        return result
    if channel == "telegram":
        result = {"enabled": enabled, "chatId": _text(item.get("chatId"), 128)}
        if enabled and not result["chatId"]:
            raise ValueError("Для Telegram укажите chat ID")
        return result
    webhook = _text(item.get("webhookUrl"), 1_024)
    if webhook and not re.fullmatch(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_-]{20,700}", webhook):
        raise ValueError("Slack webhook должен вести на hooks.slack.com")
    result = {"enabled": enabled}
    if enabled and not webhook:
        raise ValueError("Для Slack укажите Incoming Webhook URL")
    return result


def save_settings(database_path: str, channel: str, value: Any) -> dict[str, Any]:
    normalized = normalize_settings(channel, value)
    with closing(sqlite3.connect(database_path, timeout=30)) as connection:
        with connection:
            connection.execute(
                "INSERT INTO notification_settings (channel, config_json, enabled, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) "
                "ON CONFLICT(channel) DO UPDATE SET config_json=excluded.config_json, enabled=excluded.enabled, updated_at=excluded.updated_at",
                (channel, json.dumps(normalized, ensure_ascii=False), int(normalized["enabled"])),
            )
    return normalized


def load_settings(database_path: str) -> dict[str, dict[str, Any]]:
    with closing(sqlite3.connect(database_path, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        rows = connection.execute("SELECT channel, config_json FROM notification_settings").fetchall()
    result = {}
    for row in rows:
        channel = str(row["channel"])
        if channel not in CHANNELS:
            continue
        try:
            result[channel] = normalize_settings(channel, json.loads(row["config_json"]))
        except (TypeError, ValueError, json.JSONDecodeError):
            result[channel] = normalize_settings(channel, {})
    for channel in CHANNELS:
        result.setdefault(channel, normalize_settings(channel, {}))
    return result


def settings_payload(database_path: str, secret_path: str, secrets_loader: Callable | None = None) -> dict[str, Any]:
    loader = secrets_loader or _load_secret_file
    secrets = loader(secret_path)
    return {
        "channels": load_settings(database_path),
        "secretsConfigured": {channel: bool(secrets.get(channel)) for channel in CHANNELS},
    }


def update_channel(database_path: str, secret_path: str, channel: str, config: Any, secret: Any = None, clear_secret: bool = False) -> dict[str, Any]:
    normalized = normalize_settings(channel, config)
    if not isinstance(secret, (dict, type(None))):
        raise ValueError("secret must be an object")
    if secret is not None and any(key not in {"password", "botToken", "webhookUrl"} for key in secret):
        raise ValueError("Unsupported secret field")
    if secret is not None and any(not isinstance(value, str) for value in secret.values()):
        raise ValueError("Secret values must be strings")
    current = _load_secret_file(secret_path)
    secret_values = {key: value for key, value in (secret or {}).items() if value}
    if clear_secret:
        current.pop(channel, None)
    elif secret_values:
        current[channel] = {**current.get(channel, {}), **secret_values}
    if clear_secret or secret_values:
        from backend.services.integrations.notification_secrets import save_secrets
        save_secrets(secret_path, current)
    if normalized["enabled"]:
        required_secret = {"telegram": "botToken", "slack": "webhookUrl"}.get(channel)
        if required_secret and not current.get(channel, {}).get(required_secret):
            raise ValueError("Для включения канала сохраните его секрет")
        if channel == "email" and normalized["username"] and not current.get(channel, {}).get("password"):
            raise ValueError("Для SMTP-аутентификации сохраните пароль")
    saved = save_settings(database_path, channel, normalized)
    return {
        "settings": saved,
        "secretsConfigured": bool(current.get(channel)),
    }


def _post_json(url: str, payload: dict[str, Any]) -> None:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
    opener = build_opener(HTTPSHandler(context=ssl.create_default_context()), _NoRedirect())
    with opener.open(request, timeout=TIMEOUT_SECONDS) as response:
        if response.status < 200 or response.status >= 300:
            raise OSError("Notification provider returned a non-success response")
        response.read(32 * 1024)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def _send_email(config: dict[str, Any], secret: dict[str, str], subject: str, body: str) -> None:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = config["sender"]
    message["To"] = ", ".join(config["recipients"])
    message.set_content(body)
    context = ssl.create_default_context()
    smtp_factory = smtplib.SMTP_SSL if config["security"] == "ssl" else smtplib.SMTP
    with smtp_factory(config["host"], config["port"], timeout=TIMEOUT_SECONDS, **({"context": context} if config["security"] == "ssl" else {})) as client:
        client.ehlo()
        if config["security"] == "starttls":
            client.starttls(context=context)
            client.ehlo()
        password = secret.get("password", "")
        if config["username"] or password:
            if not config["username"] or not password:
                raise ValueError("Для SMTP-аутентификации нужны username и пароль")
            client.login(config["username"], password)
        client.send_message(message)


def _send_channel(channel: str, config: dict[str, Any], secret: dict[str, str], subject: str, body: str) -> None:
    if channel == "email":
        _send_email(config, secret, subject, body)
        return
    if channel == "telegram":
        token = secret.get("botToken", "")
        if not token or not re.fullmatch(r"[0-9]{4,20}:[A-Za-z0-9_-]{20,}", token):
            raise ValueError("Настройте токен Telegram bot")
        _post_json(f"https://api.telegram.org/bot{token}/sendMessage", {"chat_id": config["chatId"], "text": body})
        return
    webhook = secret.get("webhookUrl", "")
    if not webhook or not re.fullmatch(r"https://hooks\.slack\.com/services/[A-Za-z0-9/_-]{20,700}", webhook):
        raise ValueError("Настройте Slack Incoming Webhook")
    _post_json(webhook, {"text": f"*{subject}*\n{body}"})


def format_summary(value: Any) -> tuple[str, str]:
    item = value if isinstance(value, dict) else {}
    subject = _text(item.get("title") or "MAC Analyzer Pro Next — сводка", 180)
    lines = [
        f"Событие: {_text(item.get('title') or 'Анализ завершён', 180)}",
        f"Результат: {_text(item.get('message') or 'Операция завершена.', 1_000)}",
        f"Время: {_text(item.get('timestamp'), 40)}",
    ]
    for key, label in (("fileName", "Файл"), ("deviceCount", "Устройства"), ("filledAddresses", "Устройства с адресом"), ("rooms", "Устройства с помещением"), ("processingTimeMs", "Время обработки, мс")):
        candidate = item.get(key)
        if candidate is not None and candidate != "":
            lines.append(f"{label}: {_text(candidate, 500)}")
    body = "\n".join(lines)
    if len(body.encode("utf-8")) > MAX_SUMMARY_BYTES:
        body = body[:MAX_SUMMARY_BYTES // 2]
    return subject, body


def send_enabled(database_path: str, secret_path: str, summary: Any, secrets_loader: Callable | None = None, sender: Callable | None = None) -> dict[str, str]:
    channels = load_settings(database_path)
    loader = secrets_loader or _load_secret_file
    secrets = loader(secret_path)
    subject, body = format_summary(summary)
    results: dict[str, str] = {}
    deliver = sender or _send_channel
    for channel in CHANNELS:
        config = channels[channel]
        if not config.get("enabled"):
            continue
        try:
            deliver(channel, config, secrets.get(channel, {}), subject, body)
            results[channel] = "sent"
        except Exception as error:
            results[channel] = f"failed:{type(error).__name__}"
    return results


def send_test(database_path: str, secret_path: str, channel: str, secrets_loader: Callable | None = None, sender: Callable | None = None) -> dict[str, Any]:
    if channel not in CHANNELS:
        raise ValueError("Неизвестный канал уведомлений")
    config = load_settings(database_path)[channel]
    if not config.get("enabled"):
        raise ValueError("Сначала включите и сохраните этот канал")
    loader = secrets_loader or _load_secret_file
    secrets = loader(secret_path)
    deliver = sender or _send_channel
    subject, body = format_summary({
        "title": "Тестовое уведомление MAC Analyzer Pro Next",
        "message": "Проверка канала связи. Данные оборудования не включены.",
    })
    try:
        deliver(channel, config, secrets.get(channel, {}), subject, body)
    except Exception as error:
        raise OSError(f"Тестовая доставка не выполнена ({type(error).__name__})") from None
    return {"ok": True, "channel": channel}


def _load_secret_file(path: str) -> dict[str, dict[str, str]]:
    from backend.services.integrations.notification_secrets import load_secrets
    return load_secrets(path)
