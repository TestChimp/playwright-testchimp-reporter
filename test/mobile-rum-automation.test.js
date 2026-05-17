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

/** Mobilewright UI project mock — platform comes from projects[].use.platform. */
function mobileProject(extra = {}) {
  return { name: 'mobile', rootDir: '/tmp/r', use: { platform: 'ios' }, ...extra };
}

test('getMobileRumAutomationUrls includes default flush URL', () => {
  const { getMobileRumAutomationUrls } = require('../dist/rum-automation-mobile');
  const urls = getMobileRumAutomationUrls();
  assert.equal(urls.flushUrl, 'testchimp-rum://truecoverage/v1/flush');
});

function getCapturedDeviceFixture() {
  let deviceFixture;
  const fakeTest = {
    extend(fixtures) {
      deviceFixture = fixtures.device;
      return fakeTest;
    },
  };
  const { extendMobileTestWithTrueCoverageDevice } = require('../dist/rum-automation-mobile');
  extendMobileTestWithTrueCoverageDevice(fakeTest);
  assert.ok(typeof deviceFixture === 'function');
  return deviceFixture;
}

test('attachMobileRumAutomationHooks registers afterEach only (SET is device fixture)', async () => {
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
  assert.equal(hooks.beforeEach, null);

  const testInfo = {
    file: 'tests/foo.spec.ts',
    title: 'my test',
    titlePath: () => ['', 'foo.spec.ts', 'my test'],
    project: mobileProject(),
    retry: 0,
    workerIndex: 1,
    testId: 'abc',
  };

  await hooks.afterEach({ device }, testInfo);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('testchimp-rum://truecoverage/v1/set?p='));
  assert.equal(calls[1], 'testchimp-rum://truecoverage/v1/flush');
});

test('afterEach sends flush after trailing set', async () => {
  const { attachMobileRumAutomationHooks } = require('../dist/rum-automation-mobile');
  const calls = [];
  const device = {
    openUrl: async (u) => {
      calls.push(u);
    },
  };
  const hooks = { afterEach: null };
  attachMobileRumAutomationHooks({
    afterEach(fn) {
      hooks.afterEach = fn;
      return this;
    },
  });

  const testInfo = {
    file: 'tests/foo.spec.ts',
    title: 't',
    titlePath: () => ['', 'foo.spec.ts', 't'],
    project: mobileProject(),
    retry: 0,
    workerIndex: 0,
    testId: 'flush-order',
  };

  await hooks.afterEach({ device }, testInfo);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('/set?p='));
  assert.equal(calls[1], 'testchimp-rum://truecoverage/v1/flush');
});

test('device fixture does not call launchApp (Mobilewright owns launch)', async () => {
  const deviceFixture = getCapturedDeviceFixture();
  const calls = [];
  const device = {
    launchApp: async () => {
      calls.push('launch');
    },
    openUrl: async (u) => calls.push(u),
  };
  const testInfo = {
    file: 'tests/foo.spec.ts',
    title: 't',
    titlePath: () => ['', 'foo.spec.ts', 't'],
    project: mobileProject(),
    retry: 0,
    workerIndex: 0,
    testId: 'id1',
  };
  let used;
  await deviceFixture(
    { device },
    async (d) => {
      used = d;
    },
    testInfo
  );
  assert.strictEqual(used, device);
  assert.ok(!calls.includes('launch'));
  assert.equal(calls.filter((c) => typeof c === 'string' && c.includes('/set?p=')).length, 1);
});

test('successive device fixture invocations get distinct set payloads from their testInfo', async () => {
  const deviceFixture = getCapturedDeviceFixture();
  const calls = [];
  const device = {
    openUrl: async (u) => {
      calls.push(u);
    },
  };

  const base = {
    file: 'tests/foo.spec.ts',
    project: mobileProject(),
    retry: 0,
    workerIndex: 0,
    testId: 'same',
  };

  const run = async (title) => {
    await deviceFixture(
      { device },
      async () => {},
      { ...base, title, titlePath: () => ['', 'foo.spec.ts', title] }
    );
  };

  await run('first');
  await run('second');

  const setUrls = calls.filter((u) => u.includes('/set?p='));
  assert.equal(setUrls.length, 2);
  const p1 = decodeSetPayload(setUrls[0]);
  const p2 = decodeSetPayload(setUrls[1]);
  assert.notEqual(JSON.stringify(p1), JSON.stringify(p2));
});

test('device fixture openUrl set retries until success', async () => {
  try {
    delete require.cache[require.resolve('../dist/rum-automation-mobile')];
    const deviceFixture = getCapturedDeviceFixture();
    let openCount = 0;
    const device = {
      openUrl: async (u) => {
        openCount += 1;
        if (u.includes('/set?p=') && openCount < 3) {
          throw new Error('transient');
        }
      },
    };

    const testInfo = {
      file: 'tests/foo.spec.ts',
      title: 't',
      titlePath: () => ['', 'foo.spec.ts', 't'],
      project: mobileProject(),
      retry: 0,
      workerIndex: 0,
      testId: 'x',
    };

    await deviceFixture({ device }, async () => {}, testInfo);
    assert.equal(openCount, 3);
  } finally {
    delete require.cache[require.resolve('../dist/rum-automation-mobile')];
  }
});

test('device fixture sends one SET per test', async () => {
  const deviceFixture = getCapturedDeviceFixture();
  const urls = [];
  const device = {
    openUrl: async (u) => {
      urls.push(u);
    },
  };

  const testInfo = {
    file: 'tests/foo.spec.ts',
    title: 't',
    titlePath: () => ['', 'foo.spec.ts', 't'],
    project: mobileProject(),
    retry: 0,
    workerIndex: 0,
    testId: 'x',
  };

  await deviceFixture({ device, bundleId: 'com.example.app' }, async () => {}, testInfo);
  const setUrls = urls.filter((u) => u.includes('/set?p='));
  assert.equal(setUrls.length, 1);
});

test('openUrl respects OPEN_URL_TIMEOUT_MS and does not hang forever (device fixture)', async () => {
  process.env.TESTCHIMP_RUM_AUTOMATION_OPEN_URL_TIMEOUT_MS = '50';
  try {
    delete require.cache[require.resolve('../dist/rum-automation-mobile')];
    const { extendMobileTestWithTrueCoverageDevice } = require('../dist/rum-automation-mobile');
    let deviceFixture;
    const fakeTest = {
      extend(f) {
        deviceFixture = f.device;
        return fakeTest;
      },
    };
    extendMobileTestWithTrueCoverageDevice(fakeTest);

    const calls = [];
    const device = {
      openUrl: async () => {
        calls.push('hang');
        await new Promise(() => {
          /* never resolves */
        });
      },
    };

    const testInfo = {
      file: 'tests/foo.spec.ts',
      title: 't',
      titlePath: () => ['', 'foo.spec.ts', 't'],
      project: mobileProject(),
      retry: 0,
      workerIndex: 0,
      testId: 'timeout',
    };

    const t0 = Date.now();
    await deviceFixture({ device }, async () => {}, testInfo);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 8000, `expected bounded fixture time, got ${elapsed}ms`);
    assert.ok(calls.length >= 3, 'should retry hung openUrl');
  } finally {
    delete process.env.TESTCHIMP_RUM_AUTOMATION_OPEN_URL_TIMEOUT_MS;
    delete require.cache[require.resolve('../dist/rum-automation-mobile')];
  }
});

test('device fixture no-op when device cannot openUrl (e.g. setup project)', async () => {
  const deviceFixture = getCapturedDeviceFixture();
  const testInfo = {
    file: 'setup/global.setup.spec.js',
    title: 'global setup',
    titlePath: () => ['', 'global.setup.spec.js', 'global setup'],
    project: { name: 'setup', rootDir: '/tmp/r' },
    retry: 0,
    workerIndex: 0,
    testId: 'setup',
  };
  let sawUse = false;
  await deviceFixture({}, async () => {
    sawUse = true;
  }, testInfo);
  assert.ok(sawUse);
});

test('device fixture sends SET even when use.platform is missing (0.2.0 regression)', async () => {
  const deviceFixture = getCapturedDeviceFixture();
  const calls = [];
  const device = {
    openUrl: async (u) => {
      calls.push(u);
    },
  };
  for (const project of [
    { name: 'ios', rootDir: '/tmp/r', use: {} },
    { name: 'bad', rootDir: '/tmp/r', use: { platform: 'mobile' } },
  ]) {
    const testInfo = {
      file: 'tests/foo.spec.ts',
      title: 't',
      titlePath: () => ['', 'foo.spec.ts', 't'],
      project,
      retry: 0,
      workerIndex: 0,
      testId: 'x',
    };
    calls.length = 0;
    await deviceFixture({ device }, async () => {}, testInfo);
    assert.equal(
      calls.filter((c) => typeof c === 'string' && c.includes('/set?p=')).length,
      1,
      `expected one SET for project ${JSON.stringify(project.use)}`
    );
  }
});

test('screen fixture does not send SET (device owns SET)', async () => {
  delete require.cache[require.resolve('../dist/mobile-screen-transport-resync')];
  const { attachMobileScreenTransportResync } = require('../dist/mobile-screen-transport-resync');
  let screenFixture;
  const fakeTest = {
    extend(f) {
      screenFixture = f.screen;
      return fakeTest;
    },
  };
  attachMobileScreenTransportResync(fakeTest);

  const calls = [];
  const device = { openUrl: async (u) => calls.push(u) };
  const screen = { tap: async () => {} };
  const testInfo = {
    file: 'tests/foo.spec.ts',
    title: 'screen only',
    titlePath: () => ['', 'foo.spec.ts', 'screen only'],
    project: mobileProject(),
    retry: 0,
    workerIndex: 0,
    testId: 'sp',
  };
  await screenFixture({ screen, device }, async () => {}, testInfo);
  assert.equal(calls.filter((u) => u.includes('/set?p=')).length, 0);
});

test('afterEach skips mobile URLs when platformFromTestInfo is web', async () => {
  const { attachMobileRumAutomationHooks } = require('../dist/rum-automation-mobile');
  const calls = [];
  const device = {
    openUrl: async (u) => {
      calls.push(u);
    },
  };
  const hooks = { afterEach: null };
  attachMobileRumAutomationHooks({
    afterEach(fn) {
      hooks.afterEach = fn;
      return this;
    },
  });
  const testInfo = {
    file: 'tests/api.spec.ts',
    title: 'api test',
    titlePath: () => ['', 'api.spec.ts', 'api test'],
    project: { name: 'api', rootDir: '/tmp/r', use: {} },
    retry: 0,
    workerIndex: 0,
    testId: 'api',
  };
  await hooks.afterEach({ device }, testInfo);
  assert.equal(calls.length, 0);
});

test('attachMobileRumAutomationHooks does not register afterAll clear by default', async () => {
  const { attachMobileRumAutomationHooks } = require('../dist/rum-automation-mobile');
  let afterAllFn = null;
  attachMobileRumAutomationHooks({
    afterEach() {
      return this;
    },
    afterAll(fn) {
      afterAllFn = fn;
      return this;
    },
  });
  assert.ok(afterAllFn == null);
});

test('attachMobileRumAutomationHooks registers afterAll clear+flush when SUITE_TEARDOWN_CLEAR=1', async () => {
  process.env.TESTCHIMP_RUM_AUTOMATION_SUITE_TEARDOWN_CLEAR = '1';
  try {
    const resolved = require.resolve('../dist/rum-automation-mobile');
    delete require.cache[resolved];
    const { attachMobileRumAutomationHooks } = require(resolved);
    let afterAllFn = null;
    attachMobileRumAutomationHooks({
      afterEach() {
        return this;
      },
      afterAll(fn) {
        afterAllFn = fn;
        return this;
      },
    });
    assert.ok(typeof afterAllFn === 'function');
    const calls = [];
    await afterAllFn({ device: { openUrl: async (u) => calls.push(u) } });
    assert.equal(calls[0], 'testchimp-rum://truecoverage/v1/clear');
    assert.equal(calls[1], 'testchimp-rum://truecoverage/v1/flush');
  } finally {
    delete process.env.TESTCHIMP_RUM_AUTOMATION_SUITE_TEARDOWN_CLEAR;
    delete require.cache[require.resolve('../dist/rum-automation-mobile')];
  }
});

test('legacy: device fixture clears first when TESTCHIMP_RUM_AUTOMATION_CLEAR_BETWEEN_TESTS=1', async () => {
  process.env.TESTCHIMP_RUM_AUTOMATION_CLEAR_BETWEEN_TESTS = '1';
  try {
    const resolved = require.resolve('../dist/rum-automation-mobile');
    delete require.cache[resolved];
    const { extendMobileTestWithTrueCoverageDevice } = require(resolved);
    let deviceFixture;
    const fakeTest = {
      extend(f) {
        deviceFixture = f.device;
        return fakeTest;
      },
    };
    extendMobileTestWithTrueCoverageDevice(fakeTest);

    const calls = [];
    const device = {
      openUrl: async (u) => {
        calls.push(u);
      },
    };
    const testInfo = {
      file: 'tests/foo.spec.ts',
      title: 'my test',
      titlePath: () => ['', 'foo.spec.ts', 'my test'],
      project: mobileProject(),
      retry: 0,
      workerIndex: 1,
      testId: 'abc',
    };
    await deviceFixture({ device }, async () => {}, testInfo);
    assert.equal(calls[0], 'testchimp-rum://truecoverage/v1/clear');
    assert.ok(calls[1].includes('testchimp-rum://truecoverage/v1/set?p='));
  } finally {
    delete process.env.TESTCHIMP_RUM_AUTOMATION_CLEAR_BETWEEN_TESTS;
    delete require.cache[require.resolve('../dist/rum-automation-mobile')];
  }
});
