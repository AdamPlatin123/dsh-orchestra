// Migration 0001, the M0 schema (plan step 3, §2.2 item 3, r4 D1). Frozen with the journal record
// format at the end of step 3: a later change is migration 0002, never an edit here.
//
// Projection tables, rebuilt from the journal by src/store/rebuild.ts alone and compared row by row
// with the live ones (test/store/rebuild.test.ts): project, part (R01 roster), event (source events
// and the clock, transition, judgment, human and human.result records, in one table), inbox_item,
// reminder, command, protect_entry, and applied_jseq. Side tables, never rebuilt: snippet (purgeable
// text, src/store/snippets.ts), install_key (the key of the snippets' content digests) and metric.
// Every table is STRICT, so a column takes its declared type or the statement fails.
//
// event.kind is the journal record kind (event, clock, transition, judgment, human, human.result,
// brake.plan); a source event's own kind (§2.2 item 3's `kind: edge`, status, tool, ...) is ev_kind.
// So the edges of a part are `kind = 'event' AND ev_kind = 'edge'`, never `kind = 'edge'`.
//
// Time fields (I04): an event keeps the source's own srcSeq, its srcTime with the precision it was
// given in (data only: never an order or a duration, invariant 20), and obsMono/obsWall, read before
// the batch was appended, with the boot they belong to; jseq is the journal's order. An inbox item's
// committed_* is the obsMono/obsWall stamped on its batch before the append (so a rebuild gets it
// back), committed_jseq the jseq of that batch's commit record, rev the commit jseq of its last
// change; notified_* is the ack's arrival or the toast's shown time, from a `notified` record.

export type Migration = { readonly name: string; readonly statements: readonly string[]; readonly setVersion: string };

const M0001: Migration = Object.freeze({
  name: '0001-m0',
  statements: Object.freeze([
    // The commit line of the last batch applied, and its hash: the startup reconciliation checks the
    // journal still holds that very line.
    'CREATE TABLE applied_jseq (id INTEGER PRIMARY KEY CHECK (id = 1), jseq INTEGER NOT NULL CHECK (jseq >= 0), hash TEXT NOT NULL) STRICT',
    "INSERT INTO applied_jseq (id, jseq, hash) VALUES (1, 0, '0000000000000000000000000000000000000000000000000000000000000000')",
    `CREATE TABLE project (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      hue INTEGER NOT NULL CHECK (hue >= 0 AND hue < 12),
      created_jseq INTEGER NOT NULL,
      updated_jseq INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE part (
      ref TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      project_id TEXT,
      cwd TEXT,
      version TEXT,
      source_cursor INTEGER,
      cursor_src_seq INTEGER,
      cursor_jseq INTEGER,
      created_jseq INTEGER NOT NULL,
      updated_jseq INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE event (
      jseq INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      ev_kind TEXT,
      part_ref TEXT,
      src_seq INTEGER,
      src_time INTEGER,
      src_time_precision TEXT,
      obs_mono INTEGER NOT NULL,
      obs_wall INTEGER NOT NULL,
      boot_id TEXT NOT NULL,
      line_digest TEXT NOT NULL,
      content_digest TEXT,
      snippet_ref TEXT,
      action_id TEXT,
      timer_id TEXT,
      body TEXT NOT NULL
    ) STRICT`,
    // The human verbs' backstop (UI design 一 5): the check is made before the append, and a duplicate
    // that got into the journal anyway is skipped by INSERT OR IGNORE and counted (journal.dupAction).
    "CREATE UNIQUE INDEX event_human_action ON event (action_id) WHERE kind = 'human'",
    "CREATE UNIQUE INDEX event_result_action ON event (action_id) WHERE kind = 'human.result'",
    // One row per source event (I02): a part re-read from its committed cursor meets its own events.
    "CREATE UNIQUE INDEX event_source_seq ON event (part_ref, src_seq) WHERE kind = 'event'",
    // A timerId names one firing (seq counts the entity's timers of a class).
    "CREATE UNIQUE INDEX event_clock_timer ON event (timer_id) WHERE kind = 'clock'",
    `CREATE TABLE inbox_item (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      sev TEXT NOT NULL,
      grp TEXT NOT NULL,
      conf TEXT NOT NULL,
      state TEXT NOT NULL,
      project_id TEXT,
      part_ref TEXT,
      dedup_key TEXT NOT NULL,
      reminder_id TEXT,
      rev INTEGER NOT NULL,
      created_jseq INTEGER NOT NULL,
      committed_jseq INTEGER,
      committed_mono INTEGER,
      committed_wall INTEGER,
      committed_boot_id TEXT,
      notified_mono INTEGER,
      notified_wall INTEGER,
      notified_boot_id TEXT,
      notified_via TEXT,
      notified_attempt INTEGER,
      snooze_until_wall INTEGER,
      end_class TEXT,
      end_cause TEXT,
      ended_jseq INTEGER,
      ended_wall INTEGER,
      ended_action_id TEXT
    ) STRICT`,
    'CREATE INDEX inbox_item_dedup ON inbox_item (dedup_key)',
    // At most one live item per dedupKey (src/model/inbox.ts): apply refuses a second one first, typed
    // (dedup-live); the index is the backstop under it.
    'CREATE UNIQUE INDEX inbox_item_live_dedup ON inbox_item (dedup_key) WHERE end_class IS NULL',
    'CREATE INDEX inbox_item_state ON inbox_item (state)',
    `CREATE TABLE reminder (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      due_wall INTEGER NOT NULL,
      snippet_ref TEXT,
      project_id TEXT,
      rev INTEGER NOT NULL,
      created_jseq INTEGER NOT NULL,
      ended_jseq INTEGER,
      ended_wall INTEGER
    ) STRICT`,
    'CREATE INDEX reminder_state ON reminder (state)',
    `CREATE TABLE command (
      id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      verb TEXT NOT NULL,
      harness_pid INTEGER NOT NULL,
      harness_create_time TEXT NOT NULL,
      status TEXT NOT NULL,
      subtrees TEXT NOT NULL,
      jseq INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE protect_entry (
      pid INTEGER NOT NULL,
      create_time TEXT NOT NULL,
      reason TEXT NOT NULL,
      added_jseq INTEGER NOT NULL,
      PRIMARY KEY (pid, create_time)
    ) STRICT`,
    `CREATE TABLE snippet (
      ref TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      text TEXT,
      bytes INTEGER NOT NULL,
      digest TEXT NOT NULL,
      created_wall INTEGER NOT NULL,
      expires_wall INTEGER NOT NULL,
      cleared_wall INTEGER
    ) STRICT`,
    // One random key per install, kept beside the journal and never in it: the snippets' content
    // digests (the judgment's inputDigest, a tombstone's digest) are HMAC-SHA256 under it, so a digest
    // that outlives a purge does not let a short or guessable text be confirmed offline.
    'CREATE TABLE install_key (id INTEGER PRIMARY KEY CHECK (id = 1), key BLOB NOT NULL CHECK (length(key) = 32)) STRICT',
    `CREATE TABLE metric (
      seq INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      jseq INTEGER,
      value INTEGER NOT NULL,
      obs_mono INTEGER,
      boot_id TEXT
    ) STRICT`,
  ]),
  setVersion: 'PRAGMA user_version = 1',
});

/** Every migration in order; the database's user_version counts how many have run. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([M0001]);

/** The tables rebuild.ts derives from the journal, in the order they are compared. */
export const PROJECTION_TABLES: readonly string[] = Object.freeze(['applied_jseq', 'project', 'part', 'event', 'inbox_item', 'reminder', 'command', 'protect_entry']);

/** Side tables: written beside the journal and never rebuilt from it. */
export const SIDE_TABLES: readonly string[] = Object.freeze(['snippet', 'install_key', 'metric']);
