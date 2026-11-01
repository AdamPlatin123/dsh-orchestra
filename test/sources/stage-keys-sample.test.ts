import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KEYS } from '../../src/sources/stage.ts';
import { STAGE_CANARY, writeStageFixture } from '../helpers/stage-fixture.ts';
import { withTmp } from '../helpers/tmp.ts';

// scripts/stage-keys-sample.ts over the synthetic stage fixture: it counts, and prints no value, no
// file name and no path of the sessions it read.

const SCRIPT = fileURLToPath(new URL('../../scripts/stage-keys-sample.ts', import.meta.url));

/** Every string value in the fixture's files: what the sampler must never print. */
function fixtureStrings(dir: string): Set<string> {
  const out = new Set<string>();
  const walkValue = (v: unknown) => {
    if (typeof v === 'string') out.add(v);
    else if (Array.isArray(v)) v.forEach(walkValue);
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walkValue);
  };
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.add(e.name);
      if (e.isDirectory()) walk(p);
      else {
        const text = e.name.endsWith('.zstd') ? zlib.zstdDecompressSync(fs.readFileSync(p)).toString('utf8') : fs.readFileSync(p, 'utf8');
        for (const line of text.split('\n')) if (line.trim() !== '') walkValue(JSON.parse(line));
      }
    }
  };
  walk(path.join(dir, 'roots'));
  return out;
}

test('the sampler prints counts per KEYS entry, tool name and event type, and nothing of the sessions', (t) => {
  const dir = fs.realpathSync.native(withTmp(t));
  writeStageFixture(dir, 1_793_560_000_000);
  const r = spawnSync(process.execPath, [SCRIPT, '--claude-root', path.join(dir, 'roots', 'claude'), '--dsh-root', path.join(dir, 'roots', 'dsh')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  for (const e of KEYS) assert.match(out, new RegExp(`^  ${e.id.replace(/\./g, '\\.')} +\\d+ / \\d+ / \\d+ `, 'm'), e.id);
  assert.match(out, /^  claude\.task +3 \/ 3 \/ 0 /m);
  assert.match(out, /^  claude\.task-result +1 \/ 1 \/ 0 /m);
  assert.match(out, /^tool_use names: Task 3, Agent 0, TodoWrite 1, Read 1, Grep 1, Glob 1, .*Bash 2, .*other 0$/m);
  assert.match(out, /^dsh event types: head 3, todo\/write 1, goal\/change 1, .*tool\/call 4, other 2$/m);

  assert.equal(out.includes(STAGE_CANARY), false);
  assert.equal(out.includes('sk-ant'), false);
  assert.equal(out.includes(dir), false);
  assert.doesNotMatch(out, /[A-Za-z]:\\/);
  // Every word printed is a number or a word of the sampler's own source or the tables it names
  // (stage.ts's KEYS, peek.ts's notes): nothing came from a session.
  const words = (s: string) => s.split(/[\s,:;()[\]'"`~/=<>{}|+!?]+/).filter((w) => w !== '');
  const source = ['scripts/stage-keys-sample.ts', 'src/sources/stage.ts', 'src/sources/peek.ts']
    .map((f) => fs.readFileSync(fileURLToPath(new URL(`../../${f}`, import.meta.url)), 'utf8')).join('\n');
  const own = new Set(words(source));
  const foreign = words(out).filter((w) => !/^\d+$/.test(w) && !own.has(w));
  assert.deepEqual(foreign, [], `words not of the sampler's own: ${foreign.join(' ')}`);
  // And no value of the fixture long enough to mean something appears in the output, but those that
  // are constants of that source themselves (a tool name, an event type).
  const leaks = [...fixtureStrings(dir)].filter((v) => v.length >= 8 && out.includes(v) && !source.includes(`'${v}'`));
  assert.deepEqual(leaks, [], `printed fixture text: ${leaks.join(' | ')}`);
});

test('a failure prints its class and code only, never the path its message names', (t) => {
  const dir = fs.realpathSync.native(withTmp(t));
  const missing = path.join(dir, 'no-such-claude-root');
  const r = spawnSync(process.execPath, [SCRIPT, '--claude-root', missing], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /stage-keys-sample: failed: Error ENOENT/);
  for (const p of [missing, dir, 'no-such-claude-root']) assert.equal(r.stderr.includes(p) || r.stdout.includes(p), false, `leaks ${p}`);
});

test('the sampler refuses an unknown argument and a flag without its directory', () => {
  for (const args of [['--claude'], ['--claude-root'], ['--dsh-root', '--claude-root', 'x']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(r.status, 0, args.join(' '));
    assert.match(r.stderr, /usage: node scripts\/stage-keys-sample\.ts/);
  }
});
