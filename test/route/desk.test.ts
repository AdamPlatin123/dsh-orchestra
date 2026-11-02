import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { TestContext } from 'node:test';
import type { LoopbackPost, LoopbackPostResult } from '../../src/net/magpie.ts';
import { makeLoopbackPost, parseLoopbackUrl } from '../../src/net/magpie.ts';
import { DESK_LIMITS, dispatchOf, makeAfter, makeDesk } from '../../src/route/desk.ts';
import type { DeskDeps } from '../../src/route/desk.ts';
import { DEFAULT_ROUTER_MODEL, ROUTER_SYSTEM_PROMPT, readRouterReply, routerRequest } from '../../src/route/router-model.ts';
import { VirtualClock } from '../../src/runtime/clock.ts';
import { checkBody } from '../../src/store/records.ts';

// The dispatch desk (orchestra app plan §3): the rules first, then the router model on magpie, and a
// suggestion that starts nothing. The router model here is a fake HTTP server on 127.0.0.1 at a random
// port, reached through the same narrow POST module production uses (src/net/magpie.ts); the deadline
// runs on a VirtualClock. Every sentence and every answer is synthetic.

const BOTH = { codex: true, claude: true } as const;
const ok = (text: string): LoopbackPostResult => ({ ok: true, status: 200, text });
/** A chat completion as magpie sends it: the JSON answer as a string in message.content, beside a reasoning text that is ignored. */
const completion = (content: string) => JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, reasoning_content: 'thinking out loud' } }] });

type Fake = { url: string; bodies: unknown[]; got: Promise<void> };

/** A fake magpie: answers each POST with `answer(body)`, or never when it returns null. */
async function fakeMagpie(t: TestContext, answer: (body: any) => { status: number; text: string } | null): Promise<Fake> {
  const bodies: unknown[] = [];
  let gotOne!: () => void;
  const got = new Promise<void>((r) => { gotOne = r; });
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers['content-type'], 'application/json');
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      bodies.push(body);
      gotOne();
      const a = answer(body);
      if (a === null) {
        open.add(res);
        return;
      }
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(a.text);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => {
    for (const res of open) res.destroy();
    server.close(() => r());
  }));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1/chat/completions`, bodies, got };
}

function desk(post: LoopbackPost | null, over: Partial<DeskDeps> = {}) {
  let mono = 1000;
  const d = makeDesk({ post, routerModel: DEFAULT_ROUTER_MODEL, on: () => BOTH, redact: (s) => s.replace(/sk-[A-Za-z0-9]+/g, '[redacted]'), nowMono: () => mono, nowWall: () => 1_761_868_800_000, ...over });
  return { d, tick: (ms: number) => { mono += ms; } };
}

test('the narrow POST takes only http://127.0.0.1 URLs: no other host, scheme, query, fragment or user info', () => {
  assert.deepEqual(parseLoopbackUrl('http://127.0.0.1:3425/v1/chat/completions'), { port: 3425, path: '/v1/chat/completions' });
  for (const u of ['http://localhost:3425/v1/chat/completions', 'https://127.0.0.1:3425/v1', 'http://10.0.0.1:3425/v1', 'http://127.0.0.1:3425/v1?x=1', 'http://127.0.0.1:3425/v1#x', 'http://u:p@127.0.0.1:3425/v1', 'http://[::1]:3425/v1', 'not a url']) {
    assert.equal(parseLoopbackUrl(u), null, u);
    assert.throws(() => makeLoopbackPost({ url: u, after: () => () => {}, timeoutMs: 1, maxBytes: 1 }), /not a loopback/, u);
  }
});

test('what goes out is the fixed system prompt and the sentence, nothing else; JSON mode, no streaming', () => {
  const body = routerRequest(DEFAULT_ROUTER_MODEL, '把 README 翻成英文');
  assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'response_format', 'stream', 'temperature']);
  assert.deepEqual(body.messages, [{ role: 'system', content: ROUTER_SYSTEM_PROMPT }, { role: 'user', content: '把 README 翻成英文' }]);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.stream, false);
  assert.equal(body.model, 'zcode/GLM-5.3');
});

test('the router model\'s reply: valid, fenced, not JSON, missing fields, a model off the list, a harness that is off, an HTTP error, a failed POST', () => {
  const answer = (o: unknown) => ok(completion(JSON.stringify(o)));
  const good = { harness: 'claude', model: 'zcode/glm-5.3-flash', title: '解释代码', reason: '短问答，sk-abc123 用快模型' };
  const r = readRouterReply(answer(good), BOTH, (s) => s.replace(/sk-[A-Za-z0-9]+/g, '[redacted]'));
  assert.deepEqual(r, { ok: true, pick: { harness: 'claude', model: 'zcode/GLM-5.3-Flash', title: '解释代码', reason: '短问答，[redacted] 用快模型' } });
  assert.equal(readRouterReply(ok(completion('```json\n' + JSON.stringify(good) + '\n```')), BOTH, (s) => s).ok, true, 'one code fence is taken');
  const why = (x: LoopbackPostResult, on: { codex: boolean; claude: boolean } = BOTH) => { const a = readRouterReply(x, on, (s) => s); return a.ok ? 'ok' : a.why; };
  assert.equal(why(ok(completion('I think codex'))), 'bad-json');
  assert.equal(why(ok('<html>')), 'bad-json');
  assert.equal(why(ok(JSON.stringify({ choices: [] }))), 'bad-json');
  assert.equal(why(answer({ harness: 'codex', model: 'codex/gpt-6.1-sol' })), 'bad-shape');
  assert.equal(why(answer({ ...good, title: '   ' })), 'bad-shape');
  assert.equal(why(answer({ ...good, harness: 'dsh' })), 'bad-shape');
  assert.equal(why(answer({ ...good, model: 'gpt-4o' })), 'model-not-allowed');
  assert.equal(why(answer({ ...good, harness: 'claude', model: 'codex/gpt-6.1-sol' })), 'model-not-allowed', 'Claude takes no codex/* model');
  assert.equal(why(answer(good), { codex: true, claude: false }), 'harness-off');
  assert.equal(why({ ok: true, status: 502, text: completion(JSON.stringify(good)) }), 'http-error');
  assert.equal(why({ ok: false, why: 'timeout' }), 'timeout');
  assert.equal(why({ ok: false, why: 'network' }), 'network');
  const noReason = readRouterReply(answer({ ...good, reason: 7 }), BOTH, (s) => s);
  assert.equal(noReason.ok && noReason.pick.reason, null);
});

test('a valid answer: the model\'s pick leads, the rules follow as alternatives; the fake saw only the prompt and the sentence; nothing starts', async (t) => {
  const fake = await fakeMagpie(t, () => ({ status: 200, text: completion(JSON.stringify({ harness: 'claude', model: 'zcode/GLM-5.3', title: '翻译 README', reason: '纯文字翻译' })) }));
  const clock = new VirtualClock({ mono: 0, wall: 0 });
  const post = makeLoopbackPost({ url: fake.url, after: makeAfter(clock), timeoutMs: 20_000, maxBytes: 64 * 1024 });
  const { d } = desk(post);
  const r = await d.suggest('把 README 翻成英文');
  assert.equal(r.router.state, 'answered');
  assert.equal(r.router.why, null);
  assert.equal(r.title, '翻译 README');
  assert.deepEqual(r.candidates.map((c) => [c.harness, c.model, c.source, c.rule, c.reason]), [
    ['claude', 'zcode/GLM-5.3', 'model', null, '纯文字翻译'],
    ['codex', 'codex/gpt-6.1-sol', 'rule', 'code-or-command', null],
  ]);
  assert.deepEqual([...r.rules], ['code-or-command', 'fallback']);
  assert.match(r.routeId, /^[0-9a-f]{20}$/);
  assert.equal(fake.bodies.length, 1);
  assert.deepEqual((fake.bodies[0] as any).messages, [{ role: 'system', content: ROUTER_SYSTEM_PROMPT }, { role: 'user', content: '把 README 翻成英文' }]);
  assert.deepEqual(clock.pending(), [], 'the deadline was cancelled once the answer came');
  assert.equal(d.last(), null, 'a suggestion is no dispatch');
});

test('a sentence that names a harness keeps it first, even when the model picks another', async (t) => {
  const fake = await fakeMagpie(t, () => ({ status: 200, text: completion(JSON.stringify({ harness: 'claude', model: 'zcode/GLM-5.3', title: '修测试', reason: '随便' })) }));
  const clock = new VirtualClock({ mono: 0, wall: 0 });
  const { d } = desk(makeLoopbackPost({ url: fake.url, after: makeAfter(clock), timeoutMs: 20_000, maxBytes: 64 * 1024 }));
  const r = await d.suggest('用 codex 修一个测试');
  assert.deepEqual(r.candidates.map((c) => `${c.harness} ${c.model} ${c.source}`), ['codex codex/gpt-6.1-sol rule', 'claude zcode/GLM-5.3 model']);
  assert.equal(r.router.pick, 1);
});

test('the router model agrees with a rule: one candidate, the rule\'s, and router.pick names it', async () => {
  const post: LoopbackPost = async () => ok(completion(JSON.stringify({ harness: 'codex', model: 'codex/gpt-6.1-sol', title: '修测试', reason: '同意' })));
  const r = await desk(post).d.suggest('用 codex 修一个测试');
  assert.deepEqual(r.candidates.map((c) => `${c.harness} ${c.model} ${c.source}`), ['codex codex/gpt-6.1-sol rule', 'claude zcode/GLM-5.3 rule']);
  assert.deepEqual([r.router.state, r.router.pick], ['answered', 0]);
});

test('content that is not JSON: no answer (bad-json), the card is the rules\' alone', async (t) => {
  const fake = await fakeMagpie(t, () => ({ status: 200, text: completion('Sure! I would use codex.') }));
  const clock = new VirtualClock({ mono: 0, wall: 0 });
  const { d } = desk(makeLoopbackPost({ url: fake.url, after: makeAfter(clock), timeoutMs: 20_000, maxBytes: 64 * 1024 }));
  const r = await d.suggest('解释一下这段代码');
  assert.deepEqual(r.router, { model: 'zcode/GLM-5.3', state: 'no-answer', why: 'bad-json', pick: null });
  assert.ok(r.candidates.every((c) => c.source === 'rule'));
  assert.equal(r.candidates[0]!.model, 'zcode/GLM-5.3-Flash');
  assert.equal(r.title, '解释一下这段代码');
});

test('no answer within the deadline (20 s on the Clock): timeout, the rules alone; a reply too big is too-big', async (t) => {
  const silent = await fakeMagpie(t, () => null);
  const clock = new VirtualClock({ mono: 0, wall: 0 });
  const { d } = desk(makeLoopbackPost({ url: silent.url, after: makeAfter(clock), timeoutMs: 20_000, maxBytes: 64 * 1024 }));
  const out = d.suggest('帮我想想下周的计划');
  await silent.got;
  assert.equal(clock.pending().length, 1);
  clock.advanceBy(19_999);
  clock.advanceBy(1);
  const r = await out;
  assert.deepEqual([r.router.state, r.router.why], ['no-answer', 'timeout']);
  assert.deepEqual(r.candidates.map((c) => c.rule), ['fallback', 'fallback']);

  const big = await fakeMagpie(t, () => ({ status: 200, text: 'x'.repeat(10_000) }));
  const small = makeLoopbackPost({ url: big.url, after: makeAfter(clock), timeoutMs: 20_000, maxBytes: 1024 });
  assert.deepEqual(await small({}), { ok: false, why: 'too-big' });
  // Nobody listens: network.
  const closed = await fakeMagpie(t, () => ({ status: 200, text: '' }));
  const port = Number(new URL(closed.url).port);
  await new Promise((r) => setTimeout(r, 10));
  const gone = makeLoopbackPost({ url: `http://127.0.0.1:${port === 1 ? 2 : 1}/v1/chat/completions`, after: makeAfter(clock), timeoutMs: 20_000, maxBytes: 1024 });
  assert.deepEqual(await gone({}), { ok: false, why: 'network' });
});

test('the router model is not asked when the rules settled it (harness and model named), nor when it is off', async () => {
  let calls = 0;
  const post: LoopbackPost = async () => {
    calls++;
    return ok(completion('{}'));
  };
  const { d } = desk(post);
  const r = await d.suggest('用 claude 和 zcode/GLM-5.3-Flash 回答一下');
  assert.equal(r.router.state, 'skipped');
  assert.equal(calls, 0);
  assert.equal(r.candidates[0]!.rule, 'named-model');
  const off = await desk(null).d.suggest('解释一下这段代码');
  assert.equal(off.router.state, 'off');
  assert.equal(off.candidates[0]!.source, 'rule');
});

test('the RouteDecision: the candidates, the pick, the reason chip, mode manual; it passes the journal\'s schema; take() wants the same sentence and a fresh suggestion', async () => {
  const post: LoopbackPost = async () => ok(completion(JSON.stringify({ harness: 'claude', model: 'zcode/GLM-5.3', title: '翻译', reason: '文字活' })));
  const { d, tick } = desk(post);
  const r = await d.suggest('把 README 翻成英文');
  assert.equal(d.take(r.routeId, '把 README 翻成中文'), null, 'another sentence takes nothing');
  assert.equal(d.take('0000000000aaaaaaaaaa', '把 README 翻成英文'), null);
  const kept = d.take(r.routeId, '把 README 翻成英文');
  assert.ok(kept !== null);
  const rec = d.decision(kept, { actionId: '11111111-1111-4111-8111-111111111111', ownedId: 'abcdefabcdefabcdefab', harness: 'codex', model: 'codex/gpt-6.1-sol' });
  assert.equal(rec.kind, 'route');
  const { decisionId, ...rest } = rec.body;
  assert.match(String(decisionId), /^[0-9a-f]{64}$/);
  assert.deepEqual(rest, {
    actionId: '11111111-1111-4111-8111-111111111111', routeId: r.routeId, ownedId: 'abcdefabcdefabcdefab', taskClass: 'code', rules: ['code-or-command', 'fallback'],
    candidates: [
      { harness: 'claude', model: 'zcode/GLM-5.3', source: 'model', rule: null },
      { harness: 'codex', model: 'codex/gpt-6.1-sol', source: 'rule', rule: 'code-or-command' },
    ],
    chosen: { harness: 'codex', model: 'codex/gpt-6.1-sol' }, pick: 1, reason: 'code-or-command', router: 'answered', mode: 'manual',
  });
  assert.equal(checkBody('route', rec.body, null), null);
  assert.equal(d.take(r.routeId, '把 README 翻成英文'), null, 'a decision uses the suggestion up');

  // Set by hand: pick null, reason manual. The model's pick taken: reason router-model.
  const r2 = await d.suggest('把 README 翻成英文');
  const manual = d.decision(d.take(r2.routeId, '把 README 翻成英文')!, { actionId: '22222222-2222-4222-8222-222222222222', ownedId: 'abcdefabcdefabcdefab', harness: 'claude', model: 'opencode-go/kimi-k3' });
  assert.deepEqual([manual.body.pick, manual.body.reason], [null, 'manual']);
  assert.equal(checkBody('route', manual.body, null), null);
  const r3 = await d.suggest('把 README 翻成英文');
  const byModel = d.decision(d.take(r3.routeId, '把 README 翻成英文')!, { actionId: '33333333-3333-4333-8333-333333333333', ownedId: 'abcdefabcdefabcdefab', harness: 'claude', model: 'zcode/GLM-5.3' });
  assert.deepEqual([byModel.body.pick, byModel.body.reason], [0, 'router-model']);
  // The journal holds these rules across fields.
  assert.equal(checkBody('route', { ...byModel.body, reason: 'manual' }, null)?.reason, 'consistency');
  assert.equal(checkBody('route', { ...byModel.body, chosen: { harness: 'codex', model: 'codex/gpt-6.1-sol' } }, null)?.reason, 'consistency');
  assert.equal(checkBody('route', { ...byModel.body, pick: 2 }, null)?.reason, 'consistency');
  assert.equal(checkBody('route', { ...byModel.body, title: 'free text' }, null)?.reason, 'extra-key', 'no free text in a body');

  // A suggestion ages out.
  const r4 = await d.suggest('把 README 翻成英文');
  tick(DESK_LIMITS.ttlMs + 1);
  assert.equal(d.take(r4.routeId, '把 README 翻成英文'), null);

  // A dispatch is what the router row shows; a stored body gives it back.
  d.dispatched({ ownedId: 'abcdefabcdefabcdefab', harness: 'codex', model: 'codex/gpt-6.1-sol' });
  assert.deepEqual(d.last(), { ownedId: 'abcdefabcdefabcdefab', harness: 'codex', model: 'codex/gpt-6.1-sol', at: 1_761_868_800_000 });
  assert.deepEqual(dispatchOf(rec.body, 42), { ownedId: 'abcdefabcdefabcdefab', harness: 'codex', model: 'codex/gpt-6.1-sol', at: 42 });
  assert.equal(dispatchOf({ ownedId: 1 }, 42), null);
});
