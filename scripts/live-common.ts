// What the live runs (scripts/live-smoke.ts, scripts/live-route.ts) share for talking to orchestrad and
// for leaving nothing behind (orchestra app plan, phase 3 review): an HTTP request with a deadline, so a
// reply that never comes cannot hang a run (and keep orchestrad, a host, claude.exe or codex.exe alive);
// the end of an owned session waited out through the stop order before orchestrad is killed (a kill on
// Windows is TerminateProcess: orchestrad's own stop never runs); and a look at the children orchestrad
// recorded (run/pids.jsonl of the test dir) once it is gone, ending only those still there whose image is
// the one the rule started (node.exe for claude-host, codex.exe for codex-app-server), with their trees.
//
// Listed in EXEMPT_SCRIPTS (test/helpers/scan-rules.ts), as the two scripts that use it: it speaks HTTP to
// orchestrad on 127.0.0.1, waits on timers, reads the pid log of a test dir and ends recorded children.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';

/** Longest any one request to orchestrad may take. */
export const REQUEST_MS = 30_000;
/** The Claude host's stop order (src/os/owned-proc.ts HOST_STOP_MS: 3 s + 2 s) and a margin. */
export const STOP_ORDER_MS = 5_500;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string; json: any };

export function request(port: number, host: string, method: string, pathname: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          if ((res.headers['content-type'] ?? '').startsWith('application/json')) json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json });
      });
      res.on('error', reject);
    });
    req.setTimeout(REQUEST_MS, () => req.destroy(new Error(`live: ${method} ${pathname} had no answer within ${REQUEST_MS / 1000} s`)));
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * Ends an owned session and waits until the list says it ended or failed (at most `ms`), then the whole
 * stop order: only then is orchestrad killed. Never throws: what happened is the result.
 */
export async function endAndWait(end: () => Promise<Reply>, state: () => Promise<string | null>, ms = 15_000): Promise<{ endAnswer: number | null; settled: string | null }> {
  let endAnswer: number | null = null;
  try {
    endAnswer = (await end()).status;
  } catch {
    endAnswer = null;
  }
  let settled: string | null = null;
  for (let waited = 0; waited < ms; waited += 500) {
    try {
      settled = await state();
    } catch {
      settled = null;
    }
    if (settled === 'ended' || settled === 'failed') break;
    await sleep(500);
  }
  await sleep(STOP_ORDER_MS);
  return { endAnswer, settled };
}

const IMAGE: Readonly<Record<string, string>> = { 'claude-host': 'node.exe', 'codex-app-server': 'codex.exe' };

/** The image name of a running pid (tasklist), or null when none runs under it. */
function imageOf(pid: number): string | null {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    const m = /^"([^"]+)","(\d+)"/m.exec(out);
    return m !== null && Number(m[2]) === pid ? m[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * After orchestrad is gone: the children it recorded (rules claude-host and codex-app-server) still
 * running under the image their rule starts. Each is ended with its tree (taskkill /T /F) and counted.
 * A pid now running another image is someone else's (pids are reused): it is left alone and counted apart.
 */
export function leftovers(testDir: string): { recorded: number; leftover: number; ended: number; otherImage: number } {
  const file = path.join(testDir, 'orchestra', 'run', 'pids.jsonl');
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {
    lines = [];
  }
  const pids = new Map<number, string>();
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as { rule?: unknown; pid?: unknown };
      if (typeof e.rule === 'string' && Object.hasOwn(IMAGE, e.rule) && typeof e.pid === 'number' && Number.isSafeInteger(e.pid) && e.pid > 0) pids.set(e.pid, e.rule);
    } catch {
      // A torn line: nothing to find in it.
    }
  }
  let leftover = 0;
  let ended = 0;
  let otherImage = 0;
  for (const [pid, rule] of pids) {
    const image = imageOf(pid);
    if (image === null) continue;
    if (image !== IMAGE[rule]) {
      otherImage++;
      continue;
    }
    leftover++;
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000, stdio: 'ignore' });
      ended++;
    } catch {
      // Gone in the meantime, or not ours to end: counted as a leftover all the same.
    }
  }
  return { recorded: pids.size, leftover, ended, otherImage };
}
