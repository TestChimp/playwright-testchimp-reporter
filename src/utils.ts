import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import type { TestCase, Suite } from '@playwright/test/reporter';
import type { JobManifestEntry } from './types';

/**
 * Derived path components for test identification
 */
export interface DerivedPaths {
  folderPath: string;
  fileName: string;
  suitePath: string[];
  testName: string;
}

export interface TestInfoLike {
  file: string;
  title: string;
  titlePath?: () => string[];
  project?: { name?: string };
}

/**
 * Canonicalize folderPath to match scriptservice manifest convention:
 * - normalize separators to '/'
 * - trim duplicate slashes
 * - strip leading './'
 * - strip leading 'tests/' (or 'tests')
 * - map '.' to ''
 */
export function normalizeManifestFolderPath(folderPath: string): string {
  if (!folderPath) return '';
  const posix = folderPath.split(path.sep).join('/').replace(/\\/g, '/');
  const trimmed = posix
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!trimmed || trimmed === '.') return '';
  return trimmed.replace(/^tests(?:\/|$)/, '');
}

function normalizeSuitePath(suitePath: string[] | undefined): string[] {
  return Array.isArray(suitePath) ? suitePath : [];
}

function buildSuitePathCandidates(runtimeSuitePath: string[]): string[][] {
  const unique = new Map<string, string[]>();
  const add = (sp: string[]) => unique.set(JSON.stringify(sp), sp);
  add(runtimeSuitePath);
  if (runtimeSuitePath.length > 0) {
    add([]);
  }
  return Array.from(unique.values());
}

/**
 * Resolve a manifest jobId using robust fallback candidates for folderPath/suitePath.
 * Exact candidates are attempted first, then normalized variants.
 */
export function resolveJobIdFromManifest(
  manifest: JobManifestEntry[],
  key: { folderPath: string; fileName: string; suitePath: string[]; testName: string }
): string | undefined {
  return resolveManifestEntryFromRuntime(manifest, key)?.entry?.jobId;
}

export interface ManifestResolutionResult {
  entry: JobManifestEntry;
  strategy:
    | 'exact_path_tuple'
    | 'normalized_path_tuple'
    | 'suitepath_empty_fallback'
    | 'stable_identity_unique';
}

/**
 * Resolve full manifest entry with deterministic strategy metadata.
 * Stable identity (`fileName + suitePath + testName`) is preferred over path-only
 * when it uniquely identifies a single manifest entry.
 */
export function resolveManifestEntryFromRuntime(
  manifest: JobManifestEntry[],
  key: { folderPath: string; fileName: string; suitePath: string[]; testName: string }
): ManifestResolutionResult | undefined {
  const runtimeFolder = normalizeManifestFolderPath(key.folderPath);
  const normalizedSuitePath = normalizeSuitePath(key.suitePath);
  const suitePathJson = JSON.stringify(normalizedSuitePath);

  const stableIdentityMatches = manifest.filter((e) =>
    e.fileName === key.fileName &&
    JSON.stringify(normalizeSuitePath(e.suitePath)) === suitePathJson &&
    e.testName === key.testName &&
    !!e.jobId
  );
  if (stableIdentityMatches.length === 1) {
    return { entry: stableIdentityMatches[0], strategy: 'stable_identity_unique' };
  }

  const exactTuple = manifest.find((e) =>
    e.folderPath === key.folderPath &&
    e.fileName === key.fileName &&
    JSON.stringify(normalizeSuitePath(e.suitePath)) === suitePathJson &&
    e.testName === key.testName &&
    !!e.jobId
  );
  if (exactTuple) {
    return { entry: exactTuple, strategy: 'exact_path_tuple' };
  }

  const normalizedTuple = manifest.find((e) =>
    normalizeManifestFolderPath(e.folderPath) === runtimeFolder &&
    e.fileName === key.fileName &&
    JSON.stringify(normalizeSuitePath(e.suitePath)) === suitePathJson &&
    e.testName === key.testName &&
    !!e.jobId
  );
  if (normalizedTuple) {
    return { entry: normalizedTuple, strategy: 'normalized_path_tuple' };
  }

  if (normalizedSuitePath.length > 0) {
    const suiteEmpty = manifest.find((e) =>
      normalizeManifestFolderPath(e.folderPath) === runtimeFolder &&
      e.fileName === key.fileName &&
      JSON.stringify(normalizeSuitePath(e.suitePath)) === '[]' &&
      e.testName === key.testName &&
      !!e.jobId
    );
    if (suiteEmpty) {
      return { entry: suiteEmpty, strategy: 'suitepath_empty_fallback' };
    }
  }
  return undefined;
}

/**
 * Derive path components from a Playwright TestInfo (runtime context).
 *
 * Note: This intentionally avoids reporter-only types like TestCase/Suite, since this
 * is used in `@playwright/test` runtime hooks.
 */
export function derivePathsFromTestInfo(
  testInfo: TestInfoLike,
  testsFolder: string,
  rootDir: string,
  verbose: boolean = false
): DerivedPaths {
  const basePath = testsFolder ? path.resolve(rootDir, testsFolder) : rootDir;
  const filePath = testInfo.file;
  const isRelativePath = !path.isAbsolute(filePath);

  if (verbose) {
    // eslint-disable-next-line no-console
    console.log(`[TestChimp] Path derivation for test: ${testInfo.title}`);
    // eslint-disable-next-line no-console
    console.log(`[TestChimp]   rootDir: ${rootDir}`);
    // eslint-disable-next-line no-console
    console.log(`[TestChimp]   testsFolder: ${testsFolder || "(not set)"}`);
    // eslint-disable-next-line no-console
    console.log(`[TestChimp]   basePath: ${basePath}`);
    // eslint-disable-next-line no-console
    console.log(`[TestChimp]   testInfo.file (original): ${filePath}`);
    // eslint-disable-next-line no-console
    console.log(`[TestChimp]   isRelativePath: ${isRelativePath}`);
  }

  const absoluteFilePath = isRelativePath ? path.resolve(rootDir, filePath) : filePath;

  let relativePath = path.relative(basePath, absoluteFilePath);
  relativePath = path.normalize(relativePath);

  if (relativePath.startsWith("..")) {
    const parts = relativePath.split(path.sep);
    const filteredParts = parts.filter((p) => p !== ".." && p !== ".");
    relativePath = filteredParts.join(path.sep);
  }

  // Normalize to forward slashes for consistent cross-platform encoding.
  const posixRelative = relativePath.split(path.sep).join("/");
  const folderPath = path.posix.dirname(posixRelative);
  const fileName = path.posix.basename(posixRelative);

  // Derive suitePath from titlePath() (exclude project + file + test title)
  const suitePath: string[] = [];
  const tp = typeof testInfo.titlePath === "function" ? testInfo.titlePath() : [];
  if (Array.isArray(tp) && tp.length > 1) {
    const projectName = testInfo.project?.name;
    const baseFile = path.posix.basename(filePath.split(path.sep).join("/"));
    for (const part of tp.slice(0, -1)) {
      if (!part) continue;
      if (projectName && part === projectName) continue;
      if (part === baseFile) continue;
      // Filter out file-ish parts that Playwright sometimes includes.
      if (/\.(spec|test)\.[jt]sx?$/.test(part)) continue;
      if (part.includes("/") || part.includes("\\")) continue;
      suitePath.push(part);
    }
  }

  return {
    folderPath: folderPath === "." ? "" : folderPath,
    fileName,
    suitePath,
    testName: testInfo.title,
  };
}

/**
 * Derive path components from a Playwright TestCase
 *
 * @param test The Playwright TestCase
 * @param testsFolder Base folder for relative path calculation (optional)
 * @param rootDir Playwright root directory
 * @param verbose Whether to log path resolution details
 * @returns Derived path components for test identification
 */
export function derivePaths(
  test: TestCase,
  testsFolder: string,
  rootDir: string,
  verbose: boolean = false
): DerivedPaths {
  // Calculate path relative to testsFolder (or rootDir if not specified)
  const basePath = testsFolder ? path.resolve(rootDir, testsFolder) : rootDir;
  const filePath = test.location.file;
  const isRelativePath = !path.isAbsolute(filePath);
  
  if (verbose) {
    console.log(`[TestChimp] Path derivation for test: ${test.title}`);
    console.log(`[TestChimp]   rootDir: ${rootDir}`);
    console.log(`[TestChimp]   testsFolder: ${testsFolder || '(not set)'}`);
    console.log(`[TestChimp]   basePath: ${basePath}`);
    console.log(`[TestChimp]   test.location.file (original): ${filePath}`);
    console.log(`[TestChimp]   isRelativePath: ${isRelativePath}`);
  }
  
  // Always normalize to absolute path first for deterministic behavior
  // This ensures consistent behavior regardless of whether Playwright returns
  // absolute or relative paths (which can vary between CI and local runs)
  const absoluteFilePath = isRelativePath 
    ? path.resolve(rootDir, filePath)
    : filePath;
  
  if (verbose) {
    console.log(`[TestChimp]   absoluteFilePath: ${absoluteFilePath}`);
  }
  
  // Calculate relative path from basePath to absolute file path
  let relativePath = path.relative(basePath, absoluteFilePath);
  relativePath = path.normalize(relativePath);
  
  if (verbose) {
    console.log(`[TestChimp]   relativePath (after path.relative): ${relativePath}`);
  }
  
  // If the path still starts with ".." after normalization, remove those components
  // This handles edge cases where the path goes outside the expected base
  if (relativePath.startsWith('..')) {
    if (verbose) {
      console.log(`[TestChimp]   WARNING: Path starts with "..", removing parent directory references`);
    }
    const parts = relativePath.split(path.sep);
    const filteredParts = parts.filter(p => p !== '..' && p !== '.');
    relativePath = filteredParts.join(path.sep);
    if (verbose) {
      console.log(`[TestChimp]   relativePath (after removing ".."): ${relativePath}`);
    }
  }

  // Use posix-style paths so manifest lookup matches scriptservice manifest (forward slashes)
  const posixRelative = relativePath.split(path.sep).join('/');
  const folderPath = (path.posix.dirname(posixRelative) === '.' ? '' : path.posix.dirname(posixRelative));
  const fileName = path.posix.basename(posixRelative);
  
  if (verbose) {
    console.log(`[TestChimp]   Final folderPath: "${folderPath}"`);
    console.log(`[TestChimp]   Final fileName: "${fileName}"`);
  }

  // Build suite path from parent suites (describe blocks)
  // Walk up the parent chain, collecting suite titles
  // According to Playwright docs: suite.location is missing for root and project suites
  // We should only include suites that have a location (file-level and describe suites)
  // and ensure they belong to the same test file
  const suitePath: string[] = [];
  let parent: Suite | undefined = test.parent;
  const testFile = test.location.file;

  while (parent) {
    // Stop if we've reached a root or project suite (they don't have a location)
    // This prevents including browser/project names like "chromium" in the suite path
    if (!parent.location) {
      break;
    }

    // Only include suites from the same test file
    if (parent.location.file !== testFile) {
      parent = parent.parent;
      continue;
    }

    // Skip file-level suites (they have a location but their title is the file path)
    // Only include describe block suites (nested test groups)
    if (parent.title &&
        !parent.title.endsWith('.spec.ts') &&
        !parent.title.endsWith('.test.ts') &&
        !parent.title.endsWith('.spec.js') &&
        !parent.title.endsWith('.test.js')) {
      suitePath.unshift(parent.title);
    }
    
    parent = parent.parent;
  }

  return {
    folderPath: folderPath === '.' ? '' : folderPath,
    fileName,
    suitePath,
    testName: test.title
  };
}

/**
 * Derive the tests folder name/path used for relative path calculation.
 * Uses TESTCHIMP_TESTS_FOLDER env if set, otherwise default "tests".
 */
export function deriveTestsFolder(_projectRootDir: string): string {
  return process.env.TESTCHIMP_TESTS_FOLDER || 'tests';
}

/**
 * Current git branch name from env / CI (TrueCoverage ci-test-info, SmartTest execution reports, ExploreChimp
 * `branchName` on `analyze_explorechimp_data_sources`).
 */
export function getBranchName(): string | undefined {
  const fromEnv =
    process.env.TESTCHIMP_BRANCH_NAME ||
    process.env.TESTCHIMP_BRANCH ||
    process.env.CI_COMMIT_REF_NAME ||
    process.env.GIT_BRANCH ||
    process.env.BRANCH_NAME;
  if (fromEnv) return fromEnv;
  // GitHub Actions: GITHUB_REF is e.g. refs/heads/main
  const ghRef = process.env.GITHUB_REF;
  if (ghRef?.startsWith('refs/heads/')) return ghRef.slice('refs/heads/'.length);
  return undefined;
}

const BATCH_ID_FILENAME = '.testchimp-batch-invocation-id';

/** Absolute path to the batch-invocation id file (same rules as {@link readTestChimpBatchInvocationId}). */
export function getTestChimpBatchInvocationFilePath(projectRootDir: string = process.cwd()): string {
  return process.env.TESTCHIMP_BATCH_ID_FILE || path.join(projectRootDir, BATCH_ID_FILENAME);
}

/**
 * Batch / exploration id used by TrueCoverage and ExploreChimp local runs.
 * Prefer env TESTCHIMP_BATCH_INVOCATION_ID, else `.testchimp-batch-invocation-id` under project root.
 */
export function readTestChimpBatchInvocationId(projectRootDir: string = process.cwd()): string | undefined {
  const fromEnv = process.env.TESTCHIMP_BATCH_INVOCATION_ID;
  if (fromEnv) return fromEnv.trim();
  const filePath = getTestChimpBatchInvocationFilePath(projectRootDir);
  try {
    const v = fs.readFileSync(filePath, 'utf8').trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Same path rules as {@link TestChimpReporter} platform manifest (jobId ↔ test identity).
 */
export function loadJobManifestEntries(projectRootDir: string = process.cwd()): JobManifestEntry[] {
  const testsFolder = process.env.TESTCHIMP_TESTS_FOLDER || 'tests';
  const manifestPath =
    process.env.TESTCHIMP_JOB_MANIFEST_PATH?.trim() ||
    path.join(testsFolder, '.testchimp-job-manifest.json');
  const resolvedPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(projectRootDir, manifestPath);
  try {
    const content = fs.readFileSync(resolvedPath, 'utf8');
    const parsed = JSON.parse(content) as JobManifestEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Stable step id for ExploreChimp analytics Playwright steps so {@link TestChimpReporter} `SmartTestExecutionStep.step_id`
 * matches `AnalyzeDataSourcesRequest.step_id` / persisted bugs (journey viewer merge).
 */
export function stableExploreChimpAnalyticsStepId(testId: string, retry: number, stepTitle: string): string {
  const tid = String(testId ?? '');
  const r = Number.isFinite(retry) ? retry : 0;
  const title = String(stepTitle ?? '');
  return createHash('sha256').update(`${tid}:${r}:${title}`).digest('hex');
}

/**
 * Stable journey execution id for local ExploreChimp (no platform manifest).
 * Matches {@link applyExploreChimpPageFixture}: manifest jobId wins when present.
 */
export function stableJourneyExecutionId(journeyId: string, batchInvocationId: string, retry: number): string {
  const jid = String(journeyId ?? '').trim();
  const bid = String(batchInvocationId ?? '').trim();
  const r = Number.isFinite(retry) ? retry : 0;
  return createHash('sha256').update(`${jid}:${bid}:${r}`).digest('hex');
}

/**
 * Generate a simple unique ID for steps
 */
export function generateStepId(stepNumber: number): string {
  return `step_${stepNumber}_${Date.now()}`;
}

/**
 * Safely get an environment variable with optional default
 */
export function getEnvVar(name: string, defaultValue?: string): string | undefined {
  return process.env[name] || defaultValue;
}

/**
 * Generate a UUID v4
 * Simple implementation without external dependency
 */
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
