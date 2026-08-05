/**
 * API operation coverage capture for Playwright (US-185).
 * Collects HTTP interactions; ingest is append-only (no coverage math client-side).
 *
 * P0: never disrupt test execution. Body reads and drain are hard-timeout’d; on timeout we
 * keep metadata (or drop the interaction) rather than hang fixture teardown.
 *
 * Opt-in via TESTCHIMP_ENABLE_API_CAPTURE=1 (default off). One flag enables page capture,
 * payload reads, attachment, and reporter ingest together — leave unset to avoid any impact
 * on test execution from API capturing.
 * Scope capture to matching URLs via TESTCHIMP_API_COVERAGE_URL_REGEX (optional; matches full URL).
 * Body read timeout: TESTCHIMP_API_COVERAGE_BODY_TIMEOUT_MS (default 1500).
 * Drain timeout: TESTCHIMP_API_COVERAGE_DRAIN_TIMEOUT_MS (default 5000).
 *
 * Mocked vs real: native Playwright `route.fulfill(...)` calls are detected automatically.
 * Playwright does not expose this on Response, so route handlers registered after capture attaches
 * are instrumented in-process. Instrumentation is best-effort and must never alter route behavior.
 */
import type { Page, Request, Route } from '@playwright/test';

/**
 * Legacy optional response/request header that still marks an interaction as MOCKED.
 * Prefer automatic `route.fulfill` detection (or {@link fulfillMocked} for pre-attach handlers).
 */
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

function envTimeoutMs(name: string, defaultMs: number, minMs: number, maxMs: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultMs;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return defaultMs;
  return Math.max(minMs, Math.min(maxMs, n));
}

/**
 * Whether API operation capture + payload ingest should run.
 * Controlled solely by TESTCHIMP_ENABLE_API_CAPTURE (default off / unset).
 * Truthy: 1, true, yes. Falsy / unset: disabled.
 */
export function isApiCoverageEnabled(): boolean {
  return envFlag('TESTCHIMP_ENABLE_API_CAPTURE', false);
}

/**
 * Payload capture follows the same opt-in as {@link isApiCoverageEnabled}.
 * Kept as a named export for callers that previously branched on payloads separately.
 */
export function apiCoveragePayloadsEnabled(): boolean {
  return isApiCoverageEnabled();
}

/** Per-response body read cap so SSE/long-poll cannot hang the pending set. */
export function resolveApiCoverageBodyTimeoutMs(): number {
  return envTimeoutMs('TESTCHIMP_API_COVERAGE_BODY_TIMEOUT_MS', 1500, 50, 10_000);
}

/** Fixture-teardown drain budget (same spirit as RUM flush). */
export function resolveApiCoverageDrainTimeoutMs(): number {
  return envTimeoutMs('TESTCHIMP_API_COVERAGE_DRAIN_TIMEOUT_MS', 5000, 100, 30_000);
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
const ROUTING_INSTRUMENTED = Symbol('testchimpApiCoverageRoutingInstrumented');
const ROUTE_FULFILL_INSTRUMENTED = Symbol('testchimpApiCoverageRouteFulfillInstrumented');

/** Shared across pages in a worker so context-level routes can mark the owning page's request. */
const fulfilledRequests = new WeakSet<object>();

const SKIP_RESOURCE_TYPES = new Set([
  'image',
  'media',
  'font',
  'stylesheet',
  'script',
  'document',
  'websocket',
  'eventsource',
  'manifest',
  'texttrack',
]);

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

/** Binary / multipart / streaming content types — never call response.text(). */
function isSkippableContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  const c = ct.toLowerCase();
  return (
    c.includes('multipart/form-data') ||
    c.includes('octet-stream') ||
    c.includes('text/event-stream') ||
    c.includes('text/html') ||
    c.startsWith('image/') ||
    c.startsWith('video/') ||
    c.startsWith('audio/')
  );
}

/** Statuses with no useful body — skip body read. */
export function shouldSkipBodyForStatus(status: number): boolean {
  return status < 200 || status === 204 || status === 304;
}

export function shouldSkipResourceType(resourceType: string): boolean {
  return SKIP_RESOURCE_TYPES.has(resourceType);
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

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function bodyToApiPayload(
  contentType: string | undefined,
  getText: () => Promise<string>,
  timeoutMs: number
): Promise<ApiPayload | undefined> {
  if (isSkippableContentType(contentType)) {
    return { kind: ApiPayloadKind.OMITTED, contentType };
  }
  try {
    const text = await withTimeout(getText(), timeoutMs);
    return textToApiPayload(contentType, text);
  } catch {
    // Timeout or body read failure: omit payload rather than fail the test.
    return undefined;
  }
}

/**
 * Explicit MOCKED marker for route handlers registered before capture instrumentation attaches.
 * Prefer ordinary `route.fulfill(...)` after the TestChimp page fixture has attached.
 */
export async function fulfillMocked(
  route: Route,
  options: Parameters<Route['fulfill']>[0]
): Promise<void> {
  const request = markFulfilledRequest(route);
  try {
    await route.fulfill(options);
  } catch (error) {
    if (request) fulfilledRequests.delete(request);
    throw error;
  }
}

type RouteAugmented = Route & {
  [ROUTE_FULFILL_INSTRUMENTED]?: boolean;
};

type RoutingTarget = Pick<Page, 'route' | 'unroute'> & {
  [ROUTING_INSTRUMENTED]?: boolean;
};

function markFulfilledRequest(route: Route): object | undefined {
  try {
    const request = route.request() as object;
    fulfilledRequests.add(request);
    return request;
  } catch {
    // Classification is best-effort; never interfere with Playwright route handling.
    return undefined;
  }
}

function clearFulfilledRequest(route: Route): void {
  try {
    fulfilledRequests.delete(route.request() as object);
  } catch {
    // Best-effort only.
  }
}

function hasLegacyMockedHeader(req: Request, response: { headers: () => Record<string, string> }): boolean {
  try {
    return !!req.headers()[TESTCHIMP_MOCKED_HEADER] || !!response.headers()[TESTCHIMP_MOCKED_HEADER];
  } catch {
    return false;
  }
}

function replaceRouteMethod<K extends keyof Route>(
  route: Route,
  methodName: K,
  value: Route[K]
): PropertyDescriptor | undefined {
  const previous = Object.getOwnPropertyDescriptor(route, methodName as string);
  Object.defineProperty(route, methodName as string, {
    configurable: true,
    value,
    writable: true,
  });
  return previous;
}

/**
 * Instrument a Route so fulfill marks MOCKED, while continue/fallback/abort clear any pending mark.
 *
 * P0: every instrumentation operation is isolated from the original Playwright call. Even if
 * marking fails, the original method is called exactly once with unchanged arguments and its
 * fulfillment or rejection is propagated.
 */
function instrumentRouteFulfill(route: Route): void {
  const replaced: Array<{ name: keyof Route; descriptor: PropertyDescriptor | undefined }> = [];
  try {
    const augmented = route as RouteAugmented;
    if (augmented[ROUTE_FULFILL_INSTRUMENTED]) return;

    const originalFulfill = route.fulfill.bind(route);
    const instrumentedFulfill: Route['fulfill'] = (options) => {
      const request = markFulfilledRequest(route);
      try {
        const result = originalFulfill(options);
        if (!request) return result;
        // Normalize thenables so a non-Promise return cannot throw TypeError into the test.
        return Promise.resolve(result).catch((error) => {
          fulfilledRequests.delete(request);
          throw error;
        });
      } catch (error) {
        if (request) fulfilledRequests.delete(request);
        throw error;
      }
    };

    const clearAndForward =
      <M extends 'continue' | 'fallback' | 'abort'>(methodName: M): Route[M] => {
        const original = route[methodName].bind(route) as Route[M];
        return ((...args: Parameters<Route[M]>) => {
          clearFulfilledRequest(route);
          return (original as (...a: Parameters<Route[M]>) => ReturnType<Route[M]>)(...args);
        }) as Route[M];
      };

    replaced.push({ name: 'fulfill', descriptor: replaceRouteMethod(route, 'fulfill', instrumentedFulfill) });
    for (const methodName of ['continue', 'fallback', 'abort'] as const) {
      if (typeof route[methodName] !== 'function') continue;
      replaced.push({
        name: methodName,
        descriptor: replaceRouteMethod(route, methodName, clearAndForward(methodName)),
      });
    }
    Object.defineProperty(augmented, ROUTE_FULFILL_INSTRUMENTED, {
      configurable: true,
      value: true,
    });
  } catch {
    // Roll back a partial install; a changed/non-extensible Route remains usable but unclassified.
    for (let i = replaced.length - 1; i >= 0; i -= 1) {
      const { name, descriptor } = replaced[i]!;
      try {
        if (descriptor) Object.defineProperty(route, name as string, descriptor);
        else delete (route as Partial<Route>)[name];
      } catch {
        // Extremely defensive: standard Playwright Route objects are configurable/extensible.
      }
    }
  }
}

/**
 * Wrap subsequently registered route handlers while preserving `unroute(url, handler)` identity.
 * Install failures are deliberately ignored: missing mocked coverage is preferable to test impact.
 */
function instrumentRoutingTarget(target: RoutingTarget): void {
  const routeDescriptor = Object.getOwnPropertyDescriptor(target, 'route');
  const unrouteDescriptor = Object.getOwnPropertyDescriptor(target, 'unroute');
  let routeReplaced = false;
  let unrouteReplaced = false;
  try {
    if (target[ROUTING_INSTRUMENTED]) return;

    const originalRoute = target.route.bind(target);
    const originalUnroute = target.unroute.bind(target);
    const wrappedHandlers = new WeakMap<
      Parameters<Page['route']>[1],
      Parameters<Page['route']>[1]
    >();

    const instrumentedRoute: Page['route'] = async (url, handler, options) => {
      let wrappedHandler = wrappedHandlers.get(handler);
      if (!wrappedHandler) {
        wrappedHandler = (route, request) => {
          instrumentRouteFulfill(route);
          return handler(route, request);
        };
        wrappedHandlers.set(handler, wrappedHandler);
      }
      return originalRoute(url, wrappedHandler, options);
    };

    const instrumentedUnroute: Page['unroute'] = async (url, handler) => {
      if (!handler) return originalUnroute(url);
      return originalUnroute(url, wrappedHandlers.get(handler) ?? handler);
    };

    Object.defineProperty(target, 'route', {
      configurable: true,
      value: instrumentedRoute,
      writable: true,
    });
    routeReplaced = true;
    Object.defineProperty(target, 'unroute', {
      configurable: true,
      value: instrumentedUnroute,
      writable: true,
    });
    unrouteReplaced = true;
    Object.defineProperty(target, ROUTING_INSTRUMENTED, {
      configurable: true,
      value: true,
    });
  } catch {
    // Roll back partial installation so route/unroute semantics cannot diverge.
    try {
      if (routeReplaced) {
        if (routeDescriptor) Object.defineProperty(target, 'route', routeDescriptor);
        else delete (target as Partial<RoutingTarget>).route;
      }
      if (unrouteReplaced) {
        if (unrouteDescriptor) Object.defineProperty(target, 'unroute', unrouteDescriptor);
        else delete (target as Partial<RoutingTarget>).unroute;
      }
    } catch {
      // Extremely defensive: standard Playwright objects are configurable/extensible.
    }
  }
}

function pushInteraction(page: Page, interaction: ApiOperationInteractionPayload): void {
  const buf = getBuffers(page);
  buf.push(interaction);
  if (buf.length > 500) {
    buf.splice(0, buf.length - 500);
  }
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
  const bodyTimeoutMs = resolveApiCoverageBodyTimeoutMs();

  if (typeof p.route === 'function' && typeof p.unroute === 'function') {
    instrumentRoutingTarget(p);
  }
  try {
    const context = p.context();
    if (typeof context.route === 'function' && typeof context.unroute === 'function') {
      instrumentRoutingTarget(context);
    }
  } catch {
    // Fake/closed pages or changed Playwright APIs: response capture still remains usable.
  }

  page.on('request', (req: Request) => {
    starts.set(req as object, Date.now());
  });

  page.on('response', (response) => {
    const work = (async () => {
      try {
        const req = response.request();
        const url = req.url();
        if (regex && !regex.test(url)) return;
        const resourceType = req.resourceType();
        if (shouldSkipResourceType(resourceType)) {
          return;
        }
        const status = response.status();
        const start = starts.get(req as object) ?? Date.now();
        const rt = Math.max(0, Date.now() - start);
        const reqCt = req.headers()['content-type'];
        const resCt = response.headers()['content-type'];
        // Consume the marker: each Playwright Request has at most one response.
        // Legacy header remains a supported opt-in for pre-instrumentation handlers.
        const mocked =
          fulfilledRequests.delete(req as object) || hasLegacyMockedHeader(req, response);

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

        let responsePayload: ApiPayload | undefined;
        if (capturePayloads && !shouldSkipBodyForStatus(status) && !isSkippableContentType(resCt)) {
          responsePayload = await bodyToApiPayload(resCt, () => response.text(), bodyTimeoutMs);
        } else if (capturePayloads && isSkippableContentType(resCt)) {
          responsePayload = { kind: ApiPayloadKind.OMITTED, contentType: resCt };
        }

        pushInteraction(page, {
          endpoint: stripPath(url),
          httpMethod: req.method(),
          responseCode: status,
          requestPayload,
          responsePayload,
          queryParams: parseQueryParams(url),
          responseTimeMs: rt,
          testMode: ApiOperationTestMode.AUTOMATION,
          interactionType: mocked ? ApiOperationInteractionType.MOCKED : ApiOperationInteractionType.REAL,
        });
      } catch {
        /* ignore — capture must never throw into the test */
      }
    })();
    const pending = getPending(page);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
}

/**
 * Wait (bounded) for in-flight response handlers, then drain the buffer.
 * On drain timeout, returns whatever is already buffered and abandons remaining pending work.
 */
export async function drainApiCoverageInteractions(page: Page): Promise<ApiOperationInteractionPayload[]> {
  const pending = getPending(page);
  if (pending.size > 0) {
    const drainMs = resolveApiCoverageDrainTimeoutMs();
    try {
      await withTimeout(Promise.allSettled([...pending]).then(() => undefined), drainMs);
    } catch {
      // Abandon unfinished body reads; do not block page fixture teardown.
    }
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
