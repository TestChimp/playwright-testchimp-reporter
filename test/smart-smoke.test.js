const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  isTruthyEnv,
  normalizeTag,
  resolveSmartSmokeConfig,
  locatorKey,
  normalizeLocator,
  normalizeTestSuite,
  toWireLocator,
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

  it('env time budget suppresses use-only suitePercentage', () => {
    const cfg = resolveSmartSmokeConfig(
      { suitePercentage: 20, includeTags: ['smoke'] },
      {
        TESTCHIMP_SMART_SMOKE_ENABLED: '1',
        TESTCHIMP_SMART_SMOKE_MAX_TIME_BUDGET_MINS: '15',
      }
    );
    assert.equal(cfg.maxTimeBudgetMins, 15);
    assert.equal(cfg.suitePercentage, undefined);
    assert.equal(cfg.usedDefaultSuitePercentage, false);
  });

  it('env suite percentage still applies with time budget', () => {
    const cfg = resolveSmartSmokeConfig(
      { suitePercentage: 20 },
      {
        TESTCHIMP_SMART_SMOKE_ENABLED: '1',
        TESTCHIMP_SMART_SMOKE_MAX_TIME_BUDGET_MINS: '15',
        TESTCHIMP_SMART_SMOKE_SUITE_PERCENTAGE: '40',
      }
    );
    assert.equal(cfg.suitePercentage, 40);
    assert.equal(cfg.maxTimeBudgetMins, 15);
  });

  it('env time budget suppresses use-only suitePercentage even with empty MAX_TESTS env', () => {
    const cfg = resolveSmartSmokeConfig(
      { suitePercentage: 20 },
      {
        TESTCHIMP_SMART_SMOKE_ENABLED: '1',
        TESTCHIMP_SMART_SMOKE_MAX_TIME_BUDGET_MINS: '15',
        TESTCHIMP_SMART_SMOKE_MAX_TESTS: '',
      }
    );
    assert.equal(cfg.maxTimeBudgetMins, 15);
    assert.equal(cfg.suitePercentage, undefined);
    assert.equal(cfg.maxTests, undefined);
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

  it('normalizeTestSuite wraps a bare string (does not split on /)', () => {
    assert.deepEqual(normalizeTestSuite('My suite'), ['My suite']);
    assert.deepEqual(normalizeTestSuite('Workflow MCP/CLI tools'), ['Workflow MCP/CLI tools']);
    assert.deepEqual(normalizeTestSuite(['A', 'B']), ['A', 'B']);
    assert.deepEqual(normalizeTestSuite(''), []);
    assert.deepEqual(normalizeTestSuite(null), []);
    assert.deepEqual(normalizeTestSuite(undefined), []);
  });

  it('normalizeLocator coerces string testSuite; preserves quotes and & in testName', () => {
    const n = normalizeLocator({
      folderPath: ['auth'],
      fileName: 'export.spec.ts',
      testSuite: 'Export flows',
      testName: 'Export & Complete with "(edited)" title',
    });
    assert.deepEqual(n.testSuite, ['Export flows']);
    assert.equal(n.testName, 'Export & Complete with "(edited)" title');

    const wire = toWireLocator(n);
    assert.deepEqual(wire.test_suite, ['Export flows']);
    assert.equal(typeof wire.test_suite, 'object');
    assert.ok(Array.isArray(wire.test_suite));
    assert.equal(wire.test_name, 'Export & Complete with "(edited)" title');
  });

  it('toWireLocator never sends test_suite as a string', () => {
    const wire = toWireLocator({
      folderPath: 'a/b',
      fileName: 'f.ts',
      test_suite: 'Single describe',
      test_name: 't1',
    });
    assert.deepEqual(wire.folder_path, ['a', 'b']);
    assert.deepEqual(wire.test_suite, ['Single describe']);
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
    maybeSkipForSmartSmoke,
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

  it('returns pending when enabled and sidecar missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-smoke-'));
    const prev = process.env.TESTCHIMP_SMART_SMOKE_ENABLED;
    const prevFile = process.env.TESTCHIMP_SMART_SMOKE_SELECTION_FILE;
    try {
      process.env.TESTCHIMP_SMART_SMOKE_ENABLED = 'true';
      process.env.TESTCHIMP_SMART_SMOKE_SELECTION_FILE = path.join(dir, 'missing.json');
      invalidateSmartSmokeSelectionCache();
      const lookup = loadSmartSmokeSelectionLookup(dir);
      assert.deepEqual(lookup, { pending: true });
    } finally {
      if (prev === undefined) delete process.env.TESTCHIMP_SMART_SMOKE_ENABLED;
      else process.env.TESTCHIMP_SMART_SMOKE_ENABLED = prev;
      if (prevFile === undefined) delete process.env.TESTCHIMP_SMART_SMOKE_SELECTION_FILE;
      else process.env.TESTCHIMP_SMART_SMOKE_SELECTION_FILE = prevFile;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('after wait timeout, subsequent lookups skip immediately (gave-up cache)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-smoke-'));
    const prev = process.env.TESTCHIMP_SMART_SMOKE_ENABLED;
    const prevFile = process.env.TESTCHIMP_SMART_SMOKE_SELECTION_FILE;
    const prevWait = process.env.TESTCHIMP_SMART_SMOKE_SELECTION_WAIT_MS;
    const skipThrow = () => {
      const err = new Error('skipped');
      err.name = 'SkipError';
      throw err;
    };
    try {
      process.env.TESTCHIMP_SMART_SMOKE_ENABLED = 'true';
      process.env.TESTCHIMP_SMART_SMOKE_SELECTION_FILE = path.join(dir, 'missing.json');
      process.env.TESTCHIMP_SMART_SMOKE_SELECTION_WAIT_MS = '0';
      invalidateSmartSmokeSelectionCache();

      assert.throws(
        () =>
          maybeSkipForSmartSmoke({
            annotations: [],
            skip: skipThrow,
            project: { rootDir: dir },
            title: 't',
            titlePath: () => ['t'],
            file: 'a.spec.ts',
          }),
        /skipped/i
      );

      const t1 = Date.now();
      assert.throws(
        () =>
          maybeSkipForSmartSmoke({
            annotations: [],
            skip: skipThrow,
            project: { rootDir: dir },
            title: 't2',
            titlePath: () => ['t2'],
            file: 'b.spec.ts',
          }),
        /skipped/i
      );
      // Gave-up cache: second call must not re-enter a long wait.
      assert.ok(Date.now() - t1 < 500);
    } finally {
      if (prev === undefined) delete process.env.TESTCHIMP_SMART_SMOKE_ENABLED;
      else process.env.TESTCHIMP_SMART_SMOKE_ENABLED = prev;
      if (prevFile === undefined) delete process.env.TESTCHIMP_SMART_SMOKE_SELECTION_FILE;
      else process.env.TESTCHIMP_SMART_SMOKE_SELECTION_FILE = prevFile;
      if (prevWait === undefined) delete process.env.TESTCHIMP_SMART_SMOKE_SELECTION_WAIT_MS;
      else process.env.TESTCHIMP_SMART_SMOKE_SELECTION_WAIT_MS = prevWait;
      invalidateSmartSmokeSelectionCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
