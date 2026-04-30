/**
 * TrueCoverage runtime: injects CITestInfo into the browser so @testchimp/rum-js can
 * send the ci-test-info header on RUM ingest requests.
 *
 * Prefer `installTrueCoverage(mergedTest)` on the same `test` object your specs use
 * (e.g. `mergeTests` output from `fixtures/index.js`). The side-effect
 * `import '@testchimp/playwright/runtime'` still registers on the root `@playwright/test`
 * instance for backward compatibility.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { derivePathsFromTestInfo, deriveTestsFolder, getBranchName } from './utils';

const BATCH_ID_FILENAME = '.testchimp-batch-invocation-id';

function readBatchInvocationId(projectRootDir: string): string | undefined {
  const fromEnv = process.env.TESTCHIMP_BATCH_INVOCATION_ID;
  if (fromEnv) return fromEnv;
  const filePath =
    process.env.TESTCHIMP_BATCH_ID_FILE || path.join(projectRootDir, BATCH_ID_FILENAME);
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Register TrueCoverage CI metadata injection on the given Playwright `test` object
 * (including `mergeTests(...)` output). Returns the same instance for chaining.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function installTrueCoverage(test: any): any {
  // Use a page fixture override instead of beforeEach hooks.
  //
  // In Playwright, fixtures can navigate during setup. When CI info injection is only in `beforeEach`,
  // a page may emit RUM before the hook runs, causing missing ci-test-info headers. Overriding the
  // `page` fixture ensures the injection happens before user test code sees the page.
  return test.extend({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    const batchInvocationId = readBatchInvocationId(projectRootDir);
    if (batchInvocationId) ciTestInfo.batchInvocationId = batchInvocationId;

    const jsonString = JSON.stringify(ciTestInfo);
    await page.addInitScript(
      (info: string) => {
        // Browser main thread: globalThis is window.
        (globalThis as unknown as { __TC_CI_TEST_INFO?: string }).__TC_CI_TEST_INFO = info;
      },
      jsonString
    );

    // Also set on the currently loaded page (if any). `addInitScript` only affects future documents,
    // so without this, apps that initialize RUM on the first loaded document can emit events before
    // the init script ever runs.
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

// IMPORTANT: resolve @playwright/test from the *consumer* project, not from this package.
const pwRequire = createRequire(path.join(process.cwd(), 'package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { test: rootTest } = pwRequire('@playwright/test') as any;

installTrueCoverage(rootTest);
