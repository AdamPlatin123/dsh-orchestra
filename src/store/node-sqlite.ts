import type { DatabaseSync, StatementSync, constants } from 'node:sqlite';
import type { Authorizer, DbOpener, DbOpenerConfig, DbOpenerSpec, Param, RawConnection, RawStatement, Row, SqliteBackend, SqliteCodes } from './db.ts';

// The one module that loads node:sqlite (plan step 3, zen note 7.3), minted like src/fs/node-io.ts:
// boot.ts imports it before the import fence goes in and hands makeDbOpener to main.ts in BootPorts;
// once the fence is in, no module can resolve it (minted-before-fence), and builtin-policy.ts gives
// node:sqlite to this module alone. The builtin itself loads only when the first opener is made, in
// working mode after the lock: a ui-only process never loads node:sqlite or db.ts (plan §6 invariant
// 10). The raw DatabaseSync never leaves this file: a caller gets a DbOpener (db.ts) built around the
// backend below, whose connections expose exec, prepare and the authorizer, and nothing else of
// node:sqlite (the static scan sqlite-surface-bans names what stays out, and this file never names it).
//
// DatabaseSync reads every option it is not given through the prototype chain (measured on 24.22:
// open, readOnly, enableForeignKeyConstraints, enableDoubleQuotedStringLiterals, allowExtension,
// timeout, readBigInts, returnArrays, allowBareNamedParameters, allowUnknownNamedParameters,
// defensive), so each bag is frozen, has no prototype and sets all of them. Statements take
// positional parameters only, so no parameter bag is ever read.

type Sqlite = { DatabaseSync: typeof DatabaseSync; constants: typeof constants };

const bag = <T extends object>(o: T): T => Object.freeze(Object.assign(Object.create(null) as T, o));

const OPTIONS = {
  rw: bag({
    open: true, readOnly: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false,
    timeout: 250, readBigInts: false, returnArrays: false, allowBareNamedParameters: false, allowUnknownNamedParameters: false, defensive: true,
  }),
  ro: bag({
    open: true, readOnly: true, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false,
    timeout: 250, readBigInts: false, returnArrays: false, allowBareNamedParameters: false, allowUnknownNamedParameters: false, defensive: true,
  }),
} as const;

function statementOf(raw: StatementSync): RawStatement {
  return bag({
    run: (...params: Param[]) => ({ changes: Number(raw.run(...params).changes) }),
    get: (...params: Param[]) => raw.get(...params) as Row | undefined,
    all: (...params: Param[]) => raw.all(...params) as Row[],
  });
}

function connectionOf(db: DatabaseSync): RawConnection {
  return bag({
    exec: (sql: string) => {
      db.exec(String(sql));
    },
    prepare: (sql: string) => statementOf(db.prepare(String(sql))),
    setAuthorizer: (fn: Authorizer) => {
      db.setAuthorizer(fn as Parameters<DatabaseSync['setAuthorizer']>[0]);
    },
    close: () => {
      db.close();
    },
  });
}

function backendOf(sqlite: Sqlite): SqliteBackend {
  const c = sqlite.constants;
  const codes: SqliteCodes = bag({
    OK: c.SQLITE_OK, DENY: c.SQLITE_DENY, SELECT: c.SQLITE_SELECT, READ: c.SQLITE_READ, FUNCTION: c.SQLITE_FUNCTION, PRAGMA: c.SQLITE_PRAGMA,
    ATTACH: c.SQLITE_ATTACH, DETACH: c.SQLITE_DETACH, TRANSACTION: c.SQLITE_TRANSACTION, RECURSIVE: c.SQLITE_RECURSIVE,
  });
  const Database = sqlite.DatabaseSync;
  return bag({
    codes,
    open: (file: string, mode: 'rw' | 'ro') => connectionOf(new Database(String(file), mode === 'ro' ? OPTIONS.ro : OPTIONS.rw)),
  });
}

/**
 * A DbOpener on the real node:sqlite. Asynchronous because node:sqlite and db.ts load with the first
 * opener (see above). Object.assign copies the spec's own enumerable fields only, into an object
 * without a prototype, before the first await, and the backend comes last, so one in the spec never
 * reaches the opener.
 */
export async function makeDbOpener(spec: DbOpenerSpec): Promise<DbOpener> {
  const cfg = Object.assign(Object.create(null) as DbOpenerConfig, spec);
  const [sqlite, { DbOpener: Opener }] = await Promise.all([import('node:sqlite'), import('./db.ts')]);
  return new Opener(Object.assign(cfg, { backend: backendOf(sqlite) }));
}
