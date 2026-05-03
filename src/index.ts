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
 * ExploreChimp: set `EXPLORECHIMP_ENABLED=true`, use `test('…', async ({ markScreenState }) => …)`; `TESTCHIMP_BATCH_INVOCATION_ID`, sources/regex envs as documented in the runtime module.
 */

export { TestChimpReporter } from './testchimp-reporter';
export { TestChimpApiClient } from './api-client';
export * from './types';
export * from './utils';

// Default export for Playwright reporter configuration
import { TestChimpReporter } from './testchimp-reporter';
export default TestChimpReporter;
