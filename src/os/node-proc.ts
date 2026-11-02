import { spawn } from 'node:child_process';
import type { SpawnBackend, SpawnGateConfig } from './spawn.ts';
import { SpawnGate } from './spawn.ts';
import { ownEnv } from '../runtime/own.ts';

// The one module that imports node:child_process (plan step 2c, zen note 7.2/7.3). boot.ts imports
// it before the import fence goes in and hands makeSpawnGate to main.ts in BootPorts; once the fence
// is in, no module can resolve it (minted-before-fence). It is its own module rather than part of
// src/fs/node-io.ts so that each minted module holds one builtin and its builtin-policy row names
// exactly that one. The backend never leaves this file: a caller gets a SpawnGate, whose exes and
// argv are spawn.ts's constants, built around it.

/**
 * Spawns with options of its own making: a frozen object without a prototype holding the gate's cwd,
 * stdio and env, every other field fixed here. The env is the gate's, built per rule from its whitelist
 * and fixed extras (alpha 0.2 design §2.1), never this process's whole environment; it is copied again
 * here, own string entries only. Node enumerates the env object with for...in, so an object with a
 * prototype would carry an enumerable key some module put on Object.prototype into the child
 * (measured on 24.22; a COR_PROFILER into csc, say).
 */
const NODE_BACKEND: SpawnBackend = (exe, argv, gate) => {
  const options = Object.freeze(Object.assign(Object.create(null) as Record<string, unknown>, {
    cwd: gate.cwd,
    stdio: [...gate.stdio],
    windowsHide: true,
    shell: false,
    detached: false,
    windowsVerbatimArguments: false,
    env: ownEnv(gate.env),
  }));
  return spawn(exe, [...argv], options);
};

/** What a caller of makeSpawnGate chooses; the backend is always this module's. */
export type SpawnGateSpec = Omit<SpawnGateConfig, 'backend'>;

/**
 * A spawn gate that starts real processes. Object.assign copies the spec's own enumerable fields only,
 * into an object without a prototype, and the backend comes last, so one in the spec never reaches the gate.
 */
export function makeSpawnGate(spec: SpawnGateSpec): SpawnGate {
  return new SpawnGate(Object.assign(Object.create(null) as SpawnGateConfig, spec, { backend: NODE_BACKEND }));
}
