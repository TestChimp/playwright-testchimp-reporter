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
