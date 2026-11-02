import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHEAP_MODEL, MAX_CANDIDATES, ROUTE_MODELS, TITLE_CP, canonicalModel, clip, isCodeOrCommand, isShortQuestion, runRules } from '../../src/route/rules.ts';
import { MODELS } from '../../ui/owned.js';

// The dispatch desk's deterministic rules (orchestra app plan §3; r4 D9: rules first). Every sentence
// here is synthetic. Each case names the rules that hit, in order, and the candidates they put up.

const BOTH = { codex: true, claude: true } as const;
const brief = (text: string, on: { codex: boolean; claude: boolean } = BOTH) => {
  const r = runRules(text, on);
  return { hits: [...r.hits], first: r.candidates[0] === undefined ? null : `${r.candidates[0].harness} ${r.candidates[0].model} ${r.candidates[0].rule}`, all: r.candidates.map((c) => `${c.harness} ${c.model}`), taskClass: r.taskClass, decided: r.decided };
};

test('the desk\'s model lists are the dialog\'s (ui/owned.js MODELS), the default first', () => {
  assert.deepEqual(ROUTE_MODELS, MODELS);
  assert.ok(ROUTE_MODELS.claude.includes(CHEAP_MODEL));
  assert.equal(canonicalModel('ZCODE/glm-5.3-flash'), 'zcode/GLM-5.3-Flash');
  assert.equal(canonicalModel('codex/gpt-6.1-sol', 'claude'), null, 'Claude takes no codex/* model');
  assert.equal(canonicalModel('gpt-4o'), null);
});

test('named-harness: "用 codex 修一个测试" goes to Codex first, the code rule agrees, Claude is the alternative', () => {
  const r = brief('用 codex 修一个测试');
  assert.deepEqual(r.hits, ['named-harness', 'code-or-command', 'fallback']);
  assert.equal(r.first, 'codex codex/gpt-6.1-sol named-harness');
  assert.deepEqual(r.all, ['codex codex/gpt-6.1-sol', 'claude zcode/GLM-5.3']);
  assert.equal(r.taskClass, 'named');
  assert.equal(r.decided, false, 'a harness without a model leaves the model to decide');
  assert.equal(brief('please use Claude to review this').first, 'claude zcode/GLM-5.3 named-harness');
  assert.equal(brief('@claude 看看这个设计').first, 'claude zcode/GLM-5.3 named-harness');
  // "codex" inside another word names nothing.
  assert.equal(brief('用 codexify 打包').hits.includes('named-harness'), false);
});

test('named-harness: "不要用 codex" rules Codex out of the card', () => {
  const r = brief('不要用 codex，帮我修复登录的 bug');
  assert.ok(r.hits.includes('named-harness'));
  assert.ok(r.all.every((c) => c.startsWith('claude ')), r.all.join(' | '));
  assert.equal(brief("don't use claude, fix the build").all.every((c) => c.startsWith('codex ')), true);
});

test('named-model: a full id or a bare name; its harness when it takes it; harness and model both named is decided (the router model is not asked)', () => {
  const full = brief('用 claude 和 zcode/GLM-5.3-Flash 回答一下');
  assert.equal(full.first, `claude ${CHEAP_MODEL} named-model`);
  assert.equal(full.decided, true);
  assert.equal(brief('用 GLM-5.3-Flash 总结这段话').first, 'claude zcode/GLM-5.3-Flash named-model', 'the longest bare name wins over GLM-5.3');
  assert.equal(brief('换 kimi-k3 试试').first, 'claude opencode-go/kimi-k3 named-model');
  // A codex/* model named with Claude: Claude cannot run it, so it goes to Codex and nothing is decided.
  const cross = brief('用 claude 跑 codex/gpt-6.1-terra');
  assert.equal(cross.first, 'codex codex/gpt-6.1-terra named-model');
  assert.equal(cross.decided, false);
  // GLM-5.3 inside GLM-5.3.1 names nothing.
  assert.equal(brief('GLM-5.3.1 是什么').hits.includes('named-model'), false);
});

test('code-or-command: changing code, running commands or tests, or editing a named file leans Codex', () => {
  for (const s of ['把 README 翻成英文', '修复 src/app.ts 里的报错', 'run the tests and fix what fails', '写一个脚本清理临时文件', '编辑 notes.md 加一节']) {
    assert.ok(isCodeOrCommand(s), s);
    assert.equal(brief(s).first?.startsWith('codex codex/gpt-6.1-sol'), true, s);
  }
  for (const s of ['解释一下这段代码', '这段代码是什么意思？', '周末去哪玩']) assert.equal(isCodeOrCommand(s), false, s);
});

test('short-question: a short question or "explain" goes to the cheap model on Claude; a long one does not', () => {
  const r = brief('解释一下这段代码');
  assert.deepEqual(r.hits, ['short-question', 'fallback']);
  assert.equal(r.first, `claude ${CHEAP_MODEL} short-question`);
  assert.equal(r.taskClass, 'question');
  assert.ok(isShortQuestion('what does this regex match?'));
  assert.ok(!isShortQuestion(`为什么${'很长'.repeat(60)}`), 'over 80 code points is not short');
  // Named Claude with a question: the cheap model too.
  assert.equal(brief('用 claude 解释 TCP 是什么？').first, `claude ${CHEAP_MODEL} named-harness`);
});

test('fallback: no rule hits, the two defaults; a harness that is off is never offered', () => {
  const r = brief('帮我想想下周的计划');
  assert.deepEqual(r.hits, ['fallback']);
  assert.deepEqual(r.all, ['codex codex/gpt-6.1-sol', 'claude zcode/GLM-5.3']);
  assert.equal(r.taskClass, 'general');
  assert.deepEqual(brief('帮我想想下周的计划', { codex: false, claude: true }).all, ['claude zcode/GLM-5.3']);
  assert.deepEqual(brief('用 codex 修一个测试', { codex: false, claude: true }).all, ['claude zcode/GLM-5.3']);
  assert.deepEqual(brief('随便', { codex: false, claude: false }).all, []);
  assert.equal(runRules('随便', { codex: false, claude: false }).decided, false);
});

test('at most three candidates, no repeats; the rule title is the first line, cleaned and cut', () => {
  const r = runRules('用 codex 和 zcode/GLM-5.3 解释一下这段代码？', BOTH);
  assert.ok(r.candidates.length <= MAX_CANDIDATES);
  assert.equal(new Set(r.candidates.map((c) => `${c.harness} ${c.model}`)).size, r.candidates.length);
  assert.equal(runRules('\n\n  第一行\t任务  \n第二行', BOTH).title, '第一行 任务');
  const long = runRules('长'.repeat(100), BOTH).title;
  assert.equal([...long].length, TITLE_CP);
  assert.ok(long.endsWith('…'));
  assert.equal(clip(`a${String.fromCharCode(0x202e)}b${String.fromCharCode(7)}c`, 10), 'a b c', 'bidi and control characters never reach a title');
});
