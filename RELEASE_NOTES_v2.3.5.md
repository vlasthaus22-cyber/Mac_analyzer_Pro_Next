# MAC Analyzer Pro Next v2.3.5

Стабильный полный выпуск: автономное приложение, Windows host, исходный код, документация, справочные данные и инструкции.

## Изменения

- Счётчик сверху показывает число устройств активного Final, а история аналитики считает уникальные MAC в каждом Final.
- Аналитика исключает повторные строки с тем же MAC из общего числа устройств и подсчёта устройств без помещения.
- Значение address больше не разбирается как иерархия помещения. Явные location/locationPath и legacy-пути в поле room сохраняют прежнее распознавание.
- Поиск и однофайловые результаты показывают один столбец «Адрес». Для старых записей он подхватывает physicalAddress, если address пуст.
- Добавлен потоковый экспорт полного результата поиска в Excel/XLSX, включая разбиение больших выгрузок на листы.
- Графики динамики, присутствия и общего числа устройств стали компактнее.
- Руководство разъясняет, что рабочая база находится в IndexedDB профиля браузера, а переносимая копия скачивается как JSON .madb.json.

## Проверки и комплект

- Focused regressions: normalization, duplicate MAC analytics, address mapping, search XLSX, Inventory columns, cache counters.
- `pnpm check` passed: syntax, ESLint, parity validation, portable build, Windows host build and runtime checks, complete Node suite, Python 199/199, and verified full release ZIP.
- Chrome headless browser smoke passed on the generated autonomous HTML, including imports, merging, analytics, XLSX/TXT exports, archives, cancellation, reload/recovery, and two 5,000-device Final runs.
- `pnpm check:release-readiness` passed: 188/188 parity requirements verified (100%).
- Full ZIP: 362 entries, 22,185,717 bytes, SHA-256 `e37ff8843329a5a6014f1ce61b6ee71125f423433e325f5ad4beee3e00011d9f`.
