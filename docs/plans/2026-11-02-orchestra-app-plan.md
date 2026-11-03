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
| Codex app-server 版本 | initialize 回复的 userAgent 形如 `orchestra/0.165.0 (Windows 10.0.26200; x86_64) unknown (orchestra; 0.2.0)`（客户端名在前，版本在斜杠后）；`skills/list` 在私有 CODEX_HOME 下仍列出用户目录的 skills |
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
- 建议只是「Route to?」卡片：人点「派出」才起会话；从不自动派（r4 Route to?：拿不准时出卡请你选，绝不默认派活）。每次派活写一条 RouteDecision（候选、理由、模式=manual）：带建议派出的记候选和人选了哪个；没要建议、建议过期或改过句子再派出的，也记一条（没有候选，router 记 not-asked），对应 r4 §9.5「M1 起每次派活都记一条 mode=manual 的 RouteDecision」。
- 路由模型拿不到时退回纯规则，卡片照出。

### 4. 审批（D8）
- 一个队列，超时 30 分钟即拒；批准只收配对页面的 POST（cookie + 操控令牌 + Origin）。
- 小审批栏可直接「允许」：参数完整可见才给；shell、网络、cwd 外写入要按住，或点一下后输入确认词「放行」（r4 §10.9 的「键入确认」，给读屏浏览模式和手机用）；列表变化 750 ms 内无效；绑定参数摘要；不批量。通知和 DSH 镜像不放「允许」。
- 受保护路径直接拒，不弹卡（2026-11-02 阶段 2 复核后改）：审批里出现的文件路径、写入根目录、命令 cwd，先按工作目录解析成绝对路径，再按最近的已存在上级做 realpath（会跟随目录联接），用 spawn 闸同一张 cwd 拒绝表判断（数据目录、各 harness 根、~/.claude、~/.dsh、AppData、仓库……）。命中就自动回 decline，feed 记 auto-denied / protected。只在工作目录外、没命中拒绝表的，仍是高风险卡片要按住或键入。

### 分歧和残余风险（2026-11-02 阶段 2 复核后记）
- **0.2 设计第 134 行 vs 本计划 §4（旧版）**：0.2 设计要求受保护路径直接拒；本计划旧版只写「要按住」，代码曾按较松的一边做。现已改成直接拒，以 0.2 设计为准。
- **0.2 设计第 528 行「真实 profile 下 owned-disabled」**：被本计划 §2（真实 profile 用 `ORCHESTRA_HOME\work\<会话>`）取代。现在两种 profile 下都是「带 --owned 启动并找到 codex.exe 才开」。若要恢复 0.2 的限制，在 `setUpOwnedCodex` 开头对真实 profile 返回 off('not-asked')，由用户定。
- **进程树的 Job 回收（D4，2026-11-02 接上；原为残余风险）**：D4 要求每个自有子进程宿主各自一个随关闭即杀的 Job，由 procguard 拉起。现在的做法：
  - procguard 进了产品代码：`native/procguard/ProcGuard.cs`（从 S4 spike 精简而来，只留一次性 run-in-job 和常驻的 job-info、kill-job、alive）。源码的 sha256 钉在 `src/os/procguard-pins.ts`（`scripts/pin-procguard.ts` 生成）；对不上就不编译。编译只用系统自带的 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`，经 spawn 闸的 csc 规则和它固定的参数。产物放 `ORCHESTRA_HOME\runtime\procguard\<源码 sha256>\procguard.exe`（数据目录里，不进仓库）。旧 csc 没有 /deterministic，所以产物没法钉在仓库里：编译时把它的 sha256 写在旁边的 `procguard.exe.sha256`，之后每次启动、每次经闸启动它之前都比对；对不上算被改过（procguard-tampered），自有会话整个关掉，页面和控制台写明原因；删掉那个目录再启动会重新编译。
  - 自有会话的子进程改经 procguard 启动：spawn 闸新规则 procguard-codex、procguard-claude（测试用 procguard-codex-fake），argv 固定为 `run-in-job --name <Job 名> --env-allowlist <文件> -- <内层规则的 exe 和 argv>`。内层的 exe、argv、cwd、环境都按原来的 codex-app-server、claude-host 规则判。procguard 先以挂起状态建子进程，放进 Job 后再恢复；Job 设 KILL_ON_JOB_CLOSE，不设 BREAKAWAY_OK；子进程只继承三个 std 句柄（HANDLE_LIST）；环境从零建，只按名单从 procguard 自己的环境里复制（名单 = 闸给内层规则的变量名 + libuv 自动补的 LIBUV_ADDED_ENV），所以子进程看到的环境和原来一样，文件里只有变量名、没有值。同名 Job 已存在就拒绝，不会加入别人的 Job；Job 的 DACL 只允许按名字打开来查询和结束。
  - 已覆盖：自己结束、orchestrad 停机、出错、子进程自己退出，四种结束都先走原来的停止顺序；包装进程一退出，Job 的最后一个句柄就关了，Job 里剩下的进程（codex 跑的命令、host 下的 claude.exe、Start-Process 起的进程）全部结束。子进程关闭后，常驻 procguard 再按名字查一次这个 Job，feed 记 tree-ended / tree-stopped / tree-left，查不到结果记 tree-unsure（未知）。实测见本节末「第 3 阶段复核后补记」后面的「procguard 实测」。
  - 刹车：`POST /api/owned/:id/brake`（人手动作，和其他自有会话动作一样要解锁、操控令牌、actionId 去重），常驻 procguard 立即结束整个 Job，拒掉这个会话所有待审批，会话以 braked 结束（「你踩了刹车，整棵进程树已停」）。页面停止键第三档，和「结束会话」一样要在 3 秒内点两次。
  - procguard 编不出来或常驻的起不来时：自有会话照旧（不经 Job），GET /api/owned 的 brakeWhy 写明原因，页面写「刹车不可用：…」，会话结束时 feed 仍写 children-may-remain / host-killed。
  - 仍未覆盖（残余）：① 同一用户的进程可以从包装进程里复制出 Job 的完整句柄，改掉它的限制，Job 挡不住同用户的恶意进程，只防正常的进程树泄漏。② orchestrad 被强杀时，按 S4 用例 a 的机制，包装进程在 orchestrad 的 libuv Job 里，会跟着死，它的 Job 也跟着关；但这次没有在会话还在跑时强杀 orchestrad 来实测产品代码（live-smoke 杀 orchestrad 时会话已结束），未知。③ Job 里如果有进程是用别的用户令牌启动的（例如 DSH 沙箱），打开和核对创建时间可能失败；这次只测了 codex、Claude host、cmd、ping。④ env-allowlist 文件被改只会少给变量，不会多给（procguard 只能复制它自己有的），但改了不会被发现。⑤ node.exe 本身仍只查存在、不是链接，没有哈希。
- **页面体积上限放宽（2026-11-02，真实 codex 联调后）**：用户先前定的上限是 `ui/` 目录 120 KiB、页面加载总量 168 KiB；联调前（f390437 的上一个提交）`ui/` 是 122859 字节，离上限 122880 字节只剩 21 字节，对话区的读屏播报和新消息自动滚动因此一直没做。放宽后已在 f390437 加上：对话区旁有一个 aria-live 播报区，只播新到的、不是你自己说的话；停在底部时才跟着新消息滚动。用户现在的目标是做到整体可用，后面还要加派活台等界面，所以放宽到 `ui/` 200 KiB、页面总量 240 KiB（`test/ui/tower-page.test.ts` 里的断言同步改了）。仍是零依赖、无构建，页面本身没有引入新库。
- **自有 Codex 会话读用户全局 skills（已修，有残余）**：私有 `CODEX_HOME` 挡不住 skills。codex-cli 0.165.0 按 USERPROFILE 找 `~/.agents/skills`，把清单和路径写进模型的指令；联调时模型请求运行 `Get-Content <用户目录>/.agents/skills/.../SKILL.md`。现在 `config.toml` 写 `[skills] include_instructions = false`（清单和根目录都不进提示词；实测在消息里点名 `$技能名` 也不注入）和 `[skills.bundled] enabled = false`（不往私有目录解包自带 skills）。实测 `[[skills.config]]` 按根目录禁用、`skip_host_skill_discovery` 特性都去不掉那个根。残余：codex 进程自己是否仍扫描该目录（读 SKILL.md 的开头元数据）**未知**，模型看不到。没有改子进程的 USERPROFILE（会影响 codex 跑的每条命令的 `~`、PowerShell 配置等，副作用面太大）。另外命令审批卡上，codex 报告的读取/列目录/搜索路径在工作目录外时，会单独列一行「outside the work dir: …」。
- **Windows 沙箱只能只读（保持现状）**：`sandbox_mode = "workspace-write"` 在 Windows 上不生效，`thread/start` 回 `readOnly`，codex 说「The filesystem sandbox is read-only」，于是每次写文件、跑命令都来申请审批。要写入型沙箱，需要 `[windows] sandbox = "elevated"`（要 `codex-windows-sandbox-setup.exe` 以管理员身份建沙箱用户）或 `"unelevated"`。npm 装的 codex 只带 `codex.exe` 和 `codex-code-mode-host.exe`，没有 setup 和 `codex-command-runner.exe`；实测 `"unelevated"` 下 codex 声称 workspace-write，但第一条命令挂住不返回（150 秒超时）。需要提权或额外安装，所以不开，每次都问人（更安全）。派活对话框写明「Codex 在 Windows 上的沙箱只能只读：它每次写文件、跑命令，都会先来问你」。
- **对话流顺序（已修）**：codex 先发 `item/started`（命令开始），再发审批请求，所以「命令 · … · 被拒绝」曾排在它的「等你审批」卡片前面。现在审批打开期间先把那条命令从 feed 里撤下，回答后（或自动拒绝、codex 自己撤回审批后）再以新的 seq 重发；页面收到同一条命令的第二次通告，就把那一行挪到后面。feed 读起来是：等你审批 → 你的回答 → 命令和结果。
- **Claude 自有会话（阶段 4，2026-11-02 接上）**：0.2 的 host 经 spawn 闸新规则 `claude-host` 起（node.exe 用仓库 `.tools\node24\node.exe`，worktree 里没有就用主检出目录的；argv 只有 host.mjs 的绝对路径）。和 0.2 设计不同或补上的几处：
  - 模型：0.2 设计（r4 §7.2 的 haiku-only）只许 `opencode-go/claude-haiku-5-5`；按用户目标放宽到 `zcode/*`、`opencode-go/*`，默认 `zcode/GLM-5.3`。`codex/*` 走 Responses API，Claude 不收。host 从 start 帧起仍是精确守卫：init、每条回复、`modelUsage` 只认这个模型和 `ANTHROPIC_SMALL_FAST_MODEL`（`zcode/GLM-5-Turbo`）。
  - 网关：不加 0.2 设计的 `--claude-gateway`；和 Codex 一样，带 `--owned` 就用 magpie（`ANTHROPIC_BASE_URL=http://127.0.0.1:3425`，闸只认回环地址；`ANTHROPIC_AUTH_TOKEN` 是固定占位串）。
  - 配置目录：host 进程自己的 `CLAUDE_CONFIG_DIR` 是 `ORCHESTRA_HOME\claude-home`（兜底）；每个会话实际用 `ORCHESTRA_HOME\claude\<ownedId>`（0.2 设计 §3.1），由 start 帧给。
  - claude.exe：用 SDK 自带的 `@anthropic-ai/claude-agent-sdk-win32-x64\claude.exe`（2.1.287，跟 SDK 版本走），不用用户自己会自动更新的 claude.exe。它约 240 MB，不算哈希：启动时查存在、没有链接，并记下大小、mtime 和文件 id；每次 spawn 前闸和三个钉子一起复查，变了就拒（host-tampered）。host 另查 init 帧的 `claude_code_version` 必须是 2.1.287（host-core.mjs 的 CLI_VERSION），不是就 safety-stop（cli-version）。host.mjs、host-core.mjs、sdk.mjs 三个文件的 sha256 钉在 `src/owned/claude-pins.ts`（`scripts/pin-claude-host.ts` 生成），启动时查一次，spawn 前闸再查一次。
  - 和 0.2 设计第 82 行的差别：设计写「claude.exe 变了就在页面告警」，这里更严，直接拒绝启动。node.exe（`.tools\node24\node.exe`）仍只查存在、没有链接，没有哈希，也没有大小和 mtime 的复查（残余风险）。
  - 花费：对话流里的「花费」是 SDK result 的 `total_cost_usd`，是 Claude CLI 按它自己的价目表用 token 数估的，不是 magpie 报的。走 magpie 的 zcode / opencode-go 模型不在它的价目表里，这个数不代表真实花费（真实花费未知），页面这样写明。0.2 设计「只显示 total_cost_usd，超 $1 提示」的前提（这个数是真钱）在这里不成立，「超 $1 提示」没做。
  - 受保护根：host 原来把 `~/.orchestra` 整个拒掉，真实 profile 下工作目录就在里面。改成和 cwd 拒绝表一样的「工作根豁免」：会话自己的 `<受保护根>\work\<id>` 放开，根的其他部分（别的会话、登记、库）仍拒。
  - 对话流里没有工具结果：host 协议只报工具名，不报输出（0.2 设计如此）。
  - 结束顺序：close 帧 → 3 s 后关 stdin → 2 s 后才杀 host。经 procguard 启动时杀的是包装进程，Job 一关 claude.exe 也一起结束；procguard 没开时杀了的话 feed 写「claude.exe 可能还在」（见上面「进程树的 Job 回收」）。
- **派活台（阶段 5，2026-11-02 接上）**：和 r4 不同或简化的几处：
  - r4 D9 和 §9.2 要分叉 adaptive-router 的 `router-core`（硬过滤、Wilson 证据门、滞回），这里没做：只有五条确定性规则（点名模型、点名 harness/「不要用 X」、改代码跑命令、短问答、默认），之后问一次 magpie 上的路由模型（`zcode/GLM-5.3`，chat completions，JSON 模式，20 秒）。只有规则把 harness 和模型都定了时才不问模型（D9「只有模糊时才用 LLM」的最小版）。证据门、影子模式留到 M4。
  - 候选只列能用的 harness（关着的、并发已满的都不列，卡片写明哪个不可用、是否已满），没有 r4 §9.2 第 5 步的类型化拒绝码。路由模型只能从规则留下的 harness 里选（r4 §9.2 第 9 步）：句子里说了「不要用 X」，模型还选 X，就拒掉它的答案（why 记 harness-excluded），卡片只剩规则的建议。同时在问路由模型的建议最多 2 个，再多的不问模型（busy）。
  - 路由模型起的标题在卡片上标明「路由模型起的」；只有人派给模型选的那一项时，才用它作会话名，否则会话名是那句话的第一行。
  - RouteDecision（journal 的 `route` 记录）没有 `input`（那句话）、`confidence`、`overriddenBy`：journal 不收自由文本（records.ts 的规则），那句话已作为会话第一条消息进了会话自己的对话流；置信度这一版不知道（T1：不写成 0）。有 `pick`（人选了第几个候选，手动改了就是 null）、`reason`（理由 chip：规则 id、router-model、manual）、`routerModel`（问了哪个路由模型，没问是 null）和 `routerWhy`（它的答案为什么没用上：没回、回了被拒、没问，见 router-model.ts 的 ROUTER_WHY）。只有 mode=manual。2026-11-02 第 3 阶段复核时加了 routerModel、routerWhy，routeId 改成可空：当时本机真实 profile 的数据目录里还没有任何 route 记录（最后写入是 11-01），所以没做旧记录迁移。
  - 派出时只认「同一句话」的建议：建议后改过句子，派出不带 routeId，记成一条手动的 RouteDecision（router not-asked）。建议只在内存里存 30 分钟、最多 64 条；重启后作废。塔表顶上「你」那一行显示最近一次派活（任何一次，不只带建议的）；不带 --owned 启动时派活台不开，也不读以前的记录，那一行写「没有读到派活记录」，不说「没派过」。
  - 联网：守护进程唯一的出站调用在 `src/net/magpie.ts`，只许 POST 到 http://127.0.0.1（组合根常量 `MAGPIE_CHAT_URL`）；builtin 表只给它 `node:http` 的 `request`，扫描规则 `net:magpie-post-loopback-only` 钉住 host 和方法。
- **自有会话跨重启**：每个会话一份 `ORCHESTRA_HOME\owned\<ownedId>.json`（0.2 设计 §2.4）。重启后没结束的会话显示「状态未知」、endReason daemon-restart，不续跑、不重发；对话内容只在旧进程内存里，重启后看不到。某个 harness 这次没开（SDK 不在、host 被改、找不到 codex.exe、准备失败）时，它以前的会话仍按同样规则只读列出（`src/owned/restored.ts`），不会从页面上消失。
- **第 3 阶段复核后补记（2026-11-02）**：
  - 并发上限：两家合计同时最多 3 个（0.2 设计 §2.4 的「同时最多 3 个活动的自有会话」，§4 的「同时最多 3 个，先结束一个」），之前误做成每家各 3 个。派活台把满了的 harness 当作不可用。
  - 结束原因新增三个：interrupt-unsure（你按了中断，但 Claude 还有没处理的消息，为免停不住，Orchestra 结束了它）、protocol-error（host 发来读不懂的内容，Orchestra 停了它）、daemon-stop（orchestrad 停机时结束的）。以前这三种分别记成 you-ended、exited、you-ended，和实际不符。
  - 停机：orchestrad 停机时先结束所有自有会话，再最多等 6 s 让每个 Claude host 走完停止顺序（close 帧 → 3 s 后关 stdin → 2 s 后杀），然后才关库退出；日志记下还没关掉的个数。Codex 的停止是关 stdin 后立即杀，不等。
  - Claude 的消息状态：写进 host 的 stdin 时是「已写给它的 host，还没确认收到」；host 回了这条的 lifecycle 帧或这一轮的 result 才算「已交给它」；host 在确认前就没了，记「发出了但不知道它收到没有」。
  - 会话结束后 host 还发来的审批请求：直接回拒，不建卡；host 关闭时不论会话怎么结束都清掉它名下的卡。
  - Codex 版本：codex.exe 是用户全局 npm 装的，会随 `npm i -g` 升级。现在每个会话从 initialize 回复的 userAgent 里读版本（实测格式 `orchestra/0.165.0 (Windows …) …`），不在钉死的列表（目前只有 0.165.0）里就以 policy-mismatch 结束，写明实际版本。没做「thread/start 后查 skills 列表必须为空」：实测 app-server 的 `skills/list` 在私有 CODEX_HOME 下照样列出用户目录的 skills（隔离靠的是不写进提示词，不是不列），这个断言会永远失败。
  - Codex 没来问就跑的命令：命令或文件改动跑完（completed/failed）却没有对应的审批请求时，对话流写一条「这一条它没来问你就跑了」。工作目录外的只读命令 codex 是否一定来申请审批：只实测过一次（`node scripts/live-smoke.ts --harness codex --outside`，2026-11-02，codex-cli 0.165.0，经 magpie）：让它读测试目录里、工作目录外的一个合成文件，它来申请了审批（命令卡，shell 风险），没有没问就跑的。同样的探测对 Claude 也是先来问（命令卡）。一次不代表总是如此，仍算未知。
  - 联调脚本：`scripts/live-smoke.ts`、`scripts/live-route.ts` 的每个请求有 30 s 期限；不论成败，派出过的会话都先经 orchestrad 结束并等完停止顺序，再杀 orchestrad；之后按测试目录里 run/pids.jsonl 记下的 pid 查残留，映像名对得上的连同子树结束，并在报告里写数量。orchestrad 读到 stdin EOF 自己停机（父进程被杀时也能收尾）还没做。
- **procguard 实测（2026-11-02，本机，测试 profile）**：
  - 单元测试里的真机用例（`test/os/procguard-real.test.ts`）：用系统 csc 编出 procguard，常驻的说 ready；假 app-server（node）经 procguard-codex-fake 规则在 Job 里跑，它用 cmd 起 `ping -t`（S4 的基线：不经 Job 时这个 ping 在 node 被杀后还活着）。Job 里有 node、cmd、PING.EXE，包装进程本身不在 Job 里；刹车回 left 0，之后按 pid + 创建时间查，0 个还活着。另一条用例走普通结束（关 stdin 再杀包装进程），同样 0 个。没有 csc 时这两条会跳过并写明原因。
  - `node scripts/live-smoke.ts --harness codex`：退出码 0。Job 里有 codex.exe、codex-code-mode-host.exe、conhost.exe 各 1 个；结束后 feed 记 tree-ended，按 pid + 创建时间查 0 个还活着。
  - `node scripts/live-smoke.ts --harness claude`：退出码 0。Job 里有 node.exe（host）、claude.exe、conhost.exe 各 1 个；结束后 tree-ended，0 个还活着。
  - `node scripts/live-smoke.ts --harness codex --brake`：让 codex 用 `Start-Process` 起一个 `ping -t`（会脱离它的命令继续跑）。刹车前 Job 里有 codex.exe、codex-code-mode-host.exe、PING.EXE、conhost.exe ×2；刹车回 200，killed 5、left 0，会话结束为 braked，0 个还活着。
  - `node scripts/live-smoke.ts --harness claude --brake`：同样的任务，Job 里有 node.exe、claude.exe、PING.EXE、conhost.exe ×2；刹车回 killed 5、left 0，braked，0 个还活着。
  - 四次联调的测试目录都已删除，run/pids.jsonl 里记下的子进程（包装进程、常驻 procguard）事后都已不在。每种只跑了一次，不代表每次都如此。

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
