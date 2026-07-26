const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const reporterPath = path.join(__dirname, '..', 'dist', 'testchimp-reporter.js');

/** 1x1 PNG */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function makeTestCase() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-reporter-'));
  const file = path.join(rootDir, 'tests', 'e2e', 'sample.spec.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '// fixture');
  const project = { name: 'chromium', use: {} };
  // Every Suite in the chain must implement project(); describe returns undefined, root returns project.
  const rootSuite = {
    type: 'suite',
    title: '',
    parent: undefined,
    project: () => project,
  };
  const describeSuite = {
    type: 'describe',
    title: '',
    parent: rootSuite,
    project: () => undefined,
  };
  return {
    id: 'test-id-1',
    title: 'sample test',
    retries: 0,
    location: { file, line: 1, column: 1 },
    titlePath: () => ['sample.spec.js', 'sample test'],
    parent: describeSuite,
    annotations: [],
    _rootDir: rootDir,
  };
}

function makeResult(status, screenshotPath) {
  return {
    status,
    duration: 10,
    retry: 0,
    startTime: new Date(),
    errors: [],
    error: status === 'failed' ? { message: 'boom' } : undefined,
    attachments: screenshotPath
      ? [
          {
            name: 'screenshot',
            contentType: 'image/png',
            path: screenshotPath,
          },
        ]
      : [],
    steps: [],
    annotations: [],
  };
}

describe('CI ingest drained by onEnd (Playwright fire-and-forget onTestEnd)', () => {
  const savedEnv = {};
  const envKeys = ['TESTCHIMP_API_KEY', 'TESTCHIMP_BACKEND_URL', 'TESTCHIMP_EXECUTION_MODE', 'EXPLORECHIMP_ENABLED'];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
    }
    process.env.TESTCHIMP_API_KEY = 'test-key-not-secret';
    process.env.TESTCHIMP_BACKEND_URL = 'https://example.testchimp.invalid';
    delete process.env.TESTCHIMP_EXECUTION_MODE;
    delete process.env.EXPLORECHIMP_ENABLED;
    delete require.cache[require.resolve(reporterPath)];
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('awaits slow screenshot upload + ingest before completeBatchInvocation when onTestEnd is not awaited', async () => {
    const { TestChimpReporter } = require(reporterPath);
    const test = makeTestCase();
    const screenshotPath = path.join(test._rootDir, 'fail.png');
    fs.writeFileSync(screenshotPath, TINY_PNG);

    const order = [];
    let resolveUpload;
    const uploadStarted = new Promise((r) => {
      resolveUpload = r;
    });

    const reporter = new TestChimpReporter({
      executionMode: 'ci',
      captureScreenshots: true,
      verbose: false,
      testsFolder: 'tests',
    });

    const suite = {
      tests: [test],
      suites: [],
    };
    const config = {
      rootDir: test._rootDir,
      projects: [],
    };

    reporter.onBegin(config, suite);
    assert.equal(reporter.isEnabled, true);

    // Replace live HTTP client with a slow upload + ordered ingest/completeBatch.
    const mockClient = {
      getBaseUrl: () => 'https://example.testchimp.invalid',
      uploadAttachment: async () => {
        order.push('upload_start');
        resolveUpload();
        await new Promise((r) => setTimeout(r, 80));
        order.push('upload_done');
        return { gcpPath: 'gs://bucket/shot.jpg' };
      },
      ingestExecutionReport: async () => {
        order.push('ingest');
        return { jobId: 'job-1', testFound: true };
      },
      completeBatchInvocation: async () => {
        order.push('complete_batch');
        return { materialized: true };
      },
    };
    reporter.apiClient = mockClient;

    // Seed a step so screenshot attach has a target (failing or last-step fallback).
    reporter.onTestBegin(test, makeResult('passed'));
    const testKey = `${test.id}_attempt_0`;
    const execution = reporter.testExecutions.get(testKey);
    assert.ok(execution);
    execution.steps.push({
      stepId: 'step_1',
      description: 'expect visible',
      status: 2, // FAILURE_STEP_EXECUTION-ish; numeric ok for attach filter
      screenshotPath: undefined,
    });
    // Force FAILURE status enum value used by attachScreenshotsToFailingSteps
    const { StepExecutionStatus } = require(path.join(__dirname, '..', 'dist', 'types.js'));
    execution.steps[0].status = StepExecutionStatus.FAILURE_STEP_EXECUTION;

    const result = makeResult('failed', screenshotPath);

    // Simulate Playwright V2: fire-and-forget onTestEnd (do not await).
    reporter.onTestEnd(test, result);
    await uploadStarted;
    assert.ok(order.includes('upload_start'));
    assert.ok(!order.includes('ingest'), 'ingest must not finish before onEnd drains');

    await reporter.onEnd({ status: 'failed' });

    assert.deepEqual(
      order.filter((x) => x === 'upload_start' || x === 'upload_done' || x === 'ingest' || x === 'complete_batch'),
      ['upload_start', 'upload_done', 'ingest', 'complete_batch']
    );
  });
});
