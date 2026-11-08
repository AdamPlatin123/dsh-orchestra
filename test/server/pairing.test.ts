import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { Log } from '../../src/runtime/log.ts';
import { PAIR_TTL_MS, PEEK_HOST, makePairing, startPeekServer } from '../../src/server/http.ts';
import { humanJournal } from '../../src/server/owned.ts';
import type { PairingsIo } from '../../src/server/pairings.ts';
import { PAIRINGS_MAX, PAIRING_TTL_MS, makePairings } from '../../src/server/pairings.ts';
import { CSRF_RE } from '../../src/server/routes.ts';
import { pairBrowser } from '../helpers/pair.ts';
import { realIo } from '../helpers/read-io.ts';
import { mustOpen, storeFixture } from '../helpers/store.ts';
import { withTmp } from '../helpers/tmp.ts';

// The remembered browsers (src/server/pairings.ts; 2026-11-08: pair once): digests only, 16 at most, 90
// days each, saved on every change and read back at the start; a broken file is none remembered, never a
// crash. The routes that use them are in owned-http.test.ts; the restart of a real orchestrad there too.

const WALL = Date.parse('2026-11-08T00:00:00Z');

function memIo(text: string | null = null): PairingsIo & { text: string | null; saves: number } {
  const io = {
    text, saves: 0,
    load: () => io.text,
    save: (t: string) => {
      io.text = t;
      io.saves++;
    },
  };
  return io;
}

test('pair, has, holds, forget: a token is good only with its own sid, in constant-time form; nothing raw is kept', () => {
  const hub = new VirtualClock({ mono: 0, wall: WALL });
  const io = memIo();
  const p = makePairings({ nowWall: () => hub.port(null).nowWall(), io, log: new Log({ clock: hub.port(null) }) });
  assert.equal(p.count, 0);
  const a = p.pair();
  const b = p.pair();
  assert.match(a.sid, CSRF_RE);
  assert.match(a.csrf, CSRF_RE);
  assert.equal(p.count, 2);
  assert.equal(io.saves, 2, 'saved on every change');
  for (const s of [a.sid, a.csrf, b.sid, b.csrf]) assert.equal(io.text!.includes(s), false, 'digests only on disk');
  assert.deepEqual(Object.keys(JSON.parse(io.text!)), ['v', 'browsers']);
  assert.equal(p.has(a.sid), true);
  assert.equal(p.holds(a.sid, a.csrf), true);
  assert.equal(p.holds(a.sid, b.csrf), false, 'another browser\'s token');
  assert.equal(p.holds(b.sid, a.csrf), false);
  for (const bad of [undefined, '', 'x', a.csrf.slice(1), `${a.csrf}=`, ['x'], 42]) assert.equal(p.holds(a.sid, bad), false, String(bad));
  assert.equal(p.has('orchestra-forged'), false);
  assert.equal(p.forget(a.sid), true);
  assert.equal(p.has(a.sid), false);
  assert.equal(p.holds(a.sid, a.csrf), false, 'dead after forget');
  assert.equal(p.forget(a.sid), false);
  assert.equal(p.holds(b.sid, b.csrf), true, 'the other browser stays');
  assert.equal(io.saves, 3);
});

test('remembered across a restart: a new store over the saved text knows the browser; 90 days later it is dead, dropped on load and on check', () => {
  const hub = new VirtualClock({ mono: 0, wall: WALL });
  const log = new Log({ clock: hub.port(null) });
  const io = memIo();
  const first = makePairings({ nowWall: () => hub.port(null).nowWall(), io, log });
  const old = first.pair();
  hub.advanceBy(PAIRING_TTL_MS - 1000);
  const young = first.pair();
  const again = makePairings({ nowWall: () => hub.port(null).nowWall(), io, log });
  assert.equal(again.count, 2);
  assert.equal(again.holds(old.sid, old.csrf), true);
  // Just past 90 days for the old one: dead on the check, and saved without it.
  hub.advanceBy(1001);
  const saves = io.saves;
  assert.equal(again.has(old.sid), false);
  assert.equal(again.count, 1);
  assert.equal(io.saves, saves + 1);
  assert.equal(again.holds(young.sid, young.csrf), true);
  // And on load: both past 90 days are dropped at once.
  hub.advanceBy(PAIRING_TTL_MS);
  const later = makePairings({ nowWall: () => hub.port(null).nowWall(), io, log });
  assert.equal(later.count, 0);
  assert.deepEqual(JSON.parse(io.text!).browsers, []);
});

test('at most 16: the 17th browser pushes out the one paired first', () => {
  const hub = new VirtualClock({ mono: 0, wall: WALL });
  const p = makePairings({ nowWall: () => hub.port(null).nowWall(), io: memIo(), log: new Log({ clock: hub.port(null) }) });
  const all = [];
  for (let i = 0; i < PAIRINGS_MAX + 1; i++) {
    all.push(p.pair());
    hub.advanceBy(1000);
  }
  assert.equal(PAIRINGS_MAX, 16);
  assert.equal(p.count, 16);
  assert.equal(p.has(all[0]!.sid), false, 'the oldest went');
  for (const b of all.slice(1)) assert.equal(p.holds(b.sid, b.csrf), true);
});

test('a broken, unreadable or odd file: a warning without its text, none remembered, no crash; the next save rewrites it', () => {
  const hub = new VirtualClock({ mono: 0, wall: WALL });
  const secret = 'sekrit-0123456789';
  for (const [text, why] of [[`{not json ${secret}`, 'bad-json'], [JSON.stringify({ v: 2, browsers: [] }), 'bad-shape'], [JSON.stringify({ v: 1, browsers: [{ sidSha256: secret, csrfSha256: 'a'.repeat(64), pairedAt: 1 }] }), 'bad-shape']] as const) {
    const log = new Log({ clock: hub.port(null) });
    const io = memIo(text);
    const p = makePairings({ nowWall: () => hub.port(null).nowWall(), io, log });
    assert.equal(p.count, 0, why);
    const w = log.entries().find((e) => e.event === 'pairings-unreadable');
    assert.deepEqual(w?.fields, { why }, why);
    assert.equal(JSON.stringify(log.entries()).includes(secret), false);
    p.pair();
    assert.equal(JSON.parse(io.text!).browsers.length, 1, 'rewritten');
  }
  const log = new Log({ clock: hub.port(null) });
  const p = makePairings({ nowWall: () => hub.port(null).nowWall(), io: { load: () => { throw new Error('EACCES'); }, save: () => { throw new Error('EROFS'); } }, log });
  assert.equal(p.count, 0);
  const b = p.pair();
  assert.equal(p.holds(b.sid, b.csrf), true, 'a failed save keeps it in memory');
  assert.deepEqual(log.entries().filter((e) => e.event.startsWith('pairings-')).map((e) => e.event), ['pairings-unreadable', 'pairings-save-failed']);
  assert.equal(JSON.stringify(log.entries()).includes(b.csrf), false);
});

test('the console code: issue replaces it and its count in a row, the count in all stays; shut, issue gives none', () => {
  const p = makePairing(null, 0);
  assert.equal(p.attempt('12345678', 0), 'no-code');
  const a = p.issue(0)!;
  assert.match(a, /^[0-9]{8}$/);
  const other = (c: string) => (c === '99999999' ? '99999998' : '99999999');
  for (let i = 0; i < 4; i++) assert.equal(p.attempt(other(a), 0), 'wrong');
  const b = p.issue(10)!;
  assert.equal(p.attempt(a === b ? other(b) : a, 10), 'wrong', 'the old code is replaced');
  assert.equal(p.attempt(b, 10 + PAIR_TTL_MS), 'ok', 'the 10 minutes run from its own issue');
  let n = 5;
  while (n < 20) {
    const k = p.issue(0)!;
    for (let i = 0; i < 4 && n < 20; i++, n++) p.attempt(other(k), 0);
  }
  assert.equal(p.open, false);
  assert.equal(p.issue(0), null);
  assert.equal(p.attempt('12345678', 0), 'shut');
});

async function serve(t: TestContext, file: string) {
  const sf = await storeFixture(t);
  const store = mustOpen(sf).store;
  const clock = sf.clock.port(null);
  const log = new Log({ clock });
  const pairings = makePairings({
    nowWall: () => clock.nowWall(), log,
    io: { load: () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null), save: (text) => fs.writeFileSync(file, text) },
  });
  const server = await startPeekServer({
    port: 0, gate: new ReadGate({ roots: [], io: realIo, testDirs: [sf.dir] }), roots: [], redact: (s) => s, clock, log, pairingCode: pairings.count === 0 ? '12345678' : null,
    profile: 'test', pairings, owned: { journal: humanJournal(store) },
  });
  return { server, store, log, pairings };
}

function get(port: number, p: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { host: `${PEEK_HOST}:${port}`, ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end();
  });
}

test('in process, over a file: paired before a restart, the cookie and the token work after it with no code', async (t) => {
  const file = path.join(withTmp(t), 'pairings.json');
  const one = await serve(t, file);
  const { cookie, csrf } = await pairBrowser(one.server, '12345678');
  await one.server.close();
  one.store.close();
  const two = await serve(t, file);
  t.after(() => two.server.close());
  assert.equal(two.pairings.count, 1);
  const h = { cookie, 'sec-fetch-site': 'same-origin', 'x-orchestra-csrf': csrf };
  assert.equal(await get(two.server.port, '/api/tower', { cookie }), 200);
  // Past the chain to the route itself (no handler here: 501), so the token was taken.
  assert.equal(await get(two.server.port, '/api/owned', h), 501);
  assert.equal(await get(two.server.port, '/api/owned', { ...h, 'x-orchestra-csrf': csrf.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) }), 403);
  for (const s of [csrf, cookie.split('=')[1]!]) assert.equal(fs.readFileSync(file, 'utf8').includes(s), false);
});
