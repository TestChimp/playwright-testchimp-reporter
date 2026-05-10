import { buildCiTestInfoJson, type TestInfoForCi } from './ci-test-info';

const DEFAULT_SET_PREFIX = 'testchimp-rum://truecoverage/v1/set?p=';
const DEFAULT_CLEAR_URL = 'testchimp-rum://truecoverage/v1/clear';

/** Max length for the full openUrl string (conservative for iOS). */
const MAX_OPEN_URL_CHARS = 8000;

export interface MobileRumAutomationUrls {
  setUrlPrefix: string;
  clearUrl: string;
}

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

let warnedMobileAutomationOnce = false;

/**
 * Register `beforeEach` / `afterEach` on the given Playwright `TestType` to push CI JSON into the app via
 * `device.openUrl` (mobilecli `device.url`). Used when `TESTCHIMP_PROJECT_TYPE` is `ios`/`android`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function attachMobileRumAutomationHooks(testType: any): any {
  const { setUrlPrefix, clearUrl } = getMobileRumAutomationUrls();

  testType.beforeEach(
    async (
      { device }: { device: { openUrl: (url: string) => Promise<void> } },
      testInfo: TestInfoForCi
    ) => {
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
      try {
        await device.openUrl(built);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[TestChimp] TrueCoverage device.openUrl(set) failed (non-fatal): ${msg}`);
      }
    }
  );

  testType.afterEach(
    async ({ device }: { device: { openUrl: (url: string) => Promise<void> } }) => {
      try {
        await device.openUrl(clearUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[TestChimp] TrueCoverage device.openUrl(clear) failed (non-fatal): ${msg}`);
      }
    }
  );

  return testType;
}
