"""Authorization helpers for privileged optional-host operations."""

from __future__ import annotations

import hmac


def authorize_loopback_shutdown(remote_address: str, authorization: str, expected_token: str | None) -> bool:
    """Require the one-launch token and IPv4 loopback for host shutdown."""
    if not expected_token or remote_address != "127.0.0.1":
        return False
    return hmac.compare_digest(authorization, f"Bearer {expected_token}")
