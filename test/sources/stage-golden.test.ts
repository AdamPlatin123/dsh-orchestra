import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessRoot } from '../../src/fs/harness-roots.ts';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import { makeStageBuilder } from '../../src/sources/stage.ts';
import { validateStage } from '../../shared/stage-contract.js';
import { realIo } from '../helpers/read-io.ts';
import { normalizeSnapshot, writeStageFixture } from '../helpers/stage-fixture.ts';
import { withTmp } from '../helpers/tmp.ts';

// The contract's golden file (0.1 alpha design §8, §10): the snapshot of the stage fixture, its time
// fields, rev and session ids normalized. The page is built against it and against
// test/fixtures/stage-ui-sample.json; both pass shared/stage-contract.js. Changing the golden file
// needs both owners to agree.

const GOLDEN = fileURLToPath(new URL('../fixtures/stage-snapshot.json', import.meta.url));

test('the golden file passes the shared contract', () => {
  const golden: unknown = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(validateStage(golden).errors, []);
});

test('the stage fixture at baseMs + 30 s gives the golden snapshot', (t) => {
  const dir = fs.realpathSync.native(withTmp(t));
  writeStageFixture(dir, 1_793_560_000_000);
  const roots: HarnessRoot[] = (['claude', 'dsh', 'codex'] as const).map((kind) => {
    const p = path.join(dir, 'roots', kind);
    return { kind, path: p, real: p };
  });
  const redactor = makeRedactor({ env: {} });
  const builder = makeStageBuilder({
    gate: new ReadGate({ roots, io: realIo, testDirs: [dir] }), roots, redact: (text) => redactor.redact({ text }).text,
    clock: new VirtualClock({ mono: 1000, wall: 1_793_560_030_000 }).port(null), profile: 'test',
  });
  const snap = builder.snapshot();
  assert.deepEqual(validateStage(snap).errors, []);
  assert.deepEqual(normalizeSnapshot(snap), JSON.parse(fs.readFileSync(GOLDEN, 'utf8')));
});
