const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const worldstatePath = path.join(__dirname, '..', 'dist', 'worldstate.js');

test('teardownWorldState runs teardown with empty ctx', async () => {
  const {
    defineWorldState,
    teardownWorldState,
    __resetWorldStateRegistryForTests,
  } = require(worldstatePath);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ws-'));
  const prev = process.cwd();
  try {
    fs.writeFileSync(
      path.join(dir, 'x.world.js'),
      `
const { defineWorldState } = require(${JSON.stringify(worldstatePath)});
let ran = false;
module.exports = defineWorldState({
  meta: { id: 'ws-x', description: 'x' },
  setup() {},
  teardown() { ran = true; }
});
globalThis.__wsTeardownRan = () => ran;
`,
      'utf8',
    );
    process.chdir(dir);
    __resetWorldStateRegistryForTests();
    await teardownWorldState('ws-x');
    const mod = require(path.join(dir, 'x.world.js'));
    assert.equal(typeof globalThis.__wsTeardownRan, 'function');
    assert.equal(globalThis.__wsTeardownRan(), true);
  } finally {
    process.chdir(prev);
    __resetWorldStateRegistryForTests();
    fs.rmSync(dir, { recursive: true, force: true });
    delete globalThis.__wsTeardownRan;
  }
});

test('nested ensureWorldState in another world-state setup runs prerequisite first', async () => {
  const { defineWorldState, ensureWorldState, __resetWorldStateRegistryForTests } =
    require(worldstatePath);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ws-nested-'));
  const prev = process.cwd();
  try {
    const order = [];
    globalThis.__wsOrder = order;

    fs.writeFileSync(
      path.join(dir, 'child.world.js'),
      `
const { defineWorldState } = require(${JSON.stringify(worldstatePath)});
module.exports = defineWorldState({
  meta: { id: 'child-ws', description: 'child' },
  setup() { globalThis.__wsOrder.push('child'); },
});
`,
      'utf8',
    );

    fs.writeFileSync(
      path.join(dir, 'parent.world.js'),
      `
const { defineWorldState, ensureWorldState } = require(${JSON.stringify(worldstatePath)});
module.exports = defineWorldState({
  meta: { id: 'parent-ws', description: 'parent' },
  setup: async () => {
    globalThis.__wsOrder.push('parent-before');
    await ensureWorldState('child-ws');
    globalThis.__wsOrder.push('parent-after');
  },
});
`,
      'utf8',
    );

    process.chdir(dir);
    __resetWorldStateRegistryForTests();
    await ensureWorldState('parent-ws');
    assert.deepEqual(order, ['parent-before', 'child', 'parent-after']);
  } finally {
    process.chdir(prev);
    __resetWorldStateRegistryForTests();
    fs.rmSync(dir, { recursive: true, force: true });
    delete globalThis.__wsOrder;
  }
});
