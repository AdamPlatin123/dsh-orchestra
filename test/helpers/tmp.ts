// Fixtures for fs tests. Everything lives in a fresh os.tmpdir()/orchestra-test-* directory, and
// links only ever point inside that directory.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { TestContext } from 'node:test';

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-test-'));
}

/** Removes a fixture tree without ever entering a junction or link. */
export function rmTree(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return;
    throw e;
  }
  if (st.isSymbolicLink()) {
    try {
      fs.unlinkSync(p);
    } catch {
      fs.rmdirSync(p);
    }
    return;
  }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) rmTree(path.join(p, name));
    fs.rmdirSync(p);
    return;
  }
  fs.unlinkSync(p);
}

/** A fresh temp dir removed after the test. */
export function withTmp(t: TestContext): string {
  const dir = tmpDir();
  t.after(() => rmTree(dir));
  return dir;
}

/**
 * withTmp for fixtures Node loads as code (a runner, an entry, a worker module): a package.json at the
 * root ends Node's package-scope lookup there, so loading a file from the fixture never looks for one
 * up the tree (the temp dir's parents, the real home). Its "type" makes every .ts and .js file in the
 * fixture an ES module, as the entries are written.
 */
export function withModuleTmp(t: TestContext): string {
  const dir = withTmp(t);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  return dir;
}

export function put(file: string, content: string | Uint8Array = 'x'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function assertInside(base: string, p: string): void {
  const rel = path.relative(base, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`fixture link would leave ${base}: ${p}`);
}

/** Junction `link` -> `target`, both inside `base`. */
export function junction(base: string, link: string, target: string): void {
  assertInside(base, link);
  assertInside(base, target);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction');
}

export type Probe = { ok: true } | { ok: false; why: string };

/** Can this machine create a directory junction without admin? */
export function probeJunction(): Probe {
  const base = tmpDir();
  try {
    fs.mkdirSync(path.join(base, 't'));
    fs.symlinkSync(path.join(base, 't'), path.join(base, 'j'), 'junction');
    return fs.lstatSync(path.join(base, 'j')).isSymbolicLink() ? { ok: true } : { ok: false, why: 'junction not reported by lstat' };
  } catch (e) {
    return { ok: false, why: `junction creation failed: ${(e as { code?: string }).code}` };
  } finally {
    rmTree(base);
  }
}

/** Can this process create a directory link (needs Developer Mode or admin on Windows)? */
export function probeSymlink(): Probe {
  const base = tmpDir();
  try {
    fs.mkdirSync(path.join(base, 't'));
    fs.symlinkSync(path.join(base, 't'), path.join(base, 'l'), 'dir');
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `directory link creation failed (${(e as { code?: string }).code}); needs Developer Mode or admin` };
  } finally {
    rmTree(base);
  }
}

/** Can the temp volume hold alternate data streams? */
export function probeAds(): Probe {
  const base = tmpDir();
  try {
    const f = path.join(base, 'f.txt');
    fs.writeFileSync(f, 'main');
    fs.writeFileSync(`${f}:s`, 'stream');
    return fs.readFileSync(`${f}:s`, 'utf8') === 'stream' && fs.statSync(f).size === 4
      ? { ok: true }
      : { ok: false, why: 'stream did not round-trip' };
  } catch (e) {
    return { ok: false, why: `temp volume has no alternate data streams (${(e as { code?: string }).code})` };
  } finally {
    rmTree(base);
  }
}

function shortCandidates(name: string): string[] {
  const bare = name.replace(/^[. ]+/, '').toUpperCase();
  const dot = bare.lastIndexOf('.');
  const stem = (dot > 0 ? bare.slice(0, dot) : bare).replace(/[^A-Z0-9_$%'@{}~!#()&^-]/g, '');
  const ext = dot > 0 ? bare.slice(dot + 1).replace(/[^A-Z0-9_$%'@{}~!#()&^-]/g, '').slice(0, 3) : '';
  const out: string[] = [];
  for (let i = 1; i <= 4; i++) out.push(`${stem.slice(0, 6)}~${i}${ext ? `.${ext}` : ''}`);
  return out;
}

/** The 8.3 short name of `dir\name`, or null when the volume does not generate one. */
export function shortNameOf(dir: string, name: string): string | null {
  const long = fs.realpathSync.native(path.join(dir, name)).toLowerCase();
  for (const c of shortCandidates(name)) {
    try {
      if (fs.realpathSync.native(path.join(dir, c)).toLowerCase() === long) return c;
    } catch {
      // not this candidate
    }
  }
  return null;
}

/** Digest of a tree: relative paths, entry types, link targets and file bytes; never follows links. */
export function treeDigest(root: string): string {
  const h = crypto.createHash('sha256');
  const walk = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) h.update(`L ${r} -> ${fs.readlinkSync(p)}\n`);
      else if (st.isDirectory()) {
        h.update(`D ${r}\n`);
        walk(p, r);
      } else {
        h.update(`F ${r} ${st.size}\n`);
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(root, '');
  return h.digest('hex');
}
