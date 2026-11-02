# Orchestra 应用：从 alpha 到整体可用（2026-11-02）

用户目标（原话）：「不受限制，不要问，参考架构，自由创作到应用整体可用阶段，API允许自由使用magpie的Zcode和OpenCodego，codex也一等公民，使用codex API」。

分支 `claude/orchestra-app`，从 `claude/alpha-0.2-interactive` 的 76807ec 切出。alpha-0.2 会话的未提交工作（Claude host、POST 底座）交回后合并进来。

## 依据

- 现行规格 r4：`docs/specs/2026-10-27-dsh-orchestra-design-r4.md`（主检出目录版本，含用户未提交的第七批，只读）。
- 面板调研和决定：塔表方案。报告在`docs/research/2026-11-02-tower-panel.md`，要点抄在下面「界面」一节。
- 0.2 设计稿：`docs/plans/2026-11-02-alpha-0.2-slice-design.md`。

## 已实测（2026-11-02，本机）

| 通路 | 结果 |
|---|---|
| magpie `http://127.0.0.1:3425` | 不要密钥。`/v1/models` 列出 `zcode/*`、`opencode-go/*`、`codex/*` 等 44 个模型；`/v1/responses`、`/v1/messages`、`/v1/chat/completions` 都通 |
| Codex CLI 0.165.0 经 magpie | 私有 `CODEX_HOME` 里写 `model_provider = magpie`（`base_url = http://127.0.0.1:3425/v1`，`wire_api = responses`），`codex exec` 用 `codex/gpt-6.1-sol` 跑通；会话落在 `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Codex app-server 协议 | `codex app-server generate-json-schema` 可本地生成 JSON Schema（v2），有命令审批、文件改动审批的服务端请求 |
| Claude CLI 经 magpie | 私有 `CLAUDE_CONFIG_DIR` + `ANTHROPIC_BASE_URL=http://127.0.0.1:3425` + 占位 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_MODEL=zcode/GLM-5.3`，`claude -p` 跑通（CLI 报 unrecognized_model 警告，不影响） |
| 真实数据 | Claude 60 个会话进快照（13 个活着）；subagent 111/111 挂得到上级，109/111 状态未知，最深 1 层；DSH 磁盘上 92 个会话被 60 个名额挤掉却显示 empty（bug）；Codex 会话是 `~/.codex/sessions/**/rollout-*.jsonl.zst`（zstd，Node 24 有 `zlib.zstdDecompressSync`）和 `archived_sessions/` |

## 架构

一个守护进程 orchestrad（r4 D3：只有一个守护进程，UI 只在 `orchestra.localhost`）。零 npm 依赖照旧；前端仍是原生 ES 模块，不引入 React（报告里的 React 建议不采纳：要下载、要构建步骤，现有 DOM 补丁和 CSP 测试够用）。

### 1. 观察（只读，三家同等）
- Claude：沿用 `src/sources/peek.ts`、`stage.ts`。
- DSH：沿用；修来源计数（按截取前总数计，名额按 harness 分配）。
- **Codex（新）**：读 `CODEX_HOME`（默认 `~/.codex`）下 `sessions/**/rollout-*.jsonl[.zst]` 和 `archived_sessions/`。从 `session_meta` 取 id、cwd、时间；从事件取最近活动、在等审批、子代理（如有）。只读、有上限、经读闸。
- 输出新契约 **TowerSnapshot**（`shared/tower-contract.js`）：三层（你/路由 → agent → subagent），每个节点带 `harness`、`ownership`（owned/observed/foreign）、`state` + `basis`（registry/推测/未知）、`waiting`（来源：orchestra 队列 / 原生 / 推测）、子树计数 `{children, errors, waiting}`、聚合组（已回报 ×N、同类 ×N）、裁剪计数。校验器 + 金样本，计数等于列表长度（T3）。

### 2. 自有会话（驱动）
- **Codex（app-server）**：orchestrad 经 spawn 闸起 `codex app-server`（stdio JSON-RPC），私有 `CODEX_HOME = ORCHESTRA_HOME\codex-home`，配置写 magpie provider；`approval_policy = on-request`，`sandbox_mode = workspace-write`。命令/文件审批的服务端请求进 Orchestra 审批队列，人决定后回复；超时即拒（D8）。
- **Codex app-server 实测（2026-11-02，codex-cli 0.165.0，经 magpie）**：stdio 上一行一个 JSON-RPC 对象。
  - 顺序：`initialize {clientInfo}` → 通知 `initialized` → `thread/start {cwd, model, approvalPolicy, sandbox}`（结果里 `thread.id`）→ `turn/start {threadId, input:[{type:'text', text}]}`。
  - 服务端请求 `item/commandExecution/requestApproval`，参数有 threadId、turnId、itemId、command、cwd、commandActions、availableDecisions 等。回 `{decision:'decline'}`，这一项以 declined 结束；回 `{decision:'accept'}`，命令执行并拿到输出。
  - 只回 accept / decline，**不发** acceptForSession、acceptWithExecpolicyAmendment：不留持久规则，合 D8（审批只能由人做，超时即拒）的本意。
  - 其他服务端请求：`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`（向人提问）、`mcpServer/elicitation/request`。
  - 通知：turn/started、turn/completed、item/started、item/completed、item/agentMessage/delta、item/commandExecution/outputDelta、serverRequest/resolved、thread/tokenUsage/updated。客户端还可用 turn/steer、turn/interrupt、thread/resume、thread/fork。
  - npm 装的 `codex` 只是个壳。spawn 闸要钉真实 exe：`%APPDATA%\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`，argv 固定为 `app-server`。
  - `CODEX_HOME` 放在 %TEMP% 下时，Codex 会警告不建辅助程序，不影响运行。
- **cwd（自有会话）**：测试 profile 用测试目录下的 `work\`。真实 profile 用 orchestrad 自己建的 `ORCHESTRA_HOME\work\<会话>`，只对这一个根放开 AppData 拒绝表。登记项目根留到路由阶段做。
- **POST 底座**：0.2 会话已经写好检查链、解锁码、操控令牌和 actionId 去重（`src/server/owned.ts`），但还没提交。第 3 阶段先把这份快照搬进本分支，日后合并 0.2 分支时以那时的版本为准。
- **Claude**：用 0.2 会话的 host 子进程（SDK，路线 B）；SDK 从 sdk-probe 已装的 node_modules 复制，不下载。环境：私有 `CLAUDE_CONFIG_DIR`，`ANTHROPIC_BASE_URL` 指 magpie，模型默认 `zcode/GLM-5.3`。0.2 的 host 交回前，先做 Codex。
- 模型白名单：只许 magpie 上的 `zcode/*`、`opencode-go/*`、`codex/*`。
- cwd：测试 profile 下只在测试目录 `work\`；真实 profile 下允许用户在设置里登记的项目根（过 cwd 拒绝表），派活时在确认框里写明。

### 3. 路由（superagent 层）
- 「派活台」：人输入一句话 → 先跑确定性规则（D9：确定性规则先、LLM 后），再请 magpie 上的路由模型（默认 `zcode/GLM-5.3`，chat completions，只要 JSON）给出建议：harness、模型、cwd、标题、理由。
- 建议只是「Route to?」卡片：人点「派出」才起会话；从不自动派（r4 Route to?：拿不准时出卡请你选，绝不默认派活）。每次派活写一条 RouteDecision（候选、理由、模式=manual）。
- 路由模型拿不到时退回纯规则，卡片照出。

### 4. 审批（D8）
- 一个队列，超时 30 分钟即拒；批准只收配对页面的 POST（cookie + 操控令牌 + Origin）。
- 小审批栏可直接「允许」：参数完整可见才给；shell、网络、受保护路径、cwd 外写入要按住；列表变化 750 ms 内无效；绑定参数摘要；不批量。通知和 DSH 镜像不放「允许」。

### 5. 界面：塔表
- 首页 `/`：顶栏（计数即筛选、刹车）、「等你」钉栏（按剩余时间）、跨项目树表（你 → agent → subagent，同一行格式，缩进表层级，子树小框 `子·错·等`）、右栏详情、底部「发给 → X」输入框和停止键。
- agent 页 `/agent/<id>`：左这一枝、中对话、右选中的 subagent。
- 「关于数据」页：诚实声明、未测规则、源健康。
- 配色「航图」：一色一义（黄=等你，朱=出错，青=在跑），亮暗两套；系统黑体 + 等宽数字；行高 30px（手机 44px）。
- 375px 可用：钉栏 + 树，点行进全屏节点页。

### 6. 装进 DSH（后做）
独立只读 DSH 插件：左栏图标 + 主区只读塔表，数据经插件宿主用只读 token 取；所有人类动作深链回 orchestrad。

## 阶段

1. 观察：Codex 来源、DSH 计数修复、TowerSnapshot 契约、`/api/tower`。
2. 塔表 UI（只读）替换首页和 `/stage`。
3. 合并 0.2；Codex 自有会话（app-server）+ 审批队列 + POST 端点；agent 页对话、审批、停止。
4. Claude 自有会话（0.2 host）接上同一套。
5. 路由派活台（规则 + magpie 模型 + Route to? 卡）。
6. 端到端：真实数据 + magpie 实跑一遍；交接。
7. DSH 只读插件（有余力再做）。
