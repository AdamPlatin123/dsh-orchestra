import * as path from 'node:path';

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
};

export type ResolvedEnv = {
  orchestraHome: string;
  /** Claude root candidates in discovery order; glob entries are patterns, not resolved directories. */
  claudeRootCandidates: string[];
  /** The literal prefix of each launcher glob, before its first `*`. */
  launcherGlobPrefixes: string[];
  dshHome: string;
  codexHome: string;
  dshTuiHome: string;
  dsBotHome: string;
  /** Every directory the write fence must deny and the data-dir check must keep apart from orchestraHome. */
  knownHarnessRoots: string[];
};

export const DEFAULT_LAUNCHER_GLOBS: readonly string[] = ['~/.rec/claude/accounts/*/config'];

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return win.join(home, p.slice(2));
  return p;
}

function norm(p: string): string {
  const r = win.normalize(p);
  return r.length > 3 ? r.replace(/[\\/]+$/, '') : r;
}

function globPrefix(pattern: string): string {
  const star = pattern.indexOf('*');
  const literal = star < 0 ? pattern : pattern.slice(0, star);
  return norm(literal);
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

export function resolveEnv(input: EnvInput): ResolvedEnv {
  const home = norm(input.home);
  const env = input.env;
  const set = (v: string | undefined) => (v !== undefined && v.trim() !== '' ? norm(expandHome(v, home)) : undefined);

  const orchestraHome = set(env.ORCHESTRA_HOME) ?? win.join(home, '.orchestra');

  const launcherGlobs = (input.launcherGlobs ?? DEFAULT_LAUNCHER_GLOBS).map((g) => norm(expandHome(g, home)));
  const xdg = set(env.XDG_CONFIG_HOME);
  const claudeRootCandidates = dedupe([
    ...(set(env.CLAUDE_CONFIG_DIR) ? [set(env.CLAUDE_CONFIG_DIR) as string] : []),
    win.join(home, '.claude'),
    xdg ? win.join(xdg, 'claude') : win.join(home, '.config', 'claude'),
    ...launcherGlobs,
  ]);
  const launcherGlobPrefixes = dedupe(launcherGlobs.map(globPrefix));

  const defaultDsh = win.join(home, '.dsh');
  const defaultCodex = win.join(home, '.codex');
  const dshHome = set(env.DSH_HOME) ?? defaultDsh;
  const codexHome = set(env.CODEX_HOME) ?? defaultCodex;
  const dshTuiHome = win.join(home, '.dsh-tui');
  const dsBotHome = win.join(home, '.ds-bot');

  // Deny more rather than less: the default dirs stay listed even when an env var points elsewhere.
  const knownHarnessRoots = dedupe([
    ...claudeRootCandidates.filter((c) => !c.includes('*')),
    ...launcherGlobPrefixes,
    dshHome, defaultDsh,
    codexHome, defaultCodex,
    dshTuiHome,
    dsBotHome,
    ...(input.extraHarnessRoots ?? []).map((r) => norm(expandHome(r, home))),
  ]);

  return { orchestraHome, claudeRootCandidates, launcherGlobPrefixes, dshHome, codexHome, dshTuiHome, dsBotHome, knownHarnessRoots };
}
