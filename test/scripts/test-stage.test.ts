import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../scripts/test-stage.ts', import.meta.url));

test('test-stage --smoke stages a temp dir, starts a fake agent and a test-profile orchestrad, then removes it all', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--smoke'], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const out = r.stdout;
  const stage = /^stage: (.+)$/m.exec(out)?.[1]?.trim();
  assert.ok(stage !== undefined && path.dirname(stage).toLowerCase() === os.tmpdir().toLowerCase() && path.basename(stage).startsWith('orchestra-test-'), out);
  assert.match(out, /^\[agent\] fake-agent \d+ child \d+$/m);
  assert.match(out, /^\[orchestrad\] TEST PROFILE$/m);
  assert.match(out, /^\[orchestrad\] orchestrad: working \(test profile, pid \d+, data .+\)$/m);
  assert.match(out, /^\[orchestrad\] orchestrad: pairing code \d{8}$/m);
  assert.match(out, /^stage: removed /m);
  assert.equal(fs.existsSync(stage), false, 'the stage dir is gone');
});

test('test-stage refuses an unknown argument before staging anything', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--real'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stdout, /stage:/);
});
