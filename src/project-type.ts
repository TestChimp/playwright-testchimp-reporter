export type RunPlatform = 'web' | 'ios' | 'android';
export type FixtureKey = 'page' | 'screen';

/** Minimal shape for platform/device resolution (TestInfo in tests, TestCase + suite project in reporter). */
export type TestInfoWithPlatformHints = {
  project?: { use?: unknown; name?: string };
  annotations?: Array<{ type?: string; description?: string }>;
};

function parsePlatformValue(raw: string): RunPlatform | null {
  const p = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (p === 'ios' || p === 'android') {
    return p;
  }
  return null;
}

/** Mobilewright 0.0.36+ pushes `device.platform` on testInfo after device allocation. */
function platformFromAnnotations(testInfo: TestInfoWithPlatformHints): RunPlatform | null {
  for (const a of testInfo.annotations ?? []) {
    if (a.type === 'device.platform') {
      const parsed = parsePlatformValue(a.description ?? '');
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

/**
 * Read run platform for TrueCoverage / ExploreChimp branching.
 * Primary: Mobilewright `projects[].use.platform`. Fallback: `testInfo.annotations` (`device.platform`).
 * Omitted / unknown => web.
 */
export function platformFromTestInfo(testInfo: TestInfoWithPlatformHints): RunPlatform {
  const fromUse = parsePlatformValue(
    String((testInfo.project?.use as { platform?: string } | undefined)?.platform ?? '')
  );
  if (fromUse) {
    return fromUse;
  }
  const fromAnnotations = platformFromAnnotations(testInfo);
  if (fromAnnotations) {
    return fromAnnotations;
  }
  return 'web';
}

export function isMobilePlatform(platform: RunPlatform): boolean {
  return platform === 'ios' || platform === 'android';
}

export function getFixtureKeyForPlatform(platform: RunPlatform): FixtureKey {
  return isMobilePlatform(platform) ? 'screen' : 'page';
}
