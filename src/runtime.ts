/**
 * TestChimp Playwright runtime: TrueCoverage CI metadata (`installTrueCoverage` / `installTestChimp`) and,
 * when `EXPLORECHIMP_ENABLED`, ExploreChimp local analytics (same installs — no separate ExploreChimp install).
 *
 * Platform branching uses Mobilewright `projects[].use.platform` (ios/android). When omitted, web behaviour applies.
 * Pass `{ uiFixture: 'screen' }` when wrapping `@mobilewright/test`; default `page` for `@playwright/test`.
 */

import * as path from 'path';
import { createRequire } from 'module';
import { buildCiTestInfoJson } from './ci-test-info';
import {
  applyExploreChimpFixture,
  runExploreChimpMarkScreenState,
  isExploreChimpEnabled,
} from './explorechimp';
import { isMobilePlatform, platformFromTestInfo, type FixtureKey } from './project-type';
import { attachMobileScreenTransportResync } from './mobile-screen-transport-resync';
import {
  attachMobileRumAutomationHooks,
  extendMobileTestWithTrueCoverageDevice,
} from './rum-automation-mobile';

const pwRequire = createRequire(path.join(process.cwd(), 'package.json'));

/** Bound screen/state marker from the `markScreenState` Playwright fixture. */
export type MarkScreenStateFixture = (screenName: string, stateName?: string) => Promise<void>;

export type InstallTestChimpOptions = {
  /** `screen` for `@mobilewright/test` barrels; `page` for `@playwright/test` (default). */
  uiFixture?: FixtureKey;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extendWebTrueCoveragePage(test: any): any {
  return test.extend({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    page: async ({ page }: { page: any }, use: any, testInfo: any) => {
      if (isMobilePlatform(platformFromTestInfo(testInfo))) {
        await use(page);
        return;
      }

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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addMarkScreenStateFixture(test: any, uiFixture: FixtureKey): any {
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

  if (uiFixture === 'screen') {
    return test.extend({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      markScreenState: async ({ screen }: { screen: unknown }, use: any, testInfo: any) => {
        const platform = platformFromTestInfo(testInfo);
        if (!isMobilePlatform(platform)) {
          await use(buildMarkFn(undefined));
          return;
        }
        if (screen === undefined) {
          throw new Error(
            '[TestChimp] Missing "screen" fixture. Use @mobilewright/test in fixtures/index.js and set projects[].use.platform to ios or android on mobile UI projects.'
          );
        }
        await use(buildMarkFn(screen));
      },
    });
  }

  return test.extend({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markScreenState: async ({ page }: { page: unknown }, use: any, testInfo: any) => {
      const platform = platformFromTestInfo(testInfo);
      if (isMobilePlatform(platform)) {
        await use(buildMarkFn(undefined));
        return;
      }
      if (page === undefined) {
        throw new Error(
          '[TestChimp] Missing "page" fixture. Use @playwright/test in fixtures/index.js for web and API specs.'
        );
      }
      await use(buildMarkFn(page));
    },
  });
}

/**
 * Register TrueCoverage CI metadata injection on the given Playwright `test` object
 * (including `mergeTests(...)` output). When `EXPLORECHIMP_ENABLED`, also applies ExploreChimp wiring.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installTrueCoverage(test: any, options: InstallTestChimpOptions = {}): any {
  const uiFixture = options.uiFixture ?? 'page';

  // Web (@playwright/test): only extend `page` + optional ExploreChimp — never touch `device` / mobile hooks.
  let chain = test;
  if (uiFixture === 'screen') {
    chain = extendMobileTestWithTrueCoverageDevice(chain);
  }
  if (uiFixture === 'page') {
    chain = extendWebTrueCoveragePage(chain);
  }

  const withMark = addMarkScreenStateFixture(chain, uiFixture);
  let result: typeof withMark = withMark;

  if (isExploreChimpEnabled()) {
    result = applyExploreChimpFixture(withMark, uiFixture);
  }

  if (uiFixture === 'screen') {
    result = attachMobileRumAutomationHooks(result);
    result = attachMobileScreenTransportResync(result);
  }

  return result;
}

/** Same behaviour as {@link installTrueCoverage} — umbrella name for TrueCoverage + ExploreChimp (via env). */
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
  const { test } = pwRequire('@playwright/test') as any;
  await test.step(title, async () => {
    // eslint-disable-next-line no-console
    console.log(`reached ${screen} | ${state}`);
  });
}
