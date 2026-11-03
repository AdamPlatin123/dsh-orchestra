// The DSH seat bundle's own tests (integrations/dsh-seat, outside src/shared/ui and every repo scan) run in
// the repo suite too: importing the file registers its node:test cases in this run. The cases below hold
// the bundle's restated protocol to orchestrad's own and run the seat's pipe client against the real port.
import '../../integrations/dsh-seat/test/provider.test.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as seat from '../../integrations/dsh-seat/index.js';
import { makeRealClock, oneShot } from '../../src/runtime/clock.ts';
import { Log } from '../../src/runtime/log.ts';
import { makeRequests } from '../../src/route/requests.ts';
import { AGENT_AUTH, AGENT_TOKEN_FILE, agentPipeName, agentReplyMac, agentRequestMac, startAgentPort } from '../../src/server/agent-port.ts';
import { withTmp } from '../helpers/tmp.ts';

test('the seat restates orchestrad\'s proof exactly: the same header names, the same request MAC and reply proof', () => {
  assert.deepEqual({ ...seat.AGENT_AUTH }, { ...AGENT_AUTH });
  const token = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(16).toString('base64url');
  const body = Buffer.from(JSON.stringify({ harness: 'codex', text: '中文 and text' }));
  assert.equal(seat.agentRequestMac(token, nonce, '1800000000000', 'POST', '/agent/v1/requests', body), agentRequestMac(token, nonce, '1800000000000', 'POST', '/agent/v1/requests', body));
  assert.equal(seat.agentReplyMac(token, nonce, 200, '{"a":1}'), agentReplyMac(token, nonce, 200, '{"a":1}'));
  assert.notEqual(seat.agentRequestMac(token, nonce, '1800000000000', 'GET', '/agent/v1/requests', body), agentRequestMac(token, nonce, '1800000000000', 'POST', '/agent/v1/requests', body));
});

test('the seat\'s pipe client against the real agent port: submit, a long poll, a withdraw with the key; a pending request that the seat gives up on is withdrawn', async (t) => {
  if (process.platform !== 'win32') return t.skip('named pipes in this form are Windows only');
  const dir = withTmp(t);
  const clock = makeRealClock();
  const p = clock.port(null);
  const requests = makeRequests({ after: oneShot(clock, 'seat-e2e'), nowMono: () => p.nowMono(), nowWall: () => p.nowWall(), redact: (text) => ({ text, count: 0 }), observe: () => null, endOwned: () => false });
  t.after(() => requests.close());
  const tokenFile = path.join(dir, AGENT_TOKEN_FILE);
  const started = await startAgentPort({
    after: oneShot(clock, 'seat-e2e-port'), nowMono: () => p.nowMono(), nowWall: () => p.nowWall(),
    pipe: agentPipeName('test', `seat-e2e-${crypto.randomBytes(4).toString('hex')}`), tokenFile,
    writeToken: (f, text) => fs.writeFileSync(f, text, { flag: 'wx' }), removeToken: (f) => fs.rmSync(f), requests, judgeCwd: () => null, log: new Log({ clock: p }),
  });
  assert.ok(started.ok);
  if (!started.ok) return;
  t.after(() => started.port.close());
  const port = seat.makePipePort({ pipe: started.port.pipe, tokenFile });
  const provider = seat.makeSeatProvider({ providerName: 'orchestra-codex', harness: 'codex', port, requestTimeoutMs: 5_000 });
  const run = await provider.start({ prompt: [{ type: 'text', text: 'create hello.txt containing hi' }], parent: { id: 'sess-e2e' }, cwd: 'D:\\work', label: 'hello 😀', signal: new AbortController().signal });
  const id = run.id.slice('orchestra-'.length);
  const card = requests.get(id)!;
  assert.deepEqual([card.state, card.requester, card.label], ['pending', { kind: 'dsh', sessionId: 'sess-e2e' }, 'hello 😀']);
  const r = await run.result;
  assert.deepEqual([r.stopReason, r.diagnostic], ['refusal', seat.DIAG.seatTimeout(5)]);
  assert.deepEqual([requests.get(id)!.state, requests.get(id)!.why], ['withdrawn', 'requester-withdrew']);
});
