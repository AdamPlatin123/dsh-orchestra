// @ts-check
// The page's one clock (0.1 alpha design §5, T7): monotonic time, the frame callback, the poll timers
// and the wall-time formatting. A time the page shows is the daemon's observedAt plus a monotonic delta
// measured here; the browser's wall clock is never subtracted from the daemon's.

/** Monotonic milliseconds. */
export const nowMono = () => performance.now();

/** Runs `fn` on the next frame. @param {() => void} fn */
export const onFrame = (fn) => requestAnimationFrame(fn);

/**
 * Calls `fn` every `ms` until the returned stop function runs.
 * @param {number} ms @param {() => void} fn
 * @returns {() => void}
 */
export function every(ms, fn) {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

/** @param {number} ms @returns {AbortSignal} */
export const deadline = (ms) => AbortSignal.timeout(ms);

/** @param {number} n */
const two = (n) => String(n).padStart(2, '0');

/** A daemon wall time (ms) as local hh:mm:ss. @param {number} ms */
export function fmtClock(ms) {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** An event's ISO time (from the daemon) as local hh:mm:ss, or --:--:-- when it does not parse. @param {string} s */
export function fmtIso(s) {
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? fmtClock(ms) : '--:--:--';
}
