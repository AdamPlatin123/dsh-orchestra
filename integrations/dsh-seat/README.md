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
| `done` | `completed` | 交回的是派出的会话**第一回合的最后一条消息**（最多 8 KiB，被截过会标「已截断」），前面加一行来源说明。这只表示「请求的那一回合回来了」，不是完成判定：任何 agent 都不能宣布完成（r4 D19） |
| `rejected` | `refusal` | 人在配对页点了「拒绝」 |
| `expired` | `refusal` | orchestrad 的时限到了，没人派出（超时即拒） |
| 仍是 `pending`，但到了本 bundle 的 `requestTimeoutMs` | `refusal` | bundle 先撤回请求，再报拒绝 |
| `failed`、请求口不认识这条请求、令牌不对、连不上 | `error` | 诊断里只写 orchestrad 的代码，不写原文 |
| DSH 取消了这次委派（UI 中断子级、模型调 `interrupt_agent`、父级被拆除） | `aborted` | bundle 撤回请求；已派出的会话走正常结束顺序收尾，**不是刹车** |

两条细节：
- DSH 在子级正常结束后也会调 `dispose()`。所以 bundle 只在请求还没到终态时撤回，最多撤一次，失败也不抛。orchestrad 那边对已终态请求的撤回也是空操作。
- 委派工具在 0.2.1 里是异步的：调用后立即返回子级 id，结果以完成通知回到父会话。主 agent 那一轮不会卡在「等人点派出」上；时限只是为了让卡片别挂太久。

## 这里没有批准键，为什么

这个 bundle 里没有「允许」「派出」「批准」按钮，也不注册任何 DSH 审批监听器（不碰 `approval/request`），不回答任何 DSH 审批。这是故意的，依据是 r4 的 **D8**（`docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 第 492 行）：

> 只有一个审批队列，超时即拒；审批永远不经 agent 转发，不能通过 MCP 解决，不会自动放行。人类动词（批准、拒绝、拍板、刹车……）只挂在需要配对 cookie 的 UI 监听器上，agent 一侧的通道物理上没有这些路由。

落到 seat 上就是三条：
1. **DSH 是 agent 一侧。** DSH 里的主 agent、它装的插件、它能跑的 shell，全都在 agent 一侧。只要 DSH 页面上有一个能让请求通过的按钮，同一进程里的代码就能按它。所以通过只能发生在 Orchestra 配对页上。
2. **请求口物理上只有三条路由。** 提请求、查状态、撤回。派出、批准、拒绝、刹车在请求口上不存在，打过去一律 404（orchestrad 侧有反向测试 `test/server/agent-port.test.ts` 钉住）。
3. **令牌只授「提请求」的权。** 令牌文件谁读到了都只能提请求，每一条仍然要人点派出。bundle 每次请求都现读令牌文件，因为 orchestrad 每次启动都换令牌。

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
dsh --profile seat-hl --dump-config | Select-String "orchestra"   # 三行：orchestra-seat 和两行 tool-subagent
```

## 测试

```powershell
node --test "integrations/dsh-seat/test/*.test.mjs"
```

仓库的全量测试也会跑它（`test/integrations/dsh-seat.test.ts` 导入这个文件）。测试用一个假请求口覆盖 completed / refusal / error / aborted 四种结果、撤回只发生一次、`dispose()` 不抛，以及 guard；另有一条用真的 named pipe 验证 `Authorization: Bearer` 和每次现读令牌。

## 已知限制

- 提交请求的那一刻被取消，orchestrad 可能已经建了卡片但 bundle 拿不到它的 id，没法撤回。那张卡会在 orchestrad 的时限到后自己变成 `expired`（超时即拒）。
- 请求只存在 orchestrad 内存里。orchestrad 重启后，DSH 再查会得到 `request-unknown`，结果是 `error`。
- orchestrad 目前让会话在它自己的 `ORCHESTRA_HOME\work\<id>` 里跑，DSH 传的 `cwd` 只显示在卡片上。
- 但这个 `cwd` 要先过 orchestrad 的工作目录拒绝表：在 `%USERPROFILE%\AppData` 下（包括 `%TEMP%`）、在 orchestra 仓库里、系统目录里，请求会被拒（`cwd-forbidden`，委派调用直接报错）。所以 DSH 要从普通项目目录启动。实验室冒烟里用的是 orchestrad 自己工作根下的一个子目录（拒绝表对它放行）。
- 外部子级在 DSH 自己的界面里只显示为一次工具调用；进度看 Orchestra 配对页。
- 没有 pipe 对端进程校验：同一用户的进程读到令牌文件就能提请求（但每条仍要人点派出）。
