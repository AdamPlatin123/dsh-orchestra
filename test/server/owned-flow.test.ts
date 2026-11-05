import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TestContext } from 'node:test';
import type { ChildPipe } from '../../src/os/child-pipe.ts';
import type { OwnedJob } from '../../src/os/procguard.ts';
import type { ApprovalOutcome, ApprovalView } from '../../src/owned/approvals.ts';
import type { PeekServer } from '../../src/server/http.ts';
import type { Store } from '../../src/store/store.ts';
import { ReadGate } from '../../src/fs/read-gate.ts';
import { realpath } from '../../src/fs/node-io.ts';
import { childPipe } from '../../src/os/child-pipe.ts';
import { makeSpawnGate } from '../../src/os/node-proc.ts';
import { FAKE_CODEX_SCRIPT, resolveSystemRoot } from '../../src/os/spawn.ts';
import { APPROVAL_LIMITS, Approvals } from '../../src/owned/approvals.ts';
import { CodexOwned } from '../../src/owned/codex-owned.ts';
import { Log } from '../../src/runtime/log.ts';
import { PEEK_HOST, startPeekServer } from '../../src/server/http.ts';
import { humanJournal } from '../../src/server/owned.ts';
import { ownedEnabled, ownedList, registerOwnedHandlers } from '../../src/server/owned-handlers.ts';
import { makeRedactor } from '../../src/store/redact.ts';
import { validateOwnedFeed, validateOwnedList } from '../../shared/owned-contract.js';
import { validateTower } from '../../shared/tower-contract.js';
import { realIo } from '../helpers/read-io.ts';
import { mustOpen, storeFixture } from '../helpers/store.ts';
import type { StoreFixture } from '../helpers/store.ts';

// The owned-session routes end to end (orchestra app plan §2-§4): the paired, unlocked page starts an
// owned Codex session over HTTP, the session asks for approval, and the person's answer (or the clock's)
// reaches the child. The child is test/fixtures/fake-codex-app-server.ts under this node.exe, through the
// spawn gate's test-only rule; the queue's clock is the store fixture's VirtualClock, shared with the
// server. No codex.exe, no model, no network; every text is synthetic.

const PAIR = '12345678';
const uuid = () => crypto.randomUUID();

type Rig = {
  sf: StoreFixture; store: Store; server: PeekServer; host: string; origin: string; log: Log; owned: CodexOwned; approvals: Approvals;
  printed: string[]; settled: [ApprovalView, ApprovalOutcome][];
  /** What Orchestra answered to the fake's server requests: [id, result or {error}]. */
  answers(): [string, Record<string, unknown>][];
};

async function rig(t: TestContext, opts: { codex?: boolean; job?: () => OwnedJob; brakeWhy?: string | null } = {}): Promise<Rig> {
  // Registered before the store fixture's own cleanup, so the children are gone before their work dirs are.
  let stop: () => Promise<void> = async () => {};
  t.after(() => stop());
  const sf = await storeFixture(t);
  const store = mustOpen(sf).store;
  const clock = sf.clock;
  const log = new Log({ clock: clock.port(null) });
  const dir = fs.realpathSync.native(sf.dir);
  const home = path.join(dir, 'orchestra-owned');
  const workRoot = path.join(home, 'work');
  const codexHome = path.join(home, 'codex-home');
  fs.mkdirSync(workRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  const fakeLog = path.join(dir, 'fake.log');
  const sys = resolveSystemRoot(process.env, realpath);
  assert.ok(sys.ok, JSON.stringify(sys));
  const gate = makeSpawnGate({
    systemRoot: sys, rules: ['codex-app-server-fake'], record: () => {}, realpath, clock, env: process.env,
    envExtra: { 'codex-app-server-fake': { CODEX_HOME: codexHome, FAKE_CODEX_LOG: fakeLog } },
    cwd: { allowedRoots: [workRoot], protectedDirs: [home], userHome: os.homedir(), ownedWorkRoot: workRoot },
    fakeCodexNode: process.execPath,
  });
  const settled: [ApprovalView, ApprovalOutcome][] = [];
  // The default settle time (750 ms on the Clock): a test moves the virtual clock past it before it allows.
  const approvals = new Approvals({ hub: clock, onSettled: (v, o) => settled.push([v, o]) });
  const redactor = makeRedactor({ env: {} });
  const closes: Promise<void>[] = [];
  const owned = new CodexOwned({
    approvals,
    makeWorkDir: (id) => {
      const d = path.join(workRoot, id);
      fs.mkdirSync(d);
      return d;
    },
    launch: (cwd) => {
      const pipe: ChildPipe = childPipe(gate.start({ exe: process.execPath, argv: [FAKE_CODEX_SCRIPT], cwd }), opts.job?.() ?? null);
      closes.push(new Promise((r) => pipe.onClose(() => r())));
      return pipe;
    },
    now: () => clock.wall,
    redact: (text) => {
      const r = redactor.redact({ text });
      return { text: r.text, count: r.verdict.known + r.verdict.entropy + Object.values(r.verdict.format).reduce((a, b) => a + b, 0) };
    },
  });
  const codex = opts.codex === false ? null : owned;
  const deps = { codex, codexOff: 'not-asked', claude: null, log, ...(opts.brakeWhy === undefined ? {} : { brakeWhy: opts.brakeWhy }) };
  const printed: string[] = [];
  const server = await startPeekServer({
    port: 0, gate: new ReadGate({ roots: [], io: realIo, testDirs: [sf.dir] }), roots: [], redact: (s) => s, clock: clock.port(null), log, pairingCode: PAIR, profile: 'test',
    owned: { journal: humanJournal(store), printUnlockCode: (c) => printed.push(c), enabled: ownedEnabled(deps), handlers: registerOwnedHandlers(deps) },
    ...(codex === null ? {} : { ownedSeats: { seats: () => codex.towerSeats(), nowWall: () => clock.wall } }),
  });
  stop = async () => {
    owned.endAll();
    await Promise.race([Promise.all(closes), new Promise((r) => setTimeout(r, 5000))]);
    await server.close();
  };
  const host = `${PEEK_HOST}:${server.port}`;
  const received = (): Record<string, any>[] => (fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, 'utf8').split('\n').filter((l) => l !== '').flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  }) : []);
  return {
    sf, store, server, host, origin: `http://${host}`, log, owned, approvals, printed, settled,
    answers: () => received().filter((m) => m.method === undefined && typeof m.id === 'string' && m.id.startsWith('srv-')).map((m) => [m.id, m.error !== undefined ? { error: m.error } : m.result]),
  };
}

type Reply = { status: number; body: string; json: any };

function request(r: Rig, method: string, pathname: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: r.server.port, method, path: pathname, headers: { host: r.host, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        if (res.headers['content-type']?.startsWith('application/json')) json = JSON.parse(text);
        resolve({ status: res.statusCode!, body: text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

type Page = { cookie: string; csrf: string | null };

/** Pairs a page and, unless told not to, unlocks it with the code printed to the console. */
async function page(r: Rig, unlock = true): Promise<Page> {
  const cookie = await new Promise<string>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: r.server.port, method: 'POST', path: '/pair',
      headers: { host: r.host, origin: r.origin, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(String(res.headers['set-cookie']).split(';')[0]!));
    });
    req.on('error', reject);
    req.end(`code=${PAIR}`);
  });
  if (!unlock) return { cookie, csrf: null };
  const asked = await request(r, 'POST', '/api/owned/unlock-code', { cookie, origin: r.origin, 'sec-fetch-site': 'same-origin' });
  assert.equal(asked.status, 204);
  const u = await request(r, 'POST', '/api/owned/unlock', heads(r, { cookie, csrf: null }), JSON.stringify({ code: r.printed.at(-1) }));
  assert.equal(u.status, 200, u.body);
  return { cookie, csrf: u.json.csrf as string };
}

const heads = (r: Rig, p: Page): Record<string, string> => ({
  cookie: p.cookie, origin: r.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...(p.csrf === null ? {} : { 'x-orchestra-csrf': p.csrf }),
});
const post = (r: Rig, p: Page, pathname: string, body: Record<string, unknown>) => request(r, 'POST', pathname, heads(r, p), JSON.stringify(body));
const get = (r: Rig, p: Page, pathname: string) => request(r, 'GET', pathname, heads(r, p));

async function until(what: string, cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = performance.now();
  while (!(await cond())) {
    if (performance.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((res) => setTimeout(res, 15));
  }
}

const humans = (r: Rig) => r.store.db.all("SELECT kind, body FROM event WHERE kind IN ('human', 'human.result') ORDER BY jseq")
  .map((x) => ({ kind: String(x.kind), body: JSON.parse(String(x.body)) as Record<string, unknown> }));

/** Starts a session with `text` and waits until its first approval is listed; returns the list as the page saw it. */
async function startAndAsk(r: Rig, p: Page, text: string): Promise<{ ownedId: string; actionId: string; list: any; approval: any }> {
  const actionId = uuid();
  const made = await post(r, p, '/api/owned/new', { actionId, text, harness: 'codex' });
  assert.equal(made.status, 200, made.body);
  const ownedId = made.json.ownedId as string;
  assert.match(ownedId, /^[0-9a-f]{20}$/);
  let list: any = null;
  await until('the approval', async () => {
    const l = await get(r, p, '/api/owned');
    assert.equal(l.status, 200, l.body);
    list = l.json;
    return list.approvals.length > 0;
  });
  const v = validateOwnedList(list);
  assert.ok(v.ok, v.errors.join('\n'));
  return { ownedId, actionId, list, approval: list.approvals[0] };
}

test('unlocked page: new session, its command asks, the person allows after the list settled; the fake hears accept, and both actions are human records', async (t) => {
  const r = await rig(t);
  const p = await page(r);
  const { ownedId, actionId, list, approval } = await startAndAsk(r, p, 'run echo synthetic');
  assert.equal(approval.ownedId, ownedId);
  assert.equal(approval.kind, 'command');
  assert.equal(approval.risk, 'shell');
  assert.equal(approval.high, true, 'a shell is high risk (r4 §10.9)');
  assert.equal(approval.deadline, r.sf.clock.wall + APPROVAL_LIMITS.timeoutMs, 'the deadline is 30 minutes off on the wall clock');
  assert.equal(list.owned[0].waiting, approval.approvalId);
  assert.equal(list.owned[0].title, 'run echo synthetic');
  // Within 750 ms of the change of the list an allow changes nothing.
  const early = await post(r, p, `/api/approvals/${approval.approvalId}/allow`, { actionId: uuid(), digest: approval.digest, rev: list.rev });
  assert.deepEqual([early.status, early.json], [409, { error: 'stale-view' }]);
  r.sf.clock.advanceBy(APPROVAL_LIMITS.settleMs);
  const allowId = uuid();
  const ok = await post(r, p, `/api/approvals/${approval.approvalId}/allow`, { actionId: allowId, digest: approval.digest, rev: list.rev });
  assert.equal(ok.status, 200, ok.body);
  assert.equal(ok.json.accepted, true);
  await until('the accept', () => r.answers().length > 0);
  assert.deepEqual(r.answers(), [['srv-1', { decision: 'accept' }]]);
  // The command ran: its output comes back in the feed, which passes the contract.
  await until('the output', async () => (await get(r, p, `/api/owned/${ownedId}/feed`)).json.events.some((e: any) => e.kind === 'tool-result' && e.state === 'ran'));
  const feed = (await get(r, p, `/api/owned/${ownedId}/feed?after=0`)).json;
  const fv = validateOwnedFeed(feed);
  assert.ok(fv.ok, fv.errors.join('\n'));
  const you = feed.events.find((e: any) => e.kind === 'you');
  assert.equal(you.uuid, actionId, 'your message carries the actionId of its human record');
  assert.ok(feed.events.some((e: any) => e.kind === 'answer' && e.state === 'accept'));
  const later = (await get(r, p, `/api/owned/${ownedId}/feed?after=${feed.to}`)).json;
  assert.deepEqual(later.events, [], 'after= reads only what came since');
  assert.deepEqual(humans(r).map((h) => [h.kind, h.body.verb, h.body.targetId]), [
    ['human', 'owned-new', ownedId], ['human.result', 'owned-new', ownedId],
    ['human', 'approval-allow', approval.approvalId], ['human.result', 'approval-allow', approval.approvalId],
  ]);
  assert.deepEqual(r.settled.map(([, o]) => [o.decision, o.cause]), [['accept', 'human']]);
});

test('deny: the fake hears decline at once, whatever the revision; a second answer finds it gone', async (t) => {
  const r = await rig(t);
  const p = await page(r);
  const { approval } = await startAndAsk(r, p, 'run echo nope');
  const denied = await post(r, p, `/api/approvals/${approval.approvalId}/deny`, { actionId: uuid() });
  assert.equal(denied.status, 200, denied.body);
  await until('the decline', () => r.answers().length > 0);
  assert.deepEqual(r.answers(), [['srv-1', { decision: 'decline' }]]);
  const again = await post(r, p, `/api/approvals/${approval.approvalId}/deny`, { actionId: uuid() });
  assert.deepEqual([again.status, again.json], [409, { error: 'approval-gone' }]);
  r.sf.clock.advanceBy(APPROVAL_LIMITS.settleMs);
  const late = await post(r, p, `/api/approvals/${approval.approvalId}/allow`, { actionId: uuid(), digest: approval.digest, rev: (await get(r, p, '/api/owned')).json.rev });
  assert.deepEqual([late.status, late.json], [409, { error: 'approval-gone' }]);
  assert.deepEqual(humans(r).filter((h) => h.kind === 'human').map((h) => h.body.verb), ['owned-new', 'approval-deny']);
});

test('allow with another digest is refused (digest-mismatch) and declined; another rev changes nothing (stale-view); neither writes a human record', async (t) => {
  const r = await rig(t);
  const p = await page(r);
  const { approval, list } = await startAndAsk(r, p, 'run echo mismatch');
  r.sf.clock.advanceBy(APPROVAL_LIMITS.settleMs);
  const stale = await post(r, p, `/api/approvals/${approval.approvalId}/allow`, { actionId: uuid(), digest: approval.digest, rev: list.rev - 1 });
  assert.deepEqual([stale.status, stale.json], [409, { error: 'stale-view' }]);
  assert.deepEqual(r.answers(), [], 'a stale view answers nothing');
  const wrong = await post(r, p, `/api/approvals/${approval.approvalId}/allow`, { actionId: uuid(), digest: '0'.repeat(64), rev: list.rev });
  assert.deepEqual([wrong.status, wrong.json], [409, { error: 'digest-mismatch' }]);
  await until('the decline', () => r.answers().length > 0);
  assert.deepEqual(r.answers(), [['srv-1', { decision: 'decline' }]], 'what the page did not show is refused');
  assert.deepEqual(humans(r).filter((h) => h.kind === 'human').map((h) => h.body.verb), ['owned-new']);
  assert.ok(r.log.entries().some((e) => e.event === 'approval-declined-mismatch'));
});

test('nobody answers: after 30 minutes on the Clock the queue declines by itself (cause clock), the fake hears decline, the feed says auto-denied', async (t) => {
  const r = await rig(t);
  const p = await page(r);
  const { ownedId, approval } = await startAndAsk(r, p, 'run echo timeout');
  r.sf.clock.advanceBy(APPROVAL_LIMITS.timeoutMs - 1);
  assert.equal(r.approvals.list().length, 1, 'still open a millisecond before');
  r.sf.clock.advanceBy(1);
  await until('the decline', () => r.answers().length > 0);
  assert.deepEqual(r.answers(), [['srv-1', { decision: 'decline' }]]);
  assert.deepEqual(r.settled.map(([v, o]) => [v.approvalId, o.decision, o.cause]), [[approval.approvalId, 'decline', 'clock']]);
  const feed = (await get(r, p, `/api/owned/${ownedId}/feed`)).json;
  assert.ok(feed.events.some((e: any) => e.kind === 'auto-denied' && e.ref === approval.approvalId && e.state === 'clock'), JSON.stringify(feed.events));
  const list = (await get(r, p, '/api/owned')).json;
  assert.deepEqual([list.approvals, list.owned[0].waiting], [[], null]);
  assert.deepEqual(humans(r).filter((h) => h.kind === 'human').map((h) => h.body.verb), ['owned-new'], 'the clock is no person');
});

test('not unlocked: every owned route answers 403, the list and the approvals included; nothing starts', async (t) => {
  const r = await rig(t);
  const locked = await page(r, false);
  const tries: [string, string, Record<string, unknown> | null][] = [
    ['GET', '/api/owned', null],
    ['POST', '/api/owned/new', { actionId: uuid(), text: 'say hi', harness: 'codex' }],
    ['POST', `/api/approvals/${'a'.repeat(32)}/allow`, { actionId: uuid(), digest: '0'.repeat(64), rev: 1 }],
    ['POST', `/api/approvals/${'a'.repeat(32)}/deny`, { actionId: uuid() }],
  ];
  for (const [m, pth, body] of tries) {
    const res = m === 'GET' ? await get(r, locked, pth) : await post(r, locked, pth, body!);
    assert.deepEqual([res.status, res.json], [403, { error: 'not-unlocked' }], pth);
  }
  assert.equal(r.owned.list().length, 0);
  assert.deepEqual(humans(r), []);
});

test('the tower draws the owned session under its own project, waiting on Orchestra\'s queue with the deadline; the snapshot passes the validator', async (t) => {
  const r = await rig(t);
  const p = await page(r);
  const { ownedId, approval } = await startAndAsk(r, p, 'run echo tower');
  // The tower is a read-only page: the cookie alone reads it.
  const res = await request(r, 'GET', '/api/tower', { cookie: p.cookie, 'sec-fetch-site': 'same-origin' });
  assert.equal(res.status, 200, res.body);
  const tower = res.json;
  const v = validateTower(tower);
  assert.ok(v.ok, v.errors.join('\n'));
  const project = tower.projects[0];
  assert.equal(project.basis, 'owned');
  assert.equal(project.name, 'Orchestra 自有');
  const node = project.nodes[0];
  assert.deepEqual(
    { id: node.id, session: node.session, ownership: node.ownership, layer: node.layer, state: node.state, basis: node.basis, waiting: node.waiting, title: node.title },
    { id: `n:${ownedId}`, session: null, ownership: 'owned', layer: 'agent', state: 'waiting', basis: 'owned', waiting: { kind: 'approval', source: 'orchestra', deadline: approval.deadline }, title: 'run echo tower' },
  );
  assert.equal(node.activity, 'echo tower');
  assert.deepEqual(tower.waitingBar, [{ node: `n:${ownedId}`, kind: 'approval', source: 'orchestra', deadline: approval.deadline }]);
  assert.equal(tower.tally.waiting, 1);
  // Answered, it runs on and then goes idle; ended, it is ended (never idle, never done) with why it ended.
  await post(r, p, `/api/approvals/${approval.approvalId}/deny`, { actionId: uuid() });
  await until('idle', () => r.owned.get(ownedId)!.state === 'idle');
  const idle = (await request(r, 'GET', '/api/tower', { cookie: p.cookie })).json;
  assert.ok(validateTower(idle).ok);
  assert.deepEqual([idle.projects[0].nodes[0].state, idle.projects[0].nodes[0].waiting, idle.waitingBar], ['idle', null, []]);
  const end = await post(r, p, `/api/owned/${ownedId}/end`, { actionId: uuid() });
  assert.equal(end.status, 200, end.body);
  const ended = (await request(r, 'GET', '/api/tower', { cookie: p.cookie })).json;
  assert.ok(validateTower(ended).ok, validateTower(ended).errors.join('\n'));
  assert.deepEqual([ended.projects[0].nodes[0].state, ended.projects[0].nodes[0].activity], ['ended', '已结束：你结束的']);
  const after = await post(r, p, `/api/owned/${ownedId}/message`, { actionId: uuid(), text: 'say more' });
  assert.deepEqual([after.status, after.json], [409, { error: 'owned-ended' }]);
});

test('new: claude is off until its host is wired, a model off the owned list is refused by the shape, a message to no session is item-unknown; with Codex off the list says why', async (t) => {
  const r = await rig(t);
  const p = await page(r);
  const claude = await post(r, p, '/api/owned/new', { actionId: uuid(), text: 'hi', harness: 'claude' });
  assert.deepEqual([claude.status, claude.json], [409, { error: 'owned-disabled' }]);
  const model = await post(r, p, '/api/owned/new', { actionId: uuid(), text: 'hi', harness: 'codex', model: 'gpt-4o' });
  assert.equal(model.status, 400);
  const none = await post(r, p, `/api/owned/${'b'.repeat(20)}/message`, { actionId: uuid(), text: 'hi' });
  assert.deepEqual([none.status, none.json], [404, { error: 'item-unknown' }]);
  const chosen = await post(r, p, '/api/owned/new', { actionId: uuid(), text: 'say hello there', harness: 'codex', model: 'zcode/GLM-5.3' });
  assert.equal(chosen.status, 200, chosen.body);
  const s = r.owned.get(chosen.json.ownedId)!;
  assert.equal(s.model, 'zcode/GLM-5.3');
  await until('the turn', () => s.state === 'idle' && s.feed.since(0).events.some((e) => e.kind === 'text' && e.state === 'final'));
  const list = (await get(r, p, '/api/owned')).json;
  assert.ok(validateOwnedList(list).ok, validateOwnedList(list).errors.join('\n'));
  assert.deepEqual([list.enabled, list.disabledWhy, list.harnesses, list.limits], [true, null, { codex: true, claude: false }, { maxOwned: 3, active: 1 }]);
  assert.deepEqual(list.owned[0].tokens, { input: 20, cachedInput: 5, output: 10, total: 30 });
  assert.equal(humans(r).filter((h) => h.kind === 'human').length, 1, 'refusals write nothing');

  const off = await rig(t, { codex: false });
  const po = await page(off);
  const l = (await get(off, po, '/api/owned')).json;
  assert.ok(validateOwnedList(l).ok, validateOwnedList(l).errors.join('\n'));
  assert.deepEqual([l.enabled, l.disabledWhy, l.owned, l.approvals], [false, 'not-asked', [], []]);
  const n = await post(off, po, '/api/owned/new', { actionId: uuid(), text: 'hi', harness: 'codex' });
  assert.deepEqual([n.status, n.json], [409, { error: 'owned-disabled' }]);
  assert.deepEqual(ownedList({ codex: null, claude: null, codexOff: 'codex-missing' }).disabledWhy, 'codex-missing');
});

test('interrupt: open approvals are declined first, then the turn stops; the reply counts them', async (t) => {
  const r = await rig(t);
  const p = await page(r);
  const { ownedId } = await startAndAsk(r, p, 'run echo stop');
  const res = await post(r, p, `/api/owned/${ownedId}/interrupt`, { actionId: uuid() });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual([res.json.denied, res.json.withdrawn], [1, 0]);
  await until('the decline', () => r.answers().length > 0);
  assert.deepEqual(r.answers(), [['srv-1', { decision: 'decline' }]]);
  assert.deepEqual(r.settled.map(([, o]) => [o.decision, o.cause]), [['decline', 'interrupt']]);
});

test('brake (r4 D4/D8): the session Job ended, its open approval declined, the session ended as braked; a human record; a second brake finds it ended', async (t) => {
  const r = await rig(t, {
    brakeWhy: null,
    job: () => Object.freeze({ name: `orchestra-job-${'e'.repeat(32)}`, endTree: async () => ({ ok: true as const, found: true, killed: 2, left: 0 }), procs: async () => [] }),
  });
  const p = await page(r);
  const { ownedId, list } = await startAndAsk(r, p, 'run echo braked');
  assert.equal(list.brakeWhy, null);
  assert.equal(list.owned[0].brake, true);
  const res = await post(r, p, `/api/owned/${ownedId}/brake`, { actionId: uuid() });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual([res.json.killed, res.json.left], [2, 0]);
  // Declined, never allowed (D8). The child is stopped right after, so whether it read the answer first is not asserted.
  assert.deepEqual(r.settled.map(([, o]) => [o.decision, o.cause]), [['decline', 'brake']]);
  const after = (await get(r, p, '/api/owned')).json;
  assert.ok(validateOwnedList(after).ok);
  assert.deepEqual([after.owned[0].state, after.owned[0].endReason, after.owned[0].brake], ['ended', 'braked', false]);
  const feed = (await get(r, p, `/api/owned/${ownedId}/feed`)).json;
  assert.ok(feed.events.some((e: { kind: string; state: string }) => e.kind === 'lifecycle' && e.state === 'braked'));
  assert.ok(feed.events.some((e: { kind: string; state: string; text: string }) => e.kind === 'note' && e.state === 'tree-stopped' && e.text === '2'));
  assert.deepEqual(humans(r).filter((h) => h.kind === 'human').map((h) => h.body.verb), ['owned-new', 'owned-brake']);
  const again = await post(r, p, `/api/owned/${ownedId}/brake`, { actionId: uuid() });
  assert.deepEqual([again.status, again.json], [409, { error: 'owned-ended' }]);
});

test('brake on a session without a Job (procguard off): 503 brake-unavailable, nothing ends; the list says why there is none', async (t) => {
  const r = await rig(t);
  const p = await page(r);
  const { ownedId, list } = await startAndAsk(r, p, 'run echo kept');
  assert.equal(list.brakeWhy, 'not-asked');
  assert.equal(list.owned[0].brake, false);
  const res = await post(r, p, `/api/owned/${ownedId}/brake`, { actionId: uuid() });
  assert.deepEqual([res.status, res.json], [503, { error: 'brake-unavailable' }]);
  const still = (await get(r, p, '/api/owned')).json;
  assert.equal(still.owned[0].state, 'running');
  assert.equal(still.approvals.length, 1, 'the card still waits for the person');
  assert.deepEqual(humans(r).filter((h) => h.kind === 'human').map((h) => h.body.verb), ['owned-new']);
});
