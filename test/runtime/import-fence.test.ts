import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { decideBuiltin, moduleKeyFromUrl, rowsFor } from '../../src/runtime/builtin-policy.ts';
import { EXIT } from '../../src/runtime/exit.ts';
import { ImportFenceError, decideImport, installImportFence } from '../../src/runtime/import-fence.ts';
import { BASE_LOCKS } from '../../src/runtime/process-powers.ts';
import { BOOTSTRAP_URL, WorkerStartError, checkWorkerTarget, startWorker } from '../../src/runtime/workers.ts';
import { withTmp } from '../helpers/tmp.ts';

const src = (rel: string) => new URL(`../../src/${rel}`, import.meta.url).href;
const REPO = new URL('../../', import.meta.url);
const DISPATCHER_SLOTS = [Symbol.for('undici.globalDispatcher.1'), Symbol.for('undici.globalDispatcher.2')];
const DEBUG_POWERS = ['_debugProcess', '_debugEnd', '_getActiveHandles', '_getActiveRequests'];
const ORIGIN_SLOT = Symbol.for('undici.globalOrigin.1');
/** Every non-optional slot of the process-powers table, locked or pinned. */
const FULL_STATUS = { locks: BASE_LOCKS };

/** Polls `cond` every 20 ms; true once it holds, false after `ms`. */
async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) return false;
    await sleep(20);
  }
  return true;
}

type Run = { status: number | null; stdout: string; stderr: string; dir: string };

const BOOT_RUNNER = `import { boot } from ${JSON.stringify(src('boot.ts'))};\nawait boot(new URL('./entry.ts', import.meta.url));\n`;
const BARE_RUNNER = `const m = await import(new URL('./entry.ts', import.meta.url).href);\nawait m.start();\n`;

/**
 * Writes `files` into a fresh temp dir (outside src/, so only the default builtins apply there) and
 * runs entry.ts in a child process, through boot() unless `fenced` is false (or a runner is given).
 */
function runEntry(t: TestContext, files: Record<string, string>, fenced: boolean | string = true): Run {
  const dir = withTmp(t);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const runner = typeof fenced === 'string' ? fenced : fenced ? BOOT_RUNNER : BARE_RUNNER;
  fs.writeFileSync(path.join(dir, 'runner.mjs'), runner);
  const r = spawnSync(process.execPath, [path.join(dir, 'runner.mjs')], { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, dir };
}

function lastJson(out: string): Record<string, unknown> {
  const line = out.trim().split(/\r?\n/).at(-1) ?? '';
  return JSON.parse(line) as Record<string, unknown>;
}

test('policy: default builtins everywhere, rows per module, the forbidden list beats every row', () => {
  assert.equal(decideBuiltin(null, 'node:path').allow, true);
  assert.equal(decideBuiltin(null, 'fs').allow, false);
  assert.deepEqual(decideBuiltin(null, 'node:fs'), { allow: false, builtin: 'node:fs', module: null, reason: 'not-allowed-for-module' });
  // Since step 2c node:fs and node:child_process belong to the minted modules alone.
  assert.equal(decideBuiltin('src/fs/node-io.ts', 'node:fs').allow, true);
  assert.equal(decideBuiltin('src/fs/node-io.ts', 'fs/promises').allow, false, 'node:fs does not imply node:fs/promises');
  assert.equal(decideBuiltin('src/fs/read-gate.ts', 'node:fs').allow, false);
  assert.equal(decideBuiltin('src/fs/write-fence.ts', 'node:fs').allow, false);
  assert.equal(decideBuiltin('src/fs/paths.ts', 'node:fs').allow, false);
  assert.equal(decideBuiltin('src/fs/read-gate.ts', 'node:os').allow, false);
  // write-fence.ts's node:os row was stale (it imports only node:path and node:crypto) and removed.
  assert.equal(decideBuiltin('src/fs/write-fence.ts', 'node:os').allow, false);
  assert.equal(decideBuiltin('src/main.ts', 'node:os').allow, true);
  assert.equal(decideBuiltin('src/fs/sub/x.ts', 'node:fs').allow, false);
  assert.equal(decideBuiltin('src/os/node-proc.ts', 'child_process').allow, true);
  assert.equal(decideBuiltin('src/os/spawn.ts', 'child_process').allow, false);
  assert.equal(decideBuiltin('src/model/inbox.ts', 'node:child_process').allow, false);
  assert.equal(decideBuiltin('src/store/db.ts', 'node:sqlite').allow, true);
  assert.equal(decideBuiltin('src/main.ts', 'node:module').allow, false);
  assert.equal(decideBuiltin('src/runtime/features.ts', 'node:module').allow, true);
  for (const id of ['node:vm', 'vm', 'node:wasi', 'node:inspector', 'node:inspector/promises', 'node:repl', 'node:cluster']) {
    assert.equal((decideBuiltin('src/runtime/import-fence.ts', id) as { reason?: string }).reason, 'forbidden-everywhere', id);
  }
  assert.equal(rowsFor('SRC/FS/NODE-IO.TS').length, 1, 'module keys compare case-insensitively');
});

test('policy: module keys come from file URLs inside the repo only', () => {
  const base = REPO.href;
  assert.equal(moduleKeyFromUrl(`${base}src/fs/read-gate.ts`, REPO), 'src/fs/read-gate.ts');
  assert.equal(moduleKeyFromUrl(`${base}src/fs/read-gate.ts?x=1#h`, REPO), 'src/fs/read-gate.ts');
  assert.equal(moduleKeyFromUrl(base.replace(/^file:\/\/\/(\w):/, (_m, d: string) => `file:///${d.toLowerCase()}:`) + 'src/main.ts', REPO), 'src/main.ts');
  assert.equal(moduleKeyFromUrl('file:///C:/elsewhere/src/fs/read-gate.ts', REPO), null);
  assert.equal(moduleKeyFromUrl('data:text/javascript,1', REPO), null);
  assert.equal(moduleKeyFromUrl('node:fs', REPO), null);
  assert.equal(moduleKeyFromUrl(undefined, REPO), null);
  assert.equal(moduleKeyFromUrl('not a url', REPO), null);
});

test('installImportFence without registerHooks still replaces the getter and stubs, and is idempotent', () => {
  const calls: string[] = [];
  const fake: Record<string, unknown> = {
    getBuiltinModule: (id: string) => {
      calls.push(id);
      return { id };
    },
    binding: () => 'raw',
    _linkedBinding: () => 'raw',
    dlopen: () => 'raw',
    loadEnvFile: () => 'raw',
    report: { writeReport: () => 'raw', directory: '' },
    _debugProcess: () => 'raw',
    _debugEnd: () => 'raw',
    _getActiveHandles: () => ['raw'],
    _getActiveRequests: () => ['raw'],
  };
  const fakeGlobal: Record<PropertyKey, unknown> = { fetch: () => 'raw', WebSocket: function WebSocket() {} };
  const status = installImportFence(fake, {}, REPO, fakeGlobal);
  assert.deepEqual(status, { resolveHook: false, ...FULL_STATUS });
  assert.equal(installImportFence(fake, {}, REPO, fakeGlobal), status);
  const get = fake.getBuiltinModule as (id: string) => unknown;
  assert.deepEqual(get('path'), { id: 'node:path' });
  assert.throws(() => get('node:fs'), { code: 'ERR_ORCHESTRA_IMPORT_FENCE', reason: 'getter' });
  assert.throws(() => get('child_process'), { code: 'ERR_ORCHESTRA_IMPORT_FENCE' });
  // The first call is the fence priming node:worker_threads before it locks process.chdir (process-powers.ts, primedBy).
  assert.deepEqual(calls, ['node:worker_threads', 'node:path']);
  for (const name of ['binding', '_linkedBinding', 'dlopen', 'loadEnvFile', 'kill', '_kill', ...DEBUG_POWERS]) {
    assert.throws(() => (fake[name] as () => unknown)(), { code: 'ERR_ORCHESTRA_IMPORT_FENCE', reason: 'disabled' }, name);
  }
  for (const slot of DISPATCHER_SLOTS) {
    const stub = fakeGlobal[slot] as Record<string, () => unknown>;
    assert.ok(Object.isFrozen(stub), String(slot));
    for (const m of ['dispatch', 'request', 'stream', 'connect']) assert.throws(() => stub[m]!(), { code: 'ERR_ORCHESTRA_IMPORT_FENCE', reason: 'disabled' }, `${String(slot)}.${m}`);
    assert.throws(() => {
      fakeGlobal[slot] = {};
    }, TypeError, String(slot));
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(fakeGlobal, ORIGIN_SLOT), { value: undefined, writable: false, enumerable: false, configurable: false });
  assert.throws(() => {
    fakeGlobal[ORIGIN_SLOT] = new URL('http://127.0.0.1:9/');
  }, TypeError);
  const report = fake.report as Record<string, unknown>;
  assert.throws(() => (report.writeReport as () => unknown)(), { code: 'ERR_ORCHESTRA_IMPORT_FENCE' });
  assert.throws(() => {
    report.directory = 'C:\\elsewhere';
  }, TypeError);
  for (const name of ['fetch', 'WebSocket', 'EventSource']) {
    assert.throws(() => (fakeGlobal[name] as () => unknown)(), { code: 'ERR_ORCHESTRA_IMPORT_FENCE', reason: 'disabled' }, name);
    assert.throws(() => {
      fakeGlobal[name] = () => 'restored';
    }, TypeError, name);
  }
  assert.throws(() => {
    fake.getBuiltinModule = () => 'restored';
  }, TypeError);
});

test('a dispatcher slot undici already filled (writable, not configurable) is locked to the same stub', () => {
  const agent = { request: () => 'raw' };
  const fakeGlobal: Record<PropertyKey, unknown> = {};
  Object.defineProperty(fakeGlobal, DISPATCHER_SLOTS[0]!, { value: agent, writable: true, enumerable: false, configurable: false });
  installImportFence({}, {}, REPO, fakeGlobal);
  const stub = fakeGlobal[DISPATCHER_SLOTS[0]!] as Record<string, () => unknown>;
  assert.notEqual(stub, agent);
  assert.equal(stub, fakeGlobal[DISPATCHER_SLOTS[1]!]);
  assert.throws(() => stub.request!(), { code: 'ERR_ORCHESTRA_IMPORT_FENCE', reason: 'disabled' });
  assert.deepEqual(Object.getOwnPropertyDescriptor(fakeGlobal, DISPATCHER_SLOTS[0]!), { value: stub, writable: false, enumerable: false, configurable: false });
});

test('decideImport: builtins by policy; otherwise .ts/.js file: URLs only, no attributes, and src stays inside src/shared', () => {
  const R = REPO.href;
  const fromModel = `${R}src/model/x.ts`;
  const tmp = 'file:///C:/Temp/orchestra-test-x/';
  const why = (parent: string | undefined, url: string, attrs?: Record<string, string>) => {
    const d = decideImport(parent, url, attrs, REPO);
    return d.allow ? 'allow' : d.reason;
  };
  assert.equal(why(`${R}src/fs/node-io.ts`, 'node:fs'), 'allow');
  assert.equal(why(`${R}src/fs/read-gate.ts`, 'node:fs'), 'not-allowed-for-module');
  assert.equal(why(fromModel, 'node:fs'), 'not-allowed-for-module');
  assert.equal(why(fromModel, 'node:vm'), 'forbidden-everywhere');
  assert.equal(why(fromModel, `${R}src/fs/paths.ts`), 'allow');
  assert.equal(why(fromModel, `${R}shared/sanitize.js`), 'allow');
  assert.equal(why(fromModel, `${tmp}auth.json`, { type: 'json' }), 'import-attributes');
  assert.equal(why(undefined, `${tmp}auth.json`, { type: 'json' }), 'import-attributes');
  assert.equal(why(fromModel, 'node:path', { type: 'json' }), 'import-attributes');
  assert.equal(why(undefined, `${tmp}auth.json`), 'not-code-module');
  assert.equal(why(undefined, `${tmp}.env`), 'not-code-module');
  assert.equal(why(undefined, `${tmp}addon.node`), 'not-code-module');
  assert.equal(why(undefined, 'data:text/javascript,export default 1'), 'not-file-url');
  assert.equal(why(undefined, 'https://example.com/x.js'), 'not-file-url');
  assert.equal(why(fromModel, `${tmp}x.ts`), 'outside-repo-module');
  assert.equal(why(fromModel, `${R}spikes/s1-dsh/frame-tail.ts`), 'outside-repo-module');
  assert.equal(why(fromModel, `${R}test/helpers/tmp.ts`), 'outside-repo-module');
  assert.equal(why(`${R}shared/x.js`, `${tmp}x.js`), 'outside-repo-module');
  assert.equal(why(`${R}src/boot.ts`, `${tmp}entry.ts`), 'allow');
  assert.equal(why(`${R}src/workers/bootstrap.ts`, `${tmp}worker.ts`), 'allow');
  assert.equal(why(`${R}src/boot.ts`, `${tmp}entry.json`), 'not-code-module');
  assert.equal(why(`${tmp}entry.ts`, `${tmp}sibling.ts`), 'allow');
  assert.equal(why(`${tmp}entry.ts`, `${R}src/fs/read-gate.ts`), 'allow');
});

test('the resolve hook throws a typed ImportFenceError for every refusal', () => {
  type Hooks = { resolve(s: string, c: { parentURL?: string; importAttributes?: Record<string, string> }, n: (s: string) => { url: string }): { url: string } };
  let hooks: Hooks | undefined;
  installImportFence({}, { registerHooks: (h: Hooks) => { hooks = h; } } as never, REPO, {});
  assert.ok(hooks !== undefined);
  const next = (url: string) => () => ({ url });
  const parentURL = `${REPO.href}src/model/x.ts`;
  assert.deepEqual(hooks.resolve('./paths.ts', { parentURL }, next(`${REPO.href}src/fs/paths.ts`)), { url: `${REPO.href}src/fs/paths.ts` });
  const cases: Array<[string, Record<string, string> | undefined, string]> = [
    ['file:///C:/Temp/a.json', { type: 'json' }, 'import-attributes'],
    ['file:///C:/Temp/a.json', undefined, 'not-code-module'],
    ['file:///C:/Temp/a.ts', undefined, 'outside-repo-module'],
    ['data:text/javascript,1', undefined, 'not-file-url'],
    ['node:child_process', undefined, 'not-allowed-for-module'],
  ];
  for (const [url, importAttributes, reason] of cases) {
    assert.throws(() => hooks!.resolve('x', { parentURL, ...(importAttributes ? { importAttributes } : {}) }, next(url)), (e: unknown) => {
      assert.ok(e instanceof ImportFenceError);
      assert.equal(e.reason, reason, url);
      assert.match(e.message, new RegExp(`denied \\(${reason}\\) for src/model/x\\.ts`));
      return true;
    });
  }
});

test('worker targets: only .ts file URLs, never source text, data: URLs or the bootstrap itself', () => {
  assert.deepEqual(checkWorkerTarget(new URL('file:///C:/x/w.ts')), { ok: true, href: 'file:///C:/x/w.ts' });
  assert.deepEqual(checkWorkerTarget('const x = 1'), { ok: false, reason: 'not-file-url' });
  assert.deepEqual(checkWorkerTarget(new URL('data:text/javascript,1')), { ok: false, reason: 'not-file-url' });
  assert.deepEqual(checkWorkerTarget(new URL('https://example.com/w.ts')), { ok: false, reason: 'not-file-url' });
  assert.deepEqual(checkWorkerTarget(new URL('file:///C:/x/w.js')), { ok: false, reason: 'not-ts-module' });
  assert.deepEqual(checkWorkerTarget(new URL('file:///C:/x/w.ts?v=2')), { ok: false, reason: 'not-ts-module' });
  assert.deepEqual(checkWorkerTarget(BOOTSTRAP_URL), { ok: false, reason: 'is-bootstrap' });
  assert.throws(() => startWorker(new URL('data:text/javascript,1')), WorkerStartError);
});

test('boot(): an entry that statically imports node:child_process fails at load', (t) => {
  const entry = {
    'entry.ts': "import * as cp from 'node:child_process';\nexport async function start(): Promise<void> { console.log('LOADED', typeof cp.spawn); }\n",
  };
  const fenced = runEntry(t, entry);
  assert.notEqual(fenced.status, 0);
  assert.doesNotMatch(fenced.stdout, /LOADED/);
  assert.match(fenced.stderr, /ERR_ORCHESTRA_IMPORT_FENCE/);
  assert.match(fenced.stderr, /node:child_process denied \(not-allowed-for-module\)/);

  const control = runEntry(t, entry, false);
  assert.equal(control.status, 0, control.stderr);
  assert.match(control.stdout, /LOADED function/);
});

test('boot(): the default builtins and src modules with their own rows still load', (t) => {
  const r = runEntry(t, {
    'entry.ts': [
      "import * as path from 'node:path';",
      "import * as crypto from 'node:crypto';",
      `import { ReadGate } from ${JSON.stringify(src('fs/read-gate.ts'))};`,
      `import { WriteFence } from ${JSON.stringify(src('fs/write-fence.ts'))};`,
      "export async function start(): Promise<void> { console.log('LOADED', typeof path.join, typeof crypto.createHash, typeof ReadGate, typeof WriteFence); }",
    ].join('\n'),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /LOADED function function function function/);
});

test('boot(): process.getBuiltinModule and the native escape hatches throw, and cannot be put back', (t) => {
  const r = runEntry(t, {
    'entry.ts': `
const out: Record<string, unknown> = {};
const attempt = (name: string, f: () => unknown) => {
  try { const v = f(); out[name] = v === undefined ? 'undefined' : typeof v; } catch (e) { out[name] = (e as { code?: string; name: string }).code ?? (e as Error).name; }
};
export async function start(): Promise<void> {
  attempt('childProcess', () => process.getBuiltinModule('node:child_process'));
  attempt('computedFs', () => (process as unknown as Record<string, (id: string) => unknown>)['getBuilt' + 'inModule']!('node:fs'));
  attempt('bareFs', () => process.getBuiltinModule('fs'));
  attempt('path', () => process.getBuiltinModule('node:path'));
  attempt('binding', () => (process as unknown as { binding(n: string): unknown }).binding('fs'));
  attempt('linkedBinding', () => (process as unknown as { _linkedBinding(n: string): unknown })._linkedBinding('x'));
  attempt('dlopen', () => process.dlopen({ exports: {} } as never, 'C:\\\\nope.node'));
  attempt('reassign', () => { (process as unknown as Record<string, unknown>).getBuiltinModule = () => 1; });
  attempt('delete', () => { delete (process as unknown as Record<string, unknown>).getBuiltinModule; });
  attempt('redefine', () => Object.defineProperty(process, 'getBuiltinModule', { value: () => 1 }));
  console.log(JSON.stringify(out));
}
`,
  });
  assert.equal(r.status, 0, r.stderr);
  const fence = 'ERR_ORCHESTRA_IMPORT_FENCE';
  assert.deepEqual(lastJson(r.stdout), {
    childProcess: fence,
    computedFs: fence,
    bareFs: fence,
    path: 'object',
    binding: fence,
    linkedBinding: fence,
    dlopen: fence,
    reassign: 'TypeError',
    delete: 'TypeError',
    redefine: 'TypeError',
  });
});

test('boot(): dynamic import of vm and the other non-default builtins is refused', (t) => {
  const r = runEntry(t, {
    'entry.ts': `
export async function start(): Promise<void> {
  const out: Record<string, string> = {};
  const specs = ['node:vm', 'vm', 'node:module', 'node:worker_threads', 'node:fs/promises', 'node:inspector/promises', 'node:url'];
  for (const s of specs) {
    try { await import(s); out[s] = 'loaded'; } catch (e) { out[s] = (e as { code?: string }).code ?? String(e); }
  }
  console.log(JSON.stringify(out));
}
`,
  });
  assert.equal(r.status, 0, r.stderr);
  const fence = 'ERR_ORCHESTRA_IMPORT_FENCE';
  assert.deepEqual(lastJson(r.stdout), {
    'node:vm': fence,
    vm: fence,
    'node:module': fence,
    'node:worker_threads': fence,
    'node:fs/promises': fence,
    'node:inspector/promises': fence,
    'node:url': 'loaded',
  });
});

// The network name bans of the static scan went in step 2c (ban:net.connect, ban:createConnection,
// ban:http.request, ban:http.get, ban:node:https): no module without a row gets a network builtin at
// runtime, whoever asks, and the two rows that allow node:net or node:http are held to createServer by
// builtin-only-names (test/repo/static-scan.test.ts derives that from BUILTIN_ROWS).
test('PoC boot(): a module without a row can import no network builtin at runtime; unfenced it imports them all', (t) => {
  const entry = {
    'entry.ts': `
export async function start(): Promise<void> {
  const out: Record<string, string> = {};
  for (const s of ['node:net', 'net', 'node:http', 'node:https', 'node:tls', 'node:dgram', 'node:http2']) {
    try { await import(s); out[s] = 'loaded'; } catch (e) { out[s] = (e as { reason?: string }).reason ?? String(e); }
  }
  console.log(JSON.stringify(out));
}
`,
  };
  const specs = ['node:net', 'net', 'node:http', 'node:https', 'node:tls', 'node:dgram', 'node:http2'];
  const fenced = runEntry(t, entry);
  assert.equal(fenced.status, 0, fenced.stderr);
  assert.deepEqual(lastJson(fenced.stdout), Object.fromEntries(specs.map((s) => [s, 'not-allowed-for-module'])));
  const control = runEntry(t, entry, false);
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual(lastJson(control.stdout), Object.fromEntries(specs.map((s) => [s, 'loaded'])));
});

test('PoC boot(): JSON, data: and non-code imports, loadEnvFile and process.report are refused; code imports still load', (t) => {
  const files = {
    'auth.json': '{"token":"abc"}',
    '.env': 'SECRET_X=hunter2\n',
    'sibling.ts': 'export const sibling = 1;\n',
    'entry.ts': `
import { fileURLToPath } from 'node:url';
const out: Record<string, unknown> = {};
const code = (e: unknown) => (e as { code?: string; reason?: string }).reason ?? (e as { code?: string }).code ?? (e as Error).name;
const attempt = async (name: string, f: () => unknown) => {
  try { const v = await f(); out[name] = v === undefined ? 'undefined' : JSON.stringify(v); } catch (e) { out[name] = code(e); }
};
export async function start(): Promise<void> {
  const here = (n: string) => new URL('./' + n, import.meta.url).href;
  await attempt('jsonImport', async () => (await import(here('auth.json'), { with: { type: 'json' } })).default);
  await attempt('jsonNoAttributes', async () => (await import(here('auth.json'))).default);
  await attempt('dataUrl', async () => (await import('data:text/javascript,export default 42')).default);
  await attempt('sibling', async () => (await import(here('sibling.ts'))).sibling);
  await attempt('loadEnvFile', () => process.loadEnvFile(fileURLToPath(here('.env'))));
  out.secretAfter = process.env.SECRET_X ?? null;
  await attempt('writeReport', () => process.report.writeReport(fileURLToPath(here('report.json'))));
  await attempt('reportDirectory', () => { (process.report as { directory: string }).directory = fileURLToPath(here('')); });
  await attempt('reportOnFatal', () => { (process.report as { reportOnFatalError: boolean }).reportOnFatalError = true; });
  await attempt('loadEnvFileBack', () => { (process as unknown as Record<string, unknown>).loadEnvFile = () => 1; });
  await attempt('reportBack', () => { Object.defineProperty(process, 'report', { value: {} }); });
  console.log(JSON.stringify(out));
}
`,
  };
  // Unfenced, only the two reads run: the control must not write a diagnostic report anywhere.
  const controlEntry = `
import { fileURLToPath } from 'node:url';
export async function start(): Promise<void> {
  const here = (n: string) => new URL('./' + n, import.meta.url).href;
  const jsonImport = JSON.stringify((await import(here('auth.json'), { with: { type: 'json' } })).default);
  process.loadEnvFile(fileURLToPath(here('.env')));
  console.log(JSON.stringify({ jsonImport, secretAfter: process.env.SECRET_X ?? null }));
}
`;
  const r = runEntry(t, files);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastJson(r.stdout), {
    jsonImport: 'import-attributes',
    jsonNoAttributes: 'not-code-module',
    dataUrl: 'not-file-url',
    sibling: '1',
    loadEnvFile: 'disabled',
    secretAfter: null,
    writeReport: 'disabled',
    reportDirectory: 'TypeError',
    reportOnFatal: 'TypeError',
    loadEnvFileBack: 'TypeError',
    reportBack: 'TypeError',
  });
  assert.equal(fs.existsSync(path.join(r.dir, 'report.json')), false);

  const control = runEntry(t, { ...files, 'entry.ts': controlEntry }, false);
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual(lastJson(control.stdout), { jsonImport: '{"token":"abc"}', secretAfter: 'hunter2' }, 'without the fence the PoC reads both files');
});

test('PoC boot(): fetch, WebSocket and EventSource are dead in every spelling; boot hands main the one live fetch', (t) => {
  const r = runEntry(t, {
    'entry.ts': `
const out: Record<string, unknown> = {};
const attempt = (name: string, f: () => unknown) => {
  try { const v = f(); out[name] = v === undefined ? 'undefined' : typeof v; } catch (e) { out[name] = (e as { reason?: string }).reason ?? (e as Error).name; }
};
export async function start(_f: unknown, _fence: unknown, ports: { fetch: typeof fetch }): Promise<void> {
  attempt('fetch', () => fetch('data:,x'));
  attempt('alias', () => { const f = fetch; return f('data:,x'); });
  attempt('reflect', () => Reflect.apply(fetch, null, ['data:,x']));
  attempt('computed', () => (globalThis as unknown as Record<string, (u: string) => unknown>)['fet' + 'ch']!('data:,x'));
  attempt('webSocket', () => new WebSocket('ws://127.0.0.1:9/'));
  attempt('eventSource', () => new (globalThis as unknown as { EventSource: new (u: string) => unknown }).EventSource('http://127.0.0.1:9/'));
  attempt('reassign', () => { (globalThis as unknown as Record<string, unknown>).fetch = () => 1; });
  attempt('delete', () => { delete (globalThis as unknown as Record<string, unknown>).WebSocket; });
  out.portIsGlobal = ports.fetch === globalThis.fetch;
  out.port = await (await ports.fetch('data:,live')).text();
  console.log(JSON.stringify(out));
}
`,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastJson(r.stdout), {
    fetch: 'disabled',
    alias: 'disabled',
    reflect: 'disabled',
    computed: 'disabled',
    webSocket: 'disabled',
    eventSource: 'disabled',
    reassign: 'TypeError',
    delete: 'TypeError',
    portIsGlobal: false,
    port: 'live',
  });
});

test('boot() without a resolve hook prints the fence status, exits with the missing-features code and never imports the entry', (t) => {
  const entry = { 'entry.ts': "console.log('LOADED');\nexport async function start(): Promise<unknown> { console.log('STARTED'); return { code: 0 }; }\n" };
  const runner = (deps: string) => [
    `import { runEntry } from ${JSON.stringify(src('boot.ts'))};`,
    `import { detectFeatures } from ${JSON.stringify(src('runtime/features.ts'))};`,
    `import { installImportFence } from ${JSON.stringify(src('runtime/import-fence.ts'))};`,
    `await runEntry(new URL('./entry.ts', import.meta.url)${deps});`,
  ].join('\n');
  const marks = (out: string) => out.split(/\r?\n/).filter((l) => l === 'LOADED' || l === 'STARTED');

  const r = runEntry(t, entry, runner(', { detectFeatures, installImportFence: () => installImportFence(process, {}) }'));
  assert.equal(r.status, EXIT.missingFeatures, r.stderr);
  assert.deepEqual(marks(r.stdout), [], 'the entry was neither loaded nor started');
  const lines = r.stderr.split(/\r?\n/).filter((l) => l.startsWith('orchestrad: '));
  assert.equal(lines.length, 1, r.stderr);
  const prefix = 'orchestrad: cannot start, missing: module.registerHooks (the import fence has no resolve hook): ';
  assert.ok(lines[0]!.startsWith(prefix), lines[0]);
  assert.deepEqual(JSON.parse(lines[0]!.slice(prefix.length)), { resolveHook: false, ...FULL_STATUS });

  // Control: the same entry under the real fence loads and starts once.
  const control = runEntry(t, entry, runner(''));
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual(marks(control.stdout), ['LOADED', 'STARTED']);
});

test('boot(): process.kill and process._kill are dead and cannot be put back', (t) => {
  const r = runEntry(t, {
    'entry.ts': `
const out: Record<string, string> = {};
const attempt = (name: string, fn: () => unknown) => {
  try { fn(); out[name] = 'reached'; } catch (e) { out[name] = (e as { reason?: string; name?: string }).reason ?? (e as Error).name; }
};
export async function start(): Promise<void> {
  attempt('kill', () => process.kill(process.pid, 0));
  attempt('_kill', () => (process as unknown as { _kill(p: number, s: number): unknown })._kill(process.pid, 0));
  attempt('computed', () => (process as unknown as Record<string, (p: number, s: number) => unknown>)['ki' + 'll']!(process.pid, 0));
  attempt('reassign', () => { (process as unknown as Record<string, unknown>).kill = () => 1; });
  console.log(JSON.stringify(out));
}
`,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastJson(r.stdout), { kill: 'disabled', _kill: 'disabled', computed: 'disabled', reassign: 'TypeError' });
});

test('boot(): a child is still stopped through its own ChildProcess handle while process.kill is dead', (t) => {
  // The runner imports child_process before boot() installs the fence, as src/os/spawn.ts would be
  // allowed to; ChildProcess.kill goes through the handle, not process.kill.
  const runner = [
    "import { spawn } from 'node:child_process';",
    `import { boot } from ${JSON.stringify(src('boot.ts'))};`,
    "globalThis.spawnForTest = spawn;",
    "await boot(new URL('./entry.ts', import.meta.url));",
  ].join('\n');
  const r = runEntry(t, {
    'entry.ts': `
export async function start(): Promise<void> {
  const spawn = (globalThis as unknown as { spawnForTest: (exe: string, argv: string[], o: object) => { pid?: number; kill(): boolean; once(e: string, f: (c: number | null, s: string | null) => void): void } }).spawnForTest;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise<string>((resolve) => child.once('exit', (c, s) => resolve(String(s ?? c))));
  const sent = child.kill();
  console.log(JSON.stringify({ sent, exit: await exited, killStub: (() => { try { process.kill(child.pid ?? 0, 0); return 'reached'; } catch (e) { return (e as { reason?: string }).reason; } })() }));
}
`,
  }, runner);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastJson(r.stdout), { sent: true, exit: 'SIGTERM', killStub: 'disabled' });
});

type Idle = { pid: number; stderr(): string; stop(): Promise<void> };

/**
 * A throwaway node child that only idles, stopped through its handle. --inspect-port=0 gives its
 * inspector a free port should anyone open it; "ready" means its own code runs, so its debug
 * handler is in place.
 */
async function idleNode(t: TestContext): Promise<Idle> {
  const file = path.join(withTmp(t), 'idle.mjs');
  fs.writeFileSync(file, "process.stderr.write('ready\\n');\nsetInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, ['--inspect-port=0', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  if (typeof child.pid !== 'number') throw new Error('spawn gave no pid');
  let err = '';
  child.stderr!.on('data', (c: Buffer) => {
    err += c.toString('utf8');
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  t.after(stop);
  assert.ok(await until(() => err.includes('ready'), 15_000), `the idle child never got ready: ${err}`);
  return { pid: child.pid, stderr: () => err, stop };
}

test('PoC boot(): process._debugProcess cannot open the inspector of another node process; unfenced it does', async (t) => {
  const LISTENING = /Debugger listening/;
  const entry = (pid: number) => ({
    'entry.ts': `
const out: Record<string, string> = {};
const attempt = (name: string, fn: () => unknown) => {
  try { fn(); out[name] = 'reached'; } catch (e) { out[name] = (e as { code?: string }).code ?? (e as Error).name; }
};
export async function start(): Promise<void> {
  const p = process as unknown as { _debugProcess(pid: number): void; _debugEnd(): void };
  attempt('debugProcess', () => p._debugProcess(${pid}));
  attempt('debugEnd', () => p._debugEnd());
  console.log(JSON.stringify(out));
}
`,
  });

  // Control first: unfenced, the call opens the target's inspector; it also says how long that takes to show.
  const bad = await idleNode(t);
  const control = runEntry(t, entry(bad.pid), false);
  const shownFrom = performance.now();
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual(lastJson(control.stdout), { debugProcess: 'reached', debugEnd: 'reached' });
  assert.ok(await until(() => LISTENING.test(bad.stderr()), 15_000), `control: no inspector opened; target stderr: ${bad.stderr()}`);
  const shownAfter = performance.now() - shownFrom;
  await bad.stop();

  const target = await idleNode(t);
  const fenced = runEntry(t, entry(target.pid));
  assert.equal(fenced.status, 0, fenced.stderr);
  assert.deepEqual(lastJson(fenced.stdout), { debugProcess: 'ERR_ORCHESTRA_IMPORT_FENCE', debugEnd: 'ERR_ORCHESTRA_IMPORT_FENCE' });
  const wait = Math.max(1500, 3 * shownAfter);
  t.diagnostic(`control inspector showed ${shownAfter.toFixed(0)} ms after its runner ended; watching the fenced target for ${wait.toFixed(0)} ms`);
  await sleep(wait);
  assert.doesNotMatch(target.stderr(), LISTENING);
  await target.stop();
});

test('PoC boot(): process._getActiveHandles cannot hand out the lock pipe\'s server; unfenced, closing it frees the lock', (t) => {
  const key = `C:\\orchestra-handles-test-${process.pid}-${Date.now()}`;
  // The runner takes the single-writer lock before boot(), as orchestrad does, and checks after the
  // entry ran whether a second listen on the pipe still gets "held".
  const runner = (fenced: boolean) => [
    `import { boot } from ${JSON.stringify(src('boot.ts'))};`,
    `import { acquireLock, lockPipeName } from ${JSON.stringify(src('runtime/lock.ts'))};`,
    `const pipe = lockPipeName(${JSON.stringify(`${key}-${fenced ? 'fenced' : 'control'}`)});`,
    'const held = await acquireLock(pipe);',
    "if (!held.ok) throw new Error('lock not taken: ' + held.reason);",
    "const entry = new URL('./entry.ts', import.meta.url);",
    fenced ? 'const result = (await boot(entry)).result;' : 'const result = await (await import(entry.href)).start();',
    'const again = await acquireLock(pipe);',
    "console.log(JSON.stringify({ result, second: again.ok ? 'acquired' : again.reason }));",
    'if (again.ok) await again.lock.release();',
    'await held.lock.release();',
  ].join('\n');
  const entry = {
    'entry.ts': `
type Handle = { constructor: { name: string }; close?(cb: () => void): void };
const code = (e: unknown) => (e as { code?: string }).code ?? (e as Error).name;
function requests(): string {
  try { return typeof (process as unknown as { _getActiveRequests(): unknown })._getActiveRequests(); } catch (e) { return code(e); }
}
export async function start(): Promise<unknown> {
  let handles: Handle[];
  try { handles = (process as unknown as { _getActiveHandles(): Handle[] })._getActiveHandles(); } catch (e) { return { handles: code(e), requests: requests() }; }
  const servers = handles.filter((h) => h.constructor.name === 'Server');
  for (const s of servers) await new Promise<void>((resolve) => s.close!(() => resolve()));
  return { handles: \`\${servers.length} server closed\`, requests: requests() };
}
`,
  };
  const fenced = runEntry(t, entry, runner(true));
  assert.equal(fenced.status, 0, fenced.stderr);
  assert.deepEqual(lastJson(fenced.stdout), { result: { handles: 'ERR_ORCHESTRA_IMPORT_FENCE', requests: 'ERR_ORCHESTRA_IMPORT_FENCE' }, second: 'held' });

  const control = runEntry(t, entry, runner(false));
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual(lastJson(control.stdout), { result: { handles: '1 server closed', requests: 'object' }, second: 'acquired' }, 'unfenced, any module drops the lock');
});

test('PoC boot(): the undici dispatcher slots hold a frozen stub that cannot send or be replaced; node:http and data: fetch still work', (t) => {
  // A fake repo root around the temp dir gives <tmp>\src\server\http.ts the node:http row, so a
  // module may import node:http after the fence went in, as src/server/http.ts will.
  const runner = [
    "import * as nodeModule from 'node:module';",
    "import { pathToFileURL } from 'node:url';",
    `import { boot } from ${JSON.stringify(src('boot.ts'))};`,
    `import { detectFeatures } from ${JSON.stringify(src('runtime/features.ts'))};`,
    `import { installImportFence } from ${JSON.stringify(src('runtime/import-fence.ts'))};`,
    "const root = new URL('./', import.meta.url);",
    "await boot(new URL('./entry.ts', root), { detectFeatures, installImportFence: () => installImportFence(process, nodeModule, root) });",
  ].join('\n');
  const files = {
    'src/server/http.ts': "import { createServer } from 'node:http';\nexport const kind = typeof createServer;\n",
    'entry.ts': `
const SLOTS = [Symbol.for('undici.globalDispatcher.1'), Symbol.for('undici.globalDispatcher.2')];
type Slot = { request(o: object): unknown };
const g = globalThis as unknown as Record<symbol, Slot>;
const out: Record<string, unknown> = {};
const attempt = (name: string, fn: () => unknown) => {
  try { fn(); out[name] = 'reached'; } catch (e) { out[name] = (e as { reason?: string }).reason ?? (e as Error).name; }
};
export async function start(_f: unknown, _fence: unknown, ports: { fetch: typeof fetch }): Promise<void> {
  const stubs = SLOTS.map((s) => g[s]);
  // Before node:http loads, so that without the stubs this reads an empty slot and sends nothing.
  for (const [i, s] of SLOTS.entries()) attempt('request' + (i + 1), () => g[s]!.request({ origin: 'http://127.0.0.1:9', path: '/', method: 'GET' }));
  const http = await import('./src/server/http.ts');
  out.httpImport = http.kind;
  out.port = await (await ports.fetch('data:,live')).text();
  out.sameStubs = SLOTS.every((s, i) => g[s] === stubs[i]) && stubs[0] === stubs[1];
  out.frozen = Object.isFrozen(stubs[0]);
  for (const [i, s] of SLOTS.entries()) {
    const n = i + 1;
    attempt('assign' + n, () => { g[s] = { request: () => 'mine' }; });
    attempt('redefine' + n, () => Object.defineProperty(globalThis, s, { value: {} }));
    attempt('delete' + n, () => { delete g[s]; });
  }
  console.log(JSON.stringify(out));
}
`,
  };
  // Unfenced, both slots appear with the first import of node:http, send HTTP without fetch, and a
  // Proxy put there sees the path of a request made through the fetch boot captured.
  const controlEntry = `
const SLOTS = [Symbol.for('undici.globalDispatcher.1'), Symbol.for('undici.globalDispatcher.2')];
type Dispatcher = { request(o: object): Promise<{ statusCode: number; body: { text(): Promise<string> } }>; dispatch(o: { path: string }, h: unknown): unknown };
const g = globalThis as unknown as Record<symbol, Dispatcher>;
export async function start(_f: unknown, _fence: unknown, ports: { fetch: typeof fetch }): Promise<void> {
  const out: Record<string, unknown> = { absent: SLOTS.map((s) => s in globalThis) };
  const http = await import('node:http');
  out.present = SLOTS.map((s) => s in globalThis);
  const server = http.createServer((q, s) => { s.end('got ' + q.url); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const res = await g[SLOTS[0]!]!.request({ origin, path: '/no-fetch', method: 'GET' });
  out.request = [res.statusCode, await res.body.text()];
  const seen: string[] = [];
  for (const s of SLOTS) {
    const real = g[s]!;
    g[s] = new Proxy(real, {
      get(target, k) {
        const v = Reflect.get(target, k) as unknown;
        if (k === 'dispatch') return (o: { path: string }, h: unknown) => { seen.push(o.path); return real.dispatch(o, h); };
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }
  out.fetched = await (await ports.fetch(origin + '/secret-path')).text();
  out.seen = seen;
  server.close();
  console.log(JSON.stringify(out));
}
`;
  const r = runEntry(t, files, runner);
  assert.equal(r.status, 0, r.stderr);
  const dead = { request1: 'disabled', assign1: 'TypeError', redefine1: 'TypeError', delete1: 'TypeError', request2: 'disabled', assign2: 'TypeError', redefine2: 'TypeError', delete2: 'TypeError' };
  assert.deepEqual(lastJson(r.stdout), { httpImport: 'function', port: 'live', sameStubs: true, frozen: true, ...dead });

  const control = runEntry(t, { 'entry.ts': controlEntry }, `const m = await import(new URL('./entry.ts', import.meta.url).href);\nawait m.start(undefined, undefined, { fetch: globalThis.fetch });\n`);
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual(lastJson(control.stdout), {
    absent: [false, false], present: [true, true], request: [200, 'got /no-fetch'], fetched: 'got /secret-path', seen: ['/secret-path'],
  });
});

test('PoC boot(): a module-defined Object.prototype.dispatcher never sees a request made through ports.fetch; unfenced it sees all of them', (t) => {
  // Nothing reaches the network: the module's dispatcher throws, and so does the dead one ports.fetch binds.
  const entry = `
const seen: string[] = [];
type Opts = { method: string; origin: string; path: string; headers: unknown };
type Port = { fetch(u: string, i?: object): Promise<Response> };
export async function start(_f: unknown, _fence: unknown, ports: Port): Promise<void> {
  Object.defineProperty(Object.prototype, 'dispatcher', {
    value: { dispatch(o: Opts) { seen.push(o.method + ' ' + o.origin + o.path + ' ' + JSON.stringify(o.headers)); throw new Error('intercepted by module'); }, isMockActive: false },
    configurable: true, writable: true,
  });
  const url = 'http://127.0.0.1:65000/secret-path?token=abc';
  const out: Record<string, unknown> = {};
  const why = async (name: string, f: () => Promise<Response>) => {
    try { await f(); out[name] = 'resolved'; } catch (e) { const c = (e as { cause?: { reason?: string; message?: string } }).cause; out[name] = c?.reason ?? c?.message ?? String(e); }
  };
  await why('noInit', () => ports.fetch(url));
  await why('emptyInit', () => ports.fetch(url, {}));
  await why('auth', () => ports.fetch(url, { headers: { authorization: 'Bearer t0k' } }));
  out.data = await (await ports.fetch('data:,live')).text();
  delete (Object.prototype as Record<string, unknown>).dispatcher;
  out.seen = seen;
  console.log(JSON.stringify(out));
}
`;
  const r = runEntry(t, { 'entry.ts': entry });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastJson(r.stdout), { noInit: 'disabled', emptyInit: 'disabled', auth: 'disabled', data: 'live', seen: [] });

  const control = runEntry(t, { 'entry.ts': entry }, `const m = await import(new URL('./entry.ts', import.meta.url).href);
await m.start(undefined, undefined, { fetch: globalThis.fetch });
`);
  assert.equal(control.status, 0, control.stderr);
  const c = lastJson(control.stdout) as { noInit: string; seen: string[] };
  assert.equal(c.noInit, 'intercepted by module');
  assert.equal(c.seen.length, 3, 'with the plain fetch the module sees every request');
  assert.ok(c.seen[2]!.startsWith('GET http://127.0.0.1:65000/secret-path?token=abc '), c.seen[2]);
  assert.ok(c.seen[2]!.includes('"authorization":"Bearer t0k"'), c.seen[2]);
});

test('PoC boot(): the undici global origin slot stays empty, so no module picks where a relative URL goes; unfenced a module sets it', (t) => {
  const entry = `
const ORIGIN = Symbol.for('undici.globalOrigin.1');
const g = globalThis as unknown as Record<symbol, unknown>;
const name = (e: unknown) => (e as Error).name;
export async function start(_f: unknown, _fence: unknown, ports: { fetch(u: string): Promise<Response> } | undefined): Promise<void> {
  const out: Record<string, unknown> = { before: g[ORIGIN] === undefined };
  try { g[ORIGIN] = new URL('http://127.0.0.1:65000/'); out.assign = 'reached'; } catch (e) { out.assign = name(e); }
  try { out.requestUrl = new Request('/rel').url; } catch (e) { out.requestUrl = name(e); }
  if (ports !== undefined) {
    try { Object.defineProperty(globalThis, ORIGIN, { value: new URL('http://127.0.0.1:65000/') }); out.redefine = 'reached'; } catch (e) { out.redefine = name(e); }
    try { await ports.fetch('/rel'); out.rel = 'resolved'; } catch (e) { out.rel = (e as Error).message; }
  }
  console.log(JSON.stringify(out));
}
`;
  const r = runEntry(t, { 'entry.ts': entry });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastJson(r.stdout), { before: true, assign: 'TypeError', requestUrl: 'TypeError', redefine: 'TypeError', rel: 'Failed to parse URL from /rel' });

  // Unfenced the module only builds a Request, so nothing is sent anywhere.
  const control = runEntry(t, { 'entry.ts': entry }, false);
  assert.equal(control.status, 0, control.stderr);
  assert.deepEqual(lastJson(control.stdout), { before: true, assign: 'reached', requestUrl: 'http://127.0.0.1:65000/rel' });
});

test('workers.ts: the bootstrap fences the worker before its module loads', (t) => {
  const r = runEntry(t, {
    'entry.ts': `
import { startWorker } from ${JSON.stringify(src('runtime/workers.ts'))};
type Outcome = { messages: unknown[]; error: string | null; exit: number | null };
const run = (name: string) => new Promise<Outcome>((resolve) => {
  const out: Outcome = { messages: [], error: null, exit: null };
  const w = startWorker(new URL('./' + name, import.meta.url), { hello: 1 });
  w.on('message', (m) => out.messages.push(m));
  w.on('error', (e) => { out.error = String((e as Error).message); });
  w.on('exit', (c) => { out.exit = c; resolve(out); });
});
export async function start(): Promise<void> {
  const result: Record<string, Outcome> = {};
  for (const n of ['worker-fs.ts', 'worker-ok.ts', 'worker-getter.ts', 'worker-norun.ts', 'worker-powers.ts']) result[n] = await run(n);
  console.log(JSON.stringify(result));
}
`,
    'worker-fs.ts': "import * as fs from 'node:fs';\nexport function run(ctx: { post(m: unknown): void }): void { ctx.post({ got: typeof fs.readFileSync }); }\n",
    'worker-ok.ts': "import * as path from 'node:path';\nexport function run(ctx: { data: unknown; post(m: unknown): void }): void { ctx.post({ ok: true, data: ctx.data, sep: path.sep }); }\n",
    'worker-getter.ts': `export function run(ctx: { post(m: unknown): void }): void {
  try { process.getBuiltinModule('node:fs'); ctx.post('reached'); } catch (e) { ctx.post('threw:' + (e as { code?: string }).code); }
}
`,
    'worker-norun.ts': 'export const nothing = 1;\n',
    'worker-powers.ts': `export function run(ctx: { post(m: unknown): void }): void {
  const out: Record<string, string> = {};
  const p = process as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ['_debugProcess', '_debugEnd', '_getActiveHandles', '_getActiveRequests']) {
    try { p[name]!(); out[name] = 'reached'; } catch (e) { out[name] = (e as { reason?: string }).reason ?? (e as Error).name; }
  }
  try { (globalThis as unknown as Record<symbol, { request(o: object): unknown }>)[Symbol.for('undici.globalDispatcher.1')]!.request({}); out.dispatcher = 'reached'; } catch (e) { out.dispatcher = (e as { reason?: string }).reason ?? (e as Error).name; }
  ctx.post(out);
}
`,
  });
  assert.equal(r.status, 0, r.stderr);
  const res = lastJson(r.stdout) as Record<string, { messages: unknown[]; error: string | null; exit: number }>;
  assert.deepEqual(res['worker-powers.ts']!.messages, [{ _debugProcess: 'disabled', _debugEnd: 'disabled', _getActiveHandles: 'disabled', _getActiveRequests: 'disabled', dispatcher: 'disabled' }]);
  assert.deepEqual(res['worker-fs.ts']!.messages, []);
  assert.match(res['worker-fs.ts']!.error ?? '', /ERR_ORCHESTRA_IMPORT_FENCE.*node:fs denied \(not-allowed-for-module\)/);
  assert.equal(res['worker-fs.ts']!.exit, 1);
  assert.deepEqual(res['worker-ok.ts'], { messages: [{ ok: true, data: { hello: 1 }, sep: '\\' }], error: null, exit: 0 });
  assert.deepEqual(res['worker-getter.ts']!.messages, ['threw:ERR_ORCHESTRA_IMPORT_FENCE']);
  assert.match(res['worker-norun.ts']!.error ?? '', /exports no run\(\)/);
});
