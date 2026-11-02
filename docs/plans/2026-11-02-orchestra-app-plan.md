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
| Codex skills 隔离（联调后） | 私有 `CODEX_HOME` 下仍列出 `~/.agents/skills`；`[skills] include_instructions = false` 后 rollout 里不再有用户目录下的 `.agents` 路径，也没有 `skills_instructions`（`codex exec` 和 app-server 两条路都测了） |
| Codex 在 Windows 上的沙箱 | `workspace-write` 被降为 `readOnly`；`[windows] sandbox = "unelevated"` 时命令挂住；`elevated` 需要管理员装 setup 程序。保持只读，每次写和跑都问人 |
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
- 小审批栏可直接「允许」：参数完整可见才给；shell、网络、cwd 外写入要按住，或点一下后输入确认词「放行」（r4 §10.9 的「键入确认」，给读屏浏览模式和手机用）；列表变化 750 ms 内无效；绑定参数摘要；不批量。通知和 DSH 镜像不放「允许」。
- 受保护路径直接拒，不弹卡（2026-11-02 阶段 2 复核后改）：审批里出现的文件路径、写入根目录、命令 cwd，先按工作目录解析成绝对路径，再按最近的已存在上级做 realpath（会跟随目录联接），用 spawn 闸同一张 cwd 拒绝表判断（数据目录、各 harness 根、~/.claude、~/.dsh、AppData、仓库……）。命中就自动回 decline，feed 记 auto-denied / protected。只在工作目录外、没命中拒绝表的，仍是高风险卡片要按住或键入。

### 分歧和残余风险（2026-11-02 阶段 2 复核后记）
- **0.2 设计第 134 行 vs 本计划 §4（旧版）**：0.2 设计要求受保护路径直接拒；本计划旧版只写「要按住」，代码曾按较松的一边做。现已改成直接拒，以 0.2 设计为准。
- **0.2 设计第 528 行「真实 profile 下 owned-disabled」**：被本计划 §2（真实 profile 用 `ORCHESTRA_HOME\work\<会话>`）取代。现在两种 profile 下都是「带 --owned 启动并找到 codex.exe 才开」。若要恢复 0.2 的限制，在 `setUpOwnedCodex` 开头对真实 profile 返回 off('not-asked')，由用户定。
- **进程树没有 Job 回收（D4 残余）**：结束、出错、进程退出时只杀 codex.exe 本身，它跑的命令启动的子进程可能残留。feed 里会写一条 children-may-remain，页面显示「只结束了 codex 本身：它跑的命令启动的子进程可能还在」。长期做法：procguard 提供 run-in-job 后，codex-app-server 规则改经 Job 启动。0.2 设计第 8 节第 3 条原本只记了 Claude host，这里把 codex 补上。
- **页面体积上限放宽（2026-11-02，真实 codex 联调后）**：用户先前定的上限是 `ui/` 目录 120 KiB、页面加载总量 168 KiB；联调前 `ui/` 只剩约 31 字节余量，读屏播报和自动滚动（第 29 条）因此没做。用户现在的目标是做到整体可用，后面还要加派活台等界面，所以放宽到 `ui/` 200 KiB、页面总量 240 KiB（`test/ui/tower-page.test.ts` 里的断言同步改了）。仍是零依赖、无构建，页面本身没有引入新库。
- **自有 Codex 会话读用户全局 skills（已修，有残余）**：私有 `CODEX_HOME` 挡不住 skills。codex-cli 0.165.0 按 USERPROFILE 找 `~/.agents/skills`，把清单和路径写进模型的指令；联调时模型请求运行 `Get-Content <用户目录>/.agents/skills/.../SKILL.md`。现在 `config.toml` 写 `[skills] include_instructions = false`（清单和根目录都不进提示词；实测在消息里点名 `$技能名` 也不注入）和 `[skills.bundled] enabled = false`（不往私有目录解包自带 skills）。实测 `[[skills.config]]` 按根目录禁用、`skip_host_skill_discovery` 特性都去不掉那个根。残余：codex 进程自己是否仍扫描该目录（读 SKILL.md 的开头元数据）**未知**，模型看不到。没有改子进程的 USERPROFILE（会影响 codex 跑的每条命令的 `~`、PowerShell 配置等，副作用面太大）。另外命令审批卡上，codex 报告的读取/列目录/搜索路径在工作目录外时，会单独列一行「outside the work dir: …」。
- **Windows 沙箱只能只读（保持现状）**：`sandbox_mode = "workspace-write"` 在 Windows 上不生效，`thread/start` 回 `readOnly`，codex 说「The filesystem sandbox is read-only」，于是每次写文件、跑命令都来申请审批。要写入型沙箱，需要 `[windows] sandbox = "elevated"`（要 `codex-windows-sandbox-setup.exe` 以管理员身份建沙箱用户）或 `"unelevated"`。npm 装的 codex 只带 `codex.exe` 和 `codex-code-mode-host.exe`，没有 setup 和 `codex-command-runner.exe`；实测 `"unelevated"` 下 codex 声称 workspace-write，但第一条命令挂住不返回（150 秒超时）。需要提权或额外安装，所以不开，每次都问人（更安全）。派活对话框写明「Codex 在 Windows 上的沙箱只能只读：它每次写文件、跑命令，都会先来问你」。
- **对话流顺序（已修）**：codex 先发 `item/started`（命令开始），再发审批请求，所以「命令 · … · 被拒绝」曾排在它的「等你审批」卡片前面。现在审批打开期间先把那条命令从 feed 里撤下，回答后（或自动拒绝、codex 自己撤回审批后）再以新的 seq 重发；页面收到同一条命令的第二次通告，就把那一行挪到后面。feed 读起来是：等你审批 → 你的回答 → 命令和结果。
- **Claude 自有会话（阶段 4，2026-11-02 接上）**：0.2 的 host 经 spawn 闸新规则 `claude-host` 起（node.exe 用仓库 `.tools\node24\node.exe`，worktree 里没有就用主检出目录的；argv 只有 host.mjs 的绝对路径）。和 0.2 设计不同或补上的几处：
  - 模型：0.2 设计（r4 §7.2 的 haiku-only）只许 `opencode-go/claude-haiku-5-5`；按用户目标放宽到 `zcode/*`、`opencode-go/*`，默认 `zcode/GLM-5.3`。`codex/*` 走 Responses API，Claude 不收。host 从 start 帧起仍是精确守卫：init、每条回复、`modelUsage` 只认这个模型和 `ANTHROPIC_SMALL_FAST_MODEL`（`zcode/GLM-5-Turbo`）。
  - 网关：不加 0.2 设计的 `--claude-gateway`；和 Codex 一样，带 `--owned` 就用 magpie（`ANTHROPIC_BASE_URL=http://127.0.0.1:3425`，闸只认回环地址；`ANTHROPIC_AUTH_TOKEN` 是固定占位串）。
  - 配置目录：host 进程自己的 `CLAUDE_CONFIG_DIR` 是 `ORCHESTRA_HOME\claude-home`（兜底）；每个会话实际用 `ORCHESTRA_HOME\claude\<ownedId>`（0.2 设计 §3.1），由 start 帧给。
  - claude.exe：用 SDK 自带的 `@anthropic-ai/claude-agent-sdk-win32-x64\claude.exe`（2.1.287，跟 SDK 版本走），不用用户自己会自动更新的 claude.exe。它约 240 MB，不算哈希，只查存在且没有链接；host.mjs、host-core.mjs、sdk.mjs 三个文件的 sha256 钉在 `src/owned/claude-pins.ts`（`scripts/pin-claude-host.ts` 生成），启动时查一次，spawn 前闸再查一次。
  - 受保护根：host 原来把 `~/.orchestra` 整个拒掉，真实 profile 下工作目录就在里面。改成和 cwd 拒绝表一样的「工作根豁免」：会话自己的 `<受保护根>\work\<id>` 放开，根的其他部分（别的会话、登记、库）仍拒。
  - 对话流里没有工具结果：host 协议只报工具名，不报输出（0.2 设计如此）。
  - 结束顺序：close 帧 → 3 s 后关 stdin → 2 s 后才杀 host；杀了的话 feed 写「claude.exe 可能还在」（D4 残余，同 Codex）。
- **派活台（阶段 5，2026-11-02 接上）**：和 r4 不同或简化的几处：
  - r4 D9 和 §9.2 要分叉 adaptive-router 的 `router-core`（硬过滤、Wilson 证据门、滞回），这里没做：只有五条确定性规则（点名模型、点名 harness/「不要用 X」、改代码跑命令、短问答、默认），之后问一次 magpie 上的路由模型（`zcode/GLM-5.3`，chat completions，JSON 模式，20 秒）。只有规则把 harness 和模型都定了时才不问模型（D9「只有模糊时才用 LLM」的最小版）。证据门、影子模式留到 M4。
  - 候选只列能用的 harness（关着的不列，卡片写明哪个不可用），没有 r4 §9.2 第 5 步的类型化拒绝码。
  - RouteDecision（journal 的 `route` 记录）没有 `input`（那句话）、`confidence`、`overriddenBy`：journal 不收自由文本（records.ts 的规则），那句话已作为会话第一条消息进了会话自己的对话流；置信度这一版不知道（T1：不写成 0）。有 `pick`（人选了第几个候选，手动改了就是 null）和 `reason`（理由 chip：规则 id、router-model、manual）。只有 mode=manual。
  - 派出时只认「同一句话」的建议：建议后改过句子，派出不带 routeId，不写 RouteDecision。建议只在内存里存 30 分钟、最多 64 条；重启后作废。
  - 联网：守护进程唯一的出站调用在 `src/net/magpie.ts`，只许 POST 到 http://127.0.0.1（组合根常量 `MAGPIE_CHAT_URL`）；builtin 表只给它 `node:http` 的 `request`，扫描规则 `net:magpie-post-loopback-only` 钉住 host 和方法。
- **自有会话跨重启**：每个会话一份 `ORCHESTRA_HOME\owned\<ownedId>.json`（0.2 设计 §2.4）。重启后没结束的会话显示「状态未知」、endReason daemon-restart，不续跑、不重发；对话内容只在旧进程内存里，重启后看不到。

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
