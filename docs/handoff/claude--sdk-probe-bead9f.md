# Handoff: claude/sdk-probe-bead9f

## Facts
- Owner: AdamPlatin123
- When: 2026-11-02 07:30 UTC（模拟后端补测；初版 2026-11-01 22:20 UTC）
- Machine: 550W备份1号机
- Branch: claude/sdk-probe-bead9f（从 claude/m0-thin-slice-e9066d 的 3b34a53 切出）
- Commit: 286416d（复核后的版本；模拟后端补测在它之后、带本文件这一版的那个提交里）
- Pushed: no（push 前要问用户）
- Uncommitted on that machine: none。主检出目录里 r4「第七批」的未提交改动不在这条分支上，见 `docs/handoff/main.md`

## Goal
探针（spike）：在 M1（M1：Orchestra 自己拉起会话、收发消息）正式写 `drivers/` 之前，用 Claude Agent SDK 从 Orchestra 这边拉起一次 Claude 会话，发消息、收事件，再用最薄通路的只读读取器 `src/sources/peek.ts` 把 transcript 读回 peek 页。代码只在 `spikes/claude-sdk/`，不进 `src/`。

## Done（已完成且已验证）
- `spikes/claude-sdk/`：`probe.mjs`、`summarize.mjs`、`peek-check.mjs`、`REPORT.md`；SDK 钉在 0.3.287（r4 §7.2 钉的版本，npm 上有），lockfile 已提交，`node_modules` 被忽略。验证：`npm ci --ignore-scripts` 用的就是这份 lockfile；`git status` 里没有 `node_modules`。
- SDK 在本机以普通权限拉起会话，`system/init` 在 1.6–2.9 s 到达，`capabilities` 里有 `msg_lifecycle_v1`（CLI 2.1.310）。验证：`live.json` 与 `init.json` 的 init 帧，见 REPORT §1。
- `CLAUDE_CODE_DISABLE_WORKFLOWS=1` 去掉了 `Workflow` 工具和 `deep-research`、`workflow-authoring` 技能；`__remote-workflow`、`workflow-launch-exec` 两个命令还在。验证：零模型阶段的干净对照和 `probe.mjs --phase init` 两种设置对照，见 REPORT §1 第 3a 行。
- 注册表 `sessions/<pid>.json`：`entrypoint` = `sdk-ts`；`query()` 后 ≤1 s 出现；1 s 轮询看得到 2–3 s 回合的 busy → idle。验证：`live.json` 的 registry 样本。
- peek 读取器不改就能读出 SDK 会话：91 行 transcript 在会话页上是 91 行（各类型计数相等）。但 77 行没有内容，文件已接近 256 KiB 尾读窗口。验证：`peek-check.mjs`，测试 profile 的 orchestrad，`peek-check.json`。
- 鉴权失败不是环境白名单造成的：`--phase init --env inherit` 继承完整环境（只去掉桌面宿主的消息管道、会话 id 和沙箱代理），仍是 `authentication_failed`，$0。
- 独立子代理复核过初稿，15 条意见全部接受并改进 REPORT，见 REPORT「复核」一节。
- 模拟后端补测（用户 2026-11-02 要求「使用 opencode go mock 一下」）：`probe.mjs --gateway http://127.0.0.1:3425 --model opencode-go/claude-haiku-5-5`，经本机 magpie 网关，配置目录用草稿区里一次性的目录。两次运行结果一致：插话（`next`）和排队（`later`）都不插进正在跑的纯文本回合；`interrupt()` 停下回合，生命周期帧报 `cancelled`；`canUseTool` 被调用，拒绝后会话继续；注册表出现 `waiting`；带 uuid 的消息有 `command_lifecycle` 帧（`queued → started → completed`）；peek 页上 user / assistant 行都有内容。验证：草稿区 `evidence-mock*/live.json`、`peek-check.json`，见 REPORT §9。
- 全量测试：958 条，955 过、0 失败、1 跳过、2 todo，和起点相同。验证：`.tools/node24/node.exe --test "test/**/*.test.ts"`。

## Unverified（做了但没验证，或验证没过）
- REPORT §9（模拟后端补测）没有交给独立复核。它只说明 CLI / SDK 一侧的行为，不说明 Anthropic API 本身，也不说明 Q8 的登录路径。`next` 会不会在两次工具调用之间插进回合、多条排队时的先后，都没测。
- 全量测试在补测后没有重跑：补测只改了 `spikes/claude-sdk/` 和文档。
- **没有一次走用户 Claude 登录的模型回合。** 子进程鉴权失败：继承的 `CLAUDE_CONFIG_DIR`（本会话的账号目录）里存的 OAuth 已过期且刷新失败；桌面应用里的 CLI 由宿主代为续期，单独拉起的子进程没有。另外 CLI 不读 Windows 系统代理，要显式传 `HTTPS_PROXY`，否则 API 回 403。走真实登录时，effort 是否被 API 采用、`/goal` 能否执行仍是「未测」；插话、排队、中断、审批、`waiting` 只在模拟后端上测过。
- `initializationResult().account` 在登录失效时是否照样返回：零模型阶段早于第一次刷新失败，要重测。

## Next（按优先级，每条可独立执行）
1. 请用户定鉴权方式（REPORT §5 的 A / B / C / D）。r4 的 Q8 已定「自有 Claude 会话沿用你的 `CLAUDE_CONFIG_DIR`、复用你的登录」，但本机的配置根由桌面应用托管、存的登录已过期，照 Q8 现在跑不通。A 照 Q8：用户本人在普通终端里对该配置根重新 `/login`；B 偏离 Q8，单开一个配置目录登录（要重开 Q8）。用户登录后跑 `node spikes/claude-sdk/probe.mjs --phase live --proxy http://127.0.0.1:10809 --config-dir <目录> --out <草稿区>`。预期：`summarize.mjs` 显示 assistant 的 `model` 是 claude-haiku-*、`result.total_cost_usd` > 0 且 ≤ 0.15、`canUseTool` 至少 1 次、注册表出现 `waiting`。然后补 REPORT §1 的 2b、2c、3b、4c 和 §2、§3。
2. 真实回合跑通后再跑一次 `peek-check.mjs`，看 tool_use / tool_result 行在 peek 页上是不是有内容。
3. 把 REPORT §9 关于 r4 §8.2 的发现交给用户定要不要改规格（本分支不改 r4）：r4 第 952 行写 Claude 的 Steer 是 `streamInput{priority:'next'}`，但在纯文本回合里它要等当前回合结束才开始，实际等于 Queue；"read" 回执 `started` 也要等到那时，`queued` 帧是立即到的。要补的测：在一个会调工具的回合里发 `next`，看它是否在两次工具调用之间插进去（改 `probe.mjs` 的 T3，用模拟后端即可）。
4. 把 REPORT §4 的五条发现交给 M1 规划：每回合断言 `system/init.tools`；`settingSources: []` 挡不住插件和技能；子进程环境白名单；登录状态不能看 `account`；显式代理。是否改 r4 由用户定，本分支不改 r4。

## Do not touch
- 主检出目录里 r4 的未提交改动：由用户决定什么时候提交。
- `accounts/54102/config/projects/` 下探针留下的 6 个 `…-orchestra-sdk-*` 目录（REPORT §7）：删不删由用户决定。

## Open questions
- Q8（已定沿用你的配置根）在「配置根由桌面应用托管」时怎么落地：单独拉起的 CLI 没有宿主续期。要不要重开 Q8，由用户定。
- 要不要 push 本分支。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-01 AdamPlatin123：起点交接文件 `docs/handoff/claude--m0-thin-slice-e9066d.md` 记的 Commit 是 200ea73，实际 HEAD 是 3b34a53；中间只有两个 `handoff:` 提交（ee6a91b、3b34a53），没有代码变化。处理：以 git 为准，从 3b34a53 开始。
- 2026-11-01 AdamPlatin123：会话里 Bash 默认经沙箱代理（127.0.0.1:12477），npm 和 claude 都连不上外网。处理：装包、跑探针时不经沙箱，并去掉这个代理变量；给 claude 子进程显式传系统代理 127.0.0.1:10809。
- 2026-11-02 AdamPlatin123：任务简报要求真实回合走 haiku、用你的登录。用户改为让探针经 magpie 网关走 opencode-go 的 `claude-haiku-5-5` 做模拟。处理：模型名仍含 haiku，守卫照常生效；配置目录换成一次性的，不写用户的配置根；REPORT §9 写明这只是模拟，不替代真实登录下的补测。
