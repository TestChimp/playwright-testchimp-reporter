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

export interface MobileRumAutomationUrls {
  setUrlPrefix: string;
  clearUrl: string;
  flushUrl: string;
}

/** Mobilewright worker fixtures used by TrueCoverage hooks (`device` absent in non-mobile projects, e.g. setup). */
type MobileDeviceWorkerFixtures = {
  device?: {
    openUrl: (url: string) => Promise<void>;
    launchApp?: (bundleId: string) => Promise<void>;
  } | null;
  bundleId?: string;
};

type MobileDeviceNonNull = NonNullable<MobileDeviceWorkerFixtures['device']>;

/**
 * URL prefix and clear URL for Mobilewright TrueCoverage (`device.openUrl`).
 * Optional overrides: `TESTCHIMP_RUM_AUTOMATION_SET_PREFIX`, `TESTCHIMP_RUM_AUTOMATION_CLEAR_URL`,
 * `TESTCHIMP_RUM_AUTOMATION_FLUSH_URL`.
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

async function openUrlAutomationWithRetries(device: MobileDeviceNonNull, url: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < SET_OPEN_URL_MAX_ATTEMPTS; attempt++) {
    try {
      await device.openUrl(url);
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
 * Register `beforeEach` / `afterEach` on the given Playwright `TestType` to push CI JSON into the app via
 * `device.openUrl` (mobilecli `device.url`). Used when `TESTCHIMP_PROJECT_TYPE` is `ios`/`android`.
 *
 * Each test's `beforeEach` clears prior CI, optionally `launchApp`, then sends one or more `set` URLs and
 * a short settle delay so the app can apply CI before steps run. `afterEach` sends one more `set` for the
 * same test (helps late emits / async tails), then `testchimp-rum://truecoverage/v1/flush` so buffered RUM
 * uploads before the next test's `clear` (short runs vs the SDK timer flush).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function attachMobileRumAutomationHooks(testType: any): any {
  const { setUrlPrefix, clearUrl, flushUrl } = getMobileRumAutomationUrls();

  testType.beforeEach(async ({ device, bundleId }: MobileDeviceWorkerFixtures, testInfo: TestInfoForCi) => {
    if (!device || typeof device.openUrl !== 'function') {
      return;
    }
    try {
      await device.openUrl(clearUrl);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[TestChimp] TrueCoverage device.openUrl(clear-before-set) failed (non-fatal): ${msg}`);
    }
    let launchedApp = false;
    const bid = typeof bundleId === 'string' && bundleId.trim() !== '' ? bundleId.trim() : undefined;
    if (bid != null && typeof device.launchApp === 'function') {
      try {
        await device.launchApp(bid);
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
    await pushTrueCoverageSetForCurrentTest(device, testInfo, setUrlPrefix, 1);
    await openUrlAutomationWithRetries(device, flushUrl);
  });

  return testType;
}
