# Проверки Next

## Локальные проверки

Установите Node.js 20+ и pnpm, затем выполните в корне проекта:

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
SHA-256/CRC и исключение пользовательских баз. `pnpm package:release` отдельно
собирает автономный HTML, ZIP и внешний SHA-256 sidecar в `dist/`.

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

Большой Dashboard smoke сообщает границу чтения/обработки каждого чанка истории Final и прерывает конкретный проверочный прогон, если текст прогресса не меняется 75 секунд. Worker приложения имеет свой 60-секундный timeout ответа; watchdog smoke ждёт его исхода и сохраняет диагностику отказа.

После исправления потока read-only IndexedDB полные Edge smoke два раза подряд завершились `ok: true` на свежих профилях: оба Final по 5 000 устройств прошли все 10 чанков истории, status aggregates дошли до 5 000/5 000, кэш Dashboard завершил IndexedDB-транзакцию; далее проверены периодное сравнение, Inventory на 10 004 устройства, reload и additive reference-archive import. В четырёх более ранних повторах были задержки на чтении последнего чанка, status aggregation, Worker ingest и ожидании `transaction.complete` после успешного ответа чанка. Новый тест воспроизводит задержку завершения read-only транзакции, а два свежих полных прогона подтвердили исправленный путь. Другие parity items и некоторые исторические графики/drilldown остаются открытыми; выбранный статус уже согласует KPI, рейтинг производителей и KPI-экспорты.

На 2026-10-17 полный Edge smoke на отдельном профиле и новой disposable IndexedDB завершился `ok: true`. Помимо больших Final, истории, Inventory, reload и reference archive он проверил drilldown KPI «Устройства», «Изменённые», «Отсутствуют» и «Без изменений», включая полный список из четырёх неизменившихся устройств, загрузку состава аномальной комнаты и пагинацию диалога. Он также выбрал статус «Отсутствуют» и сверил KPI устройств с числом отсутствующих, производителей с рейтингом выбранного статуса и помещений со списком полного выбранного набора. Каждый диалог закрывался штатно до следующего клика. Пользовательская база не открывалась.

Для отдельной проверки статуса/страниц и экспортов Dashboard запустите тот же Edge с уникальным профилем и базой, затем выполните `node tools/browser-smoke.mjs 9333 $appUrl --roster-only`. По умолчанию режим создаёт Final на 125 устройств через UI; `--roster-size=5000` задаёт размер до 5 000. Проверяются страницы 1–100 и 101–200, PNG/HTML/XLSX из Dashboard и сигнатуры артефактов. Smoke завершается до общего stress flow с несколькими Final. Edge smoke для 5 000 устройств подтвердил roster 1–100 и 101–200 и успешное создание трёх экспортов.


Harness `tools/browser-smoke.mjs` также содержит сценарии сравнения двух файлов: точные added/absent/modified totals и CSV/JSON/XLSX/TXT downloads; и трёх файлов: отдельный mapping, выбранная направленная пара и все шесть направленных пар в попарном CSV-экспорте. Эти новые сценарии синтаксически проверены, а их привязки покрыты build-config тестом. Реальный browser run остаётся открытым: текущий browser-channel блокирует автоматизацию автономного `file:` URL; не обходите это ограничение другим способом подключения к браузеру.
