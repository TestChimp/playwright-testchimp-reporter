/**
 * @testchimp/playwright
 *
 * Playwright reporter for TestChimp test execution tracking and coverage reporting.
 *
 * @example
 * // playwright.config.ts
 * import { defineConfig } from '@playwright/test';
 *
 * export default defineConfig({
 *   reporter: [
 *     ['list'],
 *     ['@testchimp/playwright/reporter', {
 *       verbose: true,
 *       reportOnlyFinalAttempt: true,
 *       captureScreenshots: true
 *     }]
 *   ]
 * });
 *
 * Environment Variables:
 * - TESTCHIMP_API_KEY (required for backend calls): resolves project + organization server-side
 * - TESTCHIMP_PROJECT_ID (optional): only when not inferable from API key (legacy paths)
 * - TESTCHIMP_BACKEND_URL (optional): Featureservice base URL (defaults used by reporter)
 * - TESTCHIMP_TESTS_FOLDER (optional): Base folder for relative path calculation
 * - TESTCHIMP_RELEASE (optional): Release/version identifier
 * - TESTCHIMP_ENV (optional): Environment name (e.g., staging, prod)
 * Runtime (`@testchimp/playwright/runtime`): use `installTrueCoverage` or `installTestChimp` (same behavior).
 * Platform is read from Mobilewright `projects[].use.platform` (`ios`/`android`); omitted means web (`page` fixture).
 * Pass `{ uiFixture: 'screen' }` when wrapping `@mobilewright/test`; default `page` for `@playwright/test`.
 * Mobile TrueCoverage: `use.platform` ios/android + TestChimpRum URL handler; see README. `installTestChimp` extends **`device`** so **`SET`** runs after Mobilewright **`launchApp`**. Optional **`TESTCHIMP_RUM_TRANSPORT_RESYNC=0`** disables automatic `v1/set` after likely transport failures on mobile `screen` calls. **`TESTCHIMP_RUM_AUTOMATION_CLEAR_BETWEEN_TESTS=1`** opts in to legacy `/v1/clear` before each test `SET` in the **`device`** fixture (default off). **`TESTCHIMP_RUM_AUTOMATION_SUITE_TEARDOWN_CLEAR=1`** opts in to `afterAll` `clear`+`flush` after each spec file (default off).
 * ExploreChimp: set `EXPLORECHIMP_ENABLED=true`, use `test('…', async ({ markScreenState }) => …)`; `TESTCHIMP_BATCH_INVOCATION_ID`, sources/regex envs as documented in the runtime module. Set **`TESTCHIMP_BRANCH_NAME`** (or `TESTCHIMP_BRANCH`) locally so analyze requests send `branchName` and the server can persist `branch_id`.
 * Suite batch id: the reporter writes `.testchimp-batch-invocation-id` under the Playwright project root at run start (when unset, generates a UUID) and removes it at run end so ExploreChimp fixtures and CI stay aligned.
 */

export { TestChimpReporter } from './testchimp-reporter';
export { TestChimpApiClient } from './api-client';
export * from './types';
export * from './utils';
export { buildCiTestInfoJson, buildCiTestInfoObject, type CiTestInfo, type TestInfoForCi } from './ci-test-info';
export {
  attachMobileRumAutomationHooks,
  buildAutomationSetOpenUrl,
  clearBetweenTestsEnabled,
  suiteTeardownClearEnabled,
  extendMobileTestWithTrueCoverageDevice,
  getMobileRumAutomationUrls,
  isLikelyMobileTransportFailure,
  resyncTrueCoverageSetForCurrentTest,
  transportResyncDisabled,
  type MobileDeviceWorkerFixtures,
  type MobileRumAutomationUrls,
} from './rum-automation-mobile';
export {
  attachMobileScreenTransportResync,
  wrapScreenForTransportResync,
} from './mobile-screen-transport-resync';
/** ExploreChimp / agents.proto JSON mirrors (camelCase). */
export type * from './explorechimp/agents-explorechimp-json';
export { DataSourceEnum } from './explorechimp/agents-explorechimp-json';

// Default export for Playwright reporter configuration
import { TestChimpReporter } from './testchimp-reporter';
export default TestChimpReporter;
