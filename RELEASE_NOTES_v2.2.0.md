# MAC Analyzer Pro Next v2.2.0

Полный выпуск browser-first версии MAC Analyzer Pro Next. Функциональная матрица сверена с исходным Web/PyQt перечнем: **188/188 требований полностью подтверждены, открытых пунктов нет**.

## Основные изменения

- Автономная HTML-программа включает парсинг и объединение Main/SmartRoom/DDIO, сравнения, массовые и отложенные задания, Dashboard/аналитику, Inventory, Final/History, отчёты, импорты/экспорты и portable archive.
- Сохранены сильная идентификация, приоритеты источников, атомарные Final, additive restore, миграции IndexedDB и bounded-memory обработка больших наборов.
- Перенесены совместимые импорты настроек/архивов PyQt, IEEE OUI и MAC5 знания, workspace/file-handle восстановление, локальные отчёты и optional loopback SQLite host.
- Внешние vendor и notification каналы остаются выключенными по умолчанию, требуют отдельного opt-in и передают только разрешённый минимум данных.
- Проверка повторного доступа к папке вызывает нативный `FileSystemDirectoryHandle.requestPermission()` из trusted user gesture; состояние кнопок сверяется с ответом Chrome.

## Проверки и артефакты

- `pnpm check` завершился успешно: JavaScript syntax, ESLint, 188 строк матрицы, автономный HTML/worker, packaged Windows host/runtime, полный Node suite, Python **199/199**, полный ZIP verifier.
- `pnpm check:release-readiness` прошёл: **188/188 требований (100%)**, code/test coverage **188/188 (100%)**.
- Chrome smoke проверил реальный нативный вызов File System Access на disposable OPFS handle с CDP trusted click; отдельные Edge smoke подтверждают Windows creation-time через optional host, импорты, аналитику, storage/restart, exports и backend workflows.
- Браузерное системное окно разрешений не оценивается визуально headless smoke; проверяется вызов нативного API и соответствующее состояние приложения.

Сборка, проверенная 2026-11-09:

| Файл | Размер | SHA-256 |
|---|---:|---|
| `MAC-Analyzer-Pro-Next.html` | 9 716 794 bytes | `5932bef77d086c2251eb0816b1bd6715bdcdcbe2c042dc0d280592e3c9d3ff9d` |
| `MAC-Analyzer-Pro-Next-Host.exe` | См. размер артефакта | См. checksum sidecar рядом с артефактами |

Полный ZIP включает автономный HTML, исходный код, документацию, migrations/reference data и инструкции; он не содержит пользовательскую базу данных. Его SHA-256 записывается в checksum sidecar рядом с архивом и проверяется release ZIP verifier. Для переноса пользовательских данных между браузерными профилями используйте portable database archive. Optional Windows host нужен только для локальных SQLite-функций и не синхронизирует IndexedDB автоматически.
