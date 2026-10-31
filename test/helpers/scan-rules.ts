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
];

// test/ is scanned for in-process-start-only-in-helper alone: every other rule's scope excludes it.
export const SCANNED_DIRS: readonly string[] = ['src', 'shared', 'ui', 'scripts', 'vendor', 'test'];

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
// and the ones it is handed to. An alias of process (`const p = process; p.kill(pid)`) passes the
// text scan and meets the runtime stub, which every spelling reaches.
const POWER_TABLE = 'src/runtime/process-powers.ts';
const isSymbolKey = (key: string) => key.startsWith('Symbol(');
const PROCESS_NAMES = PROCESS_POWERS.filter((e) => e.class !== 'keep' && !isSymbolKey(e.key)).map((e) => escapeRe(e.key)).join('|');
const processPowerMember = ban('process-power-member', except(prod, POWER_TABLE),
  new RegExp(`\\bprocess\\s*(?:\\?\\.|\\.)\\s*(?:${PROCESS_NAMES})(?![\\w$])`),
  new RegExp(`\\bprocess\\s*(?:\\?\\.\\s*)?\\[\\s*(['"\`])(?:${PROCESS_NAMES})\\1\\s*\\]`),
  new RegExp(`\\bReflect\\s*\\.\\s*get\\s*\\(\\s*(?:globalThis\\s*\\.\\s*)?process\\s*,\\s*(['"\`])(?:${PROCESS_NAMES})\\1`),
  new RegExp(`\\{[^{}]*(?<![\\w$])(?:${PROCESS_NAMES})(?![\\w$])[^{}]*\\}\\s*=\\s*(?:globalThis\\s*\\.\\s*)?process\\b`));

const GLOBAL_NAMED = GLOBAL_POWERS.filter((e) => e.class !== 'keep' && !isSymbolKey(e.key))
  .map((e) => ({ e, re: new RegExp(`(?<![\\w$])${escapeRe(e.key)}(?![\\w$])`, 'g') }));
const globalPowerName: Rule = {
  id: 'global-power-name',
  applies: (f) => code(f) && f !== POWER_TABLE,
  find: (text, file) => GLOBAL_NAMED
    .filter(({ e }) => !(e.class === 'mint' && (e.mintedBy === file || e.heldBy.includes(file))))
    .flatMap(({ re }) => [...text.matchAll(re)].map((m) => ({ index: m.index, text: m[0] }))),
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
// the LauncherFsPorts type and launcherRootFs.
const FACTORY = 'makeReadGate|makeWriteFence|makeSpawnGate';
const FACTORY_ROOTS: readonly string[] = ['src/boot.ts', 'src/main.ts', 'src/runtime/working.ts', 'src/fs/node-io.ts', 'src/os/node-proc.ts'];
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
    ];
    return res.flatMap((re) => [...text.matchAll(re)]).filter((m) => !allowed(m.index)).map((m) => ({ index: m.index, text: m[0] }));
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
const appendExistingFlag: Rule = {
  id: 'node-io-append-existing-flag',
  applies: (f) => f === 'src/fs/node-io.ts',
  find(text) {
    const m = /'append-existing'\s*:\s*([^,\n}]+)/.exec(text);
    if (m === null) return [{ index: 0, text: "no 'append-existing' flag in node-io.ts" }];
    const expr = m[1]!.trim();
    if (/^fs\.constants\.O_WRONLY\s*\|\s*fs\.constants\.O_APPEND$/.test(expr)) return [];
    return [{ index: m.index, text: `append-existing must be fs.constants.O_WRONLY | fs.constants.O_APPEND (no O_CREAT), got ${expr}` }];
  },
};

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

const readGateFlag: Rule = {
  id: 'read-gate-open-flag-r',
  applies: (f) => f === 'src/fs/read-gate.ts',
  find: (text) => openNotReadOnly(text),
};

export const RULES: readonly Rule[] = [
  builtinPolicy,
  builtinOnlyNames,
  processPowerMember,
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
  inProcessStart,
  handleKill,
  mintedImport,
  workingImport,
  launcherRootFsUse,
  gateFactoryUse,
  // Any instance leads back to its class through .constructor, and a keep host such as process.stdout
  // (a net.Socket under a pipe or tty) leads to a class that reaches the whole outbound network. The
  // import fence governs imports, not property access, so this is the one static tripwire for that
  // route; nothing in daemon code needs .constructor. The quoted name covers Reflect.get(x, 'constructor').
  ban('ban:.constructor', code, /\.\s*constructor\b/, /['"`]constructor['"`]/),
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
