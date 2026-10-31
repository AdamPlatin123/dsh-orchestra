// Every own key of `process` and `globalThis` on the pinned Node, and what the import fence does with
// it (P8: authority is handed, not reachable). installImportFence() applies this table on each thread;
// the static scan generates its process and global rules from it (test/helpers/scan-rules.ts); the
// key-set golden (test/runtime/process-powers.test.ts) fails on any key the table does not list, on
// any listed non-optional key that is missing and on any changed shape, so a Node upgrade forces a
// commit that classifies only the delta. boot.ts loads this module, through import-fence.ts, before
// the fence goes in, so it imports nothing.
//
//   keep  the slot stays as Node made it; `why` says why it is harmless. `pin` freezes the slot with
//         its own value: stopping and the crash path end the process through it, so no module may
//         swap it for one that returns (measured: a no-op exit or reallyExit, or a replaced
//         _fatalException, keeps a crashed process alive or changes its exit code).
//   lock  the slot gets a stub for good (non-writable, non-configurable); nobody gets the original.
//   mint  boot.ts takes the original before the fence locks the slot like a lock entry, and hands it
//         to the one module named in `heldBy`.

/** The Node the table was taken on (process.versions.node); planStartup notes any other (startup.ts). */
export const POWERS_NODE = '24.22.0';

/** typeof the slot's value once the fence is in (null as 'null'), or 'accessor' for a getter/setter. */
export type Shape = 'string' | 'number' | 'boolean' | 'undefined' | 'null' | 'object' | 'function' | 'symbol' | 'bigint' | 'accessor';
/** When an optional key exists: an IPC channel to a parent, --permission, or --experimental-webstorage. */
export type Optional = 'ipc' | 'permission' | 'webstorage';
/**
 * What a lock or mint slot holds: a function that throws (throws), the getter that hands out the
 * default builtins only (builtin-getter), a frozen report whose methods throw (report), the frozen
 * undici dispatcher whose methods throw (dead-dispatcher), or undefined (empty).
 */
export type Stub = 'throws' | 'builtin-getter' | 'report' | 'dead-dispatcher' | 'empty';

/**
 * `key` is the property name, or Symbol(description) for a symbol; a lock or mint symbol is the
 * registered one. `primedBy` names a builtin whose first load assigns the slot: the fence loads it
 * before it locks anything, or that load would throw on the locked slot later (measured on 24.22).
 */
type Base = { key: string; shape: Shape; optional?: Optional; primedBy?: string; why: string };
export type Power =
  | (Base & { class: 'keep'; pin?: true })
  | (Base & { class: 'lock'; stub: Stub })
  | (Base & { class: 'mint'; stub: Stub; mintedBy: string; heldBy: readonly string[] });

const keep = (key: string, shape: Shape, why: string, more: { optional?: Optional } = {}): Power => ({ class: 'keep', key, shape, why, ...more });
const pin = (key: string, why: string): Power => ({ class: 'keep', key, shape: 'function', why, pin: true });
const lock = (key: string, why: string, more: { stub?: Stub; shape?: Shape; optional?: Optional; primedBy?: string } = {}): Power => ({
  class: 'lock', key, stub: more.stub ?? 'throws', shape: more.shape ?? 'function', why,
  ...(more.optional !== undefined ? { optional: more.optional } : {}), ...(more.primedBy !== undefined ? { primedBy: more.primedBy } : {}),
});

const DATA = 'data about this process or build; reading it does nothing';
const MEASURE = 'a measurement of this process; no I/O';
const EMITTER = 'EventEmitter state; process.emit reaches the stop handler, and stopping ends the process (working.ts)';
const IPC = 'exists only when a parent forked this process with an IPC channel; orchestrad is started from a console and never forked, and such a parent would already own the process';

export const PROCESS_POWERS: readonly Power[] = [
  // Locked: each reaches the file system, other processes, native code or the inspector past every gate.
  lock('binding', 'internal bindings: fs, pipes and processes without any gate'),
  lock('_linkedBinding', 'linked native bindings, the same'),
  lock('dlopen', 'loads native code'),
  lock('getBuiltinModule', 'hands out any builtin by name, past the import fence; no module needs it, so only the default builtins come back', { stub: 'builtin-getter' }),
  lock('loadEnvFile', 'reads a file into process.env past the read gate'),
  lock('report', 'writeReport and the reportOn* flags write a file past the write fence; frozen, so setting a field throws', { stub: 'report', shape: 'object' }),
  lock('kill', 'a raw signal by pid skips the identity checks of the brake (plan invariant 7); children stop through their own handle'),
  lock('_kill', 'the same, unwrapped'),
  lock('execve', 'replaces this process with any executable, past the spawn gate (unavailable on Windows today)'),
  lock('abort', 'ends the process without the typed exit or the crash line'),
  // node:internal/worker wraps it by assignment when first loaded on the main thread, and node:util,
  // node:http and the first fetch load that module.
  lock('chdir', 'moves the working directory every relative path and child process starts from', { primedBy: 'node:worker_threads' }),
  lock('umask', 'measured: under a mask of 0o222 every file created is read-only, and a rename over it or a write open of it fails with EPERM (writeAtomic, append)'),
  // node:domain and node:repl replace it when loaded; the builtin table refuses both.
  lock('setUncaughtExceptionCaptureCallback', 'measured: a capture callback swallows every uncaught error, so boot.ts never sees the crash and the process lives on'),
  lock('_debugProcess', 'opens the inspector of another Node process of this user (node:inspector by another name)'),
  lock('_debugEnd', 'closes it again'),
  lock('_getActiveHandles', 'hands out the live handles, the lock pipe server among them, which anyone could close'),
  lock('_getActiveRequests', 'hands out the live requests'),
  // Pinned: the ways the process ends.
  pin('exit', 'stopping and the crash line end the process through it (main.ts, boot.ts)'),
  pin('reallyExit', 'process.exit ends the process through it'),
  pin('_fatalException', 'Node routes every uncaught error through it to boot.ts\'s crash handler'),
  // Kept.
  keep('version', 'string', DATA),
  keep('versions', 'object', DATA),
  keep('arch', 'string', DATA),
  keep('platform', 'string', DATA),
  keep('release', 'object', DATA),
  keep('config', 'object', DATA),
  keep('features', 'object', DATA),
  keep('allowedNodeEnvironmentFlags', 'accessor', DATA),
  keep('moduleLoadList', 'object', DATA),
  keep('_preload_modules', 'object', DATA),
  keep('argv', 'object', DATA),
  keep('argv0', 'string', DATA),
  keep('execArgv', 'object', DATA),
  keep('execPath', 'string', 'data; no module reads it (the spawn gate resolves its executables itself)'),
  keep('pid', 'number', DATA),
  keep('ppid', 'number', DATA),
  keep('title', 'string', 'the console window title'),
  keep('debugPort', 'number', 'setting it opens nothing: the inspector needs node:inspector (forbidden) or _debugProcess (locked)'),
  keep('env', 'object', 'read once by main.ts; children get an own-keys copy (own.ts, node-proc.ts)'),
  keep('cwd', 'function', DATA),
  keep('uptime', 'function', MEASURE),
  keep('hrtime', 'function', MEASURE),
  keep('cpuUsage', 'function', MEASURE),
  keep('threadCpuUsage', 'function', MEASURE),
  keep('resourceUsage', 'function', MEASURE),
  keep('memoryUsage', 'function', MEASURE),
  keep('constrainedMemory', 'function', MEASURE),
  keep('availableMemory', 'function', MEASURE),
  keep('getActiveResourcesInfo', 'function', 'type names of the live resources only, no handle; a diagnostic'),
  keep('hasUncaughtExceptionCaptureCallback', 'function', 'a yes/no question'),
  keep('stdout', 'accessor', 'the console; a residual (zen note 7.1): net.Socket is reachable through its prototype chain'),
  keep('stderr', 'accessor', 'the console, the same'),
  keep('stdin', 'accessor', 'the console input; nothing in orchestrad reads it'),
  keep('openStdin', 'function', 'the same input'),
  keep('_rawDebug', 'function', 'writes to stderr only'),
  keep('emitWarning', 'function', 'writes a warning to stderr'),
  keep('nextTick', 'function', 'schedules a callback in this process'),
  keep('_tickCallback', 'function', 'runs the queued ticks'),
  keep('ref', 'function', 'keeps a handle the caller already holds alive'),
  keep('unref', 'function', 'the opposite'),
  keep('finalization', 'accessor', 'callbacks when an object the caller holds is collected'),
  keep('sourceMapsEnabled', 'accessor', 'stack trace formatting'),
  keep('setSourceMapsEnabled', 'function', 'the same'),
  keep('_startProfilerIdleNotifier', 'function', 'marks the CPU profiler idle; no profiler can be started (node:inspector is forbidden)'),
  keep('_stopProfilerIdleNotifier', 'function', 'the same'),
  keep('exitCode', 'accessor', 'non-configurable, so it cannot be locked; boot.ts\'s crash path passes its code to exit itself'),
  keep('_exiting', 'accessor', 'set by process.exit; it only skips the exit event'),
  keep('domain', 'null', EMITTER),
  keep('_events', 'object', EMITTER),
  keep('_eventsCount', 'number', EMITTER),
  keep('_maxListeners', 'undefined', EMITTER),
  keep('Symbol(shapeMode)', 'boolean', EMITTER),
  keep('Symbol(kCapture)', 'boolean', EMITTER),
  keep('Symbol(Symbol.toStringTag)', 'string', DATA),
  keep('Symbol(orchestra.importFence)', 'object', 'the fence\'s own frozen status, locked by installImportFence itself'),
  keep('permission', 'object', 'questions about the --permission model only', { optional: 'permission' }),
  keep('channel', 'object', IPC, { optional: 'ipc' }),
  keep('_channel', 'accessor', IPC, { optional: 'ipc' }),
  keep('_handleQueue', 'null', IPC, { optional: 'ipc' }),
  keep('_pendingMessage', 'null', IPC, { optional: 'ipc' }),
  keep('send', 'function', IPC, { optional: 'ipc' }),
  keep('_send', 'function', IPC, { optional: 'ipc' }),
  keep('connected', 'boolean', IPC, { optional: 'ipc' }),
  keep('disconnect', 'function', IPC, { optional: 'ipc' }),
  keep('_disconnect', 'function', IPC, { optional: 'ipc' }),
  keep('Symbol(kChannelHandle)', 'object', IPC, { optional: 'ipc' }),
];

const NO_IO = 'computes in memory only';

export const GLOBAL_POWERS: readonly Power[] = [
  {
    class: 'mint', key: 'fetch', stub: 'throws', shape: 'function', mintedBy: 'src/boot.ts', heldBy: ['src/net/dsh-connect.ts'],
    why: 'the network; boot.ts wraps the original as ports.fetch, which the DSH connect gets in step 15',
  },
  lock('WebSocket', 'the network; no module needs it'),
  lock('EventSource', 'the network; no module needs it'),
  // undici fills its global dispatcher slots on the first fetch or import of node:http, and only when
  // they are empty: a module could then send HTTP with .request(), or put a Proxy there that sees every
  // request made without an own dispatcher. A frozen stub takes both slots for good. undici resolves a
  // relative URL against the origin slot, so it is locked empty. Imports of node:http and fetches of
  // data: URLs still work. ports.fetch binds its own dispatcher into every request it makes (boot.ts):
  // the slots alone would not protect it, since undici reads every RequestInit field through the
  // prototype chain. Step 15 needs real HTTP: boot will run `await fetch('data:,')` before the fence
  // (undici loads, nothing goes on the network), take the dispatcher from these slots and bind it in
  // place of the dead one. Until then ports.fetch serves data: URLs only.
  lock('Symbol(undici.globalDispatcher.1)', 'undici\'s global dispatcher slot', { stub: 'dead-dispatcher', shape: 'object' }),
  lock('Symbol(undici.globalDispatcher.2)', 'its second slot, the same', { stub: 'dead-dispatcher', shape: 'object' }),
  lock('Symbol(undici.globalOrigin.1)', 'the base of every relative URL', { stub: 'empty', shape: 'undefined' }),
  lock('localStorage', 'writes the --localstorage-file past the write fence', { optional: 'webstorage' }),
  lock('sessionStorage', 'web storage, the same', { optional: 'webstorage' }),
  keep('Storage', 'function', 'its class; constructing one throws', { optional: 'webstorage' }),
  keep('process', 'accessor', 'the object the process half of this table covers'),
  keep('global', 'object', 'globalThis by another name'),
  keep('globalThis', 'object', 'itself'),
  keep('console', 'object', 'writes to stdout and stderr, the console'),
  keep('Buffer', 'accessor', NO_IO),
  keep('crypto', 'accessor', 'randomness and digests; no I/O'),
  keep('navigator', 'accessor', DATA),
  keep('performance', 'accessor', 'clock reads; step 3 keeps the clock in clock.ts'),
  keep('eval', 'function', 'compiles code that meets the same fence; the scan bans calling it in our code'),
  keep('Function', 'function', 'the same; the scan bans constructing it'),
  keep('WebAssembly', 'object', 'a module gets no import but those its caller passes; no I/O of its own'),
  keep('BroadcastChannel', 'function', 'messages between threads of this process'),
  keep('MessageChannel', 'function', 'the same'),
  keep('MessagePort', 'function', 'the same'),
  keep('Request', 'function', 'data only; a relative URL resolves against the origin slot, locked empty'),
  keep('Response', 'function', 'data only'),
  keep('Headers', 'function', 'data only'),
  keep('FormData', 'function', 'data only'),
];

/** The rest of globalThis: ECMAScript and web values that compute in memory. Listed by name only. */
export const PLAIN_GLOBALS: readonly string[] = [
  'Object', 'Array', 'Number', 'parseFloat', 'parseInt', 'Infinity', 'NaN', 'undefined', 'Boolean', 'String', 'Symbol', 'Date',
  'Promise', 'RegExp', 'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
  'JSON', 'Math', 'Intl', 'ArrayBuffer', 'Atomics', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
  'BigUint64Array', 'BigInt64Array', 'Uint8ClampedArray', 'Float32Array', 'Float64Array', 'Float16Array', 'DataView', 'Map', 'BigInt',
  'Set', 'Iterator', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'FinalizationRegistry', 'WeakRef', 'SharedArrayBuffer', 'SuppressedError',
  'DisposableStack', 'AsyncDisposableStack', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape',
  'isFinite', 'isNaN', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'queueMicrotask',
  'structuredClone', 'atob', 'btoa', 'URL', 'URLSearchParams', 'URLPattern', 'DOMException', 'AbortController', 'AbortSignal', 'Event',
  'EventTarget', 'CustomEvent', 'MessageEvent', 'CloseEvent', 'TextEncoder', 'TextDecoder', 'TextEncoderStream', 'TextDecoderStream',
  'TransformStream', 'TransformStreamDefaultController', 'WritableStream', 'WritableStreamDefaultController', 'WritableStreamDefaultWriter',
  'ReadableStream', 'ReadableStreamDefaultReader', 'ReadableStreamBYOBReader', 'ReadableStreamBYOBRequest', 'ReadableByteStreamController',
  'ReadableStreamDefaultController', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy', 'CompressionStream', 'DecompressionStream',
  'Blob', 'File', 'Performance', 'PerformanceEntry', 'PerformanceMark', 'PerformanceMeasure', 'PerformanceObserver',
  'PerformanceObserverEntryList', 'PerformanceResourceTiming', 'Crypto', 'CryptoKey', 'SubtleCrypto', 'Navigator', 'Symbol(Symbol.toStringTag)',
];

/** The table's label of a property key: its name, or Symbol(description). */
export function powerLabel(k: PropertyKey): string {
  return typeof k === 'symbol' ? `Symbol(${k.description ?? ''})` : String(k);
}

/** The property key of a lock or mint entry: its name, or the registered symbol its label names. */
export function slotOf(e: Power): PropertyKey {
  const m = /^Symbol\((.+)\)$/.exec(e.key);
  return m === null ? e.key : Symbol.for(m[1]!);
}

/** Does the fence make this entry's slot read-only? Lock and mint entries, and pinned keep entries. */
export function isFenced(e: Power): boolean {
  return e.class !== 'keep' || e.pin === true;
}

/** Slots every fence install makes read-only, whatever the thread: the fenced entries that are not optional. */
export const BASE_LOCKS: number = [...PROCESS_POWERS, ...GLOBAL_POWERS].filter((e) => isFenced(e) && e.optional === undefined).length;
