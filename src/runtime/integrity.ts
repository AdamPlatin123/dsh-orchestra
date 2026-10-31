import * as path from 'node:path';
import type { RunResult, SpawnGate } from '../os/spawn.ts';
import { WHOAMI_ARGV, WHOAMI_REL } from '../os/spawn.ts';
import { frozen } from '../../shared/frozen.js';

const win = path.win32;

// Own integrity level, judged only by the mandatory label SID in `whoami /groups /fo csv /nh`
// (S-1-16-<rid>; SIDs do not change with the display language). Never by a write probe: a probe
// that happens to succeed proves nothing about the level. Any doubt is `unknown`, which
// planStartup treats as unsafe (S5 saw whoami fail once with 0xC0000142).

export type KnownLevel = 'high-or-above' | 'medium' | 'low';
export type IntegrityLevel = KnownLevel | 'unknown';

export type UnknownReason =
  | 'system-root-unavailable'
  | 'spawn-refused'
  | 'spawn-failed'
  | 'timeout'
  | 'output-too-large'
  | 'signal'
  | 'exit-nonzero'
  | 'empty-output'
  | 'parse-error'
  | 'no-label'
  | 'multiple-labels'
  | 'bad-rid';

export type Integrity =
  | { level: KnownLevel; rid: number; sid: string }
  | { level: 'unknown'; reason: UnknownReason; detail?: string };

export const HIGH_RID = 12288;
export const MEDIUM_RID = 8192;
const MAX_RID = 0xffffffff;
const LABEL = /^S-1-16-(\d{1,10})$/;

export const WHOAMI_LIMITS = frozen({ timeoutMs: 10_000, maxBytes: 256 * 1024 } as const);

export function levelForRid(rid: number): KnownLevel {
  if (rid >= HIGH_RID) return 'high-or-above';
  if (rid >= MEDIUM_RID) return 'medium';
  return 'low';
}

/** One CSV record per line, RFC 4180 quoting; null when a quote is left open or stray. */
export function parseCsvLine(line: string): string[] | null {
  const fields: string[] = [];
  let i = 0;
  for (;;) {
    let field = '';
    if (line[i] === '"') {
      i++;
      for (;;) {
        if (i >= line.length) return null;
        const ch = line[i]!;
        if (ch === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        field += ch;
        i++;
      }
      if (i < line.length && line[i] !== ',') return null;
    } else {
      const end = line.indexOf(',', i);
      field = end < 0 ? line.slice(i) : line.slice(i, end);
      if (field.includes('"')) return null;
      i = end < 0 ? line.length : end;
    }
    fields.push(field);
    if (i >= line.length) return fields;
    i++;
  }
}

/**
 * Judges whoami's stdout. The bytes come in the console code page (GBK here); decoding them as
 * latin1 keeps every ASCII quote, comma and SID intact whatever the group names say, since no
 * GBK trail byte falls below 0x40.
 */
export function parseWhoamiGroups(stdout: string): Integrity {
  if (stdout.trim() === '') return { level: 'unknown', reason: 'empty-output' };
  const sids: string[] = [];
  const lines = stdout.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (line.trim() === '') continue;
    const fields = parseCsvLine(line);
    if (fields === null) return { level: 'unknown', reason: 'parse-error', detail: `quoting broken on line ${n + 1}` };
    for (const f of fields) if (LABEL.test(f)) sids.push(f);
  }
  if (sids.length === 0) return { level: 'unknown', reason: 'no-label' };
  if (sids.length > 1) return { level: 'unknown', reason: 'multiple-labels', detail: sids.join(' ') };
  const sid = sids[0]!;
  const rid = Number(LABEL.exec(sid)![1]);
  if (!Number.isSafeInteger(rid) || rid > MAX_RID) return { level: 'unknown', reason: 'bad-rid', detail: sid };
  return { level: levelForRid(rid), rid, sid };
}

function exitText(code: number): string {
  return code < 0 || code > 255 ? `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}` : String(code);
}

/** Maps a whoami run to a level; every failure, including a non-zero exit with good output, is `unknown`. */
export function judgeWhoamiRun(r: RunResult): Integrity {
  if (!r.ok) {
    switch (r.reason) {
      case 'refused':
        return { level: 'unknown', reason: 'spawn-refused', detail: r.decision.reason };
      case 'spawn-failed':
        return { level: 'unknown', reason: 'spawn-failed', detail: r.detail };
      case 'timeout':
        return { level: 'unknown', reason: 'timeout', detail: `${r.timeoutMs} ms` };
      case 'output-too-large':
        return { level: 'unknown', reason: 'output-too-large', detail: `${r.maxBytes} bytes` };
      case 'signal':
        return { level: 'unknown', reason: 'signal', detail: r.signal };
    }
  }
  if (r.exitCode !== 0) return { level: 'unknown', reason: 'exit-nonzero', detail: exitText(r.exitCode) };
  return parseWhoamiGroups(r.stdout.toString('latin1'));
}

/** Runs `%SystemRoot%\System32\whoami.exe /groups /fo csv /nh` through the spawn gate. */
export async function probeIntegrity(gate: SpawnGate, systemRoot: string): Promise<Integrity> {
  const r = await gate.run({ exe: win.join(systemRoot, WHOAMI_REL), argv: WHOAMI_ARGV }, WHOAMI_LIMITS);
  return judgeWhoamiRun(r);
}

export function describeIntegrity(i: Integrity): string {
  return i.level === 'unknown' ? `unknown (${i.reason}${i.detail !== undefined ? `: ${i.detail}` : ''})` : `${i.level} (${i.sid})`;
}
