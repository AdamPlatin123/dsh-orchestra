import * as path from 'node:path';
import { ownField, ownFields } from './own.ts';
import { frozen } from '../../shared/frozen.js';

const win = path.win32;

export type EnvInput = {
  /** The user's home directory. Injected: this module never calls os.homedir(). */
  home: string;
  /** Environment variables. Injected: this module never reads process.env. */
  env: Readonly<Record<string, string | undefined>>;
  /** Launcher layouts holding extra Claude roots, `~` = home. Default: ~/.rec/claude/accounts/{*}/config. */
  launcherGlobs?: readonly string[];
  /** Extra harness roots the user adds in Tuning (for example the DS-Bot desktop data dir). */
  extraHarnessRoots?: readonly string[];
  /** Extra Claude roots the user adds in Tuning; they are read like any other Claude root. */
  extraClaudeRoots?: readonly string[];
};

/** What a harness root holds; the read gate picks its policy by kind. */
export type HarnessRootKind = 'claude' | 'claude-prefix' | 'dsh' | 'codex' | 'dsh-tui' | 'ds-bot' | 'extra';

export type TypedRoot = { kind: HarnessRootKind; path: string };

export type ResolvedEnv = {
  orchestraHome: string;
  /** Claude root candidates in discovery order; glob entries are patterns, not resolved directories. */
  claudeRootCandidates: string[];
  /** The deepest literal directory of each launcher glob: the segments before the one holding its first `*`. */
  launcherGlobPrefixes: string[];
  dshHome: string;
  codexHome: string;
  dshTuiHome: string;
  dsBotHome: string;
  /** Every directory the write fence must deny and the data-dir check must keep apart from orchestraHome. */
  knownHarnessRoots: string[];
  /** knownHarnessRoots with their kind, same order; the first kind wins when two entries share a path. */
  typedHarnessRoots: TypedRoot[];
};

export const DEFAULT_LAUNCHER_GLOBS: readonly string[] = frozen(['~/.rec/claude/accounts/*/config']);

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return win.join(home, p.slice(2));
  return p;
}

function norm(p: string): string {
  const r = win.normalize(p);
  return r.length > 3 ? r.replace(/[\\/]+$/, '') : r;
}

/**
 * The deepest literal directory of a glob: everything before the separator that precedes its first
 * `*`. Cutting at the `*` itself would turn `...\claude\acc*\x` into the prefix `...\claude\acc`,
 * which misses `...\claude\acc-new`.
 */
function globPrefix(pattern: string): string {
  const star = pattern.indexOf('*');
  if (star < 0) return norm(pattern);
  const sep = pattern.lastIndexOf('\\', star);
  const dir = sep < 0 ? '' : pattern.slice(0, sep);
  return /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : norm(dir);
}

function dedupe(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

const INPUT_KEYS = ['home', 'env', 'launcherGlobs', 'extraHarnessRoots', 'extraClaudeRoots'] as const;

/**
 * Own fields only, of the input and of the environment: a variable or list the caller did not set
 * reads undefined, never a value some module put on Object.prototype (process.env falls through to it).
 */
export function resolveEnv(given: EnvInput): ResolvedEnv {
  const input = ownFields(given, INPUT_KEYS);
  const home = norm(input.home as string);
  const env = (name: string) => ownField(input.env as Record<string, string | undefined>, name);
  const set = (v: string | undefined) => (typeof v === 'string' && v.trim() !== '' ? norm(expandHome(v, home)) : undefined);

  const orchestraHome = set(env('ORCHESTRA_HOME')) ?? win.join(home, '.orchestra');

  const launcherGlobs = (input.launcherGlobs ?? DEFAULT_LAUNCHER_GLOBS).map((g) => norm(expandHome(g, home)));
  const xdg = set(env('XDG_CONFIG_HOME'));
  const extraClaude = (input.extraClaudeRoots ?? []).map((r) => norm(expandHome(r, home)));
  const claudeRootCandidates = dedupe([
    ...(set(env('CLAUDE_CONFIG_DIR')) ? [set(env('CLAUDE_CONFIG_DIR')) as string] : []),
    win.join(home, '.claude'),
    xdg ? win.join(xdg, 'claude') : win.join(home, '.config', 'claude'),
    ...launcherGlobs,
    ...extraClaude,
  ]);
  const launcherGlobPrefixes = dedupe(launcherGlobs.map(globPrefix));

  const defaultDsh = win.join(home, '.dsh');
  const defaultCodex = win.join(home, '.codex');
  const dshHome = set(env('DSH_HOME')) ?? defaultDsh;
  const codexHome = set(env('CODEX_HOME')) ?? defaultCodex;
  const dshTuiHome = win.join(home, '.dsh-tui');
  const dsBotHome = win.join(home, '.ds-bot');

  // Deny more rather than less: the default dirs stay listed even when an env var points elsewhere.
  const typed: TypedRoot[] = [
    ...claudeRootCandidates.filter((c) => !c.includes('*')).map((p) => ({ kind: 'claude' as const, path: p })),
    ...launcherGlobPrefixes.map((p) => ({ kind: 'claude-prefix' as const, path: p })),
    { kind: 'dsh', path: dshHome }, { kind: 'dsh', path: defaultDsh },
    { kind: 'codex', path: codexHome }, { kind: 'codex', path: defaultCodex },
    { kind: 'dsh-tui', path: dshTuiHome },
    { kind: 'ds-bot', path: dsBotHome },
    ...(input.extraHarnessRoots ?? []).map((r) => ({ kind: 'extra' as const, path: norm(expandHome(r, home)) })),
  ];
  const seen = new Set<string>();
  const typedHarnessRoots = typed.filter((r) => {
    const key = r.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const knownHarnessRoots = typedHarnessRoots.map((r) => r.path);

  return { orchestraHome, claudeRootCandidates, launcherGlobPrefixes, dshHome, codexHome, dshTuiHome, dsBotHome, knownHarnessRoots, typedHarnessRoots };
}
