# Handoff: claude/zen-superagent-exploration-04992d

## Facts
- Owner: AdamPlatin123
- When: 2026-11-01 10:40 +0000
- Machine: 550W备份1号机
- Branch: claude/zen-superagent-exploration-04992d（worktree，从 main@a1492bf 拉出）
- Commit: a1492bf（本交接随研究笔记一起提交，提交会晚于它）
- Pushed: no。这个分支没有设置 upstream，push 要等用户点头
- Uncommitted on that machine: 这个 worktree 里没有。但主检出目录（main 分支）有一处未提交改动：`docs/specs/2026-10-27-dsh-orchestra-design-r4.md`，约 +145/−113 行。它来自另一个 Claude 账号目录的会话，本会话没碰它，也没读它的内容。

## Goal
继续研究两件事：一是 DeepSeek Super-agent 原型；二是「开眼」准则（zen，`docs/research/2026-10-31-eye-diagram-zen.md` 里借眼图写下的 P1–P9 状态设计准则）。另外加入用户提供的 Spawn 案例，做三方对照。只做研究，不改规格，也不改代码。

## Done（已完成且已验证）
- `docs/research/2026-11-01-zen-superagent-deep-read.md`：逐文件读完 Super-agent 原型 @6337fc8（7 个切片），按 P1–P9 对照。
  - 验证：每个切片配一个唱反调的复核者。84 条里 53 条成立、31 条打折扣、0 条被推翻。
  - 主会话亲手核对了 3 条关键证据，都成立：`http.ts:75-79`、`settings.ts:32-53` 加 `tools/main.ts:248-299`、`dsh.ts:493-503`。
- `docs/research/2026-11-01-spawn-agent-org.md`：Spawn 创始人长文的一手核对，以及按协调、权力、验证三个角度对照 r4。
  - 验证：48 条里 30 条成立、18 条打折扣、0 条被推翻。
- `docs/research/2026-11-01-zen-superagent-spawn-overview.md`：三方总览，14 个问题按落点排了序。
  - 第 3 节读了本仓库的 `src/store/journal.ts:150-153,226`、`src/store/db.ts:285-290`。
- `docs/research/2026-10-31-deepseek-superagent.md`：只在文首加了一行更新说明，正文没动。

## Unverified（做了但没验证，或验证没过）
- 两份笔记中，除了那 3 条，其余由子代理产出的证据没有逐条亲手复核。
- 总览第 3 节有一个结论：新版本 journal 被旧版读到时，报的是 `journal-chain`，和真正的损坏共用一个符号。这是读代码得出的，没跑测试。
- Super-agent 的文章原文仍没读到（微信验证页）。Spawn 原文取自 teapaw.org 镜像，不是 X 原页面。
- DSH 本体源码没读。关于 `inject` 和 inbox 认领语义的说法，部分来自原型代码里的注释。

## Next（按优先级，每条可独立执行）
1. 请用户确认主检出目录里那份 r4 未提交改动是谁留下的，按 `.claude/rules/handoff.md` §1.5 和 §5 处理。确认之前，不要以那份改动为准引用 r4。
2. 请用户对总览 §4 表里「M0 / M1 开工前要定的」6 个问题拍板：Q-SA8、Q-SA5、Q-SA6、Q-SP2、Q-SP4、Q-SP6。定下来以后，按 r4 的决策传播流程并入（附录 G 记一批）。
3. 如果用户同意 Q-SA8 的推荐：在 `src/store/journal.ts` 的 `parseLine` 里，对不认识的 kind 单独报一个原因（例如 `journal-newer`），和 `journal-chain` 分开。补一条测试：旧版读到带新 kind 的 journal 时，拒绝启动，退出原因可以区分。预期结果是现有测试仍然全绿。
4. 用户同意 push 后，执行 `git push -u origin claude/zen-superagent-exploration-04992d`。

## Do not touch
- 主检出目录里那份未提交的 r4 改动：不是本会话留下的，由用户决定怎么处理。

## Open questions
- 主检出目录里的 r4 改动是用户自己留下的吗？
- 总览 §4 列出的 14 个问题（Q-SA4–Q-SA10、Q-SP1–Q-SP7）。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-01 AdamPlatin123：会话开始时，SessionStart hook 报的是 main 检出目录的状态（branch main、1 个未提交文件、TAKEOVER CHECK）。本 worktree 自己是干净的，HEAD 也一致。处理：只读 worktree，没有改动主检出目录，已告知用户，在等用户确认。
