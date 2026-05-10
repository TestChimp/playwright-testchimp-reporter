const test = require('node:test');
const assert = require('node:assert/strict');

test('buildAutomationSetOpenUrl encodes base64url payload', () => {
  const { buildAutomationSetOpenUrl, getMobileRumAutomationUrls } = require('../dist/rum-automation-mobile');
  const { setUrlPrefix } = getMobileRumAutomationUrls();
  const json = JSON.stringify({ testName: 'a' });
  const url = buildAutomationSetOpenUrl(setUrlPrefix, json);
  assert.equal(typeof url, 'string');
  assert.ok(url.startsWith('testchimp-rum://truecoverage/v1/set?p='));
  const p = url.slice('testchimp-rum://truecoverage/v1/set?p='.length);
  const decoded = Buffer.from(p, 'base64url').toString('utf8');
  assert.equal(decoded, json);
});

test('attachMobileRumAutomationHooks always registers beforeEach/afterEach', async () => {
  const { attachMobileRumAutomationHooks } = require('../dist/rum-automation-mobile');

  const calls = [];
  const device = {
    openUrl: async (u) => {
      calls.push(u);
    },
  };

  const hooks = { beforeEach: null, afterEach: null };
  const fakeTest = {
    beforeEach(fn) {
      hooks.beforeEach = fn;
      return this;
    },
    afterEach(fn) {
      hooks.afterEach = fn;
      return this;
    },
  };

  const out = attachMobileRumAutomationHooks(fakeTest);
  assert.strictEqual(out, fakeTest);
  assert.ok(typeof hooks.beforeEach === 'function');
  assert.ok(typeof hooks.afterEach === 'function');

  const testInfo = {
    file: 'tests/foo.spec.ts',
    title: 'my test',
    titlePath: () => ['', 'foo.spec.ts', 'my test'],
    project: { name: 'mobile', rootDir: '/tmp/r' },
    retry: 0,
    workerIndex: 1,
    testId: 'abc',
  };

  await hooks.beforeEach({ device }, testInfo);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('testchimp-rum://truecoverage/v1/set?p='));

  await hooks.afterEach({ device });
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'testchimp-rum://truecoverage/v1/clear');
});
