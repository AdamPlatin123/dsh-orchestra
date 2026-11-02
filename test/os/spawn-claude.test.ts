import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { SpawnDecision, SpawnGateConfig } from '../../src/os/spawn.ts';
import { realpath } from '../../src/fs/node-io.ts';
import { CLAUDE_GATEWAY_TOKEN, CLAUDE_HOST_FIXED_ENV, ENV_WHITELIST, SpawnGate, resolveSystemRoot } from '../../src/os/spawn.ts';
import { makeRealClock } from '../../src/runtime/clock.ts';
import { CLAUDE_HOST_PINS } from '../../src/owned/claude-pins.ts';
import { CLAUDE_HOST_REL, checkPins, resolveHostSite } from '../../src/owned/claude-site.ts';
import { fakeSpawn } from '../helpers/fake-spawn.ts';
import { CLAUDE_EXTRA, HOST_ENTRY } from '../helpers/claude-host.ts';
import { withTmp } from '../helpers/tmp.ts';

// The claude-host spawn rule (orchestra app step 4; alpha 0.2 design §2.1): node.exe with exactly
// [host.mjs], in a work dir the cwd table allows; the env is the rule's whitelist, the composition root's
// checked extras (the private config dir, the loopback gateway, the placeholder token, the small fast
// model, NO_PROXY) and the gate's own fixed variables; the pins are checked again before every start.
// A spy backend: nothing runs.

const CLOCK = makeRealClock();
const why = (d: SpawnDecision) => (d.allow ? `allow:${d.rule}` : d.reason);

function rig(t: TestContext) {
  const dir = fs.realpathSync.native(withTmp(t));
  const home = path.join(dir, 'orchestra');
  const work = path.join(home, 'work');
  fs.mkdirSync(path.join(work, 'a1b2'), { recursive: true });
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok);
  const verdict = { why: null as string | null };
  const base = (): SpawnGateConfig => ({
    systemRoot: sys, rules: ['claude-host'], record: () => {}, backend: fakeSpawn(() => ({ hang: true })).backend, realpath, clock: CLOCK, env: process.env,
    envExtra: { 'claude-host': { ...CLAUDE_EXTRA, CLAUDE_CONFIG_DIR: path.join(home, 'claude-home') } },
    cwd: { allowedRoots: [work], protectedDirs: [home], userHome: os.homedir(), ownedWorkRoot: work },
    claudeHost: { node: process.execPath, entry: HOST_ENTRY, verify: () => verdict.why },
  });
  return { dir, home, work, verdict, gate: (over: Partial<SpawnGateConfig> = {}) => new SpawnGate({ ...base(), ...over }) };
}

test('claude-host: exactly node.exe with [host.mjs] in a work dir; other argv, cwd or exe are refused with a reason', (t) => {
  const r = rig(t);
  const g = r.gate();
  const cwd = path.join(r.work, 'a1b2');
  assert.deepEqual(g.decide({ exe: process.execPath, argv: [HOST_ENTRY], cwd }), { allow: true, rule: 'claude-host', exe: process.execPath, argv: [HOST_ENTRY], cwd });
  assert.equal(why(g.decide({ exe: process.execPath, argv: [HOST_ENTRY, '--inspect'], cwd })), 'argv-mismatch');
  assert.equal(why(g.decide({ exe: process.execPath, argv: ['-e', 'process.exit()'], cwd })), 'argv-mismatch');
  assert.equal(why(g.decide({ exe: process.execPath, argv: [], cwd })), 'argv-mismatch');
  assert.equal(why(g.decide({ exe: process.execPath, argv: [HOST_ENTRY] })), 'cwd-not-allowed');
  assert.equal(why(g.decide({ exe: process.execPath, argv: [HOST_ENTRY], cwd: r.home })), 'cwd-denied');
  assert.equal(why(g.decide({ exe: path.join(r.dir, 'node.exe'), argv: [HOST_ENTRY], cwd })), 'unknown-exe');
  assert.equal(why(r.gate({ rules: ['whoami'] }).decide({ exe: process.execPath, argv: [HOST_ENTRY], cwd })), 'rule-not-enabled');
  // The pins again before every start: a mismatch refuses without a child.
  r.verdict.why = 'hosts/claude/host.mjs: changed';
  assert.deepEqual(g.decide({ exe: process.execPath, argv: [HOST_ENTRY], cwd }), { allow: false, reason: 'host-tampered', exe: process.execPath, rule: 'claude-host', detail: 'hosts/claude/host.mjs: changed' });
  assert.throws(() => g.start({ exe: process.execPath, argv: [HOST_ENTRY], cwd }), /host-tampered/);
});

test('claude-host: the child gets the whitelist, the checked extras and the fixed env, and nothing else (no key, no NODE_OPTIONS)', (t) => {
  const r = rig(t);
  const spy = fakeSpawn(() => ({ hang: true }));
  const env = { SystemRoot: process.env.SystemRoot, windir: process.env.windir, USERPROFILE: 'C:\\Users\\u', PATH: 'C:\\Windows', NODE_OPTIONS: '--require x', ANTHROPIC_API_KEY: 'sk-ant-real', HTTPS_PROXY: 'http://p:8080' };
  const g = r.gate({ backend: spy.backend, env });
  g.start({ exe: process.execPath, argv: [HOST_ENTRY], cwd: path.join(r.work, 'a1b2') }).kill();
  const got = { ...spy.calls[0]!.opts.env };
  assert.deepEqual(Object.keys(got).sort(), [
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CODE_DISABLE_WORKFLOWS', 'CLAUDE_CONFIG_DIR',
    'DISABLE_AUTOUPDATER', 'NO_PROXY', 'PATH', 'SystemRoot', 'USERPROFILE', 'windir',
  ].sort());
  assert.equal(got.CLAUDE_CONFIG_DIR, path.join(r.home, 'claude-home'));
  assert.equal(got.ANTHROPIC_AUTH_TOKEN, CLAUDE_GATEWAY_TOKEN);
  for (const [k, v] of Object.entries(CLAUDE_HOST_FIXED_ENV)) assert.equal(got[k], v, k);
  assert.ok(ENV_WHITELIST['claude-host'].every((n) => !/proxy|key|token|node_/i.test(n)));
});

test('claude-host: refused at construction without its site or its extras, with a non-loopback gateway, a real key or another token', (t) => {
  const r = rig(t);
  const extra = (over: Record<string, string>, drop: string[] = []) => {
    const e: Record<string, string> = { ...CLAUDE_EXTRA, CLAUDE_CONFIG_DIR: path.join(r.home, 'claude-home'), ...over };
    for (const d of drop) delete e[d];
    return { envExtra: { 'claude-host': e } };
  };
  assert.throws(() => r.gate({ claudeHost: undefined as never }), /claude-host enabled without its site/);
  assert.throws(() => r.gate({ claudeHost: { node: path.join(r.dir, 'x.exe'), entry: HOST_ENTRY, verify: () => null } }), /runs under node\.exe/);
  assert.throws(() => r.gate({ claudeHost: { node: process.execPath, entry: path.join(r.dir, 'evil.mjs'), verify: () => null } }), /entry is host\.mjs/);
  assert.throws(() => r.gate(extra({}, ['CLAUDE_CONFIG_DIR'])), /needs envExtra\.claude-host\.CLAUDE_CONFIG_DIR/);
  assert.throws(() => r.gate(extra({ CLAUDE_CONFIG_DIR: 'relative' })), /CLAUDE_CONFIG_DIR, an absolute path/);
  assert.throws(() => r.gate(extra({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' })), /gateway must be http:\/\/127\.0\.0\.1/);
  assert.throws(() => r.gate(extra({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425/v1' })), /gateway must be/);
  assert.throws(() => r.gate(extra({ ANTHROPIC_AUTH_TOKEN: 'sk-ant-xyz' })), /fixed gateway placeholder/);
  assert.throws(() => r.gate(extra({ ANTHROPIC_SMALL_FAST_MODEL: 'codex/gpt-6.1-sol' })), /SMALL_FAST_MODEL/);
  assert.throws(() => r.gate(extra({ ANTHROPIC_API_KEY: 'x' })), /never handed to the Claude host/);
  assert.throws(() => r.gate(extra({ DISABLE_AUTOUPDATER: '0' })), /set by the gate itself/);
});

test('pins: host.mjs and host-core.mjs are pinned as they are on disk (run scripts/pin-claude-host.ts after editing the host); the SDK entry too where it is installed', () => {
  const repo = path.dirname(path.dirname(import.meta.dirname));
  for (const [rel, want] of Object.entries(CLAUDE_HOST_PINS)) {
    const file = path.join(repo, ...rel.split('/'));
    if (rel.includes('node_modules') && !fs.existsSync(file)) continue;
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), want, rel);
  }
  assert.equal(checkPins((f) => fs.readFileSync(f), repo, { 'hosts/claude/host.mjs': CLAUDE_HOST_PINS['hosts/claude/host.mjs']! }), null);
  assert.equal(checkPins(() => Buffer.from('changed'), repo), 'hosts/claude/host.mjs: changed');
  assert.equal(checkPins(() => {
    throw Object.assign(new Error('denied'), { decision: { reason: 'hardlink' } });
  }, repo), 'hosts/claude/host.mjs: unreadable (hardlink)');
});

test('resolveHostSite: node.exe of the repository (or of the main checkout), host.mjs, the SDK\'s claude.exe; each missing or behind a link is a reason', (t) => {
  const dir = fs.realpathSync.native(withTmp(t));
  const repo = path.join(dir, 'repo');
  const main = path.join(dir, 'main');
  const put = (root: string, rel: string) => {
    const f = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
    return f;
  };
  assert.equal((resolveHostSite(realpath, repo, main) as { reason: string }).reason, 'node-missing');
  const node = put(main, CLAUDE_HOST_REL.node);
  assert.equal((resolveHostSite(realpath, repo, main) as { reason: string }).reason, 'host-missing');
  const entry = put(repo, CLAUDE_HOST_REL.entry);
  assert.equal((resolveHostSite(realpath, repo, main) as { reason: string }).reason, 'claude-exe-missing');
  const exe = put(repo, CLAUDE_HOST_REL.claudeExe);
  assert.deepEqual(resolveHostSite(realpath, repo, main), { ok: true, node, entry, claudeExe: exe });
  const own = put(repo, CLAUDE_HOST_REL.node);
  assert.equal((resolveHostSite(realpath, repo, main) as { node: string }).node, own, 'the copy\'s own node.exe first');
  const moved = (p: string) => (p === own ? path.join(dir, 'elsewhere', 'node.exe') : realpath(p));
  assert.equal((resolveHostSite(moved, repo, main) as { reason: string }).reason, 'reparsed');
});
