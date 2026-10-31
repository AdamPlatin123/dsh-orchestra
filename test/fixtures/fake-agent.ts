// A fake agent process tree for the test profile: this node process carries the fake-agent marker
// and starts one child that carries it too. Both only idle. The parent ends when its stdin closes;
// the child ends when the parent does (its stdin is a pipe from the parent).
//   node fake-agent.ts --orchestra-fake-agent [--child]
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FAKE_AGENT_MARKER } from '../../src/runtime/test-profile.ts';

const args = process.argv.slice(2);
if (!args.includes(FAKE_AGENT_MARKER)) throw new Error(`fake-agent.ts needs ${FAKE_AGENT_MARKER}`);

const keepAlive = setInterval(() => {}, 60_000);
process.stdin.resume();
process.stdin.on('end', () => {
  clearInterval(keepAlive);
  process.exit(0);
});

if (!args.includes('--child')) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), FAKE_AGENT_MARKER, '--child'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  process.stdout.write(`fake-agent ${process.pid} child ${child.pid}\n`);
  process.on('exit', () => {
    child.stdin?.end();
  });
}
