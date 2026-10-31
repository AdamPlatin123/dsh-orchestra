// Metadata snapshot of the top level of ~/.codex (name, size, mtime; files and folders), and a diff of two snapshots.
// Take a snapshot BEFORE running any codex subcommand, and again after (review finding S1-CODEX-07).
// Nothing is opened: readdir + stat only. Names that look sensitive are left out of the output entirely.
// Usage: node24 codex-home-meta.mjs [codexHome] > snap.json
//        node24 codex-home-meta.mjs --diff before.json after.json
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const SENSITIVE = /auth|config\.toml|history\.jsonl|\.bak|credential|\.key$|\.env|^memories/i;

if (argv[0] === '--diff') {
  const [a, b] = argv.slice(1).map((p) => JSON.parse(fs.readFileSync(p, 'utf8')).entries);
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push({ name: k, before: a[k] ?? null, after: b[k] ?? null });
  console.log(JSON.stringify(out.sort((x, y) => x.name.localeCompare(y.name)), null, 1));
} else {
  const home = argv[0] ?? path.join(process.env.USERPROFILE, '.codex');
  const entries = {};
  for (const e of fs.readdirSync(home, { withFileTypes: true })) {
    if (SENSITIVE.test(e.name)) continue;
    const st = fs.statSync(path.join(home, e.name));
    entries[e.name + (e.isDirectory() ? '/' : '')] = { size: e.isDirectory() ? null : st.size, mtime: st.mtime.toISOString() };
  }
  console.log(JSON.stringify({ home, takenAt: new Date().toISOString(), entries }, null, 1));
}
