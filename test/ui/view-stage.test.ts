import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateStage } from '../../shared/stage-contract.js';
import { STAGE_TEXT } from '../../shared/strings.js';
import {
  CHIPS, clipW, describeDrawer, describeHeader, describePlan, describeRules, describeScore, fill, flowBucket, groupSummary, plateText, view,
} from '../../ui/view.js';
import { groupItems } from '../../ui/layout.js';

// ui/view.js's descriptors over the page's hand-written sample (test/fixtures/stage-ui-sample.json),
// which passes shared/stage-contract.js like the daemon's golden file. The truthfulness rules of the
// 0.1 alpha design §2 are checked on what the page would show: every count is the length of its rows
// (T3), the word for "done" never appears (T2), a checked todo reads 自报已勾, the verdict reads
// 无复核者（这一版没有） (D19: only a non-author reviewer or you can call work done), and a rule checked against
// no real sample reads 没测过（0 个样本） however many hits it had (T4).

const SAMPLE = fileURLToPath(new URL('../fixtures/stage-ui-sample.json', import.meta.url));
type Json = Record<string, any>;
const sample = (): Json => JSON.parse(fs.readFileSync(SAMPLE, 'utf8')) as Json;
const fmt = { time: (ms: number) => new Date(ms).toISOString().slice(11, 19), iso: (s: string) => s.slice(11, 19) };
const SHOP = '2261f9a05a5aea69ded3';
const NOTES = 'cd4802ae2841e8ed33cc';
const DONE = '完成';

/** Every text in a descriptor tree. */
function texts(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) for (const v of x) texts(v, out);
  else if (x !== null && typeof x === 'object') {
    for (const [k, v] of Object.entries(x)) {
      if (k === 'text' && typeof v === 'string') out.push(v);
      else texts(v, out);
    }
  }
  return out;
}

/** Every descriptor with a key under `x`. */
function descs(x: unknown, out: Json[] = []): Json[] {
  if (Array.isArray(x)) for (const v of x) descs(v, out);
  else if (x !== null && typeof x === 'object') {
    if (typeof (x as Json).key === 'string' && typeof (x as Json).tpl === 'string') out.push(x as Json);
    for (const v of Object.values(x)) descs(v, out);
  }
  return out;
}

function everything(s: Json, chip: any = null, sel: string | null = null): string[] {
  const out: string[] = [];
  for (const lane of s.lanes) {
    out.push(...texts(describeHeader(s as any, lane.id, { stale: false, at: '10:00:30' })));
    out.push(...texts(describeHeader(s as any, lane.id, { stale: true, at: '10:00:30' })));
    out.push(...texts(describeScore(s as any, lane.id, sel)));
    out.push(...texts(describePlan(s as any, lane.id, chip, sel, fmt)));
    for (const node of [...lane.players.map((p: Json) => p.id), ...lane.items.map((w: Json) => w.id)]) {
      out.push(...texts(describeDrawer(s as any, lane.id, node, null, fmt, 0)));
    }
  }
  return out;
}

test('the sample the view tests read is a valid stage snapshot', () => {
  assert.deepEqual(validateStage(sample()), { ok: true, errors: [] });
});

test('STAGE_TEXT never holds the word for done, and every key the page names exists', () => {
  for (const [k, v] of Object.entries(STAGE_TEXT)) assert.ok(!v.includes(DONE), `${k}: ${v}`);
  const html = fs.readFileSync(fileURLToPath(new URL('../../ui/stage.html', import.meta.url)), 'utf8');
  for (const m of html.matchAll(/data-t="([^"]+)"/g)) assert.ok(Object.hasOwn(STAGE_TEXT, m[1]!), `stage.html names ${m[1]}`);
  const js = fs.readFileSync(fileURLToPath(new URL('../../ui/view.js', import.meta.url)), 'utf8');
  for (const m of js.matchAll(/(?:STAGE_TEXT\[|fill\()'([a-zA-Z.-]+)'/g)) assert.ok(Object.hasOwn(STAGE_TEXT, m[1]!), `view.js names ${m[1]}`);
});

test('plain words: no music notation, no music jargon and no milestone code in any text the page can show', () => {
  // User feedback 2026-11-02: ordinary readers cannot decode the score's jargon. One row per member
  // stays; every other mark and word is plain.
  const JARGON = ['谱', '奏', '乐器', '木管', '弦乐', '打击', '铜管', '休止', '声部', '演奏', '日场', '夜场', '孤儿', '回流', '交回', '延长号', '连线', '回弧', '短语', '部门', '委派', 'M0', 'M2', '×'];
  const html = fs.readFileSync(fileURLToPath(new URL('../../ui/stage.html', import.meta.url)), 'utf8');
  const s = sample();
  const shown = [...Object.values(STAGE_TEXT), ...everything(s), ...[...html.matchAll(/>([^<>]+)</g)].map((m) => m[1]!), ...[...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]!)];
  for (const t of shown) for (const j of JARGON) assert.ok(!t.includes(j), `${j} in ${t}`);
  // The dispatch and report arrows carry their heads as drawn geometry, not markers.
  assert.doesNotMatch(html, /marker/);
});

test('no text the page can show says done, and no STAGE_TEXT key leaks raw', () => {
  const s = sample();
  const all = [...everything(s), ...CHIPS.flatMap((c) => everything(s, c, 'w:toolu_t1'))];
  assert.ok(all.length > 100);
  for (const t of all) {
    assert.ok(!t.includes(DONE), t);
    assert.ok(!Object.hasOwn(STAGE_TEXT, t) || t === STAGE_TEXT[t], `raw key ${t}`);
    assert.ok(!/\{\w+\}/.test(t), `unfilled placeholder in ${t}`);
  }
});

test('header counts are the lengths of the rows they label (T3)', () => {
  const s = sample();
  const lane = s.lanes[0];
  const h = describeHeader(s as any, SHOP, { stale: false, at: '10:00:30' });
  const playing = lane.players.filter((p: Json) => ['busy', 'running', 'waiting'].includes(p.live.state));
  assert.deepEqual(h.counts, { a: playing.length, b: lane.players.length, c: view(lane, 'reported').rows.length, d: view(lane, 'sent').rows.length });
  assert.equal(h.slots.players.text, `成员 ${playing.length}/${lane.players.length} 在干活`);
  assert.equal(h.slots.items.text, '任务 1/6 已回报');
  assert.equal(h.slots.fresh.text, '观测于 10:00:30');
  const stale = describeHeader(s as any, SHOP, { stale: true, at: '10:00:30' });
  assert.deepEqual(stale.slots.fresh, { text: '数据截至 10:00:30', data: { tone: 'warn' } });
});

test('each chip filters the list to exactly its number of rows (T3)', () => {
  const s = sample();
  for (const lane of s.lanes) {
    for (const chip of CHIPS) {
      const p = describePlan(s as any, lane.id, chip, null, fmt);
      const n = view(lane, chip).count;
      const chipDesc = descs(p.slots.chips).find((d) => d.key === chip)!;
      assert.match(chipDesc.text, new RegExp(` ${n}$`));
      assert.deepEqual(chipDesc.attr, { 'aria-pressed': 'true' });
      const rows = descs(p.slots.list).filter((d) => d.tpl === 'tpl-row');
      assert.equal(rows.length, n, `${lane.name} ${chip}`);
      assert.equal(p.rows, n);
      assert.deepEqual(rows.map((r) => r.key), view(lane, chip).rows.map((w: Json) => w.id));
    }
  }
  const shop = describePlan(s as any, SHOP, null, null, fmt);
  assert.deepEqual(descs(shop.slots.chips).map((d) => d.text), ['已派 6', '在跑 3', '已回报 1', '已复核 0']);
  const reviewed = describePlan(s as any, SHOP, 'reviewed', null, fmt);
  assert.equal(reviewed.slots.empty.text, '已复核 0：这一版没有复核者');
});

test('a checked todo reads 自报已勾 with a hatched dot; the lead desk reports 自报 1/3, never a finished plan', () => {
  const s = sample();
  const plan = describePlan(s as any, SHOP, null, null, fmt);
  const desk = descs(plan.slots.desk).find((d) => d.tpl === 'tpl-desk' && d.slots.name.text.startsWith('shop · 重构'))!;
  assert.equal(desk.slots.todoHead.text, '主会话自己的待办，自报 1/3');
  assert.equal(desk.slots.goal.text, '未设目标');
  const todos = desk.slots.todo.kids;
  assert.deepEqual(todos.map((t: Json) => [t.slots.g.text, t.slots.st.text]), [['☑', '自报已勾'], ['◐', '在做'], ['○', '待做']]);
  // The hatch: the page's stylesheet marks a self-checked todo's label with a hatched band, not a tick of done.
  assert.equal(todos[0].data.s, 'completed');
  const css = fs.readFileSync(fileURLToPath(new URL('../../ui/stage.css', import.meta.url)), 'utf8');
  assert.match(css, /\.todo-i\[data-s=completed\] \.st \{[^}]*repeating-linear-gradient\(45deg, var\(--hatch\)/);
  const dsh = descs(plan.slots.desk).find((d) => d.tpl === 'tpl-desk' && d.slots.name.text === 'shop · DSH lead')!;
  assert.match(dsh.slots.goal.text, /^目标：上线结账/);
  // All todos checked still claims only what the agent said.
  const all = sample();
  all.lanes[0].players[0].stand.items.forEach((i: Json) => { i.status = 'completed'; });
  all.lanes[0].players[0].stand.selfReported.checked = 3;
  const d2 = descs(describePlan(all as any, SHOP, null, null, fmt).slots.desk)[0]!;
  assert.equal(d2.slots.todoHead.text, '主会话自己的待办，自报 3/3，全部自报已勾');
});

test('every work item row carries the verdict 无复核者（这一版没有）, undeclared criteria, and a report no further than 已回报', () => {
  const s = sample();
  const rows = descs(describePlan(s as any, SHOP, null, null, fmt).slots.list).filter((d) => d.tpl === 'tpl-row');
  assert.ok(rows.length >= 6);
  for (const r of rows) assert.equal(r.slots.verdict.text, '无复核者（这一版没有）');
  const t1 = rows.find((r) => r.key === 'w:toolu_t1')!;
  assert.equal(t1.slots.report.text, '已回报 19:07:00，1.2k 字节');
  assert.equal(t1.slots.flowText.text, '读 48k 字节 → 回报 1.2k 字节（约为所读的 1/40）');
  assert.equal(t1.data.flow, '5');
  assert.equal(rows.find((r) => r.key === 'w:agent-a3')!.slots.report.text, '可能断了');
  assert.equal(rows.find((r) => r.key === 'w:toolu_t2')!.slots.report.text, '在跑');
  assert.equal(rows.find((r) => r.key === 'w:dsh:c41f96c594ee71fce362')!.slots.flowText.text, '读 未知 → 回报 未知');
  const html = fs.readFileSync(fileURLToPath(new URL('../../ui/stage.html', import.meta.url)), 'utf8');
  const row = /<template id="tpl-row">[\s\S]*?<\/template>/.exec(html)![0];
  assert.ok(row.includes('data-t="plan.crit"') && row.includes('data-t="plan.critNote"'), 'each row template shows 验收标准：未声明 and its label');
  assert.equal(STAGE_TEXT['plan.crit'], '验收标准：未声明');
  assert.equal(STAGE_TEXT['plan.critNote'], '派活原文，不是验收标准');
});

test('T3: 往下派了 n 个活 is one list on the graph and in 任务清单, unlinked items left out of both', () => {
  const s = sample();
  const items = s.lanes[0].items as Json[];
  const t5 = items.find((w) => w.id === 'w:toolu_t5')!;
  // The department hands on one more linked item and one the records cannot link.
  items.push({ ...t5, id: 'w:extra-linked', parent: null }, { ...t5, id: 'w:extra-loose', join: null, parent: null });
  const DEPT = 'p:2c3a4249d77070058649';
  const claude = describeScore(s as any, SHOP, null).systems.kids!.find((d) => d.key === 'claude')!;
  const head = claude.slots!.heads!.kids!.find((d) => d.key === DEPT)!;
  const row = describePlan(s as any, SHOP, null, null, fmt).slots.list.kids!.find((d) => d.key === 'w:toolu_t2')!;
  assert.equal(head.slots!.tag!.text, '往下派了 2 个活（第 1 层）');
  assert.equal(row.slots!.dept!.text, head.slots!.tag!.text);
});

test('departments group by executor with depth badges; unjoined items and stray clones go to 未关联', () => {
  const s = sample();
  const list = describePlan(s as any, SHOP, null, null, fmt).slots.list.kids!;
  assert.deepEqual(list.map((d) => [d.key, d.data?.depth ?? '-']), [
    ['w:toolu_t1', '0'], ['w:toolu_t2', '0'], ['w:toolu_t5', '1'], ['w:team:t1', '0'], ['w:dsh:c41f96c594ee71fce362', '0'],
    ['h:unlinked', '-'], ['w:agent-a3', '0'],
  ]);
  const t2 = list[1]!;
  assert.deepEqual(t2.slots!.dept, { text: '往下派了 1 个活（第 1 层）', data: { hide: '0' } });
  assert.equal(list[5]!.slots!.t!.text, '未关联（1）');
  // A clone no item points at is listed too, and a department deeper than 2 is flagged.
  const s2 = sample();
  s2.lanes[0].items = s2.lanes[0].items.filter((w: Json) => w.id !== 'w:agent-a3');
  s2.lanes[0].cues = [];
  s2.lanes[0].players.find((p: Json) => p.label === 'Review diff · 审查结账改动').depth = 3;
  const l2 = describePlan(s2 as any, SHOP, null, null, fmt).slots.list.kids!;
  // Its one button names the player, so several stray rows read apart.
  const strayLabel = s2.lanes[0].players.find((p: Json) => p.id === 'p:f46dd28a5499d8efef0b').label;
  assert.ok(l2.some((d) => d.key === 'x:p:f46dd28a5499d8efef0b' && d.slots!.brief!.text === `${strayLabel}：没有找到派活记录`));
  assert.equal(l2.find((d) => d.key === 'w:toolu_t2')!.slots!.deep!.data!.hide, '0');
});

test('the lane total says how much the lead did not read, only over items with both sides known', () => {
  const s = sample();
  assert.equal(describePlan(s as any, SHOP, null, null, fmt).slots.total.text, '分身读了 48k 字节，回报 1.2k 字节：主会话少读约 47k 字节（1 项有数据）');
  assert.equal(describePlan(s as any, NOTES, null, null, fmt).slots.total.data!.hide, '1');
  assert.deepEqual([1, 2, 40, 300, 1e9].map((r) => flowBucket({ childBytes: r * 100, reportBytes: 100 })), ['0', '1', '5', '8', '8']);
});

test('describeRules reads 没测过（0 个样本） with class untested, never a pass, even with hits:5 and n:0 (T4)', () => {
  const s = sample();
  const rules = describeRules(s.rules);
  assert.equal(rules.length, 13);
  for (const r of rules) {
    assert.equal(r.cls, 'untested');
    assert.equal(r.slots!.n!.text, '没测过（0 个样本）');
    assert.ok(!texts(r).some((t) => t.includes('通过')));
  }
  const m = sample();
  m.rules[0].hits = 5;
  const [r0] = describeRules(m.rules);
  assert.deepEqual([r0!.cls, r0!.slots!.n!.text, r0!.slots!.hits!.text], ['untested', '没测过（0 个样本）', '本次命中 5']);
  m.rules[1].status = 'keys-mismatch';
  const r1 = describeRules(m.rules)[1]!;
  assert.deepEqual([r1.cls, r1.slots!.n!.text], ['mismatch', '字段对不上']);
  const plan = describePlan(m as any, SHOP, null, null, fmt);
  assert.deepEqual(plan.slots.health, { text: '字段对不上（解析器是推测）：claude.join.agentId', data: { hide: '0' } });
  assert.equal(describePlan(s as any, SHOP, null, null, fmt).slots.health.data!.hide, '1', 'health takes no space when nothing is wrong (T6)');
});

test('[测试] shows for the test profile and not for real', () => {
  const s = sample();
  const h = describeHeader(s as any, SHOP, { stale: false, at: '' });
  assert.deepEqual(h.slots.test, { text: '[测试]', data: { hide: '0' } });
  assert.ok(h.title.startsWith('[测试] '));
  s.profile = 'real';
  const r = describeHeader(s as any, SHOP, { stale: false, at: '' });
  assert.deepEqual(r.slots.test, { text: '', data: { hide: '1' } });
  assert.ok(!r.title.includes('[测试]'));
});

test('each group’s collaboration sentence counts the lists it summarizes (T3), and its form comes from roles', () => {
  const s = sample();
  const lane = s.lanes[0];
  const f = s.podium.fermatas;
  const claude = groupSummary(lane, 'claude', f);
  assert.equal(claude.form, 'tree', 'clones and no teammates: a chain of delegation');
  assert.equal(claude.text, '分身 4 个，其中 1 个又往下派活；派活 4 次：在跑 2，已回报 1，可能断了 1；回报约为所读的 1/40（1 项有数据）；等你 1');
  const dsh = groupSummary(lane, 'dsh', f);
  assert.equal(dsh.form, 'team', 'a teammate makes a team');
  assert.equal(dsh.text, '队友 1 个，分身 1 个；派活 2 次：在跑 1，未知 1');
  for (const h of ['claude', 'dsh']) {
    const g = groupSummary(lane, h, f);
    const L = g.lists;
    const mine = lane.players.filter((p: Json) => p.harness === h);
    // Each list is what an independent filter of the lane gives, and each number in the text is its length.
    assert.deepEqual(L.clones.map((p) => p.id).sort(), mine.filter((p: Json) => p.role === 'clone').map((p: Json) => p.id).sort());
    assert.deepEqual(L.teammates.map((p) => p.id).sort(), mine.filter((p: Json) => p.role === 'teammate').map((p: Json) => p.id).sort());
    assert.deepEqual(L.sent.map((w) => w.id), groupItems(lane, h).map((w: Json) => w.id));
    assert.deepEqual(L.waiting.map((p) => p.id), mine.filter((p: Json) => f.includes(p.id)).map((p: Json) => p.id));
    const said: [string, readonly unknown[]][] = [
      ['队友', L.teammates], ['分身', L.clones], ['其中', L.depts], ['派活', L.sent], ['在跑', L.working],
      ['已回报', L.reported], ['可能断了', L.orphan], ['未知', L.unknown], ['等你', L.waiting],
    ];
    for (const [word, list] of said) {
      const m = new RegExp(`(?:^|[，；：])${word} (\\d+)`).exec(g.text);
      if (list.length === 0 && word !== '派活') assert.equal(m, null, `${h}: ${word} 0 is not said`);
      else assert.equal(Number(m![1]), list.length, `${h}: ${word}`);
    }
    if (L.flows.length > 0) assert.match(g.text, new RegExp(`（${L.flows.length} 项有数据）`));
  }
  const notes = groupSummary(s.lanes[1], 'claude', f);
  assert.deepEqual([notes.form, notes.text], ['solo', '只有主会话；没有派活记录']);
});

test('the score: one system per group with players, heads and phrases from their fields, Codex untouched, waits from the list', () => {
  const s = sample();
  const sc = describeScore(s as any, SHOP, 'w:toolu_t2');
  const systems = sc.systems!.kids!;
  assert.deepEqual(systems.map((d) => d.key), ['claude', 'dsh']);
  const claude = systems[0]!;
  assert.deepEqual(claude.data, { lineage: 'claude', form: 'tree' });
  assert.equal(claude.slots!.sysForm!.text, '主会话派活给分身');
  assert.equal(systems[1]!.slots!.sysForm!.text, '组长带队友');
  assert.equal(claude.slots!.sysLine!.text, groupSummary(s.lanes[0], 'claude', s.podium.fermatas).text);
  // The two SVGs share one height, and the music is as wide as its columns.
  const h = claude.slots!.hsvg!.attr!.height;
  assert.equal(claude.slots!.msvg!.attr!.height, h);
  assert.equal(claude.slots!.msvg!.attr!.viewBox, `0 0 ${claude.slots!.msvg!.attr!.width} ${h}`);
  const heads = claude.slots!.heads!.kids!;
  const lead = heads.find((d) => d.key === 'p:fbeae7c18667b6987518')!;
  assert.deepEqual(lead.data, { node: 'p:fbeae7c18667b6987518', lineage: 'claude', role: 'principal', look: 'solid', instr: 'percussion', basis: 'registry', sel: '0' });
  assert.equal(lead.slots!.tag!.text, 'Claude 主会话，在等你');
  assert.ok(!lead.slots!.name!.text!.startsWith('shop'), 'no head repeats the project the header names');
  assert.ok(lead.slots!.title!.text!.includes('在等你：permission prompt'));
  const dept = heads.find((d) => d.key === 'p:2c3a4249d77070058649')!;
  assert.equal(dept.slots!.tag!.text, '往下派了 1 个活（第 1 层）');
  assert.equal(dept.slots!.dept!.data!.hide, '0');
  assert.equal(heads.find((d) => d.key === 'p:f46dd28a5499d8efef0b')!.data!.look, 'ghost');
  for (const d of [...heads, ...systems[1]!.slots!.heads!.kids!]) {
    const p = s.lanes[0].players.find((x: Json) => x.id === d.key)!;
    assert.deepEqual([d.data!.look, d.data!.instr, d.data!.role, d.data!.lineage], [p.look, p.instrument.class, p.role, p.harness], 'T1: the head is its fields');
  }
  const phrases = claude.slots!.phrases!.kids!;
  const by = (id: string) => phrases.find((d) => d.key === id)!;
  assert.equal(by('w:toolu_t1').slots!.cap!.text, '读 48k → 回报 1.2k');
  assert.equal(by('w:toolu_t1').slots!.tie!.data!.hide, '0');
  assert.deepEqual([by('w:toolu_t2').slots!.st!.text, by('w:toolu_t2').slots!.cap!.data!.hide], ['在跑', '1'], 'still working: the state above the bar, no sizes below');
  assert.deepEqual([by('w:toolu_t2').data!.sel, by('w:toolu_t2').attr!['aria-current']], ['1', 'true']);
  assert.equal(by('w:toolu_t2').slots!.tie!.data!.hide, '1', 'still working: nothing came back');
  assert.deepEqual([by('w:agent-a3').slots!.st!.text, by('w:agent-a3').slots!.cap!.text], ['可能断了', '读了多少未知']);
  assert.equal(by('w:agent-a3').data!.kind, 'stub');
  assert.ok(phrases.every((d) => d.slots!.title!.text!.startsWith(s.lanes[0].items.find((w: Json) => w.id === d.key).brief)));
  assert.ok(!texts(sc).some((t) => t.includes('无复核者')), 'the verdict lives in the detail, never on the score');
  const dshUnknown = systems[1]!.slots!.phrases!.kids!.find((d) => d.key === 'w:dsh:c41f96c594ee71fce362')!;
  assert.deepEqual([dshUnknown.slots!.st!.text, dshUnknown.slots!.cap!.text, dshUnknown.data!.kind], ['未知', '读了多少未知', 'stub'], 'no flow: a stub that says 未知');
  assert.deepEqual(claude.slots!.ferms!.kids!.map((d) => d.data!.node), s.podium.fermatas);
  assert.equal(sc.waits!.kids!.length, s.podium.fermatas.length);
  assert.equal(sc.waits!.kids![0]!.slots!.t!.text, 'shop · 重构结账流程 (checkout refactor) 在等你：permission prompt');
  assert.equal(sc.podium!.text, '需要你 1，收件箱未接入');
  assert.ok(!systems.some((d) => d.key === 'codex'), 'Codex has no players: its system is static and says 未接入');
  assert.equal(STAGE_TEXT['grp.codex'], '未接入（这一版不读）');
  const notes = describeScore(s as any, NOTES, null).systems!.kids!;
  assert.deepEqual(notes.map((d) => d.key), ['claude'], 'a group with no players in the lane draws no system');
  assert.equal(notes[0]!.slots!.heads!.kids![0]!.data!.instr, 'strings');
  assert.ok(notes[0]!.slots!.heads!.kids![0]!.slots!.title!.text!.endsWith('不在读到的尾部'), 'the full stand text is in the head title');
});

test('selecting a player marks its head and staff; a wait in another lane still counts and names it', () => {
  const s = sample();
  const sc = describeScore(s as any, SHOP, 'p:2c3a4249d77070058649');
  const claude = sc.systems!.kids![0]!;
  const sel = (kids: Json[]) => kids.filter((d) => d.data?.sel === '1').map((d) => d.key);
  assert.deepEqual(sel(claude.slots!.heads!.kids!), ['p:2c3a4249d77070058649']);
  assert.deepEqual(sel(claude.slots!.staves!.kids!), ['p:2c3a4249d77070058649']);
  assert.deepEqual(sel(claude.slots!.phrases!.kids!), []);
  s.podium.fermatas = ['p:b79f477f6d435116155b', 'p:ffffffffffffffffffff'];
  const other = describeScore(s as any, SHOP, null);
  assert.deepEqual(other.waits!.kids!.map((d) => d.data!.wait), ['p:b79f477f6d435116155b', '']);
  assert.equal(other.waits!.kids![1]!.slots!.t!.text, '有成员在等你，但不在读到的项目里');
  assert.equal(other.podium!.text, '需要你 2，收件箱未接入');
});

test('the drawer: basis, instrument evidence, rules at N=0, the canary only as its redaction marker', () => {
  const s = sample();
  const d = describeDrawer(s as any, SHOP, 'w:toolu_t2', null, fmt, 2000)!;
  const facts = Object.fromEntries(d.slots.facts!.kids!.map((k) => [k.key, k.slots!.v!.text]));
  assert.equal(facts['dr.live'], '在跑（推断），10 秒前');
  assert.equal(facts['dr.instr'], '做复核（code-reviewer）；近 15 次工具调用：读 10、写 0、命令 3');
  assert.equal(facts['dr.rule'], 'instrument.tool-map：没测过（0 个样本），本次命中 10');
  assert.equal(facts['dr.verdict'], '无复核者（这一版没有）');
  assert.equal(facts['dr.join'], '按描述关联（推测）；claude.clone.running：没测过（0 个样本），本次命中 2');
  assert.match(d.slots.brief!.text!, /\[redacted:sk-ant\]$/);
  assert.equal(d.slots.evNote!.text, '读取中…');
  assert.equal(d.session, 'ff7ce04c37f67805bb72');
  const ok = describeDrawer(s as any, SHOP, 'p:fbeae7c18667b6987518', {
    session: { id: '1f58d4ebc954d015d023', harness: 'claude', label: 'x', size: 1, mtimeMs: 0 },
    events: Array.from({ length: 60 }, (_, i) => ({ at: '2026-11-01T10:00:00.000Z', type: 'assistant', text: `e${i}` })), unparsed: 2, note: 'tail-only', brief: null,
  }, fmt, 0)!;
  const lead = Object.fromEntries(ok.slots.facts!.kids!.map((k) => [k.key, k.slots!.v!.text!]));
  assert.match(lead['dr.live'], /^在等你：permission prompt（登记表），\d+ (秒|分钟|小时)前$/, 'the wait is said once, with its reason');
  assert.equal(ok.slots.sub!.text!.split('在等你').length, 2, 'the drawer header says it once too');
  assert.equal(ok.slots.events!.kids!.length, 50);
  assert.equal(ok.slots.events!.kids![49]!.slots!.tx!.text, 'e59');
  assert.equal(ok.slots.evNote!.text, '另有 2 行没解析；只读了文件末尾');
  assert.equal(describeDrawer(s as any, SHOP, 'p:fbeae7c18667b6987518', { error: 'not-found' }, fmt, 0)!.slots.evNote!.text, '读取失败：not-found');
  assert.equal(describeDrawer(s as any, SHOP, 'p:00000000000000000000', null, fmt, 0), null);
  for (const t of everything(s)) assert.ok(!/sk-ant-api03-/.test(t));
});

test('clipW counts wide characters twice and marks a cut with …; plateText falls back honestly', () => {
  assert.equal(clipW('abcdef', 6), 'abcdef');
  assert.equal(clipW('abcdefg', 6), 'abcdef…');
  assert.equal(clipW('修复结账金额', 8), '修复结账…');
  assert.equal(fill('chip.sent', { n: 3 }), '已派 3');
  assert.equal(fill('no.such.key'), 'no.such.key');
  const p = sample().lanes[0].players[0];
  p.stand.keys = 'mismatch';
  assert.equal(plateText(p), '字段对不上');
});

test('no lane: the stage and plan say so instead of drawing an empty orchestra', () => {
  const s = sample();
  s.lanes = [];
  assert.equal(describeScore(s as any, null, null).nolanes!.text, '还没有读到任何会话');
  assert.deepEqual(describeScore(s as any, null, null).systems!.kids, []);
  assert.equal(describePlan(s as any, null, null, null, fmt).slots.empty.text, '还没有读到任何会话');
  assert.equal(describeHeader(s as any, null, { stale: false, at: '' }).laneIndex, -1);
});
