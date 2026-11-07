"""One-message, TLS-only SMTP sink for isolated notification browser smoke."""

from __future__ import annotations

import argparse
from email import policy
from email.parser import BytesParser
import json
import os
from pathlib import Path
import socket
import ssl


MAX_MESSAGE_BYTES = 16 * 1024


def _write_json(path: Path, value: dict[str, object]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, path)


def _readline(reader, limit: int = 4_096) -> bytes:
    line = reader.readline(limit + 1)
    if len(line) > limit or (line and not line.endswith(b"\n")):
        raise ValueError("SMTP command line exceeded its bound")
    return line


def serve(args: argparse.Namespace) -> int:
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(args.cert, args.key)
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", args.port))
    listener.listen(1)
    listener.settimeout(45)
    _write_json(args.ready_file, {"host": "127.0.0.1", "port": listener.getsockname()[1]})
    try:
        raw_connection, address = listener.accept()
        if address[0] != "127.0.0.1":
            raise ValueError("SMTP sink accepts loopback connections only")
        with context.wrap_socket(raw_connection, server_side=True) as connection:
            connection.settimeout(15)
            reader = connection.makefile("rb")
            connection.sendall(b"220 localhost isolated SMTP sink\r\n")
            accepted_recipient = False
            in_data = False
            message = bytearray()
            while True:
                line = _readline(reader)
                if not line:
                    raise ConnectionError("SMTP client disconnected before QUIT")
                command = line.decode("ascii", errors="replace").strip()
                verb, _, argument = command.partition(" ")
                verb = verb.upper()
                if in_data:
                    if line in (b".\r\n", b".\n"):
                        in_data = False
                        parsed = BytesParser(policy=policy.default).parsebytes(bytes(message))
                        recipients = [item.strip() for item in str(parsed.get("To", "")).split(",") if item.strip()]
                        body = parsed.get_body(preferencelist=("plain",))
                        body_text = body.get_content() if body else ""
                        if not accepted_recipient or recipients != [args.expected_to]:
                            connection.sendall(b"550 unexpected test recipient\r\n")
                            raise ValueError("SMTP message did not use its configured synthetic sink recipient")
                        if parsed.get("Subject") != "Тестовое уведомление MAC Analyzer Pro Next":
                            connection.sendall(b"550 unexpected test subject\r\n")
                            raise ValueError("SMTP message subject was not the expected test notification")
                        if "Данные оборудования не включены." not in body_text or len(message) > MAX_MESSAGE_BYTES:
                            connection.sendall(b"550 unexpected test body\r\n")
                            raise ValueError("SMTP test message included unexpected or oversized content")
                        _write_json(args.receipt_file, {
                            "sender": str(parsed.get("From", "")),
                            "recipients": recipients,
                            "subject": str(parsed.get("Subject", "")),
                            "body": body_text,
                            "bytes": len(message),
                        })
                        connection.sendall(b"250 queued in local disposable sink\r\n")
                        continue
                    if line.startswith(b".."):
                        line = line[1:]
                    message.extend(line)
                    if len(message) > MAX_MESSAGE_BYTES:
                        connection.sendall(b"552 message too large\r\n")
                        raise ValueError("SMTP test message exceeded its size bound")
                    continue
                if verb in {"EHLO", "HELO"}:
                    connection.sendall(b"250-localhost\r\n250 SIZE 16384\r\n")
                elif verb == "MAIL":
                    connection.sendall(b"250 sender accepted\r\n")
                elif verb == "RCPT":
                    accepted_recipient = argument.casefold() == f"to:<{args.expected_to}>".casefold()
                    connection.sendall(b"250 recipient accepted\r\n" if accepted_recipient else b"550 recipient rejected\r\n")
                elif verb == "DATA":
                    if not accepted_recipient:
                        connection.sendall(b"503 recipient required\r\n")
                    else:
                        in_data = True
                        message.clear()
                        connection.sendall(b"354 end with <CRLF>.<CRLF>\r\n")
                elif verb == "RSET":
                    accepted_recipient = False
                    message.clear()
                    connection.sendall(b"250 reset\r\n")
                elif verb == "NOOP":
                    connection.sendall(b"250 ok\r\n")
                elif verb == "QUIT":
                    connection.sendall(b"221 bye\r\n")
                    return 0 if args.receipt_file.exists() else 1
                else:
                    connection.sendall(b"502 command unsupported\r\n")
    finally:
        listener.close()
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--cert", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--ready-file", type=Path, required=True)
    parser.add_argument("--receipt-file", type=Path, required=True)
    parser.add_argument("--expected-to", default="sink@example.test")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535 or args.expected_to != "sink@example.test":
        parser.error("only an ephemeral/local port and the synthetic sink recipient are supported")
    try:
        return serve(args)
    except (OSError, ssl.SSLError, ValueError, ConnectionError) as error:
        print(f"SMTP smoke sink failed: {type(error).__name__}: {error}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
