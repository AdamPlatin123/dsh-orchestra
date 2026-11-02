// @ts-check
// The page's one DOM writer (0.1 alpha design §5): a keyed patcher for HTML and SVG. Nodes are <template>
// clones; a write (textContent, dataset, classList, setAttribute from ATTRS) is skipped when the value is
// there, so an identical render writes nothing. No markup is parsed (trusted-types 'none'). A keyed node
// keeps its identity across renders (so a CSS animation runs on) and moves only when its place changed.
import { frozen } from '../shared/frozen.js';
import { STAGE_TEXT } from '../shared/strings.js';

/** @typedef {import('./view.js').Paint} Paint */
/** @typedef {import('./view.js').Desc} Desc */

/** What setAttribute may write: SVG geometry, aria-pressed and aria-current. Never href, style or on*. */
export const ATTRS = frozen(['transform', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'viewBox', 'aria-pressed', 'aria-current']);

/** @param {DOMRect} b @param {number} x @param {number} y */
export function outsideBox(b, x, y) {
  return x < b.left || x > b.right || y < b.top || y > b.bottom;
}

/** @param {{ key: string, isComposing?: boolean }} e */
export function activates(e) {
  return !e.isComposing && (e.key === 'Enter' || e.key === ' ');
}

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

  /** A fresh copy of a template's one element; an <svg> wrapper (for the SVG namespace) is skipped. @param {string} id */
  function clone(id) {
    const t = /** @type {HTMLTemplateElement | null} */ (doc.getElementById(id));
    let root = t === null ? null : t.content.firstElementChild;
    if (root !== null && root.localName === 'svg' && root.firstElementChild !== null) root = root.firstElementChild;
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
        if (el.getAttribute(k) !== v) el.setAttribute(k, v);
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
    // Stale nodes go first, so the ones after them are still in place and need no move.
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

  /** At boot: each [data-t] takes its STAGE_TEXT, each empty .ins the five glyphs (CSS shows one). */
  function fillStatic() {
    const roots = [doc, ...Array.from(doc.querySelectorAll('template')).map((t) => /** @type {HTMLTemplateElement} */ (t).content)];
    const glyphs = clone('tpl-glyph');
    for (const r of roots) {
      for (const el of Array.from(r.querySelectorAll('.ins'))) {
        if (el.firstElementChild === null) for (const c of Array.from(glyphs.children)) el.insertBefore(c.cloneNode(true), null);
      }
      for (const el of Array.from(r.querySelectorAll('[data-t]'))) {
        const k = /** @type {string} */ (el.getAttribute('data-t'));
        if (Object.hasOwn(STAGE_TEXT, k) && el.textContent !== STAGE_TEXT[k]) el.textContent = STAGE_TEXT[k];
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
    paint,
    list,
    fillStatic,
    byId,
    /** Paints the element with that id. @param {string} id @param {Paint} p */
    paintId: (id, p) => paint(byId(id), p),
    /** @param {string} t */
    title: (t) => { if (doc.title !== t) doc.title = t; },
    /** @param {HTMLSelectElement} sel @param {number} i */
    select: (sel, i) => { if (sel.selectedIndex !== i) sel.selectedIndex = i; },
    /** Opens or closes the drawer dialog, modal so focus stays inside and Esc closes it. @param {HTMLDialogElement} d @param {boolean} open */
    drawer: (d, open) => {
      if (open && !d.open) d.showModal();
      else if (!open && d.open) d.close();
    },
    /** @param {Element} el @param {string} text */
    say: (el, text) => { if (el.textContent !== text) el.textContent = text; },
  };
}
