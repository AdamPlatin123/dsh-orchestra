import * as path from 'node:path';
import { isWithin } from '../fs/paths.ts';
import { frozen } from '../../shared/frozen.js';

const win = path.win32;

// r4 §7.4 自有 Claude 乐章的配置隔离 2: the paths inside a session's own cwd that other programs run or read
// as configuration (Claude Code, Codex, DSH, git, VS Code, npm, husky): `.claude/**`, `.mcp.json`,
// `.codex/**`, `.dsh/**`, `cordis.patch.yml`, `.git/hooks/**`, `.vscode/tasks.json`, `package.json`
// (its scripts: the whole file here, a diff is not parsed), `.husky/**`. A change there runs later outside
// the session's Job, where the brake does not reach (D4), so an approval that changes one is high risk
// (risk protected: the card asks for more than one click), never an ordinary write. Matched at any depth
// below the cwd (a folder below it may be where Claude Code or git is started next), case-insensitively,
// on the path as named and on its realpath (an 8.3 short name such as GIT~1 resolves to .git there).

/** The protected names, as r4 §7.4 lists them (for the card and the tests). */
export const CWD_GUARDED: readonly string[] = frozen(['.claude/**', '.mcp.json', '.codex/**', '.dsh/**', 'cordis.patch.yml', '.git/hooks/**', '.vscode/tasks.json', 'package.json', '.husky/**']);

const DIRS: Readonly<Record<string, string>> = frozen({ '.claude': '.claude/**', '.codex': '.codex/**', '.dsh': '.dsh/**', '.husky': '.husky/**' });
const FILES: Readonly<Record<string, string>> = frozen({ '.mcp.json': '.mcp.json', 'cordis.patch.yml': 'cordis.patch.yml', 'package.json': 'package.json' });

/** Which of r4 §7.4's protected paths `p` (absolute, normalized) is inside `cwd`, or null (outside cwd: not this table's to say). */
export function guardedIn(p: string, cwd: string): string | null {
  if (!isWithin(p, cwd)) return null;
  const rel = win.relative(cwd, p);
  if (rel === '') return null;
  const segs = rel.split('\\').filter((x) => x !== '').map((x) => x.toLowerCase());
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (Object.hasOwn(DIRS, s)) return DIRS[s]!;
    if (s === '.git' && segs[i + 1] === 'hooks') return '.git/hooks/**';
    if (s === '.vscode' && segs[i + 1] === 'tasks.json' && i + 2 === segs.length) return '.vscode/tasks.json';
  }
  const last = segs[segs.length - 1]!;
  return Object.hasOwn(FILES, last) ? FILES[last]! : null;
}

/** guardedIn on a path as named (against cwd) and on its realpath (against cwd's realpath): the first that says one. */
export function guardedPlace(at: { p: string; real: string }, cwd: string, realCwd: string): string | null {
  return guardedIn(at.p, cwd) ?? guardedIn(at.real, realCwd);
}
