/**
 * Smart-smoke: config merge, suite walk, related-tests load, selection sidecar.
 */

import fs from 'fs';
import path from 'path';
import type { FullConfig, Suite, TestCase } from '@playwright/test/reporter';
import {
  derivePaths,
  derivePathsFromTestInfo,
  getBranchName,
  getEnvVar,
  normalizeManifestFolderPath,
  type DerivedPaths,
  type TestInfoLike,
} from './utils';

export const SMART_SMOKE_SKIP_REASON = 'smart-smoke';
export const SMART_SMOKE_SELECTION_FILENAME = '.testchimp-smart-smoke-selection.json';

/** Project `use.testchimpSmartSmoke` shape (also fixture option). */
export interface TestchimpSmartSmokeUseOptions {
  maxTests?: number;
  suitePercentage?: number;
  maxTimeBudgetMins?: number;
  includeTags?: string[];
  relatedTestsOnly?: boolean;
}

export interface ResolvedSmartSmokeConfig {
  enabled: boolean;
  maxTests?: number;
  suitePercentage?: number;
  maxTimeBudgetMins?: number;
  includeTags: string[];
  relatedTestsOnly: boolean;
  /** True when no size constraint came from env or use — client applied 20% fallback. */
  usedDefaultSuitePercentage: boolean;
}

export interface TestLocatorJson {
  folderPath?: string[] | string;
  folder_path?: string[];
  fileName?: string;
  file_name?: string;
  testSuite?: string[];
  test_suite?: string[];
  testName?: string;
  test_name?: string;
}

export interface SmartSmokeSelectionFile {
  selectedTests: TestLocatorJson[];
  enabled: boolean;
  relatedTestsOnly?: boolean;
  branchName?: string;
}

export function isTruthyEnv(value: string | undefined | null): boolean {
  if (value == null) return false;
  const v = String(value).trim().toLowerCase();
  return v === 'true' || v === '1';
}

export function normalizeTag(tag: string): string {
  const t = String(tag || '').trim();
  if (!t) return '';
  return t.startsWith('@') ? t.toLowerCase() : `@${t.toLowerCase()}`;
}

/** Env field → use field → fallback (warn + 20% suite % when no size constraint). */
export function resolveSmartSmokeConfig(
  useOpts: TestchimpSmartSmokeUseOptions | undefined,
  env: NodeJS.ProcessEnv = process.env
): ResolvedSmartSmokeConfig {
  const enabled = isTruthyEnv(env.TESTCHIMP_SMART_SMOKE_ENABLED);
  const use = useOpts || {};

  const maxTestsEnv = env.TESTCHIMP_SMART_SMOKE_MAX_TESTS?.trim();
  const suitePctEnv = env.TESTCHIMP_SMART_SMOKE_SUITE_PERCENTAGE?.trim();
  const timeEnv = env.TESTCHIMP_SMART_SMOKE_MAX_TIME_BUDGET_MINS?.trim();
  const tagsEnv = env.TESTCHIMP_SMART_SMOKE_INCLUDE_TAGS?.trim();
  const relatedOnlyEnv = env.TESTCHIMP_SMART_SMOKE_RELATED_TESTS_ONLY;

  let maxTests: number | undefined;
  if (maxTestsEnv) {
    const n = parseInt(maxTestsEnv, 10);
    if (Number.isFinite(n) && n > 0) maxTests = n;
  } else if (typeof use.maxTests === 'number' && use.maxTests > 0) {
    maxTests = use.maxTests;
  }

  let suitePercentage: number | undefined;
  if (suitePctEnv) {
    const n = Number(suitePctEnv);
    if (Number.isFinite(n) && n > 0) suitePercentage = n;
  } else if (typeof use.suitePercentage === 'number' && use.suitePercentage > 0) {
    suitePercentage = use.suitePercentage;
  }

  let maxTimeBudgetMins: number | undefined;
  if (timeEnv) {
    const n = parseInt(timeEnv, 10);
    if (Number.isFinite(n) && n > 0) maxTimeBudgetMins = n;
  } else if (typeof use.maxTimeBudgetMins === 'number' && use.maxTimeBudgetMins > 0) {
    maxTimeBudgetMins = use.maxTimeBudgetMins;
  }

  let includeTags: string[] = [];
  if (tagsEnv) {
    includeTags = tagsEnv.split(',').map((t) => t.trim()).filter(Boolean);
  } else if (Array.isArray(use.includeTags)) {
    includeTags = [...use.includeTags];
  }

  const relatedTestsOnly = relatedOnlyEnv != null && String(relatedOnlyEnv).trim() !== ''
    ? isTruthyEnv(relatedOnlyEnv)
    : Boolean(use.relatedTestsOnly);

  let usedDefaultSuitePercentage = false;
  if (
    enabled &&
    !relatedTestsOnly &&
    maxTests == null &&
    suitePercentage == null &&
    maxTimeBudgetMins == null
  ) {
    suitePercentage = 20;
    usedDefaultSuitePercentage = true;
  }

  return {
    enabled,
    maxTests,
    suitePercentage,
    maxTimeBudgetMins,
    includeTags,
    relatedTestsOnly,
    usedDefaultSuitePercentage,
  };
}

export function readSmartSmokeUseFromConfig(config: FullConfig): TestchimpSmartSmokeUseOptions | undefined {
  const projects = config.projects || [];
  for (const p of projects) {
    const use = (p as { use?: Record<string, unknown> }).use;
    const raw = use?.testchimpSmartSmoke;
    if (raw && typeof raw === 'object') {
      return raw as TestchimpSmartSmokeUseOptions;
    }
  }
  return undefined;
}

export function folderPathSegments(folderPath: string | string[] | undefined): string[] {
  if (Array.isArray(folderPath)) {
    return folderPath.map((s) => String(s || '').trim()).filter((s) => s && s !== '.');
  }
  const norm = normalizeManifestFolderPath(String(folderPath || ''));
  if (!norm) return [];
  return norm.split('/').filter(Boolean);
}

export function locatorFromDerived(paths: DerivedPaths): TestLocatorJson {
  return {
    folderPath: folderPathSegments(paths.folderPath),
    fileName: paths.fileName,
    testSuite: Array.isArray(paths.suitePath) ? [...paths.suitePath] : [],
    testName: paths.testName,
  };
}

export function normalizeLocator(raw: TestLocatorJson): TestLocatorJson {
  const folder =
    raw.folder_path ??
    (Array.isArray(raw.folderPath) ? raw.folderPath : folderPathSegments(raw.folderPath as string | undefined));
  return {
    folderPath: folderPathSegments(folder),
    fileName: raw.file_name ?? raw.fileName ?? '',
    testSuite: raw.test_suite ?? raw.testSuite ?? [],
    testName: raw.test_name ?? raw.testName ?? '',
  };
}

export function locatorKey(loc: TestLocatorJson): string {
  const n = normalizeLocator(loc);
  const folder = Array.isArray(n.folderPath) ? n.folderPath : folderPathSegments(n.folderPath);
  const suite = Array.isArray(n.testSuite) ? n.testSuite : [];
  return [
    folder.join('/'),
    n.fileName || '',
    suite.join('\u0001'),
    n.testName || '',
  ].join('\0');
}

export function locatorsEqual(a: TestLocatorJson, b: TestLocatorJson): boolean {
  return locatorKey(a) === locatorKey(b);
}

export function collectSuiteCandidates(
  suite: Suite,
  testsFolder: string,
  rootDir: string,
  includeTags: string[]
): { suiteCandidates: TestLocatorJson[]; taggedTests: TestLocatorJson[] } {
  const wanted = new Set(includeTags.map(normalizeTag).filter(Boolean));
  const suiteCandidates: TestLocatorJson[] = [];
  const taggedTests: TestLocatorJson[] = [];
  const seen = new Set<string>();
  const seenTagged = new Set<string>();

  const visit = (s: Suite) => {
    for (const test of s.tests) {
      const paths = derivePaths(test, testsFolder, rootDir, false);
      const loc = locatorFromDerived(paths);
      const key = locatorKey(loc);
      if (!seen.has(key)) {
        seen.add(key);
        suiteCandidates.push(loc);
      }
      if (wanted.size > 0 && testMatchesTags(test, wanted) && !seenTagged.has(key)) {
        seenTagged.add(key);
        taggedTests.push(loc);
      }
    }
    for (const child of s.suites) {
      visit(child);
    }
  };
  visit(suite);
  return { suiteCandidates, taggedTests };
}

function testMatchesTags(test: TestCase, wantedNormalized: Set<string>): boolean {
  const tags = (test as { tags?: string[] }).tags;
  if (!Array.isArray(tags) || tags.length === 0) return false;
  for (const t of tags) {
    if (wantedNormalized.has(normalizeTag(t))) return true;
  }
  return false;
}

export function findPlansRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.testchimp-plans'))) {
      return dir;
    }
    const plansDir = path.join(dir, 'plans');
    if (fs.existsSync(plansDir) && fs.statSync(plansDir).isDirectory()) {
      // Prefer mapped plans root (marker inside plans/) over a bare folder name match.
      if (fs.existsSync(path.join(plansDir, '.testchimp-plans'))) {
        return plansDir;
      }
      // Fallback: conventional plans/ directory when marker is absent.
      return plansDir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Load related-tests.json for the current branch under plans/smart-smoke/<branch>/.
 * Branch path segments are kept literally (nested dirs for `/` in branch names).
 */
export function loadRelatedTests(plansRoot: string | undefined, branchName: string | undefined): TestLocatorJson[] {
  if (!plansRoot || !branchName?.trim()) return [];
  const filePath = path.join(plansRoot, 'smart-smoke', ...branchName.split(/[/\\]+/), 'related-tests.json');
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { relatedTests?: unknown }).relatedTests)
        ? (raw as { relatedTests: unknown[] }).relatedTests
        : Array.isArray((raw as { related_tests?: unknown }).related_tests)
          ? (raw as { related_tests: unknown[] }).related_tests
          : [];
    return list
      .filter((x): x is TestLocatorJson => x != null && typeof x === 'object')
      .map(normalizeLocator);
  } catch {
    return [];
  }
}

export function getSmartSmokeSelectionFilePath(projectRootDir: string = process.cwd()): string {
  return (
    getEnvVar('TESTCHIMP_SMART_SMOKE_SELECTION_FILE') ||
    path.join(projectRootDir, SMART_SMOKE_SELECTION_FILENAME)
  );
}

export function writeSmartSmokeSelectionFile(
  projectRootDir: string,
  payload: SmartSmokeSelectionFile
): string {
  const filePath = getSmartSmokeSelectionFilePath(projectRootDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  invalidateSmartSmokeSelectionCache();
  return filePath;
}

type SelectionCacheEntry = {
  filePath: string;
  mtimeMs: number;
  selection: SmartSmokeSelectionFile;
  keySet: Set<string>;
};

let selectionCache: SelectionCacheEntry | null = null;

export function invalidateSmartSmokeSelectionCache(): void {
  selectionCache = null;
}

/**
 * Load selection sidecar once per worker (re-read only when mtime changes).
 * Returns undefined when smart-smoke is not active for this process.
 */
export function loadSmartSmokeSelectionLookup(
  projectRootDir: string = process.cwd()
): { selection: SmartSmokeSelectionFile; keySet: Set<string> } | undefined {
  // Env is the source of truth for "is this run smart-smoke" — ignore stale sidecars
  // left behind when a previous run crashed before onEnd unlink.
  if (!isTruthyEnv(process.env.TESTCHIMP_SMART_SMOKE_ENABLED)) {
    return undefined;
  }
  const filePath = getSmartSmokeSelectionFilePath(projectRootDir);
  try {
    const st = fs.statSync(filePath);
    if (
      selectionCache &&
      selectionCache.filePath === filePath &&
      selectionCache.mtimeMs === st.mtimeMs
    ) {
      return { selection: selectionCache.selection, keySet: selectionCache.keySet };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as SmartSmokeSelectionFile;
    if (!parsed || !Array.isArray(parsed.selectedTests) || !parsed.enabled) {
      selectionCache = null;
      return undefined;
    }
    const selection: SmartSmokeSelectionFile = {
      ...parsed,
      selectedTests: parsed.selectedTests.map(normalizeLocator),
    };
    const keySet = new Set(selection.selectedTests.map((t) => locatorKey(t)));
    selectionCache = { filePath, mtimeMs: st.mtimeMs, selection, keySet };
    return { selection, keySet };
  } catch {
    selectionCache = null;
    return undefined;
  }
}

export function readSmartSmokeSelectionFile(
  projectRootDir: string = process.cwd()
): SmartSmokeSelectionFile | undefined {
  return loadSmartSmokeSelectionLookup(projectRootDir)?.selection;
}

export function unlinkSmartSmokeSelectionFile(filePath: string | null | undefined): void {
  if (!filePath) return;
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
  invalidateSmartSmokeSelectionCache();
}

/** Client-side must_include when related-tests-only or API unavailable. */
export function unionLocators(...lists: TestLocatorJson[][]): TestLocatorJson[] {
  const map = new Map<string, TestLocatorJson>();
  for (const list of lists) {
    for (const loc of list) {
      const n = normalizeLocator(loc);
      map.set(locatorKey(n), n);
    }
  }
  return [...map.values()];
}

export function isLocatorSelected(
  paths: DerivedPaths,
  selected: TestLocatorJson[],
  keySet?: Set<string>
): boolean {
  const key = locatorKey(locatorFromDerived(paths));
  if (keySet) return keySet.has(key);
  return selected.some((s) => locatorKey(s) === key);
}

export function resolveSkipReasonFromAnnotations(
  annotations: Array<{ type?: string; description?: string }> | undefined,
  playwrightSkipMessage?: string
): string | undefined {
  if (!annotations?.length && !playwrightSkipMessage) return undefined;
  for (const a of annotations || []) {
    if (a.type === 'skip-reason' && a.description?.trim()) {
      return a.description.trim();
    }
  }
  for (const a of annotations || []) {
    if ((a.type === 'skip' || a.type === 'fix') && a.description?.trim()) {
      return a.description.trim();
    }
  }
  const msg = playwrightSkipMessage?.trim();
  return msg || undefined;
}

export function maybeSkipForSmartSmoke(testInfo: TestInfoLike & {
  annotations: Array<{ type: string; description?: string }>;
  skip: (condition?: boolean, description?: string) => void;
  project?: { rootDir?: string };
}): void {
  const rootDir = testInfo.project?.rootDir ?? process.cwd();
  const lookup = loadSmartSmokeSelectionLookup(rootDir);
  if (!lookup) return;
  const testsFolder = getEnvVar('TESTCHIMP_TESTS_FOLDER') || 'tests';
  const paths = derivePathsFromTestInfo(testInfo, testsFolder, rootDir);
  if (isLocatorSelected(paths, lookup.selection.selectedTests, lookup.keySet)) return;
  testInfo.annotations.push({ type: 'skip-reason', description: SMART_SMOKE_SKIP_REASON });
  testInfo.skip(true, SMART_SMOKE_SKIP_REASON);
}

export function toWireLocator(loc: TestLocatorJson): Record<string, unknown> {
  const n = normalizeLocator(loc);
  return {
    folder_path: n.folderPath || [],
    file_name: n.fileName || '',
    test_suite: n.testSuite || [],
    test_name: n.testName || '',
  };
}

export function fromWireLocator(raw: Record<string, unknown>): TestLocatorJson {
  return normalizeLocator({
    folder_path: raw.folder_path as string[] | undefined,
    folderPath: raw.folderPath as string[] | string | undefined,
    file_name: raw.file_name as string | undefined,
    fileName: raw.fileName as string | undefined,
    test_suite: raw.test_suite as string[] | undefined,
    testSuite: raw.testSuite as string[] | undefined,
    test_name: raw.test_name as string | undefined,
    testName: raw.testName as string | undefined,
  });
}

export { getBranchName };
