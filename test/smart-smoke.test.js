const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  isTruthyEnv,
  normalizeTag,
  resolveSmartSmokeConfig,
  locatorKey,
  normalizeLocator,
  unionLocators,
  resolveSkipReasonFromAnnotations,
} = require('../dist/smart-smoke.js');

describe('smart-smoke config', () => {
  it('isTruthyEnv accepts true and 1', () => {
    assert.equal(isTruthyEnv('true'), true);
    assert.equal(isTruthyEnv('TRUE'), true);
    assert.equal(isTruthyEnv('1'), true);
    assert.equal(isTruthyEnv('0'), false);
    assert.equal(isTruthyEnv('false'), false);
    assert.equal(isTruthyEnv(undefined), false);
  });

  it('normalizeTag adds @ and lowercases', () => {
    assert.equal(normalizeTag('smoke'), '@smoke');
    assert.equal(normalizeTag('@Smoke'), '@smoke');
  });

  it('env overrides use; default suite % when enabled without size', () => {
    const cfg = resolveSmartSmokeConfig(
      { maxTests: 40, suitePercentage: 50, includeTags: ['smoke'] },
      {
        TESTCHIMP_SMART_SMOKE_ENABLED: '1',
        TESTCHIMP_SMART_SMOKE_MAX_TESTS: '15',
      }
    );
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.maxTests, 15);
    assert.equal(cfg.suitePercentage, 50);
    assert.deepEqual(cfg.includeTags, ['smoke']);
    assert.equal(cfg.usedDefaultSuitePercentage, false);

    const fallback = resolveSmartSmokeConfig({}, { TESTCHIMP_SMART_SMOKE_ENABLED: 'true' });
    assert.equal(fallback.suitePercentage, 20);
    assert.equal(fallback.usedDefaultSuitePercentage, true);
  });

  it('relatedTestsOnly from env true/1', () => {
    const a = resolveSmartSmokeConfig({ relatedTestsOnly: false }, {
      TESTCHIMP_SMART_SMOKE_ENABLED: 'true',
      TESTCHIMP_SMART_SMOKE_RELATED_TESTS_ONLY: '1',
      TESTCHIMP_SMART_SMOKE_MAX_TESTS: '5',
    });
    assert.equal(a.relatedTestsOnly, true);
  });
});

describe('smart-smoke locators', () => {
  it('unionLocators dedupes', () => {
    const a = normalizeLocator({ fileName: 'a.ts', testName: 't1' });
    const b = normalizeLocator({ file_name: 'a.ts', test_name: 't1' });
    const c = normalizeLocator({ fileName: 'b.ts', testName: 't2' });
    assert.equal(locatorKey(a), locatorKey(b));
    const u = unionLocators([a, b], [c]);
    assert.equal(u.length, 2);
  });
});

describe('skip reason', () => {
  it('prefers skip-reason annotation', () => {
    assert.equal(
      resolveSkipReasonFromAnnotations(
        [{ type: 'skip-reason', description: 'smart-smoke' }, { type: 'skip', description: 'other' }],
        'ignored'
      ),
      'smart-smoke'
    );
  });
});

describe('smart-smoke stale sidecar guard', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const {
    writeSmartSmokeSelectionFile,
    loadSmartSmokeSelectionLookup,
    invalidateSmartSmokeSelectionCache,
  } = require('../dist/smart-smoke.js');

  it('ignores selection file when TESTCHIMP_SMART_SMOKE_ENABLED is off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-smoke-'));
    const prev = process.env.TESTCHIMP_SMART_SMOKE_ENABLED;
    const prevFile = process.env.TESTCHIMP_SMART_SMOKE_SELECTION_FILE;
    try {
      process.env.TESTCHIMP_SMART_SMOKE_ENABLED = 'true';
      writeSmartSmokeSelectionFile(dir, {
        enabled: true,
        selectedTests: [{ fileName: 'a.ts', testName: 't1', folderPath: [], testSuite: [] }],
      });
      invalidateSmartSmokeSelectionCache();
      delete process.env.TESTCHIMP_SMART_SMOKE_ENABLED;
      assert.equal(loadSmartSmokeSelectionLookup(dir), undefined);
    } finally {
      if (prev === undefined) delete process.env.TESTCHIMP_SMART_SMOKE_ENABLED;
      else process.env.TESTCHIMP_SMART_SMOKE_ENABLED = prev;
      if (prevFile === undefined) delete process.env.TESTCHIMP_SMART_SMOKE_SELECTION_FILE;
      else process.env.TESTCHIMP_SMART_SMOKE_SELECTION_FILE = prevFile;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
