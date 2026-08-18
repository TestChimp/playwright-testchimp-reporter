const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveExecutionSource } = require(path.join(__dirname, '..', 'dist', 'utils.js'));

describe('resolveExecutionSource', () => {
  it('honors TESTCHIMP_EXECUTION_SOURCE over CI=true', () => {
    assert.equal(
      resolveExecutionSource({ TESTCHIMP_EXECUTION_SOURCE: 'CLOUD_AGENT', CI: 'true' }),
      'CLOUD_AGENT'
    );
    assert.equal(
      resolveExecutionSource({ TESTCHIMP_EXECUTION_SOURCE: 'local_agent', CI: '1' }),
      'LOCAL_AGENT'
    );
  });

  it('falls back to CI when CI=true and env unset', () => {
    assert.equal(resolveExecutionSource({ CI: 'true' }), 'CI');
  });

  it('treats GITHUB_ACTIONS + CI=true as CI when env unset (true pipeline)', () => {
    assert.equal(resolveExecutionSource({ CI: 'true', GITHUB_ACTIONS: 'true' }), 'CI');
  });

  it('treats Cursor IDE / Claude Code as LOCAL_AGENT even when CI=true', () => {
    assert.equal(resolveExecutionSource({ CI: 'true', CURSOR_AGENT: '1' }), 'LOCAL_AGENT');
    assert.equal(resolveExecutionSource({ CURSOR_AGENT: '1' }), 'LOCAL_AGENT');
    assert.equal(resolveExecutionSource({ CI: 'true', CLAUDE_CODE: '1' }), 'LOCAL_AGENT');
  });

  it('treats Copilot workspace / Cursor cloud worker as CLOUD_AGENT', () => {
    assert.equal(
      resolveExecutionSource({ CI: 'true', COPILOT_USE_PLATFORM: '1' }),
      'CLOUD_AGENT'
    );
    assert.equal(resolveExecutionSource({ COPILOT_WORKSPACE: '1' }), 'CLOUD_AGENT');
    assert.equal(
      resolveExecutionSource({ CURSOR_AGENT: '1', CURSOR_AGENT_WORKER_ID: 'pw_123' }),
      'CLOUD_AGENT'
    );
  });

  it('falls back to LOCAL_AGENT when CI is unset', () => {
    assert.equal(resolveExecutionSource({}), 'LOCAL_AGENT');
  });

  it('ignores unknown TESTCHIMP_EXECUTION_SOURCE and uses other signals', () => {
    assert.equal(resolveExecutionSource({ TESTCHIMP_EXECUTION_SOURCE: 'not-a-source', CI: 'true' }), 'CI');
  });
});
