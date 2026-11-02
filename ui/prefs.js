// @ts-check
// Per-viewer storage (orchestra app plan §5): the theme (localStorage), the token (sessionStorage). All in
// try/catch: blocked or empty storage changes nothing else.

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

// The token (slice design §2.7): this tab's session storage, per origin and port.
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
