// The static-scan rules (plan step 1, invariants 2, 4, 6, 14, 15 of plan §6). Text based and
// strict: comments count too, so production code keeps banned words out of its comments as well.
import * as nodeModule from 'node:module';
import { builtinId, decideBuiltin, onlyNames } from '../../src/runtime/builtin-policy.ts';

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

export const SCANNED_DIRS: readonly string[] = ['src', 'shared', 'ui', 'scripts', 'vendor'];

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

const readGateFlag: Rule = {
  id: 'read-gate-open-flag-r',
  applies: (f) => f === 'src/fs/read-gate.ts',
  find(text) {
    const out: Finding[] = [];
    for (const m of text.matchAll(/\bopenSync\s*\(([^()]*)\)/g)) {
      const args = m[1]!.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      if (args.length >= 2 && !/'r'$/.test(args[1]!)) out.push({ index: m.index, text: m[0] });
    }
    return out;
  },
};

export const RULES: readonly Rule[] = [
  builtinPolicy,
  builtinOnlyNames,
  ban('ban:getBuiltinModule', except(prod, 'src/runtime/import-fence.ts'), /\bgetBuiltinModule\b/),
  ban('ban:process.binding', except(prod, 'src/runtime/import-fence.ts'), /\bprocess\s*\.\s*binding\b/, /\[\s*['"`]binding['"`]\s*\]/),
  ban('ban:_linkedBinding', except(prod, 'src/runtime/import-fence.ts'), /\b_linkedBinding\b/),
  ban('ban:dlopen', except(prod, 'src/runtime/import-fence.ts'), /\bdlopen\b/),
  ban('ban:loadEnvFile', except(prod, 'src/runtime/import-fence.ts'), /\bloadEnvFile\b/),
  ban('ban:process.report', except(prod, 'src/runtime/import-fence.ts'),
    /\bwriteReport\b/, /\bprocess\s*\.\s*report\b/, /\[\s*['"`]report['"`]\s*\]/),
  ban('ban:import-attributes', prod, /\bwith\s*\{\s*type\b/, /\bassert\s*\{\s*type\b/, /\b(?:with|assert)\s*:\s*\{/),
  ban('ban:createRequire', prod, /\bcreateRequire\b/),
  ban('ban:eval(', prod, /\beval\s*\(/),
  ban('ban:new Function', prod, /\bnew\s+Function\b/),
  ban('ban:eval: true', prod, /\beval\s*:\s*true\b/, /['"`]eval['"`]\s*:\s*true\b/),
  ban('ban:copyFile', prod, /copyFile/),
  ban('ban:cp(', prod, /\bcp(?:Sync)?\s*\(/),
  ban('ban:createWriteStream', prod, /createWriteStream/),
  ban('ban:truncate', prod, /truncate/),
  ban('ban:utimes', prod, /utimes/),
  ban('ban:symlink', prod, /symlink/i),
  ban('ban:link(', prod, /\blink(?:Sync)?\s*\(/),
  ban('ban:shell: true', prod, /\bshell\s*:\s*(?:true\b|['"`])/),
  ban('ban:cc-msg', prod, /cc-msg/),
  ban('dynamic-import-literal-only', except(prod, 'src/boot.ts', 'src/workers/bootstrap.ts'), /\bimport\s*\(\s*(?!(['"])[^'"\n]*\1\s*\))/),
  ban('mkdtemp-only-in-write-fence', except(prod, 'src/fs/write-fence.ts'), /mkdtemp/),
  // Bare identifier, so an alias (`const f = fetch`) counts too. boot.ts takes the one capability
  // before the fence locks the global; import-fence.ts names it to lock it.
  ban('fetch-only-in-dsh-connect', except(code, 'src/net/dsh-connect.ts', 'src/boot.ts', 'src/runtime/import-fence.ts'), /\bfetch\b/),
  ban('ban:WebSocket/EventSource', except(code, 'src/runtime/import-fence.ts'), /\bWebSocket\b/, /\bEventSource\b/),
  ban('ban:net.connect', prod, /\bnet\s*\.\s*connect\b/),
  ban('ban:createConnection', prod, /\bcreateConnection\b/),
  ban('ban:http.request', prod, /\bhttps?\s*\.\s*request\b/),
  ban('ban:http.get', prod, /\bhttps?\s*\.\s*get\b/),
  ban('ban:node:https', prod, /['"`](?:node:)?https['"`]/),
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
  // r4 §5.3/§7.2: no module but the write fence calls fs write APIs. Only src/fs/* may import node:fs.
  ban('fs-write-only-in-write-fence', (f) => /^src\/fs\/[^/]+$/.test(f) && f !== 'src/fs/write-fence.ts',
    /\b(?:write\w*|append\w*|rename\w*|mkdir\w*|rmdir\w*|rm|rmSync|unlink\w*|chmod\w*|chown\w*|fsync\w*|lchown\w*|lchmod\w*)\s*\(/),
  ban('fs-open-only-in-gates', (f) => /^src\/fs\/[^/]+$/.test(f) && f !== 'src/fs/write-fence.ts' && f !== 'src/fs/read-gate.ts',
    /\b(?:open|openSync|opendir|opendirSync|readdir|readdirSync|readFile|readFileSync|createReadStream|read|readSync)\s*\(/),
  readGateFlag,
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
