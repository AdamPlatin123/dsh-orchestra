// Inputs for calling main.ts start() in-process. Always with a fake home and a minimal environment:
// the real profile derives its harness roots from both, and must never see the real ones here.
import * as os from 'node:os';
import type { FenceStatus } from '../../src/runtime/import-fence.ts';
import type { ConsolePort } from '../../src/runtime/log.ts';

export const FENCE_OK: FenceStatus = { resolveHook: true, builtinGetter: true, nativeStubs: true, ioStubs: true, networkGlobals: true, killStubs: true };
export const FENCE_NO_HOOK: FenceStatus = { ...FENCE_OK, resolveHook: false };

/** SystemRoot, windir and the temp dir only: no CLAUDE_CONFIG_DIR, DSH_HOME, CODEX_HOME, XDG or ORCHESTRA_HOME. */
export function minimalEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  return { SystemRoot: process.env.SystemRoot, windir: process.env.windir, TEMP: os.tmpdir(), TMP: os.tmpdir(), ...extra };
}

export type Captured = { port: ConsolePort; out: string[]; err: string[]; all(): string[] };

export function captureConsole(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    port: { out: (l) => out.push(l), err: (l) => err.push(l) },
    out,
    err,
    all: () => [...out, ...err],
  };
}
