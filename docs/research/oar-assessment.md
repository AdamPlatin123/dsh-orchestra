# botiverse/oar（Open Agent Runtime）评估（2026-10-28）

由一个 Opus 研究代理对 `botiverse/oar` main@8f12790、npm `@botiverse/oar` 0.75.0 做只读评估（浅克隆、`gh api`、`npm view`；没有安装或运行任何东西），编排器整理。结论先行：**只借设计，不采用为 Orchestra 的 `drivers/` 层**。

## 它是什么

- Botiverse, Inc. 的 Apache-2.0 TypeScript 库，用一个 `Session` API 覆盖 11 个编程代理运行时：Claude Code、Codex、Cursor、Grok Build、Kimi Code、OpenCode、Pi / Pi Durable、Qwen Code、Qoder、Antigravity。Botiverse 自家产品 Raft（源码可见，FSL-1.1-ALv2）建在它上面。
- 驱动方式：Claude 走 `claude -p` stream-json CLI（不是 Agent SDK）；Codex 走 `codex app-server` v2，每个 Session 一个进程；Grok / Kimi / OpenCode / Antigravity 走 ACP；Pi 与 Cursor 在宿主进程内走 SDK。不 vendor 二进制，只找 PATH 上已装的 CLI。
- Antumi（`flyhero/antumi`）不是 Botiverse 的产品，也不用 OAR；它是与 Orchestra 很接近的对照物（额度视图、人工审批、经 `dsh --profile antumi` 驱动 DSH），值得另看一眼（未深读）。

## 做得好的地方（值得借）

- 选项拒绝契约：运行时不支持的选项在打开前被拒绝，绝不静默丢弃。
- 事件逐条带 `seq` 与 `agentPath`（子代理路径），跨进程 `resume`，`steer` / `queue` / `withdraw` / `abort` 都返回类型化的接受或拒绝码。
- `accountUsage()`：Claude 的 5 小时与 7 天窗口（含 `seven_day_opus` 等细分）、Codex 的 primary / secondary 窗口，各带 `usedRatio`、`resetsAt`、`id`、`durationMs`；另有 `installation`、`authStatus`、`login` / `logout`（只转发 URL 或设备码，不碰 token）、`listModels`（含 effort 档）、`checkUpdate`。
- 失败分类表（`rate_limit_event` → `quota` 带 `resetsAt`）、Claude 环境变量脱敏、进程树回收细节。
- 零 token CI 模式：真实 CLI 对着脚本化的模型提供方（`@copilotkit/aimock`，经 `ANTHROPIC_BASE_URL` / Codex `model_provider`）跑，加 110 个回放 fixture；`openVoyage` JSONL 录制；`@botiverse/oar/testing` 的脚本化运行时。
- 测试投入很大（约 283 个单元测试文件、CI 覆盖 Windows），文档是目前公开的最好的 Codex app-server / Claude stream-json 细节证据库之一。

## 为什么不能直接采用

1. **审批模型与 D8 直接冲突。** 它声明「Sessions run YOLO by default」：Claude 硬编码 `--dangerously-skip-permissions`，Codex 发 `approvalPolicy: "never"` 且默认 `danger-full-access` 沙箱，ACP 客户端一律选 `allow_always`，Grok 加 `--always-approve`，Antigravity 每次打开都 `set_mode yolo`。没有宿主回答审批的 API（`Session.answer` 被明确推迟）；开放中的 PR #513 只加「本地直接拒绝」的 Claude 模式，resume 时漏传模式就退回 bypass。最安全的配置也只是「只拒不问」，无法把审批送进 Orchestra 的人工队列。
2. **API 变动极快。** 9 周 133 个 npm 版本（0.0.1 → 0.75.0），最近 26 条 release note 里 12 条含 breaking / removed / renamed；Node ≥24、ESM-only；`undici` 与 `@cursor/sdk` 精确钉版。
3. **Windows 进程归属。** 它自己 spawn，用 `taskkill /T` 杀树，没有 Job Object，没有 spawn 钩子可接 procguard；`resources()` 在 Windows 返回 null；Codex `workspace-write` 在没有 Codex Windows 沙箱时静默退成 `read-only`。
4. **凭据与配置副作用。** #402：短生命周期的 Claude 探针（`accountUsage` 这类）可能让过期 token 刷新失败并清空凭据存储，把本机所有 claude 登出；#343：打开 Codex 会话会把仓库永久写成 trusted；#344：没有会话级 Codex API key。
5. **治理。** 727 次提交里一个人（xxchan）占 381 次，10 月的提交大多由 AI 代理共同署名；优先级由 Raft 与 DSH 的需求决定。传输选择也与 r4 不同：r4 选 Agent SDK 进程内（含进程内 MCP），OAR 选 CLI；r4 按配置指纹复用 Codex hub，OAR 每会话一个 app-server。

## 与 DSH 的关系（要注意的一点）

- OAR 没有 DSH 运行时；写一个 ACP 适配器估计 300–500 行（推断），但 `shared/acp` 内核不对外导出、且自带 `allow_always`，要么提 PR 要么 fork。
- 反过来，**DeepSeek Harness 已经内嵌并打补丁使用 OAR**：`packages/experimental/subagent-oar` 与 `tool-subagent-oar`，自带 `LICENSE-OAR`；其 README 写明「不把原生审批请求转发到 DSH 的交互 UI」「不对这些进程应用 DSH 的子进程沙箱与后代清理」。PR #513 正是从 DSH 的补丁来的。
- 对 Orchestra 的含义：私有 DSH home 的组合要排除或钉住 `subagent-oar` / `tool-subagent-oar`，否则 Claude / Codex 子进程会绕过 Orchestra 的审批队列与 Job 树（推断；建议加进 r4 §7.4 的私有 home 表）。

## 建议

- **(b) 借设计、不采用。** 可直接搬的：选项拒绝契约；`agentPath` 与（`agentPath`, id）复合键；失败分类表与额度窗口 id / 时长（直接服务于愿望预算的水位线）；Claude env 脱敏；进程树回收细节；aimock + 回放的零 token CI。把它的 `docs/runtimes/claude.md`、`codex.md`、`docs/spec/runtime-matrix.md` 当作持续更新的证据库，跟踪 #513（审批 API）、#402、#343。
- 窄用法：只读调用 `accountUsage` / `listModels`，放在 procguard 包裹的辅助进程里、精确钉版；前提是先解决 #402 的登出风险（例如 `CLAUDE_CODE_OAUTH_TOKEN` 路径，未核实）。
- 不建议 (a) 作为驱动层采用（需要永久维护一个去 YOLO、加审批 API、接 procguard、加 DSH 的分叉，对着几乎每天的 breaking 发布 rebase），也不建议 (c) 忽略。

## 未核实

- PR #513 最终形态与审批 API 的时间；`accountUsage` 在 Windows 真实订阅上的行为；`CLAUDE_CODE_OAUTH_TOKEN` 是否能避开 #402；DSH ACP 适配器的估算；Antumi 的内部架构；10 月共同署名的统计只是 trailer 计数；Pi SDK 与传递依赖的许可证未审。

克隆位置（只读，可删）：`C:\Users\Calx\AppData\Local\Temp\claude\G---Projects-dsh-orchestra\9a172ed9-e9ae-47dd-b3c0-dc5700f0828c\scratchpad\oar\src\oar`。
