# Handoff: claude/zen-superagent-exploration-04992d

## Facts
- Owner: AdamPlatin123
- When: 2026-11-01（历史改写后更新）
- Machine: 550W备份1号机
- Branch: claude/zen-superagent-exploration-04992d（worktree，从 main@a1492bf 拉出）
- Commit: 6e96c3c（研究笔记）；本交接的更新随后单独提交
- Pushed: yes，origin/claude/zen-superagent-exploration-04992d；`main`（a1492bf）也已推到 origin/main。`claude/handoff-protocol` 没推（它和 main 指向同一个提交）
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
- 全量测试（`.tools/node24/node.exe --test "test/**/*.test.ts"`）939 条中 13 条失败，都是要真正启动 orchestrad 的测试，原因是本会话以管理员权限运行，orchestrad 拒绝在提权环境下启动（stderr：`refusing to run elevated`）。改写前的提交上失败的也正是这 13 条，所以与改写无关；但它们在普通权限的控制台里能不能过，本会话没验证。

## Next（按优先级，每条可独立执行）
1. 把本分支的笔记和用户的 r4「第七批」对一遍。主检出目录里那份 r4 未提交改动就是第七批：并入了 SA-1–SA-10，加了 W1–W6（更积极的唤醒）、R82、规则 9（沉默与唤醒），D20 放宽成「你不在时照派只读 Task」。本分支三份笔记写的时候，依据的是已提交的 r4，所以至少有两处要对：
   - r4 第七批的 §10.2、§10.12 和 §13（主检出目录工作区第 1558、1745、2522 行附近）写着 SA-4「排队时你的消息唤醒已有乐手优先于启动新乐章」，并标注出处为「Super-agent 参考」「槽数取自 Super-agent 原型」。可深读笔记 §5 核过原型：只有「多一个槽的溢出」，没有唤醒优先。所以「唤醒优先」应改标为 r4 自己的设计，不能算借鉴。改不改 r4，由用户决定。
   - 总览 §4 末尾写「Q-SA1 到 Q-SA3 仍然开着」，按第七批，Q-SA1 已定（并入），只有 Q-SA2、Q-SA3 还开着。
   完整做法：把深读笔记 §5 的 26 处更正逐条在第七批 r4 里查一遍，列出 r4 继承了哪些已被推翻的说法。只出报告，不改 r4。
2. 请用户对总览 §4 表里「M0 / M1 开工前要定的」6 个问题拍板：Q-SA8、Q-SA5、Q-SA6、Q-SP2、Q-SP4、Q-SP6。定下来以后，按 r4 的决策传播流程并入（附录 G 记一批）。
3. 如果用户同意 Q-SA8 的推荐：在 `src/store/journal.ts` 的 `parseLine` 里，对不认识的 kind 单独报一个原因（例如 `journal-newer`），和 `journal-chain` 分开。补一条测试：旧版读到带新 kind 的 journal 时，拒绝启动，退出原因可以区分。预期结果是现有测试仍然全绿（要在非管理员控制台里跑，见 Unverified 最后一条）。
4. 本地还留着改写前的备份引用 `refs/backup/pre-secret-rewrite/*`（三个分支各一份，仍含旧的假密钥提交）。用户确认不需要回退后，可以 `git update-ref -d` 删掉。这些引用不会被普通 push 带上远端，但不要用 `git push --mirror` 或推 `refs/*`。

## Do not touch
- 主检出目录里那份未提交的 r4 改动（第七批）：用户本人在另一个会话里写的，还没提交。由用户决定什么时候提交，本会话不改它。

## Open questions
- 总览 §4 列出的 14 个问题（Q-SA4–Q-SA10、Q-SP1–Q-SP7）。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-01 AdamPlatin123：会话开始时，SessionStart hook 报的是 main 检出目录的状态（branch main、1 个未提交文件、TAKEOVER CHECK）。本 worktree 自己是干净的，HEAD 也一致。处理：只读 worktree，没有改动主检出目录，已告知用户，在等用户确认。2026-11-01 用户确认：这份 r4 改动是本人留下的。Owner 不变，不需要接管。
- 2026-11-01 AdamPlatin123：第一次 push 被 GitHub 推送保护拒收。原因是 M0 第 3 步的提交 dafd29e 在 `test/store/redact.test.ts` 里写了一个形似 DeepSeek 密钥的测试值（假的）。经用户同意，改写了本地历史：从 dafd29e 起的 9 个提交按原作者、原时间重放，只做了两处改动：一是测试里把这个值改成运行时拼接（`FAKE_SK`），二是正文和提交说明里引用这 9 个提交的短哈希，换成了新哈希。新旧对照：dafd29e→e451d4c、ebde3c7→dd3d9d0、a3c8ac0→70a4e52、46f9138→7a76a26、0ac951d→fd35af0、ca59fea→f92bdc5、21d1d10→7b7c93d、4f50192→a1492bf、fae04f9→6e96c3c。`main` 和 `claude/handoff-protocol` 都移到了 a1492bf。主检出目录用的是 `git reset --keep`，r4 的未提交改动前后逐字节一致。旧引用备份在 `refs/backup/pre-secret-rewrite/*`。

- 2026-11-01 AdamPlatin123：研究线收尾，分支快进合并进 main，本文件归档。后续状态见 `docs/handoff/main.md`。
