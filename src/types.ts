/**
 * Type definitions for the TestChimp Playwright reporter
 * Uses camelCase for TypeScript interfaces
 */

export enum SmartTestExecutionStatus {
  UNKNOWN_SMART_TEST_EXECUTION_STATUS = 0,
  SMART_TEST_EXECUTION_QUEUED = 1,
  SMART_TEST_EXECUTION_IN_PROGRESS = 2,
  SMART_TEST_EXECUTION_COMPLETED = 3,
  SMART_TEST_EXECUTION_FAILED = 4,
  SMART_TEST_EXECUTION_COMPLETED_WITH_REPAIRS = 5,
  SMART_TEST_EXECUTION_CANCELLED = 6,
  SMART_TEST_EXECUTION_SKIPPED = 7,
  SMART_TEST_EXECUTION_INTERRUPTED = 8
}

export enum StepExecutionStatus {
  UNKNOWN_STEP_EXECUTION_STATUS = 0,
  SUCCESS_STEP_EXECUTION = 1,
  FAILURE_STEP_EXECUTION = 2
}

export enum ScenarioCoverageStatus {
  UNKNOWN_SCENARIO_COVERAGE_STATUS = 0,
  SUCCESSFUL_SCENARIO_COVERAGE = 1,
  FAILED_SCENARIO_COVERAGE = 2,
  NOT_ATTEMPTED_SCENARIO_COVERAGE = 3
}

export interface PlaywrightLocation {
  file?: string;
  line?: number;
  column?: number;
}

export interface PlaywrightError {
  message?: string;
  stack?: string;
  snippet?: string;
  value?: string;
  location?: PlaywrightLocation;
  cause?: PlaywrightError;
}

export interface SmartTestExecutionStep {
  stepId?: string;
  description: string;
  code?: string;
  screenshotBase64?: string;  // Base64 encoded screenshot (only for failing steps; deprecated in favor of screenshotPath)
  screenshotPath?: string;    // GCS path to screenshot (preferred)
  /** Populated for ExploreChimp analytics steps (same values as analyze_data_sources / markScreenState). */
  screenState?: { name: string; state: string };
  status: StepExecutionStatus;
  error?: string;
  wasRepaired?: boolean;
  pwStepCategory?: string;
  durationMs?: number;
  pwError?: PlaywrightError;
}

export interface ScenarioCoverageResult {
  scenarioTitle: string;
  scenarioId?: string;
  status: ScenarioCoverageStatus;
}

/** Single retry attempt log (steps + status + error for one attempt) */
export interface RetryAttemptLog {
  retryCount?: number;
  steps: SmartTestExecutionStep[];
  status?: SmartTestExecutionStatus;
  error?: string;
}

export interface SmartTestExecutionJobDetail {
  testName: string;
  steps: SmartTestExecutionStep[];
  status: SmartTestExecutionStatus;
  error?: string;
  updatedScript?: string;
  scenarioCoverageResults: ScenarioCoverageResult[];
  /** All retry attempts (platform mode); each entry has retryCount, steps, status, error */
  retryAttemptLogs?: RetryAttemptLog[];
  pwError?: PlaywrightError;
  traceGcsPath?: string;
}

export interface SmartTestExecutionReport {
  folderPath: string;
  fileName: string;
  suitePath: string[];
  testName: string;
  release?: string;
  environment?: string;
  batchInvocationId?: string;
  jobDetail: SmartTestExecutionJobDetail;
  startedAtMillis?: number;
  completedAtMillis?: number;
  branchName?: string;  // CI: from git (e.g. GITHUB_REF_NAME); not available in platform run
  branchId?: number;    // Platform run: our entity id; when set, backend uses for unique test resolution
  /** ExploreChimp: matches the journey execution id and the persisted execution job id after ingest. */
  journeyExecutionId?: string;
}

export interface IngestSmartTestExecutionReportRequest {
  report: SmartTestExecutionReport;
}

export interface IngestSmartTestExecutionReportResponse {
  jobId: string;
  testId?: string;
  testFound: boolean;
  scenariosPopulated?: number;
}

/** One entry in the job manifest (test identity -> jobId) written by scriptservice for platform mode */
export interface JobManifestEntry {
  fileId?: string;
  testId?: string;
  folderPath: string;
  fileName: string;
  suitePath: string[];
  testName: string;
  jobId: string;
}

/**
 * Reporter configuration options
 */
export interface TestChimpReporterOptions {
  /** Override TESTCHIMP_API_KEY env var */
  apiKey?: string;
  /** Override TESTCHIMP_BACKEND_URL env var (default: https://featureservice.testchimp.io) - used for ingest in CI; also for ai-wright etc. */
  backendUrl?: string;
  /** Override TESTCHIMP_PLATFORM_BACKEND_URL env var - in platform mode, reporter uses this for step_end/test_end (scriptservice); if unset, falls back to backendUrl */
  platformBackendUrl?: string;
  /** Override TESTCHIMP_BATCH_INVOCATION_ID env var - when set (e.g. by platform), reporter uses this instead of generating one */
  batchInvocationId?: string;
  /** Override TESTCHIMP_PROJECT_ID env var (optional; server resolves project from API key when omitted) */
  projectId?: string;
  /** Override TESTCHIMP_TESTS_FOLDER env var - base folder for relative path calculation */
  testsFolder?: string;
  /** Override TESTCHIMP_RELEASE env var */
  release?: string;
  /** Override TESTCHIMP_ENV env var */
  environment?: string;
  /** Only report final retry attempt (default: true) */
  reportOnlyFinalAttempt?: boolean;
  /** Capture screenshots for failing steps (default: true) */
  captureScreenshots?: boolean;
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
  /**
   * When true (or when env `explorechimp_enabled` / `TESTCHIMP_EXPLORECHIMP_REPORTER_ENABLED` is truthy if this option is omitted),
   * the reporter may call ExploreChimp HTTP APIs (`journey_execution_end`, `exploration_end`) when `EXPLORECHIMP_ENABLED` is also on.
   * Default false so TrueCoverage-only SmartTest runs do not hit those endpoints.
   */
  exploreChImpReporterEnabled?: boolean;
  /** Execution mode: 'ci' = report to featureservice ingest on test end; 'platform' = report step_end/test_end to scriptservice; 'repair' = report repair_step_end/repair_test_end to scriptservice (default: from TESTCHIMP_EXECUTION_MODE or 'ci') */
  executionMode?: 'ci' | 'platform' | 'repair';
}
