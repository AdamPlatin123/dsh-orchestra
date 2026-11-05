import type { Feed } from './feed.ts';
import type { MemberEnd, MemberRecord, MemberState, OwnedRecord } from './registry.ts';
import type { Redact } from './text.ts';
import { isOwnedModel } from './models.ts';
import { REGISTRY_LIMITS, memberLive } from './registry.ts';
import { memberNodeId } from '../sources/tower.ts';
import { shown } from './text.ts';
import { frozen } from '../../shared/frozen.js';

// The sub-agents of an owned session, whichever harness runs it: the list both drivers keep (codex-session.ts by
// thread id, claude-session.ts by task id; the registry's threadId field holds either). What a harness reports differs
// and stays in its driver; how a member's state moves, how a name is taken, how a dispatch is numbered and told is the
// same, and lives here. Nothing a member says comes here: states, times, a name (shown text) and a model.

export const MEMBER_LIMITS = frozen({
  /** The sub-agents one session lists; past this they are only counted. */
  members: REGISTRY_LIMITS.members,
  /** Of those only counted, the ids kept to count each once; past this the count stands still. */
  overIds: 4096,
});

/** The ref of a stop's notes about the sub-agents, live and final. */
export const MEMBERS_STOP_REF = 'members-stop';

/** A sub-agent of a session as its driver shows it: the registry's fields, and what lives only in the driver. */
export type SessionMember = MemberRecord & {
  /** Wall ms of the last thing heard of it; null after a restart. */
  readonly lastAt: number | null;
  /** Its open approvals, oldest first. */
  readonly asks: readonly string[];
};

/** The state a driver keeps of a member; a driver adds fields of its own. */
export type MemberBase = { -readonly [K in Exclude<keyof SessionMember, 'asks'>]: SessionMember[K] } & {
  asks: string[];
  /** Its dispatch event was told with no name: told again once one is known. */
  unnamed: boolean;
};

const BLANK: Omit<MemberBase, 'threadId'> = { name: null, model: null, agentType: null, state: 'unknown', why: null, startedAt: null, endedAt: null, failed: 0, ranUnasked: 0, batch: null, lastAt: null, asks: [], unnamed: false };

export type MemberTableOptions<M extends MemberBase> = {
  ownedId: string;
  feed: Feed;
  redact: Redact;
  /** How a card names the id: thread (Codex), task (Claude). */
  idWord: string;
  /** What the driver keeps beside the shared fields of a new member. */
  extra(): Omit<M, keyof MemberBase>;
  /** A note in the session's feed (member-off-list). */
  note(state: string, text: string): void;
  /** Called before the first member of the session is listed. */
  onFirst?(): void;
};

/** The members of one session. */
export function memberTable<M extends MemberBase>(o: MemberTableOptions<M>) {
  const { ownedId, feed, redact } = o;
  const members = new Map<string, M>();
  /** Ids past the bound, each counted once. */
  const over = new Set<string>();
  let rev = 0;
  /** Batches so far: the next dispatch's number. */
  let batches = 0;
  /** The dispatch the next spawn joins: of this key, nothing else of the root's since. */
  let dispatching: { batch: number; key: string } | null = null;
  const bump = () => {
    rev++;
  };
  const clean = (raw: string, bytes: number) => shown(redact, raw.slice(0, 1024), bytes, 'head').text.replace(/\s+/g, ' ').trim();
  /** The dispatch event of a member, as it is known now. */
  const tell = (m: M) => {
    feed.push({ kind: 'note', ref: memberNodeId(ownedId, m.threadId), text: m.name, state: 'dispatch', batch: m.batch! });
  };
  const move = (m: M, state: MemberState, why: MemberEnd | null = null) => {
    if (m.state === state && m.why === why) return;
    m.state = state;
    m.why = why;
    rev++;
  };
  const end = (m: M, at: number | null) => {
    if (m.endedAt !== null || at === null) return;
    m.endedAt = at;
    rev++;
  };
  /** A member as a card names it; the end of its id tells two of one name, or of none, apart. */
  const label = (m: M | null, id: string) => `${m?.name ?? 'name unknown'} (${o.idWord} …${id.slice(-8)})`;
  return {
    all: members,
    over,
    get rev() {
      return rev;
    },
    bump,
    label,
    move,
    /** The member of an id, new if none is known and there is room; past the bound the id is only counted. */
    of(id: string): M | null {
      const had = members.get(id);
      if (had !== undefined) return had;
      if (members.size >= MEMBER_LIMITS.members) {
        if (!over.has(id) && over.size < MEMBER_LIMITS.overIds) {
          over.add(id);
          rev++;
          feed.upsert('members-over', { kind: 'note', ref: null, text: `${over.size}`, state: 'members-over' });
        }
        return null;
      }
      if (members.size === 0) o.onFirst?.();
      const m = { ...BLANK, asks: [], threadId: id, ...o.extra() } as unknown as M;
      members.set(id, m);
      rev++;
      return m;
    },
    /** The first time given for its start; a time that came later does not replace it. */
    started(m: M, at: number | null) {
      if (m.startedAt !== null || at === null) return;
      m.startedAt = at;
      rev++;
    },
    /** The first time given for its end. */
    end,
    /** A member that was heard to run; one that reported or ended only a new turn revives. */
    runs(m: M) {
      if (m.state === 'unknown' || m.state === 'idle') move(m, 'running');
    },
    /** A report came back; a turn that failed or was interrupted stays that. */
    returned(m: M, at: number | null) {
      if (m.state === 'ended') return;
      move(m, 'returned');
      end(m, at);
    },
    ended(m: M, why: MemberEnd, at: number | null) {
      move(m, 'ended', why);
      end(m, at);
    },
    name(m: M, raw: string | null) {
      if (raw === null || m.name !== null) return;
      const s = clean(raw, REGISTRY_LIMITS.memberNameBytes);
      if (s === '') return;
      m.name = s;
      rev++;
      if (m.unnamed) tell(m);
      m.unnamed = false;
    },
    /** The kind of sub-agent the harness says it is, the first it says. */
    type(m: M, raw: string | null) {
      if (raw === null || m.agentType !== null) return;
      const s = clean(raw, REGISTRY_LIMITS.memberNameBytes);
      if (s === '') return;
      m.agentType = s;
      rev++;
    },
    /** The model the harness says it runs on, the first it says; one outside the owned list is said, its name beside it (nothing stops it: isOwnedModel never saw it). */
    model(m: M, raw: string | null) {
      if (raw === null || m.model !== null) return;
      const s = clean(raw, REGISTRY_LIMITS.memberModelBytes);
      if (s === '') return;
      m.model = s;
      rev++;
      if (!isOwnedModel(raw)) o.note('member-off-list', `${label(m, m.threadId)}: ${s}`);
    },
    /** The root sent it out: once a member, in the open batch if this key has one, else in a new one. `key` null: a batch of its own, and it opens none. */
    dispatched(m: M, key: string | null) {
      if (m.batch !== null) return;
      m.batch = key !== null && dispatching?.key === key ? dispatching.batch : ++batches;
      dispatching = key === null ? null : { batch: m.batch, key };
      rev++;
      tell(m);
      m.unnamed = m.name === null;
    },
    /** Something else of the root's came: the next spawn is another dispatch. */
    closeDispatch() {
      dispatching = null;
    },
    /** The session is gone: nobody can hear a member again, so one still live is unknown, never running (T1). */
    lose() {
      for (const m of members.values()) {
        m.asks = [];
        if (memberLive(m)) move(m, 'unknown');
      }
    },
    /** The list as a session shows it. */
    list(): readonly SessionMember[] {
      return Object.freeze([...members.values()].map((m) => {
        const { threadId, name, model, agentType, state, why, startedAt, endedAt, failed, ranUnasked, batch, lastAt, asks } = m;
        return Object.freeze({ threadId, name, model, agentType, state, why, startedAt, endedAt, failed, ranUnasked, batch, lastAt, asks: Object.freeze([...asks]) });
      }));
    },
  };
}

/**
 * A run's sub-agents as a request reads them (src/route/requests.ts), beyond what the feed says. out: something of the
 * run still runs (a member's turn) or is owed by the harness; cut: one of them was stopped, or the session went with
 * something out or a member's fate unknown, so what the root last said is not the run's answer (T1); whole: neither.
 * An idle or unknown member of a live session is not out: nothing says it will ever say more.
 */
export type MemberRun = 'whole' | 'out' | 'cut';
export function memberRun(members: Iterable<Pick<MemberBase, 'state' | 'why'>>, owed: boolean, gone: boolean): MemberRun {
  const list = [...members];
  if (owed || list.some((m) => m.state === 'running')) return gone ? 'cut' : 'out';
  return list.some((m) => m.why === 'interrupted' || (gone && m.state === 'unknown')) ? 'cut' : 'whole';
}

/** What a session has of its members, for the registry and the tower. */
export type MemberHolder = { readonly members: readonly SessionMember[]; readonly membersOver: number };

/** A session's sub-agents as the registry keeps them; nothing when it has none, so its file stays as it was. */
export function memberRecords(s: MemberHolder): Pick<OwnedRecord, 'members' | 'membersOver'> {
  if (s.members.length === 0 && s.membersOver === 0) return {};
  return { members: s.members.map(({ lastAt: _l, asks: _a, ...m }) => m), membersOver: s.membersOver };
}

/** The members of a session an earlier orchestrad left, as its record says. */
export function restoredMembers(r: OwnedRecord): readonly SessionMember[] {
  return Object.freeze((r.members ?? []).map((m) => Object.freeze({ ...m, lastAt: null, asks: Object.freeze([]) })));
}
