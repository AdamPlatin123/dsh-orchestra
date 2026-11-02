import * as path from 'node:path';
import { frozen } from '../../shared/frozen.js';
import { OWNED_BOUNDS, OWNED_ENUMS, OWNED_ID_RE } from '../../shared/owned-contract.js';
import { isOwnedModel } from './models.ts';
import { utf8Length } from './text.ts';

const win = path.win32;

// The owned sessions' registry (alpha 0.2 slice design §2.4): one small file per session,
// ORCHESTRA_HOME\owned\<ownedId>.json, written through the write fence when the session is made and
// whenever its state changes, read back through the read gate when orchestrad starts. It holds what the
// tower and GET /api/owned need to say a session exists: never a message, a feed event or a path.
//
// T1 across a restart: a session the registry says was starting, idle or running belongs to an
// orchestrad that is gone; whether its child still runs nobody here knows. It comes back as unknown with
// endReason daemon-restart, and is never resumed and no message is sent again (r4 §8.3 rule 5: what has
// an unknown outcome is never resent automatically). One that had ended or failed comes back as it was.

export const REGISTRY_DIR = 'owned';
export const REGISTRY_LIMITS = frozen({ fileBytes: 4096 });

export type OwnedRecordState = 'starting' | 'idle' | 'running' | 'ended' | 'failed' | 'unknown';
export type OwnedRecord = {
  readonly v: 1;
  readonly ownedId: string;
  readonly harness: 'codex' | 'claude';
  readonly model: string;
  readonly title: string;
  readonly createdAt: number;
  readonly state: OwnedRecordState;
  readonly endReason: string | null;
};

const KEYS = ['v', 'ownedId', 'harness', 'model', 'title', 'createdAt', 'state', 'endReason'] as const;

/** One registry file's text, or null when it is not a record this build wrote (it is then left alone). */
export function parseOwnedRecord(text: string): OwnedRecord | null {
  if (utf8Length(text) > REGISTRY_LIMITS.fileBytes) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== KEYS.length || !KEYS.every((k) => Object.hasOwn(o, k))) return null;
  if (o.v !== 1 || typeof o.ownedId !== 'string' || !OWNED_ID_RE.test(o.ownedId) || (o.harness !== 'codex' && o.harness !== 'claude')) return null;
  if (typeof o.model !== 'string' || !isOwnedModel(o.model)) return null;
  if (typeof o.title !== 'string' || utf8Length(o.title) > OWNED_BOUNDS.titleBytes) return null;
  if (!Number.isSafeInteger(o.createdAt) || (o.createdAt as number) < 0) return null;
  if (typeof o.state !== 'string' || !(OWNED_ENUMS.state as readonly string[]).includes(o.state)) return null;
  if (o.endReason !== null && (typeof o.endReason !== 'string' || !(OWNED_ENUMS.endReason as readonly string[]).includes(o.endReason))) return null;
  return Object.freeze({
    v: 1, ownedId: o.ownedId, harness: o.harness, model: o.model, title: o.title, createdAt: o.createdAt as number,
    state: o.state as OwnedRecordState, endReason: o.endReason as string | null,
  });
}

/** What a record says after a restart: a session that had not ended is unknown (daemon-restart). */
export function afterRestart(r: OwnedRecord): OwnedRecord {
  if (r.state === 'ended' || r.state === 'failed' || r.state === 'unknown') return r;
  return Object.freeze({ ...r, state: 'unknown', endReason: 'daemon-restart' });
}

/** The registry's file io: the composition root hands in the write fence and the read gate. */
export type RegistryIo = {
  /** ORCHESTRA_HOME\owned, made already. */
  dir: string;
  writeAtomic(file: string, text: string): void;
  readdir(dir: string): string[];
  readFile(file: string): string;
};

export type OwnedRegistry = {
  save(r: OwnedRecord): void;
  /** Every record the registry holds, oldest first; files it cannot read or parse are left out. */
  load(): OwnedRecord[];
};

export function makeOwnedRegistry(io: RegistryIo): OwnedRegistry {
  return Object.freeze({
    save(r: OwnedRecord): void {
      if (!OWNED_ID_RE.test(r.ownedId)) throw new Error(`owned registry: not an owned id: ${String(r.ownedId)}`);
      const body: Record<string, unknown> = {};
      for (const k of KEYS) body[k] = r[k];
      io.writeAtomic(win.join(io.dir, `${r.ownedId}.json`), `${JSON.stringify(body)}\n`);
    },
    load(): OwnedRecord[] {
      let names: string[];
      try {
        names = io.readdir(io.dir);
      } catch {
        return [];
      }
      const out: OwnedRecord[] = [];
      for (const name of names) {
        const m = /^([0-9a-f]{20})\.json$/.exec(name);
        if (m === null) continue;
        let text: string;
        try {
          text = io.readFile(win.join(io.dir, name));
        } catch {
          continue;
        }
        const r = parseOwnedRecord(text);
        if (r !== null && r.ownedId === m[1]) out.push(r);
      }
      return out.sort((a, b) => a.createdAt - b.createdAt || (a.ownedId < b.ownedId ? -1 : 1));
    },
  });
}
