const test = require('node:test');
const assert = require('node:assert/strict');

function withProjectType(value, fn) {
  const prev = process.env.TESTCHIMP_PROJECT_TYPE;
  if (value === undefined) {
    delete process.env.TESTCHIMP_PROJECT_TYPE;
  } else {
    process.env.TESTCHIMP_PROJECT_TYPE = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env.TESTCHIMP_PROJECT_TYPE;
    } else {
      process.env.TESTCHIMP_PROJECT_TYPE = prev;
    }
  }
}

test('defaults to web fixture/runtime when TESTCHIMP_PROJECT_TYPE is unset', () => {
  withProjectType(undefined, () => {
    const {
      isMobileProjectType,
      getFixtureKey,
      getTestRuntimeModuleName,
    } = require('../dist/project-type');
    assert.equal(isMobileProjectType(), false);
    assert.equal(getFixtureKey(), 'page');
    assert.equal(getTestRuntimeModuleName(), '@playwright/test');
  });
});

test('ios/android values are case-insensitive and map to mobile fixture/runtime', () => {
  for (const value of ['ios', 'IOS', 'android', 'AnDrOiD']) {
    withProjectType(value, () => {
      const {
        isMobileProjectType,
        getFixtureKey,
        getTestRuntimeModuleName,
      } = require('../dist/project-type');
      assert.equal(isMobileProjectType(), true);
      assert.equal(getFixtureKey(), 'screen');
      assert.equal(getTestRuntimeModuleName(), 'mobilewright');
    });
  }
});

test('project type "mobile" is not treated as a supported mobile project type', () => {
  withProjectType('mobile', () => {
    const {
      isMobileProjectType,
      getFixtureKey,
      getTestRuntimeModuleName,
    } = require('../dist/project-type');
    assert.equal(isMobileProjectType(), false);
    assert.equal(getFixtureKey(), 'page');
    assert.equal(getTestRuntimeModuleName(), '@playwright/test');
  });
});

test('mobile runtime module can be overridden', () => {
  const prevType = process.env.TESTCHIMP_PROJECT_TYPE;
  const prevMod = process.env.TESTCHIMP_MOBILE_TEST_MODULE;
  process.env.TESTCHIMP_PROJECT_TYPE = 'ios';
  process.env.TESTCHIMP_MOBILE_TEST_MODULE = '@custom/mobile-test';
  try {
    const { getTestRuntimeModuleName } = require('../dist/project-type');
    assert.equal(getTestRuntimeModuleName(), '@custom/mobile-test');
  } finally {
    if (prevType === undefined) delete process.env.TESTCHIMP_PROJECT_TYPE;
    else process.env.TESTCHIMP_PROJECT_TYPE = prevType;
    if (prevMod === undefined) delete process.env.TESTCHIMP_MOBILE_TEST_MODULE;
    else process.env.TESTCHIMP_MOBILE_TEST_MODULE = prevMod;
  }
});

