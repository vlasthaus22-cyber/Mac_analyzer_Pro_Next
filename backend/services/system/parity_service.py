"""Bounded, read-only parity-registry validation for host diagnostics."""

from __future__ import annotations

from pathlib import Path
import re

MAX_PARITY_REGISTRY_BYTES = 4 * 1024 * 1024


def _check_parity_registry(project_root: Path) -> tuple[str, str]:
    registry = project_root / "PARITY_REGISTRY.md"
    try:
        size = registry.stat().st_size
        if size > MAX_PARITY_REGISTRY_BYTES:
            return "error", "Матрица parity превышает допустимый размер 4 МиБ."
        content = registry.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "warning", "Матрица parity не найдена; сверка функций с источником недоступна."
    except (OSError, UnicodeError):
        return "error", "Матрицу parity нельзя прочитать как UTF-8."

    identifiers: set[int] = set()
    duplicates = 0
    complete = 0
    for line in content.splitlines():
        if not re.match(r"^\|\s*\d+\s*\|", line):
            continue
        columns = line.split("|", 5)
        if len(columns) != 6 or not columns[1].strip().isdigit():
            return "error", "В строке требований матрицы parity нарушен формат."
        identifier = int(columns[1].strip())
        if identifier in identifiers:
            duplicates += 1
        identifiers.add(identifier)
        if columns[5].strip().startswith("Полностью:"):
            complete += 1
    if not identifiers:
        return "error", "В матрице parity не найдены строки требований."
    if duplicates:
        return "error", f"Матрица parity содержит повторяющиеся ID требований: {duplicates}."
    pending = len(identifiers) - complete
    detail = f"Матрица parity: полностью проверено {complete} из {len(identifiers)}; открыто или частично {pending}."
    return ("ok" if pending == 0 else "warning"), detail
