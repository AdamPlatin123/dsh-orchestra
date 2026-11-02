// A small DOM for the page's tests (UI design UID:164, 0.1 alpha design §5): elements, text, templates
// with .content, dataset, classList, attributes, createElementNS, and a parser for the markup subset
// ui/tower.html uses, so a test can patch the real templates. Every write to the tree is counted in
// doc.ops (the render budget: an identical render writes nothing). innerHTML, outerHTML and
// insertAdjacentHTML throw: the page never parses markup (Trusted Types: trusted-types 'none').
// jsdom and happy-dom are out (UID:311); this is only what the tower page needs.

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const VOID = new Set(['meta', 'link', 'input', 'br', 'img', 'hr', 'source', 'wbr']);

export type Op = { kind: string; target: string };

class FakeNode {
  parentNode: FakeElement | FakeFragment | null = null;
  readonly ownerDocument: FakeDocument;
  constructor(doc: FakeDocument) { this.ownerDocument = doc; }
  get textContent(): string { return ''; }
  cloneNode(_deep?: boolean): FakeNode { throw new Error('cloneNode: subclass'); }
  get nextSibling(): FakeNode | null {
    const p = this.parentNode;
    if (p === null) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
  }
  remove(): void {
    if (this.parentNode !== null) this.parentNode.removeChild(this);
  }
}

export class FakeText extends FakeNode {
  data: string;
  constructor(doc: FakeDocument, data: string) { super(doc); this.data = data; }
  get textContent(): string { return this.data; }
  cloneNode(): FakeText { return new FakeText(this.ownerDocument, this.data); }
}

class FakeParent extends FakeNode {
  childNodes: FakeNode[] = [];
  get children(): FakeElement[] { return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement); }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get firstElementChild(): FakeElement | null { return this.children[0] ?? null; }
  get textContent(): string { return this.childNodes.map((n) => n.textContent).join(''); }
  /** Appends during parsing or cloning, without counting a write. */
  adopt(n: FakeNode): void {
    n.parentNode = this as unknown as FakeElement;
    this.childNodes.push(n);
  }
  appendChild(n: FakeNode): FakeNode { return this.insertBefore(n, null); }
  insertBefore(n: FakeNode, ref: FakeNode | null): FakeNode {
    if (ref !== null && ref.parentNode !== (this as unknown)) throw new Error('insertBefore: ref is not a child');
    this.ownerDocument.count('insertBefore', this);
    if (n.parentNode !== null) n.parentNode.childNodes.splice(n.parentNode.childNodes.indexOf(n), 1);
    const i = ref === null ? this.childNodes.length : this.childNodes.indexOf(ref);
    this.childNodes.splice(i, 0, n);
    n.parentNode = this as unknown as FakeElement;
    return n;
  }
  removeChild(n: FakeNode): FakeNode {
    const i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error('removeChild: not a child');
    this.ownerDocument.count('remove', this);
    this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  /** Elements below this one, depth first. */
  *walk(): Generator<FakeElement> {
    for (const c of this.children) {
      yield c;
      yield* c.walk();
    }
  }
  querySelectorAll(sel: string): FakeElement[] {
    const m = matcher(sel);
    return [...this.walk()].filter(m);
  }
  querySelector(sel: string): FakeElement | null { return this.querySelectorAll(sel)[0] ?? null; }
  /** This node or one of its descendants. */
  contains(n: unknown): boolean {
    for (let x = n instanceof FakeNode ? n : null; x !== null; x = x.parentNode as FakeNode | null) if (x === (this as unknown)) return true;
    return false;
  }
}

export class FakeFragment extends FakeParent {
  cloneNode(deep = false): FakeFragment {
    const f = new FakeFragment(this.ownerDocument);
    if (deep) for (const c of this.childNodes) f.adopt(c.cloneNode(true));
    return f;
  }
}

/** Matches `tag`, `#id`, `.cls`, `[attr]` and `[attr=value]`, one simple selector or a comma list of them. */
function matcher(sel: string): (e: FakeElement) => boolean {
  const parts = sel.split(',').map((s) => s.trim());
  return (e) => parts.some((p) => {
    const a = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(p);
    if (a !== null) return a[2] === undefined ? e.hasAttribute(a[1]!) : e.getAttribute(a[1]!) === a[2];
    if (p.startsWith('#')) return e.getAttribute('id') === p.slice(1);
    if (p.startsWith('.')) return e.classList.contains(p.slice(1));
    return e.localName === p;
  });
}

const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export class FakeElement extends FakeParent {
  readonly attrs = new Map<string, string>();
  readonly content: FakeFragment | null;
  readonly dataset: Record<string, string | undefined>;
  readonly classList: { add(c: string): void; remove(c: string): void; contains(c: string): boolean; toggle(c: string, on?: boolean): boolean };
  selectedIndex = -1;
  open = false;
  focused = false;

  readonly localName: string;
  readonly namespaceURI: string;

  constructor(doc: FakeDocument, localName: string, namespaceURI: string) {
    super(doc);
    this.localName = localName;
    this.namespaceURI = namespaceURI;
    this.content = localName === 'template' ? new FakeFragment(doc) : null;
    const el = this;
    this.dataset = new Proxy({} as Record<string, string | undefined>, {
      get: (_t, k) => (typeof k === 'string' ? el.attrs.get(`data-${kebab(k)}`) : undefined),
      set: (_t, k, v) => {
        if (typeof k !== 'string') return false;
        el.ownerDocument.count('dataset', el);
        el.attrs.set(`data-${kebab(k)}`, String(v));
        return true;
      },
      has: (_t, k) => typeof k === 'string' && el.attrs.has(`data-${kebab(k)}`),
      ownKeys: () => [...el.attrs.keys()].filter((a) => a.startsWith('data-')).map((a) => a.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())),
      getOwnPropertyDescriptor: (_t, k) => (typeof k === 'string' && el.attrs.has(`data-${kebab(k)}`) ? { enumerable: true, configurable: true, value: el.attrs.get(`data-${kebab(k)}`) } : undefined),
    });
    const list = () => (el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
    const put = (cs: string[]) => el.attrs.set('class', cs.join(' '));
    this.classList = {
      add: (c) => { el.ownerDocument.count('classList', el); if (!list().includes(c)) put([...list(), c]); },
      remove: (c) => { el.ownerDocument.count('classList', el); put(list().filter((x) => x !== c)); },
      contains: (c) => list().includes(c),
      toggle: (c, on) => {
        const want = on ?? !list().includes(c);
        if (want) el.classList.add(c);
        else el.classList.remove(c);
        return want;
      },
    };
  }

  get tagName(): string { return this.namespaceURI === HTML_NS ? this.localName.toUpperCase() : this.localName; }
  get id(): string { return this.attrs.get('id') ?? ''; }
  get nextElementSibling(): FakeElement | null {
    const p = this.parentNode;
    if (p === null) return null;
    const sibs = p.children;
    return sibs[sibs.indexOf(this) + 1] ?? null;
  }
  get textContent(): string { return super.textContent; }
  set textContent(v: string) {
    this.ownerDocument.count('textContent', this);
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = v === '' ? [] : [new FakeText(this.ownerDocument, v)];
    for (const c of this.childNodes) c.parentNode = this;
  }
  getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string): boolean { return this.attrs.has(k); }
  setAttribute(k: string, v: string): void {
    this.ownerDocument.count('setAttribute', this);
    this.attrs.set(k, String(v));
  }
  removeAttribute(k: string): void {
    this.ownerDocument.count('removeAttribute', this);
    this.attrs.delete(k);
  }
  closest(sel: string): FakeElement | null {
    const m = matcher(sel);
    for (let e: FakeElement | FakeFragment | null = this; e instanceof FakeElement; e = e.parentNode) if (m(e)) return e;
    return null;
  }
  focus(): void { this.focused = true; }
  showModal(): void { this.ownerDocument.count('showModal', this); this.open = true; }
  close(): void { this.ownerDocument.count('close', this); this.open = false; }
  cloneNode(deep = false): FakeElement {
    const e = new FakeElement(this.ownerDocument, this.localName, this.namespaceURI);
    for (const [k, v] of this.attrs) e.attrs.set(k, v);
    if (deep) {
      for (const c of this.childNodes) e.adopt(c.cloneNode(true));
      if (this.content !== null && e.content !== null) for (const c of this.content.childNodes) e.content.adopt(c.cloneNode(true));
    }
    return e;
  }
  get innerHTML(): string { throw new Error('innerHTML: the page never parses markup'); }
  set innerHTML(_v: string) { throw new Error('innerHTML: the page never parses markup'); }
  get outerHTML(): string { throw new Error('outerHTML: the page never parses markup'); }
  set outerHTML(_v: string) { throw new Error('outerHTML: the page never parses markup'); }
  insertAdjacentHTML(): void { throw new Error('insertAdjacentHTML: the page never parses markup'); }
}

export class FakeDocument extends FakeParent {
  ops: Op[] = [];
  title = '';
  constructor() { super(null as unknown as FakeDocument); (this as { ownerDocument: FakeDocument }).ownerDocument = this; }
  count(kind: string, target: FakeNode): void {
    this.ops.push({ kind, target: target instanceof FakeElement ? target.localName : 'node' });
  }
  cloneNode(): FakeDocument { throw new Error('not needed'); }
  get documentElement(): FakeElement | null { return this.firstElementChild; }
  get body(): FakeElement | null { return this.querySelector('body'); }
  createElement(tag: string): FakeElement { return new FakeElement(this, tag.toLowerCase(), HTML_NS); }
  createElementNS(ns: string, tag: string): FakeElement { return new FakeElement(this, tag, ns); }
  createTextNode(s: string): FakeText { return new FakeText(this, s); }
  getElementById(id: string): FakeElement | null { return this.querySelector(`#${id}`); }
  /** Forgets the writes so far: the next render's are the ones that count. */
  resetOps(): void { this.ops = []; }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENTITIES[e] ?? m;
});

/**
 * Parses the markup subset of ui/tower.html into a fresh document: elements, attributes (quoted, bare
 * or boolean), text, comments, the doctype, void elements, `/>` (SVG), and <template> children into
 * .content. Elements inside <svg> get the SVG namespace. Not a general HTML parser.
 */
export function parseHtml(html: string): FakeDocument {
  const doc = new FakeDocument();
  const stack: { node: FakeParent; ns: string; tag: string }[] = [{ node: doc, ns: HTML_NS, tag: '#document' }];
  const top = () => stack[stack.length - 1]!;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>|([^<]+)/gi;
  for (const m of html.matchAll(re)) {
    const [all, close, open, attrText, selfClose, text] = m;
    if (all.startsWith('<!')) continue;
    if (close !== undefined) {
      const tag = close.toLowerCase();
      while (stack.length > 1 && top().tag !== tag) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (open !== undefined) {
      const tag = open.toLowerCase() === 'svg' ? 'svg' : top().ns === SVG_NS ? open : open.toLowerCase();
      const ns = tag === 'svg' || top().ns === SVG_NS ? SVG_NS : HTML_NS;
      const el = new FakeElement(doc, tag, ns);
      for (const a of (attrText ?? '').matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
        el.attrs.set(a[1]!, decode(a[2] ?? a[3] ?? a[4] ?? ''));
      }
      const parent = top().node;
      const into = parent instanceof FakeElement && parent.content !== null ? parent.content : parent;
      into.adopt(el);
      if (selfClose !== '/' && !(ns === HTML_NS && VOID.has(tag))) stack.push({ node: el, ns, tag: tag.toLowerCase() });
      continue;
    }
    if (text !== undefined && text.trim() !== '') {
      const parent = top().node;
      const into = parent instanceof FakeElement && parent.content !== null ? parent.content : parent;
      into.adopt(new FakeText(doc, decode(text)));
    }
  }
  return doc;
}
