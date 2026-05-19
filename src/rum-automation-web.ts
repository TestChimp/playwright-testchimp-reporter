import { buildCiTestInfoJson, type TestInfoForCi } from './ci-test-info';

/** Per-call cap for `page.evaluate` RUM flush so a wedged page does not burn the whole test timeout. */
export function resolveWebRumFlushTimeoutMs(): number {
  const raw = process.env.TESTCHIMP_RUM_WEB_FLUSH_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 5000;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return 5000;
  return Math.max(100, Math.min(30_000, n));
}

/** Max time to wait for buffered events before flush when CI metadata is present (fast async emits). */
export function resolveWebRumBufferPollMs(): number {
  const raw = process.env.TESTCHIMP_RUM_WEB_BUFFER_POLL_MS;
  if (raw === undefined || raw === '') return 500;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return 500;
  return Math.max(0, Math.min(2000, n));
}

export function webRumFlushDebugEnabled(): boolean {
  const raw = process.env.TESTCHIMP_RUM_WEB_FLUSH_DEBUG?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
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

type PageWithRumFlush = {
  // Playwright allows one optional evaluate argument; keep the signature wide for CI JSON.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  evaluate: (fn: (...args: any[]) => void | Promise<void>, arg?: unknown) => Promise<unknown>;
};

/**
 * Re-apply TrueCoverage CI metadata on the page (mirrors mobile resync before flush).
 */
export async function syncWebCiTestInfo(
  page: Pick<PageWithRumFlush, 'evaluate'>,
  testInfo: TestInfoForCi,
  projectRootDir: string
): Promise<void> {
  const jsonString = buildCiTestInfoJson(testInfo, projectRootDir);
  await page.evaluate((info: string) => {
    (globalThis as unknown as { __TC_CI_TEST_INFO?: string }).__TC_CI_TEST_INFO = info;
  }, jsonString);
}

/**
 * Flush buffered @testchimp/rum-js events before Playwright tears down the page.
 * Awaits `globalThis.__TC_RUM_FLUSH` (rum-js ≥ 0.1.7) with a normal fetch so the POST
 * completes while the page is still open.
 */
export async function flushWebRumBuffer(
  page: PageWithRumFlush,
  testInfo?: TestInfoForCi,
  projectRootDir?: string
): Promise<void> {
  const timeoutMs = resolveWebRumFlushTimeoutMs();
  const debug = webRumFlushDebugEnabled();

  try {
    if (testInfo && projectRootDir) {
      await syncWebCiTestInfo(page, testInfo, projectRootDir);
    }

    const bufferPollMs = resolveWebRumBufferPollMs();

    await withTimeout(
      page.evaluate(async (pollMs: number) => {
        const g = globalThis as {
          __TC_CI_TEST_INFO?: string;
          __TC_RUM_FLUSH?: () => void | Promise<void | boolean>;
          __TC_RUM_GET_BUFFER_SIZE?: () => number;
          testchimp?: { flush?: () => void };
        };
        const hasCi =
          typeof g.__TC_CI_TEST_INFO === 'string' && g.__TC_CI_TEST_INFO.length > 0;
        if (hasCi && pollMs > 0 && typeof g.__TC_RUM_GET_BUFFER_SIZE === 'function') {
          const deadline = Date.now() + pollMs;
          while (Date.now() < deadline) {
            if (g.__TC_RUM_GET_BUFFER_SIZE() > 0) break;
            await new Promise((r) => setTimeout(r, 25));
          }
        }
        if (typeof g.__TC_RUM_FLUSH === 'function') {
          await g.__TC_RUM_FLUSH();
        } else if (typeof g.testchimp?.flush === 'function') {
          g.testchimp.flush();
        }
      }, bufferPollMs),
      timeoutMs,
      'flushWebRumBuffer'
    );
  } catch (err) {
    if (debug) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[TestChimp] flushWebRumBuffer failed (non-fatal): ${msg}`);
    }
  }
}

/**
 * Web RUM flush runs in {@link extendWebTrueCoveragePage} fixture teardown (after all hooks).
 * This export remains for API compatibility; mobile hooks still use `afterEach`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function attachWebRumAutomationHooks(testType: any): any {
  return testType;
}
