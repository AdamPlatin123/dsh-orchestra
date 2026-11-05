import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOWER_TEXT } from '../../shared/strings.js';
import { describeNew, describeOwned, describeRequestPins, type Guard } from '../../ui/owned.js';
import { describeRows } from '../../ui/view.js';
import { makeRequests } from '../../src/route/requests.ts';

// Project roots on the page (orchestra app plan 项目根, --project-root): the dispatch dialog offers
// Orchestra's own work dir (the default) and the roots the list names, never a free path, and says what a
// session there may do; a request card says where its session runs and, if in the work dir, why; a session
// page and an owned tower row name where it works. Without roots the dialog is as before. Synthetic data.

const HTML = fs.readFileSync(fileURLToPath(new URL('../../ui/tower.html', import.meta.url)), 'utf8');
const ROOT = 'D:\\work\\proj';
const LIST = { v: 1, kind: 'owned-list', rev: 0, enabled: true, disabledWhy: null, harnesses: { codex: true, claude: true }, owned: [], approvals: [], limits: { maxOwned: 3, active: 0 } };
const g: Guard = { unlocked: true, settle: '', hold: null, busy: false, nowWall: 0 };
const fill = (key: string, args: Record<string, string>) => TOWER_TEXT[key]!.replace(/\{(\w+)\}/g, (_, k: string) => args[k] ?? '');

test('the dispatch dialog: the work dir select lists the default first, then each root; hidden with no roots, where the note says how to add one', () => {
  assert.match(HTML, /<select id="nw-cwd" class="dlg-in" data-slot="cwdSel"><\/select>/);
  assert.ok(!HTML.includes('data-t="new.cwd"'), 'the fixed line gave way to the note slot');
  const none = describeNew({ ...LIST, roots: [] }, 'codex', false);
  assert.equal(none.cwdBox.data.hide, '1');
  assert.equal(none.cwdNote.text, TOWER_TEXT['new.cwd']);
  assert.ok(TOWER_TEXT['new.cwd']!.includes('--project-root'));
  // A list from before roots existed (no field): the same as none.
  assert.equal(describeNew(LIST, 'codex', false).cwdBox.data.hide, '1');
  const two = describeNew({ ...LIST, roots: [ROOT, 'E:\\site'] }, 'codex', false);
  assert.equal(two.cwdBox.data.hide, '0');
  assert.deepEqual(two.cwdSel.kids.map((k: any) => [k.attr.value, k.text]), [['', TOWER_TEXT['new.cwdWork']], [ROOT, ROOT], ['E:\\site', 'E:\\site']]);
  assert.equal(two.cwdNote.text, TOWER_TEXT['new.cwdWorkNote']);
});

test('the dispatch dialog: a picked root says the truth for the harness (Codex: its sandbox is read-only on Windows, so writes and commands still ask)', () => {
  const list = { ...LIST, roots: [ROOT] };
  const codex = describeNew(list, 'codex', false, ROOT).cwdNote.text;
  assert.equal(codex, fill('new.cwdRootCodex', { d: ROOT }));
  assert.ok(codex.includes('沙箱只读') && codex.includes('先来问你') && codex.includes(ROOT));
  // Review fix (T1): the on-request read measurement asked for a read-only sandbox outside Orchestra; Orchestra asks workspace-write.
  assert.ok(codex.includes('在 Orchestra 外') && codex.includes('请求的是只读沙箱') && codex.includes('这个组合在 Orchestra 里没测'), codex);
  const claude = describeNew(list, 'claude', false, ROOT).cwdNote.text;
  assert.equal(claude, fill('new.cwdRootClaude', { d: ROOT }));
  assert.ok(claude.includes('读、查找这个目录里的文件不问你'));
  // A value that is not one of the roots is the default (the page never sends a free path).
  assert.equal(describeNew(list, 'codex', false, 'C:\\anything').cwdNote.text, TOWER_TEXT['new.cwdWorkNote']);
});

test('a request card says where its session runs: in its cwd inside a root, else the work dir and why (an unknown why says so, T1)', () => {
  const r = {
    requestId: '6'.repeat(20), harness: 'codex', label: null, text: 'x', cwd: `${ROOT}\\web`, requester: 'dsh:s1', state: 'pending', createdAt: 0, expiresAt: 60_000, ownedId: null, why: null,
    fetched: false, suggestion: null, suggesting: 'no-desk',
  };
  const meta = (extra: Record<string, unknown>) => (describeRequestPins({ requests: [{ ...r, ...extra }] }, g) as any[])[0].slots.meta.text as string;
  assert.ok(meta({ runIn: `${ROOT}\\web`, runInWhy: null }).includes(fill('req.cwdRoot', { cwd: `${ROOT}\\web`, run: `${ROOT}\\web` })));
  assert.ok(meta({ runIn: null, runInWhy: 'outside-roots' }).includes(fill('req.cwd', { cwd: `${ROOT}\\web`, why: TOWER_TEXT['cwdwhy.outside-roots']! })));
  assert.ok(meta({ runIn: null, runInWhy: 'no-roots' }).includes(TOWER_TEXT['cwdwhy.no-roots']!));
  assert.ok(meta({ runIn: null, runInWhy: 'brand-new' }).includes('原因未知：brand-new'));
  // Project-root review: a Claude request says its session is held as untrusted (every read asks too) and that its last reply goes back to the requester.
  const claude = meta({ harness: 'claude', runIn: `${ROOT}\\web`, runInWhy: null });
  assert.ok(claude.includes(fill('req.cwdRootClaude', { cwd: `${ROOT}\\web`, run: `${ROOT}\\web` })), claude);
  assert.ok(claude.includes('读、查找、写文件、跑命令每次都先来问你') && claude.includes('回复会交给发请求的 DSH 会话'));
  assert.ok(!claude.includes(fill('req.cwdRoot', { cwd: `${ROOT}\\web`, run: `${ROOT}\\web` })));
  // Codex (r4 §8.5): started with the untrusted approval policy; what was measured (one run: Get-Content, listing,
  // writing each asked), that other ways of reading were not, and that its last reply goes back to the requester.
  const codex = meta({ runIn: `${ROOT}\\web`, runInWhy: null });
  assert.ok(codex.includes('untrusted') && codex.includes('Get-Content') && codex.includes('别的读法没测') && codex.includes('回复会交给发请求的 DSH 会话'), codex);
  assert.ok(!codex.includes('会不会先问你，未知'), 'measured now');
  // Review fix (T1): the measurement was outside Orchestra (a direct app-server, sandbox echoed read-only): the card says so.
  assert.ok(codex.includes('在 Orchestra 外') && codex.includes('沙箱回的是只读') && codex.includes('经 Orchestra 在项目根里测过两次'), codex);
  assert.ok(TOWER_TEXT['req.untrustedCodex']!.includes('在 Orchestra 外') && TOWER_TEXT['req.untrustedCodex']!.includes('workspace-write'));
  // In Orchestra's own work dir the session is untrusted all the same (r4 §8.5 names no cwd), per harness.
  const workCodex = meta({ runIn: null, runInWhy: 'outside-roots' });
  assert.ok(workCodex.includes(TOWER_TEXT['req.untrustedCodex']!) && !workCodex.includes(TOWER_TEXT['req.untrustedClaude']!), workCodex);
  const workClaude = meta({ harness: 'claude', runIn: null, runInWhy: 'no-roots' });
  assert.ok(workClaude.includes(TOWER_TEXT['req.untrustedClaude']!) && !workClaude.includes(TOWER_TEXT['req.untrustedCodex']!), workClaude);
  for (const m of [claude, codex, workCodex, workClaude]) assert.equal(m.split('按来源不可信处理').length, 2, `said once: ${m}`);
  // A directory the read gate would not stat: unknown whether it is one, never "it does not exist" (T1).
  assert.ok(meta({ runIn: null, runInWhy: 'stat-refused' }).includes(TOWER_TEXT['cwdwhy.stat-refused']!));
  assert.ok(TOWER_TEXT['cwdwhy.stat-refused']!.includes('未知'));
});

test('a session page names where it works: a project root, Orchestra\'s own dir, or unknown from before a restart', () => {
  const o = { ownedId: 'a'.repeat(20), harness: 'codex', model: 'codex/gpt-6.1-sol', title: 't', state: 'idle', endReason: null, waiting: null, queued: 0, tokens: null, lastSeq: 0, createdAt: 0, brake: true, stoppable: false };
  const st = (cwd: unknown) => (describeOwned(o.ownedId, { ...LIST, roots: [ROOT], requests: [], requestedGone: [], owned: [{ ...o, cwd }] }, undefined, g) as any).ownSt.text as string;
  assert.ok(st({ path: ROOT, kind: 'project-root' }).includes(fill('own.cwdRoot', { d: ROOT })));
  // A folder below a root is not itself a root the person named: the page says it lies in one.
  assert.ok(st({ path: `${ROOT}\\web`, kind: 'project-root' }).includes(`工作目录 ${ROOT}\\web（在你放行的项目根里）`));
  assert.ok(st({ path: 'C:\\o\\work\\x', kind: 'work' }).includes(fill('own.cwdWork', { d: 'C:\\o\\work\\x' })));
  assert.ok(st(null).includes(TOWER_TEXT['own.cwdUnknown']!));
});

test('an owned tower row names the folder it works in once the page can read the list; an observed row never', () => {
  const node = (ownership: string) => ({
    id: `n:${'a'.repeat(20)}`, session: null, harness: 'codex', ownership, layer: 'agent', parent: null, depth: 0, title: 't', activity: '在跑',
    state: 'running', basis: ownership === 'owned' ? 'owned' : 'log', waiting: null, counts: { children: 0, errors: 0, waiting: 0 }, groups: [], ageMs: 0, agentType: null,
  });
  const row = (n: any) => ({ key: n.id, kind: 'node', level: 2, parentKey: null, expandable: false, expanded: false, match: false, setsize: 1, posinset: 1, project: { id: 'p', name: 'p', basis: 'owned', nodes: [n], groups: [] }, node: n, group: null, gone: false });
  const ctx = { sel: null, peek: new Set<string>(), flash: new Map<string, string>(), cwdOf: () => `${ROOT}\\` };
  const act = (n: any, c: any) => (describeRows([row(n)] as any, c)[0] as any).slots.act.text as string;
  assert.equal(act(node('owned'), ctx), `在跑${TOWER_TEXT['sep.parts']}${fill('row.cwd', { d: 'proj' })}`);
  assert.equal(act(node('owned'), { ...ctx, cwdOf: () => null }), '在跑', 'locked, or a list without it: the activity alone');
  assert.equal(act(node('observed'), ctx), '在跑');
});

test('requests: runIn holds only for the cwd as shown; a cwd the redactor changed runs in the work dir (redacted); none named: no-roots', () => {
  const mk = (redact: (s: string) => string) => makeRequests({
    after: () => () => {}, nowMono: () => 0, nowWall: () => 0, redact: (text) => ({ text: redact(text), count: 0 }), observe: () => null, endOwned: () => false,
  });
  const ask = { harness: 'codex' as const, text: 'x', cwd: `${ROOT}\\web`, label: null, requester: { kind: 'dsh' as const, sessionId: 's' } };
  const plain = mk((s) => s).create({ ...ask, runIn: `${ROOT}\\web`, runInWhy: null });
  assert.ok(plain.ok);
  if (plain.ok) assert.deepEqual([plain.request.runIn, plain.request.runInWhy], [`${ROOT}\\web`, null]);
  const hidden = mk((s) => s.replace('proj', '[secret]')).create({ ...ask, runIn: `${ROOT}\\web`, runInWhy: null });
  assert.ok(hidden.ok);
  if (hidden.ok) assert.deepEqual([hidden.request.runIn, hidden.request.runInWhy], [null, 'redacted']);
  const none = mk((s) => s).create(ask);
  assert.ok(none.ok);
  if (none.ok) assert.deepEqual([none.request.runIn, none.request.runInWhy], [null, 'no-roots']);
});
