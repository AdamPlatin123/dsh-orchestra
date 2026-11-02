// Writes the tower page's synthetic fixture (test/helpers/stage-fixture.ts: one project "shop" with a
// Claude lead waiting on a permission prompt and its subagents, a DSH lead with a teammate and a
// reviewer, a Codex lead with two subagents) into %TEMP%\orchestra-test-tower and prints the command
// that serves it (orchestra app plan §5). A stale copy of the dir is removed first. The mtimes count
// from now, read off a probe file's stat, so the running states hold for about a minute after the run.
//   node scripts/tower-demo.ts
// Listed in EXEMPT_SCRIPTS (test/helpers/scan-rules.ts): it writes only inside its temp dir.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rmTree } from '../test/helpers/tmp.ts';
import { writeStageFixture } from '../test/helpers/stage-fixture.ts';

if (process.argv.length > 2) {
  console.error(`tower-demo: unknown argument ${process.argv[2]}`);
  process.exit(2);
}

// The test profile takes a dir directly inside the real temp dir whose name starts orchestra-test-.
const dir = path.join(fs.realpathSync.native(os.tmpdir()), 'orchestra-test-tower');
rmTree(dir);
fs.mkdirSync(dir);
const probe = path.join(dir, 'probe');
fs.writeFileSync(probe, '');
const baseMs = Math.floor(Number(fs.statSync(probe, { bigint: true }).mtimeMs) / 1000) * 1000;
fs.rmSync(probe);
writeStageFixture(dir, baseMs);

console.log(`tower-demo: synthetic roots in ${dir}`);
console.log('tower-demo: start orchestrad from an unelevated console in the repo:');
console.log(`  orchestra.cmd --test-profile --test-dir ${dir} --peek-port 7470`);
console.log('tower-demo: then open http://orchestra.localhost:7470/ and enter the printed pairing code: the tower is the home page.');
