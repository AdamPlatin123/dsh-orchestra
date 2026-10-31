import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TestContext } from 'node:test';
import { decideBuiltin, moduleKeyFromUrl, rowsFor } from '../../src/runtime/builtin-policy.ts';
import { ImportFenceError, decideImport, installImportFence } from '../../src/runtime/import-fence.ts';
import { BOOTSTRAP_URL, WorkerStartError, checkWorkerTarget, startWorker } from '../../src/runtime/workers.ts';
import { withTmp } from '../helpers/tmp.ts';

const src = (rel: string) => new URL(`../../src/${rel}`, import.meta.url).href;
const REPO = new URL('../../', import.meta.url);

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
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
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
  assert.equal(decideBuiltin('src/fs/read-gate.ts', 'node:fs').allow, true);
  assert.equal(decideBuiltin('src/fs/read-gate.ts', 'fs/promises').allow, true);
  assert.equal(decideBuiltin('src/fs/read-gate.ts', 'node:os').allow, false);
  assert.equal(decideBuiltin('src/fs/write-fence.ts', 'node:os').allow, true);
  assert.equal(decideBuiltin('src/fs/sub/x.ts', 'node:fs').allow, false);
  assert.equal(decideBuiltin('src/os/spawn.ts', 'child_process').allow, true);
  assert.equal(decideBuiltin('src/model/inbox.ts', 'node:child_process').allow, false);
  assert.equal(decideBuiltin('src/store/db.ts', 'node:sqlite').allow, true);
  assert.equal(decideBuiltin('src/main.ts', 'node:module').allow, false);
  assert.equal(decideBuiltin('src/runtime/features.ts', 'node:module').allow, true);
  for (const id of ['node:vm', 'vm', 'node:wasi', 'node:inspector', 'node:inspector/promises', 'node:repl', 'node:cluster']) {
    assert.equal((decideBuiltin('src/runtime/import-fence.ts', id) as { reason?: string }).reason, 'forbidden-everywhere', id);
  }
  assert.equal(rowsFor('SRC/FS/READ-GATE.TS').length, 1, 'module keys compare case-insensitively');
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
  };
  const fakeGlobal: Record<string, unknown> = { fetch: () => 'raw', WebSocket: function WebSocket() {} };
  const status = installImportFence(fake, {}, REPO, fakeGlobal);
  assert.deepEqual(status, { resolveHook: false, builtinGetter: true, nativeStubs: true, ioStubs: true, networkGlobals: true });
  assert.equal(installImportFence(fake, {}, REPO, fakeGlobal), status);
  const get = fake.getBuiltinModule as (id: string) => unknown;
  assert.deepEqual(get('path'), { id: 'node:path' });
  assert.throws(() => get('node:fs'), { code: 'ERR_ORCHESTRA_IMPORT_FENCE', reason: 'getter' });
  assert.throws(() => get('child_process'), { code: 'ERR_ORCHESTRA_IMPORT_FENCE' });
  assert.deepEqual(calls, ['node:path']);
  for (const name of ['binding', '_linkedBinding', 'dlopen', 'loadEnvFile']) {
    assert.throws(() => (fake[name] as () => unknown)(), { code: 'ERR_ORCHESTRA_IMPORT_FENCE', reason: 'disabled' }, name);
  }
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

test('decideImport: builtins by policy; otherwise .ts/.js file: URLs only, no attributes, and src stays inside src/shared', () => {
  const R = REPO.href;
  const fromModel = `${R}src/model/x.ts`;
  const tmp = 'file:///C:/Temp/orchestra-test-x/';
  const why = (parent: string | undefined, url: string, attrs?: Record<string, string>) => {
    const d = decideImport(parent, url, attrs, REPO);
    return d.allow ? 'allow' : d.reason;
  };
  assert.equal(why(`${R}src/fs/read-gate.ts`, 'node:fs'), 'allow');
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

test('boot() without a resolve hook refuses to load the entry: typed outcome, exit 2, nothing imported', (t) => {
  const runner = [
    `import { boot } from ${JSON.stringify(src('boot.ts'))};`,
    `import { detectFeatures } from ${JSON.stringify(src('runtime/features.ts'))};`,
    `import { installImportFence } from ${JSON.stringify(src('runtime/import-fence.ts'))};`,
    "const outcome = await boot(new URL('./entry.ts', import.meta.url), { detectFeatures, installImportFence: () => installImportFence(process, {}) });",
    'console.log(JSON.stringify(outcome));',
  ].join('\n');
  const r = runEntry(t, { 'entry.ts': "console.log('LOADED');\nexport async function start(): Promise<void> { console.log('STARTED'); }\n" }, runner);
  assert.equal(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stdout, /LOADED|STARTED/);
  assert.match(r.stderr, /cannot start, import fence has no resolve hook/);
  assert.deepEqual(lastJson(r.stdout), {
    started: false,
    reason: 'no-resolve-hook',
    fence: { resolveHook: false, builtinGetter: true, nativeStubs: true, ioStubs: true, networkGlobals: true },
  });
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
  for (const n of ['worker-fs.ts', 'worker-ok.ts', 'worker-getter.ts', 'worker-norun.ts']) result[n] = await run(n);
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
  });
  assert.equal(r.status, 0, r.stderr);
  const res = lastJson(r.stdout) as Record<string, { messages: unknown[]; error: string | null; exit: number }>;
  assert.deepEqual(res['worker-fs.ts']!.messages, []);
  assert.match(res['worker-fs.ts']!.error ?? '', /ERR_ORCHESTRA_IMPORT_FENCE.*node:fs denied \(not-allowed-for-module\)/);
  assert.equal(res['worker-fs.ts']!.exit, 1);
  assert.deepEqual(res['worker-ok.ts'], { messages: [{ ok: true, data: { hello: 1 }, sep: '\\' }], error: null, exit: 0 });
  assert.deepEqual(res['worker-getter.ts']!.messages, ['threw:ERR_ORCHESTRA_IMPORT_FENCE']);
  assert.match(res['worker-norun.ts']!.error ?? '', /exports no run\(\)/);
});
