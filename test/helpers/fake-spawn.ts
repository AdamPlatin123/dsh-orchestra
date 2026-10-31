// A spawn backend spy: records every call and plays back a scripted child. Nothing is executed.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { BackendOptions, ChildLike, SpawnBackend } from '../../src/os/spawn.ts';

export type FakeCall = { exe: string; argv: string[]; opts: BackendOptions };

export type FakeBehavior = {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  exitCode?: number;
  /** Ends with this signal instead of an exit code. */
  signal?: NodeJS.Signals;
  /** Fails like a missing exe: 'error' event, no pid. */
  error?: string;
  /** Never exits on its own; only kill() ends it. */
  hang?: boolean;
  pid?: number;
};

export type FakeSpawn = { backend: SpawnBackend; calls: FakeCall[]; kills: number };

let nextPid = 40_000;

export function fakeSpawn(behave: (call: FakeCall) => FakeBehavior = () => ({ exitCode: 0 })): FakeSpawn {
  const state: FakeSpawn = { backend: () => { throw new Error('unset'); }, calls: [], kills: 0 };
  state.backend = (exe, argv, opts) => {
    const call: FakeCall = { exe, argv: [...argv], opts };
    state.calls.push(call);
    const b = behave(call);
    const ee = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let closed = false;
    const close = (code: number | null, signal: NodeJS.Signals | null) => {
      if (closed) return;
      closed = true;
      stdout.end();
      stderr.end();
      setImmediate(() => ee.emit('close', code, signal));
    };
    const child = Object.assign(ee, {
      pid: b.error === undefined ? (b.pid ?? nextPid++) : undefined,
      stdin: null,
      stdout,
      stderr,
      kill: () => {
        state.kills++;
        close(null, 'SIGTERM');
        return true;
      },
    }) as unknown as ChildLike;
    setImmediate(() => {
      if (b.error !== undefined) {
        ee.emit('error', Object.assign(new Error(`spawn ${exe} ${b.error}`), { code: b.error }));
        close(-4058, null);
        return;
      }
      if (b.stdout !== undefined) stdout.write(b.stdout);
      if (b.stderr !== undefined) stderr.write(b.stderr);
      if (b.hang === true) return;
      setImmediate(() => close(b.signal === undefined ? (b.exitCode ?? 0) : null, b.signal ?? null));
    });
    return child;
  };
  return state;
}

// whoami /groups /fo csv /nh, as captured on this machine (GBK console), trimmed to a few groups.
const gbk = (hex: string) => Buffer.from(hex.replace(/\s+/g, ''), 'hex');
const q = (s: string) => Buffer.from(s, 'latin1');
const KNOWN_GROUP = gbk('D2D1 D6AA D7E9'); // 已知组
const ATTRS = gbk('B1D8 D0E8 B5C4 D7E9 2C20 C6F4 D3C3 D3DA C4AC C8CF 2C20 C6F4 D3C3 B5C4 D7E9'); // 必需的组, 启用于默认, 启用的组
const LABEL_WORD = gbk('B1EA C7A9'); // 标签

/** A whoami CSV with the given mandatory label line, group names in Chinese (GBK bytes). */
export function whoamiChinese(label: string | null): Buffer {
  const parts: Buffer[] = [
    q('"Everyone","'), KNOWN_GROUP, q('","S-1-1-0","'), ATTRS, q('"\r\n'),
    q('"NT AUTHORITY\\Authenticated Users","'), KNOWN_GROUP, q('","S-1-5-11","'), ATTRS, q('"\r\n'),
  ];
  if (label !== null) parts.push(q(`"Mandatory Label\\${label}","`), LABEL_WORD, q(`","${sidFor(label)}",""\r\n`));
  return Buffer.concat(parts);
}

/** The same in English. */
export function whoamiEnglish(label: string | null): Buffer {
  const lines = [
    '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
    '"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"',
  ];
  if (label !== null) lines.push(`"Mandatory Label\\${label}","Label","${sidFor(label)}",""`);
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'latin1');
}

const RIDS: Record<string, number> = {
  'Untrusted Mandatory Level': 0,
  'Low Mandatory Level': 4096,
  'Medium Mandatory Level': 8192,
  'Medium Plus Mandatory Level': 8448,
  'High Mandatory Level': 12288,
  'System Mandatory Level': 16384,
};

function sidFor(label: string): string {
  const rid = RIDS[label];
  if (rid === undefined) throw new Error(`unknown label ${label}`);
  return `S-1-16-${rid}`;
}

/** A spawn spy whose whoami prints `out` and exits with `exitCode`; anything else fails the test. */
export function whoamiSpy(out: Buffer | string, exitCode = 0): FakeSpawn {
  return fakeSpawn((call) => {
    if (!/\\whoami\.exe$/i.test(call.exe)) throw new Error(`unexpected spawn ${call.exe}`);
    return { stdout: out, exitCode };
  });
}
