# Проверки Next

## Локальные проверки

Установите Node.js 20+, pnpm и Python 3.10+ для integration suite optional host,
затем выполните в корне проекта:

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` выполняет синтаксические проверки, ESLint и весь набор тестов без
зависимости от установленной команды `npm`. В составе проверки собирается
portable HTML, проверяется граф включённых модулей и компилируется inline
JavaScript полученного артефакта. Также валидируются ссылки модулей и тестов в
`PARITY_REGISTRY.md`, собирается полный исходный ZIP, проверяются его внутренние
SHA-256/CRC и исключение пользовательских баз. Полная проверка также запускает
все Node tests и `unittest discover` для Python integration tests; Python runtime
ниже 3.10 или его отсутствие дают ошибку, а не пропускают suite. Используйте
`node scripts/run-python-tests.mjs` для отдельного запуска. Если Python не находится в `PATH`,
задайте переменную `PYTHON` полным путём к `python.exe`. `pnpm package:release` отдельно
собирает автономный HTML, ZIP и внешний SHA-256 sidecar в `dist/`.

На Windows перед `pnpm check` установите `requirements-windows-packaging.txt`
в Python-окружение, выбранное через `PYTHON`. Полная проверка собирает
однофайловый loopback host `asInvoker`, проверяет встроенный HTML и API во
временном пути с пробелами и кириллицей и включает EXE в полный ZIP. Эта
проверка не открывает браузер и не обращается к пользовательским базам.

Если файл в `dist/` открыт или заблокирован, все команды сборки и проверки
артефактов используют единый альтернативный каталог из `MAC_ANALYZER_DIST_DIR`.
В PowerShell назначьте ему новый каталог под `$env:TEMP` перед `pnpm check`;
HTML-проверка и ZIP-проверка будут использовать этот каталог, а внутренний путь
HTML в ZIP останется `dist/MAC-Analyzer-Pro-Next.html`.

Перед публикацией GitHub Release выполните `pnpm check:release-readiness`.
Проверка блокирует публикацию, пока в `PARITY_REGISTRY.md` есть любое требование
со статусом «Частично», «Не закрыто», «Не проверено» или «Не реализовано».
Локальная сборка portable HTML/ZIP остаётся доступна для проверки артефактов;
она сама по себе не подтверждает готовность к публикации.

Отдельная команда `pnpm update:ieee-registry` обновляет offline reference JSON
через официальные IEEE CSV-источники. Она требует сеть и запускается отдельно;
обычная сборка использует сохранённый JSON и остаётся автономной.

Горячие клавиши имеют отдельные unit-проверки распознавания, модификаторов и
сохранения стандартного редактирования в текстовых полях.

## Browser smoke для автономного HTML

Соберите автономную программу через `pnpm build`, затем запустите поддерживаемый
Edge с отдельным временным профилем и DevTools endpoint:

```powershell
$smokeId = [guid]::NewGuid().ToString('N')
$smokeProfile = Join-Path $env:TEMP "mac-analyzer-next-smoke-$smokeId"
$smokeDb = "mac-analyzer-pro-next-test-$smokeId"
$appFile = (Resolve-Path 'dist\MAC-Analyzer-Pro-Next.html').Path
$appUrl = ([uri]$appFile).AbsoluteUri + "?db=$smokeDb"
$edgeCommand = Get-Command msedge.exe -ErrorAction SilentlyContinue
$edgePath = if ($edgeCommand) { $edgeCommand.Source } else { Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe' }
if (-not (Test-Path -LiteralPath $edgePath)) { throw "Edge executable not found: $edgePath" }
Start-Process $edgePath -WindowStyle Hidden -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run',
  '--remote-allow-origins=*', '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=9333', "--user-data-dir=$smokeProfile", $appUrl
)
node tools/browser-smoke.mjs 9333 $appUrl
```

Smoke сам дожидается DevTools endpoint, выбирает вкладку по точному disposable DB ID (и создаёт её через DevTools, если Edge запустился без начальной страницы), создаёт случайный первый инженерный пароль через штатную форму только в новой disposable IndexedDB, открывает lazy-вкладку импорта перед поиском полей и автоматически подтверждает штатные browser confirm-диалоги только в этом disposable прогоне. Он проверяет Main/SmartRoom/DDIO, DDIO IP, SmartRoom-комнату для MAC без Smartroom ID, полный список отклонения switch IP 3:1, оба режима подбора файлов и границы допуска 0/24 часа, переназначение SmartRoom/DDIO, отключение цикла, файлы без пары, проверку двух batch-пар, последовательную запись, повторную идемпотентность, состав Final/Inventory, отдельный UI-анализ CSV и его историю, создание расписания, ручную очередь и автоматическую очередь после наступления due времени. После завершения проверяется восстановление Final после перезагрузки страницы. И профиль, и имя IndexedDB создаются уникальными, поэтому smoke не открывает пользовательскую базу.

Для проверки UI-анализа одного файла во всех заявленных форматах используйте отдельный Edge-профиль и свежую disposable IndexedDB, затем запустите `node tools/browser-smoke.mjs 9333 $appUrl --single-file-all-formats-only`. Сценарий загружает CSV, TSV, TXT, JSON, XLSX, XLSM и legacy XLS через штатный file input, применяет mapping review, запускает анализ и сверяет точное число устройств с сохранённой записью single-analysis. Режим использует `tests/fixtures/legacy-devices.xls`; другие тестовые файлы формируются в памяти и не меняют рабочую базу.

Для browser smoke сортировки #638 используйте отдельный headless Edge-профиль и новую disposable IndexedDB, затем запустите `node tools/browser-smoke.mjs 9333 $appUrl --table-sorter-parity-only`. Сценарий сортирует сохранённый Inventory по MAC в обоих направлениях через IndexedDB index, создаёт три одноразовых IP→address rules через Data UI и проверяет DOM-сортировку обычной таблицы кликом, Space и Enter с доступным `aria-sort` и естественным числовым порядком IP.

Для end-to-end проверки детектора и диалога сопоставления колонок используйте отдельный Edge-профиль и disposable IndexedDB, затем запустите `node tools/browser-smoke.mjs 9333 $appUrl --column-mapping-review-only`. Сценарий через single-file UI загружает CSV с сильным Device ID, MAC, endpoint/switch IP и конфликтующим Device Type/model образцом; проверяет confidence, причины, альтернативы и примеры, не изменяет схему при отмене, запрещает пустой draft без сильной identity, принимает рекомендации с уникальными колонками/обязательным MAC и подтверждает точный результат анализа.

Для проверки локального vendor detector используйте disposable Edge profile/IndexedDB с командами выше и запустите node tools/browser-smoke.mjs 9333 $appUrl --ieee-registry-parity-only. Smoke проходит detector settings и enrichment через UI, проверяет IEEE OUI source/confidence в Web и PyQt precedence profiles, CID catalog-only поведение и сохранённые manufacturer/model inference provenance.

Для исторического консенсуса адреса по switch IP используйте отдельный Edge-профиль и disposable IndexedDB по командам выше, затем запустите node tools/browser-smoke.mjs 9333 $appUrl --historical-address-consensus-only. Сценарий создаёт три исторических Final и текущий Final через UI, проверяет применение порога ≥90%, оставляет 89% на ручную проверку, сохраняет известное значение Main, проверяет источник/confidence/альтернативы и убеждается, что исторически выведенный адрес не записывается как новое независимое свидетельство.

Для восстановления пустых полей базового Final в сравнении запустите тот же browser setup с `node tools/browser-smoke.mjs 9333 $appUrl --comparison-history-backfill-only`. Он создаёт три синтетических Final, проверяет восстановленное значение в derived Dashboard index, счётчик изменений и неизменность исходного baseline; требуется только disposable IndexedDB.

Большой Dashboard smoke сообщает границу чтения/обработки каждого чанка истории Final и прерывает конкретный проверочный прогон, если текст прогресса не меняется 75 секунд. Worker приложения имеет свой 60-секундный timeout ответа; watchdog smoke ждёт его исхода и сохраняет диагностику отказа.

После исправления потока read-only IndexedDB полные Edge smoke два раза подряд завершились `ok: true` на свежих профилях: оба Final по 5 000 устройств прошли все 10 чанков истории, status aggregates дошли до 5 000/5 000, кэш Dashboard завершил IndexedDB-транзакцию; далее проверены периодное сравнение, Inventory на 10 004 устройства, reload и additive reference-archive import. В четырёх более ранних повторах были задержки на чтении последнего чанка, status aggregation, Worker ingest и ожидании `transaction.complete` после успешного ответа чанка. Новый тест воспроизводит задержку завершения read-only транзакции, а два свежих полных прогона подтвердили исправленный путь. Другие parity items и некоторые исторические графики/drilldown остаются открытыми; выбранный статус уже согласует KPI, рейтинг производителей и KPI-экспорты.

Для потокового CSV и XLSX есть отдельные stress-сценарии `--stress-only`, `--xlsx-stress-only` и `--blob-stress-only`. Последний создаёт крупные файлы внутри браузера, импортирует два Final и сравнивает полный Dashboard/History/temporal результат; затем точечно читает `originalFiles` по ключам обоих Final и сверяет размер Blob, заголовок и последнюю строку, не выгружая весь Blob в Node. Запускайте его на отдельном headless Edge и disposable `?db=mac-analyzer-pro-next-test-<id>` согласно командам выше, например `node tools/browser-smoke.mjs 9333 $appUrl --blob-stress-only --stress-rows=5000`.

Для подтверждения полной аналитики и памяти Dashboard (#25) запустите `node tools/browser-smoke.mjs 9333 $appUrl --stress-only --stress-rows=10000` на отдельном headless Edge. На 2026-11-07 сценарий прошёл `ok:true`: два Final по 10 000 устройств, точные Dashboard/Temporal totals, 42 замера JS heap, peak 90 MiB и final 52 MiB.

Для focused проверки настроек и экспорта Dashboard (#499) на автономном HTML откройте отдельный headless Edge с новой disposable IndexedDB и инженерским режимом, затем запустите `node tools/browser-smoke.mjs 9333 $appUrl --dashboard-settings-ui-only`. Сценарий проверяет три вкладки и клавиатурную навигацию, все шесть KPI и пять экранных графиков, сохранение/применение/сброс и восстановление настроек после reload, а также скачиваемые PNG 2000×1200 и HTML. HTML blob разбирается целиком и сверяется на шесть KPI, четыре графика и fixture-значения Acme/Logitech; внешний браузерный доступ не используется.

Для #666 smoke `--batch-folder-metadata-only` запускайте на одноразовом loopback host с двумя переменными окружения: `MAC_ANALYZER_BATCH_MAIN_TEST_PATH` указывает на disposable папку Main, `MAC_ANALYZER_BATCH_MAIN_TEST_FILE` — на файл внутри неё. Host нужно запустить с отдельным временным `--root`, а приложение открыть в Edge с уникальной IndexedDB и DevTools портом. Smoke подаёт файл через штатный drag-and-drop, у которого `lastModified` намеренно отличается от фактического Windows creation time; затем проверяет реальное сопоставление, применённую дату пары и отсутствие содержимого в запросе к host.

Для глобального журнала изменений (`#162`) используйте тот же запуск с отдельным профилем и `?db=mac-analyzer-pro-next-test-<id>`, затем выполните `node tools/browser-smoke.mjs 9333 $appUrl --history-log-pages-only`. Он добавляет только синтетические события в одноразовую IndexedDB и через UI проверяет страницы 100/100/5, общий счётчик, возврат назад и точный результат фильтра.

Для темы запустите приложение в отдельном headless Edge с disposable `?db=mac-analyzer-pro-next-test-<id>` и выполните `node tools/browser-smoke.mjs 9333 $appUrl --theme-smoke-only`. Сценарий выбирает тёмную тему через диалог, проверяет ARIA-состояние и IndexedDB, измеряет computed-color WCAG AA contrast (текст, muted, primary/hover, danger/error banner и danger-soft) в light/dark, затем перезапускает страницу при конфликтующем `localStorage=light` и проверяет приоритет IndexedDB.

На 2026-10-17 полный Edge smoke на отдельном профиле и новой disposable IndexedDB завершился `ok: true`. Помимо больших Final, истории, Inventory, reload и reference archive он проверил drilldown KPI «Устройства», «Изменённые», «Отсутствуют» и «Без изменений», включая полный список из четырёх неизменившихся устройств, загрузку состава аномальной комнаты и пагинацию диалога. Он также выбрал статус «Отсутствуют» и сверил KPI устройств с числом отсутствующих, производителей с рейтингом выбранного статуса и помещений со списком полного выбранного набора. Каждый диалог закрывался штатно до следующего клика. Пользовательская база не открывалась.

Для отдельной проверки статуса/страниц и экспортов Dashboard запустите тот же Edge с уникальным профилем и базой, затем выполните `node tools/browser-smoke.mjs 9333 $appUrl --roster-only`. По умолчанию режим создаёт Final на 125 устройств через UI; `--roster-size=12249` задаёт максимальный размер 12 249. Проверяются виртуализированный roster и страницы 1–100 и 101–200 по реальным MAC, а также PNG/HTML/XLSX из Dashboard и сигнатуры артефактов. Smoke завершается до общего stress flow с несколькими Final. Edge smoke для 12 249 устройств завершился `ok: true`: обе страницы содержали ожидаемые граничные записи, HTML включал полный счётчик, PNG имел PNG-сигнатуру, XLSX — ZIP-сигнатуру и завершённый `WritableStream`.

Для UI-состояния папки после сброса сохранённого разрешения откройте autonomous HTML через `localhost` на secure context и запустите `node tools/browser-smoke.mjs 9333 $appUrl --data-directory-reauthorize-only` с новой disposable базой. Smoke хранит дескриптор в отдельной OPFS-папке, перезагружает вкладку, подменяет `queryPermission`/`requestPermission` тестовым адаптером и проверяет, что UI предлагает одну кнопку, скрывает повторный picker и возвращается в подключённое состояние. Этот сценарий не подтверждает настоящий браузерный prompt или доверенный пользовательский жест; parity #38 остаётся частичным до проверки нативного permission flow.

Для импорта legacy autosave и защиты от коллизии browser ID запустите `node tools/browser-smoke.mjs 9333 $appUrl --legacy-autosave-recovery-only` с disposable профилем/IndexedDB. Режим создаёт активный Next Final через UI, импортирует `tests/fixtures/legacy-browser-id-collision.sqlite` через штатную SQLite-форму и проверяет две записи: одну с отсутствующим Final и вторую, чей `resultBrowserSnapshotId` совпадает с ID присутствующего SQLite Final. Обе ссылки остаются inert, кнопка активации не появляется, исходный active Final переживает импорт и reload. Затем режим добавляет только синтетические метаданные неполного нового snapshot, перезапускает приложение и ждёт завершения bootstrap, проверяя видимый статус и сохранение прежнего валидного активного Final. Fixture содержит только синтетические данные; SQLite integrity check возвращает `ok`.


Harness `tools/browser-smoke.mjs` также содержит сценарии сравнения двух файлов: точные added/absent/modified totals и CSV/JSON/XLSX/TXT downloads; и трёх файлов: отдельный mapping, выбранная направленная пара и все шесть направленных пар в попарном CSV-экспорте. Эти новые сценарии синтаксически проверены, а их привязки покрыты build-config тестом. Полный Edge smoke 2026-11-04 запущен на собранном автономном HTML с disposable IndexedDB и завершил assertions с ok: true. После закрытия DevTools самим harness повторный cleanup wrapper получил ECONNREFUSED; приложение и его assertions не завершились ошибкой. Открытыми остаются только матричные критерии, которые smoke явно не проверяет.

Полный Edge smoke 2026-11-05 повторно завершился `ok: true` на свежем headless-профиле и уникальной disposable IndexedDB. Проверены запуск автономного HTML и закрытие баннера ошибки с очисткой текста; Main/SmartRoom/DDIO и точное заполнение IP; Dashboard, полный roster, фильтры, аномальная комната и история; расписание и последовательная очередь; именованный архив, portable/reference/device-transfer import и экспорт; сравнение двух и трёх файлов; два Final по 5 000 устройств, десять чанков по 500, period mode, полный Inventory 10 005 устройств, reload и восстановление последнего целого Final при stale pointer и более новом неполном snapshot. Smoke не открывал пользовательскую базу. Сам по себе общий прогон не закрывает критерии, чьи отдельные условия или визуальные графики его assertions не проверяли.

Повторный полный Edge smoke 2026-11-06 на этой сборке также завершился `ok: true` и повторил основной поток, включая Dashboard на 5 000 устройств, полный Inventory, сравнение файлов, экспорты и восстановление после перезапуска. Прогон использовал новый временный профиль и disposable IndexedDB; пользовательское хранилище не открывалось. Точные незакрытые условия остаются перечислены в `PARITY_REGISTRY.md`.


Для optional host используйте focused Edge режимы --optional-host-workflows-only, --optional-host-transfer-only и --optional-diagnostics-only на loopback host с уникальным временным --root, отдельным headless Edge профилем и disposable IndexedDB. Они проверяют UI backup/search/maintenance/export, явную передачу Inventory и Final со связанной History и обратное восстановление SQLite-копии, затем 25 browser/host diagnostics. `--optional-host-transfer-only` также создаёт второй Final, выбирает все две копии на странице и удаляет их через UI; проверяет, что host Inventory сохранён. Не подключайте пользовательский root.

Для управления и очистки Final (`#485`) выполните `node tools/browser-smoke.mjs 9333 $appUrl --final-history-management-only` в отдельном Edge профиле и disposable IndexedDB. Сценарий создаёт три Final через UI, проверяет комбинированный поиск по имени исходного файла/MAC, vendor, model, room и датам, выборочное удаление и очистку истории с сохранением Inventory, настроек, пользовательского правила и named archives.

Для внешнего MAC vendor API запустите optional host с отдельным временным `--root`, автономным HTML из `dist/` и одноразовой SQLite, затем откройте его в отдельном headless Edge и выполните `node tools/browser-smoke.mjs 9333 $appUrl --external-vendor-ui-only`. Сценарий проверяет, что opt-in изначально выключен, сохраняет provider через интерфейс и только затем отправляет синтетический `00:00:02:00:00:00` выбранному keyless macadress HTTPS API; сверяет видимое имя vendor и один cache entry. Также проверяется live `mac2vendor` lookup через документированный HTTPS API 7n4.cn для того же синтетического MAC, без browser runtime error. База и профиль disposable; реальные MAC и пользовательские данные не используются.

Для UI/host round-trip каналов Email/Telegram/Slack (#402) откройте приложение из собранного `dist/` через optional host с отдельной временной SQLite и disposable IndexedDB, затем запустите `node tools/browser-smoke.mjs 9333 $appUrl --notifications-settings-ui-only` на отдельном Edge-профиле. Smoke штатно входит в инженерский режим, проверяет что все каналы и секреты изначально выключены, сохраняет фиктивные несекретные Email/Telegram/Slack параметры через UI, перезагружает страницу и проверяет их восстановление после повторного входа. Кнопки отправки не нажимаются; внешняя доставка и пользовательские секреты не используются.

Для проверки реальной Email-доставки без внешнего адресата (#673) после `pnpm build` запустите `pwsh -NoProfile -ExecutionPolicy Bypass -File tools/run-notification-email-browser-smoke.ps1` (PowerShell 7+ нужен для генерации временного TLS сертификата). Сценарий создаёт временный self-signed TLS сертификат, optional host, отдельный Edge профиль и одноразовую IndexedDB; Email явно включается через UI и тестовое письмо отправляется только в локальный TLS SMTP sink, который принимает ровно `sink@example.test` и проверяет тему/тело без данных оборудования. После прогона временные root, сертификат, профиль и процессы очищаются. Telegram/Slack реальные внешние тестовые доставки не запускаются.


Для #59 запустите `node tools/browser-smoke.mjs 9333 $appUrl --database-unavailable-cache-only` на отдельном Edge с новой disposable IndexedDB. Сценарий создаёт Final через UI, сохраняет точные Final/Inventory counts в localStorage, затем перезапускает автономный HTML с отказом только для IndexedDB open и проверяет, что оба числа остаются видимыми вместе с ошибкой хранилища.


Focused сценарий `--reference-dashboard-146-only` также проверяет Chart.js заголовок тренда, все пять каскадных room filters, локальную K-means через UI (три кластера покрывают весь выбранный Final) и восстановление режима/диапазона Dashboard после reload. Harness ждёт явный признак завершения bootstrap перед проверкой состояния; приложение сначала инициализирует lazy tabs, затем активирует view. Для общего поиска проверяется как успешный адрес помещения, так и отказ при запросе без совпадений.

Для browser runtime профиля расчёта пары Final используйте `node tools/browser-smoke.mjs 9333 $appUrl --stress-only --stress-rows=5000` в одноразовом Edge профиле и IndexedDB. Два последовательных импорта создают два Final по 5 000 устройств/10 чанков; сценарий снимает `Runtime.getHeapUsage` на этапах анализа и проверяет Dashboard/temporal итоги, включая 10 000 уникальных MAC и обработку Worker обоих Final. Edge smoke 2026-11-07: peak 72 352 476 bytes (69 MiB), final 59 530 400 bytes (57 MiB), ошибок нет.

Для проверки сохранения режима Dashboard «За период» и календарного диапазона после перезапуска при существующем Final используйте отдельный Edge, временный профиль и disposable IndexedDB: `node tools/browser-smoke.mjs 9333 $appUrl --period-mode-persistence-only`. Сценарий создаёт Final через UI, сохраняет период и диапазон, сверяет `analyticsDashboardSettings` в IndexedDB, перезагружает HTML и проверяет восстановленные значения и выбранный текущий Final.

Для измерения fallback-экспорта без File System Access используйте отдельный headless Chrome/Edge с временным профилем и disposable IndexedDB: `node tools/browser-smoke.mjs 9333 $appUrl --fallback-export-stress-only --stress-rows=10000`. Инициализационный script отключает showSaveFilePicker/showOpenFilePicker до перезагрузки приложения; тест импортирует два Final по 10 000 строк, экспортирует обе направленные пары в Blob и потоково считает строки, не загружая целый CSV как строку. Chrome headless smoke 2026-11-05 подтвердил 40 001 строку, файл 5 240 118 bytes, peak heap экспорта 59 MiB, общий пик прогона 85 MiB без ошибок.

Для пользовательских полей источников (#678) запустите автономный HTML в отдельном Chrome/Edge с новой disposable IndexedDB и выполните `node tools/browser-smoke.mjs 9333 $appUrl --custom-fields-only`. Сценарий через UI инженерного режима добавляет поле и сопоставляет колонку в Main, SmartRoom и DDIO; после объединения проверяет один Final/одну запись устройства, значения и подписи пользовательских полей в IndexedDB, источник каждого значения, сохранение сильных идентификаторов, неизменность известного Main IP и запись альтернативного DDIO IP в `possibleIps`. Массовое сохранение custom-полей дополнительно покрыто enrichment/batch regressions.

Для проверки состава сводного Dashboard XLSX (#676) используйте `node tools/browser-smoke.mjs 9333 $appUrl --dashboard-xlsx-parity-only` на отдельном headless Chrome/Edge и новой disposable IndexedDB. Сценарий создаёт четыре устройства через UI, где три Smartroom ID соответствуют двум заполненным физическим помещениям, а в Main также встречаются `N/A` и `Unknown` для switch IP. Он перехватывает реальный XLSX Blob, проверяет записи ZIP и CRC, затем проверяет точные строки листов «Общая статистика», «Помещения» и «Коммутаторы».

Для проверки постраничной истории изменений switch IP (#672) используйте `node tools/browser-smoke.mjs 9333 $appUrl --switch-ip-pages-only`. На disposable IndexedDB сценарий создаёт два Final по 101 устройству, проверяет точный total, диапазоны 1–100/101–101, граничные строки виртуализированной таблицы, кнопку перехода и возврат на первую страницу.

Для проверки массовой очереди при отказе отдельного цикла (#668) используйте `node tools/browser-smoke.mjs 9333 $appUrl --batch-queue-failure-only`. Сценарий внедряет одноразовую ошибку записи IndexedDB во втором из трёх Main-циклов; проверяет продолжение к третьему Final, видимую диагностику и отсутствие данных сбойного цикла в Final/Inventory/History. Затем ту же очередь повторно запускает с политикой остановки и сверяет, что непосещённый третий цикл явно отмечен как не запускавшийся, а ранее сохранённое состояние не изменено.

Для сквозной проверки SQLite `smartroom_room_mappings` (#670) используйте `node tools/browser-smoke.mjs 9333 $appUrl --sqlite-smartroom-room-only`. Синтетическая база `tests/fixtures/smartroom-room-mappings.sqlite` загружается через экран импорта SQLite в инженерском режиме; затем создаётся Final с пустой комнатой при точном ID, неоднозначным нормализованным ID и заранее заполненной комнатой. Smoke напрямую сверяет значения, confidence, provenance и сохранение конфликта в одноразовой IndexedDB.

Для восстановления выбранного исходного файла после перезапуска (#233) используйте `node tools/browser-smoke.mjs 9333 $appUrl --workspace-source-handle-restart-only` на одноразовом профиле и IndexedDB через localhost. Сценарий создаёт synthetic OPFS CSV и FileSystemFileHandle, выбирает его через UI, перезапускает страницу, проверяет, что файл не читается до повторной инженерной аутентификации, затем восстанавливает Main и проверяет mapping и сохранность прежнего Final. Picker и permission API shim-ированы для детерминированного теста; настоящий системный prompt проверяется отдельно и не считается подтверждённым этим smoke.

Для проверки bounded checkpoint рабочего состояния (#242) выполните `node tools/browser-smoke.mjs 9344 $appUrl --workspace-state-persistence-only` на отдельном headless Edge, временном профиле и новой disposable IndexedDB. Сценарий через интерфейс создаёт 60 устройств, включает фильтр, сортировку и вторую страницу, проверяет IndexedDB shape checkpoint и отдельное наличие analyticsCache, перезапускает автономный HTML, сверяет восстановленные view/filter/page/page-size/sort и удаляет checkpoint в Data UI. После перезапуска он повторно входит в инженерский режим штатной формой. Этот smoke покрывает только workspace checkpoint; восстановление исходного файла и batch-папки проверяется сценариями ниже и в реестре #242.


Для #384 локального IP-маппинга запустите Edge на отдельном профиле и disposable IndexedDB по командам выше и выполните `node tools/browser-smoke.mjs 9333 $appUrl --ip-address-mapping-workflow-only`. Сценарий через UI проверяет автоопределение, предложенные колонки и импорт CSV, ручное правило и явное применение правил к пустым адресам активного Final; сверяет provenance, обновление Inventory, сохранение известного адреса и неизменность ID/даты Final.


Для #386 исторического IP→адрес и постоянного Smartroom ID→room запустите Edge с отдельным профилем и disposable IndexedDB. Выполните `node tools/browser-smoke.mjs 9333 $appUrl --smartroom-mapping-workflow-only`; сценарий подтверждает согласованную комнату, sample MAC limit, конфликтные варианты, последующее заполнение по ID и provenance. Исторический switch-IP консенсус на нескольких Final проверяется отдельно режимом `--historical-address-consensus-only`.

Для индивидуальной аналитики и MAC-префиксов (#534) запустите на отдельных disposable Edge профилях `node tools/browser-smoke.mjs 9333 $appUrl --device-analytics-appearances-only` и `node tools/browser-smoke.mjs 9333 $appUrl --search-doubleclick-only`. Сценарии проверяют три появления устройства, полную историю, TXT/HTML/XLSX экспорты, пользовательское правило MAC-префикса, формат, source, точный/частичный поиск и occurrence count across Finals.

Для UI-конфликтов идентичности, отмены и failure preservation запустите отдельный Edge smoke с уникальными профилем и `?db=mac-analyzer-pro-next-test-<id>`, затем выполните `node tools/browser-smoke.mjs 9333 $appUrl --single-file-safety-only`. Режим создаёт baseline Final через UI; отображает strong identity conflict и weak ambiguity из single-file CSV; отменяет анализ во время потокового чтения; затем инъецирует disposable quota failure при сохранении анализа. В конце проверяются активный Final, snapshot, Inventory, History, single-analysis rows и временные chunks. Все ошибки синтетические и ограничены одноразовой IndexedDB.

Для #529 автономной полной аналитики без backend запустите актуальный `dist/MAC-Analyzer-Pro-Next.html` на отдельном headless Edge/Chrome с временным профилем и disposable IndexedDB, затем выполните `node tools/browser-smoke.mjs 9333 $appUrl --analytics-cache-reopen-only`. Сценарий импортирует три синтетических устройства, проверяет полный отчёт, рейтинги и заполненность комнат, графики, два switch topology узла и постраничный roster, экспорты TXT/SVG/CSV/HTML, фильтры производителя/помещения до точного результата и повторное использование полной аналитики после перехода в другую вкладку. Он отключает File System Access только в этом одноразовом smoke, чтобы проверить локальный Blob-export fallback.

Проверка #353 использует тот же `--optional-host-transfer-only` на отдельном loopback SQLite host и disposable root: сценарий создаёт Main-устройство с hostname/serial/Device ID/device name/vendor/model, передаёт Inventory, находит его в UI по serial и подтверждает, что повторная передача не добавила дубли или конфликты.

Для проверки восстановления папки массового импорта после перезапуска (#242) запустите свежий headless Edge с localhost-адресом актуального автономного HTML, отдельным профилем и disposable IndexedDB, затем выполните `node tools/browser-smoke.mjs 9344 $appUrl --workspace-batch-directory-restart-only`. Smoke создаёт OPFS-папку с двумя CSV (один вложен в подпапку) и неподдерживаемым PDF, выбирает её кнопкой Main, проверяет сохранённый локальный handle без пути, reload, отсутствие перечисления до инженерского входа, затем явное восстановление после login и точные relative paths списка.

## Проверка OUI-переноса из optional host

Для проверки браузерного импорта OUI из SQLite optional host используйте loopback host с отдельным временным `MAC_ANALYZER_DATA_DIR`, поместите синтетический `oui.csv` в его `data/reference`, запустите autonomous HTML на loopback с отдельным headless Edge-профилем и disposable IndexedDB, затем выполните `node tools/browser-smoke.mjs <devtools-port> <loopback-url>?db=mac-analyzer-pro-next-test-<id> --optional-host-oui-reference-only`. Smoke через пользовательскую кнопку переносит справочник в IndexedDB, проверяет обновление только записей с источником `Справочник optional host`, сохранение пользовательских/выученных правил и закрытие ошибки. Временный host/database и профиль smoke изолированы от рабочих данных.

## Проверка Windows launcher в браузере

Для реального launcher smoke используйте изолированный headless Edge и временные
пути: отдельный профиль браузера, уникальный параметр `?db=mac-analyzer-pro-next-test-<id>`,
собственный `--state-file` launcher и `MAC_ANALYZER_DATA_DIR` внутри временного
каталога. `tools/browser-smoke.mjs <devtools-port> <loopback-url> --launcher-startup-only`
проверяет документ приложения, маршрут, статус IndexedDB, закрытие error banner
и `/api/health`; после проверки остановите host командой launcher с `--stop` и
тем же `--state-file`. Smoke #394 прошёл в Edge 2026-11-07; для запуска не
использовались пользовательские базы.

Для проверки browser lifecycle SignalHandler запустите автономное приложение в
Edge с отдельным профилем и disposable IndexedDB, затем выполните
`node tools/browser-smoke.mjs <devtools-port> <app-url> --pagehide-cleanup-only`.
Smoke вызывает установленный приложением обработчик `pagehide` и сверяет все
активные browser-owned intervals до и после cleanup; сценарий #390 подтвердил
очистку 1/1 interval без runtime errors.

## Импорт SQLite PyQt через интерфейс

Для сфокусированного Edge smoke создайте новую синтетическую базу (команда откажется перезаписать существующий файл):

```powershell
python tools/create-pyqt-sqlite-smoke-fixture.py tests/fixtures/pyqt-sqlite-import-smoke.sqlite
```

Запустите optional host с отдельным временным каталогом данных и свежий headless Edge с новым профилем; затем вызовите:

```powershell
node tools/browser-smoke.mjs 9333 http://127.0.0.1:<PORT>/MAC-Analyzer-Pro-Next.html?db=<UNIQUE_DATABASE> --pyqt-sqlite-import-ui-only --sqlite-fixture=tests/fixtures/pyqt-sqlite-import-smoke.sqlite
```

Режим проходит базовый Final через UI, затем импортирует SQLite штатной кнопкой в разделе данных. Он сверяет `integrity_check`, все 8 тестовых PyQt-таблиц, перенесённые OUI/MAC5, движение, legacy-наблюдения, отсутствие пропусков и неизменность активного Final. Используются только синтетические данные, одноразовая IndexedDB и временный профиль; smoke не доказывает полный импорт большой реальной базы.

## Полный UI импорт reference SQLite

Для полной проверки импортируйте исходную reference-базу через UI, а не только через module-level audit. Используйте установленную эталонную `mac_analyzer_web.db`, сверив её SHA-256 с `3E340EB5397AE274B297B522C9EBB50582CF50452F64B1090DAB2B68408239A0`. Запустите optional host с новым временным `MAC_ANALYZER_DATA_DIR` и headless Edge с отдельным временным профилем. Создайте новый `?db=mac-analyzer-pro-next-test-<unique-id>` и выполните:

```powershell
node tools/browser-smoke.mjs <devtools-port> http://127.0.0.1:<host-port>/MAC-Analyzer-Pro-Next.html?db=mac-analyzer-pro-next-test-<unique-id> --reference-sqlite-import-ui-only --sqlite-path=<absolute-path-to-mac_analyzer_web.db>
```

Smoke выбирает файл через CDP по локальному пути без загрузки его байтов в DevTools, создаёт baseline Final через UI, запускает штатный импорт в Data и ждёт до 2 часов. Он проверяет integrity, контрольные counts из `tests/fixtures/reference-sqlite-import-audit-2026-11-03.json`, активный Final, browser runtime errors и ожидаемые privacy exclusions `engineering_sessions`/`notification_settings`. WAL-база без WAL sidecar явно сообщает, что данные только из отсутствующего WAL недоступны. В успешном прогоне 2026-11-07 импортировано 1,005,968 observations через UI; smoke завершился `ok:true` на отдельной disposable IndexedDB.

Для стресс-проверки legacy XLS/BIFF8 через UI (`#547`) запустите актуальный автономный HTML в отдельном headless Chrome/Edge-профиле и выполните `node tools/browser-smoke.mjs <devtools-port> <app-url> --xls-stress-only`. По умолчанию создаются и импортируются два синтетических `.xls` файла по 5 000 строк каждый, строятся два Final, затем проверяются сравнение пары, Dashboard и temporal analytics; поддерживается `--stress-rows=<1000..25000>`. Smoke измеряет heap через Browser DevTools API и не использует пользовательские данные.


Для реального UI roundtrip файлового кэша optional host (#462, #547) запустите актуальный HTML через изолированный loopback host с disposable каталогом данных, headless Chrome/Edge и уникальной IndexedDB, затем выполните
`node tools/browser-smoke.mjs <devtools-port> <app-url> --workspace-cache-ui-only`. Smoke импортирует синтетический Main, сохраняет бинарную копию с token/SHA-256, перезагружает страницу, повторно входит в инженерский режим, восстанавливает исходник через интерфейс, сверяет digest/mapping и удаляет запись; пользовательские файлы не используются.
