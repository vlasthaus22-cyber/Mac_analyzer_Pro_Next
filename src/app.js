import { tsvQuote } from "./core/csv-cell.js";
import { aggregateSnapshotHistory, buildAnalyticsPairFromChunks, buildSnapshotTotalSeries, collectPresenceTransitions, defaultSnapshotSelection, releaseDashboardCurrentDevices, snapshotHistorySignature } from "./core/analytics.js";
import { createDashboardDeviceMatcher, dashboardFilterOptions, dashboardStatusForKpi } from "./core/dashboard-filter.js";
import { buildDashboardFleetSeries } from "./core/dashboard-fleet.js";
import { resolveDashboardSnapshotPair } from "./core/dashboard-selection.js";
import { createCollector as createDatasetAnalyticsCollector, chartsSvg, collectAnalyticsBuckets, collectClusterBuckets, collectTopologyBuckets, applyAnalyticsAggregateView, renderClusters, renderOverview, renderTopology, writeClustersCsv, writeTopologyHtml } from "./core/analytics-detail.js";
import { batchMappingProblems, batchPairProblems, batchQueueProblems, compactSupportedBatchFiles, normalizeBatchPairing, pairBatchEntries, prepareBatchEntries, reassignBatchSource, runBatchQueue, unmatchedBatchEntries } from "./core/batch.js";
import { batchSourceFileRelativePath } from "./core/batch-directory-handles.js";
import { createDailyScheduler, createSerialQueue, nextIntervalExecution, nextLocalExecution, normalizeScheduleName } from "./core/daily-scheduler.js";
import { runLegacyTaskQueue } from "./core/legacy-task-queue.js";
import { streamJsonArray, writePrettyJson } from "./core/json-stream.js";
import { requestReadableStreamFileHandle, saveReadableStreamToFile } from "./core/file-stream.js";
import { createDataQualityAccumulator } from "./core/data-quality.js";
import { appendLocalNotification, DEFAULT_LOCAL_NOTIFICATION_SETTINGS, normalizeLocalNotificationLog, normalizeLocalNotificationSettings } from "./core/local-notifications.js";
import { createMacTimelineAccumulator, createMacTimelineSnapshotStatusIndex, deviceContainsNormalizedMac, compareFinalAbsencePage, compareFinalAdditionPage, compareFinalDevicePage, compareFinalIdentityDiagnosticPage, compareFinalModifiedDevicePage, compareFinalModificationDeviceGroupPage, compareFinalModificationEventPage, compareFinalUnchangedPage, compareFinals, createInventoryObservationComparator, reconcileAndCompareInventoryObservation, CURRENT_STATUS_MASK, legacyObservationTimelineEvent } from "./core/comparison.js";
import { readMacHistoryCache, writeMacHistoryCache } from "./core/mac-history-cache.js";
import { readDatabaseStatusCache, writeDatabaseStatusCache } from "./core/database-status-cache.js";
import { estimateSha256WorkingSetBytes, sha256File } from "./core/incremental-sha256.js";
import { buildSourceKey } from "./core/source-key.js";
import { runCoalescedTask } from "./core/coalesced-task.js";
import { AUTO_SAVE_INTERVAL_MS, autoSaveXlsxFilename, isAutoSaveDue } from "./core/auto-save.js";
import { createCustomSourceFieldMapping, normalizeSourceMappingPreferences, rememberSourceMapping, restoreSourceMapping, upsertSourceMappingPreference } from "./core/source-mapping-preferences.js";
import { prepareOriginalSourceRecovery } from "./core/source-file-recovery.js";
import { inspectWorkspaceSourceHandle, requestWorkspaceSourcePermission, workspaceSourceFileMatchesRecord, WORKSPACE_SOURCE_ROLES } from "./core/workspace-source-handles.js";
import { BATCH_DIRECTORY_ROLES, inspectBatchDirectoryHandle, listBatchDirectoryFiles, requestBatchDirectoryPermission } from "./core/batch-directory-handles.js";
import { assertBrowserHeapCapacity, assertFilePairCapacity, assertSourceFileCapacity } from "./core/import-limits.js";
import { CHANGE_CATEGORIES, CHANGE_CATEGORY_LABELS, isCriticalHistoryChange, normalizeChangeType, pageComparisonChanges, summarizeChangeCategories } from "./core/change-categories.js";
import { compactComparisonDevice, trimComparisonBaseline, trimComparisonDeviceInPlace, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION, finalAnalyticsIndexSignature } from "./core/compact-final-analytics.js";
import { enrich } from "./core/enrichment.js";
import { stageFinalHistoryPlan } from "./core/history-plan.js";
import { DEFAULT_ENRICHMENT_FIELD_SETTINGS, normalizeEnrichmentFieldSettings } from "./core/enrichment-settings.js";
import { DEFAULT_HISTORY_ENRICHMENT_SETTINGS, normalizeHistoryEnrichmentSettings, normalizeLegacyWorkspaceFiles } from "./core/history-enrichment-settings.js";
import { legacyWorkspaceSourceRole, restoreLegacyWorkspaceMapping } from "./core/legacy-workspace-recovery.js";
import { createHistoricalAddressAccumulator, createHistoricalAddressDeviceSummaryAccumulator, createAppliedSmartroomMappingSummaryAccumulator, buildImportedSmartroomRoomIndex, buildSmartroomRoomIndex, compareSwitchIpHistoryInBatches, mappingIndexPage } from "./core/historical-mapping.js";
import { createIpMappingDetector, DEFAULT_IP_ENRICHMENT_SETTINGS, detectIpMappingColumns, ipMappingsCsv, ipMappingsJson, ipMappingsXlsxSheets, normalizeIpEnrichmentSettings, normalizeIpMappings } from "./core/ip-mapping.js";
import { keyText, locationKey, normalizeIp, normalizeMac, text } from "./core/normalize.js";
import { createRequestGate } from "./core/request-gate.js";
import { canAccessView, createEngineerCredential, createEngineeringSession, engineeringSessionRemainingSeconds, isEngineeringSessionActive, normalizeEngineeringSessionMinutes, verifyEngineerCredential } from "./core/engineering-session.js";
import { DASHBOARD_CHART_WIDGETS, DASHBOARD_KPI_WIDGETS, DEFAULT_ANALYTICS_DASHBOARD_SETTINGS, isDashboardWidgetVisible, legacyAnalyticsDashboardSettings, normalizeAnalyticsDashboardSettings } from "./core/analytics-dashboard-settings.js";
import { analyticsDashboardHtmlChunks, analyticsDashboardXlsxSheets, analyticsSummaryXlsxSheets, buildAnalyticsDashboardExportModel } from "./core/analytics-dashboard-export.js";
import { drawDashboardExportChart } from "./ui/dashboard-export.js";
import { bindErrorBannerDismiss, dismissErrorBanner, showErrorBanner } from "./ui/error-banner.js";
import { bindSourceFileDrop, bindSourceFilesDrop } from "./ui/file-drop.js";
import { BATCH_FILE_LIST_PAGE_SIZE, batchFileListPage, removeBatchFileAt } from "./ui/batch-file-list.js";
import { dataDirectoryControlState } from "./ui/data-directory-controls.js";
import { deleteOptionalHostSnapshot, deleteOptionalHostSnapshots, listOptionalHostHistoryForMac, listOptionalHostSnapshots, loadOptionalHostDiagnostics, optionalHostDatabaseExportHref, uploadFinalSnapshotToOptionalHost, uploadInventoryToOptionalHost, uploadSnapshotHistoryToOptionalHost, uploadSQLiteBackupToOptionalHost } from "./ui/optional-host-controls.js";
import { createAnalyticsIdleScheduler, createBoundedComparisonPageCache, feedAnalyticsDatasetRows, reuseInFlightRequest, runAnalyticsInStages, usableAnalyticsFallback } from "./core/analytics-lifecycle.js";
import { aggregateSnapshotHistoryInWorker } from "./core/analytics-history-worker-client.js";
import { addRoomCatalogDevices, matchesRoomFilters, roomFilterOptions, roomFilterSignature, ROOM_FILTER_FIELDS, uniqueRoomFilterSelection } from "./core/room-filters.js";
import { carryForwardRoomDeviceFields, compactRoomHistoryDevices } from "./core/room-history.js";
import { backfillComparisonDevices } from "./core/history-enrichment.js";
import { defaultHistoryLogFilters, historyLogNeedsRefresh } from "./core/history-log-state.js";
import { matchesDeviceSearch, searchResultDoubleClickTarget } from "./core/search.js";
import { analyzeSingleFile, analyzeSingleFileBatches, analyzeSingleFileBatchesIntoStore, countSingleFileDeviceFields, detectSingleFileMapping, formatSingleFileSourceRows, hasSingleFileMappingConflicts, SINGLE_FILE_FIELDS, singleFileDeviceJson, singleFileDevicesCsvBatchChunks, singleFileDevicesCsvChunks } from "./core/single-file-analysis.js";
import { createStagedMultiFileComparisonPlan, multiFileComparisonRowsPageAsync, multiFileComparisonWorkbookSheets, pairwiseComparisonCsvChunksAsync, pairwiseComparisonPairs, pairwiseCsvHeader } from "./core/multi-file-comparison.js";
import { fileComparisonColumns, fileComparisonCsvChunksFromPlan, fileComparisonExportRowsFromPlan, fileComparisonJsonFromPlan, fileComparisonRowsPagesFromPlan } from "./core/file-comparison-export.js";
import { createTextBlobStreamSink, readableTextStreamFromIterable, writeReadableStreamToWritable } from "./core/stream-writer.js";
import { DEFAULT_OUI_FORMATS, normalizeOuiFormats } from "./core/oui-formats.js";
import { selectTemporalSnapshotWindow, TemporalStatisticsAccumulator, temporalStatisticsCsvChunks } from "./core/temporal-statistics.js";
import { createLegacyDailyStatisticsAccumulator } from "./core/legacy-daily-statistics.js";
import { abortActiveControllers, escapeActionTarget, identifyShortcut, isShortcutAllowedWithoutEngineer } from "./core/shortcuts.js";
import { openInventoryColumnManagerDialog } from "./ui/inventory-column-manager-dialog.js";
import { guardEngineeringClick, isEngineeringOnlyInputTarget, isRestrictedEngineeringViewTarget } from "./ui/engineering-access.js";
import { cleanupPageHide } from "./core/page-lifecycle.js";
import { runBrowserDiagnostics } from "./core/diagnostics.js";
import { importLegacySQLiteFile, readLegacyTaskQueueFileFromSQLite, resolveLegacySQLiteFileSelection } from "./data/sqlite-database-importer.js";
import { isThemeChoice, legacyThemeChoice, resolveThemeChoice } from "./core/theme.js";
import { captureWorkspaceState, deleteWorkspaceState as deleteWorkspaceStateSetting, normalizeWorkspaceState, readWorkspaceState } from "./core/workspace-state.js";
import { LEGACY_PYQT_SETTINGS_MAX_BYTES, normalizeLegacyAutosaveSettings, normalizeLegacyPyQtSettings } from "./core/legacy-pyqt-settings.js";
import { isFinalSnapshot, SINGLE_ANALYSIS_SNAPSHOT_TYPE } from "./core/snapshot-kind.js";
import { filterUploadHistorySnapshots, selectUploadHistoryPage, snapshotDeviceMatchesFilters, snapshotDeviceMatchesQuery, snapshotSourceNames } from "./core/upload-history.js";
import { selectVendorModelHistoryPage, vendorModelHistoryCsvChunks, VendorModelHistoryAccumulator } from "./core/vendor-model-history.js";
import { addCustomInventoryColumn, defaultInventoryColumnConfig, inventoryCellText, inventoryColumnConfigFromLegacyPreferences, INVENTORY_DEFAULT_COLUMNS, moveInventoryColumn, normalizeInventoryColumnConfig, optimizeInventoryColumnWidths, removeCustomInventoryColumn, updateInventoryColumn, visibleInventoryColumns } from "./core/inventory-columns.js";
import { buildIeeeRegistryIndex, createOuiIndexOverlay, detectOuiColumns, ieeeCidCatalogPage, ieeeOuiRecordBatches, ieeeRegistryStatus, normalizeOuiPrefix, validateIeeeRegistry } from "./core/ieee-registry.js";
import { countMac5Occurrences, createModelPrefixAnalyticsCollector, modelPrefixAnalyticsXlsxSheets } from "./core/model-knowledge.js";
import { createVendorModelRuleLearner } from "./core/vendor-model-learning.js";
import { legacyOuiSeedMatchMap, LEGACY_OUI_SEED_VERSION } from "./core/legacy-oui-seed.js";
import { DEFAULT_VENDOR_DETECTOR_SETTINGS, legacyVendorDetectorSettings, normalizeVendorDetectorSettings } from "./core/vendor-detector.js";
import { inventorySearchCsvChunks, TableTsvCollector, tableRowsTsv } from "./core/table-actions.js";
import { createSnapshotXlsxSheets, snapshotCsvBlob, snapshotHtmlBlob, snapshotJsonBlob, snapshotTextBlob, snapshotYamlBlob, writeSnapshotCsv, writeSnapshotHtml, writeSnapshotJson, writeSnapshotText, writeSnapshotYaml } from "./core/snapshot-export.js";
import { createSnapshotPdfBlob } from "./core/pdf-export.js";
import { createInventoryXlsxSheets } from "./core/inventory-export.js";
import { createXlsxWorkbookStream } from "./core/xlsx-export.js";
import { historyExportSheets } from "./core/history-export.js";
import { buildDeviceAnalytics, compactDeviceAppearance, createStrongIdentityMatcher, deviceAnalyticsContent, deviceAnalyticsHtmlChunks, deviceAnalyticsHtmlHistoryRows, deviceAnalyticsTxt, deviceAnalyticsXlsxSheets, resolveDeviceAppearance } from "./core/device-analytics.js";
import { activateLazyTab, initializeLazyTabs, queryAllLazyTabs, queryLazyTab } from "./ui/lazy-tabs.js";
import { initializeVirtualTables, refreshVirtualTable } from "./ui/virtual-table.js";
import { installTableSorter } from "./ui/table-sorter.js";
import { selectContextTableRow } from "./ui/table-context-selection.js";
import { database } from "./data/database.js";
import { getDirectoryArchiveFile, MAX_PORTABLE_ARCHIVE_BYTES, pickDataDirectory, queryDirectoryPermission, reauthorizeDirectoryHandle, requestDirectoryPermission, writeDirectoryArchive, writeDirectoryFile } from "./data/data-directory.js";
import { consumeStoredTableRows, detectMappingReport, FIELD_LABELS, fileObservationDate, inspectPortableArchiveHeader, listXlsxSheets, mappingRecommendationsWithoutReservedColumns, readPortableArchiveEvents, readTable, readTablePreview, readTableRowBatches } from "./data/importer.js";
import {
  comparisonContent,
  comparisonDiagnosticsPageContent,
  absentDevicesPageContent,
  churnContent,
  dashboardFleetDialogContent,
  dashboardAggregateDialogContent,
  dashboardChangeDeviceGroupsContent,
  deviceTable,
  defaultHistoryLogColumnWidths,
  excelColumnLabel,
  modelPrefixAnalyticsContent,
  download,
  drawBars,
  drawFinalChangeTrend,
  drawFinalTotalsTrend,
  drawLegacyDailyStatistics,
  drawWeekly,
  escapeHtml,
  HISTORY_LOG_COLUMNS,
  historyLogColumnControls,
  historyLogContent,
  createHistoryLogColumnWidthOptimizer,
  setHistoryLogGroupsOpen,
  legacyObservationLogContent,
  identityConflictDetails,
  finalHistoryComparisonDetails,
  identityCandidateComparisonMarkup,
  macTimelineContent,
  macTimelineAppearancesContent,
  macTimelineSummaryContent,
  normalizedHistoryLogColumns,
  normalizedHistoryLogColumnWidths,
  paginationSummary,
  renderKpis,
  renderRanked,
  renderSelect,
  roomAnomalyContent,
  roomPairComparisonContent,
  roomCoverageContent,
  roomTimelineObservationContent,
  showDialog,
  unassignedDevicesContent,
} from "./ui/render.js";

const $ = (selector) => document.querySelector(selector) || queryLazyTab(selector);
const $$ = (selector) => [...document.querySelectorAll(selector), ...queryAllLazyTabs(selector)];
const scheduledBatchQueue = createSerialQueue();
const workspaceStateQueue = createSerialQueue();
const localNotificationQueue = createSerialQueue();
let ieeeOuiIndex = null;
let bundledIeeeRegistry = null;
let macHistoryOptionsTimer = 0;
let macHistoryOptionsRequest = 0;
const isStreamableTableFile = (file) => typeof file?.slice === "function";

const TABLE_COLUMNS = INVENTORY_DEFAULT_COLUMNS;

const ROLE_FIELDS = Object.freeze({
  main: ["id", "deviceId", "serial", "mac", "mac2", "hostname", "ip", "switchIp", "switchPort", "authenticationTime", "manufacturer", "model", "deviceType", "deviceName", "smartroomId", "businessUnit", "city", "site", "floor", "room", "address", "physicalAddress", "locationPath"],
  smartroom: ["id", "deviceId", "serial", "mac", "mac2", "hostname", "ip", "switchIp", "switchPort", "authenticationTime", "manufacturer", "model", "deviceType", "deviceName", "smartroomId", "businessUnit", "city", "site", "floor", "room", "address", "physicalAddress", "locationPath"],
  ddio: ["reservationMac", "reservationIp", "leaseMac", "leaseIp", "deviceId"],
});

const state = {
  inventory: [],
  inventoryTotal: 0,
  inventoryColumnConfig: defaultInventoryColumnConfig(),
  inventoryColumnConfigLoaded: false,
  vendorDetectorSettings: DEFAULT_VENDOR_DETECTOR_SETTINGS,
  historyEnrichmentSettings: DEFAULT_HISTORY_ENRICHMENT_SETTINGS,
  ipEnrichmentSettings: DEFAULT_IP_ENRICHMENT_SETTINGS,
  enrichmentFieldSettings: DEFAULT_ENRICHMENT_FIELD_SETTINGS,
  ouiFormats: DEFAULT_OUI_FORMATS,
  selectedDevices: new Map(),
  contextDevice: null,
  contextDeviceKey: "",
  contextRow: null,
  contextIsInventory: false,
  tableRevision: 0,
  tableController: null,
  activeSnapshot: null,
  snapshotMetadata: [],
  legacyAutosavePage: 0,
  legacyAutosaveCursors: [null],
  legacyAutosavePageRequest: 0,
  roomCatalog: [],
  roomCatalogRevision: 0,
  roomCatalogPromise: null,
  roomFilterCascadeSignature: "",
  roomTimelineSnapshotIds: [],
  roomTimelineRoom: {},
  roomTimelineKey: "",
  roomTimelineRevision: 0,
  roomTimelinePages: {},
  roomTimelineDiagnostics: 0,
  roomPair: null,
  roomPairPage: 1,
  sourceTables: { main: null, smartroom: null, ddio: null },
  sourceFiles: { main: null, smartroom: null, ddio: null },
  workspaceSourceHandles: { main: null, smartroom: null, ddio: null },
  batchDirectoryHandles: { main: null, smartroom: null, ddio: null },
  switchIpChangeQueryId: "",
  switchIpChangeTotal: 0,
  switchIpChangesOffset: 0,
  switchIpChangePageRequest: 0,
  mappings: { main: {}, smartroom: {}, ddio: {} },
  sourceMappingPreferences: { main: [], smartroom: [], ddio: [] },
  legacyWorkspaceSources: [],
  search: "",
  page: 1,
  pageSize: 50,
  sort: { field: "mac", direction: 1 },
  workspaceView: "search",
  workspaceAutosaveTimer: 0,
  analytics: null,
  dataQualityHistoryOffset: 0,
  dataQualityHistoryRequestId: 0,
  localNotificationSettings: { ...DEFAULT_LOCAL_NOTIFICATION_SETTINGS, events: { ...DEFAULT_LOCAL_NOTIFICATION_SETTINGS.events } },
  localNotificationLog: [],
  analyticsNeedsRefresh: false,
  analyticsClusterPage: 0,
  analyticsClusterCursors: [null],
  analyticsTopologyPage: 0,
  analyticsTopologyPortPages: {},
  analyticsTopologyDevicePages: {},
  analyticsTopologyDevicePageData: {},
  analyticsTopologyUnassignedPage: 0,
  analyticsTopologyUnassignedPageData: null,
  analyticsUnassignedDeviceRequest: 0,
  analyticsComparisonDetailRequest: 0,
  analyticsComparisonPageCache: createBoundedComparisonPageCache(),
  analyticsRoomAnomalySnapshotId: "",
  analyticsRoomAnomalyPages: {},
  dashboardFleet: null,
  dashboardFleetOffset: 0,
  analyticsRoomCoveragePages: {},
  analyticsRoomCoverageRequests: new Map(),
  analyticsRoomCoverageSnapshotId: "",
  analyticsRoomCoverageOnlyAllChanged: false,
  analyticsRequests: createRequestGate(),
  dataDirectoryHandle: null,
  dataDirectoryPermission: "unavailable",
  dataDirectoryArchiveWritable: false,
  dataDirectoryWriteFailed: false,
  dataDirectoryIssue: "",
  dataDirectorySyncing: false,
  dataDirectorySyncRequested: false,
  autoSaveTimer: 0,
  autoSaveLastAttemptAt: 0,
  autoSaveRunning: false,
  deviceAnalytics: null,
  modelPrefixAnalytics: null,
  historyLog: { filters: {}, cursor: null, previous: [], page: null, requestId: 0, loaded: false, initialized: false, initializing: null, loadedRevision: -1, columns: HISTORY_LOG_COLUMNS.map(({ key }) => key), columnWidths: normalizedHistoryLogColumnWidths(null), selectedIds: new Set() },
  historyDateSummary: { queryId: null, cursor: null, hasMore: false },
  legacyObservationLog: { filters: {}, cursor: null, previous: [], page: null, requestId: 0, selectedIds: new Set(), queueTaskId: "" },
  uploadHistory: { query: "", from: "", to: "", vendor: "", model: "", room: "", page: 1, limit: 50, results: null, requestId: 0, selectedIds: new Set() },
  snapshotDetail: { id: "", page: 1 },
  vendorModelHistory: { data: null, kind: "vendors", query: "", page: 1, loading: false },
  temporalStatistics: null,
  temporalStatisticsWindowSignature: "",
  temporalStatisticsRequests: new Map(),
  temporalDataRevision: 0,
  comparisonViews: new Map(),
  macHistoryCache: new Map(),
  comparisonChangeCategory: "all",
  comparisonChangeOffset: 0,
  changeReportSettings: { mode: "snapshots", from: "", to: "" },
  periodChangePage: { category: "all", cursor: null, previous: [], page: null, requestId: 0 },
  periodChangeSummary: null,
  comparisonViewSequence: 0,
  temporalRevision: 0,
  ipMappingImport: null,
  ouiImport: null,
  ouiImportController: null,
  controller: null,
  batch: { main: [], smartroom: [], ddio: [], entries: { main: [], smartroom: [], ddio: [] }, filePages: { main: 1, smartroom: 1, ddio: 1 }, pairs: [], pairing: { mode: "nearest", toleranceHours: 24 }, failurePolicy: "continue" },
  scheduledBatches: new Map(),
  legacyTaskSchedulers: new Map(),
  singleFile: { file: null, table: null, mapping: {}, mappingReviewed: false, result: null, sheets: [], sheetName: "" },
  singleAnalysisHistory: { query: "", page: 1, result: null },
  singleFileRevision: 0,
  singleFileController: null,
  fileCompare: { files: [null, null], tables: [null, null], mappings: [{}, {}], result: null, page: 1, ambiguousPage: 1, pageSize: 100, revision: 0, controller: null },
  multiCompare: { files: [], pairs: [], currentResult: null, page: 1, pageSize: 100 },
  engineeringCredential: null,
  engineeringSession: null,
  renderedEngineerMode: null,
  engineeringSessionTimer: 0,
  engineeringSessionMinutes: 30,
  analyticsDashboardSettings: { ...DEFAULT_ANALYTICS_DASHBOARD_SETTINGS },
  analyticsAutoRefreshTimer: 0,
  analyticsAutoRefreshing: false,
  mac5Rules: { query: "", cursor: null, previous: [], page: null, requestId: 0 },
};

const optionalHostSnapshotPage = { after: "", previous: [], items: [], selected: new Set() };

const ieeeCidCatalogState = { query: "", page: 1, pageSize: 20 };

async function downloadReadableStream(filename, stream, mimeType, description, fileHandle = null) {
  const extension = [".macarchive.json", ".madb.json"].find((suffix) => filename.endsWith(suffix))
    || `.${String(filename).split(".").at(-1) || "json"}`;
  try {
    const saved = await saveReadableStreamToFile(stream, {
      suggestedName: filename,
      description,
      mimeType,
      extension,
      fileHandle,
    });
    if (saved) return "saved";
  } catch (error) {
    if (error?.name === "AbortError") return "cancelled";
    throw error;
  }
  const blob = await new globalThis.Response(stream, { headers: { "Content-Type": mimeType } }).blob();
  download(filename, blob, mimeType);
  return "downloaded";
}

async function resolveSaveHandle(handleRequest) {
  if (!handleRequest) return { fileHandle: null, cancelled: false };
  try {
    return { fileHandle: await handleRequest, cancelled: false };
  } catch (error) {
    if (error?.name === "AbortError") return { fileHandle: null, cancelled: true };
    throw error;
  }
}

async function downloadTextWriterExport(filename, mimeType, description, produce) {
  const handleRequest = requestReadableStreamFileHandle({
    suggestedName: filename,
    description,
    mimeType: mimeType.split(";")[0],
    extension: `.${String(filename).split(".").at(-1) || "txt"}`,
  });
  const { fileHandle, cancelled } = await resolveSaveHandle(handleRequest);
  if (cancelled) return "cancelled";
  if (fileHandle) {
    const writable = await fileHandle.createWritable();
    try {
      await produce(writable);
      await writable.close();
      return "saved";
    } catch (error) {
      if (typeof writable.abort === "function") await writable.abort(error).catch(() => {});
      throw error;
    }
  }
  if (typeof globalThis.TransformStream === "function") {
    const encoder = new globalThis.TextEncoder();
    const transform = new globalThis.TransformStream({
      transform(chunk, controller) { controller.enqueue(encoder.encode(String(chunk))); },
    });
    const writer = transform.writable.getWriter();
    const textWriter = { write: (chunk) => writer.write(encoder.encode(String(chunk))) };
    const savePromise = downloadReadableStream(filename, transform.readable, mimeType, description);
    const producePromise = (async () => {
      try {
        await produce(textWriter);
        await writer.close();
      } catch (error) {
        await writer.abort(error).catch(() => {});
        throw error;
      }
    })();
    try {
      const result = await savePromise;
      if (result === "cancelled") {
        await writer.abort(new DOMException("Сохранение отменено", "AbortError")).catch(() => {});
        await producePromise.catch(() => {});
        return result;
      }
      await producePromise;
      return result;
    } catch (error) {
      await writer.abort(error).catch(() => {});
      await producePromise.catch(() => {});
      throw error;
    }
  }
  const sink = createTextBlobStreamSink(mimeType);
  if (!sink) throw new Error("Потоковый экспорт недоступен в этом браузере");
  try {
    await produce(sink.writable);
    await sink.writable.close();
    download(filename, await sink.blobPromise, mimeType);
    return "downloaded";
  } catch (error) {
    await sink.writable.abort(error);
    await sink.blobPromise.catch(() => {});
    throw error;
  }
}

function showError(error) {
  const banner = $("#errorBanner");
  const occurrence = error && (typeof error === "object" || typeof error === "function") ? error : String(error);
  showErrorBanner(banner, error instanceof Error ? error.message : String(error), { dialog: document.querySelector("dialog[open]"), occurrence });
  const errorName = error instanceof Error && /^[a-z][a-z0-9]{0,63}$/i.test(error.name) ? error.name : "Error";
  console.error("[MAC Analyzer]", errorName);
  database.recordApplicationLog("ui_error", errorName).catch(() => {});
}

async function compareInventoryObservationFromDatabase(devices, timestamp) {
  const comparator = createInventoryObservationComparator(devices, timestamp);
  await database.inventoryCandidatesForDevices(devices, {
    batchSize: 250,
    includeExactAliases: true,
    onPage: (candidates) => comparator.acceptCandidates(candidates),
  });
  return comparator.finish();
}

async function prepareStagedInventoryComparison(deviceStore, timestamp, { signal, onProgress = () => {} } = {}) {
  const queryId = `history-plan:${Date.now()}:${crypto.randomUUID()}`;
  let eventOffset = 0;
  const summary = { addedCount: 0, modifiedDeviceCount: 0, unchangedCount: 0, ambiguousCount: 0, identityConflictCount: 0 };
  try {
    for (let offset = 0; offset < deviceStore.count; offset += 250) {
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      const page = await deviceStore.readPage(offset, 250);
      const candidates = await database.inventoryCandidatesForDevices(page, {
        batchSize: 250,
        includeExactAliases: true,
      });
      const comparison = reconcileAndCompareInventoryObservation(page, candidates, timestamp);
      await deviceStore.writePage(offset, page);
      for (const field of Object.keys(summary)) summary[field] += Number(comparison[field] || 0);
      const events = [
        ...comparison.added.map((device) => ({ type: "added", device: { id: device.id, mac: device.mac } })),
        ...comparison.modified.map((row) => ({
          type: "modified",
          row: {
            after: {
              id: row.after.id,
              mac: row.after.mac,
              possibleIps: row.after.possibleIps,
              possibleIpsTruncated: row.after.possibleIpsTruncated,
            },
            changes: row.changes,
          },
        })),
      ];
      await database.appendFinalHistoryPlanEvents(queryId, events, { offset: eventOffset });
      eventOffset += events.length;
      onProgress(Math.min(deviceStore.count, offset + page.length));
    }
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    return {
      historyPlanId: queryId,
      historyPlanEventCount: eventOffset,
      historyComparison: { ...summary, absentCount: 0, timestamp },
    };
  } catch (error) {
    await database.clearAnalyticsAggregateQuery(queryId).catch(() => {});
    throw error;
  }
}

async function completeSingleFileStageSummary(deviceStore, summary, { signal, onProgress = () => {} } = {}) {
  const queryId = `single-analysis-summary:${crypto.randomUUID()}`;
  const fields = { manufacturer: 0, model: 0, address: 0, room: 0, switchIp: 0 };
  const metrics = { manufacturers: "manufacturer", models: "model", rooms: "room" };
  try {
    for (let offset = 0; offset < deviceStore.count; offset += 500) {
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      const devices = await deviceStore.readPage(offset, 500);
      const counts = countSingleFileDeviceFields(devices);
      fields.manufacturer += counts.withManufacturer;
      fields.model += counts.withModel;
      fields.address += counts.withAddress;
      fields.room += counts.withRoom;
      fields.switchIp += counts.withSwitchIp;
      const macs = [];
      const aggregate = Object.fromEntries(Object.keys(metrics).map((metric) => [metric, []]));
      for (const device of devices) {
        if (device.mac) macs.push(device.mac);
        for (const [metric, field] of Object.entries(metrics)) {
          aggregate[metric].push({ value: String(device[field] || "Не указано"), count: 1 });
        }
      }
      await database.addAnalyticsDistinctBatch(queryId, "unique-mac", macs);
      await database.mergeAnalyticsAggregateBatches(queryId, aggregate);
      onProgress(Math.min(deviceStore.count, offset + devices.length));
    }
    const [uniqueMacs, manufacturers, models, rooms] = await Promise.all([
      database.analyticsAggregateCount(queryId, "unique-mac"),
      database.analyticsAggregateTop(queryId, "manufacturers", 10, "ru", { tieBreak: "numeric" }),
      database.analyticsAggregateTop(queryId, "models", 10, "ru", { tieBreak: "numeric" }),
      database.analyticsAggregateTop(queryId, "rooms", 10, "ru", { tieBreak: "numeric" }),
    ]);
    return {
      ...summary,
      valid: deviceStore.count,
      uniqueMacs,
      withManufacturer: fields.manufacturer,
      withModel: fields.model,
      withAddress: fields.address,
      withRoom: fields.room,
      withSwitchIp: fields.switchIp,
      manufacturers: manufacturers.map(({ value: label, count: value }) => ({ label, value })),
      models: models.map(({ value: label, count: value }) => ({ label, value })),
      rooms: rooms.map(({ value: label, count: value }) => ({ label, value })),
    };
  } finally {
    await database.clearAnalyticsAggregateQuery(queryId).catch(() => {});
  }
}

function createSingleAnalysisDeviceStageStore(queryId) {
  return {
    queryId,
    count: 0,
    async appendPage(devices, { offset, total, identityEntries = new Map() }) {
      const appended = await database.appendFinalDeviceStageChunk(queryId, devices, { offset, total, identityEntries });
      this.count = offset + appended;
      return appended;
    },
    readPage: (offset, limit) => database.finalDeviceStagePage(queryId, { offset, limit }),
    readPositions: (positions) => database.finalDeviceStageDevicesAtPositions(queryId, positions),
    readIdentityEntries: (keys) => database.finalDeviceStageIdentityEntries(queryId, keys),
    writeIdentityEntries: (entries, maxPositionExclusive) => database.writeFinalDeviceStageIdentityEntries(
      queryId, entries, { maxPositionExclusive },
    ),
    writePositions: (updates) => database.replaceFinalDeviceStageDevicesAtPositions(queryId, updates),
    writePage: (offset, devices) => database.replaceFinalDeviceStagePage(queryId, { offset, devices }),
    finalize: (total) => database.finalizeFinalDeviceStage(queryId, total),
  };
}

function isEngineerActive() {
  return isEngineeringSessionActive(state.engineeringSession);
}

function renderLocalNotificationLog() {
  const host = $("#localNotificationLog");
  if (!host) return;
  const events = state.localNotificationSettings.events;
  const eventInputs = {
    analysis: $("#localNotificationEvent_analysis"),
    quality: $("#localNotificationEvent_quality"),
    backup: $("#localNotificationEvent_backup"),
  };
  for (const [event, input] of Object.entries(eventInputs)) if (input) input.checked = events[event];
  const status = $("#localNotificationStatus");
  if (status) status.textContent = `${state.localNotificationLog.length.toLocaleString("ru-RU")} записей · журнал хранится только в IndexedDB этого браузера; внешние каналы не используются.`;
  host.replaceChildren();
  if (!state.localNotificationLog.length) {
    host.textContent = "Локальных уведомлений пока нет.";
    return;
  }
  for (const item of state.localNotificationLog) {
    const article = document.createElement("article");
    article.className = "local-notification-item";
    const heading = document.createElement("strong");
    heading.textContent = item.title;
    const detail = document.createElement("p");
    detail.className = "muted";
    detail.textContent = `${new Date(item.createdAt).toLocaleString("ru-RU")} · ${item.type} · локально`;
    const message = document.createElement("p");
    message.textContent = item.message;
    article.dataset.level = item.level;
    article.append(heading, detail, message);
    host.append(article);
  }
}

async function loadLocalNotifications() {
  const [settings, log] = await Promise.all([
    database.getSetting("localNotificationSettings", DEFAULT_LOCAL_NOTIFICATION_SETTINGS),
    database.getSetting("localNotificationLog", []),
  ]);
  state.localNotificationSettings = normalizeLocalNotificationSettings(settings);
  state.localNotificationLog = normalizeLocalNotificationLog(log);
  renderLocalNotificationLog();
}

async function saveLocalNotificationSettings() {
  const events = {
    analysis: $("#localNotificationEvent_analysis").checked,
    quality: $("#localNotificationEvent_quality").checked,
    backup: $("#localNotificationEvent_backup").checked,
  };
  const settings = normalizeLocalNotificationSettings({ events });
  await localNotificationQueue.enqueue(async () => {
    await database.setSetting("localNotificationSettings", settings);
    state.localNotificationSettings = settings;
  });
  renderLocalNotificationLog();
  $("#localNotificationSaveStatus").textContent = "Настройки сохранены в IndexedDB этого браузера.";
}

async function recordLocalNotification(type, title, message, level = "info") {
  return localNotificationQueue.enqueue(async () => {
    const settings = normalizeLocalNotificationSettings(await database.getSetting("localNotificationSettings", state.localNotificationSettings));
    const stored = normalizeLocalNotificationLog(await database.getSetting("localNotificationLog", state.localNotificationLog));
    const result = appendLocalNotification(stored, { type, title, message, level }, settings);
    if (!result.added) return false;
    await database.setSetting("localNotificationLog", result.log);
    state.localNotificationSettings = settings;
    state.localNotificationLog = result.log;
    renderLocalNotificationLog();
    return true;
  });
}

async function clearLocalNotificationLog() {
  if (!globalThis.confirm("Очистить локальный журнал уведомлений?")) return;
  await localNotificationQueue.enqueue(async () => {
    await database.setSetting("localNotificationLog", []);
    state.localNotificationLog = [];
  });
  renderLocalNotificationLog();
}

function workspaceStateOptions() {
  return {
    views: $$(".nav-button").map((button) => button.dataset.view),
    sortFields: TABLE_COLUMNS.map(([key]) => key),
    pageSizes: [...$("#pageSizeSelect").options].map((option) => Number(option.value || option.textContent)),
  };
}

async function persistWorkspaceState() {
  return workspaceStateQueue.enqueue(async () => {
    const options = workspaceStateOptions();
    const value = captureWorkspaceState({
      view: state.workspaceView,
      search: state.search,
      page: state.page,
      pageSize: state.pageSize,
      sort: state.sort,
    }, options.views, options.sortFields, options.pageSizes);
    await database.setSetting("workspaceState", value);
    const status = $("#workspaceStateStatus");
    if (status) status.textContent = `Рабочее состояние сохранено · ${new Date().toLocaleTimeString("ru-RU")}`;
    return value;
  });
}

function scheduleWorkspaceStateSave() {
  globalThis.clearTimeout(state.workspaceAutosaveTimer);
  state.workspaceAutosaveTimer = globalThis.setTimeout(() => {
    state.workspaceAutosaveTimer = 0;
    persistWorkspaceState().catch(showError);
  }, 350);
}

async function restoreWorkspaceState() {
  const saved = await readWorkspaceState(workspaceStateQueue, database);
  applyWorkspaceState(saved);
  if (saved) $("#workspaceStateStatus").textContent = "Рабочее состояние восстановлено из IndexedDB.";
}

function applyWorkspaceState(value) {
  const options = workspaceStateOptions();
  const restored = normalizeWorkspaceState(value, options);
  state.workspaceView = restored.view;
  state.search = restored.search;
  state.page = restored.page;
  state.pageSize = restored.pageSize;
  state.sort = restored.sort;
  $("#globalSearch").value = state.search;
  $("#pageSizeSelect").value = String(state.pageSize);
}

async function saveWorkspaceStateNow() {
  globalThis.clearTimeout(state.workspaceAutosaveTimer);
  state.workspaceAutosaveTimer = 0;
  await persistWorkspaceState();
}

async function restoreWorkspaceStateNow() {
  globalThis.clearTimeout(state.workspaceAutosaveTimer);
  state.workspaceAutosaveTimer = 0;
  const saved = await readWorkspaceState(workspaceStateQueue, database);
  if (!saved) {
    $("#workspaceStateStatus").textContent = "Сохранённого рабочего состояния нет.";
    return false;
  }
  applyWorkspaceState(saved);
  const accessibleView = canAccessView(state.workspaceView, isEngineerActive()) ? state.workspaceView : "search";
  activateView(accessibleView);
  await renderDeviceTable();
  $("#workspaceStateStatus").textContent = "Сохранённое рабочее состояние восстановлено.";
  return true;
}

async function deleteWorkspaceState() {
  globalThis.clearTimeout(state.workspaceAutosaveTimer);
  state.workspaceAutosaveTimer = 0;
  await deleteWorkspaceStateSetting(workspaceStateQueue, database);
  $("#workspaceStateStatus").textContent = "Checkpoint удалён. Автосохранение продолжится при следующем изменении интерфейса.";
}

function expireEngineeringSessionIfNeeded() {
  if (!state.engineeringSession || isEngineerActive()) return false;
  endEngineeringSession();
  return true;
}

function formatSessionRemaining(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function renderEngineeringMode() {
  const engineer = isEngineerActive();
  const button = $("#engineeringModeButton");
  if (button) {
    button.textContent = engineer
      ? `Инженер · ${formatSessionRemaining(engineeringSessionRemainingSeconds(state.engineeringSession))} · Выйти`
      : "Пользователь · Войти";
    button.setAttribute("aria-label", engineer ? "Завершить инженерную сессию" : "Войти в инженерный режим");
  }
  $$(".nav-button").forEach((nav) => { nav.hidden = !canAccessView(nav.dataset.view, engineer); });
  $$(".nav-group").forEach((group) => { group.hidden = !group.querySelector(".nav-button:not([hidden])"); });
  const columnManager = $("#toggleInventoryColumnManager");
  const columnDialog = $("#inventoryColumnManagerDialog");
  if (columnManager) columnManager.hidden = !engineer;
  if (!engineer && columnDialog?.open) columnDialog.close();
  const analyticsSettingsButton = $("#analyticsSettingsButton");
  if (analyticsSettingsButton) analyticsSettingsButton.hidden = !engineer;
  for (const selector of ["#deleteHistoryEventsButton", "#deleteFilteredHistoryEventsButton", "#deleteLegacyObservationsButton", "#deleteFilteredLegacyObservationsButton"]) {
    const button = $(selector);
    if (button) button.hidden = !engineer;
  }
  if (state.renderedEngineerMode !== engineer) {
    state.renderedEngineerMode = engineer;
    if (!engineer) {
      state.historyLog.selectedIds.clear();
      state.legacyObservationLog.selectedIds.clear();
      const historyPage = state.historyLog.page;
      if (historyPage) {
        $("#historyLogStatus").textContent = `${historyPage.total.toLocaleString("ru-RU")} событий · страница ${state.historyLog.previous.length + 1} · показано ${historyPage.rows.length.toLocaleString("ru-RU")} · отмечено 0`;
        $("#deleteHistoryEventsButton").disabled = true;
      }
      $("#deleteLegacyObservationsButton").disabled = true;
    }
    if (state.historyLog.page) {
      $("#historyLogResults").innerHTML = historyLogContent(state.historyLog.page.rows, state.historyLog.columns, state.historyLog.selectedIds, state.historyLog.columnWidths, engineer);
    }
    if (state.legacyObservationLog.page) {
      $("#legacyObservationResults").innerHTML = legacyObservationLogContent(state.legacyObservationLog.page.rows, state.legacyObservationLog.selectedIds, state.legacyObservationLog.queueSummaries, engineer);
    }
  }
  const dataQualityPanel = $("#dataQualityPanel");
  if (dataQualityPanel) dataQualityPanel.hidden = !engineer;
  if (engineer && dataQualityPanel?.dataset.historyLoaded !== "true") {
    void renderDataQualityHistory().then(() => { dataQualityPanel.dataset.historyLoaded = "true"; }).catch(showError);
  }
}

function renderAnalyticsDashboardSettings() {
  $("#analyticsAutoRefreshEnabled").checked = state.analyticsDashboardSettings.autoRefresh;
  $("#analyticsRefreshIntervalSeconds").value = String(state.analyticsDashboardSettings.refreshIntervalSeconds);
  $$("[data-dashboard-widget-setting]").forEach((input) => {
    input.checked = isDashboardWidgetVisible(state.analyticsDashboardSettings, input.dataset.dashboardWidgetSetting);
  });
}

function applyDashboardWidgetVisibility() {
  $$("#analyticsKpis [data-dashboard-widget-kpi]").forEach((item) => {
    item.classList.toggle("dashboard-widget-hidden", !isDashboardWidgetVisible(state.analyticsDashboardSettings, item.dataset.dashboardWidgetKpi));
  });
  $$("[data-dashboard-widget]").forEach((item) => {
    item.classList.toggle("dashboard-widget-hidden", !isDashboardWidgetVisible(state.analyticsDashboardSettings, item.dataset.dashboardWidget));
  });
  if (state.analytics?.detailsReady) drawDashboardStatusCharts(state.analytics);
}

function activeDashboardWidgetKeys() {
  return new Map([...DASHBOARD_KPI_WIDGETS, ...DASHBOARD_CHART_WIDGETS]
    .map(({ key }) => [key, isDashboardWidgetVisible(state.analyticsDashboardSettings, key)]));
}

function scheduleAnalyticsAutoRefresh() {
  globalThis.clearInterval(state.analyticsAutoRefreshTimer);
  state.analyticsAutoRefreshTimer = 0;
  if (!state.analyticsDashboardSettings.autoRefresh) return;
  state.analyticsAutoRefreshTimer = globalThis.setInterval(() => {
    if (document.visibilityState === "hidden" || $("#analyticsView").hidden || state.analyticsAutoRefreshing || !state.analytics?.detailsReady) return;
    state.analyticsAutoRefreshing = true;
    renderAnalytics(true).catch((error) => {
      state.analyticsAutoRefreshing = false;
      showAnalyticsFallback(error, state.analytics);
    });
  }, state.analyticsDashboardSettings.refreshIntervalSeconds * 1_000);
}

async function loadAnalyticsDashboardSettings() {
  const savedSettings = await database.getSetting("analyticsDashboardSettings", null);
  const importedLegacySettings = savedSettings
    ? null
    : legacyAnalyticsDashboardSettings(await database.getSetting("legacyAppSetting:dashboard", null));
  state.analyticsDashboardSettings = normalizeAnalyticsDashboardSettings(savedSettings || importedLegacySettings || DEFAULT_ANALYTICS_DASHBOARD_SETTINGS);
  if (importedLegacySettings) await database.setSetting("analyticsDashboardSettings", importedLegacySettings);
  renderAnalyticsDashboardSettings();
  applyDashboardWidgetVisibility();
  scheduleAnalyticsAutoRefresh();
}

async function saveAnalyticsDashboardSettings(settings) {
  applyAnalyticsDashboardSettings(settings);
  await database.setSetting("analyticsDashboardSettings", state.analyticsDashboardSettings);
}

function applyAnalyticsDashboardSettings(settings) {
  state.analyticsDashboardSettings = normalizeAnalyticsDashboardSettings(settings);
  renderAnalyticsDashboardSettings();
  applyDashboardWidgetVisibility();
  scheduleAnalyticsAutoRefresh();
  $("#dashboardComparisonMode").value = state.analyticsDashboardSettings.comparisonMode;
  $("#dashboardComparisonDateFrom").value = state.analyticsDashboardSettings.comparisonDateFrom;
  $("#dashboardComparisonDateTo").value = state.analyticsDashboardSettings.comparisonDateTo;
  syncDashboardComparisonControls();
  syncDashboardFilterControls();
  $("#analyticsDashboardSettingsStatus").textContent = state.analyticsDashboardSettings.autoRefresh
    ? `Автообновление включено: каждые ${state.analyticsDashboardSettings.refreshIntervalSeconds} с, пока открыта аналитика.`
    : "Автообновление выключено.";
}

function endEngineeringSession({ returnToSearch = true } = {}) {
  stopScheduledBatch("Планировщик остановлен вместе с инженерной сессией.");
  for (const scheduler of state.legacyTaskSchedulers.values()) scheduler.stop({ notify: false });
  state.legacyTaskSchedulers.clear();
  state.engineeringSession = null;
  if ($("#analyticsDashboardSettingsDialog").open) $("#analyticsDashboardSettingsDialog").close();
  renderEngineeringMode();
  if (returnToSearch) activateView("search");
  renderDeviceTable().catch(showError);
  if (state.legacyObservationLog.page) {
    const current = state.legacyObservationLog;
    loadLegacyObservationLog({ filters: current.filters, cursor: current.cursor, previous: current.previous }).catch(showError);
  }
}

async function initializeEngineeringMode() {
  state.engineeringCredential = await database.getSetting("engineeringCredential", null);
  state.engineeringSessionMinutes = normalizeEngineeringSessionMinutes(await database.getSetting("engineeringSessionMinutes", 30));
  $("#engineeringSessionMinutes").value = String(state.engineeringSessionMinutes);
  renderEngineeringMode();
  state.engineeringSessionTimer = globalThis.setInterval(() => {
    if (!isEngineerActive()) {
      if (state.engineeringSession) endEngineeringSession();
      else renderEngineeringMode();
      return;
    }
    renderEngineeringMode();
  }, 1_000);
}

function openEngineeringModeDialog() {
  expireEngineeringSessionIfNeeded();
  if (isEngineerActive()) {
    endEngineeringSession();
    return;
  }
  const firstUse = !state.engineeringCredential;
  $("#engineeringModeDescription").textContent = firstUse
    ? "Задайте пароль инженера. Сохранится только стойкий хеш; пароль не записывается в базу."
    : "Введите пароль, чтобы открыть инженерные разделы. Неверный пароль не меняет текущий режим.";
  $("#engineeringPasswordConfirmField").hidden = !firstUse;
  $("#engineeringPassword").autocomplete = firstUse ? "new-password" : "current-password";
  $("#engineeringPasswordConfirm").required = firstUse;
  $("#engineeringPassword").value = "";
  $("#engineeringPasswordConfirm").value = "";
  $("#engineeringModeStatus").textContent = "";
  $("#engineeringModeSubmit").textContent = firstUse ? "Создать пароль и войти" : "Войти в инженерный режим";
  $("#engineeringModeDialog").showModal();
  $("#engineeringPassword").focus();
}

async function submitEngineeringLogin(event) {
  event.preventDefault();
  const password = $("#engineeringPassword").value;
  const firstUse = !state.engineeringCredential;
  const status = $("#engineeringModeStatus");
  const submit = $("#engineeringModeSubmit");
  submit.disabled = true;
  try {
    if (firstUse) {
      if (password !== $("#engineeringPasswordConfirm").value) throw new Error("Пароли не совпадают");
      const credential = await createEngineerCredential(password);
      await database.setSetting("engineeringCredential", credential);
      state.engineeringCredential = credential;
    } else if (!await verifyEngineerCredential(password, state.engineeringCredential)) {
      throw new Error("Неверный пароль инженера");
    }
    state.engineeringSessionMinutes = normalizeEngineeringSessionMinutes($("#engineeringSessionMinutes").value);
    await database.setSetting("engineeringSessionMinutes", state.engineeringSessionMinutes);
    state.engineeringSession = createEngineeringSession(state.engineeringSessionMinutes);
    $("#engineeringModeDialog").close();
    renderEngineeringMode();
    try { await restoreWorkspaceSourceHandles({ loadPermittedFiles: true }); }
    catch (error) { showError(error); }
    try { await restoreWorkspaceBatchDirectories({ loadPermittedFiles: true }); }
    catch (error) { showError(error); }
    await restoreLegacyTaskSchedulers();
    if (!$("#historyView").hidden && state.legacyObservationLog.page) {
      const current = state.legacyObservationLog;
      await loadLegacyObservationLog({ filters: current.filters, cursor: current.cursor, previous: current.previous });
    }
    await renderDeviceTable();
  } catch (error) {
    status.textContent = error.message || String(error);
    $("#engineeringPassword").focus();
  } finally {
    $("#engineeringPassword").value = "";
    $("#engineeringPasswordConfirm").value = "";
    submit.disabled = false;
  }
}

function clearError() {
  dismissErrorBanner($("#errorBanner"));
}

function cancelActiveProcess() {
  return abortActiveControllers([state.controller, state.singleFileController, state.fileCompare.controller, state.ouiImportController]);
}

function handleAppPageHide(event) {
  const cleaned = cleanupPageHide(event, {
    abortActive: cancelActiveProcess,
    invalidatePending: invalidateAnalyticsRequests,
    intervalTimers: [state.autoSaveTimer, state.analyticsAutoRefreshTimer, state.engineeringSessionTimer, state.workspaceAutosaveTimer],
    stopSchedulers: [
      () => stopScheduledBatch("Планировщик остановлен при закрытии приложения."),
      () => {
        for (const scheduler of state.legacyTaskSchedulers.values()) scheduler.stop({ notify: false });
        state.legacyTaskSchedulers.clear();
      },
    ],
  });
  if (!cleaned) return;
  state.autoSaveTimer = 0;
  state.analyticsAutoRefreshTimer = 0;
  state.engineeringSessionTimer = 0;
}

function progress(value, detail, title = "Обработка") {
  const panel = $("#progressPanel");
  panel.hidden = false;
  $("#progressTitle").textContent = title;
  $("#progressPercent").textContent = `${Math.round(value)}%`;
  $("#progressBar").value = value;
  $("#progressDetail").textContent = detail;
}

function finishProgress(detail = "Готово") {
  progress(100, detail);
  setTimeout(() => { $("#progressPanel").hidden = true; }, 900);
}

function supportsDataDirectoryAccess() {
  return globalThis.isSecureContext !== false && typeof globalThis.showDirectoryPicker === "function";
}

async function refreshDataDirectoryControls() {
  const pickerButton = $("#chooseDataDirectoryButton");
  const permissionButton = $("#dataDirectoryButton");
  const status = $("#dataDirectoryStatus");
  const supported = supportsDataDirectoryAccess();
  if (!state.dataDirectoryHandle) state.dataDirectoryIssue = "";
  const controls = dataDirectoryControlState({
    supported,
    permission: state.dataDirectoryPermission,
    handle: state.dataDirectoryHandle,
    writeFailed: state.dataDirectoryWriteFailed,
    issue: state.dataDirectoryIssue,
  });
  pickerButton.hidden = controls.picker.hidden;
  pickerButton.disabled = controls.picker.disabled;
  pickerButton.textContent = controls.picker.text;
  permissionButton.hidden = controls.reauthorize.hidden;
  permissionButton.textContent = controls.reauthorize.text;
  status.textContent = controls.status;
}

async function restoreDataDirectoryArchive() {
  state.dataDirectoryArchiveWritable = false;
  state.dataDirectoryWriteFailed = false;
  state.dataDirectoryHandle = await database.dataDirectoryHandle();
  if (!state.dataDirectoryHandle) {
    state.dataDirectoryPermission = "unavailable";
    await refreshDataDirectoryControls();
    return false;
  }
  state.dataDirectoryPermission = await queryDirectoryPermission(state.dataDirectoryHandle);
  await refreshDataDirectoryControls();
  if (state.dataDirectoryPermission !== "granted") return false;
  try {
    const file = await getDirectoryArchiveFile(state.dataDirectoryHandle);
    if (!file) {
      state.dataDirectoryArchiveWritable = true;
      state.dataDirectoryIssue = "Архив в выбранной папке отсутствует; будет создан после сверки с IndexedDB.";
      return false;
    }
    await importPortableArchiveFile(file);
    state.dataDirectoryArchiveWritable = true;
    state.dataDirectoryIssue = "";
    state.analytics = null;
    $("#dataDirectoryStatus").textContent = `Архив из «${state.dataDirectoryHandle.name || "папки данных"}» объединён с IndexedDB.`;
    return true;
  } catch (error) {
    state.dataDirectoryIssue = `Автовосстановление не выполнено; файл не перезаписан: ${error.message}`;
    $("#dataDirectoryStatus").textContent = state.dataDirectoryIssue;
    return false;
  }
}

function portableDatabaseArchiveStream() {
  return database.exportArchiveStream(portableDatabaseArchiveOptions());
}

function portableDatabaseArchiveOptions() {
  return {
    readLegacyTaskQueueFile: (source, observation) => readLegacyTaskQueueFileFromSQLite(source, observation),
  };
}

async function synchronizeDataDirectoryArchiveOnce() {
  const handle = state.dataDirectoryHandle;
  if (!handle || !state.dataDirectoryArchiveWritable) return;
  try {
    state.dataDirectoryPermission = await queryDirectoryPermission(handle);
    if (state.dataDirectoryPermission !== "granted") {
      await refreshDataDirectoryControls();
      return;
    }
    await writeDirectoryArchive(handle, portableDatabaseArchiveStream());
    if (handle !== state.dataDirectoryHandle) {
      state.dataDirectorySyncRequested = true;
      return;
    }
    state.dataDirectoryWriteFailed = false;
    state.dataDirectoryIssue = "";
    $("#dataDirectoryStatus").textContent = `Portable archive синхронизирован · ${new Date().toLocaleString("ru-RU")}.`;
  } catch (error) {
    if (handle !== state.dataDirectoryHandle) {
      state.dataDirectorySyncRequested = true;
      return;
    }
    state.dataDirectoryArchiveWritable = false;
    state.dataDirectoryWriteFailed = true;
    state.dataDirectoryIssue = `Запись архива не выполнена: ${error.message}. Final сохранён в IndexedDB; выберите папку с правом записи.`;
    try { state.dataDirectoryPermission = await queryDirectoryPermission(handle); } catch { state.dataDirectoryPermission = "prompt"; }
    await refreshDataDirectoryControls();
    $("#dataDirectoryStatus").textContent = state.dataDirectoryIssue;
  }
}

function synchronizeDataDirectoryArchive() {
  if (!state.dataDirectoryHandle || !state.dataDirectoryArchiveWritable) return;
  return runCoalescedTask(state, synchronizeDataDirectoryArchiveOnce, {
    runningKey: "dataDirectorySyncing",
    pendingKey: "dataDirectorySyncRequested",
  });
}

async function autoSaveActiveFinal() {
  if (state.autoSaveRunning) return;
  const status = $("#autoSaveStatus");
  const handle = state.dataDirectoryHandle;
  if (!state.activeSnapshot || !(state.activeSnapshot.deviceCount > 0)) {
    status.textContent = "Автосохранение Final ожидает успешный снимок с устройствами.";
    return;
  }
  if (!handle) {
    status.textContent = "Автосохранение Final: выберите папку данных, чтобы сохранять XLSX каждые 5 минут.";
    return;
  }
  if (state.dataDirectoryWriteFailed) {
    status.textContent = "Автосохранение приостановлено после ошибки записи. Выберите другую папку кнопкой в шапке приложения.";
    return;
  }
  state.autoSaveRunning = true;
  try {
    state.dataDirectoryPermission = await queryDirectoryPermission(handle);
    if (state.dataDirectoryPermission !== "granted") {
      await refreshDataDirectoryControls();
      status.textContent = "Автосохранение пропущено: разрешите доступ к папке кнопкой в шапке приложения.";
      return;
    }
    const date = new Date();
    const uniqueToken = globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const fileName = autoSaveXlsxFilename(date, uniqueToken);
    const columns = inventoryOutputColumns();
    const sheets = createSnapshotXlsxSheets(database, state.activeSnapshot, columns);
    let result;
    try {
      result = await writeDirectoryFile(handle, fileName, createXlsxWorkbookStream(sheets));
    } catch (error) {
      state.dataDirectoryWriteFailed = true;
      state.dataDirectoryIssue = `Автосохранение не выполнено: ${error.message}. Final остаётся в IndexedDB; выберите другую папку.`;
      try { state.dataDirectoryPermission = await queryDirectoryPermission(handle); } catch { state.dataDirectoryPermission = "prompt"; }
      await refreshDataDirectoryControls();
      throw error;
    }
    status.textContent = `Final сохранён в ${result.fileName} · ${date.toLocaleString("ru-RU")}.`;
  } catch (error) {
    status.textContent = `Автосохранение не выполнено: ${error.message}. Final остаётся в IndexedDB.`;
  } finally {
    state.autoSaveRunning = false;
  }
}

function startFinalAutoSave() {
  if (state.autoSaveTimer) return;
  state.autoSaveLastAttemptAt = Date.now();
  $("#autoSaveStatus").textContent = state.activeSnapshot?.deviceCount > 0
    ? (state.dataDirectoryHandle && state.dataDirectoryPermission === "granted"
      ? "Автосохранение Final включено · первый XLSX будет создан через 5 минут."
      : "Автосохранение Final ожидает выбранную папку с разрешением на запись.")
    : "Автосохранение Final ожидает успешный снимок с устройствами.";
  state.autoSaveTimer = globalThis.setInterval(requestFinalAutoSaveIfDue, AUTO_SAVE_INTERVAL_MS);
}

function requestFinalAutoSaveIfDue(now = Date.now()) {
  if (!state.autoSaveTimer || state.autoSaveRunning || !isAutoSaveDue(state.autoSaveLastAttemptAt, now)) return false;
  state.autoSaveLastAttemptAt = now;
  void autoSaveActiveFinal();
  return true;
}

async function chooseDataDirectory() {
  if (!supportsDataDirectoryAccess()) throw new Error("Выбор папки данных доступен в поддерживаемом Chrome или Edge в защищённом контексте");
  const handle = await pickDataDirectory((options) => globalThis.showDirectoryPicker(options));
  if (!handle) return;
  state.dataDirectoryWriteFailed = false;
  state.dataDirectoryIssue = "";
  await database.setDataDirectoryHandle(handle);
  state.dataDirectoryHandle = handle;
  state.dataDirectoryPermission = await queryDirectoryPermission(handle);
  await refreshDataDirectoryControls();
  if (state.dataDirectoryPermission !== "granted") {
    state.dataDirectoryPermission = await requestDirectoryPermission(handle);
  }
  if (state.dataDirectoryPermission === "granted") {
    await restoreDataDirectoryArchive();
    await refreshDatabaseState();
  } else {
    await refreshDataDirectoryControls();
  }
}

async function reauthorizeDataDirectory() {
  if (state.dataDirectoryWriteFailed) return chooseDataDirectory();
  if (!state.dataDirectoryHandle) return chooseDataDirectory();
  await reauthorizeDirectoryHandle(state.dataDirectoryHandle, {
    onPermission: (permission) => { state.dataDirectoryPermission = permission; },
    onDenied: () => refreshDataDirectoryControls(),
    onGranted: async () => {
      await restoreDataDirectoryArchive();
      await refreshDatabaseState();
    },
  });
}

function activateView(name) {
  if (!canAccessView(name, isEngineerActive())) {
    $("#engineeringModeStatus").textContent = "Этот раздел доступен в инженерном режиме.";
    return false;
  }
  activateLazyTab(name);
  const previousView = $(".nav-button.active")?.dataset.view || "";
  if (previousView === "analytics" && name !== "analytics") {
    invalidateAnalyticsRequests();
    state.analytics = null;
    state.analyticsAutoRefreshing = false;
    state.analyticsNeedsRefresh = true;
    state.analyticsRoomAnomalyPages = {};
    state.analyticsRoomCoveragePages = {};
    state.analyticsRoomCoverageRequests.clear();
    state.analyticsTopologyDevicePageData = {};
    state.analyticsTopologyUnassignedPageData = null;
  }
  hideDeviceContextMenu();
  $$(".nav-button").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $$(".view").forEach((view) => {
    const active = view.id === `${name}View`;
    view.classList.toggle("active", active);
    view.hidden = !active;
  });
  history.replaceState(null, "", `#${name}`);
  state.workspaceView = name;
  scheduleWorkspaceStateSave();
  if (name === "analytics") {
    const force = state.analyticsNeedsRefresh;
    state.analyticsNeedsRefresh = false;
    renderAnalytics(force).catch((error) => {
      if (force) state.analyticsNeedsRefresh = true;
      showAnalyticsFallback(error, state.analytics);
    });
  }
  if (name === "history") {
    renderMacOptions().catch(showError);
    if (!state.historyLog.initialized) initializeHistoryLog().catch(showError);
    else if (!state.historyLog.initializing && historyLogNeedsRefresh(state.historyLog, state.temporalDataRevision)) {
      loadHistoryLog({ filters: state.historyLog.filters, cursor: null, previous: [] }).catch(showError);
    }
  }
  if (name === "notifications") renderLocalNotificationLog();
  if (name === "rooms") initializeRoomFilters().catch(showError);
  if (name === "data") { renderSnapshotList(); renderMac5RuleList().catch(showError); renderLocalArchiveList().catch(showError); renderLegacyAutosaveRestoreList().catch(showError); renderPerformanceMetrics().catch(showError); renderApplicationLog().catch(showError); }
  return true;
}

function handleGlobalShortcut(event) {
  expireEngineeringSessionIfNeeded();
  const shortcut = identifyShortcut(event);
  if (!shortcut) return;
  if (!isEngineerActive() && !isShortcutAllowedWithoutEngineer(shortcut)) return;
  const actions = {
    "ctrl+o": () => { activateView("enrichment"); $("#mainFileInput").click(); },
    "ctrl+s": () => {
      activateView("data");
      $(state.snapshotMetadata.length ? "#exportFinalXlsxButton" : "#exportDatabaseButton").click();
    },
    "ctrl+e": () => {
      activateView("data");
      const menu = $("#exportFinalCsvButton").closest("details.export-menu");
      menu.open = true;
      menu.querySelector("summary").focus();
    },
    "ctrl+a": () => activateView("analytics"),
    "ctrl+h": () => activateView("history"),
    "ctrl+f": () => { activateView("search"); $("#globalSearch").focus(); $("#globalSearch").select(); },
    "ctrl+shift+c": () => {
      openInventoryColumnManagerDialog($("#inventoryColumnManagerDialog"), $("#inventoryCustomColumnLabel"), $("#toggleInventoryColumnManager"));
    },
    f1: () => activateView("guide"),
    f5: () => { activateView("enrichment"); $("#runEnrichmentButton").click(); },
    f6: () => activateView("filecompare"),
    f7: () => { activateView("analytics"); $("#datasetOverview").scrollIntoView({ block: "start" }); },
    f8: () => { activateView("analytics"); $("#topologySummary").closest("article").scrollIntoView({ block: "start" }); },
    f9: () => activateView("multicompare"),
    escape: () => {
      const target = escapeActionTarget({
        contextMenuOpen: !$("#deviceContextMenu").hidden,
        dialogOpen: document.querySelector("dialog[open]") !== null,
        errorVisible: !$("#errorBanner").hidden,
        processVisible: !$("#progressPanel").hidden,
      });
      if (target === "context-menu") hideDeviceContextMenu();
      else if (target === "error") dismissErrorBanner($("#errorBanner"), { suppressRepeat: true });
      else if (target === "process") cancelActiveProcess();
      return target !== "" && target !== "native-dialog";
    },
  };
  const action = actions[shortcut];
  if (!action) return;
  if (shortcut === "escape") {
    if (action()) event.preventDefault();
    return;
  }
  event.preventDefault();
  action();
}

async function refreshDatabaseState() {
  invalidateAnalyticsRequests();
  state.analytics = null;
  state.analyticsComparisonPageCache.clear();
  state.comparisonViews.clear();
  state.macHistoryCache.clear();
  state.snapshotMetadata = (await database.listSnapshots({ includeDiagnostics: false })).filter(isFinalSnapshot);
  state.roomCatalogRevision += 1;
  state.roomCatalogPromise = null;
  state.roomCatalog = [];
  state.roomFilterCascadeSignature = "";
  state.temporalStatistics = null;
  state.temporalStatisticsWindowSignature = "";
  state.temporalRevision += 1;
  state.temporalDataRevision += 1;
  state.periodChangeSummary = null;
  state.periodChangePage = { category: "all", cursor: null, previous: [], page: null, requestId: state.periodChangePage.requestId + 1 };
  state.activeSnapshot = await database.activeSnapshotMetadata();
  const optionalSnapshotUploadButton = $("#optionalHostSnapshotUploadButton");
  if (optionalSnapshotUploadButton) optionalSnapshotUploadButton.disabled = !state.activeSnapshot;
  state.inventoryTotal = await database.inventoryCount();
  const optionalInventoryUploadButton = $("#optionalHostInventoryUploadButton");
  if (optionalInventoryUploadButton) optionalInventoryUploadButton.disabled = state.inventoryTotal === 0;
  writeDatabaseStatusCache({ snapshotCount: state.snapshotMetadata.length, inventoryCount: state.inventoryTotal });
  $("#databaseStatus").textContent = `${state.snapshotMetadata.length} Final · ${state.inventoryTotal.toLocaleString("ru-RU")} устройств`;
  renderSnapshotSelectors();
  await renderDeviceTable();
  await renderMacOptions();
  await renderIpMappings();
  await renderLocalArchiveList();
  await refreshDataDirectoryControls();
  await synchronizeDataDirectoryArchive();
}

async function renderLocalArchiveList() {
  const host = $("#localArchiveList");
  if (!host) return;
  const archives = await database.listLocalArchives();
  host.innerHTML = archives.length
    ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Архив</th><th>Создан</th><th>Final</th><th>Записей</th><th>Действия</th></tr></thead><tbody>${archives.map((archive) => `<tr><td>${escapeHtml(archive.name)}</td><td>${escapeHtml(new Date(archive.createdAt).toLocaleString("ru-RU"))}</td><td>${Number(archive.snapshotCount || 0).toLocaleString("ru-RU")}</td><td>${Number(archive.recordCount || 0).toLocaleString("ru-RU")}</td><td><button type="button" class="button secondary" data-restore-local-archive="${escapeHtml(archive.id)}">Восстановить</button> <button type="button" class="button secondary" data-export-local-archive="${escapeHtml(archive.id)}">Выгрузить</button> <button type="button" class="button secondary" data-delete-local-archive="${escapeHtml(archive.id)}">Удалить</button></td></tr>`).join("")}</tbody></table></div>`
    : '<p class="empty">Локальные архивы ещё не сохранены.</p>';
  host.querySelectorAll("[data-restore-local-archive]").forEach((button) => button.addEventListener("click", () => (async () => {
    const result = await database.restoreLocalArchive(button.dataset.restoreLocalArchive);
    state.analytics = null;
    await refreshDatabaseState();
    $("#localArchiveStatus").textContent = `Архив объединён с базой. Final: ${result.snapshotCount}; активный: ${result.activeSnapshotId || "не выбран"}.`;
  })().catch(showError)));
  host.querySelectorAll("[data-export-local-archive]").forEach((button) => button.addEventListener("click", () => (async () => {
    const archive = archives.find((item) => item.id === button.dataset.exportLocalArchive);
    const safeName = String(archive?.name || "archive").replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 60) || "archive";
    const filename = `${safeName}.madb.json`;
    let fileHandle = null;
    try {
      const handleRequest = requestReadableStreamFileHandle({
        suggestedName: filename,
        description: "Локальный архив MAC Analyzer",
        mimeType: "application/json",
        extension: ".madb.json",
      });
      fileHandle = handleRequest ? await handleRequest : null;
    } catch (error) {
      if (error?.name === "AbortError") return;
      throw error;
    }
    const stream = await database.exportLocalArchiveStream(button.dataset.exportLocalArchive, portableDatabaseArchiveOptions());
    await downloadReadableStream(filename, stream, "application/json", "Локальный архив MAC Analyzer", fileHandle);
  })().catch(showError)));
  host.querySelectorAll("[data-delete-local-archive]").forEach((button) => button.addEventListener("click", () => (async () => {
    const archive = archives.find((item) => item.id === button.dataset.deleteLocalArchive);
    if (!globalThis.confirm(`Удалить локальный архив «${archive?.name || ""}»?`)) return;
    await database.deleteLocalArchive(button.dataset.deleteLocalArchive);
    $("#localArchiveStatus").textContent = "Локальный архив удалён.";
    await renderLocalArchiveList();
  })().catch(showError)));
}

async function renderLegacyAutosaveRestoreList() {
  const host = $("#legacyAutosaveRestoreList");
  if (!host) return;
  const pageIndex = Math.max(0, Math.floor(Number(state.legacyAutosavePage) || 0));
  const requestId = ++state.legacyAutosavePageRequest;
  const page = await database.legacyAutosavePage({ limit: 50, after: state.legacyAutosaveCursors[pageIndex] || null });
  if (requestId !== state.legacyAutosavePageRequest) return;
  if (!page.rows.length) {
    host.innerHTML = '<p class="muted">Импортированные автосохранения не найдены.</p>';
    return;
  }
  host.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th>Слот</th><th>Сохранено</th><th>Final</th><th>Действие</th></tr></thead><tbody>${page.rows.map((record) => {
    const value = record.value && typeof record.value === "object" ? record.value : {};
    const slot = String(record.key || "").slice("legacyAutosave:".length);
    const snapshot = state.snapshotMetadata.find((item) => item.id === value.snapshotId && isFinalSnapshot(item));
    const snapshotStatus = snapshot ? `${escapeHtml(snapshot.name || snapshot.id)} · ${Number(snapshot.deviceCount || 0).toLocaleString("ru-RU")} устройств` : "Связанный импортированный Final не найден";
    const action = `<div class="action-row">${snapshot ? `<button class="button secondary" type="button" data-activate-legacy-autosave="${escapeHtml(record.key)}">Сделать Final активным</button>` : ""}<button class="button secondary" type="button" data-restore-legacy-autosave-settings="${escapeHtml(record.key)}">Восстановить настройки</button></div>`;
    return `<tr><td>${escapeHtml(slot || "—")}</td><td>${escapeHtml(value.updatedAt ? new Date(value.updatedAt).toLocaleString("ru-RU") : "—")}</td><td>${snapshotStatus}</td><td>${action}</td></tr>`;
  }).join("")}</tbody></table></div><div class="pagination-controls"><button class="button secondary" type="button" data-legacy-autosave-page="previous"${pageIndex === 0 ? " disabled" : ""}>Назад</button><span class="muted">Страница ${pageIndex + 1} · ${page.rows.length} автосохранений</span><button class="button secondary" type="button" data-legacy-autosave-page="next"${!page.hasMore || !page.nextCursor ? " disabled" : ""}>Далее</button></div>`;
  host.querySelectorAll("[data-legacy-autosave-page]").forEach((button) => button.addEventListener("click", () => {
    if (button.disabled) return;
    if (button.dataset.legacyAutosavePage === "previous") {
      state.legacyAutosavePage = Math.max(0, pageIndex - 1);
    } else if (button.dataset.legacyAutosavePage === "next" && page.hasMore && page.nextCursor) {
      state.legacyAutosaveCursors[pageIndex + 1] = page.nextCursor;
      state.legacyAutosaveCursors.length = pageIndex + 2;
      state.legacyAutosavePage = pageIndex + 1;
    }
    renderLegacyAutosaveRestoreList().catch(showError);
  }));
  host.querySelectorAll("[data-activate-legacy-autosave]").forEach((button) => button.addEventListener("click", () => (async () => {
    const record = page.rows.find((item) => item.key === button.dataset.activateLegacyAutosave);
    const snapshotId = record?.value?.snapshotId;
    const snapshot = state.snapshotMetadata.find((item) => item.id === snapshotId && isFinalSnapshot(item));
    if (!snapshot) throw new Error("Связанный Final больше не доступен");
    if (!globalThis.confirm(`Сделать Final «${snapshot.name || snapshot.id}» активным? Текущие снимки и история сохранятся. Исходные файлы и незавершённые строки старого рабочего пространства не восстанавливаются.`)) return;
    await database.activateSnapshot(snapshot.id);
    state.analytics = null;
    await refreshDatabaseState();
    $("#legacyAutosaveRestoreStatus").textContent = `Импортированный Final «${snapshot.name || snapshot.id}» активирован; существующие снимки и история сохранены.`;
  })().catch(showError)));
  host.querySelectorAll("[data-restore-legacy-autosave-settings]").forEach((button) => button.addEventListener("click", () => (async () => {
    const key = button.dataset.restoreLegacyAutosaveSettings;
    const rawState = await database.legacyAutosaveState(key, { maxBytes: LEGACY_PYQT_SETTINGS_MAX_BYTES });
    const migration = normalizeLegacyAutosaveSettings(JSON.parse(rawState));
    const labels = migration.applied.join(", ");
    if (!globalThis.confirm(`Восстановить совместимые настройки из этого автосохранения (${labels})? Настройки текущего профиля будут заменены только в перечисленных пунктах. Результаты и импортированные снимки не изменятся; секреты и локальные пути не переносятся.`)) return;
    const settings = migration.settings;
    let mergedSourceMappingPreferences = null;
    if (settings.sourceMappingPreferences) {
      const current = normalizeSourceMappingPreferences(state.sourceMappingPreferences);
      const restored = normalizeSourceMappingPreferences(settings.sourceMappingPreferences);
      for (const role of ["main", "smartroom", "ddio"]) {
        const entries = [...current[role]];
        for (const preference of restored[role]) {
          const existing = entries.findIndex((entry) => entry.headers.length === preference.headers.length
            && entry.headers.every((header, index) => header === preference.headers[index]));
          if (existing >= 0) entries.splice(existing, 1);
          entries.push(preference);
        }
        current[role] = entries.slice(-8);
      }
      mergedSourceMappingPreferences = current;
      settings.sourceMappingPreferences = current;
    }
    if (settings.ipAddressMappings) {
      const existingMappings = await database.ipAddressMappings();
      settings.ipAddressMappings = normalizeIpMappings([...settings.ipAddressMappings, ...existingMappings]);
    }
    const records = Object.entries(settings).map(([settingKey, value]) => ({ key: settingKey, value }));
    await database.setSettings(records);
    if (settings.theme) {
      applyTheme(settings.theme);
      try { globalThis.localStorage?.setItem("mac-analyzer-theme", settings.theme); } catch { /* IndexedDB remains the persistent source. */ }
    }
    if (settings.vendorDetectorSettings) applyVendorDetectorSettings(settings.vendorDetectorSettings);
    if (settings.historyEnrichmentSettings) applyHistoryEnrichmentSettings(settings.historyEnrichmentSettings);
    if (settings.ipEnrichmentSettings) applyIpEnrichmentSettings(settings.ipEnrichmentSettings);
    if (settings.enrichmentFieldSettings) applyEnrichmentFieldSettings(settings.enrichmentFieldSettings);
    if (settings.ouiFormats) applyOuiFormatSettings(settings.ouiFormats);
    if (settings.enrichmentStrategy) {
      const strategy = document.querySelector(`input[name="strategy"][value="${settings.enrichmentStrategy}"]`);
      if (strategy) strategy.checked = true;
    }
    if (settings.analyticsDashboardSettings) applyAnalyticsDashboardSettings(settings.analyticsDashboardSettings);
    if (settings.ipAddressMappings) await renderIpMappings();
    if (settings.inventoryColumnConfig) {
      state.inventoryColumnConfig = normalizeInventoryColumnConfig(settings.inventoryColumnConfig);
      state.inventoryColumnConfigLoaded = true;
      renderInventoryColumnManager();
      await renderDeviceTable();
    }
    if (mergedSourceMappingPreferences) state.sourceMappingPreferences = mergedSourceMappingPreferences;
    $("#legacyAutosaveRestoreStatus").textContent = `Настройки восстановлены: ${labels}. Результаты и Final не менялись.`;
  })().catch(showError)));
}

async function renderIpMappings() {
  const mappings = await database.ipAddressMappings();
  const host = $("#ipMappingList");
  host.innerHTML = mappings.length
    ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>IP коммутатора</th><th>Физический адрес</th><th>Источник</th><th></th></tr></thead><tbody>${mappings.map((item) => `<tr><td>${escapeHtml(item.switchIp)}</td><td>${escapeHtml(item.address)}</td><td>${escapeHtml(item.source)}</td><td><button type="button" class="button secondary" data-delete-ip-mapping="${escapeHtml(item.switchIp)}">Удалить</button></td></tr>`).join("")}</tbody></table></div>`
    : '<p class="empty">Правила ещё не добавлены.</p>';
  host.querySelectorAll("[data-delete-ip-mapping]").forEach((button) => button.addEventListener("click", () => (async () => {
    await database.deleteIpAddressMapping(button.dataset.deleteIpMapping);
    await renderIpMappings();
    await synchronizeDataDirectoryArchive();
  })().catch(showError)));
}

async function prepareIpMappingImport(file) {
  if (!file) return;
  const table = isStreamableTableFile(file) ? await readTablePreview(file, { maxRows: 100 }) : await readTable(file);
  const suggested = detectIpMappingColumns(table.headers, table.rows);
  state.ipMappingImport = { file, table, ...suggested };
  const panel = $("#ipMappingImportPanel");
  const columnOptions = (selected) => `<option value="">Выберите колонку</option>${table.headers.map((header, index) => `<option value="${index}" ${selected === index ? "selected" : ""}>${escapeHtml(`${excelColumnLabel(index)} · ${header || `Колонка ${index + 1}`}`)}</option>`).join("")}`;
  panel.innerHTML = `<p>Файл: ${escapeHtml(file.name)} · выберите столбцы для IP коммутатора и физического адреса.</p><div class="mapping-grid"><label><span>IP коммутатора</span><select id="ipMappingImportSwitchColumn">${columnOptions(suggested.switchIndex)}</select></label><label><span>Физический адрес</span><select id="ipMappingImportAddressColumn">${columnOptions(suggested.addressIndex)}</select></label></div><button id="confirmIpMappingImportButton" class="button primary" type="button">Импортировать правила</button>`;
  panel.hidden = false;
  const confirm = $("#confirmIpMappingImportButton");
  const update = () => {
    const switchIndex = Number($("#ipMappingImportSwitchColumn").value);
    const addressIndex = Number($("#ipMappingImportAddressColumn").value);
    confirm.disabled = !Number.isInteger(switchIndex) || !Number.isInteger(addressIndex) || switchIndex === addressIndex
      || $("#ipMappingImportSwitchColumn").value === "" || $("#ipMappingImportAddressColumn").value === "";
  };
  panel.querySelectorAll("select").forEach((select) => select.addEventListener("change", update));
  confirm.addEventListener("click", () => importIpMappings(file, {
    switchIndex: Number($("#ipMappingImportSwitchColumn").value),
    addressIndex: Number($("#ipMappingImportAddressColumn").value),
  }).catch(showError));
  update();
}

async function importIpMappings(file, { switchIndex, addressIndex } = {}) {
  if (!file) return;
  const prepared = state.ipMappingImport?.file === file ? state.ipMappingImport : null;
  const streamingTable = isStreamableTableFile(file);
  const table = prepared?.table || (streamingTable ? await readTablePreview(file, { maxRows: 100 }) : await readTable(file));
  if (!Number.isInteger(switchIndex) || switchIndex < 0 || switchIndex >= table.headers.length
    || !Number.isInteger(addressIndex) || addressIndex < 0 || addressIndex >= table.headers.length || switchIndex === addressIndex) {
    throw new Error("Выберите разные колонки IP коммутатора и физического адреса");
  }
  const importedRecords = async function* () {
    const batches = streamingTable
      ? readTableRowBatches(file, { batchSize: 500 })
      : (async function* () { yield table.rows; })();
    for await (const rows of batches) {
      for (const row of rows) {
        const switchIp = text(row[switchIndex]);
        const address = text(row[addressIndex]);
        if (switchIp && address) yield { switchIp, address, source: `Файл: ${file.name}` };
      }
    }
  };
  const saved = await database.mergeIpAddressMappings(importedRecords());
  await synchronizeDataDirectoryArchive();
  $("#ipMappingStatus").textContent = `Всего сохранено правил: ${saved.length}`;
  $("#ipMappingImportPanel").hidden = true;
  $("#ipMappingImportPanel").replaceChildren();
  state.ipMappingImport = null;
  await renderIpMappings();
}

async function loadInventoryColumnConfig() {
  if (state.inventoryColumnConfigLoaded) return;
  let saved = await database.getSetting("inventoryColumnConfig", null);
  let restoredLegacyPreferences = false;
  if (!saved) {
    for (const viewName of ["inventory", "results"]) {
      const legacy = await database.getSetting(`legacyColumnPreferences:${viewName}`, null);
      const migrated = inventoryColumnConfigFromLegacyPreferences(legacy);
      if (!migrated) continue;
      saved = migrated;
      await database.setSetting("inventoryColumnConfig", migrated);
      restoredLegacyPreferences = true;
      break;
    }
  }
  state.inventoryColumnConfig = normalizeInventoryColumnConfig(saved);
  state.inventoryColumnConfigLoaded = true;
  renderInventoryColumnManager();
  if (restoredLegacyPreferences) $("#inventoryColumnStatus").textContent = "Настройки столбцов восстановлены из импортированной базы.";
}

function renderInventoryColumnManager() {
  const host = $("#inventoryColumnSettings");
  if (!host) return;
  const columns = state.inventoryColumnConfig.columns;
  host.innerHTML = columns.map((column, index) => `<div class="inventory-column-setting" data-column-setting="${escapeHtml(column.key)}"><label class="inventory-column-visible"><input type="checkbox" data-column-visible="${escapeHtml(column.key)}" ${column.visible ? "checked" : ""}> Показать${column.custom ? " · своё поле" : ""}</label><label>Заголовок<input type="text" maxlength="60" data-column-label="${escapeHtml(column.key)}" value="${escapeHtml(column.label)}"></label><label>Ширина, px<input type="number" min="70" max="600" step="10" data-column-width="${escapeHtml(column.key)}" value="${column.width}"></label><span class="inventory-column-order"><button class="button secondary" type="button" data-column-move="${escapeHtml(column.key)}" data-direction="-1" aria-label="Переместить ${escapeHtml(column.label)} выше" ${index === 0 ? "disabled" : ""}>↑</button><button class="button secondary" type="button" data-column-move="${escapeHtml(column.key)}" data-direction="1" aria-label="Переместить ${escapeHtml(column.label)} ниже" ${index === columns.length - 1 ? "disabled" : ""}>↓</button></span>${column.custom ? `<button class="button secondary" type="button" data-column-remove="${escapeHtml(column.key)}" aria-label="Удалить пользовательский столбец ${escapeHtml(column.label)}">Удалить</button>` : ""}</div>`).join("");
}

async function saveInventoryColumnConfig(config, { rerender = true } = {}) {
  state.inventoryColumnConfig = normalizeInventoryColumnConfig(config);
  await database.setSetting("inventoryColumnConfig", state.inventoryColumnConfig);
  renderInventoryColumnManager();
  if (rerender) {
    await renderDeviceTable();
    if (state.snapshotDetail.id && $("#detailsDialog").open && $("#detailsDialog [data-dialog-title]").textContent.startsWith("Final: ")) {
      await openFinalSnapshotPage(state.snapshotDetail.id, state.snapshotDetail.page);
    }
  }
}

async function saveInventoryCustomField(deviceId, fieldKey, value) {
  const updated = await database.updateInventoryCustomField(deviceId, fieldKey, value);
  const device = state.inventory.find((item) => String(item.id) === String(deviceId));
  if (device) Object.assign(device, { customFields: updated.customFields, customFieldSources: updated.customFieldSources });
  const selected = state.selectedDevices.get(deviceId);
  if (selected) Object.assign(selected, { customFields: updated.customFields, customFieldSources: updated.customFieldSources });
  if (state.contextDevice && String(state.contextDevice.id) === String(deviceId)) {
    Object.assign(state.contextDevice, { customFields: updated.customFields, customFieldSources: updated.customFieldSources });
  }
  $("#inventoryColumnStatus").textContent = "Значение пользовательского поля сохранено в Inventory.";
}

async function optimizeInventoryColumns() {
  const status = $("#inventoryColumnStatus");
  status.textContent = "Измерение ширины по полному Inventory…";
  try {
    const optimized = await optimizeInventoryColumnWidths(state.inventoryColumnConfig, (visit) => database.forEachInventory(visit));
    await saveInventoryColumnConfig(optimized);
    status.textContent = "Ширина рассчитана по всему Inventory.";
  } catch (error) {
    status.textContent = `Не удалось измерить Inventory: ${error.message || error}`;
    throw error;
  }
}

function inventoryOutputColumns() {
  return visibleInventoryColumns(state.inventoryColumnConfig).map(({ key, label }) => ({
    key,
    label,
    value: (device, rowNumber) => inventoryCellText(device, key, rowNumber),
  }));
}

async function renderDeviceTable() {
  await loadInventoryColumnConfig();
  state.tableController?.abort();
  const controller = new globalThis.AbortController();
  state.tableController = controller;
  const revision = ++state.tableRevision;
  let result;
  try {
    result = await database.searchInventory({ query: state.search, field: state.sort.field, direction: state.sort.direction, page: state.page, pageSize: state.pageSize, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) return;
    throw error;
  }
  if (revision !== state.tableRevision) return;
  state.inventory = result.items;
  state.page = result.page;
  scheduleWorkspaceStateSave();
  const columns = visibleInventoryColumns(state.inventoryColumnConfig);
  const sortableColumnKeys = new Set(TABLE_COLUMNS.map(([key]) => key));
  $("#searchCount").textContent = `Всего найдено: ${result.total.toLocaleString("ru-RU")} устройств`;
  $("#pageLabel").textContent = paginationSummary(result);
  $("#deviceTable").innerHTML = `<table class="data-table inventory-data-table" data-virtual-scroll="true"><colgroup><col style="width:44px">${columns.map(({ width }) => `<col style="width:${width}px">`).join("")}</colgroup><thead><tr><th><input class="row-select" type="checkbox" data-select-page aria-label="Выбрать все строки этой страницы" title="Выбрать строки этой страницы"></th>${columns.map(({ key, label }) => `<th>${sortableColumnKeys.has(key) ? `<button class="table-sort" type="button" data-sort="${escapeHtml(key)}">${escapeHtml(label)}${state.sort.field === key ? (state.sort.direction > 0 ? " ↑" : " ↓") : ""}</button>` : escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${result.items.map((device, rowIndex) => { const rowNumber = (result.page - 1) * state.pageSize + rowIndex + 1; return `<tr data-device-id="${escapeHtml(device.id)}" tabindex="0" aria-selected="${state.selectedDevices.has(device.id)}" class="${state.selectedDevices.has(device.id) ? "is-selected" : ""}"><td><input class="row-select" type="checkbox" data-select-device="${escapeHtml(device.id)}" aria-label="Выбрать ${escapeHtml(device.mac || device.hostname || device.id)}" ${state.selectedDevices.has(device.id) ? "checked" : ""}></td>${columns.map(({ key, label, custom }) => { const value = inventoryCellText(device, key, rowNumber); return custom && isEngineerActive() ? `<td><input class="inventory-custom-cell" type="text" maxlength="4000" data-inventory-custom-field="${escapeHtml(key)}" aria-label="${escapeHtml(label)} для ${escapeHtml(device.mac || device.hostname || device.id)}" value="${escapeHtml(value)}"></td>` : `<td title="${escapeHtml(value)}">${escapeHtml(value || "—")}</td>`; }).join("")}</tr>`; }).join("")}</tbody></table>`;
  $("#deviceTable").querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => {
    state.sort = state.sort.field === button.dataset.sort ? { field: button.dataset.sort, direction: -state.sort.direction } : { field: button.dataset.sort, direction: 1 };
    scheduleWorkspaceStateSave();
    renderDeviceTable().catch(showError);
  }));
  $("#deviceTable").querySelectorAll("[data-device-id]").forEach((row) => row.addEventListener("dblclick", () => {
    const device = state.inventory.find((item) => item.id === row.dataset.deviceId);
    const target = searchResultDoubleClickTarget(device);
    if (target?.kind === "mac") {
      showDialog($("#detailsDialog"), `Выбор действия · ${target.mac}`, `<p>Выберите действие для MAC-адреса ${escapeHtml(target.mac)}:</p><div class="action-row"><button class="button primary" type="button" data-search-result-action="history" data-device-id="${escapeHtml(device.id)}">Показать историю</button><button class="button secondary" type="button" data-search-result-action="analytics" data-device-id="${escapeHtml(device.id)}">Аналитика устройства</button></div>`);
      return;
    }
    if (target?.kind === "model") {
      openModelPrefixAnalytics(target.model).catch(showError);
      return;
    }
    openDeviceAnalytics(device).catch(showError);
  }));
  $("#deviceTable").querySelectorAll("[data-select-device]").forEach((checkbox) => checkbox.addEventListener("change", () => {
    const device = state.inventory.find((item) => item.id === checkbox.dataset.selectDevice);
    setDeviceSelected(device, checkbox.checked);
  }));
  $("#deviceTable").addEventListener("change", (event) => {
    const input = event.target.closest("[data-inventory-custom-field]");
    if (!input) return;
    const row = input.closest("[data-device-id]");
    saveInventoryCustomField(row?.dataset.deviceId, input.dataset.inventoryCustomField, input.value).catch(showError);
  });
  $("#deviceTable [data-select-page]").addEventListener("change", (event) => {
    for (const device of state.inventory) setDeviceSelected(device, event.target.checked, false);
    updateDeviceSelectionUi();
  });
  $("#deviceTable").querySelectorAll("[data-device-id]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("button, input, a")) return;
      const device = state.inventory.find((item) => item.id === row.dataset.deviceId);
      if (!device) return;
      if (event.ctrlKey || event.metaKey) setDeviceSelected(device, !state.selectedDevices.has(device.id));
      else {
        state.selectedDevices.clear();
        setDeviceSelected(device, true, false);
        updateDeviceSelectionUi();
      }
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === " " && !event.target.closest("input,button")) {
        event.preventDefault();
        const device = state.inventory.find((item) => item.id === row.dataset.deviceId);
        if (device) setDeviceSelected(device, !state.selectedDevices.has(device.id));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const device = state.inventory.find((item) => item.id === row.dataset.deviceId);
        openDeviceAnalytics(device).catch(showError);
      } else if (event.key === "F10" && event.shiftKey) {
        event.preventDefault();
        const device = state.inventory.find((item) => item.id === row.dataset.deviceId);
        if (device && !state.selectedDevices.has(device.id)) {
          state.selectedDevices.clear();
          setDeviceSelected(device, true, false);
          updateDeviceSelectionUi();
        }
        showDeviceContextMenu(row.dataset.deviceId, row.getBoundingClientRect().left, row.getBoundingClientRect().bottom, { device, row, inventory: true });
      }
    });
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const device = state.inventory.find((item) => item.id === row.dataset.deviceId);
      if (device && !state.selectedDevices.has(device.id)) {
        state.selectedDevices.clear();
        setDeviceSelected(device, true, false);
        updateDeviceSelectionUi();
      }
      showDeviceContextMenu(row.dataset.deviceId, event.clientX, event.clientY, { device, row, inventory: true });
    });
  });
  const deviceTbody = $("#deviceTable table tbody");
  deviceTbody.addEventListener("virtual-table-render", () => {
    deviceTbody.querySelectorAll("[data-device-id]").forEach((row) => {
      const selected = state.selectedDevices.has(row.dataset.deviceId);
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-selected", String(selected));
      const checkbox = row.querySelector("[data-select-device]");
      if (checkbox) checkbox.checked = selected;
    });
  });
  refreshVirtualTable(deviceTbody);
  updateDeviceSelectionUi();
}

function setDeviceSelected(device, selected, update = true) {
  if (!device?.id) return;
  if (selected) state.selectedDevices.set(device.id, device);
  else state.selectedDevices.delete(device.id);
  const row = [...$("#deviceTable").querySelectorAll("[data-device-id]")].find((item) => item.dataset.deviceId === device.id);
  if (row) {
    row.classList.toggle("is-selected", selected);
    row.setAttribute("aria-selected", String(selected));
    const checkbox = row.querySelector("[data-select-device]");
    if (checkbox) checkbox.checked = selected;
  }
  if (update) updateDeviceSelectionUi();
}

function updateDeviceSelectionUi() {
  const count = state.selectedDevices.size;
  $("#deviceSelectionStatus").textContent = count ? `Выбрано строк: ${count.toLocaleString("ru-RU")}` : "Не выбрано строк";
  $("#clearDeviceSelectionButton").disabled = !count;
  const header = $("#deviceTable [data-select-page]");
  if (header) {
    const selectedOnPage = state.inventory.filter((device) => state.selectedDevices.has(device.id)).length;
    header.checked = state.inventory.length > 0 && selectedOnPage === state.inventory.length;
    header.indeterminate = selectedOnPage > 0 && selectedOnPage < state.inventory.length;
  }
}

function contextDeviceFromRow(row) {
  const values = Object.fromEntries([...row.querySelectorAll("[data-device-field]")]
    .map((cell) => [cell.dataset.deviceField, cell.textContent.trim() === "—" ? "" : cell.textContent.trim()]));
  return { ...values, id: row.dataset.deviceId || values.id || "" };
}

function contextTableColumns(row) {
  const table = row?.closest("table");
  return [...(row?.querySelectorAll("[data-device-field]") || [])].map((cell) => ({
    key: cell.dataset.deviceField,
    label: table?.querySelector(`thead [data-device-column="${cell.dataset.deviceField}"]`)?.textContent.trim() || cell.dataset.deviceField,
  }));
}

function contextTablePage(row) {
  const table = row?.closest("table");
  const rows = [...(table?.querySelectorAll("tbody [data-device-context-row]") || [])];
  return { columns: contextTableColumns(row), rows: rows.map(contextDeviceFromRow) };
}

function showDeviceContextMenu(deviceId, x, y, { device = null, row = null, inventory = false } = {}) {
  const menu = $("#deviceContextMenu");
  menu.dataset.deviceId = deviceId;
  state.contextDevice = device || (row ? contextDeviceFromRow(row) : null);
  state.contextDeviceKey = deviceId;
  state.contextRow = row;
  state.contextIsInventory = inventory;
  menu.querySelectorAll('[data-device-action="copy-selected"], [data-device-action="copy-filtered"]').forEach((item) => { item.hidden = !inventory; });
  menu.hidden = false;
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, globalThis.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, globalThis.innerHeight - bounds.height - 8))}px`;
  menu.querySelector("[role=menuitem]")?.focus();
}

function hideDeviceContextMenu() {
  const menu = $("#deviceContextMenu");
  if (menu) menu.hidden = true;
}

async function copyText(value) {
  if (globalThis.navigator.clipboard?.writeText) {
    try { await globalThis.navigator.clipboard.writeText(value); return; } catch {}
  }
  const helper = document.createElement("textarea");
  helper.value = value;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.append(helper);
  helper.select();
  const copied = document.execCommand("copy");
  helper.remove();
  if (!copied) throw new Error("Браузер не разрешил скопировать данные в буфер обмена");
}

async function copyFilteredInventory() {
  const clipboard = globalThis.navigator.clipboard;
  if (!clipboard?.write || !globalThis.ClipboardItem) {
    throw new Error("Браузер не поддерживает потоковое копирование всего результата. Используйте экспорт CSV или копирование видимой страницы.");
  }
  let resolveBlob;
  let rejectBlob;
  const blobPromise = new Promise((resolve, reject) => { resolveBlob = resolve; rejectBlob = reject; });
  const writePromise = clipboard.write([new globalThis.ClipboardItem({ "text/plain": blobPromise })]);
  let writeError = null;
  writePromise.catch((error) => { writeError = error; });
  const query = state.search;
  const collector = new TableTsvCollector(inventoryOutputColumns(), { chunkRows: 500 });
  let scanned = 0;
  try {
    await database.forEachInventory((device) => {
      if (writeError) throw writeError;
      scanned += 1;
      if (matchesDeviceSearch(device, query)) collector.add(device);
      if (scanned % 5_000 === 0) $("#deviceSelectionStatus").textContent = `Проверено записей: ${scanned.toLocaleString("ru-RU")}`;
    });
    const result = collector.finish();
    resolveBlob(result.blob);
    await writePromise;
    $("#deviceSelectionStatus").textContent = `Скопированы все найденные строки: ${result.rowCount.toLocaleString("ru-RU")}`;
  } catch (error) {
    rejectBlob(error);
    await writePromise.catch(() => {});
    throw error;
  }
}

async function runDeviceContextAction(action, deviceId) {
  const device = state.contextDevice && state.contextDeviceKey === deviceId
    ? state.contextDevice
    : state.inventory.find((item) => item.id === deviceId) || state.selectedDevices.get(deviceId);
  const contextRow = state.contextRow;
  const inventoryContext = state.contextIsInventory;
  hideDeviceContextMenu();
  if (action === "copy-mac") {
    if (!device?.mac) throw new Error("У выбранного устройства нет MAC-адреса");
    await copyText(device.mac);
  } else if (action === "copy-row") {
    if (!device) throw new Error("Устройство больше не найдено");
    await copyText(tableRowsTsv([device], inventoryContext ? inventoryOutputColumns() : contextTableColumns(contextRow), { includeHeaders: false }));
  } else if (action === "copy-selected") {
    if (!inventoryContext) throw new Error("Выбор нескольких строк доступен в таблице Inventory");
    if (!state.selectedDevices.size) throw new Error("Сначала выберите строки таблицы");
    await copyText(tableRowsTsv([...state.selectedDevices.values()], inventoryOutputColumns(), { includeHeaders: false }));
  } else if (action === "copy-page") {
    if (inventoryContext) await copyText(tableRowsTsv(state.inventory, inventoryOutputColumns()));
    else {
      const page = contextTablePage(contextRow);
      if (!page.rows.length) throw new Error("В этой таблице нет строк для копирования");
      await copyText(tableRowsTsv(page.rows, page.columns));
    }
  } else if (action === "copy-filtered") {
    if (!inventoryContext) throw new Error("Копирование полного результата поиска доступно в Inventory");
    await copyFilteredInventory();
    return;
  } else if (action === "history") {
    if (!normalizeMac(device?.mac)) throw new Error("У выбранного устройства нет MAC-адреса");
    activateView("history");
    $("#macHistorySearch").value = device.mac;
    await openMacHistory();
    return;
  } else if (action === "analytics") {
    await openDeviceAnalytics(device);
    return;
  }
  $("#deviceSelectionStatus").textContent = action === "copy-selected"
    ? `Скопировано строк: ${state.selectedDevices.size.toLocaleString("ru-RU")}`
    : action === "copy-page" ? `Скопирована видимая таблица: ${(inventoryContext ? state.inventory.length : contextTablePage(contextRow).rows.length).toLocaleString("ru-RU")} строк`
      : "Скопировано в буфер обмена";
}

async function openDeviceAnalytics(device) {
  if (!device) throw new Error("Устройство больше не найдено в Inventory");
  state.deviceAnalytics = null;
  showDialog($("#detailsDialog"), `Аналитика устройства · ${device.mac || device.hostname || device.id}`, '<p class="empty">Загружаются появления и история устройства…</p>');
  const appearances = [];
  const matchesDevice = createStrongIdentityMatcher(device);
  for (const metadata of state.snapshotMetadata) {
    let candidateCount = 0;
    const candidates = [];
    await database.forEachSnapshotChunk(metadata.id, (rows) => {
      for (const item of rows) {
        if (!matchesDevice(item)) continue;
        candidateCount += 1;
        if (candidates.length < 2) candidates.push(item);
      }
    });
    const match = resolveDeviceAppearance(device, candidates, candidateCount);
    if (match.status === "absent") continue;
    appearances.push({ ...metadata, status: match.status, device: match.device ? compactDeviceAppearance(match.device) : null, candidateCount: match.candidates.length || candidateCount });
  }
  const historyPage = device.id ? await database.historyPage(device.id, { limit: 100 }) : { rows: [], total: 0, hasMore: false, nextCursor: null };
  const snapshotTimes = new Map(state.snapshotMetadata.map((item) => [item.id, item.createdAt]));
  const events = historyPage.rows.map((item) => ({ ...item, timestamp: item.timestamp || snapshotTimes.get(item.snapshotId) || "" }));
  state.deviceAnalytics = buildDeviceAnalytics(device, appearances, events, historyPage);
  $("#detailsDialog [data-dialog-title]").textContent = `Аналитика устройства · ${device.mac || device.hostname || device.id}`;
  $("#detailsDialog [data-dialog-content]").innerHTML = deviceAnalyticsContent(state.deviceAnalytics);
}

async function loadMoreDeviceHistory() {
  const current = state.deviceAnalytics;
  if (!current?.historyHasMore || !current.device.id || current.historyLoading) return;
  current.historyLoading = true;
  const button = $("#detailsDialog [data-dialog-content] [data-load-device-history]");
  const buttonLabel = button?.textContent || "Показать следующие 100 событий";
  if (button) {
    button.disabled = true;
    button.textContent = "Загрузка истории…";
  }
  try {
    const page = await database.historyPage(current.device.id, { cursor: current.historyCursor, limit: 100 });
    if (state.deviceAnalytics !== current) return;
    const snapshotTimes = new Map(state.snapshotMetadata.map((item) => [item.id, item.createdAt]));
    const added = page.rows.map((item) => ({ ...item, timestamp: item.timestamp || snapshotTimes.get(item.snapshotId) || "" }));
    const content = $("#detailsDialog [data-dialog-content]");
    const historyRows = content.querySelector("#deviceHistoryRows");
    const historyHeading = content.querySelector("#deviceHistoryHeading");
    if (!historyRows || !historyHeading) throw new Error("Не удалось продолжить показ истории устройства");
    current.historyShown = Number(current.historyShown ?? current.history.length) + added.length;
    current.history = added;
    current.historyTotal = Number(page.total ?? current.historyTotal);
    current.modifiedTotal = Number(page.modifiedTotal ?? current.modifiedTotal);
    current.historyHasMore = Boolean(page.hasMore);
    current.historyCursor = page.nextCursor || null;
    historyRows.insertAdjacentHTML("beforeend", deviceAnalyticsHtmlHistoryRows(added));
    historyHeading.textContent = `Изменения параметров (${current.historyTotal.toLocaleString("ru-RU")}) · показано ${current.historyShown.toLocaleString("ru-RU")}`;
    if (!current.historyHasMore) content.querySelector("[data-load-device-history]")?.remove();
  } finally {
    current.historyLoading = false;
    if (state.deviceAnalytics === current && current.historyHasMore && button) {
      button.disabled = false;
      button.textContent = buttonLabel;
    }
  }
}

async function deleteDeviceHistory() {
  const current = state.deviceAnalytics;
  if (!current?.device?.id || !current.historyTotal) return;
  const count = Number(current.historyTotal);
  if (!globalThis.confirm(`Удалить ${count.toLocaleString("ru-RU")} событий журнала этого устройства? Появления в Final, снимки Final и Inventory сохранятся.`)) return;
  const deleted = await database.deleteDeviceHistoryEvents(current.device.id);
  if (state.deviceAnalytics !== current) return;
  const page = await database.historyPage(current.device.id, { limit: 100 });
  if (state.deviceAnalytics !== current) return;
  const snapshotTimes = new Map(state.snapshotMetadata.map((item) => [item.id, item.createdAt]));
  const events = page.rows.map((item) => ({ ...item, timestamp: item.timestamp || snapshotTimes.get(item.snapshotId) || "" }));
  state.deviceAnalytics = buildDeviceAnalytics(current.device, current.appearances, events, page);
  state.macHistoryCache.clear();
  $("#detailsDialog [data-dialog-content]").innerHTML = `<p class="muted" role="status">Удалено событий журнала: ${deleted.toLocaleString("ru-RU")}. Final и Inventory сохранены.</p>${deviceAnalyticsContent(state.deviceAnalytics)}`;
}

async function exportDeviceAnalytics() {
  const payload = state.deviceAnalytics;
  if (!payload) throw new Error("Сначала откройте аналитику устройства");
  const safeMac = normalizeMac(payload.device.mac) || "device";
  const stream = readableTextStreamFromIterable(deviceAnalyticsHtmlChunks(
    payload,
    (deviceId, options) => database.historyPage(deviceId, options),
  ));
  await downloadReadableStream(`device-analytics-${safeMac.replaceAll(":", "")}.html`, stream, "text/html;charset=utf-8", "HTML аналитики устройства");
}

function exportDeviceAnalyticsTxt() {
  const payload = state.deviceAnalytics;
  if (!payload) throw new Error("Сначала откройте аналитику устройства");
  const safeMac = normalizeMac(payload.device.mac) || "device";
  const content = deviceAnalyticsTxt(payload);
  download(`device-analytics-${safeMac.replaceAll(":", "")}.txt`, new globalThis.Blob([content], { type: "text/plain;charset=utf-8" }), "text/plain;charset=utf-8");
}

async function* deviceAnalyticsHistoryRows(device) {
  const snapshotTimes = new Map(state.snapshotMetadata.map((item) => [item.id, item.createdAt]));
  let cursor = null;
  do {
    const page = await database.historyPage(device.id, { cursor, limit: 500 });
    for (const event of page.rows) yield { ...event, timestamp: event.timestamp || snapshotTimes.get(event.snapshotId) || "" };
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  } while (cursor);
}

async function exportDeviceAnalyticsXlsx() {
  const payload = state.deviceAnalytics;
  if (!payload) throw new Error("Сначала откройте аналитику устройства");
  const historyRows = payload.device.id ? deviceAnalyticsHistoryRows(payload.device) : (async function* emptyHistory() {})();
  const stream = createXlsxWorkbookStream(deviceAnalyticsXlsxSheets(payload, historyRows));
  const safeMac = normalizeMac(payload.device.mac) || "device";
  await downloadReadableStream(
    `device-analytics-${safeMac.replaceAll(":", "")}.xlsx`,
    stream,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Аналитика устройства",
  );
}

function renderMapping(role) {
  const table = state.sourceTables[role];
  const container = $(`#${role}Mapping`);
  if (!table) {
    container.innerHTML = "";
    return;
  }
  const report = detectMappingReport(table.headers, table.rows, role);
  const currentMapping = state.mappings[role] || {};
  const identityFields = role === "ddio" ? [] : ["id", "deviceId", "serial", "mac", "mac2"];
  const hasCurrentIdentity = identityFields.some((field) => Number.isInteger(currentMapping[field]));
  const hasCurrentDdIoPair = (Number.isInteger(currentMapping.reservationMac) && Number.isInteger(currentMapping.reservationIp))
    || (Number.isInteger(currentMapping.leaseMac) && Number.isInteger(currentMapping.leaseIp));
  const identityNote = role === "ddio"
    ? hasCurrentDdIoPair ? "Сопоставлена полная пара MAC/IP резервации или аренды." : "Для продолжения требуется выбрать пару MAC и IP резервации или аренды."
    : hasCurrentIdentity ? "В сопоставлении выбран сильный идентификатор; проверьте колонки." : "Сильный идентификатор не выбран. Выберите ID, Device ID, серийный номер или MAC вручную.";
  const customColumns = state.inventoryColumnConfig.columns.filter(({ custom }) => custom);
  const mappingControl = (field, label) => `<label><span>${escapeHtml(label)}</span><select data-mapping-role="${role}" data-mapping-field="${field}"><option value="">Не использовать</option>${table.headers.map((header, index) => `<option value="${index}" ${Number(currentMapping[field]) === index ? "selected" : ""}>${escapeHtml(`${excelColumnLabel(index)} · ${header || `Колонка ${index + 1}`}`)}</option>`).join("")}</select></label>`;
  container.innerHTML = `<p class="mapping-review">${escapeHtml(identityNote)} Автовыбор — подсказка: выбор в списках можно изменить. Ручной выбор запоминается для этой схемы заголовков.</p><button class="button secondary mapping-review-open" type="button" data-open-mapping-review="${role}">Проверить варианты колонок</button>${ROLE_FIELDS[role].map((field) => {
    const detail = report.details[field];
    const recommendedIndex = detail?.recommendedIndex;
    const suggestedHeader = Number.isInteger(recommendedIndex)
      ? text(table.headers[recommendedIndex]) || `Колонка ${recommendedIndex + 1}`
      : "нет уверенного совпадения";
    const recommendedCandidate = detail?.alternatives?.find((item) => item.index === recommendedIndex);
    const examples = recommendedCandidate?.examples?.length ? ` · примеры: ${recommendedCandidate.examples.map((item) => escapeHtml(item)).join(" / ")}` : "";
    const alternatives = detail?.alternatives?.filter((item) => item.index !== recommendedIndex).length
      ? ` · варианты: ${detail.alternatives.filter((item) => item.index !== recommendedIndex).map((item) => `${escapeHtml(item.header)} (${item.score})`).join(", ")}`
      : "";
    const warning = detail?.conflict ? " · есть конфликт кандидатов, проверьте вручную" : "";
    const reason = detail?.recommendedReason ? ` · причины: ${escapeHtml(detail.recommendedReason)}` : "";
    const helper = `Подсказка: ${escapeHtml(suggestedHeader)} · совпадение ${detail?.recommendedConfidence || 0}%${examples}${alternatives}${reason}${warning}`;
    return `<label><span>${escapeHtml(FIELD_LABELS[field])}</span><select data-mapping-role="${role}" data-mapping-field="${field}"><option value="">Не использовать</option>${table.headers.map((header, index) => `<option value="${index}" ${Number(state.mappings[role][field]) === index ? "selected" : ""}>${escapeHtml(`${excelColumnLabel(index)} · ${header || `Колонка ${index + 1}`}`)}</option>`).join("")}</select><small class="mapping-hint">${helper}</small></label>`;
  }).join("")}${customColumns.map(({ key, label }) => mappingControl(key, label)).join("")}${isEngineerActive() ? `<div class="toolbar mapping-custom-field"><label>Новое пользовательское поле<input type="text" data-source-custom-label maxlength="60" autocomplete="off"></label><label>Колонка источника<select data-source-custom-column><option value="">Не указано</option>${table.headers.map((header, index) => `<option value="${index}">${escapeHtml(`${excelColumnLabel(index)} · ${header || `Колонка ${index + 1}`}`)}</option>`).join("")}</select></label><button class="button secondary" type="button" data-add-source-custom-field>Добавить поле</button></div>` : ""}`;
  container.querySelectorAll("select").forEach((select) => select.addEventListener("change", () => {
    if (select.value === "") delete state.mappings[role][select.dataset.mappingField];
    else state.mappings[role][select.dataset.mappingField] = Number(select.value);
    renderMapping(role);
    persistSourceMappingPreference(role).catch(showError);
  }));
  container.querySelector("[data-open-mapping-review]").addEventListener("click", () => openMappingReview(role));
  container.querySelector("[data-add-source-custom-field]")?.addEventListener("click", async () => {
    try {
      const { config, mapping } = createCustomSourceFieldMapping(
        state.inventoryColumnConfig,
        state.mappings[role],
        container.querySelector("[data-source-custom-label]").value,
        container.querySelector("[data-source-custom-column]").value,
        table.headers.length,
      );
      await saveInventoryColumnConfig(config, { rerender: false });
      state.mappings[role] = mapping;
      renderMapping(role);
      await persistSourceMappingPreference(role);
    } catch (error) {
      showError(error);
    }
  });
}

async function persistSourceMappingPreference(role) {
  const table = state.sourceTables[role];
  if (!table || !["main", "smartroom", "ddio"].includes(role)) return;
  const preference = rememberSourceMapping(table.headers, state.mappings[role]);
  if (!preference) return;
  state.sourceMappingPreferences[role] = upsertSourceMappingPreference(state.sourceMappingPreferences[role], preference);
  await database.setSetting("sourceMappingPreferences", state.sourceMappingPreferences);
}

function openMappingReview(role) {
  const isSingle = role === "single";
  const table = isSingle ? state.singleFile.table : state.sourceTables[role];
  if (!table) return;
  const dialog = $("#mappingReviewDialog");
  const report = detectMappingReport(table.headers, table.rows, role);
  let draft = { ...(isSingle ? state.singleFile.mapping : state.mappings[role]) || {} };
  const fields = isSingle ? SINGLE_FILE_FIELDS : ROLE_FIELDS[role];
  const supportsCustomFields = !isSingle && ["main", "smartroom", "ddio"].includes(role);
  const roleLabel = isSingle ? "Анализ одного файла" : { main: "Основной файл", smartroom: "SmartRoom", ddio: "DDIO" }[role];
  const sourceFile = isSingle ? state.singleFile.file : state.sourceFiles[role];
  const summary = $("#mappingReviewSummary");
  const content = $("#mappingReviewContent");
  const validation = $("#mappingReviewValidation");
  const apply = $("#mappingReviewApply");
  const render = () => {
    const customColumns = supportsCustomFields ? state.inventoryColumnConfig.columns.filter(({ custom }) => custom) : [];
    const mappingFields = [...fields, ...customColumns.map(({ key }) => key)];
    const conflicts = fields.filter((field) => report.details[field]?.conflict).length;
    summary.textContent = `${roleLabel} · ${sourceFile?.name || "файл"} · ${table.rowCount === null ? "потоковая обработка" : `${table.rowCount.toLocaleString("ru-RU")} строк`}. Проверка использует только локальный ограниченный образец.`
      + (conflicts ? ` Кандидатов для ручной проверки: ${conflicts}.` : " Явных конфликтов кандидатов нет.");
    content.innerHTML = `<div class="table-scroll"><table class="data-table mapping-review-table"><thead><tr><th>Поле</th><th>Рекомендация</th><th>Выбранная колонка</th><th>Примеры значений</th></tr></thead><tbody>${mappingFields.map((field) => {
      const customColumn = customColumns.find(({ key }) => key === field);
      const label = customColumn?.label || FIELD_LABELS[field] || field;
      const detail = report.details[field];
      const recommendedIndex = detail?.recommendedIndex;
      const recommended = customColumn ? "Выбирается вручную для пользовательского поля" : Number.isInteger(recommendedIndex)
        ? `${excelColumnLabel(recommendedIndex)} · ${text(table.headers[recommendedIndex]) || `Колонка ${recommendedIndex + 1}`} · ${detail.recommendedConfidence}%${detail.selectedIndex === recommendedIndex ? " · выбрано автоматически" : " · кандидат, не назначен"}`
        : "Нет уверенной рекомендации";
      const alternatives = detail?.alternatives?.filter((item) => item.index !== recommendedIndex).length
        ? ` · другие варианты: ${detail.alternatives.filter((item) => item.index !== recommendedIndex).map((item) => `${excelColumnLabel(item.index)} ${text(item.header)} (${item.score})`).join(", ")}`
        : "";
      const recommendedCandidate = detail?.alternatives?.find((item) => item.index === recommendedIndex);
      const examples = (recommendedCandidate?.examples || detail?.examples || []).slice(0, 3).map((value) => escapeHtml(value)).join(" · ") || "—";
      const conflict = detail?.conflict ? "<strong class=\"mapping-conflict\">Проверьте совпадающие варианты</strong>" : "";
      const reason = detail?.recommendedReason ? `<small class="mapping-reason">Причина: ${escapeHtml(detail.recommendedReason)}</small>` : "";
      const options = table.headers.map((header, index) => `<option value="${index}" ${Number(draft[field]) === index ? "selected" : ""}>${escapeHtml(`${excelColumnLabel(index)} · ${header || `Колонка ${index + 1}`}`)}</option>`).join("");
      return `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(recommended)}${escapeHtml(alternatives)}${reason}${conflict}</td><td><select data-review-field="${field}" aria-label="Колонка для поля ${escapeHtml(label)}"><option value="">Не использовать</option>${options}</select></td><td>${examples}</td></tr>`;
    }).join("")}</tbody></table></div>${supportsCustomFields && isEngineerActive() ? `<div class="toolbar mapping-custom-field"><label>Новое пользовательское поле<input id="mappingReviewCustomLabel" maxlength="60" autocomplete="off"></label><button class="button secondary" type="button" data-mapping-add-custom>Добавить поле</button></div>` : ""}`;
    content.querySelectorAll("[data-review-field]").forEach((select) => select.addEventListener("change", () => {
      const field = select.dataset.reviewField;
      if (select.value === "") delete draft[field];
      else draft[field] = Number(select.value);
      updateValidation();
    }));
    content.querySelector("[data-mapping-add-custom]")?.addEventListener("click", () => {
      const input = content.querySelector("#mappingReviewCustomLabel");
      try {
        const config = addCustomInventoryColumn(state.inventoryColumnConfig, input.value);
        config.columns.at(-1).visible = false;
        saveInventoryColumnConfig(config, { rerender: false }).then(() => {
          input.value = "";
          render();
        }).catch(showError);
      } catch (error) { showError(error); }
    });
    updateValidation();
  };
  const updateValidation = () => {
    const problems = isSingle
      ? [
        ...(["id", "deviceId", "serial", "mac", "mac2"].some((field) => Number.isInteger(draft[field])) ? [] : ["Выберите внутренний ID, Device ID, серийный номер или MAC"]),
        ...(new Set(Object.values(draft).filter(Number.isInteger)).size === Object.values(draft).filter(Number.isInteger).length ? [] : ["Одна колонка не может быть назначена нескольким полям"]),
      ]
      : batchMappingProblems(role, draft, { rowCount: table.rowCount, file: sourceFile || { name: roleLabel } });
    validation.textContent = problems.length ? problems.join(" · ") : "Сопоставление корректно и готово к применению.";
    validation.classList.toggle("error", problems.length > 0);
    validation.classList.toggle("success", problems.length === 0);
    apply.disabled = problems.length > 0;
  };
  $("#mappingReviewRecommendations").onclick = () => {
    const customMappings = Object.fromEntries(Object.entries(draft).filter(([field]) => /^custom_[0-9a-f-]{36}$/i.test(field)));
    const recommendations = mappingRecommendationsWithoutReservedColumns(report, Object.values(customMappings));
    draft = { ...recommendations, ...customMappings };
    render();
  };
  $("#mappingReviewClear").onclick = () => {
    draft = {};
    render();
  };
  $("#mappingReviewForm").onsubmit = (event) => {
    event.preventDefault();
    const problems = isSingle
      ? [
        ...(["id", "deviceId", "serial", "mac", "mac2"].some((field) => Number.isInteger(draft[field])) ? [] : ["Выберите внутренний ID, Device ID, серийный номер или MAC"]),
        ...(new Set(Object.values(draft).filter(Number.isInteger)).size === Object.values(draft).filter(Number.isInteger).length ? [] : ["Одна колонка не может быть назначена нескольким полям"]),
      ]
      : batchMappingProblems(role, draft, { rowCount: table.rowCount, file: sourceFile || { name: roleLabel } });
    if (problems.length) { updateValidation(); return; }
    if (isSingle) {
      state.singleFileController?.abort();
      state.singleFileController = null;
      state.singleFileRevision += 1;
      state.singleFile.mapping = { ...draft };
      state.singleFile.mappingReviewed = true;
      state.singleFile.result = null;
      $("#exportSingleCsvButton").disabled = true;
      renderSingleMapping();
    } else {
      state.mappings[role] = { ...draft };
      renderMapping(role);
      persistSourceMappingPreference(role).catch(showError);
    }
    dialog.close();
  };
  render();
  if (!dialog.open) dialog.showModal();
  content.querySelector("select")?.focus();
}

document.querySelectorAll("[data-mapping-review-close]").forEach((button) => button.addEventListener("click", () => {
  const dialog = $("#mappingReviewDialog");
  if (dialog.open) dialog.close();
}));

function renderSingleMapping() {
  const { table, mapping } = state.singleFile;
  const host = $("#singleMapping");
  if (!table) { host.innerHTML = ""; return; }
  const conflictReport = detectMappingReport(table.headers, table.rows, "single");
  const hasConflicts = hasSingleFileMappingConflicts(conflictReport);
  const reviewRequired = hasConflicts && !state.singleFile.mappingReviewed;
  const hasStrongIdentity = ["id", "deviceId", "serial", "mac", "mac2"].some((field) => Number.isInteger(mapping[field]));
  const conflictCount = SINGLE_FILE_FIELDS.filter((field) => conflictReport.details[field]?.conflict).length;
  const status = hasConflicts
    ? `Автоподбор нашёл неоднозначные варианты в ${conflictCount} полях.${reviewRequired ? " Перед анализом откройте проверку вариантов и примените сопоставление." : " Варианты проверены."}`
    : `${hasStrongIdentity ? "Выбрано поле сильной идентичности." : "Для анализа выберите внутренний ID, Device ID, серийный номер или MAC."} Рекомендации основаны на локальном ограниченном образце.`;
  host.innerHTML = `<p class="mapping-review">${escapeHtml(status)}</p><button class="button secondary mapping-review-open" type="button" data-open-single-mapping-review>Проверить варианты колонок</button>${SINGLE_FILE_FIELDS.map((field) => `<label><span>${escapeHtml(FIELD_LABELS[field] || field)}</span><select data-single-mapping-field="${field}"><option value="">Не использовать</option>${table.headers.map((header, index) => `<option value="${index}" ${Number(mapping[field]) === index ? "selected" : ""}>${escapeHtml(`${excelColumnLabel(index)} · ${header || `Колонка ${index + 1}`}`)}</option>`).join("")}</select></label>`).join("")}`;
  $("#runSingleAnalysisButton").disabled = !state.singleFile.file || reviewRequired;
  host.querySelector("[data-open-single-mapping-review]").addEventListener("click", () => openMappingReview("single"));
  host.querySelectorAll("[data-single-mapping-field]").forEach((select) => select.addEventListener("change", () => {
    state.singleFileController?.abort();
    state.singleFileController = null;
    state.singleFileRevision += 1;
    $("#runSingleAnalysisButton").disabled = !state.singleFile.file;
    const field = select.dataset.singleMappingField;
    if (select.value === "") delete state.singleFile.mapping[field];
    else state.singleFile.mapping[field] = Number(select.value);
    state.singleFile.mappingReviewed = false;
    state.singleFile.result = null;
    $("#exportSingleCsvButton").disabled = true;
    $("#exportSingleJsonButton").disabled = true;
    $("#singleAnalysisResult").classList.add("empty");
    $("#singleAnalysisResult").textContent = "Сопоставление изменено. Запустите анализ повторно.";
    renderSingleMapping();
  }));
}

async function handleSingleFile(file, requestedSheet = "") {
  if (!file) return;
  state.singleFileController?.abort();
  state.singleFileController = null;
  const revision = ++state.singleFileRevision;
  clearError();
  progress(5, `Чтение ${file.name}`, "Анализ одного файла");
  let sheets;
  let sheetName;
  let table;
  try {
    sheets = await listXlsxSheets(file);
    if (revision !== state.singleFileRevision) return;
    sheetName = requestedSheet && sheets.includes(requestedSheet) ? requestedSheet : sheets[0] || "";
    table = isStreamableTableFile(file)
      ? await readTablePreview(file, { maxRows: 100, sheetName })
      : await readTable(file, { sheetName });
    if (revision !== state.singleFileRevision) return;
  } catch (error) {
    if (revision !== state.singleFileRevision) return;
    throw error;
  }
  state.singleFile = { file, table, mapping: detectSingleFileMapping(table.headers, table.rows), mappingReviewed: false, result: null, sheets, sheetName };
  const sheetPicker = $("#singleSheetPicker");
  sheetPicker.hidden = sheets.length < 2;
  $("#singleSheetSelect").innerHTML = sheets.map((name) => `<option value="${escapeHtml(name)}" ${name === sheetName ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
  const rowSummary = table.preview ? `предпросмотр ${table.rows.length.toLocaleString("ru-RU")} строк; полный файл анализируется пакетами` : `${table.rowCount.toLocaleString("ru-RU")} строк`;
  $("#singleFileStatus").textContent = `${file.name}${sheetName ? ` · ${sheetName}` : ""} · ${rowSummary}`;
  $("#runSingleAnalysisButton").disabled = false;
  $("#exportSingleCsvButton").disabled = true;
  $("#exportSingleJsonButton").disabled = true;
  $("#singleAnalysisResult").classList.add("empty");
  $("#singleAnalysisResult").textContent = "Проверьте колонки и запустите анализ.";
  renderSingleMapping();
  finishProgress("Файл прочитан");
}

async function exportSingleAnalysisCsv() {
  const result = state.singleFile.result;
  if (!result) throw new Error("Сначала запустите анализ");
  const filename = "single-file-analysis.csv";
  const mime = "text/csv;charset=utf-8";
  let pickerPromise;
  if (typeof globalThis.showSaveFilePicker === "function") pickerPromise = globalThis.showSaveFilePicker({
    suggestedName: filename,
    types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
  });
  const chunks = result.singleAnalysisId
    ? singleFileDevicesCsvBatchChunks(database.singleAnalysisDeviceChunks(result.singleAnalysisId))
    : singleFileDevicesCsvChunks(result.devices);
  if (pickerPromise) {
    const handle = await pickerPromise;
    await writeReadableStreamToWritable(
      readableTextStreamFromIterable(chunks),
      await handle.createWritable(),
    );
    return;
  }
  const stream = readableTextStreamFromIterable(chunks);
  const blob = await new globalThis.Response(stream, { headers: { "Content-Type": mime } }).blob();
  download(filename, blob, mime);
}

async function* singleAnalysisDevices(analysisId) {
  for await (const batch of database.singleAnalysisDeviceChunks(analysisId)) {
    for (const device of batch) yield singleFileDeviceJson(device);
  }
}

function* currentSingleAnalysisDevices(result) {
  for (const device of result?.devices || []) yield singleFileDeviceJson(device);
}

function singleAnalysisJsonPayload(result) {
  const devices = result?.singleAnalysisId ? singleAnalysisDevices(result.singleAnalysisId) : currentSingleAnalysisDevices(result);
  return {
    ...result,
    preview: Array.isArray(result?.preview) ? result.preview.map(singleFileDeviceJson) : result?.preview,
    devices: streamJsonArray(devices),
  };
}

function renderSingleAnalysis(result) {
  const { summary } = result;
  const counts = [
    ["Строк", summary.rows], ["Уникальных устройств", summary.valid], ["Уникальных MAC", summary.uniqueMacs],
    ["Ошибки идентификации", summary.invalid], ["Некорректные MAC", summary.invalidMacs || 0], ["Неоднозначные строки", summary.ambiguous], ["Конфликты идентификаторов", summary.identityConflicts || 0], ["Объединено повторов", summary.duplicateRows],
    ["С производителем", summary.withManufacturer], ["С моделью", summary.withModel], ["С помещением", summary.withRoom], ["С адресом", summary.withAddress],
  ];
  const ranking = (title, rows) => `<section><h3>${title}</h3>${rows.length ? `<ol>${rows.map((item) => `<li>${escapeHtml(item.label)} — ${item.value.toLocaleString("ru-RU")}</li>`).join("")}</ol>` : '<p class="muted">Нет данных</p>'}</section>`;
  const columns = [["mac", "MAC"], ["manufacturer", "Производитель"], ["model", "Модель"], ["ip", "IP"], ["switchIp", "IP коммутатора"], ["room", "Помещение"], ["address", "Адрес"], ["sourceRows", "Строки"]];
  const shown = result.preview.map((device) => ({ ...device, sourceRows: formatSingleFileSourceRows(device) }));
  const invalid = result.invalidPreview;
  const invalidMacs = result.invalidMacPreview || [];
  const ambiguous = result.ambiguousPreview;
  const identityConflicts = result.identityConflictPreview || [];
  const ambiguousHtml = ambiguous.length
    ? `<h3>Неоднозначные строки · показаны первые ${ambiguous.length} из ${summary.ambiguous}</h3><ul>${ambiguous.map((item) => {
      return `<li><strong>Строка ${item.row}</strong><p class="muted">Соответствие не выбрано. Сравните исходные данные с кандидатами.</p>${identityCandidateComparisonMarkup(item.device, item.candidates, { incomingLabel: "Строка файла" }) || "Кандидаты не найдены"}</li>`;
    }).join("")}</ul>`
    : '<p class="muted">Неоднозначных соответствий нет.</p>';
  const identityConflictHtml = identityConflicts.length
    ? `<h3>Конфликты сильных идентификаторов · показаны первые ${identityConflicts.length} из ${summary.identityConflicts}</h3><div class="table-scroll"><table class="data-table"><thead><tr><th>Строка</th><th>Выбранный идентификатор</th><th>Конфликтующее соответствие</th></tr></thead><tbody>${identityConflicts.map((item) => `<tr><td>${item.row}</td><td>${escapeHtml(item.selected)}</td><td>${escapeHtml(item.alternative)}</td></tr>`).join("")}</tbody></table></div>`
    : '<p class="muted">Конфликтующих соответствий нет.</p>';
  $("#singleAnalysisResult").classList.remove("empty");
  $("#singleAnalysisResult").innerHTML = `<div class="kpi-grid">${counts.map(([label, value]) => `<article class="kpi"><span>${label}</span><strong>${Number(value).toLocaleString("ru-RU")}</strong></article>`).join("")}</div><div class="analytics-grid">${ranking("Производители", summary.manufacturers)}${ranking("Модели", summary.models)}${ranking("Помещения", summary.rooms)}</div><h3>Распознанные устройства · показаны первые ${shown.length} из ${summary.valid}</h3>${shown.length ? `<div class="table-scroll"><table class="data-table"><thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${shown.map((device) => `<tr>${columns.map(([field]) => `<td>${escapeHtml(Array.isArray(device[field]) ? device[field].join(", ") : device[field] || "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : '<p class="empty">Устройства с сильным идентификатором не найдены.</p>'}<h3>Строки без сильного идентификатора · показаны первые ${invalid.length} из ${summary.invalid}</h3>${invalid.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Строка</th><th>Исходный MAC</th><th>Причина</th><th>Рекомендация</th><th>Данные</th></tr></thead><tbody>${invalid.map((item) => `<tr><td>${item.row}</td><td>${escapeHtml(item.rawMac || "—")}</td><td>${escapeHtml(item.reason)}</td><td>${escapeHtml(item.recommendation)}</td><td>${escapeHtml(item.values.join(" · "))}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">Ошибок идентификации нет.</p>'}${invalidMacs.length ? `<h3>Некорректные MAC · первые ${invalidMacs.length} из ${summary.invalidMacs}</h3><div class="table-scroll"><table class="data-table"><thead><tr><th>Строка</th><th>Исходное значение</th><th>Причина</th><th>Рекомендация</th></tr></thead><tbody>${invalidMacs.map((item) => `<tr><td>${item.row}</td><td>${escapeHtml(item.value)}</td><td>${escapeHtml(item.reason)}</td><td>${escapeHtml(item.recommendation)}</td></tr>`).join("")}</tbody></table></div>` : ""}${ambiguousHtml}${identityConflictHtml}`;
}

async function renderSingleAnalysisHistory() {
  const history = state.singleAnalysisHistory;
  const result = await database.listSingleAnalyses({ query: history.query, page: history.page, limit: 25 });
  history.result = result;
  history.page = result.page;
  $("#singleAnalysisHistoryRows").innerHTML = result.rows.length
    ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Время</th><th>Файл</th><th>Устройств</th><th>Ошибок</th><th>Действия</th></tr></thead><tbody>${result.rows.map((item) => `<tr><td>${escapeHtml(new Date(item.processedAt).toLocaleString("ru-RU"))}</td><td>${escapeHtml(item.filename)}${item.sheetName ? `<br><span class="muted">${escapeHtml(item.sheetName)}</span>` : ""}</td><td>${Number(item.deviceCount).toLocaleString("ru-RU")}</td><td>${Number(item.diagnosticCounts.invalid + item.diagnosticCounts.invalidMacs + item.diagnosticCounts.ambiguous + item.diagnosticCounts.identityConflicts).toLocaleString("ru-RU")}</td><td><button class="button secondary" type="button" data-single-analysis-open="${escapeHtml(item.id)}">Открыть</button> <button class="button secondary" type="button" data-single-analysis-delete="${escapeHtml(item.id)}">Удалить</button></td></tr>`).join("")}</tbody></table></div>`
    : '<p class="empty">Сохранённых анализов не найдено.</p>';
  $("#singleAnalysisHistoryPageLabel").textContent = `${result.total.toLocaleString("ru-RU")} результатов · страница ${result.page} из ${result.pageCount}`;
  $("#previousSingleAnalysisHistoryPage").disabled = !result.hasPrevious;
  $("#nextSingleAnalysisHistoryPage").disabled = !result.hasNext;
}

async function openSingleAnalysisHistory(id) {
  const saved = await database.loadSingleAnalysis(id, { previewOnly: true });
  if (!saved) throw new Error("Сохранённый анализ больше не найден");
  state.singleFile = { file: null, table: null, mapping: saved.mapping, result: saved.result, sheets: [], sheetName: saved.sheetName };
  $("#singleFileStatus").textContent = `${saved.filename}${saved.sheetName ? ` · ${saved.sheetName}` : ""} · сохранён ${new Date(saved.processedAt).toLocaleString("ru-RU")}`;
  $("#singleSheetPicker").hidden = true;
  $("#singleMapping").replaceChildren();
  $("#runSingleAnalysisButton").disabled = true;
  $("#exportSingleCsvButton").disabled = false;
  $("#exportSingleJsonButton").disabled = false;
  $("#singleAnalysisPersistenceStatus").textContent = "Открыт ранее сохранённый локальный анализ. Его можно просмотреть и экспортировать.";
  renderSingleAnalysis(saved.result);
}

async function deleteSingleAnalysisHistory(id) {
  if (!globalThis.confirm("Удалить сохранённый анализ и все его блоки данных?")) return;
  await database.deleteSingleAnalysis(id);
  await renderSingleAnalysisHistory();
}

async function enrichStandaloneDevices(devices, signal, { progressStart = 55, progressEnd = 90 } = {}) {
  const activeSnapshotId = await database.getSetting("activeSnapshotId", "");
  const vendorDetectorSettings = normalizeVendorDetectorSettings(await database.getSetting("vendorDetectorSettings", DEFAULT_VENDOR_DETECTOR_SETTINGS));
  const historyEnrichmentSettings = normalizeHistoryEnrichmentSettings(await database.getSetting(
    "historyEnrichmentSettings", await database.getSetting("legacyAppSetting:historyEnrichment", DEFAULT_HISTORY_ENRICHMENT_SETTINGS),
  ));
  const ipEnrichmentSettings = normalizeIpEnrichmentSettings(await database.getSetting("ipEnrichmentSettings", DEFAULT_IP_ENRICHMENT_SETTINGS));
  const ipAddressMappings = ipEnrichmentSettings.enabled ? await database.ipAddressMappings() : [];
  const enrichmentFieldSettings = normalizeEnrichmentFieldSettings(await database.getSetting("enrichmentFieldSettings", DEFAULT_ENRICHMENT_FIELD_SETTINGS));
  const bundledOuiIndex = await loadBundledIeeeIndex();
  const result = await enrich({
    mainDevices: devices,
    ...(activeSnapshotId ? { loadPreviousIdentityIndex: (currentDevices) => database.buildPreviousFinalIdentityIndex(activeSnapshotId, currentDevices) } : {}),
    loadOuiIndex: async (macs) => vendorDetectorSettings.enabled && vendorDetectorSettings.useOui3
      ? createOuiIndexOverlay(bundledOuiIndex, await database.ouiIndexForMacs(macs))
      : new Map(),
    loadKnownModels: (macs) => database.knownModelsForMacs(macs),
    loadMac5Models: (macs) => database.mac5ModelsForMacs(macs),
    loadLegacyVendorModelSuggestions: (macs) => database.legacyVendorModelSuggestionsForMacs(macs, {
      useMac5Match: historyEnrichmentSettings.useMac5Match,
      useOuiMatch: historyEnrichmentSettings.useOuiMatch,
    }),
    loadHistoricalAddressIndex: async (ips) => {
      const accumulator = createHistoricalAddressAccumulator();
      await database.forEachSwitchAddressEvidenceForIps(ips, (record) => accumulator.add(record));
      return accumulator.finish();
    },
    retainHistoricalAddressIndex: false,
    loadHistoricalRoomIndex: async (ids) => buildSmartroomRoomIndex(await database.smartroomRoomMappingsForIds(ids)),
    loadImportedSmartroomRoomIndex: async (ids) => buildImportedSmartroomRoomIndex(await database.legacySmartroomRoomMappingsForIds(ids)),
    ipAddressMappings,
    ipEnrichmentSettings,
    vendorDetectorSettings,
    historyEnrichmentSettings,
    enrichmentFieldSettings,
    signal,
    onProgress: (value, stage) => progress(progressStart + value * (progressEnd - progressStart) / 100, stage, "Обогащение одного файла"),
  });
  return result;
}

async function runSingleFileAnalysis() {
  clearError();
  const { table, file, mapping } = state.singleFile;
  if (!table || !file) throw new Error("Сначала выберите файл");
  const report = detectMappingReport(table.headers, table.rows, "single");
  if (hasSingleFileMappingConflicts(report) && !state.singleFile.mappingReviewed) {
    renderSingleMapping();
    throw new Error("Сначала проверьте неоднозначные варианты колонок и примените сопоставление");
  }
  const startedAt = performance.now();
  const revision = state.singleFileRevision;
  const controller = new AbortController();
  state.singleFileController?.abort();
  state.singleFileController = controller;
  $("#runSingleAnalysisButton").disabled = true;
  try {
    await runSingleFileAnalysisTask({ table, file, mapping, startedAt, revision, controller });
  } catch (error) {
    if (controller.signal.aborted && error?.name === "AbortError") {
      if (revision === state.singleFileRevision) finishProgress("Анализ отменён");
      return;
    }
    throw error;
  } finally {
    if (state.singleFileController === controller) state.singleFileController = null;
    if (revision === state.singleFileRevision) $("#runSingleAnalysisButton").disabled = !state.singleFile.file;
  }
}

async function runSingleFileAnalysisTask({ table, file, mapping, startedAt, revision, controller }) {
  progress(1, `Подготовка ${file.name}`, "Анализ одного файла");
  assertSourceFileCapacity(file);
  assertBrowserHeapCapacity(estimateSha256WorkingSetBytes([file]) * 2);
  const sourceDigest = await sha256File(file, {
    signal: controller.signal,
    onProgress: ({ bytesRead, totalBytes }) => progress(totalBytes ? bytesRead / totalBytes * 4 : 4, `Проверка исходного файла: ${bytesRead.toLocaleString("ru-RU")} / ${totalBytes.toLocaleString("ru-RU")} байт`, "Анализ одного файла"),
  });
  let result;
  let stagedDeviceStore = null;
  if (table.preview && isStreamableTableFile(file)) {
    const stageId = `final-device-stage:${Date.now()}:${crypto.randomUUID()}`;
    stagedDeviceStore = createSingleAnalysisDeviceStageStore(stageId);
    try {
      result = await analyzeSingleFileBatchesIntoStore(table.headers, readTableRowBatches(file, {
        sheetName: state.singleFile.sheetName,
        batchSize: 500,
        signal: controller.signal,
      }), {
        mapping,
        source: file.name,
        deviceStore: stagedDeviceStore,
        signal: controller.signal,
        onProgress: ({ rowsRead }) => {
          if (revision !== state.singleFileRevision) return;
          progress(Math.min(40, 2 + rowsRead / 1_000), `Обработано ${rowsRead.toLocaleString("ru-RU")} строк`, "Анализ одного файла");
        },
      });
      if (revision !== state.singleFileRevision) {
        await database.clearAnalyticsAggregateQuery(stageId).catch(() => {});
        return;
      }
      if (stagedDeviceStore.count) {
        const enriched = await enrichStandaloneDevices(stagedDeviceStore, controller.signal, { progressStart: 40, progressEnd: 58 });
        if (revision !== state.singleFileRevision) {
          await database.clearAnalyticsAggregateQuery(stageId).catch(() => {});
          return;
        }
        if (controller.signal.aborted) throw new DOMException("Операция отменена", "AbortError");
        result.enrichmentDiagnostics = enriched.diagnostics;
        result.devices = await stagedDeviceStore.readPage(0, 20);
      } else result.enrichmentDiagnostics = { counts: {} };
      result.summary = await completeSingleFileStageSummary(stagedDeviceStore, result.summary, {
        signal: controller.signal,
        onProgress: (done) => progress(58 + done / Math.max(1, stagedDeviceStore.count) * 8, `Сводка: ${done.toLocaleString("ru-RU")} / ${stagedDeviceStore.count.toLocaleString("ru-RU")} устройств`, "Анализ одного файла"),
      });
    } catch (error) {
      await database.clearAnalyticsAggregateQuery(stageId).catch(() => {});
      throw error;
    }
    if (!stagedDeviceStore?.count) await database.clearAnalyticsAggregateQuery(stageId);
  } else {
    result = analyzeSingleFile(table, { mapping, source: file.name });
    if (revision !== state.singleFileRevision) return;
    if (controller.signal.aborted) throw new DOMException("Операция отменена", "AbortError");
    if (result.devices.length) {
      progress(30, "Проверка и обогащение устройств", "Анализ одного файла");
      const enriched = await enrichStandaloneDevices(result.devices, controller.signal, { progressStart: 30, progressEnd: 75 });
      if (revision !== state.singleFileRevision) return;
      if (controller.signal.aborted) throw new DOMException("Операция отменена", "AbortError");
      result.devices = enriched.devices;
      result.enrichmentDiagnostics = enriched.diagnostics;
      Object.assign(result.summary, countSingleFileDeviceFields(result.devices));
    }
  }
  result.preview = result.devices.slice(0, 20).map((device) => ({ ...device, sourceRows: formatSingleFileSourceRows(device) }));
  state.singleFileController = null;
  state.singleFile.result = result;
  const processedAt = new Date().toISOString();
  renderSingleAnalysis(result);
  $("#exportSingleCsvButton").disabled = Boolean(stagedDeviceStore?.count);
  $("#exportSingleJsonButton").disabled = Boolean(stagedDeviceStore?.count);
  $("#runSingleAnalysisButton").disabled = false;
  $("#singleAnalysisPersistenceStatus").textContent = "Сохраняю результат в локальную историю анализов…";
  let stagedHistoryPlanId = "";
  try {
    const observationDate = fileObservationDate(file, table.workbookCreatedAt, table.workbookModifiedAt);
    const createdAt = observationDate.date || processedAt;
    const sourceKey = buildSourceKey({
      strategy: "NO_EXPANSION",
      files: { main: file },
      mappings: { main: mapping, smartroom: {}, ddio: {} },
      sourceDigests: { main: sourceDigest },
    });
    const stagedComparison = stagedDeviceStore?.count
      ? await prepareStagedInventoryComparison(stagedDeviceStore, createdAt, {
        signal: controller.signal,
        onProgress: (done) => progress(66 + done / Math.max(1, stagedDeviceStore.count) * 8, `Сравнение с Inventory: ${done.toLocaleString("ru-RU")} / ${stagedDeviceStore.count.toLocaleString("ru-RU")} устройств`, "Анализ одного файла"),
      }) : null;
    stagedHistoryPlanId = stagedComparison?.historyPlanId || "";
    if (stagedComparison) {
      result.devices = await stagedDeviceStore.readPage(0, 20);
      result.preview = result.devices.map((device) => ({ ...device, sourceRows: formatSingleFileSourceRows(device) }));
      state.singleFile.result = result;
      renderSingleAnalysis(result);
    }
    const comparison = stagedComparison ? null : await compareInventoryObservationFromDatabase(result.devices, createdAt);
    const savedAnalysis = await database.saveSingleAnalysis({ filename: file.name, sheetName: state.singleFile.sheetName, result, deviceStore: stagedDeviceStore?.count ? stagedDeviceStore : null, processedAt,
      onProgress: ({ completed, total, phase }) => progress(75 + (total ? completed / total : phase === "complete" ? 1 : 0) * 7, `Сохранение анализа: ${(completed || 0).toLocaleString("ru-RU")} / ${(total || 0).toLocaleString("ru-RU")} устройств`, "Анализ одного файла"),
    });
    const previewDevices = result.devices.slice(0, 20);
    let finalSnapshot;
    try {
      finalSnapshot = await database.saveFinal({
        name: `Single file: ${file.name}`,
        snapshotType: SINGLE_ANALYSIS_SNAPSHOT_TYPE,
        sourceKey,
        createdAt,
        processingTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(stagedDeviceStore?.count ? {
          stagedDeviceQueryId: stagedDeviceStore.queryId,
          stagedDeviceCount: stagedDeviceStore.count,
          historyPlanId: stagedComparison.historyPlanId,
          historyPlanEventCount: stagedComparison.historyPlanEventCount,
        } : { devices: result.devices, comparison }),
        diagnostics: {
          ...result.enrichmentDiagnostics,
          singleFile: result.diagnostics,
          ...(stagedComparison ? { historyComparison: stagedComparison.historyComparison } : {}),
        },
        sourceFiles: [{ role: "main", name: file.name, size: file.size, lastModified: file.lastModified || 0, date: fileObservationDate(file, table.workbookCreatedAt, table.workbookModifiedAt) }],
        originalFiles: [{ role: "main", file }],
        activate: false,
        updateInventory: true,
        consumeDevices: true,
        onProgress: ({ phase, completedDevices = 0, totalDevices = 0, completed = 0, total = 0 }) => {
          if (phase === "history") progress(82 + (total ? completed / total : 1) * 4, `История: ${completed.toLocaleString("ru-RU")} / ${total.toLocaleString("ru-RU")} событий`, "Анализ одного файла");
          else if (phase === "chunk" || phase === "complete") progress(86 + (totalDevices ? completedDevices / totalDevices : 1) * 13, `Сохранение Final: ${completedDevices.toLocaleString("ru-RU")} / ${totalDevices.toLocaleString("ru-RU")} устройств`, "Анализ одного файла");
        },
      });
    } catch (error) {
      await database.deleteSingleAnalysis(savedAnalysis.id).catch(() => {});
      throw error;
    } finally {
      if (stagedComparison?.historyPlanId) await database.clearAnalyticsAggregateQuery(stagedComparison.historyPlanId).catch(() => {});
    }
    result.finalSnapshotId = finalSnapshot.id;
    result.singleAnalysisId = savedAnalysis.id;
    result.devices = previewDevices;
    $("#exportSingleCsvButton").disabled = false;
    $("#exportSingleJsonButton").disabled = false;
    if (stagedDeviceStore?.count) await database.clearAnalyticsAggregateQuery(stagedDeviceStore.queryId);
    await database.attachSingleAnalysisSnapshot(savedAnalysis.id, finalSnapshot.id);
    state.singleFile.result = result;
    $("#singleAnalysisPersistenceStatus").textContent = `Снимок одиночного анализа сохранён в локальную историю: ${finalSnapshot.name}${finalSnapshot.reused ? " · набор уже был сохранён" : ""}.`;
    recordLocalNotification("analysis", "Анализ одного файла завершён", `Обработано устройств: ${finalSnapshot.deviceCount.toLocaleString("ru-RU")}.`, "success").catch(showError);
    state.analytics = null;
    await refreshDatabaseState();
    if (!$("#singleAnalysisHistory").hidden) {
      state.singleAnalysisHistory.page = 1;
      await renderSingleAnalysisHistory();
    }
  } catch (error) {
    if (stagedHistoryPlanId) await database.clearAnalyticsAggregateQuery(stagedHistoryPlanId).catch(() => {});
    if (stagedDeviceStore?.count) await database.clearAnalyticsAggregateQuery(stagedDeviceStore.queryId).catch(() => {});
    $("#singleAnalysisPersistenceStatus").textContent = `Результат показан, но не сохранён в истории: ${error.message}`;
  }
  finishProgress("Анализ завершён");
}

function renderFileCompareMapping(position) {
  const table = state.fileCompare.tables[position];
  const mapping = state.fileCompare.mappings[position];
  const host = $(`#compareFile${position}Mapping`);
  if (!table) { host.innerHTML = ""; return; }
  host.innerHTML = SINGLE_FILE_FIELDS.map((field) => `<label><span>${escapeHtml(FIELD_LABELS[field] || field)}</span><select data-compare-position="${position}" data-compare-field="${field}"><option value="">Не использовать</option>${table.headers.map((header, index) => `<option value="${index}" ${Number(mapping[field]) === index ? "selected" : ""}>${escapeHtml(`${excelColumnLabel(index)} · ${header || `Колонка ${index + 1}`}`)}</option>`).join("")}</select></label>`).join("");
  host.querySelectorAll("[data-compare-field]").forEach((select) => select.addEventListener("change", () => {
    state.fileCompare.controller?.abort();
    state.fileCompare.controller = null;
    state.fileCompare.revision += 1;
    clearFileCompareResult().catch(showError);
    $("#runFileCompareButton").disabled = !state.fileCompare.tables.every(Boolean);
    const field = select.dataset.compareField;
    if (select.value === "") delete state.fileCompare.mappings[position][field];
    else state.fileCompare.mappings[position][field] = Number(select.value);
    state.fileCompare.result = null;
    state.fileCompare.page = 1;
    state.fileCompare.ambiguousPage = 1;
    $("#exportFileCompareCsvButton").disabled = true;
    $("#exportFileCompareJsonButton").disabled = true;
    $("#exportFileCompareXlsxButton").disabled = true;
    $("#exportFileCompareTxtButton").disabled = true;
    $("#fileCompareResult").classList.add("empty");
    $("#fileCompareResult").textContent = "Сопоставление изменено. Запустите сравнение повторно.";
  }));
}

async function handleCompareFile(position, file) {
  if (!file) return;
  state.fileCompare.controller?.abort();
  state.fileCompare.controller = null;
  const revision = ++state.fileCompare.revision;
  clearError();
  await clearFileCompareResult();
  if (revision !== state.fileCompare.revision) return;
  progress(4, `Чтение ${file.name}`, "Сравнение двух файлов");
  const table = isStreamableTableFile(file)
    ? await readTablePreview(file, { maxRows: 100 })
    : await readTable(file);
  state.fileCompare.files[position] = file;
  state.fileCompare.tables[position] = table;
  state.fileCompare.mappings[position] = detectSingleFileMapping(table.headers, table.rows);
  state.fileCompare.result = null;
  state.fileCompare.page = 1;
  state.fileCompare.ambiguousPage = 1;
  const rowSummary = table.preview ? `предпросмотр ${table.rows.length.toLocaleString("ru-RU")} строк; полный файл обрабатывается пакетами` : `${table.rowCount.toLocaleString("ru-RU")} строк`;
  $(`#compareFile${position}Status`).textContent = `${file.name} · ${rowSummary}`;
  $(`#compareFile${position}Mapping`).dataset.ready = "true";
  renderFileCompareMapping(position);
  $("#runFileCompareButton").disabled = !state.fileCompare.tables.every(Boolean);
  $("#exportFileCompareCsvButton").disabled = true;
  $("#exportFileCompareJsonButton").disabled = true;
  $("#exportFileCompareXlsxButton").disabled = true;
  $("#exportFileCompareTxtButton").disabled = true;
  $("#fileCompareResult").classList.add("empty");
  $("#fileCompareResult").textContent = "Проверьте оба сопоставления колонок и запустите сравнение.";
  finishProgress("Файл прочитан");
}

async function analyzeFileCompareInputIntoStage(position, { controller, stageStart = 0 } = {}) {
  const { files, tables, mappings } = state.fileCompare;
  const file = files[position];
  const table = tables[position];
  if (!file || !table) throw new Error("Выберите оба файла для сравнения");
  if (!isStreamableTableFile(file)) throw new Error(`Формат ${file.name} нельзя безопасно сравнить пакетами`);
  const preview = table.preview ? table : await readTablePreview(file, { maxRows: 100 });
  const stageId = `final-device-stage:${Date.now()}:${crypto.randomUUID()}`;
  const deviceStore = createSingleAnalysisDeviceStageStore(stageId);
  try {
    const result = await analyzeSingleFileBatchesIntoStore(preview.headers, readTableRowBatches(file, {
      sheetName: preview.sheet || "",
      batchSize: 500,
      signal: controller?.signal,
      onProgress: ({ rowsRead }) => progress(Math.min(stageStart + 44, stageStart + rowsRead / 1_000),
        `${file.name}: обработано ${rowsRead.toLocaleString("ru-RU")} строк`, "Сравнение двух файлов"),
    }), {
      mapping: mappings[position], source: file.name, deviceStore, signal: controller?.signal,
      retainSourceRows: false, retainDiagnosticSamples: false, compactDevices: true,
    });
    return {
      fileName: file.name,
      summary: result.summary,
      devices: result.devices,
      diagnostics: result.diagnostics,
      deviceStore,
      stageId,
    };
  } catch (error) {
    await database.clearAnalyticsAggregateQuery(stageId).catch(() => {});
    throw error;
  }
}

async function clearFileCompareResult() {
  const result = state.fileCompare.result;
  state.fileCompare.result = null;
  result?.comparisonPlan?.clear?.();
  await result?.cleanup?.();
}

async function runFileCompare() {
  clearError();
  const { tables } = state.fileCompare;
  if (!tables.every(Boolean)) throw new Error("Выберите оба файла для сравнения");
  assertFilePairCapacity(state.fileCompare.files);
  const revision = state.fileCompare.revision;
  const controller = new AbortController();
  state.fileCompare.controller?.abort();
  state.fileCompare.controller = controller;
  $("#runFileCompareButton").disabled = true;
  const staged = [];
  let comparisonPlan = null;
  let retained = false;
  try {
    await clearFileCompareResult();
    const before = await analyzeFileCompareInputIntoStage(0, { controller, stageStart: 2 });
    staged.push(before);
    if (revision !== state.fileCompare.revision) return;
    if (controller.signal.aborted) throw new DOMException("Операция отменена", "AbortError");
    const after = await analyzeFileCompareInputIntoStage(1, { controller, stageStart: 50 });
    staged.push(after);
    if (revision !== state.fileCompare.revision) return;
    if (controller.signal.aborted) throw new DOMException("Операция отменена", "AbortError");
    comparisonPlan = await createStagedMultiFileComparisonPlan(before.deviceStore, after.deviceStore, new Date().toISOString(), { all: true }, { signal: controller.signal });
    if (revision !== state.fileCompare.revision) return;
    const analysis = {
      before, after, comparison: comparisonPlan, comparisonPlan,
      cleanup: async () => Promise.all(staged.map(({ stageId }) => database.clearAnalyticsAggregateQuery(stageId).catch(() => {}))),
    };
    state.fileCompare.result = analysis;
    retained = true;
    state.fileCompare.page = 1;
    state.fileCompare.ambiguousPage = 1;
    await renderFileCompareResult(analysis);
    $("#exportFileCompareCsvButton").disabled = false;
    $("#exportFileCompareJsonButton").disabled = false;
    $("#exportFileCompareXlsxButton").disabled = false;
    $("#exportFileCompareTxtButton").disabled = false;
    finishProgress("Сравнение завершено");
  } catch (error) {
    if (controller.signal.aborted && error?.name === "AbortError") {
      if (revision === state.fileCompare.revision) finishProgress("Сравнение отменено");
      return;
    }
    throw error;
  } finally {
    if (!retained) {
      comparisonPlan?.clear?.();
      await Promise.all(staged.map(({ stageId }) => database.clearAnalyticsAggregateQuery(stageId).catch(() => {})));
    }
    if (state.fileCompare.controller === controller) state.fileCompare.controller = null;
    if (revision === state.fileCompare.revision) $("#runFileCompareButton").disabled = !state.fileCompare.tables.every(Boolean);
  }
}

const FILE_COMPARE_PAGE_SIZES = [25, 50, 100, 250, 500, 1_000];

function fileComparisonPageControls(section, page, total, pageSize) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(page * pageSize, total);
  if (pages < 2) return `<p class="muted">Показано ${start}–${end} из ${total.toLocaleString("ru-RU")}</p>`;
  return `<div class="button-row"><button class="button secondary" type="button" data-file-comparison-page="${section}" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>Назад</button><span class="muted">Показано ${start.toLocaleString("ru-RU")}–${end.toLocaleString("ru-RU")} из ${total.toLocaleString("ru-RU")} · страница ${page} из ${pages}</span><button class="button secondary" type="button" data-file-comparison-page="${section}" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>Дальше</button></div>`;
}

function requireFileComparisonPlan(analysis) {
  if (typeof analysis?.comparisonPlan?.eventsPage !== "function") throw new Error("План сравнения недоступен. Выполните сравнение файлов повторно");
  return analysis.comparisonPlan;
}

async function renderFileCompareResult(analysis) {
  const { before, after, comparison: result } = analysis;
  const files = state.fileCompare.files;
  const summary = [["Добавлено", result.addedCount ?? result.added.length], ["Отсутствует", result.absentCount ?? result.absent.length], ["Изменено", result.modifiedDeviceCount ?? result.modified.length], ["Без изменений", result.unchangedCount ?? result.unchanged.length], ["Неоднозначно", result.ambiguousCount ?? result.ambiguous.length]];
  const columns = fileComparisonColumns(state.ouiFormats);
  const pageSize = FILE_COMPARE_PAGE_SIZES.includes(state.fileCompare.pageSize) ? state.fileCompare.pageSize : 100;
  state.fileCompare.pageSize = pageSize;
  const pageRequests = [
    { key: "changed", statuses: ["Добавлено", "Отсутствует", "Изменено"], offset: (state.fileCompare.page - 1) * pageSize, limit: pageSize },
    { key: "ambiguous", statuses: ["Неоднозначно"], offset: (state.fileCompare.ambiguousPage - 1) * pageSize, limit: pageSize },
  ];
  const pages = await fileComparisonRowsPagesFromPlan(requireFileComparisonPlan(analysis), pageRequests, { ouiFormats: state.ouiFormats });
  if (state.fileCompare.result !== analysis) return;
  const changedPage = pages.changed;
  const pageSizeOptions = FILE_COMPARE_PAGE_SIZES.map((size) => `<option value="${size}" ${pageSize === size ? "selected" : ""}>${size.toLocaleString("ru-RU")}</option>`).join("");
  const pageSizeControl = `<label class="file-comparison-page-size">Строк на странице<select data-file-comparison-page-size>${pageSizeOptions}</select></label>`;
  const tableHtml = changedPage.total ? `<div class="table-scroll"><table class="data-table"><thead><tr>${columns.map(({ label }) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${changedPage.rows.map((row) => `<tr>${columns.map(({ key }) => `<td>${escapeHtml(row[key] || "—")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${fileComparisonPageControls("changed", state.fileCompare.page, changedPage.total, pageSize)}` : '<p class="muted">Подтверждённых изменений нет.</p>';
  const ambiguousPage = pages.ambiguous;
  const ambiguousHtml = ambiguousPage.total ? `<h3>Неоднозначные соответствия</h3><ul>${ambiguousPage.rows.map((row) => `<li>${escapeHtml(row.mac || row.deviceId || row.serial || "Устройство")}: кандидаты ${escapeHtml(row.changes)}</li>`).join("")}</ul>${fileComparisonPageControls("ambiguous", state.fileCompare.ambiguousPage, ambiguousPage.total, pageSize)}` : "";
  $("#fileCompareResult").classList.remove("empty");
  $("#fileCompareResult").innerHTML = `<p class="muted">${escapeHtml(files[0].name)} → ${escapeHtml(files[1].name)} · ${before.summary.valid} → ${after.summary.valid} уникальных устройств</p><div class="kpi-grid">${summary.map(([label, value]) => `<article class="kpi"><span>${label}</span><strong>${Number(value).toLocaleString("ru-RU")}</strong></article>`).join("")}</div>${pageSizeControl}${tableHtml}${ambiguousHtml}`;
}

async function* fileComparisonXlsxRows(analysis) {
  const rows = fileComparisonExportRowsFromPlan(requireFileComparisonPlan(analysis), state.ouiFormats);
  for await (const row of rows) yield fileComparisonColumns(state.ouiFormats).map(({ key }) => row[key]);
}

async function* fileComparisonTxtChunks(analysis) {
  const columns = fileComparisonColumns(state.ouiFormats);
  yield `\uFEFF${columns.map(({ label }) => tsvQuote(label)).join("\t")}`;
  const rows = fileComparisonExportRowsFromPlan(requireFileComparisonPlan(analysis), state.ouiFormats);
  for await (const row of rows) {
    yield `\r\n${columns.map(({ key }) => tsvQuote(row[key])).join("\t")}`;
  }
}

function streamFromAsyncIterable(iterable) {
  return readableTextStreamFromIterable(iterable);
}

function renderMultiMappings() {
  const host = $("#multiCompareMappings");
  const files = state.multiCompare.files;
  host.innerHTML = files.map((entry, index) => `<details class="panel" ${index === 0 ? "open" : ""}><summary>${escapeHtml(entry.file.name)} · ${entry.preview.rowCount === null ? "предпросмотр" : `${entry.preview.rowCount} строк`}</summary><button class="button secondary" type="button" data-remove-multi-file="${index}">Удалить файл</button><div class="mapping-grid">${SINGLE_FILE_FIELDS.map((field) => `<label><span>${escapeHtml(FIELD_LABELS[field] || field)}</span><select data-multi-position="${index}" data-multi-field="${field}"><option value="">Не использовать</option>${entry.preview.headers.map((header, column) => `<option value="${column}" ${Number(entry.mapping[field]) === column ? "selected" : ""}>${escapeHtml(header || `Колонка ${column + 1}`)}</option>`).join("")}</select></label>`).join("")}</div></details>`).join("");
  host.querySelectorAll("[data-multi-field]").forEach((select) => select.addEventListener("change", () => {
    const entry = files[Number(select.dataset.multiPosition)];
    const field = select.dataset.multiField;
    if (select.value === "") delete entry.mapping[field];
    else entry.mapping[field] = Number(select.value);
    state.multiCompare.currentResult = null;
    state.multiCompare.page = 1;
    $("#multiCompareResult").classList.add("empty");
    $("#multiCompareResult").textContent = "Сопоставление изменено. Рассчитайте выбранную пару повторно.";
  }));
  host.querySelectorAll("[data-remove-multi-file]").forEach((button) => button.addEventListener("click", () => {
    files.splice(Number(button.dataset.removeMultiFile), 1);
    state.multiCompare.pairs = files.length >= 2 ? pairwiseComparisonPairs(files.length) : [];
    state.multiCompare.currentResult = null;
    state.multiCompare.page = 1;
    renderMultiCompareState();
  }));
}

function renderMultiCompareState() {
  const { files, pairs } = state.multiCompare;
  renderMultiMappings();
  $("#multiCompareStatus").textContent = files.length
    ? `${files.length} файлов · ${pairs.length} направленных пар · сопоставление колонок задаётся отдельно для каждого файла`
    : "Файлы не выбраны.";
  const select = $("#multiComparePairSelect");
  const previous = select.value;
  select.innerHTML = pairs.map((pair) => `<option value="${escapeHtml(pair.id)}">${escapeHtml(files[pair.first].file.name)} ↔ ${escapeHtml(files[pair.second].file.name)}</option>`).join("");
  if (pairs.some((pair) => pair.id === previous)) select.value = previous;
  select.disabled = pairs.length === 0;
  $("#runMultiCompareButton").disabled = pairs.length === 0;
  $("#exportAllMultiCompareButton").disabled = pairs.length === 0;
  $("#exportAllMultiCompareCsvButton").disabled = pairs.length === 0;
  if (!pairs.length) {
    $("#multiCompareResult").classList.add("empty");
    $("#multiCompareResult").textContent = "Выберите не менее двух файлов.";
  }
}

async function handleMultiCompareFiles(fileList) {
  if (!fileList?.length) return;
  clearError();
  const current = state.multiCompare.files;
  const knownFileObjects = new Set(current.map(({ file }) => file));
  const additions = [...fileList].filter((file) => !knownFileObjects.has(file));
  if (current.length + additions.length > 10) throw new Error("Можно добавить не более 10 файлов");
  const prepared = [];
  for (let index = 0; index < additions.length; index += 1) {
    const file = additions[index];
    if (!isStreamableTableFile(file)) throw new Error(`Формат ${file.name} не поддерживается. Выберите CSV, TSV, TXT, JSON, XLSX, XLSM или XLS.`);
    progress((index + 1) / additions.length * 35, `Предпросмотр ${file.name}`, "Сравнение нескольких файлов");
    const preview = await readTablePreview(file, { maxRows: 100 });
    prepared.push({ file, preview, mapping: detectSingleFileMapping(preview.headers, preview.rows) });
  }
  await clearCurrentMultiCompareResult();
  state.multiCompare.files.push(...prepared);
  state.multiCompare.pairs = state.multiCompare.files.length >= 2 ? pairwiseComparisonPairs(state.multiCompare.files.length) : [];
  state.multiCompare.currentResult = null;
  state.multiCompare.page = 1;
  renderMultiCompareState();
  finishProgress("Предпросмотр файлов готов");
}

async function loadMultiComparePair(pair, { signal } = {}) {
  const files = [state.multiCompare.files[pair.first], state.multiCompare.files[pair.second]];
  const cache = await stageMultiCompareFiles(files, { signal });
  try {
    if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
    const result = await cache.loadPair({ first: 0, second: 1 });
    result.pair.first = pair.first;
    result.pair.second = pair.second;
    result.cleanup = cache.clear;
    return result;
  } catch (error) {
    await cache.clear();
    throw error;
  }
}

async function clearCurrentMultiCompareResult() {
  const result = state.multiCompare.currentResult;
  state.multiCompare.currentResult = null;
  result?.comparisonPlan?.clear?.();
  await result?.cleanup?.();
}

async function stageMultiCompareFiles(files, { signal } = {}) {
  const staged = [];
  const plans = new Set();
  const clear = async () => {
    for (const plan of plans) plan.clear?.();
    plans.clear();
    return Promise.all(staged.map(({ stageId }) => database.clearAnalyticsAggregateQuery(stageId).catch(() => {})));
  };
  try {
    for (let index = 0; index < files.length; index += 1) {
      if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
      const entry = files[index];
      const stageId = `final-device-stage:${Date.now()}:${crypto.randomUUID()}`;
      const deviceStore = createSingleAnalysisDeviceStageStore(stageId);
      staged.push({ stageId, deviceStore, summary: null, source: entry.file.name });
      const analysisOptions = {
        mapping: entry.mapping,
        source: entry.file.name,
        retainSourceRows: false,
        retainDiagnosticSamples: false,
        compactDevices: true,
      };
      if (!isStreamableTableFile(entry.file)) throw new Error(`Формат ${entry.file.name} нельзя безопасно сравнить пакетами`);
      const preview = entry.preview?.preview
        ? entry.preview
        : await readTablePreview(entry.file, { maxRows: 100 });
      const analysis = await analyzeSingleFileBatchesIntoStore(preview.headers, readTableRowBatches(entry.file, {
        batchSize: 500,
        signal,
        onProgress: ({ rowsRead }) => progress(2 + (index + Math.min(1, rowsRead / 100_000)) / files.length * 18,
          `${entry.file.name}: обработано ${rowsRead.toLocaleString("ru-RU")} строк`, "Подготовка сравнения"),
      }), { ...analysisOptions, deviceStore, signal });
      staged[index] = { stageId, deviceStore, summary: analysis.summary, source: entry.file.name };
      progress(2 + (index + 1) / files.length * 18, `Подготовлен файл ${index + 1} из ${files.length}: ${entry.file.name}`, "Подготовка сравнения");
    }
    return {
      staged,
      async loadPair(pair) {
        if (signal?.aborted) throw new DOMException("Операция отменена", "AbortError");
        const first = staged[pair.first];
        const second = staged[pair.second];
        if (!first || !second) throw new Error("Пара сравнения ссылается на отсутствующий временный файл");
        const before = { summary: first.summary };
        const after = { summary: second.summary };
        const comparisonPlan = await createStagedMultiFileComparisonPlan(first.deviceStore, second.deviceStore, new Date().toISOString(), {
          mac: $("#multiFieldMac").checked,
          oui: $("#multiFieldOui").checked,
          vendor: $("#multiFieldVendor").checked,
          model: $("#multiFieldModel").checked,
          ip: $("#multiFieldIp").checked,
          address: $("#multiFieldAddress").checked,
          room: $("#multiFieldRoom").checked,
        }, { signal });
        plans.add(comparisonPlan);
        return {
          pair: { file1: first.source, file2: second.source, first: pair.first, second: pair.second },
          before,
          after,
          comparison: null,
          comparisonPlan,
        };
      },
      clear,
    };
  } catch (error) {
    await clear();
    throw error;
  }
}

async function runMultiCompareCancellable(title, action) {
  const controller = new AbortController();
  state.controller = controller;
  try {
    return await action(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && error?.name === "AbortError") {
      finishProgress(`${title} отменено`);
      return null;
    }
    throw error;
  } finally {
    if (state.controller === controller) state.controller = null;
  }
}

const MULTI_COMPARE_PAGE_SIZES = [25, 50, 100, 250, 500, 1_000];

async function renderMultiCompareResult(result) {
  const renderSequence = (result.renderSequence || 0) + 1;
  result.renderSequence = renderSequence;
  const { comparison, before, after, pair } = result;
  const counts = result.comparisonPlan || comparison;
  const summaries = [["Только во втором", counts.addedCount ?? comparison.added.length], ["Только в первом", counts.absentCount ?? comparison.absent.length], ["Изменено", counts.modifiedDeviceCount ?? comparison.modified.length], ["Без изменений", counts.unchangedCount ?? comparison.unchanged.length], ["Неоднозначно", counts.ambiguousCount ?? comparison.ambiguous.length]];
  const pageSize = MULTI_COMPARE_PAGE_SIZES.includes(state.multiCompare.pageSize) ? state.multiCompare.pageSize : 100;
  state.multiCompare.pageSize = pageSize;
  const page = await multiFileComparisonRowsPageAsync(pair, result, { offset: (state.multiCompare.page - 1) * state.multiCompare.pageSize, limit: state.multiCompare.pageSize });
  if (state.multiCompare.currentResult !== result || result.renderSequence !== renderSequence) return;
  state.multiCompare.page = page.page;
  const fields = [["status", "Статус"], ["mac", "MAC"], ["before", "Было"], ["after", "Стало"], ["changes", "Изменения"]];
  const pageSizeOptions = MULTI_COMPARE_PAGE_SIZES.map((size) => `<option value="${size}" ${size === pageSize ? "selected" : ""}>${size.toLocaleString("ru-RU")}</option>`).join("");
  const pageSizeControl = `<label class="file-comparison-page-size">Строк на странице<select data-multi-compare-page-size>${pageSizeOptions}</select></label>`;
  $("#multiCompareResult").classList.remove("empty");
  const start = page.total ? page.offset + 1 : 0;
  const end = page.offset + page.rows.length;
  const pagination = page.pageCount > 1
    ? `<div class="action-row"><span class="muted">Показано ${start.toLocaleString("ru-RU")}–${end.toLocaleString("ru-RU")} из ${page.total.toLocaleString("ru-RU")} · страница ${page.page} из ${page.pageCount}</span><button class="button secondary" type="button" data-multi-compare-page="${page.page - 1}" ${page.hasPrevious ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-multi-compare-page="${page.page + 1}" ${page.hasNext ? "" : "disabled"}>Дальше</button></div>`
    : page.total ? `<p class="muted">Строк: ${page.total.toLocaleString("ru-RU")}</p>` : "";
  $("#multiCompareResult").innerHTML = `<p>${escapeHtml(pair.file1)} → ${escapeHtml(pair.file2)} · ${before.summary.valid} → ${after.summary.valid} устройств</p><div class="kpi-grid">${summaries.map(([label, value]) => `<article class="kpi"><span>${label}</span><strong>${Number(value).toLocaleString("ru-RU")}</strong></article>`).join("")}</div>${pageSizeControl}${page.rows.length ? `<div class="table-scroll"><table class="data-table"><thead><tr>${fields.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${page.rows.map((row) => `<tr>${fields.map(([field]) => `<td>${escapeHtml(row[field])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${pagination}` : '<p class="empty">Данные совпадают; диагностик идентичности нет.</p>'}`;
}

async function runMultiCompareSelected() {
  const pair = state.multiCompare.pairs.find((item) => item.id === $("#multiComparePairSelect").value) || state.multiCompare.pairs[0];
  if (!pair) throw new Error("Добавьте не менее двух файлов");
  return runMultiCompareCancellable("Сравнение пары", async (signal) => {
    await clearCurrentMultiCompareResult();
    const result = await loadMultiComparePair(pair, { signal });
    state.multiCompare.currentResult = result;
    state.multiCompare.page = 1;
    await renderMultiCompareResult(result);
    finishProgress("Пара сравнена");
    return result;
  });
}

async function exportAllMultiComparePairsCsv() {
  const { pairs, files } = state.multiCompare;
  if (!pairs.length) throw new Error("Нет пар для сравнения");
  return runMultiCompareCancellable("Экспорт сравнений", async (signal) => {
    const filename = "multi-file-comparison.csv";
    const pickerRequest = typeof globalThis.showSaveFilePicker === "function" ? globalThis.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
    }) : null;
    const { fileHandle, cancelled } = await resolveSaveHandle(pickerRequest);
    if (cancelled) {
      finishProgress("Экспорт отменён");
      return null;
    }
    const cache = await stageMultiCompareFiles(files, { signal });
    try {
    const chunks = (async function* () {
      yield `\uFEFF${pairwiseCsvHeader()}`;
      for (let index = 0; index < pairs.length; index += 1) {
        if (signal.aborted) throw new DOMException("Операция отменена", "AbortError");
        const pair = pairs[index];
        progress(20 + index / pairs.length * 80, `Пара ${index + 1} из ${pairs.length}: ${files[pair.first].file.name} → ${files[pair.second].file.name}`, "Экспорт всех сравнений");
        const result = await cache.loadPair(pair);
        yield* pairwiseComparisonCsvChunksAsync(result.pair, result, { signal });
        result.comparisonPlan?.clear?.();
      }
    }());
    const stream = readableTextStreamFromIterable(chunks, { signal });
    const saved = await downloadReadableStream(filename, stream, "text/csv;charset=utf-8", "CSV сравнений", fileHandle);
    if (signal.aborted) throw new DOMException("Операция отменена", "AbortError");
    if (saved === "cancelled") {
      finishProgress("Экспорт отменён");
      return null;
    }
    finishProgress(`Экспортированы все ${pairs.length} пар`);
    } finally {
      await cache.clear();
    }
  });
}

async function exportAllMultiComparePairs() {
  const { pairs, files } = state.multiCompare;
  if (!pairs.length) throw new Error("Нет пар для сравнения");
  return runMultiCompareCancellable("Экспорт сравнений", async (signal) => {
    const filename = `multi-comparison-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const pickerRequest = typeof globalThis.showSaveFilePicker === "function" ? globalThis.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: "Excel", accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] } }],
    }) : null;
    const { fileHandle, cancelled } = await resolveSaveHandle(pickerRequest);
    if (cancelled) {
      finishProgress("Экспорт отменён");
      return null;
    }
    const cache = await stageMultiCompareFiles(files, { signal });
    try {
    const sheets = multiFileComparisonWorkbookSheets(pairs, files, (pair) => cache.loadPair(pair), { signal });
    const stream = createXlsxWorkbookStream(sheets);
    const saved = await downloadReadableStream(
      filename,
      stream,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "XLSX сравнений",
      fileHandle,
    );
    if (signal.aborted) throw new DOMException("Операция отменена", "AbortError");
    if (saved === "cancelled") {
      finishProgress("Экспорт отменён");
      return null;
    }
    finishProgress(`Экспортированы все ${pairs.length} пар в XLSX`);
    } finally {
      await cache.clear();
    }
  });
}

async function handleSourceFile(role, file) {
  if (!file) return;
  if (!WORKSPACE_SOURCE_ROLES.includes(role)) throw new Error("Неизвестная роль исходного файла");
  await readAndApplySourceFile(role, file, { beforeApply: async () => {
    await database.deleteWorkspaceSourceFileHandle(role);
    state.workspaceSourceHandles[role] = null;
    renderWorkspaceSourceHandleStatus(role, "Постоянный доступ не сохранён для этого файла.");
  } });
}

function supportsWorkspaceSourceHandles() {
  return globalThis.isSecureContext !== false && typeof globalThis.showOpenFilePicker === "function";
}

function renderWorkspaceSourceHandleStatus(role, detail = "") {
  const button = document.querySelector(`[data-workspace-source-handle="${role}"]`);
  const status = $(`#${role}WorkspaceSourceStatus`);
  if (!button || !status) return;
  const supported = supportsWorkspaceSourceHandles();
  const record = state.workspaceSourceHandles[role];
  button.hidden = !supported;
  button.disabled = !supported;
  button.textContent = record?.handle
    ? record.permission === "granted" ? "Восстановить сохранённый файл" : "Разрешить доступ и восстановить"
    : "Выбрать с сохранением доступа";
  status.textContent = detail || (record?.handle
    ? `Сохранённый доступ: ${record.name || "файл"}. После перезапуска браузер может запросить разрешение.`
    : supported
      ? "Можно сохранить доступ к исходному файлу для восстановления после перезапуска. Путь к файлу не сохраняется."
      : "Постоянный доступ к файлу этим браузером не поддерживается; обычный выбор файла работает без изменений.");
}

async function readAndApplySourceFile(role, file, { restored = false, restoredFrom = "сохранённого Final", persisted = false, beforeApply = null } = {}) {
  clearError();
  progress(5, `Чтение ${file.name}`, "Импорт файла");
  const table = await readSourceTable(file);
  if (beforeApply) await beforeApply(file, table);
  setSourceTable(role, file, table, { restored, restoredFrom });
  if (persisted) renderWorkspaceSourceHandleStatus(role, `Файл восстановлен из рабочей области: ${file.name}. Сверьте сопоставления перед объединением.`);
  finishProgress("Файл прочитан");
}

async function restoreWorkspaceSourceHandles({ loadPermittedFiles = false } = {}) {
  const records = await database.workspaceSourceFileHandles();
  const byRole = new Map(records.map((record) => [record.role, record]));
  for (const role of WORKSPACE_SOURCE_ROLES) {
    const record = byRole.get(role) || null;
    state.workspaceSourceHandles[role] = record ? { ...record, permission: "unknown" } : null;
    if (!record) {
      renderWorkspaceSourceHandleStatus(role);
      continue;
    }
    const inspected = await inspectWorkspaceSourceHandle(record);
    state.workspaceSourceHandles[role] = { ...record, permission: inspected.permission };
    if (!inspected.file) {
      renderWorkspaceSourceHandleStatus(role, `${record.name}: ${inspected.error || "требуется разрешение"}. Нажмите кнопку, чтобы разрешить доступ.`);
      continue;
    }
    if (!workspaceSourceFileMatchesRecord(inspected.file, record)) {
      renderWorkspaceSourceHandleStatus(role, `${record.name}: файл изменился после сохранения. Нажмите кнопку, чтобы проверить и загрузить текущую версию.`);
      continue;
    }
    renderWorkspaceSourceHandleStatus(role, loadPermittedFiles
      ? `Восстанавливается ${record.name}…`
      : `Разрешение сохранено для ${record.name}; входной файл можно восстановить в инженерном режиме.`);
    if (loadPermittedFiles && isEngineerActive()) {
      try {
        await readAndApplySourceFile(role, inspected.file, { restored: true, restoredFrom: "рабочей области", persisted: true });
      } catch (error) {
        renderWorkspaceSourceHandleStatus(role, `${record.name}: не удалось восстановить файл. ${error.message || error}`);
      }
    }
  }
}

async function activateWorkspaceSourceHandle(role) {
  if (!isEngineerActive()) throw new Error("Восстановление исходников доступно только в инженерном режиме");
  const saved = state.workspaceSourceHandles[role];
  if (saved?.handle) {
    // Invoke requestPermission synchronously from this click before awaiting anything.
    const permission = await requestWorkspaceSourcePermission(saved.handle);
    state.workspaceSourceHandles[role] = { ...saved, permission };
    if (permission !== "granted") {
      renderWorkspaceSourceHandleStatus(role, `Браузер не выдал разрешение на чтение ${saved.name}. Разрешите доступ и повторите.`);
      return false;
    }
    const file = await saved.handle.getFile();
    if (!workspaceSourceFileMatchesRecord(file, saved)
      && !globalThis.confirm(`Файл «${saved.name}» изменился с момента сохранения. Загрузить его текущую версию?`)) return false;
    await readAndApplySourceFile(role, file, {
      restored: true,
      restoredFrom: "рабочей области",
      persisted: true,
      beforeApply: async () => {
        const record = await database.saveWorkspaceSourceFileHandle(role, saved.handle, file);
        state.workspaceSourceHandles[role] = { ...record, permission: "granted" };
      },
    });
    return true;
  }
  const picker = globalThis.showOpenFilePicker;
  if (!supportsWorkspaceSourceHandles() || typeof picker !== "function") {
    renderWorkspaceSourceHandleStatus(role, "Сохранение доступа не поддерживается. Выберите файл через обычное поле загрузки.");
    return false;
  }
  const pickerPromise = picker.call(globalThis, {
    multiple: false,
    types: [{ description: "Файл источника MAC Analyzer", accept: {
      "text/csv": [".csv"], "text/tab-separated-values": [".tsv"], "text/plain": [".txt"],
      "application/json": [".json"],
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
      "application/vnd.ms-excel.sheet.macroEnabled.12": [".xlsm"],
      "application/vnd.ms-excel": [".xls"],
    } }],
  });
  let handles;
  try { handles = await pickerPromise; }
  catch (error) { if (error?.name === "AbortError") return false; throw error; }
  const handle = handles?.[0];
  if (!handle || handle.kind !== "file") return false;
  const file = await handle.getFile();
  await readAndApplySourceFile(role, file, { beforeApply: async () => {
    const record = await database.saveWorkspaceSourceFileHandle(role, handle, file);
    state.workspaceSourceHandles[role] = { ...record, permission: "granted" };
  } });
  renderWorkspaceSourceHandleStatus(role, `Доступ к ${file.name} сохранён локально в этом профиле браузера.`);
  return true;
}

function supportsBatchDirectoryHandles() {
  return globalThis.isSecureContext !== false && typeof globalThis.showDirectoryPicker === "function";
}

function renderBatchDirectoryHandleStatus(role, detail = "") {
  const button = document.querySelector(`[data-batch-directory-handle="${role}"]`);
  const status = $(`#batch${role === "main" ? "Main" : role === "smartroom" ? "Smartroom" : "DdIo"}DirectoryStatus`);
  if (!button || !status) return;
  const supported = supportsBatchDirectoryHandles();
  const record = state.batchDirectoryHandles[role];
  button.hidden = !supported;
  button.disabled = !supported;
  button.textContent = record?.handle
    ? record.permission === "granted" ? "Восстановить сохранённую папку" : "Разрешить доступ и восстановить"
    : "Выбрать папку с сохранением доступа";
  status.textContent = detail || (record?.handle
    ? `Сохранённая папка: ${record.name}. После перезапуска браузер может запросить разрешение.`
    : supported
      ? "Можно восстановить список файлов из выбранной папки после перезапуска. Путь и содержимое не сохраняются."
      : "Постоянный доступ к папке не поддерживается; обычный выбор папки и drag-and-drop остаются доступны.");
}

async function handleBatchFileSelection(role, files, { append = false, page = null } = {}) {
  if (!BATCH_DIRECTORY_ROLES.includes(role)) throw new Error("Неизвестная роль папки массового объединения");
  await database.deleteWorkspaceBatchDirectoryHandle(role);
  state.batchDirectoryHandles[role] = null;
  setBatchFiles(role, files, { append, page });
  renderBatchDirectoryHandleStatus(role, "Сохранённый доступ к папке удалён: состав списка изменён вручную.");
}

async function restoreWorkspaceBatchDirectories({ loadPermittedFiles = false } = {}) {
  const records = await database.workspaceBatchDirectoryHandles();
  const byRole = new Map(records.map((record) => [record.role, record]));
  for (const role of BATCH_DIRECTORY_ROLES) {
    const record = byRole.get(role) || null;
    state.batchDirectoryHandles[role] = record ? { ...record, permission: "unknown" } : null;
    if (!record) {
      renderBatchDirectoryHandleStatus(role);
      continue;
    }
    const inspected = await inspectBatchDirectoryHandle(record);
    state.batchDirectoryHandles[role] = { ...record, permission: inspected.permission };
    if (!inspected.handle) {
      renderBatchDirectoryHandleStatus(role, `${record.name}: ${inspected.error || "требуется разрешение"}. Нажмите кнопку для доступа.`);
      continue;
    }
    if (loadPermittedFiles && isEngineerActive() && !state.batch[role].length) {
      try {
        const files = await listBatchDirectoryFiles(inspected.handle);
        setBatchFiles(role, files);
        renderBatchDirectoryHandleStatus(role, `Восстановлена папка ${record.name}: ${files.length.toLocaleString("ru-RU")} файлов. Повторно сформируйте пары перед запуском.`);
      } catch (error) {
        renderBatchDirectoryHandleStatus(role, `${record.name}: не удалось прочитать папку. ${error.message || error}`);
      }
      continue;
    }
    renderBatchDirectoryHandleStatus(role, `Доступ к ${record.name} разрешён; список можно восстановить в инженерном режиме.`);
  }
}

async function activateWorkspaceBatchDirectory(role) {
  if (!isEngineerActive()) throw new Error("Восстановление папок очереди доступно только в инженерном режиме");
  if (!BATCH_DIRECTORY_ROLES.includes(role)) throw new Error("Неизвестная роль папки массового объединения");
  const saved = state.batchDirectoryHandles[role];
  if (saved?.handle) {
    const permission = await requestBatchDirectoryPermission(saved.handle);
    state.batchDirectoryHandles[role] = { ...saved, permission };
    if (permission !== "granted") {
      renderBatchDirectoryHandleStatus(role, `Браузер не выдал разрешение на чтение ${saved.name}. Разрешите доступ и повторите.`);
      return false;
    }
    const files = await listBatchDirectoryFiles(saved.handle);
    setBatchFiles(role, files);
    renderBatchDirectoryHandleStatus(role, `Восстановлена папка ${saved.name}: ${files.length.toLocaleString("ru-RU")} файлов. Повторно сформируйте пары перед запуском.`);
    return true;
  }
  const picker = globalThis.showDirectoryPicker;
  if (!supportsBatchDirectoryHandles() || typeof picker !== "function") {
    renderBatchDirectoryHandleStatus(role, "Сохранение доступа не поддерживается. Выберите папку через обычное поле.");
    return false;
  }
  const pickerPromise = picker.call(globalThis, { mode: "read" });
  let handle;
  try { handle = await pickerPromise; }
  catch (error) { if (error?.name === "AbortError") return false; throw error; }
  if (!handle || handle.kind !== "directory") return false;
  const files = await listBatchDirectoryFiles(handle);
  const record = await database.saveWorkspaceBatchDirectoryHandle(role, handle);
  state.batchDirectoryHandles[role] = { ...record, permission: "granted" };
  setBatchFiles(role, files);
  renderBatchDirectoryHandleStatus(role, `Доступ к папке ${record.name} сохранён локально: ${files.length.toLocaleString("ru-RU")} файлов.`);
  return true;
}

async function readSourceTable(file, { sheetName = "" } = {}) {
  return isStreamableTableFile(file)
    ? readTablePreview(file, { maxRows: 100, sheetName })
    : readTable(file, { sheetName });
}

function setSourceTable(role, file, table, { restored = false, restoredFrom = "сохранённого Final" } = {}) {
  state.sourceFiles[role] = file;
  state.sourceTables[role] = table;
  const detected = detectMappingReport(table.headers, table.rows, role).mapping;
  state.mappings[role] = restoreSourceMapping(table.headers, state.sourceMappingPreferences[role], detected);
  const rowSummary = table.preview
    ? `предпросмотр ${table.rows.length.toLocaleString("ru-RU")} строк; полный файл обработается потоком`
    : `${table.rowCount.toLocaleString("ru-RU")} строк`;
  $(`#${role}FileStatus`).textContent = `${file.name} · ${rowSummary}${restored ? ` · восстановлен из ${restoredFrom}` : ""}`;
  renderMapping(role);
}

function renderLegacyWorkspaceSources() {
  const panel = $("#legacyWorkspaceRestorePanel");
  const select = $("#legacyWorkspaceSourceSelect");
  const status = $("#legacyWorkspaceSourceStatus");
  const rolePicker = $("#legacyWorkspaceRestoreRolePicker");
  const roleSelect = $("#legacyWorkspaceRestoreRoleSelect");
  if (!panel || !select || !status) return;
  const files = normalizeLegacyWorkspaceFiles(state.legacyWorkspaceSources);
  panel.hidden = files.length === 0;
  select.innerHTML = files.map((file, index) => {
    const role = legacyWorkspaceSourceRole(file.role);
    const roleLabel = { main: "Main", smartroom: "SmartRoom", ddio: "DDIO" }[role]
      || (file.role === "additional" ? "Дополнительный файл · назначьте роль" : "Источник");
    const date = file.createdAt ? ` · ${escapeHtml(file.createdAt)}` : "";
    const sheet = file.sheet ? ` · лист ${escapeHtml(file.sheet)}` : "";
    const rowCount = file.id.startsWith("pyqt-settings-") ? "число строк не сохранено" : `${file.rowCount.toLocaleString("ru-RU")} строк`;
    return `<option value="${index}">${escapeHtml(roleLabel)} · ${escapeHtml(file.name || "без имени")} · ${rowCount}${sheet}${date}</option>`;
  }).join("");
  const selected = files[Number(select.value) || 0];
  if (rolePicker && roleSelect) {
    rolePicker.hidden = selected?.role !== "additional";
    roleSelect.value = "";
  }
  status.textContent = files.length ? `Доступно сводок: ${files.length}. Сопоставления применяются только к выбранному файлу и только в пределах его колонок; дополнительные файлы требуют явного выбора роли.` : "В архиве нет сводок исходных файлов.";
}

async function restoreLegacyWorkspaceSource(index, file, roleOverride = "") {
  if (!file) return;
  const summary = state.legacyWorkspaceSources[Number(index)];
  const role = legacyWorkspaceSourceRole(summary?.role)
    || (summary?.role === "additional" && ["main", "smartroom", "ddio"].includes(roleOverride) ? roleOverride : "");
  if (!summary || !role) throw new Error("Выберите действительную сводку исходного файла");
  progress(5, `Чтение выбранного файла ${file.name}`, "Восстановление источника PyQt");
  try {
    assertSourceFileCapacity(file);
    const table = await readSourceTable(file, { sheetName: summary.sheet });
    const detected = detectMappingReport(table.headers, table.rows, role).mapping;
    const fallback = restoreSourceMapping(table.headers, state.sourceMappingPreferences[role], detected);
    const allowedFields = [...ROLE_FIELDS[role], ...state.inventoryColumnConfig.columns.filter(({ custom }) => custom).map(({ key }) => key)];
    const mapping = restoreLegacyWorkspaceMapping(summary, table.headers, allowedFields, fallback);
    if (summary.role === "additional") {
      const restoredRole = role === "main" ? "primary" : role;
      const updatedSources = state.legacyWorkspaceSources.map((source, sourceIndex) => sourceIndex === Number(index)
        ? { ...source, role: restoredRole }
        : source);
      await database.setSetting("legacyAppSetting:sourceFiles", normalizeLegacyWorkspaceFiles(updatedSources));
      state.legacyWorkspaceSources = updatedSources;
      renderLegacyWorkspaceSources();
    }
    setSourceTable(role, file, table, { restored: true });
    state.mappings[role] = mapping;
    renderMapping(role);
    $("#legacyWorkspaceSourceStatus").textContent = `Восстановлено в ${role.toUpperCase()}: ${file.name}. Сохранённые сопоставления применены в границах ${table.headers.length} колонок; проверьте их перед запуском.`;
    finishProgress("Источник PyQt восстановлен в объединение");
  } catch (error) {
    finishProgress("Источник PyQt не восстановлен");
    throw error;
  }
}

async function restoreOriginalSources(snapshotId, button) {
  if (!isEngineerActive()) throw new Error("Восстановление исходников доступно только в инженерном режиме");
  const currentFiles = ["main", "smartroom", "ddio"].map((role) => state.sourceFiles[role]).filter(Boolean);
  const currentSummary = currentFiles.map((file) => file.name || "без имени").join(", ");
  if (currentFiles.length && !globalThis.confirm(`Восстановленные файлы заменят текущие исходники для объединения (${currentSummary}). Продолжить?`)) return false;

  button.disabled = true;
  clearError();
  progress(5, "Подготовка исходных файлов из Final", "Восстановление исходников");
  try {
    const prepared = await prepareOriginalSourceRecovery(snapshotId, {
      database,
      isAuthorized: isEngineerActive,
      readTable: async (file, role) => {
        progress(10, `Чтение ${role.toUpperCase()}: ${file.name}`, "Восстановление исходников");
        assertSourceFileCapacity(file);
        return readSourceTable(file);
      },
      onProgress: ({ index, total }) => progress(10 + 80 * index / total, `Проверено файлов: ${index} из ${total}`, "Восстановление исходников"),
    });
    if (!isEngineerActive()) throw new Error("Инженерный сеанс завершился до применения файлов");
    const stagedByRole = new Map(prepared.map((item) => [item.role, item]));
    for (const role of ["main", "smartroom", "ddio"]) {
      $(`#${role}FileInput`).value = "";
      const staged = stagedByRole.get(role);
      if (staged) setSourceTable(role, staged.file, staged.table, { restored: true });
      else {
        state.sourceFiles[role] = null;
        state.sourceTables[role] = null;
        state.mappings[role] = {};
        $(`#${role}FileStatus`).textContent = "Не выбран";
        renderMapping(role);
      }
    }
    activateView("enrichment");
    finishProgress(`Восстановлено исходных файлов: ${prepared.length}`);
    return true;
  } catch (error) {
    finishProgress("Исходные файлы не восстановлены");
    throw error;
  } finally {
    button.disabled = false;
  }
}

async function executeEnrichment({ tables, mappings, files, name, strategy, progressRange = [0, 100], includeSwitchIpReport = false }) {
  const processingStartedAt = performance.now();
  const [start, end] = progressRange;
  const sourceDigests = {};
  try {
    const entries = Object.entries(files).filter(([, file]) => file);
    for (const [, file] of entries) assertSourceFileCapacity(file);
    const hashWorkingSetBytes = estimateSha256WorkingSetBytes(entries.map(([, file]) => file));
    assertBrowserHeapCapacity(hashWorkingSetBytes * 2);
    const results = await Promise.allSettled(entries.map(async ([role, file], index) => {
      sourceDigests[role] = await sha256File(file, {
        signal: state.controller?.signal,
        onProgress: ({ bytesRead, totalBytes }) => {
          const roleProgress = totalBytes ? bytesRead / totalBytes : 1;
          const portion = (index + roleProgress) / Math.max(1, entries.length);
          progress(start + portion * Math.min(2, (end - start) * 0.02), `Проверка исходника ${role.toUpperCase()}: ${bytesRead.toLocaleString("ru-RU")} / ${totalBytes.toLocaleString("ru-RU")} байт`, "Объединение данных");
        },
      });
    }));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  } catch (error) {
    error.batchStage = "проверка исходных файлов";
    throw error;
  }
  const activeSnapshotId = await database.getSetting("activeSnapshotId", "");
  const vendorDetectorSettings = normalizeVendorDetectorSettings(await database.getSetting("vendorDetectorSettings", DEFAULT_VENDOR_DETECTOR_SETTINGS));
  const historyEnrichmentSettings = normalizeHistoryEnrichmentSettings(await database.getSetting(
    "historyEnrichmentSettings", await database.getSetting("legacyAppSetting:historyEnrichment", DEFAULT_HISTORY_ENRICHMENT_SETTINGS),
  ));
  const ipEnrichmentSettings = normalizeIpEnrichmentSettings(await database.getSetting("ipEnrichmentSettings", DEFAULT_IP_ENRICHMENT_SETTINGS));
  const ipAddressMappings = ipEnrichmentSettings.enabled ? await database.ipAddressMappings() : [];
  const enrichmentFieldSettings = normalizeEnrichmentFieldSettings(await database.getSetting("enrichmentFieldSettings", DEFAULT_ENRICHMENT_FIELD_SETTINGS));
  const bundledOuiIndex = await loadBundledIeeeIndex();
  const rowsFor = (role) => {
    const table = tables[role];
    const file = files[role];
    if (table?.preview && file && isStreamableTableFile(file)) {
      const stageStart = role === "main" ? 20 : role === "smartroom" ? 40 : 70;
      return readTableRowBatches(file, {
        sheetName: table.sheet,
        batchSize: 500,
        signal: state.controller?.signal,
        onProgress: ({ rowsRead = 0 } = {}) => {
          const phase = stageStart + Math.min(12, rowsRead / 5_000);
          progress(start + phase / 100 * (end - start), `Чтение ${role.toUpperCase()}: ${rowsRead.toLocaleString("ru-RU")} строк`, "Обогащение");
        },
      });
    }
    if (!table?.rowsConsumed && Array.isArray(table?.rows) && table.rows.length) return consumeStoredTableRows(table, { batchSize: 500 });
    if (table?.rowCount === 0 || !file) return [];
    return readTableRowBatches(file, {
      sheetName: table?.sheet || "",
      batchSize: 500,
      signal: state.controller?.signal,
      onProgress: ({ rowsRead = 0 } = {}) => {
        const stageStart = role === "main" ? 20 : role === "smartroom" ? 40 : 70;
        const phase = stageStart + Math.min(12, rowsRead / 5_000);
        progress(start + phase / 100 * (end - start), `Чтение ${role.toUpperCase()}: ${rowsRead.toLocaleString("ru-RU")} строк`, "Обогащение");
      },
    });
  };
  const stagedDeviceQueryId = `final-device-stage:${Date.now()}:${crypto.randomUUID()}`;
  const deviceStore = {
    queryId: stagedDeviceQueryId,
    count: 0,
    async appendPage(devices, { offset, total, identityEntries = new Map() }) {
      const appended = await database.appendFinalDeviceStageChunk(stagedDeviceQueryId, devices, { offset, total, identityEntries });
      this.count = offset + appended;
      return appended;
    },
    readPage: (offset, limit) => database.finalDeviceStagePage(stagedDeviceQueryId, { offset, limit }),
    readPositions: (positions) => database.finalDeviceStageDevicesAtPositions(stagedDeviceQueryId, positions),
    readIdentityEntries: (keys) => database.finalDeviceStageIdentityEntries(stagedDeviceQueryId, keys),
    appendDdIoEvidencePage: (index) => database.appendFinalDdIoEvidencePage(stagedDeviceQueryId, index),
    ddIoEvidenceForKeys: (macs, deviceIds) => database.finalDdIoEvidenceForKeys(stagedDeviceQueryId, macs, deviceIds),
    ddIoTargetIdentityKeys: (keys) => database.finalDeviceStageIdentityEntries(stagedDeviceQueryId, keys),
    writeIdentityEntries: (entries, maxPositionExclusive) => database.writeFinalDeviceStageIdentityEntries(
      stagedDeviceQueryId, entries, { maxPositionExclusive },
    ),
    writePositions: (updates) => database.replaceFinalDeviceStageDevicesAtPositions(stagedDeviceQueryId, updates),
    writePage: (offset, devices) => database.replaceFinalDeviceStagePage(stagedDeviceQueryId, { offset, devices }),
    finalize: (total) => database.finalizeFinalDeviceStage(stagedDeviceQueryId, total),
  };
  const result = await enrich({
    mainRows: rowsFor("main"),
    smartroomRows: rowsFor("smartroom"),
    ddioRows: rowsFor("ddio"),
    mappings,
    strategy,
    ...(activeSnapshotId ? { loadPreviousIdentityIndex: (currentDevices) => database.buildPreviousFinalIdentityIndex(activeSnapshotId, currentDevices) } : {}),
    ipAddressMappings,
    ipEnrichmentSettings,
    loadOuiIndex: async (macs) => vendorDetectorSettings.enabled && vendorDetectorSettings.useOui3
      ? createOuiIndexOverlay(bundledOuiIndex, await database.ouiIndexForMacs(macs))
      : new Map(),
    loadKnownModels: (macs) => database.knownModelsForMacs(macs),
    loadMac5Models: (macs) => database.mac5ModelsForMacs(macs),
    loadLegacyVendorModelSuggestions: (macs) => database.legacyVendorModelSuggestionsForMacs(macs, {
      useMac5Match: historyEnrichmentSettings.useMac5Match,
      useOuiMatch: historyEnrichmentSettings.useOuiMatch,
    }),
    loadHistoricalAddressIndex: async (ips) => {
      const accumulator = createHistoricalAddressAccumulator();
      await database.forEachSwitchAddressEvidenceForIps(ips, (record) => accumulator.add(record));
      return accumulator.finish();
    },
    retainHistoricalAddressIndex: false,
    loadHistoricalRoomIndex: async (ids) => buildSmartroomRoomIndex(await database.smartroomRoomMappingsForIds(ids)),
    loadImportedSmartroomRoomIndex: async (ids) => buildImportedSmartroomRoomIndex(await database.legacySmartroomRoomMappingsForIds(ids)),
    retainSmartroomRoomEvidence: includeSwitchIpReport,
    vendorDetectorSettings,
    historyEnrichmentSettings,
    enrichmentFieldSettings,
    deviceStore,
    signal: state.controller?.signal,
    onProgress: (value, stage) => progress(start + value / 100 * (end - start), stage, "Обогащение"),
  }).catch(async (error) => {
    await database.clearAnalyticsAggregateQuery(stagedDeviceQueryId).catch(() => {});
    error.batchStage = "обработка данных";
    throw error;
  });
  let historicalSwitchChangeQueryId = "";
  let historicalSwitchChangeTotal = 0;
  const mainObservationDate = fileObservationDate(files.main, tables.main?.workbookCreatedAt, tables.main?.workbookModifiedAt);
  const createdAt = mainObservationDate.date || new Date().toISOString();
  let presentation = null;
  const historicalAddressSummary = includeSwitchIpReport ? createHistoricalAddressDeviceSummaryAccumulator() : null;
  const appliedSmartroomSummary = includeSwitchIpReport ? createAppliedSmartroomMappingSummaryAccumulator() : null;
  const sourceKey = buildSourceKey({ strategy, files, mappings, sourceDigests });
  progress(start + 0.96 * (end - start), "Атомарное сохранение Final", "Обогащение");
  const finalDeviceCount = Number(result.deviceCount ?? result.devices.length);
  let historyPlan = null;
  let metadata;
  try {
    if (result.deviceStore !== deviceStore) {
      for (let offset = 0; offset < finalDeviceCount; offset += 500) {
        if (state.controller?.signal.aborted) throw new DOMException("Операция отменена", "AbortError");
        const end = Math.min(finalDeviceCount, offset + 500);
        const page = result.devices.slice(offset, end);
        await database.appendFinalDeviceStageChunk(stagedDeviceQueryId, page, { offset, total: finalDeviceCount });
        page.length = 0;
        for (let index = offset; index < end; index += 1) result.devices[index] = null;
      }
      result.devices.length = 0;
    }
    if (includeSwitchIpReport) {
      await database.clearExpiredAnalyticsAggregateQueries("switch-ip-report:").catch(showError);
      historicalSwitchChangeQueryId = `switch-ip-report:${Date.now()}:${crypto.randomUUID()}`;
      try {
        const report = await compareSwitchIpHistoryInBatches(
          [],
          (page) => database.inventoryCandidatesForDevices(page),
          {
            deviceCount: finalDeviceCount,
            loadDevicePage: (offset, limit) => database.finalDeviceStagePage(stagedDeviceQueryId, { offset, limit }),
            onDevicePage: (page) => {
              historicalAddressSummary.add(page);
              appliedSmartroomSummary.add(page);
            },
            signal: state.controller?.signal,
            onChangesBatch: (changes, { total }) => database.appendSwitchIpReportChanges(
              historicalSwitchChangeQueryId,
              changes,
              { offset: total - changes.length },
            ),
          },
        );
        historicalSwitchChangeTotal = report.total;
        presentation = {
          historicalAddressSummary: historicalAddressSummary.finish(),
          appliedSmartroomSummary: appliedSmartroomSummary.finish(),
        };
      } catch (error) {
        await database.clearAnalyticsAggregateQuery(historicalSwitchChangeQueryId).catch(() => {});
        error.batchStage = "сверка IP коммутаторов с историей";
        throw error;
      }
    }
    historyPlan = await stageFinalHistoryPlan({
      snapshotId: activeSnapshotId,
      deviceCount: finalDeviceCount,
      loadDevicePage: (offset, limit) => database.finalDeviceStagePage(stagedDeviceQueryId, { offset, limit }),
      timestamp: createdAt,
      signal: state.controller?.signal,
      loadPreviousIdentityIndex: (snapshotId, currentDevices, signature) => database.buildPreviousFinalIdentityIndex(snapshotId, currentDevices, signature),
      visitPreviousChunks: (snapshotId, visit) => database.forEachSnapshotChunk(snapshotId, visit),
      verifyPreviousSnapshot: (snapshotId, signature) => database.assertSnapshotSignature(snapshotId, signature),
      appendEvents: (queryId, events, options) => database.appendFinalHistoryPlanEvents(queryId, events, options),
      clearEvents: (queryId) => database.clearAnalyticsAggregateQuery(queryId),
    });
    result.diagnostics.historyComparison = historyPlan.historyComparison;
    metadata = await database.saveFinal({
      name: name || `Final ${files.main.name}`,
      sourceKey,
      createdAt,
      processingTimeMs: Math.max(0, Math.round(performance.now() - processingStartedAt)),
      devices: [],
      stagedDeviceQueryId,
      stagedDeviceCount: finalDeviceCount,
      diagnostics: result.diagnostics,
      historyPlanId: historyPlan.queryId,
      historyPlanEventCount: historyPlan.eventCount,
      historyPlanBaselineId: activeSnapshotId,
      historyPlanBaselineSignature: historyPlan.snapshotSignature,
      consumeDevices: true,
      sourceFiles: Object.entries(files).filter(([, file]) => file).map(([role, file]) => ({ role, name: file.name, size: file.size, lastModified: file.lastModified || 0, date: fileObservationDate(file, tables[role]?.workbookCreatedAt, tables[role]?.workbookModifiedAt) })),
      originalFiles: Object.entries(files).filter(([, file]) => file).map(([role, file]) => ({ role, file })),
    }).catch(async (error) => {
      error.batchStage = "атомарное сохранение Final";
      if (historicalSwitchChangeQueryId) await database.clearAnalyticsAggregateQuery(historicalSwitchChangeQueryId).catch(() => {});
      throw error;
    });
  } finally {
    if (historyPlan?.queryId) await database.clearAnalyticsAggregateQuery(historyPlan.queryId).catch(() => {});
    await database.clearAnalyticsAggregateQuery(stagedDeviceQueryId).catch(() => {});
  }
  if (!metadata.reused) recordOperationDuration("enrichment", metadata.processingTimeMs);
  result.diagnostics.historyComparison = metadata.diagnostics?.historyComparison || null;
  // The saved Final is now the durable owner of the staged device records.
  if (!includeSwitchIpReport) {
    result.historicalAddressIndex = null;
    result.historicalRoomIndex = null;
    result.importedSmartroomRoomIndex = null;
  }
  recordLocalNotification("analysis", "Объединение данных завершено", `Сохранён Final: ${finalDeviceCount.toLocaleString("ru-RU")} устройств.`, "success").catch(showError);
  return { ...result, presentation, metadata, historicalSwitchChangeQueryId, historicalSwitchChangeTotal };
}

function recordOperationDuration(operation, durationMs) {
  database.recordPerformanceMetric(operation, durationMs).catch(() => {});
}

async function renderPerformanceMetrics() {
  const status = $("#performanceMetricsStatus");
  const host = $("#performanceMetricsTable");
  if (!status || !host) return;
  status.textContent = "Чтение локальных метрик…";
  const rows = await database.performanceStatistics({ days: 7 });
  status.textContent = `${rows.reduce((sum, row) => sum + row.count, 0).toLocaleString("ru-RU")} операций за последние 7 дней`;
  host.innerHTML = rows.length
    ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Операция</th><th>Запусков</th><th>Среднее</th><th>Минимум</th><th>Максимум</th><th>Последний запуск</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.operation)}</td><td>${row.count.toLocaleString("ru-RU")}</td><td>${(row.averageMs / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} с</td><td>${(row.minMs / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} с</td><td>${(row.maxMs / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} с</td><td>${escapeHtml(new Date(row.latestAt).toLocaleString("ru-RU"))}</td></tr>`).join("")}</tbody></table></div>`
    : '<p class="empty">Метрик пока нет. Успешные обогащения и экспорты будут учитываться локально.</p>';
}

async function renderImportedDailyStatistics() {
  const status = $("#legacyDailyStatisticsStatus");
  const canvas = $("#legacyDailyStatisticsChart");
  const host = $("#legacyDailyStatisticsTable");
  if (!status || !canvas || !host) return;
  status.textContent = "Чтение импортированных сводок за 30 дней…";
  host.replaceChildren();
  const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const through = new Date().toISOString().slice(0, 10);
  const accumulator = createLegacyDailyStatisticsAccumulator({ fromDate: from, throughDate: through });
  let cursor = null;
  while (true) {
    const page = await database.legacyObservationPage({ kind: "daily_stats", cursor, limit: 100 });
    let outsideRange = false;
    for (const row of page.rows) {
      if (String(row.observedAt || "").slice(0, 10) < from) { outsideRange = true; break; }
      accumulator.add(row);
    }
    if (outsideRange || !page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  const rows = accumulator.finish();
  canvas.hidden = rows.length === 0;
  if (!rows.length) {
    status.textContent = "Импортированных дневных сводок за последние 30 дней нет.";
    host.innerHTML = '<p class="empty">Импортируйте SQLite-базу, содержащую daily_stats.</p>';
    return;
  }
  drawLegacyDailyStatistics(canvas, rows);
  status.textContent = `${rows.length.toLocaleString("ru-RU")} дней с импортированной статистикой · ${rows[0].date} — ${rows.at(-1).date}`;
  const columns = [
    ["date", "Дата"], ["totalDevices", "Всего устройств"], ["newDevices", "Новые устройства"],
    ["vendorsCount", "Производителей"], ["roomsCount", "Помещений"],
    ["devicesWithAddress", "С адресом"], ["devicesWithRoom", "С помещением"],
  ];
  host.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map(([field]) => `<td>${escapeHtml(row[field].toLocaleString("ru-RU"))}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

async function renderApplicationLog() {
  const host = $("#applicationLogEntries");
  if (!host) return;
  const entries = await database.applicationLog();
  host.innerHTML = entries.length
    ? `<ul class="diagnostic-events">${[...entries].reverse().map((entry) => `<li><strong>${escapeHtml(entry.event)}</strong><span>${escapeHtml(entry.errorName || "—")} · ${escapeHtml(new Date(entry.timestamp).toLocaleString("ru-RU"))}</span></li>`).join("")}</ul>`
    : '<p class="empty">Событий приложения пока нет.</p>';
}

async function loadHistoricalAddressDetailsPage(candidateIps, offset = 0, limit = 100) {
  const page = await database.switchAddressEvidenceIpsPage(offset, limit, candidateIps);
  const accumulator = createHistoricalAddressAccumulator();
  await database.forEachSwitchAddressEvidenceForIps(page.ips, (record) => accumulator.add(record));
  return { ...page, rows: [...accumulator.finish().values()] };
}

function historicalAddressDetails(appliedCount, page) {
  if (!page?.total) return "";
  const end = Math.min(page.offset + page.ips.length, page.total);
  const rows = page.rows.map((item) => `<tr><td>${escapeHtml(item.switchIp)}</td><td>${item.status === "confirmed" ? "Подтверждено" : "Нужна проверка"}</td><td>${escapeHtml(item.address || item.alternatives.map((value) => value.address).join(" / ") || "—")}</td><td>${Math.round(item.confidence * 100)}%</td><td>${item.evidence.map((record) => `${escapeHtml(record.snapshotName)} · ${record.deviceCount} устройств`).join("<br>")}</td></tr>`).join("");
  const pager = page.total > page.limit
    ? `<div class="action-row"><span class="muted">Показано ${page.offset + 1}–${end} из ${page.total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-historical-address-offset="${Math.max(0, page.offset - page.limit)}" ${page.offset > 0 ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-historical-address-offset="${page.offset + page.limit}" ${end < page.total ? "" : "disabled"}>Дальше</button></div>`
    : "";
  return `<div data-historical-address-details><details><summary>IP коммутатора → адрес по прошлым Final: применено ${appliedCount}, кандидатов ${page.total.toLocaleString("ru-RU")}</summary><div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>IP коммутатора</th><th>Решение</th><th>Адрес</th><th>Уверенность</th><th>Основания</th></tr></thead><tbody>${rows}</tbody></table></div>${pager}</details></div>`;
}

function bindHistoricalAddressPager(container, appliedCount, candidateIps) {
  container?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-historical-address-offset]");
    if (!button || button.disabled) return;
    const nextOffset = Number(button.dataset.historicalAddressOffset);
    button.disabled = true;
    loadHistoricalAddressDetailsPage(candidateIps, nextOffset).then((page) => {
      if (!container.isConnected) return;
      const replacement = document.createElement("div");
      replacement.innerHTML = historicalAddressDetails(appliedCount, page);
      const nextContainer = replacement.firstElementChild;
      if (!nextContainer) return;
      container.replaceWith(nextContainer);
      bindHistoricalAddressPager(nextContainer, appliedCount, candidateIps);
    }).catch(showError);
  });
}

function bindMappingIndexPager(container, selector, dataKey, renderPage) {
  container?.addEventListener("click", (event) => {
    const button = event.target.closest(selector);
    if (!button || button.disabled) return;
    const offset = Math.max(0, Math.floor(Number(button.dataset[dataKey]) || 0));
    button.disabled = true;
    const replacement = document.createElement("div");
    replacement.innerHTML = renderPage(offset);
    const nextContainer = replacement.firstElementChild;
    if (!nextContainer) return;
    container.replaceWith(nextContainer);
    bindMappingIndexPager(nextContainer, selector, dataKey, renderPage);
  });
}

function historicalSmartroomDetails(index, appliedCount, offset = 0, expanded = false) {
  if (!index?.size) return "";
  const page = mappingIndexPage(index, { offset, limit: 100 });
  let rows = "";
  for (const item of page.rows) {
    rows += `<tr><td>${escapeHtml(item.smartroomId)}</td><td>${item.status === "confirmed" ? "Подтверждено" : "Нужна проверка"}</td><td>${escapeHtml(item.room || item.alternatives.map((value) => value.room).join(" / ") || "—")}</td><td>${escapeHtml(item.snapshotName)} · ${escapeHtml(item.createdAt)}</td><td>${item.sampleMacs.map(escapeHtml).join("<br>")}</td></tr>`;
  }
  const end = Math.min(page.offset + page.rows.length, page.total);
  const pager = page.total > page.limit
    ? `<div class="action-row"><span class="muted">Показано ${page.offset + 1}–${end} из ${page.total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-historical-smartroom-page="${Math.max(0, page.offset - page.limit)}" ${page.hasPrevious ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-historical-smartroom-page="${page.offset + page.limit}" ${page.hasNext ? "" : "disabled"}>Дальше</button></div>`
    : "";
  return `<div data-historical-smartroom-details><details ${expanded ? "open" : ""}><summary>Smartroom ID → помещение по последнему успешному Final: применено ${appliedCount}, ID ${page.total.toLocaleString("ru-RU")}</summary><div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>Smartroom ID</th><th>Решение</th><th>Помещение</th><th>Источник Final</th><th>MAC примеры</th></tr></thead><tbody>${rows}</tbody></table></div>${pager}</details></div>`;
}

function importedSmartroomDetails(index, appliedCount, offset = 0, expanded = false) {
  if (!index?.size) return "";
  const page = mappingIndexPage(index, { offset, limit: 100 });
  let rows = "";
  for (const item of page.rows) {
    rows += `<tr><td>${escapeHtml(item.smartroomId)}</td><td>${item.status === "confirmed" ? "Подтверждено" : "Конфликт · нужна проверка"}</td><td>${escapeHtml(item.room || item.alternatives.map((value) => value.room).join(" / ") || "—")}</td><td>${escapeHtml(item.source || "SQLite import")}</td><td>${escapeHtml(item.updatedAt || "—")}</td></tr>`;
  }
  const end = Math.min(page.offset + page.rows.length, page.total);
  const pager = page.total > page.limit
    ? `<div class="action-row"><span class="muted">Показано ${page.offset + 1}–${end} из ${page.total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-imported-smartroom-page="${Math.max(0, page.offset - page.limit)}" ${page.hasPrevious ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-imported-smartroom-page="${page.offset + page.limit}" ${page.hasNext ? "" : "disabled"}>Дальше</button></div>`
    : "";
  return `<div data-imported-smartroom-details><details ${expanded ? "open" : ""}><summary>Импортированные SQLite-маппинги Smartroom: применено ${appliedCount}, требуется проверка ${page.reviewCount.toLocaleString("ru-RU")} из ${page.total.toLocaleString("ru-RU")}</summary><div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>Smartroom ID</th><th>Решение</th><th>Помещение</th><th>Источник</th><th>Обновлено</th></tr></thead><tbody>${rows}</tbody></table></div>${pager}</details></div>`;
}

function historicalSwitchChangeDetails(page) {
  if (!page.total) return "";
  const rows = page.rows.map((item) => `<tr><td>${escapeHtml(item.mac || item.id)}</td><td>${escapeHtml(item.previousIp)}</td><td>${escapeHtml(item.currentIp)}</td><td>${escapeHtml(item.deviceIp || "—")}</td><td>${escapeHtml(item.possibleIps.join(", ") || "—")}</td><td>${escapeHtml(item.identityConflicts.join(", ") || "—")}</td><td>${escapeHtml(item.lastSeen || "—")}</td></tr>`).join("");
  const pager = page.total > page.limit ? `<div class="action-row"><span class="muted">Показано ${page.offset + 1}–${Math.min(page.offset + page.rows.length, page.total)} из ${page.total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-switch-ip-change-offset="${Math.max(0, page.offset - page.limit)}" ${page.hasPrevious ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-switch-ip-change-offset="${page.offset + page.limit}" ${page.hasNext ? "" : "disabled"}>Дальше</button></div>` : `<p class="muted">Устройств: ${page.total.toLocaleString("ru-RU")}</p>`;
  return `<details open><summary>Изменения IP коммутатора по сохранённой истории: ${page.total.toLocaleString("ru-RU")}</summary><p class="notice">Сравнение выполнено с последним сохранённым состоянием устройства до записи этого Final. IP устройства и возможные IP из DDIO показаны отдельно; подсказки не меняют данные. Совпадения по Device ID, serial или MAC с другими конфликтующими сильными идентификаторами отмечены в последнем столбце.</p><div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>MAC</th><th>IP коммутатора ранее</th><th>IP коммутатора сейчас</th><th>IP устройства</th><th>Possible IPs (DDIO)</th><th>Несогласованные идентификаторы</th><th>Последнее наблюдение</th></tr></thead><tbody>${rows}</tbody></table></div>${pager}</details>`;
}

async function loadSwitchIpChangeReportPage(host, offset) {
  const queryId = state.switchIpChangeQueryId;
  if (!queryId || !host) return;
  const request = ++state.switchIpChangePageRequest;
  const page = await database.switchIpReportChangesPage(queryId, { offset, limit: 100 });
  if (request !== state.switchIpChangePageRequest || queryId !== state.switchIpChangeQueryId || !host.isConnected) return;
  state.switchIpChangesOffset = page.offset;
  state.switchIpChangeTotal = page.total;
  host.innerHTML = historicalSwitchChangeDetails(page);
}

async function runEnrichment() {
  clearError();
  if (!state.sourceTables.main) throw new Error("Выберите основной файл");
  const mappingIssues = [
    ...batchMappingProblems("main", state.mappings.main, { rowCount: state.sourceTables.main.rowCount }),
    ...(state.sourceTables.smartroom && state.sourceTables.smartroom.rowCount !== 0 ? batchMappingProblems("smartroom", state.mappings.smartroom) : []),
    ...(state.sourceTables.ddio && state.sourceTables.ddio.rowCount !== 0 ? batchMappingProblems("ddio", state.mappings.ddio) : []),
  ];
  if (mappingIssues.length) throw new Error(`Проверьте сопоставление колонок:\n${mappingIssues.join("\n")}`);
  const roleLabels = { main: "Main", smartroom: "SmartRoom", ddio: "DDIO" };
  const mappingSummary = ["main", "smartroom", "ddio"]
    .filter((role) => state.sourceTables[role])
    .map((role) => {
      const table = state.sourceTables[role];
      const fields = Object.entries(state.mappings[role] || {}).filter(([, index]) => Number.isInteger(index))
        .map(([field, index]) => `${FIELD_LABELS[field] || field} → ${excelColumnLabel(index)} · ${text(table.headers[index]) || `Колонка ${index + 1}`}`);
      return `${roleLabels[role]} (${state.sourceFiles[role]?.name || "файл"}): ${fields.join("; ") || "нет выбранных колонок"}`;
    });
  if (!globalThis.confirm(`Проверьте сопоставление перед обогащением:\n\n${mappingSummary.join("\n")}\n\nЗапустить с этими настройками?`)) return;
  if (state.switchIpChangeQueryId) {
    const previousQueryId = state.switchIpChangeQueryId;
    state.switchIpChangeQueryId = "";
    state.switchIpChangePageRequest += 1;
    await database.clearAnalyticsAggregateQuery(previousQueryId).catch(showError);
  }
  state.controller = new AbortController();
  const strategy = $("input[name='strategy']:checked").value;
  const result = await executeEnrichment({
    tables: state.sourceTables,
    mappings: state.mappings,
    files: state.sourceFiles,
    name: `Final ${state.sourceFiles.main.name}`,
    strategy,
    includeSwitchIpReport: true,
  });
  state.switchIpChangeQueryId = result.historicalSwitchChangeQueryId || "";
  state.switchIpChangeTotal = result.historicalSwitchChangeTotal || 0;
  state.switchIpChangesOffset = 0;
  state.switchIpChangePageRequest += 1;
  let switchIpChangePage = { rows: [], total: 0, offset: 0, limit: 100, hasPrevious: false, hasNext: false };
  if (state.switchIpChangeQueryId) {
    try { switchIpChangePage = await database.switchIpReportChangesPage(state.switchIpChangeQueryId, { limit: 100 }); }
    catch (error) { showError(error); }
  }
  $("#enrichmentSummary").classList.remove("empty");
  const { historicalAddressSummary, appliedSmartroomSummary } = result.presentation;
  const historicalAddressCandidates = historicalAddressSummary.candidateIps;
  const appliedHistoricalAddressIps = historicalAddressSummary.appliedCount;
  let historicalAddressPage = null;
  try { historicalAddressPage = await loadHistoricalAddressDetailsPage(historicalAddressCandidates); }
  catch (error) { showError(error); }
  $("#enrichmentSummary").innerHTML = `<h3>${result.metadata.reused ? "Этот набор файлов уже объединён" : "Final успешно сохранён"}</h3><p>Main raw: <strong>${result.diagnostics.counts.mainRaw}</strong> · Main unique: <strong>${result.diagnostics.counts.mainUnique}</strong> · после SmartRoom: <strong>${result.diagnostics.counts.afterSmartroom}</strong> · DDIO IP: <strong>${result.diagnostics.counts.ddioMatchedIp}</strong> · адрес из истории: <strong>${result.diagnostics.counts.historicalAddressFilled}</strong> · помещение по Smartroom ID из истории: <strong>${result.diagnostics.counts.historicalSmartroomRoomFilled}</strong> · Final: <strong>${result.diagnostics.counts.finalUnique}</strong></p><p>Несопоставленных: ${result.diagnostics.counts.unmatchedTotal ?? result.diagnostics.unmatched.length} (примеры ${result.diagnostics.unmatched.length}, пропущено ${result.diagnostics.counts.unmatchedTruncated || 0}) · конфликтов: ${result.diagnostics.counts.conflictsTotal ?? result.diagnostics.conflicts.length} (примеры ${result.diagnostics.conflicts.length}, пропущено ${result.diagnostics.counts.conflictsTruncated || 0}) · некорректных: ${result.diagnostics.counts.invalidTotal ?? result.diagnostics.invalid.length} (примеры ${result.diagnostics.invalid.length}, пропущено ${result.diagnostics.counts.invalidTruncated || 0})</p>${identityConflictDetails(result.diagnostics.conflicts, result.diagnostics.counts.identityConflictsTotal)}${finalHistoryComparisonDetails(result.diagnostics.historyComparison)}<div data-switch-ip-change-container>${historicalSwitchChangeDetails(switchIpChangePage)}</div>${historicalAddressDetails(appliedHistoricalAddressIps, historicalAddressPage)}${historicalSmartroomDetails(result.historicalRoomIndex, appliedSmartroomSummary.historicalCount)}${importedSmartroomDetails(result.importedSmartroomRoomIndex, appliedSmartroomSummary.importedCount)}`;
  bindHistoricalAddressPager($("#enrichmentSummary [data-historical-address-details]"), appliedHistoricalAddressIps, historicalAddressCandidates);
  bindMappingIndexPager(
    $("#enrichmentSummary [data-historical-smartroom-details]"),
    "[data-historical-smartroom-page]",
    "historicalSmartroomPage",
    (offset) => historicalSmartroomDetails(result.historicalRoomIndex, appliedSmartroomSummary.historicalCount, offset, true),
  );
  bindMappingIndexPager(
    $("#enrichmentSummary [data-imported-smartroom-details]"),
    "[data-imported-smartroom-page]",
    "importedSmartroomPage",
    (offset) => importedSmartroomDetails(result.importedSmartroomRoomIndex, appliedSmartroomSummary.importedCount, offset, true),
  );
  await refreshDatabaseState();
  finishProgress("Final сохранён");
}

function dashboardFilterSettingsFromControls() {
  return {
    query: $("#analyticsDashboardSearch").value,
    manufacturer: $("#analyticsDashboardManufacturer").value,
    room: $("#analyticsDashboardRoom").value,
    status: $("#analyticsDashboardStatus").value,
  };
}

function syncDashboardFilterControls(filters = state.analyticsDashboardSettings.filters) {
  const normalized = normalizeAnalyticsDashboardSettings({ filters }).filters;
  $("#analyticsDashboardSearch").value = normalized.query;
  $("#analyticsDashboardManufacturer").value = normalized.manufacturer;
  $("#analyticsDashboardRoom").value = normalized.room;
  $("#analyticsDashboardStatus").value = normalized.status;
}

function selectDashboardKpiStatus(key, analytics = state.analytics) {
  const status = dashboardStatusForKpi(key);
  if (!status || !analytics?.comparison) return;
  const filters = { ...dashboardFilterSettingsFromControls(), status };
  $("#analyticsDashboardStatus").value = status;
  return saveAnalyticsDashboardSettings({ ...state.analyticsDashboardSettings, filters }).then(async () => {
    if (state.analytics !== analytics) return;
    if (key === "modified") await showAnalyticsModificationPage(analytics, 0, false, true);
    if (key === "absent") await showAnalyticsAbsencePage(analytics, 0, true);
    if (key === "unchanged") await renderAnalyticsUnchangedPage(analytics, 0, true);
    return renderAnalytics(true);
  }).catch(showError);
}

async function showDashboardAggregateDialog(key, analytics) {
  const field = key === "manufacturers" ? "manufacturer" : "room";
  if (analytics?.dashboardFilters?.status !== "all") {
    await selectDashboardKpiStatus(key, analytics);
    analytics = state.analytics;
  }
  if (!analytics) return;
  const dialog = $("#detailsDialog");
  dialog.querySelector("[data-dialog-title]").textContent = field === "manufacturer" ? "Производители выбранного Final" : "Помещения выбранного Final";
  dialog.querySelector("[data-dialog-content]").innerHTML = '<p class="muted" role="status">Рассчитываю полный список…</p>';
  if (!dialog.open) dialog.showModal();
  let attempts = 0;
  while (state.analytics === analytics && !analytics.detailsReady && attempts < 1800) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    attempts += 1;
  }
  if (state.analytics !== analytics || !analytics.detailsReady) {
    dialog.querySelector("[data-dialog-content]").innerHTML = '<p class="empty">Детализация не рассчитана. Обновите аналитику и повторите открытие.</p>';
    return;
  }
  const queryId = analytics.dataset?.clusters?.queryId;
  if (queryId) {
    const detail = {
      field,
      analytics,
      queryId,
      metric: field === "manufacturer" ? "vendor" : "occupancy-room",
      limit: 100,
      pageCursors: [null],
      offset: 0,
      items: [],
    };
    state.dashboardAggregateDetail = detail;
    await loadDashboardAggregatePage(detail, 0);
    return;
  }
  const items = field === "manufacturer"
    ? (analytics.dataset?.charts?.vendors || analytics.vendors || [])
    : (analytics.dataset?.roomOccupancy?.rooms || []).map((item) => ({ label: item.label, value: item.count }));
  state.dashboardAggregateDetail = { field, items, offset: 0, analytics };
  dialog.querySelector("[data-dialog-content]").innerHTML = dashboardAggregateDialogContent(items, { field, offset: 0 });
}

async function loadDashboardAggregatePage(detail, pageIndex) {
  if (!detail?.queryId || !Number.isSafeInteger(pageIndex) || pageIndex < 0) return;
  const cursor = detail.pageCursors[pageIndex];
  if (pageIndex > 0 && !cursor) return;
  const requestId = (detail.requestId || 0) + 1;
  detail.requestId = requestId;
  const result = await database.analyticsAggregateRankedPage(detail.queryId, detail.metric, {
    after: cursor,
    limit: detail.limit,
  });
  if (detail.requestId !== requestId || state.dashboardAggregateDetail !== detail || state.analytics !== detail.analytics) return;
  detail.offset = pageIndex * detail.limit;
  detail.pageIndex = pageIndex;
  detail.total = result.total;
  detail.hasPrevious = pageIndex > 0;
  detail.hasNext = result.hasMore;
  detail.items = result.rows.map(({ value, count }) => ({ label: value, value: count }));
  detail.pageCursors[pageIndex + 1] = result.hasMore ? result.nextCursor : null;
  $("#detailsDialog [data-dialog-content]").innerHTML = dashboardAggregateDialogContent(detail.items, {
    field: detail.field,
    offset: detail.offset,
    limit: detail.limit,
    total: detail.total,
    hasPrevious: detail.hasPrevious,
    hasNext: detail.hasNext,
  });
}

async function showDashboardFleetDialog(analytics) {
  if (!analytics) return;
  const dialog = $("#detailsDialog");
  const content = dialog.querySelector("[data-dialog-content]");
  const showContent = (value) => {
    dialog.querySelector("[data-dialog-title]").textContent = "Динамика устройств по Final";
    content.innerHTML = value;
    if (!dialog.open) dialog.showModal();
  };
  if (!analytics.detailsReady) {
    showContent('<p class="muted" role="status">Считаю число уникальных MAC и динамику Final по полной истории…</p>');
    let attempts = 0;
    while (state.analytics && !state.analytics.detailsReady && attempts < 1800) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempts += 1;
    }
    analytics = state.analytics;
    if (!analytics?.detailsReady) {
      showContent('<p class="empty">Историю Final не удалось рассчитать. Проверьте статус аналитики и повторите открытие.</p>');
      return;
    }
  }
  const fleet = buildDashboardFleetSeries(analytics, state.snapshotMetadata);
  state.dashboardFleet = fleet;
  state.dashboardFleetOffset = 0;
  showContent(dashboardFleetDialogContent(fleet, { offset: 0 }));
}

function renderDashboardFilterOptions(devices = [], suppliedOptions = null) {
  const options = suppliedOptions || dashboardFilterOptions(devices);
  const filters = state.analyticsDashboardSettings.filters;
  const renderOptions = (rows, selected, allLabel) => {
    const values = new Set(rows);
    if (selected && !values.has(selected)) values.add(selected);
    const ordered = [...values].sort((left, right) => left.localeCompare(right, "ru", { sensitivity: "base" }) || left.localeCompare(right));
    return `<option value="">${allLabel}</option>${ordered.map((value) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}${rows.includes(value) ? "" : " (нет в выбранном Final)"}</option>`).join("")}`;
  };
  $("#analyticsDashboardManufacturer").innerHTML = renderOptions(options.manufacturers, filters.manufacturer, "Все производители");
  $("#analyticsDashboardRoom").innerHTML = renderOptions(options.rooms, filters.room, "Все помещения");
  syncDashboardFilterControls(filters);
}
function renderSnapshotSelectors() {
  const items = state.snapshotMetadata.map((snapshot) => ({ value: snapshot.id, label: `${snapshot.name} · ${snapshot.deviceCount}` }));
  const defaults = defaultSnapshotSelection(state.snapshotMetadata);
  renderSelect($("#baseSnapshotSelect"), items, $("#baseSnapshotSelect").value || defaults.baseId, "Нет базового Final");
  renderSelect($("#currentSnapshotSelect"), items, $("#currentSnapshotSelect").value || defaults.currentId, "Нет текущего Final");
  renderSelect($("#changeReportBaseSnapshotSelect"), items, $("#changeReportBaseSnapshotSelect").value || defaults.baseId, "Нет базового Final");
  renderSelect($("#changeReportCurrentSnapshotSelect"), items, $("#changeReportCurrentSnapshotSelect").value || defaults.currentId, "Нет текущего Final");
  $("#dashboardComparisonMode").value = state.analyticsDashboardSettings.comparisonMode || "snapshots";
  $("#dashboardComparisonDateFrom").value = state.analyticsDashboardSettings.comparisonDateFrom || "";
  $("#dashboardComparisonDateTo").value = state.analyticsDashboardSettings.comparisonDateTo || "";
  syncDashboardComparisonControls();
}

const analyticsIdleScheduler = createAnalyticsIdleScheduler({ onError: showError });

function invalidateAnalyticsRequests() {
  analyticsIdleScheduler.cancel();
  state.analyticsRequests.invalidate();
}

function scheduleIdleAnalytics(callback) {
  return analyticsIdleScheduler.schedule(callback);
}

async function loadTopologyAggregateNodes(queryId, switchRows, pageSize = 50) {
  return Promise.all(switchRows.map(async (row) => {
    const switchIp = row.value;
    const [ports, rooms] = await Promise.all([
      database.analyticsAggregateValuePage(queryId, `topology-port:${switchIp}`, { limit: pageSize }),
      database.analyticsAggregateValuePage(queryId, `topology-room:${switchIp}`, { limit: pageSize }),
    ]);
    return {
      switchIp,
      deviceCount: Number(row.count || 0),
      portCount: ports.total,
      ports: ports.rows.map((item) => ({ port: item.value, deviceCount: item.count })),
      portPageData: { page: 0, firstCursor: ports.firstCursor, nextCursor: ports.nextCursor, hasMore: ports.hasMore },
      rooms: rooms.rows.map((item) => item.value),
      roomCount: rooms.total,
      roomPageData: { page: 0, firstCursor: rooms.firstCursor, nextCursor: rooms.nextCursor, hasMore: rooms.hasMore },
      sampleMacs: [],
    };
  }));
}

async function calculateAnalyticsDetails(analytics, revision, metadata, historySignature, force, missingPositionMask = null, currentStatusMask = null) {
  const loading = $("#analyticsLoadingStatus");
  const stage = (message) => { if (loading && state.analyticsRequests.isCurrent(revision)) loading.textContent = message; };
  stage("Расчёт статистики по времени…");
  await renderTemporalStatistics(false);
  if (!state.analyticsRequests.isCurrent(revision)) return null;
  stage("Подготовка истории выбранных Final…");
  const historyFilters = {
    query: analytics.dashboardFilters?.query || "",
    manufacturer: analytics.dashboardFilters?.manufacturer || "",
    room: analytics.dashboardFilters?.room || "",
  };
  let history = force ? null : await database.loadSnapshotHistoryCache(historySignature, historyFilters);
  if (!history) {
    stage("Агрегация истории Final по чанкам…");
    const visitHistoryChunks = async (snapshotId, visit, _snapshot, index) => {
      progress(index / Math.max(1, metadata.length) * 90, "Обработка истории Final " + (index + 1) + " из " + metadata.length, "Аналитика");
      await database.forEachSnapshotChunk(snapshotId, visit, {
        onProgress: ({ phase, index: chunkIndex, chunkCount, visitedDevices, deviceCount }) => {
          if (phase === "chunk-start") stage(`Чтение истории Final ${index + 1}/${metadata.length}, чанка ${chunkIndex + 1}/${chunkCount}: ${visitedDevices.toLocaleString("ru-RU")} из ${deviceCount.toLocaleString("ru-RU")}…`);
          else if (phase === "chunk-result") stage(`Ответ IndexedDB для истории Final ${index + 1}/${metadata.length}, чанка ${chunkIndex + 1}/${chunkCount} получен; обрабатываю…`);
          else if (phase === "chunk-ready") stage(`Обработка истории Final ${index + 1}/${metadata.length}, чанка ${chunkIndex + 1}/${chunkCount} (${visitedDevices.toLocaleString("ru-RU")} устройств)…`);
        },
      });
    };
    history = await aggregateSnapshotHistoryInWorker(metadata, visitHistoryChunks, {
      isCurrent: () => state.analyticsRequests.isCurrent(revision),
      filters: historyFilters,
      onProgress: ({ phase, snapshot, snapshotIndex, snapshotCount, deviceCount, chunkIndex, chunkCount, error }) => {
        if (phase === "worker-start") stage(`Worker истории Final ${snapshotIndex + 1}/${snapshotCount}, чанк ${chunkIndex + 1}/${chunkCount}: обрабатывает ${deviceCount.toLocaleString("ru-RU")} устройств…`);
        if (phase === "chunk-complete") stage(`История Final ${snapshotIndex + 1}/${snapshotCount}: прочитано ${deviceCount} устройств из блока «${snapshot.name || snapshot.id}»…`);
        else if (phase === "worker-error") stage(error);
        else if (phase === "snapshot-complete") stage(`История Final: завершён снимок ${snapshotIndex + 1}/${snapshotCount} «${snapshot.name || snapshot.id}»…`);
        else if (phase === "finish-start") stage(`Завершение истории и сводок для ${snapshotCount} Final…`);
        else if (phase === "finish-complete") stage("История Final и сводки готовы…");
      },
    });
    if (!state.analyticsRequests.isCurrent(revision)) return null;
    if (!history) history = await aggregateSnapshotHistory(metadata, visitHistoryChunks, { filters: historyFilters });
    if (!state.analyticsRequests.isCurrent(revision)) return null;
    await database.saveSnapshotHistoryCache(historySignature, history, historyFilters);
  }
  if (!state.analyticsRequests.isCurrent(revision)) return null;
  stage("Подготовка сводок и агрегатов выбранного статуса…");
  const dashboardStatus = analytics.dashboardFilters?.status || "all";
  const datasetSnapshotId = dashboardStatus === "missing" ? analytics.previous?.id || "" : analytics.current?.id || "";
  const datasetCacheSnapshotId = `${datasetSnapshotId}:dashboard:${dashboardStatus}`;
  const datasetCacheKey = `selected-final-dataset-v7:${JSON.stringify(analytics.comparisonPairSignature || analytics.dashboardFilters || {})}`;
  const cachedDataset = force ? null : await database.loadAnalyticsCache(datasetCacheKey, historySignature, 7);
  if (!state.analyticsRequests.isCurrent(revision)) return null;
  let dataset = cachedDataset?.snapshotId === datasetCacheSnapshotId ? cachedDataset.dataset : null;
  if (!dataset) {
    const clusterFields = ["vendor", "room", "switchIp"];
    const clusterQueryId = datasetSnapshotId ? `analytics-final-v2:${datasetCacheSnapshotId}:${JSON.stringify(analytics.dashboardFilters || {})}` : "";
    if (clusterQueryId) await database.clearAnalyticsAggregateQuery(clusterQueryId);
    const datasetCollector = createDatasetAnalyticsCollector({ includeTopologyDevices: false, includeTopologySummary: !clusterQueryId, includeClusters: !clusterQueryId, includeRankings: !clusterQueryId, clusterFields });
    let rowsProcessed = 0;
    const acceptStatusChunk = (chunk = [], startOffset = 0) => {
      if (dashboardStatus === "missing") return chunk.filter((_device, index) => missingPositionMask?.[startOffset + index] === 1);
      if (dashboardStatus !== "changed" && dashboardStatus !== "unchanged") return chunk;
      const expectedStatus = CURRENT_STATUS_MASK[dashboardStatus];
      return chunk.filter((_device, index) => currentStatusMask?.[startOffset + index] === expectedStatus);
    };
    await feedAnalyticsDatasetRows({
      snapshotId: datasetSnapshotId,
      devices: datasetSnapshotId ? undefined : analytics.devices,
      visitChunks: (snapshotId, visit) => database.forEachSnapshotChunk(snapshotId, visit, {
        onProgress: ({ phase, index, chunkCount, visitedDevices, deviceCount }) => {
          if (phase === "chunk-start") stage(`Чтение чанка ${index + 1}/${chunkCount} Final: ${visitedDevices.toLocaleString("ru-RU")} из ${deviceCount.toLocaleString("ru-RU")}…`);
          else if (phase === "chunk-result") stage(`Ответ IndexedDB для чанка ${index + 1}/${chunkCount} получен; обрабатываю…`);
        },
      }),
      isCurrent: () => state.analyticsRequests.isCurrent(revision),
      accept: async (chunk, startOffset = 0) => {
        const selectedChunk = acceptStatusChunk(chunk, startOffset);
        if (!selectedChunk.length) return;
        datasetCollector.accept(selectedChunk);
        const pendingRowsProcessed = rowsProcessed + selectedChunk.length;
        if (clusterQueryId) {
          stage(`Сохранение агрегатов выбранного статуса: ${pendingRowsProcessed.toLocaleString("ru-RU")} из ${Number(analytics.dashboardFilteredDeviceCount ?? analytics.current?.deviceCount ?? 0).toLocaleString("ru-RU")} устройств…`);
          await database.mergeAnalyticsAggregateBatches(clusterQueryId, {
            cluster: collectClusterBuckets(selectedChunk, clusterFields),
            ...collectAnalyticsBuckets(selectedChunk),
            ...collectTopologyBuckets(selectedChunk),
          });
        }
        rowsProcessed = pendingRowsProcessed;
        stage(`Сводки выбранного статуса: ${rowsProcessed.toLocaleString("ru-RU")} из ${Number(analytics.dashboardFilteredDeviceCount ?? analytics.current?.deviceCount ?? 0).toLocaleString("ru-RU")} устройств сохранены…`);
      },
    });
    if (!state.analyticsRequests.isCurrent(revision)) {
      return null;
    }
    stage("Завершение рейтингов, комнат и топологии…");
    dataset = datasetCollector.finish();
    if (clusterQueryId) {
      const metricNames = ["vendor", "model", "room", "smartroom", "switch", "occupancy-room"];
      const [page, ...metricResults] = await Promise.all([
        database.analyticsAggregatePage(clusterQueryId, "cluster", { limit: 50 }),
        ...metricNames.map(async (metric) => ({ metric, rows: await database.analyticsAggregateTop(clusterQueryId, metric, 50) })),
      ]);
      const pageItems = page.rows.map((row) => ({ ...row.data, id: row.value, count: row.count }));
      const tops = Object.fromEntries(metricResults.map(({ metric, rows }) => [metric, rows]));
      const countMetrics = ["known-vendor", "model", "room-identity", "smartroom", "switch", "occupancy-room"];
      const counts = Object.fromEntries(await Promise.all(countMetrics.map(async (metric) => [metric, await database.analyticsAggregateCount(clusterQueryId, metric)])));
      dataset.clusters = {
        ...dataset.clusters,
        fields: clusterFields,
        items: pageItems,
        pageItems,
        page: 0,
        pageTotal: page.total,
        pageHasMore: page.hasMore,
        nextCursor: page.nextCursor,
        queryId: clusterQueryId,
        summary: { clusters: page.total, devices: dataset.summary.devices, largestCluster: page.rows[0]?.count || 0 },
      };
      applyAnalyticsAggregateView(dataset, { tops, counts });
      const switchPage = await database.analyticsAggregateRankedPage(clusterQueryId, "topology-switch", { limit: 20 });
      const topologyNodes = await loadTopologyAggregateNodes(clusterQueryId, switchPage.rows, 50);
      dataset.topology = {
        ...dataset.topology,
        nodes: topologyNodes,
        pageItems: topologyNodes,
        page: 0,
        pageTotal: switchPage.total,
        pageHasMore: switchPage.hasMore,
        firstCursor: switchPage.firstCursor,
        nextCursor: switchPage.nextCursor,
        queryId: clusterQueryId,
        summary: {
          ...dataset.topology.summary,
          switches: switchPage.total,
          ports: await database.analyticsAggregateCount(clusterQueryId, "topology-port-total"),
        },
      };
      stage("Сохранение рассчитанной сводки Dashboard…");
    }
    if (datasetSnapshotId) await database.saveAnalyticsCache(datasetCacheKey, historySignature, { snapshotId: datasetCacheSnapshotId, dataset }, 7, {
      onProgress: ({ phase }) => {
        const labels = {
          started: "Сохранение сводки: открыта транзакция…",
          "serialize-start": "Сохранение сводки: подготовка к IndexedDB…",
          "serialize-complete": "Сохранение сводки: данные подготовлены…",
          "put-complete": "Сохранение сводки: запись принята IndexedDB…",
          "transaction-complete": "Сохранение сводки: транзакция завершена…",
          complete: "Сводка Dashboard сохранена…",
        };
        if (labels[phase]) stage(labels[phase]);
      },
    });
  } else if (dataset.clusters?.queryId) {
    const page = await database.analyticsAggregatePage(dataset.clusters.queryId, "cluster", { limit: 50 });
    dataset.clusters.pageItems = page.rows.map((row) => ({ ...row.data, id: row.value, count: row.count }));
    dataset.clusters.page = 0;
    dataset.clusters.pageTotal = page.total;
    dataset.clusters.pageHasMore = page.hasMore;
    dataset.clusters.nextCursor = page.nextCursor;
  }
  const expectedDevices = Number(analytics.dashboardFilteredDeviceCount ?? analytics.current?.deviceCount ?? analytics.devices?.length ?? 0);
  if (dataset.summary.devices !== expectedDevices) throw new Error("Аналитика Final остановлена: число прочитанных устройств не совпало с метаданными снимка");
  delete analytics.comparison.statusClassifier;
  return {
    weekly: history.weekly,
    snapshotChanges: history.snapshotChanges,
    totals: history.totals,
    churn: history.churn,
    history: history.history,
    dataset,
  };
}

function scheduleAnalyticsDetails(analytics, revision, metadata, historySignature, force, missingPositionMask = null, currentStatusMask = null) {
  $("#analyticsLoadingStatus").hidden = false;
  return runAnalyticsInStages({
    calculatePair: async () => analytics,
    calculateDetails: (pair) => calculateAnalyticsDetails(pair, revision, metadata, historySignature, force, missingPositionMask, currentStatusMask),
    isCurrent: () => state.analyticsRequests.isCurrent(revision) && state.analytics === analytics,
    paintSummary: paintAnalyticsSummary,
    paintDetails: (pair, details) => {
      Object.assign(pair, details, { detailsReady: true });
      paintAnalyticsDetails(pair);
      $("#analyticsLoadingStatus").hidden = true;
      finishProgress("Аналитика рассчитана");
    },
    schedule: scheduleIdleAnalytics,
    onError: (error) => {
      state.analyticsAutoRefreshing = false;
      $("#analyticsLoadingStatus").hidden = true;
      showAnalyticsFallback(error, analytics.fallbackAnalytics);
    },
  });
}

async function ensureDashboardComparisonIndex(metadata, baselineMetadata, isCurrent = () => true) {
  if (!baselineMetadata) return { snapshotId: "", signature: "", restoredFieldCount: 0, ambiguousMatchCount: 0 };
  const baselineIndex = metadata.indexOf(baselineMetadata);
  const baselineSignature = finalAnalyticsIndexSignature(baselineMetadata);
  if (baselineIndex <= 0) {
    if (!await database.hasFinalAnalyticsIndex(baselineMetadata.id, baselineSignature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION)) {
      await database.saveFinalAnalyticsIndexFromSnapshot(
        baselineMetadata.id,
        baselineSignature,
        (visit) => database.forEachSnapshotChunk(baselineMetadata.id, visit),
        compactComparisonDevice,
        FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
      );
    }
    return { snapshotId: baselineMetadata.id, signature: baselineSignature, restoredFieldCount: 0, ambiguousMatchCount: 0 };
  }

  const historyMetadata = metadata.slice(0, baselineIndex);
  const indexedSnapshotId = `__mac_analyzer_comparison_backfill__:${baselineMetadata.id}`;
  const indexedSignature = JSON.stringify([
    "comparison-backfill-index",
    baselineSignature,
    historyMetadata.map((snapshot) => finalAnalyticsIndexSignature(snapshot)),
  ]);
  for (const snapshot of historyMetadata) {
    const historySignature = finalAnalyticsIndexSignature(snapshot);
    if (!await database.hasFinalAnalyticsIndex(snapshot.id, historySignature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION)) {
      await database.saveFinalAnalyticsIndexFromSnapshot(
        snapshot.id,
        historySignature,
        (visit) => database.forEachSnapshotChunk(snapshot.id, visit),
        compactComparisonDevice,
        FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
      );
    }
    if (!isCurrent()) return null;
  }

  let indexMetadata = await database.finalAnalyticsIndexMetadata(indexedSnapshotId, indexedSignature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION);
  if (!indexMetadata) {
    const backfillStats = { restoredFieldCount: 0, ambiguousMatchCount: 0 };
    await database.saveFinalAnalyticsIndexFromSnapshot(
      indexedSnapshotId,
      indexedSignature,
      (visit) => database.forEachSnapshotChunk(baselineMetadata.id, async (sourceChunk) => {
        for (const device of sourceChunk) trimComparisonDeviceInPlace(device);
        const restored = await backfillComparisonDevices(
          sourceChunk,
          historyMetadata,
          (snapshotId, snapshotVisit) => database.forEachSnapshotChunk(snapshotId, snapshotVisit),
          {
            inPlace: true,
            resolveSnapshotIdentityIndex: (snapshot, devices) => database.buildFinalAnalyticsIdentityIndex(
              snapshot.id,
              finalAnalyticsIndexSignature(snapshot),
              FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
              devices,
            ),
          },
        );
        backfillStats.restoredFieldCount += restored.restoredFieldCount;
        backfillStats.ambiguousMatchCount += restored.diagnostics.length;
        trimComparisonBaseline(restored.devices);
        await visit(restored.devices);
      }),
      null,
      FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
      backfillStats,
    );
    indexMetadata = await database.finalAnalyticsIndexMetadata(indexedSnapshotId, indexedSignature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION);
  }
  return {
    snapshotId: indexedSnapshotId,
    signature: indexedSignature,
    restoredFieldCount: Number(indexMetadata?.restoredFieldCount || 0),
    ambiguousMatchCount: Number(indexMetadata?.ambiguousMatchCount || 0),
  };
}

function syncDashboardComparisonControls() {
  const periodMode = $("#dashboardComparisonMode")?.value === "period";
  $("#dashboardPeriodSelectionControls").hidden = !periodMode;
  $("#dashboardSnapshotSelectionControls").hidden = periodMode;
}

async function renderAnalytics(force = false) {
  analyticsIdleScheduler.cancel();
  const fallbackAnalytics = usableAnalyticsFallback(state.analytics);
  $("#analyticsHistoryFallback").hidden = true;
  $("#analyticsHistoryFallback").textContent = "";
  if (!state.snapshotMetadata.length) {
    invalidateAnalyticsRequests();
    state.analytics = null;
    $("#analyticsKpis").innerHTML = '<p class="empty">Сначала выполните обогащение.</p>';
    $("#analyticsHistoryKpis").innerHTML = "";
    $("#datasetOverview").innerHTML = "";
    $("#changeTable").innerHTML = "";
    $("#analyticsLoadingStatus").hidden = true;
    return;
  }
  if (state.analytics && !force) {
    const revision = state.analyticsRequests.begin();
    if (state.analytics.detailsReady) {
      paintAnalyticsDetails(state.analytics);
      return;
    }
    if (state.analyticsDashboardSettings.filters.status !== "all") return renderAnalytics(true);
    const cachedMetadata = [...state.snapshotMetadata].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    return scheduleAnalyticsDetails(state.analytics, revision, cachedMetadata, snapshotHistorySignature(cachedMetadata), false);
  }
  const revision = state.analyticsRequests.begin();
  const metadata = [...state.snapshotMetadata].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  const historySignature = snapshotHistorySignature(metadata);
  const pair = resolveDashboardSnapshotPair(metadata, {
    comparisonMode: $("#dashboardComparisonMode").value,
    comparisonDateFrom: $("#dashboardComparisonDateFrom").value,
    comparisonDateTo: $("#dashboardComparisonDateTo").value,
    baseSnapshotId: $("#baseSnapshotSelect").value,
    currentSnapshotId: $("#currentSnapshotSelect").value,
  });
  $("#baseSnapshotSelect").value = pair.baselineId;
  $("#currentSnapshotSelect").value = pair.comparisonId;
  const currentMetadata = metadata.find((item) => item.id === pair.comparisonId) || metadata.at(-1);
  const currentIndex = currentMetadata ? metadata.indexOf(currentMetadata) : -1;
  const previousMetadata = metadata.find((item) => item.id === pair.baselineId) || metadata[currentIndex - 1];
  const previousIndex = await ensureDashboardComparisonIndex(metadata, previousMetadata, () => state.analyticsRequests.isCurrent(revision));
  if (!previousIndex) return;
  if (!state.analyticsRequests.isCurrent(revision)) return;
  const previous = { ...(previousMetadata || {}), devices: [], deviceCount: Number(previousMetadata?.deviceCount || 0) };
  const historyBackfill = {
    restoredFields: previousIndex.restoredFieldCount,
    ambiguousMatches: previousIndex.ambiguousMatchCount,
  };
  const dashboardFilters = state.analyticsDashboardSettings.filters;
  const deviceMatches = createDashboardDeviceMatcher(dashboardFilters);
  const current = currentMetadata || { id: "", createdAt: "", deviceCount: 0, chunkCount: 0 };
  const builtAnalytics = await buildAnalyticsPairFromChunks(previous, current,
    (visit) => currentMetadata?.id
      ? database.forEachSnapshotChunk(currentMetadata.id, visit)
      : Promise.resolve(current),
    {
      deviceMatches,
      includeAbsentPositionMask: dashboardFilters.status === "missing",
      includeCurrentStatusMask: dashboardFilters.status === "changed" || dashboardFilters.status === "unchanged",
      resolveIdentityChunk: previousIndex.snapshotId
        ? (chunk) => database.buildFinalAnalyticsIdentityIndex(previousIndex.snapshotId, previousIndex.signature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION, chunk)
        : null,
      visitPreviousChunks: previousIndex.snapshotId
        ? (visit) => database.forEachFinalAnalyticsIndexChunk(previousIndex.snapshotId, previousIndex.signature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION, visit)
        : null,
      previousDeviceCount: previous.deviceCount,
      releasePreviousDevices: true,
      isCurrent: () => state.analyticsRequests.isCurrent(revision),
      onProgress: ({ phase, pass, passes, label, processed, total }) => {
        const status = $("#analyticsLoadingStatus");
        status.hidden = false;
        status.textContent = phase === "start"
          ? `${label} · этап ${pass} из ${passes}…`
          : `${label} · этап ${pass} из ${passes}: ${Number(processed).toLocaleString("ru-RU")} из ${Number(total).toLocaleString("ru-RU")}`;
      },
    });
  if (!builtAnalytics) return;
  if (!state.analyticsRequests.isCurrent(revision)) return;
  renderDashboardFilterOptions([], builtAnalytics.dashboardFilterOptions);
  // The pair summary keeps no current device projection; later details reread bounded Final chunks.
  const missingPositionMask = dashboardFilters.status === "missing" ? builtAnalytics.comparison.absentPositionMask : null;
  const currentStatusMask = dashboardFilters.status === "changed" || dashboardFilters.status === "unchanged" ? builtAnalytics.comparison.currentStatusMask : null;
  delete builtAnalytics.comparison.absentPositionMask;
  delete builtAnalytics.comparison.currentStatusMask;
  const analytics = releaseDashboardCurrentDevices(builtAnalytics);
  analytics.dashboardFilteredDeviceCount = dashboardFilters.status === "changed" ? analytics.comparison.modifiedDeviceCount
    : dashboardFilters.status === "missing" ? analytics.comparison.absentCount
      : dashboardFilters.status === "unchanged" ? analytics.comparison.unchangedCount
        : analytics.kpis.devices;
  analytics.dashboardFilters = dashboardFilters;
  analytics.comparisonPairSignature = JSON.stringify([historySignature, previousMetadata?.id || "", currentMetadata?.id || "", dashboardFilters]);
  analytics.totals = buildSnapshotTotalSeries(metadata);
  state.analyticsClusterPage = 0;
  state.analyticsClusterCursors = [null];
  state.analyticsTopologyPage = 0;
  state.analyticsTopologyPortPages = {};
  state.analyticsTopologyDevicePages = {};
  state.analyticsTopologyDevicePageData = {};
  state.analyticsTopologyUnassignedPage = 0;
  state.analyticsTopologyUnassignedPageData = null;
  state.analyticsRoomCoveragePages = {};
  state.analyticsRoomCoverageRequests.clear();
  state.analyticsRoomCoverageSnapshotId = currentMetadata?.id || "";
  analytics.historyBackfill = historyBackfill;
  analytics.fallbackAnalytics = fallbackAnalytics;
  analytics.detailsReady = false;
  state.analytics = analytics;
  scheduleAnalyticsDetails(analytics, revision, metadata, historySignature, force, missingPositionMask, currentStatusMask);
}

function showAnalyticsFallback(error, candidate = state.analytics) {
  const fallback = usableAnalyticsFallback(candidate);
  const status = $("#analyticsHistoryFallback");
  if (fallback) {
    state.analytics = fallback;
    paintAnalyticsDetails(fallback);
    status.textContent = "Обновление не удалось. Показан последний успешно рассчитанный полный Dashboard; повторите обновление после восстановления IndexedDB.";
  } else {
    status.textContent = "Полный Dashboard пока недоступен. Дождитесь восстановления IndexedDB и обновите аналитику.";
  }
  status.hidden = false;
  showError(error);
}

async function runDataQualityAnalysis() {
  if (!isEngineerActive()) throw new Error("Для проверки качества войдите в инженерный режим");
  const snapshotId = $("#currentSnapshotSelect").value || state.analytics?.current?.id || "";
  const snapshot = state.snapshotMetadata.find((item) => item.id === snapshotId);
  if (!snapshot) throw new Error("Выберите Final для анализа качества данных");
  const button = $("#runDataQualityButton");
  const status = $("#dataQualityStatus");
  const output = $("#dataQualityReport");
  const accumulator = createDataQualityAccumulator();
  let read = 0;
  button.disabled = true;
  output.replaceChildren();
  try {
    status.textContent = "Локальная проверка Final «" + (snapshot.name || snapshot.id) + "»…";
    await database.forEachSnapshotChunk(snapshot.id, (chunk) => {
      accumulator.accept(chunk);
      read += chunk.length;
      status.textContent = "Проверено " + read.toLocaleString("ru-RU") + " из " + snapshot.deviceCount.toLocaleString("ru-RU") + " устройств…";
    });
    const report = accumulator.finish();
    const savedReport = await database.saveDataQualityReport(snapshot, report);
    recordLocalNotification("quality", "Проверка качества завершена", `Устройства: ${report.devices.toLocaleString("ru-RU")}; оценка: ${report.score}/100; проблем: ${report.issues.length.toLocaleString("ru-RU")}.`, report.issues.length ? "warning" : "success").catch(showError);
    const issueRows = report.issues.map((issue) => "<li><strong>" + escapeHtml(issue.title) + "</strong> · " + escapeHtml(issue.count.toLocaleString("ru-RU")) + " · " + escapeHtml(issue.severity) + "<br>" + escapeHtml(issue.recommendation) + "</li>").join("");
    const recommendations = report.recommendations.map((recommendation) => "<li>" + escapeHtml(recommendation) + "</li>").join("");
    const labels = { vendor: "Производитель", manufacturer: "Производитель", model: "Модель", address: "Адрес", ip: "IP устройства", room: "Помещение", switchIp: "IP коммутатора", switchPort: "Порт" };
    const coverageRows = Object.entries(report.fieldCoverage).map(([key, coverage]) => "<tr><th scope=\"row\">" + labels[key] + "</th><td>" + coverage.filled.toLocaleString("ru-RU") + " / " + coverage.total.toLocaleString("ru-RU") + "</td><td>" + coverage.percent.toFixed(1) + "%</td></tr>").join("");
    const parts = [
      "<h4>Final: " + escapeHtml(snapshot.name || snapshot.id) + "</h4>",
      "<p>Оценка качества: <strong>" + report.score.toLocaleString("ru-RU") + " / 100 · " + report.grade + "</strong></p>",
      "<p>Устройств: <strong>" + report.summary.devices.toLocaleString("ru-RU") + "</strong> · повторные MAC: <strong>" + report.summary.duplicates.toLocaleString("ru-RU") + "</strong> · заполненность: <strong>" + report.summary.completeness.toLocaleString("ru-RU") + "%</strong> · источников: <strong>" + report.summary.sources.toLocaleString("ru-RU") + "</strong></p>",
      report.issues.length ? "<h4>Обнаруженные проблемы</h4><ul>" + issueRows + "</ul>" : "<p class=\"notice\">" + (report.devices ? "Качество данных хорошее. Проблем не обнаружено." : "В выбранном Final нет устройств для проверки.") + "</p>",
      recommendations ? "<h4>Рекомендации</h4><ul>" + recommendations + "</ul>" : "",
      coverageRows ? "<div class=\"table-scroll\"><table class=\"data-table\"><caption>Заполненность полей полного Final</caption><thead><tr><th>Поле</th><th>Заполнено</th><th>Доля</th></tr></thead><tbody>" + coverageRows + "</tbody></table></div>" : "",
    ];
    output.innerHTML = parts.join("");
    status.textContent = "Проверка завершена и сохранена · " + report.devices.toLocaleString("ru-RU") + " устройств · " + report.issues.length.toLocaleString("ru-RU") + " проблем · " + new Date(savedReport.createdAt).toLocaleString("ru-RU");
    await renderDataQualityHistory(0);
    finishProgress("Локальный анализ качества данных завершён");
    return report;
  } finally {
    button.disabled = false;
  }
}

async function renderDataQualityHistory(offset = state.dataQualityHistoryOffset) {
  const host = $("#dataQualityHistory");
  if (!host) return;
  const requestId = ++state.dataQualityHistoryRequestId;
  const page = await database.dataQualityReportsPage({ offset, limit: 20 });
  if (requestId !== state.dataQualityHistoryRequestId) return;
  state.dataQualityHistoryOffset = page.offset;
  const panel = $("#dataQualityPanel");
  if (panel) panel.dataset.historyLoaded = "true";
  const status = $("#dataQualityHistoryStatus");
  const previous = $("#dataQualityHistoryPreviousButton");
  const next = $("#dataQualityHistoryNextButton");
  if (status) status.textContent = page.total
    ? `${(page.offset + 1).toLocaleString("ru-RU")}–${(page.offset + page.rows.length).toLocaleString("ru-RU")} из ${page.total.toLocaleString("ru-RU")}`
    : "0 отчётов";
  if (previous) previous.disabled = !page.hasPrevious;
  if (next) next.disabled = !page.hasNext;
  if (!page.rows.length) {
    host.textContent = "Сохранённых отчётов пока нет.";
    return;
  }
  const rows = page.rows.map((record) => "<tr><td>" + escapeHtml(new Date(record.createdAt).toLocaleString("ru-RU")) + "</td><td>" + escapeHtml(record.snapshotName) + "</td><td>" + escapeHtml(record.score.toLocaleString("ru-RU") + " / 100") + "</td><td>" + escapeHtml(record.grade) + "</td><td>" + escapeHtml(record.report.summary?.devices?.toLocaleString("ru-RU") || "0") + "</td></tr>").join("");
  host.innerHTML = "<table class=\"data-table\"><caption>Отчёты качества " + escapeHtml((page.offset + 1).toLocaleString("ru-RU")) + "–" + escapeHtml((page.offset + page.rows.length).toLocaleString("ru-RU")) + " из " + escapeHtml(page.total.toLocaleString("ru-RU")) + "</caption><thead><tr><th>Дата</th><th>Final</th><th>Оценка</th><th>Класс</th><th>Устройства</th></tr></thead><tbody>" + rows + "</tbody></table>";
}

async function renderTemporalStatistics(force = false) {
  const period = $("#temporalPeriodSelect").value || "day";
  const rangeDays = Number($("#temporalRangeSelect").value || 30);
  const signature = snapshotHistorySignature(state.snapshotMetadata);
  const snapshots = selectTemporalSnapshotWindow(state.snapshotMetadata, { rangeDays });
  const historyFilters = {
    query: state.analyticsDashboardSettings.filters.query,
    manufacturer: state.analyticsDashboardSettings.filters.manufacturer,
    room: state.analyticsDashboardSettings.filters.room,
  };
  const filtersSignature = JSON.stringify(historyFilters);
  const windowSignature = JSON.stringify([snapshotHistorySignature(snapshots), filtersSignature]);
  const requestKey = JSON.stringify([state.temporalDataRevision, signature, filtersSignature, period, rangeDays, windowSignature, Boolean(force)]);
  return reuseInFlightRequest(state.temporalStatisticsRequests, requestKey, async () => {
  const revision = ++state.temporalRevision;
  if (state.temporalStatistics && state.temporalStatisticsWindowSignature === windowSignature && !force) return paintTemporalStatistics(state.temporalStatistics);
  state.temporalStatistics = null;
  state.temporalStatisticsWindowSignature = "";
  $("#temporalSummary").replaceChildren();
  $("#temporalChart").hidden = true;
  $("#temporalTable").classList.add("empty");
  $("#temporalTable").textContent = "Пересчёт статистики по выбранным фильтрам…";
  $("#exportTemporalCsvButton").disabled = true;
  const cacheKey = `temporal-${period}-${rangeDays}:${filtersSignature}`;
  if (!force) {
    const cached = await database.loadAnalyticsCache(cacheKey, signature, 1);
    if (revision !== state.temporalRevision) return;
    if (cached?.windowSignature === windowSignature) {
      state.temporalStatistics = cached.result;
      state.temporalStatisticsWindowSignature = windowSignature;
      paintTemporalStatistics(cached.result);
      return;
    }
  }
  if (!snapshots.length) {
    $("#temporalSummary").innerHTML = "";
    $("#temporalChart").hidden = true;
    $("#temporalTable").classList.add("empty");
    $("#temporalTable").textContent = "Нет сохранённых Final.";
    $("#exportTemporalCsvButton").disabled = true;
    state.temporalStatistics = null;
    state.temporalStatisticsWindowSignature = windowSignature;
    return;
  }
  await database.clearExpiredAnalyticsAggregateQueries("temporal:");
  if (revision !== state.temporalRevision) return;
  const accumulator = new TemporalStatisticsAccumulator(period, {
    deviceMatches: historyFilters.query || historyFilters.manufacturer || historyFilters.room
      ? createDashboardDeviceMatcher(historyFilters)
      : null,
    macStore: database,
    queryId: `temporal:${crypto.randomUUID()}`,
  });
  const temporalLoading = $("#analyticsLoadingStatus");
  try {
    for (let index = 0; index < snapshots.length; index += 1) {
      const snapshot = snapshots[index];
      progress(index / snapshots.length * 92, `Final ${index + 1} из ${snapshots.length}`, "Статистика по времени");
      await accumulator.startSnapshot(snapshot);
      if (revision !== state.temporalRevision) return;
      const chunkCount = Math.max(1, Number(snapshot.chunkCount) || Math.ceil(Number(snapshot.deviceCount || 0) / 500));
      await database.forEachSnapshotChunk(snapshot.id, async (devices, chunkIndex) => {
        if (revision !== state.temporalRevision) return false;
        await accumulator.observeChunk(devices);
        const chunkNumber = chunkIndex + 1;
        const percent = ((index + chunkNumber / chunkCount) / snapshots.length) * 92;
        const detail = `Final ${index + 1} из ${snapshots.length}, блок ${chunkNumber} из ${chunkCount}`;
        progress(percent, detail, "Статистика по времени");
        if (temporalLoading && !temporalLoading.hidden && temporalLoading.textContent.startsWith("Расчёт статистики по времени")) {
          temporalLoading.textContent = `Расчёт статистики по времени: ${detail}…`;
        }
        return true;
      });
      accumulator.endSnapshot();
      if (revision !== state.temporalRevision) return;
    }
    const result = await accumulator.finish();
    if (revision !== state.temporalRevision) return;
    await database.saveAnalyticsCache(cacheKey, signature, { windowSignature, result }, 1);
    if (revision !== state.temporalRevision) return;
    state.temporalStatistics = result;
    state.temporalStatisticsWindowSignature = windowSignature;
    paintTemporalStatistics(result);
    finishProgress("Временная статистика рассчитана");
  } finally {
    await accumulator.cleanup();
  }
  });
}

function paintTemporalStatistics(result) {
  const { summary, periods } = result;
  const summaries = [
    ["Периодов", summary.periods], ["Снимков", summary.snapshots], ["Уникальных MAC", summary.uniqueMacs],
    ["Сумма устройств по снимкам", summary.deviceTotal], ["Последний снимок", summary.latestDeviceCount], ["Максимум", summary.maxDevices],
  ];
  $("#temporalSummary").innerHTML = summaries.map(([label, value]) => `<article class="kpi"><span>${label}</span><strong>${Number(value).toLocaleString("ru-RU")}</strong></article>`).join("");
  const chart = $("#temporalChart");
  chart.hidden = false;
  drawBars(chart, periods.map((row) => ({ label: row.period, value: row.uniqueMacs })));
  $("#temporalTable").classList.remove("empty");
  const columns = [
    ["period", "Период"], ["snapshotCount", "Снимков"], ["deviceTotal", "Сумма устройств"], ["maxDevices", "Максимум"],
    ["uniqueMacs", "Уникальных MAC"], ["added", "Новые MAC"], ["removed", "Исчезли MAC"], ["vendors", "Производителей"], ["rooms", "Помещений"],
  ];
  $("#temporalTable").innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}<th>Источники</th><th>История запусков</th></tr></thead><tbody>${periods.map((row) => `<tr>${columns.map(([field]) => `<td>${escapeHtml(row[field])}</td>`).join("")}<td>${escapeHtml(row.sources.join("; ") || "—")}</td><td>${row.snapshots.map((snapshot) => `<div>${escapeHtml(snapshot.createdAt ? new Date(snapshot.createdAt).toLocaleString("ru-RU") : "Без даты")} · ${escapeHtml(snapshot.name || snapshot.id)} · ${snapshot.deviceCount} устройств · ${(snapshot.processingTimeMs / 1000).toFixed(2)} с</div>`).join("")}</td></tr>`).join("")}</tbody></table></div>`;
  $("#exportTemporalCsvButton").disabled = false;
}

function pagedComparisonMarkup(viewId, comparison, offset = 0) {
  return comparisonContent(comparison, { viewId, offset, limit: 100 });
}

function pagedComparisonContent(comparison) {
  state.comparisonViews.clear();
  const viewId = `comparison-${++state.comparisonViewSequence}`;
  state.comparisonViews.set(viewId, comparison);
  return pagedComparisonMarkup(viewId, comparison);
}

function loadMoreComparison(button) {
  const viewId = button.dataset.comparisonMore;
  const comparison = state.comparisonViews.get(viewId);
  const page = button.closest("[data-comparison-page]");
  if (!comparison || !page || page.dataset.comparisonPage !== viewId) {
    showError(new Error("Список изменений устарел. Пересчитайте аналитику."));
    return;
  }
  page.innerHTML = pagedComparisonMarkup(viewId, comparison, Number(button.dataset.nextOffset));
}

async function loadIdentityDiagnosticsMarkup(analytics, offset = 0) {
  if (!analytics?.current?.id) {
    const comparison = analytics?.comparison || {};
    const ambiguous = comparison.ambiguous || [];
    const identityConflicts = comparison.identityConflicts || [];
    return ambiguous.length || identityConflicts.length
      ? pagedComparisonContent({ modified: [], ambiguous, identityConflicts })
      : "";
  }
  const expected = Number(analytics?.comparison?.ambiguousCount || 0) + Number(analytics?.comparison?.identityConflictCount || 0);
  if (!expected) return "";
  const page = await loadDashboardComparisonPage(analytics, "identityDiagnostics", offset, 100);
  if (!page || state.analytics !== analytics) return "";
  if (page.total !== expected) throw new Error("Число диагностик идентичности не совпало с точным сравнением выбранных Final");
  return comparisonDiagnosticsPageContent(page);
}

function normalizeChangeReportSettings(settings = {}) {
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";
  return {
    mode: settings.mode === "period" ? "period" : "snapshots",
    from: validDate(settings.from),
    to: validDate(settings.to),
  };
}

function defaultChangeReportRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 29 * 86_400_000);
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

function applyChangeReportControls() {
  const period = state.changeReportSettings.mode === "period";
  $("#changeReportModeSelect").value = state.changeReportSettings.mode;
  $("#changeReportFrom").value = state.changeReportSettings.from;
  $("#changeReportTo").value = state.changeReportSettings.to;
  $("#changePeriodControls").hidden = !period;
  $("#changeSnapshotControls").hidden = period;
}

async function saveChangeReportSettings(settings) {
  state.changeReportSettings = normalizeChangeReportSettings(settings);
  await database.setSetting("changeReportSettings", state.changeReportSettings);
  applyChangeReportControls();
}

function periodHistoryFilters(category, settings = state.changeReportSettings, dashboardFilters = state.analyticsDashboardSettings.filters) {
  const filters = {
    from: settings.from,
    to: settings.to,
    query: dashboardFilters.query,
    manufacturer: dashboardFilters.manufacturer,
    room: dashboardFilters.room,
  };
  if (category === "critical") filters.severity = "critical";
  else if (category === "added") filters.type = "added";
  else if (category === "absent") filters.type = "absent";
  else if (category === "modified") filters.type = "modified";
  return filters;
}

async function renderPeriodChangeCategory(category = state.comparisonChangeCategory) {
  const settings = state.changeReportSettings;
  if (!settings.from || !settings.to) return;
  if (settings.from > settings.to) throw new Error("Начальная дата позже конечной");
  const dashboardFilters = normalizeAnalyticsDashboardSettings({ filters: state.analyticsDashboardSettings.filters }).filters;
  const signature = JSON.stringify([settings.from, settings.to, dashboardFilters.query, dashboardFilters.manufacturer, dashboardFilters.room, state.temporalDataRevision]);
  const view = state.periodChangePage;
  if (view.category !== category || state.periodChangeSummary?.signature !== signature) {
    state.periodChangePage = { category, cursor: null, previous: [], page: null, requestId: view.requestId };
  }
  const requestId = state.periodChangePage.requestId + 1;
  state.periodChangePage.requestId = requestId;
  try {
    if (state.periodChangeSummary?.signature !== signature) {
      const [all, critical, added, absent, modified] = await Promise.all([
        database.historySearchPage(periodHistoryFilters("", settings, dashboardFilters), { limit: 1 }),
        database.historySearchPage(periodHistoryFilters("critical", settings, dashboardFilters), { limit: 1 }),
        database.historySearchPage(periodHistoryFilters("added", settings, dashboardFilters), { limit: 1 }),
        database.historySearchPage(periodHistoryFilters("absent", settings, dashboardFilters), { limit: 1 }),
        database.historySearchPage(periodHistoryFilters("modified", settings, dashboardFilters), { limit: 1 }),
      ]);
      if (requestId !== state.periodChangePage.requestId) return;
      state.periodChangeSummary = { signature, counts: { all: all.total, critical: critical.total, added: added.total, absent: absent.total, modified: modified.total } };
    }
    const current = state.periodChangePage;
    const page = await database.historySearchPage(periodHistoryFilters(category, settings, dashboardFilters), { cursor: current.cursor, limit: 100 });
    if (requestId !== state.periodChangePage.requestId) return;
    state.periodChangePage = { ...state.periodChangePage, page };
    const counts = state.periodChangeSummary.counts;
    const tabs = `<div class="change-category-tabs" role="tablist" aria-label="Категории изменений">${CHANGE_CATEGORIES.map((key) => `<button type="button" class="button secondary ${category === key ? "active-filter" : ""}" role="tab" aria-controls="analyticsChangeEventsPanel" aria-selected="${category === key}" tabindex="${category === key ? "0" : "-1"}" data-change-category="${key}">${CHANGE_CATEGORY_LABELS[key]} <strong>${counts[key].toLocaleString("ru-RU")}</strong></button>`).join("")}</div>`;
    const rows = page.rows.map((event) => {
      const type = normalizeChangeType(event.type);
      const oldValue = event.oldValue ?? event.before;
      const newValue = event.newValue ?? event.after;
      const fieldLabel = event.label || event.field || event.fieldLabel || "Устройство";
      const severity = isCriticalHistoryChange(type, event.field || event.label || event.fieldLabel, oldValue, newValue) ? "critical" : type === "added" ? "low" : "other";
      const eventLabel = type === "added" ? "Добавлено" : type === "absent" ? "Отсутствует" : "Изменено";
      const detail = `${fieldLabel}: ${oldValue || "—"} → ${newValue || "—"}`;
      const identity = event.mac || event.device?.mac || event.deviceId || event.device?.id || "—";
      return `<tr><td><span class="severity-badge severity-${severity}">${severity === "critical" ? "Критическое" : severity === "low" ? "Низкое" : "Другое"}</span></td><td>${eventLabel}</td><td>${escapeHtml(identity)}</td><td>${escapeHtml(event.device?.room || "—")}</td><td>${escapeHtml(detail)}</td><td>${escapeHtml(event.source || "История Final")}</td></tr>`;
    }).join("");
    const pageNumber = state.periodChangePage.previous.length + 1;
    const pager = page.total > 100 ? `<div class="action-row"><span class="muted">Страница ${pageNumber} · показано ${page.rows.length.toLocaleString("ru-RU")} из ${page.total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-period-change-page="previous" ${state.periodChangePage.previous.length ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-period-change-page="next" ${page.hasMore ? "" : "disabled"}>Дальше</button></div>` : `<p class="muted">Событий: ${page.total.toLocaleString("ru-RU")}</p>`;
    const body = rows ? `<div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>Важность</th><th>Тип</th><th>MAC / ID</th><th>Помещение</th><th>Изменение</th><th>Источник</th></tr></thead><tbody>${rows}</tbody></table></div>${pager}` : '<p class="empty">За выбранный период изменений нет.</p>';
    const periodLabel = `<p class="muted">${settings.from} — ${settings.to} · ${page.total.toLocaleString("ru-RU")} событий</p>`;
    $("#changeTable").innerHTML = `${tabs}<div id="analyticsChangeEventsPanel" role="tabpanel" aria-label="${CHANGE_CATEGORY_LABELS[category]}">${periodLabel}${body}</div>`;
  } catch (error) {
    if (requestId === state.periodChangePage.requestId) throw error;
  }
}

async function renderAnalyticsUnchangedPage(analytics = state.analytics, offset = 0, dialog = false) {
  if (!analytics?.comparison) return;
  if (dialog) showDialog($("#detailsDialog"), "Без изменений", '<p class="muted" role="status">Сравнение выбранных Final…</p>');
  const result = await loadDashboardUnchangedPage(analytics, offset, 100);
  if (!result || state.analytics !== analytics) return;
  const expected = Number(analytics.comparison.unchangedCount || 0);
  if (result.total !== expected) throw new Error("Список без изменений не совпал со счётчиком выбранной пары Final");
  const rows = result.devices.map((device) => `<tr><td>${escapeHtml(device.mac || device.deviceId || device.serial || "—")}</td><td>${escapeHtml(device.manufacturer || "—")}</td><td>${escapeHtml(device.model || "—")}</td><td>${escapeHtml(device.room || "—")}</td><td>${escapeHtml(device.ip || "—")}</td></tr>`).join("");
  const pageAttribute = dialog ? "data-analytics-unchanged-page" : "data-unchanged-page";
  const pager = result.total > result.limit ? `<div class="action-row"><span class="muted">Показано ${Math.min(result.offset + result.devices.length, result.total).toLocaleString("ru-RU")} из ${result.total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" ${pageAttribute}="${Math.max(0, result.offset - result.limit)}" ${result.offset ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" ${pageAttribute}="${result.offset + result.limit}" ${result.hasNext ? "" : "disabled"}>Дальше</button></div>` : `<p class="muted">Устройств: ${result.total.toLocaleString("ru-RU")}</p>`;
  const body = rows ? `<div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>MAC / ID</th><th>Производитель</th><th>Модель</th><th>Помещение</th><th>IP</th></tr></thead><tbody>${rows}</tbody></table></div>${pager}` : '<p class="empty">Неизменившихся устройств нет.</p>';
  if (dialog) $("#detailsDialog [data-dialog-content]").innerHTML = body;
  else $("#changeTable").innerHTML = `<h3>Без изменений</h3>${body}`;
}
async function renderAnalyticsModifiedDevicePage(analytics = state.analytics, offset = 0) {
  if (!analytics?.comparison) return;
  const result = await loadDashboardModifiedDevicePage(analytics, offset, 100);
  if (!result || state.analytics !== analytics) return;
  const expected = Number(analytics.comparison.modifiedDeviceCount || 0);
  if (result.total !== expected) throw new Error("Список изменённых устройств не совпал со счётчиком выбранной пары Final");
  const rows = result.devices.map((device) => `<tr><td>${escapeHtml(device.mac || device.deviceId || device.serial || device.id || "—")}</td><td>${escapeHtml(device.manufacturer || "—")}</td><td>${escapeHtml(device.model || "—")}</td><td>${escapeHtml(device.room || "—")}</td><td>${escapeHtml(device.ip || "—")}</td></tr>`).join("");
  const pager = result.total > result.limit ? `<div class="action-row"><span class="muted">Показано ${Math.min(result.offset + result.devices.length, result.total).toLocaleString("ru-RU")} из ${result.total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-modified-device-page="${Math.max(0, result.offset - result.limit)}" ${result.offset ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-modified-device-page="${result.offset + result.limit}" ${result.hasNext ? "" : "disabled"}>Дальше</button></div>` : `<p class="muted">Устройств: ${result.total.toLocaleString("ru-RU")}</p>`;
  const body = rows ? `<div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>MAC / ID</th><th>Производитель</th><th>Модель</th><th>Помещение</th><th>IP</th></tr></thead><tbody>${rows}</tbody></table></div>${pager}` : '<p class="empty">Изменённых устройств нет.</p>';
  $("#changeTable").innerHTML = `<h3>Изменённые устройства</h3>${body}`;
}
async function renderAnalyticsStatusRoster(analytics = state.analytics, status = "all", offset = 0) {
  if (!analytics?.comparison || !["all", "changed", "missing", "unchanged"].includes(status)) return;
  const loaders = {
    all: loadDashboardDevicePage,
    changed: loadDashboardModifiedDevicePage,
    missing: loadDashboardAbsencePage,
    unchanged: loadDashboardUnchangedPage,
  };
  const result = await loaders[status](analytics, offset, 100);
  if (!result || state.analytics !== analytics) return;
  const expected = status === "all" ? Number(analytics.kpis.devices || 0)
    : status === "changed" ? Number(analytics.comparison.modifiedDeviceCount || 0)
      : status === "missing" ? Number(analytics.comparison.absentCount || 0)
        : Number(analytics.comparison.unchangedCount || 0);
  if (result.total !== expected) throw new Error(`Список статуса «${status}» не совпал с точным сравнением выбранной пары Final`);
  const labels = { all: "Все устройства", changed: "Изменённые устройства", missing: "Отсутствующие устройства", unchanged: "Без изменений" };
  const rows = result.devices.map((device) => `<tr><td>${escapeHtml(device.mac || device.deviceId || device.serial || device.id || "—")}</td><td>${escapeHtml(device.manufacturer || "—")}</td><td>${escapeHtml(device.model || "—")}</td><td>${escapeHtml(device.room || "—")}</td><td>${escapeHtml(device.ip || "—")}</td></tr>`).join("");
  const shownEnd = Math.min(result.offset + result.devices.length, result.total);
  const pager = result.total > result.limit ? `<div class="action-row"><span class="muted">Показано ${Math.min(result.offset + 1, result.total).toLocaleString("ru-RU")}–${shownEnd.toLocaleString("ru-RU")} из ${result.total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-status-roster-page="${status}" data-page-offset="${Math.max(0, result.offset - result.limit)}" ${result.offset ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-status-roster-page="${status}" data-page-offset="${result.offset + result.limit}" ${result.hasNext ? "" : "disabled"}>Дальше</button></div>` : `<p class="muted">Устройств: ${result.total.toLocaleString("ru-RU")}</p>`;
  const body = rows ? `<div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>MAC / ID</th><th>Производитель</th><th>Модель</th><th>Помещение</th><th>IP</th></tr></thead><tbody>${rows}</tbody></table></div>${pager}` : '<p class="empty">Устройств с этим статусом нет.</p>';
  $("#changeTable").innerHTML = `<h3>${labels[status]}</h3>${body}`;
}
async function renderAnalyticsChangeCategories(comparison = state.analytics?.comparison, category, offset) {
  if (!comparison) return;
  const analytics = state.analytics;
  const reportUsesPeriod = state.changeReportSettings.mode === "period";
  const defaultStatus = category === undefined && !reportUsesPeriod ? state.analyticsDashboardSettings.filters.status : "all";
  if (category === undefined && !reportUsesPeriod) return renderAnalyticsStatusRoster(analytics, defaultStatus, 0);
  const requestedCategory = category ?? (!reportUsesPeriod && defaultStatus === "changed" ? "modified" : !reportUsesPeriod && defaultStatus === "missing" ? "absent" : state.comparisonChangeCategory);
  const selected = CHANGE_CATEGORIES.includes(requestedCategory) ? requestedCategory : "all";
  offset ??= state.comparisonChangeOffset;
  state.comparisonChangeCategory = selected;
  if (reportUsesPeriod) return renderPeriodChangeCategory(selected);
  const counts = summarizeChangeCategories(comparison);
  if (["all", "critical", "modified"].includes(selected)) {
    const groupPage = await loadDashboardChangeGroupPage(analytics, selected, offset, 100);
    if (!groupPage || state.analytics !== analytics || state.comparisonChangeCategory !== selected) return;
    if (selected === "modified" && groupPage.totalEvents !== counts.modified) throw new Error("Группы изменений не совпали с точным количеством событий выбранной пары Final");
    state.comparisonChangeOffset = groupPage.offset;
    const tabList = '<div class="change-category-tabs" role="tablist" aria-label="Категории изменений">' + CHANGE_CATEGORIES.map((key) =>
      '<button type="button" class="button secondary ' + (selected === key ? "active-filter" : "") + '" role="tab" aria-controls="analyticsChangeEventsPanel" aria-selected="' + (selected === key) + '" tabindex="' + (selected === key ? "0" : "-1") + '" data-change-category="' + key + '">' + CHANGE_CATEGORY_LABELS[key] + ' <strong>' + counts[key].toLocaleString("ru-RU") + "</strong></button>"
    ).join("") + "</div>";
    const details = dashboardChangeDeviceGroupsContent(groupPage.groups);
    const pagination = groupPage.total > 100
      ? '<div class="action-row"><span class="muted">Устройства ' + Math.min(groupPage.offset + 1, groupPage.total).toLocaleString("ru-RU") + "–" + Math.min(groupPage.offset + groupPage.groups.length, groupPage.total).toLocaleString("ru-RU") + " из " + groupPage.total.toLocaleString("ru-RU") + " · событий " + groupPage.totalEvents.toLocaleString("ru-RU") + '</span><button class="button secondary" type="button" data-change-page="' + Math.max(0, groupPage.offset - groupPage.limit) + '" ' + (groupPage.hasPrevious ? "" : "disabled") + '>Назад</button><button class="button secondary" type="button" data-change-page="' + (groupPage.offset + groupPage.limit) + '" ' + (groupPage.hasNext ? "" : "disabled") + '>Дальше</button></div>'
      : '<p class="muted">Устройств: ' + groupPage.total.toLocaleString("ru-RU") + " · событий: " + groupPage.totalEvents.toLocaleString("ru-RU") + "</p>";
    const diagnostics = await loadIdentityDiagnosticsMarkup(analytics);
    if (state.analytics !== analytics || state.comparisonChangeCategory !== selected) return;
    const content = groupPage.groups.length
      ? '<div class="change-device-groups">' + details + "</div>" + pagination
      : '<p class="empty">В этой категории изменений нет.</p>';
    $("#changeTable").innerHTML = tabList + '<div id="analyticsChangeEventsPanel" role="tabpanel" aria-label="' + CHANGE_CATEGORY_LABELS[selected] + '">' + content + "</div>" + diagnostics;
    return;
  }
  const page = pageComparisonChanges(comparison, selected, { offset, limit: 100 });
  for (const type of ["added", "absent"]) {
    const offsetKey = type === "added" ? "additionOffset" : "absenceOffset";
    const missingOffsets = page.rows.filter((event) => event.type === type && !event.device).map((event) => event[offsetKey]);
    if (!missingOffsets.length || !analytics) continue;
    const firstOffset = Math.min(...missingOffsets);
    const loaded = type === "added"
      ? await loadDashboardAdditionPage(analytics, firstOffset, missingOffsets.length)
      : await loadDashboardAbsencePage(analytics, firstOffset, missingOffsets.length);
    if (!loaded || state.analytics !== analytics || state.comparisonChangeCategory !== selected) return;
    if (loaded.total !== counts[type]) throw new Error(`Страница ${type === "added" ? "добавленных" : "отсутствующих"} устройств не совпала со счётчиком журнала изменений`);
    page.rows = page.rows.map((event) => event.type === type && !event.device
      ? { ...event, device: loaded.devices[event[offsetKey] - firstOffset] || null }
      : event);
  }
  const modificationOffsetKey = selected === "critical" ? "criticalModificationOffset" : "modificationOffset";
  const missingModificationOffsets = page.rows
    .filter((event) => event.type === "modified" && !event.device && Number.isInteger(event[modificationOffsetKey]))
    .map((event) => event[modificationOffsetKey]);
  if (missingModificationOffsets.length && analytics) {
    const firstOffset = Math.min(...missingModificationOffsets);
    const criticalOnly = selected === "critical";
    const loaded = await loadDashboardModificationPage(analytics, firstOffset, missingModificationOffsets.length, { criticalOnly });
    if (!loaded || state.analytics !== analytics || state.comparisonChangeCategory !== selected) return;
    const expected = criticalOnly ? Math.max(0, counts.critical - counts.absent) : counts.modified;
    if (loaded.total !== expected) throw new Error("Страница изменений не совпала со счётчиком журнала изменений");
    const loadedByOffset = new Map(loaded.events.map((event) => [event.modificationOffset, event]));
    page.rows = page.rows.map((event) => {
      if (event.type !== "modified" || event.device || !Number.isInteger(event[modificationOffsetKey])) return event;
      const detail = loadedByOffset.get(event[modificationOffsetKey]);
      return detail ? { ...event, ...detail } : event;
    });
    if (selected === "modified") {
      page.rows = loaded.events;
      page.offset = loaded.offset;
      page.previousOffset = loaded.previousOffset;
      page.nextOffset = loaded.nextOffset;
      page.hasMore = loaded.hasNext;
    }
  }
  state.comparisonChangeOffset = page.offset;
  const tabList = `<div class="change-category-tabs" role="tablist" aria-label="Категории изменений">${CHANGE_CATEGORIES.map((key) => `<button type="button" class="button secondary ${selected === key ? "active-filter" : ""}" role="tab" aria-controls="analyticsChangeEventsPanel" aria-selected="${selected === key}" tabindex="${selected === key ? "0" : "-1"}" data-change-category="${key}">${CHANGE_CATEGORY_LABELS[key]} <strong>${counts[key].toLocaleString("ru-RU")}</strong></button>`).join("")}</div>`;
  const deviceGroups = dashboardChangeDeviceGroupsContent(page.rows);
  const pagination = page.total > 100 ? `<div class="action-row"><span class="muted">Показано ${Math.min(page.offset + page.rows.length, page.total).toLocaleString("ru-RU")} из ${page.total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-change-page="${page.previousOffset ?? Math.max(0, page.offset - page.limit)}" ${page.offset ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-change-page="${page.nextOffset ?? page.offset + page.limit}" ${page.hasMore ? "" : "disabled"}>Дальше</button></div>` : `<p class="muted">Событий: ${page.total.toLocaleString("ru-RU")}</p>`;
  const eventTable = page.rows.length
    ? `<div class="change-device-groups">${deviceGroups}</div>${pagination}`
    : '<p class="empty">В этой категории изменений нет.</p>';
  const diagnostics = await loadIdentityDiagnosticsMarkup(analytics);
  if (state.analytics !== analytics || state.comparisonChangeCategory !== selected) return;
  $("#changeTable").innerHTML = `${tabList}<div id="analyticsChangeEventsPanel" role="tabpanel" aria-label="${CHANGE_CATEGORY_LABELS[selected]}">${eventTable}</div>${diagnostics}`;
}

function openRoomAnomalyDialog(analytics) {
  const snapshotId = analytics.current?.id || "";
  if (state.analyticsRoomAnomalySnapshotId !== snapshotId) {
    state.analyticsRoomAnomalySnapshotId = snapshotId;
    state.analyticsRoomAnomalyPages = {};
  }
  showDialog($("#detailsDialog"), "Переговорные с разными IP коммутатора", roomAnomalyContent(analytics.roomSwitchAnomalies, state.analyticsRoomAnomalyPages));
}

async function loadRoomAnomalyPage(analytics, roomKey, page) {
  const snapshotId = analytics.current?.id;
  if (!snapshotId) throw new Error("Не выбран текущий Final для загрузки состава помещения");
  const current = state.analyticsRoomAnomalyPages[roomKey];
  if (current?.loading) return;
  state.analyticsRoomAnomalyPages[roomKey] = { ...current, loading: true };
  $("#detailsDialog [data-dialog-content]").innerHTML = roomAnomalyContent(analytics.roomSwitchAnomalies, state.analyticsRoomAnomalyPages);
  try {
    const result = await database.loadSnapshotRoomAnomalyPage(snapshotId, { roomKey, page, limit: 100, filters: analytics.dashboardFilters });
    if (state.analytics?.current?.id !== snapshotId) return;
    state.analyticsRoomAnomalyPages[roomKey] = result;
    $("#detailsDialog [data-dialog-content]").innerHTML = roomAnomalyContent(state.analytics.roomSwitchAnomalies, state.analyticsRoomAnomalyPages);
  } catch (error) {
    delete state.analyticsRoomAnomalyPages[roomKey];
    throw error;
  }
}

function openRoomCoverageDialog(analytics, onlyAllChanged = false) {
  const snapshotId = analytics.current?.id || "";
  if (state.analyticsRoomCoverageSnapshotId !== snapshotId) {
    state.analyticsRoomCoverageSnapshotId = snapshotId;
    state.analyticsRoomCoveragePages = {};
    state.analyticsRoomCoverageRequests.clear();
  }
  state.analyticsRoomCoverageOnlyAllChanged = Boolean(onlyAllChanged);
  showDialog(
    $("#detailsDialog"),
    onlyAllChanged ? "Изменилось всё оборудование" : "Помещения с изменениями",
    roomCoverageContent(analytics.roomChanges, state.analyticsRoomCoverageOnlyAllChanged, state.analyticsRoomCoveragePages),
  );
}

async function loadRoomCoveragePage(analytics, roomKey, page) {
  const snapshotId = analytics.current?.id;
  if (!snapshotId) throw new Error("Не выбран текущий Final для состава помещения");
  const current = state.analyticsRoomCoveragePages[roomKey];
  if (current?.loading) return;
  const requestId = (state.analyticsRoomCoverageRequests.get(roomKey) || 0) + 1;
  state.analyticsRoomCoverageRequests.clear();
  state.analyticsRoomCoverageRequests.set(roomKey, requestId);
  state.analyticsRoomCoveragePages = { [roomKey]: { ...current, loading: true } };
  const render = () => roomCoverageContent(
    state.analytics.roomChanges,
    state.analyticsRoomCoverageOnlyAllChanged,
    state.analyticsRoomCoveragePages,
  );
  $("#detailsDialog [data-dialog-content]").innerHTML = render();
  try {
    const result = await database.loadSnapshotRoomAnomalyPage(snapshotId, { roomKey, page, limit: 100, filters: analytics.dashboardFilters });
    if (state.analytics !== analytics || state.analyticsRoomCoverageRequests.get(roomKey) !== requestId) return;
    const expected = analytics.roomChanges.find((room) => room.key === roomKey)?.rosterCount;
    if (result.total !== Number(expected || 0)) throw new Error("Число устройств помещения не совпало с выбранным Final");
    state.analyticsRoomCoveragePages[roomKey] = result;
    $("#detailsDialog [data-dialog-content]").innerHTML = render();
  } catch (error) {
    if (state.analytics !== analytics || state.analyticsRoomCoverageRequests.get(roomKey) !== requestId) return;
    delete state.analyticsRoomCoveragePages[roomKey];
    $("#detailsDialog [data-dialog-content]").innerHTML = render();
    throw error;
  }
}

async function showUnassignedAnalyticsPage(analytics, page = 1, open = false) {
  const snapshotId = analytics.current?.id;
  if (!snapshotId) throw new Error("Не выбран текущий Final для списка устройств без помещения");
  const requestId = ++state.analyticsUnassignedDeviceRequest;
  const dialog = $("#detailsDialog");
  if (open) showDialog(dialog, "Устройства без помещения", '<p class="muted" role="status">Загрузка страницы устройств…</p>');
  const result = await database.loadSnapshotUnassignedRoomPage(snapshotId, { page, limit: 50, filters: analytics.dashboardFilters });
  if (requestId !== state.analyticsUnassignedDeviceRequest || state.analytics !== analytics || state.analytics.current?.id !== snapshotId) return;
  if (result.total !== Number(analytics.kpis.withoutRoom || 0)) {
    throw new Error("Число устройств без помещения не совпало с полным выбранным Final");
  }
  dialog.querySelector("[data-dialog-title]").textContent = "Устройства без помещения";
  dialog.querySelector("[data-dialog-content]").innerHTML = unassignedDevicesContent({
    devices: result.devices,
    count: result.total,
    vendors: analytics.unassignedVendors,
    models: analytics.unassignedModels,
    page: result.page,
    pageCount: result.pageCount,
  });
  if (open && !dialog.open) dialog.showModal();
}

async function loadDashboardComparisonPage(analytics, kind, offset = 0, limit = 100, options = {}, sharedRequestId = null) {
  const requestId = sharedRequestId ?? ++state.analyticsComparisonDetailRequest;
  const currentId = analytics.current?.id || "";
  const baselineId = analytics.previous?.id || "";
  const cacheKey = JSON.stringify([
    "comparison-page-v1",
    analytics.comparisonPairSignature || JSON.stringify([baselineId, currentId]),
    kind,
    Math.max(0, Math.floor(Number(offset) || 0)),
    Math.max(1, Math.min(500, Math.floor(Number(limit) || 100))),
    Object.entries(options).sort(([left], [right]) => left.localeCompare(right)),
  ]);
  const cachedPage = state.analyticsComparisonPageCache.get(cacheKey);
  if (cachedPage) return cachedPage;
  const cachePage = (result) => {
    if (result && state.analytics === analytics && requestId === state.analyticsComparisonDetailRequest) {
      state.analyticsComparisonPageCache.set(cacheKey, result);
    }
    return result;
  };
  if (!currentId) {
    if (kind === "identityDiagnostics") return cachePage({ rows: [], total: 0, ambiguousCount: 0, identityConflictCount: 0, offset, limit, hasPrevious: offset > 0, hasNext: false });
    const devices = kind === "allDevices" ? (analytics.current?.devices || analytics.devices || []) : analytics.comparison[kind] || [];
    const start = Math.max(0, Math.floor(Number(offset) || 0));
    const size = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    if (kind === "modified") {
      const events = (analytics.comparison.modified || []).flatMap((row) => (row.changes || []).map((change) => ({ type: "modified", device: row.after, before: row.before, change })))
        .filter((event) => !options.criticalOnly || isCriticalHistoryChange("modified", event.change.field, event.change.oldValue, event.change.newValue));
      const selected = events.slice(start, start + size);
      return cachePage({ events: selected, total: events.length, offset: start, limit: size, hasPrevious: start > 0, hasNext: start + selected.length < events.length });
    }
    if (kind === "modifiedGroups") {
      const groups = [];
      let total = 0;
      let totalEvents = 0;
      for (const row of analytics.comparison.modified || []) {
        const changes = (row.changes || []).filter((change) => !options.criticalOnly || isCriticalHistoryChange("modified", change.field, change.oldValue, change.newValue));
        if (!changes.length) continue;
        if (total >= start && groups.length < size) {
          groups.push({
            type: "modified",
            severity: changes.some((change) => isCriticalHistoryChange("modified", change.field, change.oldValue, change.newValue)) ? "critical" : "other",
            device: row.after,
            before: row.before,
            changes,
          });
        }
        total += 1;
        totalEvents += changes.length;
      }
      return cachePage({ groups, total, totalEvents, offset: start, limit: size, hasPrevious: start > 0, hasNext: start + groups.length < total });
    }
    return cachePage({ devices: devices.slice(start, start + size), total: devices.length, offset: start, limit: size, hasPrevious: start > 0, hasNext: start + size < devices.length });
  }
  if (kind === "allDevices") {
    const result = await compareFinalDevicePage(
      (visit) => database.forEachSnapshotChunk(currentId, visit),
      { offset, limit, deviceMatches: createDashboardDeviceMatcher(analytics.dashboardFilters || {}) },
    );
    if (state.analytics !== analytics || requestId !== state.analyticsComparisonDetailRequest) return null;
    return cachePage(result);
  }
  if (!baselineId) {
    if (kind === "identityDiagnostics") return cachePage({ rows: [], total: 0, ambiguousCount: 0, identityConflictCount: 0, offset, limit, hasPrevious: offset > 0, hasNext: false });
    if (kind === "absent") return cachePage({ devices: [], total: 0, offset, limit, hasPrevious: offset > 0, hasNext: false });
    const comparePage = kind === "added" ? compareFinalAdditionPage : kind === "unchanged" ? compareFinalUnchangedPage : kind === "modifiedDevices" ? compareFinalModifiedDevicePage : kind === "allDevices" ? compareFinalDevicePage : kind === "modifiedGroups" ? compareFinalModificationDeviceGroupPage : compareFinalModificationEventPage;
    const result = await comparePage(
      [],
      (visit) => database.forEachSnapshotChunk(currentId, visit),
      { offset, limit, timestamp: analytics.comparison.timestamp, deviceMatches: createDashboardDeviceMatcher(analytics.dashboardFilters || {}), ...(["modified", "modifiedGroups"].includes(kind) ? options : {}) },
    );
    if (state.analytics !== analytics || requestId !== state.analyticsComparisonDetailRequest) return null;
    return cachePage(result);
  }
  const metadata = [...state.snapshotMetadata].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  const baselineMetadata = metadata.find((snapshot) => snapshot.id === baselineId);
  if (!baselineMetadata) throw new Error("Базовый Final выбранной пары не найден");
  const baselineIndex = metadata.indexOf(baselineMetadata);
  const supportsIndexedIdentityPage = ["identityDiagnostics", "absent", "added", "unchanged", "modifiedDevices", "modified", "modifiedGroups"].includes(kind);
  if (supportsIndexedIdentityPage) {
    const comparisonIndex = await ensureDashboardComparisonIndex(metadata, baselineMetadata, () => state.analytics === analytics && requestId === state.analyticsComparisonDetailRequest);
    if (!comparisonIndex) return null;
    if (state.analytics !== analytics || requestId !== state.analyticsComparisonDetailRequest) return null;
    const resolveIdentityChunk = (chunk) => database.buildFinalAnalyticsIdentityIndex(
      comparisonIndex.snapshotId,
      comparisonIndex.signature,
      FINAL_ANALYTICS_INDEX_SCHEMA_VERSION,
      chunk.map(compactComparisonDevice),
    );
    const indexedComparePage = kind === "identityDiagnostics"
      ? compareFinalIdentityDiagnosticPage
      : kind === "added" ? compareFinalAdditionPage
      : kind === "modifiedDevices" ? compareFinalModifiedDevicePage
        : kind === "modifiedGroups" ? compareFinalModificationDeviceGroupPage
          : kind === "modified" ? compareFinalModificationEventPage
            : kind === "absent" ? compareFinalAbsencePage : compareFinalUnchangedPage;
    const result = await indexedComparePage([], (visit) => database.forEachSnapshotChunk(currentId, visit), {
      offset,
      limit,
      timestamp: analytics.comparison.timestamp,
      deviceMatches: createDashboardDeviceMatcher(analytics.dashboardFilters || {}),
      resolveIdentityChunk,
      ...(kind === "absent" ? {
        previousCount: Number(baselineMetadata.deviceCount),
        visitPreviousChunks: (visit) => database.forEachFinalAnalyticsIndexChunk(comparisonIndex.snapshotId, comparisonIndex.signature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION, visit),
      } : {}),
      ...(["modified", "modifiedGroups"].includes(kind) ? options : {}),
    });
    if (state.analytics !== analytics || requestId !== state.analyticsComparisonDetailRequest) return null;
    if (kind === "identityDiagnostics"
      && (result.ambiguousCount !== Number(analytics.comparison.ambiguousCount || 0)
        || result.identityConflictCount !== Number(analytics.comparison.identityConflictCount || 0))) {
      throw new Error("Страница диагностики идентичности не совпала с точным сравнением выбранной пары Final");
    }
    return cachePage(result);
  }
  const signature = finalAnalyticsIndexSignature(baselineMetadata);
  let previousDevices = await database.loadFinalAnalyticsIndex(baselineId, signature, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION, compactComparisonDevice);
  if (!previousDevices) {
    previousDevices = [];
    await database.forEachSnapshotChunk(baselineId, (chunk) => {
      for (const device of chunk) previousDevices.push(trimComparisonDeviceInPlace(device));
    });
    if (state.analytics !== analytics || requestId !== state.analyticsComparisonDetailRequest) return null;
    try {
      await database.saveFinalAnalyticsIndex(baselineId, signature, previousDevices, FINAL_ANALYTICS_INDEX_SCHEMA_VERSION);
    } catch (error) {
      console.warn("Не удалось сохранить компактный индекс FinalAnalytics", error?.message || error);
    }
  }
  if (state.analytics !== analytics || requestId !== state.analyticsComparisonDetailRequest) return null;
  if (baselineIndex > 0 && baselineId !== currentId) {
    const restored = await backfillComparisonDevices(
      previousDevices,
      metadata.slice(0, baselineIndex),
      (snapshotId, visit) => database.forEachSnapshotChunk(snapshotId, visit),
      { inPlace: true },
    );
    previousDevices = restored.devices;
  }
  trimComparisonBaseline(previousDevices);
  if (state.analytics !== analytics || requestId !== state.analyticsComparisonDetailRequest) return null;
  if (kind === "identityDiagnostics") {
    const result = await compareFinalIdentityDiagnosticPage(
      previousDevices,
      (visit) => database.forEachSnapshotChunk(currentId, visit),
      { offset, limit, timestamp: analytics.comparison.timestamp },
    );
    if (state.analytics !== analytics || requestId !== state.analyticsComparisonDetailRequest) return null;
    if (result.ambiguousCount !== Number(analytics.comparison.ambiguousCount || 0)
      || result.identityConflictCount !== Number(analytics.comparison.identityConflictCount || 0)) {
      throw new Error("Страница диагностики идентичности не совпала с точным сравнением выбранной пары Final");
    }
    return cachePage(result);
  }
  const comparePage = kind === "added"
    ? compareFinalAdditionPage
    : kind === "allDevices" ? compareFinalDevicePage
      : kind === "modifiedDevices" ? compareFinalModifiedDevicePage
      : kind === "modifiedGroups" ? compareFinalModificationDeviceGroupPage
      : kind === "modified" ? compareFinalModificationEventPage : kind === "unchanged" ? compareFinalUnchangedPage : compareFinalAbsencePage;
  const result = await comparePage(
    previousDevices,
    (visit) => database.forEachSnapshotChunk(currentId, visit),
    { offset, limit, timestamp: analytics.comparison.timestamp, deviceMatches: createDashboardDeviceMatcher(analytics.dashboardFilters || {}), ...(["modified", "modifiedGroups"].includes(kind) ? options : {}) },
  );
  if (state.analytics !== analytics || requestId !== state.analyticsComparisonDetailRequest) return null;
  return cachePage(result);
}

async function loadDashboardAbsencePage(analytics, offset = 0, limit = 100, sharedRequestId = null) {
  return loadDashboardComparisonPage(analytics, "absent", offset, limit, {}, sharedRequestId);
}

async function loadDashboardAdditionPage(analytics, offset = 0, limit = 100, sharedRequestId = null) {
  return loadDashboardComparisonPage(analytics, "added", offset, limit, {}, sharedRequestId);
}

async function loadDashboardUnchangedPage(analytics, offset = 0, limit = 100) {
  return loadDashboardComparisonPage(analytics, "unchanged", offset, limit);
}

async function loadDashboardModifiedDevicePage(analytics, offset = 0, limit = 100) {
  return loadDashboardComparisonPage(analytics, "modifiedDevices", offset, limit);
}

async function loadDashboardDevicePage(analytics, offset = 0, limit = 100) {
  return loadDashboardComparisonPage(analytics, "allDevices", offset, limit);
}

async function loadDashboardModificationPage(analytics, offset = 0, limit = 100, options = {}) {
  return loadDashboardComparisonPage(analytics, "modified", offset, limit, options);
}

async function loadDashboardModificationGroupPage(analytics, offset = 0, limit = 100, options = {}, sharedRequestId = null) {
  return loadDashboardComparisonPage(analytics, "modifiedGroups", offset, limit, options, sharedRequestId);
}

async function loadDashboardChangeGroupPage(analytics, category, offset = 0, limit = 100) {
  const requestId = ++state.analyticsComparisonDetailRequest;
  const comparison = analytics.comparison || {};
  const counts = summarizeChangeCategories(comparison);
  const addedCount = Math.max((comparison.added || []).length, Math.floor(Number(comparison.addedCount) || 0));
  const absentCount = Math.max((comparison.absent || []).length, Math.floor(Number(comparison.absentCount) || 0));
  const modifiedRows = comparison.modified || [];
  let modifiedCount = Number.isFinite(Number(comparison.modifiedDeviceCount))
    ? Math.max(0, Math.floor(Number(comparison.modifiedDeviceCount)))
    : modifiedRows.length;
  let criticalModifiedCount = Number.isFinite(Number(comparison.criticalModifiedDeviceCount))
    ? Math.max(0, Math.floor(Number(comparison.criticalModifiedDeviceCount)))
    : modifiedRows.reduce((count, row) => count + ((row.changes || []).some((change) => isCriticalHistoryChange("modified", change.field, change.oldValue, change.newValue)) ? 1 : 0), 0);
  if (analytics.current?.id && !modifiedRows.length && (!Number.isFinite(Number(comparison.modifiedDeviceCount)) || !Number.isFinite(Number(comparison.criticalModifiedDeviceCount)))) {
    const probe = await loadDashboardModificationGroupPage(analytics, 0, 1, { criticalOnly: category === "critical" }, requestId);
    if (!probe || state.analytics !== analytics || requestId !== state.analyticsComparisonDetailRequest) return null;
    if (!Number.isFinite(Number(comparison.modifiedDeviceCount)) && category !== "critical") modifiedCount = probe.total;
    if (!Number.isFinite(Number(comparison.criticalModifiedDeviceCount)) && category === "critical") criticalModifiedCount = probe.total;
  }
  const parts = category === "critical"
    ? [
      { kind: "absent", count: absentCount },
      { kind: "modifiedGroups", count: criticalModifiedCount, options: { criticalOnly: true } },
    ]
    : category === "modified"
      ? [{ kind: "modifiedGroups", count: modifiedCount, options: {} }]
      : [
      { kind: "added", count: addedCount },
      { kind: "absent", count: absentCount },
      { kind: "modifiedGroups", count: modifiedCount, options: {} },
    ];
  const total = parts.reduce((sum, part) => sum + part.count, 0);
  const pageOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const pageEnd = Math.min(total, pageOffset + pageSize);
  const groups = [];
  let eventPageCount = 0;
  for (const part of parts) {
    const partEnd = eventPageCount + part.count;
    const overlapStart = Math.max(pageOffset, eventPageCount);
    const overlapEnd = Math.min(pageEnd, partEnd);
    if (overlapStart < overlapEnd) {
      const localOffset = overlapStart - eventPageCount;
      const requested = overlapEnd - overlapStart;
      let result;
      if (part.kind === "added") result = await loadDashboardAdditionPage(analytics, localOffset, requested, requestId);
      else if (part.kind === "absent") result = await loadDashboardAbsencePage(analytics, localOffset, requested, requestId);
      else result = await loadDashboardModificationGroupPage(analytics, localOffset, requested, part.options, requestId);
      if (!result || state.analytics !== analytics || requestId !== state.analyticsComparisonDetailRequest) return null;
      if (result.total !== part.count) throw new Error("Страница групп устройств не совпала с точным сравнением выбранной пары Final");
      if (part.kind === "modifiedGroups") {
        const expectedEvents = category === "critical" ? Math.max(0, counts.critical - absentCount) : counts.modified;
        if (result.totalEvents !== expectedEvents) throw new Error("Группы изменений не совпали с точным количеством событий выбранной пары Final");
        groups.push(...result.groups);
      } else {
        const type = part.kind === "added" ? "added" : "absent";
        const severity = type === "added" ? "low" : "critical";
        groups.push(...result.devices.map((device) => ({ type, severity, device, changes: [] })));
      }
    }
    eventPageCount = partEnd;
  }
  const totalEvents = category === "critical" ? counts.critical : category === "modified" ? counts.modified : counts.all;
  return {
    groups,
    total,
    totalEvents,
    offset: pageOffset,
    limit: pageSize,
    hasPrevious: pageOffset > 0,
    hasNext: pageEnd < total,
  };
}

async function showAnalyticsAbsencePage(analytics, offset = 0, open = true) {
  const dialog = $("#detailsDialog");
  if (open) showDialog(dialog, "Отсутствующие устройства", '<p class="muted" role="status">Сравнение выбранных Final…</p>');
  const result = await loadDashboardAbsencePage(analytics, offset, 100);
  if (!result || state.analytics !== analytics) return;
  const expected = Number(analytics.comparison.absentCount ?? analytics.kpis.absent ?? 0);
  if (result.total !== expected) throw new Error("Число отсутствующих устройств не совпало с точным сравнением выбранных Final");
  dialog.querySelector("[data-dialog-title]").textContent = "Отсутствующие устройства";
  dialog.querySelector("[data-dialog-content]").innerHTML = absentDevicesPageContent(result);
}

function modifiedEventsContent(result, codecOnly = false) {
  const rows = result.events.map(({ device, change }) => `<tr><td>${escapeHtml(device?.mac || device?.deviceId || device?.serial || "—")}</td><td>${escapeHtml(device?.room || "—")}</td><td>${escapeHtml(change?.label || change?.field || "Изменение")}</td><td>${escapeHtml(change?.oldValue || "—")}</td><td>${escapeHtml(change?.newValue || "—")}</td></tr>`).join("");
  const start = result.offset;
  const end = Math.min(result.total, start + result.events.length);
  const pager = result.total > result.limit ? `<div class="action-row"><span class="muted">Показано ${Math.min(start + result.events.length, result.total).toLocaleString("ru-RU")} из ${result.total.toLocaleString("ru-RU")}</span><button class="button secondary" type="button" data-analytics-modified-page="${result.previousOffset ?? Math.max(0, start - result.limit)}" data-modified-codec="${codecOnly}" ${start ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-analytics-modified-page="${result.nextOffset ?? start + result.limit}" data-modified-codec="${codecOnly}" ${result.hasNext ? "" : "disabled"}>Дальше</button></div>` : `<p class="muted">Событий: ${result.total.toLocaleString("ru-RU")}</p>`;
  const table = rows ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>MAC / ID</th><th>Помещение</th><th>Поле</th><th>Было</th><th>Стало</th></tr></thead><tbody>${rows}</tbody></table></div>${pager}` : '<p class="empty">Подтверждённых изменений нет.</p>';
  const range = result.total ? `Показано ${start + 1}–${end} из ${result.total.toLocaleString("ru-RU")}` : "Событий: 0";
  return `<p class="muted">${codecOnly ? "Изменения видеоконференц-устройств" : "Подтверждённые изменения"} · ${range}</p>${table}`;
}

async function showAnalyticsModificationPage(analytics, offset = 0, codecOnly = false, open = true) {
  const dialog = $("#detailsDialog");
  const title = codecOnly ? "Изменения кодеков" : "Изменённые устройства";
  if (open) showDialog(dialog, title, '<p class="muted" role="status">Сравнение выбранных Final…</p>');
  const result = await loadDashboardModificationPage(analytics, offset, 100, codecOnly ? { deviceType: "video conference" } : {});
  if (!result || state.analytics !== analytics) return;
  const expected = Number(analytics.comparison.modifiedEventCount ?? (analytics.comparison.modified || []).reduce((count, row) => count + (row.changes || []).length, 0));
  if (!codecOnly && result.total !== expected) {
    throw new Error("Число изменений не совпало с точным сравнением выбранных Final");
  }
  dialog.querySelector("[data-dialog-title]").textContent = title;
  const diagnostics = !codecOnly ? await loadIdentityDiagnosticsMarkup(analytics) : "";
  if (state.analytics !== analytics) return;
  dialog.querySelector("[data-dialog-content]").innerHTML = `${modifiedEventsContent(result, codecOnly)}${diagnostics}`;
}

function paintAnalyticsSummary(analytics) {
  paintHistoryBackfill(analytics);
  $("#analyticsHistoryKpis").innerHTML = "";
  $("#datasetOverview").textContent = "Подробная сводка выбранного статуса рассчитывается…";
  for (const selector of ["#vendorRanking", "#modelRanking", "#churnRanking", "#roomOccupancyRanking", "#clusterSummary", "#changeTable"]) {
    const host = $(selector);
    if (host) host.replaceChildren();
  }
  for (const selector of ["#weeklyChart", "#presenceChart"]) {
    const canvas = $(selector);
    canvas?.getContext?.("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }
  for (const selector of ["#dashboardStatusTotalsChart", "#dashboardStatusVendorsChart", "#dashboardStatusFieldsChart", "#dashboardStatusAbsentChart"]) {
    const canvas = $(selector);
    canvas?.getContext?.("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }
  $("#roomOccupancyStatus").textContent = "Сводка выбранного статуса рассчитывается…";
  $("#analyticsReportPreview").textContent = "Сводка выбранного статуса рассчитывается…";
  $("#exportAnalyticsReportButton").disabled = true;
  drawFinalTotalsTrend($("#totalChart"), analytics.totals || []);
  renderKpis($("#analyticsKpis"), analytics.kpis, {
    devices: () => {
      selectDashboardKpiStatus("devices", analytics);
      showDashboardFleetDialog(analytics).catch(showError);
    },
    modified: () => selectDashboardKpiStatus("modified", analytics),
    absent: () => selectDashboardKpiStatus("absent", analytics),
    unchanged: () => selectDashboardKpiStatus("unchanged", analytics),
    manufacturers: () => showDashboardAggregateDialog("manufacturers", analytics).catch(showError),
    rooms: () => showDashboardAggregateDialog("rooms", analytics).catch(showError),
    withoutRoom: () => showUnassignedAnalyticsPage(analytics, 1, true).catch(showError),
    changedRooms: () => openRoomCoverageDialog(analytics),
    allChangedRooms: () => openRoomCoverageDialog(analytics, true),
    switchAnomalyRooms: () => openRoomAnomalyDialog(analytics),
    codecChanges: () => showAnalyticsModificationPage(analytics, 0, true).catch(showError),
  }, activeDashboardWidgetKeys(), {
    devices: Number(analytics.dashboardFilteredDeviceCount ?? analytics.kpis.devices).toLocaleString("ru-RU"),
  });
  applyDashboardWidgetVisibility();
}

function drawDashboardStatusCharts(analytics) {
  if (!analytics?.detailsReady || !analytics.dataset) return;
  const model = buildAnalyticsDashboardExportModel(analytics, state.analyticsDashboardSettings);
  const canvasByKey = {
    "chart:totals": "#dashboardStatusTotalsChart",
    "chart:vendors": "#dashboardStatusVendorsChart",
    "chart:fields": "#dashboardStatusFieldsChart",
    "chart:absent-vendors": "#dashboardStatusAbsentChart",
  };
  const style = getComputedStyle(document.body);
  const color = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
  const colors = {
    background: color("--bg", "#f4f7f8"), surface: color("--surface", "#fff"),
    text: color("--text", "#172326"), muted: color("--muted", "#66777b"),
    grid: color("--border", "#d6e0e2"), axis: color("--muted", "#66777b"),
    positive: color("--primary", "#087f8c"), negative: color("--danger", "#c92a2a"),
    blue: color("--primary-dark", "#2667a8"),
  };
  for (const chart of model.charts) {
    const canvas = $(canvasByKey[chart.key]);
    const context = canvas?.getContext?.("2d");
    if (!canvas || !context) continue;
    canvas.width = Math.max(800, canvas.clientWidth);
    canvas.height = Math.max(240, canvas.clientHeight);
    drawDashboardExportChart(context, { ...chart, title: "" }, 0, 0, canvas.width, canvas.height, colors);
  }
}

function paintAnalyticsDetails(analytics) {
  paintHistoryBackfill(analytics);
  const history = analytics.history || { snapshots: 0, deviceTotal: 0, uniqueMacs: 0 };
  $("#analyticsHistoryKpis").innerHTML = [
    ["Final в истории", history.snapshots],
    ["Устройств во всех Final", history.deviceTotal],
    ["Уникальных MAC во всех Final", history.uniqueMacs],
  ].map(([label, value]) => `<article class="kpi"><span>${label}</span><strong>${Number(value).toLocaleString("ru-RU")}</strong></article>`).join("");
  renderKpis($("#analyticsKpis"), analytics.kpis, {
    devices: () => {
      selectDashboardKpiStatus("devices", analytics);
      showDashboardFleetDialog(analytics).catch(showError);
    },
    modified: () => selectDashboardKpiStatus("modified", analytics),
    absent: () => selectDashboardKpiStatus("absent", analytics),
    unchanged: () => selectDashboardKpiStatus("unchanged", analytics),
    manufacturers: () => showDashboardAggregateDialog("manufacturers", analytics).catch(showError),
    rooms: () => showDashboardAggregateDialog("rooms", analytics).catch(showError),
    withoutRoom: () => showUnassignedAnalyticsPage(analytics, 1, true).catch(showError),
    changedRooms: () => openRoomCoverageDialog(analytics),
    allChangedRooms: () => openRoomCoverageDialog(analytics, true),
    switchAnomalyRooms: () => openRoomAnomalyDialog(analytics),
    codecChanges: () => showAnalyticsModificationPage(analytics, 0, true).catch(showError),
  }, activeDashboardWidgetKeys(), {
    devices: `${Number(history.uniqueMacs || 0).toLocaleString("ru-RU")} / ${Number(analytics.dashboardFilteredDeviceCount ?? analytics.kpis.devices ?? 0).toLocaleString("ru-RU")}`,
    manufacturers: Number(analytics.dataset?.summary?.uniqueVendors ?? analytics.kpis.manufacturers).toLocaleString("ru-RU"),
    rooms: Number(analytics.dataset?.roomOccupancy?.uniqueRooms ?? analytics.dataset?.summary?.uniqueRooms ?? analytics.kpis.rooms).toLocaleString("ru-RU"),
  });
  drawWeekly($("#weeklyChart"), analytics.weekly);
  drawFinalChangeTrend($("#presenceChart"), analytics.snapshotChanges);
  drawFinalTotalsTrend($("#totalChart"), analytics.totals);
  renderRanked($("#vendorRanking"), analytics.dataset?.charts?.vendors || analytics.vendors, "Нет данных производителей");
  $("#modelRanking").innerHTML = analytics.models.length
    ? analytics.models.map((item) => `<button class="rank-row model-prefix-link" type="button" data-model-prefix-query="${escapeHtml(item.label)}"><span>${escapeHtml(item.label)}</span><strong>${Number(item.value).toLocaleString("ru-RU")}</strong></button>`).join("")
    : '<p class="empty">Нет данных моделей</p>';
  $("#modelRanking").onclick = (event) => {
    const button = event.target.closest("[data-model-prefix-query]");
    if (button) openModelPrefixAnalytics(button.dataset.modelPrefixQuery).catch(showError);
  };
  renderRanked($("#churnRanking"), analytics.churn.slice(0, 12).map((item) => ({ label: item.mac, value: item.transitions })), "Повторно исчезающих MAC нет");
  $("#openChurnButton").onclick = () => {
    let page = 1;
    showDialog($("#detailsDialog"), "MAC, которые исчезают и появляются", `<label>Поиск по MAC и данным устройства<input type="search" data-churn-search placeholder="MAC, модель, помещение, IP"></label><div class="table-scroll"><table class="data-table"><thead><tr><th>MAC</th><th>Производитель</th><th>Модель</th><th>IP</th><th>Помещение</th><th>Появлений</th><th>Исчезновений</th><th>Возвращений</th><th>Всего переходов</th></tr></thead><tbody data-churn-rows>${churnContent(analytics.churn, { page, pageSize: 100 })}</tbody></table></div>`);
    const search = $("#detailsDialog [data-churn-search]");
    const rows = $("#detailsDialog [data-churn-rows]");
    search.addEventListener("input", () => { page = 1; rows.innerHTML = churnContent(analytics.churn, { query: search.value, page, pageSize: 100 }); });
    rows.addEventListener("click", async (event) => {
      const pageButton = event.target.closest("[data-churn-page]");
      if (pageButton && !pageButton.disabled) {
        page = Number(pageButton.dataset.churnPage) || 1;
        rows.innerHTML = churnContent(analytics.churn, { query: search.value, page, pageSize: 100 });
        return;
      }
      const button = event.target.closest("[data-churn-transitions]");
      if (!button) return;
      const mac = button.dataset.churnTransitions;
      const row = Array.from(rows.querySelectorAll("[data-churn-transition-detail]"))
        .find((candidate) => candidate.dataset.churnTransitionDetail === mac);
      const content = row?.querySelector("td");
      if (!row || !content) return;
      if (row.dataset.loaded === "true") {
        row.hidden = !row.hidden;
        return;
      }
      button.disabled = true;
      button.textContent = "Загрузка…";
      try {
        const transitions = await collectPresenceTransitions(mac, state.snapshotMetadata, (snapshotId, visit) => database.forEachSnapshotChunk(snapshotId, visit), { filters: analytics.dashboardFilters || {} });
        content.innerHTML = transitions.length
          ? `<details open><summary>Переходы: ${transitions.length.toLocaleString("ru-RU")}</summary><ol>${transitions.map((item) => `<li><strong>${item.type === "absent" ? "Исчезновение" : "Возвращение"}</strong> · ${escapeHtml(item.date || "Дата не указана")} · ${escapeHtml(item.name || item.snapshotId || "Final")}</li>`).join("")}</ol></details>`
          : '<p class="empty">Переходы не найдены для текущих фильтров.</p>';
        row.dataset.loaded = "true";
        row.hidden = false;
      } catch (error) {
        content.textContent = error?.message || String(error);
        row.hidden = false;
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = "Детали";
        }
      }
    });
  };
  renderAnalyticsChangeCategories(analytics.comparison)?.catch(showError);
  applyDashboardWidgetVisibility();
  $("#datasetOverview").innerHTML = renderOverview(analytics.dataset);
  const occupancy = analytics.dataset.roomOccupancy;
  $("#roomOccupancyStatus").textContent = `Распределено ${occupancy.assignedDevices.toLocaleString("ru-RU")} из ${analytics.dataset.summary.devices.toLocaleString("ru-RU")} (${occupancy.assignedPercent.toFixed(1)}%) · без помещения ${occupancy.unassignedDevices.toLocaleString("ru-RU")} · помещений ${occupancy.uniqueRooms.toLocaleString("ru-RU")} · среднее ${occupancy.averageDevicesPerRoom.toFixed(1)} устройства на помещение`;
  renderRanked($("#roomOccupancyRanking"), occupancy.rooms.map((item) => ({ label: `${item.label} · ${item.percentOfAssigned.toFixed(1)}% распределённых`, value: item.count })), "Нет данных о заполненных помещениях");
  $("#analyticsReportPreview").textContent = analytics.dataset.reportText;
  $("#exportAnalyticsReportButton").disabled = !analytics.dataset.summary.devices;
  const clusterSummary = $("#clusterSummary");
  clusterSummary.innerHTML = renderClusters(analytics.dataset, 50, state.analyticsClusterPage);
  clusterSummary.onclick = (event) => {
    const button = event.target.closest("[data-cluster-page]");
    if (!button || button.disabled) return;
    const page = Number(button.dataset.clusterPage) || 0;
    const clusters = analytics.dataset.clusters;
    if (!clusters.queryId) {
      state.analyticsClusterPage = page;
      clusters.pageItems = null;
      clusters.page = page;
      clusterSummary.innerHTML = renderClusters(analytics.dataset, 50, page);
      return;
    }
    const after = page > state.analyticsClusterPage ? clusters.nextCursor : state.analyticsClusterCursors[page];
    if (!after && page > 0) return;
    database.analyticsAggregatePage(clusters.queryId, "cluster", { after, limit: 50 }).then((result) => {
      if (state.analytics !== analytics) return;
      state.analyticsClusterPage = page;
      state.analyticsClusterCursors[page] = after || null;
      state.analyticsClusterCursors[page + 1] = result.nextCursor;
      clusters.pageItems = result.rows.map((row) => ({ ...row.data, id: row.value, count: row.count }));
      clusters.page = page;
      clusters.pageTotal = result.total;
      clusters.pageHasMore = result.hasMore;
      clusters.nextCursor = result.nextCursor;
      clusterSummary.innerHTML = renderClusters(analytics.dataset, 50, page);
    }).catch(showError);
  };
  const topologySummary = $("#topologySummary");
  const paintTopology = () => {
    const openSwitches = new Set([...topologySummary.querySelectorAll("details.local-topology-node[open]")].map((item) => item.dataset.topologyNode));
    const openPorts = new Set([...topologySummary.querySelectorAll("details.local-topology-port[open]")].map((item) => item.dataset.topologyPortDetail));
    topologySummary.innerHTML = renderTopology(
      analytics.dataset,
      20,
      state.analyticsTopologyPage,
      50,
      state.analyticsTopologyPortPages,
      state.analyticsTopologyDevicePages,
      state.analyticsTopologyUnassignedPage,
      state.analyticsTopologyDevicePageData,
      state.analyticsTopologyUnassignedPageData,
    );
    topologySummary.querySelectorAll("details.local-topology-node").forEach((item) => { item.open = openSwitches.has(item.dataset.topologyNode); });
    topologySummary.querySelectorAll("details.local-topology-port").forEach((item) => { item.open = openPorts.has(item.dataset.topologyPortDetail); });
  };
  const fetchTopologySwitchPage = async (page) => {
    const topology = analytics.dataset.topology;
    if (!topology.queryId || page < 0) return;
    const backwards = page < state.analyticsTopologyPage;
    const cursor = backwards ? topology.firstCursor : topology.nextCursor;
    if (!cursor && (backwards || page > 0)) return;
    const result = await database.analyticsAggregateRankedPage(topology.queryId, "topology-switch", {
      ...(backwards ? { before: cursor } : { after: cursor }),
      limit: 20,
    });
    if (state.analytics !== analytics) return;
    const nodes = await loadTopologyAggregateNodes(topology.queryId, result.rows, 50);
    if (state.analytics !== analytics) return;
    topology.nodes = nodes;
    topology.pageItems = nodes;
    topology.page = page;
    topology.pageTotal = result.total;
    topology.pageHasMore = result.hasMore;
    topology.firstCursor = result.firstCursor;
    topology.nextCursor = result.nextCursor;
    state.analyticsTopologyPage = page;
    state.analyticsTopologyPortPages = {};
    state.analyticsTopologyDevicePages = {};
    state.analyticsTopologyDevicePageData = {};
    paintTopology();
  };
  const fetchTopologyChildPage = async (switchIp, kind, page) => {
    const topology = analytics.dataset.topology;
    const node = topology.nodes.find((item) => item.switchIp === switchIp);
    if (!topology.queryId || !node || page < 0) return;
    const metric = kind === "ports" ? `topology-port:${switchIp}` : `topology-room:${switchIp}`;
    const current = kind === "ports" ? node.portPageData : node.roomPageData;
    if (!current) return;
    const backwards = page < current.page;
    const cursor = backwards ? current.firstCursor : current.nextCursor;
    if (!cursor && (backwards || page > 0)) return;
    const result = await database.analyticsAggregateValuePage(topology.queryId, metric, {
      ...(backwards ? { before: cursor } : { after: cursor }),
      limit: 50,
    });
    if (state.analytics !== analytics || !topology.nodes.includes(node)) return;
    if (kind === "ports") {
      node.ports = result.rows.map((item) => ({ port: item.value, deviceCount: item.count }));
      node.portPageData = { page, firstCursor: result.firstCursor, nextCursor: result.nextCursor, hasMore: result.hasMore };
      state.analyticsTopologyDevicePages = {};
      state.analyticsTopologyDevicePageData = {};
    } else {
      node.rooms = result.rows.map((item) => item.value);
      node.roomPageData = { page, firstCursor: result.firstCursor, nextCursor: result.nextCursor, hasMore: result.hasMore };
    }
    paintTopology();
  };
  const rememberTopologyPage = (target, key, value, limit = 50) => {
    delete target[key];
    target[key] = value;
    while (Object.keys(target).length > limit) delete target[Object.keys(target)[0]];
  };
  const fetchPortDevicePage = async (portKey, page) => {
    const snapshotId = analytics.current?.id;
    if (!snapshotId) return;
    const currentData = state.analyticsTopologyDevicePageData[portKey];
    if (currentData?.page === page) return;
    const [switchIp, switchPort] = JSON.parse(portKey);
    const result = await database.loadSnapshotDevicePage(snapshotId, { switchIp, switchPort, page: page + 1, limit: 50 });
    if (state.analytics !== analytics || state.analytics.current?.id !== snapshotId || state.analyticsTopologyDevicePages[portKey] !== page) return;
    rememberTopologyPage(state.analyticsTopologyDevicePageData, portKey, { page, devices: result.devices, total: result.total });
    paintTopology();
  };
  const fetchUnassignedPage = async (page) => {
    const snapshotId = analytics.current?.id;
    if (!snapshotId) return;
    if (state.analyticsTopologyUnassignedPageData?.page === page) return;
    const result = await database.loadSnapshotDevicePage(snapshotId, { unassigned: true, page: page + 1, limit: 50 });
    if (state.analytics !== analytics || state.analytics.current?.id !== snapshotId || state.analyticsTopologyUnassignedPage !== page) return;
    state.analyticsTopologyUnassignedPageData = { page, devices: result.devices, total: result.total };
    paintTopology();
  };
  paintTopology();
  topologySummary.onclick = (event) => {
    const switchButton = event.target.closest("[data-topology-switch-page]");
    if (switchButton && !switchButton.disabled) {
      fetchTopologySwitchPage(Number(switchButton.dataset.topologySwitchPage) || 0).catch(showError);
      return;
    }
    const portButton = event.target.closest("[data-topology-port-page]");
    if (portButton && !portButton.disabled) {
      fetchTopologyChildPage(portButton.dataset.topologySwitch, "ports", Number(portButton.dataset.topologyPortPage) || 0).catch(showError);
      return;
    }
    const roomButton = event.target.closest("[data-topology-room-page]");
    if (roomButton && !roomButton.disabled) {
      fetchTopologyChildPage(roomButton.dataset.topologySwitch, "rooms", Number(roomButton.dataset.topologyRoomPage) || 0).catch(showError);
      return;
    }
    const loadPortsButton = event.target.closest("[data-topology-load-ports]");
    if (loadPortsButton && !loadPortsButton.disabled) {
      fetchTopologyChildPage(loadPortsButton.dataset.topologyLoadPorts, "ports", 0).catch(showError);
      return;
    }
    const deviceButton = event.target.closest("[data-topology-device-page]");
    if (deviceButton && !deviceButton.disabled) {
      rememberTopologyPage(state.analyticsTopologyDevicePages, deviceButton.dataset.topologyPortKey, Number(deviceButton.dataset.topologyDevicePage) || 0);
      fetchPortDevicePage(deviceButton.dataset.topologyPortKey, state.analyticsTopologyDevicePages[deviceButton.dataset.topologyPortKey]).catch(showError);
      paintTopology();
      return;
    }
    const loadDeviceButton = event.target.closest("[data-topology-load-device-page]");
    if (loadDeviceButton && !loadDeviceButton.disabled) {
      const portKey = loadDeviceButton.dataset.topologyPortKey;
      const page = Number(loadDeviceButton.dataset.topologyLoadDevicePage) || 0;
      rememberTopologyPage(state.analyticsTopologyDevicePages, portKey, page);
      fetchPortDevicePage(portKey, page).catch(showError);
      return;
    }
    const unassignedButton = event.target.closest("[data-topology-unassigned-page]");
    if (unassignedButton && !unassignedButton.disabled) {
      state.analyticsTopologyUnassignedPage = Number(unassignedButton.dataset.topologyUnassignedPage) || 0;
      fetchUnassignedPage(state.analyticsTopologyUnassignedPage).catch(showError);
      paintTopology();
      return;
    }
    const loadUnassignedButton = event.target.closest("[data-topology-load-unassigned-page]");
    if (loadUnassignedButton && !loadUnassignedButton.disabled) {
      state.analyticsTopologyUnassignedPage = Number(loadUnassignedButton.dataset.topologyLoadUnassignedPage) || 0;
      fetchUnassignedPage(state.analyticsTopologyUnassignedPage).catch(showError);
    }
  };
  state.analyticsAutoRefreshing = false;
}

function paintHistoryBackfill(analytics) {
  const status = $("#analyticsHistoryFallback");
  const restored = Number(analytics.historyBackfill?.restoredFields || 0);
  const ambiguous = Number(analytics.historyBackfill?.ambiguousMatches || 0);
  status.hidden = !restored && !ambiguous;
  status.textContent = status.hidden ? "" : `Базовый Final: восстановлено исторических значений ${restored.toLocaleString("ru-RU")}; неоднозначных совпадений оставлено без переноса: ${ambiguous.toLocaleString("ru-RU")}.`;
}

async function renderMacOptions(query = $("#macHistorySearch").value) {
  const requestId = ++macHistoryOptionsRequest;
  const search = String(query || "").trim();
  const macs = await database.inventoryMacSuggestions(search, 100);
  if (requestId !== macHistoryOptionsRequest || $("#macHistorySearch").value.trim() !== search) return;
  const options = $("#macHistoryOptions");
  options.replaceChildren(...macs.map((mac) => {
    const option = document.createElement("option");
    option.value = mac;
    return option;
  }));
}

async function initializeHistoryLog() {
  if (state.historyLog.initializing) return state.historyLog.initializing;
  const initializing = (async () => {
    const storedColumns = await database.getSetting("historyLogColumns", null);
    const storedWidths = await database.getSetting("historyLogColumnWidths", null);
    state.historyLog.columns = normalizedHistoryLogColumns(storedColumns);
    state.historyLog.columnWidths = normalizedHistoryLogColumnWidths(storedWidths);
    if (!Object.values(state.historyLog.filters).some((value) => String(value || "").trim())) {
      state.historyLog.filters = defaultHistoryLogFilters();
      for (const [name, value] of Object.entries(state.historyLog.filters)) {
        $("#historyLogFilters").elements.namedItem(name).value = value;
      }
    }
    $("#historyLogColumns").innerHTML = historyLogColumnControls(state.historyLog.columns, state.historyLog.columnWidths);
    await loadHistoryLog({ filters: state.historyLog.filters, cursor: null, previous: [] });
    state.historyLog.initialized = true;
  })();
  state.historyLog.initializing = initializing;
  try {
    await initializing;
  } finally {
    if (state.historyLog.initializing === initializing) state.historyLog.initializing = null;
  }
}

function setVendorDetectorControlsEnabled(enabled) {
  for (const selector of ["#vendorOuiEnabled", "#vendorMac5Enabled", "#vendorTextEnabled", "#vendorInferenceEnabled", "#vendorInferenceThreshold"]) {
    $(selector).disabled = !enabled;
  }
}

function applyVendorDetectorSettings(settings) {
  state.vendorDetectorSettings = normalizeVendorDetectorSettings(settings);
  $("#vendorDetectorEnabled").checked = state.vendorDetectorSettings.enabled;
  $("#vendorOuiEnabled").checked = state.vendorDetectorSettings.useOui3;
  $("#vendorMac5Enabled").checked = state.vendorDetectorSettings.useMac5;
  $("#vendorTextEnabled").checked = state.vendorDetectorSettings.useText;
  $("#vendorInferenceEnabled").checked = state.vendorDetectorSettings.useInference;
  setVendorDetectorControlsEnabled(state.vendorDetectorSettings.enabled);
  const percent = Math.round(state.vendorDetectorSettings.confidenceThreshold * 100);
  $("#vendorInferenceThreshold").value = String(percent);
  $("#vendorInferenceThresholdLabel").textContent = `${percent}%`;
}

function applyHistoryEnrichmentSettings(settings) {
  state.historyEnrichmentSettings = normalizeHistoryEnrichmentSettings(settings);
  $("#historyEnrichmentEnabled").checked = state.historyEnrichmentSettings.enabled;
  $("#historyEnrichmentPriority").checked = state.historyEnrichmentSettings.priorityHistory;
  $("#historyEnrichmentPrecedenceProfile").value = state.historyEnrichmentSettings.precedenceProfile;
  $("#historyEnrichmentOui").checked = state.historyEnrichmentSettings.useOuiMatch;
  $("#historyEnrichmentMac5").checked = state.historyEnrichmentSettings.useMac5Match;
}

function applyIpEnrichmentSettings(settings) {
  state.ipEnrichmentSettings = normalizeIpEnrichmentSettings(settings);
  $("#ipEnrichmentEnabled").checked = state.ipEnrichmentSettings.enabled;
  $("#ipEnrichmentPartial").checked = state.ipEnrichmentSettings.partialMatch;
  $("#ipEnrichmentOverwrite").checked = state.ipEnrichmentSettings.overwrite;
  $("#ipHistoricalAddressEnabled").checked = state.ipEnrichmentSettings.historicalAddress;
}

function applyEnrichmentFieldSettings(settings) {
  state.enrichmentFieldSettings = normalizeEnrichmentFieldSettings(settings);
  $$("[data-enrichment-field]").forEach((input) => {
    input.checked = state.enrichmentFieldSettings[input.dataset.enrichmentField];
  });
}

function applyOuiFormatSettings(settings) {
  state.ouiFormats = normalizeOuiFormats(settings);
  $$("[data-oui-format]").forEach((input) => {
    input.checked = state.ouiFormats[input.dataset.ouiFormat];
  });
}

async function saveOuiFormatSettings() {
  const settings = normalizeOuiFormats(Object.fromEntries(
    $$("[data-oui-format]").map((input) => [input.dataset.ouiFormat, input.checked]),
  ));
  await database.setSetting("ouiFormats", settings);
  applyOuiFormatSettings(settings);
  if (state.fileCompare.result?.comparison) renderFileCompareResult(state.fileCompare.result).catch(showError);
}

async function saveEnrichmentFieldSettings() {
  const settings = normalizeEnrichmentFieldSettings(Object.fromEntries(
    $$("[data-enrichment-field]").map((input) => [input.dataset.enrichmentField, input.checked]),
  ));
  await database.setSetting("enrichmentFieldSettings", settings);
  applyEnrichmentFieldSettings(settings);
  $("#enrichmentFieldSettingsStatus").textContent = "Поля слияния сохранены в этой базе браузера.";
}

async function saveVendorDetectorSettings() {
  const settings = normalizeVendorDetectorSettings({
    enabled: $("#vendorDetectorEnabled").checked,
    useOui3: $("#vendorOuiEnabled").checked,
    useMac5: $("#vendorMac5Enabled").checked,
    useText: $("#vendorTextEnabled").checked,
    useInference: $("#vendorInferenceEnabled").checked,
    confidenceThreshold: Number($("#vendorInferenceThreshold").value) / 100,
  });
  await database.setSetting("vendorDetectorSettings", settings);
  applyVendorDetectorSettings(settings);
  $("#vendorInferenceStatus").textContent = "Настройки OUI, MAC5 и локального автоопределения сохранены. Они применятся при следующем объединении.";
}

async function saveHistoryEnrichmentSettings() {
  const settings = normalizeHistoryEnrichmentSettings({
    enabled: $("#historyEnrichmentEnabled").checked,
    priorityHistory: $("#historyEnrichmentPriority").checked,
    precedenceProfile: $("#historyEnrichmentPrecedenceProfile").value,
    useOuiMatch: $("#historyEnrichmentOui").checked,
    useMac5Match: $("#historyEnrichmentMac5").checked,
  });
  await database.setSetting("historyEnrichmentSettings", settings);
  applyHistoryEnrichmentSettings(settings);
  $("#historyEnrichmentStatus").textContent = "Настройки сохранены в этой базе браузера и применятся при следующем объединении.";
}

async function saveIpEnrichmentSettings() {
  const settings = normalizeIpEnrichmentSettings({
    enabled: $("#ipEnrichmentEnabled").checked,
    partialMatch: $("#ipEnrichmentPartial").checked,
    overwrite: $("#ipEnrichmentOverwrite").checked,
    historicalAddress: $("#ipHistoricalAddressEnabled").checked,
  });
  await database.setSetting("ipEnrichmentSettings", settings);
  applyIpEnrichmentSettings(settings);
  $("#ipEnrichmentStatus").textContent = "Настройки сохранены локально и применятся при следующем объединении.";
}

async function exportSearchCsv() {
  const columns = visibleInventoryColumns(state.inventoryColumnConfig);
  const query = keyText(state.search);
  const iterable = inventorySearchCsvChunks({
    readPage: ({ afterId, limit }) => database.inventoryPage({ afterId, limit }),
    query,
    columns,
    matches: (device, search) => !search || matchesDeviceSearch(device, search),
    cellText: (device, key, rowNumber) => inventoryCellText(device, key, rowNumber),
    pageSize: 500,
    chunkRows: 500,
  });
  const mime = "text/csv;charset=utf-8";
  const stream = readableTextStreamFromIterable(iterable);
  await downloadReadableStream("devices.csv", stream, mime, "Inventory CSV");
}

async function openMacHistory({ includeOptionalHostHistory = false } = {}) {
  const mac = normalizeMac($("#macHistorySearch").value);
  if (!mac) throw new Error("Введите корректный MAC-адрес");
  const cacheKey = `${state.temporalDataRevision}:${mac}`;
  const cachedEvents = includeOptionalHostHistory ? null : readMacHistoryCache(state.macHistoryCache, cacheKey);
  if (cachedEvents) {
    renderMacHistory(cachedEvents);
    finishProgress("Хронология построена");
    return;
  }
  const orderedSnapshots = [...state.snapshotMetadata].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const timeline = createMacTimelineAccumulator(mac);
  for (const metadata of orderedSnapshots) {
    const matches = [];
    await database.forEachSnapshotChunk(metadata.id, (devices) => {
      for (const device of devices) if (deviceContainsNormalizedMac(device, mac)) matches.push(device);
    });
    timeline.addSnapshot(metadata, matches);
  }
  const events = timeline.events;
  const storedHistoryCount = await database.forEachMacHistoryPage(mac, (page) => {
    for (const item of page) timeline.addHistory(item, orderedSnapshots);
  });
  let legacyObservationCount = 0;
  let legacyCursor = null;
  do {
    const page = await database.legacyObservationPage({ mac, cursor: legacyCursor, limit: 500 });
    legacyObservationCount += page.rows.length;
    for (const observation of page.rows) {
      const event = legacyObservationTimelineEvent(observation);
      if (event) timeline.addEvent(event);
    }
    legacyCursor = page.nextCursor;
    if (!page.hasMore) break;
  } while (legacyCursor);
  let hostHistoryCount = 0;
  if (includeOptionalHostHistory) {
    const status = $("#optionalHostMacHistoryStatus");
    status.textContent = "Читаю страницы History выбранного MAC из SQLite optional host…";
    const snapshotStatuses = createMacTimelineSnapshotStatusIndex(events);
    let cursor = 0;
    let total = 0;
    let hasMore = true;
    while (hasMore) {
      const page = await listOptionalHostHistoryForMac(mac, { after: cursor, limit: 250 });
      total = page.total;
      for (const item of page.events) {
        if (item.payloadOmitted) continue;
        const snapshotId = item.sourceFinalId;
        const source = `SQLite optional host${item.source ? ` · ${item.source}` : ""}`;
        const device = { ...item, id: item.internalDeviceId || "", mac: item.mac || mac };
        if (item.eventType === "modified") {
          timeline.addHistory({
            id: `optional-host-${item.id}`,
            snapshotId,
            timestamp: item.observedAt,
            type: "modified",
            deviceId: item.internalDeviceId || "",
            mac: item.mac || mac,
            source,
            field: item.field,
            oldValue: item.fromValue,
            newValue: item.toValue,
            device,
          }, orderedSnapshots);
          hostHistoryCount += 1;
          continue;
        }
        const expectedStatus = item.eventType === "added" ? "first" : "absent";
        const representedBySnapshot = snapshotStatuses.has(snapshotId, expectedStatus);
        if (!representedBySnapshot) {
          timeline.addEvent({
            date: item.observedAt,
            snapshotId,
            snapshotName: `SQLite · ${snapshotId}`,
            status: "observation",
            observationKind: `optional-host-${item.eventType}`,
            source,
            historyOnly: true,
            ...(item.eventType === "absent" ? { before: device } : { after: device }),
            changes: [],
          });
        }
        snapshotStatuses.add(snapshotId, expectedStatus);
        hostHistoryCount += 1;
      }
      if (page.nextCursor === null) {
        hasMore = false;
        continue;
      }
      if (page.nextCursor <= cursor) throw new Error("Курсор History optional host не продвинулся");
      cursor = page.nextCursor;
    }
    status.textContent = `History optional host: ${hostHistoryCount.toLocaleString("ru-RU")} событий из ${total.toLocaleString("ru-RU")}; данные показаны вместе с историей браузера.`;
  }
  events.sort((left, right) => String(left.date || left.timestamp || left.createdAt || "").localeCompare(String(right.date || right.timestamp || right.createdAt || "")));
  if (!includeOptionalHostHistory) writeMacHistoryCache(state.macHistoryCache, cacheKey, events, storedHistoryCount + legacyObservationCount + orderedSnapshots.length);
  renderMacHistory(events);
  finishProgress("Хронология построена");
}

function renderMacHistory(events) {
  const timeline = $("#macTimeline");
  const appearancesPanel = $("#macAppearancesPanel");
  let timelinePage = 1;
  let appearancePage = 1;
  const appearances = events.some((event) => !event.historyOnly && ["first", "present", "changed", "observation"].includes(event.status));
  $("#macTimelineSummary").innerHTML = macTimelineSummaryContent(events);
  $("#macTimelineSummary").hidden = events.length === 0;
  const renderTimelinePage = () => { timeline.innerHTML = macTimelineContent(events, { page: timelinePage, pageSize: 100 }); };
  renderTimelinePage();
  timeline.classList.toggle("empty", events.length === 0);
  timeline.onclick = (event) => {
    const button = event.target.closest("[data-mac-timeline-page]");
    if (!button || button.disabled) return;
    timelinePage = Number(button.dataset.macTimelinePage) || 1;
    renderTimelinePage();
  };
  $("#macAppearancesPanel").hidden = !appearances;
  const renderAppearancePage = () => { $("#macAppearancesTable").innerHTML = macTimelineAppearancesContent(events, { page: appearancePage, pageSize: 100 }); };
  renderAppearancePage();
  appearancesPanel.onclick = (event) => {
    const button = event.target.closest("[data-mac-appearance-page]");
    if (!button || button.disabled) return;
    appearancePage = Number(button.dataset.macAppearancePage) || 1;
    renderAppearancePage();
  };
}

async function loadHistoryLog({ filters = state.historyLog.filters, cursor = null, previous = state.historyLog.previous } = {}) {
  const dataRevision = state.temporalDataRevision;
  const requestId = state.historyLog.requestId + 1;
  state.historyLog.requestId = requestId;
  $("#historyLogStatus").textContent = "Загружается журнал изменений…";
  const page = await database.historySearchPage(filters, { cursor, limit: 100 });
  if (requestId !== state.historyLog.requestId) return;
  if (dataRevision !== state.temporalDataRevision) {
    return loadHistoryLog({ filters, cursor: null, previous: [] });
  }
  state.historyLog = { ...state.historyLog, filters, cursor, previous, page, requestId, loaded: true, loadedRevision: dataRevision };
  const results = $("#historyLogResults");
  results.classList.toggle("empty", page.rows.length === 0);
  results.innerHTML = historyLogContent(page.rows, state.historyLog.columns, state.historyLog.selectedIds, state.historyLog.columnWidths, isEngineerActive());
  const pageNumber = previous.length + 1;
  $("#historyLogStatus").textContent = `${page.total.toLocaleString("ru-RU")} событий · страница ${pageNumber} · показано ${page.rows.length.toLocaleString("ru-RU")} · отмечено ${state.historyLog.selectedIds.size.toLocaleString("ru-RU")}`;
  $("#historyLogPreviousButton").disabled = previous.length === 0;
  $("#historyLogNextButton").disabled = !page.hasMore;
  $("#deleteHistoryEventsButton").disabled = state.historyLog.selectedIds.size === 0;
  $("#deleteFilteredHistoryEventsButton").disabled = page.total === 0;
}

function searchHistoryLog() {
  const filters = Object.fromEntries(new globalThis.FormData($("#historyLogFilters")).entries());
  state.historyLog.selectedIds.clear();
  return loadHistoryLog({ filters, cursor: null, previous: [] });
}

function historyDateSummaryHtml(days, macs) {
  const dayRows = days.map((row) => `<tr><td>${escapeHtml(row.date)}</td><td>${row.total.toLocaleString("ru-RU")}</td><td>${Number(row.added || 0).toLocaleString("ru-RU")}</td><td>${Number(row.removed || 0).toLocaleString("ru-RU")}</td><td>${Number(row.modified || 0).toLocaleString("ru-RU")}</td></tr>`).join("");
  const macRows = macs.map((row) => `<tr><td>${escapeHtml(row.value)}</td><td>${row.count.toLocaleString("ru-RU")}</td><td>${escapeHtml(row.data?.lastTimestamp || "—")}</td></tr>`).join("");
  return `<h4>Статистика по датам</h4><div class="table-scroll"><table class="data-table history-date-rows" data-virtual-scroll="true"><thead><tr><th>Дата</th><th>Всего</th><th>Добавлено</th><th>Удалено</th><th>Изменено</th></tr></thead><tbody>${dayRows || '<tr><td colspan="5">Нет событий за период</td></tr>'}</tbody></table></div><h4>Топ MAC</h4><div class="table-scroll"><table class="data-table"><thead><tr><th>MAC</th><th>Изменений</th><th>Последнее изменение</th></tr></thead><tbody>${macRows || '<tr><td colspan="3">Нет событий с MAC</td></tr>'}</tbody></table></div>`;
}

async function buildHistoryDateSummary({ after = null, append = false } = {}) {
  const status = $("#historyDateSummaryStatus");
  const results = $("#historyDateSummaryResults");
  let queryId = state.historyDateSummary.queryId;
  if (!append || !queryId) {
    status.textContent = "Подсчитывается полный журнал…";
    results.replaceChildren();
    if (queryId) await database.clearAnalyticsAggregateQuery(queryId).catch(() => {});
    queryId = `history-date-summary:${crypto.randomUUID()}`;
    state.historyDateSummary = { queryId, cursor: null, hasMore: false };
    const filters = Object.fromEntries(new globalThis.FormData($("#historyLogFilters")).entries());
    await database.historyDateRangeSummary(filters, { queryId });
  }
  const page = await database.historyDateSummaryPage(queryId, { after: after ?? state.historyDateSummary.cursor, limit: 100 });
  const macs = await database.analyticsAggregateTop(queryId, "mac", 50, "ru", { tieBreak: "firstObserved" });
  const html = historyDateSummaryHtml(page.rows, macs);
  if (append) {
    const body = results.querySelector(".history-date-rows tbody");
    const rows = page.rows.map((row) => `<tr><td>${escapeHtml(row.date)}</td><td>${row.total.toLocaleString("ru-RU")}</td><td>${Number(row.added || 0).toLocaleString("ru-RU")}</td><td>${Number(row.removed || 0).toLocaleString("ru-RU")}</td><td>${Number(row.modified || 0).toLocaleString("ru-RU")}</td></tr>`).join("");
    body?.insertAdjacentHTML("beforeend", rows);
  }
  else results.innerHTML = html;
  state.historyDateSummary = { queryId, cursor: page.nextCursor, hasMore: page.hasMore };
  $("#historyDateSummaryNextButton").disabled = !page.hasMore;
  status.textContent = `Сводка готова · показано дат: ${page.rows.length.toLocaleString("ru-RU")} на этой странице · MAC в топе: ${macs.length.toLocaleString("ru-RU")}`;
}

async function exportHistoryDateRange() {
  const status = $("#historyDateSummaryStatus");
  const filters = Object.fromEntries(new globalThis.FormData($("#historyLogFilters")).entries());
  const filename = `history-changes-${new Date().toISOString().slice(0, 10)}.xlsx`;
  status.textContent = "Формируется XLSX полного журнала за выбранный период…";
  const workbook = createXlsxWorkbookStream(historyExportSheets(database, filters));
  const result = await downloadReadableStream(
    filename,
    workbook,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "История Excel",
  );
  status.textContent = result === "cancelled" ? "Экспорт истории изменений отменён." : "Экспорт истории изменений завершён.";
}

function nextHistoryLogPage() {
  const current = state.historyLog;
  if (!current.page?.hasMore) return;
  return loadHistoryLog({ filters: current.filters, cursor: current.page.nextCursor, previous: [...current.previous, current.cursor] });
}

function previousHistoryLogPage() {
  const current = state.historyLog;
  if (!current.previous.length) return;
  const previous = [...current.previous];
  const cursor = previous.pop() ?? null;
  return loadHistoryLog({ filters: current.filters, cursor, previous });
}

async function loadLegacyObservationLog({ filters = state.legacyObservationLog.filters, cursor = null, previous = state.legacyObservationLog.previous } = {}) {
  const requestId = state.legacyObservationLog.requestId + 1;
  state.legacyObservationLog.requestId = requestId;
  $("#legacyObservationStatus").textContent = "Загружаются импортированные наблюдения…";
  const page = await database.legacyObservationSearchPage(filters, { cursor, limit: 100 });
  const taskIds = page.rows.filter((row) => row.kind === "scheduled_tasks").map((row) => String(row.payload?.id || "")).filter(Boolean);
  const queueSummaries = await database.legacyTaskQueueSummaries(taskIds);
  if (requestId !== state.legacyObservationLog.requestId) return;
  state.legacyObservationLog = { ...state.legacyObservationLog, filters, cursor, previous, page, queueSummaries, requestId };
  $("#legacyObservationResults").classList.toggle("empty", page.rows.length === 0);
  $("#legacyObservationResults").innerHTML = legacyObservationLogContent(page.rows, state.legacyObservationLog.selectedIds, queueSummaries, isEngineerActive());
  const kinds = Object.entries(page.byKind).map(([kind, count]) => `${kind}: ${count.toLocaleString("ru-RU")}`).join(" · ");
  const summary = page.summary || {};
  const distinct = `MAC: ${Number(summary.uniqueMacs || 0).toLocaleString("ru-RU")} · производителей: ${Number(summary.vendors || 0).toLocaleString("ru-RU")} · моделей: ${Number(summary.models || 0).toLocaleString("ru-RU")} · помещений: ${Number(summary.rooms || 0).toLocaleString("ru-RU")} · источников: ${Number(summary.sources || 0).toLocaleString("ru-RU")}`;
  $("#legacyObservationStatus").textContent = `${page.total.toLocaleString("ru-RU")} записей · страница ${previous.length + 1} · показано ${page.rows.length.toLocaleString("ru-RU")} · отмечено ${state.legacyObservationLog.selectedIds.size.toLocaleString("ru-RU")} · ${kinds} · ${distinct}`;
  $("#legacyObservationPreviousButton").disabled = previous.length === 0;
  $("#legacyObservationNextButton").disabled = !page.hasMore;
  $("#deleteLegacyObservationsButton").disabled = state.legacyObservationLog.selectedIds.size === 0;
  $("#deleteFilteredLegacyObservationsButton").disabled = page.total === 0 || !legacyObservationFiltersActive(filters);
}

function legacyObservationFiltersActive(filters = {}) {
  return ["kind", "mac", "source", "vendor", "model", "room", "from", "to"].some((key) => String(filters[key] || "").trim());
}

function searchLegacyObservations() {
  const filters = Object.fromEntries(new globalThis.FormData($("#legacyObservationFilters")).entries());
  state.legacyObservationLog.selectedIds.clear();
  return loadLegacyObservationLog({ filters, cursor: null, previous: [] });
}

function showImportedApiCache() {
  const form = $("#legacyObservationFilters");
  form.elements.namedItem("kind").value = "vendor_model_history";
  form.elements.namedItem("source").value = "SQLite API cache";
  for (const name of ["mac", "vendor", "model", "room", "from", "to"]) form.elements.namedItem(name).value = "";
  return searchLegacyObservations();
}

function nextLegacyObservationPage() {
  const current = state.legacyObservationLog;
  if (!current.page?.hasMore) return;
  return loadLegacyObservationLog({ filters: current.filters, cursor: current.page.nextCursor, previous: [...current.previous, current.cursor] });
}

function previousLegacyObservationPage() {
  const current = state.legacyObservationLog;
  if (!current.previous.length) return;
  const previous = [...current.previous];
  const cursor = previous.pop() ?? null;
  return loadLegacyObservationLog({ filters: current.filters, cursor, previous });
}

async function deleteSelectedLegacyObservations() {
  const ids = [...state.legacyObservationLog.selectedIds];
  if (!ids.length) return;
  if (!globalThis.confirm(`Удалить ${ids.length.toLocaleString("ru-RU")} отмеченных импортированных записей? Снимки Final и события истории не затрагиваются.`)) return;
  const deleted = await database.deleteLegacyObservations(ids);
  state.legacyObservationLog.selectedIds.clear();
  const current = state.legacyObservationLog;
  await loadLegacyObservationLog({ filters: current.filters, cursor: null, previous: [] });
  $("#legacyObservationStatus").textContent += ` · удалено записей: ${deleted.toLocaleString("ru-RU")}`;
}

async function deleteFilteredLegacyObservations() {
  const current = state.legacyObservationLog;
  const total = Number(current.page?.total || 0);
  if (!total || !legacyObservationFiltersActive(current.filters)) return;
  if (!globalThis.confirm(`Удалить все ${total.toLocaleString("ru-RU")} записи по активному фильтру? Данные Final и события History не затрагиваются.`)) return;
  const deleted = await database.deleteLegacyObservationsByFilters(current.filters);
  current.selectedIds.clear();
  await loadLegacyObservationLog({ filters: current.filters, cursor: null, previous: [] });
  $("#legacyObservationStatus").textContent += ` · удалено записей: ${deleted.toLocaleString("ru-RU")}`;
}

async function deleteSelectedHistoryEvents() {
  const selected = [...state.historyLog.selectedIds];
  if (!selected.length) return;
  if (!globalThis.confirm(`Удалить ${selected.length.toLocaleString("ru-RU")} отмеченных событий истории? Final и Inventory не удаляются.`)) return;
  const ids = selected.map((id) => /^\d+$/.test(id) ? Number(id) : id);
  const deleted = await database.deleteHistoryEvents(ids);
  state.historyLog.selectedIds.clear();
  const current = state.historyLog;
  await loadHistoryLog({ filters: current.filters, cursor: current.cursor, previous: current.previous });
  $("#historyLogStatus").textContent += ` · удалено событий: ${deleted.toLocaleString("ru-RU")}`;
}

async function deleteFilteredHistoryEvents() {
  const current = state.historyLog;
  const total = Number(current.page?.total || 0);
  if (!total) return;
  if (!globalThis.confirm(`Удалить все ${total.toLocaleString("ru-RU")} событий по текущим фильтрам? Final и Inventory не удаляются.`)) return;
  const deleted = await database.deleteHistoryEventsByFilters(current.filters);
  current.selectedIds.clear();
  await loadHistoryLog({ filters: current.filters, cursor: null, previous: [] });
  $("#historyLogStatus").textContent += ` · удалено событий: ${deleted.toLocaleString("ru-RU")}`;
}

async function saveHistoryLogColumns() {
  const selected = [...$("#historyLogColumns").querySelectorAll("[data-history-log-column]:checked")].map((input) => input.value);
  state.historyLog.columns = normalizedHistoryLogColumns(selected);
  await database.setSetting("historyLogColumns", state.historyLog.columns);
  $("#historyLogColumns").innerHTML = historyLogColumnControls(state.historyLog.columns, state.historyLog.columnWidths);
  if (state.historyLog.page) {
    $("#historyLogResults").innerHTML = historyLogContent(state.historyLog.page.rows, state.historyLog.columns, state.historyLog.selectedIds, state.historyLog.columnWidths, isEngineerActive());
  }
}

async function saveHistoryLogColumnWidths(widths = null) {
  const requested = widths || Object.fromEntries([...$("#historyLogColumns").querySelectorAll("[data-history-log-width]")]
    .map((input) => [input.dataset.historyLogWidth, input.value]));
  state.historyLog.columnWidths = normalizedHistoryLogColumnWidths(requested);
  await database.setSetting("historyLogColumnWidths", state.historyLog.columnWidths);
  $("#historyLogColumns").innerHTML = historyLogColumnControls(state.historyLog.columns, state.historyLog.columnWidths);
  if (state.historyLog.page) {
    $("#historyLogResults").innerHTML = historyLogContent(state.historyLog.page.rows, state.historyLog.columns, state.historyLog.selectedIds, state.historyLog.columnWidths, isEngineerActive());
  }
}

async function resetHistoryLogColumnWidths() {
  state.historyLog.columnWidths = defaultHistoryLogColumnWidths();
  await database.setSetting("historyLogColumnWidths", state.historyLog.columnWidths);
  $("#historyLogColumns").innerHTML = historyLogColumnControls(state.historyLog.columns, state.historyLog.columnWidths);
  if (state.historyLog.page) {
    $("#historyLogResults").innerHTML = historyLogContent(state.historyLog.page.rows, state.historyLog.columns, state.historyLog.selectedIds, state.historyLog.columnWidths, isEngineerActive());
  }
}

async function optimizeHistoryLogColumnWidths() {
  const requestId = state.historyLog.requestId;
  const dataRevision = state.temporalDataRevision;
  const filters = { ...state.historyLog.filters };
  const columns = [...state.historyLog.columns];
  const optimizer = createHistoryLogColumnWidthOptimizer(columns);
  await database.forEachHistorySearch(filters, (row) => {
    if (requestId !== state.historyLog.requestId || dataRevision !== state.temporalDataRevision
      || columns.length !== state.historyLog.columns.length
      || columns.some((key, index) => key !== state.historyLog.columns[index])) {
      const error = new Error("Подбор ширины отменён: фильтр или данные истории изменились.");
      error.name = "AbortError";
      throw error;
    }
    optimizer.add(row);
  });
  if (requestId !== state.historyLog.requestId || dataRevision !== state.temporalDataRevision
    || columns.some((key, index) => key !== state.historyLog.columns[index]) || columns.length !== state.historyLog.columns.length) return;
  state.historyLog.columnWidths = optimizer.finish();
  await saveHistoryLogColumnWidths(state.historyLog.columnWidths);
}

function roomDevices() {
  return state.roomCatalog;
}

function cascadeRoomFilters(changed = "") {
  const values = {
    businessUnit: $("#businessUnitFilter").value,
    city: $("#cityFilter").value,
    site: $("#siteFilter").value,
    floor: $("#floorFilter").value,
    room: $("#roomFilter").value,
  };
  const initialSignature = roomFilterSignature(state.roomCatalogRevision, values);
  if (!changed && state.roomFilterCascadeSignature === initialSignature) return;
  const order = ROOM_FILTER_FIELDS;
  const changedIndex = order.indexOf(changed);
  if (changedIndex >= 0) order.slice(changedIndex + 1).forEach((field) => { values[field] = ""; });
  order.forEach((field, index) => {
    const eligible = roomDevices().filter((device) => matchesRoomFilters(device, values, order.slice(0, index)));
    const select = $(`#${field === "businessUnit" ? "businessUnit" : field}Filter`);
    const options = roomFilterOptions(eligible, field, {}, order.slice(0, index));
    values[field] = uniqueRoomFilterSelection(options, values[field]);
    renderSelect(select, options, values[field], `Все: ${FIELD_LABELS[field] || field}`);
    values[field] = select.value;
  });
  state.roomFilterCascadeSignature = roomFilterSignature(state.roomCatalogRevision, values);
}

async function initializeRoomFilters() {
  if (!state.roomCatalog.length && state.snapshotMetadata.length) {
    if (!state.roomCatalogPromise) {
      const revision = state.roomCatalogRevision;
      state.roomCatalogPromise = (async () => {
        const catalog = new Map();
        for (const snapshot of state.snapshotMetadata) {
          await database.forEachSnapshotChunk(snapshot.id, (devices) => addRoomCatalogDevices(catalog, devices));
          if (revision !== state.roomCatalogRevision) return;
        }
        state.roomCatalog = [...catalog.values()];
      })();
    }
    await state.roomCatalogPromise;
    if (!state.roomCatalog.length && !state.snapshotMetadata.length) return;
  }
  cascadeRoomFilters();
}

function selectedRoomKey() {
  const query = keyText($("#roomSearch").value);
  const filters = ROOM_FILTER_FIELDS;
  const selected = Object.fromEntries(filters.map((field) => [field, $( `#${field === "businessUnit" ? "businessUnit" : field}Filter`).value]));
  const device = roomDevices().find((item) => matchesRoomFilters(item, selected, filters)
    && (!query || matchesDeviceSearch(item, query)));
  return device ? locationKey(device) : "";
}

function roomTimelineMatch(device, key, room = {}) {
  if (locationKey(device) === key) return true;
  if (!key?.startsWith("sr:") || device.smartroomId || !room.room) return false;
  return ["businessUnit", "city", "site", "floor", "room", "address"]
    .every((field) => keyText(device[field]) === keyText(room[field]));
}

async function readRoomDevices(snapshotId, key, room) {
  const devices = [];
  await database.forEachSnapshotChunk(snapshotId, (chunk) => {
    for (const device of chunk) if (roomTimelineMatch(device, key, room)) devices.push(device);
  });
  return devices;
}

async function showRoomTimeline(roomKey = "", room = {}) {
  const key = roomKey || selectedRoomKey();
  if (!key) throw new Error("Выберите помещение или уточните поиск");
  const revision = ++state.roomTimelineRevision;
  const timeline = $("#roomTimeline");
  timeline.classList.remove("empty");
  timeline.innerHTML = "";
  state.roomTimelineSnapshotIds = [];
  state.roomTimelineRoom = room;
  state.roomTimelineKey = key;
  state.roomTimelinePages = {};
  state.roomTimelineDiagnostics = 0;
  let previous = null;
  let knownRoomDevices = [];
  let ambiguousHistoryMatches = 0;
  for (const snapshot of state.snapshotMetadata) {
    const devices = await readRoomDevices(snapshot.id, key, room);
    if (revision !== state.roomTimelineRevision) return;
    const carried = carryForwardRoomDeviceFields(knownRoomDevices, devices, { previousIsCompact: true });
    ambiguousHistoryMatches += carried.diagnostics.length;
    const comparison = previous
      ? { ...compareFinals(previous.devices, carried.devices, snapshot.createdAt), previousName: previous.snapshot.name || "Final" }
      : null;
    timeline.insertAdjacentHTML("beforeend", roomTimelineObservationContent(snapshot, carried.devices, comparison, room));
    state.roomTimelineSnapshotIds.push(snapshot.id);
    previous = { snapshot, devices: carried.devices };
    knownRoomDevices = carried.knownDevices;
  }
  if (revision !== state.roomTimelineRevision) return;
  state.roomTimelineDiagnostics = ambiguousHistoryMatches;
  renderRoomTimeline();
  finishProgress("Хронология помещения построена");
}

function renderRoomTimeline() {
  const timeline = $("#roomTimeline");
  const notice = state.roomTimelineDiagnostics
    ? `<p class="notice">Для ${state.roomTimelineDiagnostics.toLocaleString("ru-RU")} неоднозначных исторических совпадений значения не переносились.</p>`
    : "";
  if (notice && !timeline.querySelector(".notice")) timeline.insertAdjacentHTML("afterbegin", notice);
}

async function loadRoomTimelineObservation(snapshotId) {
  const revision = state.roomTimelineRevision;
  const key = state.roomTimelineKey;
  const room = state.roomTimelineRoom;
  let previous = null;
  let knownRoomDevices = [];
  let ambiguousMatches = 0;
  for (const snapshot of state.snapshotMetadata) {
    const devices = await readRoomDevices(snapshot.id, key, room);
    if (revision !== state.roomTimelineRevision) return null;
    const carried = carryForwardRoomDeviceFields(knownRoomDevices, devices, { previousIsCompact: true });
    ambiguousMatches += carried.diagnostics.length;
    const comparison = previous
      ? { ...compareFinals(previous.devices, carried.devices, snapshot.createdAt), previousName: previous.snapshot.name || "Final" }
      : null;
    if (snapshot.id === snapshotId) return { snapshot, devices: carried.devices, comparison, ambiguousMatches };
    previous = { snapshot, devices: carried.devices };
    knownRoomDevices = carried.knownDevices;
  }
  return null;
}

async function updateRoomTimelinePage(snapshotId, section, page) {
  if (!state.roomTimelineSnapshotIds.includes(snapshotId) || !["roster", "changes", "added", "absent"].includes(section)) return;
  state.roomTimelinePages[snapshotId] ||= {};
  state.roomTimelinePages[snapshotId][section] = page;
  const observation = await loadRoomTimelineObservation(snapshotId);
  if (!observation || !state.roomTimelineSnapshotIds.includes(snapshotId)) return;
  const replacement = document.createElement("div");
  replacement.innerHTML = roomTimelineObservationContent(
    observation.snapshot,
    observation.devices,
    observation.comparison,
    state.roomTimelineRoom,
    state.roomTimelinePages[snapshotId],
  );
  const card = [...$("#roomTimeline").querySelectorAll("[data-room-timeline-id]")]
    .find((element) => element.dataset.roomTimelineId === snapshotId);
  if (card) card.replaceWith(replacement.firstElementChild);
}

async function compareLatestRoomFinals() {
  const key = selectedRoomKey();
  if (!key) throw new Error("Выберите помещение или уточните поиск");
  const room = roomDevices().find((device) => locationKey(device) === key) || {};
  const snapshots = [...state.snapshotMetadata].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  if (snapshots.length < 2) throw new Error("Для сравнения помещения нужны минимум два Final");
  state.roomPair = { key, room, baseSnapshot: snapshots.at(-2), currentSnapshot: snapshots.at(-1) };
  state.roomPairPage = 1;
  await renderRoomPairComparison();
  finishProgress("Сравнение двух последних Final для помещения готово");
}

async function loadRoomPairComparison(pair) {
  if (!pair) return null;
  const { key, room, baseSnapshot, currentSnapshot } = pair;
  const snapshots = [...state.snapshotMetadata].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  const baseIndex = snapshots.findIndex((snapshot) => snapshot.id === baseSnapshot.id);
  const currentIndex = snapshots.findIndex((snapshot) => snapshot.id === currentSnapshot.id);
  if (baseIndex < 0 || currentIndex < 0) throw new Error("Снимки для сравнения помещения больше недоступны");
  let knownRoomDevices = [];
  let baseDevices = [];
  let currentDevices = [];
  let ambiguousHistoryMatches = 0;
  for (let index = 0; index <= currentIndex; index += 1) {
    const snapshot = snapshots[index];
    const devices = await readRoomDevices(snapshot.id, key, room);
    const carried = carryForwardRoomDeviceFields(knownRoomDevices, devices, { previousIsCompact: true });
    knownRoomDevices = carried.knownDevices;
    ambiguousHistoryMatches += carried.diagnostics.length;
    if (index === baseIndex) baseDevices = compactRoomHistoryDevices(carried.devices);
    if (index === currentIndex) currentDevices = carried.devices;
  }
  return {
    comparison: compareFinals(baseDevices, currentDevices, currentSnapshot.createdAt),
    baseSnapshot,
    currentSnapshot,
    ambiguousHistoryMatches,
  };
}

async function renderRoomPairComparison() {
  const host = $("#roomFinalComparison");
  host.classList.remove("empty");
  if (!state.roomPair) return;
  const pair = state.roomPair;
  const data = await loadRoomPairComparison(pair);
  if (!data || state.roomPair !== pair) return;
  const { comparison, baseSnapshot, currentSnapshot, ambiguousHistoryMatches } = data;
  host.innerHTML = roomPairComparisonContent(comparison, baseSnapshot, currentSnapshot, state.roomPairPage)
    + (ambiguousHistoryMatches ? `<p class="notice">Значения не переносились для ${ambiguousHistoryMatches.toLocaleString("ru-RU")} неоднозначных исторических совпадений.</p>` : "");
}

async function showAllChangedRooms() {
  await renderAnalytics(true);
  openRoomCoverageDialog(state.analytics, true);
}

function batchSourceSelect(pair, pairIndex, role) {
  const entries = state.batch.entries[role];
  const selected = pair[role]?.id || "";
  return `<select class="batch-source-select" data-batch-pair-source="${role}" data-batch-pair-index="${pairIndex}"><option value="">Не использовать</option>${entries.map((entry) => `<option value="${escapeHtml(entry.id)}" ${entry.id === selected ? "selected" : ""}>${escapeHtml(entry.relativePath || batchSourceFileRelativePath(entry.file))} · ${escapeHtml(entry.date.date.slice(0, 10) || "Дата неизвестна")}${entry.error ? " · ОШИБКА" : ""}</option>`).join("")}</select>`;
}

function batchFileDisplayName(file) {
  return batchSourceFileRelativePath(file) || "без имени";
}

function batchEntryDisplayName(entry) {
  return entry?.relativePath || batchFileDisplayName(entry?.file);
}

function batchMappingEditor(entry) {
  if (!entry) return '<p class="muted">Источник для этой пары не выбран.</p>';
  if (entry.error) return `<p class="batch-validation error">${escapeHtml(batchEntryDisplayName(entry))}: ${escapeHtml(entry.error)}</p>`;
  const customColumns = state.inventoryColumnConfig.columns.filter(({ custom }) => custom);
  const fields = [...ROLE_FIELDS[entry.role], ...customColumns.map(({ key }) => key)];
  return `<div class="batch-mapping"><h4>${escapeHtml(batchEntryDisplayName(entry))}</h4><p class="muted">${entry.rowCount === null ? "Предпросмотр первых строк" : `${entry.rowCount.toLocaleString("ru-RU")} строк`} · дата ${escapeHtml(entry.date.date.slice(0, 10) || "не определена")}</p><div class="mapping-grid">${fields.map((field) => {
    const label = customColumns.find(({ key }) => key === field)?.label || FIELD_LABELS[field] || field;
    return `<label><span>${escapeHtml(label)}</span><select data-batch-entry-id="${escapeHtml(entry.id)}" data-batch-entry-role="${entry.role}" data-batch-mapping-field="${field}"><option value="">Не использовать</option>${entry.headers.map((header, index) => `<option value="${index}" ${Number(entry.mapping[field]) === index ? "selected" : ""}>${escapeHtml(`${excelColumnLabel(index)} · ${header || `Колонка ${index + 1}`}`)}</option>`).join("")}</select></label>`;
  }).join("")}</div></div>`;
}

function refreshBatchValidation() {
  state.batch.pairs.forEach((pair, index) => {
    const element = $(`[data-batch-problems="${index}"]`);
    if (!element) return;
    const problems = batchPairProblems(pair);
    const failed = ["error", "cancelled"].includes(pair.status);
    element.className = `batch-validation ${problems.length || failed ? "error" : "ok"}`;
    element.textContent = problems.length ? problems.join("; ")
        : ["completed", "reused"].includes(pair.status) ? pair.status === "reused" ? "Ранее сохранённый Final использован повторно" : "Final сохранён"
        : pair.status === "error" ? pair.errorMessage
          : pair.status === "cancelled" ? pair.errorMessage || "Обработка отменена"
          : pair.status === "processing" ? "Обрабатывается"
            : pair.queueMessage || (pair.status === "skipped" ? "Цикл отключён пользователем" : "Колонки готовы");
  });
  $("#runBatchButton").disabled = batchQueueProblems(state.batch.pairs).length > 0;
}

function renderBatchPreview() {
  const host = $("#batchPreview");
  host.classList.remove("empty");
  if (!state.batch.pairs.length) {
    host.innerHTML = '<p class="empty">В папке Main нет поддерживаемых файлов.</p>';
    return;
  }
  const unmatched = unmatchedBatchEntries(state.batch.pairs, state.batch.entries);
  host.innerHTML = `<p class="notice"><strong>Принцип:</strong> каждый включённый Main создаёт один Final. SmartRoom/DDIO назначаются не более чем одному Main. Выберите одинаковую календарную дату либо ближайшую дату с допуском. Файлы без достоверной даты остаются неназначенными. Можно отключить цикл, переназначить источники и увидеть неназначенные файлы до запуска.</p>${unmatched.length ? `<p class="batch-validation error">Без пары (${unmatched.length}): ${unmatched.map((entry) => escapeHtml(`${entry.role}: ${batchEntryDisplayName(entry)}`)).join(" · ")}</p>` : ""}<div class="table-scroll"><table class="data-table batch-table"><thead><tr><th>Цикл</th><th>№</th><th>Дата</th><th>Main</th><th>SmartRoom</th><th>DDIO</th></tr></thead><tbody>${state.batch.pairs.map((pair, index) => `<tr><td><input type="checkbox" aria-label="Включить цикл ${index + 1}" data-batch-pair-enabled="${index}" ${pair.enabled !== false ? "checked" : ""}></td><td>${index + 1}</td><td>${escapeHtml(pair.date.date.slice(0, 10) || "Дата неизвестна")}</td><td>${escapeHtml(batchEntryDisplayName(pair.main))}</td><td>${batchSourceSelect(pair, index, "smartroom")}</td><td>${batchSourceSelect(pair, index, "ddio")}</td></tr><tr class="batch-details-row"><td colspan="6"><details ${index === 0 ? "open" : ""}><summary>Проверить и изменить сопоставление колонок</summary><p data-batch-problems="${index}"></p><div class="batch-mapping-grid">${batchMappingEditor(pair.main)}${batchMappingEditor(pair.smartroom)}${batchMappingEditor(pair.ddio)}</div><label class="batch-review"><input type="checkbox" data-batch-pair-reviewed="${index}" ${pair.reviewed ? "checked" : ""}>Я проверил файлы и mapping этой пары</label></details></td></tr>`).join("")}</tbody></table></div>`;
  host.querySelectorAll("[data-batch-pair-source]").forEach((select) => select.addEventListener("change", () => {
    reassignBatchSource(state.batch.pairs, state.batch.entries, Number(select.dataset.batchPairIndex), select.dataset.batchPairSource, select.value);
    renderBatchPreview();
  }));
  host.querySelectorAll("[data-batch-mapping-field]").forEach((select) => select.addEventListener("change", () => {
    const entry = state.batch.entries[select.dataset.batchEntryRole].find((item) => item.id === select.dataset.batchEntryId);
    if (!entry) return;
    if (select.value === "") delete entry.mapping[select.dataset.batchMappingField];
    else entry.mapping[select.dataset.batchMappingField] = Number(select.value);
    const pair = state.batch.pairs.find((item) => [item.main, item.smartroom, item.ddio].some((source) => source?.id === entry.id));
    if (pair) pair.reviewed = false;
    refreshBatchValidation();
  }));
  host.querySelectorAll("[data-batch-pair-reviewed]").forEach((input) => input.addEventListener("change", () => {
    state.batch.pairs[Number(input.dataset.batchPairReviewed)].reviewed = input.checked;
    refreshBatchValidation();
  }));
  host.querySelectorAll("[data-batch-pair-enabled]").forEach((input) => input.addEventListener("change", () => {
    state.batch.pairs[Number(input.dataset.batchPairEnabled)].enabled = input.checked;
    refreshBatchValidation();
  }));
  refreshBatchValidation();
}

function rebuildBatchPairs() {
  const previous = new Map(state.batch.pairs.map((pair) => [pair.main.id, pair.enabled !== false]));
  state.batch.pairs = pairBatchEntries(state.batch.entries.main, state.batch.entries.smartroom, state.batch.entries.ddio, state.batch.pairing);
  state.batch.pairs.forEach((pair) => { pair.enabled = previous.get(pair.main.id) ?? true; });
  renderBatchPreview();
}

async function pairBatchFiles() {
  clearError();
  const total = ["main", "smartroom", "ddio"].reduce((sum, role) => sum + state.batch[role].length, 0);
  if (!state.batch.main.length) throw new Error("Выберите папку с основными файлами");
  let prepared = 0;
  for (const role of ["main", "smartroom", "ddio"]) {
    state.batch.entries[role] = await prepareBatchEntries(state.batch[role], role, ({ file }) => {
      progress(5 + prepared / Math.max(1, total) * 80, `Чтение заголовков: ${batchFileDisplayName(file)}`, "Подготовка массового обогащения");
      prepared += 1;
    });
  }
  rebuildBatchPairs();
  const broken = state.batch.pairs.filter((pair) => batchPairProblems(pair).length).length;
  finishProgress(`Сформировано ${state.batch.pairs.length} пар${broken ? ` · требуют проверки: ${broken}` : ""}`);
  return state.batch.pairs;
}

function renderBatchSourceFiles(role) {
  const hostId = role === "main" ? "batchMainFiles" : role === "smartroom" ? "batchSmartroomFiles" : "batchDdIoFiles";
  const host = $(`#${hostId}`);
  if (!host) return;
  const page = batchFileListPage(state.batch[role], state.batch.filePages[role]);
  state.batch.filePages[role] = page.page;
  if (!page.total) {
    host.replaceChildren();
    return;
  }
  host.innerHTML = `<ul class="batch-source-file-items">${page.items.map(({ file, index }) => { const label = batchFileDisplayName(file); return `<li><span class="batch-source-file-name" title="${escapeHtml(label)}">${escapeHtml(label)}</span><button class="button secondary" type="button" data-batch-file-remove-role="${role}" data-batch-file-remove-index="${index}" aria-label="Удалить ${escapeHtml(label)}">Удалить</button></li>`; }).join("")}</ul>${page.pages > 1 ? `<div class="batch-source-file-pager"><button class="button secondary" type="button" data-batch-file-page="previous" data-batch-file-role="${role}" ${page.page <= 1 ? "disabled" : ""}>Назад</button><span class="muted">${page.first}–${page.last} из ${page.total}</span><button class="button secondary" type="button" data-batch-file-page="next" data-batch-file-role="${role}" ${page.page >= page.pages ? "disabled" : ""}>Дальше</button></div>` : `<p class="muted">Файлов: ${page.total}</p>`}`;
  host.querySelectorAll("[data-batch-file-remove-role]").forEach((button) => button.addEventListener("click", () => {
    const index = Number(button.dataset.batchFileRemoveIndex);
    const pageNumber = state.batch.filePages[role];
    handleBatchFileSelection(role, removeBatchFileAt(state.batch[role], index), { page: pageNumber }).catch(showError);
  }));
  host.querySelectorAll("[data-batch-file-page]").forEach((button) => button.addEventListener("click", () => {
    state.batch.filePages[role] += button.dataset.batchFilePage === "next" ? 1 : -1;
    renderBatchSourceFiles(role);
  }));
}

function setBatchFiles(role, files, { append = false, page = null } = {}) {
  if (!["main", "smartroom", "ddio"].includes(role)) throw new Error("Неизвестная роль файлов массового объединения");
  const accepted = compactSupportedBatchFiles(files);
  state.batch[role] = append ? [...state.batch[role], ...accepted] : accepted;
  state.batch.filePages[role] = append
    ? Math.max(1, Math.ceil(state.batch[role].length / BATCH_FILE_LIST_PAGE_SIZE))
    : Number.isInteger(page) && page > 0 ? page : 1;
  const statusId = role === "main" ? "batchMainStatus" : role === "smartroom" ? "batchSmartroomStatus" : "batchDdIoStatus";
  $(`#${statusId}`).textContent = `${state.batch[role].length} файлов`;
  renderBatchSourceFiles(role);
  state.batch.entries[role] = [];
  state.batch.pairs = [];
  $("#runBatchButton").disabled = true;
  $("#batchPreview").classList.add("empty");
  $("#batchPreview").textContent = "Пары изменились. Нажмите «Сформировать пары» перед запуском.";
}

async function runBatch(pairs = state.batch.pairs, strategy = $("input[name='strategy']:checked").value, failurePolicy = state.batch.failurePolicy) {
  const problems = batchQueueProblems(pairs);
  if (problems.length) throw new Error(problems[0]);
  state.controller = new AbortController();
  const result = await runBatchQueue(pairs, async (pair, index) => {
    const entries = { main: pair.main, smartroom: pair.smartroom, ddio: pair.ddio };
    const files = {};
    const tables = {};
    const mappings = {};
    let stage = "чтение файлов";
    try {
      for (const role of ["main", "smartroom", "ddio"]) {
        const entry = entries[role];
        if (!entry) continue;
        stage = `чтение ${role} «${batchEntryDisplayName(entry)}»`;
        progress(index / pairs.length * 100, `Пара ${index + 1}/${pairs.length}: ${stage}`, "Массовое объединение данных");
        files[role] = entry.file;
        if (isStreamableTableFile(entry.file)) {
          tables[role] = {
            headers: entry.headers,
            rows: entry.previewRows,
            rowCount: entry.rowCount,
            preview: true,
            sheet: entry.sheet,
            workbookCreatedAt: entry.workbookCreatedAt,
            workbookModifiedAt: entry.workbookModifiedAt,
          };
        } else {
          tables[role] = await readTable(entry.file);
        }
        mappings[role] = { ...entry.mapping };
      }
      stage = "объединение Main, SmartRoom и DDIO";
      const start = index / pairs.length * 100;
      const end = (index + 1) / pairs.length * 100;
      return await executeEnrichment({ tables, mappings, files, name: `Final ${pair.main.file.name}`, strategy, progressRange: [start, end] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error?.batchStage) throw error;
      const wrapped = new Error(message, { cause: error });
      wrapped.name = error?.name || "Error";
      wrapped.batchStage = stage;
      throw wrapped;
    }
  }, {
    failurePolicy,
    onStart: (_pair, index) => {
      progress(index / pairs.length * 100, `Пара ${index + 1}/${pairs.length}: подготовка`, "Массовое объединение данных");
      refreshBatchValidation();
    },
    onComplete: () => refreshBatchValidation(),
    onQueueState: () => refreshBatchValidation(),
    onError: (error, pair, index) => {
      const stage = error?.batchStage || "обработка пары";
      const message = error instanceof Error ? error.message : String(error);
      refreshBatchValidation();
      return `Пара №${index + 1}, Main «${batchEntryDisplayName(pair.main)}», этап «${stage}»: ${message}`;
    },
  });
  state.analytics = null;
  await refreshDatabaseState();
  const stoppedMessage = result.stopped ? ` · остановлена после ошибки пары №${result.failedPairIndex}` : "";
  const cancelMessage = result.cancelled ? " · обработка отменена" : "";
  finishProgress(`Очередь завершена: ${result.completed} Final сохранено${result.errors.length ? ` · ошибок: ${result.errors.length}` : ""}${stoppedMessage}${cancelMessage}`);
  const queueErrors = result.errors.map(({ message }) => message);
  if (result.observerErrors.length) {
    queueErrors.push(`Не удалось обновить статус очереди (${result.observerErrors.map(({ phase, pairIndex }) => `пара №${pairIndex}, ${phase}`).join("; ")}). Результаты сохранённых Final не затронуты.`);
  }
  if (queueErrors.length) showError(queueErrors.join("\n"));
  return result;
}

function cloneBatchEntry(entry) {
  if (!entry) return null;
  return {
    ...entry,
    headers: [...(entry.headers || [])],
    previewRows: [...(entry.previewRows || [])],
    mapping: { ...(entry.mapping || {}) },
  };
}

function stopScheduledBatch(message = "Планировщик остановлен.") {
  for (const scheduled of state.scheduledBatches.values()) scheduled.scheduler.stop({ notify: false });
  state.scheduledBatches.clear();
  const status = $("#scheduledBatchStatus");
  const stop = $("#stopScheduledBatchButton");
  if (status) status.textContent = message;
  if (stop) stop.disabled = true;
  renderScheduledBatches();
}

function renderScheduledBatches() {
  const list = $("#scheduledBatchList");
  const status = $("#scheduledBatchStatus");
  const stop = $("#stopScheduledBatchButton");
  if (!list) return;
  const schedules = [...state.scheduledBatches.values()];
  list.innerHTML = schedules.map((schedule) => {
    const lastResult = schedule.lastStatus?.lastResult;
    const outcome = lastResult
      ? `Последний запуск: Final ${lastResult.completed} · ошибок ${lastResult.errorCount}${lastResult.stopped ? ` · остановка после пары ${lastResult.failedPairIndex}` : ""}`
      : schedule.lastStatus?.lastError ? `Ошибка: ${schedule.lastStatus.lastError.message || schedule.lastStatus.lastError}` : "Ожидает запуска";
    const nextAt = schedule.lastStatus?.nextAt ? ` · следующий запуск ${schedule.lastStatus.nextAt.toLocaleString("ru-RU")}` : "";
    const inactive = ["complete", "stopped"].includes(schedule.lastStatus?.phase);
    const phase = schedule.lastStatus?.phase === "running" ? "Выполняется" : schedule.lastStatus?.phase === "complete" ? "Однократно завершено" : schedule.lastStatus?.phase === "stopped" ? "Остановлено" : "Активно";
    return `<article class="scheduled-batch-item"><div><strong>${escapeHtml(schedule.name)}</strong><p class="muted">${phase} · пар: ${schedule.pairs.length}${nextAt}<br>${escapeHtml(outcome)}</p></div><div class="action-row"><button class="button secondary" type="button" data-schedule-stop="${escapeHtml(schedule.id)}" ${inactive ? "disabled" : ""}>Остановить</button><button class="button danger" type="button" data-schedule-delete="${escapeHtml(schedule.id)}">Удалить</button></div></article>`;
  }).join("");
  if (!schedules.length) list.innerHTML = '<p class="muted">Сохранённых расписаний нет.</p>';
  if (status && schedules.length) status.textContent = `Расписаний: ${schedules.length}. Они работают, пока открыта эта страница и действует инженерная сессия.`;
  if (stop) stop.disabled = schedules.length === 0;
}

function removeScheduledBatch(scheduleId, message = "Расписание удалено.") {
  const schedule = state.scheduledBatches.get(scheduleId);
  if (!schedule) return;
  schedule.scheduler.stop({ notify: false });
  state.scheduledBatches.delete(scheduleId);
  const status = $("#scheduledBatchStatus");
  if (status) status.textContent = message;
  renderScheduledBatches();
}

function scheduleBatch() {
  if (!isEngineerActive()) throw new Error("Для планирования массового объединения войдите в инженерный режим");
  const problems = batchQueueProblems(state.batch.pairs);
  if (problems.length) throw new Error(problems[0]);
  const name = normalizeScheduleName($("#batchScheduleName").value, [...state.scheduledBatches.values()].map((schedule) => schedule.name));
  const mode = $("#batchScheduleMode").value;
  const intervalMinutes = mode === "interval" ? Number($("#batchScheduleInterval").value) : null;
  const [hour, minute] = $("#batchScheduleTime").value.split(":").map(Number);
  if (intervalMinutes === null) nextLocalExecution(hour, minute);
  else nextIntervalExecution(intervalMinutes);
  const pairs = state.batch.pairs.map((pair) => ({
    ...pair,
    main: cloneBatchEntry(pair.main),
    smartroom: cloneBatchEntry(pair.smartroom),
    ddio: cloneBatchEntry(pair.ddio),
    status: "ready",
    result: null,
    errorMessage: "",
  }));
  const schedule = {
    pairs,
    strategy: $("input[name='strategy']:checked").value,
    failurePolicy: state.batch.failurePolicy,
    intervalMinutes,
    repeatDaily: $("#batchScheduleDaily").checked,
    id: crypto.randomUUID(),
    name,
    scheduler: null,
    lastStatus: null,
  };
  schedule.scheduler = createDailyScheduler({
    run: async ({ runs }) => {
      if (state.scheduledBatches.get(schedule.id) !== schedule) return null;
      if (!isEngineerActive()) {
        stopScheduledBatch("Планировщик остановлен: инженерная сессия завершилась.");
        return null;
      }
      const result = await scheduledBatchQueue.enqueue(() => {
        if (state.scheduledBatches.get(schedule.id) !== schedule || !isEngineerActive()) return null;
        $("#scheduledBatchStatus").textContent = `Выполняется расписание «${schedule.name}» · запуск ${runs}…`;
        return runBatch(schedule.pairs, schedule.strategy, schedule.failurePolicy);
      });
      if (!result) return null;
      return { completed: result.completed, errorCount: result.errors.length, stopped: result.stopped, failedPairIndex: result.failedPairIndex };
    },
    onStatus: (status) => {
      if (state.scheduledBatches.get(schedule.id) !== schedule) return;
      schedule.lastStatus = status;
      renderScheduledBatches();
      if (status.lastError) showError(status.lastError);
    },
  });
  state.scheduledBatches.set(schedule.id, schedule);
  renderScheduledBatches();
  schedule.scheduler.start({ hour, minute, repeatDaily: schedule.repeatDaily, intervalMinutes: schedule.intervalMinutes });
}

async function exportInventoryXlsx() {
  const status = $("#inventoryExportStatus");
  const filename = `mac-analyzer-inventory-${new Date().toISOString().slice(0, 10)}.xlsx`;
  const handleRequest = requestReadableStreamFileHandle({
    suggestedName: filename,
    description: "Excel workbook",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
  });
  const { fileHandle, cancelled } = await resolveSaveHandle(handleRequest);
  if (cancelled) {
    status.textContent = "Экспорт Inventory отменён.";
    return;
  }
  const inventoryExport = await createInventoryXlsxSheets(database, {
    columns: visibleInventoryColumns(state.inventoryColumnConfig),
    onProgress: (exported, total) => { status.textContent = `Формирование XLSX: ${exported.toLocaleString("ru-RU")} из ${total.toLocaleString("ru-RU")}`; },
  });
  status.textContent = `Подготовка XLSX: ${inventoryExport.total.toLocaleString("ru-RU")} устройств`;
  const finalCount = await database.inventoryCount();
  const exported = inventoryExport.exported;
  if (finalCount !== inventoryExport.total || exported !== inventoryExport.total) throw new Error(`Inventory изменился во время экспорта: было ${inventoryExport.total}, выгружено ${exported}, стало ${finalCount}. Повторите экспорт.`);
  await downloadReadableStream(filename, createXlsxWorkbookStream(inventoryExport.sheets), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Inventory Excel", fileHandle);
  status.textContent = `Экспортировано устройств: ${exported.toLocaleString("ru-RU")} · листов: ${inventoryExport.sheets.length}`;
}

async function exportDatabase() {
  progress(5, "Чтение локальной базы", "Экспорт базы");
  const filename = `mac-analyzer-next-${new Date().toISOString().slice(0, 10)}.madb.json`;
  const archiveStream = portableDatabaseArchiveStream();
  const result = await downloadReadableStream(filename, archiveStream, "application/json", "Резервная копия MAC Analyzer Next");
  finishProgress(result === "cancelled" ? "Экспорт базы отменён" : result === "saved" ? "Архив базы записан потоково" : "Архив базы сформирован");
  if (result === "cancelled") return;
  recordLocalNotification("backup", "Архив создан", "Портативная резервная копия сформирована локально.", "success").catch(showError);
}

async function uploadActiveFinalToOptionalHost() {
  const button = $("#optionalHostSnapshotUploadButton");
  const status = $("#optionalHostSnapshotUploadStatus");
  if (!optionalHostDatabaseExportHref(globalThis.location)) throw new Error("Копирование Final доступно только через локальный optional host");
  const metadata = await database.activeSnapshotMetadata();
  if (!metadata) throw new Error("Нет целого активного Final для копирования");
  button.disabled = true;
  status.textContent = `Потоковая передача Final «${metadata.name}»: ${Number(metadata.deviceCount).toLocaleString("ru-RU")} устройств…`;
  try {
    const result = await uploadFinalSnapshotToOptionalHost(metadata, database.iterateSnapshotDevices(metadata.id));
    status.textContent = `Final «${metadata.name}» сохранён; передача событий History…`;
    const history = await uploadSnapshotHistoryToOptionalHost(
      metadata.id,
      database.iterateSnapshotHistoryEvents(metadata.id),
    );
    const finalStatus = result.alreadyExists ? "Final уже скопирован без изменений" : "Final добавлен";
    status.textContent = `${finalStatus}: ${Number(result.deviceCount).toLocaleString("ru-RU")} устройств · History: ${history.insertedCount.toLocaleString("ru-RU")} новых, ${history.duplicateCount.toLocaleString("ru-RU")} уже были в SQLite · SHA-256 ${result.signature}`;
    return { ...result, history };
  } finally {
    button.disabled = !state.activeSnapshot;
  }
}

async function uploadInventoryToOptionalHostUi() {
  const button = $("#optionalHostInventoryUploadButton");
  const status = $("#optionalHostInventoryUploadStatus");
  if (!optionalHostDatabaseExportHref(globalThis.location)) throw new Error("Копирование Inventory доступно только через локальный optional host");
  button.disabled = true;
  status.textContent = `Чтение накопительного Inventory: ${Number(state.inventoryTotal || 0).toLocaleString("ru-RU")} устройств…`;
  try {
    const result = await uploadInventoryToOptionalHost(database.iterateInventoryPages({ pageSize: 250 }), {
      onProgress: ({ deviceCount, savedCount, conflictCount }) => {
        status.textContent = `Inventory: передано ${deviceCount.toLocaleString("ru-RU")} · сохранено ${savedCount.toLocaleString("ru-RU")} · конфликтов ${conflictCount.toLocaleString("ru-RU")}`;
      },
    });
    status.textContent = `Inventory скопирован: ${result.savedCount.toLocaleString("ru-RU")} устройств · конфликтов идентичности ${result.conflictCount.toLocaleString("ru-RU")}${result.conflictCount ? ` · примеры: ${result.conflicts.slice(0, 5).map((item) => item.internalDeviceId || item.reason).join(", ")}` : ""}. Счётчики observationCount сохранены.`;
    return result;
  } finally {
    button.disabled = Number(state.inventoryTotal || 0) === 0;
  }
}

async function renderOptionalHostSnapshots({ after = optionalHostSnapshotPage.after } = {}) {
  const list = $("#optionalHostSnapshotsList");
  const status = $("#optionalHostSnapshotsStatus");
  if (!list || !status) return null;
  status.textContent = "Загрузка списка Final из локального optional host…";
  try {
    const page = await listOptionalHostSnapshots({ after, limit: 50 });
    optionalHostSnapshotPage.after = after;
    optionalHostSnapshotPage.items = page.snapshots;
    const visibleIds = new Set(page.snapshots.map((snapshot) => snapshot.id));
    optionalHostSnapshotPage.selected = new Set([...optionalHostSnapshotPage.selected].filter((id) => visibleIds.has(id)));
    const rows = page.snapshots.map((snapshot) => {
      const createdAt = snapshot.createdAt ? new Date(snapshot.createdAt) : null;
      const date = createdAt && Number.isFinite(createdAt.getTime()) ? createdAt.toLocaleString("ru-RU") : snapshot.createdAt || "—";
      const checked = optionalHostSnapshotPage.selected.has(snapshot.id) ? " checked" : "";
      return `<tr><td><input type="checkbox" data-optional-host-snapshot-select="${escapeHtml(snapshot.id)}" aria-label="Выбрать Final ${escapeHtml(snapshot.name)}"${checked}></td><td>${escapeHtml(snapshot.name)}</td><td>${escapeHtml(date)}</td><td>${snapshot.deviceCount.toLocaleString("ru-RU")}</td><td>${escapeHtml(snapshot.source || "—")}</td><td><button class="button secondary" type="button" data-optional-host-snapshot-delete="${escapeHtml(snapshot.id)}" data-snapshot-name="${escapeHtml(snapshot.name)}">Удалить копию</button></td></tr>`;
    }).join("");
    const previous = optionalHostSnapshotPage.previous.length > 0;
    const hasNext = typeof page.nextCursor === "string" && page.nextCursor.length > 0;
    const controls = previous || hasNext
      ? `<div class="action-row"><button class="button secondary" type="button" data-optional-host-snapshot-page="previous" ${previous ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-optional-host-snapshot-page="next" data-page-cursor="${escapeHtml(page.nextCursor || "")}" ${hasNext ? "" : "disabled"}>Дальше</button></div>`
      : "";
    list.innerHTML = `<div class="table-scroll"><table class="data-table"><thead><tr><th><input type="checkbox" data-optional-host-snapshot-select-page aria-label="Выбрать все Final на этой странице"></th><th>Final</th><th>Дата</th><th>Устройств</th><th>Источник</th><th>Действие</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="empty">Копий Final в SQLite optional host нет.</td></tr>'}</tbody></table></div><div class="action-row"><button class="button danger" type="button" data-optional-host-snapshot-delete-selected ${optionalHostSnapshotPage.selected.size ? "" : "disabled"}>Удалить отмеченные копии (${optionalHostSnapshotPage.selected.size.toLocaleString("ru-RU")})</button></div>${controls}`;
    updateOptionalHostSnapshotSelectionUi();
    const start = page.snapshots.length ? optionalHostSnapshotPage.previous.length * 50 + 1 : 0;
    const end = page.snapshots.length ? Math.min(start + page.snapshots.length - 1, page.total) : 0;
    status.textContent = page.total
      ? `Всего ${page.total.toLocaleString("ru-RU")} копий · эта страница ${start.toLocaleString("ru-RU")}–${end.toLocaleString("ru-RU")}`
      : "Сохранённых Final-копий нет.";
    return page;
  } catch (error) {
    status.textContent = error.message || String(error);
    throw error;
  }
}

function updateOptionalHostSnapshotSelectionUi() {
  const list = $("#optionalHostSnapshotsList");
  if (!list) return;
  const deleteButton = list.querySelector("[data-optional-host-snapshot-delete-selected]");
  if (deleteButton) {
    deleteButton.disabled = optionalHostSnapshotPage.selected.size === 0;
    deleteButton.textContent = `Удалить отмеченные копии (${optionalHostSnapshotPage.selected.size.toLocaleString("ru-RU")})`;
  }
  const selectPage = list.querySelector("[data-optional-host-snapshot-select-page]");
  if (selectPage) {
    const selectedCount = optionalHostSnapshotPage.items.filter(({ id }) => optionalHostSnapshotPage.selected.has(id)).length;
    selectPage.checked = optionalHostSnapshotPage.items.length > 0 && selectedCount === optionalHostSnapshotPage.items.length;
    selectPage.indeterminate = selectedCount > 0 && selectedCount < optionalHostSnapshotPage.items.length;
  }
}

async function deleteSelectedOptionalHostSnapshots(button) {
  const selected = optionalHostSnapshotPage.items.filter(({ id }) => optionalHostSnapshotPage.selected.has(id));
  if (!selected.length) return;
  const names = selected.map(({ name }) => `• ${name}`).join("\n");
  if (!globalThis.confirm(`Удалить ${selected.length} отмеченных Final из SQLite optional host и их связанные History? Каждый Final удаляется отдельной транзакцией. Inventory, другие Final и данные IndexedDB сохранятся.\n\n${names}`)) return;
  button.disabled = true;
  const status = $("#optionalHostSnapshotsStatus");
  try {
    const result = await deleteOptionalHostSnapshots(selected.map(({ id }) => id));
    result.deletedIds.forEach((id) => optionalHostSnapshotPage.selected.delete(id));
    await renderOptionalHostSnapshots();
    const failedNames = result.failures.map(({ snapshotId, message }) => {
      const snapshot = selected.find(({ id }) => id === snapshotId);
      return `${snapshot?.name || snapshotId}: ${message}`;
    });
    status.textContent = failedNames.length
      ? `Удалено ${result.deletedIds.length} из ${selected.length}. Не удалены: ${failedNames.join("; ")}`
      : `Удалены ${result.deletedIds.length} отмеченных Final и связанные события History. Inventory сохранён.`;
  } finally {
    button.disabled = optionalHostSnapshotPage.selected.size === 0;
  }
}

async function deleteOptionalHostSnapshotFromUi(button) {
  const snapshotId = button?.dataset.optionalHostSnapshotDelete || "";
  const name = button?.dataset.snapshotName || snapshotId;
  if (!snapshotId || !globalThis.confirm(`Удалить копию Final «${name}» и связанную с ней History из SQLite optional host? Inventory, другие Final и данные IndexedDB сохранятся.`)) return;
  button.disabled = true;
  const status = $("#optionalHostSnapshotsStatus");
  try {
    const result = await deleteOptionalHostSnapshot(snapshotId);
    optionalHostSnapshotPage.selected.delete(snapshotId);
    status.textContent = `Удалена копия «${name}» и ${result.deletedHistoryCount.toLocaleString("ru-RU")} связанных событий History. Inventory и остальные Final сохранены.`;
    await renderOptionalHostSnapshots();
  } catch (error) {
    status.textContent = error.message || String(error);
    throw error;
  } finally {
    button.disabled = false;
  }
}

async function exportReferenceArchive() {
  progress(5, "Потоковая выгрузка Final, Inventory и истории", "Экспорт MAC Analyzer Pro");
  const archiveStream = database.exportReferenceArchiveStream();
  const filename = `mac-analyzer-${new Date().toISOString().slice(0, 10)}.macarchive.json`;
  const result = await downloadReadableStream(filename, archiveStream, "application/json", "Архив MAC Analyzer Pro");
  if (result === "cancelled") finishProgress("Экспорт архива отменён");
  else finishProgress(result === "saved" ? "Совместимый .macarchive.json записан потоково" : "Совместимый .macarchive.json сформирован");
}

async function importDatabase(file) {
  if (!file) return;
  await importPortableArchiveFile(file);
  state.analytics = null;
  await refreshDatabaseState();
  await restoreLegacyTaskSchedulers();
  startFinalAutoSave();
  finishProgress("База импортирована");
  recordLocalNotification("backup", "Архив импортирован", "Локальная база дополнена данными переносимого архива.", "success").catch(showError);
}

async function importLegacySQLite(file, walFile = null) {
  if (!file) return;
  if (!isEngineerActive()) throw new Error("Импорт SQLite доступен только в активном инженерном сеансе");
  $("#sqliteImportStatus").textContent = `Подготовка ${file.name || "SQLite-файла"}…`;
  const result = await importLegacySQLiteFile(file, database, {
    walFile,
    onProgress: ({ collection, recordsRead, stage }) => {
      const status = stage === "copying" ? "Потоковая проверка и сохранение исходной SQLite" : `${collection}: ${Number(recordsRead || 0).toLocaleString("ru-RU")} записей`;
      $("#sqliteImportStatus").textContent = status;
      progress(15, status, "Импорт SQLite");
    },
  });
  state.analytics = null;
  await refreshDatabaseState();
  await renderLegacyAutosaveRestoreList();
  await restoreLegacyTaskSchedulers();
  const imported = Object.entries(result.imported || {}).map(([key, count]) => `${key}: ${Number(count).toLocaleString("ru-RU")}`).join(", ") || "нет записей";
  const skipped = result.skippedTables?.length
    ? `; пропущены: ${result.skippedTables.map(({ table, reason }) => reason ? `${table} (${reason})` : table).join("; ")}`
    : "";
  const skippedRows = Object.entries(result.skippedRows || {}).filter(([, count]) => Number(count) > 0);
  const skippedRowSummary = skippedRows.length
    ? `; пропущены строки: ${skippedRows.map(([table, count]) => `${table}: ${Number(count).toLocaleString("ru-RU")}`).join(", ")}`
    : "";
  const reconciliation = result.identityReconciliation;
  const reconciliationSummary = reconciliation
    ? `; Inventory: объединено совпадающих идентичностей ${Number(reconciliation.linked || 0).toLocaleString("ru-RU")}, неоднозначных ${Number(reconciliation.ambiguous || 0).toLocaleString("ru-RU")}, конфликтных ${Number(reconciliation.conflicts || 0).toLocaleString("ru-RU")}`
    : "";
  const summary = `SQLite проверена (${result.integrity}) и объединена: ${imported}${reconciliationSummary}${skipped}${skippedRowSummary}`;
  $("#sqliteImportStatus").textContent = summary;
  finishProgress(summary);
}

async function importLegacyPyQtSettings(file) {
  if (!file) return;
  if (!isEngineerActive()) throw new Error("Перенос настроек PyQt доступен только в активном инженерном сеансе");
  if (file.size > LEGACY_PYQT_SETTINGS_MAX_BYTES) throw new Error("Файл настроек больше допустимого размера 1 МиБ");
  const raw = JSON.parse(await file.text());
  const hasLegacyIpMappingFile = typeof raw?.ip_address_mapping_file === "string" && Boolean(raw.ip_address_mapping_file.trim());
  const migration = normalizeLegacyPyQtSettings(raw);
  const records = Object.entries(migration.settings).map(([key, value]) => ({ key, value }));
  let restoredFileSources = null;
  if (migration.fileSources.length) {
    const savedSources = normalizeLegacyWorkspaceFiles(await database.getSetting("legacyAppSetting:sourceFiles", []));
    const mergedSources = new Map(savedSources.map((source) => [source.id, source]));
    for (const source of migration.fileSources) mergedSources.set(source.id, source);
    restoredFileSources = normalizeLegacyWorkspaceFiles([...mergedSources.values()]);
    records.push({ key: "legacyAppSetting:sourceFiles", value: restoredFileSources });
  }
  await database.setSettings(records);
  if (restoredFileSources) {
    state.legacyWorkspaceSources = restoredFileSources;
    renderLegacyWorkspaceSources();
  }
  const settings = migration.settings;
  if (settings.theme) {
    applyTheme(settings.theme);
    try { globalThis.localStorage?.setItem("mac-analyzer-theme", settings.theme); } catch { /* IndexedDB remains the persistent source. */ }
  }
  if (settings.vendorDetectorSettings) applyVendorDetectorSettings(settings.vendorDetectorSettings);
  if (settings.historyEnrichmentSettings) applyHistoryEnrichmentSettings(settings.historyEnrichmentSettings);
  if (settings.ipEnrichmentSettings) applyIpEnrichmentSettings(settings.ipEnrichmentSettings);
  if (settings.enrichmentFieldSettings) {
    applyEnrichmentFieldSettings(settings.enrichmentFieldSettings);
  }
  if (settings.ouiFormats) applyOuiFormatSettings(settings.ouiFormats);
  if (settings.enrichmentStrategy) {
    const strategy = document.querySelector(`input[name="strategy"][value="${settings.enrichmentStrategy}"]`);
    if (strategy) strategy.checked = true;
  }
  if (settings.inventoryColumnConfig) {
    state.inventoryColumnConfig = normalizeInventoryColumnConfig(settings.inventoryColumnConfig);
    state.inventoryColumnConfigLoaded = true;
    renderInventoryColumnManager();
    await renderDeviceTable();
  }
  const applied = migration.applied.join(", ");
  const ignored = migration.ignored.length ? ` Пропущены неподдерживаемые/опасные поля: ${migration.ignored.join(", ")}.` : "";
  $("#reselectPyQtIpMappingButton").hidden = !hasLegacyIpMappingFile;
  const mappingFileNote = hasLegacyIpMappingFile
    ? " Файл IP→адрес, указанный в PyQt-настройках, нужно выбрать вручную; его абсолютный путь не сохраняется."
    : "";
  $("#pyqtSettingsImportStatus").textContent = `Перенесены совместимые локальные настройки (${applied}). Путь к файлу настроек не сохраняется.${mappingFileNote}${ignored}`;
}

async function importPortableArchiveFile(file) {
  if (file.size > MAX_PORTABLE_ARCHIVE_BYTES) throw new Error("Архив больше допустимого размера 4 ГиБ");
  const header = await inspectPortableArchiveHeader(file);
  await database.importArchiveEvents(header, readPortableArchiveEvents(file, {
    sourceFormat: header.sourceFormat || "",
    onProgress: ({ collection, recordsRead }) => progress(15, `${collection}: ${recordsRead.toLocaleString("ru-RU")} записей`, "Импорт архива"),
  }));
  state.legacyWorkspaceSources = normalizeLegacyWorkspaceFiles(await database.getSetting("legacyAppSetting:sourceFiles", []));
  renderLegacyWorkspaceSources();
  const historySettings = await database.getSetting("historyEnrichmentSettings", await database.getSetting("legacyAppSetting:historyEnrichment", null));
  if (historySettings) applyHistoryEnrichmentSettings(historySettings);
  const ipSettings = await database.getSetting("ipEnrichmentSettings", null);
  if (ipSettings) applyIpEnrichmentSettings(ipSettings);
}

async function prepareOuiImport(file) {
  if (!file) return;
  const table = isStreamableTableFile(file) ? await readTablePreview(file, { maxRows: 100 }) : await readTable(file);
  const suggested = detectOuiColumns(table.headers);
  state.ouiImport = { file, table, ...suggested };
  const panel = $("#ouiImportPanel");
  const options = (selected) => `<option value="">Выберите колонку</option>${table.headers.map((header, index) => `<option value="${index}" ${selected === index ? "selected" : ""}>${escapeHtml(`${excelColumnLabel(index)} · ${header || `Колонка ${index + 1}`}`)}</option>`).join("")}`;
  panel.innerHTML = `<p>Файл: ${escapeHtml(file.name)} · выберите префикс и производителя.</p><div class="mapping-grid"><label><span>Префикс / Assignment</span><select id="ouiPrefixColumn">${options(suggested.prefixIndex)}</select></label><label><span>Производитель / Organization</span><select id="ouiVendorColumn">${options(suggested.vendorIndex)}</select></label></div><button id="confirmOuiImportButton" class="button primary" type="button">Импортировать OUI</button>`;
  panel.hidden = false;
  const confirm = $("#confirmOuiImportButton");
  const update = () => {
    const prefixIndex = Number($("#ouiPrefixColumn").value);
    const vendorIndex = Number($("#ouiVendorColumn").value);
    confirm.disabled = $("#ouiPrefixColumn").value === "" || $("#ouiVendorColumn").value === ""
      || prefixIndex === vendorIndex;
  };
  panel.querySelectorAll("select").forEach((select) => select.addEventListener("change", update));
  confirm.addEventListener("click", () => importOui(file, {
    prefixIndex: Number($("#ouiPrefixColumn").value),
    vendorIndex: Number($("#ouiVendorColumn").value),
  }).catch(showError));
  update();
}

async function importOui(file, columns) {
  if (state.ouiImportController) return;
  const controller = new AbortController();
  state.ouiImportController = controller;
  const confirmButton = $("#confirmOuiImportButton");
  if (confirmButton) confirmButton.disabled = true;
  const streamingTable = isStreamableTableFile(file);
  const prepared = state.ouiImport?.file === file ? state.ouiImport : null;
  let imported = 0;
  let rowsRead = 0;
  try {
    const table = prepared?.table || (streamingTable ? await readTablePreview(file, { maxRows: 100 }) : await readTable(file));
    if (!Number.isInteger(columns?.prefixIndex) || columns.prefixIndex < 0 || columns.prefixIndex >= table.headers.length
      || !Number.isInteger(columns?.vendorIndex) || columns.vendorIndex < 0 || columns.vendorIndex >= table.headers.length
      || columns.prefixIndex === columns.vendorIndex) throw new Error("Выберите разные колонки префикса и производителя");
    if (streamingTable) {
      for await (const rows of readTableRowBatches(file, { batchSize: 500, signal: controller.signal })) {
        const records = ouiRecords({ headers: table.headers, rows }, columns);
        if (records.length) {
          await database.importOui(records);
          imported += records.length;
        }
        rowsRead += rows.length;
        progress(Math.min(95, rowsRead / 5000), `Обработано ${rowsRead.toLocaleString("ru-RU")} строк`, "Импорт OUI");
      }
    } else {
      if (controller.signal.aborted) throw new DOMException("Операция отменена", "AbortError");
      const records = ouiRecords(table, columns);
      await database.importOui(records);
      imported = records.length;
      rowsRead = table.rows.length;
    }
    if (controller.signal.aborted) throw new DOMException("Операция отменена", "AbortError");
    await database.setSetting("ouiSource", file.name);
    await synchronizeDataDirectoryArchive();
    $("#ouiStatus").textContent = `Импортировано ${imported.toLocaleString("ru-RU")} префиксов`;
    $("#ouiImportPanel").hidden = true;
    $("#ouiImportPanel").replaceChildren();
    state.ouiImport = null;
    finishProgress("OUI импортирован");
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
    const detail = `Импорт отменён после ${rowsRead.toLocaleString("ru-RU")} строк; сохранено ${imported.toLocaleString("ru-RU")} префиксов. Повторите импорт файла, чтобы продолжить.`;
    $("#ouiStatus").textContent = detail;
    finishProgress(detail);
  } finally {
    if (state.ouiImportController === controller) state.ouiImportController = null;
    if (confirmButton) confirmButton.disabled = false;
  }
}

async function loadBundledIeeeIndex() {
  if (ieeeOuiIndex) return ieeeOuiIndex;
  const registry = await loadBundledIeeeRegistry();
  ieeeOuiIndex = buildIeeeRegistryIndex(registry);
  const status = ieeeRegistryStatus(registry);
  const coverage = Object.entries(status.counts).map(([type, count]) => `${type}: ${Number(count).toLocaleString("ru-RU")}`).join(" · ");
  $("#ouiStatus").textContent = `IEEE ${status.generatedAt.slice(0, 10)} · ${status.total.toLocaleString("ru-RU")} назначений (${coverage})`;
  return ieeeOuiIndex;
}

function renderIeeeCidCatalog(registry = bundledIeeeRegistry) {
  const table = $("#ieeeCidCatalogTable");
  if (!table || !registry) return;
  const result = ieeeCidCatalogPage(registry, ieeeCidCatalogState);
  table.innerHTML = result.rows.length
    ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>CID Assignment</th><th>Организация</th></tr></thead><tbody>${result.rows.map(([prefix, organization]) => `<tr><td><code>${escapeHtml(prefix)}</code></td><td>${escapeHtml(organization)}</td></tr>`).join("")}</tbody></table></div>`
    : '<p class="empty">Назначения CID не найдены.</p>';
  $("#ieeeCidCatalogStatus").textContent = `Найдено ${result.total.toLocaleString("ru-RU")} из ${registry.catalog.CID.length.toLocaleString("ru-RU")} назначений · страница ${result.page} из ${result.pageCount} · обновлено ${registry.metadata.generatedAt.slice(0, 10)}.`;
  $("#ieeeCidPreviousButton").disabled = result.page <= 1;
  $("#ieeeCidNextButton").disabled = result.page >= result.pageCount;
}

async function loadBundledIeeeRegistry() {
  if (bundledIeeeRegistry) return bundledIeeeRegistry;
  let registry = globalThis.__MAC_ANALYZER_IEEE_REGISTRY__;
  if (!registry) {
    const response = await fetch("assets/ieee-vendor-registry.json");
    if (!response.ok) throw new Error(`Не удалось загрузить IEEE справочник: HTTP ${response.status}`);
    registry = await response.json();
  }
  validateIeeeRegistry(registry);
  bundledIeeeRegistry = registry;
  return bundledIeeeRegistry;
}

function ouiRecords(table, columns = detectOuiColumns(table.headers)) {
  const prefixIndex = columns.prefixIndex >= 0 ? columns.prefixIndex : 0;
  const vendorIndex = columns.vendorIndex >= 0 ? columns.vendorIndex : 1;
  return table.rows.map((row) => ({
    prefix: normalizeOuiPrefix(row[prefixIndex >= 0 ? prefixIndex : 0]),
    vendor: text(row[vendorIndex >= 0 ? vendorIndex : 1]),
  })).filter((item) => item.prefix && item.vendor);
}

async function ensureBundledOui() {
  const registry = await loadBundledIeeeRegistry();
  renderIeeeCidCatalog(registry);
  const version = String(registry.metadata.generatedAt);
  const previousVersion = await database.getSetting("bundledOuiVersion", "");
  if (previousVersion === version) return;
  const currentOuiSource = await database.getSetting("ouiSource", "");
  const overwriteSources = ["Встроенный IEEE OUI"];
  if (previousVersion === "2026.10" && currentOuiSource === "Встроенный IEEE OUI") {
    overwriteSources.push("Пользовательский справочник");
  }
  const legacySeedMatches = previousVersion === LEGACY_OUI_SEED_VERSION && currentOuiSource !== "Встроенный IEEE OUI"
    ? legacyOuiSeedMatchMap()
    : null;
  progress(2, "Первичная загрузка встроенного OUI", "Инициализация");
  let imported = 0;
  for (const records of ieeeOuiRecordBatches(registry, { batchSize: 500 })) {
    imported += await database.importOui(records, { overwriteSources, legacySeedMatches });
  }
  await database.setSetting("bundledOuiVersion", version);
  if (!currentOuiSource) await database.setSetting("ouiSource", "Встроенный IEEE OUI");
  $("#ouiStatus").textContent = `Встроенный OUI: ${imported.toLocaleString("ru-RU")} префиксов`;
}

function renderSnapshotList() {
  const current = state.uploadHistory;
  const snapshots = current.results === null ? state.snapshotMetadata : current.results;
  const result = selectUploadHistoryPage(snapshots, { ...current, query: current.results === null ? current.query : "" });
  const formatDate = (value) => {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? "Без даты" : date.toLocaleString("ru-RU");
  };
  $("#snapshotList").innerHTML = result.rows.length
    ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Выбрать</th><th>Дата</th><th>Final</th><th>Файлы-источники</th><th>Устройств</th><th>Совпадений</th><th>Время</th><th>Действие</th></tr></thead><tbody>${result.rows.map((snapshot) => {
      const sourceRoles = (snapshot.originalFileRoles || []).filter((role) => ["main", "smartroom", "ddio"].includes(role));
      const sourceDownloads = sourceRoles.map((role) => `<button class="button secondary" type="button" data-download-original="${escapeHtml(snapshot.id)}" data-original-role="${escapeHtml(role)}">${escapeHtml(role.toUpperCase())}</button>`).join(" ");
      const restoreSources = isEngineerActive() && sourceRoles.length
        ? `<button class="button secondary" type="button" data-restore-originals="${escapeHtml(snapshot.id)}">Восстановить исходники в объединение</button>`
        : "";
      return `<tr><td><input type="checkbox" aria-label="Выбрать Final ${escapeHtml(snapshot.name || snapshot.id)} для удаления" data-select-final="${escapeHtml(snapshot.id)}" ${current.selectedIds.has(snapshot.id) ? "checked" : ""}></td><td>${escapeHtml(formatDate(snapshot.createdAt))}</td><td>${escapeHtml(snapshot.name || snapshot.id)}</td><td>${escapeHtml(snapshotSourceNames(snapshot).join(", ") || "—")}</td><td>${Number(snapshot.deviceCount || 0).toLocaleString("ru-RU")}</td><td>${snapshot.matchingDeviceCount == null ? "—" : Number(snapshot.matchingDeviceCount).toLocaleString("ru-RU")}</td><td>${(Math.max(0, Number(snapshot.processingTimeMs || 0)) / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} с</td><td><button class="button secondary" type="button" data-open-final="${escapeHtml(snapshot.id)}">Открыть</button>${sourceDownloads ? `<div class="action-row">${sourceDownloads}</div>${restoreSources}` : ""}</td></tr>`;
    }).join("")}</tbody></table></div>`
    : '<p class="empty">По выбранным условиям успешных загрузок нет.</p>';
  const scope = current.results === null ? "загрузок" : "совпавших Final";
  $("#snapshotHistoryStatus").textContent = `${result.total.toLocaleString("ru-RU")} ${scope} · страница ${result.page} из ${result.pageCount}`;
  $("#deleteSelectedFinalsButton").disabled = !current.selectedIds.size;
  $("#deleteSelectedFinalsButton").textContent = `Удалить отмеченные Final (${current.selectedIds.size})`;
  $("#clearFinalHistoryButton").disabled = state.snapshotMetadata.length === 0;
  $("#snapshotHistoryPreviousButton").disabled = !result.hasPrevious;
  $("#snapshotHistoryNextButton").disabled = !result.hasNext;
}

async function deleteSelectedFinals() {
  const ids = [...state.uploadHistory.selectedIds];
  if (!ids.length) return;
  if (!globalThis.confirm(`Удалить ${ids.length} отмеченных Final вместе с их историей, оригиналами файлов и аналитическими данными? Накопительный Inventory сохранится.`)) return;
  const result = await database.deleteSnapshots(ids);
  state.uploadHistory.selectedIds.clear();
  state.uploadHistory.results = null;
  state.uploadHistory.page = 1;
  await refreshDatabaseState();
  await synchronizeDataDirectoryArchive();
  renderSnapshotList();
  $("#snapshotHistoryStatus").textContent = `Удалено Final: ${result.deleted}. Inventory сохранён.`;
}

async function clearFinalHistory() {
  if (!state.snapshotMetadata.length) return;
  if (!globalThis.confirm(`Удалить все ${state.snapshotMetadata.length} Final, их историю, исходные файлы и аналитические индексы? Inventory, пользовательские правила и настройки останутся.`)) return;
  const result = await database.deleteSnapshots(state.snapshotMetadata.map(({ id }) => id));
  state.uploadHistory.selectedIds.clear();
  state.uploadHistory.results = null;
  state.uploadHistory.page = 1;
  await refreshDatabaseState();
  await synchronizeDataDirectoryArchive();
  renderSnapshotList();
  $("#snapshotHistoryStatus").textContent = `История Final очищена · удалено ${result.deleted.toLocaleString("ru-RU")}. Inventory, правила и настройки сохранены.`;
}

async function searchUploadHistory(values = state.uploadHistory) {
  const current = state.uploadHistory;
  const requestId = current.requestId + 1;
  current.requestId = requestId;
  current.query = String(values.query || "").trim();
  current.from = values.from || "";
  current.to = values.to || "";
  current.vendor = String(values.vendor || "").trim();
  current.model = String(values.model || "").trim();
  current.room = String(values.room || "").trim();
  current.page = 1;
  current.results = null;
  const query = current.query.toLocaleLowerCase("ru-RU");
  const deviceFilters = { vendor: current.vendor, model: current.model, room: current.room };
  if (!query && !current.vendor && !current.model && !current.room) {
    renderSnapshotList();
    return;
  }
  const candidates = filterUploadHistorySnapshots(state.snapshotMetadata, { from: current.from, to: current.to });
  const matched = [];
  $("#snapshotHistoryStatus").textContent = `Поиск по снимкам: 0 из ${candidates.length}…`;
  try {
    for (let index = 0; index < candidates.length; index += 1) {
      if (requestId !== current.requestId) return;
      const snapshot = candidates[index];
      const metadataText = [snapshot.name, snapshot.id, snapshot.sourceKey, ...snapshotSourceNames(snapshot)].join(" ").toLocaleLowerCase("ru-RU");
      if (query && metadataText.includes(query) && !current.vendor && !current.model && !current.room) {
        matched.push({ ...snapshot, matchingDeviceCount: null });
      } else {
        let matchingDeviceCount = 0;
        await database.forEachSnapshotChunk(snapshot.id, (devices) => {
          for (const device of devices) {
            if (snapshotDeviceMatchesQuery(device, query) && snapshotDeviceMatchesFilters(device, deviceFilters)) matchingDeviceCount += 1;
          }
        });
        if (matchingDeviceCount) matched.push({ ...snapshot, matchingDeviceCount });
      }
      if ((index + 1) % 5 === 0 || index + 1 === candidates.length) {
        $("#snapshotHistoryStatus").textContent = `Поиск по снимкам: ${index + 1} из ${candidates.length} · найдено ${matched.length}…`;
        await new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      }
    }
    if (requestId !== current.requestId) return;
    current.results = matched;
    renderSnapshotList();
  } catch (error) {
    if (requestId === current.requestId) {
      showError(error);
      $("#snapshotHistoryStatus").textContent = `Поиск остановлен: ${error.message || error}`;
    }
  }
}

async function openFinalSnapshotPage(snapshotId, page = 1) {
  await loadInventoryColumnConfig();
  const pageSize = 100;
  const result = await database.loadSnapshotPage(snapshotId, { page, limit: pageSize });
  state.snapshotDetail = { id: snapshotId, page: result.page };
  const metadata = result.metadata;
  const content = `<p class="muted">${Number(result.total).toLocaleString("ru-RU")} устройств · ${escapeHtml(new Date(metadata.createdAt || "").toLocaleString("ru-RU"))} · ${escapeHtml(snapshotSourceNames(metadata).join(", ") || "источник не указан")}</p><p class="muted">Страница ${result.page} из ${result.pageCount}</p>${result.devices.length ? deviceTable(result.devices, { columnConfig: state.inventoryColumnConfig, rowNumberOffset: (result.page - 1) * pageSize }) : '<p class="empty">В этом Final нет устройств.</p>'}<div class="action-row"><button class="button secondary" type="button" data-final-detail-page="${Math.max(1, result.page - 1)}" ${result.hasPrevious ? "" : "disabled"}>Назад</button><button class="button secondary" type="button" data-final-detail-page="${Math.min(result.pageCount, result.page + 1)}" ${result.hasNext ? "" : "disabled"}>Дальше</button></div>`;
  showDialog($("#detailsDialog"), `Final: ${metadata.name || metadata.id}`, content);
}

function renderVendorModelHistory() {
  const current = state.vendorModelHistory;
  const host = $("#vendorModelHistoryTable");
  const previous = $("#vendorModelHistoryPreviousButton");
  const next = $("#vendorModelHistoryNextButton");
  $("#exportVendorModelHistoryButton").disabled = !current.data || current.loading;
  if (!current.data) {
    host.innerHTML = '<p class="empty">Постройте историю, чтобы просмотреть агрегаты по сохранённым Final и импортированным наблюдениям.</p>';
    previous.disabled = true;
    next.disabled = true;
    $("#deleteImportedHistoryLoadsButton").hidden = true;
    $("#deleteImportedHistoryLoadsButton").disabled = true;
    return;
  }
  const result = selectVendorModelHistoryPage(current.data, current);
  const columns = current.kind === "loads"
    ? [["source", "Источник / файл"], ["records", "Устройств / записей"], ["newVendorsAdded", "Новых производителей"], ["newModelsAdded", "Новых моделей"], ["enrichedFromHistory", "Обогащено из истории"], ["vendors", "Производители"], ["models", "Модели"], ["lastSeen", "Последняя запись"], ["actions", "Действие"]]
    : current.kind === "models"
    ? [["prefix", "MAC5"], ["model", "Модель"], ["occurrences", "Наблюдений"], ["snapshots", "Final"], ["importedObservations", "Импортировано"], ["sources", "Источники"], ["firstSeen", "Первое появление"], ["lastSeen", "Последнее появление"]]
    : [["oui", "OUI"], ["vendor", "Производитель"], ["occurrences", "Наблюдений"], ["snapshots", "Final"], ["importedObservations", "Импортировано"], ["sources", "Источники"], ["firstSeen", "Первое появление"], ["lastSeen", "Последнее появление"]];
  const formatDate = (value) => {
    const date = new Date(value || "");
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ru-RU");
  };
  const renderCell = (row, key) => {
    if (key === "actions") {
      if (!row.importedLoadId) return "<td>—</td>";
      return `<td><button class="button danger" type="button" data-delete-imported-history-load="${escapeHtml(row.importedLoadId)}" ${current.loading ? "disabled" : ""}>Удалить</button></td>`;
    }
    const value = ["firstSeen", "lastSeen"].includes(key) ? formatDate(row[key])
      : Array.isArray(row[key]) ? row[key].join("; ")
        : Number.isFinite(row[key]) ? Number(row[key]).toLocaleString("ru-RU") : row[key];
    return `<td>${escapeHtml(value)}</td>`;
  };
  host.innerHTML = result.rows.length
    ? `<div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr>${columns.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join("")}</tr></thead><tbody>${result.rows.map((row) => `<tr>${columns.map(([key]) => renderCell(row, key)).join("")}</tr>`).join("")}</tbody></table></div>`
    : '<p class="empty">По выбранным условиям записей нет.</p>';
  const stats = current.data.statistics;
  $("#vendorModelHistoryStatus").textContent = `${stats.totalSnapshots.toLocaleString("ru-RU")} Final · ${Number(stats.importedObservations || 0).toLocaleString("ru-RU")} импортированных наблюдений · ${Number(stats.importedLoads || 0).toLocaleString("ru-RU")} импортированных загрузок · ${Number(stats.mappingRules || 0).toLocaleString("ru-RU")} правил · ${stats.loadRecords.toLocaleString("ru-RU")} источников загрузок · ${stats.ouiVendorRecords.toLocaleString("ru-RU")} OUI/производитель · ${stats.mac5ModelRecords.toLocaleString("ru-RU")} MAC5/модель · найдено ${result.total.toLocaleString("ru-RU")} · страница ${result.page} из ${result.pageCount}`;
  previous.disabled = !result.hasPrevious || current.loading;
  next.disabled = !result.hasNext || current.loading;
  $("#deleteImportedHistoryLoadsButton").hidden = current.kind !== "loads";
  $("#deleteImportedHistoryLoadsButton").disabled = !Number(stats.importedLoads) || current.loading;
}

async function deleteImportedHistoryLoad(id) {
  const current = state.vendorModelHistory;
  const load = current.data?.loads?.find((item) => item.importedLoadId === id);
  if (!load || !globalThis.confirm(`Удалить импортированную загрузку «${load.source}» из истории? Final и события History не затрагиваются.`)) return;
  const deleted = await database.deleteLegacyObservations([id]);
  if (!deleted) throw new Error("Запись импорта уже отсутствует в локальной базе");
  await rebuildVendorModelHistory();
  $("#vendorModelHistoryStatus").textContent += ` · удалено загрузок: ${deleted.toLocaleString("ru-RU")}`;
}

async function deleteImportedHistoryLoads() {
  const count = Number(state.vendorModelHistory.data?.statistics?.importedLoads || 0);
  if (!count || !globalThis.confirm(`Удалить все ${count.toLocaleString("ru-RU")} импортированные записи истории загрузок? Final, Inventory и события History не затрагиваются.`)) return;
  const deleted = await database.deleteLegacyObservationsByFilters({ kind: "history_loads" });
  await rebuildVendorModelHistory();
  $("#vendorModelHistoryStatus").textContent += ` · удалено загрузок: ${deleted.toLocaleString("ru-RU")}`;
}

async function rebuildVendorModelHistory() {
  const current = state.vendorModelHistory;
  if (current.loading) return;
  current.loading = true;
  $("#rebuildVendorModelHistoryButton").disabled = true;
  $("#vendorModelHistoryStatus").textContent = `Обработка Final: 0 из ${state.snapshotMetadata.length}…`;
  renderVendorModelHistory();
  try {
    const accumulator = new VendorModelHistoryAccumulator();
    let processed = 0;
    for (const snapshot of [...state.snapshotMetadata].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      accumulator.beginSnapshot(snapshot);
      await database.forEachSnapshotChunk(snapshot.id, (devices) => {
        for (const device of devices) accumulator.addDevice(device);
      });
      accumulator.endSnapshot();
      processed += 1;
      $("#vendorModelHistoryStatus").textContent = `Обработано Final: ${processed} из ${state.snapshotMetadata.length}…`;
    }
    let importedRows = 0;
    for (const kind of ["vendor_model_history", "mac_history", "resolved_device_history"]) {
      let importedCursor = null;
      let importedPage;
      do {
        importedPage = await database.legacyObservationPage({ kind, cursor: importedCursor, limit: 250 });
        for (const observation of importedPage.rows) accumulator.addObservation(observation);
        importedRows += importedPage.rows.length;
        importedCursor = importedPage.nextCursor;
        if (importedPage.hasMore) $("#vendorModelHistoryStatus").textContent = `Обработано импортированных наблюдений (${kind}): ${importedRows.toLocaleString("ru-RU")}…`;
      } while (importedPage.hasMore);
    }
    let loadCursor = null;
    let loadPage;
    let importedLoads = 0;
    do {
      loadPage = await database.legacyObservationPage({ kind: "history_loads", cursor: loadCursor, limit: 250 });
      for (const observation of loadPage.rows) accumulator.addObservation(observation);
      importedLoads += loadPage.rows.length;
      loadCursor = loadPage.nextCursor;
      if (loadPage.hasMore) $("#vendorModelHistoryStatus").textContent = `Обработано импортированных загрузок: ${importedLoads.toLocaleString("ru-RU")}…`;
    } while (loadPage.hasMore);
    let ouiCursor = "";
    let ouiPage;
    do {
      ouiPage = await database.ouiPage({ afterPrefix: ouiCursor, limit: 250 });
      for (const rule of ouiPage.rows) accumulator.addMappingRule({ kind: "vendor", prefix: rule.prefix, value: rule.vendor, source: rule.source, occurrences: rule.occurrences, firstSeen: rule.firstSeen, lastSeen: rule.lastSeen, updatedAt: rule.updatedAt });
      ouiCursor = ouiPage.nextCursor || "";
      if (ouiPage.hasMore) $("#vendorModelHistoryStatus").textContent = `Обработано OUI-правил: ${accumulator.totalMappingRules.toLocaleString("ru-RU")}…`;
    } while (ouiPage.hasMore);
    let modelCursor = "";
    let modelPage;
    do {
      modelPage = await database.mac5ModelPage({ afterPrefix: modelCursor, limit: 250 });
      for (const rule of modelPage.rows) accumulator.addMappingRule({ kind: "model", prefix: rule.prefix, value: rule.model, source: rule.source, occurrences: rule.occurrences, firstSeen: rule.firstSeen, lastSeen: rule.lastSeen, updatedAt: rule.updatedAt });
      modelCursor = modelPage.nextCursor || "";
      if (modelPage.hasMore) $("#vendorModelHistoryStatus").textContent = `Обработано OUI/MAC правил: ${accumulator.totalMappingRules.toLocaleString("ru-RU")}…`;
    } while (modelPage.hasMore);
    current.data = accumulator.result();
    current.page = 1;
    renderVendorModelHistory();
  } catch (error) {
    showError(error);
    $("#vendorModelHistoryStatus").textContent = `Не удалось построить историю: ${error.message || error}`;
  } finally {
    current.loading = false;
    $("#rebuildVendorModelHistoryButton").disabled = false;
    renderVendorModelHistory();
  }
}

async function learnVendorModelRules() {
  const button = $("#learnVendorModelButton");
  if (button.disabled) return;
  const snapshots = [...state.snapshotMetadata].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  const learner = createVendorModelRuleLearner({
    minimumCount: Number($("#vendorModelLearnMinCount").value) || 2,
    sourceFilter: $("#vendorModelLearnSource").value,
  });
  button.disabled = true;
  $("#vendorModelLearnStatus").textContent = `Чтение ${snapshots.length} Final из IndexedDB…`;
  try {
    let processed = 0;
    for (const snapshot of snapshots) {
      await database.forEachSnapshotChunk(snapshot.id, (devices) => {
        for (const device of devices) learner.add(device, snapshot);
      });
      processed += 1;
      $("#vendorModelLearnStatus").textContent = `Обработано Final: ${processed} из ${snapshots.length}…`;
    }
    const suggestions = learner.result();
    const saved = await database.saveLearnedVendorModelRules(suggestions);
    const applied = state.activeSnapshot
      ? await database.applyVendorModelRulesToActiveSnapshot()
      : { vendorsFilled: 0, modelsFilled: 0 };
    if (applied.vendorsFilled || applied.modelsFilled) {
      state.vendorModelHistory.data = null;
      await refreshDatabaseState();
    } else {
      await synchronizeDataDirectoryArchive();
    }
    $("#vendorModelLearnStatus").textContent = `Проверено устройств: ${suggestions.scannedDevices.toLocaleString("ru-RU")} · найдено правил: производителей ${suggestions.vendors.length}, моделей ${suggestions.models.length} · добавлено: производителей ${saved.vendors}, моделей ${saved.models} · активный Final дополнен: производителей ${applied.vendorsFilled}, моделей ${applied.modelsFilled}.`;
    state.mac5Rules.cursor = null;
    state.mac5Rules.previous = [];
    await renderMac5RuleList();
  } catch (error) {
    $("#vendorModelLearnStatus").textContent = `Не удалось обучить правила: ${error.message || error}`;
    showError(error);
  } finally {
    button.disabled = false;
  }
}

function exportVendorModelHistory() {
  const current = state.vendorModelHistory;
  if (!current.data) return;
  const columns = current.kind === "loads"
    ? [["source", "Источник / файл"], ["records", "Устройств / записей"], ["newVendorsAdded", "Новых производителей"], ["newModelsAdded", "Новых моделей"], ["enrichedFromHistory", "Обогащено из истории"], ["vendors", "Производители"], ["models", "Модели"], ["lastSeen", "Последняя запись"]]
    : current.kind === "models"
    ? [["prefix", "MAC5"], ["model", "Модель"], ["occurrences", "Наблюдений"], ["snapshots", "Final"], ["importedObservations", "Импортировано"], ["sources", "Источники"], ["firstSeen", "Первое появление"], ["lastSeen", "Последнее появление"]]
    : [["oui", "OUI"], ["vendor", "Производитель"], ["occurrences", "Наблюдений"], ["snapshots", "Final"], ["importedObservations", "Импортировано"], ["sources", "Источники"], ["firstSeen", "Первое появление"], ["lastSeen", "Последнее появление"]];
  const filename = `vendor-model-history-${current.kind}.csv`;
  const mime = "text/csv;charset=utf-8";
  const stream = readableTextStreamFromIterable(vendorModelHistoryCsvChunks(current.data, { kind: current.kind, query: current.query, columns }));
  let pickerPromise;
  if (typeof globalThis.showSaveFilePicker === "function") pickerPromise = globalThis.showSaveFilePicker({
    suggestedName: filename,
    types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
  });
  if (pickerPromise) {
    (async () => {
      const handle = await pickerPromise;
      await writeReadableStreamToWritable(stream, await handle.createWritable());
    })().catch((error) => { if (error?.name !== "AbortError") showError(error); });
    return;
  }
  new globalThis.Response(stream, { headers: { "Content-Type": mime } }).blob()
    .then((blob) => download(filename, blob, mime))
    .catch(showError);
}

async function renderMac5RuleList() {
  const current = state.mac5Rules;
  const requestId = ++current.requestId;
  const page = await database.mac5ModelPage({ afterPrefix: current.cursor, query: current.query, limit: 100 });
  if (requestId !== current.requestId) return;
  current.page = page;
  const container = $("#mac5ModelRules");
  container.innerHTML = page.rows.length
    ? `<div class="table-scroll"><table class="data-table" data-virtual-scroll="true"><thead><tr><th>Префикс MAC</th><th>Модель</th><th>Наблюдений</th><th>Источник</th><th>Действие</th></tr></thead><tbody>${page.rows.map((rule) => `<tr><td>${escapeHtml(rule.prefix)}</td><td>${escapeHtml(rule.model)}</td><td>${rule.observations == null ? "—" : Number(rule.observations).toLocaleString("ru-RU")}</td><td>${escapeHtml(rule.source || "Пользовательское правило")}</td><td><button type="button" class="button secondary" data-delete-mac5="${escapeHtml(rule.prefix)}">Удалить</button></td></tr>`).join("")}</tbody></table></div>`
    : `<p class="empty">${current.query ? "Правила по этому запросу не найдены." : "Пользовательские правила не добавлены. Встроенные правила применяются автоматически."}</p>`;
  $("#mac5ModelRuleStatus").textContent = page.rows.length
    ? `Показано ${page.rows.length} правил${page.hasMore ? "; есть следующая страница" : ""}.`
    : "Нет правил для отображения.";
  $("#mac5ModelRulePrevious").disabled = current.previous.length === 0;
  $("#mac5ModelRuleNext").disabled = !page.hasMore;
  container.querySelectorAll("[data-delete-mac5]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await database.deleteMac5Model(button.dataset.deleteMac5);
      await synchronizeDataDirectoryArchive();
      current.cursor = null;
      current.previous = [];
      await renderMac5RuleList();
    } catch (error) { showError(error); }
  }));
}

async function openModelPrefixAnalytics(model) {
  const customRules = await database.mac5ModelsMatchingModel(model);
  const snapshot = state.analytics?.current?.id ? state.analytics.current : state.activeSnapshot;
  const collector = createModelPrefixAnalyticsCollector(model, customRules);
  if (snapshot?.id) await database.forEachSnapshotChunk(snapshot.id, (chunk) => collector.accept(chunk));
  const result = collector.finish();
  const savedFinals = (await database.listSnapshots()).filter((item) => isFinalSnapshot(item) && !String(item.id).startsWith("legacy-sqlite-"));
  const occurrences = result.prefixes.length
    ? await countMac5Occurrences(
      result.prefixes,
      savedFinals,
      (id, visit) => database.forEachSnapshotChunk(id, visit),
      (cursor) => database.legacyObservationPage({ kind: "mac_history", cursor, limit: 500 }),
    )
    : new Map();
  result.prefixes = result.prefixes.map((item) => ({ ...item, occurrences: occurrences.get(item.prefix) || 0 }));
  state.modelPrefixAnalytics = result;
  showDialog($("#detailsDialog"), `Префиксы MAC для модели ${result.model}`, modelPrefixAnalyticsContent(result));
}

async function exportModelPrefixAnalyticsXlsx() {
  const result = state.modelPrefixAnalytics;
  if (!result) throw new Error("Сначала откройте префиксы модели");
  const stream = createXlsxWorkbookStream(modelPrefixAnalyticsXlsxSheets(result));
  const safeModel = String(result.model || "model").replace(/[^\p{L}\p{N}-]+/gu, "_").slice(0, 80) || "model";
  await downloadReadableStream(
    `model-prefixes-${safeModel}.xlsx`,
    stream,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Префиксы модели Excel",
  );
}

async function resetFiles() {
  await database.deleteWorkspaceSourceFileHandles();
  state.sourceTables = { main: null, smartroom: null, ddio: null };
  state.sourceFiles = { main: null, smartroom: null, ddio: null };
  state.mappings = { main: {}, smartroom: {}, ddio: {} };
  state.workspaceSourceHandles = { main: null, smartroom: null, ddio: null };
  for (const role of ["main", "smartroom", "ddio"]) {
    $(`#${role}FileInput`).value = "";
    $(`#${role}FileStatus`).textContent = "Не выбран";
    renderWorkspaceSourceHandleStatus(role, "Сохранённый доступ к исходному файлу удалён.");
    renderMapping(role);
  }
}

async function runSystemDiagnostics() {
  const button = $("#runDiagnosticsButton");
  const status = $("#diagnosticsStatus");
  const results = $("#diagnosticsResults");
  button.disabled = true;
  results.replaceChildren();
  status.textContent = "Проверка локального хранилища…";
  try {
    const report = await runBrowserDiagnostics({
      database,
      directoryPermission: state.dataDirectoryPermission,
      onProgress: ({ completed, total, snapshot }) => {
        status.textContent = `Проверено снимков: ${completed}/${total} · ${snapshot}`;
      },
    });
    const checks = [...report.checks];
    if (optionalHostDatabaseExportHref(globalThis.location)) {
      try {
        const hostReport = await loadOptionalHostDiagnostics({ locationLike: globalThis.location });
        if (hostReport) checks.push(...hostReport.checks);
      } catch (error) {
        checks.push({ id: "optional-host", title: "Optional host", status: "warning", detail: error.message });
      }
    }
    const passed = checks.filter((item) => item.status === "ok").length;
    const warnings = checks.filter((item) => item.status === "warning").length;
    const errors = checks.filter((item) => item.status === "error").length;
    status.textContent = `Проверка завершена · исправно: ${passed} · предупреждения: ${warnings} · ошибки: ${errors}`;
    results.innerHTML = checks.map((item) => `<li class="diagnostic-${escapeHtml(item.status)}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></li>`).join("");
  } catch (error) {
    status.textContent = `Диагностика не завершилась: ${error.message}`;
    results.replaceChildren();
  } finally {
    button.disabled = false;
  }
}

function currentTheme() {
  return document.body.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(theme) {
  const selected = isThemeChoice(theme) ? theme : "light";
  document.body.classList.toggle("dark", selected === "dark");
  $("#themeButton").setAttribute("aria-label", `Текущая тема: ${selected === "dark" ? "тёмная" : "светлая"}. Выбрать тему`);
  $("#themeButton").title = `Текущая тема: ${selected === "dark" ? "тёмная" : "светлая"}`;
  $("meta[name='theme-color']").content = selected === "dark" ? "#111827" : "#0b7285";
  $$("[data-theme-choice]").forEach((button) => {
    const active = button.dataset.themeChoice === selected;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (state.analytics?.detailsReady) drawDashboardStatusCharts(state.analytics);
}

function openThemeDialog() {
  applyTheme(currentTheme());
  $("#themeDialogStatus").textContent = "Выбранная тема действует сразу и сохраняется в этом браузере.";
  $("#themeDialog").showModal();
  $("#themeDialog").querySelector(`[data-theme-choice="${currentTheme()}"]`)?.focus();
}

async function selectTheme(theme) {
  if (!isThemeChoice(theme)) return;
  applyTheme(theme);
  $("#themeDialogStatus").textContent = `Применена ${theme === "dark" ? "тёмная" : "светлая"} тема.`;
  try { globalThis.localStorage?.setItem("mac-analyzer-theme", theme); } catch { /* IndexedDB remains the persistent source. */ }
  await database.setSetting("theme", theme);
  await synchronizeDataDirectoryArchive();
}

function selectDashboardSettingsTab(index, focus = false) {
  const tabs = $$("#analyticsDashboardSettingsDialog [role='tab']");
  const safeIndex = Math.max(0, Math.min(tabs.length - 1, index));
  tabs.forEach((tab, tabIndex) => {
    const selected = tabIndex === safeIndex;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute("aria-controls"));
    panel.hidden = !selected;
  });
  if (focus) tabs[safeIndex]?.focus();
}

async function exportAnalyticsDashboardPng() {
  const model = buildAnalyticsDashboardExportModel(state.analytics, state.analyticsDashboardSettings);
  const { kpis, charts } = model;
  const canvas = document.createElement("canvas");
  canvas.width = model.width;
  canvas.height = model.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Браузер не предоставил Canvas 2D для PNG-экспорта");
  const computed = getComputedStyle(document.body);
  const color = (name, fallback) => computed.getPropertyValue(name).trim() || fallback;
  const colors = {
    background: color("--bg", "#f4f7f8"), surface: color("--surface", "#fff"),
    text: color("--text", "#172326"), muted: color("--muted", "#66777b"),
    grid: color("--border", "#d6e0e2"), axis: color("--muted", "#66777b"),
    positive: color("--primary", "#087f8c"), negative: color("--danger", "#c92a2a"),
    blue: color("--primary-dark", "#2667a8"),
  };
  context.fillStyle = colors.background;
  context.fillRect(0, 0, model.width, model.height);
  context.fillStyle = colors.text;
  context.font = "700 31px Segoe UI, sans-serif";
  context.fillText("MAC Analyzer Pro · Dashboard", 80, 60);
  context.fillStyle = colors.muted;
  context.font = "16px Segoe UI, sans-serif";
  const snapshotLabel = state.analytics.current?.name || state.analytics.current?.id || "Текущий набор Final";
  context.fillText(`Снимок: ${snapshotLabel} · Экспорт ${new Date().toLocaleString("ru-RU")}`, 80, 92, 1840);
  const cardGap = 12;
  const cardWidth = (1840 - cardGap * 5) / 6;
  kpis.forEach((kpi, index) => {
    const x = 80 + index * (cardWidth + cardGap);
    context.fillStyle = colors.surface;
    context.fillRect(x, 120, cardWidth, 142);
    context.strokeStyle = colors.grid;
    context.strokeRect(x, 120, cardWidth, 142);
    context.fillStyle = colors.muted;
    context.font = "14px Segoe UI, sans-serif";
    context.fillText(kpi.label, x + 14, 151, cardWidth - 28);
    context.fillStyle = colors.text;
    context.font = "700 33px Segoe UI, sans-serif";
    context.fillText(Number(kpi.value).toLocaleString("ru-RU"), x + 14, 211, cardWidth - 28);
  });
  const chartRows = Math.ceil(charts.length / 2);
  const chartGap = 35;
  const chartTop = 300;
  const chartBottom = 40;
  const chartHeight = Math.min(405, (model.height - chartTop - chartBottom - chartGap * Math.max(0, chartRows - 1)) / Math.max(1, chartRows));
  charts.forEach((chart, index) => {
    const x = index % 2 === 0 ? 80 : 1020;
    const y = chartTop + Math.floor(index / 2) * (chartHeight + chartGap);
    const width = 900;
    const height = chartHeight;
    context.fillStyle = colors.surface;
    context.fillRect(x, y, width, height);
    context.strokeStyle = colors.grid;
    context.strokeRect(x, y, width, height);
    drawDashboardExportChart(context, chart, x, y, width, height, colors);
  });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Не удалось создать PNG Dashboard");
  download(`analytics-dashboard-${new Date().toISOString().slice(0, 10)}.png`, blob, "image/png");
}

async function exportAnalyticsDashboardXlsx() {
  const button = $("#exportAnalyticsXlsxButton");
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = "Формирование XLSX…";
  try {
  const filename = `analytics-dashboard-${new Date().toISOString().slice(0, 10)}.xlsx`;
  const summarySheets = analyticsSummaryXlsxSheets(state.analytics, (queryId, metric, options) => database.analyticsAggregateRankedPage(queryId, metric, options));
  const sheets = [...summarySheets, ...analyticsDashboardXlsxSheets(state.analytics, state.analyticsDashboardSettings)];
  const stream = createXlsxWorkbookStream(sheets);
  await downloadReadableStream(
    filename,
    stream,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Аналитика Excel",
  );
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function exportAnalyticsDashboardHtml() {
  const createdAt = new Date();
  const filename = `analytics-dashboard-${createdAt.toISOString().slice(0, 10)}.html`;
  const mime = "text/html;charset=utf-8";
  const chunks = analyticsDashboardHtmlChunks(state.analytics, createdAt, state.analyticsDashboardSettings);
  await downloadReadableStream(filename, readableTextStreamFromIterable(chunks), mime, "Dashboard HTML");
}

function exportActiveFinal(format) {
  const snapshot = state.activeSnapshot;
  if (!snapshot) return Promise.reject(new Error("Нет активного Final"));
  const definitions = {
    csv: { filename: "final.csv", description: "CSV", extension: ".csv", mime: "text/csv;charset=utf-8", operation: "export_csv", blob: snapshotCsvBlob, stream: writeSnapshotCsv },
    xlsx: { filename: "final.xlsx", description: "Excel", extension: ".xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", operation: "export_xlsx" },
    txt: { filename: "final.txt", description: "TXT", extension: ".txt", mime: "text/plain;charset=utf-8", operation: "export_txt", blob: snapshotTextBlob, stream: writeSnapshotText },
    json: { filename: "final.json", description: "JSON", extension: ".json", mime: "application/json", operation: "export_json", blob: snapshotJsonBlob, stream: writeSnapshotJson },
    yaml: { filename: "final.yaml", description: "YAML", extension: ".yaml", mime: "application/yaml;charset=utf-8", operation: "export_yaml", blob: snapshotYamlBlob, stream: writeSnapshotYaml },
    html: { filename: "final.html", description: "HTML", extension: ".html", mime: "text/html;charset=utf-8", operation: "export_html", blob: snapshotHtmlBlob, stream: writeSnapshotHtml },
  };
  const definition = definitions[format];
  if (!definition) return Promise.reject(new Error(`Неизвестный формат экспорта: ${format}`));
  const startedAt = performance.now();
  const visitChunks = (id, visit) => database.forEachSnapshotChunk(id, visit);
  const columns = format === "xlsx"
    ? inventoryOutputColumns()
    : format === "csv" || format === "txt" || format === "html"
      ? TABLE_COLUMNS.map(([key, label]) => ({ key, label }))
      : null;
  let pickerPromise;
  try {
    if (typeof globalThis.showSaveFilePicker === "function") pickerPromise = globalThis.showSaveFilePicker({
      suggestedName: definition.filename,
      types: [{ description: definition.description, accept: { [definition.mime.split(";")[0]]: [definition.extension] } }],
    });
  } catch (error) { return Promise.reject(error); }
  return (async () => {
    if (pickerPromise) {
      const handle = await pickerPromise;
      const writable = await handle.createWritable();
      try {
        if (format === "xlsx") {
          const sheets = createSnapshotXlsxSheets(database, snapshot, columns);
          const reader = createXlsxWorkbookStream(sheets).getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await writable.write(value);
            }
          } finally { reader.releaseLock(); }
        } else if (columns) await definition.stream(snapshot, visitChunks, columns, writable);
        else await definition.stream(snapshot, visitChunks, writable);
        await writable.close();
      } catch (error) {
        if (typeof writable.abort === "function") await writable.abort().catch(() => {});
        throw error;
      }
    } else {
      let blob;
      if (format === "xlsx") {
        blob = await new globalThis.Response(createXlsxWorkbookStream(createSnapshotXlsxSheets(database, snapshot, columns)), { headers: { "Content-Type": definition.mime } }).blob();
      } else if (typeof globalThis.TransformStream === "function") {
        const encoder = new globalThis.TextEncoder();
        const transform = new globalThis.TransformStream({
          transform(chunk, controller) { controller.enqueue(encoder.encode(String(chunk))); },
        });
        const writable = transform.writable.getWriter();
        const blobPromise = new globalThis.Response(transform.readable, { headers: { "Content-Type": definition.mime } }).blob();
        try {
          if (columns) await definition.stream(snapshot, visitChunks, columns, writable);
          else await definition.stream(snapshot, visitChunks, writable);
          await writable.close();
          blob = await blobPromise;
        } catch (error) {
          await writable.abort().catch(() => {});
          await blobPromise.catch(() => {});
          throw error;
        }
      } else {
        const sink = createTextBlobStreamSink(definition.mime);
        if (sink) {
          try {
            if (columns) await definition.stream(snapshot, visitChunks, columns, sink.writable);
            else await definition.stream(snapshot, visitChunks, sink.writable);
            await sink.writable.close();
            blob = await sink.blobPromise;
          } catch (error) {
            await sink.writable.abort(error);
            await sink.blobPromise.catch(() => {});
            throw error;
          }
        } else if (columns) {
          blob = await definition.blob(snapshot, visitChunks, columns);
        } else {
          blob = await definition.blob(snapshot, visitChunks);
        }
      }
      download(definition.filename, blob, definition.mime);
    }
    recordOperationDuration(definition.operation, performance.now() - startedAt);
  })().catch((error) => { if (error?.name !== "AbortError") throw error; });
}

async function exportTopologyHtml() {
  const analytics = state.analytics;
  if (!analytics?.dataset || !analytics.current?.id) throw new Error("Сначала рассчитайте аналитику");
  return downloadTextWriterExport("topology.html", "text/html;charset=utf-8", "HTML", (writable) =>
    writeTopologyHtml(analytics.current, (id, visit) => database.forEachSnapshotChunk(id, visit), analytics.dataset.topology.summary, writable));
}

async function exportAnalyticsClustersCsv() {
  const dataset = state.analytics?.dataset;
  if (!dataset) throw new Error("Сначала рассчитайте аналитику");
  const clusters = dataset.clusters || {};
  const fields = clusters.fields || ["vendor", "room", "switchIp"];
  return downloadTextWriterExport("clusters.csv", "text/csv;charset=utf-8", "CSV", (writable) =>
    writeClustersCsv(fields, async (visit) => {
      if (!clusters.queryId) {
        const rows = clusters.items || [];
        await visit(rows.map((row) => ({ value: row.id, count: row.count, data: row })));
        return;
      }
      let after = null;
      while (true) {
        const page = await database.analyticsAggregatePage(clusters.queryId, "cluster", { after, limit: 500 });
        await visit(page.rows);
        if (!page.hasMore) break;
        after = page.nextCursor;
      }
    }, writable));
}

async function exportJsonFile(filename, valueOrFactory) {
  let pickerPromise;
  if (typeof globalThis.showSaveFilePicker === "function") pickerPromise = globalThis.showSaveFilePicker({
    suggestedName: filename,
    types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
  });
  try {
    if (pickerPromise) {
      const handle = await pickerPromise;
      const value = await (typeof valueOrFactory === "function" ? valueOrFactory() : valueOrFactory);
      const writable = await handle.createWritable();
      try {
        await writePrettyJson(value, writable);
        await writable.close();
      } catch (error) {
        if (typeof writable.abort === "function") await writable.abort().catch(() => {});
        throw error;
      }
    } else {
      const value = await (typeof valueOrFactory === "function" ? valueOrFactory() : valueOrFactory);
      if (typeof globalThis.TransformStream === "function") {
        const encoder = new globalThis.TextEncoder();
        const transform = new globalThis.TransformStream({
          transform(chunk, controller) { controller.enqueue(encoder.encode(String(chunk))); },
        });
        const writable = transform.writable.getWriter();
        const blobPromise = new globalThis.Response(transform.readable, { headers: { "Content-Type": "application/json;charset=utf-8" } }).blob();
        try {
          await writePrettyJson(value, writable);
          await writable.close();
          download(filename, await blobPromise, "application/json;charset=utf-8");
        } catch (error) {
          await writable.abort().catch(() => {});
          await blobPromise.catch(() => {});
          throw error;
        }
      } else {
        const chunks = [];
        await writePrettyJson(value, { write: async (chunk) => chunks.push(chunk) });
        download(filename, new Blob(chunks, { type: "application/json;charset=utf-8" }), "application/json;charset=utf-8");
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  }
}

function bindEvents() {
  // Keep error recovery available even if a later UI binding fails during bootstrap.
  bindErrorBannerDismiss($("#errorBanner"));
  const optionalHostDatabaseExport = $("#optionalHostDatabaseExportLink");
  const optionalHostDatabaseExportPath = optionalHostDatabaseExportHref(globalThis.location);
  if (optionalHostDatabaseExport && optionalHostDatabaseExportPath) {
    optionalHostDatabaseExport.href = optionalHostDatabaseExportPath;
    optionalHostDatabaseExport.hidden = false;
    $("#optionalHostDatabaseExportNote").hidden = false;
    $("#optionalHostDatabaseRestoreLabel").hidden = false;
    $("#optionalHostDatabaseRestoreNote").hidden = false;
    $("#optionalHostSnapshotUploadButton").hidden = false;
    $("#optionalHostSnapshotUploadNote").hidden = false;
    $("#optionalHostInventoryUploadButton").hidden = false;
    $("#optionalHostInventoryUploadNote").hidden = false;
    $("#loadOptionalHostSnapshotsButton").hidden = false;
    $("#loadOptionalHostMacHistoryButton").hidden = false;
  }
  globalThis.addEventListener("pagehide", handleAppPageHide);
  renderEngineeringMode();
  $("#engineeringModeButton").addEventListener("click", openEngineeringModeDialog);
  $("#engineeringModeDialog").querySelector("[data-engineering-close]").addEventListener("click", () => $("#engineeringModeDialog").close());
  $("#engineeringModeForm").addEventListener("submit", (event) => submitEngineeringLogin(event).catch(showError));
  $("#vendorInferenceThreshold").addEventListener("input", (event) => { $("#vendorInferenceThresholdLabel").textContent = `${event.currentTarget.value}%`; });
  $("#vendorDetectorEnabled").addEventListener("change", (event) => setVendorDetectorControlsEnabled(event.currentTarget.checked));
  $("#saveVendorInferenceSettingsButton").addEventListener("click", () => saveVendorDetectorSettings().catch(showError));
  $("#saveHistoryEnrichmentSettingsButton").addEventListener("click", () => saveHistoryEnrichmentSettings().catch(showError));
  $("#saveIpEnrichmentSettingsButton").addEventListener("click", () => saveIpEnrichmentSettings().catch(showError));
  $("#analyticsSettingsButton").addEventListener("click", () => {
    selectDashboardSettingsTab(0);
    $("#analyticsDashboardSettingsDialog").showModal();
  });
  const dashboardSettingsTabs = $$("#analyticsDashboardSettingsDialog [role='tab']");
  dashboardSettingsTabs.forEach((tab, index) => tab.addEventListener("click", () => selectDashboardSettingsTab(index)));
  $("#analyticsDashboardSettingsDialog [role='tablist']").addEventListener("keydown", (event) => {
    const currentIndex = dashboardSettingsTabs.indexOf(event.target.closest("[role='tab']"));
    if (currentIndex < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? dashboardSettingsTabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : dashboardSettingsTabs.length - 1)) % dashboardSettingsTabs.length;
    selectDashboardSettingsTab(nextIndex, true);
  });
  $("#analyticsDashboardSettingsDialog").querySelector("[data-dashboard-settings-close]").addEventListener("click", () => $("#analyticsDashboardSettingsDialog").close());
  $("#analyticsDashboardSettingsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    saveAnalyticsDashboardSettings({
      autoRefresh: $("#analyticsAutoRefreshEnabled").checked,
      refreshIntervalSeconds: $("#analyticsRefreshIntervalSeconds").value,
      comparisonMode: state.analyticsDashboardSettings.comparisonMode,
      comparisonDateFrom: state.analyticsDashboardSettings.comparisonDateFrom,
      comparisonDateTo: state.analyticsDashboardSettings.comparisonDateTo,
      filters: state.analyticsDashboardSettings.filters,
      widgets: Object.fromEntries($$("[data-dashboard-widget-setting]").map((input) => [input.dataset.dashboardWidgetSetting, input.checked])),
    }).then(() => $("#analyticsDashboardSettingsDialog").close()).catch(showError);
  });
  $("#resetAnalyticsDashboardSettingsButton").addEventListener("click", () => saveAnalyticsDashboardSettings(DEFAULT_ANALYTICS_DASHBOARD_SETTINGS).catch(showError));
  document.addEventListener("click", (event) => {
    guardEngineeringClick(event, {
      expireSession: expireEngineeringSessionIfNeeded,
      isEngineerActive,
      canAccessView,
    });
  }, true);
  for (const eventName of ["change", "input", "submit"]) {
    document.addEventListener(eventName, (event) => {
      expireEngineeringSessionIfNeeded();
      if (isEngineerActive()) return;
      if (isEngineeringOnlyInputTarget(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (isRestrictedEngineeringViewTarget(event.target, canAccessView)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }
  document.addEventListener("visibilitychange", () => {
    expireEngineeringSessionIfNeeded();
    if (document.visibilityState === "visible") requestFinalAutoSaveIfDue();
  });
  globalThis.addEventListener("focus", expireEngineeringSessionIfNeeded);
  document.addEventListener("keydown", handleGlobalShortcut);
  document.addEventListener("contextmenu", (event) => {
    const row = event.target.closest("[data-device-context-row]");
    if (!row || row.closest("#deviceTable")) return;
    event.preventDefault();
    selectContextTableRow(row);
    const device = contextDeviceFromRow(row);
    const deviceId = device.id || device.mac || device.deviceId || device.serial || device.hostname || "table-device";
    showDeviceContextMenu(deviceId, event.clientX, event.clientY, { device, row });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "F10" || !event.shiftKey) return;
    const row = event.target.closest?.("[data-device-context-row]");
    if (!row || row.closest("#deviceTable")) return;
    event.preventDefault();
    selectContextTableRow(row);
    const device = contextDeviceFromRow(row);
    const deviceId = device.id || device.mac || device.deviceId || device.serial || device.hostname || "table-device";
    showDeviceContextMenu(deviceId, row.getBoundingClientRect().left, row.getBoundingClientRect().bottom, { device, row });
  });
  document.addEventListener("click", (event) => {
    const row = event.target.closest?.("[data-device-context-row]");
    if (row && !row.closest("#deviceTable")) selectContextTableRow(row);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const row = event.target.closest?.("[data-device-context-row]");
    if (!row || row.closest("#deviceTable") || (event.target !== row && event.target.closest("a, button, input, select, textarea"))) return;
    event.preventDefault();
    selectContextTableRow(row);
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-comparison-more]");
    if (button) loadMoreComparison(button);
    const diagnosticPage = event.target.closest("[data-comparison-diagnostic-page]");
    if (diagnosticPage && state.analytics) {
      const analytics = state.analytics;
      const offset = Number(diagnosticPage.dataset.comparisonDiagnosticPage) || 0;
      loadIdentityDiagnosticsMarkup(analytics, offset).then((markup) => {
        const section = diagnosticPage.closest("[data-comparison-diagnostics]");
        if (markup && section && state.analytics === analytics) section.outerHTML = markup;
      }).catch(showError);
    }
    const switchIpChangePage = event.target.closest("[data-switch-ip-change-offset]");
    if (switchIpChangePage && !switchIpChangePage.disabled) {
      const host = switchIpChangePage.closest("[data-switch-ip-change-container]");
      if (host) loadSwitchIpChangeReportPage(host, Number(switchIpChangePage.dataset.switchIpChangeOffset) || 0).catch(showError);
    }
    const modifiedPage = event.target.closest("[data-analytics-modified-page]");
    if (modifiedPage && state.analytics) showAnalyticsModificationPage(
      state.analytics,
      Number(modifiedPage.dataset.analyticsModifiedPage) || 0,
      modifiedPage.dataset.modifiedCodec === "true",
      false,
    ).catch(showError);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest("#deviceContextMenu")) hideDeviceContextMenu();
  });
  $("#deviceContextMenu").addEventListener("click", (event) => {
    const action = event.target.closest("[data-device-action]");
    if (action) runDeviceContextAction(action.dataset.deviceAction, $("#deviceContextMenu").dataset.deviceId).catch(showError);
  });
  $("#deviceContextMenu").addEventListener("keydown", (event) => {
    const items = [...$("#deviceContextMenu").querySelectorAll("[role=menuitem]")];
    const index = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  });
  $("#clearDeviceSelectionButton").addEventListener("click", () => {
    state.selectedDevices.clear();
    renderDeviceTable().catch(showError);
  });
  $$(".nav-button").forEach((button) => button.addEventListener("click", () => activateView(button.dataset.view)));
  $("#themeButton").addEventListener("click", openThemeDialog);
  $("#themeDialog").querySelector("[data-theme-close]").addEventListener("click", () => $("#themeDialog").close());
  $("#themeDialog").querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => selectTheme(button.dataset.themeChoice).catch(showError));
  });
  $("#runDiagnosticsButton").addEventListener("click", () => runSystemDiagnostics());
  $("#refreshPerformanceMetricsButton").addEventListener("click", () => renderPerformanceMetrics().catch(showError));
  $("#refreshLegacyDailyStatisticsButton").addEventListener("click", () => renderImportedDailyStatistics().catch(showError));
  $("#refreshApplicationLogButton").addEventListener("click", () => renderApplicationLog().catch(showError));
  $("#chooseDataDirectoryButton").addEventListener("click", () => chooseDataDirectory().catch(showError));
  $("#dataDirectoryButton").addEventListener("click", () => reauthorizeDataDirectory().catch(showError));
  const inventoryColumnDialog = $("#inventoryColumnManagerDialog");
  const inventoryColumnToggle = $("#toggleInventoryColumnManager");
  inventoryColumnDialog.addEventListener("close", () => inventoryColumnToggle.setAttribute("aria-expanded", "false"));
  inventoryColumnToggle.addEventListener("click", () => {
    if (inventoryColumnDialog.open) inventoryColumnDialog.close();
    else openInventoryColumnManagerDialog(inventoryColumnDialog, $("#inventoryCustomColumnLabel"), inventoryColumnToggle);
  });
  inventoryColumnDialog.querySelector("[data-inventory-columns-close]").addEventListener("click", () => inventoryColumnDialog.close());
  $("#inventoryColumnSettings").addEventListener("change", (event) => {
    const { columnVisible, columnLabel, columnWidth } = event.target.dataset;
    const key = columnVisible || columnLabel || columnWidth;
    if (!key) return;
    const patch = columnVisible ? { visible: event.target.checked }
      : columnLabel ? { label: event.target.value }
        : { width: event.target.value };
    saveInventoryColumnConfig(updateInventoryColumn(state.inventoryColumnConfig, key, patch)).catch(showError);
  });
  $("#inventoryColumnSettings").addEventListener("click", (event) => {
    const removeButton = event.target.closest("[data-column-remove]");
    if (removeButton) {
      saveInventoryColumnConfig(removeCustomInventoryColumn(state.inventoryColumnConfig, removeButton.dataset.columnRemove)).then(() => {
        $("#inventoryColumnStatus").textContent = "Пользовательский столбец удалён. Сохранённые значения в данных устройства остаются без изменений.";
      }).catch(showError);
      return;
    }
    const button = event.target.closest("[data-column-move]");
    if (!button || button.disabled) return;
    saveInventoryColumnConfig(moveInventoryColumn(state.inventoryColumnConfig, button.dataset.columnMove, Number(button.dataset.direction))).catch(showError);
  });
  $("#inventoryCustomColumnForm").addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const config = addCustomInventoryColumn(state.inventoryColumnConfig, $("#inventoryCustomColumnLabel").value);
      saveInventoryColumnConfig(config).then(() => {
        $("#inventoryCustomColumnLabel").value = "";
        $("#inventoryColumnStatus").textContent = "Добавлено пользовательское поле. Значения редактируются в ячейках таблицы.";
      }).catch(showError);
    } catch (error) { showError(error); }
  });
  $("#optimizeInventoryColumnsButton").addEventListener("click", () => optimizeInventoryColumns().catch(showError));
  $("#resetInventoryColumnsButton").addEventListener("click", () => {
    const customColumns = state.inventoryColumnConfig.columns.filter(({ custom }) => custom).map((column) => ({ ...column, visible: false, width: 150 }));
    const config = defaultInventoryColumnConfig();
    config.columns.push(...customColumns);
    saveInventoryColumnConfig(config).then(() => {
      $("#inventoryColumnStatus").textContent = "Настройки сброшены; пользовательские поля сохранены скрытыми.";
    }).catch(showError);
  });
  let searchTimer = 0;
  $("#globalSearch").addEventListener("input", (event) => {
    if (state.search !== event.target.value) state.selectedDevices.clear();
    state.search = event.target.value;
    state.page = 1;
    scheduleWorkspaceStateSave();
    globalThis.clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderDeviceTable().catch(showError), 180);
  });
  $("#pageSizeSelect").addEventListener("change", (event) => { state.pageSize = Number(event.target.value); state.page = 1; scheduleWorkspaceStateSave(); renderDeviceTable().catch(showError); });
  $("#previousPageButton").addEventListener("click", () => { state.page -= 1; scheduleWorkspaceStateSave(); renderDeviceTable().catch(showError); });
  $("#nextPageButton").addEventListener("click", () => { state.page += 1; scheduleWorkspaceStateSave(); renderDeviceTable().catch(showError); });
  $("#exportSearchCsvButton").addEventListener("click", () => exportSearchCsv().catch(showError));
  $("#mac5ModelForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const prefix = $("#mac5ModelPrefix").value;
      const model = $("#mac5ModelName").value;
      await database.saveMac5Model(prefix, model);
      await synchronizeDataDirectoryArchive();
      $("#mac5ModelPrefix").value = "";
      $("#mac5ModelName").value = "";
      $("#mac5ModelRuleFilter [name='query']").value = "";
      state.mac5Rules.query = "";
      state.mac5Rules.cursor = null;
      state.mac5Rules.previous = [];
      await renderMac5RuleList();
      finishProgress("Правило модели сохранено");
    } catch (error) { showError(error); }
  });
  $("#modelPrefixSearchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    openModelPrefixAnalytics($("#modelPrefixSearch").value).catch(showError);
  });
  $("#mac5ModelRuleFilter").addEventListener("submit", (event) => {
    event.preventDefault();
    state.mac5Rules.query = $("#mac5ModelRuleFilter [name='query']").value;
    state.mac5Rules.cursor = null;
    state.mac5Rules.previous = [];
    renderMac5RuleList().catch(showError);
  });
  $("#mac5ModelRuleClear").addEventListener("click", () => {
    $("#mac5ModelRuleFilter [name='query']").value = "";
    state.mac5Rules.query = "";
    state.mac5Rules.cursor = null;
    state.mac5Rules.previous = [];
    renderMac5RuleList().catch(showError);
  });
  $("#mac5ModelRuleNext").addEventListener("click", () => {
    const next = state.mac5Rules.page?.nextCursor;
    if (!next) return;
    state.mac5Rules.previous.push(state.mac5Rules.cursor);
    state.mac5Rules.cursor = next;
    renderMac5RuleList().catch(showError);
  });
  $("#mac5ModelRulePrevious").addEventListener("click", () => {
    if (!state.mac5Rules.previous.length) return;
    state.mac5Rules.cursor = state.mac5Rules.previous.pop();
    renderMac5RuleList().catch(showError);
  });

  for (const role of ["main", "smartroom", "ddio"]) {
    $(`#${role}FileInput`).addEventListener("change", (event) => {
      const file = event.target.files[0];
      event.target.value = "";
      handleSourceFile(role, file).catch(showError);
    });
    bindSourceFileDrop($(`[data-source-file-drop="${role}"]`), $(`#${role}FileStatus`), (file) => handleSourceFile(role, file).catch(showError));
  }
  document.querySelectorAll("[data-workspace-source-handle]").forEach((button) => {
    button.addEventListener("click", () => activateWorkspaceSourceHandle(button.dataset.workspaceSourceHandle).catch(showError));
  });
  $("#legacyWorkspaceSourceSelect").addEventListener("change", (event) => {
    const summary = state.legacyWorkspaceSources[Number(event.target.value)];
    const role = legacyWorkspaceSourceRole(summary?.role);
    $("#legacyWorkspaceRestoreRolePicker").hidden = summary?.role !== "additional";
    $("#legacyWorkspaceRestoreRoleSelect").value = "";
    const rowCount = summary?.id.startsWith("pyqt-settings-") ? "число строк не сохранено" : `${summary?.rowCount.toLocaleString("ru-RU")} строк`;
    $("#legacyWorkspaceSourceStatus").textContent = summary
      ? `Сводка ${summary.name || "без имени"}${role ? ` · ${role.toUpperCase()}` : ""} · ${rowCount}.${summary.role === "additional" ? " Выберите роль файла." : " Теперь укажите исходный файл."}`
      : "";
  });
  $("#legacyWorkspaceSourceInput").addEventListener("change", (event) => {
    restoreLegacyWorkspaceSource($("#legacyWorkspaceSourceSelect").value, event.target.files[0], $("#legacyWorkspaceRestoreRoleSelect").value).catch((error) => {
      $("#legacyWorkspaceSourceStatus").textContent = "Файл не восстановлен. Подробности доступны в сообщении об ошибке.";
      showError(error);
    }).finally(() => { event.target.value = ""; });
  });
  $("#legacyWorkspaceSourceInput").closest("label").addEventListener("click", (event) => {
    const summary = state.legacyWorkspaceSources[Number($("#legacyWorkspaceSourceSelect").value)];
    if (summary?.role === "additional" && !$("#legacyWorkspaceRestoreRoleSelect").value) {
      event.preventDefault();
      $("#legacyWorkspaceSourceStatus").textContent = "Сначала назначьте дополнительному файлу роль Main, SmartRoom или DDIO.";
    }
  });
  $("#singleFileInput").addEventListener("change", (event) => handleSingleFile(event.target.files[0]).catch(showError));
  $("#singleSheetSelect").addEventListener("change", (event) => handleSingleFile(state.singleFile.file, event.target.value).catch(showError));
  $("#runSingleAnalysisButton").addEventListener("click", () => runSingleFileAnalysis().catch((error) => {
    if (error?.name === "AbortError") return;
    $("#runSingleAnalysisButton").disabled = false;
    showError(error);
  }));
  $("#exportSingleCsvButton").addEventListener("click", () => {
    clearError();
    exportSingleAnalysisCsv().catch((error) => { if (error?.name !== "AbortError") showError(error); });
  });
  $("#exportSingleJsonButton").addEventListener("click", () => {
    clearError();
    if (!state.singleFile.result) return showError(new Error("Сначала запустите анализ"));
    exportJsonFile("single-file-analysis.json", () => singleAnalysisJsonPayload(state.singleFile.result)).catch(showError);
  });
  $("#toggleSingleAnalysisHistoryButton").addEventListener("click", () => {
    const panel = $("#singleAnalysisHistory");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderSingleAnalysisHistory().catch(showError);
  });
  $("#singleAnalysisHistoryForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.singleAnalysisHistory.query = $("#singleAnalysisHistoryQuery").value;
    state.singleAnalysisHistory.page = 1;
    renderSingleAnalysisHistory().catch(showError);
  });
  $("#previousSingleAnalysisHistoryPage").addEventListener("click", () => {
    state.singleAnalysisHistory.page = Math.max(1, state.singleAnalysisHistory.page - 1);
    renderSingleAnalysisHistory().catch(showError);
  });
  $("#nextSingleAnalysisHistoryPage").addEventListener("click", () => {
    state.singleAnalysisHistory.page += 1;
    renderSingleAnalysisHistory().catch(showError);
  });
  $("#singleAnalysisHistoryRows").addEventListener("click", (event) => {
    const open = event.target.closest("[data-single-analysis-open]");
    const remove = event.target.closest("[data-single-analysis-delete]");
    if (open) openSingleAnalysisHistory(open.dataset.singleAnalysisOpen).catch(showError);
    else if (remove) deleteSingleAnalysisHistory(remove.dataset.singleAnalysisDelete).catch(showError);
  });
  for (const position of [0, 1]) $(`#compareFile${position}Input`).addEventListener("change", (event) => handleCompareFile(position, event.target.files[0]).catch(showError));
  $("#runFileCompareButton").addEventListener("click", () => runFileCompare().catch((error) => {
    if (error?.name === "AbortError") return;
    $("#runFileCompareButton").disabled = false;
    showError(error);
  }));
  $("#exportFileCompareCsvButton").addEventListener("click", async () => {
    clearError();
    const analysis = state.fileCompare.result;
    if (!analysis) return showError(new Error("Сначала выполните сравнение"));
    try {
      const filename = "file-comparison.csv";
      let pickerPromise;
      if (typeof globalThis.showSaveFilePicker === "function") pickerPromise = globalThis.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
      });
      const csvChunks = fileComparisonCsvChunksFromPlan(requireFileComparisonPlan(analysis), state.ouiFormats);
      const stream = streamFromAsyncIterable(csvChunks);
      if (pickerPromise) {
        const handle = await pickerPromise;
        await writeReadableStreamToWritable(stream, await handle.createWritable());
      } else {
        const blob = await new globalThis.Response(stream).blob();
        download(filename, blob, "text/csv;charset=utf-8");
      }
    } catch (error) { if (error?.name !== "AbortError") showError(error); }
  });
  $("#exportFileCompareJsonButton").addEventListener("click", async () => {
    clearError();
    const analysis = state.fileCompare.result;
    if (!analysis) return showError(new Error("Сначала выполните сравнение"));
    const revision = state.fileCompare.revision;
    const controller = new AbortController();
    state.fileCompare.controller?.abort();
    state.fileCompare.controller = controller;
    $("#exportFileCompareJsonButton").disabled = true;
    try {
      progress(2, "Подготовка потокового JSON", "Экспорт сравнения файлов");
      await exportJsonFile("file-comparison.json", () => fileComparisonJsonFromPlan(requireFileComparisonPlan(analysis), { signal: controller.signal }));
      if (revision === state.fileCompare.revision) finishProgress("Экспорт JSON завершён");
    } catch (error) {
      if (error?.name === "AbortError") {
        if (revision === state.fileCompare.revision) finishProgress("Экспорт JSON отменён");
      } else showError(error);
    } finally {
      if (state.fileCompare.controller === controller) state.fileCompare.controller = null;
      if (revision === state.fileCompare.revision) $("#exportFileCompareJsonButton").disabled = !state.fileCompare.result;
    }
  });
  $("#exportFileCompareXlsxButton").addEventListener("click", async () => {
    clearError();
    const analysis = state.fileCompare.result;
    if (!analysis) return showError(new Error("Сначала выполните сравнение"));
    try {
      const filename = "file-comparison.xlsx";
      let pickerPromise;
      if (typeof globalThis.showSaveFilePicker === "function") pickerPromise = globalThis.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "Excel", accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] } }],
      });
      const workbook = createXlsxWorkbookStream([{ name: "Сравнение", headings: fileComparisonColumns(state.ouiFormats).map(({ label }) => label), rows: fileComparisonXlsxRows(analysis) }]);
      if (pickerPromise) await writeReadableStreamToWritable(workbook, await (await pickerPromise).createWritable());
      else download(filename, await new globalThis.Response(workbook).blob(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    } catch (error) { showError(error); }
  });
  $("#exportFileCompareTxtButton").addEventListener("click", async () => {
    clearError();
    const analysis = state.fileCompare.result;
    if (!analysis) return showError(new Error("Сначала выполните сравнение"));
    try {
      const filename = "file-comparison.txt";
      let pickerPromise;
      if (typeof globalThis.showSaveFilePicker === "function") pickerPromise = globalThis.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "TXT", accept: { "text/plain": [".txt"] } }],
      });
      const stream = streamFromAsyncIterable(fileComparisonTxtChunks(analysis));
      if (pickerPromise) await writeReadableStreamToWritable(stream, await (await pickerPromise).createWritable());
      else download(filename, await new globalThis.Response(stream).blob(), "text/plain;charset=utf-8");
    } catch (error) { showError(error); }
  });
  $("#fileCompareResult").addEventListener("click", (event) => {
    const button = event.target.closest("[data-file-comparison-page]");
    if (!button || !state.fileCompare.result) return;
    const pageKey = button.dataset.fileComparisonPage === "ambiguous" ? "ambiguousPage" : "page";
    state.fileCompare[pageKey] = Math.max(1, Number(button.dataset.page) || 1);
    button.disabled = true;
    renderFileCompareResult(state.fileCompare.result).catch(showError);
  });
  $("#fileCompareResult").addEventListener("change", (event) => {
    if (!event.target.matches("[data-file-comparison-page-size]") || !state.fileCompare.result) return;
    const pageSize = Number(event.target.value);
    if (!FILE_COMPARE_PAGE_SIZES.includes(pageSize)) return;
    state.fileCompare.pageSize = pageSize;
    state.fileCompare.page = 1;
    state.fileCompare.ambiguousPage = 1;
    renderFileCompareResult(state.fileCompare.result).catch(showError);
  });
  $("#multiCompareFilesInput").addEventListener("change", (event) => {
    handleMultiCompareFiles(event.target.files).catch(showError);
    event.target.value = "";
  });
  $("#multiCompareResult").addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-multi-compare-page]");
    if (!button || !state.multiCompare.currentResult) return;
    const requestedPage = Math.floor(Number(button.dataset.multiComparePage) || 1);
    state.multiCompare.page = Math.max(1, requestedPage);
    renderMultiCompareResult(state.multiCompare.currentResult).catch(showError);
  });
  $("#multiCompareResult").addEventListener("change", (event) => {
    if (!event.target.matches("[data-multi-compare-page-size]") || !state.multiCompare.currentResult) return;
    const pageSize = Number(event.target.value);
    if (!MULTI_COMPARE_PAGE_SIZES.includes(pageSize)) return;
    state.multiCompare.pageSize = pageSize;
    state.multiCompare.page = 1;
    renderMultiCompareResult(state.multiCompare.currentResult).catch(showError);
  });
  $("#clearMultiCompareButton").addEventListener("click", () => {
    clearCurrentMultiCompareResult().catch(showError);
    state.multiCompare = { files: [], pairs: [], currentResult: null, page: 1, pageSize: 100 };
    $("#multiCompareFilesInput").value = "";
    renderMultiCompareState();
  });
  $("#runMultiCompareButton").addEventListener("click", () => runMultiCompareSelected().catch(showError));
  $("#exportAllMultiCompareButton").addEventListener("click", () => exportAllMultiComparePairs().catch((error) => { if (error?.name !== "AbortError") showError(error); }));
  $("#exportAllMultiCompareCsvButton").addEventListener("click", () => exportAllMultiComparePairsCsv().catch(showError));
  $("#multiComparePairSelect").addEventListener("change", () => {
    clearCurrentMultiCompareResult().catch(showError);
    state.multiCompare.page = 1;
    $("#multiCompareResult").classList.add("empty");
    $("#multiCompareResult").textContent = "Выбрана другая пара. Нажмите «Рассчитать пару».";
  });
  ["multiFieldMac", "multiFieldOui", "multiFieldVendor", "multiFieldModel", "multiFieldIp", "multiFieldAddress", "multiFieldRoom"].forEach((id) => $(`#${id}`).addEventListener("change", () => {
    clearCurrentMultiCompareResult().catch(showError);
    state.multiCompare.page = 1;
    $("#multiCompareResult").classList.add("empty");
    $("#multiCompareResult").textContent = "Поля сравнения изменены. Рассчитайте пару повторно.";
  }));
  $("#runEnrichmentButton").addEventListener("click", () => runEnrichment().catch(showError));
  $("#queueCurrentSourceFilesButton").addEventListener("click", () => queueCurrentSourceFiles().catch(showError));
  $("#resetFilesButton").addEventListener("click", () => resetFiles().catch(showError));
  $("#cancelProcessButton").addEventListener("click", cancelActiveProcess);

  $("#refreshAnalyticsButton").addEventListener("click", () => renderAnalytics(true).catch((error) => showAnalyticsFallback(error, state.analytics)));
  $("#runDataQualityButton").addEventListener("click", () => runDataQualityAnalysis().catch(showError));
  $("#dataQualityHistoryPreviousButton").addEventListener("click", () => renderDataQualityHistory(Math.max(0, state.dataQualityHistoryOffset - 20)).catch(showError));
  $("#dataQualityHistoryNextButton").addEventListener("click", () => renderDataQualityHistory(state.dataQualityHistoryOffset + 20).catch(showError));
  $("#exportAnalyticsPngButton").addEventListener("click", () => exportAnalyticsDashboardPng().catch(showError));
  $("#exportAnalyticsXlsxButton").addEventListener("click", () => exportAnalyticsDashboardXlsx().catch((error) => { if (error?.name !== "AbortError") showError(error); }));
  $("#exportAnalyticsHtmlButton").addEventListener("click", () => exportAnalyticsDashboardHtml().catch((error) => { if (error?.name !== "AbortError") showError(error); }));
  $("#refreshTemporalButton").addEventListener("click", () => renderTemporalStatistics(true).catch(showError));
  $("#temporalPeriodSelect").addEventListener("change", () => { state.temporalStatistics = null; renderTemporalStatistics().catch(showError); });
  $("#temporalRangeSelect").addEventListener("change", () => { state.temporalStatistics = null; renderTemporalStatistics().catch(showError); });
  $("#exportTemporalCsvButton").addEventListener("click", () => {
    if (!state.temporalStatistics) return showError(new Error("Сначала рассчитайте временную статистику"));
    const filename = "temporal-statistics.csv";
    const mime = "text/csv;charset=utf-8";
    const stream = readableTextStreamFromIterable((function* () {
      yield "\uFEFF";
      yield* temporalStatisticsCsvChunks(state.temporalStatistics);
    })());
    let pickerPromise;
    if (typeof globalThis.showSaveFilePicker === "function") pickerPromise = globalThis.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
    });
    if (pickerPromise) {
      (async () => {
        const handle = await pickerPromise;
        await writeReadableStreamToWritable(stream, await handle.createWritable());
      })().catch((error) => { if (error?.name !== "AbortError") showError(error); });
      return;
    }
    new globalThis.Response(stream, { headers: { "Content-Type": mime } }).blob()
      .then((blob) => download(filename, blob, mime))
      .catch(showError);
  });
$("#dashboardComparisonMode").addEventListener("change", syncDashboardComparisonControls);
  $("#applyAnalyticsDashboardFiltersButton").addEventListener("click", () => {
    saveAnalyticsDashboardSettings({ ...state.analyticsDashboardSettings, filters: dashboardFilterSettingsFromControls() })
      .then(() => renderAnalytics(true)).catch((error) => showAnalyticsFallback(error, state.analytics));
  });
  $("#resetAnalyticsDashboardFiltersButton").addEventListener("click", () => {
    saveAnalyticsDashboardSettings({ ...state.analyticsDashboardSettings, filters: { query: "", manufacturer: "", room: "", status: "all" } })
      .then(() => renderAnalytics(true)).catch((error) => showAnalyticsFallback(error, state.analytics));
  });
  $("#applyChangeSnapshotButton").addEventListener("click", () => {
    $("#baseSnapshotSelect").value = $("#changeReportBaseSnapshotSelect").value;
    $("#currentSnapshotSelect").value = $("#changeReportCurrentSnapshotSelect").value;
    saveAnalyticsDashboardSettings({ ...state.analyticsDashboardSettings, comparisonMode: "snapshots" })
      .then(() => renderAnalytics(true)).catch((error) => showAnalyticsFallback(error, state.analytics));
  });
  $("#applyDashboardPeriodButton").addEventListener("click", () => {
    saveAnalyticsDashboardSettings({ ...state.analyticsDashboardSettings, comparisonMode: "period", comparisonDateFrom: $("#dashboardComparisonDateFrom").value, comparisonDateTo: $("#dashboardComparisonDateTo").value })
      .then(() => renderAnalytics(true)).catch((error) => showAnalyticsFallback(error, state.analytics));
  });
  $("#applyComparisonButton").addEventListener("click", () => {
    saveAnalyticsDashboardSettings({ ...state.analyticsDashboardSettings, comparisonMode: "snapshots" })
      .then(() => renderAnalytics(true)).catch((error) => showAnalyticsFallback(error, state.analytics));
  });
  $("#exportClustersButton").addEventListener("click", () => exportAnalyticsClustersCsv().catch((error) => { if (error?.name !== "AbortError") showError(error); }));
  $("#exportTopologyButton").addEventListener("click", () => exportTopologyHtml().catch((error) => { if (error?.name !== "AbortError") showError(error); }));
  $("#exportAnalyticsSvgButton").addEventListener("click", () => {
    if (!state.analytics?.dataset) return showError(new Error("Сначала рассчитайте аналитику"));
    download("analytics.svg", chartsSvg(state.analytics.dataset), "image/svg+xml;charset=utf-8");
  });
  $("#exportAnalyticsReportButton").addEventListener("click", () => {
    if (!state.analytics?.dataset?.summary.devices) return showError(new Error("Сначала рассчитайте аналитику полного Final"));
    download(`analytics_report_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.txt`, state.analytics.dataset.reportText, "text/plain;charset=utf-8");
  });
  $("#openMacHistoryButton").addEventListener("click", () => openMacHistory().catch(showError));
  $("#loadOptionalHostMacHistoryButton").addEventListener("click", () => openMacHistory({ includeOptionalHostHistory: true }).catch(showError));
  $("#changeTable").addEventListener("click", (event) => {
    const statusRosterPage = event.target.closest("[data-status-roster-page]");
    if (statusRosterPage && !statusRosterPage.disabled) return renderAnalyticsStatusRoster(state.analytics, statusRosterPage.dataset.statusRosterPage, Number(statusRosterPage.dataset.pageOffset) || 0).catch(showError);
    const unchangedPage = event.target.closest("[data-unchanged-page]");
    if (unchangedPage && !unchangedPage.disabled) return renderAnalyticsUnchangedPage(state.analytics, Number(unchangedPage.dataset.unchangedPage) || 0).catch(showError);
    const modifiedDevicePage = event.target.closest("[data-modified-device-page]");
    if (modifiedDevicePage && !modifiedDevicePage.disabled) return renderAnalyticsModifiedDevicePage(state.analytics, Number(modifiedDevicePage.dataset.modifiedDevicePage) || 0).catch(showError);
    const tab = event.target.closest("[data-change-category]");
    if (tab) return renderAnalyticsChangeCategories(state.analytics?.comparison, tab.dataset.changeCategory, 0)?.catch(showError);
    const periodPage = event.target.closest("[data-period-change-page]");
    if (periodPage && !periodPage.disabled) {
      const page = state.periodChangePage;
      if (periodPage.dataset.periodChangePage === "next" && page.page?.nextCursor) {
        page.previous.push(page.cursor);
        page.cursor = page.page.nextCursor;
      } else if (periodPage.dataset.periodChangePage === "previous" && page.previous.length) {
        page.cursor = page.previous.pop();
      }
      renderPeriodChangeCategory(page.category).catch(showError);
      return;
    }
    const page = event.target.closest("[data-change-page]");
    if (page && !page.disabled) renderAnalyticsChangeCategories(state.analytics?.comparison, state.comparisonChangeCategory, Number(page.dataset.changePage))?.catch(showError);
  });
  $("#changeTable").addEventListener("keydown", (event) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const active = event.target.closest("[data-change-category]");
    if (!active) return;
    event.preventDefault();
    const index = CHANGE_CATEGORIES.indexOf(active.dataset.changeCategory);
    const next = event.key === "Home" ? 0 : event.key === "End" ? CHANGE_CATEGORIES.length - 1
      : (index + (event.key === "ArrowRight" ? 1 : CHANGE_CATEGORIES.length - 1)) % CHANGE_CATEGORIES.length;
    renderAnalyticsChangeCategories(state.analytics?.comparison, CHANGE_CATEGORIES[next], 0)?.catch(showError);
    $("#changeTable [data-change-category]")?.focus();
  });
  $("#changeReportModeSelect").addEventListener("change", async (event) => {
    let settings = normalizeChangeReportSettings({ ...state.changeReportSettings, mode: event.target.value });
    if (settings.mode === "period" && (!settings.from || !settings.to)) settings = { ...settings, ...defaultChangeReportRange() };
    state.periodChangeSummary = null;
    state.periodChangePage = { category: "all", cursor: null, previous: [], page: null, requestId: state.periodChangePage.requestId + 1 };
    try {
      await saveChangeReportSettings(settings);
      if (state.analytics) renderAnalyticsChangeCategories(state.analytics.comparison, state.comparisonChangeCategory, 0)?.catch(showError);
    } catch (error) { showError(error); }
  });
  $("#applyChangeReportButton").addEventListener("click", async () => {
    const settings = normalizeChangeReportSettings({ mode: "period", from: $("#changeReportFrom").value, to: $("#changeReportTo").value });
    if (!settings.from || !settings.to) return showError(new Error("Выберите обе даты периода"));
    if (settings.from > settings.to) return showError(new Error("Начальная дата позже конечной"));
    state.periodChangeSummary = null;
    state.periodChangePage = { category: "all", cursor: null, previous: [], page: null, requestId: state.periodChangePage.requestId + 1 };
    try {
      await saveChangeReportSettings(settings);
      if (state.analytics) renderAnalyticsChangeCategories(state.analytics.comparison, state.comparisonChangeCategory, 0)?.catch(showError);
    } catch (error) { showError(error); }
  });
  $("#macHistorySearch").addEventListener("input", (event) => {
    globalThis.clearTimeout(macHistoryOptionsTimer);
    const query = event.currentTarget.value;
    if (query.replace(/[^0-9a-f]/gi, "").length < 2) {
      macHistoryOptionsRequest += 1;
      $("#macHistoryOptions").replaceChildren();
      return;
    }
    macHistoryOptionsTimer = globalThis.setTimeout(() => renderMacOptions(query).catch(showError), 120);
  });
  $("#macHistorySearch").addEventListener("keydown", (event) => { if (event.key === "Enter") openMacHistory().catch(showError); });
  $("#historyLogFilters").addEventListener("submit", (event) => { event.preventDefault(); searchHistoryLog().catch(showError); });
  $("#buildHistoryDateSummaryButton").addEventListener("click", () => buildHistoryDateSummary().catch(showError));
  $("#exportHistoryDateRangeButton").addEventListener("click", () => exportHistoryDateRange().catch((error) => { if (error?.name !== "AbortError") showError(error); }));
  $("#historyDateSummaryNextButton").addEventListener("click", () => buildHistoryDateSummary({ after: state.historyDateSummary.cursor, append: true }).catch(showError));
  $("#legacyObservationFilters").addEventListener("submit", (event) => { event.preventDefault(); searchLegacyObservations().catch(showError); });
  $("#legacyTaskCreateForm").addEventListener("submit", (event) => createLegacyTaskFromForm(event).catch(showError));
  $("#legacyTaskQueueFilePicker").addEventListener("change", (event) => appendLegacyFilesFromPicker(event).catch(showError));
  $("#showImportedApiCacheButton").addEventListener("click", () => showImportedApiCache().catch(showError));
  $("#legacyObservationNextButton").addEventListener("click", () => nextLegacyObservationPage()?.catch(showError));
  $("#legacyObservationPreviousButton").addEventListener("click", () => previousLegacyObservationPage()?.catch(showError));
  $("#legacyObservationResults").addEventListener("click", (event) => {
    const runButton = event.target.closest("[data-run-legacy-task]");
    if (runButton) runLegacyScheduledTask(runButton.dataset.runLegacyTask, runButton).catch(showError);
    const toggleButton = event.target.closest("[data-toggle-legacy-task]");
    if (toggleButton) toggleLegacyScheduledTask(toggleButton.dataset.toggleLegacyTask, toggleButton).catch(showError);
    const addFilesButton = event.target.closest("[data-add-legacy-task-files]");
    if (addFilesButton) {
      state.legacyObservationLog.queueTaskId = addFilesButton.dataset.addLegacyTaskFiles || "";
      $("#legacyTaskQueueFilePicker").click();
    }
    const button = event.target.closest("[data-download-legacy-task-file]");
    if (button) downloadLegacyTaskFile(button.dataset.downloadLegacyTaskFile, button).catch(showError);
  });
  $("#legacyObservationResults").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-legacy-observation-select]");
    if (!checkbox) return;
    if (checkbox.checked) state.legacyObservationLog.selectedIds.add(checkbox.dataset.legacyObservationSelect);
    else state.legacyObservationLog.selectedIds.delete(checkbox.dataset.legacyObservationSelect);
    const current = state.legacyObservationLog;
    const selected = current.selectedIds.size;
    const kinds = Object.entries(current.page?.byKind || {}).map(([kind, count]) => `${kind}: ${count.toLocaleString("ru-RU")}`).join(" · ");
    const summary = current.page?.summary || {};
    const distinct = `MAC: ${Number(summary.uniqueMacs || 0).toLocaleString("ru-RU")} · производителей: ${Number(summary.vendors || 0).toLocaleString("ru-RU")} · моделей: ${Number(summary.models || 0).toLocaleString("ru-RU")} · помещений: ${Number(summary.rooms || 0).toLocaleString("ru-RU")} · источников: ${Number(summary.sources || 0).toLocaleString("ru-RU")}`;
    $("#legacyObservationStatus").textContent = `${Number(current.page?.total || 0).toLocaleString("ru-RU")} записей · страница ${current.previous.length + 1} · показано ${current.page?.rows.length || 0} · отмечено ${selected.toLocaleString("ru-RU")} · ${kinds} · ${distinct}`;
    $("#deleteLegacyObservationsButton").disabled = selected === 0;
  });
  $("#deleteLegacyObservationsButton").addEventListener("click", () => deleteSelectedLegacyObservations().catch(showError));
  $("#deleteFilteredLegacyObservationsButton").addEventListener("click", () => deleteFilteredLegacyObservations().catch(showError));
  $("#historyLogNextButton").addEventListener("click", () => nextHistoryLogPage()?.catch(showError));
  $("#historyLogPreviousButton").addEventListener("click", () => previousHistoryLogPage()?.catch(showError));
  $("#snapshotHistoryFilters").addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new globalThis.FormData(event.currentTarget).entries());
    searchUploadHistory(values).catch(showError);
  });
  $("#snapshotHistoryPreviousButton").addEventListener("click", () => {
    state.uploadHistory.page = Math.max(1, state.uploadHistory.page - 1);
    renderSnapshotList();
  });
  $("#snapshotHistoryNextButton").addEventListener("click", () => {
    state.uploadHistory.page += 1;
    renderSnapshotList();
  });
  $("#snapshotList").addEventListener("click", (event) => {
    const restoreButton = event.target.closest("[data-restore-originals]");
    if (restoreButton) {
      restoreOriginalSources(restoreButton.dataset.restoreOriginals, restoreButton).catch(showError);
      return;
    }
    const originalButton = event.target.closest("[data-download-original]");
    if (originalButton) {
      downloadOriginalSource(originalButton.dataset.downloadOriginal, originalButton.dataset.originalRole, originalButton).catch(showError);
      return;
    }
    const button = event.target.closest("[data-open-final]");
    if (button) openFinalSnapshotPage(button.dataset.openFinal).catch(showError);
  });
  $("#snapshotList").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-select-final]");
    if (!checkbox) return;
    if (checkbox.checked) state.uploadHistory.selectedIds.add(checkbox.dataset.selectFinal);
    else state.uploadHistory.selectedIds.delete(checkbox.dataset.selectFinal);
    renderSnapshotList();
  });
  $("#deleteSelectedFinalsButton").addEventListener("click", () => deleteSelectedFinals().catch(showError));
  $("#clearFinalHistoryButton").addEventListener("click", () => clearFinalHistory().catch(showError));
  $("#rebuildVendorModelHistoryButton").addEventListener("click", () => rebuildVendorModelHistory());
  $("#deleteImportedHistoryLoadsButton").addEventListener("click", () => deleteImportedHistoryLoads().catch(showError));
  $("#learnVendorModelButton").addEventListener("click", () => learnVendorModelRules());
  $("#exportVendorModelHistoryButton").addEventListener("click", exportVendorModelHistory);
  $("#vendorModelHistoryTable").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-imported-history-load]");
    if (button) deleteImportedHistoryLoad(button.dataset.deleteImportedHistoryLoad).catch(showError);
  });
  $("#vendorModelHistoryFilters").addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new globalThis.FormData(event.currentTarget));
    state.vendorModelHistory.kind = ["models", "loads"].includes(values.kind) ? values.kind : "vendors";
    state.vendorModelHistory.query = values.query || "";
    state.vendorModelHistory.page = 1;
    renderVendorModelHistory();
  });
  $("#vendorModelHistoryPreviousButton").addEventListener("click", () => {
    state.vendorModelHistory.page = Math.max(1, state.vendorModelHistory.page - 1);
    renderVendorModelHistory();
  });
  $("#vendorModelHistoryNextButton").addEventListener("click", () => {
    state.vendorModelHistory.page += 1;
    renderVendorModelHistory();
  });
  $("#historyLogColumns").addEventListener("change", (event) => {
    if (event.target.matches("[data-history-log-column]")) saveHistoryLogColumns().catch(showError);
    else if (event.target.matches("[data-history-log-width]")) saveHistoryLogColumnWidths().catch(showError);
  });
  $("#historyLogColumns").addEventListener("click", (event) => {
    if (event.target.closest("[data-history-log-width-optimize]")) optimizeHistoryLogColumnWidths().catch((error) => { if (error?.name !== "AbortError") showError(error); });
    else if (event.target.closest("[data-history-log-width-reset]")) resetHistoryLogColumnWidths().catch(showError);
  });
  $("#collapseHistoryLogGroupsButton").addEventListener("click", () => setHistoryLogGroupsOpen($("#historyLogResults"), false));
  $("#expandHistoryLogGroupsButton").addEventListener("click", () => setHistoryLogGroupsOpen($("#historyLogResults"), true));
  $("#historyLogResults").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-history-event-select]");
    if (!checkbox) return;
    if (checkbox.checked) state.historyLog.selectedIds.add(checkbox.dataset.historyEventSelect);
    else state.historyLog.selectedIds.delete(checkbox.dataset.historyEventSelect);
    const selected = state.historyLog.selectedIds.size;
    $("#historyLogStatus").textContent = `${state.historyLog.page.total.toLocaleString("ru-RU")} событий · страница ${state.historyLog.previous.length + 1} · показано ${state.historyLog.page.rows.length.toLocaleString("ru-RU")} · отмечено ${selected.toLocaleString("ru-RU")}`;
    $("#deleteHistoryEventsButton").disabled = selected === 0;
  });
  $("#historyLogResults").addEventListener("dblclick", (event) => {
    if (event.target.closest("input, button, a, summary")) return;
    const row = event.target.closest("[data-history-event-row]");
    if (!row) return;
    $("#macHistorySearch").value = row.dataset.historyEventMac || "";
    openMacHistory().catch(showError);
  });
  $("#deleteHistoryEventsButton").addEventListener("click", () => deleteSelectedHistoryEvents().catch(showError));
  $("#deleteFilteredHistoryEventsButton").addEventListener("click", () => deleteFilteredHistoryEvents().catch(showError));

  ["businessUnit", "city", "site", "floor", "room"].forEach((field) => $(`#${field === "businessUnit" ? "businessUnit" : field}Filter`).addEventListener("change", () => cascadeRoomFilters(field)));
  $("#showRoomButton").addEventListener("click", () => showRoomTimeline().catch(showError));
  $("#compareRoomFinalsButton").addEventListener("click", () => compareLatestRoomFinals().catch(showError));
  $("#showAllChangedRoomButton").addEventListener("click", () => showAllChangedRooms().catch(showError));
  $("#roomTimeline").addEventListener("click", (event) => {
    const button = event.target.closest("[data-room-timeline-snapshot]");
    if (!button) return;
    const snapshotId = button.dataset.roomTimelineSnapshot;
    const section = button.dataset.roomTimelineSection;
    if (!snapshotId || !["roster", "changes", "added", "absent"].includes(section)) return;
    button.disabled = true;
    updateRoomTimelinePage(snapshotId, section, Number(button.dataset.page) || 1).catch(showError);
  });
  $("#roomFinalComparison").addEventListener("click", (event) => {
    const button = event.target.closest("[data-room-pair-page]");
    if (!button || !state.roomPair) return;
    state.roomPairPage = Number(button.dataset.page) || 1;
    button.disabled = true;
    renderRoomPairComparison().catch(showError);
  });

  for (const role of ["Main", "Smartroom", "DdIo"]) {
    $(`#batch${role}Input`).addEventListener("change", (event) => {
      const key = role === "Main" ? "main" : role === "Smartroom" ? "smartroom" : "ddio";
      const files = event.target.files;
      event.target.value = "";
      handleBatchFileSelection(key, files).catch(showError);
    });
    const key = role === "Main" ? "main" : role === "Smartroom" ? "smartroom" : "ddio";
    bindSourceFilesDrop($(`[data-batch-file-drop="${key}"]`), $(`#batch${role}Status`), (files) => handleBatchFileSelection(key, files, { append: true }).catch(showError));
  }
  document.querySelectorAll("[data-batch-directory-handle]").forEach((button) => {
    button.addEventListener("click", () => activateWorkspaceBatchDirectory(button.dataset.batchDirectoryHandle).catch(showError));
  });
  $("#previewBatchButton").addEventListener("click", () => pairBatchFiles().catch(showError));
  $("#runBatchButton").addEventListener("click", () => {
    clearError();
    scheduledBatchQueue.enqueue(() => runBatch()).catch(showError);
  });
  $("#batchFailurePolicy").addEventListener("change", () => {
    state.batch.failurePolicy = $("#batchFailurePolicy").value;
  });
  $("#scheduleBatchButton").addEventListener("click", () => {
    try { scheduleBatch(); } catch (error) { showError(error); }
  });
  $("#batchScheduleMode").addEventListener("change", () => {
    const intervalMode = $("#batchScheduleMode").value === "interval";
    $("#batchScheduleTimeLabel").hidden = intervalMode;
    $("#batchScheduleIntervalLabel").hidden = !intervalMode;
    $("#batchScheduleDailyText").textContent = intervalMode ? "Повторять с этим интервалом" : "Повторять ежедневно";
  });
  $("#stopScheduledBatchButton").addEventListener("click", () => stopScheduledBatch());
  $("#scheduledBatchList").addEventListener("click", (event) => {
    const stopButton = event.target.closest("[data-schedule-stop]");
    if (stopButton) {
      const schedule = state.scheduledBatches.get(stopButton.dataset.scheduleStop);
      schedule?.scheduler.stop();
      if (schedule) {
        schedule.lastStatus = { ...schedule.lastStatus, phase: "stopped", nextAt: null };
        renderScheduledBatches();
      }
      return;
    }
    const deleteButton = event.target.closest("[data-schedule-delete]");
    if (deleteButton) removeScheduledBatch(deleteButton.dataset.scheduleDelete);
  });
  $("#batchPairingMode").addEventListener("change", () => {
    state.batch.pairing = normalizeBatchPairing({ ...state.batch.pairing, mode: $("#batchPairingMode").value });
    if (state.batch.entries.main.length) rebuildBatchPairs();
  });
  $("#batchPairTolerance").addEventListener("change", () => {
    const value = Number($("#batchPairTolerance").value);
    state.batch.pairing = normalizeBatchPairing({ ...state.batch.pairing, toleranceHours: value });
    $("#batchPairTolerance").value = String(state.batch.pairing.toleranceHours);
    if (state.batch.pairs.length) {
      rebuildBatchPairs();
    }
  });

  for (const format of ["csv", "xlsx", "txt", "json", "yaml", "html"]) {
    $(`#exportFinal${format[0].toUpperCase()}${format.slice(1)}Button`).addEventListener("click", () => exportActiveFinal(format).catch(showError));
  }
  $("#exportFinalPdfButton").addEventListener("click", () => (async () => {
    if (!state.activeSnapshot) return showError(new Error("Нет активного Final"));
    const button = $("#exportFinalPdfButton");
    const startedAt = performance.now();
    button.disabled = true;
    try {
      const blob = await createSnapshotPdfBlob(state.activeSnapshot, (id, visit) => database.forEachSnapshotChunk(id, visit), inventoryOutputColumns(), {
        onProgress: ({ exported, total }) => {
          button.textContent = exported ? `Формирование PDF · ${exported.toLocaleString("ru-RU")} / ${total.toLocaleString("ru-RU")}` : "Формирование PDF…";
        },
      });
      download(`mac-analyzer-final-${new Date().toISOString().slice(0, 10)}.pdf`, blob, "application/pdf");
      recordOperationDuration("export_pdf", performance.now() - startedAt);
    } finally {
      button.disabled = false;
      button.textContent = "PDF (.pdf)";
    }
  })().catch(showError));
  $("#exportInventoryXlsxButton").addEventListener("click", () => (async () => {
    const button = $("#exportInventoryXlsxButton");
    button.disabled = true;
    const startedAt = performance.now();
    try { await exportInventoryXlsx(); recordOperationDuration("export_xlsx", performance.now() - startedAt); }
    finally { button.disabled = false; }
  })().catch(showError));
  $("#exportDatabaseButton").addEventListener("click", () => exportDatabase().catch(showError));
  $("#optionalHostSnapshotUploadButton").addEventListener("click", () => uploadActiveFinalToOptionalHost().catch((error) => {
    $("#optionalHostSnapshotUploadStatus").textContent = error.message || String(error);
    showError(error);
  }));
  $("#optionalHostInventoryUploadButton").addEventListener("click", () => uploadInventoryToOptionalHostUi().catch((error) => {
    $("#optionalHostInventoryUploadStatus").textContent = error.message || String(error);
    showError(error);
  }));
  $("#loadOptionalHostSnapshotsButton").addEventListener("click", () => {
    optionalHostSnapshotPage.after = "";
    optionalHostSnapshotPage.previous = [];
    renderOptionalHostSnapshots({ after: "" }).catch(showError);
  });
  $("#optionalHostSnapshotsList").addEventListener("click", (event) => {
    const deleteSelected = event.target.closest("[data-optional-host-snapshot-delete-selected]");
    if (deleteSelected) {
      deleteSelectedOptionalHostSnapshots(deleteSelected).catch(showError);
      return;
    }
    const remove = event.target.closest("[data-optional-host-snapshot-delete]");
    if (remove) {
      deleteOptionalHostSnapshotFromUi(remove).catch(showError);
      return;
    }
    const page = event.target.closest("[data-optional-host-snapshot-page]");
    if (!page || page.disabled) return;
    const direction = page.dataset.optionalHostSnapshotPage;
    if (direction === "previous") {
      optionalHostSnapshotPage.after = optionalHostSnapshotPage.previous.pop() || "";
    } else {
      optionalHostSnapshotPage.previous.push(optionalHostSnapshotPage.after);
      optionalHostSnapshotPage.after = page.dataset.pageCursor || "";
    }
    renderOptionalHostSnapshots().catch(showError);
  });
  $("#optionalHostSnapshotsList").addEventListener("change", (event) => {
    const selectPage = event.target.closest("[data-optional-host-snapshot-select-page]");
    if (selectPage) {
      for (const { id } of optionalHostSnapshotPage.items) {
        if (selectPage.checked) optionalHostSnapshotPage.selected.add(id);
        else optionalHostSnapshotPage.selected.delete(id);
      }
    } else {
      const select = event.target.closest("[data-optional-host-snapshot-select]");
      if (!select) return;
      if (select.checked) optionalHostSnapshotPage.selected.add(select.dataset.optionalHostSnapshotSelect);
      else optionalHostSnapshotPage.selected.delete(select.dataset.optionalHostSnapshotSelect);
    }
    updateOptionalHostSnapshotSelectionUi();
  });
  $("#saveLocalNotificationSettings").addEventListener("click", () => saveLocalNotificationSettings().catch(showError));
  $("#testLocalNotification").addEventListener("click", () => recordLocalNotification("test", "Тестовая запись", "Проверка локального журнала уведомлений.").catch(showError));
  $("#clearLocalNotificationLog").addEventListener("click", () => clearLocalNotificationLog().catch(showError));
  $("#exportReferenceArchiveButton").addEventListener("click", () => exportReferenceArchive().catch(showError));
  $("#importDatabaseInput").addEventListener("change", (event) => importDatabase(event.target.files[0]).catch(showError));
  $("#importSqliteDatabaseInput").addEventListener("change", (event) => {
    try {
      const { file, walFile } = resolveLegacySQLiteFileSelection(event.target.files);
      importLegacySQLite(file, walFile).catch(showError);
    } catch (error) {
      showError(error);
    } finally {
      event.target.value = "";
    }
  });
  $("#optionalHostDatabaseRestoreInput").addEventListener("change", (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const status = $("#optionalHostDatabaseRestoreStatus");
    status.textContent = `Проверка ${file.name || "SQLite-файла"}…`;
    uploadSQLiteBackupToOptionalHost(file)
      .then((result) => {
        const bytes = Number(result.bytes);
        const size = Number.isSafeInteger(bytes) && bytes >= 0 ? ` (${bytes.toLocaleString("ru-RU")} байт)` : "";
        status.textContent = `Целостная SQLite-копия сохранена отдельно${size}; активная база не изменена.`;
      })
      .catch((error) => {
        status.textContent = error.message;
        showError(error);
      })
      .finally(() => { input.value = ""; });
  });
  $("#importPyQtSettingsInput").addEventListener("change", (event) => importLegacyPyQtSettings(event.target.files[0]).catch(showError).finally(() => { event.target.value = ""; }));
  $("#reselectPyQtIpMappingButton").addEventListener("click", () => $("#importIpMappingsInput").click());
  $$("[data-enrichment-field]").forEach((input) => {
    input.addEventListener("change", () => saveEnrichmentFieldSettings().catch(showError));
  });
  $$("[data-oui-format]").forEach((input) => {
    input.addEventListener("change", () => saveOuiFormatSettings().catch(showError));
  });
  for (const [selector, checked] of [["[data-oui-formats-all]", true], ["[data-oui-formats-none]", false]]) {
    $$(selector).forEach((button) => button.addEventListener("click", () => {
      $$("[data-oui-format]").forEach((input) => { input.checked = checked; });
      saveOuiFormatSettings().catch(showError);
    }));
  }
  document.addEventListener("change", (event) => {
    if (event.target.matches?.('input[name="strategy"]')) database.setSetting("enrichmentStrategy", event.target.value).catch(showError);
  });
  $("#saveWorkspaceStateButton").addEventListener("click", () => saveWorkspaceStateNow().catch(showError));
  $("#restoreWorkspaceStateButton").addEventListener("click", () => restoreWorkspaceStateNow().catch(showError));
  $("#deleteWorkspaceStateButton").addEventListener("click", () => deleteWorkspaceState().catch(showError));
  $("#localArchiveForm").addEventListener("submit", (event) => (async () => {
    event.preventDefault();
    const button = $("#saveLocalArchiveButton");
    button.disabled = true;
    $("#localArchiveStatus").textContent = "Проверка и сохранение базы порциями…";
    try {
      const archive = await database.createLocalArchive($("#localArchiveName").value, portableDatabaseArchiveOptions());
      $("#localArchiveName").value = "";
      $("#localArchiveStatus").textContent = `Сохранён архив «${archive.name}»: ${archive.snapshotCount} Final, ${archive.recordCount.toLocaleString("ru-RU")} записей.`;
      await renderLocalArchiveList();
    } finally { button.disabled = false; }
  })().catch(showError));
  $("#ouiFileInput").addEventListener("change", (event) => prepareOuiImport(event.target.files[0]).catch(showError).finally(() => { event.target.value = ""; }));
  $("#ieeeCidSearchForm").addEventListener("submit", (event) => {
    event.preventDefault();
    ieeeCidCatalogState.query = $("#ieeeCidQuery").value;
    ieeeCidCatalogState.page = 1;
    renderIeeeCidCatalog();
  });
  $("#ieeeCidPreviousButton").addEventListener("click", () => {
    ieeeCidCatalogState.page = Math.max(1, ieeeCidCatalogState.page - 1);
    renderIeeeCidCatalog();
  });
  $("#ieeeCidNextButton").addEventListener("click", () => {
    ieeeCidCatalogState.page += 1;
    renderIeeeCidCatalog();
  });
  $("#addIpMappingButton").addEventListener("click", () => (async () => {
    if (!normalizeIp($("#ipMappingSwitchInput").value) || !text($("#ipMappingAddressInput").value)) throw new Error("Введите корректный IP коммутатора и физический адрес");
    const saved = await database.mergeIpAddressMappings([{
      switchIp: $("#ipMappingSwitchInput").value,
      address: $("#ipMappingAddressInput").value,
      source: "Ручное правило",
    }]);
    await synchronizeDataDirectoryArchive();
    $("#ipMappingSwitchInput").value = "";
    $("#ipMappingAddressInput").value = "";
    $("#ipMappingStatus").textContent = `Сохранено правил: ${saved.length}`;
    await renderIpMappings();
  })().catch(showError));
  $("#detectIpMappingsButton").addEventListener("click", () => (async () => {
    const current = await database.ipAddressMappings();
    const detector = createIpMappingDetector(current);
    if (state.activeSnapshot?.id) await database.forEachSnapshotChunk(state.activeSnapshot.id, (chunk) => detector.accept(chunk));
    const detected = detector.finish();
    const saved = await database.mergeIpAddressMappings(detected, { overwriteExisting: false });
    await synchronizeDataDirectoryArchive();
    $("#ipMappingStatus").textContent = `Добавлено однозначных правил: ${detected.length}; всего: ${saved.length}. Неоднозначные IP оставлены без правила.`;
    await renderIpMappings();
  })().catch(showError));
  $("#applyIpMappingsButton").addEventListener("click", () => (async () => {
    const result = await database.applyIpAddressMappingsToActiveSnapshot();
    state.analytics = null;
    await refreshDatabaseState();
    $("#ipMappingStatus").textContent = `Final ${result.snapshotId}: заполнено адресов ${result.filled}. ID и дата снимка сохранены.`;
  })().catch(showError));
  $("#exportIpMappingsButton").addEventListener("click", () => database.ipAddressMappings().then((mappings) => download("ip-address-mappings.csv", ipMappingsCsv(mappings), "text/csv;charset=utf-8")).catch(showError));
  $("#exportIpMappingsJsonButton").addEventListener("click", () => database.ipAddressMappings().then((mappings) => download("ip-address-mappings.json", ipMappingsJson(mappings), "application/json;charset=utf-8")).catch(showError));
  $("#exportIpMappingsXlsxButton").addEventListener("click", () => database.ipAddressMappings()
    .then((mappings) => new globalThis.Response(createXlsxWorkbookStream(ipMappingsXlsxSheets(mappings)), {
      headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    }).blob())
    .then((blob) => download("ip-address-mappings.xlsx", blob, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
    .catch(showError));
  $("#importIpMappingsInput").addEventListener("change", (event) => prepareIpMappingImport(event.target.files[0]).catch(showError).finally(() => { event.target.value = ""; }));
  $("#detailsDialog [data-dialog-close]").addEventListener("click", () => $("#detailsDialog").close());
  $("#detailsDialog [data-dialog-content]").addEventListener("click", (event) => {
    const searchResultAction = event.target.closest("[data-search-result-action]");
    if (searchResultAction) {
      const device = state.inventory.find((item) => String(item.id) === String(searchResultAction.dataset.deviceId));
      if (!device) return showError(new Error("Устройство больше не найдено в текущем результате поиска"));
      $("#detailsDialog").close();
      if (searchResultAction.dataset.searchResultAction === "history") {
        activateView("history");
        $("#macHistorySearch").value = device.mac;
        openMacHistory().catch(showError);
      } else {
        openDeviceAnalytics(device).catch(showError);
      }
      return;
    }
    const aggregatePage = event.target.closest("[data-dashboard-aggregate-page]");
    if (aggregatePage && state.dashboardAggregateDetail) {
      const detail = state.dashboardAggregateDetail;
      if (detail.queryId) {
        const pageIndex = Math.floor((Number(aggregatePage.dataset.dashboardAggregatePage) || 0) / detail.limit);
        loadDashboardAggregatePage(detail, pageIndex).catch(showError);
        return;
      }
      detail.offset = Number(aggregatePage.dataset.dashboardAggregatePage) || 0;
      $("#detailsDialog [data-dialog-content]").innerHTML = dashboardAggregateDialogContent(detail.items, detail);
      return;
    }
    const aggregateFilter = event.target.closest("[data-dashboard-aggregate-filter]");
    if (aggregateFilter && state.dashboardAggregateDetail) {
      const detail = state.dashboardAggregateDetail;
      if (state.analytics !== detail.analytics) return;
      const filters = { ...state.analyticsDashboardSettings.filters, [detail.field]: aggregateFilter.dataset.dashboardAggregateValue };
      state.dashboardAggregateDetail = null;
      $("#detailsDialog").close();
      saveAnalyticsDashboardSettings({ ...state.analyticsDashboardSettings, filters })
        .then(() => renderAnalytics(true)).catch(showError);
      return;
    }
    const unchangedPage = event.target.closest("[data-analytics-unchanged-page]");
    if (unchangedPage && !unchangedPage.disabled && state.analytics) {
      renderAnalyticsUnchangedPage(state.analytics, Number(unchangedPage.dataset.analyticsUnchangedPage) || 0, true).catch(showError);
      return;
    }
    const fleetPageButton = event.target.closest("[data-dashboard-fleet-page]");
    if (fleetPageButton && state.dashboardFleet) {
      state.dashboardFleetOffset = Number(fleetPageButton.dataset.dashboardFleetPage) || 0;
      $("#detailsDialog [data-dialog-content]").innerHTML = dashboardFleetDialogContent(state.dashboardFleet, { offset: state.dashboardFleetOffset });
      return;
    }
    const absentPageButton = event.target.closest("[data-analytics-absence-page]");
    if (absentPageButton && state.analytics) {
      showAnalyticsAbsencePage(state.analytics, Number(absentPageButton.dataset.analyticsAbsencePage) || 0, false).catch(showError);
      return;
    }
    const unassignedPageButton = event.target.closest("[data-unassigned-device-page]");
    if (unassignedPageButton && state.analytics) {
      showUnassignedAnalyticsPage(state.analytics, Number(unassignedPageButton.dataset.unassignedDevicePage) || 1).catch(showError);
      return;
    }
    const roomCoveragePageButton = event.target.closest("[data-room-coverage-page]");
    if (roomCoveragePageButton && state.analytics) {
      loadRoomCoveragePage(
        state.analytics,
        roomCoveragePageButton.dataset.roomCoveragePage,
        Number(roomCoveragePageButton.dataset.page) || 1,
      ).catch(showError);
      return;
    }
    const roomAnomalyButton = event.target.closest("[data-room-anomaly-page]");
    if (roomAnomalyButton && state.analytics) {
      loadRoomAnomalyPage(state.analytics, roomAnomalyButton.dataset.roomAnomalyPage, Number(roomAnomalyButton.dataset.page) || 1).catch(showError);
      return;
    }
    const finalPageButton = event.target.closest("[data-final-detail-page]");
    if (finalPageButton && state.snapshotDetail.id) {
      openFinalSnapshotPage(state.snapshotDetail.id, Number(finalPageButton.dataset.finalDetailPage)).catch(showError);
      return;
    }
    if (event.target.closest("[data-export-device-analytics]")) {
      if (!state.deviceAnalytics) return showError(new Error("Сначала откройте аналитику устройства"));
      exportDeviceAnalytics().catch(showError);
      return;
    }
    if (event.target.closest("[data-export-device-analytics-txt]")) {
      try { exportDeviceAnalyticsTxt(); } catch (error) { showError(error); }
      return;
    }
    if (event.target.closest("[data-export-device-analytics-xlsx]")) {
      exportDeviceAnalyticsXlsx().catch(showError);
      return;
    }
    if (event.target.closest("[data-export-model-prefix-analytics-xlsx]")) {
      exportModelPrefixAnalyticsXlsx().catch(showError);
      return;
    }
    const moreHistoryButton = event.target.closest("[data-load-device-history]");
    if (moreHistoryButton) {
      moreHistoryButton.disabled = true;
      loadMoreDeviceHistory().catch(showError);
      return;
    }
    if (event.target.closest("[data-delete-device-history]")) {
      deleteDeviceHistory().catch(showError);
      return;
    }
    if (event.target.closest("[data-open-device-timeline]")) {
      const mac = state.deviceAnalytics?.device?.mac;
      if (!normalizeMac(mac)) return showError(new Error("У устройства нет MAC для построения хронологии"));
      $("#detailsDialog").close();
      activateView("history");
      $("#macHistorySearch").value = mac;
      openMacHistory().catch(showError);
      return;
    }
    const roomButton = event.target.closest("[data-open-room-history]");
    if (roomButton) {
      const room = JSON.parse(roomButton.dataset.openRoomHistory);
      $("#detailsDialog").close();
      activateView("rooms");
      $("#roomSearch").value = "";
      const selectors = { businessUnit: "businessUnitFilter", city: "cityFilter", site: "siteFilter", floor: "floorFilter", room: "roomFilter" };
      for (const [field, id] of Object.entries(selectors)) {
        const select = $(`#${id}`);
        if ([...select.options].some((option) => option.value === room[field])) select.value = room[field];
        cascadeRoomFilters(field);
      }
      showRoomTimeline(room.key, room).catch(showError);
      return;
    }
    const link = event.target.closest("[data-search-mac]");
    if (!link) return;
    event.preventDefault();
    state.search = link.dataset.searchMac;
    state.page = 1;
    $("#globalSearch").value = state.search;
    $("#detailsDialog").close();
    activateView("search");
    renderDeviceTable().catch(showError);
  });
}

async function downloadOriginalSource(snapshotId, role, button) {
  button.disabled = true;
  try {
    const original = await database.getOriginalFile(snapshotId, role);
    if (!original) throw new Error(`Оригинал ${role.toUpperCase()} для этого Final отсутствует в IndexedDB`);
    const safeName = String(original.name || `${role}-source`).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180) || `${role}-source`;
    download(safeName, original.blob, original.type || "application/octet-stream");
  } finally {
    button.disabled = false;
  }
}

function legacyTaskFileBlob(contentBase64) {
  if (typeof contentBase64 !== "string" || contentBase64.length % 4 !== 0) throw new Error("В очереди сохранён некорректный Base64-файл");
  const parts = [];
  const encodedChunkSize = 64 * 1024;
  for (let offset = 0; offset < contentBase64.length; offset += encodedChunkSize) {
    const binary = globalThis.atob(contentBase64.slice(offset, Math.min(contentBase64.length, offset + encodedChunkSize)));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    parts.push(bytes);
  }
  return new globalThis.Blob(parts, { type: "application/octet-stream" });
}

async function createLegacyTaskFromForm(event) {
  event.preventDefault();
  if (!isEngineerActive()) throw new Error("Создание расписания доступно только в активном инженерном сеансе");
  const form = event.currentTarget;
  const values = Object.fromEntries(new globalThis.FormData(form).entries());
  const task = await database.createLegacyScheduledTask({ name: values.name, intervalMinutes: Number(values.intervalMinutes), enabled: true });
  form.reset();
  form.elements.intervalMinutes.value = "1440";
  const current = state.legacyObservationLog;
  await loadLegacyObservationLog({ filters: current.filters, cursor: null, previous: [] });
  $("#legacyObservationStatus").textContent = `Создано расписание «${task.payload.name}». Добавьте файлы в таблице расписаний.`;
  await restoreLegacyTaskSchedulers();
}

async function queueCurrentSourceFiles() {
  if (!isEngineerActive()) throw new Error("Управление очередью доступно только в активном инженерном сеансе");
  const files = ["main", "smartroom", "ddio"].map((role) => state.sourceFiles[role]).filter(Boolean);
  if (!files.length) throw new Error("Сначала выберите Main, SmartRoom или DDIO файл для объединения");
  const tasks = await database.legacyObservationSearchPage({ kind: "scheduled_tasks" }, { limit: 1 });
  const task = tasks.rows[0];
  if (!task) throw new Error("Сначала создайте расписание в разделе «Массовое объединение данных»");
  if (!isEngineerActive()) throw new Error("Инженерная сессия завершена; файлы не добавлены в очередь");
  const result = await database.appendLegacyTaskQueueFiles(task.id, files);
  const current = state.legacyObservationLog;
  await loadLegacyObservationLog({ filters: current.filters, cursor: null, previous: [] });
  $("#legacyObservationStatus").textContent = `В очередь «${task.payload.name || ""}» добавлено текущих файлов: ${result.queued}${result.invalid.length ? ` · пропущено: ${result.invalid.join(", ")}` : ""}`;
  await restoreLegacyTaskSchedulers();
}

async function appendLegacyFilesFromPicker(event) {
  const input = event.currentTarget;
  if (!isEngineerActive()) {
    input.value = "";
    throw new Error("Добавление файлов в очередь доступно только в активном инженерном сеансе");
  }
  const taskRecordId = state.legacyObservationLog.queueTaskId;
  state.legacyObservationLog.queueTaskId = "";
  const files = Array.from(input.files || []);
  input.value = "";
  if (!taskRecordId || !files.length) return;
  if (!isEngineerActive()) throw new Error("Инженерная сессия завершена; файлы не добавлены в очередь");
  const result = await database.appendLegacyTaskQueueFiles(taskRecordId, files);
  const current = state.legacyObservationLog;
  await loadLegacyObservationLog({ filters: current.filters, cursor: null, previous: [] });
  const rejected = result.invalid.length ? ` · пропущено: ${result.invalid.join(", ")}` : "";
  $("#legacyObservationStatus").textContent = `В очередь добавлено файлов: ${result.queued}${rejected}. Файлы хранятся локально в этом браузере.`;
  await restoreLegacyTaskSchedulers();
}

async function legacyTaskQueueBlob(queued, { onProgress = () => {} } = {}) {
  if (queued?.contentAvailable && typeof queued.contentBase64 === "string") {
    assertBrowserHeapCapacity(Math.ceil(queued.contentBase64Chars * 0.75) * 2);
    return { filename: queued.filename, blob: legacyTaskFileBlob(queued.contentBase64) };
  }
  const local = await database.legacyTaskQueueLocalFile(queued?.id || "");
  if (local) {
    assertBrowserHeapCapacity(local.blob.size * 2);
    return local;
  }
  const source = await database.legacySqliteSourceForTask(queued?.taskId || "");
  if (!source) throw new Error("Файл отсутствует в переносимом архиве и исходная SQLite-база недоступна в этом браузере");
  const restored = await readLegacyTaskQueueFileFromSQLite(source, queued, {
    beforeRead: (bytes) => assertBrowserHeapCapacity(bytes * 2),
    onProgress,
  });
  return restored;
}

async function downloadLegacyTaskFile(id, button) {
  if (!isEngineerActive()) throw new Error("Доступ к файлам очереди доступен только в активном инженерном сеансе");
  button.disabled = true;
  try {
    const file = await database.legacyTaskQueueFileContent(id);
    if (!file) throw new Error("Запись файла очереди не найдена");
    const restored = await legacyTaskQueueBlob(file);
    if (!isEngineerActive()) throw new Error("Инженерная сессия завершена; скачивание отменено");
    const filename = String(restored.filename || "queued-file").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180) || "queued-file";
    download(filename, restored.blob);
  } finally {
    button.disabled = false;
  }
}

async function analyzeLegacyTaskFile(file) {
  if (!isEngineerActive()) throw new Error("Запуск задачи доступен только в активном инженерном сеансе");
  assertSourceFileCapacity(file);
  assertBrowserHeapCapacity(estimateSha256WorkingSetBytes([file]) * 2);
  const startedAt = performance.now();
  const controller = new AbortController();
  progress(1, `Проверка ${file.name}`, "Фоновый анализ");
  const sourceDigest = await sha256File(file, {
    signal: controller.signal,
    onProgress: ({ bytesRead, totalBytes }) => progress(totalBytes ? bytesRead / totalBytes * 4 : 4, `Проверка файла: ${bytesRead.toLocaleString("ru-RU")} / ${totalBytes.toLocaleString("ru-RU")} байт`, "Фоновый анализ"),
  });
  const sheets = await listXlsxSheets(file);
  const sheetName = sheets[0] || "";
  const table = isStreamableTableFile(file)
    ? await readTablePreview(file, { maxRows: 100, sheetName })
    : await readTable(file, { sheetName });
  const mapping = detectSingleFileMapping(table.headers, table.rows);
  let stagedDeviceStore = null;
  let stagedHistoryPlanId = "";
  let result;
  try {
  if (table.preview && isStreamableTableFile(file)) {
    const stageId = `final-device-stage:${Date.now()}:${crypto.randomUUID()}`;
    stagedDeviceStore = createSingleAnalysisDeviceStageStore(stageId);
    result = await analyzeSingleFileBatchesIntoStore(table.headers, readTableRowBatches(file, {
      sheetName, batchSize: 500, signal: controller.signal,
      onProgress: ({ rowsRead }) => progress(Math.min(35, 4 + rowsRead / 1_000), `${file.name}: обработано ${rowsRead.toLocaleString("ru-RU")} строк`, "Фоновый анализ"),
    }), { mapping, source: file.name, deviceStore: stagedDeviceStore, signal: controller.signal,
      onProgress: ({ rowsRead }) => progress(Math.min(35, 4 + rowsRead / 1_000), `${file.name}: обработано ${rowsRead.toLocaleString("ru-RU")} строк`, "Фоновый анализ"),
    });
    if (stagedDeviceStore.count) {
      const enriched = await enrichStandaloneDevices(stagedDeviceStore, controller.signal, { progressStart: 35, progressEnd: 65 });
      result.enrichmentDiagnostics = enriched.diagnostics;
    } else result.enrichmentDiagnostics = { counts: {} };
    result.summary = await completeSingleFileStageSummary(stagedDeviceStore, result.summary, {
      signal: controller.signal,
      onProgress: (done) => progress(65 + done / Math.max(1, stagedDeviceStore.count) * 8, `Сводка: ${done.toLocaleString("ru-RU")} / ${stagedDeviceStore.count.toLocaleString("ru-RU")} устройств`, "Фоновый анализ"),
    });
    result.devices = await stagedDeviceStore.readPage(0, 20);
  } else {
    result = table.preview
      ? await analyzeSingleFileBatches(table.headers, readTableRowBatches(file, {
        sheetName, batchSize: 500, signal: controller.signal,
        onProgress: ({ rowsRead }) => progress(Math.min(35, 4 + rowsRead / 1_000), `${file.name}: обработано ${rowsRead.toLocaleString("ru-RU")} строк`, "Фоновый анализ"),
      }), { mapping, source: file.name, onProgress: ({ rowsRead }) => progress(Math.min(35, 4 + rowsRead / 1_000), `${file.name}: обработано ${rowsRead.toLocaleString("ru-RU")} строк`, "Фоновый анализ") })
      : analyzeSingleFile(table, { mapping, source: file.name });
    if (result.devices.length) {
      const enriched = await enrichStandaloneDevices(result.devices, controller.signal, { progressStart: 35, progressEnd: 65 });
      result.devices = enriched.devices;
      result.enrichmentDiagnostics = enriched.diagnostics;
      Object.assign(result.summary, countSingleFileDeviceFields(result.devices));
    }
  }
  if (!isEngineerActive()) throw new Error("Инженерный сеанс завершился до сохранения результата задачи");
  const processedAt = new Date().toISOString();
  const observationDate = fileObservationDate(file, table.workbookCreatedAt, table.workbookModifiedAt);
  const createdAt = observationDate.date || processedAt;
  const sourceKey = buildSourceKey({ strategy: "NO_EXPANSION", files: { main: file }, mappings: { main: mapping, smartroom: {}, ddio: {} }, sourceDigests: { main: sourceDigest } });
  let finalSnapshotId = "";
  const stagedComparison = stagedDeviceStore?.count
    ? await prepareStagedInventoryComparison(stagedDeviceStore, createdAt, {
      signal: controller.signal,
      onProgress: (done) => progress(73 + done / Math.max(1, stagedDeviceStore.count) * 8, `Inventory: ${done.toLocaleString("ru-RU")} / ${stagedDeviceStore.count.toLocaleString("ru-RU")} устройств`, "Фоновый анализ"),
    })
    : null;
  stagedHistoryPlanId = stagedComparison?.historyPlanId || "";
  if (stagedDeviceStore?.count) result.devices = await stagedDeviceStore.readPage(0, 20);
  if (!isEngineerActive()) throw new Error("Инженерный сеанс завершился до сохранения результата задачи");
  const savedAnalysis = await database.saveSingleAnalysis({
    filename: file.name, sheetName, result, deviceStore: stagedDeviceStore?.count ? stagedDeviceStore : null, processedAt,
    onProgress: ({ completed, total, phase }) => progress(81 + (total ? completed / total : phase === "complete" ? 1 : 0) * 4, `Сохранение анализа: ${(completed || 0).toLocaleString("ru-RU")} / ${(total || 0).toLocaleString("ru-RU")} устройств`, "Фоновый анализ"),
  });
  const previewDevices = result.devices.slice(0, 20);
  try {
  if (stagedDeviceStore?.count || result.devices.length) {
    const comparison = stagedDeviceStore?.count ? null : await compareInventoryObservationFromDatabase(result.devices, createdAt);
    if (!isEngineerActive()) throw new Error("Инженерная сессия завершилась до сохранения результата задачи");
    const finalSnapshot = await database.saveFinal({
      name: `Scheduled task: ${file.name}`, snapshotType: SINGLE_ANALYSIS_SNAPSHOT_TYPE, sourceKey, createdAt,
      processingTimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...(stagedDeviceStore?.count ? {
        stagedDeviceQueryId: stagedDeviceStore.queryId,
        stagedDeviceCount: stagedDeviceStore.count,
        historyPlanId: stagedComparison.historyPlanId,
        historyPlanEventCount: stagedComparison.historyPlanEventCount,
      } : { devices: result.devices, comparison }),
      diagnostics: { ...result.enrichmentDiagnostics, singleFile: result.diagnostics, ...(stagedComparison ? { historyComparison: stagedComparison.historyComparison } : {}) },
      sourceFiles: [{ role: "main", name: file.name, size: file.size, lastModified: file.lastModified || 0, date: observationDate }],
      originalFiles: [{ role: "main", file }],
      activate: false,
      updateInventory: true,
      consumeDevices: true,
      onProgress: ({ phase, completedDevices = 0, totalDevices = 0, completed = 0, total = 0 }) => {
        if (phase === "history") progress(85 + (total ? completed / total : 1) * 3, `History: ${completed.toLocaleString("ru-RU")} / ${total.toLocaleString("ru-RU")} событий`, "Фоновый анализ");
        else if (phase === "chunk" || phase === "complete") progress(88 + (totalDevices ? completedDevices / totalDevices : 1) * 11, `Final: ${completedDevices.toLocaleString("ru-RU")} / ${totalDevices.toLocaleString("ru-RU")} устройств`, "Фоновый анализ");
      },
    });
    finalSnapshotId = finalSnapshot.id;
  }
  } catch (error) {
    if (savedAnalysis) await database.deleteSingleAnalysis(savedAnalysis.id).catch(() => {});
    throw error;
  }
  if (!isEngineerActive()) throw new Error("Инженерная сессия завершилась до сохранения результата задачи");
  if (finalSnapshotId) await database.attachSingleAnalysisSnapshot(savedAnalysis.id, finalSnapshotId);
  result.singleAnalysisId = savedAnalysis.id;
  result.devices = previewDevices;
  progress(100, `Завершён анализ ${file.name}`, "Фоновый анализ");
  return { processedAt, finalSnapshotId, analysis: result };
  } finally {
    if (stagedHistoryPlanId) await database.clearAnalyticsAggregateQuery(stagedHistoryPlanId).catch(() => {});
    if (stagedDeviceStore?.count) await database.clearAnalyticsAggregateQuery(stagedDeviceStore.queryId).catch(() => {});
  }
}

async function runLegacyScheduledTask(id, button = null, { scheduled = false } = {}) {
  if (!isEngineerActive()) throw new Error("Запуск задачи доступен только в активном инженерном сеансе");
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const summary = await scheduledBatchQueue.enqueue(async () => {
      if (!isEngineerActive()) throw new Error("Инженерная сессия завершена; запуск задачи отменён");
      const task = await database.legacyScheduledTask(id);
      if (!isEngineerActive()) throw new Error("Инженерная сессия завершена; запуск задачи отменён");
      if (!task) {
        state.legacyTaskSchedulers.get(id)?.stop({ notify: false });
        state.legacyTaskSchedulers.delete(id);
        throw new Error("Импортированное расписание не найдено");
      }
      if (scheduled && !task.payload.enabled) throw new Error("Расписание выключено");
      const summary = await runLegacyTaskQueue(String(task.payload.id || id), {
        loadPage: (taskId, options) => database.legacyTaskQueuePage(taskId, options),
        updateItem: (itemId, patch) => {
          if (!isEngineerActive()) throw new Error("Инженерная сессия завершена; состояние очереди не изменено");
          return database.updateLegacyTaskQueueFile(itemId, patch);
        },
        processItem: async (item) => {
          if (!isEngineerActive()) throw new Error("Инженерная сессия завершена; обработка очереди остановлена");
          const queued = await database.legacyTaskQueueFileContent(item.id);
          if (!queued || queued.taskId !== String(task.payload.id || id)) throw new Error("Файл отсутствует в переносимом архиве или не относится к этому расписанию");
          const restored = await legacyTaskQueueBlob(queued, { onProgress: ({ readChars, totalChars }) => { $("#legacyObservationStatus").textContent = `Чтение ${queued.filename}: ${Math.round(readChars / totalChars * 100)}% из исходной SQLite-базы`; } });
          const filename = String(restored.filename || queued.filename || "queued-file.csv").replace(/[\\/:*?\"<>|]+/g, "_").slice(0, 180) || "queued-file.csv";
          const file = new globalThis.File([restored.blob], filename, { lastModified: Date.now() });
          const result = await analyzeLegacyTaskFile(file);
          return {
            processedAt: result.processedAt,
            result: { processedAt: result.processedAt, finalSnapshotId: result.finalSnapshotId, valid: result.analysis.summary.valid, invalid: result.analysis.summary.invalid },
          };
        },
        onProgress: ({ processed, done, errors, filename }) => {
          $("#legacyObservationStatus").textContent = `Расписание «${task.payload.name || ""}»: ${filename} · обработано ${processed}, успешно ${done}, ошибок ${errors}`;
        },
      });
      if (!isEngineerActive()) throw new Error("Инженерная сессия завершена; результат очереди не сохранён");
      const lastRunAt = new Date().toISOString();
      const nextRunAt = new Date(Date.now() + Math.max(1, Number(task.payload.intervalMinutes) || 1) * 60_000).toISOString();
      if (!isEngineerActive()) throw new Error("Инженерная сессия завершена; результат очереди не сохранён");
      await database.updateLegacyScheduledTaskRun(id, lastRunAt, nextRunAt);
      if (!scheduled) state.legacyTaskSchedulers.get(id)?.start({ intervalMinutes: Math.max(1, Number(task.payload.intervalMinutes) || 1), repeatDaily: true, firstRunAt: nextRunAt });
      state.analytics = null;
      await refreshDatabaseState();
      return summary;
    });
    const current = state.legacyObservationLog;
    await loadLegacyObservationLog({ filters: current.filters, cursor: null, previous: [] });
    $("#legacyObservationStatus").textContent += ` · задача выполнена: ${summary.processed} файлов, успешно ${summary.done}, ошибок ${summary.errors}`;
  } finally {
    if (button) button.disabled = false;
  }
}

async function toggleLegacyScheduledTask(id, button) {
  if (!isEngineerActive()) throw new Error("Управление расписанием доступно только в активном инженерном сеансе");
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const task = await database.legacyScheduledTask(id);
    if (!isEngineerActive()) throw new Error("Инженерная сессия завершена; расписание не изменено");
    if (!task) throw new Error("Импортированное расписание не найдено");
    const enabled = !Boolean(task.payload.enabled);
    if (!await database.updateLegacyScheduledTaskEnabled(id, enabled)) throw new Error("Не удалось сохранить состояние расписания");
    if (!enabled) {
      state.legacyTaskSchedulers.get(id)?.stop({ notify: false });
      state.legacyTaskSchedulers.delete(id);
    } else {
      await restoreLegacyTaskSchedulers();
    }
    const current = state.legacyObservationLog;
    await loadLegacyObservationLog({ filters: current.filters, cursor: null, previous: [] });
  } finally {
    if (button) button.disabled = false;
  }
}

async function restoreLegacyTaskSchedulers() {
  if (!isEngineerActive()) {
    for (const scheduler of state.legacyTaskSchedulers.values()) scheduler.stop({ notify: false });
    state.legacyTaskSchedulers.clear();
    return 0;
  }
  let restored = 0;
  let cursor = null;
  do {
    const page = await database.legacyObservationSearchPage({ kind: "scheduled_tasks" }, { cursor, limit: 100 });
    if (!isEngineerActive()) {
      for (const scheduler of state.legacyTaskSchedulers.values()) scheduler.stop({ notify: false });
      state.legacyTaskSchedulers.clear();
      return restored;
    }
    for (const task of page.rows) {
      if (!isEngineerActive()) break;
      const id = String(task.id || "");
      const taskId = String(task.payload?.id || "");
      if (!id || !taskId || !task.payload?.enabled || state.legacyTaskSchedulers.has(id)) continue;
      let queueCursor = null;
      let runnable = false;
      const sqliteSource = await database.legacySqliteSourceForTask(taskId);
      if (!isEngineerActive()) break;
      do {
        const queuePage = await database.legacyTaskQueuePage(taskId, { after: queueCursor, limit: 20 });
        if (!isEngineerActive()) break;
        for (const item of queuePage.rows) {
          if (!isEngineerActive()) break;
          if (item.payload?.contentAvailable || (sqliteSource && item.payload?.contentRetainedInSourceDatabase)) { runnable = true; break; }
          if (await database.legacyTaskQueueLocalFile(item.id)) { runnable = true; break; }
        }
        if (!isEngineerActive()) break;
        if (runnable) break;
        if (!queuePage.hasMore) break;
        queueCursor = queuePage.nextCursor;
      } while (queueCursor);
      if (!isEngineerActive()) break;
      if (!runnable) continue;
      if (!isEngineerActive()) break;
      const scheduler = createDailyScheduler({
        run: () => runLegacyScheduledTask(id, null, { scheduled: true }),
        onStatus: ({ phase, nextAt }) => {
          $("#legacyObservationStatus").textContent = `Расписание «${task.payload.name || ""}»: ${phase}${nextAt ? ` · следующий запуск ${nextAt.toLocaleString("ru-RU")}` : ""}`;
        },
      });
      state.legacyTaskSchedulers.set(id, scheduler);
      restored += 1;
      const parsedNext = Date.parse(task.payload.nextRunAt || "");
      const firstRunAt = Number.isFinite(parsedNext) ? new Date(parsedNext) : new Date();
      scheduler.start({ intervalMinutes: Math.max(1, Number(task.payload.intervalMinutes) || 1), repeatDaily: true, firstRunAt });
    }
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  } while (cursor);
  if (!isEngineerActive()) {
    for (const scheduler of state.legacyTaskSchedulers.values()) scheduler.stop({ notify: false });
    state.legacyTaskSchedulers.clear();
    return 0;
  }
  if (restored) $("#databaseStatus").textContent += ` · активных legacy-расписаний: ${restored} (работают, пока страница открыта)`;
}

async function bootstrap() {
  bindEvents();
  initializeVirtualTables(document);
  installTableSorter(document);
  const cachedStatus = readDatabaseStatusCache();
  if (cachedStatus) {
    $("#databaseStatus").textContent = `${cachedStatus.snapshotCount} Final · ${cachedStatus.inventoryCount.toLocaleString("ru-RU")} устройств · последний сохранённый счётчик`;
  }
  await database.open();
  await loadLocalNotifications().catch(showError);
  await database.clearExpiredAnalyticsAggregateQueries("switch-ip-report:").catch(showError);
  await database.clearExpiredAnalyticsAggregateQueries("final-device-stage:", Date.now() - 60 * 60 * 1000).catch(showError);
  await initializeEngineeringMode();
  await restoreWorkspaceState();
  await loadAnalyticsDashboardSettings();
  await restoreDataDirectoryArchive();
  state.sourceMappingPreferences = normalizeSourceMappingPreferences(await database.getSetting("sourceMappingPreferences", {}));
  await restoreWorkspaceSourceHandles().catch(showError);
  await restoreWorkspaceBatchDirectories().catch(showError);
  state.legacyWorkspaceSources = normalizeLegacyWorkspaceFiles(await database.getSetting("legacyAppSetting:sourceFiles", []));
  renderLegacyWorkspaceSources();
  const savedVendorDetectorSettings = await database.getSetting("vendorDetectorSettings", null);
  const importedVendorDetectorSettings = savedVendorDetectorSettings
    ? null
    : legacyVendorDetectorSettings(await database.getSetting("legacyAppSetting:vendor_detector", null));
  state.vendorDetectorSettings = normalizeVendorDetectorSettings(savedVendorDetectorSettings || importedVendorDetectorSettings || DEFAULT_VENDOR_DETECTOR_SETTINGS);
  if (importedVendorDetectorSettings) await database.setSetting("vendorDetectorSettings", importedVendorDetectorSettings);
  applyVendorDetectorSettings(state.vendorDetectorSettings);
  const savedHistoryEnrichmentSettings = await database.getSetting("historyEnrichmentSettings", null);
  const importedHistoryEnrichmentSettings = savedHistoryEnrichmentSettings
    ? null : await database.getSetting("legacyAppSetting:historyEnrichment", null);
  state.historyEnrichmentSettings = normalizeHistoryEnrichmentSettings(
    savedHistoryEnrichmentSettings || importedHistoryEnrichmentSettings || DEFAULT_HISTORY_ENRICHMENT_SETTINGS,
  );
  if (importedHistoryEnrichmentSettings) await database.setSetting("historyEnrichmentSettings", state.historyEnrichmentSettings);
  applyHistoryEnrichmentSettings(state.historyEnrichmentSettings);
  state.ipEnrichmentSettings = normalizeIpEnrichmentSettings(await database.getSetting("ipEnrichmentSettings", DEFAULT_IP_ENRICHMENT_SETTINGS));
  applyIpEnrichmentSettings(state.ipEnrichmentSettings);
  const savedEnrichmentStrategy = await database.getSetting("enrichmentStrategy", "NO_EXPANSION");
  const strategyInput = document.querySelector(`input[name="strategy"][value="${savedEnrichmentStrategy}"]`);
  if (strategyInput) strategyInput.checked = true;
  applyEnrichmentFieldSettings(await database.getSetting("enrichmentFieldSettings", DEFAULT_ENRICHMENT_FIELD_SETTINGS));
  applyOuiFormatSettings(await database.getSetting("ouiFormats", DEFAULT_OUI_FORMATS));
  state.changeReportSettings = normalizeChangeReportSettings(await database.getSetting("changeReportSettings", {}));
  if (state.changeReportSettings.mode === "period" && (!state.changeReportSettings.from || !state.changeReportSettings.to)) {
    state.changeReportSettings = { ...state.changeReportSettings, ...defaultChangeReportRange() };
    await database.setSetting("changeReportSettings", state.changeReportSettings);
  }
  applyChangeReportControls();
  const finalRecovery = await database.recoverActiveSnapshot();
  let localTheme = "";
  try { localTheme = globalThis.localStorage?.getItem("mac-analyzer-theme") || ""; } catch { /* Use IndexedDB or the system preference. */ }
  const databaseTheme = await database.getSetting("theme", "");
  const importedLegacyTheme = legacyThemeChoice(await database.getSetting("legacyAppSetting:theme", ""));
  applyTheme(resolveThemeChoice(databaseTheme, localTheme, importedLegacyTheme
    ? importedLegacyTheme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches));
  await ensureBundledOui();
  await loadBundledIeeeIndex();
  await refreshDatabaseState();
  if (finalRecovery.recovered && finalRecovery.snapshotId) {
    $("#databaseStatus").textContent += " · активный Final восстановлен";
  } else if (finalRecovery.unavailable) {
    $("#databaseStatus").textContent += " · активный Final недоступен";
  }
  await restoreLegacyTaskSchedulers();
  $("#progressPanel").hidden = true;
  const requestedView = location.hash.slice(1);
  const allowedViews = workspaceStateOptions().views;
  const initial = allowedViews.includes(requestedView) ? requestedView : state.workspaceView;
  const initialView = $(`#${initial}View`) && canAccessView(initial, isEngineerActive()) ? initial : "search";
  activateView(initialView);
  initializeLazyTabs($$(".view"), initialView);
}

bootstrap().catch(showError);

export { executeEnrichment, pairBatchFiles };

