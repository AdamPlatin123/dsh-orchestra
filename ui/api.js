// @ts-check
// The page's only network calls (0.1 alpha design §5): two GETs, each with a literal /api/ path. Every
// answer is turned into a value, never a throw: { ok: true, body } or { ok: false, code } with the
// server's error code, 'unpaired' for a 403, 'network' when the daemon cannot be reached or is too slow.

import { deadline } from './clock.js';

const HEX20 = /^[0-9a-f]{20}$/;
export const TIMEOUT_MS = 4000;
/** @returns {RequestInit} */
const opts = () => ({ credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: deadline(TIMEOUT_MS) });

/** @typedef {{ ok: true, body: unknown } | { ok: false, code: string }} Answer */

/** null while a run is out. @template T @param {() => Promise<T>} run @returns {() => Promise<T | null>} */
export function oneAtATime(run) {
  let out = false;
  return async () => {
    if (out) return null;
    out = true;
    try {
      return await run();
    } finally {
      out = false;
    }
  };
}

/** @param {() => Promise<Response>} go @returns {Promise<Answer>} */
async function read(go) {
  let res;
  try {
    res = await go();
  } catch {
    return { ok: false, code: 'network' };
  }
  if (res.status === 403) return { ok: false, code: 'unpaired' };
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body !== null) return { ok: true, body };
  const code = body !== null && typeof body === 'object' && typeof (/** @type {{ error?: unknown }} */ (body)).error === 'string' ? String(/** @type {{ error: string }} */ (body).error) : `http-${res.status}`;
  return { ok: false, code };
}

/** GET /api/peek/stage: the whole snapshot, always 200 when paired. */
export const getStage = () => read(() => fetch('/api/peek/stage', opts()));

/**
 * GET /api/peek/session?id=: one session's last events. The id is checked before it goes into the URL.
 * @param {string} id
 * @returns {Promise<Answer>}
 */
export async function getSession(id) {
  if (!HEX20.test(id)) return { ok: false, code: 'bad-id' };
  return read(() => fetch('/api/peek/session?id=' + id, opts()));
}
