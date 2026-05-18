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

test('flushWebRumBuffer calls page.evaluate', async () => {
  const { flushWebRumBuffer } = require('../dist/rum-automation-web');
  let evaluateCalls = 0;
  const page = {
    evaluate: async () => {
      evaluateCalls += 1;
    },
  };
  await flushWebRumBuffer(page);
  assert.equal(evaluateCalls, 1);
});

test('flushWebRumBuffer is non-fatal when evaluate throws', async () => {
  const { flushWebRumBuffer } = require('../dist/rum-automation-web');
  const page = {
    evaluate: async () => {
      throw new Error('page closed');
    },
  };
  await assert.doesNotReject(() => flushWebRumBuffer(page));
});
