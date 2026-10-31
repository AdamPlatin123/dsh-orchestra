import type { Features } from './features.ts';
import type { DataDirCheck } from './data-dir.ts';
import type { Integrity } from './integrity.ts';
import { MIN_NODE, missingFeatures } from './features.ts';
import { describeDataDir } from './data-dir.ts';
import { EXIT } from './exit.ts';
import { describeIntegrity } from './integrity.ts';

// planStartup(): one decision from three inputs, in the plan's order (step 2, plan §6 invariants 9
// and 10). Elevated beats everything; a missing core feature exits; any doubt about integrity, the
// import fence or the data dir gives ui-only; only a clean result works.

export { EXIT };

export type StartupNote =
  | { id: 'zstd-missing'; effect: 'dsh-source-off' }
  | { id: 'node-below-min'; effect: 'tuning-warning'; node: string; min: string };

export type UiOnlyReason =
  | { id: 'integrity-low'; rid: number }
  | { id: 'integrity-unknown'; integrity: Extract<Integrity, { level: 'unknown' }> }
  | { id: 'no-resolve-hook' }
  | { id: 'data-dir'; check: Extract<DataDirCheck, { ok: false }> };

export type StartupPlan =
  | { mode: 'exit'; code: typeof EXIT.elevated; reason: 'elevated'; integrity: Extract<Integrity, { level: 'high-or-above' }>; notes: StartupNote[] }
  | { mode: 'exit'; code: typeof EXIT.missingFeatures; reason: 'missing-features'; missing: string[]; notes: StartupNote[] }
  | { mode: 'ui-only'; reasons: UiOnlyReason[]; notes: StartupNote[] }
  | { mode: 'working'; dataDir: Extract<DataDirCheck, { ok: true }>; notes: StartupNote[] };

/** Tuning notes that never change the mode: no zstd turns the DSH source off; an old Node only warns. */
export function startupNotes(f: Features): StartupNote[] {
  const notes: StartupNote[] = [];
  if (!f.zstd) notes.push({ id: 'zstd-missing', effect: 'dsh-source-off' });
  if (!f.nodeAtLeastMin) notes.push({ id: 'node-below-min', effect: 'tuning-warning', node: f.node, min: MIN_NODE.join('.') });
  return notes;
}

export type ExitPlan = Extract<StartupPlan, { mode: 'exit' }>;

/**
 * The two exits, which need neither the data dir nor the harness roots: start() asks this before it
 * resolves or lists anything, so an elevated process reads nothing below the user's home.
 */
export function planExit(features: Features, integrity: Integrity): ExitPlan | null {
  const notes = startupNotes(features);
  if (integrity.level === 'high-or-above') return { mode: 'exit', code: EXIT.elevated, reason: 'elevated', integrity, notes };
  if (!features.sqlite || !features.typeStripping) {
    const missing = missingFeatures(features).filter((m) => m === 'node:sqlite' || m === 'typescript type stripping');
    return { mode: 'exit', code: EXIT.missingFeatures, reason: 'missing-features', missing, notes };
  }
  return null;
}

/**
 * `features.registerHooks` must already say whether the resolve hook is in place (boot passes
 * features AND fence status). ui-only lists every reason that applies, in a fixed order.
 */
export function planStartup(features: Features, integrity: Integrity, dataDir: DataDirCheck): StartupPlan {
  const exit = planExit(features, integrity);
  if (exit !== null) return exit;
  const notes = startupNotes(features);
  const reasons: UiOnlyReason[] = [];
  if (integrity.level === 'low') reasons.push({ id: 'integrity-low', rid: integrity.rid });
  if (integrity.level === 'unknown') reasons.push({ id: 'integrity-unknown', integrity });
  if (!features.registerHooks) reasons.push({ id: 'no-resolve-hook' });
  if (!dataDir.ok) reasons.push({ id: 'data-dir', check: dataDir });
  if (reasons.length > 0) return { mode: 'ui-only', reasons, notes };
  return { mode: 'working', dataDir, notes };
}

function describeReason(r: UiOnlyReason): string {
  switch (r.id) {
    case 'integrity-low':
      return `low integrity (S-1-16-${r.rid})`;
    case 'integrity-unknown':
      return `integrity ${describeIntegrity(r.integrity)}`;
    case 'no-resolve-hook':
      return 'module.registerHooks missing, the import fence has no resolve hook';
    case 'data-dir':
      return `data dir: ${describeDataDir(r.check)}`;
  }
}

export function describeNote(n: StartupNote): string {
  return n.id === 'zstd-missing' ? 'zlib zstd missing: the DSH source stays off' : `node ${n.node} is below ${n.min}`;
}

/** The one console line for a plan that does not work; null for working. */
export function planMessage(plan: StartupPlan): string | null {
  switch (plan.mode) {
    case 'exit':
      return plan.reason === 'elevated'
        ? `orchestrad: refusing to run elevated (${describeIntegrity(plan.integrity)}); start it from a normal, non-administrator console`
        : `orchestrad: cannot start, missing: ${plan.missing.join(', ')}`;
    case 'ui-only':
      return `orchestrad: ui-only: ${plan.reasons.map(describeReason).join('; ')}. This build has no UI to serve yet, so it stops here (exit ${EXIT.uiOnly}).`;
    case 'working':
      return null;
  }
}
