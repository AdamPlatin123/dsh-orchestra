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
//
// An owned session's sub-agents (its members, members.ts) are kept with it, states and times only, so
// the tower still lists them after a restart: one the record says was running or idle comes back unknown,
// never running. A file without them (a session that spawned none, an earlier build's) reads as before, and so
// does a member an earlier build wrote without its batch or its type (null: not known). threadId holds a Codex
// thread id or a Claude task id.

export const REGISTRY_DIR = 'owned';
/** 32 members of at most 200 + 240 + 240 + 240 characters written out (a thread id; a name, a model and a type that are all quotes) fit. */
export const REGISTRY_LIMITS = frozen({ fileBytes: 40 * 1024, members: 32, memberIdChars: 200, memberNameBytes: 120, memberModelBytes: 120 });

export type OwnedRecordState = 'starting' | 'idle' | 'running' | 'ended' | 'failed' | 'unknown';
/** running and idle are what codex last said of a live thread; the rest stay true once its session is gone. */
export type MemberState = 'running' | 'idle' | 'returned' | 'ended' | 'unknown';
/** Why a member ended without a report: its turn failed, it was interrupted, or it was shut down. */
export type MemberEnd = 'failed' | 'interrupted' | 'shutdown';
/** One sub-agent of a session as the registry keeps it: never a word it said. */
export type MemberRecord = {
  readonly threadId: string;
  /** Shown text (redacted); null when codex named it nowhere (T1). */
  readonly name: string | null;
  /** The model codex said it runs on, shown text; null when codex did not say (T1). */
  readonly model: string | null;
  /** The kind of sub-agent the harness named (Claude's subagent_type), shown text; null when it names none (T1). */
  readonly agentType: string | null;
  readonly state: MemberState;
  /** Set exactly when the state is ended. */
  readonly why: MemberEnd | null;
  /** Wall ms codex gave for its start and its end; null when it gave none (T1). */
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** Its steps (commands, file changes, tool calls) that failed, and errors that took no retry: a report can come back all the same. */
  readonly failed: number;
  /** Its commands and file changes that ran though codex never asked. */
  readonly ranUnasked: number;
  /** The dispatch of the root it came with (codex-session.ts, a number within its session); null when no spawn of the root named it (T1). */
  readonly batch: number | null;
};

export type OwnedRecord = {
  readonly v: 1;
  readonly ownedId: string;
  readonly harness: 'codex' | 'claude';
  readonly model: string;
  readonly title: string;
  readonly createdAt: number;
  readonly state: OwnedRecordState;
  readonly endReason: string | null;
  /** Its sub-agents, at most REGISTRY_LIMITS.members; absent when none was seen. */
  readonly members?: readonly MemberRecord[];
  /** Sub-agents past that bound: named nowhere, counted here. */
  readonly membersOver?: number;
  /** It was the front desk (src/route/front-desk.ts): no worker, whatever else this file says. Absent on every other session. */
  readonly frontDesk?: true;
};

const KEYS = ['v', 'ownedId', 'harness', 'model', 'title', 'createdAt', 'state', 'endReason'] as const;
const MEMBER_KEYS = ['threadId', 'name', 'model', 'agentType', 'state', 'why', 'startedAt', 'endedAt', 'failed', 'ranUnasked', 'batch'] as const;
const MEMBER_STATES: readonly unknown[] = ['running', 'idle', 'returned', 'ended', 'unknown'];
const MEMBER_ENDS: readonly unknown[] = ['failed', 'interrupted', 'shutdown'];
const stamp = (v: unknown) => v === null || (Number.isSafeInteger(v) && (v as number) >= 0);

/** One member of a registry file, or null when it is not one this build wrote. */
function parseMember(v: unknown): MemberRecord | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o: Record<string, unknown> = { batch: null, agentType: null, ...(v as Record<string, unknown>) };
  if (Object.keys(o).length !== MEMBER_KEYS.length || !MEMBER_KEYS.every((k) => Object.hasOwn(o, k))) return null;
  if (typeof o.threadId !== 'string' || o.threadId === '' || o.threadId.length > REGISTRY_LIMITS.memberIdChars) return null;
  if (o.name !== null && (typeof o.name !== 'string' || o.name === '' || utf8Length(o.name) > REGISTRY_LIMITS.memberNameBytes)) return null;
  if (o.model !== null && (typeof o.model !== 'string' || o.model === '' || utf8Length(o.model) > REGISTRY_LIMITS.memberModelBytes)) return null;
  if (o.agentType !== null && (typeof o.agentType !== 'string' || o.agentType === '' || utf8Length(o.agentType) > REGISTRY_LIMITS.memberNameBytes)) return null;
  if (!MEMBER_STATES.includes(o.state) || (o.state === 'ended' ? !MEMBER_ENDS.includes(o.why) : o.why !== null)) return null;
  if ((o.batch !== null && (!Number.isSafeInteger(o.batch) || (o.batch as number) < 1)) || !stamp(o.startedAt) || !stamp(o.endedAt) || !Number.isSafeInteger(o.failed) || (o.failed as number) < 0 || !Number.isSafeInteger(o.ranUnasked) || (o.ranUnasked as number) < 0) return null;
  return Object.freeze({ ...o }) as unknown as MemberRecord;
}

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
  const withMembers = Object.hasOwn(o, 'members') && Object.hasOwn(o, 'membersOver');
  const desk = Object.hasOwn(o, 'frontDesk');
  if (desk && o.frontDesk !== true) return null;
  if (Object.keys(o).length !== KEYS.length + (withMembers ? 2 : 0) + (desk ? 1 : 0) || !KEYS.every((k) => Object.hasOwn(o, k))) return null;
  if (o.v !== 1 || typeof o.ownedId !== 'string' || !OWNED_ID_RE.test(o.ownedId) || (o.harness !== 'codex' && o.harness !== 'claude')) return null;
  if (typeof o.model !== 'string' || !isOwnedModel(o.model)) return null;
  if (typeof o.title !== 'string' || utf8Length(o.title) > OWNED_BOUNDS.titleBytes) return null;
  if (!Number.isSafeInteger(o.createdAt) || (o.createdAt as number) < 0) return null;
  if (typeof o.state !== 'string' || !(OWNED_ENUMS.state as readonly string[]).includes(o.state)) return null;
  if (o.endReason !== null && (typeof o.endReason !== 'string' || !(OWNED_ENUMS.endReason as readonly string[]).includes(o.endReason))) return null;
  let members: MemberRecord[] | null = null;
  if (withMembers) {
    if (!Array.isArray(o.members) || o.members.length > REGISTRY_LIMITS.members || !Number.isSafeInteger(o.membersOver) || (o.membersOver as number) < 0) return null;
    members = o.members.map(parseMember).filter((m) => m !== null);
    if (members.length !== o.members.length || new Set(members.map((m) => m.threadId)).size !== members.length) return null;
  }
  return Object.freeze({
    v: 1, ownedId: o.ownedId, harness: o.harness, model: o.model, title: o.title, createdAt: o.createdAt as number,
    state: o.state as OwnedRecordState, endReason: o.endReason as string | null,
    ...(members === null ? {} : { members: Object.freeze(members), membersOver: o.membersOver as number }),
    ...(desk ? { frontDesk: true as const } : {}),
  });
}

/** Whether codex last said this member's thread is alive: then nobody here knows how it stands once its session is gone (T1). */
export const memberLive = (m: Pick<MemberRecord, 'state'>): boolean => m.state === 'running' || m.state === 'idle';

/** What a record says after a restart: a session that had not ended is unknown (daemon-restart), and so is any member still live in it. */
export function afterRestart(r: OwnedRecord): OwnedRecord {
  const over = r.state === 'ended' || r.state === 'failed' || r.state === 'unknown';
  const loose = r.members?.some(memberLive) === true;
  if (over && !loose) return r;
  return Object.freeze({
    ...r,
    ...(over ? {} : { state: 'unknown' as const, endReason: 'daemon-restart' }),
    ...(loose ? { members: Object.freeze(r.members!.map((m) => (memberLive(m) ? Object.freeze({ ...m, state: 'unknown' as const }) : m))) } : {}),
  });
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
      if (r.members !== undefined) {
        body.members = r.members.map((m) => Object.fromEntries(MEMBER_KEYS.map((k) => [k, m[k]])));
        body.membersOver = r.membersOver ?? 0;
      }
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
