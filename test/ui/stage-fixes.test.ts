import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { oneAtATime } from '../../ui/api.js';
import { activates, outsideBox } from '../../ui/dom.js';
import { parse } from '../../ui/route.js';
import { describePlan, nameplate } from '../../ui/view.js';

// The page's review fixes that live in pure modules: a hash that does not decode, one poll at a time,
// the drawer's backdrop test, Space on a role=button, the nameplate's project cut, the stray rows'
// button names, and the contrast of the --stale text that carries 无复核者（M0） and 未测（N=0）.

const LANE = 'a'.repeat(20);

test('a hash with a malformed escape parses with that part missing, never a throw', () => {
  assert.deepEqual(parse('#/stage/%'), { view: 'stage', lane: null, node: null, peek: false });
  assert.deepEqual(parse('#/plan/abc%E0%A4%A'), { view: 'plan', lane: null, node: null, peek: false });
  assert.deepEqual(parse(`#/plan/${LANE}/p%3Azz%/peek`), { view: 'plan', lane: LANE, node: null, peek: false });
  assert.deepEqual(parse(`#/stage/${LANE}/${encodeURIComponent(`p:${'b'.repeat(20)}`)}/peek`), { view: 'stage', lane: LANE, node: `p:${'b'.repeat(20)}`, peek: true });
});

test('one poll at a time: a call while one is out answers null and starts nothing', async () => {
  let started = 0;
  let release: (v: string) => void = () => {};
  const run = oneAtATime(() => {
    started++;
    return new Promise<string>((r) => (release = r));
  });
  const first = run();
  assert.equal(await run(), null);
  assert.equal(started, 1);
  release('a');
  assert.equal(await first, 'a');
  const second = run();
  assert.equal(started, 2);
  release('b');
  assert.equal(await second, 'b');
  // A run that throws frees the slot too.
  const failing = oneAtATime(async () => {
    throw new Error('x');
  });
  await assert.rejects(failing());
  await assert.rejects(failing());
});

test('the drawer closes only on a click outside its box, and Space activates like Enter', () => {
  const box = { left: 600, right: 1060, top: 0, bottom: 900 };
  assert.equal(outsideBox(box, 300, 400), true, 'the backdrop');
  assert.equal(outsideBox(box, 610, 400), false, 'the dialog padding');
  assert.equal(outsideBox(box, 800, 899), false, 'below the last section');
  assert.deepEqual([' ', 'Enter', 'a', 'Tab'].map((key) => activates({ key })), [true, true, false, false]);
  assert.equal(activates({ key: ' ', isComposing: true }), false);
});

test('the nameplate cuts the project only when the label head is exactly its name', () => {
  const p = (label: string) => ({ role: 'clone', harness: 'claude', agentType: null, label, session: 'c'.repeat(20) }) as never;
  assert.equal(nameplate(p('dsh · run tests'), { name: 'dsh-orchestra' } as never).name, 'dsh · run tests');
  assert.equal(nameplate(p('shop · fix'), { name: 'shop' } as never).name, 'fix');
  assert.equal(nameplate(p('shop-api · fix'), { name: 'shop' } as never).name, 'shop-api · fix');
});

test('several stray players each get a button that names them', () => {
  const s = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../fixtures/stage-ui-sample.json', import.meta.url)), 'utf8'));
  const lane = s.lanes[0];
  // Every item gone: each clone is a stray of 未关联.
  lane.items = [];
  lane.cues = [];
  const fmt = { time: () => '00:00:00', iso: () => '00:00:00' };
  const rows = describePlan(s, lane.id, null, null, fmt).slots.list.kids!.filter((d) => d.key.startsWith('x:'));
  assert.ok(rows.length >= 2, `${rows.length} stray rows`);
  const names = rows.map((d) => d.slots!.brief!.text as string);
  assert.equal(new Set(names).size, names.length, `identical button names: ${names.join(' | ')}`);
});

test('--stale text meets WCAG AA (4.5:1) on the light card and paper', () => {
  const css = fs.readFileSync(fileURLToPath(new URL('../../ui/stage.css', import.meta.url)), 'utf8');
  const light = (name: string) => {
    const m = new RegExp(`--${name}:\\s*light-dark\\((#[0-9a-f]{6})`, 'i').exec(css);
    assert.ok(m !== null, `--${name}`);
    return m[1]!;
  };
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x! + 0.05) / (y! + 0.05);
  };
  for (const bg of ['card', 'paper']) assert.ok(ratio(light('stale'), light(bg)) >= 4.5, `--stale on --${bg}: ${ratio(light('stale'), light(bg)).toFixed(2)}`);
});
