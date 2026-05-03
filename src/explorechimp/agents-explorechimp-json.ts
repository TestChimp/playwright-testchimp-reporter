/**
 * TypeScript mirrors of Featureservice JSON bodies for ExploreChimp
 * `POST /smart-test/analyze_explorechimp_data_sources` (protobuf JSON, camelCase fields).
 *
 * Keep in sync with:
 * - `AwareRepo/services/protos/agents.proto` — `AnalyzeDataSourcesRequest`, `MetricsPayload`,
 *   `RequestResponsePair`, `ApiRequestsPayload`, `DomSnapshotPayload`, `ConsoleLogsPayload`,
 *   `ScreenState`, `DataSource`, `LongTaskDetail`, `InteractionLatencyEntry`, `ResourceTimingEntry`, `BoundingBox`
 * - `AwareRepo/services/protos/common.proto` — `ConsoleLogEntry`
 *
 * Same convention as UI artifact viewers: optional proto fields use `?`; JSON uses camelCase (never snake_case in TS).
 */

/** `agents.proto` DataSource — numeric JSON (enums as int). */
export const DataSourceEnum = {
  UNKNOWN_DATA_SOURCE: 0,
  DOM_SOURCE: 1,
  SCREENSHOT_SOURCE: 2,
  NETWORK_SOURCE: 3,
  CONSOLE_SOURCE: 4,
  METRICS_SOURCE: 5,
} as const;

export type DataSource = (typeof DataSourceEnum)[keyof typeof DataSourceEnum];

export interface ScreenState {
  name?: string;
  state?: string;
}

/** `common.proto` ConsoleLogEntry (JSON). Deprecated level/message omitted by the reporter. */
export interface ConsoleLogEntry {
  level?: string;
  message?: string;
  /** int64 millis — string is safe for JSON int64; server accepts number for typical wall times. */
  timestamp?: string | number;
  type?: string;
  text?: string;
}

/** `agents.proto` ConsoleLogsPayload — map keys are stringified int32 indices in JSON. */
export interface ConsoleLogsPayload {
  consoleLogs?: Record<string, ConsoleLogEntry>;
}

/** `agents.proto` RequestResponsePair */
export interface RequestResponsePair {
  url?: string;
  method?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  status?: number;
  responseTimeMs?: number;
  /** int64 millis */
  timestamp?: string | number;
}

/** `agents.proto` ApiRequestsPayload */
export interface ApiRequestsPayload {
  requests?: Record<string, RequestResponsePair>;
}

/** `agents.proto` DomSnapshotPayload */
export interface DomSnapshotPayload {
  snapshot?: string;
}

/** `agents.proto` BoundingBox */
export interface BoundingBox {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  xPct?: number;
  yPct?: number;
  widthPct?: number;
  heightPct?: number;
}

/** `agents.proto` LongTaskDetail */
export interface LongTaskDetail {
  name?: string;
  startTime?: number;
  duration?: number;
  attributionName?: string;
  attributionType?: string;
  containerType?: string;
  containerSrc?: string;
  containerId?: string;
}

/** `agents.proto` InteractionLatencyEntry */
export interface InteractionLatencyEntry {
  duration?: number;
  inputDelay?: number;
  processingDuration?: number;
  presentationDelay?: number;
  eventType?: string;
  /** int64 millis */
  timestamp?: string | number;
  targetElementId?: string;
  targetLocator?: string;
  boundingBox?: BoundingBox;
}

/** `agents.proto` ResourceTimingEntry */
export interface ResourceTimingEntry {
  url?: string;
  initiatorType?: string;
  duration?: number;
  dnsLookupMs?: number;
  tcpConnectionMs?: number;
  tlsNegotiationMs?: number;
  requestTimeMs?: number;
  responseTimeMs?: number;
  transferSizeBytes?: number;
  encodedSizeBytes?: number;
  decodedSizeBytes?: number;
  fromCache?: boolean;
  /** int64 millis */
  timestamp?: string | number;
  resourceType?: string;
}

/**
 * `agents.proto` MetricsPayload.
 * Note: `screenState` here is the optional **string** `"screen|state"` (field 10), not the `ScreenState` message.
 */
export interface MetricsPayload {
  lcp?: number;
  fcp?: number;
  cls?: number;
  tbt?: number;
  longTasksCount?: number;
  longTasksTotalMs?: number;
  memoryHeapUsedMb?: number;
  memoryHeapTotalMb?: number;
  /** int64 millis */
  collectedAt?: string | number;
  /** Pipe-separated screen|state when set on the payload (reporter usually sets top-level {@link ScreenState} only). */
  screenState?: string;
  longTaskDetails?: LongTaskDetail[];
  interactionLatencies?: InteractionLatencyEntry[];
  resourceTimings?: ResourceTimingEntry[];
}

/** `agents.proto` AnalyzeDataSourcesRequest (JSON field names). */
export interface AnalyzeDataSourcesRequest {
  apiRequestsPayload?: ApiRequestsPayload;
  domSnapshotPayload?: DomSnapshotPayload;
  consoleLogsPayload?: ConsoleLogsPayload;
  metricsPayload?: MetricsPayload;
  screenshotPath?: string;
  stepId?: string;
  journeyExecutionId?: string;
  journeyId?: string;
  explorationId?: string;
  branchName?: string;
  screenState?: ScreenState;
  projectId?: string;
  organizationId?: string;
  analyzedDataSource?: DataSource;
  networkRequestHash?: string;
  testId?: string;
  axeResultsJson?: string;
}
