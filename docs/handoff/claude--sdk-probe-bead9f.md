# Handoff: claude/sdk-probe-bead9f

## Facts
- Owner: AdamPlatin123
- When: 2026-11-01 21:50 UTC
- Machine: 550W备份1号机
- Branch: claude/sdk-probe-bead9f（从 claude/m0-thin-slice-e9066d 的 3b34a53 切出）
- Commit: 3b34a53（本文件和探针代码在它之后的同一个提交里）
- Pushed: no（push 前要问用户）
- Uncommitted on that machine: none。主检出目录里 r4「第七批」的未提交改动不在这条分支上，见 `docs/handoff/main.md`

## Goal
探针（spike）：在 M1（M1：Orchestra 自己拉起会话、收发消息）正式写 `drivers/` 之前，用 Claude Agent SDK 从 Orchestra 这边拉起一次 Claude 会话，发消息、收事件，再用最薄通路的只读读取器 `src/sources/peek.ts` 把 transcript 读回 peek 页。代码只在 `spikes/claude-sdk/`，不进 `src/`。

## Done（已完成且已验证）
- `spikes/claude-sdk/`：`probe.mjs`、`summarize.mjs`、`peek-check.mjs`、`REPORT.md`；SDK 钉在 0.3.287（r4 §7.2 钉的版本，npm 上有），lockfile 已提交，`node_modules` 被忽略。验证：`npm ci --ignore-scripts` 用的就是这份 lockfile；`git status` 里没有 `node_modules`。
- SDK 在本机以普通权限拉起会话，`system/init` 在 1.6–2.9 s 到达，`capabilities` 里有 `msg_lifecycle_v1`（CLI 2.1.310）。验证：`live.json` 与 `init.json` 的 init 帧，见 REPORT §1。
- `CLAUDE_CODE_DISABLE_WORKFLOWS=1` 去掉了 `Workflow` 工具和 `deep-research`、`workflow-authoring` 技能。验证：`probe.mjs --phase init` 两种设置对照，见 REPORT §1 第 3a 行。
- 注册表 `sessions/<pid>.json`：`entrypoint` = `sdk-ts`；约 1 s 内出现；1 s 轮询看得到 2–3 s 回合的 busy → idle。验证：`live.json` 的 registry 样本。
- peek 读取器不改就能读出 SDK 会话：91 行 transcript 在会话页上是 91 行。验证：`peek-check.mjs`，测试 profile 的 orchestrad，`peek-check.json`。
- 全量测试：958 条，955 过、0 失败、1 跳过、2 todo，和起点相同。验证：`.tools/node24/node.exe --test "test/**/*.test.ts"`。

## Unverified（做了但没验证，或验证没过）
- **没有一次真实的模型回合。** 子进程鉴权失败：继承的 `CLAUDE_CONFIG_DIR`（本会话的账号目录）里存的 OAuth 已过期且刷新失败；桌面应用里的 CLI 由宿主代为续期，单独拉起的子进程没有。另外 CLI 不读 Windows 系统代理，要显式传 `HTTPS_PROXY`，否则 API 回 403。所以下面这些都是「未测」：`streamInput` 的 `next`（插话）和 `later`（排队）、`interrupt()` 停下在跑的回合、`canUseTool` 被调用和拒绝后的表现、注册表的 `waiting`、tool_use 在流和磁盘上的对照、effort 是否被 API 采用、`/goal` 能否执行。
- 子代理复核的结果见 REPORT 末尾「复核」一节；若该节不存在，说明复核还没并进去。

## Next（按优先级，每条可独立执行）
1. 请用户定鉴权方式（REPORT §5 的 A / B / C）。选 A：用户本人在一个新的配置目录里登录一次（`$env:CLAUDE_CONFIG_DIR='<目录>'; claude`，然后 `/login`），之后跑 `node spikes/claude-sdk/probe.mjs --phase live --proxy http://127.0.0.1:10809 --config-dir <目录> --out <草稿区>`。预期：`summarize.mjs` 显示 assistant 的 `model` 是 claude-haiku-*、`result.total_cost_usd` > 0 且 ≤ 0.15、`canUseTool` 至少 1 次、注册表出现 `waiting`。然后补 REPORT §1 的 2b、2c、3b、4c 和 §2、§3。
2. 真实回合跑通后再跑一次 `peek-check.mjs`，看 tool_use / tool_result 行在 peek 页上是不是有内容。
3. 把 REPORT §4 的五条发现交给 M1 规划：每回合断言 `system/init.tools`；`settingSources: []` 挡不住插件和技能；子进程环境白名单；登录状态不能看 `account`；显式代理。是否改 r4 由用户定，本分支不改 r4。

## Do not touch
- 主检出目录里 r4 的未提交改动：由用户决定什么时候提交。
- `accounts/54102/config/projects/` 下探针留下的 5 个 `…-orchestra-sdk-*` 目录（REPORT §7）：删不删由用户决定。

## Open questions
- 自有 Claude 乐章用哪个配置目录、怎么登录（用户的日常目录，还是 Orchestra 专用目录）？r4 里没找到明确规定；§5.3 只规定 `~/.orchestra` 不得在任何 harness 根目录之内。
- 要不要 push 本分支。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-01 AdamPlatin123：起点交接文件 `docs/handoff/claude--m0-thin-slice-e9066d.md` 记的 Commit 是 200ea73，实际 HEAD 是 3b34a53；中间只有两个 `handoff:` 提交（ee6a91b、3b34a53），没有代码变化。处理：以 git 为准，从 3b34a53 开始。
- 2026-11-01 AdamPlatin123：会话里 Bash 默认经沙箱代理（127.0.0.1:12477），npm 和 claude 都连不上外网。处理：装包、跑探针时不经沙箱，并去掉这个代理变量；给 claude 子进程显式传系统代理 127.0.0.1:10809。
