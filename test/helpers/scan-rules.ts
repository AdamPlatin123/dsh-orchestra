// The static-scan rules (plan step 1, invariants 2, 4, 6, 14, 15 of plan §6). Text based and
// strict: comments count too, so production code keeps banned words out of its comments as well.
import * as nodeModule from 'node:module';
import * as path from 'node:path';
import { MINTED_MODULES, builtinId, decideBuiltin, onlyNames, rowsFor } from '../../src/runtime/builtin-policy.ts';
import { GLOBAL_POWERS, PROCESS_POWERS } from '../../src/runtime/process-powers.ts';

export type Finding = { index: number; text: string };
export type Rule = {
  id: string;
  applies(file: string): boolean;
  find(text: string, file: string): Finding[];
};
export type Hit = { rule: string; file: string; line: number; text: string };

// Scripts that only touch tmp or fixtures; everything else under scripts/ is scanned (plan step 1).
export const EXEMPT_SCRIPTS: readonly string[] = [
  'scripts/sanitize-fixture.ts',
  'scripts/latency-report.ts',
  'scripts/procmon-check.ts',
  'scripts/rss-20.ts',
  'scripts/test-stage.ts',
  // The tower page's demo (orchestra app plan §5): tower-demo writes the synthetic fixture into a
  // %TEMP%\orchestra-test-* dir; embed-ui reads the repo's ui/ and shared/ and writes the one generated
  // src/server/ui-assets.ts. Neither touches a harness root. stage-keys-sample reads real roots and so
  // stays scanned (plan step 1).
  'scripts/tower-demo.ts',
  'scripts/embed-ui.ts',
  // Orchestra app step 4 (owned Claude sessions): pin-claude-host reads the host's two files and the
  // installed SDK entry and writes the one generated src/owned/claude-pins.ts. live-smoke is the manual
  // end-to-end run against the local magpie gateway: it starts orchestrad in the test profile (a child
  // process, its data dir an %TEMP%\orchestra-test-* dir it makes and removes), talks to it over HTTP
  // on 127.0.0.1 with fetch, waits with timers and reads the one file the owned session wrote in that
  // dir. Daemon rules (spawn gate, read gate, clock) would ban each of those; it is never part of the
  // test run and touches no harness root.
  'scripts/pin-claude-host.ts',
  // procguard's pin (orchestra app: owned sessions in procguard Jobs): reads native/procguard/ProcGuard.cs
  // and writes the one generated src/os/procguard-pins.ts, as pin-claude-host does for the host.
  'scripts/pin-procguard.ts',
  'scripts/live-smoke.ts',
  // The dispatch desk's live run (orchestra app plan §3), the same kind as live-smoke: it starts orchestrad
  // in the test profile, speaks HTTP to it on 127.0.0.1 and waits on timers; it touches no harness root.
  'scripts/live-route.ts',
  // What the two live runs share (phase 3 review): HTTP to orchestrad with a deadline, the end of a session
  // waited out, and the children orchestrad recorded in the test dir's run/pids.jsonl ended when left over.
  'scripts/live-common.ts',
];

// test/ is scanned for in-process-start-only-in-helper alone: every other rule's scope excludes it.
// hosts/ (alpha 0.2 design §6) gets the hosts: rules alone, the same way.
export const SCANNED_DIRS: readonly string[] = ['src', 'shared', 'ui', 'scripts', 'vendor', 'test', 'hosts'];

/** Repo-relative paths under SCANNED_DIRS the scan never walks: a host's SDK, which the user installs (design §1). */
export const isScanSkipped = (rel: string): boolean => /^hosts\/[^/]+\/node_modules(?:\/|$)/.test(rel.replace(/\\/g, '/'));

const exempt = (f: string) => EXEMPT_SCRIPTS.includes(f);
/** Daemon-side code: src, shared and the scanned scripts. */
const code = (f: string) => /^(src|shared|scripts)\//.test(f) && !exempt(f);
/** Everything first-party that ships: daemon-side code plus the browser UI. */
const prod = (f: string) => code(f) || f.startsWith('ui/');
const ui = (f: string) => f.startsWith('ui/');
const vendor = (f: string) => f.startsWith('vendor/');
const except = (scope: (f: string) => boolean, ...files: string[]) => (f: string) => scope(f) && !files.includes(f);

function matches(re: RegExp): (text: string) => Finding[] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return (text) => [...text.matchAll(g)].map((m) => ({ index: m.index, text: m[0] }));
}

function ban(id: string, scope: (f: string) => boolean, ...res: RegExp[]): Rule {
  const finders = res.map(matches);
  return { id, applies: scope, find: (text) => finders.flatMap((f) => f(text)) };
}

export type ImportRef = {
  spec: string;
  index: number;
  form: 'static' | 'export' | 'side-effect' | 'dynamic' | 'require';
  typeOnly: boolean;
  /** Named value imports; null for a namespace or default import, or any non-static form. */
  names: string[] | null;
};

function namedList(clause: string): string[] | null {
  const c = clause.trim();
  if (!/^\{[\s\S]*\}$/.test(c)) return null;
  return c.slice(1, -1).split(',').map((s) => s.trim()).filter((s) => s.length > 0 && !/^type\s/.test(s))
    .map((s) => s.split(/\s+as\s+/)[0]!.trim());
}

/** Every import-like reference with a literal specifier. */
export function findImports(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  for (const m of text.matchAll(/\bimport\s+(type\s+)?([\w$*{}\s,]+?)\s*\bfrom\s*(['"])([^'"\n]+)\3/g)) {
    out.push({ spec: m[4]!, index: m.index, form: 'static', typeOnly: m[1] !== undefined, names: namedList(m[2]!) });
  }
  for (const m of text.matchAll(/\bexport\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\3/g)) {
    out.push({ spec: m[4]!, index: m.index, form: 'export', typeOnly: m[1] !== undefined, names: namedList(m[2]!) });
  }
  for (const m of text.matchAll(/\bimport\s*(['"])([^'"\n]+)\1/g)) {
    out.push({ spec: m[2]!, index: m.index, form: 'side-effect', typeOnly: false, names: null });
  }
  for (const m of text.matchAll(/\bimport\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g)) {
    out.push({ spec: m[2]!, index: m.index, form: 'dynamic', typeOnly: false, names: null });
  }
  for (const m of text.matchAll(/\brequire\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g)) {
    out.push({ spec: m[2]!, index: m.index, form: 'require', typeOnly: false, names: null });
  }
  return out;
}

const valueImports = (text: string) => findImports(text).filter((r) => !r.typeOnly);

const builtinPolicy: Rule = {
  id: 'builtin-policy',
  applies: code,
  find(text, file) {
    const out: Finding[] = [];
    for (const r of valueImports(text)) {
      if (!nodeModule.isBuiltin(r.spec)) continue;
      const d = decideBuiltin(file, r.spec);
      if (!d.allow) out.push({ index: r.index, text: `${d.builtin} (${d.reason})` });
    }
    return out;
  },
};

const builtinOnlyNames: Rule = {
  id: 'builtin-only-names',
  applies: code,
  find(text, file) {
    const out: Finding[] = [];
    for (const r of valueImports(text)) {
      if (!nodeModule.isBuiltin(r.spec)) continue;
      const id = builtinId(r.spec);
      const only = onlyNames(file, id);
      if (only === undefined || !decideBuiltin(file, id).allow) continue;
      const extra = r.names === null ? ['<namespace, default or dynamic import>'] : r.names.filter((n) => !only.includes(n));
      if (extra.length > 0) out.push({ index: r.index, text: `${id}: ${extra.join(', ')} (only ${only.join(', ')})` });
    }
    return out;
  },
};

const vendorTypeOnly: Rule = {
  id: 'vendor-type-only',
  applies: prod,
  find: (text) => valueImports(text).filter((r) => /(^|\/)vendor\//.test(r.spec)).map((r) => ({ index: r.index, text: r.spec })),
};

const noSpikes: Rule = {
  id: 'no-spikes-import',
  applies: prod,
  find: (text) => findImports(text).filter((r) => /(^|[\\/])spikes[\\/]/.test(r.spec)).map((r) => ({ index: r.index, text: r.spec })),
};

// The runtime twin is decideImport in src/runtime/import-fence.ts: code files only, never data.
const relativeCodeOnly: Rule = {
  id: 'import-relative-code-only',
  applies: prod,
  find: (text) => findImports(text)
    .filter((r) => !nodeModule.isBuiltin(r.spec) && !(/^\.\.?\//.test(r.spec) && /\.(?:ts|js)$/.test(r.spec)))
    .map((r) => ({ index: r.index, text: r.spec })),
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The process and global rules are generated from src/runtime/process-powers.ts, the table the import
// fence locks at runtime; the table names every key it lists, so it is the one file they skip. They
// match member access only: process.<name>, process['<name>'], Reflect.get(process, '<name>') and
// destructuring from process, never a bare name, so child.kill(), controller.abort() and timer.unref()
// pass. A global's own name is matched bare (an alias counts too), except in the module that mints it
// and the ones it is handed to; a process mint entry likewise (boot.ts takes process.reallyExit and
// keeps it). An alias of process (`const p = process; p.kill(pid)`) passes the text scan and meets the
// runtime stub, which every spelling reaches.
const POWER_TABLE = 'src/runtime/process-powers.ts';
const isSymbolKey = (key: string) => key.startsWith('Symbol(');
const mintedOrHeldBy = (e: (typeof PROCESS_POWERS)[number], file: string) => e.class === 'mint' && (e.mintedBy === file || e.heldBy.includes(file));
const PROCESS_FENCED = PROCESS_POWERS.filter((e) => e.class !== 'keep' && !isSymbolKey(e.key));
/** The member patterns over the process keys `file` may not name: every lock entry, and every mint entry it neither mints nor holds. */
function processMemberRes(file: string): RegExp[] {
  const names = PROCESS_FENCED.filter((e) => !mintedOrHeldBy(e, file)).map((e) => escapeRe(e.key)).join('|');
  if (names === '') return [];
  return [
    new RegExp(`\\bprocess\\s*(?:\\?\\.|\\.)\\s*(?:${names})(?![\\w$])`, 'g'),
    new RegExp(`\\bprocess\\s*(?:\\?\\.\\s*)?\\[\\s*(['"\`])(?:${names})\\1\\s*\\]`, 'g'),
    new RegExp(`\\bReflect\\s*\\.\\s*get\\s*\\(\\s*(?:globalThis\\s*\\.\\s*)?process\\s*,\\s*(['"\`])(?:${names})\\1`, 'g'),
    new RegExp(`\\{[^{}]*(?<![\\w$])(?:${names})(?![\\w$])[^{}]*\\}\\s*=\\s*(?:globalThis\\s*\\.\\s*)?process\\b`, 'g'),
  ];
}
const processPowerMember: Rule = {
  id: 'process-power-member',
  applies: except(prod, POWER_TABLE),
  find: (text, file) => processMemberRes(file).flatMap((re) => [...text.matchAll(re)].map((m) => ({ index: m.index, text: m[0] }))),
};

// orchestrad's exit code is boot.ts's alone (finding N1): makeEndProcess hands its typed code to the
// reallyExit it took before the fence, and the fence locks process.exit and process.reallyExit for
// everyone else (process-power-member names them). Two levers stay outside the table:
// process.exitCode is a non-configurable accessor, and an 'exit' or 'beforeExit' listener runs
// whenever the process ends by itself. Neither changes a code boot commits (it passes the code to
// reallyExit), but either decides the code of a process that ends any other way, so both stay in
// boot.ts. An alias of process (`const p = process; p.exitCode = 0`) is a residual of a text scan.
// Step 3b, finding F1: the crash path decides the code too. boot.ts's crash handler is the capture
// callback (runEntry) and its monitor listener comes first, but an 'uncaughtExceptionMonitor' listener
// that throws ends a crash with 7, an 'unhandledRejection' listener keeps a rejection from crashing at
// all, and an 'uncaughtException' listener does nothing but mislead. So adding or removing a listener
// of any of these five events stays in boot.ts, and process.removeAllListeners (which takes boot's
// monitor with it, whatever event it names) is banned outside it; process.off of a signal stays allowed.
const ASSIGN = '\\s*(?:(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[-+*/%&|^])?=(?!=)|\\+\\+|--)';
const EXIT_EVENT_METHODS = '(?:on|once|addListener|prependListener|prependOnceListener|off|removeListener)';
const EXIT_EVENTS = '(?:exit|beforeExit|uncaughtException|uncaughtExceptionMonitor|unhandledRejection)';
const processExitLevers = ban('process-exit-only-in-boot', except(code, 'src/boot.ts'),
  new RegExp(`\\bprocess\\s*(?:\\?\\.|\\.)\\s*exitCode${ASSIGN}`),
  new RegExp(`\\bprocess\\s*(?:\\?\\.\\s*)?\\[\\s*(['"\`])exitCode\\1\\s*\\]${ASSIGN}`),
  /(?:\+\+|--)\s*process\s*(?:\.\s*exitCode\b|\[\s*(['"`])exitCode\1\s*\])/,
  /\b(?:Reflect\s*\.\s*(?:set|defineProperty)|Object\s*\.\s*defineProperty)\s*\(\s*(?:globalThis\s*\.\s*)?process\s*,\s*(['"`])exitCode\1/,
  new RegExp(`\\bprocess\\s*(?:\\?\\.|\\.)\\s*${EXIT_EVENT_METHODS}\\s*\\(\\s*(['"\`])${EXIT_EVENTS}\\1`),
  new RegExp(`\\bprocess\\s*(?:\\?\\.\\s*)?\\[\\s*(['"\`])${EXIT_EVENT_METHODS}\\1\\s*\\]\\s*\\(\\s*(['"\`])${EXIT_EVENTS}\\2`),
  /\bprocess\s*(?:\?\.|\.)\s*removeAllListeners\b/,
  /\bprocess\s*(?:\?\.\s*)?\[\s*(['"`])removeAllListeners\1\s*\]/,
  /\{[^{}]*(?<![\w$])removeAllListeners(?![\w$])[^{}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/);

// Object.freeze does not hold a RegExp against Annex B's compile(), which swaps the pattern before it
// fails on the frozen lastIndex (measured on 24.22). shared/frozen.js gives every RegExp it freezes an
// own compile that throws, so `X_RE.compile(...)` meets that stub; a call through RegExp.prototype or
// a destructured compile would reach the original, so the word is banned in our code as a member, a
// quoted key or a destructured name. shared/frozen.js names it to define the stub. A key computed at
// run time is a residual of a text scan; RegExp.prototype itself cannot be locked without turning off
// V8's regex fast paths process-wide (shared/frozen.js).
const regexpCompile = ban('ban:RegExp-compile', except(prod, 'shared/frozen.js'),
  /\.\s*compile\b/, /['"`]compile['"`]/, /\{[^{}]*(?<![\w$.])compile\s*[:,}]/);

const GLOBAL_NAMED = GLOBAL_POWERS.filter((e) => e.class !== 'keep' && !isSymbolKey(e.key))
  .map((e) => ({ e, re: new RegExp(`(?<![\\w$])${escapeRe(e.key)}(?![\\w$])`, 'g') }));
// The Fetch Metadata request headers (Sec-Fetch-Site and its siblings) name no global: the server
// checks Sec-Fetch-Site (plan step 4, invariant 12). They are blanked to the same length before the
// match, so offsets stay put and a bare fetch beside one still counts.
const FETCH_METADATA = /\bsec-fetch-(?:site|mode|dest|user)\b/gi;
const globalPowerName: Rule = {
  id: 'global-power-name',
  applies: (f) => code(f) && f !== POWER_TABLE,
  find: (text, file) => {
    const t = text.replace(FETCH_METADATA, (m) => ' '.repeat(m.length));
    return GLOBAL_NAMED
      .filter(({ e }) => !(e.class === 'mint' && (e.mintedBy === file || e.heldBy.includes(file))))
      .flatMap(({ re }) => [...t.matchAll(re)].map((m) => ({ index: m.index, text: m[0] })));
  },
};
// A symbol entry is matched by its registered key without the trailing version (undici.globalDispatcher.1 -> undici.globalDispatcher).
const SYMBOL_TEXTS = [...new Set(GLOBAL_POWERS.filter((e) => e.class !== 'keep' && isSymbolKey(e.key)).map((e) => e.key.slice('Symbol('.length, -1).replace(/\.\d+$/, '')))];
const globalPowerSymbol = ban('global-power-symbol', except(prod, POWER_TABLE), ...SYMBOL_TEXTS.map((t) => new RegExp(`\\b${escapeRe(t)}\\b`)));

// Plan §6 invariant 7: a raw signal by pid skips the identity checks of the brake. The import fence
// locks process.kill and process._kill (process-power-member covers the scan); children stop through
// their own ChildProcess handle, and procguard (step 6) kills by pid + createTime. The handle form
// `.kill(` is allowed only in src/os/, which holds the handles. import-fence.ts once named kill and
// was exempt; the process-powers table drives the fence now, so it names no kill and gets no pass.
const OS_DIR = (f: string) => f.startsWith('src/os/');
const handleKill = ban('kill-only-in-os', (f) => code(f) && !OS_DIR(f), /\.\s*_?kill\s*\(/);

/** [start, end) of the first line matching `head` up to the first `}` at column 0 after it, or null. */
function spanOf(text: string, head: RegExp): [number, number] | null {
  const start = text.search(head);
  if (start < 0) return null;
  const close = /^\}/m.exec(text.slice(start));
  return [start, close === null ? text.length : start + close.index + 1];
}

// Step 2c removed gate-construction-only-in-roots (a gate built anywhere reaches nothing real, since
// its io/backend is required and minted only in node-io.ts/node-proc.ts — minting.test.ts measures
// it). But the FACTORIES hand out the real io: a non-root module that calls makeReadGate would get a
// real gate over roots it picks. gate-factory-only-in-roots keeps that authority in the composition
// roots (P8). The factory names appear only in the root files, and in harness-roots.ts only inside
// the LauncherFsPorts type and launcherRootFs. Step 3 adds makeDbOpener, the node:sqlite mint's
// factory (src/store/node-sqlite.ts): an opener made by any other module would open databases with a
// fence of its own choosing. Elsewhere the names are banned as words, wherever they stand: a property,
// a call, a destructured key renamed or not, a quoted key for brackets or Reflect.get, a comment. A key
// computed at run time ('make' + 'ReadGate') stays a residual of a text scan.
const FACTORY = 'makeReadGate|makeWriteFence|makeSpawnGate|makeDbOpener';
const FACTORY_ROOTS: readonly string[] = ['src/boot.ts', 'src/main.ts', 'src/runtime/working.ts', 'src/fs/node-io.ts', 'src/os/node-proc.ts', 'src/store/node-sqlite.ts'];
const gateFactoryUse: Rule = {
  id: 'gate-factory-only-in-roots',
  applies: code,
  find(text, file) {
    if (FACTORY_ROOTS.includes(file)) return [];
    const spans = file === 'src/fs/harness-roots.ts'
      ? [spanOf(text, /^export type LauncherFsPorts\b/m), spanOf(text, /^export function launcherRootFs\b/m)]
      : [];
    const allowed = (i: number) => spans.some((s) => s !== null && i >= s[0] && i < s[1]);
    const res = [
      new RegExp(`(?:\\?\\.|\\.)\\s*(?:${FACTORY})(?![\\w$])`, 'g'),
      new RegExp(`(?<![\\w$.])(?:${FACTORY})(?![\\w$])\\s*\\(`, 'g'),
      new RegExp(`\\{[^{}]*(?<![\\w$])(?:${FACTORY})(?![\\w$])[^{}]*\\}\\s*=`, 'g'),
      // Any other spelling: the bare word (a quoted key, a renamed destructuring, a comment).
      new RegExp(`(?<![\\w$])(?:${FACTORY})(?![\\w$])`, 'g'),
    ];
    const hits = res.flatMap((re) => [...text.matchAll(re)]).filter((m) => !allowed(m.index));
    // One hit per place: the bare-word pattern meets the same name as the narrower ones.
    const seen = new Set<number>();
    return hits.filter((m) => {
      const at = m.index + m[0].search(new RegExp(`(?:${FACTORY})`));
      if (seen.has(at)) return false;
      seen.add(at);
      return true;
    }).map((m) => ({ index: m.index, text: m[0] }));
  },
};

const resolvesTo = (file: string, spec: string, target: string) =>
  /^\.\.?\//.test(spec) && path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)).toLowerCase() === target;

// A minted module (builtin-policy.ts rows with `minted`) is imported by src/boot.ts before the import
// fence goes in and by nobody else. decideImport refuses it to every module resolved after the fence
// (minted-before-fence); this rule covers what boot.ts's own graph loads before it, where no hook runs.
const mintedImport: Rule = {
  id: 'minted-import-only-in-boot',
  applies: (f) => code(f) && f !== 'src/boot.ts',
  find: (text, file) => valueImports(text).filter((r) => MINTED_MODULES.some((m) => resolvesTo(file, r.spec, m)))
    .map((r) => ({ index: r.index, text: `${r.form} import of ${r.spec}` })),
};

const WRITE_CALL = /\b(?:write\w*|append\w*|rename\w*|mkdir\w*|mkdtemp\w*|rmdir\w*|rm|rmSync|unlink\w*|chmod\w*|chown\w*|fsync\w*|f?truncate\w*|lchown\w*|lchmod\w*)\s*\(/g;

/** `openSync(...)` calls whose flag argument is not the literal 'r'. */
function openNotReadOnly(text: string, offset = 0): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(/\bopenSync\s*\(([^()]*)\)/g)) {
    const args = m[1]!.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (args.length >= 2 && !/'r'$/.test(args[1]!)) out.push({ index: offset + m.index, text: m[0] });
  }
  return out;
}

// node-io.ts holds both raw ios; the one makeReadGate hands out must only read: no write call and no
// open other than 'r' inside `const READ_IO`. The read gate itself is held to the same by
// fs-write-only-in-write-fence and read-gate-open-flag-r.
const readIoReadsOnly: Rule = {
  id: 'node-io-read-io-reads-only',
  applies: (f) => f === 'src/fs/node-io.ts',
  find(text) {
    const span = spanOf(text, /^const READ_IO\b/m);
    if (span === null) return [{ index: 0, text: 'no const READ_IO in node-io.ts' }];
    const body = text.slice(span[0], span[1]);
    const writes = [...body.matchAll(WRITE_CALL)].map((m) => ({ index: span[0] + m.index, text: m[0] }));
    return [...writes, ...openNotReadOnly(body, span[0])];
  },
};

// node-io.ts's 'append-existing' flag must open for append and never create: O_WRONLY | O_APPEND,
// no O_CREAT. WriteFence.append() rests on it — a file it created on a lost race (a directory swapped
// out of home) is removed again only because the open did not create one. The write-fence tests run
// over the helper's own io (test/helpers/write-io.ts), so this pins the constant production uses: a
// plain 'a', or an added O_CREAT, would silently create and leave a stray file outside home.
// The key must appear exactly once (a later duplicate key wins at run time), and its value is read up
// to the next comma or closing brace at depth 0, across lines, so an O_CREAT on the next line counts.
// test/fs/write-fence.test.ts also measures production's WRITE_IO: appending to a missing file through
// the fence's existing-file path creates nothing.
function valueOf(text: string, from: number): string {
  let depth = 0;
  let i = from;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
    } else if (c === ',' && depth === 0) break;
  }
  return text.slice(from, i).replace(/\s+/g, ' ').trim();
}

function flagRule(id: string, key: string, want: RegExp, wantText: string): Rule {
  return {
    id,
    applies: (f) => f === 'src/fs/node-io.ts',
    find(text) {
      const ms = [...text.matchAll(new RegExp(`'${key}'\\s*:`, 'g'))];
      if (ms.length === 0) return [{ index: 0, text: `no '${key}' flag in node-io.ts` }];
      if (ms.length > 1) return [{ index: ms[1]!.index, text: `'${key}' is set ${ms.length} times; the last one wins at run time` }];
      const m = ms[0]!;
      const expr = valueOf(text, m.index + m[0].length);
      if (want.test(expr)) return [];
      return [{ index: m.index, text: `${key} must be ${wantText}, got ${expr}` }];
    },
  };
}

const appendExistingFlag: Rule = flagRule('node-io-append-existing-flag', 'append-existing', /^fs\.constants\.O_WRONLY \| fs\.constants\.O_APPEND$/, 'fs.constants.O_WRONLY | fs.constants.O_APPEND (no O_CREAT)');

// The same for 'write-existing' (step 3), the handle WriteFence.shorten() cuts the journal through:
// O_WRONLY alone. An O_CREAT would make a file where a swapped directory pointed, an O_TRUNC would
// empty the whole journal before the fence judged the handle; 'w' would do both.
const writeExistingFlag: Rule = flagRule('node-io-write-existing-flag', 'write-existing', /^fs\.constants\.O_WRONLY$/, 'fs.constants.O_WRONLY (no O_CREAT, no O_TRUNC)');

// runWorking builds both fs gates from whatever context it is handed and then clears tmp\: only
// main.ts, after planStartup() said working, may load it. Type-only imports load nothing.
const workingImport: Rule = {
  id: 'working-wiring-only-from-main',
  applies: (f) => /^(src|shared)\//.test(f) && f !== 'src/main.ts' && f !== 'src/runtime/working.ts',
  find: (text, file) => valueImports(text).filter((r) => resolvesTo(file, r.spec, 'src/runtime/working.ts'))
    .map((r) => ({ index: r.index, text: `${r.form} import of ${r.spec}` })),
};

// launcherRootFs makes a ReadGate from a caller-made env with the factory it is handed: the
// composition roots only. A namespace import of harness-roots.ts would reach it as a property, so it
// counts too.
const LAUNCHER_ROOTS = ['src/main.ts', 'src/runtime/working.ts', 'src/fs/harness-roots.ts'];
const launcherRootFsUse: Rule = {
  id: 'launcher-root-fs-only-in-roots',
  applies: (f) => /^(src|shared)\//.test(f) && !LAUNCHER_ROOTS.includes(f),
  find(text, file) {
    const out = matches(/\blauncherRootFs\b/)(text);
    for (const r of valueImports(text)) {
      if (r.names === null && r.form !== 'side-effect' && resolvesTo(file, r.spec, 'src/fs/harness-roots.ts')) out.push({ index: r.index, text: `${r.form} import of ${r.spec}` });
    }
    return out;
  },
};

// The fs calls no module may make, in one table, over the modules that can import node:fs at all
// (builtin-policy.ts; since step 2c only src/fs/node-io.ts). Everywhere else there is no node:fs to
// call them on: the builtin-policy rule and the import fence refuse the import. ftruncate stays
// allowed (`truncate` matches only as a word of its own): step 3 truncates the journal through it.
const FS_NAME_BANS: readonly { name: string; re: RegExp }[] = [
  { name: 'copyFile', re: /copyFile/g },
  { name: 'cp', re: /\bcp(?:Sync)?\s*\(/g },
  { name: 'createWriteStream', re: /createWriteStream/g },
  { name: 'truncate', re: /(?<![\w$])truncate(?:Sync)?(?![\w$])/g },
  { name: 'utimes', re: /utimes/g },
  { name: 'symlink', re: /symlink/gi },
  { name: 'link', re: /\blink(?:Sync)?\s*\(/g },
];
const holdsFs = (f: string) => rowsFor(f).some((r) => r.allow.some((id) => id === 'node:fs' || id.startsWith('node:fs/')));
const fsNameBans: Rule = {
  id: 'fs-name-bans',
  applies: (f) => code(f) && holdsFs(f),
  find: (text) => FS_NAME_BANS.flatMap(({ name, re }) => [...text.matchAll(re)].map((m) => ({ index: m.index, text: `${name}: ${m[0]}` }))),
};

// The node:sqlite mint hands out exec, prepare and the authorizer, nothing else of the builtin (plan
// step 3, invariant 17): no backup (copies the database to any path), sessions and changesets,
// extensions, serialize/deserialize, user functions or aggregates, tag stores, or the defensive switch
// (left on by the open options). Over the modules that can import node:sqlite at all (builtin-policy.ts;
// node-sqlite.ts alone): everywhere else there is no node:sqlite to call them on.
const SQLITE_NAME_BANS: readonly { name: string; re: RegExp }[] = [
  { name: 'backup', re: /\bbackup\b/g },
  { name: 'Session', re: /\b(?:Session|createSession|applyChangeset)\b/g },
  { name: 'loadExtension', re: /\b(?:loadExtension|enableLoadExtension)\b/g },
  { name: 'serialize', re: /\b(?:serialize|deserialize)\b/g },
  { name: 'function', re: /\.\s*(?:function|aggregate)\s*\(/g },
  { name: 'createTagStore', re: /\bcreateTagStore\b/g },
  { name: 'enableDefensive', re: /\benableDefensive\b/g },
];
const holdsSqlite = (f: string) => rowsFor(f).some((r) => r.allow.includes('node:sqlite'));
const sqliteNameBans: Rule = {
  id: 'sqlite-surface-bans',
  applies: (f) => code(f) && holdsSqlite(f),
  find: (text) => SQLITE_NAME_BANS.flatMap(({ name, re }) => [...text.matchAll(re)].map((m) => ({ index: m.index, text: `${name}: ${m[0]}` }))),
};

// SQL is fixed text with positional parameters (plan step 3): never a template literal that
// interpolates into SQL, never SQL glued together with +. Keywords are matched in capitals, the way
// the store writes SQL, so English in a message does not trip it; and any interpolating template
// handed straight to a statement method counts whatever its case. The authorizer is the runtime net.
const SQL_WORD = '(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|ATTACH|DETACH|VACUUM|REPLACE|WHERE|VALUES)';
const QUOTE = '[\'"`]';
const NOT_QUOTE = '[^\'"`\\n]*';
const sqlTextLiteral = ban('sql-text-literal-only', code,
  // A template literal with a SQL keyword and an interpolation.
  new RegExp('`[^`]*\\b' + SQL_WORD + '\\b[^`]*\\$\\{'),
  // An interpolating template handed straight to a statement method.
  /\.\s*(?:run|all|exec|prepare)\s*\(\s*`[^`]*\$\{/,
  // A quoted piece of SQL glued to something with +, on either side.
  new RegExp('(' + QUOTE + ')' + NOT_QUOTE + '\\b' + SQL_WORD + '\\b' + NOT_QUOTE + '\\1\\s*\\+'),
  new RegExp('\\+\\s*' + QUOTE + NOT_QUOTE + '\\b' + SQL_WORD + '\\b'));

// `new Worker(src, { eval: true })` runs source text in a thread that never meets the bootstrap, and
// no resolve hook reaches it: in the modules that can import node:worker_threads (builtin-policy.ts)
// this rule is the only defense. Every other module cannot get a Worker at all.
const holdsWorkers = (f: string) => rowsFor(f).some((r) => r.allow.includes('node:worker_threads'));

// An in-process start() or runWorking() runs orchestrad inside the test process. Without a pinned home
// main.ts takes the real one (a test file run directly, or with --test-isolation=none, carries no
// NODE_TEST_CONTEXT), and its default stopping ends the test process. test/helpers/start.ts wraps
// both: it refuses unless home is a fake home in an orchestra-test-* fixture and passes
// IN_PROCESS_STOP, so it is the only test file that may import them. Type-only imports load nothing.
const IN_PROCESS: readonly { module: string; name: string }[] = [{ module: 'src/main.ts', name: 'start' }, { module: 'src/runtime/working.ts', name: 'runWorking' }];
const inProcessStart: Rule = {
  id: 'in-process-start-only-in-helper',
  applies: (f) => f.startsWith('test/') && f !== 'test/helpers/start.ts',
  find: (text, file) => valueImports(text)
    .filter((r) => r.form !== 'side-effect' && IN_PROCESS.some((t) => resolvesTo(file, r.spec, t.module) && (r.names === null || r.names.includes(t.name))))
    .map((r) => ({ index: r.index, text: `${r.form} import of ${r.spec}` })),
};

// Invariant 21 (plan step 3): time only through the Clock port. The clocks the plan names (Date.now,
// new Date(), performance.now, process.hrtime, setTimeout, setInterval) and the environment clocks of
// zen note 7.3 (Date(), a bare new Date, Intl.DateTimeFormat().format() without an argument,
// performance.timeOrigin, process.uptime, AbortSignal.timeout) appear only in src/runtime/clock.ts.
// Every performance member counts (mark, measure and timerify stamp the time too), and so does an
// alias of performance. new Date(ms) converts a reading and passes; Date.parse and Date.UTC compute.
// node:timers and node:timers/promises are clock.ts's builtins alone: builtin-policy.ts's row, which the
// builtin-policy rule and the import fence both read, refuses them everywhere else.
// ui/ and test/ are outside the scope (ui/clock.js is the page's one clock, step 5). scripts/test-stage.ts
// keeps its two setTimeout calls under §3's script exemption (EXEMPT_SCRIPTS): it runs beside
// orchestrad, waits on processes it started, and feeds nothing to the journal. The process-powers
// table names every global and is skipped.
//
// Ordinary spellings reach a clock past a member pattern ((Date).now(), Date/**/.now(), const { now } =
// Date, Reflect.construct(Date, []), globalThis['Date'].now(), (performance).now()), so the words
// themselves are banned outside clock.ts: `performance` anywhere, `Date` anywhere but Date.UTC(,
// Date.parse( and new Date(<an argument that is no spread>), which compute or convert; the timer names
// and hrtime/uptime/timeOrigin quoted too, and AbortSignal's timeout by any spelling. The globals stay
// keep entries (process-powers.ts): a key computed at run time (globalThis['Da' + 'te']) is the
// residual of a text scan.
const CLOCK_FILE = 'src/runtime/clock.ts';

/** Every `Date` word that is not Date.UTC(, Date.parse( or new Date(<no spread, not empty>). */
function dateWords(text: string): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(/(?<![\w$])Date(?![\w$])/g)) {
    const after = text.slice(m.index + 4, m.index + 64);
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (/^\s*\.\s*(?:UTC|parse)\s*\(/.test(after) && !/\.\s*$/.test(before)) continue;
    if (/\bnew\s+$/.test(before) && /^\s*\(\s*(?!\.\.\.|\))/.test(after)) continue;
    out.push({ index: m.index, text: text.slice(m.index, m.index + 24).split('\n')[0]! });
  }
  return out;
}

/** The word bans above, beside the member patterns below: one rule. */
const clockWords = (text: string): Finding[] => [
  ...dateWords(text),
  ...matches(/(?<![\w$])performance(?![\w$])/)(text),
  ...matches(/['"`](?:hrtime|uptime|timeOrigin)['"`]/)(text),
  ...matches(/\bAbortSignal\s*(?:\?\.\s*)?\[/)(text),
  ...matches(/\(\s*AbortSignal\s*\)/)(text),
  ...matches(/\{[^{}]*(?<![\w$])timeout(?![\w$])[^{}]*\}\s*=\s*(?:globalThis\s*\.\s*)?AbortSignal\b/)(text),
];

const clockMembers = ban('clock-only-in-clock-ts', (f) => code(f) && f !== CLOCK_FILE && f !== POWER_TABLE,
  /\bDate\s*(?:\?\.|\.)\s*now\b/,
  /\bDate\s*\[\s*(['"`])now\1\s*\]/,
  /\bReflect\s*\.\s*get\s*\(\s*(?:globalThis\s*\.\s*)?Date\s*,\s*(['"`])now\1/,
  /\bnew\s+(?:globalThis\s*\.\s*)?Date\b(?:\s*\(\s*\)|(?!\s*\())/,
  /(?<![\w$.])(?<!\bnew\s+)Date\s*\(/,
  /\bperformance\s*(?:\?\.|\.|\[)/,
  /=\s*(?:globalThis\s*\.\s*)?performance\b/,
  /\bprocess\s*(?:\?\.|\.)\s*(?:hrtime|uptime)\b/,
  /\bprocess\s*(?:\?\.\s*)?\[\s*(['"`])(?:hrtime|uptime)\1\s*\]/,
  /\{[^{}]*(?<![\w$])(?:hrtime|uptime)(?![\w$])[^{}]*\}\s*=\s*(?:globalThis\s*\.\s*)?process\b/,
  /\bset(?:Timeout|Interval)\b/,
  /\bDateTimeFormat\b[^;\n]*?\.\s*format(?:ToParts)?\s*\(\s*\)/,
  /\bAbortSignal\s*\.\s*timeout\b/);
const clockOnly: Rule = { id: clockMembers.id, applies: clockMembers.applies, find: (text, file) => [...clockMembers.find(text, file), ...clockWords(text)] };

// The real clock hub is made in boot.ts alone and handed down (BootPorts.clock); a module that made its
// own would read the time past the Clock its composition root handed it, and a VirtualClock in daemon
// code would be a second time base. So makeRealClock is named only in boot.ts and clock.ts, and
// VirtualClock only in clock.ts (tests use both). takeExitTimer, the native timer of boot.ts's flush
// deadline, likewise: clock.ts hands it out once and boot.ts takes it first, so any other caller is
// refused at run time, and the name outside boot.ts is a mistake the scan shows at build time. A
// namespace or dynamic import of clock.ts would reach any of them as a property, so it counts too,
// except in boot.ts; type-only imports load nothing.
const clockFactories: Rule = {
  id: 'clock-factories-only-in-roots',
  applies: (f) => code(f) && f !== CLOCK_FILE,
  find(text, file) {
    const out = matches(/\bVirtualClock\b/)(text);
    if (file === 'src/boot.ts') return out;
    out.push(...matches(/\b(?:makeRealClock|takeExitTimer)\b/)(text));
    for (const r of valueImports(text)) {
      if (r.names === null && r.form !== 'side-effect' && resolvesTo(file, r.spec, CLOCK_FILE)) out.push({ index: r.index, text: `${r.form} import of ${r.spec}` });
    }
    return out;
  },
};

// shared/ is loaded by the page too (ui/ imports '../shared/x.js'): it imports only .js files inside
// shared/. Builtins are refused there by builtin-policy.ts (NO_BUILTIN_DIRS) for the builtin-policy rule
// and the import fence alike; this rule covers everything else, src/ included.
const sharedSelfContained: Rule = {
  id: 'shared-imports-shared-only',
  applies: (f) => f.startsWith('shared/'),
  find: (text, file) => findImports(text)
    .filter((r) => !nodeModule.isBuiltin(r.spec) && !(/^\.\.?\//.test(r.spec) && /\.js$/.test(r.spec) && path.posix.normalize(path.posix.join(path.posix.dirname(file), r.spec)).startsWith('shared/')))
    .map((r) => ({ index: r.index, text: r.spec })),
};

// Daemon-side code never loads test/ code (a test helper may hold node:fs, or write and delete helpers,
// that builtin-policy cannot see through, and plain `node scripts/x.ts` runs outside the import fence).
// The one exception: a scanned script may take test/helpers/read-io.ts, whose openSync refuses every
// flag but 'r'. Type-only imports load nothing.
const READ_IO_HELPER = 'test/helpers/read-io.ts';
const noTestImport: Rule = {
  id: 'code-no-test-import',
  applies: code,
  find: (text, file) => valueImports(text)
    .filter((r) => /^\.\.?\//.test(r.spec))
    .filter((r) => {
      const to = path.posix.normalize(path.posix.join(path.posix.dirname(file), r.spec)).toLowerCase();
      return to.startsWith('test/') && !(file.startsWith('scripts/') && to === READ_IO_HELPER);
    })
    .map((r) => ({ index: r.index, text: r.spec })),
};

const readGateFlag: Rule = {
  id: 'read-gate-open-flag-r',
  applies: (f) => f === 'src/fs/read-gate.ts',
  find: (text) => openNotReadOnly(text),
};

// The Claude host (alpha 0.2 design §1 route B, §6 "扫描"). It runs as its own node process outside
// orchestrad's import fence, beside an SDK the user installed, so none of the rules above reach it
// (their scopes are src/, shared/, scripts/, ui/, vendor/ and test/) and it gets rules of its own. The
// entry host.mjs wires powers: it alone imports builtins (a short list), loads the SDK by one absolute
// file URL built from its own location, and holds the one timer. Every other host file is pure and
// imports nothing. No host file names a permission bypass (r4's dangerously scan lands here).
const hosts = (f: string) => f.startsWith('hosts/') && !isScanSkipped(f);
const HOST_ENTRY = 'hosts/claude/host.mjs';
const HOST_BUILTINS: readonly string[] = ['node:crypto', 'node:fs/promises'];
const HOST_SDK_URL = "const SDK_URL = new URL('./node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs', import.meta.url);";

const hostImports: Rule = {
  id: 'hosts:import-allowlist',
  applies: hosts,
  find: (text, file) => findImports(text)
    .filter((r) => !(file === HOST_ENTRY && HOST_BUILTINS.includes(r.spec)) && !(file === HOST_ENTRY && /^\.\/[\w-]+\.mjs$/.test(r.spec)))
    .map((r) => ({ index: r.index, text: `${r.form} import of ${r.spec}` })),
};

// Any other way to reach daemon code: a path literal into src/ or shared/, wherever it stands.
const hostNoDaemonPath = ban('hosts:no-src-or-shared', hosts, /['"`][^'"`\n]*(?:^|[\\/])(?:src|shared)[\\/][^'"`\n]*['"`]/);

// The one computed import: the SDK, by the URL built from host.mjs's own location. findImports sees
// literal specifiers only, so every `import(` is matched here.
const hostDynamicImport: Rule = {
  id: 'hosts:sdk-import-only-in-entry',
  applies: hosts,
  find(text, file) {
    const entry = file === HOST_ENTRY;
    const sdkAt = entry ? text.indexOf(HOST_SDK_URL) : -1;
    const inSdkUrl = (i: number) => sdkAt >= 0 && i >= sdkAt && i < sdkAt + HOST_SDK_URL.length;
    const out = [
      ...matches(/\bimport\s*\(/)(text).filter((m) => !(entry && text.startsWith('import(SDK_URL.href)', m.index))),
      ...[/\bnew\s+URL\s*\(/, /\bimport\s*\.\s*meta\b/, /\bSDK_URL\s*=/].flatMap((re) => matches(re)(text).filter((m) => !inSdkUrl(m.index))),
    ];
    if (entry && text.split(HOST_SDK_URL).length !== 2) out.push({ index: 0, text: 'host.mjs defines SDK_URL exactly once, as the URL of the installed sdk.mjs next to it' });
    return out;
  },
};

const hostTimers = ban('hosts:setTimeout-only-in-entry', hosts, /\bset(?:Interval|Immediate)\b/, /['"`]node:timers/);
const hostTimeout: Rule = { id: 'hosts:setTimeout-only-in-entry', applies: hosts, find: (text, file) => [...hostTimers.find(text, file), ...(file === HOST_ENTRY ? [] : matches(/\bsetTimeout\b/)(text))] };

const hostPure = ban('hosts:core-pure', (f) => hosts(f) && f !== HOST_ENTRY, /\bprocess\s*(?:\?\.|\.|\[)/, /\bglobalThis\b/, /\brequire\s*\(/);

const hostNoBypass = ban('hosts:no-permission-bypass', hosts,
  /bypassPermissions/, /acceptEdits/, /allowDangerouslySkipPermissions/, /permissionPrompt/, /dangerously/i);

const hostNoDynamicCode = ban('hosts:no-dynamic-code', hosts, /\beval\s*\(/, /\bnew\s+Function\b/, /\bcreateRequire\b/, /\bMath\s*(?:\?\.|\.)\s*random\b/);

// The owned Codex step (orchestra app plan §2): the fake app-server's spawn rule and its node.exe option
// start a child of the test suite's choosing. In daemon code only src/os/spawn.ts names them (it opens them
// only under the test runner); a composition root that named them would hand the daemon a node.exe child.
const fakeCodexOnlyInTests = ban('fake-codex-only-in-tests', except(code, 'src/os/spawn.ts'), /codex-app-server-fake/, /\bfakeCodexNode\b/, /\bFAKE_CODEX_SCRIPT\b/);

// The cwd policy's one exemption (src/os/cwd.ts): only the composition root names the owned work root,
// and the policy itself checks it is ORCHESTRA_HOME's own work dir. Nowhere else may hand one in.
const ownedWorkRootOnlyInWorking = ban('owned-work-root-only-in-working', except(code, 'src/runtime/working.ts', 'src/os/cwd.ts'), /\bownedWorkRoot\b/);

// The dispatch desk's one outbound call (orchestra app plan §3): builtin-policy.ts lets only
// src/net/magpie.ts import node:http's request (no other module can import a client at all), and here every
// request call in it opens with host LOOPBACK, its port and method POST, and LOOPBACK is the literal
// 127.0.0.1. A call to any other host, or a GET, is flagged.
const MAGPIE_FILE = 'src/net/magpie.ts';
const magpiePost: Rule = {
  id: 'net:magpie-post-loopback-only',
  applies: (f) => f === MAGPIE_FILE,
  find(text) {
    const out: Finding[] = [];
    const decl = "const LOOPBACK = '127.0.0.1';";
    if (!/^const LOOPBACK = '127\.0\.0\.1';$/m.test(text)) out.push({ index: 0, text: `no ${decl}` });
    for (const m of text.matchAll(/\brequest\s*\(/g)) {
      const rest = text.slice(m.index + m[0].length);
      if (!/^\s*\{\s*host:\s*LOOPBACK,\s*port,\s*method:\s*'POST',/.test(rest)) out.push({ index: m.index, text: text.slice(m.index, m.index + 48).split('\n')[0]! });
    }
    // LOOPBACK is bound once, by that declaration.
    for (const m of text.matchAll(/\bLOOPBACK\s*=(?!=)/g)) if (m.index !== text.indexOf(decl) + 'const '.length) out.push({ index: m.index, text: 'LOOPBACK bound again' });
    return out;
  },
};

export const RULES: readonly Rule[] = [
  builtinPolicy,
  builtinOnlyNames,
  processPowerMember,
  processExitLevers,
  regexpCompile,
  globalPowerName,
  globalPowerSymbol,
  // The lock is identity, not heartbeat: daemon.json is written once per start and nothing in the
  // lock or its wiring runs on a timer, ref'd or unref'd (process.getActiveResourcesInfo() would not
  // even show an unref'd one).
  ban('no-timers-in-lock', (f) => f === 'src/runtime/lock.ts' || f === 'src/runtime/working.ts',
    /\bset(?:Interval|Timeout|Immediate)\b/, /['"`](?:node:)?timers(?:\/promises)?['"`]/),
  ban('ban:import-attributes', prod, /\bwith\s*\{\s*type\b/, /\bassert\s*\{\s*type\b/, /\b(?:with|assert)\s*:\s*\{/),
  ban('ban:createRequire', prod, /\bcreateRequire\b/),
  ban('ban:eval(', prod, /\beval\s*\(/),
  ban('ban:new Function', prod, /\bnew\s+Function\b/),
  ban('ban:eval: true', (f) => prod(f) && holdsWorkers(f), /\beval\s*:\s*true\b/, /['"`]eval['"`]\s*:\s*true\b/),
  fsNameBans,
  sqliteNameBans,
  sqlTextLiteral,
  ban('ban:shell: true', prod, /\bshell\s*:\s*(?:true\b|['"`])/),
  ban('ban:cc-msg', prod, /cc-msg/),
  ban('dynamic-import-literal-only', except(prod, 'src/boot.ts', 'src/workers/bootstrap.ts'), /\bimport\s*\(\s*(?!(['"])[^'"\n]*\1\s*\))/),
  ban('mkdtemp-only-in-write-fence', except(prod, 'src/fs/write-fence.ts', 'src/fs/node-io.ts'), /mkdtemp/),
  ban('ban:agents --json', prod, /agents\s+--json/, /['"`]agents['"`]\s*,\s*['"`]--json['"`]/),
  noSpikes,
  relativeCodeOnly,
  vendorTypeOnly,
  ban('ui:innerHTML', ui, /\binnerHTML\b/),
  ban('ui:outerHTML', ui, /\bouterHTML\b/),
  ban('ui:insertAdjacentHTML', ui, /\binsertAdjacentHTML\b/),
  ban('ui:document.write', ui, /\bdocument\s*\.\s*write(?:ln)?\b/),
  ban('ui:fetch-relative-api-only', ui, /\bfetch\s*\(\s*(?!['"`]\/api\/)/),
  // The page's powers, one module each (plan step 5's ui rules): the network in ui/api.js, time in
  // ui/clock.js (T7: the browser's wall clock is never set against the daemon's), storage in
  // ui/prefs.js, navigation in ui/route.js. No other channel out, and no attribute that runs or styles.
  ban('ui:fetch-only-in-api', except(ui, 'ui/api.js'), /\bfetch\b/),
  ban('ui:clock-only-in-clock', except(ui, 'ui/clock.js'),
    /(?<![\w$])Date(?![\w$])/, /(?<![\w$])performance(?![\w$])/, /\bset(?:Timeout|Interval)\b/, /\brequestAnimationFrame\b/, /\bAbortSignal\s*(?:\?\.|\.)\s*timeout\b/),
  ban('ui:storage-only-in-prefs', except(ui, 'ui/prefs.js'), /\b(?:localStorage|sessionStorage|indexedDB)\b/, /\bdocument\s*\.\s*cookie\b/),
  ban('ui:location-write-only-in-route', except(ui, 'ui/route.js'),
    /\blocation\s*\.\s*(?:href|hash|search|pathname|host|hostname|port|protocol)\s*=(?!=)/, /\blocation\s*=(?!=)/,
    /\blocation\s*\.\s*(?:assign|replace|reload)\s*\(/, /\bhistory\s*\.\s*(?:pushState|replaceState)\b/),
  ban('ui:no-other-channel', ui, /\bWebSocket\b/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /\bEventSource\b/, /\bimportScripts\b/, /\bwindow\s*\.\s*open\s*\(/),
  ban('ui:setAttribute-on-style', ui, /\bsetAttribute(?:NS)?\s*\(\s*(?:[^,()]*,\s*)?['"`](?:on[a-z]*|style|href|xlink:href|src)['"`]/i),
  ban('vendor:no-dangerously', vendor, /dangerously/i),
  // r4 §5.3/§7.2: no module but the write fence calls fs write APIs. Only src/fs/node-io.ts imports
  // node:fs, and implements them there; its read io is held apart by node-io-read-io-reads-only.
  ban('fs-write-only-in-write-fence', (f) => /^src\/fs\/[^/]+$/.test(f) && f !== 'src/fs/write-fence.ts' && f !== 'src/fs/node-io.ts',
    /\b(?:write\w*|append\w*|rename\w*|mkdir\w*|rmdir\w*|rm|rmSync|unlink\w*|chmod\w*|chown\w*|fsync\w*|lchown\w*|lchmod\w*)\s*\(/),
  ban('fs-open-only-in-gates', (f) => /^src\/fs\/[^/]+$/.test(f) && !['src/fs/write-fence.ts', 'src/fs/read-gate.ts', 'src/fs/node-io.ts'].includes(f),
    /\b(?:open|openSync|opendir|opendirSync|readdir|readdirSync|readFile|readFileSync|createReadStream|read|readSync)\s*\(/),
  readGateFlag,
  readIoReadsOnly,
  appendExistingFlag,
  writeExistingFlag,
  inProcessStart,
  handleKill,
  fakeCodexOnlyInTests,
  ownedWorkRootOnlyInWorking,
  mintedImport,
  workingImport,
  launcherRootFsUse,
  gateFactoryUse,
  // Any instance leads back to its class through .constructor, and a keep host such as process.stdout
  // (a net.Socket under a pipe or tty) leads to a class that reaches the whole outbound network. The
  // import fence governs imports, not property access, so this is the one static tripwire for that
  // route; nothing in daemon code needs .constructor. The quoted name covers Reflect.get(x, 'constructor').
  // A destructuring pattern reaches it too (`const { constructor: S } = process.stdout`), in an
  // assignment or a parameter; a key computed at run time ('constr' + 'uctor') is a residual.
  ban('ban:.constructor', code, /\.\s*constructor\b/, /['"`]constructor['"`]/, /\{[^{}]*(?<![\w$.])constructor\s*[:,}]/),
  clockOnly,
  clockFactories,
  // Apply, rebuild and replay must not depend on the machine's locale, and daemon code needs none: the
  // page formats times (ui/clock.js), strings compare by code units. The table lists Intl as a global.
  ban('ban:locale', (f) => code(f) && f !== POWER_TABLE, /\bIntl\b/, /\btoLocale[A-Z]\w*/, /\blocaleCompare\b/),
  // Daemon code needs no non-cryptographic randomness: ids are written to the journal when made, and the
  // pairing code and the CSRF token come from node:crypto (zen note 7.6: no Rng port).
  ban('ban:Math.random', code, /\bMath\s*(?:\?\.|\.)\s*random\b/, /\bMath\s*\[\s*(['"`])random\1\s*\]/),
  sharedSelfContained,
  noTestImport,
  hostImports,
  hostNoDaemonPath,
  hostDynamicImport,
  hostTimeout,
  hostPure,
  hostNoBypass,
  hostNoDynamicCode,
  magpiePost,
];

function lineOf(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Hits of every rule that applies to `file` (repo-relative, forward slashes). */
export function scan(file: string, text: string, rules: readonly Rule[] = RULES): Hit[] {
  const key = file.replace(/\\/g, '/');
  const out: Hit[] = [];
  for (const rule of rules) {
    if (!rule.applies(key)) continue;
    for (const f of rule.find(text, key)) out.push({ rule: rule.id, file: key, line: lineOf(text, f.index), text: f.text });
  }
  return out;
}
