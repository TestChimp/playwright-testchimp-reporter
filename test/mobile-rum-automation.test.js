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

function decodeSetPayload(url) {
  const prefix = 'testchimp-rum://truecoverage/v1/set?p=';
  assert.ok(url.startsWith(prefix));
  const p = url.slice(prefix.length);
  return JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
}

test('attachMobileRumAutomationHooks registers beforeEach for mobile automation', async () => {
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
  assert.equal(calls.length, 2);
  assert.equal(calls[0], 'testchimp-rum://truecoverage/v1/clear');
  assert.ok(calls[1].includes('testchimp-rum://truecoverage/v1/set?p='));
});

test('beforeEach calls launchApp before openUrl when bundleId and launchApp exist', async () => {
  const { attachMobileRumAutomationHooks } = require('../dist/rum-automation-mobile');
  const calls = [];
  const device = {
    launchApp: async (bid) => {
      calls.push({ kind: 'launch', bid });
    },
    openUrl: async (u) => {
      calls.push({ kind: 'openUrl', u });
    },
  };
  const hooks = { beforeEach: null, afterEach: null };
  attachMobileRumAutomationHooks({
    beforeEach(fn) {
      hooks.beforeEach = fn;
      return this;
    },
    afterEach(fn) {
      hooks.afterEach = fn;
      return this;
    },
  });

  const testInfo = {
    file: 'tests/foo.spec.ts',
    title: 't',
    titlePath: () => ['', 'foo.spec.ts', 't'],
    project: { name: 'mobile', rootDir: '/tmp/r' },
    retry: 0,
    workerIndex: 0,
    testId: 'id1',
  };

  await hooks.beforeEach({ device, bundleId: 'com.example.app' }, testInfo);
  assert.equal(calls.length, 6);
  assert.equal(calls[0].kind, 'openUrl');
  assert.deepEqual(calls[1], { kind: 'launch', bid: 'com.example.app' });
  assert.equal(calls[2].kind, 'openUrl');
  assert.equal(calls[3].kind, 'openUrl');
  assert.equal(calls[4].kind, 'openUrl');
  assert.equal(calls[5].kind, 'openUrl');
});

test('successive tests get distinct set payloads from their testInfo', async () => {
  const { attachMobileRumAutomationHooks } = require('../dist/rum-automation-mobile');
  const calls = [];
  const device = {
    openUrl: async (u) => {
      calls.push(u);
    },
  };
  const hooks = { beforeEach: null, afterEach: null };
  attachMobileRumAutomationHooks({
    beforeEach(fn) {
      hooks.beforeEach = fn;
      return this;
    },
    afterEach(fn) {
      hooks.afterEach = fn;
      return this;
    },
  });

  const base = {
    file: 'tests/foo.spec.ts',
    project: { name: 'mobile', rootDir: '/tmp/r' },
    retry: 0,
    workerIndex: 0,
    testId: 'same',
  };

  await hooks.beforeEach(
    { device },
    { ...base, title: 'first', titlePath: () => ['', 'foo.spec.ts', 'first'] }
  );
  await hooks.beforeEach(
    { device },
    { ...base, title: 'second', titlePath: () => ['', 'foo.spec.ts', 'second'] }
  );

  const setUrls = calls.filter((u) => u.includes('/set?p='));
  assert.equal(setUrls.length, 2);
  const p1 = decodeSetPayload(setUrls[0]);
  const p2 = decodeSetPayload(setUrls[1]);
  assert.notEqual(JSON.stringify(p1), JSON.stringify(p2));
  assert.equal(calls[0], 'testchimp-rum://truecoverage/v1/clear');
  assert.equal(calls[2], 'testchimp-rum://truecoverage/v1/clear');
});

test('openUrl set retries until success', async () => {
  const { attachMobileRumAutomationHooks } = require('../dist/rum-automation-mobile');
  let openCount = 0;
  const device = {
    openUrl: async (u) => {
      openCount += 1;
      if (u.includes('/set?p=') && openCount < 3) {
        throw new Error('transient');
      }
    },
  };
  const hooks = { beforeEach: null, afterEach: null };
  attachMobileRumAutomationHooks({
    beforeEach(fn) {
      hooks.beforeEach = fn;
      return this;
    },
    afterEach(fn) {
      hooks.afterEach = fn;
      return this;
    },
  });

  const testInfo = {
    file: 'tests/foo.spec.ts',
    title: 't',
    titlePath: () => ['', 'foo.spec.ts', 't'],
    project: { name: 'mobile', rootDir: '/tmp/r' },
    retry: 0,
    workerIndex: 0,
    testId: 'x',
  };

  await hooks.beforeEach({ device }, testInfo);
  assert.equal(openCount, 3);
});

test('beforeEach sends set URL four times when app launch succeeds', async () => {
  const { attachMobileRumAutomationHooks } = require('../dist/rum-automation-mobile');
  const urls = [];
  const device = {
    launchApp: async () => {},
    openUrl: async (u) => {
      urls.push(u);
    },
  };
  const hooks = { beforeEach: null, afterEach: null };
  attachMobileRumAutomationHooks({
    beforeEach(fn) {
      hooks.beforeEach = fn;
      return this;
    },
    afterEach(fn) {
      hooks.afterEach = fn;
      return this;
    },
  });

  const testInfo = {
    file: 'tests/foo.spec.ts',
    title: 't',
    titlePath: () => ['', 'foo.spec.ts', 't'],
    project: { name: 'mobile', rootDir: '/tmp/r' },
    retry: 0,
    workerIndex: 0,
    testId: 'x',
  };

  await hooks.beforeEach({ device, bundleId: 'com.example.app' }, testInfo);
  const setUrls = urls.filter((u) => u.includes('/set?p='));
  assert.equal(setUrls.length, 4);
  assert.equal(setUrls[0], setUrls[1]);
  assert.equal(setUrls[0], setUrls[2]);
  assert.equal(setUrls[0], setUrls[3]);
});

test('beforeEach no-op when device is missing (e.g. setup project)', async () => {
  const { attachMobileRumAutomationHooks } = require('../dist/rum-automation-mobile');
  const hooks = { beforeEach: null, afterEach: null };
  attachMobileRumAutomationHooks({
    beforeEach(fn) {
      hooks.beforeEach = fn;
      return this;
    },
    afterEach(fn) {
      hooks.afterEach = fn;
      return this;
    },
  });

  const testInfo = {
    file: 'setup/global.setup.spec.js',
    title: 'global setup',
    titlePath: () => ['', 'global.setup.spec.js', 'global setup'],
    project: { name: 'setup', rootDir: '/tmp/r' },
    retry: 0,
    workerIndex: 0,
    testId: 'setup',
  };

  await hooks.beforeEach({}, testInfo);
});
