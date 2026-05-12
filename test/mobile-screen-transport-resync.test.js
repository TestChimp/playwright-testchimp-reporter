const test = require('node:test');
const assert = require('node:assert/strict');

test('isLikelyMobileTransportFailure matches common transport messages', () => {
  const { isLikelyMobileTransportFailure } = require('../dist/rum-automation-mobile');
  assert.equal(isLikelyMobileTransportFailure(new Error('websocket closed with code 1006')), true);
  assert.equal(isLikelyMobileTransportFailure(new Error('ECONNRESET')), true);
  assert.equal(isLikelyMobileTransportFailure(new Error('rpc failed: connection closed')), true);
  assert.equal(isLikelyMobileTransportFailure(new Error('assertion failed')), false);
  assert.equal(isLikelyMobileTransportFailure(null), false);
});

test('isLikelyMobileTransportFailure is off when TESTCHIMP_RUM_TRANSPORT_RESYNC=0', () => {
  const prev = process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC;
  process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC = '0';
  try {
    delete require.cache[require.resolve('../dist/rum-automation-mobile')];
    const { isLikelyMobileTransportFailure } = require('../dist/rum-automation-mobile');
    assert.equal(isLikelyMobileTransportFailure(new Error('websocket 1006')), false);
  } finally {
    if (prev === undefined) delete process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC;
    else process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC = prev;
    delete require.cache[require.resolve('../dist/rum-automation-mobile')];
  }
});

test('wrapScreenForTransportResync calls openUrl with set after transport-like failure', async () => {
  const { wrapScreenForTransportResync } = require('../dist/mobile-screen-transport-resync');

  const openUrls = [];
  const device = {
    openUrl: async (u) => {
      openUrls.push(u);
    },
  };

  const testInfo = {
    file: 'tests/foo.spec.ts',
    title: 't',
    titlePath: () => ['', 'foo.spec.ts', 't'],
    project: { name: 'mobile', rootDir: '/tmp/r' },
    retry: 0,
    workerIndex: 0,
    testId: 'resync-wrap',
  };

  const base = {
    tap: async () => {
      throw new Error('websocket closed with code 1006');
    },
  };

  const wrapped = wrapScreenForTransportResync(base, { device, testInfo });
  await assert.rejects(() => wrapped.tap(), /1006/);
  assert.ok(openUrls.some((u) => typeof u === 'string' && u.includes('truecoverage/v1/set?p=')));
});

test('wrapScreenForTransportResync does not resync when TESTCHIMP_RUM_TRANSPORT_RESYNC=0', async () => {
  const prev = process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC;
  process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC = '0';
  try {
    delete require.cache[require.resolve('../dist/mobile-screen-transport-resync')];
    delete require.cache[require.resolve('../dist/rum-automation-mobile')];
    const { wrapScreenForTransportResync } = require('../dist/mobile-screen-transport-resync');

    const openUrls = [];
    const device = { openUrl: async (u) => openUrls.push(u) };
    const testInfo = {
      file: 'x',
      title: 't',
      titlePath: () => ['t'],
      project: { rootDir: '/tmp' },
      retry: 0,
      workerIndex: 0,
      testId: 'id',
    };
    const wrapped = wrapScreenForTransportResync(
      {
        tap: async () => {
          throw new Error('websocket 1006');
        },
      },
      { device, testInfo }
    );
    await assert.rejects(() => wrapped.tap(), /1006/);
    assert.equal(openUrls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC;
    else process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC = prev;
    delete require.cache[require.resolve('../dist/mobile-screen-transport-resync')];
    delete require.cache[require.resolve('../dist/rum-automation-mobile')];
  }
});

test('attachMobileScreenTransportResync is no-op when TESTCHIMP_RUM_TRANSPORT_RESYNC=0', () => {
  const prev = process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC;
  process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC = '0';
  try {
    delete require.cache[require.resolve('../dist/mobile-screen-transport-resync')];
    delete require.cache[require.resolve('../dist/rum-automation-mobile')];
    const { attachMobileScreenTransportResync } = require('../dist/mobile-screen-transport-resync');
    const t = { id: 1 };
    assert.strictEqual(attachMobileScreenTransportResync(t), t);
  } finally {
    if (prev === undefined) delete process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC;
    else process.env.TESTCHIMP_RUM_TRANSPORT_RESYNC = prev;
    delete require.cache[require.resolve('../dist/mobile-screen-transport-resync')];
    delete require.cache[require.resolve('../dist/rum-automation-mobile')];
  }
});
