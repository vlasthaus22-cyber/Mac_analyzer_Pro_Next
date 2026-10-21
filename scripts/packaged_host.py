"""PyInstaller entry point for the Python-free optional Windows host."""

from __future__ import annotations

import sys
from pathlib import Path


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] == "--server-mode":
        server_arguments = arguments[1:]
        if getattr(sys, "frozen", False):
            bundled_root = Path(getattr(sys, "_MEIPASS", ""))
            server_arguments.extend(("--app-file", str(bundled_root / "dist" / "MAC-Analyzer-Pro-Next.html")))
        sys.argv = [sys.argv[0], *server_arguments]
        from server import main as server_main

        return server_main()

    sys.argv = [sys.argv[0], *arguments]
    from scripts.optional_server_launcher import main as launcher_main

    return launcher_main()


if __name__ == "__main__":
    raise SystemExit(main())
