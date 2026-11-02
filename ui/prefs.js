// @ts-check
// Per-viewer conveniences in localStorage (orchestra app plan §5): the theme; and the controller token in
// sessionStorage. Every access is in try/catch; the page works the same when storage is blocked or empty.

const THEMES = ['auto', 'light', 'dark'];
const KEY = 'orchestra.tower.theme';

/** @returns {'auto' | 'light' | 'dark'} */
export function getTheme() {
  let v = null;
  try {
    v = localStorage.getItem(KEY);
  } catch {
    v = null;
  }
  return v !== null && THEMES.includes(v) ? /** @type {'auto' | 'light' | 'dark'} */ (v) : 'auto';
}

/** @param {'auto' | 'light' | 'dark'} theme */
export function setTheme(theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}

// The controller token (slice design §2.7): this tab's session storage, per origin (port included).
/** @returns {string | null} */
export function getCsrf() {
  try {
    const v = sessionStorage.getItem('orchestra.csrf');
    return v !== null && /^[\w-]{43}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Keeps the token; null drops it. Blocked storage: it lasts as long as the page. @param {string | null} v */
export function setCsrf(v) {
  try {
    if (v === null) sessionStorage.removeItem('orchestra.csrf');
    else sessionStorage.setItem('orchestra.csrf', v);
  } catch {}
}
