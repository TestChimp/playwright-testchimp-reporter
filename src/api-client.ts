import axios, { AxiosInstance, AxiosError } from 'axios';
import FormData from 'form-data';
import {
  IngestSmartTestExecutionReportResponse,
  SmartTestExecutionReport,
  SmartTestExecutionJobDetail
} from './types';

/**
 * Convert camelCase keys to snake_case recursively
 */
function toSnakeCase(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(toSnakeCase);
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      result[snakeKey] = toSnakeCase(value);
    }
    return result;
  }

  return obj;
}

/**
 * Convert snake_case keys to camelCase recursively
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
  private projectId: string;
  private verbose: boolean;

  constructor(apiUrl: string, apiKey: string, projectId: string, verbose: boolean = false) {
    this.projectId = projectId;
    this.verbose = verbose;

    this.client = axios.create({
      baseURL: apiUrl,
      headers: {
        'Content-Type': 'application/json',
        'testchimp-api-key': apiKey,
        'project-id': projectId
      },
      timeout: 30000
    });
  }

  /**
   * Send a test execution report to the TestChimp backend
   */
  async ingestExecutionReport(
    report: SmartTestExecutionReport
  ): Promise<IngestSmartTestExecutionReportResponse> {
    // Convert camelCase to snake_case for the API
    const snakeCaseReport = toSnakeCase({ report });

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

      const response = await this.client.post(
        '/api/ingest_smarttest_execution_report',
        snakeCaseReport
      );

      // Convert response from snake_case to camelCase
      return toCamelCase(response.data) as IngestSmartTestExecutionReportResponse;
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;

        console.error(`[TestChimp] API error (${status}): ${message}`);

        if (status === 401 || status === 403) {
          throw new Error(`[TestChimp] Authentication failed. Check TESTCHIMP_API_KEY and TESTCHIMP_PROJECT_ID.`);
        }
      }

      throw error;
    }
  }

  /**
   * Upload a single attachment (e.g. compressed screenshot) to the backend.
   * Uses multipart/form-data and returns the parsed response (expects { gcpPath }).
   */
  async uploadAttachment(buffer: Buffer, contentType: string): Promise<{ gcpPath: string }> {
    const form = new FormData();
    // Filename is not used for storage (server generates ULID), but helps set content type.
    form.append('file', buffer, {
      filename: 'screenshot.jpeg',
      contentType,
    });

    try {
      const response = await this.client.post('/api/upload_attachment', form, {
        headers: {
          // Let form-data set the correct multipart boundary & content type.
          ...form.getHeaders(),
        },
      });
      const data = response.data;
      
      const gcpPath = data.gcpPath;
      if (!gcpPath) {
        console.error('[TestChimp] upload_attachment response missing gcpPath. Keys:', Object.keys(data || {}));
        throw new Error('[TestChimp] upload_attachment response missing gcpPath');
      }

      return { gcpPath };
    } catch (error) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;
        const message = error.response?.data?.message || error.message;
        console.error(`[TestChimp] upload_attachment error (${status}): ${message}`);
      }
      throw error;
    }
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
      await this.client.post('/api/platform/step_end', body);
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
   * Platform mode: send final job detail on test end (upsert + scenario coverage).
   * POST {backend}/api/platform/test_end with jobId and jobDetail.
   */
  async platformTestEnd(jobId: string, jobDetail: SmartTestExecutionJobDetail): Promise<void> {
    try {
      const body = { jobId, jobDetail };
      if (this.verbose) {
        console.log(`[TestChimp] platform/test_end jobId=${jobId} status=${jobDetail.status}`);
      }
      await this.client.post('/api/platform/test_end', body);
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
    return !!this.projectId;
  }

  /**
   * Repair mode: emit a single progress event (step-level).
   * POST {backend}/api/platform/repair_step_end with { jobId, event }.
   */
  async repairStepEnd(jobId: string, event: Record<string, unknown>): Promise<void> {
    try {
      const body = { jobId, event };
      await this.client.post('/api/platform/repair_step_end', body);
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
      await this.client.post('/api/platform/repair_test_end', body);
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
