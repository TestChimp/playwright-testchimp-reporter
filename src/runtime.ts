/**
 * TestChimp Playwright runtime: TrueCoverage CI metadata (`installTrueCoverage` / `installTestChimp`) and,
 * when `EXPLORECHIMP_ENABLED`, ExploreChimp local analytics (same installs — no separate ExploreChimp install).
 *
 * Prefer `installTrueCoverage(mergedTest)` (or `installTestChimp`) on the same `test` object your specs use.
 * Screen/state markers: `test('…', async ({ markScreenState }) => { await markScreenState('Screen', 'state'); })`.
 * The same `markScreenState` fixture records a runner `test.step` when ExploreChimp is off, and runs ExploreChimp analytics when it is on.
 * Side-effect `import '@testchimp/playwright/runtime'` registers on the active test runtime:
 * default `@playwright/test`, or `mobilewright` when `TESTCHIMP_PROJECT_TYPE=ios|android`.
 */

import * as path from 'path';
import { createRequire } from 'module';
import {
  derivePathsFromTestInfo,
  deriveTestsFolder,
  getBranchName,
  readTestChimpBatchInvocationId,
} from './utils';
import {
  applyExploreChimpFixture,
  runExploreChimpMarkScreenState,
  isExploreChimpEnabled,
} from './explorechimp';
import { getFixtureKey, getTestRuntimeModuleName, isMobileProjectType } from './project-type';

/** Resolve test runtime module from the consumer project (web: Playwright, mobile: Mobilewright). */
const pwRequire = createRequire(path.join(process.cwd(), 'package.json'));
const fixtureKey = getFixtureKey();
const mobileProject = isMobileProjectType();
const runtimeModuleName = getTestRuntimeModuleName();
let warnedTrueCoverageMobileSkip = false;

/** Bound screen/state marker from the `markScreenState` Playwright fixture. */
export type MarkScreenStateFixture = (screenName: string, stateName?: string) => Promise<void>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addMarkScreenStateFixture(test: any): any {
  return test.extend({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    markScreenState: async (fixtures: Record<string, unknown>, use: any) => {
      const fixtureTarget = fixtures[fixtureKey];
      const fn: MarkScreenStateFixture = async (screenName: string, stateName?: string) => {
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
      await use(fn);
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
        page: async ({ page }: { page: any }, use: any, testInfo: any) => {
          const project = testInfo.project as { rootDir?: string };
          const projectRootDir = project.rootDir ?? process.cwd();
          const testsFolder = deriveTestsFolder(projectRootDir);
          const paths = derivePathsFromTestInfo(
            testInfo as unknown as Parameters<typeof derivePathsFromTestInfo>[0],
            testsFolder,
            projectRootDir,
            false
          );

          const ciTestInfo: Record<string, unknown> = {
            folderPath: paths.folderPath,
            fileName: paths.fileName,
            suitePath: paths.suitePath,
            testName: paths.testName,
          };
          const branchName = getBranchName();
          if (branchName) ciTestInfo.branchName = branchName;
          const env = process.env.TESTCHIMP_ENV || process.env.TESTCHIMP_ENVIRONMENT;
          if (env) ciTestInfo.environment = String(env).trim();
          const release = process.env.TESTCHIMP_RELEASE || process.env.TESTCHIMP_RELEASE_NAME;
          if (release) ciTestInfo.release = release;
          const batchInvocationId = readTestChimpBatchInvocationId(projectRootDir);
          if (batchInvocationId) ciTestInfo.batchInvocationId = batchInvocationId;

          const jsonString = JSON.stringify(ciTestInfo);
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

  if (mobileProject && !warnedTrueCoverageMobileSkip) {
    // TrueCoverage CI metadata injection currently relies on Playwright page semantics.
    // eslint-disable-next-line no-console
    console.warn('[TestChimp] TrueCoverage instrumentation is web-only for now; skipping on mobile.');
    warnedTrueCoverageMobileSkip = true;
  }

  const withMark = addMarkScreenStateFixture(withCi);
  if (!isExploreChimpEnabled()) {
    return withMark;
  }
  return applyExploreChimpFixture(withMark);
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
