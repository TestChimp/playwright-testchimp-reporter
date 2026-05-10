import {
  derivePathsFromTestInfo,
  deriveTestsFolder,
  getBranchName,
  readTestChimpBatchInvocationId,
  type TestInfoLike,
} from './utils';

/** Payload embedded in `ci-test-info` header and `__TC_CI_TEST_INFO` (mirrors web runtime). */
export type CiTestInfo = Record<string, unknown>;

export type TestInfoForCi = TestInfoLike & {
  retry?: number;
  workerIndex?: number;
  testId?: string | number;
};

export function buildCiTestInfoObject(
  testInfo: TestInfoForCi,
  projectRootDir: string
): CiTestInfo {
  const testsFolder = deriveTestsFolder(projectRootDir);
  const paths = derivePathsFromTestInfo(
    testInfo,
    testsFolder,
    projectRootDir,
    false
  );

  const ciTestInfo: CiTestInfo = {
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

  if (typeof testInfo.retry === 'number') ciTestInfo.retry = testInfo.retry;
  if (typeof testInfo.workerIndex === 'number') ciTestInfo.workerIndex = testInfo.workerIndex;
  if (testInfo.testId != null && String(testInfo.testId).length > 0) {
    ciTestInfo.testId = String(testInfo.testId);
  }

  return ciTestInfo;
}

export function buildCiTestInfoJson(testInfo: TestInfoForCi, projectRootDir: string): string {
  return JSON.stringify(buildCiTestInfoObject(testInfo, projectRootDir));
}
