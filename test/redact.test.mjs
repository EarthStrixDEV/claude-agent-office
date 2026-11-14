import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, clip } from '../bridge/redact.mjs';

const secrets = [
  'sk-abcdefghijklmnop1234',
  'ghp_abcdefghijklmnopqrstuvwxyz12',
  'AKIAABCDEFGHIJKLMNOP',
  'xoxb-1234567890-abcdef',
];

test('one-group patterns hide the whole secret', () => {
  for (const s of secrets) {
    const out = redact(`key ${s} end`);
    assert.equal(out, 'key •••• end');
  }
});

test('two-group patterns keep the label and hide the value', () => {
  assert.equal(redact('token=supersecretvalue'), 'token=••••');
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop'), 'Authorization: Bearer ••••');
});

test('clip redacts before truncating', () => {
  assert.ok(!clip(`run ${secrets[0]}`, 10).includes('sk-abc'));
});
