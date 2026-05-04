import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  TestStep,
  FullResult,
  TestError
} from '@playwright/test/reporter';
import fs from 'fs';
import sharp from 'sharp';

import { TestChimpApiClient } from './api-client';
import {
  TestChimpReporterOptions,
  SmartTestExecutionReport,
  SmartTestExecutionStep,
  SmartTestExecutionStatus,
  StepExecutionStatus,
  SmartTestExecutionJobDetail,
  RetryAttemptLog,
  JobManifestEntry
} from './types';
import {
  derivePaths,
  generateStepId,
  generateUUID,
  getEnvVar,
  normalizeManifestFolderPath,
  resolveManifestEntryFromRuntime,
  stableExploreChimpAnalyticsStepId,
  stableJourneyExecutionId,
} from './utils';
import { isExploreChimpEnabled } from './explorechimp/index';
import { consumeExploreChimpAnalyticsStepScreenState } from './explorechimp/analytics-step-screen-state-registry';
import path from 'path';

/**
 * Internal state for tracking a test execution
 */
interface TestExecutionState {
  testCase: TestCase;
  steps: SmartTestExecutionStep[];
  startedAt: number;
  attemptNumber: number;
}

/**
 * Retry tracking info for a test
 */
interface RetryInfo {
  maxRetries: number;
  currentAttempt: number;
}

/**
 * TestChimp Playwright Reporter
 *
 * Reports test execution data to the TestChimp backend for
 * coverage tracking and traceability.
 *
 * @example
 * // playwright.config.ts
 * export default defineConfig({
 *   reporter: [
 *     ['@testchimp/playwright/reporter', {
 *       verbose: true,
 *       reportOnlyFinalAttempt: true
 *     }]
 *   ]
 * });
 */
export class TestChimpReporter implements Reporter {
  /**
   * Max Playwright trace .zip size we'll POST as multipart to featureservice `/api/upload_attachment`.
   * Must stay below the server's Commons multipart limit (see featureservice `FeatureServiceApplication`).
   * Failure screenshots use the same endpoint but are re-encoded to JPEG first (~viewport KB range).
   */
  private static readonly DEFAULT_TRACE_MAX_BYTES = 25 * 1024 * 1024;
  private static readonly DEFAULT_TRACE_UPLOAD_TIMEOUT_MS = 120_000;
  private static readonly DEFAULT_TRACE_UPLOAD_RETRIES = 2;
  private config!: FullConfig;
  private options: Required<TestChimpReporterOptions>;
  private apiClient: TestChimpApiClient | null = null;
  private batchInvocationId: string = '';
  private testsFolder: string = '';

  // Track test executions (keyed by test ID + attempt, e.g. "testId_attempt_0", "testId_attempt_1").
  // In platform mode we keep all attempts until test_end so the job detail we send includes full retryAttemptLogs.
  private testExecutions: Map<string, TestExecutionState> = new Map();

  // Track retry counts per test (to identify final attempt)
  private testRetryInfo: Map<string, RetryInfo> = new Map();

  // Platform mode: manifest (test identity -> jobId), loaded once in onBegin
  private jobManifest: JobManifestEntry[] = [];

  // Flag to indicate if reporter is properly configured
  private isEnabled: boolean = false;
  private pendingOperations: Promise<any>[] = [];

  constructor(options: TestChimpReporterOptions = {}) {
    // Env wins over playwright.config reporter options so repair/platform runs can
    // force mode (e.g. scriptservice sets TESTCHIMP_EXECUTION_MODE=repair; customer
    // configs often hard-code executionMode: 'ci', which would otherwise hit FeatureService).
    const envMode = getEnvVar('TESTCHIMP_EXECUTION_MODE')?.trim();
    const executionMode: 'ci' | 'platform' | 'repair' =
      envMode === 'repair' || envMode === 'platform' || envMode === 'ci'
        ? envMode
        : (options.executionMode || 'ci');

    this.options = {
      apiKey: options.apiKey || '',
      backendUrl: options.backendUrl || '',
      platformBackendUrl: options.platformBackendUrl || '',
      batchInvocationId: options.batchInvocationId || '',
      projectId: options.projectId || '',
      testsFolder: options.testsFolder || '',
      release: options.release || '',
      environment: options.environment || '',
      reportOnlyFinalAttempt: options.reportOnlyFinalAttempt ?? true,
      captureScreenshots: options.captureScreenshots ?? true,
      verbose: options.verbose ?? false,
      executionMode
    };
  }

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.batchInvocationId = getEnvVar('TESTCHIMP_BATCH_INVOCATION_ID', this.options.batchInvocationId) || generateUUID();

    // Initialize configuration from env vars (env vars take precedence)
    const apiKey = getEnvVar('TESTCHIMP_API_KEY', this.options.apiKey);
    const projectId = getEnvVar('TESTCHIMP_PROJECT_ID', this.options.projectId);
    this.testsFolder = getEnvVar('TESTCHIMP_TESTS_FOLDER', this.options.testsFolder) || 'tests';
    // In platform/repair mode reporter calls scriptservice (step_end/test_end or repair_* endpoints)
    // via TESTCHIMP_PLATFORM_BACKEND_URL; TESTCHIMP_BACKEND_URL stays as featureservice for ai-wright etc.
    const backendUrl =
      this.options.executionMode === 'platform' || this.options.executionMode === 'repair'
        ? getEnvVar('TESTCHIMP_PLATFORM_BACKEND_URL', this.options.platformBackendUrl) || getEnvVar('TESTCHIMP_BACKEND_URL', this.options.backendUrl) || 'https://featureservice.testchimp.io'
        : getEnvVar('TESTCHIMP_BACKEND_URL', this.options.backendUrl) || 'https://featureservice.testchimp.io';

    // Update options with env var values for release/environment
    this.options.release = getEnvVar('TESTCHIMP_RELEASE', this.options.release) || '';
    this.options.environment = getEnvVar('TESTCHIMP_ENV', this.options.environment) || '';

    // In repair mode we allow reporting to scriptservice localhost without an API key.
    // (API client still requires a header value, so we pass a dummy string.)
    if (!apiKey && this.options.executionMode !== 'repair') {
      console.warn('[TestChimp] Missing TESTCHIMP_API_KEY. Reporting disabled.');
      this.isEnabled = false;
      return;
    }

    this.apiClient = new TestChimpApiClient(backendUrl, apiKey || 'local-repair', projectId || '', this.options.verbose);
    this.isEnabled = true;

    if (this.options.executionMode === 'platform') {
      this.jobManifest = this.loadJobManifest();
      const manifestPath =
        getEnvVar('TESTCHIMP_JOB_MANIFEST_PATH') ||
        (this.testsFolder ? path.join(this.testsFolder, '.testchimp-job-manifest.json') : '.testchimp-job-manifest.json');
      const rootDir = this.config?.rootDir || process.cwd();
      const resolvedPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(rootDir, manifestPath);
      const sample =
        this.jobManifest.length > 0
          ? ` (sample: ${JSON.stringify(this.jobManifest.slice(0, 2).map((e) => ({ fileId: e.fileId, testId: e.testId, folderPath: e.folderPath, fileName: e.fileName, suitePath: e.suitePath ?? [], testName: e.testName })))}`
          : '';
      console.log(
        `[TestChimp] Platform mode: manifest from ${resolvedPath} → ${this.jobManifest.length} entries${sample} (backend for step_end/test_end: ${backendUrl})`
      );
    }

    if (this.options.verbose) {
      console.log(`[TestChimp] Reporter initialized. Batch ID: ${this.batchInvocationId}`);
      console.log(`[TestChimp] Tests folder: ${this.testsFolder || '(root)'}`);
      console.log(`[TestChimp] Execution mode: ${this.options.executionMode}`);
    }

    // Scan suite to understand retry configuration
    this.scanTestRetries(suite);
  }

  private loadJobManifest(): JobManifestEntry[] {
    const manifestPath =
      getEnvVar('TESTCHIMP_JOB_MANIFEST_PATH') ||
      (this.testsFolder ? path.join(this.testsFolder, '.testchimp-job-manifest.json') : '.testchimp-job-manifest.json');
    const rootDir = this.config?.rootDir || process.cwd();
    const resolvedPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(rootDir, manifestPath);
    try {
      const content = fs.readFileSync(resolvedPath, 'utf8');
      const parsed = JSON.parse(content) as JobManifestEntry[];
      const entries = Array.isArray(parsed) ? parsed : [];
      if (entries.length === 0 && this.options.executionMode === 'platform') {
        console.warn(`[TestChimp] Platform mode: manifest at ${resolvedPath} is empty or not an array (step_end/test_end will be skipped).`);
      }
      return entries;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[TestChimp] Could not load job manifest from ${resolvedPath}: ${msg}`);
      return [];
    }
  }

  /**
   * Resolve jobId from the platform manifest.
   * - No describe block: both parser and Playwright use suitePath [] → exact match.
   * - Global describe(): parser only sees test.describe() so manifest has []; Playwright reports e.g. ["Suite"] → fallback with [].
   */
  private getJobFromManifest(
    folderPath: string,
    fileName: string,
    suitePath: string[],
    testName: string
  ): { jobId: string; strategy: string } | undefined {
    const resolved = resolveManifestEntryFromRuntime(this.jobManifest, { folderPath, fileName, suitePath, testName });
    if (!resolved?.entry?.jobId) return undefined;
    return { jobId: resolved.entry.jobId, strategy: resolved.strategy };
  }

  private getManifestDebugCandidates(fileName: string, testName: string, limit: number = 3): string {
    const candidates = this.jobManifest
      .filter((e) => e.fileName === fileName || e.testName === testName)
      .slice(0, limit)
      .map((e) => ({
        folderPath: normalizeManifestFolderPath(e.folderPath),
        fileName: e.fileName,
        suitePath: e.suitePath || [],
        testName: e.testName
      }));
    return JSON.stringify(candidates);
  }

  /**
   * Build full job detail from all attempts for this test (from in-memory testExecutions).
   * For step_end: currentAttemptIsFinal=false (current attempt in progress).
   * For test_end: currentAttemptIsFinal=true, finalStatus/error from result.
   * Past attempts are marked FAILED (retry implies they did not succeed).
   */
  private buildJobDetailFromAttempts(
    testId: string,
    testName: string,
    upToRetryInclusive: number,
    currentAttemptIsFinal: boolean,
    finalStatus?: SmartTestExecutionStatus,
    finalError?: string
  ): SmartTestExecutionJobDetail {
    // Only prior attempts go in retryAttemptLogs; last run is in jobDetail.steps (no duplication when 1 run).
    const retryAttemptLogs: RetryAttemptLog[] = [];
    for (let r = 0; r < upToRetryInclusive; r++) {
      const key = `${testId}_attempt_${r}`;
      const exec = this.testExecutions.get(key);
      if (!exec) continue;
      retryAttemptLogs.push({
        retryCount: r,
        steps: [...exec.steps],
        status: SmartTestExecutionStatus.SMART_TEST_EXECUTION_FAILED,
        error: undefined
      });
    }
    const currentExec = this.testExecutions.get(`${testId}_attempt_${upToRetryInclusive}`);
    const steps = currentExec?.steps ?? [];
    return {
      testName,
      steps,
      status: currentAttemptIsFinal && finalStatus !== undefined ? finalStatus : SmartTestExecutionStatus.SMART_TEST_EXECUTION_IN_PROGRESS,
      error: currentAttemptIsFinal ? finalError : undefined,
      scenarioCoverageResults: [],
      retryAttemptLogs
    };
  }

  /** Build current job detail for platform step_end (all attempts so far, current still in progress) */
  private buildCurrentJobDetailForPlatform(test: TestCase, currentRetry: number, testName: string): SmartTestExecutionJobDetail {
    return this.buildJobDetailFromAttempts(test.id, testName, currentRetry, false);
  }

  /** Build final job detail for platform test_end (all attempts with final status) */
  private buildFinalJobDetailForPlatform(
    test: TestCase,
    result: TestResult,
    testName: string,
    currentSteps: SmartTestExecutionStep[]
  ): SmartTestExecutionJobDetail {
    const status = this.mapStatus(result.status);
    const jobDetail = this.buildJobDetailFromAttempts(test.id, testName, result.retry, true, status, result.error?.message);
    return {
      ...jobDetail,
      steps: [...currentSteps],
      pwError: this.toPlaywrightError(result.error)
    };
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    console.log(`[TestChimp] onTestBegin called for test: ${test.title} (retry: ${result.retry})`);
    
    if (!this.isEnabled) {
      console.log(`[TestChimp] Reporter is not enabled, skipping test start tracking for: ${test.title}`);
      return;
    }

    const testKey = this.getTestKey(test, result.retry);

    this.testExecutions.set(testKey, {
      testCase: test,
      steps: [],
      startedAt: Date.now(),
      attemptNumber: result.retry + 1
    });
    
    console.log(`[TestChimp] Created execution state for test: ${test.title} (key: ${testKey})`);

    // Update retry tracking
    const retryKey = test.id;
    const retryInfo = this.testRetryInfo.get(retryKey);
    if (retryInfo) {
      retryInfo.currentAttempt = result.retry;
    }

    if (this.options.verbose) {
      console.log(`[TestChimp] Test started: ${test.title} (attempt ${result.retry + 1})`);
    }
  }

  onStepEnd(test: TestCase, result: TestResult, step: TestStep): void {
    if (!this.isEnabled) return;
    // Repair mode: emit lightweight progress events (multiple healer reruns are grouped by run index).
    if (this.options.executionMode === 'repair' && this.apiClient) {
      const jobId = getEnvVar('TESTCHIMP_REPAIR_JOB_ID', '') || '';
      if (jobId) {
        const runIndexRaw = getEnvVar('TESTCHIMP_REPAIR_RUN_INDEX', '0') || '0';
        const runIndex = Number(runIndexRaw) || 0;
        const event = {
          runIndex,
          timestampMillis: Date.now(),
          message: `[${step.category}] ${step.title}${step.error?.message ? ` (error: ${step.error.message})` : ''}`,
          phase: 'RUNNING_HEALER',
          rawPayloadJson: JSON.stringify({
            testTitle: test.title,
            retry: result.retry,
            step: { title: step.title, category: step.category, duration: step.duration },
            error: step.error ? { message: step.error.message, stack: (step.error as any).stack } : undefined,
          }),
        };
        const p = this.apiClient.repairStepEnd(jobId, event).catch((err) => {
          console.error(`[TestChimp] repair_step_end failed jobId=${jobId}:`, err instanceof Error ? err.message : err);
        });
        this.pendingOperations.push(p);
      }
      // Continue capturing steps locally for consistency (no-op for repair UI today).
    }

    const testKey = this.getTestKey(test, result.retry);
    const execution = this.testExecutions.get(testKey);

    if (!execution) return;

    // Log all steps when verbose is enabled (for debugging)
    if (this.options.verbose) {
      console.log(`[TestChimp] Step seen: "${step.title}" (category: ${step.category})`);
    }

    // Capture test.step (user-defined steps), expect (assertions), and pw:api (Playwright API calls)
    // Exclude internal hooks, fixtures, and attachments
    if (step.category !== 'test.step' && step.category !== 'expect' && step.category !== 'pw:api') {
      if (this.options.verbose) {
        console.log(`[TestChimp] Step filtered out: "${step.title}" (category: ${step.category})`);
      }
      return;
    }

    // ExploreChimp wraps analyze calls in test.step; axe/page.content emit many nested pw:api steps. Do not
    // record them (avoids duplicate descriptions in ingestion + smaller payloads / platform step_end traffic).
    if (step.category === 'pw:api' && this.hasExploreChimpSyntheticWrapperAncestor(step)) {
      if (this.options.verbose) {
        console.log(`[TestChimp] Step suppressed (pw:api inside ExploreChimp wrapper): "${step.title}"`);
      }
      return;
    }

    const stepNumber = execution.steps.length + 1;
    const desc = this.getStepDescription(step);
    let stepId = generateStepId(stepNumber);
    if (step.category === 'test.step' && this.isExploreChimpAnalyticsStepTitle(step.title)) {
      stepId = stableExploreChimpAnalyticsStepId(test.id, result.retry, step.title);
    }

    const exploreChimpScreenState =
      step.category === 'test.step' && this.isExploreChimpAnalyticsStepTitle(step.title)
        ? consumeExploreChimpAnalyticsStepScreenState(stepId)
        : undefined;

    const executionStep: SmartTestExecutionStep = {
      stepId,
      description: desc,
      status: step.error
        ? StepExecutionStatus.FAILURE_STEP_EXECUTION
        : StepExecutionStatus.SUCCESS_STEP_EXECUTION,
      error: step.error?.message,
      pwStepCategory: step.category,
      durationMs: step.duration,
      pwError: this.toPlaywrightError(step.error),
      wasRepaired: false,
      ...(exploreChimpScreenState ? { screenState: exploreChimpScreenState } : {})
    };

    execution.steps.push(executionStep);

    if (this.options.verbose) {
      console.log(
        `[TestChimp] Step captured: ${stepNumber} (${step.category}): "${executionStep.description}" (raw: "${step.title}") - ${executionStep.status}`
      );
    }

    // Platform mode: after each step, send full job detail to scriptservice (blind upsert)
    if (this.options.executionMode === 'platform' && this.apiClient) {
      const paths = derivePaths(test, this.testsFolder, this.config.rootDir, false);
      const resolved = this.getJobFromManifest(paths.folderPath, paths.fileName, paths.suitePath, paths.testName);
      if (resolved?.jobId) {
        const jobId = resolved.jobId;
        console.log(
          `[TestChimp] platform/step_end resolve strategy=${resolved.strategy} jobId=${jobId} fileName="${paths.fileName}" suitePath=${JSON.stringify(paths.suitePath)} testName="${paths.testName}"`
        );
        const jobDetail = this.buildCurrentJobDetailForPlatform(test, result.retry, paths.testName);
        const p = this.apiClient.platformStepEnd(jobId, jobDetail).then(
          () => {
            if (this.options.verbose) {
              console.log(`[TestChimp] platform/step_end ok jobId=${jobId} steps=${jobDetail.steps?.length ?? 0}`);
            }
          },
          (err) => {
            console.error(`[TestChimp] platform/step_end failed jobId=${jobId}:`, err instanceof Error ? err.message : err);
            }
          );
          this.pendingOperations.push(p);
      } else {
        console.warn(
          `[TestChimp] platform/step_end skipped: no jobId in manifest for folderPath="${paths.folderPath}" normalizedFolderPath="${normalizeManifestFolderPath(paths.folderPath)}" fileName="${paths.fileName}" suitePath=${JSON.stringify(paths.suitePath)} testName="${paths.testName}" candidates=${this.getManifestDebugCandidates(paths.fileName, paths.testName)}`
        );
      }
    }
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    const p = this._onTestEndInner(test, result);
    this.pendingOperations.push(p);
    await p;
  }

  private async _onTestEndInner(test: TestCase, result: TestResult): Promise<void> {
    console.log(`[TestChimp] onTestEnd called for test: ${test.title} (status: ${result.status}, retry: ${result.retry})`);
    
    if (!this.isEnabled) {
      console.log(`[TestChimp] Reporter is not enabled, skipping report for: ${test.title}`);
      return;
    }
    
    if (!this.apiClient) {
      console.log(`[TestChimp] API client is not initialized, skipping report for: ${test.title}`);
      return;
    }

    // Repair mode: emit end-of-run marker and stop (no CI/platform ingest report).
    if (this.options.executionMode === 'repair') {
      const jobId = getEnvVar('TESTCHIMP_REPAIR_JOB_ID', '') || '';
      if (jobId) {
        const runIndexRaw = getEnvVar('TESTCHIMP_REPAIR_RUN_INDEX', '0') || '0';
        const runIndex = Number(runIndexRaw) || 0;
        const summary = {
          runIndex,
          timestampMillis: Date.now(),
          status: result.status,
          message: `Repair run completed with status=${result.status} retry=${result.retry}`,
          errorMessage: result.error?.message,
        };
        try {
          await this.apiClient.repairTestEnd(jobId, summary);
        } catch (e) {
          console.error(`[TestChimp] repair_test_end failed jobId=${jobId}:`, e);
        }
      }
      return;
    }

    const testKey = this.getTestKey(test, result.retry);
    const execution = this.testExecutions.get(testKey);

    if (!execution) {
      console.log(`[TestChimp] No execution state found for test: ${test.title} (key: ${testKey}), skipping report`);
      console.log(`[TestChimp] Available execution keys: ${Array.from(this.testExecutions.keys()).join(', ')}`);
      return;
    }

    // Check if this is the final attempt (for retry handling)
    // If test passed, it's always the final attempt (no retries will occur)
    // If test failed, check if we've reached max retries
    const retryKey = test.id;
    const retryInfo = this.testRetryInfo.get(retryKey);
    const testPassed = result.status === 'passed';
    const isFinalAttempt = testPassed || !retryInfo || result.retry >= retryInfo.maxRetries;

    console.log(`[TestChimp] Test status: ${result.status}, retry: ${result.retry}, maxRetries: ${retryInfo?.maxRetries ?? 'unknown'}, isFinalAttempt: ${isFinalAttempt}`);

    // Platform mode: we keep all retry attempts in testExecutions until test_end. Only send test_end on final attempt (with full retryAttemptLogs), then cleanup.
    if (this.options.executionMode === 'platform') {
      if (isFinalAttempt && this.apiClient) {
        const paths = derivePaths(test, this.testsFolder, this.config.rootDir, false);
        const resolved = this.getJobFromManifest(paths.folderPath, paths.fileName, paths.suitePath, paths.testName);
        if (resolved?.jobId) {
          const jobId = resolved.jobId;
          console.log(
            `[TestChimp] platform/test_end resolve strategy=${resolved.strategy} jobId=${jobId} fileName="${paths.fileName}" suitePath=${JSON.stringify(paths.suitePath)} testName="${paths.testName}"`
          );
          if (this.options.captureScreenshots) {
            await this.attachScreenshotsToFailingSteps(execution.steps, result.attachments);
          }
          const jobDetail = this.buildFinalJobDetailForPlatform(test, result, paths.testName, execution.steps);
          const traceGcsPath = await this.uploadTraceAttachmentIfPresent(result.attachments);
          if (traceGcsPath) {
            jobDetail.traceGcsPath = traceGcsPath;
          }
          try {
            await this.apiClient.platformTestEnd(jobId, jobDetail);
            console.log(`[TestChimp] platform/test_end sent: ${test.title} jobId=${jobId} retryAttemptLogs=${jobDetail.retryAttemptLogs?.length ?? 0}`);
          } catch (error) {
            console.error(`[TestChimp] platform/test_end failed for ${test.title}:`, error);
          }
        } else {
          console.warn(
            `[TestChimp] platform/test_end skipped: no jobId in manifest for folderPath="${paths.folderPath}" normalizedFolderPath="${normalizeManifestFolderPath(paths.folderPath)}" fileName="${paths.fileName}" suitePath=${JSON.stringify(paths.suitePath)} testName="${paths.testName}" candidates=${this.getManifestDebugCandidates(paths.fileName, paths.testName)}`
          );
          if (isExploreChimpEnabled() && isFinalAttempt) {
            const fsBase = (getEnvVar('TESTCHIMP_BACKEND_URL', '') || '').trim();
            if (fsBase) {
              if (this.options.captureScreenshots) {
                await this.attachScreenshotsToFailingSteps(execution.steps, result.attachments);
              }
              const traceGcsPath = await this.uploadTraceAttachmentIfPresent(result.attachments);
              const fallbackReport = this.buildReport(test, result, execution);
              if (traceGcsPath) {
                fallbackReport.jobDetail.traceGcsPath = traceGcsPath;
              }
              try {
                const fsClient = new TestChimpApiClient(
                  fsBase,
                  getEnvVar('TESTCHIMP_API_KEY', this.options.apiKey) || '',
                  getEnvVar('TESTCHIMP_PROJECT_ID', this.options.projectId) || '',
                  this.options.verbose
                );
                await fsClient.ingestExecutionReport(fallbackReport);
                console.log(
                  `[TestChimp] ExploreChimp platform fallback: ingested smart test execution to featureservice (${fsBase}) jobId=${fallbackReport.journeyExecutionId ?? '(none)'}`
                );
              } catch (e) {
                console.error('[TestChimp] ExploreChimp platform fallback ingest failed:', e);
              }
            } else {
              console.warn(
                '[TestChimp] ExploreChimp platform mode: no manifest jobId and TESTCHIMP_BACKEND_URL is unset; smart_test_execution_jobs will not be written. Set TESTCHIMP_BACKEND_URL to your featureservice base URL for fallback CI ingest.'
              );
            }
          }
        }
        try {
          await this.maybeExploreChimpJourneyExecutionEnd(test, result, execution, paths);
        } catch (e) {
          console.error(`[TestChimp] ExploreChimp journey_execution_end failed for ${test.title}:`, e);
        }
        // Cleanup all attempts for this test (we have attempts 0..result.retry)
        for (let r = 0; r <= result.retry; r++) {
          this.testExecutions.delete(this.getTestKey(test, r));
        }
      }
      return;
    }

    // CI mode: skip non-final attempts if configured (still close ExploreChimp journey for this attempt)
    if (this.options.reportOnlyFinalAttempt && !isFinalAttempt) {
      console.log(`[TestChimp] Skipping non-final attempt ${result.retry + 1} for: ${test.title}`);
      try {
        await this.maybeExploreChimpJourneyExecutionEnd(test, result, execution);
      } catch (e) {
        console.error(`[TestChimp] ExploreChimp journey_execution_end failed for ${test.title}:`, e);
      }
      this.testExecutions.delete(testKey);
      return;
    }

    // Attach screenshots (CI mode) before building the report
    if (this.options.captureScreenshots) {
      await this.attachScreenshotsToFailingSteps(execution.steps, result.attachments);
    }

    // Build the report
    const report = this.buildReport(test, result, execution);
    const traceGcsPath = await this.uploadTraceAttachmentIfPresent(result.attachments);
    if (traceGcsPath) {
      report.jobDetail.traceGcsPath = traceGcsPath;
    }

    // Log report details
    console.log(`[TestChimp] Preparing to send report for test: ${test.title}`);
    console.log(`[TestChimp]   Status: ${report.jobDetail.status}`);
    console.log(`[TestChimp]   Steps: ${report.jobDetail.steps.length}`);
    const stepsWithScreenshots = report.jobDetail.steps.filter(s => s.screenshotBase64);
    if (stepsWithScreenshots.length > 0) {
      console.log(`[TestChimp]   Steps with screenshots: ${stepsWithScreenshots.length}`);
    }

    try {
      const response = await this.apiClient.ingestExecutionReport(report);

      if (this.options.verbose) {
        console.log(`[TestChimp] Reported: ${test.title} (jobId: ${response.jobId}, testFound: ${response.testFound})`);
        if (response.scenariosPopulated && response.scenariosPopulated > 0) {
          console.log(`[TestChimp] Auto-populated ${response.scenariosPopulated} scenario(s)`);
        }
      }
    } catch (error) {
      console.error(`[TestChimp] Failed to report test: ${test.title}`, error);
    }

    try {
      await this.maybeExploreChimpJourneyExecutionEnd(test, result, execution);
    } catch (e) {
      console.error(`[TestChimp] ExploreChimp journey_execution_end failed for ${test.title}:`, e);
    }

    // Cleanup
    this.testExecutions.delete(testKey);
  }

  async onEnd(result: FullResult): Promise<void> {
    if (this.pendingOperations.length > 0) {
      console.log(`[TestChimp] Waiting for ${this.pendingOperations.length} pending operations to complete...`);
      await Promise.allSettled(this.pendingOperations);
    }
    if (this.isEnabled && this.apiClient && isExploreChimpEnabled()) {
      const explorationId = this.batchInvocationId?.trim();
      if (explorationId) {
        try {
          await this.apiClient.explorechimpExplorationEnd({ explorationId });
        } catch (e) {
          console.error('[TestChimp] explorechimp/exploration_end failed:', e);
        }
      }
    }
    if (this.options.verbose) {
      console.log(`[TestChimp] Test run completed. Status: ${result.status}`);
      console.log(`[TestChimp] Batch invocation ID: ${this.batchInvocationId}`);
    }
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private getTestKey(test: TestCase, retry: number): string {
    return `${test.id}_attempt_${retry}`;
  }

  /**
   * ExploreChimp execution job id: platform manifest job id when resolved, else stable hash of test id + batch + retry.
   * Must match {@link maybeExploreChimpJourneyExecutionEnd} and the id used for smart test execution ingest.
   */
  private exploreChimpJourneyExecutionJobId(
    test: TestCase,
    result: TestResult,
    paths: ReturnType<typeof derivePaths>
  ): string | undefined {
    if (!isExploreChimpEnabled()) {
      return undefined;
    }
    const explorationId = this.batchInvocationId?.trim();
    if (!explorationId) {
      return undefined;
    }
    if (this.options.executionMode === 'platform') {
      const resolved = this.getJobFromManifest(paths.folderPath, paths.fileName, paths.suitePath, paths.testName);
      const fromManifest = resolved?.jobId?.trim();
      if (fromManifest) {
        return fromManifest;
      }
    }
    return stableJourneyExecutionId(test.id, explorationId, result.retry);
  }

  /**
   * Local ExploreChimp: persist step timeline and mark the journey execution completed.
   */
  private async maybeExploreChimpJourneyExecutionEnd(
    test: TestCase,
    result: TestResult,
    execution: TestExecutionState,
    pathsInput?: ReturnType<typeof derivePaths>
  ): Promise<void> {
    if (!this.apiClient || !isExploreChimpEnabled()) {
      return;
    }
    const explorationId = this.batchInvocationId?.trim();
    if (!explorationId) {
      console.warn(
        '[TestChimp] ExploreChimp: skipping journey end — batch invocation id is empty (set TESTCHIMP_BATCH_INVOCATION_ID)'
      );
      return;
    }
    const paths = pathsInput ?? derivePaths(test, this.testsFolder, this.config.rootDir, false);
    const journeyExecutionId = this.exploreChimpJourneyExecutionJobId(test, result, paths);
    if (!journeyExecutionId) {
      return;
    }
    await this.apiClient.explorechimpJourneyExecutionEnd({
      journeyId: test.id,
      journeyExecutionId,
      explorationId,
      steps: execution.steps,
      smartTestStatus: this.mapStatus(result.status),
      errorMessage: result.error?.message,
    });
  }

  private scanTestRetries(suite: Suite): void {
    const scanSuite = (s: Suite) => {
      for (const test of s.tests) {
        this.testRetryInfo.set(test.id, {
          maxRetries: test.retries,
          currentAttempt: 0
        });
      }
      for (const child of s.suites) {
        scanSuite(child);
      }
    };
    scanSuite(suite);

    if (this.options.verbose) {
      console.log(`[TestChimp] Scanned ${this.testRetryInfo.size} test(s)`);
    }
  }

  private buildReport(
    test: TestCase,
    result: TestResult,
    execution: TestExecutionState
  ): SmartTestExecutionReport {
    // Derive paths from test location
    const paths = derivePaths(test, this.testsFolder, this.config.rootDir, this.options.verbose);
    const branchName =
      getEnvVar('TESTCHIMP_BRANCH', '') ||
      getEnvVar('GITHUB_HEAD_REF', '') ||
      getEnvVar('GITHUB_REF_NAME', '') ||
      getEnvVar('CI_COMMIT_REF_NAME', '') ||
      undefined;
    // Platform run: scriptservice sets TESTCHIMP_BRANCH_ID (our entity id) for unique test resolution; CI does not have it
    const branchIdRaw = getEnvVar('TESTCHIMP_BRANCH_ID', '');
    const branchId = branchIdRaw ? parseInt(branchIdRaw, 10) : undefined;
    const branchIdValid = branchId !== undefined && !Number.isNaN(branchId) ? branchId : undefined;

    // Map Playwright status to SmartTestExecutionStatus
    const status = this.mapStatus(result.status);

    const report: SmartTestExecutionReport = {
      folderPath: paths.folderPath,
      fileName: paths.fileName,
      suitePath: paths.suitePath,
      testName: paths.testName,
      release: this.options.release || undefined,
      environment: this.options.environment || undefined,
      batchInvocationId: this.batchInvocationId,
      jobDetail: {
        testName: paths.testName,
        steps: execution.steps,
        status,
        error: result.error?.message,
        pwError: this.toPlaywrightError(result.error),
        scenarioCoverageResults: [] // Backend will populate if empty
      },
      startedAtMillis: execution.startedAt,
      completedAtMillis: Date.now(),
      branchName,
      branchId: branchIdValid
    };
    const exploreChimpJobId = this.exploreChimpJourneyExecutionJobId(test, result, paths);
    if (exploreChimpJobId) {
      report.journeyExecutionId = exploreChimpJobId;
    }
    return report;
  }

  private mapStatus(playwrightStatus: string): SmartTestExecutionStatus {
    switch (playwrightStatus) {
      case 'passed':
        return SmartTestExecutionStatus.SMART_TEST_EXECUTION_COMPLETED;
      case 'failed':
      case 'timedOut':
        return SmartTestExecutionStatus.SMART_TEST_EXECUTION_FAILED;
      case 'skipped':
        return SmartTestExecutionStatus.SMART_TEST_EXECUTION_SKIPPED;
      case 'interrupted':
        return SmartTestExecutionStatus.SMART_TEST_EXECUTION_INTERRUPTED;
      default:
        if (playwrightStatus) {
          console.warn(
            `[TestChimp] mapStatus: unknown Playwright result.status "${playwrightStatus}" — storing UNKNOWN_SMART_TEST_EXECUTION_STATUS`
          );
        }
        return SmartTestExecutionStatus.UNKNOWN_SMART_TEST_EXECUTION_STATUS;
    }
  }

  /**
   * Attach failure screenshots: failing steps first; if none, attach to last step (test-level failures e.g. ai.act).
   */
  private async attachScreenshotsToFailingSteps(
    steps: SmartTestExecutionStep[],
    attachments: TestResult['attachments']
  ): Promise<void> {
    // Log all attachments for debugging
    console.log(`[TestChimp] Processing screenshots: ${attachments.length} total attachment(s), ${steps.length} step(s) total`);
    if (attachments.length > 0) {
      attachments.forEach((att, idx) => {
        console.log(`[TestChimp]   Attachment ${idx + 1}: name="${att.name}", contentType="${att.contentType}", path="${att.path || 'none'}", body=${att.body ? `present (${att.body.length} bytes)` : 'none'}`);
      });
    }

    // Filter for image attachments (with either path or body)
    const screenshots = attachments.filter(
      (a) => a.contentType?.startsWith('image/') && (a.path || a.body)
    );

    console.log(`[TestChimp] Found ${screenshots.length} screenshot(s) (with path or body)`);

    if (screenshots.length === 0) {
      console.log(`[TestChimp] No screenshots found in attachments - Playwright may not be configured to capture screenshots on failure`);
      console.log(`[TestChimp] To enable screenshots, add 'screenshot: "only-on-failure"' to your Playwright config`);
      return;
    }

    const failingWithoutScreenshot = steps.filter(
      (s) => s.status === StepExecutionStatus.FAILURE_STEP_EXECUTION && !s.screenshotPath
    );

    let targetSteps: SmartTestExecutionStep[];

    if (failingWithoutScreenshot.length > 0) {
      targetSteps = failingWithoutScreenshot;
      console.log(
        `[TestChimp] Found ${targetSteps.length} failing step(s) without screenshots; stepIds=${targetSteps
          .map((s) => s.stepId || 'unknown')
          .join(', ')}`
      );
    } else if (steps.length > 0) {
      const last = steps[steps.length - 1];
      if (last && !last.screenshotPath) {
        targetSteps = [last];
        console.log(
          `[TestChimp] No failing steps without screenshot; attaching failure screenshot to last step (fallback): "${last.description}" (${last.stepId})`
        );
      } else {
        console.log(
          `[TestChimp] No failing steps to attach screenshots to${last?.screenshotPath ? ' (last step already has screenshot)' : ''}`
        );
        return;
      }
    } else {
      console.log(`[TestChimp] No failing steps to attach screenshots to (no steps recorded)`);
      return;
    }

    // Use the last screenshot (most recent, likely from test failure)
    const screenshot = screenshots[screenshots.length - 1];

    let imageBuffer: Buffer | null = null;
    try {
      if (screenshot.path) {
        imageBuffer = fs.readFileSync(screenshot.path);
      } else if (screenshot.body) {
        imageBuffer = Buffer.from(screenshot.body);
      }
    } catch (error) {
      console.error(`[TestChimp] ✗ Failed to read screenshot:`, error);
      imageBuffer = null;
    }

    if (!imageBuffer) {
      console.warn('[TestChimp] Screenshot has neither readable path nor body; skipping upload');
      return;
    }
    console.log(`[TestChimp] Read screenshot buffer: ${imageBuffer.length} bytes`);

    if (!this.apiClient) {
      console.warn('[TestChimp] API client not initialized; cannot upload attachment');
      return;
    }

    try {
      // Convert to JPEG (quality 50) to reduce size
      const jpegBuffer = await sharp(imageBuffer)
        .jpeg({ quality: 50 })
        .toBuffer();
      console.log(`[TestChimp] Converted to JPEG: ${jpegBuffer.length} bytes, calling uploadAttachment`);
      const uploadResp = await this.apiClient.uploadAttachment(jpegBuffer, 'image/jpeg', {
        filename: 'screenshot.jpeg'
      });
      const gcpPath = uploadResp.gcpPath;
      if (!gcpPath) {
        console.error('[TestChimp] uploadAttachment response missing gcpPath; cannot attach to steps');
        return;
      }
      console.log(`[TestChimp] uploadAttachment succeeded: ${gcpPath}`);

      for (let stepIdx = 0; stepIdx < targetSteps.length; stepIdx++) {
        const step = targetSteps[stepIdx];
        step.screenshotPath = gcpPath;
        if (step.screenshotBase64) {
          delete step.screenshotBase64;
        }
        console.log(
          `[TestChimp] ✓ Attached screenshot path to step ${stepIdx + 1}: "${step.description}" -> ${gcpPath}`
        );
      }
    } catch (error) {
      console.error('[TestChimp] ✗ Failed to upload screenshot attachment:', error);
    }
  }

  private getTraceMaxBytes(): number {
    const raw = getEnvVar('TESTCHIMP_TRACE_MAX_BYTES', '') || '';
    const parsed = raw ? parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
    return TestChimpReporter.DEFAULT_TRACE_MAX_BYTES;
  }

  private isTraceAttachment(attachment: TestResult['attachments'][number]): boolean {
    const name = (attachment.name || '').toLowerCase();
    const contentType = (attachment.contentType || '').toLowerCase();
    const filePath = (attachment.path || '').toLowerCase();
    return (
      contentType.includes('zip') ||
      name.includes('trace') ||
      filePath.endsWith('.zip')
    );
  }

  private async uploadTraceAttachmentIfPresent(attachments: TestResult['attachments']): Promise<string | undefined> {
    if (!this.apiClient) {
      return undefined;
    }

    const traceAttachment = [...attachments].reverse().find((a) => this.isTraceAttachment(a));
    if (!traceAttachment) {
      return undefined;
    }

    let traceBuffer: Buffer | null = null;
    try {
      if (traceAttachment.path) {
        traceBuffer = fs.readFileSync(traceAttachment.path);
      } else if (traceAttachment.body) {
        traceBuffer = Buffer.from(traceAttachment.body);
      }
    } catch (error) {
      console.error('[TestChimp] Failed to read trace attachment:', error);
      return undefined;
    }

    if (!traceBuffer || traceBuffer.length === 0) {
      console.warn('[TestChimp] Trace attachment is empty; skipping upload');
      return undefined;
    }

    const maxBytes = this.getTraceMaxBytes();
    if (traceBuffer.length > maxBytes) {
      console.warn(`[TestChimp] Trace attachment too large (${traceBuffer.length} bytes > ${maxBytes} bytes); skipping upload`);
      return undefined;
    }

    const contentType = traceAttachment.contentType || 'application/zip';
    const filename = traceAttachment.path
      ? path.basename(traceAttachment.path)
      : `${(traceAttachment.name || 'trace').replace(/[^a-zA-Z0-9._-]/g, '_')}.zip`;
    try {
      const uploadResp = await this.apiClient.uploadAttachment(traceBuffer, contentType, {
        filename,
        timeoutMs: TestChimpReporter.DEFAULT_TRACE_UPLOAD_TIMEOUT_MS,
        maxRetries: TestChimpReporter.DEFAULT_TRACE_UPLOAD_RETRIES
      });
      if (this.options.verbose) {
        console.log(`[TestChimp] Trace uploaded (${traceBuffer.length} bytes): ${uploadResp.gcpPath}`);
      }
      return uploadResp.gcpPath;
    } catch (error) {
      // Non-blocking by design: test execution should still be reported.
      console.error('[TestChimp] Trace upload failed (continuing without trace):', error);
      return undefined;
    }
  }

  /**
   * Generic Playwright pw:api leaf titles; use innermost enclosing test.step title instead.
   */
  private static readonly GENERIC_PW_API_TITLES = new Set(
    [
      'evaluate',
      'screenshot',
      'navigate',
      'wait',
      'click',
      'fill',
      'select',
      'check',
      'press',
      'hover',
      'drag',
      'tap',
      'type',
      'reload',
      'go to url',
      'get attribute',
      'inner text',
      'text content',
      'viewport',
      'close context',
      'close page',
      'new page',
      'keyboard',
      'mouse',
      'wait for event',
      'wait for timeout',
      'wait for load state',
      'wait for selector',
      'wait for function',
      'focus',
      'blur',
      'dispatch event',
      'emulate media',
      'add init script',
      'expose binding',
      'route',
      'unroute',
      'set content',
      'set extra http headers',
      'add cookies',
      'clear cookies',
      'grant permissions',
      'clear permissions'
    ]
  );

  private isGenericPwApiTitle(title: string): boolean {
    return TestChimpReporter.GENERIC_PW_API_TITLES.has(title.trim().toLowerCase());
  }

  /** Single-line description: test.step / expect use title; generic pw:api uses enclosing test.step title when present. */
  /** Must match ExploreChimp `test.step` titles in `explorechimp/index.ts` (stable step id alignment). */
  private isExploreChimpAnalyticsStepTitle(title: string): boolean {
    return (
      title.startsWith('Analyzing Console for Screen-state') ||
      title.startsWith('Analyzing Network for Screen-state') ||
      title.startsWith('Analyzing Metrics for Screen-state') ||
      title.startsWith('Analyzing Screenshot for Screen-state') ||
      title.startsWith('Analyzing DOM for Screen-state')
    );
  }

  /**
   * Playwright `test.step` wrappers used by ExploreChimp / markScreenState. Nested `pw:api` calls (e.g. axe
   * internals) must not inherit these titles for ingestion — that produced dozens of duplicate step rows per
   * checkpoint. Those wrappers are also omitted as "enclosing" steps for generic pw:api description folding.
   */
  private isExploreChimpSyntheticWrapperTitle(title: string): boolean {
    return this.isExploreChimpAnalyticsStepTitle(title) || title.startsWith('ScreenState:');
  }

  /** Nearest enclosing `test.step` that is not an ExploreChimp synthetic wrapper. */
  private getInnermostEnclosingTestStepTitle(step: TestStep): string | undefined {
    let p: TestStep | undefined = step.parent;
    while (p) {
      if (p.category === 'test.step' && !this.isExploreChimpSyntheticWrapperTitle(p.title)) {
        return p.title;
      }
      p = p.parent;
    }
    return undefined;
  }

  /** True if any ancestor `test.step` is ExploreChimp DOM/screenshot/etc. or ScreenState wait — suppress child pw:api rows. */
  private hasExploreChimpSyntheticWrapperAncestor(step: TestStep): boolean {
    let p: TestStep | undefined = step.parent;
    while (p) {
      if (p.category === 'test.step' && this.isExploreChimpSyntheticWrapperTitle(p.title)) {
        return true;
      }
      p = p.parent;
    }
    return false;
  }

  private getStepDescription(step: TestStep): string {
    if (step.category === 'test.step' || step.category === 'expect') {
      return step.title;
    }
    if (step.category === 'pw:api' && this.isGenericPwApiTitle(step.title)) {
      const enclosing = this.getInnermostEnclosingTestStepTitle(step);
      if (enclosing) {
        return enclosing;
      }
    }
    return step.title;
  }

  private toPlaywrightError(error: TestError | undefined, depth: number = 0, maxDepth: number = 3) {
    if (!error || depth >= maxDepth) {
      return undefined;
    }
    const mapped: any = {
      message: error.message,
      stack: error.stack,
      snippet: (error as any).snippet,
      value: (error as any).value,
    };
    if (error.location) {
      mapped.location = {
        file: error.location.file,
        line: error.location.line,
        column: error.location.column,
      };
    }
    if (error.cause) {
      mapped.cause = this.toPlaywrightError(error.cause, depth + 1, maxDepth);
    }
    return mapped;
  }
}
