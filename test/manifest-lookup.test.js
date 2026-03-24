const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveJobIdFromManifest, normalizeManifestFolderPath } = require('../dist/utils');

test('normalizes tests-prefixed folder paths to manifest convention', () => {
  assert.equal(normalizeManifestFolderPath('tests/e2e'), 'e2e');
  assert.equal(normalizeManifestFolderPath('tests'), '');
  assert.equal(normalizeManifestFolderPath('e2e'), 'e2e');
  assert.equal(normalizeManifestFolderPath(''), '');
});

test('resolves root-level test when runtime has empty folderPath', () => {
  const manifest = [
    {
      folderPath: '',
      fileName: 'TeamSearch.spec.js',
      suitePath: [],
      testName: 'search_success',
      jobId: 'job-root',
    },
  ];
  const jobId = resolveJobIdFromManifest(manifest, {
    folderPath: '',
    fileName: 'TeamSearch.spec.js',
    suitePath: [],
    testName: 'search_success',
  });
  assert.equal(jobId, 'job-root');
});

test('resolves when manifest/runtime differ by tests prefix', () => {
  const manifest = [
    {
      folderPath: 'e2e',
      fileName: 'TeamSearch.spec.js',
      suitePath: [],
      testName: 'search_success',
      jobId: 'job-e2e',
    },
  ];
  const jobId = resolveJobIdFromManifest(manifest, {
    folderPath: 'tests/e2e',
    fileName: 'TeamSearch.spec.js',
    suitePath: [],
    testName: 'search_success',
  });
  assert.equal(jobId, 'job-e2e');
});

test('falls back from runtime suitePath to empty suitePath entry', () => {
  const manifest = [
    {
      folderPath: 'e2e',
      fileName: 'TeamSearch.spec.js',
      suitePath: [],
      testName: 'search_success',
      jobId: 'job-suite-fallback',
    },
  ];
  const jobId = resolveJobIdFromManifest(manifest, {
    folderPath: 'e2e',
    fileName: 'TeamSearch.spec.js',
    suitePath: ['SearchFlow'],
    testName: 'search_success',
  });
  assert.equal(jobId, 'job-suite-fallback');
});
