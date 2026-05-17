const test = require('node:test');
const assert = require('node:assert/strict');

function mockTestInfo(platform) {
  const use = platform === undefined ? {} : { platform };
  return { project: { use } };
}

test('platformFromTestInfo defaults to web when platform is omitted', () => {
  const { platformFromTestInfo, isMobilePlatform, getFixtureKeyForPlatform } = require('../dist/project-type');
  const p = platformFromTestInfo(mockTestInfo(undefined));
  assert.equal(p, 'web');
  assert.equal(isMobilePlatform(p), false);
  assert.equal(getFixtureKeyForPlatform(p), 'page');
});

test('ios and android are recognized case-insensitively', () => {
  for (const value of ['ios', 'IOS', 'android', 'AnDrOiD']) {
    const { platformFromTestInfo, isMobilePlatform, getFixtureKeyForPlatform } = require('../dist/project-type');
    const p = platformFromTestInfo(mockTestInfo(value));
    assert.equal(isMobilePlatform(p), true);
    assert.equal(getFixtureKeyForPlatform(p), 'screen');
  }
});

test('unknown platform values fall back to web', () => {
  const { platformFromTestInfo, isMobilePlatform } = require('../dist/project-type');
  const p = platformFromTestInfo(mockTestInfo('mobile'));
  assert.equal(p, 'web');
  assert.equal(isMobilePlatform(p), false);
});

test('device.platform annotation is a fallback when use.platform is omitted', () => {
  const { platformFromTestInfo, isMobilePlatform } = require('../dist/project-type');
  const p = platformFromTestInfo({
    project: { use: {} },
    annotations: [{ type: 'device.platform', description: 'android' }],
  });
  assert.equal(p, 'android');
  assert.equal(isMobilePlatform(p), true);
});

test('use.platform wins over device.platform annotation', () => {
  const { platformFromTestInfo } = require('../dist/project-type');
  const p = platformFromTestInfo({
    project: { use: { platform: 'ios' } },
    annotations: [{ type: 'device.platform', description: 'android' }],
  });
  assert.equal(p, 'ios');
});
