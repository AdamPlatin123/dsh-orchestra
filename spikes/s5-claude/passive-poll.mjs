// S5: zero-cost, read-only passive watch of the Claude session registry in every root.
// Answers "do sessions this spike did NOT start (Desktop-hosted, TUI) ever show status=waiting,
// and does it go back to busy/idle afterwards?" without starting any claude process or model call.
// Opens ONLY %CLAUDE_CONFIG_DIR%/sessions/<pid>.json (the brief's read whitelist); in the other roots it
// only lists file names (<pid>.json counts), unless --open-all-roots is given.
// Never opens *.key, transcripts or .claude.json.
// Records status / waitingFor / entrypoint / version / timestamps only; never cwd, name or sessionId.
// usage: node passive-poll.mjs [--seconds 600] [--interval-ms 500] [--extra-root <dir>]... [--open-all-roots] [--out <file.json>]
// Writes partial results every 30 s, so a run cut short still leaves evidence.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const scriptSha256 = crypto.createHash('sha256').update(fs.readFileSync(self)).digest('hex').slice(0, 16);
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const seconds = Number(opt('--seconds', '600'));
const intervalMs = Number(opt('--interval-ms', '500'));
const outFile = opt('--out', null);
const home = os.homedir();

// same candidate list as roots.mjs; a root counts only if it has sessions/
const cand = [process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), path.join(home, '.config', 'claude')];
const accDir = path.join(home, '.rec', 'claude', 'accounts');
try { for (const a of fs.readdirSync(accDir)) cand.push(path.join(accDir, a, 'config')); } catch { /* no launcher layout */ }
args.forEach((a, i) => { if (a === '--extra-root') cand.push(args[i + 1]); });
const seen = new Set(); const roots = [];
for (const c of cand.filter(Boolean)) {
  let real; try { real = fs.realpathSync.native(c); } catch { continue; }
  if (seen.has(real.toLowerCase())) continue; seen.add(real.toLowerCase());
  try { if (fs.statSync(path.join(real, 'sessions')).isDirectory()) roots.push(real); } catch { /* not a root */ }
}

const openAll = args.includes('--open-all-roots');
let primary = null; try { primary = fs.realpathSync.native(process.env.CLAUDE_CONFIG_DIR).toLowerCase(); } catch { /* unset */ }
const mayOpen = (root) => openAll || root.toLowerCase() === primary;
const nameOnly = {}; // root index -> max <pid>.json count seen (names only, never opened)

const t0 = Date.now();
const S = new Map(); // key root#pid -> tracker
const statusSamples = {}; let rounds = 0; let samples = 0; let parseErrors = 0;
const inc = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
const rel = (t) => (typeof t === 'number' ? t - t0 : null);

function round() {
  const now = Date.now(); rounds++;
  const present = new Set();
  roots.forEach((root, ri) => {
    let names = []; try { names = fs.readdirSync(path.join(root, 'sessions')); } catch { return; }
    if (!mayOpen(root)) { nameOnly[ri] = Math.max(nameOnly[ri] ?? 0, names.filter((n) => /^\d+\.json$/.test(n)).length); return; }
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue; // registry files only; *.key never opened
      let j; try { j = JSON.parse(fs.readFileSync(path.join(root, 'sessions', n), 'utf8')); } catch { parseErrors++; continue; }
      samples++;
      const key = `${ri}#${j.pid}`; present.add(key);
      const st = j.status === undefined ? '(no status)' : String(j.status);
      inc(statusSamples, st);
      let s = S.get(key);
      if (!s) {
        s = { root: ri, pid: j.pid, entrypoint: j.entrypoint, kind: j.kind, version: j.version, firstSeen: rel(now), preexisting: rounds === 1, statusKeyAt: null, transitions: [], goneAt: null, last: null };
        S.set(key, s);
      }
      if (j.status !== undefined && s.statusKeyAt == null) s.statusKeyAt = rel(now);
      const sig = `${st}|${j.waitingFor ?? ''}|${j.statusUpdatedAt ?? ''}`;
      if (sig !== s.last) {
        s.transitions.push({ seenAt: rel(now), status: st, waitingFor: j.waitingFor, statusUpdatedAt: rel(j.statusUpdatedAt) });
        s.last = sig;
      }
      s.goneAt = null;
    }
  });
  for (const [k, s] of S) if (!present.has(k) && s.goneAt == null) s.goneAt = rel(now);
}

function report(final) {
  const sessions = [...S.values()];
  const byEntrypoint = {}; for (const s of sessions) inc(byEntrypoint, `${s.entrypoint}/${s.kind}/${s.version}`);
  const waitingEpisodes = [];
  for (const s of sessions) {
    s.transitions.forEach((tr, i) => {
      if (tr.status !== 'waiting') return;
      const nx = s.transitions.slice(i + 1).find((x) => x.status !== 'waiting' || x.waitingFor !== tr.waitingFor);
      waitingEpisodes.push({
        root: s.root, pid: s.pid, entrypoint: s.entrypoint, version: s.version, waitingFor: tr.waitingFor,
        statusUpdatedAt: tr.statusUpdatedAt, seenAt: tr.seenAt,
        pollLagMs: tr.statusUpdatedAt != null && tr.statusUpdatedAt >= 0 ? tr.seenAt - tr.statusUpdatedAt : null,
        endedBy: nx ? `${nx.status}${nx.waitingFor ? '/' + nx.waitingFor : ''}` : (s.goneAt != null ? 'registry file removed' : 'still waiting at end'),
        durationMs: nx && nx.statusUpdatedAt != null && tr.statusUpdatedAt != null ? nx.statusUpdatedAt - tr.statusUpdatedAt : null,
      });
    });
  }
  const newOnes = sessions.filter((s) => !s.preexisting && s.statusKeyAt != null);
  const out = {
    script: 'passive-poll.mjs', scriptSha256, pid: process.pid, final,
    startedAt: new Date(t0).toISOString(), elapsedS: Math.round((Date.now() - t0) / 1000), intervalMs,
    rootsWatched: roots.map((r) => ({ root: r.replace(home, '~'), opened: mayOpen(r) })), registryFilesInNameOnlyRootsMax: nameOnly,
    rounds, samples, parseErrors, statusSamples,
    sessionsSeen: sessions.length, byEntrypointKindVersion: byEntrypoint,
    newSessions: { n: newOnes.length, firstSeenToStatusKeyMs: newOnes.map((s) => s.statusKeyAt - s.firstSeen).sort((a, b) => a - b) },
    removedDuringWatch: sessions.filter((s) => s.goneAt != null).length,
    waitingEpisodes,
    transitionCounts: sessions.reduce((o, s) => { for (let i = 1; i < s.transitions.length; i++) inc(o, `${s.transitions[i - 1].status}->${s.transitions[i].status}`); return o; }, {}),
  };
  const text = JSON.stringify(out, null, 1);
  if (outFile) fs.writeFileSync(outFile, text);
  return text;
}

console.error(`[passive-poll] pid=${process.pid} roots=${roots.length} seconds=${seconds}`);
round();
const iv = setInterval(round, intervalMs);
const rep = setInterval(() => report(false), 30000);
setTimeout(() => { clearInterval(iv); clearInterval(rep); round(); console.log(report(true)); }, seconds * 1000);
