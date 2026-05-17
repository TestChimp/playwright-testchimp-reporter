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
