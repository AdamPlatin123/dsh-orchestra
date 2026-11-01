// Writes the stage preview's synthetic fixture (test/helpers/stage-fixture.ts) into
// %TEMP%\orchestra-test-stage and prints the command that serves it (0.1 alpha design §9). A stale
// copy of the dir is removed first. The mtimes count from now, read off a probe file's stat, so the
// lead, a2 and the DSH lead play solid for about a minute after the run; a3 is a ghost from the start.
//   node scripts/stage-demo.ts
// Listed in EXEMPT_SCRIPTS (test/helpers/scan-rules.ts): it writes only inside its temp dir.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rmTree } from '../test/helpers/tmp.ts';
import { writeStageFixture } from '../test/helpers/stage-fixture.ts';

if (process.argv.length > 2) {
  console.error(`stage-demo: unknown argument ${process.argv[2]}`);
  process.exit(2);
}

// The test profile takes a dir directly inside the real temp dir whose name starts orchestra-test-.
const dir = path.join(fs.realpathSync.native(os.tmpdir()), 'orchestra-test-stage');
rmTree(dir);
fs.mkdirSync(dir);
const probe = path.join(dir, 'probe');
fs.writeFileSync(probe, '');
const baseMs = Math.floor(Number(fs.statSync(probe, { bigint: true }).mtimeMs) / 1000) * 1000;
fs.rmSync(probe);
writeStageFixture(dir, baseMs);

console.log(`stage-demo: synthetic roots in ${dir}`);
console.log('stage-demo: start orchestrad from an unelevated console in the repo:');
console.log(`  orchestra.cmd --test-profile --test-dir ${dir} --peek-port 7470`);
console.log('stage-demo: then open http://orchestra.localhost:7470/, enter the printed pairing code and follow the Stage link.');
