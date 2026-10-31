import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { resolveEnv } from '../../src/runtime/env.ts';
import { isWithin } from '../../src/fs/paths.ts';

const HOME = 'X:\\fake\\home';

test('defaults come from the injected home only', () => {
  const r = resolveEnv({ home: HOME, env: {} });
  assert.equal(r.orchestraHome, 'X:\\fake\\home\\.orchestra');
  assert.deepEqual(r.claudeRootCandidates, [
    'X:\\fake\\home\\.claude',
    'X:\\fake\\home\\.config\\claude',
    'X:\\fake\\home\\.rec\\claude\\accounts\\*\\config',
  ]);
  assert.deepEqual(r.launcherGlobPrefixes, ['X:\\fake\\home\\.rec\\claude\\accounts']);
  assert.equal(r.dshHome, 'X:\\fake\\home\\.dsh');
  assert.equal(r.codexHome, 'X:\\fake\\home\\.codex');
  const real = os.homedir().toLowerCase();
  for (const p of [r.orchestraHome, ...r.claudeRootCandidates, ...r.knownHarnessRoots]) {
    assert.ok(!p.toLowerCase().startsWith(real), `touched the real home: ${p}`);
  }
});

test('candidate order: CLAUDE_CONFIG_DIR, ~/.claude, XDG, launcher globs; case-insensitive dedupe', () => {
  const r = resolveEnv({
    home: HOME,
    env: { CLAUDE_CONFIG_DIR: 'X:\\FAKE\\HOME\\.claude\\', XDG_CONFIG_HOME: 'Y:\\xdg' },
  });
  assert.deepEqual(r.claudeRootCandidates, [
    'X:\\FAKE\\HOME\\.claude',
    'Y:\\xdg\\claude',
    'X:\\fake\\home\\.rec\\claude\\accounts\\*\\config',
  ]);
});

test('knownHarnessRoots covers every harness, glob prefixes and extra roots, without glob patterns', () => {
  const r = resolveEnv({
    home: HOME,
    env: { CLAUDE_CONFIG_DIR: 'X:\\fake\\home\\.rec\\claude\\accounts\\1\\config', DSH_HOME: 'Z:\\dsh', CODEX_HOME: '~/alt-codex' },
    extraHarnessRoots: ['G:\\_dsbotplayground\\', 'g:\\_DSBOTPLAYGROUND'],
  });
  const roots = r.knownHarnessRoots.map((p) => p.toLowerCase());
  for (const want of [
    'x:\\fake\\home\\.rec\\claude\\accounts\\1\\config',
    'x:\\fake\\home\\.claude',
    'x:\\fake\\home\\.config\\claude',
    'x:\\fake\\home\\.rec\\claude\\accounts',
    'z:\\dsh',
    'x:\\fake\\home\\.dsh',
    'x:\\fake\\home\\alt-codex',
    'x:\\fake\\home\\.codex',
    'x:\\fake\\home\\.dsh-tui',
    'x:\\fake\\home\\.ds-bot',
    'g:\\_dsbotplayground',
  ]) {
    assert.ok(roots.includes(want), `missing ${want}`);
  }
  assert.ok(roots.every((p) => !p.includes('*')), 'a glob pattern leaked into the roots');
  assert.equal(roots.filter((p) => p === 'g:\\_dsbotplayground').length, 1, 'extra roots are deduped');
});

test('typedHarnessRoots: every known root with its kind, same order as knownHarnessRoots; extra Claude roots are Claude roots', () => {
  const r = resolveEnv({ home: HOME, env: { DSH_HOME: 'Z:\\dsh' }, extraClaudeRoots: ['Y:\\more-claude\\'], extraHarnessRoots: ['G:\\bot'] });
  assert.deepEqual(r.typedHarnessRoots.map((x) => x.path), r.knownHarnessRoots);
  assert.equal(r.claudeRootCandidates.at(-1), 'Y:\\more-claude');
  const kinds = Object.fromEntries(r.typedHarnessRoots.map((x) => [x.path.toLowerCase(), x.kind]));
  assert.deepEqual(kinds, {
    'x:\\fake\\home\\.claude': 'claude',
    'x:\\fake\\home\\.config\\claude': 'claude',
    'y:\\more-claude': 'claude',
    'x:\\fake\\home\\.rec\\claude\\accounts': 'claude-prefix',
    'z:\\dsh': 'dsh',
    'x:\\fake\\home\\.dsh': 'dsh',
    'x:\\fake\\home\\.codex': 'codex',
    'x:\\fake\\home\\.dsh-tui': 'dsh-tui',
    'x:\\fake\\home\\.ds-bot': 'ds-bot',
    'g:\\bot': 'extra',
  });
});

test('ORCHESTRA_HOME overrides the data dir; empty values are ignored', () => {
  assert.equal(resolveEnv({ home: HOME, env: { ORCHESTRA_HOME: 'W:\\orch\\' } }).orchestraHome, 'W:\\orch');
  assert.equal(resolveEnv({ home: HOME, env: { ORCHESTRA_HOME: '  ' } }).orchestraHome, 'X:\\fake\\home\\.orchestra');
});

test('a launcher glob prefix is the deepest literal directory, cut at a segment boundary', () => {
  const custom = resolveEnv({ home: HOME, env: {}, launcherGlobs: ['~/.rec/claude/acc*/x', 'Q:/*/config', 'W:/tools/launch/accounts'] });
  assert.deepEqual(custom.launcherGlobPrefixes, ['X:\\fake\\home\\.rec\\claude', 'Q:\\', 'W:\\tools\\launch\\accounts']);
  // The prefix denies a sibling account directory the glob would also match.
  assert.ok(isWithin('X:\\fake\\home\\.rec\\claude\\acc-new', custom.launcherGlobPrefixes[0]!));
  assert.ok(!isWithin('X:\\fake\\home\\.rec\\claude\\acc-new', 'X:\\fake\\home\\.rec\\claude\\acc'));
  // The default glob keeps its prefix.
  assert.deepEqual(resolveEnv({ home: HOME, env: {} }).launcherGlobPrefixes, ['X:\\fake\\home\\.rec\\claude\\accounts']);
  assert.deepEqual(resolveEnv({ home: HOME, env: {}, launcherGlobs: ['~/.rec/claude/accounts/a*b/config'] }).launcherGlobPrefixes, ['X:\\fake\\home\\.rec\\claude\\accounts']);
});
