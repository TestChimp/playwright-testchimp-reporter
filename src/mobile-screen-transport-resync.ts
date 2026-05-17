import type { TestInfoForCi } from './ci-test-info';
import {
  isLikelyMobileTransportFailure,
  resyncTrueCoverageSetForCurrentTest,
  transportResyncDisabled,
  type MobileDeviceWorkerFixtures,
} from './rum-automation-mobile';

type ScreenTransportCtx = {
  device: unknown;
  testInfo: TestInfoForCi;
};

function isThenable(v: unknown): v is Promise<unknown> {
  return v != null && typeof (v as { then?: unknown }).then === 'function';
}

async function runWithTransportResync<T>(fn: () => Promise<T>, ctx: ScreenTransportCtx): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isLikelyMobileTransportFailure(err)) {
      throw err;
    }
    const dev = ctx.device as { openUrl?: (url: string) => Promise<void> } | null | undefined;
    if (!dev || typeof dev.openUrl !== 'function') {
      throw err;
    }
    try {
      await resyncTrueCoverageSetForCurrentTest(
        dev as NonNullable<MobileDeviceWorkerFixtures['device']>,
        ctx.testInfo
      );
      // eslint-disable-next-line no-console
      console.warn(
        '[TestChimp] TrueCoverage: re-sent SET after a likely transport failure so the next RUM emit can carry ci_test_info again.'
      );
    } catch (resyncErr) {
      const m = resyncErr instanceof Error ? resyncErr.message : String(resyncErr);
      // eslint-disable-next-line no-console
      console.warn(`[TestChimp] TrueCoverage: SET resync failed (non-fatal): ${m}`);
    }
    throw err;
  }
}

/**
 * Wrap a Mobilewright `screen` so async method failures that look like transport drops trigger a TrueCoverage SET resync before the error propagates.
 */
export function wrapScreenForTransportResync(screen: unknown, ctx: ScreenTransportCtx): unknown {
  if (transportResyncDisabled() || screen == null || typeof screen !== 'object') {
    return screen;
  }
  return new Proxy(screen as object, {
    get(_target, prop, receiver) {
      const v = Reflect.get(screen as object, prop, receiver);
      if (typeof v !== 'function') {
        return v;
      }
      return (...args: unknown[]) => {
        const out = Reflect.apply(v as (...a: unknown[]) => unknown, screen as object, args);
        if (isThenable(out)) {
          return runWithTransportResync(() => out as Promise<unknown>, ctx);
        }
        return out;
      };
    },
  });
}

/**
 * Extend the test type with a `screen` fixture that proxies callable screen APIs for transport-failure resync.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function attachMobileScreenTransportResync(testType: any): any {
  if (transportResyncDisabled()) {
    return testType;
  }
  return testType.extend({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    screen: async ({ screen, device }: { screen: unknown; device?: unknown }, use: any, testInfo: TestInfoForCi) => {
      const ctx: ScreenTransportCtx = { device, testInfo };
      await use(wrapScreenForTransportResync(screen, ctx));
    },
  });
}
