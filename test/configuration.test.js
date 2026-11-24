import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MARKETPLACE_URL = 'http://host.docker.internal:4000';
process.env.PICK_LOCK_TTL_SECONDS = '42';

const { config } = await import('../src/config.js');

test('marketplace URL includes mock API port', () => {
  assert.equal(config.marketplaceUrl, 'http://host.docker.internal:4000');
});

test('lock TTL is read from environment', () => {
  assert.equal(config.pickLockTtlSeconds, 42);
});
