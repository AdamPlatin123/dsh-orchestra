import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Rule } from '../helpers/scan-rules.ts';
import { BUILTIN_ROWS } from '../../src/runtime/builtin-policy.ts';
import { GLOBAL_POWERS, PROCESS_POWERS } from '../../src/runtime/process-powers.ts';
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
  // Since step 2c only the minted modules import node:fs and node:child_process.
  pos('builtin-policy', 'src/fs/read-gate.ts', "import * as fs from 'node:fs';"),
  pos('builtin-policy', 'src/fs/write-fence.ts', "import { renameSync } from 'node:fs';"),
  pos('builtin-policy', 'src/fs/node-io.ts', "import * as fsp from 'node:fs/promises';"),
  pos('builtin-policy', 'src/os/spawn.ts', "import { execFile } from 'node:child_process';"),
  neg('builtin-policy', 'src/fs/node-io.ts', "import * as fs from 'node:fs';\nimport * as path from 'node:path';"),
  neg('builtin-policy', 'src/fs/read-gate.ts', "import type { Stats } from 'node:fs';\nimport * as path from 'node:path';"),
  neg('builtin-policy', 'src/model/inbox.ts', "import type { Stats } from 'node:fs';"),
  neg('builtin-policy', 'src/os/node-proc.ts', "import { spawn } from 'node:child_process';"),
  neg('builtin-policy', 'src/os/spawn.ts', "import type { ChildProcess } from 'node:child_process';"),
  neg('builtin-policy', 'scripts/test-stage.ts', "import * as fs from 'node:fs';"),

  pos('builtin-only-names', 'src/main.ts', "import * as os from 'node:os';"),
  pos('builtin-only-names', 'src/main.ts', "import { homedir, userInfo } from 'node:os';"),
  pos('builtin-only-names', 'src/runtime/lock.ts', "import { createServer, connect } from 'node:net';"),
  neg('builtin-only-names', 'src/main.ts', "import { homedir, totalmem } from 'node:os';"),
  // write-fence.ts's node:os row was stale (it imports only node:path and node:crypto) and was
  // removed in the fixer pass, so node:os is now not-allowed-for-module there.
  pos('builtin-policy', 'src/fs/write-fence.ts', "import { tmpdir } from 'node:os';"),
  neg('builtin-only-names', 'src/runtime/lock.ts', "import { createServer, type Server } from 'node:net';"),
  pos('builtin-only-names', 'src/server/http.ts', "import { createServer, request } from 'node:http';"),
  pos('builtin-only-names', 'src/server/http.ts', "import * as http from 'node:http';"),
  neg('builtin-only-names', 'src/server/http.ts', "import { createServer, type IncomingMessage } from 'node:http';"),

  // The process and global rules come from src/runtime/process-powers.ts (step 2c); the table file is
  // the one they skip, so import-fence.ts, which no longer names any key, gets no exemption.
  pos('process-power-member', 'src/model/x.ts', "const cp = process.getBuiltinModule('node:child_process');"),
  neg('process-power-member', 'src/runtime/import-fence.ts', "lock(p, 'getBuiltinModule', wrapper);"),
  neg('process-power-member', 'src/model/x.ts', 'const builtins = DEFAULT_BUILTINS;'),
  pos('process-power-member', 'src/model/x.ts', "process.binding('fs');"),
  pos('process-power-member', 'src/model/x.ts', "process['binding']('fs');"),
  neg('process-power-member', 'src/model/x.ts', 'const binding = keyBinding(event);'),
  pos('process-power-member', 'src/model/x.ts', "process._linkedBinding('x');"),
  neg('process-power-member', 'src/runtime/import-fence.ts', "for (const n of ['_linkedBinding']) lock(p, n, stub);"),
  pos('process-power-member', 'src/model/x.ts', 'process.dlopen(module, file);'),
  neg('process-power-member', 'src/model/x.ts', 'const dlopened = false;'),
  pos('process-power-member', 'src/model/x.ts', "process.loadEnvFile('C:\\\\x\\\\.env');"),
  pos('process-power-member', 'src/model/x.ts', "const { loadEnvFile } = process;"),
  pos('process-power-member', 'src/runtime/import-fence.ts', "lock(p, 'loadEnvFile', disabled('process.loadEnvFile'));"),
  neg('process-power-member', 'src/runtime/process-powers.ts', "lock('loadEnvFile', 'reads a file into process.loadEnvFile past the read gate'),"),
  neg('process-power-member', 'src/model/x.ts', 'const envFile = loadEnv(file);'),
  pos('process-power-member', 'src/model/x.ts', 'process._debugProcess(pid);'),
  pos('process-power-member', 'src/model/x.ts', "const open = process['_debugProcess'];"),
  pos('process-power-member', 'src/model/x.ts', 'const open = process?._debugProcess;'),
  neg('process-power-member', 'src/runtime/import-fence.ts', "const DEBUG_POWERS = ['_debugProcess', '_debugEnd'];"),
  neg('process-power-member', 'src/model/x.ts', 'const debugProcessed = true;'),
  pos('process-power-member', 'src/model/x.ts', 'process._debugEnd();'),
  neg('process-power-member', 'src/runtime/import-fence.ts', "for (const name of ['_debugEnd']) lock(p, name, stub);"),
  neg('process-power-member', 'src/model/x.ts', 'const debugEnded = false;'),
  pos('process-power-member', 'src/model/x.ts', 'for (const h of process._getActiveHandles()) h.close();'),
  neg('process-power-member', 'src/model/x.ts', 'const kinds = process.getActiveResourcesInfo();'),
  pos('process-power-member', 'src/model/x.ts', 'const reqs = process._getActiveRequests();'),
  neg('process-power-member', 'src/model/x.ts', 'const reqs = activeRequests();'),
  pos('process-power-member', 'src/model/x.ts', 'process.execve(exe, argv);'),
  pos('process-power-member', 'src/model/x.ts', 'process.chdir(dir);'),
  pos('process-power-member', 'src/model/x.ts', 'process.abort();'),
  pos('process-power-member', 'src/model/x.ts', 'process.umask(0o222);'),
  pos('process-power-member', 'src/model/x.ts', 'process.setUncaughtExceptionCaptureCallback(() => {});'),
  // Member access only: the same names as methods of other objects pass, and kept keys pass.
  neg('process-power-member', 'src/os/spawn.ts', 'child.kill();'),
  neg('process-power-member', 'src/model/x.ts', 'controller.abort();'),
  neg('process-power-member', 'src/model/x.ts', 'timer.unref();'),
  // Finding N1: process.exit is a lock entry and process.reallyExit a mint boot.ts keeps, so neither is
  // a kept key any more. This example used to be a negative (exit was a pinned keep entry, and boot.ts
  // ended through it); boot.ts now ends through the reallyExit it took, and no module, boot.ts
  // included, may call process.exit.
  pos('process-power-member', 'src/boot.ts', "process.stderr.write(line, () => process.exit(EXIT.crashed));"),
  pos('process-power-member', 'src/model/x.ts', 'process.exit(0);'),
  pos('process-power-member', 'src/model/x.ts', 'process.reallyExit(0);'),
  pos('process-power-member', 'src/runtime/working.ts', "const end = process['reallyExit'];"),
  neg('process-power-member', 'src/boot.ts', 'const reallyExit: (code: number) => void = process.reallyExit;'),
  neg('process-power-member', 'src/model/x.ts', 'const code = endCode(exit, reallyExitCode);'),
  neg('process-power-member', 'src/model/x.ts', 'const { pid, argv } = process;'),
  // The two exit levers outside the table: process.exitCode and the exit-event listeners, boot.ts only.
  pos('process-exit-only-in-boot', 'src/model/x.ts', "process.on('exit', () => { process.exitCode = 0; });"),
  pos('process-exit-only-in-boot', 'src/model/x.ts', 'process.exitCode = 0;'),
  pos('process-exit-only-in-boot', 'src/runtime/working.ts', 'process.exitCode ??= 0;'),
  pos('process-exit-only-in-boot', 'src/model/x.ts', "process['exitCode'] = 0;"),
  pos('process-exit-only-in-boot', 'src/model/x.ts', 'process.exitCode++;'),
  pos('process-exit-only-in-boot', 'src/model/x.ts', '--process.exitCode;'),
  pos('process-exit-only-in-boot', 'src/model/x.ts', "Reflect.set(process, 'exitCode', 0);"),
  pos('process-exit-only-in-boot', 'src/model/x.ts', "Object.defineProperty(globalThis.process, 'exitCode', { value: 0 });"),
  pos('process-exit-only-in-boot', 'src/main.ts', "process.once('beforeExit', flush);"),
  pos('process-exit-only-in-boot', 'shared/x.js', 'process.prependListener("exit", f);'),
  pos('process-exit-only-in-boot', 'src/model/x.ts', "process['addListener']('exit', f);"),
  neg('process-exit-only-in-boot', 'src/boot.ts', 'process.exitCode = code;'),
  neg('process-exit-only-in-boot', 'src/model/x.ts', 'const was = process.exitCode;'),
  neg('process-exit-only-in-boot', 'src/model/x.ts', 'if (process.exitCode === 0) note();'),
  neg('process-exit-only-in-boot', 'src/model/x.ts', 'if (process.exitCode >= 20) note();'),
  neg('process-exit-only-in-boot', 'src/os/spawn.ts', "child.once('exit', onExit);"),
  neg('process-exit-only-in-boot', 'src/runtime/working.ts', "process.on('SIGINT', stop);"),
  // shared/frozen.js names compile to give each frozen RegExp its own stub; nobody else names it.
  pos('ban:RegExp-compile', 'src/server/x.ts', "CSRF_RE.compile('^.*$');"),
  pos('ban:RegExp-compile', 'src/model/x.ts', "RegExp.prototype.compile.call(ID_RE, '.*');"),
  pos('ban:RegExp-compile', 'shared/protocol.js', "ID_RE['compile']('.*');"),
  pos('ban:RegExp-compile', 'ui/app.js', 'const { compile } = RegExp.prototype;'),
  neg('ban:RegExp-compile', 'shared/frozen.js', "Object.defineProperty(v, 'compile', { value: compileDisabled });"),
  neg('ban:RegExp-compile', 'src/model/x.ts', 'const compiled = compileShape(shape);'),
  neg('ban:RegExp-compile', 'src/os/spawn.ts', '/** The one file csc may compile. */'),
  pos('global-power-symbol', 'src/model/x.ts', "const d = globalThis[Symbol.for('undici.globalDispatcher.1')];"),
  pos('global-power-symbol', 'src/net/dsh-connect.ts', "const slot = Symbol.for('undici.globalDispatcher.2');"),
  pos('global-power-symbol', 'src/runtime/import-fence.ts', "const UNDICI_DISPATCHERS = [Symbol.for('undici.globalDispatcher.1')];"),
  neg('global-power-symbol', 'src/runtime/process-powers.ts', "lock('Symbol(undici.globalDispatcher.1)', 'undici\\'s global dispatcher slot', { stub: 'dead-dispatcher' }),"),
  neg('global-power-symbol', 'src/net/dsh-connect.ts', 'const r = await fetch(url, { dispatcher });'),
  pos('global-power-symbol', 'src/model/x.ts', "globalThis[Symbol.for('undici.globalOrigin.1')] = new URL(base);"),
  neg('global-power-symbol', 'src/runtime/process-powers.ts', "lock('Symbol(undici.globalOrigin.1)', 'the base of every relative URL', { stub: 'empty' }),"),
  neg('global-power-symbol', 'src/net/dsh-connect.ts', 'const u = new URL(path, origin);'),
  pos('no-timers-in-lock', 'src/runtime/working.ts', 'setInterval(() => fence.writeAtomic(daemonJson, info), 10_000).unref();'),
  pos('no-timers-in-lock', 'src/runtime/lock.ts', 'const t = setTimeout(retry, 100);'),
  pos('no-timers-in-lock', 'src/runtime/lock.ts', "import { setTimeout as sleep } from 'node:timers/promises';"),
  neg('no-timers-in-lock', 'src/runtime/working.ts', 'fence.writeAtomic(daemonJson, encodeDaemonInfo(info));'),
  neg('no-timers-in-lock', 'src/os/spawn.ts', 'const timer = setTimeout(() => child.kill(), ms);'),
  pos('process-power-member', 'src/model/x.ts', 'process.report.writeReport(p);'),
  pos('process-power-member', 'src/model/x.ts', "process['report'].directory = d;"),
  // A bare name is never matched (step 2c): `r` could only be an alias of process.report, whose
  // writeReport the import fence locks for every spelling.
  neg('process-power-member', 'src/model/x.ts', 'const { writeReport } = r;'),
  neg('process-power-member', 'src/runtime/import-fence.ts', "lock(p, 'report', Object.freeze({ writeReport: stub }));"),
  neg('process-power-member', 'src/model/source-report.ts', 'const report = buildReport(source);'),
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
  pos('ban:eval: true', 'src/workers/bootstrap.ts', 'new Worker(code, { eval: true });'),
  neg('ban:eval: true', 'src/runtime/workers.ts', 'new Worker(url, { eval: false });'),
  // Narrowed to the modules that can import node:worker_threads; elsewhere there is no Worker to pass it to.
  neg('ban:eval: true', 'src/model/x.ts', 'const opts = { eval: true };'),
  // One table over the modules that can import node:fs (only src/fs/node-io.ts since step 2c).
  pos('fs-name-bans', 'src/fs/node-io.ts', 'fs.copyFileSync(a, b);'),
  neg('fs-name-bans', 'src/sources/codex/state5-snapshot.ts', 'fence.writeAtomic(b, gate.readFile(a));'),
  pos('fs-name-bans', 'src/fs/node-io.ts', 'fs.cp(a, b);'),
  pos('fs-name-bans', 'src/fs/node-io.ts', 'cpSync(a, b);'),
  neg('fs-name-bans', 'src/fs/node-io.ts', 'const cpu = cpus();'),
  pos('fs-name-bans', 'src/fs/node-io.ts', 'const s = fs.createWriteStream(p);'),
  neg('fs-name-bans', 'src/fs/node-io.ts', 'const s = createReadableThing(p);'),
  pos('fs-name-bans', 'src/fs/node-io.ts', 'fs.truncateSync(p, 0);'),
  pos('fs-name-bans', 'src/fs/node-io.ts', 'truncate: (p: string) => fs.truncate(p, 0, () => {}),'),
  neg('fs-name-bans', 'src/fs/node-io.ts', 'const short = text.slice(0, 2048);'),
  // ftruncate is allowed in node-io.ts (the only file the rule applies to): step 3 truncates the
  // journal through the write fence's io. The write-fence.ts negative that used to sit here never
  // exercised the pattern (holdsFs is false there), so the node-io.ts negative is the real check.
  neg('fs-name-bans', 'src/fs/node-io.ts', 'ftruncateSync: (fd: number, length: number) => fs.ftruncateSync(fd, length),'),
  neg('fs-name-bans', 'src/fs/node-io.ts', 'const entry = { truncated: true };'),
  pos('fs-name-bans', 'src/fs/node-io.ts', 'fs.utimesSync(p, a, m);'),
  neg('fs-name-bans', 'src/fs/node-io.ts', 'const times = [a, m];'),
  pos('fs-name-bans', 'src/fs/node-io.ts', "fs.symlinkSync(a, b, 'junction');"),
  neg('fs-name-bans', 'src/fs/node-io.ts', 'if (st.isSymbolicLink()) removeLinkEntry(p);'),
  pos('fs-name-bans', 'src/fs/node-io.ts', 'fs.link(a, b);'),
  pos('fs-name-bans', 'src/fs/node-io.ts', 'linkSync(a, b);'),
  neg('fs-name-bans', 'src/fs/node-io.ts', 'fs.unlinkSync(a); deepLink(b);'),
  // Outside node-io.ts the same calls need node:fs first, which the builtin-policy rule flags.
  neg('fs-name-bans', 'src/model/x.ts', 'fs.copyFileSync(a, b);'),
  pos('builtin-policy', 'src/sources/codex/state5-snapshot.ts', "import * as fs from 'node:fs';\nfs.copyFileSync(a, b);"),
  pos('builtin-policy', 'src/fs/read-gate.ts', "import { ftruncateSync } from 'node:fs';\nftruncateSync(fd, 0);"),
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
  neg('mkdtemp-only-in-write-fence', 'src/fs/write-fence.ts', 'const made = this.#io.mkdtempSync(win.join(parent, prefix));'),
  neg('mkdtemp-only-in-write-fence', 'src/fs/node-io.ts', 'mkdtempSync: (prefix: string) => fs.mkdtempSync(prefix, MKDTEMP),'),
  pos('global-power-name', 'src/server/routes.ts', "await fetch('http://example.com/');"),
  pos('global-power-name', 'src/model/x.ts', 'const f = fetch; await f(url);'),
  pos('global-power-name', 'src/model/x.ts', 'Reflect.apply(globalThis.fetch, null, [url]);'),
  neg('global-power-name', 'src/net/dsh-connect.ts', 'const r = await fetch(url, { redirect: "manual" });'),
  neg('global-power-name', 'src/boot.ts', 'const ports: BootPorts = { fetch: globalThis.fetch };'),
  neg('global-power-name', 'src/model/x.ts', 'prefetch(items);'),
  pos('global-power-name', 'src/net/dsh-connect.ts', 'const ws = new WebSocket(url);'),
  pos('global-power-name', 'src/boot.ts', 'const ws = new WebSocket(url);'),
  pos('global-power-name', 'src/model/x.ts', "const es = new globalThis.EventSource('http://127.0.0.1:1/');"),
  pos('global-power-name', 'src/model/x.ts', "localStorage.setItem('k', v);"),
  pos('global-power-name', 'src/runtime/import-fence.ts', "const NETWORK_GLOBALS = ['fetch', 'WebSocket', 'EventSource'];"),
  neg('global-power-name', 'src/runtime/process-powers.ts', "lock('WebSocket', 'the network; no module needs it'),"),
  neg('global-power-name', 'ui/app.js', "const es = new EventSource('/api/events');"),
  neg('global-power-name', 'src/model/x.ts', 'const socketPath = pipeName(id);'),
  // The five network name bans went in step 2c: test 'rules dropped or narrowed in step 2c' shows which defense stops each bad sample.
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
  neg('fs-write-only-in-write-fence', 'src/fs/node-io.ts', 'renameSync: (from: string, to: string) => fs.renameSync(from, to),'),
  pos('fs-write-only-in-write-fence', 'src/fs/harness-roots.ts', 'this.#io.unlinkSync(p);'),
  pos('fs-open-only-in-gates', 'src/fs/harness-roots.ts', 'const text = fs.readFileSync(p);'),
  pos('fs-open-only-in-gates', 'src/fs/paths.ts', "const fd = fs.openSync(p, 'r');"),
  neg('fs-open-only-in-gates', 'src/fs/read-gate.ts', "const fd = fs.openSync(p, 'r');"),
  pos('fs-open-only-in-gates', 'src/fs/harness-roots.ts', 'const names = fs.readdirSync(dir);'),
  pos('fs-open-only-in-gates', 'src/fs/paths.ts', 'const d = fs.opendirSync(dir);'),
  neg('fs-open-only-in-gates', 'src/fs/harness-roots.ts', 'return gate.subdirs(dir);'),
  neg('fs-open-only-in-gates', 'src/fs/node-io.ts', "openSync: (p: string, _flags: 'r') => fs.openSync(p, 'r'),"),
  pos('read-gate-open-flag-r', 'src/fs/read-gate.ts', "const fd = fs.openSync(p, 'r+');"),
  pos('read-gate-open-flag-r', 'src/fs/read-gate.ts', 'const fd = fs.openSync(p, flags);'),
  neg('read-gate-open-flag-r', 'src/fs/read-gate.ts', "openSync: (p, _flags) => fs.openSync(p, 'r'),"),
  neg('read-gate-open-flag-r', 'src/fs/read-gate.ts', "openSync(p: string, flags: 'r'): number;"),

  pos('node-io-read-io-reads-only', 'src/fs/node-io.ts', "const READ_IO: ReadIo = opts({\n  openSync: (p: string) => fs.openSync(p, 'r+'),\n});\n"),
  pos('node-io-read-io-reads-only', 'src/fs/node-io.ts', "const READ_IO: ReadIo = opts({\n  closeSync: (fd: number) => { fs.fsyncSync(fd); fs.closeSync(fd); },\n});\n"),
  pos('node-io-read-io-reads-only', 'src/fs/node-io.ts', "const READ_IO = { ...WRITE_IO, renameSync: (a: string, b: string) => fs.renameSync(a, b) };\n}\n"),
  pos('node-io-read-io-reads-only', 'src/fs/node-io.ts', "const IO: ReadIo = opts({});\n"),
  neg('node-io-read-io-reads-only', 'src/fs/node-io.ts', "const READ_IO: ReadIo = opts({\n  openSync: (p: string, _flags: 'r') => fs.openSync(p, 'r'),\n});\n\nconst WRITE_IO: WriteIo = opts({\n  renameSync: (a: string, b: string) => fs.renameSync(a, b),\n});\n"),
  neg('node-io-read-io-reads-only', 'src/fs/read-gate.ts', 'const READ_IO = { writeSync: (fd) => fs.writeSync(fd) };'),

  pos('process-power-member', 'src/brakes/kill-tree.ts', 'process.kill(pid);'),
  pos('process-power-member', 'src/runtime/lock.ts', "process['kill'](pid, 'SIGTERM');"),
  pos('process-power-member', 'src/model/x.ts', 'const { kill } = process;'),
  pos('process-power-member', 'src/model/x.ts', 'const { pid, kill: k } = globalThis.process;'),
  pos('process-power-member', 'src/model/x.ts', "Reflect.get(process, 'kill')(pid);"),
  pos('process-power-member', 'src/model/x.ts', 'process._kill(pid, 15);'),
  // The runtime fence stubs process.kill for src/os/ too, so the scan does not let it through there.
  pos('process-power-member', 'src/os/procguard-client.ts', 'process.kill(helper.pid);'),
  pos('process-power-member', 'src/os/spawn.ts', "const { kill } = process;"),
  neg('process-power-member', 'src/runtime/import-fence.ts', "for (const name of ['kill', '_kill']) lock(p, name, disabled(`process.${name}`));"),
  neg('process-power-member', 'src/brakes/kill-tree.ts', 'await procguard.killTree(plan);'),
  pos('kill-only-in-os', 'src/model/x.ts', 'const p = process; p.kill(pid);'),
  // import-fence.ts no longer names kill (the process-powers table drives the fence), so it lost its
  // exemption: a .kill( there is now flagged like any non-os module.
  pos('kill-only-in-os', 'src/runtime/import-fence.ts', 'child.kill();'),
  pos('kill-only-in-os', 'src/brakes/kill-tree.ts', 'agentChild.kill();'),
  pos('kill-only-in-os', 'scripts/check-real-dsh.ts', 'child.kill();'),
  neg('kill-only-in-os', 'src/os/spawn.ts', 'child.kill();'),
  neg('kill-only-in-os', 'src/os/procguard-client.ts', 'helper.kill();'),
  neg('kill-only-in-os', 'src/brakes/kill-tree.ts', 'await procguard.killTree(plan);'),
  neg('kill-only-in-os', 'scripts/test-stage.ts', 'agent.kill();'),


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

  pos('minted-import-only-in-boot', 'src/main.ts', "import { makeReadGate } from './fs/node-io.ts';"),
  pos('minted-import-only-in-boot', 'src/runtime/log.ts', "import * as io from '../fs/node-io.ts';"),
  pos('minted-import-only-in-boot', 'src/runtime/working.ts', "const { makeSpawnGate } = await import('../os/node-proc.ts');"),
  pos('minted-import-only-in-boot', 'src/runtime/features.ts', "export { realpath } from '../fs/NODE-IO.ts';"),
  pos('minted-import-only-in-boot', 'scripts/check-real-claude.ts', "import { makeReadGate } from '../src/fs/node-io.ts';"),
  neg('minted-import-only-in-boot', 'src/boot.ts', "import { makeReadGate, makeWriteFence, realpath } from './fs/node-io.ts';\nimport { makeSpawnGate } from './os/node-proc.ts';"),
  neg('minted-import-only-in-boot', 'src/main.ts', "import type { ReadGateSpec } from './fs/node-io.ts';"),
  neg('minted-import-only-in-boot', 'src/runtime/working.ts', "import { ReadGateError } from '../fs/read-gate.ts';"),
  neg('minted-import-only-in-boot', 'scripts/test-stage.ts', "import { makeReadGate } from '../src/fs/node-io.ts';"),

  // gate-factory-only-in-roots: the real io is handed out by the factories, so only the composition
  // roots may name them; in harness-roots.ts only the LauncherFsPorts type and launcherRootFs.
  pos('gate-factory-only-in-roots', 'src/sources/claude/roots.ts', "const gate = ctx.makeReadGate({ roots: [{ kind: 'claude', path: 'C:\\\\', real: 'C:\\\\' }] });"),
  pos('gate-factory-only-in-roots', 'src/model/x.ts', 'const g = makeSpawnGate(spec);'),
  pos('gate-factory-only-in-roots', 'src/model/x.ts', 'const { makeWriteFence } = ports;'),
  pos('gate-factory-only-in-roots', 'src/fs/harness-roots.ts', 'export function other(env: E, ports: P): void {\n  const g = ports.makeReadGate({ roots: [] });\n}\n'),
  neg('gate-factory-only-in-roots', 'src/main.ts', "const gate = d.makeSpawnGate({ systemRoot: sys, rules: ['whoami'] });"),
  neg('gate-factory-only-in-roots', 'src/runtime/working.ts', 'const fence = await ctx.makeWriteFence({ orchestraHome: home, harnessRoots });'),
  neg('gate-factory-only-in-roots', 'src/fs/harness-roots.ts', 'export function launcherRootFs(env: E, ports: P): RootFs {\n  const gate = ports.makeReadGate({ roots });\n  return gate;\n}\n'),
  neg('gate-factory-only-in-roots', 'src/fs/harness-roots.ts', 'export type LauncherFsPorts = {\n  makeReadGate(spec: Spec): ReadGate;\n};\n'),
  // Finding F7: the names are words banned wherever they stand outside the roots, comments included (this
  // was a negative example before; the comment in spawn.ts now names "node-proc.ts's gate factory").
  pos('gate-factory-only-in-roots', 'src/os/spawn.ts', '// reaches a gate only through makeSpawnGate: a gate built anywhere else'),
  neg('gate-factory-only-in-roots', 'src/os/spawn.ts', "// reaches a gate only through node-proc.ts's gate factory: a gate built anywhere else"),
  pos('gate-factory-only-in-roots', 'src/model/x.ts', "const g = ports['makeSpawnGate'](spec);"),
  pos('gate-factory-only-in-roots', 'src/model/x.ts', "const g = Reflect.get(ports, 'makeReadGate')(spec);"),
  pos('gate-factory-only-in-roots', 'src/model/x.ts', 'export function f({ makeReadGate: mk }: P) { return mk(spec); }'),
  neg('gate-factory-only-in-roots', 'src/model/x.ts', 'const g = ports.readGate; const made = makeReadGateLike(spec);'),
  // Step 3: the node:sqlite mint's factory is a gate factory too.
  pos('gate-factory-only-in-roots', 'src/store/store.ts', 'const opener = await deps.makeDbOpener({ fence });'),
  pos('gate-factory-only-in-roots', 'src/model/x.ts', 'const { makeDbOpener } = ports;'),
  neg('gate-factory-only-in-roots', 'src/runtime/working.ts', 'const opener = await ctx.makeDbOpener({ fence });'),
  neg('gate-factory-only-in-roots', 'src/store/node-sqlite.ts', 'export async function makeDbOpener(spec: DbOpenerSpec): Promise<DbOpener> {'),
  pos('minted-import-only-in-boot', 'src/runtime/working.ts', "import { makeDbOpener } from '../store/node-sqlite.ts';"),
  pos('minted-import-only-in-boot', 'src/store/db.ts', "const m = await import('./node-sqlite.ts');"),
  neg('minted-import-only-in-boot', 'src/boot.ts', "import { makeDbOpener } from './store/node-sqlite.ts';"),
  neg('minted-import-only-in-boot', 'src/runtime/working.ts', "import type { DbOpener } from '../store/db.ts';"),
  pos('builtin-policy', 'src/store/db.ts', "import { DatabaseSync } from 'node:sqlite';"),
  pos('builtin-policy', 'src/store/store.ts', "const s = await import('node:sqlite');"),
  neg('builtin-policy', 'src/store/node-sqlite.ts', "const s = await import('node:sqlite');"),
  neg('builtin-policy', 'src/store/db.ts', "import type { DatabaseSync } from 'node:sqlite';"),

  // sqlite-surface-bans: node-sqlite.ts hands out exec, prepare and the authorizer only.
  pos('sqlite-surface-bans', 'src/store/node-sqlite.ts', 'const copy = sqlite.backup(db, target);'),
  pos('sqlite-surface-bans', 'src/store/node-sqlite.ts', 'const s = db.createSession();'),
  pos('sqlite-surface-bans', 'src/store/node-sqlite.ts', 'db.applyChangeset(buf);'),
  pos('sqlite-surface-bans', 'src/store/node-sqlite.ts', 'db.enableLoadExtension(true); db.loadExtension(p);'),
  pos('sqlite-surface-bans', 'src/store/node-sqlite.ts', 'const bytes = db.serialize();'),
  pos('sqlite-surface-bans', 'src/store/node-sqlite.ts', 'db.function(\'f\', () => 1);'),
  pos('sqlite-surface-bans', 'src/store/node-sqlite.ts', "db.aggregate('a', { start: 0, step: (a) => a });"),
  pos('sqlite-surface-bans', 'src/store/node-sqlite.ts', 'const tags = db.createTagStore();'),
  pos('sqlite-surface-bans', 'src/store/node-sqlite.ts', 'db.enableDefensive(false);'),
  neg('sqlite-surface-bans', 'src/store/node-sqlite.ts', "exec: (sql: string) => { db.exec(String(sql)); },\nprepare: (sql: string) => statementOf(db.prepare(String(sql))),"),
  // Only the module that can import node:sqlite: elsewhere there is nothing to call them on.
  neg('sqlite-surface-bans', 'src/store/db.ts', '// a backup of the database'),

  // sql-text-literal-only: fixed SQL text with positional parameters.
  pos('sql-text-literal-only', 'src/store/rebuild.ts', 'db.all(`SELECT * FROM ${table} ORDER BY id`);'),
  pos('sql-text-literal-only', 'src/store/x.ts', 'const q = `DELETE FROM item WHERE id = \'${id}\'`;'),
  pos('sql-text-literal-only', 'src/store/x.ts', 'db.run(`update item set state = ${s}`);'),
  pos('sql-text-literal-only', 'src/store/x.ts', "db.get('SELECT * FROM item WHERE id = ' + id);"),
  pos('sql-text-literal-only', 'src/model/x.ts', "const sql = base + ' WHERE kind = ?';"),
  neg('sql-text-literal-only', 'src/store/rebuild.ts', "db.run('UPDATE inbox_item SET state = ?, rev = ? WHERE id = ?', to, rev, id);"),
  neg('sql-text-literal-only', 'src/store/x.ts', 'const m = `${entity} ${id} does not exist`;'),
  neg('sql-text-literal-only', 'src/store/x.ts', "db.exec(`CREATE TABLE t (\n  a INTEGER\n) STRICT`);"),

  // node-io-append-existing-flag: the flag must open for append without creating (no O_CREAT).
  pos('node-io-append-existing-flag', 'src/fs/node-io.ts', "const OPEN_FLAGS = bag({ wx: 'wx', ax: 'ax', 'append-existing': 'a' });"),
  pos('node-io-append-existing-flag', 'src/fs/node-io.ts', "const OPEN_FLAGS = bag({ 'append-existing': fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT });"),
  neg('node-io-append-existing-flag', 'src/fs/node-io.ts', "const OPEN_FLAGS = bag({ wx: 'wx', ax: 'ax', 'append-existing': fs.constants.O_WRONLY | fs.constants.O_APPEND });"),
  // Finding F8: the value runs to the next comma at depth 0, across lines, and the key is set once.
  pos('node-io-append-existing-flag', 'src/fs/node-io.ts', "const OPEN_FLAGS = bag({\n  'append-existing': fs.constants.O_WRONLY | fs.constants.O_APPEND\n    | fs.constants.O_CREAT,\n});"),
  pos('node-io-append-existing-flag', 'src/fs/node-io.ts', "const OPEN_FLAGS = bag({ 'append-existing': fs.constants.O_WRONLY | fs.constants.O_APPEND, 'append-existing': 'a' });"),
  neg('node-io-append-existing-flag', 'src/fs/node-io.ts', "const OPEN_FLAGS = bag({\n  'append-existing': fs.constants.O_WRONLY\n    | fs.constants.O_APPEND,\n  ax: 'ax',\n});"),
  pos('node-io-write-existing-flag', 'src/fs/node-io.ts', "const OPEN_FLAGS = bag({ 'write-existing': fs.constants.O_WRONLY, 'write-existing': 'w' });"),
  // node-io-write-existing-flag: the journal's cut opens for writing in place, never creating or emptying.
  pos('node-io-write-existing-flag', 'src/fs/node-io.ts', "const OPEN_FLAGS = bag({ 'write-existing': 'w' });"),
  pos('node-io-write-existing-flag', 'src/fs/node-io.ts', "const OPEN_FLAGS = bag({ 'write-existing': fs.constants.O_WRONLY | fs.constants.O_TRUNC });"),
  pos('node-io-write-existing-flag', 'src/fs/node-io.ts', "const OPEN_FLAGS = bag({ 'write-existing': fs.constants.O_WRONLY | fs.constants.O_CREAT });"),
  pos('node-io-write-existing-flag', 'src/fs/node-io.ts', "const OPEN_FLAGS = bag({ wx: 'wx' });"),
  neg('node-io-write-existing-flag', 'src/fs/node-io.ts', "const OPEN_FLAGS = bag({ 'append-existing': fs.constants.O_WRONLY | fs.constants.O_APPEND, 'write-existing': fs.constants.O_WRONLY });"),

  // ban:.constructor: an instance's .constructor reaches its class (process.stdout -> net.Socket -> the network).
  pos('ban:.constructor', 'src/model/x.ts', 'const S = process.stdout.constructor;'),
  pos('ban:.constructor', 'src/model/x.ts', "const G = Reflect.get(gate, 'constructor');"),
  pos('ban:.constructor', 'src/model/x.ts', 'const S = Object.getPrototypeOf(process.stderr).constructor;'),
  neg('ban:.constructor', 'src/fs/read-gate.ts', 'constructor(config: ReadGateConfig) { this.cfg = config; }'),
  neg('ban:.constructor', 'src/model/x.ts', 'const label = describeConstructorKind(x);'),
  // Finding F6: a destructuring pattern, in an assignment or a parameter.
  pos('ban:.constructor', 'src/model/x.ts', 'const { constructor: S } = process.stdout;'),
  pos('ban:.constructor', 'src/model/x.ts', 'export function f({ constructor: C }: { constructor: unknown }) { return C; }'),
  pos('ban:.constructor', 'src/model/x.ts', 'const { write, constructor } = process.stderr;'),
  neg('ban:.constructor', 'src/model/x.ts', 'class Gate {\n  constructor(config: Config) {\n    this.config = config;\n  }\n}'),

  // The paths are chosen so that none of these strings resolves to src/ from this file, which the
  // rule scans too; the helper's own import is spelled in two pieces for the same reason.
  pos('in-process-start-only-in-helper', 'test/x.test.ts', "import { start } from '../src/main.ts';"),
  pos('in-process-start-only-in-helper', 'test/x.test.ts', "import { defaultStartDeps, start as mainStart } from '../src/main.ts';"),
  pos('in-process-start-only-in-helper', 'test/x.test.ts', "import * as main from '../src/main.ts';"),
  pos('in-process-start-only-in-helper', 'test/x.test.ts', "const { runWorking } = await import('../src/runtime/working.ts');"),
  pos('in-process-start-only-in-helper', 'test/a/b/x.test.ts', "export { runWorking } from '../../../src/runtime/working.ts';"),
  neg('in-process-start-only-in-helper', 'test/x.test.ts', "import type { StartDeps, StartOutcome } from '../src/main.ts';"),
  neg('in-process-start-only-in-helper', 'test/x.test.ts', "import { defaultStartDeps } from '../src/main.ts';"),
  neg('in-process-start-only-in-helper', 'test/x.test.ts', "import { startInProcess } from './helpers/start.ts';"),
  neg('in-process-start-only-in-helper', 'test/helpers/start.ts', "import { start } from '../../src/" + "main.ts';"),
  neg('in-process-start-only-in-helper', 'src/model/x.ts', "import { start } from '../main.ts';"),
  // Step 3: the Clock rule. The sites the step moved onto the Clock port are positives in their old form.
  pos('clock-only-in-clock-ts', 'src/os/spawn.ts', "const timer = setTimeout(() => halt('timeout'), limits.timeoutMs);"),
  pos('clock-only-in-clock-ts', 'src/main.ts', 'now: Date.now,'),
  pos('clock-only-in-clock-ts', 'src/runtime/log.ts', 'this.#now = cfg.now ?? Date.now;'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const t = Date.now();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const t = Date?.now();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', "const t = Date['now']();"),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', "const t = Reflect.get(Date, 'now')();"),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const d = new Date();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const d = new Date;'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const d = new globalThis.Date();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const s = Date();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const t = performance.now();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const o = performance.timeOrigin;'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', "const m = performance['now']();"),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', "performance.mark('x');"),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const p = performance; p.now();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const { now } = globalThis.performance;'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const t = process.hrtime.bigint();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const u = process.uptime();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', "const u = process['uptime']();"),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const { hrtime } = process;'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'setTimeout(f, 10);'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const h = setInterval(f, 1000);'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', "import { setTimeout as sleep } from 'node:timers/promises';"),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', "const s = new Intl.DateTimeFormat('en').format();"),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const p = Intl.DateTimeFormat().formatToParts();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const sig = AbortSignal.timeout(10_000);'),
  pos('clock-only-in-clock-ts', 'shared/protocol.js', 'const t = Date.now();'),
  pos('clock-only-in-clock-ts', 'scripts/check-real-claude.ts', 'const t0 = performance.now();'),
  neg('clock-only-in-clock-ts', 'src/runtime/clock.ts', 'const read = () => ({ mono: Math.floor(performance.now()), wall: Date.now() });'),
  neg('clock-only-in-clock-ts', 'src/os/spawn.ts', 'const at = new Date(this.#clock.nowWall()).toISOString();'),
  neg('clock-only-in-clock-ts', 'src/model/x.ts', 'const d = new Date(ms);'),
  neg('clock-only-in-clock-ts', 'src/model/x.ts', 'const due = Date.parse(text) + Date.UTC(2026, 0, 1);'),
  neg('clock-only-in-clock-ts', 'src/model/x.ts', 'const at = clock.nowWall(); const myDate = toDate(at);'),
  neg('clock-only-in-clock-ts', 'src/model/x.ts', 'const score = sample.performanceScore;'),
  neg('clock-only-in-clock-ts', 'src/model/x.ts', "const s = new Intl.DateTimeFormat('en', o).format(at);"),
  // Finding S8: ordinary spellings of a clock read past a member pattern; the words themselves are banned.
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const t = (Date).now();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const t = Date/**/.now();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const { now } = Date;'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const d = new Date(...[]);'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const s = Date.call(null);'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const d = Reflect.construct(Date, []);'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', "const t = globalThis['Date'].now();"),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', "const t = globalThis['performance'].now();"),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const t = (performance).now();'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', "const h = Reflect.get(process, 'hrtime');"),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const { timeout } = AbortSignal;'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', "const s = AbortSignal['timeout'](5);"),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', 'const s = (AbortSignal).timeout(5);'),
  pos('clock-only-in-clock-ts', 'src/model/x.ts', '// a Date in a comment counts too'),
  neg('clock-only-in-clock-ts', 'src/model/x.ts', 'const iso = new Date(ms).toISOString(); const d = new Date( ms );'),
  neg('clock-only-in-clock-ts', 'src/model/x.ts', 'const s = AbortSignal.any([a, b]); const t = updatedAt + timeoutMs;'),
  neg('clock-only-in-clock-ts', 'src/model/x.ts', 'const h = setImmediate(f);'),
  neg('clock-only-in-clock-ts', 'src/model/x.ts', 'const s = AbortSignal.any([a, b]);'),
  neg('clock-only-in-clock-ts', 'src/model/x.ts', 'const { pid, argv } = process;'),
  neg('clock-only-in-clock-ts', 'scripts/test-stage.ts', 'const timer = setTimeout(() => resolve(false), ms);'),
  neg('clock-only-in-clock-ts', 'ui/clock.js', 'const t = performance.now();'),
  neg('clock-only-in-clock-ts', 'test/x.test.ts', 'setTimeout(f, 1);'),
  neg('clock-only-in-clock-ts', 'src/runtime/process-powers.ts', "'isFinite', 'isNaN', 'setTimeout', 'setInterval', 'setImmediate',"),
  // node:timers left the default row: only clock.ts imports it.
  pos('builtin-policy', 'src/model/x.ts', "import { setTimeout } from 'node:timers';"),
  pos('builtin-policy', 'src/runtime/working.ts', "import { setTimeout as sleep } from 'node:timers/promises';"),
  neg('builtin-policy', 'src/runtime/clock.ts', "import { clearTimeout, setTimeout } from 'node:timers';"),

  pos('clock-factories-only-in-roots', 'src/model/x.ts', "import { makeRealClock } from '../runtime/clock.ts';\nconst hub = makeRealClock();"),
  pos('clock-factories-only-in-roots', 'src/main.ts', 'const hub = makeRealClock();'),
  pos('clock-factories-only-in-roots', 'src/runtime/working.ts', 'const vc = new VirtualClock({ mono: 0, wall: 0 });'),
  pos('clock-factories-only-in-roots', 'src/boot.ts', 'const vc = new VirtualClock({ mono: 0, wall: 0 });'),
  pos('clock-factories-only-in-roots', 'src/model/x.ts', "import * as c from '../runtime/clock.ts';\nconst hub = c['makeReal' + 'Clock']();"),
  pos('clock-factories-only-in-roots', 'src/model/x.ts', "const c = await import('../runtime/clock.ts');"),
  neg('clock-factories-only-in-roots', 'src/boot.ts', "import { makeRealClock } from './runtime/clock.ts';\nconst ports = { clock: makeRealClock() };"),
  neg('clock-factories-only-in-roots', 'src/boot.ts', "import * as clockModule from './runtime/clock.ts';"),
  neg('clock-factories-only-in-roots', 'src/runtime/clock.ts', 'export class VirtualClock implements ClockHub {'),
  neg('clock-factories-only-in-roots', 'src/os/spawn.ts', "import type { Clock, ClockHub, Fired } from '../runtime/clock.ts';"),
  neg('clock-factories-only-in-roots', 'src/model/x.ts', "import { clockRecord, timerId } from '../runtime/clock.ts';"),
  neg('clock-factories-only-in-roots', 'test/x.test.ts', 'const vc = new VirtualClock({ mono: 0, wall: 0 });'),

  pos('ban:locale', 'src/model/x.ts', "const s = new Intl.DateTimeFormat('zh-CN').format(t);"),
  pos('ban:locale', 'src/model/x.ts', 'rows.sort((a, b) => a.name.localeCompare(b.name));'),
  pos('ban:locale', 'src/model/x.ts', 'const s = new Date(t).toLocaleString();'),
  pos('ban:locale', 'src/model/x.ts', "const s = n.toLocaleString('en');"),
  pos('ban:locale', 'src/model/x.ts', 'const u = name.toLocaleUpperCase();'),
  pos('ban:locale', 'shared/strings.js', 'const c = new Intl.Collator();'),
  neg('ban:locale', 'src/model/x.ts', 'rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));'),
  neg('ban:locale', 'src/model/x.ts', 'const u = name.toUpperCase();'),
  neg('ban:locale', 'src/model/x.ts', 'const s = new Date(t).toISOString(); const international = true;'),
  neg('ban:locale', 'src/runtime/process-powers.ts', "'JSON', 'Math', 'Intl', 'ArrayBuffer',"),
  neg('ban:locale', 'ui/clock.js', "const f = new Intl.DateTimeFormat('zh-CN', o);"),

  pos('ban:Math.random', 'src/model/x.ts', 'const id = Math.random().toString(36);'),
  pos('ban:Math.random', 'src/model/x.ts', "const r = Math['random']();"),
  pos('ban:Math.random', 'shared/protocol.js', 'const tab = Math.random();'),
  neg('ban:Math.random', 'src/runtime/working.ts', 'const code = crypto.randomInt(0, 100_000_000); const id = crypto.randomUUID();'),
  neg('ban:Math.random', 'test/x.test.ts', 'const order = Math.random();'),

  pos('shared-imports-shared-only', 'shared/protocol.js', "import { timerId } from '../src/runtime/clock.ts';"),
  pos('shared-imports-shared-only', 'shared/strings.js', "import { ID_RE } from './protocol.ts';"),
  pos('shared-imports-shared-only', 'shared/x.js', "import { a } from '../ui/app.js';"),
  pos('shared-imports-shared-only', 'shared/x.js', "import v from 'lodash';"),
  pos('shared-imports-shared-only', 'shared/x.js', "/** @typedef {import('../src/main.ts').StartDeps} D */"),
  neg('shared-imports-shared-only', 'shared/strings.js', "import { ERROR_CODES } from './protocol.js';"),
  neg('shared-imports-shared-only', 'shared/sub/x.js', "import { a } from '../protocol.js';"),
  neg('shared-imports-shared-only', 'src/model/x.ts', "import { ID_RE } from '../../shared/protocol.js';"),
  // A builtin in shared/ is the builtin-policy rule's (NO_BUILTIN_DIRS), defaults included.
  neg('shared-imports-shared-only', 'shared/x.js', "import * as path from 'node:path';"),
  pos('builtin-policy', 'shared/x.js', "import * as path from 'node:path';"),
  pos('builtin-policy', 'shared/x.js', "/** @typedef {import('node:fs').Stats} S */"),
  neg('builtin-policy', 'src/model/x.ts', "import * as path from 'node:path';"),
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

test('process-power-member flags every lock and mint key of process in each member form, and none as a method of another object', () => {
  const fenced = PROCESS_POWERS.filter((e) => e.class !== 'keep');
  assert.ok(fenced.length >= 17, 'the table locks the keys the brief lists at least');
  const hit = (text: string) => scan('src/model/x.ts', text).filter((h) => h.rule === 'process-power-member').length > 0;
  for (const { key } of fenced) {
    for (const text of [`process.${key}(x);`, `process['${key}'](x);`, `const f = process?.${key};`, `const { ${key} } = process;`, `Reflect.get(process, '${key}');`]) {
      assert.ok(hit(text), `not flagged: ${text}`);
    }
    for (const text of [`thing.${key}(x);`, `const ${key}ed = 1;`, `const x = { ${key}: 1 };`]) assert.ok(!hit(text), `flagged: ${text}`);
  }
  for (const { key } of PROCESS_POWERS.filter((e) => e.class === 'keep' && !e.key.startsWith('Symbol('))) assert.ok(!hit(`process.${key};`), `kept key flagged: ${key}`);
  // A process mint entry is named only where it is minted and held (reallyExit: boot.ts, held by nobody else).
  const minted = PROCESS_POWERS.filter((e) => e.class === 'mint');
  assert.deepEqual(minted.map((e) => [e.key, e.class === 'mint' ? e.mintedBy : '', e.class === 'mint' ? [...e.heldBy] : []]), [['reallyExit', 'src/boot.ts', []]]);
  const hitIn = (file: string, text: string) => scan(file, text).filter((h) => h.rule === 'process-power-member').length > 0;
  for (const e of minted) {
    if (e.class !== 'mint') continue;
    for (const f of [e.mintedBy, ...e.heldBy]) assert.ok(!hitIn(f, `const f = process.${e.key};`), `${e.key} in ${f}`);
    for (const f of ['src/main.ts', 'src/runtime/working.ts', 'src/model/x.ts']) assert.ok(hitIn(f, `const f = process.${e.key};`), `${e.key} in ${f}`);
  }
  assert.ok(hitIn('src/boot.ts', 'process.exit(code);'), 'boot.ts mints reallyExit, not exit');
});

test('global-power-name flags every lock and mint global by its bare name, except where a mint entry is minted and held', () => {
  const named = GLOBAL_POWERS.filter((e) => e.class !== 'keep' && !e.key.startsWith('Symbol('));
  assert.deepEqual(named.map((e) => e.key).sort(), ['EventSource', 'WebSocket', 'fetch', 'localStorage', 'sessionStorage']);
  const hit = (file: string, text: string) => scan(file, text).filter((h) => h.rule === 'global-power-name').length > 0;
  for (const e of named) {
    assert.ok(hit('src/model/x.ts', `const g = ${e.key};`), e.key);
    assert.ok(!hit('src/model/x.ts', `const g = my${e.key};`), e.key);
    assert.ok(!hit('src/runtime/process-powers.ts', `const g = ${e.key};`), `${e.key} in the table`);
    if (e.class === 'mint') for (const f of [e.mintedBy, ...e.heldBy]) assert.ok(!hit(f, `const g = ${e.key};`), `${e.key} in ${f}`);
  }
});

// Rules dropped (or narrowed) in step 2c because another defense stops their bad sample (zen note 7.3,
// drop-shadow-rules). For every module that can import the builtin a sample needs (BUILTIN_ROWS), and
// for code modules without a row, the sample must still be flagged by some rule; the rules that flag
// it are the covering defense. Browser code (ui/) has no node builtins at all.
type Shadow = { dropped: string; builtin: string; sample: string };
const fsSample = (call: string) => `import * as fs from 'node:fs';\n${call}`;
const SHADOWS: readonly Shadow[] = [
  { dropped: 'ban:net.connect', builtin: 'node:net', sample: "import * as net from 'node:net';\nnet.connect(pipe);" },
  { dropped: 'ban:net.connect', builtin: 'node:net', sample: "import { connect } from 'node:net';\nconnect(pipe);" },
  { dropped: 'ban:createConnection', builtin: 'node:net', sample: "import { createConnection } from 'node:net';\ncreateConnection({ path: pipe });" },
  { dropped: 'ban:http.request', builtin: 'node:http', sample: "import * as http from 'node:http';\nhttp.request(url);" },
  { dropped: 'ban:http.request', builtin: 'node:http', sample: "import { request } from 'node:http';\nrequest(url);" },
  { dropped: 'ban:http.request', builtin: 'node:https', sample: "import * as https from 'node:https';\nhttps.request(url);" },
  { dropped: 'ban:http.get', builtin: 'node:http', sample: "import { get } from 'node:http';\nget(url, cb);" },
  { dropped: 'ban:node:https', builtin: 'node:https', sample: "import * as https from 'node:https';" },
  { dropped: 'ban:node:https', builtin: 'node:https', sample: "const h = require('https');" },
  { dropped: 'ban:copyFile', builtin: 'node:fs', sample: fsSample('fs.copyFileSync(a, b);') },
  { dropped: 'ban:cp(', builtin: 'node:fs', sample: fsSample('fs.cpSync(a, b);') },
  { dropped: 'ban:createWriteStream', builtin: 'node:fs', sample: fsSample('fs.createWriteStream(p);') },
  { dropped: 'ban:truncate', builtin: 'node:fs', sample: fsSample('fs.truncateSync(p, 0);') },
  { dropped: 'ban:utimes', builtin: 'node:fs', sample: fsSample('fs.utimesSync(p, a, m);') },
  { dropped: 'ban:symlink', builtin: 'node:fs', sample: fsSample("fs.symlinkSync(a, b, 'junction');") },
  { dropped: 'ban:link(', builtin: 'node:fs', sample: fsSample('fs.linkSync(a, b);') },
  { dropped: 'ban:eval: true outside the worker modules', builtin: 'node:worker_threads', sample: "import { Worker } from 'node:worker_threads';\nnew Worker(src, { eval: true });" },
];
const ROW_MODULES = [...new Set(BUILTIN_ROWS.flatMap((r) => r.modules))];
const NO_ROW_MODULES = ['src/model/x.ts', 'shared/x.js', 'scripts/check-real-claude.ts'];

/** For each shadow and module: the rules that flag the sample there ('' when none does). */
function coverage(rules: readonly Rule[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of SHADOWS) {
    for (const m of [...ROW_MODULES, ...NO_ROW_MODULES]) {
      out.set(`${s.dropped} | ${s.sample.split('\n').at(-1)} | ${m}`, [...new Set(scan(m, s.sample, rules).map((h) => h.rule))].sort().join(','));
    }
  }
  return out;
}
const gaps = (c: Map<string, string>) => [...c].filter(([, by]) => by === '').map(([k]) => k);

test('rules dropped or narrowed in step 2c: each bad sample is still flagged in every module that could act on it, derived from BUILTIN_ROWS', () => {
  const c = coverage(RULES);
  assert.deepEqual(gaps(c), []);
  // The covering defense: only-names for the two modules that may import node:net or node:http, the
  // fs-name table where node:fs can be imported, the narrowed eval rule in the worker modules, and the
  // builtin-policy rule (the import fence's static twin) everywhere else.
  const by = (dropped: string, sampleEnd: string, m: string) => c.get(`${dropped} | ${sampleEnd} | ${m}`);
  assert.equal(by('ban:net.connect', 'net.connect(pipe);', 'src/runtime/lock.ts'), 'builtin-only-names');
  assert.equal(by('ban:net.connect', 'connect(pipe);', 'src/server/http.ts'), 'builtin-only-names');
  assert.equal(by('ban:http.request', 'request(url);', 'src/server/http.ts'), 'builtin-only-names');
  assert.equal(by('ban:http.request', 'https.request(url);', 'src/server/http.ts'), 'builtin-policy');
  assert.equal(by('ban:net.connect', 'net.connect(pipe);', 'src/model/x.ts'), 'builtin-policy');
  assert.equal(by('ban:node:https', "const h = require('https');", 'scripts/check-real-claude.ts'), 'builtin-policy');
  assert.ok(by('ban:copyFile', 'fs.copyFileSync(a, b);', 'src/fs/node-io.ts')!.split(',').includes('fs-name-bans'));
  // main.ts has a node:os row but not node:fs, so a node:fs call there is caught by the import of node:fs.
  assert.equal(by('ban:copyFile', 'fs.copyFileSync(a, b);', 'src/main.ts'), 'builtin-policy');
  assert.equal(by('ban:eval: true outside the worker modules', 'new Worker(src, { eval: true });', 'src/runtime/workers.ts'), 'ban:eval: true');
  assert.equal(by('ban:eval: true outside the worker modules', 'new Worker(src, { eval: true });', 'src/model/x.ts'), 'builtin-policy');
});

test('calibration: without the narrowed eval rule the derivation reports exactly the modules allowed node:worker_threads', () => {
  const workerModules = BUILTIN_ROWS.filter((r) => r.allow.includes('node:worker_threads')).flatMap((r) => r.modules).sort();
  assert.deepEqual(workerModules, ['src/runtime/workers.ts', 'src/workers/bootstrap.ts']);
  const open = gaps(coverage(RULES.filter((r) => r.id !== 'ban:eval: true')));
  assert.deepEqual(open, workerModules.map((m) => `ban:eval: true outside the worker modules | new Worker(src, { eval: true }); | ${m}`));
  // The bad sample is the real shape of workers.ts's one Worker call with eval switched on.
  const workers = fs.readFileSync(path.join(repo, 'src/runtime/workers.ts'), 'utf8');
  assert.match(workers, /return new Worker\(BOOTSTRAP_URL, \{/);
  const bad = workers.replace('return new Worker(BOOTSTRAP_URL, {', 'return new Worker(BOOTSTRAP_URL, {\n    eval: true,');
  assert.deepEqual(scan('src/runtime/workers.ts', bad).map((h) => h.rule), ['ban:eval: true']);
  // Dropping only-names, or the builtin-policy rule, opens the modules each one covers.
  assert.ok(gaps(coverage(RULES.filter((r) => r.id !== 'builtin-only-names'))).some((g) => g.endsWith('| src/runtime/lock.ts')));
  assert.ok(gaps(coverage(RULES.filter((r) => r.id !== 'builtin-policy'))).some((g) => g.endsWith('| src/model/x.ts')));
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
  assert.ok(files.some((f) => f.endsWith('startup-modes.test.ts')), 'the scan saw test/');
  const hits = files.flatMap((f) => {
    const rel = path.relative(repo, f).split(path.sep).join('/');
    return EXEMPT_SCRIPTS.includes(rel) ? [] : scan(rel, fs.readFileSync(f, 'utf8'));
  });
  assert.deepEqual(hits, []);
});
