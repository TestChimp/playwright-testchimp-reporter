/**
 * TestChimp Playwright runtime: TrueCoverage CI metadata (`installTrueCoverage` / `installTestChimp`) and,
 * when `EXPLORECHIMP_ENABLED`, ExploreChimp local analytics (same installs — no separate ExploreChimp install).
 *
 * Prefer `installTrueCoverage(mergedTest)` (or `installTestChimp`) on the same `test` object your specs use.
 * Screen/state markers: `test('…', async ({ markScreenState }) => { await markScreenState('Screen', 'state'); })`.
 * The same `markScreenState` fixture records a runner `test.step` when ExploreChimp is off, and runs ExploreChimp analytics when it is on.
 * Side-effect `import '@testchimp/playwright/runtime'` registers on the active test runtime:
 * default `@playwright/test`, or `@mobilewright/test` when `TESTCHIMP_PROJECT_TYPE=ios|android`.
 *
 * Mobile TrueCoverage: when `TESTCHIMP_PROJECT_TYPE` is `ios`/`android`, hooks call `device.openUrl` to push CI JSON; integrate TestChimpRum (iOS/Android) URL handling in the app. By default, **`/v1/clear` is not sent** before each test (avoids a clear→set gap with null `ci-test-info` on RUM); each test still `SET`s CI, then `afterEach` runs `v1/flush`. Optional **`TESTCHIMP_RUM_AUTOMATION_SUITE_TEARDOWN_CLEAR=1`** registers `afterAll` to send `clear`+`flush` after the spec file. When the fixture key is `screen`, the `screen` object is proxied so likely WebSocket/mobilecli transport failures trigger an extra `v1/set` resync (disable with `TESTCHIMP_RUM_TRANSPORT_RESYNC=0`). Opt in to legacy clear-before-each-test with `TESTCHIMP_RUM_AUTOMATION_CLEAR_BETWEEN_TESTS=1`.
 */

import * as path from 'path';
import { createRequire } from 'module';
import { buildCiTestInfoJson } from './ci-test-info';
import {
  applyExploreChimpFixture,
  runExploreChimpMarkScreenState,
  isExploreChimpEnabled,
} from './explorechimp';
import { getFixtureKey, getTestRuntimeModuleName, isMobileProjectType } from './project-type';
import { attachMobileScreenTransportResync } from './mobile-screen-transport-resync';
import { attachMobileRumAutomationHooks } from './rum-automation-mobile';

/** Resolve test runtime module from the consumer project (web: Playwright, mobile: Mobilewright). */
const pwRequire = createRequire(path.join(process.cwd(), 'package.json'));
const fixtureKey = getFixtureKey();
const mobileProject = isMobileProjectType();
const runtimeModuleName = getTestRuntimeModuleName();

/** Bound screen/state marker from the `markScreenState` Playwright fixture. */
export type MarkScreenStateFixture = (screenName: string, stateName?: string) => Promise<void>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addMarkScreenStateFixture(test: any): any {
  // Playwright 1.59+ requires the fixture worker's first parameter to use object destructuring
  // (e.g. `{ page }`), not a single positional `fixtures` object.
  const buildMarkFn = (fixtureTarget: unknown): MarkScreenStateFixture => {
    return async (screenName: string, stateName?: string) => {
      if (isExploreChimpEnabled()) {
        try {
          await runExploreChimpMarkScreenState(fixtureTarget, screenName, stateName);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.warn(`[TestChimp] ExploreChimp markScreenState failed (non-fatal): ${msg}`);
          try {
            await runTraceOnlyMarkScreenState(screenName, stateName);
          } catch {
            // Trace step is best-effort; never fail the test for analytics.
          }
        }
      } else {
        await runTraceOnlyMarkScreenState(screenName, stateName);
      }
    };
  };

  if (fixtureKey === 'screen') {
    return test.extend({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      markScreenState: async ({ screen }: { screen: unknown }, use: any) => {
        await use(buildMarkFn(screen));
      },
    });
  }

  return test.extend({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markScreenState: async ({ page }: { page: unknown }, use: any) => {
      await use(buildMarkFn(page));
    },
  });
}

/**
 * Register TrueCoverage CI metadata injection on the given Playwright `test` object
 * (including `mergeTests(...)` output). When `EXPLORECHIMP_ENABLED`, also applies ExploreChimp page wiring.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installTrueCoverage(test: any): any {
  const withCi = mobileProject
    ? test
    : test.extend({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        page: async ({ page }: { page: any }, use: any, testInfo: any) => {
          const project = testInfo.project as { rootDir?: string };
          const projectRootDir = project.rootDir ?? process.cwd();
          const jsonString = buildCiTestInfoJson(testInfo, projectRootDir);

          await page.addInitScript(
            (info: string) => {
              (globalThis as unknown as { __TC_CI_TEST_INFO?: string }).__TC_CI_TEST_INFO = info;
            },
            jsonString
          );

          try {
            await page.evaluate((info: string) => {
              (globalThis as unknown as { __TC_CI_TEST_INFO?: string }).__TC_CI_TEST_INFO = info;
            }, jsonString);
          } catch {
            // Ignore: page may be closed or not ready yet.
          }

          await use(page);
        },
      });

  const withMark = addMarkScreenStateFixture(withCi);
  let chain: typeof withMark = withMark;
  if (isExploreChimpEnabled()) {
    chain = applyExploreChimpFixture(withMark);
  }
  if (mobileProject) {
    chain = attachMobileRumAutomationHooks(chain);
    if (fixtureKey === 'screen') {
      chain = attachMobileScreenTransportResync(chain);
    }
  }
  return chain;
}

/** Same behavior as {@link installTrueCoverage} — umbrella name for TrueCoverage + ExploreChimp (via env). */
export const installTestChimp = installTrueCoverage;

export { isExploreChimpEnabled };

const DEFAULT_SCREEN_STATE = 'default';

/** Trace-only marker: Playwright `test.step` + console (ExploreChimp-off path for the fixture). */
async function runTraceOnlyMarkScreenState(screenName: string, stateName?: string): Promise<void> {
  const screen = String(screenName ?? '').trim();
  if (!screen) {
    return;
  }
  const state =
    stateName != null && String(stateName).trim() !== ''
      ? String(stateName).trim()
      : DEFAULT_SCREEN_STATE;
  const title = `ScreenState: ${screen} | ${state}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { test } = pwRequire(runtimeModuleName) as any;
  await test.step(title, async () => {
    // eslint-disable-next-line no-console
    console.log(`reached ${screen} | ${state}`);
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { test: rootTest } = pwRequire(runtimeModuleName) as any;

installTrueCoverage(rootTest);
