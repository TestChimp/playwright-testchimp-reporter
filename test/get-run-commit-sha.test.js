const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const utilsPath = path.join(__dirname, '..', 'dist', 'utils.js');

describe('getRunCommitSha', () => {
  const envKeys = [
    'TESTCHIMP_GIT_COMMIT_SHA',
    'GITHUB_EVENT_PATH',
    'GITHUB_EVENT_NAME',
    'GITHUB_SHA',
    'CI_COMMIT_SHA',
    'GIT_COMMIT',
    'COMMIT_SHA',
  ];
  const saved = {};
  let eventFile;

  beforeEach(() => {
    for (const key of envKeys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
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
    if (eventFile) {
      try {
        fs.unlinkSync(eventFile);
      } catch {
        // ignore
      }
      eventFile = undefined;
    }
    delete require.cache[require.resolve(utilsPath)];
  });

  it('prefers TESTCHIMP_GIT_COMMIT_SHA', () => {
    process.env.TESTCHIMP_GIT_COMMIT_SHA = 'override-sha';
    process.env.GITHUB_SHA = 'actions-merge-sha';
    const { getRunCommitSha } = require(utilsPath);
    assert.equal(getRunCommitSha(), 'override-sha');
  });

  it('prefers pull_request.head.sha over GITHUB_SHA', () => {
    eventFile = path.join(os.tmpdir(), `tc-gh-event-${Date.now()}.json`);
    fs.writeFileSync(
      eventFile,
      JSON.stringify({ pull_request: { head: { sha: 'pr-head-durable' } } }),
      'utf8',
    );
    process.env.GITHUB_EVENT_PATH = eventFile;
    process.env.GITHUB_EVENT_NAME = 'pull_request';
    process.env.GITHUB_SHA = 'ephemeral-merge';
    const { getRunCommitSha } = require(utilsPath);
    assert.equal(getRunCommitSha(), 'pr-head-durable');
  });

  it('ignores pull_request payload on push events', () => {
    eventFile = path.join(os.tmpdir(), `tc-gh-event-push-${Date.now()}.json`);
    fs.writeFileSync(
      eventFile,
      JSON.stringify({ pull_request: { head: { sha: 'should-not-use' } } }),
      'utf8',
    );
    process.env.GITHUB_EVENT_PATH = eventFile;
    process.env.GITHUB_EVENT_NAME = 'push';
    process.env.GITHUB_SHA = 'push-sha';
    // Force CI fallback by making git rev-parse fail via invalid cwd is hard; set override empty
    // and rely on git succeeding — assert we do not get should-not-use.
    const { getRunCommitSha } = require(utilsPath);
    assert.notEqual(getRunCommitSha(), 'should-not-use');
  });
});
