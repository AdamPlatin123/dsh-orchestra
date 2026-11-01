# Handoff: main

## Facts
- Owner: AdamPlatin123
- When: 2026-11-01
- Machine: 550W备份1号机
- Branch: main
- Commit: a1492bf，之后快进合并了研究分支 claude/zen-superagent-exploration-04992d（只加了文档）
- Pushed: yes（origin/main）
- Uncommitted on that machine: 主检出目录里有 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 的未提交改动，是 r4「第七批」（2026-10-31：更积极的唤醒 W1–W6、并入 Super-agent 借鉴 SA-1–SA-10、R82、规则 9），用户本人写的。别的机器上没有这份改动

## Goal
回到 M0 写代码。2026-11-01 用户认同：文档走得太远（规格、研究、计划约 3 MB，超过代码和测试的总量），研究线到此收尾。下一步要尽早让 M0 碰到真实会话的数据。

## Done（已完成且已验证）
- M0 计划步骤 0–3、2b、2c、3b 已提交（见 `docs/plans/2026-10-31-m0-implementation-plan.md` 第 15 行、第 127 行）。验证：2026-11-01 用 `.tools/node24/node.exe --test "test/**/*.test.ts"` 跑全量，939 条中 924 条通过（13 条失败的原因见 Unverified）。
- 研究线收尾：`docs/research/2026-11-01-zen-superagent-spawn-overview.md` 文首写明了已收尾、停车场里有哪些问题、有两处已知待更正。

## Unverified（做了但没验证，或验证没过）
- 那 13 条失败的测试都要真正启动 orchestrad。当时的会话以管理员权限运行，orchestrad 拒绝在提权环境下启动（stderr：`refusing to run elevated`）。在普通权限的控制台里能不能全过，还没验证。

## Next（按优先级，每条可独立执行）
1. 从普通权限（非管理员）的控制台启动 Claude Code，然后跑 `.tools/node24/node.exe --test "test/**/*.test.ts"`。预期 939 条全过。不先做这一步，后面改的代码都没法完整验证。
2. 请用户决定什么时候提交 r4 第七批（主检出目录里那份未提交改动）。提交时顺手改一句：§10.2、§10.12、§13 里 SA-4 的「唤醒优先」不是取自 Super-agent 原型，是 r4 自己的设计（依据 `docs/research/2026-11-01-zen-superagent-deep-read.md` §5）。
3. 请用户定 Q-SA8（journal 和 db 格式怎么演进）。如果采纳推荐：在 `src/store/journal.ts` 的 `parseLine`（第 226 行附近）里，把不认识的 kind 单独报成 `journal-newer`，和 `journal-chain`（断链）分开；补一条测试，验证旧版读到新 kind 时拒绝启动，并且退出原因能区分。预期现有测试仍全过。
4. M0 下一步：请用户先选方向。一是照计划继续做第 4 步（HTTP、UI 鉴权、SSE，计划第 575 行起，1.95 d，线 B），二是先评估能不能提前做一条最薄的通路：读一个真实的 Claude 或 DSH 会话文件，显示在 UI 上，放到第 10 步之前（计划里第 10 步约在实现第 14 天）。
5. 本地还留着改写历史前的备份引用 `refs/backup/pre-secret-rewrite/*`，里面是带旧测试密钥的提交。用户确认不需要回退以后，用 `git update-ref -d` 删掉。不要用 `git push --mirror`。

## Do not touch
- 主检出目录里 r4 的未提交改动：由用户决定什么时候提交。

## Open questions
- 要不要把「M0 跑通前冻结 r4，只改错」和「新问题必须写明卡住哪一步代码，否则进停车场」写进 CLAUDE.md？2026-11-01 只提过建议，用户还没确认。
- 停车场里的 13 个问题：Q-SA4–Q-SA7、Q-SA9、Q-SA10、Q-SP1–Q-SP7（见总览 §4）。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-01 AdamPlatin123：main 的历史被改写过一次，为的是去掉一个被 GitHub 推送保护拦下的假测试密钥。新旧提交的对照表见 `docs/handoff/archive/claude--zen-superagent-exploration-04992d.md` 的 Divergence 一节。
