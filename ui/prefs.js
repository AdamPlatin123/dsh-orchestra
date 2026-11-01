// @ts-check
// Per-viewer conveniences in localStorage (0.1 alpha design §5): the theme and the last lane. Every
// access is in try/catch, and the page works the same when storage is blocked or empty.

const THEMES = ['auto', 'light', 'dark'];

/** @param {string} k */
function get(k) {
  try {
    return localStorage.getItem(`orchestra.stage.${k}`);
  } catch {
    return null;
  }
}

/** @param {string} k @param {string} v */
function put(k, v) {
  try {
    localStorage.setItem(`orchestra.stage.${k}`, v);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

/** @returns {'auto' | 'light' | 'dark'} */
export function getTheme() {
  const t = get('theme');
  return t !== null && THEMES.includes(t) ? /** @type {'auto' | 'light' | 'dark'} */ (t) : 'auto';
}

/** @param {'auto' | 'light' | 'dark'} t */
export const setTheme = (t) => put('theme', t);

/** @returns {string | null} */
export function getLane() {
  const l = get('lane');
  return l !== null && /^[0-9a-f]{20}$/.test(l) ? l : null;
}

/** @param {string} id */
export const setLane = (id) => put('lane', id);
