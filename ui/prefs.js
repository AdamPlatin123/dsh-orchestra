// @ts-check
// Per-viewer conveniences in localStorage (orchestra app plan §5): the theme. Every access is in
// try/catch, and the page works the same when storage is blocked or empty.

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
