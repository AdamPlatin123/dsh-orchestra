import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXEMPT_SCRIPTS, RULES, SCANNED_DIRS, findImports, scan } from '../helpers/scan-rules.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));

type Case = { rule: string; file: string; text: string; hit: boolean };

const pos = (rule: string, file: string, text: string): Case => ({ rule, file, text, hit: true });
const neg = (rule: string, file: string, text: string): Case => ({ rule, file, text, hit: false });

// Each rule: at least one example it must flag and one it must leave alone.
const CASES: readonly Case[] = [
  pos('builtin-policy', 'src/model/inbox.ts', "import * as fs from 'node:fs';"),
  pos('builtin-policy', 'src/model/inbox.ts', "import { spawn } from 'child_process';"),
  pos('builtin-policy', 'src/fs/read-gate.ts', "import * as vm from 'node:vm';"),
  pos('builtin-policy', 'src/fs/sub/deeper.ts', "import * as fs from 'node:fs';"),
  pos('builtin-policy', 'src/main.ts', "const m = await import('node:module');"),
  pos('builtin-policy', 'scripts/check-real-claude.ts', "import { readFileSync } from 'node:fs';"),
  neg('builtin-policy', 'src/fs/read-gate.ts', "import * as fs from 'node:fs';\nimport * as path from 'node:path';"),
  neg('builtin-policy', 'src/model/inbox.ts', "import type { Stats } from 'node:fs';"),
  neg('builtin-policy', 'src/os/spawn.ts', "import { execFile } from 'node:child_process';"),
  neg('builtin-policy', 'scripts/test-stage.ts', "import * as fs from 'node:fs';"),

  pos('builtin-only-names', 'src/main.ts', "import * as os from 'node:os';"),
  pos('builtin-only-names', 'src/main.ts', "import { homedir, userInfo } from 'node:os';"),
  pos('builtin-only-names', 'src/runtime/lock.ts', "import { createServer, connect } from 'node:net';"),
  neg('builtin-only-names', 'src/main.ts', "import { homedir, totalmem } from 'node:os';"),
  neg('builtin-only-names', 'src/fs/write-fence.ts', "import { tmpdir } from 'node:os';"),
  neg('builtin-only-names', 'src/runtime/lock.ts', "import { createServer, type Server } from 'node:net';"),
  pos('builtin-only-names', 'src/server/http.ts', "import { createServer, request } from 'node:http';"),
  pos('builtin-only-names', 'src/server/http.ts', "import * as http from 'node:http';"),
  neg('builtin-only-names', 'src/server/http.ts', "import { createServer, type IncomingMessage } from 'node:http';"),

  pos('ban:getBuiltinModule', 'src/model/x.ts', "const cp = process.getBuiltinModule('node:child_process');"),
  neg('ban:getBuiltinModule', 'src/runtime/import-fence.ts', "lock(p, 'getBuiltinModule', wrapper);"),
  neg('ban:getBuiltinModule', 'src/model/x.ts', 'const builtins = DEFAULT_BUILTINS;'),
  pos('ban:process.binding', 'src/model/x.ts', "process.binding('fs');"),
  pos('ban:process.binding', 'src/model/x.ts', "process['binding']('fs');"),
  neg('ban:process.binding', 'src/model/x.ts', 'const binding = keyBinding(event);'),
  pos('ban:_linkedBinding', 'src/model/x.ts', "process._linkedBinding('x');"),
  neg('ban:_linkedBinding', 'src/runtime/import-fence.ts', "for (const n of ['_linkedBinding']) lock(p, n, stub);"),
  pos('ban:dlopen', 'src/model/x.ts', 'process.dlopen(module, file);'),
  neg('ban:dlopen', 'src/model/x.ts', 'const dlopened = false;'),
  pos('ban:loadEnvFile', 'src/model/x.ts', "process.loadEnvFile('C:\\\\x\\\\.env');"),
  pos('ban:loadEnvFile', 'src/model/x.ts', "const { loadEnvFile } = process;"),
  neg('ban:loadEnvFile', 'src/runtime/import-fence.ts', "lock(p, 'loadEnvFile', disabled('process.loadEnvFile'));"),
  neg('ban:loadEnvFile', 'src/model/x.ts', 'const envFile = loadEnv(file);'),
  pos('ban:_debugProcess', 'src/model/x.ts', 'process._debugProcess(pid);'),
  pos('ban:_debugProcess', 'src/model/x.ts', "const open = process['_debugProcess'];"),
  neg('ban:_debugProcess', 'src/runtime/import-fence.ts', "const DEBUG_POWERS = ['_debugProcess', '_debugEnd'];"),
  neg('ban:_debugProcess', 'src/model/x.ts', 'const debugProcessed = true;'),
  pos('ban:_debugEnd', 'src/model/x.ts', 'process._debugEnd();'),
  neg('ban:_debugEnd', 'src/runtime/import-fence.ts', "for (const name of ['_debugEnd']) lock(p, name, stub);"),
  neg('ban:_debugEnd', 'src/model/x.ts', 'const debugEnded = false;'),
  pos('ban:_getActiveHandles', 'src/model/x.ts', 'for (const h of process._getActiveHandles()) h.close();'),
  neg('ban:_getActiveHandles', 'src/runtime/import-fence.ts', "const DEBUG_POWERS = ['_getActiveHandles'];"),
  neg('ban:_getActiveHandles', 'src/model/x.ts', 'const kinds = process.getActiveResourcesInfo();'),
  pos('ban:_getActiveRequests', 'src/model/x.ts', 'const reqs = process._getActiveRequests();'),
  neg('ban:_getActiveRequests', 'src/runtime/import-fence.ts', "const DEBUG_POWERS = ['_getActiveRequests'];"),
  neg('ban:_getActiveRequests', 'src/model/x.ts', 'const reqs = activeRequests();'),
  pos('ban:undici.globalDispatcher', 'src/model/x.ts', "const d = globalThis[Symbol.for('undici.globalDispatcher.1')];"),
  pos('ban:undici.globalDispatcher', 'src/net/dsh-connect.ts', "const slot = Symbol.for('undici.globalDispatcher.2');"),
  neg('ban:undici.globalDispatcher', 'src/runtime/import-fence.ts', "const UNDICI_DISPATCHERS = [Symbol.for('undici.globalDispatcher.1')];"),
  neg('ban:undici.globalDispatcher', 'src/net/dsh-connect.ts', 'const r = await fetch(url, { dispatcher });'),
  pos('ban:undici.globalOrigin', 'src/model/x.ts', "globalThis[Symbol.for('undici.globalOrigin.1')] = new URL(base);"),
  neg('ban:undici.globalOrigin', 'src/runtime/import-fence.ts', "const UNDICI_ORIGIN = Symbol.for('undici.globalOrigin.1');"),
  neg('ban:undici.globalOrigin', 'src/net/dsh-connect.ts', 'const u = new URL(path, origin);'),
  pos('no-timers-in-lock', 'src/runtime/working.ts', 'setInterval(() => fence.writeAtomic(daemonJson, info), 10_000).unref();'),
  pos('no-timers-in-lock', 'src/runtime/lock.ts', 'const t = setTimeout(retry, 100);'),
  pos('no-timers-in-lock', 'src/runtime/lock.ts', "import { setTimeout as sleep } from 'node:timers/promises';"),
  neg('no-timers-in-lock', 'src/runtime/working.ts', 'fence.writeAtomic(daemonJson, encodeDaemonInfo(info));'),
  neg('no-timers-in-lock', 'src/os/spawn.ts', 'const timer = setTimeout(() => child.kill(), ms);'),
  pos('ban:process.report', 'src/model/x.ts', 'process.report.writeReport(p);'),
  pos('ban:process.report', 'src/model/x.ts', "process['report'].directory = d;"),
  pos('ban:process.report', 'src/model/x.ts', 'const { writeReport } = r;'),
  neg('ban:process.report', 'src/runtime/import-fence.ts', "lock(p, 'report', Object.freeze({ writeReport: stub }));"),
  neg('ban:process.report', 'src/model/source-report.ts', 'const report = buildReport(source);'),
  pos('ban:import-attributes', 'src/model/x.ts', "import cfg from './c.json' with { type: 'json' };"),
  pos('ban:import-attributes', 'src/model/x.ts', "const m = await import(u, { with: { type: 'json' } });"),
  pos('ban:import-attributes', 'src/model/x.ts', "import cfg from './c.json' assert { type: 'json' };"),
  neg('ban:import-attributes', 'src/fs/x.ts', 'const entries = list(dir, { withFileTypes: true });'),
  pos('ban:createRequire', 'src/model/x.ts', "const require = createRequire(import.meta.url);"),
  neg('ban:createRequire', 'src/model/x.ts', 'const requirement = create(Require);'),
  pos('ban:eval(', 'ui/app.js', 'eval(code);'),
  neg('ban:eval(', 'src/model/x.ts', 'const r = retrieval(code);'),
  pos('ban:new Function', 'src/model/x.ts', "const f = new Function('return 1');"),
  neg('ban:new Function', 'src/model/x.ts', 'const f = newFunction();'),
  pos('ban:eval: true', 'src/runtime/workers.ts', 'new Worker(src, {eval: true});'),
  pos('ban:eval: true', 'src/runtime/workers.ts', "new Worker(src, { 'eval': true });"),
  neg('ban:eval: true', 'src/runtime/workers.ts', 'new Worker(url, { eval: false });'),
  pos('ban:copyFile', 'src/sources/codex/state5-snapshot.ts', 'fs.copyFileSync(a, b);'),
  neg('ban:copyFile', 'src/sources/codex/state5-snapshot.ts', 'fence.writeAtomic(b, gate.readFile(a));'),
  pos('ban:cp(', 'src/model/x.ts', 'fs.cp(a, b);'),
  pos('ban:cp(', 'src/model/x.ts', 'cpSync(a, b);'),
  neg('ban:cp(', 'src/model/x.ts', 'const cpu = cpus();'),
  pos('ban:createWriteStream', 'src/model/x.ts', 'const s = fs.createWriteStream(p);'),
  neg('ban:createWriteStream', 'src/model/x.ts', 'const s = createReadableThing(p);'),
  pos('ban:truncate', 'src/model/x.ts', 'fs.ftruncateSync(fd, 0);'),
  neg('ban:truncate', 'src/model/x.ts', 'const short = text.slice(0, 2048);'),
  pos('ban:utimes', 'src/model/x.ts', 'fs.utimesSync(p, a, m);'),
  neg('ban:utimes', 'src/model/x.ts', 'const times = [a, m];'),
  pos('ban:symlink', 'src/model/x.ts', "fs.symlinkSync(a, b, 'junction');"),
  neg('ban:symlink', 'src/model/x.ts', 'if (st.isSymbolicLink()) removeLinkEntry(p);'),
  pos('ban:link(', 'src/model/x.ts', 'fs.link(a, b);'),
  pos('ban:link(', 'src/model/x.ts', 'linkSync(a, b);'),
  neg('ban:link(', 'src/model/x.ts', 'fs.unlinkSync(a); deepLink(b);'),
  pos('ban:shell: true', 'src/os/spawn.ts', "execFile(exe, argv, { shell: true });"),
  pos('ban:shell: true', 'src/os/spawn.ts', "spawn(exe, argv, { shell: 'cmd.exe' });"),
  neg('ban:shell: true', 'src/os/spawn.ts', 'spawn(exe, argv, { shell: false, windowsHide: true });'),
  pos('ban:cc-msg', 'src/sources/claude/registry.ts', "const pipe = '\\\\\\\\.\\\\pipe\\\\cc-msg-' + id;"),
  neg('ban:cc-msg', 'src/sources/claude/registry.ts', "const field = 'ccMessage';"),

  pos('dynamic-import-literal-only', 'src/model/x.ts', 'const m = await import(target);'),
  pos('dynamic-import-literal-only', 'src/model/x.ts', 'const m = await import(`./${name}.ts`);'),
  neg('dynamic-import-literal-only', 'src/model/x.ts', "const m = await import('./other.ts');"),
  neg('dynamic-import-literal-only', 'src/boot.ts', 'const main = await import(entry.href);'),
  neg('dynamic-import-literal-only', 'src/workers/bootstrap.ts', 'const mod = await import(c.href);'),
  pos('mkdtemp-only-in-write-fence', 'src/sources/codex/state5-snapshot.ts', 'const d = fs.mkdtempSync(p);'),
  neg('mkdtemp-only-in-write-fence', 'src/fs/write-fence.ts', 'const made = fs.mkdtempSync(win.join(parent, prefix));'),
  pos('fetch-only-in-dsh-connect', 'src/server/routes.ts', "await fetch('http://example.com/');"),
  pos('fetch-only-in-dsh-connect', 'src/model/x.ts', 'const f = fetch; await f(url);'),
  pos('fetch-only-in-dsh-connect', 'src/model/x.ts', 'Reflect.apply(globalThis.fetch, null, [url]);'),
  neg('fetch-only-in-dsh-connect', 'src/net/dsh-connect.ts', 'const r = await fetch(url, { redirect: "manual" });'),
  neg('fetch-only-in-dsh-connect', 'src/boot.ts', 'const ports: BootPorts = { fetch: globalThis.fetch };'),
  neg('fetch-only-in-dsh-connect', 'src/model/x.ts', 'prefetch(items);'),
  pos('ban:WebSocket/EventSource', 'src/net/dsh-connect.ts', 'const ws = new WebSocket(url);'),
  pos('ban:WebSocket/EventSource', 'src/model/x.ts', "const es = new globalThis.EventSource('http://127.0.0.1:1/');"),
  neg('ban:WebSocket/EventSource', 'src/runtime/import-fence.ts', "const NETWORK_GLOBALS = ['fetch', 'WebSocket', 'EventSource'];"),
  neg('ban:WebSocket/EventSource', 'ui/app.js', "const es = new EventSource('/api/events');"),
  neg('ban:WebSocket/EventSource', 'src/model/x.ts', 'const socketPath = pipeName(id);'),
  pos('ban:net.connect', 'src/model/x.ts', 'const s = net.connect(pipe);'),
  neg('ban:net.connect', 'src/model/x.ts', 'const s = net.createServer();'),
  pos('ban:createConnection', 'src/model/x.ts', 'const s = createConnection({ path: pipe });'),
  neg('ban:createConnection', 'src/model/x.ts', 'const c = createConfig();'),
  pos('ban:http.request', 'src/model/x.ts', 'http.request(url);'),
  pos('ban:http.request', 'src/model/x.ts', 'https.request(url);'),
  neg('ban:http.request', 'src/server/http.ts', 'server.on("request", handle);'),
  pos('ban:http.get', 'src/model/x.ts', 'http.get(url, cb);'),
  neg('ban:http.get', 'src/server/http.ts', 'routes.get(path);'),
  pos('ban:node:https', 'src/model/x.ts', "import * as https from 'node:https';"),
  pos('ban:node:https', 'src/model/x.ts', 'const h = require("https");'),
  neg('ban:node:https', 'src/net/dsh-connect.ts', "if (u.protocol !== 'http:') return null;"),
  pos('ban:agents --json', 'scripts/check-real-claude.ts', "run('claude agents --json');"),
  pos('ban:agents --json', 'src/os/spawn.ts', "execFile(claude, ['agents','--json']);"),
  pos('ban:agents --json', 'src/os/spawn.ts', 'execFile(claude, ["agents", "--json"]);'),
  neg('ban:agents --json', 'src/os/spawn.ts', "execFile(claude, ['agents', '--help']);"),
  neg('ban:agents --json', 'src/os/spawn.ts', "const flags = ['--json'];"),
  pos('no-spikes-import', 'src/model/x.ts', "import { walk } from '../../spikes/s1-dsh/frame-tail.mjs';"),
  neg('no-spikes-import', 'src/model/x.ts', "import { walk } from '../lib/zstd/frames.ts';"),
  pos('import-relative-code-only', 'src/model/x.ts', "import { x } from 'lodash';"),
  pos('import-relative-code-only', 'src/model/x.ts', "import cfg from './c.json' with { type: 'json' };"),
  pos('import-relative-code-only', 'src/model/x.ts', "export * from 'file:///C:/elsewhere/x.ts';"),
  pos('import-relative-code-only', 'src/model/x.ts', "const m = await import('data:text/javascript,export default 1');"),
  pos('import-relative-code-only', 'ui/app.js', "import { s } from '/shared/sanitize.js';"),
  neg('import-relative-code-only', 'src/model/x.ts', "import { a } from './a.ts';\nimport * as fs from 'node:fs';"),
  neg('import-relative-code-only', 'src/model/x.ts', "import type { AgentEvent } from '../../vendor/dsh-tui/src/agent/types.ts';"),
  neg('import-relative-code-only', 'ui/app.js', "import { s } from '../shared/sanitize.js';"),
  pos('vendor-type-only', 'src/model/symbols.ts', "import { AgentEvent } from '../../vendor/dsh-tui/src/agent/types.ts';"),
  pos('vendor-type-only', 'src/model/symbols.ts', "import { type AgentEvent } from '../../vendor/dsh-tui/src/agent/types.ts';"),
  neg('vendor-type-only', 'src/model/symbols.ts', "import type { AgentEvent } from '../../vendor/dsh-tui/src/agent/types.ts';"),

  pos('ui:innerHTML', 'ui/inbox.js', 'row.innerHTML = title;'),
  neg('ui:innerHTML', 'ui/inbox.js', 'row.textContent = title;'),
  pos('ui:outerHTML', 'ui/inbox.js', 'const h = row.outerHTML;'),
  neg('ui:outerHTML', 'ui/inbox.js', 'const h = row.outerText;'),
  pos('ui:insertAdjacentHTML', 'ui/inbox.js', "row.insertAdjacentHTML('beforeend', s);"),
  neg('ui:insertAdjacentHTML', 'ui/inbox.js', "row.insertAdjacentText('beforeend', s);"),
  pos('ui:document.write', 'ui/app.js', 'document.write(s);'),
  neg('ui:document.write', 'ui/app.js', 'document.title = s;'),
  pos('ui:fetch-relative-api-only', 'ui/app.js', "fetch('https://example.com/x');"),
  pos('ui:fetch-relative-api-only', 'ui/app.js', 'fetch(url);'),
  neg('ui:fetch-relative-api-only', 'ui/app.js', "fetch('/api/inbox', { method: 'POST' });"),
  neg('ui:innerHTML', 'src/model/x.ts', '// innerHTML is a ui/ rule only'),
  pos('vendor:no-dangerously', 'vendor/dsh-tui/src/backends/claude/options.ts', 'allowDangerouslySkipPermissions: true,'),
  neg('vendor:no-dangerously', 'vendor/dsh-tui/src/agent/types.ts', 'export type AgentEvent = { kind: string };'),

  pos('fs-write-only-in-write-fence', 'src/fs/read-gate.ts', 'fs.writeFileSync(p, data);'),
  pos('fs-write-only-in-write-fence', 'src/fs/harness-roots.ts', 'fs.renameSync(a, b);'),
  pos('fs-write-only-in-write-fence', 'src/fs/paths.ts', 'fs.rm(p, { recursive: true });'),
  neg('fs-write-only-in-write-fence', 'src/fs/write-fence.ts', 'fs.renameSync(tmp, p);'),
  neg('fs-write-only-in-write-fence', 'src/fs/read-gate.ts', 'const fd = this.#io.openSync(real, \'r\');'),
  pos('fs-open-only-in-gates', 'src/fs/harness-roots.ts', 'const text = fs.readFileSync(p);'),
  pos('fs-open-only-in-gates', 'src/fs/paths.ts', "const fd = fs.openSync(p, 'r');"),
  neg('fs-open-only-in-gates', 'src/fs/read-gate.ts', "const fd = fs.openSync(p, 'r');"),
  pos('fs-open-only-in-gates', 'src/fs/harness-roots.ts', 'const names = fs.readdirSync(dir);'),
  pos('fs-open-only-in-gates', 'src/fs/paths.ts', 'const d = fs.opendirSync(dir);'),
  neg('fs-open-only-in-gates', 'src/fs/harness-roots.ts', 'return gate.subdirs(dir);'),
  pos('read-gate-open-flag-r', 'src/fs/read-gate.ts', "const fd = fs.openSync(p, 'r+');"),
  pos('read-gate-open-flag-r', 'src/fs/read-gate.ts', 'const fd = fs.openSync(p, flags);'),
  neg('read-gate-open-flag-r', 'src/fs/read-gate.ts', "openSync: (p, _flags) => fs.openSync(p, 'r'),"),
  neg('read-gate-open-flag-r', 'src/fs/read-gate.ts', "openSync(p: string, flags: 'r'): number;"),

  pos('ban:process.kill', 'src/brakes/kill-tree.ts', 'process.kill(pid);'),
  pos('ban:process.kill', 'src/runtime/lock.ts', "process['kill'](pid, 'SIGTERM');"),
  pos('ban:process.kill', 'src/model/x.ts', 'const { kill } = process;'),
  pos('ban:process.kill', 'src/model/x.ts', 'const { pid, kill: k } = globalThis.process;'),
  pos('ban:process.kill', 'src/model/x.ts', "Reflect.get(process, 'kill')(pid);"),
  pos('ban:process.kill', 'src/model/x.ts', 'process._kill(pid, 15);'),
  // The runtime fence stubs process.kill for src/os/ too, so the scan does not let it through there.
  pos('ban:process.kill', 'src/os/procguard-client.ts', 'process.kill(helper.pid);'),
  pos('ban:process.kill', 'src/os/spawn.ts', "const { kill } = process;"),
  neg('ban:process.kill', 'src/os/spawn.ts', 'child.kill();'),
  neg('ban:process.kill', 'src/runtime/import-fence.ts', "for (const name of ['kill', '_kill']) lock(p, name, disabled(`process.${name}`));"),
  neg('ban:process.kill', 'src/brakes/kill-tree.ts', 'await procguard.killTree(plan);'),
  pos('kill-only-in-os', 'src/model/x.ts', 'const p = process; p.kill(pid);'),
  pos('kill-only-in-os', 'src/brakes/kill-tree.ts', 'agentChild.kill();'),
  pos('kill-only-in-os', 'scripts/check-real-dsh.ts', 'child.kill();'),
  neg('kill-only-in-os', 'src/os/spawn.ts', 'child.kill();'),
  neg('kill-only-in-os', 'src/os/procguard-client.ts', 'helper.kill();'),
  neg('kill-only-in-os', 'src/brakes/kill-tree.ts', 'await procguard.killTree(plan);'),
  neg('kill-only-in-os', 'scripts/test-stage.ts', 'agent.kill();'),

  pos('gate-construction-only-in-roots', 'src/sources/claude/roots.ts', 'const gate = new ReadGate({ roots: [], testDirs: [d] });'),
  pos('gate-construction-only-in-roots', 'src/store/db.ts', 'const fence = new WriteFence({ orchestraHome: "C:\\\\", harnessRoots: [] });'),
  pos('gate-construction-only-in-roots', 'src/model/x.ts', "import { ReadGate, ReadGateError } from '../fs/read-gate.ts';"),
  pos('gate-construction-only-in-roots', 'src/model/x.ts', "import * as rg from '../fs/read-gate.ts';\nconst g = new rg.ReadGate(cfg);"),
  pos('gate-construction-only-in-roots', 'src/model/x.ts', "const { WriteFence } = await import('../fs/write-fence.ts');"),
  pos('gate-construction-only-in-roots', 'src/model/x.ts', 'class Wide extends WriteFence {}'),
  pos('gate-construction-only-in-roots', 'src/model/x.ts', 'const g = createReadGate(cfg);'),
  pos('gate-construction-only-in-roots', 'src/model/x.ts', 'const g = Reflect.construct(ReadGate, [cfg]);'),
  pos('gate-construction-only-in-roots', 'src/model/x.ts', "import { SpawnGate } from '../os/spawn.ts';\nconst g = new SpawnGate({ systemRoot: sys, rules: ['whoami'], record });"),
  pos('gate-construction-only-in-roots', 'src/os/toast.ts', "const g = new SpawnGate({ systemRoot: sys, rules: ['powershell-toast'], record });"),
  pos('gate-construction-only-in-roots', 'src/runtime/integrity.ts', "import * as sp from '../os/spawn.ts';\nconst g = new sp.SpawnGate(cfg);"),
  pos('gate-construction-only-in-roots', 'src/fs/harness-roots.ts', 'export function other(): void {\n  const gate = new ReadGate({ roots: [] });\n}\n'),
  pos('gate-construction-only-in-roots', 'src/fs/harness-roots.ts', 'export function launcherRootFs(env: E): RootFs {\n  const fence = new WriteFence(cfg);\n}\n'),
  neg('gate-construction-only-in-roots', 'src/runtime/working.ts', 'const fence = new WriteFence({ orchestraHome: home, harnessRoots });'),
  neg('gate-construction-only-in-roots', 'src/main.ts', 'const gate = new ReadGate(cfg);'),
  neg('gate-construction-only-in-roots', 'src/main.ts', "const gate = new SpawnGate({ systemRoot: sys, rules: ['whoami'], record });"),
  neg('gate-construction-only-in-roots', 'src/fs/harness-roots.ts', 'export function launcherRootFs(env: E): RootFs {\n  const gate = new ReadGate({ roots, ...opts });\n  return gate;\n}\n'),
  neg('gate-construction-only-in-roots', 'src/runtime/data-dir.ts', "import type { WriteFence } from '../fs/write-fence.ts';\nexport function prepare(fence: WriteFence): void {}"),
  neg('gate-construction-only-in-roots', 'src/runtime/integrity.ts', "import type { RunResult, SpawnGate } from '../os/spawn.ts';\nimport { WHOAMI_ARGV } from '../os/spawn.ts';"),
  neg('gate-construction-only-in-roots', 'src/model/x.ts', "import { ReadGateError, type ReadGate } from '../fs/read-gate.ts';"),
  neg('gate-construction-only-in-roots', 'scripts/check-real-claude.ts', 'const gate = new ReadGate(productionConfig);'),

  pos('working-wiring-only-from-main', 'src/model/x.ts', "import { runWorking } from '../runtime/working.ts';\nawait runWorking(ctx);"),
  pos('working-wiring-only-from-main', 'src/runtime/startup.ts', "const { runWorking } = await import('./working.ts');"),
  pos('working-wiring-only-from-main', 'src/server/http.ts', "export { runWorking } from '../runtime/working.ts';"),
  neg('working-wiring-only-from-main', 'src/main.ts', "const { runWorking } = await import('./runtime/working.ts');"),
  neg('working-wiring-only-from-main', 'src/model/x.ts', "import type { WorkingOutcome } from '../runtime/working.ts';"),
  neg('working-wiring-only-from-main', 'scripts/test-stage.ts', "import { runWorking } from '../src/runtime/working.ts';"),

  pos('launcher-root-fs-only-in-roots', 'src/model/x.ts', "import { launcherRootFs } from '../fs/harness-roots.ts';\nconst rfs = launcherRootFs(fakeEnv, { io });"),
  pos('launcher-root-fs-only-in-roots', 'src/sources/claude/roots.ts', "import * as hr from '../../fs/harness-roots.ts';\nconst rfs = hr['launcher' + 'RootFs'](env);"),
  neg('launcher-root-fs-only-in-roots', 'src/main.ts', 'roots = computeHarnessRoots(env, launcherRootFs(env));'),
  neg('launcher-root-fs-only-in-roots', 'src/runtime/data-dir.ts', "import type { HarnessRoot } from '../fs/harness-roots.ts';"),
  neg('launcher-root-fs-only-in-roots', 'src/runtime/working.ts', "import { rootDenyList } from '../fs/harness-roots.ts';"),

  pos('ban:.constructor', 'src/model/x.ts', 'const G = gate.constructor;'),
  pos('ban:.constructor', 'src/model/x.ts', "const G = Object.getPrototypeOf(gate)['constructor'];"),
  pos('ban:.constructor', 'src/model/x.ts', "const G = Reflect.get(gate, 'constructor');"),
  pos('ban:.constructor', 'src/model/x.ts', 'const G = Reflect.get(Object.getPrototypeOf(gate), `constructor`);'),
  neg('ban:.constructor', 'src/model/x.ts', 'constructor(cfg: Config) { this.cfg = cfg; }'),
];

for (const c of CASES) {
  test(`${c.rule}: ${c.hit ? 'flags' : 'passes'} ${c.file}: ${c.text.replace(/\n/g, ' | ')}`, () => {
    const hits = scan(c.file, c.text).filter((h) => h.rule === c.rule);
    if (c.hit) assert.ok(hits.length > 0, `expected ${c.rule} to flag this`);
    else assert.deepEqual(hits, []);
  });
}

test('every rule has at least one positive and one negative example', () => {
  for (const rule of RULES) {
    assert.ok(CASES.some((c) => c.rule === rule.id && c.hit), `${rule.id} has no positive example`);
    assert.ok(CASES.some((c) => c.rule === rule.id && !c.hit), `${rule.id} has no negative example`);
  }
  const ids = new Set(RULES.map((r) => r.id));
  for (const c of CASES) assert.ok(ids.has(c.rule), `example for unknown rule ${c.rule}`);
  assert.equal(ids.size, RULES.length, 'rule ids are unique');
});

test('findImports reads every import form and keeps type-only imports apart', () => {
  const refs = findImports([
    "import type { A } from 'node:fs';",
    "import * as p from 'node:path';",
    "import {\n  x,\n  type Y,\n  z as w,\n} from 'node:os';",
    "export { q } from './q.ts';",
    "import './side.ts';",
    "await import('node:vm');",
    "require('node:net');",
  ].join('\n'));
  assert.deepEqual(refs.map((r) => [r.form, r.spec, r.typeOnly, r.names]), [
    ['static', 'node:fs', true, ['A']],
    ['static', 'node:path', false, null],
    ['static', 'node:os', false, ['x', 'z']],
    ['export', './q.ts', false, ['q']],
    ['side-effect', './side.ts', false, null],
    ['dynamic', 'node:vm', false, null],
    ['require', 'node:net', false, null],
  ]);
});

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs|cjs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('the repository passes every rule', () => {
  const files = SCANNED_DIRS.flatMap((d) => walk(path.join(repo, d)));
  assert.ok(files.some((f) => f.endsWith('write-fence.ts')), 'the scan saw src/');
  const hits = files.flatMap((f) => {
    const rel = path.relative(repo, f).split(path.sep).join('/');
    return EXEMPT_SCRIPTS.includes(rel) ? [] : scan(rel, fs.readFileSync(f, 'utf8'));
  });
  assert.deepEqual(hits, []);
});
