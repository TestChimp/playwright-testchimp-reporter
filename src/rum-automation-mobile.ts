import { buildCiTestInfoJson, type TestInfoForCi } from './ci-test-info';

const DEFAULT_SET_PREFIX = 'testchimp-rum://truecoverage/v1/set?p=';
const DEFAULT_CLEAR_URL = 'testchimp-rum://truecoverage/v1/clear';

/** Max length for the full openUrl string (conservative for iOS). */
const MAX_OPEN_URL_CHARS = 8000;

const SET_OPEN_URL_MAX_ATTEMPTS = 3;
const SET_OPEN_URL_RETRY_DELAY_MS = 400;
const SET_AFTER_LAUNCH_REPEAT_COUNT = 2;
const SET_AFTER_LAUNCH_REPEAT_DELAY_MS = 300;

export interface MobileRumAutomationUrls {
  setUrlPrefix: string;
  clearUrl: string;
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
 * Optional overrides: `TESTCHIMP_RUM_AUTOMATION_SET_PREFIX`, `TESTCHIMP_RUM_AUTOMATION_CLEAR_URL`.
 */
export function getMobileRumAutomationUrls(): MobileRumAutomationUrls {
  return {
    setUrlPrefix: process.env.TESTCHIMP_RUM_AUTOMATION_SET_PREFIX?.trim() || DEFAULT_SET_PREFIX,
    clearUrl: process.env.TESTCHIMP_RUM_AUTOMATION_CLEAR_URL?.trim() || DEFAULT_CLEAR_URL,
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

async function openUrlSetWithRetries(device: MobileDeviceNonNull, url: string): Promise<void> {
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
    `[TestChimp] TrueCoverage device.openUrl(set) failed after ${SET_OPEN_URL_MAX_ATTEMPTS} attempts (non-fatal): ${msg}`
  );
}

async function pushSetUrlWithPostLaunchRepeat(
  device: MobileDeviceNonNull,
  url: string,
  repeats: number
): Promise<void> {
  const total = Math.max(1, repeats);
  for (let i = 0; i < total; i++) {
    await openUrlSetWithRetries(device, url);
    if (i < total - 1) {
      await sleep(SET_AFTER_LAUNCH_REPEAT_DELAY_MS);
    }
  }
}

let warnedMobileAutomationOnce = false;

/**
 * Register `beforeEach` / `afterEach` on the given Playwright `TestType` to push CI JSON into the app via
 * `device.openUrl` (mobilecli `device.url`). Used when `TESTCHIMP_PROJECT_TYPE` is `ios`/`android`.
 *
 * Each test's `beforeEach` builds `ci_test_info` from **that** run's `testInfo`, optionally foregrounds the
 * app with `device.launchApp(bundleId)` when both are available, then opens the set URL. `afterEach`
 * clears automation context via the clear URL so the next test receives a fresh set payload.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function attachMobileRumAutomationHooks(testType: any): any {
  const { setUrlPrefix, clearUrl } = getMobileRumAutomationUrls();

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
      return;
    }
    const repeats = launchedApp ? SET_AFTER_LAUNCH_REPEAT_COUNT : 1;
    await pushSetUrlWithPostLaunchRepeat(device, built, repeats);
  });

  return testType;
}
