// Stages a test-profile orchestrad for manual UI checks (plan step 2): a fresh
// %TEMP%\orchestra-test-* dir with synthetic roots, a fake-agent process tree, and orchestrad in the
// test profile with that tree registered as its brake root. Implementation sessions start
// orchestrad only this way. Ctrl+C tears everything down and removes the dir.
//   node scripts/test-stage.ts [--smoke]     (--smoke: tear down as soon as orchestrad works)
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE_AGENT_MARKER } from '../src/runtime/test-profile.ts';
import { rmTree } from '../test/helpers/tmp.ts';

const BOOT = fileURLToPath(new URL('../src/boot.ts', import.meta.url));
const FAKE_AGENT = fileURLToPath(new URL('../test/fixtures/fake-agent.ts', import.meta.url));

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== '--smoke');
if (unknown.length > 0) {
  console.error(`test-stage: unknown argument ${unknown[0]}`);
  process.exit(2);
}
const smoke = args.includes('--smoke');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-test-'));
console.log(`stage: ${dir}`);
// Synthetic roots: the layouts the sources expect, empty until the fixture writers (step 7) fill them.
for (const sub of ['claude\\projects', 'claude\\sessions', 'dsh\\sessions', 'codex\\sessions']) fs.mkdirSync(path.join(dir, 'roots', sub), { recursive: true });

function lines(stream: NodeJS.ReadableStream | null, each: (line: string) => void): void {
  let rest = '';
  stream?.on('data', (chunk: Buffer) => {
    rest += chunk.toString('utf8');
    const parts = rest.split(/\r?\n/);
    rest = parts.pop()!;
    for (const p of parts) each(p);
  });
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const agent = spawn(process.execPath, [FAKE_AGENT, FAKE_AGENT_MARKER], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
const agentReady = new Promise<void>((resolve) => lines(agent.stdout, (l) => {
  console.log(`[agent] ${l}`);
  resolve();
}));
await agentReady;

const orchestrad = spawn(process.execPath, [BOOT, '--test-profile', '--test-dir', dir, '--test-root-pid', String(agent.pid)], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let tearing: Promise<void> | null = null;
function teardown(code: number): Promise<void> {
  return (tearing ??= (async () => {
    if (orchestrad.exitCode === null && orchestrad.signalCode === null) {
      orchestrad.kill();
      await waitExit(orchestrad, 5000);
    }
    agent.stdin?.end();
    if (!(await waitExit(agent, 3000))) {
      agent.kill();
      await waitExit(agent, 3000);
    }
    rmTree(dir);
    console.log(`stage: removed ${dir}`);
    process.exit(code);
  })());
}

lines(orchestrad.stdout, (l) => {
  console.log(`[orchestrad] ${l}`);
  if (/^orchestrad: working /.test(l)) {
    console.log('stage: URL: none yet (the HTTP UI arrives with step 4)');
    if (smoke) setTimeout(() => void teardown(0), 200);
  }
});
lines(orchestrad.stderr, (l) => console.log(`[orchestrad:err] ${l}`));
orchestrad.once('exit', (code) => {
  console.log(`stage: orchestrad exited (${code})`);
  void teardown(code === 0 ? 0 : 1);
});
for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.once(s, () => void teardown(0));
