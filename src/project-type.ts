export type FixtureKey = 'page' | 'screen';

const MOBILE_TYPES = new Set(['ios', 'android']);
const DEFAULT_WEB_RUNTIME_MODULE = '@playwright/test';
/** Mobilewright exposes `test` / `expect` from `@mobilewright/test`, not the `mobilewright` CLI package. */
const DEFAULT_MOBILE_RUNTIME_MODULE = '@mobilewright/test';

function normalizedProjectType(): string {
  return String(process.env.TESTCHIMP_PROJECT_TYPE ?? '')
    .trim()
    .toLowerCase();
}

export function isMobileProjectType(): boolean {
  return MOBILE_TYPES.has(normalizedProjectType());
}

export function getFixtureKey(): FixtureKey {
  return isMobileProjectType() ? 'screen' : 'page';
}

export function getTestRuntimeModuleName(): string {
  return isMobileProjectType()
    ? DEFAULT_MOBILE_RUNTIME_MODULE
    : DEFAULT_WEB_RUNTIME_MODULE;
}

