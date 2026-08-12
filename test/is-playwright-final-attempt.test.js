const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isPlaywrightFinalAttempt } = require('../dist/utils.js');

describe('isPlaywrightFinalAttempt', () => {
  it('treats skipped as final even when retries remain (smart-smoke / test.skip)', () => {
    assert.equal(isPlaywrightFinalAttempt('skipped', 0, 2), true);
  });

  it('treats passed as final', () => {
    assert.equal(isPlaywrightFinalAttempt('passed', 0, 2), true);
  });

  it('treats interrupted as final', () => {
    assert.equal(isPlaywrightFinalAttempt('interrupted', 0, 2), true);
  });

  it('does not treat early failed attempt as final when retries remain', () => {
    assert.equal(isPlaywrightFinalAttempt('failed', 0, 2), false);
    assert.equal(isPlaywrightFinalAttempt('failed', 1, 2), false);
  });

  it('treats last failed attempt as final', () => {
    assert.equal(isPlaywrightFinalAttempt('failed', 2, 2), true);
  });

  it('treats any status as final when maxRetries is unknown', () => {
    assert.equal(isPlaywrightFinalAttempt('failed', 0, undefined), true);
    assert.equal(isPlaywrightFinalAttempt('failed', 0, null), true);
  });
});
