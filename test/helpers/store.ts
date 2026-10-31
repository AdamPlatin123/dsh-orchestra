// Store fixtures (plan step 3): a fresh ORCHESTRA_HOME inside an orchestra-test-* dir, the real write
// fence and read gate over it (made with the minted factories, as working.ts does), the real SQLite
// opener, a virtual clock and a redactor over an environment the test picks. Tests wrap the writer to
// inject a crash at the commit's three points.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { WriteFence } from '../../src/fs/write-fence.ts';
import type { ReadGate } from '../../src/fs/read-gate.ts';
import type { DbOpener } from '../../src/store/db.ts';
import type { StoreDeps, StoreOpen, StoreWriter } from '../../src/store/store.ts';
import { makeReadGate, makeWriteFence } from '../../src/fs/node-io.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { journalPath } from '../../src/store/journal.ts';
import { makeDbOpener } from '../../src/store/node-sqlite.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import { openStore } from '../../src/store/store.ts';
import { rmTree, tmpDir } from './tmp.ts';

export type StoreFixture = {
  dir: string;
  home: string;
  fence: WriteFence;
  gate: ReadGate;
  opener: DbOpener;
  clock: VirtualClock;
  journal: string;
  db: string;
  /** Closes `x` when the test ends, before the fixture is removed (Windows refuses to remove an open database). */
  track<T extends { close(): void }>(x: T): T;
  /** Opens the store as working.ts does; a new bootId each call unless one is given. */
  open(opts?: { writer?: StoreWriter; bootId?: string; env?: Record<string, string> }): StoreOpen;
};

/** 2026-10-31T00:00:00Z, the virtual wall clock's start. */
export const T0 = Date.UTC(2026, 9, 31);

export async function storeFixture(t: TestContext): Promise<StoreFixture> {
  const raw = tmpDir();
  const open: { close(): void }[] = [];
  t.after(() => {
    for (const x of open.reverse()) {
      try {
        x.close();
      } catch {
        // Closed already.
      }
    }
    rmTree(raw);
  });
  const dir = fs.realpathSync.native(raw);
  const home = path.join(dir, 'orchestra');
  const fence = await makeWriteFence({ orchestraHome: home, harnessRoots: [path.join(dir, 'claude')] });
  fence.mkdirp(home);
  const gate = makeReadGate({ roots: [], orchestraHome: home });
  const opener = await makeDbOpener({ fence });
  const clock = new VirtualClock({ mono: 1000, wall: T0 });
  return {
    dir, home, fence, gate, opener, clock,
    track: (x) => {
      open.push(x);
      return x;
    },
    journal: journalPath(home),
    db: path.join(home, 'orchestra.db'),
    open(opts = {}) {
      const deps: StoreDeps = {
        openDb: (f) => opener.open(f),
        writer: opts.writer ?? fence,
        reader: gate,
        home,
        bootId: opts.bootId ?? crypto.randomUUID(),
        clock: clock.port(null),
        redactor: makeRedactor({ env: opts.env ?? {} }),
      };
      const o = openStore(deps);
      if (o.ok) open.push(o.store);
      return o;
    },
  };
}

/** Opens and expects a reconciled store. */
export function mustOpen(f: StoreFixture, opts?: Parameters<StoreFixture['open']>[0]): Extract<StoreOpen, { ok: true }> {
  const o = f.open(opts);
  if (!o.ok) throw new Error(`store did not open: ${JSON.stringify(o.break)}`);
  return o;
}

/** Removes the database and its side files, as if the db were lost; the journal stays. */
export function deleteDb(f: StoreFixture): void {
  for (const s of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${f.db}${s}`, { force: true });
}

export const digestOf = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
