# Handoff: claude/sharp-robinson-3001ea

## Facts
- Owner: AdamPlatin123
- When: 2026-11-08
- Machine: 550W备份1号机
- Branch: claude/sharp-robinson-3001ea（从 `claude/orchestra-app` 的 ffd7daf 切出）
- Commit: 本交接所在的提交（之前 5b3a87e、f7b5866、54142d7）
- Pushed: no（用户还没定：合进 `claude/orchestra-app`（应能快进），还是推远端）
- Uncommitted on that machine: none

## Goal
问题卡：用户 2026-11-07 给了一张参考截图（富文本里的开关、单选、分段按钮和「提交」），要求照这个样子在 Orchestra 里自己写，不引入那个包。第一片只做「agent 问你问题时按选项回答」；截图里那排「批准」开关（批量审批）不在这一片，要用户另外拍板。

## Done（已完成且已验证）
- 服务端：Codex 的提问（`item/tool/requestUserInput`）不再压成纯文本。审批队列保留每一题的小标题、问题、选项（名字和说明）以及能不能自己写（`src/owned/approvals.ts` 的 `ApprovalQuestion`、`picksFit`、`answer()`；`src/owned/codex-session.ts` 的 `askQuestion`、`queueAsk`）。题目和选项经过与 preview 相同的遮蔽，被遮的处数计入 redactions，所以会让卡片变成高风险。
- 新的人类动作 `approval-answer`：`POST /api/approvals/:id/answer {digest, rev, answers}`，每题一项，要么是 `{option: 第几个}`，要么是 `{text}`。检查和「允许」一样：digest 对不上、列表 750 ms 内刚变过（stale-view），都不收。对不上题目的回答（少一题、选项越界、不让自己写却写了、空文本、一题两个答案）一律按 digest-mismatch 拒绝。页面只发选项的序号，服务端用 Codex 原本的选项名回给它，所以被遮住的选项也能答对。
- 只能拒绝的情况和以前一样：有一题是要密码那类秘密（isSecret）、有一题没有 id、id 重复、超过 8 题、某题超过 16 个选项、或 preview 太长。
- 契约：`shared/protocol.js` 的 HUMAN_VERBS 末尾加了 `approval-answer`，journal 的 `human` / `human.result` 的 verb 枚举跟着扩大（只增不减，旧 journal 照样能重放；但旧版 orchestrad 读到新 verb 会拒绝启动）。`shared/owned-contract.js` 的审批项多了 `questions` 字段，并新增 `checkQuestions`：questions 不为空当且仅当 canText。冻结测试 `test/repo/contract-freeze.test.ts` 已更新，加了说明段。
- 页面（`/` 和 `/tower` 两页）：问题卡和等你栏上的按钮是「回答…」，从来不出现「允许」。点开是 `qa-dlg` 对话框，每题一组按钮（`aria-pressed`，选中时圆圈填满）；2 到 4 个短选项且都没有说明时并排显示；能自己写的题有一行输入框。不替你预选任何一项；每题都有答案之前「提交回答」是灰的。答完后对话里显示「你回答了：」加每题一行。题目不止一题时，卡片标题是各题小标题用 / 连起来。（`ui/owned.js` 的 `describeAnswer`、`ui/drive.js` 的 `answerOpen`/`answerPick`/`answerTyped`/`answerGo`、两页 html 和 css、`shared/strings.js` 的 `qa.*`。）
- 提问开关（用户 2026-11-08 选「打开它」）：`src/owned/codex-home.ts` 的 `codexConfigToml` 现在写 `[features] default_mode_request_user_input = true`，文首注释记了测量结果和这是 Codex 标「开发中」的开关。`test/owned/owned-parts.test.ts` 和 `test/owned/owned-wiring.test.ts` 的 config.toml 断言已补。验证：全量 1807 条，1804 过，0 失败；测试 profile 实走一次，没手动改配置，生成的 config.toml 已带开关，worker 用 request_user_input 问了两题，选一项、自己写一项后，worker 复述「这个小项目叫“星屿”，页面主色使用橙色。」。走完实例已停、无残留进程、7483 端口已释放、测试目录已删。
- 页面体积上限：首页自有文件 128→131 KiB，首页总量 321→331 KiB，tower 页 248→257 KiB，原因写在两条测试的注释里。
- 验证：
  - 全量 `node --test "test/**/*.test.ts"`（node 用主检出目录的 `.tools/node24/node.exe`，普通权限）：1807 条，1804 过，0 失败，1 跳过，2 todo。合并改派后的基线是 1803 条，1800 过。
  - 新测试：`test/owned/owned-parts.test.ts`（picks 合不合题）、`test/owned/codex-session.test.ts`（两题、被遮的选项回原名、秘密题只能拒绝）、`test/server/owned-flow.test.ts`（HTTP 全程）、`test/owned/approval-origin.test.ts`（契约反例）、`test/ui/owned-app.test.ts`（假 DOM 里开对话框、选、写、提交，以及请求体）。
  - 测试 profile 真模型实走（内置浏览器，1280 宽，codex/gpt-6.1-sol 经 magpie）：两次都是 worker 用 request_user_input 问两题，在对话框里选一项、自己写一项，提交后 worker 复述的内容和答案一致（「项目叫 Baton，主题用绿色。」）。走完测试实例已停，没有残留 procguard 或 codex 进程，7483 端口已释放，测试目录已删。

## Unverified（做了但没验证，或验证没过）
- 提问开关 `default_mode_request_user_input` 在 codex-cli 0.165.0 里标着 under development。升级 Codex 后它可能改名或消失，那时 worker 会退回到用普通文字提问，问题卡不再出现。升级后要重新实走一次。开着它之后 worker 是不是明显更常停下来问，还没在真实任务里观察过。
- Codex 要求每题都有选项，不接受只能自己写的题（实走时 worker 说「request_user_input 要求每题都有选项」）。所以「没有选项、只给输入框」这条路径只有假 Codex 的测试覆盖。
- 实走时有一次模型没用工具，直接用普通文字提问。这取决于模型自己，Orchestra 管不了。
- 页面没在手机宽度和亮色主题下看过；屏幕阅读器没试过。
- 来源不可信的会话（r4 §8.5：seat 或总台派出、按受污染运行的会话）的问题卡：对话框顶部会写来源链，但回答不需要键入确认词。这样做是因为回答本身不执行任何东西，不过没走过真实场景。
- Claude 自有会话的提问（AskUserQuestion）没做，Claude 那边仍然只能拒绝。

## Next（按优先级，每条可独立执行）
1. 请用户决定这条分支的去向：合进 `claude/orchestra-app`（它停在 ffd7daf，这条分支在它之上，可以快进），还是推远端。
2. 第二片：Claude 的 AskUserQuestion 也做成问题卡。从 `src/owned/claude-session.ts` 第 783 行附近开始（现在固定 `canText: false`），对照 `src/owned/codex-session.ts` 的 `askQuestion` 填 `questions`、实现回答回写。
3. 批量审批（截图里那排「批准」开关）：要用户先拍板，见 Open questions。

## Do not touch
- 主检出目录里 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 的未提交改动：用户本人的第七批改动。

## Open questions
- 批量审批要不要做、怎么做。它和 D8（审批、拍板、刹车只有你能做，超时就算拒绝）有张力：一个「提交」同时放行好几件事，加上开关默认是开的，就成了一键全放行。2026-11-07 的建议是：开关默认关，只把低风险、来源干净的审批并在一起；来源不可信的照旧一张一张批，并且要键入确认词。
- 要不要在 r4 里补一句「问题卡的回答走 approval-answer，检查和允许一样」：r4 由用户本人改。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-07 AdamPlatin123：本分支开始时先把改派分支 `claude/serene-merkle-3ac513` 合进了 `claude/orchestra-app`（合并提交 8d2697c），并推到 origin（到 ffd7daf）。见 `docs/handoff/claude--orchestra-app.md`。

## 代号速查
| 代号 | 内容（一句话） | 出处 |
|---|---|---|
| D8 | 审批、拍板、刹车只有你能做，超时就算拒绝；不给能长期生效的授权 | r4；`src/owned/approvals.ts` 文首 |
| r4 §8.5 | 来源不可信（seat、总台派出）的会话按受污染运行，卡片上写来源链 | r4 §8.5 |
| r4 §10.9 | 列表刚变过 750 ms 内点「允许」不算数；高风险要按住或键入 | `src/owned/approvals.ts` 第 14–16 行 |
| stale-view / digest-mismatch | 前者：页面看到的列表已过时，什么都不做；后者：页面看到的和服务端的不一致，直接拒绝这一条 | `src/owned/approvals.ts` |
| 测试 profile | `--test-profile --test-dir <dir>`：数据全在那个测试目录里，不碰真实数据 | `src/boot.ts` |
