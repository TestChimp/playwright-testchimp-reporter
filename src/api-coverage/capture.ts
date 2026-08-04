/**
 * API operation coverage capture for Playwright (US-185).
 * Collects HTTP interactions; ingest is append-only (no coverage math client-side).
 *
 * Enable/disable via TESTCHIMP_API_COVERAGE (default on; set to '0'/'false' to opt out).
 * Scope capture to matching URLs via TESTCHIMP_API_COVERAGE_URL_REGEX (optional; matches full URL).
 * Disable request/response body capture via TESTCHIMP_API_COVERAGE_PAYLOADS=0 (default on;
 * mirrors ProjectConfig.operationsConfig.disablePayloadTrackingInTests).
 *
 * Mocked vs real: interactions default to REAL. To mark a route as MOCKED, fulfill it via
 * {@link fulfillMocked} instead of `route.fulfill(...)` directly — it stamps a response header
 * this module checks for. Playwright gives no generic way to detect route interception otherwise.
 */
import type { Page, Request, Route } from '@playwright/test';

export const TESTCHIMP_MOCKED_HEADER = 'x-testchimp-mocked';

/** Name of the per-test Playwright attachment carrying buffered interactions (JSON array). */
export const API_COVERAGE_ATTACHMENT_NAME = 'testchimp-api-coverage';

export enum ApiOperationTestMode {
  UNKNOWN_API_OPERATION_TEST_MODE = "UNKNOWN_API_OPERATION_TEST_MODE",
  AUTOMATION = "AUTOMATION",
  MANUAL = "MANUAL",
}

export enum ApiOperationInteractionType {
  UNKNOWN_API_OPERATION_INTERACTION_TYPE = "UNKNOWN_API_OPERATION_INTERACTION_TYPE",
  REAL = "REAL",
  MOCKED = "MOCKED",
}

export enum ApiPayloadKind {
  UNKNOWN_API_PAYLOAD_KIND = "UNKNOWN_API_PAYLOAD_KIND",
  JSON = "JSON",
  FORM_URLENCODED = "FORM_URLENCODED",
  XML = "XML",
  OMITTED = "OMITTED",
}

/** Mirrors api_operations_service.proto ApiPayload. */
export interface ApiPayload {
  kind?: ApiPayloadKind | string;
  contentType?: string;
  /** When kind=JSON. */
  jsonBody?: string;
  /** When kind=FORM_URLENCODED. */
  formFields?: Record<string, string>;
  /** When kind=XML (stored; field coverage not walked yet). */
  xmlBody?: string;
}

export interface ApiOperationInteractionPayload {
  executionId?: string;
  batchInvocationId?: string;
  testId?: string;
  endpoint: string;
  httpMethod: string;
  responseCode?: number;
  requestPayload?: ApiPayload;
  responsePayload?: ApiPayload;
  environment?: string;
  responseTimeMs?: number;
  /** ApiOperationTestMode enum name (JsonFormat). */
  testMode?: ApiOperationTestMode | string;
  /** ApiOperationInteractionType enum name (JsonFormat). */
  interactionType?: ApiOperationInteractionType | string;
  /** Observed URL query params (stripped from endpoint for path matching). */
  queryParams?: Record<string, string>;
}

/** Alias matching the `ApiOperationInteraction` proto message name used in ingest requests. */
export type ApiOperationInteraction = ApiOperationInteractionPayload;

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

/** Whether page-level API coverage capture should be installed (default on). */
export function isApiCoverageEnabled(): boolean {
  return envFlag('TESTCHIMP_API_COVERAGE', true);
}

/** Whether request/response bodies should be captured (default on). */
export function apiCoveragePayloadsEnabled(): boolean {
  return envFlag('TESTCHIMP_API_COVERAGE_PAYLOADS', true);
}

/** Optional URL allow-list regex from TESTCHIMP_API_COVERAGE_URL_REGEX (matches full URL). */
export function buildApiCoverageUrlRegex(): RegExp | null {
  const raw = process.env.TESTCHIMP_API_COVERAGE_URL_REGEX?.trim();
  if (!raw) return null;
  try {
    return new RegExp(raw);
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[TestChimp] Invalid TESTCHIMP_API_COVERAGE_URL_REGEX, ignoring: ${raw}`);
    return null;
  }
}

const PAYLOAD_MAX = 65536;
const BUFFER_KEY = '__testchimpApiCoverageBuffers';
const PENDING_KEY = '__testchimpApiCoveragePending';

type PageAugmented = Page & {
  [BUFFER_KEY]?: ApiOperationInteractionPayload[];
  [PENDING_KEY]?: Set<Promise<void>>;
};

function getBuffers(page: Page): ApiOperationInteractionPayload[] {
  const p = page as PageAugmented;
  if (!p[BUFFER_KEY]) p[BUFFER_KEY] = [];
  return p[BUFFER_KEY]!;
}

function getPending(page: Page): Set<Promise<void>> {
  const p = page as PageAugmented;
  if (!p[PENDING_KEY]) p[PENDING_KEY] = new Set();
  return p[PENDING_KEY]!;
}

function stripPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname || '/';
  } catch {
    const q = url.indexOf('?');
    return q >= 0 ? url.slice(0, q) : url;
  }
}

function parseQueryParams(url: string): Record<string, string> | undefined {
  try {
    const u = new URL(url);
    if (![...u.searchParams.keys()].length) return undefined;
    const out: Record<string, string> = {};
    u.searchParams.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  } catch {
    const q = url.indexOf('?');
    if (q < 0) return undefined;
    const params = new URLSearchParams(url.slice(q + 1));
    const out: Record<string, string> = {};
    params.forEach((v, k) => {
      out[k] = v;
    });
    return Object.keys(out).length ? out : undefined;
  }
}

function truncate(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  return s.length <= PAYLOAD_MAX ? s : s.slice(0, PAYLOAD_MAX);
}

function isSkippableContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const c = ct.toLowerCase();
  return (
    c.includes('multipart/form-data') ||
    c.includes('octet-stream') ||
    c.startsWith('image/') ||
    c.startsWith('video/') ||
    c.startsWith('audio/')
  );
}

function isJsonContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const c = ct.toLowerCase();
  return c.includes('application/json') || c.includes('+json');
}

function isFormContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  return ct.toLowerCase().includes('application/x-www-form-urlencoded');
}

function isXmlContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const c = ct.toLowerCase();
  return c.includes('application/xml') || c.includes('text/xml') || c.includes('+xml');
}

function textToApiPayload(contentType: string | undefined, text: string | null | undefined): ApiPayload | undefined {
  if (!text) return undefined;
  if (isSkippableContentType(contentType)) {
    return { kind: ApiPayloadKind.OMITTED, contentType };
  }
  if (isFormContentType(contentType)) {
    const params = new URLSearchParams(text);
    const formFields: Record<string, string> = {};
    params.forEach((v, k) => {
      formFields[k] = truncate(v) || '';
    });
    return {
      kind: ApiPayloadKind.FORM_URLENCODED,
      contentType,
      formFields,
    };
  }
  if (isXmlContentType(contentType)) {
    return {
      kind: ApiPayloadKind.XML,
      contentType,
      xmlBody: truncate(text),
    };
  }
  if (isJsonContentType(contentType)) {
    return {
      kind: ApiPayloadKind.JSON,
      contentType,
      jsonBody: truncate(text),
    };
  }
  // Best-effort: try JSON parse for unspecified types
  try {
    JSON.parse(text);
    return {
      kind: ApiPayloadKind.JSON,
      contentType,
      jsonBody: truncate(text),
    };
  } catch {
    return undefined;
  }
}

async function bodyToApiPayload(
  contentType: string | undefined,
  getText: () => Promise<string>
): Promise<ApiPayload | undefined> {
  if (isSkippableContentType(contentType)) {
    return { kind: ApiPayloadKind.OMITTED, contentType };
  }
  try {
    return textToApiPayload(contentType, await getText());
  } catch {
    return undefined;
  }
}

/**
 * Fulfill a route as mocked and mark the request for coverage (interactionType=MOCKED).
 */
export async function fulfillMocked(
  route: Route,
  options: Parameters<Route['fulfill']>[0]
): Promise<void> {
  const headers = { ...(options?.headers || {}), [TESTCHIMP_MOCKED_HEADER]: '1' };
  await route.fulfill({ ...options, headers });
}

/**
 * Attach API coverage listeners to a page. Call once per page (idempotent).
 */
export function attachApiCoverageCapture(
  page: Page,
  opts?: { urlRegex?: RegExp | null; capturePayloads?: boolean }
): void {
  const p = page as PageAugmented & { __testchimpApiCoverageHooked?: boolean };
  if (p.__testchimpApiCoverageHooked) return;
  p.__testchimpApiCoverageHooked = true;

  const starts = new WeakMap<object, number>();
  const regex = opts?.urlRegex ?? null;
  const capturePayloads = opts?.capturePayloads !== false;

  page.on('request', (req: Request) => {
    starts.set(req as object, Date.now());
  });

  page.on('response', (response) => {
    const work = (async () => {
      try {
        const req = response.request();
        const url = req.url();
        if (regex && !regex.test(url)) return;
        // Skip binary navigations / assets loosely
        const resourceType = req.resourceType();
        if (
          resourceType === 'image' ||
          resourceType === 'media' ||
          resourceType === 'font' ||
          resourceType === 'stylesheet' ||
          resourceType === 'script'
        ) {
          return;
        }
        const start = starts.get(req as object) ?? Date.now();
        const rt = Math.max(0, Date.now() - start);
        const reqCt = req.headers()['content-type'];
        const resCt = response.headers()['content-type'];
        const mocked =
          !!req.headers()[TESTCHIMP_MOCKED_HEADER] ||
          !!response.headers()[TESTCHIMP_MOCKED_HEADER];

        let requestPayload: ApiPayload | undefined;
        if (capturePayloads) {
          try {
            const post = req.postData();
            if (post) {
              requestPayload = textToApiPayload(reqCt, post);
            }
          } catch {
            /* ignore */
          }
        }

        const responsePayload = capturePayloads
          ? await bodyToApiPayload(resCt, () => response.text())
          : undefined;

        const buf = getBuffers(page);
        buf.push({
          endpoint: stripPath(url),
          httpMethod: req.method(),
          responseCode: response.status(),
          requestPayload,
          responsePayload,
          queryParams: parseQueryParams(url),
          responseTimeMs: rt,
          testMode: ApiOperationTestMode.AUTOMATION,
          interactionType: mocked ? ApiOperationInteractionType.MOCKED : ApiOperationInteractionType.REAL,
        });
        if (buf.length > 500) {
          buf.splice(0, buf.length - 500);
        }
      } catch {
        /* ignore */
      }
    })();
    const pending = getPending(page);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
}

/** Wait for in-flight response handlers, then drain the buffer (call from fixture teardown). */
export async function drainApiCoverageInteractions(page: Page): Promise<ApiOperationInteractionPayload[]> {
  const pending = getPending(page);
  if (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
  const buf = getBuffers(page);
  const copy = buf.slice();
  buf.length = 0;
  return copy;
}

/** Serialize buffered interactions for a Playwright `testInfo.attach(...)` body. */
export function toApiCoverageAttachmentBody(interactions: ApiOperationInteractionPayload[]): Buffer {
  return Buffer.from(JSON.stringify(interactions), 'utf8');
}

/** Parse a previously-attached JSON buffer/string back into interactions (best-effort). */
export function parseApiCoverageAttachment(raw: Buffer | string): ApiOperationInteractionPayload[] {
  try {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as ApiOperationInteractionPayload[]) : [];
  } catch {
    return [];
  }
}
