const test = require('node:test');
const assert = require('node:assert/strict');

const { collectPlaywrightAnnotations } = require('../dist/annotations');

test('collectPlaywrightAnnotations merges test and result annotations', () => {
  const out = collectPlaywrightAnnotations(
    {
      annotations: [{ type: 'scenario', description: '#TS-101' }],
    },
    {
      annotations: [{ type: 'issue', description: 'https://example.com/1' }],
    }
  );
  assert.deepEqual(out, [
    { type: 'scenario', description: '#TS-101' },
    { type: 'issue', description: 'https://example.com/1' },
  ]);
});

test('collectPlaywrightAnnotations dedupes by type and description', () => {
  const out = collectPlaywrightAnnotations(
    {
      annotations: [
        { type: 'scenario', description: '#TS-101' },
        { type: 'scenario', description: '#TS-101' },
      ],
    },
    {
      annotations: [{ type: 'scenario', description: '#TS-101' }],
    }
  );
  assert.deepEqual(out, [{ type: 'scenario', description: '#TS-101' }]);
});

test('collectPlaywrightAnnotations skips empty type and defaults missing description to empty string', () => {
  const out = collectPlaywrightAnnotations(
    {
      annotations: [
        { type: '', description: 'ignored' },
        { type: 'scenario' },
        { description: 'no-type' },
        null,
      ],
    },
    null
  );
  assert.deepEqual(out, [{ type: 'scenario', description: '' }]);
});

test('collectPlaywrightAnnotations preserves non-scenario types', () => {
  const out = collectPlaywrightAnnotations({
    annotations: [
      { type: 'slow', description: 'flaky path' },
      { type: 'scenario', description: '#TS-202' },
    ],
  });
  assert.deepEqual(out, [
    { type: 'slow', description: 'flaky path' },
    { type: 'scenario', description: '#TS-202' },
  ]);
});
