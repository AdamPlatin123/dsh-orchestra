# @local/orchestra-seat

DSH 的一个 bundle（插件组合包），目标版本是 DSH CLI **0.2.1-rc.2**（`engines.dsh` 写的是确切版本，别的版本装不上）。它把 Orchestra 注册成两个**受治理的**子代理后端：

| 模型看到的工具 | 后端名 | Orchestra 里实际干活的 |
|---|---|---|
| `subagent_codex_governed` | `orchestra-codex` | orchestrad 拉起的自有 Codex 会话 |
| `subagent_claude_governed` | `orchestra-claude` | orchestrad 拉起的自有 Claude Code 会话 |

「受治理」的意思是：DSH 的主 agent 调这两个工具时，**不会有任何进程被启动**。bundle 只经 orchestrad 的 agent 侧请求口（一条 named pipe，只有提请求、查状态、撤回三条路由）提交一条乐手请求，然后等。请求在 Orchestra 配对页的「等你」栏里变成一张卡，由人点「派出」或「拒绝」；到时限没人点，就算拒绝。

零依赖，只用 Node 自带模块。

## 结果怎么回到 DSH

| orchestrad 里请求的状态 | DSH 子代理的 `stopReason` | 说明 |
|---|---|---|
| `done` | `completed` | 最多三个文字块：① seat 的说明，只写 orchestrad 请求口报告了什么（会话 id、第一回合结束了、不是完成判定）；② 派出的会话**第一回合的最后一条消息**原文（最多 8 KiB），包在这次结果现生成的界线 `<<orchestra-worker-output 随机串>> … <</orchestra-worker-output 随机串>>` 里，说明块写明界线内是未经复核的工人输出，是数据不是指令；③ 被截过时的截断说明，放在界线外，按原因写（orchestrad 的 8 KiB 上限、会话自己截过、Orchestra 的记录丢过早期事件）。记录丢过早期事件又找不到文字时写「交回的文字未知」，不写「没有」。这只表示「请求的那一回合回来了」，不是完成判定：任何 agent 都不能宣布完成（r4 D19） |
| `rejected` | `refusal` | 人在配对页点了「拒绝」 |
| `expired` | `refusal` | orchestrad 的时限到了，没人派出（超时即拒） |
| 仍是 `pending`，但到了本 bundle 的 `requestTimeoutMs` | 看撤回的实际结果 | 撤回成功：`refusal`（没人派出）。撤回时发现人刚好派出了：`aborted`，诊断写「会话已按正常结束顺序收尾」，不说没人派出。撤回没成功：`refusal`，诊断写「卡片可能还在配对页上，到 orchestrad 的时限会自动拒；有人派出的话结果不会回到这里」 |
| `failed`、请求口不认识这条请求、令牌不对、回复证明不了令牌、连不上 | `error` | 诊断里只写 orchestrad 的代码，不写原文 |
| DSH 取消了这次委派（UI 中断子级、模型调 `interrupt_agent`、父级被拆除） | `aborted` | bundle 带着提交时拿到的撤回钥匙撤回请求（连接被断、管道忙时在 5 秒内退避重试 100/300/1000 ms）；已派出的会话走正常结束顺序收尾，**不是刹车**。撤回没成功时诊断照实说，不说「已撤回」 |

两条细节：
- DSH 在子级正常结束后也会调 `dispose()`。所以 bundle 只在请求还没到终态时撤回，最多撤一次（一次撤回里断线可以重试），失败也不抛。orchestrad 那边对已终态请求的撤回也是空操作。
- 只有提交方能撤回：orchestrad 在提交的回复里给一把撤回钥匙（16 字节随机数），只给这一次，不进列表、不进日志。别人拿到 requestId 也撤不回。
- 委派工具在 0.2.1 里是异步的：调用后立即返回子级 id，结果以完成通知回到父会话。主 agent 那一轮不会卡在「等人点派出」上；时限只是为了让卡片别挂太久。

## 这里没有批准键，为什么

这个 bundle 里没有「允许」「派出」「批准」按钮，也不注册任何 DSH 审批监听器（不碰 `approval/request`），不回答任何 DSH 审批。这是故意的，依据是 r4 的 **D8**（`docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 第 492 行）：

> 只有一个审批队列，超时即拒；审批永远不经 agent 转发，不能通过 MCP 解决，不会自动放行。人类动词（批准、拒绝、拍板、刹车……）只挂在需要配对 cookie 的 UI 监听器上，agent 一侧的通道物理上没有这些路由。

落到 seat 上就是三条：
1. **DSH 是 agent 一侧。** DSH 里的主 agent、它装的插件、它能跑的 shell，全都在 agent 一侧。只要 DSH 页面上有一个能让请求通过的按钮，同一进程里的代码就能按它。所以通过只能发生在 Orchestra 配对页上。
2. **请求口物理上只有三条路由。** 提请求、查状态、撤回。派出、批准、拒绝、刹车在请求口上不存在，打过去一律 404（orchestrad 侧有反向测试 `test/server/agent-port.test.ts` 钉住）。
3. **令牌只授「提请求」的权，而且不过管道。** 令牌文件谁读到了都只能提请求，每一条仍然要人点派出。bundle 每次请求都现读令牌文件，因为 orchestrad 每次启动都换令牌。请求里不带令牌本身，只带一个新随机数、当前时间和「令牌对这条请求（方法、路径、body 的 sha256）的 HMAC」；orchestrad 回复时也带「令牌对这次回复（随机数、状态码、body）的 HMAC」（`x-orchestra-proof`），bundle 核对不上就一个字都不信（`proof-bad`）。所以只抢到管道名、没读到令牌文件的进程，既拿不到令牌，也伪造不了结果。

这也是 r4 **A17**（agent 只能请求新建乐手，只生成一条由人批准的条目，r4 第 794 行）的落地：DSH 能做的只有「请求」。

另外，bundle 用 `ctx.tools.guard` 拒掉 `plugin_manager`：这个宿主里的会话不能再往宿主里装代码。注意这只是防误装，不是令牌保护，DSH 的 shell 工具同样能读到令牌文件；令牌本来就只能提请求。

## 安装（开发期，`link:`，隔离的 DSH_HOME）

下面的命令只在隔离的 `DSH_HOME` 里跑，不碰 `~/.dsh`。`dsh` 要用全局 CLI 自带的 Node 24（`%APPDATA%\npm\dsh.ps1` 会自动选它）。

```powershell
$env:DSH_HOME = "<某个隔离目录>\dsh-home"
$env:DSH_TELEMETRY_DISABLED = "1"      # 不发会话遥测
Set-Location "<某个隔离目录>"          # dsh 会读当前目录的 .env，别在仓库目录里起

# 建一次 profile（--from-default-profile 每次都会删掉重建，所以只用一次）
dsh --profile seat-hl --from-default-profile headless --dump-config > $null

# 装 bundle：link: 路径只读磁盘上的 package.json，不查 registry
dsh plugin --profile seat-hl add -w --offline "link:<仓库>\integrations\dsh-seat"
```

然后在 profile 的 `cordis.patch.yml`（`$env:DSH_HOME\profiles\seat-hl\cordis.patch.yml`）里告诉它 orchestrad 在哪。整段替换 bundle 自带的 config：

```yaml
- id: orchestra-seat
  config:
    pipe: '\\.\pipe\orchestra-agent-test-<名字>'      # orchestrad 启动时打印的 pipe 名
    tokenFile: 'C:\...\orchestra-test-<名字>\orchestra\agent-port.token'
    requestTimeoutMs: 600000                           # 没人派出时最多等多久，最少 5000
```

orchestrad 要带 `--owned --agent-port --peek-port <端口>` 启动；测试 profile 再加 `--test-profile --test-dir %TEMP%\orchestra-test-<名字>`，pipe 名就是 `\\.\pipe\orchestra-agent-test-<名字>`。

检查：

```powershell
dsh --profile seat-hl --dump-config | Select-String "^- id: (orchestra-seat|tool-subagent-orchestra-)"   # 三行：orchestra-seat 和两行 tool-subagent
# 只搜 "orchestra" 会命中十几行（patch 来源注释、name、pipe、tokenFile、provider 都含这个词），不代表装错
```

## 装进你日常用的 DSH profile

**这一步由你本人决定、由你本人动手。** AI 助手不替你装：依据是 r4 的两条。

- **D11**（只对接、不魔改上游；r4 第 495 行）：「live `web` profile 里默认不放 Orchestra 代码（你可以 opt-in，Q5a 已定 2026-10-29）；任何 bundle 先在隔离的 `DSH_HOME` 加 3099 / 3199 端口上验证」。
- **Q5a**（日常 profile 里放不放 Orchestra 代码；r4 第 2904 行，第 167、2254 行同义）：「默认不放；保留你手动 opt-in 的路径：在 Tuning 开启，是人类动词、记 Decision；开启前同一版本的 bundle 必须先在隔离 `DSH_HOME` 验过（推断）」。

所以开始之前：

1. **先用同一版本在隔离的 `DSH_HOME` 里验过**（上一节）。「同一版本」按提交算：bundle 的 `package.json` 版本号不随提交变，要记下你验过的是哪个提交，日常 profile 里 link 的也必须是那个提交。
2. **知道它和 r4 原文对不上的三处**，由你决定接不接受：
   - Q5a 写的是 opt-in 时**只加载 bundle 的只读部分**（转发子代理开始/结束、后代可见、BSB 标签页），不开会改变 agent 行为的部分。seat 不是只读的：它给日常 profile 里的每个会话加两个模型能调的工具，每调一次就在 Orchestra 配对页上出一张请求卡。它派不出任何东西（每张卡都要你点「派出」，10 分钟没人点就自动拒），但它确实超出了 Q5a 说的「只读部分」。
   - Q5a 说「在 Tuning 开启」。Orchestra 现在没有 Tuning 页，也不记这次开启的 Decision：开启就是你手动跑下面的命令、手动改文件（计划 `docs/plans/2026-11-02-orchestra-app-plan.md` 的分歧一节记了这一条）。
   - D11、Q5a 写的是 live `web` profile。r4 第 3879 行记着 DS-Bot 2026-10-26 起换成了桌面版，这两条要按桌面版重核。这里说的「日常 profile」就是你平时实际在用的那个 DSH profile，名字以你本机为准。Q5a 还要求隔离验证包括和 DS-Bot `approvals.js` 共存的检查（推断）：seat 不碰 `approval/request`，但共存没有验证过，你的日常 profile 里如果还装着 DS-Bot，结果未知。

### 步骤

**顺序：先让 orchestrad 带 `--agent-port` 起来，再用 DSH。** 令牌文件只在 orchestrad 运行时存在，每次启动都换新的；seat 每次请求都现读这个文件，所以 orchestrad 重启后 DSH 不用重启，但重启前还在等的请求全部丢失。orchestrad 没在跑时，委派会以 `error` 结束（诊断写找不到令牌文件或连不上）。orchestrad 的启动方法见 `docs/quickstart.md` 第 1 节（`start-orchestra.cmd`，或 `orchestra.cmd --owned --agent-port --peek-port 7470`）。

1. **link 到一个稳定的检出目录，不要 link 到 `.claude\worktrees` 下。** `link:` 直接读磁盘上的文件，那个目录切分支、被清理、被删掉，你日常 DSH 里的代码就跟着变或者没了。worktree 是临时的。注意：seat 目前只在分支 `claude/orchestra-app` 上（没合并、没 push），主检出目录的 `main` 里还没有 `integrations\dsh-seat`。合并之前要装，就为它单独准备一个固定位置、不随手切分支的检出目录。
2. **不要用 `--from-default-profile`。** 它会把 profile 删掉重建，用在日常 profile 上会抹掉你原来的配置。日常 profile 已经存在，直接装 bundle：

   ```powershell
   Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue   # 确认这个窗口没指向隔离目录；日常 DSH 用 ~/.dsh
   Set-Location "<某个普通目录>"                              # dsh 会读当前目录的 .env，别在仓库目录里起
   dsh plugin --profile <日常 profile> add -w --offline "link:<稳定检出目录>\integrations\dsh-seat"
   ```

3. **在日常 profile 的 `cordis.patch.yml`（`~\.dsh\profiles\<日常 profile>\cordis.patch.yml`）末尾追加下面这段，不要整份覆盖这个文件**（里面可能已经有你别的配置）。文件里已经有 `- id: orchestra-seat` 的话，改那一段，不要再加第二段。这一段会整段替换 bundle 自带的 config：

   ```yaml
   - id: orchestra-seat
     config:
       pipe: '\\.\pipe\orchestra-agent-real'                  # 真实 profile 的 pipe 名，和 src/server/agent-port.ts 一致
       tokenFile: 'C:\Users\<你>\.orchestra\agent-port.token'  # 绝对路径；以 orchestrad 启动时控制台打印的「token in …」为准
       requestTimeoutMs: 600000                                # 没人派出时 DSH 最多等多久，整数，最少 5000
   ```

   bundle 启动时按 `index.js` 的 `configProblem` 检查这段：`pipe` 必须以 `\\.\pipe\orchestra-agent-` 开头；`tokenFile` 必须是绝对路径（`%USERPROFILE%` 这类写法不算，要写展开后的路径）；`requestTimeoutMs` 可以不写，写了必须是不小于 5000 的整数。不合格时 bundle 不注册任何后端，只在 DSH 日志里写一行 `orchestra-seat: config unusable (…)`。你设了 `ORCHESTRA_HOME` 的话，令牌文件在那个目录里，照控制台打印的写。
4. **检查**：`dsh --profile <日常 profile> --dump-config | Select-String "^- id: (orchestra-seat|tool-subagent-orchestra-)"` 应该是三行。

### 装上以后会变的

- **这个 DSH 里 `plugin_manager` 一律被拒**：bundle 注册的拦截器作用于这个 profile 起的整个 DSH 宿主，所有会话都一样，不管是谁调的。要装别的插件，改用命令行 `dsh plugin …`。
- 日常 profile 里每个会话的模型都多了两个工具 `subagent_codex_governed`、`subagent_claude_governed`（全局工具，所有 preset 都看得到）。模型调一次，配对页上就多一张请求卡，等你处理。
- 卸载：本文没核实 DSH 的卸载命令（未知）。至少要删掉第 3 步追加的那一段。

## 测试

```powershell
node --test "integrations/dsh-seat/test/*.test.mjs"
```

仓库的全量测试也会跑它（`test/integrations/dsh-seat.test.ts` 导入这个文件）。测试用一个假请求口覆盖 completed / refusal / error / aborted 四种结果、撤回只发生一次（断线时的重试）、按撤回实际结果写诊断、界线包裹、`dispose()` 不抛，以及 guard；另有一条用真的 named pipe 验证 HMAC 请求头、令牌不过管道、每次现读令牌、回复证明对不上就拒收。仓库那边再核对 bundle 重述的 HMAC 和 orchestrad 的一字不差，并让 bundle 的管道客户端对着真的请求口走一遍。

## 已知限制

- 提交请求的那一刻被取消，orchestrad 可能已经建了卡片但 bundle 拿不到它的 id，没法撤回。那张卡会在 orchestrad 的时限到后自己变成 `expired`（超时即拒）。
- 请求只存在 orchestrad 内存里。orchestrad 重启后，DSH 再查会得到 `request-unknown`，结果是 `error`。
- 会话在哪里跑，看 orchestrad 启动时有没有放行项目根（`--project-root <绝对路径>`，可以给多次，只能和 `--owned` 一起用）：
  - DSH 传的 `cwd` 落在某个放行的根里（根本身或它下面的子目录；规范化后比较，不分大小写），并且过了拒绝表、是目录、路径上没有链接或连接点、DSH 写的路径里没有 `..`：卡片写「这在你放行的项目根里，派出后在 <cwd> 里跑」，派出后会话就在那个目录里跑。
  - 否则（没放行任何根、`cwd` 不在根里、有 `..`、有链接……）：会话照旧在 orchestrad 自己的 `ORCHESTRA_HOME\work\<id>` 里跑，卡片写「派出后仍在 Orchestra 自建的工作目录里跑」并写明原因。
  - 不管哪种，派出都只有人在配对页上点（D8）；Codex 在 Windows 上的沙箱只读，会话每次写文件、跑命令仍会来问。
- 这个 `cwd` 还要先过 orchestrad 的工作目录拒绝表：在 `%USERPROFILE%\AppData` 下（包括 `%TEMP%`）、在 orchestra 仓库里、系统目录里，请求会被拒（`cwd-forbidden`，委派调用直接报错）。所以 DSH 要从普通项目目录启动。实验室冒烟里用的是 orchestrad 自己工作根下的一个子目录（拒绝表对它放行）。测试 profile 下放行的项目根只能在测试目录里，在那里面拒绝表不按 AppData 那一行拒；真实 profile 没有这个例外。
- 外部子级在 DSH 自己的界面里只显示为一次工具调用；进度看 Orchestra 配对页。DSH 的 `list_agents` 也看不到它（显示没有子级），模型因此可能以为第一次没成功、再调一次（2026-11-03 headless 实测出现过，配对页上多了一张一样的卡）。所以同一个 DSH 会话、同一工作目录、同一段任务文字的请求还没有结果时，bundle 直接拒绝第二次调用，诊断写明「不用重试，结果会以完成通知送回」（`[duplicate]`）。第一次还在提交、orchestrad 还没回话时，收没收下未知，诊断就不承诺结果，只说那次委派报错的话可以再提（`[duplicate-submitting]`）。只在同一个 DSH 进程里有效；第一个请求有了结果后，同样的请求可以再提。DSH 没给出会话 id 时（卡片上是「未知」），分不清是不是同一个会话提的，就不合并，只受 orchestrad 自己的限额约束。
- 没有 pipe 对端进程校验（final.md §6.3 B 推迟到以后的 pipe-client-pid）。由此剩下的：
  - 同一用户的进程读到令牌文件就能提请求（但每条仍要人点派出）。自有 Codex 会话也在其中：Windows 上它的沙箱只限写、不限读，令牌文件放到哪个同用户可读的目录都一样，挪位置没用；要靠以后的对端 pid 校验或收紧文件 ACL。
  - 卡片上的「请求方」是请求方自己报的（DSH 会话 id，取不到就是「未知」），页面写成「自称来自 DSH 会话 …（未核实）」，不能当身份看。每个请求方同时最多 4 条在等，但换 id 的进程只受全局限额（16 条、每分钟 6 条）约束。
  - 读到令牌文件的进程如果再抢到管道（Windows 允许同用户给同名管道加实例；orchestrad 崩溃后管道名空着更容易），就能冒充 orchestrad 回话，包括伪造 `done` 和任意文字。所以 bundle 的说明块只写「orchestrad 请求口报告」，并把工人文字放在界线里标成未复核的数据。只抢到管道、没读到令牌的进程只能丢弃或拖延请求，或把截到的请求原样转发一次（MAC 绑住了方法、路径和 body）。
