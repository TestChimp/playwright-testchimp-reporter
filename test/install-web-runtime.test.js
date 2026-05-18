const test = require('node:test');
const assert = require('node:assert/strict');

test('installTestChimp(page) does not register mobile afterEach hooks', () => {
  const { installTestChimp } = require('../dist/runtime');
  const hooks = { afterEach: null, afterAll: null };
  const fakeTest = {
    extend() {
      return fakeTest;
    },
    afterEach(fn) {
      hooks.afterEach = fn;
      return this;
    },
    afterAll(fn) {
      hooks.afterAll = fn;
      return this;
    },
  };
  installTestChimp(fakeTest, { uiFixture: 'page' });
  assert.equal(hooks.afterEach, null);
  assert.equal(hooks.afterAll, null);
});

test('installTestChimp(page) flushes RUM after page fixture use', async () => {
  const { installTestChimp } = require('../dist/runtime');
  let pageFixture;
  const fakeTest = {
    extend(fixtures) {
      if (fixtures.page) pageFixture = fixtures.page;
      return fakeTest;
    },
    afterEach() {
      return this;
    },
  };
  installTestChimp(fakeTest, { uiFixture: 'page' });
  assert.equal(typeof pageFixture, 'function');

  const evaluateCalls = [];
  const page = {
    addInitScript: async () => {},
    evaluate: async (fn, arg) => {
      evaluateCalls.push({ fn, arg });
    },
  };
  const testInfo = {
    file: 'tests/foo.spec.ts',
    title: 'my test',
    titlePath: () => ['', 'foo.spec.ts', 'my test'],
    project: { name: 'chromium', rootDir: '/tmp/r', use: {} },
    retry: 0,
    workerIndex: 0,
    testId: 't1',
  };

  let used = false;
  await pageFixture({ page }, async () => {
    used = true;
  }, testInfo);
  assert.equal(used, true);
  assert.equal(evaluateCalls.length, 2);
  assert.equal(typeof evaluateCalls[0].arg, 'string');
  assert.equal(evaluateCalls[1].arg, undefined);
});

test('installTestChimp(screen) registers mobile afterEach hook', () => {
  const { installTestChimp } = require('../dist/runtime');
  const hooks = { afterEach: null };
  const fakeTest = {
    extend() {
      return fakeTest;
    },
    afterEach(fn) {
      hooks.afterEach = fn;
      return this;
    },
  };
  installTestChimp(fakeTest, { uiFixture: 'screen' });
  assert.equal(typeof hooks.afterEach, 'function');
});
