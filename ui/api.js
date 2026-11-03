// @ts-check
// The page's only network calls (orchestra app plan §5), to literal /api/ paths; owned ones carry the token
// (§2.7). An answer: { ok, body } or { ok: false, code } ('unpaired': a bare 403; 'network': unknown, T1).

import { deadline } from './clock.js';

const HEX20 = /^[0-9a-f]{20}$/;
export const TIMEOUT_MS = 4000;
const POST_MS = 15000;
/** The dispatch desk waits on the router model (20 s on the daemon's side) before it answers with the rules alone. */
const SUGGEST_MS = 30000;
const POST_RE = /^(?:owned\/(?:new|unlock|unlock-code|[0-9a-f]{20}\/(?:message|interrupt|end|brake))|approvals\/[0-9a-f]{32}\/(?:allow|deny)|route\/suggest|agent-requests\/[0-9a-f]{20}\/reject)$/;
/** @param {string | null} [csrf] */
const heads = (csrf) => (csrf ? { accept: 'application/json', 'x-orchestra-csrf': csrf } : { accept: 'application/json' });
/** @param {string | null} [csrf] @returns {RequestInit} */
const opts = (csrf) => ({ credentials: 'same-origin', cache: 'no-store', headers: heads(csrf), signal: deadline(TIMEOUT_MS) });

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
  if (res.status === 204) return { ok: true, body: null };
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok && body !== null) return { ok: true, body };
  const err = body !== null && typeof body === 'object' ? /** @type {{ error?: unknown }} */ (body).error : undefined;
  if (typeof err === 'string') return { ok: false, code: err };
  return { ok: false, code: res.status === 403 ? 'unpaired' : `http-${res.status}` };
}

/** GET /api/tower: the whole tower snapshot (shared/tower-contract.js), always 200 when paired. */
export const getTower = () => read(() => fetch('/api/tower', opts()));

/** GET /api/peek/session?id= (the id checked first). @param {string} id @returns {Promise<Answer>} */
export async function getSession(id) {
  if (!HEX20.test(id)) return { ok: false, code: 'bad-id' };
  return read(() => fetch('/api/peek/session?id=' + id, opts()));
}

/** GET /api/owned (shared/owned-contract.js OwnedList). @param {string} csrf */
export const getOwned = (csrf) => read(() => fetch('/api/owned', opts(csrf)));

/** GET /api/owned/:id/feed?after= (OwnedFeed). @param {string} csrf @param {string} id @param {number} after @returns {Promise<Answer>} */
export async function getFeed(csrf, id, after) {
  if (!HEX20.test(id) || !Number.isSafeInteger(after) || after < 0) return { ok: false, code: 'bad-id' };
  return read(() => fetch('/api/owned/' + id + '/feed?after=' + after, opts(csrf)));
}

/** An owned POST: JSON, or no body at all (unlock-code). @param {string | null} csrf @param {string} path after /api/ @param {object | null} body @returns {Promise<Answer>} */
export async function post(csrf, path, body) {
  if (!POST_RE.test(path)) return { ok: false, code: 'bad-id' };
  const json = body === null ? {} : { 'content-type': 'application/json' };
  const init = { method: 'POST', credentials: /** @type {const} */ ('same-origin'), cache: /** @type {const} */ ('no-store'), headers: { ...heads(csrf), ...json }, signal: deadline(path === 'route/suggest' ? SUGGEST_MS : POST_MS) };
  return read(() => fetch('/api/' + path, body === null ? init : { ...init, body: JSON.stringify(body) }));
}
