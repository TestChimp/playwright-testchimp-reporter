/**
 * Unit tests for API coverage capture: timeouts, skip rules, bounded drain.
 * Capture must never hang fixture teardown (P0).
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const PENDING_KEY = '__testchimpApiCoveragePending';
const BUFFER_KEY = '__testchimpApiCoverageBuffers';

beforeEach(() => {
  delete process.env.TESTCHIMP_ENABLE_API_CAPTURE;
  delete process.env.TESTCHIMP_API_COVERAGE_BODY_TIMEOUT_MS;
  delete process.env.TESTCHIMP_API_COVERAGE_DRAIN_TIMEOUT_MS;
});

afterEach(() => {
  delete process.env.TESTCHIMP_ENABLE_API_CAPTURE;
  delete process.env.TESTCHIMP_API_COVERAGE_BODY_TIMEOUT_MS;
  delete process.env.TESTCHIMP_API_COVERAGE_DRAIN_TIMEOUT_MS;
});

test('isApiCoverageEnabled defaults off; TESTCHIMP_ENABLE_API_CAPTURE opts in', () => {
  const { isApiCoverageEnabled, apiCoveragePayloadsEnabled } = require('../dist/api-coverage/capture');
  assert.equal(isApiCoverageEnabled(), false);
  assert.equal(apiCoveragePayloadsEnabled(), false);
  process.env.TESTCHIMP_ENABLE_API_CAPTURE = '1';
  assert.equal(isApiCoverageEnabled(), true);
  assert.equal(apiCoveragePayloadsEnabled(), true);
  process.env.TESTCHIMP_ENABLE_API_CAPTURE = '0';
  assert.equal(isApiCoverageEnabled(), false);
});

test('resolveApiCoverageBodyTimeoutMs defaults to 1500', () => {
  const { resolveApiCoverageBodyTimeoutMs } = require('../dist/api-coverage/capture');
  assert.equal(resolveApiCoverageBodyTimeoutMs(), 1500);
});

test('resolveApiCoverageDrainTimeoutMs defaults to 5000', () => {
  const { resolveApiCoverageDrainTimeoutMs } = require('../dist/api-coverage/capture');
  assert.equal(resolveApiCoverageDrainTimeoutMs(), 5000);
});

test('resolveApiCoverageBodyTimeoutMs clamps env', () => {
  process.env.TESTCHIMP_API_COVERAGE_BODY_TIMEOUT_MS = '99999';
  const { resolveApiCoverageBodyTimeoutMs } = require('../dist/api-coverage/capture');
  assert.equal(resolveApiCoverageBodyTimeoutMs(), 10_000);
});

test('shouldSkipResourceType skips document/websocket/eventsource', () => {
  const { shouldSkipResourceType } = require('../dist/api-coverage/capture');
  assert.equal(shouldSkipResourceType('document'), true);
  assert.equal(shouldSkipResourceType('websocket'), true);
  assert.equal(shouldSkipResourceType('eventsource'), true);
  assert.equal(shouldSkipResourceType('xhr'), false);
  assert.equal(shouldSkipResourceType('fetch'), false);
});

test('shouldSkipBodyForStatus skips 204/304/1xx', () => {
  const { shouldSkipBodyForStatus } = require('../dist/api-coverage/capture');
  assert.equal(shouldSkipBodyForStatus(204), true);
  assert.equal(shouldSkipBodyForStatus(304), true);
  assert.equal(shouldSkipBodyForStatus(100), true);
  assert.equal(shouldSkipBodyForStatus(200), false);
  assert.equal(shouldSkipBodyForStatus(500), false);
});

test('drainApiCoverageInteractions returns within timeout when pending never resolves', async () => {
  process.env.TESTCHIMP_API_COVERAGE_DRAIN_TIMEOUT_MS = '80';
  // Re-require so resolvers see env (module caches env reads at call time — fine).
  const { drainApiCoverageInteractions } = require('../dist/api-coverage/capture');

  const never = new Promise(() => {});
  const page = {
    [PENDING_KEY]: new Set([never]),
    [BUFFER_KEY]: [
      {
        endpoint: '/api/ok',
        httpMethod: 'GET',
        responseCode: 200,
      },
    ],
  };

  const started = Date.now();
  const out = await drainApiCoverageInteractions(page);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2000, `drain took too long: ${elapsed}ms`);
  assert.equal(out.length, 1);
  assert.equal(out[0].endpoint, '/api/ok');
  assert.equal(page[BUFFER_KEY].length, 0);
});

test('attachApiCoverageCapture skips eventsource without body read', async () => {
  process.env.TESTCHIMP_API_COVERAGE_DRAIN_TIMEOUT_MS = '200';
  const {
    attachApiCoverageCapture,
    drainApiCoverageInteractions,
  } = require('../dist/api-coverage/capture');

  let textCalls = 0;
  const handlers = {};
  const page = {
    on(event, fn) {
      handlers[event] = fn;
    },
  };

  attachApiCoverageCapture(page, { capturePayloads: true });

  const req = {
    url: () => 'https://example.com/sse',
    method: () => 'GET',
    resourceType: () => 'eventsource',
    headers: () => ({}),
    postData: () => null,
  };
  handlers.response({
    request: () => req,
    status: () => 200,
    headers: () => ({ 'content-type': 'text/event-stream' }),
    text: async () => {
      textCalls += 1;
      return 'data: never\n\n';
    },
  });

  const out = await drainApiCoverageInteractions(page);
  assert.equal(textCalls, 0);
  assert.equal(out.length, 0);
});

test('attachApiCoverageCapture captures JSON within body timeout', async () => {
  process.env.TESTCHIMP_API_COVERAGE_BODY_TIMEOUT_MS = '500';
  process.env.TESTCHIMP_API_COVERAGE_DRAIN_TIMEOUT_MS = '1000';
  const {
    attachApiCoverageCapture,
    drainApiCoverageInteractions,
    ApiPayloadKind,
  } = require('../dist/api-coverage/capture');

  const handlers = {};
  const page = {
    on(event, fn) {
      handlers[event] = fn;
    },
  };

  attachApiCoverageCapture(page, { capturePayloads: true });

  const req = {
    url: () => 'https://api.example.com/v1/items?x=1',
    method: () => 'GET',
    resourceType: () => 'fetch',
    headers: () => ({}),
    postData: () => null,
  };
  handlers.request(req);
  handlers.response({
    request: () => req,
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    text: async () => '{"ok":true}',
  });

  const out = await drainApiCoverageInteractions(page);
  assert.equal(out.length, 1);
  assert.equal(out[0].endpoint, '/v1/items');
  assert.equal(out[0].httpMethod, 'GET');
  assert.equal(out[0].responseCode, 200);
  assert.equal(out[0].responsePayload?.kind, ApiPayloadKind.JSON);
  assert.equal(out[0].responsePayload?.jsonBody, '{"ok":true}');
  assert.equal(out[0].queryParams?.x, '1');
});

test('attachApiCoverageCapture omits payload when body read hangs past timeout', async () => {
  process.env.TESTCHIMP_API_COVERAGE_BODY_TIMEOUT_MS = '50';
  process.env.TESTCHIMP_API_COVERAGE_DRAIN_TIMEOUT_MS = '500';
  const {
    attachApiCoverageCapture,
    drainApiCoverageInteractions,
  } = require('../dist/api-coverage/capture');

  const handlers = {};
  const page = {
    on(event, fn) {
      handlers[event] = fn;
    },
  };

  attachApiCoverageCapture(page, { capturePayloads: true });

  const req = {
    url: () => 'https://api.example.com/v1/slow',
    method: () => 'GET',
    resourceType: () => 'xhr',
    headers: () => ({}),
    postData: () => null,
  };
  handlers.response({
    request: () => req,
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    text: () => new Promise(() => {}),
  });

  const started = Date.now();
  const out = await drainApiCoverageInteractions(page);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2000, `took ${elapsed}ms`);
  assert.equal(out.length, 1);
  assert.equal(out[0].endpoint, '/v1/slow');
  assert.equal(out[0].responsePayload, undefined);
});

function captureTestPage(context) {
  const handlers = {};
  let registeredHandler;
  let unroutedHandler;
  const page = {
    on(event, fn) {
      handlers[event] = fn;
    },
    async route(_url, handler) {
      registeredHandler = handler;
    },
    async unroute(_url, handler) {
      unroutedHandler = handler;
    },
    context() {
      if (!context) throw new Error('no context in unit fake');
      return context;
    },
  };
  return {
    handlers,
    page,
    registeredHandler: () => registeredHandler,
    unroutedHandler: () => unroutedHandler,
  };
}

function captureRequest(url = 'https://api.example.com/v1/mocked') {
  return {
    url: () => url,
    method: () => 'GET',
    resourceType: () => 'fetch',
    headers: () => ({}),
    postData: () => null,
  };
}

function emitCaptureResponse(handlers, req) {
  handlers.response({
    request: () => req,
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    text: async () => '{"mocked":true}',
  });
}

test('plain route.fulfill is detected as MOCKED without changing fulfill options', async () => {
  const {
    attachApiCoverageCapture,
    drainApiCoverageInteractions,
    ApiOperationInteractionType,
  } = require('../dist/api-coverage/capture');
  const fake = captureTestPage();
  attachApiCoverageCapture(fake.page, { capturePayloads: false });

  const options = { status: 201, json: { mocked: true } };
  let receivedOptions;
  const userHandler = (route) => route.fulfill(options);
  await fake.page.route('**/v1/mocked', userHandler);

  const req = captureRequest();
  const route = {
    request: () => req,
    fulfill: (actualOptions) => {
      receivedOptions = actualOptions;
      // Emit synchronously to prove the request is marked before fulfill can produce a response.
      emitCaptureResponse(fake.handlers, req);
      return Promise.resolve();
    },
  };
  await fake.registeredHandler()(route, req);

  const out = await drainApiCoverageInteractions(fake.page);
  assert.equal(receivedOptions, options);
  assert.equal(out.length, 1);
  assert.equal(out[0].interactionType, ApiOperationInteractionType.MOCKED);

  await fake.page.unroute('**/v1/mocked', userHandler);
  assert.equal(fake.unroutedHandler(), fake.registeredHandler());
});

test('legacy fulfillMocked marks without adding a response header', async () => {
  const {
    attachApiCoverageCapture,
    drainApiCoverageInteractions,
    fulfillMocked,
    ApiOperationInteractionType,
  } = require('../dist/api-coverage/capture');
  const fake = captureTestPage();
  attachApiCoverageCapture(fake.page, { capturePayloads: false });

  const req = captureRequest('https://api.example.com/v1/legacy-mock');
  const options = { status: 200, headers: { 'x-existing': 'kept' } };
  let receivedOptions;
  await fulfillMocked({
    request: () => req,
    fulfill: (actualOptions) => {
      receivedOptions = actualOptions;
      emitCaptureResponse(fake.handlers, req);
      return Promise.resolve();
    },
  }, options);

  const out = await drainApiCoverageInteractions(fake.page);
  assert.equal(receivedOptions, options);
  assert.deepEqual(receivedOptions.headers, { 'x-existing': 'kept' });
  assert.equal(out[0].interactionType, ApiOperationInteractionType.MOCKED);
});

test('route.continue remains REAL', async () => {
  const {
    attachApiCoverageCapture,
    drainApiCoverageInteractions,
    ApiOperationInteractionType,
  } = require('../dist/api-coverage/capture');
  const fake = captureTestPage();
  attachApiCoverageCapture(fake.page, { capturePayloads: false });

  await fake.page.route('**/v1/real', (route) => route.continue());
  const req = captureRequest('https://api.example.com/v1/real');
  const route = {
    request: () => req,
    continue: () => {
      emitCaptureResponse(fake.handlers, req);
      return Promise.resolve();
    },
    fulfill: () => Promise.resolve(),
  };
  await fake.registeredHandler()(route, req);

  const out = await drainApiCoverageInteractions(fake.page);
  assert.equal(out.length, 1);
  assert.equal(out[0].interactionType, ApiOperationInteractionType.REAL);
});

test('classification failure never prevents the original fulfill', async () => {
  const { attachApiCoverageCapture } = require('../dist/api-coverage/capture');
  const fake = captureTestPage();
  attachApiCoverageCapture(fake.page, { capturePayloads: false });

  let fulfillCalls = 0;
  await fake.page.route('**/*', (route) => route.fulfill({ status: 200 }));
  await fake.registeredHandler()({
    // WeakSet rejects primitives; instrumentation must swallow that and still fulfill.
    request: () => 1,
    fulfill: () => {
      fulfillCalls += 1;
      return Promise.resolve();
    },
  });
  assert.equal(fulfillCalls, 1);
});

test('original fulfill rejection is preserved', async () => {
  const { attachApiCoverageCapture } = require('../dist/api-coverage/capture');
  const fake = captureTestPage();
  attachApiCoverageCapture(fake.page, { capturePayloads: false });

  const expected = new Error('Playwright fulfill failed');
  await fake.page.route('**/*', (route) => route.fulfill({ status: 200 }));
  await assert.rejects(
    fake.registeredHandler()({
      request: () => captureRequest(),
      fulfill: () => Promise.reject(expected),
    }),
    expected
  );
});

test('rejected fulfill does not taint a later continued response as MOCKED', async () => {
  const {
    attachApiCoverageCapture,
    drainApiCoverageInteractions,
    ApiOperationInteractionType,
  } = require('../dist/api-coverage/capture');
  const fake = captureTestPage();
  attachApiCoverageCapture(fake.page, { capturePayloads: false });

  await fake.page.route('**/*', async (route) => {
    await assert.rejects(route.fulfill({ status: 200 }), /fulfill failed/);
    await route.continue();
  });
  const req = captureRequest('https://api.example.com/v1/fallback-real');
  await fake.registeredHandler()({
    request: () => req,
    fulfill: () => Promise.reject(new Error('fulfill failed')),
    continue: () => {
      emitCaptureResponse(fake.handlers, req);
      return Promise.resolve();
    },
  }, req);

  const out = await drainApiCoverageInteractions(fake.page);
  assert.equal(out.length, 1);
  assert.equal(out[0].interactionType, ApiOperationInteractionType.REAL);
});

test('sync continue after non-awaited rejected fulfill stays REAL', async () => {
  const {
    attachApiCoverageCapture,
    drainApiCoverageInteractions,
    ApiOperationInteractionType,
  } = require('../dist/api-coverage/capture');
  const fake = captureTestPage();
  attachApiCoverageCapture(fake.page, { capturePayloads: false });

  await fake.page.route('**/*', (route) => {
    void route.fulfill({ status: 200 }).catch(() => {});
    return route.continue();
  });
  const req = captureRequest('https://api.example.com/v1/sync-continue');
  await fake.registeredHandler()({
    request: () => req,
    fulfill: () => Promise.reject(new Error('fulfill failed')),
    continue: () => {
      // Response observed before fulfill rejection microtask cleanup would otherwise taint MOCKED.
      emitCaptureResponse(fake.handlers, req);
      return Promise.resolve();
    },
  }, req);

  const out = await drainApiCoverageInteractions(fake.page);
  assert.equal(out.length, 1);
  assert.equal(out[0].interactionType, ApiOperationInteractionType.REAL);
});

test('legacy x-testchimp-mocked response header still marks MOCKED', async () => {
  const {
    attachApiCoverageCapture,
    drainApiCoverageInteractions,
    ApiOperationInteractionType,
    TESTCHIMP_MOCKED_HEADER,
  } = require('../dist/api-coverage/capture');
  const fake = captureTestPage();
  attachApiCoverageCapture(fake.page, { capturePayloads: false });

  const req = captureRequest('https://api.example.com/v1/header-mock');
  fake.handlers.response({
    request: () => req,
    status: () => 200,
    headers: () => ({
      'content-type': 'application/json',
      [TESTCHIMP_MOCKED_HEADER]: '1',
    }),
    text: async () => '{"mocked":true}',
  });

  const out = await drainApiCoverageInteractions(fake.page);
  assert.equal(out.length, 1);
  assert.equal(out[0].interactionType, ApiOperationInteractionType.MOCKED);
});

test('non-thenable fulfill return does not throw into the test', async () => {
  const { attachApiCoverageCapture } = require('../dist/api-coverage/capture');
  const fake = captureTestPage();
  attachApiCoverageCapture(fake.page, { capturePayloads: false });

  await fake.page.route('**/*', async (route) => {
    await route.fulfill({ status: 200 });
  });
  await fake.registeredHandler()({
    request: () => captureRequest(),
    fulfill: () => undefined,
  });
});

test('partial routing instrumentation failure restores original route method', async () => {
  const { attachApiCoverageCapture } = require('../dist/api-coverage/capture');
  const handlers = {};
  let originalRouteCalls = 0;
  const originalRoute = async () => {
    originalRouteCalls += 1;
  };
  const page = {
    on(event, fn) {
      handlers[event] = fn;
    },
    route: originalRoute,
  };
  Object.defineProperty(page, 'unroute', {
    configurable: false,
    value: async () => {},
    writable: false,
  });

  attachApiCoverageCapture(page, { capturePayloads: false });
  assert.equal(page.route, originalRoute);
  await page.route('**/*', () => {});
  assert.equal(originalRouteCalls, 1);
});

test('context.route fulfill is detected for the page response', async () => {
  const {
    attachApiCoverageCapture,
    drainApiCoverageInteractions,
    ApiOperationInteractionType,
  } = require('../dist/api-coverage/capture');
  let contextHandler;
  const context = {
    async route(_url, handler) {
      contextHandler = handler;
    },
    async unroute() {},
  };
  const fake = captureTestPage(context);
  attachApiCoverageCapture(fake.page, { capturePayloads: false });

  await context.route('**/v1/context-mock', (route) => route.fulfill({ status: 200 }));
  const req = captureRequest('https://api.example.com/v1/context-mock');
  await contextHandler({
    request: () => req,
    fulfill: () => {
      emitCaptureResponse(fake.handlers, req);
      return Promise.resolve();
    },
  }, req);

  const out = await drainApiCoverageInteractions(fake.page);
  assert.equal(out.length, 1);
  assert.equal(out[0].interactionType, ApiOperationInteractionType.MOCKED);
});
