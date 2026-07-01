import axios, { AxiosInstance, AxiosError } from 'axios';
import FormData from 'form-data';
import {
  IngestSmartTestExecutionReportResponse,
  SmartTestExecutionReport,
  SmartTestExecutionJobDetail,
  CompleteBatchInvocationResponse,
} from './types';
import { getEnvVar } from './utils';

/** Default cap for most JSON API calls (ms). Override with TESTCHIMP_REQUEST_TIMEOUT_MS. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** Cap for large payloads or server-heavy routes (platform test_end, ingest, journey_execution_end). Override with TESTCHIMP_LONG_REQUEST_TIMEOUT_MS. */
const DEFAULT_LONG_REQUEST_TIMEOUT_MS = 600_000;

function parsePositiveTimeoutMs(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 3_600_000) : fallback;
}

/**
 * Convert response keys to camelCase recursively (backend uses protobuf JSON, mostly camelCase).
 */
function toCamelCase(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(toCamelCase);
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      result[camelKey] = toCamelCase(value);
    }
    return result;
  }

  return obj;
}

/**
 * HTTP client for communicating with the TestChimp backend API
 */
export class TestChimpApiClient {
  private client: AxiosInstance;
  private apiKey: string;
  private projectId: string;
  private verbose: boolean;
  /** Upper bound for typical JSON POSTs (step_end, repair_*, exploration_end, etc.). */
  private readonly requestTimeoutMs: number;
  /** Upper bound for large bodies or server-heavy handlers (test_end, ingest, journey_execution_end). */
  private readonly longRequestTimeoutMs: number;

  constructor(apiUrl: string, apiKey: string, projectId: string, verbose: boolean = false) {
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.verbose = verbose;

    this.requestTimeoutMs = parsePositiveTimeoutMs(
      getEnvVar('TESTCHIMP_REQUEST_TIMEOUT_MS'),
      DEFAULT_REQUEST_TIMEOUT_MS
    );
    this.longRequestTimeoutMs = parsePositiveTimeoutMs(
      getEnvVar('TESTCHIMP_LONG_REQUEST_TIMEOUT_MS'),
      DEFAULT_LONG_REQUEST_TIMEOUT_MS
    );

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'testchimp-api-key': apiKey
    };
    const trimmedProject = projectId?.trim();
    if (trimmedProject) {
      headers['project-id'] = trimmedProject;
    }

    this.client = axios.create({
      baseURL: apiUrl,
      headers,
      timeout: this.requestTimeoutMs
    });
  }

  /** Resolved axios base URL (ingest / upload_attachment / ExploreChimp server routes). */
  getBaseUrl(): string {
    const u = this.client.defaults.baseURL;
    return typeof u === 'string' ? u : '';
  }

  /**
   * Send a test execution report to the TestChimp backend
   */
  async ingestExecutionReport(
    report: SmartTestExecutionReport
  ): Promise<IngestSmartTestExecutionReportResponse> {
    const body = { report };

    try {
      // Always log when sending reports (not just when verbose)
      console.log(`[TestChimp] Sending report for test: ${report.testName} (status: ${report.jobDetail?.status}, steps: ${report.jobDetail?.steps?.length || 0})`);
      
      // Log screenshot details if verbose
      if (this.verbose && report.jobDetail?.steps) {
        const stepsWithScreenshots = report.jobDetail.steps.filter(s => s.screenshotBase64);
        if (stepsWithScreenshots.length > 0) {
          console.log(`[TestChimp]   Including ${stepsWithScreenshots.length} step(s) with screenshots`);
          stepsWithScreenshots.forEach((step, idx) => {
            const screenshotSize = step.screenshotBase64?.length || 0;
            console.log(`[TestChimp]     Step ${idx + 1}: "${step.description}" - screenshot size: ${screenshotSize} bytes`);
          });
        } else {
          console.log(`[TestChimp]   No screenshots attached to any steps`);
        }
      }

      const response = await this.client.post('/api/ingest_smarttest_execution_report', body, {
        timeout: this.longRequestTimeoutMs
      });

      return toCamelCase(response.data) as IngestSmartTestExecutionReportResponse;
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;

        console.error(`[TestChimp] API error (${status}): ${message}`);

        if (status === 401 || status === 403) {
          throw new Error(
            `[TestChimp] Authentication failed. Check TESTCHIMP_API_KEY (TESTCHIMP_PROJECT_ID is optional; the backend resolves the project from the API key).`
          );
        }
      }

      throw error;
    }
  }

  /**
   * CI suite-end: finalize batch invocation status and materialize denormalized counts.
   */
  async completeBatchInvocation(body: {
    batchInvocationId: string;
    status: number;
  }): Promise<CompleteBatchInvocationResponse> {
    try {
      const response = await this.client.post('/api/complete_batch_invocation', body, {
        timeout: this.requestTimeoutMs,
      });
      return toCamelCase(response.data) as CompleteBatchInvocationResponse;
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        console.error(`[TestChimp] complete_batch_invocation error (${status}): ${message}`);
      }
      throw error;
    }
  }

  /**
   * Upload a single attachment (e.g. compressed screenshot) to the backend.
   * Uses multipart/form-data and returns the parsed response (expects { gcpPath }).
   */
  async uploadAttachment(
    buffer: Buffer,
    contentType: string,
    options?: { filename?: string; timeoutMs?: number; maxRetries?: number }
  ): Promise<{ gcpPath: string }> {
    const filename = options?.filename || 'attachment.bin';
    const timeoutMs = options?.timeoutMs ?? 120_000;
    const maxRetries = options?.maxRetries ?? 2;

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const form = new FormData();
        // Filename is not used for storage (server generates ULID), but helps set content type.
        form.append('file', buffer, {
          filename,
          contentType,
        });

        const response = await this.client.post('/api/upload_attachment', form, {
          headers: {
            // Let form-data set the correct multipart boundary & content type.
            ...form.getHeaders(),
          },
          timeout: timeoutMs
        });
        const data = response.data;

        const gcpPath = data.gcpPath;
        if (!gcpPath) {
          console.error('[TestChimp] upload_attachment response missing gcpPath. Keys:', Object.keys(data || {}));
          throw new Error('[TestChimp] upload_attachment response missing gcpPath');
        }

        return { gcpPath };
      } catch (error) {
        lastError = error;
        if (error instanceof AxiosError) {
          const status = error.response?.status;
          const message = error.response?.data?.message || error.message;
          console.error(`[TestChimp] upload_attachment error (${status}) attempt=${attempt + 1}/${maxRetries + 1}: ${message}`);
          const retriable = !status || status >= 500 || status === 408 || status === 429;
          if (!retriable || attempt >= maxRetries) {
            break;
          }
        } else if (attempt >= maxRetries) {
          break;
        }

        // Exponential backoff: 300ms, 600ms, 1200ms
        const sleepMs = 300 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('[TestChimp] upload_attachment failed');
  }

  /**
   * Platform mode: send full job detail on step end (blind upsert).
   * POST {backend}/api/platform/step_end with jobId and jobDetail.
   */
  async platformStepEnd(jobId: string, jobDetail: SmartTestExecutionJobDetail): Promise<void> {
    try {
      const body = { jobId, jobDetail };
      if (this.verbose) {
        console.log(`[TestChimp] platform/step_end jobId=${jobId} steps=${jobDetail.steps?.length ?? 0} retryAttemptLogs=${jobDetail.retryAttemptLogs?.length ?? 0}`);
      }
      await this.client.post('/api/platform/step_end', body, { timeout: this.requestTimeoutMs });
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        console.error(`[TestChimp] platform/step_end error (${status}): ${message}`);
      }
      throw error;
    }
  }

  /**
   * Local ExploreChimp: persist journey log and mark the journey execution completed.
   * POST /smart-test/explorechimp/journey_execution_end
   */
  async explorechimpJourneyExecutionEnd(body: {
    journeyId: string;
    journeyExecutionId: string;
    explorationId: string;
    steps: SmartTestExecutionJobDetail['steps'];
    smartTestStatus: number;
    errorMessage?: string;
  }): Promise<void> {
    try {
      await this.client.post('/smart-test/explorechimp/journey_execution_end', body, {
        timeout: this.longRequestTimeoutMs
      });
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        console.error(`[TestChimp] explorechimp/journey_execution_end error (${status}): ${message}`);
      }
      throw error;
    }
  }

  /**
   * Local ExploreChimp: mark exploration completed and refresh aggregated result.
   * POST /smart-test/explorechimp/exploration_end
   */
  async explorechimpExplorationEnd(body: { explorationId: string }): Promise<void> {
    try {
      await this.client.post('/smart-test/explorechimp/exploration_end', body, {
        timeout: this.requestTimeoutMs
      });
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        console.error(`[TestChimp] explorechimp/exploration_end error (${status}): ${message}`);
      }
      throw error;
    }
  }

  async platformTestEnd(jobId: string, jobDetail: SmartTestExecutionJobDetail): Promise<void> {
    try {
      const body = { jobId, jobDetail };
      if (this.verbose) {
        console.log(`[TestChimp] platform/test_end jobId=${jobId} status=${jobDetail.status}`);
      }
      await this.client.post('/api/platform/test_end', body, { timeout: this.longRequestTimeoutMs });
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        console.error(`[TestChimp] platform/test_end error (${status}): ${message}`);
      }
      throw error;
    }
  }

  /**
   * Check if the client is properly configured
   */
  isConfigured(): boolean {
    return !!this.apiKey?.trim();
  }

  /**
   * Repair mode: emit a single progress event (step-level).
   * POST {backend}/api/platform/repair_step_end with { jobId, event }.
   */
  async repairStepEnd(jobId: string, event: Record<string, unknown>): Promise<void> {
    try {
      const body = { jobId, event };
      await this.client.post('/api/platform/repair_step_end', body, { timeout: this.requestTimeoutMs });
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        console.error(`[TestChimp] repair_step_end error (${status}): ${message}`);
      }
      throw error;
    }
  }

  /**
   * Repair mode: mark end of one healer run (can be emitted multiple times).
   * POST {backend}/api/platform/repair_test_end with { jobId, summary }.
   */
  async repairTestEnd(jobId: string, summary: Record<string, unknown>): Promise<void> {
    try {
      const body = { jobId, summary };
      await this.client.post('/api/platform/repair_test_end', body, { timeout: this.requestTimeoutMs });
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        console.error(`[TestChimp] repair_test_end error (${status}): ${message}`);
      }
      throw error;
    }
  }
}
