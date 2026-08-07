const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_INGRESS_URL,
  mapSaaSFeatureserviceToIngress,
  resolveCiIngestBaseUrl,
} = require('../dist/utils.js');

const ENV_KEYS = ['TESTCHIMP_INGRESS_URL', 'TESTCHIMP_BACKEND_URL'];

describe('resolveCiIngestBaseUrl', () => {
  /** @type {Record<string, string | undefined>} */
  let saved = {};

  beforeEach(() => {
    saved = {};
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('defaults to prod ingress', () => {
    assert.equal(resolveCiIngestBaseUrl(), DEFAULT_INGRESS_URL);
  });

  it('prefers TESTCHIMP_INGRESS_URL over backend URL', () => {
    process.env.TESTCHIMP_INGRESS_URL = 'https://ingress-staging.testchimp.io/';
    process.env.TESTCHIMP_BACKEND_URL = 'https://featureservice-staging.testchimp.io';
    assert.equal(resolveCiIngestBaseUrl(), 'https://ingress-staging.testchimp.io');
  });

  it('rewrites SaaS featureservice-staging to ingress-staging', () => {
    process.env.TESTCHIMP_BACKEND_URL = 'https://featureservice-staging.testchimp.io';
    assert.equal(resolveCiIngestBaseUrl(), 'https://ingress-staging.testchimp.io');
  });

  it('rewrites SaaS featureservice prod to ingress prod', () => {
    process.env.TESTCHIMP_BACKEND_URL = 'https://featureservice.testchimp.io/';
    assert.equal(resolveCiIngestBaseUrl(), 'https://ingress.testchimp.io');
  });

  it('leaves custom / enterprise backend URLs unchanged', () => {
    process.env.TESTCHIMP_BACKEND_URL = 'https://api.customer.example';
    assert.equal(resolveCiIngestBaseUrl(), 'https://api.customer.example');
  });

  it('uses options.ingressUrl when env unset', () => {
    assert.equal(
      resolveCiIngestBaseUrl({ ingressUrl: 'https://ingress-staging.testchimp.io' }),
      'https://ingress-staging.testchimp.io'
    );
  });

  it('mapSaaSFeatureserviceToIngress is a no-op for unknown hosts', () => {
    assert.equal(mapSaaSFeatureserviceToIngress('https://example.testchimp.invalid'), 'https://example.testchimp.invalid');
  });
});
