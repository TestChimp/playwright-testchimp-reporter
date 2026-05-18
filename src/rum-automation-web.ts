/** Per-call cap for `page.evaluate` RUM flush so a wedged page does not burn the whole test timeout. */
export function resolveWebRumFlushTimeoutMs(): number {
  const raw = process.env.TESTCHIMP_RUM_WEB_FLUSH_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 5000;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return 5000;
  return Math.max(100, Math.min(30_000, n));
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

type PageWithEvaluate = {
  evaluate: (fn: () => void, arg?: unknown) => Promise<unknown>;
};

/**
 * Flush buffered @testchimp/rum-js events before Playwright tears down the page.
 * Non-fatal when the page is closed or rum-js is not initialized.
 */
export async function flushWebRumBuffer(page: PageWithEvaluate): Promise<void> {
  const timeoutMs = resolveWebRumFlushTimeoutMs();
  try {
    await withTimeout(
      page.evaluate(() => {
        const g = globalThis as {
          __TC_RUM_FLUSH?: () => void;
          testchimp?: { flush?: () => void };
        };
        if (typeof g.__TC_RUM_FLUSH === 'function') {
          g.__TC_RUM_FLUSH();
        } else if (typeof g.testchimp?.flush === 'function') {
          g.testchimp.flush();
        }
      }),
      timeoutMs,
      'flushWebRumBuffer'
    );
  } catch {
    // Non-fatal: page closed, navigation torn down, or rum not initialized.
  }
}
