/**
 * ExploreChimp local runs (when `EXPLORECHIMP_ENABLED`): page instrumentation + analyze API via Featureservice.
 * Wired automatically by `installTrueCoverage` / `installTestChimp` — do not import this module from app code.
 * With ExploreChimp on, call markers via the Playwright fixture: `test('…', async ({ markScreenState }) => { … })`.
 * Env: TESTCHIMP_BACKEND_URL, TESTCHIMP_API_KEY, TESTCHIMP_BATCH_INVOCATION_ID (exploration id).
 * Branch for analyze payloads: every `POST .../analyze_explorechimp_data_sources` body includes `branchName`
 * from {@link getBranchName} — set **`TESTCHIMP_BRANCH_NAME`** (preferred) or **`TESTCHIMP_BRANCH`** locally so
 * the server can resolve `branch_id` on explorations and bugs (CI git envs are used when unset).
 * Optional: EXPLORECHIMP_SOURCES_TO_ANALYZE, EXPLORECHIMP_REQUEST_REGEX_TO_ANALYZE (required when NETWORK is listed),
 * EXPLORECHIMP_LONG_TASK_THRESHOLD_MS (default 50; matches scriptservice watcher long-task gate).
 * DOM/axe payload caps: EXPLORECHIMP_DOM_MAX_CHARS (default 32000), EXPLORECHIMP_AXE_MAX_VIOLATIONS (default 25),
 * EXPLORECHIMP_AXE_MAX_NODES_PER_VIOLATION (default 8).
 */

import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import { createHash } from 'crypto';
import { createRequire } from 'module';
import path from 'path';
import {
  getBranchName,
  readTestChimpBatchInvocationId,
  derivePathsFromTestInfo,
  deriveTestsFolder,
  resolveManifestEntryFromRuntime,
  loadJobManifestEntries,
  stableExploreChimpAnalyticsStepId,
  stableJourneyExecutionId,
} from '../utils';
import {
  collectMetricsSince,
  installExploreChimpPerfMetricsObservers,
  parseExploreChimpLongTaskThresholdMs,
  resetExploreChimpPerfMetricsBuffers,
} from './perf-metrics';
import {
  DataSourceEnum,
  type AnalyzeDataSourcesRequest,
  type ApiRequestItemReference,
  type ApiRequestReference,
  type ApiRequestsPayload,
  type ArtifactInteractionLatencyBreakdown,
  type ArtifactReference,
  type AxeViolationReference,
  type Bug,
  type ConsoleLogEntry,
  type ConsoleLogReference,
  type ConsoleLogsPayload,
  type DomElementReference,
  type DomSnapshotPayload,
  type ExploreChimpStepArtifactPayload,
  type LayoutShiftElement,
  type MetricsPayload,
  type MetricsReference,
  type RequestResponsePair,
  type ScreenshotReference,
  type TrimmedHtmlElement,
} from './agents-explorechimp-json';
import { cleanHtml } from './clean-html';
import { compactAxeResultsForUpload } from './axe-compact';
import { registerExploreChimpAnalyticsStepScreenState } from './analytics-step-screen-state-registry';
import {
  isMobilePlatform,
  platformFromTestInfo,
  type FixtureKey,
  type RunPlatform,
} from '../project-type';
import { ExecutionPlatform, runPlatformToExecutionPlatform } from '../execution-context';

export { DataSourceEnum };
export type {
  AnalyzeDataSourcesRequest,
  ApiRequestItemReference,
  ApiRequestReference,
  ApiRequestsPayload,
  ArtifactInteractionLatencyBreakdown,
  ArtifactReference,
  AxeViolationReference,
  Bug,
  BoundingBox,
  ConsoleLogEntry,
  ConsoleLogReference,
  ConsoleLogsPayload,
  DataSource,
  DomElementReference,
  DomSnapshotPayload,
  ExploreChimpStepArtifactPayload,
  InteractionLatencyEntry,
  LayoutShiftElement,
  LongTaskDetail,
  MetricsPayload,
  MetricsReference,
  RequestResponsePair,
  ResourceTimingEntry,
  ScreenState,
  ScreenshotReference,
  TrimmedHtmlElement,
} from './agents-explorechimp-json';

const pwRequire = createRequire(path.join(process.cwd(), 'package.json'));

function testRuntimeModuleForPlatform(platform: RunPlatform): string {
  return isMobilePlatform(platform) ? '@mobilewright/test' : '@playwright/test';
}

const K_META = '__testchimpExploreChimpMeta';
const K_BUF = '__testchimpExploreChimpBuffers';
const K_HOOKED = '__testchimpExploreChimpHooked';

type ExploreChimpTarget = Record<string, unknown> & {
  on?: (event: string, cb: (...args: any[]) => void) => void;
  screenshot?: (opts?: Record<string, unknown>) => Promise<Buffer>;
  waitForLoadState?: (state: string, opts?: Record<string, unknown>) => Promise<void>;
  content?: () => Promise<string>;
  addInitScript?: (...args: any[]) => Promise<void>;
  evaluate?: <T, A = unknown>(fn: (arg: A) => T, arg: A) => Promise<T>;
};
type PageAugmented = ExploreChimpTarget & Record<string, unknown>;

export interface ExploreChimpPageMeta {
  journeyExecutionId: string;
  journeyId: string;
  testId: string;
  /** Ingest-aligned tuple; featureservice resolves backend SmartTest id (see agents.proto resolution_*). */
  analyzeResolutionPayload: {
    resolutionFolderPath: string;
    resolutionFileName: string;
    resolutionSuitePath: string[];
    resolutionTestName: string;
  };
  /** Playwright testInfo.retry — used with testId for stable analytics step ids. */
  testRetry: number;
  projectRootDir: string;
  /** From `testInfo.project.use.platform` (ios/android) or web when omitted. */
  platform: RunPlatform;
}

function exploreChimpAnalyticsStepId(meta: ExploreChimpPageMeta, stepTitle: string): string {
  return stableExploreChimpAnalyticsStepId(meta.testId, meta.testRetry, stepTitle);
}

interface ConsoleRow {
  type: string;
  text: string;
  timestamp: number;
}

interface NetworkRow {
  url: string;
  method: string;
  status: number;
  responseTimeMs: number;
  timestamp: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
}

interface BufferState {
  consoleRows: ConsoleRow[];
  networkRows: NetworkRow[];
  priorMarkedScreen: { name: string; state: string } | null;
  /** Wall-clock start of the interval attributed to the *prior* screen-state (scriptservice `metricsCollectionStartTimestamp`). */
  metricsIntervalSinceMs: number;
}

const MAX_CONSOLE = 60;
const MAX_CONSOLE_MSG = 600;
const MAX_NETWORK_ROWS = 35;

export function isExploreChimpEnabled(): boolean {
  const v = process.env.EXPLORECHIMP_ENABLED;
  return v === '1' || v === 'true' || v === 'TRUE';
}

export function parseExploreChimpSources(): Set<string> {
  const raw = process.env.EXPLORECHIMP_SOURCES_TO_ANALYZE?.trim();
  if (!raw) {
    return new Set(['DOM', 'SCREENSHOT', 'CONSOLE', 'NETWORK', 'METRICS']);
  }
  return new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
}

function parseNetworkRegex(): RegExp | null {
  const raw = process.env.EXPLORECHIMP_REQUEST_REGEX_TO_ANALYZE?.trim();
  if (!raw) return null;
  try {
    return new RegExp(raw);
  } catch {
    console.warn(`[ExploreChimp] Invalid EXPLORECHIMP_REQUEST_REGEX_TO_ANALYZE — ignoring`);
    return null;
  }
}

function createBackendClient(): AxiosInstance {
  const backendUrl =
    process.env.TESTCHIMP_BACKEND_URL?.trim() || 'https://featureservice.testchimp.io';
  const apiKey = process.env.TESTCHIMP_API_KEY?.trim() || '';
  return axios.create({
    baseURL: backendUrl.replace(/\/+$/, ''),
    headers: {
      'Content-Type': 'application/json',
      'testchimp-api-key': apiKey,
    },
    timeout: 120000,
  });
}

async function uploadScreenshot(client: AxiosInstance, buffer: Buffer): Promise<string> {
  const form = new FormData();
  form.append('file', buffer, { filename: 'explorechimp.jpg', contentType: 'image/jpeg' });
  const response = await client.post('/api/upload_attachment', form, {
    headers: {
      ...form.getHeaders(),
    },
    timeout: 120000,
  });
  const gcpPath = (response.data as { gcpPath?: string })?.gcpPath;
  if (!gcpPath) {
    throw new Error('[ExploreChimp] upload_attachment missing gcpPath');
  }
  return gcpPath;
}

function platformForAnalyze(meta: ExploreChimpPageMeta | undefined): ExecutionPlatform {
  return runPlatformToExecutionPlatform(meta?.platform ?? 'web');
}

async function postAnalyze(
  client: AxiosInstance,
  body: AnalyzeDataSourcesRequest,
  meta?: ExploreChimpPageMeta
): Promise<void> {
  await client.post('/smart-test/analyze_explorechimp_data_sources', {
    ...body,
    platform: platformForAnalyze(meta),
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function headersToRecord(headers: { [name: string]: string }): Record<string, string> {
  const out: Record<string, string> = {};
  const allowReq = new Set([
    'content-type',
    'authorization',
    'cookie',
    'user-agent',
    'accept',
    'referer',
    'origin',
  ]);
  const allowRes = new Set([
    'content-type',
    'cache-control',
    'x-frame-options',
    'content-security-policy',
  ]);
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (allowReq.has(lk) || allowRes.has(lk)) {
      out[k] = lk === 'authorization' ? '[REDACTED]' : truncate(String(v), 500);
    }
  }
  return out;
}

function buildConsoleLogsPayload(rows: ConsoleRow[]): ConsoleLogsPayload {
  const consoleLogs: Record<string, ConsoleLogEntry> = {};
  const slice = rows.slice(-MAX_CONSOLE);
  slice.forEach((r, i) => {
    consoleLogs[String(i)] = {
      type: r.type,
      text: truncate(r.text, MAX_CONSOLE_MSG),
      timestamp: String(Math.trunc(r.timestamp)),
    };
  });
  return { consoleLogs };
}

function buildApiRequestsPayload(rows: NetworkRow[]): ApiRequestsPayload {
  const requests: Record<string, RequestResponsePair> = {};
  rows.slice(-MAX_NETWORK_ROWS).forEach((r, i) => {
    requests[String(i)] = {
      url: truncate(r.url, 2000),
      method: r.method,
      status: r.status,
      responseTimeMs: r.responseTimeMs,
      timestamp: String(Math.trunc(r.timestamp)),
      requestHeaders: r.requestHeaders,
      responseHeaders: r.responseHeaders,
    };
  });
  return { requests };
}

function hashNetworkBatch(rows: NetworkRow[]): string {
  const key = rows
    .map((r) => `${r.method} ${r.url}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(key).digest('hex');
}

function getBuffers(page: ExploreChimpTarget): BufferState {
  const p = page as PageAugmented;
  if (!p[K_BUF]) {
    p[K_BUF] = {
      consoleRows: [],
      networkRows: [],
      priorMarkedScreen: null,
      metricsIntervalSinceMs: Date.now(),
    };
  }
  return p[K_BUF] as BufferState;
}

/** Clears console/network buffers, resets in-page perf buffers (watcher.resetMetrics), advances metrics interval. */
async function resetExploreChimpIntervalBuffers(page: ExploreChimpTarget): Promise<void> {
  const b = getBuffers(page);
  b.consoleRows = [];
  b.networkRows = [];
  await resetExploreChimpPerfMetricsBuffers(page);
  b.metricsIntervalSinceMs = Date.now();
}

export function attachExploreChimpInstrumentation(
  page: ExploreChimpTarget,
  opts: { recordNetwork: boolean; networkRegex: RegExp | null }
): void {
  const p = page as PageAugmented;
  if (p[K_HOOKED]) return;
  p[K_HOOKED] = true;

  if (typeof page.on !== 'function') {
    return;
  }

  const reqStarts = new WeakMap<object, number>();

  if (opts.recordNetwork && opts.networkRegex) {
    const networkRegex = opts.networkRegex;
    page.on('request', (req) => {
      reqStarts.set(req as object, Date.now());
    });

    page.on('response', async (response) => {
      try {
        const req = (response as { request: () => any }).request();
        const url = req.url();
        if (!networkRegex.test(url)) return;
        const start = reqStarts.get(req as object) ?? Date.now();
        const rt = Math.max(0, Date.now() - start);
        const reqHeaders = headersToRecord(req.headers());
        let resHeaders: Record<string, string> = {};
        try {
          resHeaders = headersToRecord(response.headers());
        } catch {
          /* ignore */
        }
        const b = getBuffers(page);
        if (b.networkRows.length >= MAX_NETWORK_ROWS * 2) {
          b.networkRows.splice(0, b.networkRows.length - MAX_NETWORK_ROWS);
        }
        b.networkRows.push({
          url,
          method: req.method(),
          status: response.status(),
          responseTimeMs: rt,
          timestamp: Date.now(),
          requestHeaders: reqHeaders,
          responseHeaders: resHeaders,
        });
      } catch {
        /* ignore */
      }
    });
  }

  page.on('console', (msg) => {
    const b = getBuffers(page);
    b.consoleRows.push({
      type: msg.type(),
      text: truncate(msg.text(), MAX_CONSOLE_MSG),
      timestamp: Date.now(),
    });
    if (b.consoleRows.length > MAX_CONSOLE * 2) {
      b.consoleRows.splice(0, b.consoleRows.length - MAX_CONSOLE);
    }
  });
}

/**
 * Extends Playwright `test` with ExploreChimp page meta + buffers (only when `EXPLORECHIMP_ENABLED`).
 * Used from {@link installTrueCoverage} / {@link installTestChimp}; not required as a separate install.
 *
 * Playwright 1.59+ requires fixture functions to destructure the first argument (e.g. `{ page }`), not `(fixtures, use)`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runExploreChimpPageOrScreenFixture(
  target: ExploreChimpTarget | undefined,
  use: any,
  testInfo: any,
  uiFixture: FixtureKey
): Promise<void> {
  if (!target) {
    throw new Error(
      `[ExploreChimp] Missing "${uiFixture}" fixture. Use installTestChimp with uiFixture matching your runner (@playwright/test → page, @mobilewright/test → screen).`
    );
  }
  const platform = platformFromTestInfo(testInfo);
  if (!isExploreChimpEnabled()) {
    await use(target);
    return;
  }
  const project = testInfo.project as { rootDir?: string };
  const projectRootDir = project.rootDir ?? process.cwd();
  const testsFolder = deriveTestsFolder(projectRootDir);
  const manifest = loadJobManifestEntries(projectRootDir);
  const dp = derivePathsFromTestInfo(
    {
      file: testInfo.file,
      title: testInfo.title,
      titlePath: testInfo.titlePath,
      project: testInfo.project,
    },
    testsFolder,
    projectRootDir
  );
  const resolved = resolveManifestEntryFromRuntime(manifest, {
    folderPath: dp.folderPath,
    fileName: dp.fileName,
    suitePath: dp.suitePath,
    testName: dp.testName,
  });
  const manifestJobId = resolved?.entry.jobId?.trim();
  const batchInvocationId = readTestChimpBatchInvocationId(projectRootDir)?.trim() || '';
  const journeyId = String(testInfo.testId ?? '');
  const retry = typeof testInfo.retry === 'number' ? testInfo.retry : 0;
  const journeyExecutionId =
    manifestJobId ||
    (batchInvocationId && journeyId
      ? stableJourneyExecutionId(journeyId, batchInvocationId, retry)
      : '');
  if (!manifestJobId && process.env.TESTCHIMP_EXECUTION_MODE === 'platform') {
    console.warn(
      '[ExploreChimp] No manifest jobId for this test — set TESTCHIMP_BATCH_INVOCATION_ID or add a manifest entry so journeyExecutionId is stable.'
    );
  }
  if (!journeyExecutionId) {
    console.warn(
      '[ExploreChimp] Missing journeyExecutionId (need manifest jobId or TESTCHIMP_BATCH_INVOCATION_ID + Playwright test id). ExploreChimp backend calls will be skipped.'
    );
  }
  const meta: ExploreChimpPageMeta = {
    journeyExecutionId,
    journeyId,
    testId: String(testInfo.testId ?? ''),
    analyzeResolutionPayload: {
      resolutionFolderPath: dp.folderPath,
      resolutionFileName: dp.fileName,
      resolutionSuitePath: [...dp.suitePath],
      resolutionTestName: dp.testName,
    },
    testRetry: typeof testInfo.retry === 'number' ? testInfo.retry : 0,
    projectRootDir,
    platform,
  };
  (target as PageAugmented)[K_META] = meta;

  const sources = parseExploreChimpSources();
  const wantNetwork = sources.has('NETWORK');
  const regex = wantNetwork ? parseNetworkRegex() : null;
  if (wantNetwork && !regex) {
    console.warn(
      '[ExploreChimp] NETWORK listed in EXPLORECHIMP_SOURCES_TO_ANALYZE but EXPLORECHIMP_REQUEST_REGEX_TO_ANALYZE is missing — network capture disabled'
    );
  }
  attachExploreChimpInstrumentation(target, {
    recordNetwork: !!(wantNetwork && regex),
    networkRegex: regex,
  });
  if (sources.has('METRICS') && !isMobilePlatform(platform)) {
    await installExploreChimpPerfMetricsObservers(target, parseExploreChimpLongTaskThresholdMs());
  }

  await use(target);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyExploreChimpFixture(test: any, uiFixture: FixtureKey): any {
  if (uiFixture === 'screen') {
    return test.extend({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      screen: async ({ screen }: { screen: any }, use: any, testInfo: any) => {
        await runExploreChimpPageOrScreenFixture(screen, use, testInfo, uiFixture);
      },
    });
  }
  return test.extend({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page: async ({ page }: { page: any }, use: any, testInfo: any) => {
      await runExploreChimpPageOrScreenFixture(page, use, testInfo, uiFixture);
    },
  });
}

/** @deprecated Use {@link applyExploreChimpFixture} */
export const applyExploreChimpPageFixture = applyExploreChimpFixture;

function getMeta(page: ExploreChimpTarget): ExploreChimpPageMeta | undefined {
  return (page as PageAugmented)[K_META] as ExploreChimpPageMeta | undefined;
}

/**
 * ExploreChimp path for screen markers; invoked by the `markScreenState` fixture (not directly from specs).
 */
export async function runExploreChimpMarkScreenState(
  page: unknown,
  screenName: string,
  stateName?: string
): Promise<void> {
  const target = page as ExploreChimpTarget;
  const screen = String(screenName ?? '').trim();
  if (!screen) return;

  const state =
    stateName != null && String(stateName).trim() !== ''
      ? String(stateName).trim()
      : 'default';

  const sources = parseExploreChimpSources();
  const meta = getMeta(target);
  const platform = meta?.platform ?? 'web';
  const { test } = pwRequire(testRuntimeModuleForPlatform(platform)) as {
    test: { step: (name: string, fn: () => Promise<void>) => Promise<void> };
  };
  const explorationId = readTestChimpBatchInvocationId(meta?.projectRootDir ?? process.cwd());
  const apiKey = process.env.TESTCHIMP_API_KEY?.trim() || '';

  if (!meta || !explorationId || !apiKey) {
    console.warn(
      '[ExploreChimp] Missing ExploreChimp page wiring (installTrueCoverage + EXPLORECHIMP_ENABLED), TESTCHIMP_API_KEY, or TESTCHIMP_BATCH_INVOCATION_ID — skipping backend calls'
    );
    // eslint-disable-next-line no-console
    console.log(`reached ${screen} | ${state}`);
    return;
  }

  await test.step(`ScreenState: ${screen} | ${state}`, async () => {
    if (typeof target.waitForLoadState === 'function') {
      await target.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    }
  });

  const client = createBackendClient();
  const buffers = getBuffers(target);
  const prior = buffers.priorMarkedScreen;
  const current = { name: screen, state };
  /** Same resolution order as execution reports when reporter uses {@link getBranchName} in buildReport. */
  const branchName = getBranchName() ?? '';
  const resolutionFields = meta.analyzeResolutionPayload;

  const wantNetwork = sources.has('NETWORK');
  const regex = wantNetwork ? parseNetworkRegex() : null;

  // --- Prior interval: console, network, metrics (attribute to prior screen-state)
  if (prior) {
    if (sources.has('CONSOLE') && buffers.consoleRows.length > 0) {
      const consoleTitle = `Analyzing Console for Screen-state ${prior.name} | ${prior.state}`;
      const priorScreenState = { name: prior.name, state: prior.state };
      registerExploreChimpAnalyticsStepScreenState(
        exploreChimpAnalyticsStepId(meta, consoleTitle),
        priorScreenState
      );
      await test.step(consoleTitle, async () => {
        await postAnalyze(client, {
          explorationId,
          journeyExecutionId: meta.journeyExecutionId,
          journeyId: meta.journeyId,
          testId: meta.testId,
          ...resolutionFields,
          branchName,
          stepId: exploreChimpAnalyticsStepId(meta, consoleTitle),
          analyzedDataSource: DataSourceEnum.CONSOLE_SOURCE,
          screenState: priorScreenState,
          consoleLogsPayload: buildConsoleLogsPayload(buffers.consoleRows),
          networkRequestHash: '',
        }, meta);
      });
    }

    if (wantNetwork && regex && buffers.networkRows.length > 0) {
      const netRows = buffers.networkRows.filter((r) => regex.test(r.url));
      if (netRows.length > 0) {
        const networkTitle = `Analyzing Network for Screen-state ${prior.name} | ${prior.state}`;
        const hash = hashNetworkBatch(netRows);
        const priorNetScreenState = { name: prior.name, state: prior.state };
        registerExploreChimpAnalyticsStepScreenState(
          exploreChimpAnalyticsStepId(meta, networkTitle),
          priorNetScreenState
        );
        await test.step(networkTitle, async () => {
          await postAnalyze(client, {
            explorationId,
            journeyExecutionId: meta.journeyExecutionId,
            journeyId: meta.journeyId,
            testId: meta.testId,
            ...resolutionFields,
            branchName,
            stepId: exploreChimpAnalyticsStepId(meta, networkTitle),
            analyzedDataSource: DataSourceEnum.NETWORK_SOURCE,
            screenState: priorNetScreenState,
            apiRequestsPayload: buildApiRequestsPayload(netRows),
            networkRequestHash: hash,
          }, meta);
        });
      }
    }

    if (sources.has('METRICS') && meta && !isMobilePlatform(meta.platform)) {
      const metricsTitle = `Analyzing Metrics for Screen-state ${prior.name} | ${prior.state}`;
      let metricsPayload: MetricsPayload | null = null;
      try {
        metricsPayload = await collectMetricsSince(target, buffers.metricsIntervalSinceMs);
      } catch {
        metricsPayload = null;
      }
      if (metricsPayload) {
        const priorMetricsScreenState = { name: prior.name, state: prior.state };
        registerExploreChimpAnalyticsStepScreenState(
          exploreChimpAnalyticsStepId(meta, metricsTitle),
          priorMetricsScreenState
        );
        await test.step(metricsTitle, async () => {
          await postAnalyze(client, {
            explorationId,
            journeyExecutionId: meta.journeyExecutionId,
            journeyId: meta.journeyId,
            testId: meta.testId,
            ...resolutionFields,
            branchName,
            stepId: exploreChimpAnalyticsStepId(meta, metricsTitle),
            analyzedDataSource: DataSourceEnum.METRICS_SOURCE,
            screenState: priorMetricsScreenState,
            metricsPayload,
            networkRequestHash: '',
          }, meta);
        });
      }
    }
  }

  // --- Current screen: screenshot + DOM (DOM + axe = single request, single Playwright step)
  if (sources.has('SCREENSHOT')) {
    const shotTitle = `Analyzing Screenshot for Screen-state ${current.name} | ${current.state}`;
    registerExploreChimpAnalyticsStepScreenState(exploreChimpAnalyticsStepId(meta, shotTitle), current);
    await test.step(shotTitle, async () => {
      if (typeof target.screenshot !== 'function') {
        console.warn('[ExploreChimp] Fixture does not expose screenshot() — skipping screenshot analysis.');
        return;
      }
      const jpeg = await target.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
      const gcpPath = await uploadScreenshot(client, jpeg);
      await postAnalyze(client, {
        explorationId,
        journeyExecutionId: meta.journeyExecutionId,
        journeyId: meta.journeyId,
        testId: meta.testId,
        ...resolutionFields,
        branchName,
        stepId: exploreChimpAnalyticsStepId(meta, shotTitle),
        analyzedDataSource: DataSourceEnum.SCREENSHOT_SOURCE,
        screenState: { name: current.name, state: current.state },
        screenshotPath: gcpPath,
        networkRequestHash: '',
      }, meta);
    });
  }

  if (sources.has('DOM') && meta && !isMobilePlatform(meta.platform)) {
    const domTitle = `Analyzing DOM for Screen-state ${current.name} | ${current.state}`;
    registerExploreChimpAnalyticsStepScreenState(exploreChimpAnalyticsStepId(meta, domTitle), current);
    await test.step(domTitle, async () => {
      let html = '';
      try {
        if (typeof target.content === 'function') {
          html = await target.content();
        }
      } catch {
        html = '';
      }
      if (!html) {
        return;
      }
      const { default: AxeBuilder } = await import('@axe-core/playwright');
      const axeResults = await new AxeBuilder({ page: target as never }).analyze();
      const domMaxParsed = Number.parseInt(process.env.EXPLORECHIMP_DOM_MAX_CHARS?.trim() || '', 10);
      const domMax =
        Number.isFinite(domMaxParsed) && domMaxParsed > 0 ? domMaxParsed : 32000;
      const snapshot = cleanHtml(html, domMax);
      const axeResultsJson = compactAxeResultsForUpload(axeResults);
      const domSnapshotPayload: DomSnapshotPayload = { snapshot };
      await postAnalyze(client, {
        explorationId,
        journeyExecutionId: meta.journeyExecutionId,
        journeyId: meta.journeyId,
        testId: meta.testId,
        ...resolutionFields,
        branchName,
        stepId: exploreChimpAnalyticsStepId(meta, domTitle),
        analyzedDataSource: DataSourceEnum.DOM_SOURCE,
        screenState: { name: current.name, state: current.state },
        domSnapshotPayload,
        axeResultsJson,
        networkRequestHash: '',
      }, meta);
    });
  }

  buffers.priorMarkedScreen = current;
  await resetExploreChimpIntervalBuffers(target);
}
