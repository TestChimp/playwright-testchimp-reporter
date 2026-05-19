const test = require('node:test');
const assert = require('node:assert/strict');

test('resolveWebRumFlushTimeoutMs defaults to 5000', () => {
  const prev = process.env.TESTCHIMP_RUM_WEB_FLUSH_TIMEOUT_MS;
  delete process.env.TESTCHIMP_RUM_WEB_FLUSH_TIMEOUT_MS;
  const { resolveWebRumFlushTimeoutMs } = require('../dist/rum-automation-web');
  assert.equal(resolveWebRumFlushTimeoutMs(), 5000);
  if (prev !== undefined) process.env.TESTCHIMP_RUM_WEB_FLUSH_TIMEOUT_MS = prev;
});

test('resolveWebRumFlushTimeoutMs clamps env value', () => {
  const prev = process.env.TESTCHIMP_RUM_WEB_FLUSH_TIMEOUT_MS;
  process.env.TESTCHIMP_RUM_WEB_FLUSH_TIMEOUT_MS = '99999';
  delete require.cache[require.resolve('../dist/rum-automation-web')];
  const { resolveWebRumFlushTimeoutMs } = require('../dist/rum-automation-web');
  assert.equal(resolveWebRumFlushTimeoutMs(), 30000);
  if (prev !== undefined) process.env.TESTCHIMP_RUM_WEB_FLUSH_TIMEOUT_MS = prev;
  else delete process.env.TESTCHIMP_RUM_WEB_FLUSH_TIMEOUT_MS;
});

function fakePage(overrides = {}) {
  return {
    evaluate: async () => {},
    ...overrides,
  };
}

test('flushWebRumBuffer calls page.evaluate for flush', async () => {
  const { flushWebRumBuffer } = require('../dist/rum-automation-web');
  let evaluateCalls = 0;
  const page = fakePage({
    evaluate: async () => {
      evaluateCalls += 1;
    },
  });
  await flushWebRumBuffer(page);
  assert.equal(evaluateCalls, 1);
});

test('flushWebRumBuffer re-syncs CI then flushes when testInfo provided', async () => {
  const { flushWebRumBuffer } = require('../dist/rum-automation-web');
  const evaluateArgs = [];
  const page = fakePage({
    evaluate: async (fn, arg) => {
      evaluateArgs.push({ hasArg: arg !== undefined, argType: typeof arg });
    },
  });
  const testInfo = {
    file: '/tmp/tests/web/e2e/menu.spec.js',
    title: 'main dishes',
    titlePath: () => ['', 'menu.spec.js', 'main dishes'],
    project: { name: 'web', rootDir: '/tmp/tests', use: {} },
    retry: 0,
    workerIndex: 0,
    testId: 'tid-menu',
  };
  await flushWebRumBuffer(page, testInfo, '/tmp/tests');
  assert.equal(evaluateArgs.length, 2);
  assert.equal(evaluateArgs[0].hasArg, true);
  assert.equal(evaluateArgs[0].argType, 'string');
  assert.equal(evaluateArgs[1].hasArg, true);
  assert.equal(evaluateArgs[1].argType, 'number');
});

test('flushWebRumBuffer is non-fatal when evaluate throws', async () => {
  const { flushWebRumBuffer } = require('../dist/rum-automation-web');
  const page = fakePage({
    evaluate: async () => {
      throw new Error('page closed');
    },
  });
  await assert.doesNotReject(() => flushWebRumBuffer(page));
});
