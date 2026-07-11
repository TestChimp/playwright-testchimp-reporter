const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Load compiled utils after build (npm test runs build first).
const utilsPath = path.join(__dirname, '..', 'dist', 'utils.js');

describe('getBranchName', () => {
  const envKeys = [
    'TESTCHIMP_BRANCH_NAME',
    'TESTCHIMP_BRANCH',
    'CI_COMMIT_REF_NAME',
    'GITHUB_REF_NAME',
    'GIT_BRANCH',
    'BRANCH_NAME',
    'GITHUB_REF',
  ];
  const saved = {};

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // Reset module cache so per-process branch cache is cleared between tests.
    delete require.cache[require.resolve(utilsPath)];
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    delete require.cache[require.resolve(utilsPath)];
  });

  it('prefers TESTCHIMP_BRANCH_NAME over git', () => {
    process.env.TESTCHIMP_BRANCH_NAME = 'from-env';
    const { getBranchName } = require(utilsPath);
    assert.equal(getBranchName(), 'from-env');
  });

  it('uses GITHUB_REF_NAME when set', () => {
    process.env.GITHUB_REF_NAME = 'ci-branch';
    const { getBranchName } = require(utilsPath);
    assert.equal(getBranchName(), 'ci-branch');
  });

  it('falls back to git rev-parse when env is unset', () => {
    const { getBranchName } = require(utilsPath);
    const branch = getBranchName();
    assert.ok(branch, 'expected a branch from local git');
    assert.notEqual(branch, 'HEAD');
  });

  it('treats whitespace-only env as unset and falls back to git', () => {
    process.env.TESTCHIMP_BRANCH_NAME = '   ';
    const { getBranchName } = require(utilsPath);
    const branch = getBranchName();
    assert.ok(branch, 'expected a branch from local git');
    assert.notEqual(branch, 'HEAD');
  });
});
