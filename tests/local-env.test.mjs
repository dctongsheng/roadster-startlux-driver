import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLocalEnv, readLocalKey } from '../extension/local-env.mjs';

test('local env reads only a literal API key without executing or interpolating values', () => {
  assert.equal(parseLocalEnv('# note\nOTHER=ignored\nexport STARTLUX_API_KEY = "dummy-key" # note\n'), 'dummy-key');
  assert.equal(parseLocalEnv("STARTLUX_API_KEY='$(not-a-command)'"), '$(not-a-command)');
  assert.equal(parseLocalEnv('STARTLUX_API_KEY=${NOT_EXPANDED}'), '${NOT_EXPANDED}');
  assert.equal(parseLocalEnv('\uFEFFSTARTLUX_API_KEY=dummy # comment\r\n'), 'dummy');
  assert.equal(parseLocalEnv('OTHER=dummy'), null);
  for (const value of ['STARTLUX_API_KEY=', 'STARTLUX_API_KEY="broken',
    'STARTLUX_API_KEY=a\nSTARTLUX_API_KEY=b', 'STARTLUX_API_KEY=a\0b']) {
    assert.throws(() => parseLocalEnv(value));
  }
  assert.throws(() => parseLocalEnv('a'.repeat(32769)));
});

test('local env fetch stays inside the extension and safely ignores missing or malformed files', async () => {
  const runtime = { getURL: path => `chrome-extension://own-extension/${path}` };
  let calls = 0;
  assert.equal(await readLocalKey(runtime, async (url, options) => {
    calls++;
    assert.equal(url, 'chrome-extension://own-extension/.env');
    assert.deepEqual(options, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
    return { ok: true, text: async () => 'STARTLUX_API_KEY=dummy-local-key' };
  }), 'dummy-local-key');
  assert.equal(calls, 1);
  assert.equal(await readLocalKey(runtime, async () => ({ ok: false })), null);
  assert.equal(await readLocalKey(runtime, async () => { throw new Error('file missing'); }), null);
  assert.equal(await readLocalKey(runtime, async () => ({ ok: true, text: async () => 'STARTLUX_API_KEY="broken' })), null);
});
