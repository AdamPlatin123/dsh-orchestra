// @ts-check
// The page's one DOM writer (orchestra app plan §5): a keyed patcher of <template> clones. An identical
// render writes nothing; no markup is parsed; a keyed node keeps its identity (focus) and moves only if it must.
import { frozen } from '../shared/frozen.js';
import { TOWER_TEXT } from '../shared/strings.js';

/**
 * What one element gets: text, data-*, classes, attributes from ATTRS (null removes one), named
 * descendants (data-slot) and keyed children.
 * @typedef {{ text?: string, data?: Record<string, string>, cls?: string, attr?: Record<string, string | null>, slots?: Record<string, Paint>, kids?: readonly Desc[] }} Paint
 * @typedef {Paint & { key: string, tpl: string }} Desc
 */

/** What setAttribute may write: ARIA, tabindex, title, disabled, value, a wire's geometry. Never href, style or on*. */
export const ATTRS = frozen([
  'aria-pressed', 'aria-current', 'aria-level', 'aria-expanded', 'aria-selected', 'aria-setsize', 'aria-posinset',
  'aria-busy', 'aria-label', 'aria-disabled', 'tabindex', 'title', 'disabled', 'value', 'd', 'cx', 'cy',
]);

/**
 * @param {Document} doc
 */
export function makePatcher(doc) {
  /** @type {WeakMap<Element, Map<string, Element>>} */
  const slots = new WeakMap();
  /** @type {WeakMap<Element, string>} */
  const classes = new WeakMap();
  /** @type {WeakMap<Element, Map<string, Element>>} */
  const lists = new WeakMap();

  /** A fresh copy of a template's one element. @param {string} id */
  function clone(id) {
    const t = /** @type {HTMLTemplateElement | null} */ (doc.getElementById(id));
    const root = t === null ? null : t.content.firstElementChild;
    if (root === null) throw new Error(`no template ${id}`);
    return /** @type {Element} */ (root.cloneNode(true));
  }

  /** The descendant marked data-slot=name, looked up once per node. @param {Element} el @param {string} name */
  function slot(el, name) {
    let m = slots.get(el);
    if (m === undefined) slots.set(el, (m = new Map()));
    let s = m.get(name);
    if (s === undefined) {
      s = find(el, name);
      if (s === null) throw new Error(`no slot ${name}`);
      m.set(name, s);
    }
    return s;
  }

  /** @param {Element} el @param {string} name @returns {Element | null} */
  function find(el, name) {
    for (const c of Array.from(el.children)) {
      if (c.getAttribute('data-slot') === name) return c;
      const d = find(c, name);
      if (d !== null) return d;
    }
    return null;
  }

  /** @param {Element} el @param {Paint} p */
  function paint(el, p) {
    if (p.text !== undefined && el.textContent !== p.text) el.textContent = p.text;
    if (p.data !== undefined) {
      const ds = /** @type {HTMLElement} */ (el).dataset;
      for (const [k, v] of Object.entries(p.data)) if (ds[k] !== v) ds[k] = v;
    }
    if (p.cls !== undefined) {
      const prev = classes.get(el) ?? '';
      if (prev !== p.cls) {
        const want = p.cls.split(' ').filter(Boolean);
        for (const c of prev.split(' ').filter(Boolean)) if (!want.includes(c)) el.classList.remove(c);
        for (const c of want) if (!el.classList.contains(c)) el.classList.add(c);
        classes.set(el, p.cls);
      }
    }
    if (p.attr !== undefined) {
      for (const [k, v] of Object.entries(p.attr)) {
        if (!ATTRS.includes(k)) throw new Error(`attribute ${k} is not on the patcher's list`);
        if (v === null) {
          if (el.hasAttribute(k)) el.removeAttribute(k);
        } else if (el.getAttribute(k) !== v) el.setAttribute(k, v);
      }
    }
    if (p.slots !== undefined) for (const [name, sp] of Object.entries(p.slots)) paint(slot(el, name), sp);
    if (p.kids !== undefined) list(el, p.kids);
  }

  /**
   * Keyed children of `parent` in `descs` order; the rest go, and a node in its place costs nothing.
   * @param {Element} parent @param {readonly Desc[]} descs
   */
  function list(parent, descs) {
    const had = lists.get(parent) ?? new Map();
    /** @type {Map<string, Element>} */
    const next = new Map();
    // Stale nodes go first: the rest stay in place.
    const keep = new Set(descs.map((d) => d.key));
    for (const [k, n] of had) if (!keep.has(k)) n.remove();
    let ref = parent.firstElementChild;
    for (const d of descs) {
      let n = had.get(d.key);
      const fresh = n === undefined;
      if (n === undefined) n = clone(d.tpl);
      paint(n, d);
      if (n === ref) ref = ref.nextElementSibling;
      else if (!fresh && 'moveBefore' in parent) /** @type {any} */ (parent).moveBefore(n, ref);
      else parent.insertBefore(n, ref);
      next.set(d.key, n);
    }
    lists.set(parent, next);
  }

  /** The keyed node of `parent` under `key`, if the last list put one there. @param {Element} parent @param {string} key */
  const keyed = (parent, key) => lists.get(parent)?.get(key) ?? null;

  /** At boot: each [data-t] in the page and its templates takes its TOWER_TEXT. */
  function fillStatic() {
    const roots = [doc, ...Array.from(doc.querySelectorAll('template')).map((t) => /** @type {HTMLTemplateElement} */ (t).content)];
    for (const r of roots) {
      for (const el of Array.from(r.querySelectorAll('[data-t]'))) {
        const k = /** @type {string} */ (el.getAttribute('data-t'));
        if (!Object.hasOwn(TOWER_TEXT, k)) throw new Error(`no text ${k}`);
        if (el.textContent !== TOWER_TEXT[k]) el.textContent = TOWER_TEXT[k];
      }
    }
  }

  /** @param {string} id */
  const byId = (id) => {
    const el = doc.getElementById(id);
    if (el === null) throw new Error(`no #${id}`);
    return el;
  };

  return {
    clone,
    slot,
    paint,
    list,
    keyed,
    fillStatic,
    byId,
    /** Paints the element with that id. @param {string} id @param {Paint} p */
    paintId: (id, p) => paint(byId(id), p),
    /** @param {string} t */
    title: (t) => { if (doc.title !== t) doc.title = t; },
    /** @param {Element} el @param {string} text */
    say: (el, text) => { if (el.textContent !== text) el.textContent = text; },
  };
}
