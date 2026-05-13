import { buildCiTestInfoJson, type TestInfoForCi } from './ci-test-info';

const DEFAULT_SET_PREFIX = 'testchimp-rum://truecoverage/v1/set?p=';
const DEFAULT_CLEAR_URL = 'testchimp-rum://truecoverage/v1/clear';
const DEFAULT_FLUSH_URL = 'testchimp-rum://truecoverage/v1/flush';

/** Max length for the full openUrl string (conservative for iOS). */
const MAX_OPEN_URL_CHARS = 8000;

const SET_OPEN_URL_MAX_ATTEMPTS = 3;
const SET_OPEN_URL_RETRY_DELAY_MS = 400;
/** Extra `set` bursts after `launchApp` so CI is applied before UI steps (reduces null ci_test_info from early emits). */
const SET_AFTER_LAUNCH_REPEAT_COUNT = 4;
const SET_AFTER_LAUNCH_REPEAT_DELAY_MS = 120;

/** Optional pause (ms) after the last `set` so the app can process the VIEW intent before the next Playwright step. */
function resolvePostSetSettleMs(): number {
  const raw = process.env.TESTCHIMP_RUM_AUTOMATION_POST_SET_SETTLE_MS;
  if (raw === undefined || raw === '') return 100;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return 100;
  return Math.max(0, Math.min(500, n));
}

/** Per-call cap for `device.openUrl` / `device.launchApp` so a wedged driver does not burn the whole test timeout. */
function resolveOpenUrlTimeoutMs(): number {
  const raw = process.env.TESTCHIMP_RUM_AUTOMATION_OPEN_URL_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 25_000;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return 25_000;
  return Math.max(100, Math.min(120_000, n));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface MobileRumAutomationUrls {
  setUrlPrefix: string;
  clearUrl: string;
  flushUrl: string;
}

/** Mobilewright worker fixtures used by TrueCoverage hooks (`device` absent in non-mobile projects, e.g. setup). */
export type MobileDeviceWorkerFixtures = {
  device?: {
    openUrl: (url: string) => Promise<void>;
    launchApp?: (bundleId: string) => Promise<void>;
  } | null;
  bundleId?: string;
};

type MobileDeviceNonNull = NonNullable<MobileDeviceWorkerFixtures['device']>;

/** Disable automatic TrueCoverage SET after mobilecli/WebSocket transport errors (`TESTCHIMP_RUM_TRANSPORT_RESYNC=0`). */
export function transportResyncDisabled(): boolean {
  return process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC?.trim() === '0';
}

/**
 * When true, each test's `beforeEach` sends `/v1/clear` before `SET` (legacy).
 * Default false: skip clear between tests so the app keeps CI until overwritten by `SET`,
 * avoiding a clear→set gap where RUM emits snapshot nil. Opt in with `TESTCHIMP_RUM_AUTOMATION_CLEAR_BETWEEN_TESTS=1`.
 */
export function clearBetweenTestsEnabled(): boolean {
  const raw = process.env.TESTCHIMP_RUM_AUTOMATION_CLEAR_BETWEEN_TESTS?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * When true, register `afterAll` to send `/v1/clear` then `/v1/flush` after the spec file finishes.
 * Default false: no automatic clear at file end (avoids clearing CI before the next spec file's `SET`,
 * and matches "no clear during suite" unless explicitly opted in).
 * Opt in with `TESTCHIMP_RUM_AUTOMATION_SUITE_TEARDOWN_CLEAR=1`.
 */
export function suiteTeardownClearEnabled(): boolean {
  const raw = process.env.TESTCHIMP_RUM_AUTOMATION_SUITE_TEARDOWN_CLEAR?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/**
 * Heuristic: mobilecli / WebSocket abnormal close or connection drop (e.g. code 1006).
 * Used to re-send TrueCoverage `SET` so the next RUM emit can carry `ci_test_info` again.
 */
export function isLikelyMobileTransportFailure(err: unknown): boolean {
  if (transportResyncDisabled()) return false;
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (m.length === 0) return false;
  const needles = [
    '1006',
    'websocket',
    'connection closed',
    'econnreset',
    'socket hang up',
    'network connection lost',
    'rpc',
    'mobilecli',
  ];
  return needles.some((n) => m.includes(n));
}

/**
 * URL prefix and clear URL for Mobilewright TrueCoverage (`device.openUrl`).
 * Optional overrides: `TESTCHIMP_RUM_AUTOMATION_SET_PREFIX`, `TESTCHIMP_RUM_AUTOMATION_CLEAR_URL`,
 * `TESTCHIMP_RUM_AUTOMATION_FLUSH_URL`, `TESTCHIMP_RUM_AUTOMATION_OPEN_URL_TIMEOUT_MS` (per `openUrl`/`launchApp` call, default 25000, clamp 100–120000),
 * `TESTCHIMP_RUM_AUTOMATION_CLEAR_BETWEEN_TESTS` (default off: no `/v1/clear` before each test; see {@link clearBetweenTestsEnabled}),
 * `TESTCHIMP_RUM_AUTOMATION_SUITE_TEARDOWN_CLEAR` (default off: no `afterAll` clear+flush; see {@link suiteTeardownClearEnabled}).
 */
export function getMobileRumAutomationUrls(): MobileRumAutomationUrls {
  return {
    setUrlPrefix: process.env.TESTCHIMP_RUM_AUTOMATION_SET_PREFIX?.trim() || DEFAULT_SET_PREFIX,
    clearUrl: process.env.TESTCHIMP_RUM_AUTOMATION_CLEAR_URL?.trim() || DEFAULT_CLEAR_URL,
    flushUrl: process.env.TESTCHIMP_RUM_AUTOMATION_FLUSH_URL?.trim() || DEFAULT_FLUSH_URL,
  };
}

export function buildAutomationSetOpenUrl(setUrlPrefix: string, ciJson: string): string | { error: string } {
  const payload = Buffer.from(ciJson, 'utf8').toString('base64url');
  const url = `${setUrlPrefix}${payload}`;
  if (url.length > MAX_OPEN_URL_CHARS) {
    return {
      error: `[TestChimp] TrueCoverage automation URL exceeds ${MAX_OPEN_URL_CHARS} chars (${url.length}); shorten CI metadata paths or raise the limit in the plugin.`,
    };
  }
  return url;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function openUrlOnce(device: MobileDeviceNonNull, url: string): Promise<void> {
  const ms = resolveOpenUrlTimeoutMs();
  await withTimeout(device.openUrl(url), ms, 'TrueCoverage device.openUrl');
}

async function openUrlAutomationWithRetries(device: MobileDeviceNonNull, url: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < SET_OPEN_URL_MAX_ATTEMPTS; attempt++) {
    try {
      await openUrlOnce(device, url);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < SET_OPEN_URL_MAX_ATTEMPTS - 1) {
        await sleep(SET_OPEN_URL_RETRY_DELAY_MS);
      }
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  // eslint-disable-next-line no-console
  console.warn(
    `[TestChimp] TrueCoverage device.openUrl failed after ${SET_OPEN_URL_MAX_ATTEMPTS} attempts (non-fatal): ${msg}`
  );
}

async function pushSetUrlWithPostLaunchRepeat(
  device: MobileDeviceNonNull,
  url: string,
  repeats: number
): Promise<void> {
  const total = Math.max(1, repeats);
  for (let i = 0; i < total; i++) {
    await openUrlAutomationWithRetries(device, url);
    if (i < total - 1) {
      await sleep(SET_AFTER_LAUNCH_REPEAT_DELAY_MS);
    }
  }
}

let warnedMobileAutomationOnce = false;

async function pushTrueCoverageSetForCurrentTest(
  device: MobileDeviceNonNull,
  testInfo: TestInfoForCi,
  setUrlPrefix: string,
  repeatBurst: number
): Promise<boolean> {
  const project = testInfo.project as { rootDir?: string } | undefined;
  const projectRootDir = project?.rootDir ?? process.cwd();
  const ciJson = buildCiTestInfoJson(testInfo, projectRootDir);
  const built = buildAutomationSetOpenUrl(setUrlPrefix, ciJson);
  if (typeof built === 'object' && 'error' in built) {
    if (!warnedMobileAutomationOnce) {
      warnedMobileAutomationOnce = true;
      // eslint-disable-next-line no-console
      console.warn(built.error);
    }
    return false;
  }
  await pushSetUrlWithPostLaunchRepeat(device, built, Math.max(1, repeatBurst));
  return true;
}

/**
 * Re-send a single TrueCoverage `v1/set` for the current test (e.g. after a mobilecli/WebSocket transport drop)
 * so the next RUM emit can attach `ci_test_info` again.
 */
export async function resyncTrueCoverageSetForCurrentTest(
  device: MobileDeviceWorkerFixtures['device'],
  testInfo: TestInfoForCi
): Promise<boolean> {
  if (!device || typeof device.openUrl !== 'function') {
    return false;
  }
  const d = device as MobileDeviceNonNull;
  const { setUrlPrefix } = getMobileRumAutomationUrls();
  return pushTrueCoverageSetForCurrentTest(d, testInfo, setUrlPrefix, 1);
}

/**
 * Register `beforeEach` / `afterEach` (and optionally `afterAll`) on the given Playwright
 * `TestType` to push CI JSON into the app via `device.openUrl` (mobilecli `device.url`).
 * Used when `TESTCHIMP_PROJECT_TYPE` is `ios`/`android`.
 *
 * By default, **`/v1/clear` is not sent** before each test (avoids a clear→set window where RUM emits have no
 * `ci-test-info`). Each `beforeEach` overwrites CI via one or more `SET` URLs. Opt in to legacy clear-first
 * behavior with `TESTCHIMP_RUM_AUTOMATION_CLEAR_BETWEEN_TESTS=1`.
 *
 * `beforeEach`: optionally `launchApp`, then `SET` burst + settle. `afterEach`: trailing `SET` then `flush`.
 * **`afterAll`:** only when `TESTCHIMP_RUM_AUTOMATION_SUITE_TEARDOWN_CLEAR=1`: `clear` + `flush` after the file's tests.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function attachMobileRumAutomationHooks(testType: any): any {
  const { setUrlPrefix, clearUrl, flushUrl } = getMobileRumAutomationUrls();

  testType.beforeEach(async ({ device, bundleId }: MobileDeviceWorkerFixtures, testInfo: TestInfoForCi) => {
    if (!device || typeof device.openUrl !== 'function') {
      return;
    }
    if (clearBetweenTestsEnabled()) {
      await openUrlAutomationWithRetries(device, clearUrl);
    }
    let launchedApp = false;
    const bid = typeof bundleId === 'string' && bundleId.trim() !== '' ? bundleId.trim() : undefined;
    if (bid != null && typeof device.launchApp === 'function') {
      try {
        const ms = resolveOpenUrlTimeoutMs();
        await withTimeout(device.launchApp(bid), ms, 'TrueCoverage device.launchApp');
        launchedApp = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[TestChimp] TrueCoverage device.launchApp failed (non-fatal): ${msg}`);
      }
    }

    const repeatBurst = launchedApp ? SET_AFTER_LAUNCH_REPEAT_COUNT : 1;
    const ok = await pushTrueCoverageSetForCurrentTest(device, testInfo, setUrlPrefix, repeatBurst);
    if (!ok) return;
    const settle = resolvePostSetSettleMs();
    if (settle > 0) {
      await sleep(settle);
    }
  });

  testType.afterEach(async ({ device }: MobileDeviceWorkerFixtures, testInfo: TestInfoForCi) => {
    if (!device || typeof device.openUrl !== 'function') {
      return;
    }
    await resyncTrueCoverageSetForCurrentTest(device, testInfo);
    await openUrlAutomationWithRetries(device, flushUrl);
  });

  if (typeof testType.afterAll === 'function' && suiteTeardownClearEnabled()) {
    testType.afterAll(async ({ device }: MobileDeviceWorkerFixtures) => {
      if (!device || typeof device.openUrl !== 'function') {
        return;
      }
      await openUrlAutomationWithRetries(device, clearUrl);
      await openUrlAutomationWithRetries(device, flushUrl);
    });
  }

  return testType;
}
