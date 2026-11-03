# Handoff: claude/alpha-0.2-interactive

## Facts
- Owner: AdamPlatin123
- When: 2026-11-02（第三次更新：第 2、5 步完成；本会话停在这里，后续并回主会话一条线做）
- Machine: 550W备份1号机
- Branch: claude/alpha-0.2-interactive（从 `claude/alpha-0.1` 的 eead531 切出）
- Commit: 见 `git log eead531..HEAD`
- Pushed: no（push 要等用户点头）
- Uncommitted on that machine: none（本分支 worktree 在 `.claude/worktrees/alpha-0-2`）
- 设计稿已按用户要求提交进仓库：`docs/plans/2026-11-02-alpha-0.2-slice-design.md`（80772b2）。下文的「第 N 步」「§N」都指它（第 N 步是它 §7 工作拆分表的行号）。

## Goal
在 Stage 页上做出可交互的薄切片和导入：在测试 profile 下新开 Orchestra 自己拥有的 Claude 会话（下称「自有会话」），发消息、审批工具调用、停下；把已观察到的 Claude 会话导入或复制一份接着做；把 DSH 会话复制一份快照。2026-11-02 用户决定把这些提前做，早于 r4 的计划（见 Divergence）。

## Done（已完成且已验证）
测试命令都是在 worktree 根目录跑全量 `node --test "test/**/*.test.ts"`（node 用主检出目录的 `.tools/node24/node.exe`）。起点 eead531：1079 条，1076 过，0 失败，1 跳过，2 todo。

- e949a73 spawn 闸的环境变量白名单和 cwd 检查（设计第 1 步）：每条 spawn 规则只拿固定的几个环境变量，值在建闸时拷一次；`NODE_OPTIONS`、`NODE_PATH` 永不传给子进程；`node-proc.ts` 不再把整个 `process.env` 交给子进程；新增 `src/os/cwd.ts`，按拒绝表和允许根检查调用方给的 cwd。允许根（`allowedRoots`）是参数，空表什么都不允许。— 验证：全量 1090 条，1087 过，0 失败。真实 whoami 用缩减后的环境跑通；真实 csc 用 csc 的变量在临时目录编译过一个小 C# 文件。
- b04626d 自有会话协议冻结（设计第 4 步）：`shared/protocol.js` 新增 9 个人类动作、19 个错误码；`src/server/routes.ts` 新增 14 条自有会话路由的形状和两种访问级别（`cookie`、`unlocked`），没有处理函数；冻结样例 `OWNED_ROUTES`。— 验证：全量 1098 条，1095 过，0 失败。
- b0ffefd 导入用的暂存复制（设计第 10 步）：写围栏新增 `renameDir`；读闸新增 `entries`；新模块 `src/import/staged-copy.ts`（`ImportStager`、`Stage`：begin → addFile/addTree → copy → writeReceipt → commit | discard）。— 验证：全量 1110 条，1107 过，0 失败；`test/import/staged-copy.test.ts` 全用合成数据，含真实 junction 的用例（没有跳过）。
- 1a15923 在跑的条上飘小音符（设计稿以外的 UI 小改动）：只给登记表确认在跑的条加音符，每页最多 6 条；减少动效时显示一个静止音符。— 验证：全量 1113 条，1110 过，0 失败；只在假 DOM 测试里验证。
- 97ef0b7 复核修正：复核 13 条发现，逐条对照代码核实，13 条都修了。要点：
  - 代理变量检查不再依赖 URL 解析，无 scheme 的 `user:pass@host` 也会被拒；名字含 proxy 的变量都查；同名不同大小写的附加变量被拒。
  - 暂存复制每个文件只开一次读句柄（读闸新增 `openRead`），所有分块都从这一个句柄读，并核对计划时的真实路径和 dev/ino；同名换了文件，即使允许变化也作废。
  - `ImportStager` 必须给 `stagingParent`（设计 §3.0 指定 ORCHESTRA_HOME 下的 tmp，每次启动清空）；放在目标旁边要调用方明确要求。
  - 改名已发生但事后检查失败时，状态记为 `unverified`，抛 `commit-unverified`，不再去删一个已经不存在的暂存目录。
  - `renameDir` 的注释写明 Windows 上的缺口：检查之后、改名之前出现在目标处的**文件**会被静默替换；有测试钉住这一行为。
  - cwd 拒绝表加上重定向的 `APPDATA` / `LOCALAPPDATA`，以及 worktree 所属的主检出目录（另可经 `spec.repoRoots` 指定）。
  - `text-too-long` 的提示改成中性的「文字太长」；图例改为「小音符：确认在跑（只标前 6 条）」，图例图标改用单个音符；音符的路径拆成单段子路径，不再被填成三角形。
  — 验证：全量 1118 条，1115 过，0 失败，1 跳过，2 todo。页面体积：`ui/` 98616 / 102400 字节；`/stage` 加载总量 143336 / 143360 字节，余量 24 字节。

- 2f0a5c3 Claude host 子进程和假 SDK（设计第 2 步）：
  - `hosts/claude/package.json` 只钉 `@anthropic-ai/claude-agent-sdk` 0.3.287；`package-lock.json` 取自 sdk-probe 分支的同版本 lockfile，只改了根包名；`hosts/claude/node_modules/` 进 `.gitignore`。
  - `hosts/claude/host-core.mjs` 装全部逻辑，不 import 任何东西：起始帧校验、PreToolUse 闸、`canUseTool` 经 ask/perm 帧并绑定 digest、预览、启动断言和模型守卫。PreToolUse 闸的规则：受保护路径直接拒；后台运行的 Bash、PowerShell 直接拒；Read/Glob/Grep/Write/Edit/PowerShell/Bash 以外的工具一律拒；其余转审批。
  - `hosts/claude/host.mjs` 是入口，按绝对 file URL 加载 SDK；SDK 不在时发 `sdk-missing` 退出帧。
  - `test/fixtures/fake-sdk.ts`、`test/hosts/claude-host.test.ts`（34 条）；规范化 JSON 和脱敏规则各有一组共用测试向量（`test/fixtures/canonical-json-vectors.json`、`redact-vectors.json`），两边实现都跑。
  - `hosts` 纳入静态扫描，另有 7 条 `hosts:` 专属规则。
  — 验证：全量 1211 条，1208 过，0 失败，1 跳过，2 todo（与第 5 步合起来跑）。真 SDK、真 claude.exe 一次都没跑过。
- 142dafe 自有会话路由的底座（设计第 5 步），在 `src/server/owned.ts`：
  - 操控码：`POST /api/owned/unlock-code` 把一次性 8 位码打到控制台（测试 profile 打到 stdout），回 204；`POST /api/owned/unlock {code}` 换一个绑定 sid 的令牌。节流照配对码：10 分钟过期、连错 5 次作废、累计错 20 次关到重启。
  - 设计 §2.7 的十步检查链；通过并被处理函数接受的人类动作，写进 Store 的 `human` / `human.result` 记录。
  - 新增冻结错误码 `body-too-big`（413）：正文超过 64 KiB 时返回，同提交更新了金样例。
  - 处理函数表 `makeOwnedHandlers().register(method, path, fn)`。还没有处理函数，所有自有路由一律回 501。`enabled` 开关默认关，关时 new / import / retry 回 409 `owned-disabled`。
  - `test/server/owned-http.test.ts` 14 条。
  — 验证：同上，全量 1211 条，0 失败。
- 80772b2 设计稿入库（见 Facts）。

## Unverified（做了但没验证，或验证没过）
- 没有驱动过任何会话：host 只用假 SDK 测过，真 `host.mjs` 只在没装 SDK 时起过一次。第 3 步没做，orchestrad 还起不了 host。
- 14 条自有路由只有底座，都回 501（第 6c 步没做）。
- **第 2、5 步的独立安全复核发现 9 条，一条都没修**（复核只读了 2f0a5c3、142dafe 两个提交，逐条追过代码，标「确认」的是代码路径追实了，标「可能」的取决于真 CLI 的行为）：
  1. 高，确认：`host-core.mjs` 的 `buildPreview` 先把所有字段拼成一段文字再整体脱敏。比如 Write 的 `content` 以 `authorization:` 结尾，就会把下一行的 `file_path` 一起吞掉；`pem` 规则没有 m 标志，会一直吞到预览末尾。结果是审批卡上看不到真正的目标路径或命令尾巴，却仍给「允许」。修法：逐个字段脱敏，路径字段和键名不脱敏；预览改成结构化的 `[{k, v}]`；有脱敏的 shell 和写文件工具只给「不允许」。
  2. 中，确认：预览里的字段边界可以伪造（值里带换行加 `file_path:`）。修法同上，改结构化字段，路径字段放最前。
  3. 中，可能：相对路径按起始 cwd 解析，CLI 在一次获准的 `cd` 之后，实际读的可能是别处的文件。修法：只有绝对路径才走「CLI 默认放行」；跑过 shell 以后，省略 `path` 的 Glob/Grep 一律转审批。
  4. 中，可能：Glob/Grep 只查搜索根，根下面的 junction 可以指到受保护目录。修法：一律转审批，或根下有重解析点就拒。
  5. 中，可能：PreToolUse 钩子遇到不合规的输入时返回 `{}`（等于不表态），`judge` 抛错或超时也一样，这时 CLI 会按默认放行只读工具。修法：钩子整体包 try/catch 返回 deny，并加一个比 SDK 钩子超时更短的计时。
  6. 低中，确认：根相对路径（`\Users\…`）、UNC、`\\?\`、`::$INDEX_ALLOCATION` 这类摆不进 cwd 的路径会弹审批卡，不是直接拒，卡上的风险也不标「受保护」。修法：按 cwd 所在盘解析；写类工具遇到摆不进的路径直接拒。
  7. 中，可能：别的端口的页面能拿到同一个 sid，可以反复申请操控码挤掉你的码，或连错 20 次把解锁关到重启；控制台那行字没写是哪个端口的码，假页面可以骗你填。修法：控制台打印完整 origin，码绑定一个页面和控制台上都显示的标签页随机数，按 sid 限速。
  8. 低，确认：`http.ts` 的 `readBody` 超长后还会一直读到结束，可以被无限长的分块正文占住连接。修法：超长时 `req.destroy()`。
  9. 低，可能：`host-core.mjs` 的 `sessionEnv` 把 host 的全部环境交给 claude.exe。修法：改白名单。
  复核确认没问题的：digest 按留存的原 input 重算，`updatedInput` 就是原对象；解锁的比较是常数时间；去重没有空窗；`__proto__` 和重复键无害。还有一条要落在第 6b 步：参数太长（tooLong）时，orchestrad 的 perm 处理也必须只接受「不允许」。
- `ImportStager` 没有任何调用方；导入流程（第 11、12 步）没做。磁盘剩余空间检查只在调用方传 `freeBytes` 时生效（写围栏的 io 没有 statfs）。
- 小音符只在假 DOM 测试里验证过，没在真实浏览器里看过；演示数据也没有登记表确认在跑的条，所以页面上一个音符都不画。用户已决定前端推倒重做，这一项不再跟。
- powershell-toast 的环境变量名单是暂定的，要等第 17 步（早先计划里引入 toast 脚本的那一步）才能真跑。
- 本分支所有提交都没有 push。

## Next（后续由主会话一条线接着做；起点是本分支最新提交）
用户 2026-11-02 的新安排（经主会话转达）：前端全部推倒重做，第 9 步（UI）和 `ui/` 的改动都停；后端照常，接口和数据契约要做成和前端无关。本会话停在第 5 步。下面是剩下的后端工作，按依赖排序：

0. **先修上面 Unverified 里复核的 9 条**，至少第 1、2、5 条（都在 `hosts/claude/host-core.mjs`），再往 host 上接东西。
1. 第 3 步：`claude-host` spawn 规则（`src/os/spawn.ts`），依赖第 1、2 步（已做）。要点：
   - exe 是启动时解析的 node.exe（realpath，不许有重解析点），argv 固定为 `[hostEntry]`（`hosts/claude/host.mjs` 的绝对路径，由 `src/main.ts` 建闸时给）。
   - 环境变量白名单：系统变量、TEMP/TMP、USERPROFILE、PATH、PATHEXT、COMSPEC。固定附加项：`NO_PROXY=127.0.0.1,localhost`、`CLAUDE_CODE_DISABLE_WORKFLOWS=1`、`DISABLE_AUTOUPDATER=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`。给了 `--claude-gateway` 才加 `ANTHROPIC_BASE_URL` 和占位的 `ANTHROPIC_API_KEY`。`CLAUDE_CONFIG_DIR` 不进 host 的环境，只走起始帧。
   - 哈希钉死：构建脚本把 `host.mjs`、`host-core.mjs` 的 sha256 嵌进 orchestrad，SDK 0.3.287 的 `sdk.mjs` 的 sha256 作常量（可从 sdk-probe worktree 已装的那份本地算出，不用下载）；每次 spawn 前重算，不符拒 `host-tampered`，SDK 不在拒 `sdk-missing`。
   - claude.exe 位置：`%USERPROFILE%\.local\bin\claude.exe`，启动时 realpath，记下大小和 mtime，放进起始帧的 `claudeExe`。
   - 新文件 `src/os/owned-proc.ts`：停止顺序是 close 帧 → 等 3 秒 → 关 stdin → 等 2 秒 → 杀进程，并标「claude.exe 可能残留」，计时只用 Clock。
   - `WorkingContext` 增加 `spawnGate`（只给闸实例，不给工厂）。
   - 起始帧的确切形状见 `host-core.mjs` 的校验，未知键一律拒。
2. **用户 2026-11-02 的新决定：work 目录挪出 AppData，不给 AppData 那一行开口子。** 做法：新增只在测试 profile 下有效的参数 `--work-dir <路径>`。要求：已存在；本身就是 realpath；最后一段以 `orchestra-work-` 开头（防止指到真实项目）；本身要过 cwd 拒绝表。它就是 `claude-host` 规则的 `allowedRoots`，每个会话的 cwd 是 `<workDir>\<ownedId>`。没给这个参数时自有会话关闭，`disabledWhy` 记 `no-work-dir`。同一步加 `--claude-gateway http://127.0.0.1:<port>`（只认这种写法）。
3. 第 6a 步：驱动和登记（`src/owned/registry.ts`、`driver.ts`）。要点：
   - 私有配置目录是 `<ORCHESTRA_HOME>\claude\<ownedId>`。
   - orchestrad 里排队，上限 5；停下的顺序：先把没答的审批按不允许处理，再清空队列，最后发 interrupt。
   - 重启后，starting / running / waiting 一律改 `unknown`，不自动续跑。
   - 重试时私有目录下有 `sessions/*.json` 就回 409 `still-running`，带 `confirmGone` 才放行。探针证实：host 被杀后 claude.exe 约 0.5 秒自己退出，但注册表文件会留下。
4. 第 6b 步：审批队列（`src/owned/approvals.ts`）。超时按 Q4 的 30 分钟，到时算拒绝，记一条 cause 为 `clock` 的非人类记录；允许时要带回 digest 和 rev；参数太长（tooLong）时只接受「不允许」。
5. 第 6c 步：把各端点接到第 5 步的 `makeOwnedHandlers().register(...)` 上。处理函数收到 `{route, id, query, body, actionId, sid}`，返回 `{ok:true, reply, targetId?}` 或 `{ok:false, error}`。从 `working.ts` 打开 `enabled`，条件是测试 profile、给了网关、给了 work 目录、找到了 claude.exe、host 没被篡改，几项都满足。重启后的重放只回 `actionId` / `accepted` / `jseq` / `replayed`，动词自己的回包字段要靠这一步补。
6. 第 7 步：`shared/owned-contract.js`（`validateOwnedList` / `validateOwnedFeed`）和金样例。`disabledWhy` 的枚举加上 `no-work-dir`、`no-claude`、`sdk-missing`、`host-tampered`。
7. 第 11 步：Claude 导入。探针结论（sdk-probe REPORT §10，已对照证据核实）：
   - resume 按会话 id 在整个 `projects/` 下找会话，项目目录名不必和 cwd 对上。
   - `.jsonl` 之外，要连同 `<id>/` 子目录一起复制（`tool-results/` 在里面）；读闸要放行它。
   - fork 用 `resume` + `resumeSessionAt` + `forkSession`。
   - 交接说明用 `systemPrompt {type:'preset', preset:'claude_code', append}`，resume 时要加 `snapshot:false` 才生效。
   - 认 Desktop 托管的会话，要读第一个带 uuid 的行里的 `entrypoint`（值为 `claude-desktop`），不能只看第一行。
   - 导入时 `tainted` 默认 false（用户决定）。
8. 第 12 步：DSH 快照，做成可单独拿掉的提交。第 13 步：在 `NOTICE` 里写明出处。
9. 第 14 步：在测试 profile 下用 magpie 网关实测一遍。前提是用户本人在 `hosts/claude` 下执行过 `npm ci --omit=optional --omit=dev --ignore-scripts`（要下载，先问用户）。
10. 第 9 步（UI）和「给演示数据加一个在跑的会话」都**停了**（前端推倒重做）。

## Do not touch
- 主检出目录里 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 的未提交改动：用户本人的。

## Open questions
**已定（用户 2026-11-02：「按推荐，导入对话不每次用工具都问」）：**
- **SDK 路线 = B**：独立 host 子进程，用真 SDK。仓库只放 `hosts/claude/package.json` 和 lockfile；SDK 由用户本人在 `hosts/claude` 里执行一次 `npm ci` 装上（要下载，AI 助手不代跑）。
- **0.2 只开测试 profile**：只在测试 profile 下、只在测试目录的 `work\` 里干活，不碰真实项目。
- **页面体积上限放宽**：页面 168 KiB、`ui/` 120 KiB（`test/ui/stage-html.test.ts`，即设计第 8 步，已在 5895f37 提交）。
- **导入的会话默认不算污染**（这一条没按设计推荐）：导入的会话和新开的会话一样，工作目录内的只读工具（Read、Glob、Grep）不每次问；工作目录外的、会写的、跑命令的照样逐次审批（设计 §2.2 第 5 条）。设计 §2.2 第 4 条（污染会话连 Read 也问）的代码路径保留，但导入时 `tainted` 默认 false，页面不显示「来源不明，每次都会问你」。用户接受的代价：导入的历史里可能读过网页或第三方 MCP 输出，会影响它接下来的行为（设计 §8 第 6 条）。
- 设计 §8 其余各条（第 2、3、7、8、9、10、11、13、14 条）这次没有逐条问。实现时先按设计推荐做，交付前再请用户过一遍。

下面「四个未定的决定」一节是决定之前写的，保留作记录（实现时都只做了各选项共有的部分，取决于决定的值做成了参数）：
- **SDK 路线**（设计 §8 第 1 条）：B 独立 host 子进程（用真 SDK，围栏不动，host 靠专属扫描规则和哈希钉死来管），还是 C 直接说 stream-json（零依赖，但要复刻没有文档的协议）。设计推荐 B。
- **0.2 只开测试 profile**（设计 §8 第 12 条）：0.2 只在测试 profile 下、只在测试目录里干活，还是允许在测试 profile 下选真实项目当 cwd（项目内容会发给 magpie）。设计推荐前者。
- **页面体积上限**（设计 §4.2、§8 第 5 条）：放宽到页面 168 KiB、`ui/` 120 KiB，还是把对话区做成单独的乐手页（Stage 只加约 5 KB，仍要小幅放宽）。
- **导入的会话默认算不算污染**（设计 §8 第 6 条，对应 r4 §8.5 的 taint 规则）：算则每次用工具都问，连 Read 也问；不算则和新开会话一样。设计推荐默认算。

设计 §8 的其他待定项：
- 第 2 条 SDK 许可证：仓库只放 `package.json` 加 lockfile、本机 `npm ci`，明着偏离 D5 写的 vendored；r4 §12.2 要用户补一行。
- 第 3 条 没有 procguard 的 Job 回收：接受现状的残余风险，还是先补 `run-in-job`。
- 第 4 条 配置目录和登录：每个会话一个私有配置目录，还是沿用你的 `~/.claude`（Q8 = A）。真实 profile 开放前再定。
- 第 7 条 审批超时：沿用 Q4 的 30 分钟，还是 5 分钟。
- 第 8 条 Desktop 托管、已结束的会话能否 resume，还是只给 fork。
- 第 9 条 DSH 快照带不带进 0.2。
- 第 10 条 对话正文进 JSON（偏离 M0「帧不带源文本」的约定），建议和 alpha 0.1 的同类偏离一起决定。
- 第 11 条 单条消息 2 KB 上限照守，还是放宽到 16 KB。
- 第 13 条 CLI 内置技能和插件关不掉时，是否改为一张由你确认的钉死名单。
- 第 14 条 M0 的 `GET /api/session` 仍只凭 cookie 发 csrf，`seen`、`snooze`、`brake` 等动作是否也接到操控令牌上（要改冻结契约）。

交付前请用户过一遍的（用户要求少打断，改为列在这里）：
- 设计 §8 第 13 条：init 帧里的技能和插件关不掉（探针：`skills: []` 能把技能从模型面前拿掉，但 init 照报 16 个技能、3 个插件）。host 的启动断言改成对照一张钉死的名单：技能 `design, design-sync, dataviz, update-config, verify, debug, code-review, simplify, batch, fewer-permission-prompts, doctor, loop, claude-api, run, run-skill-generator, plugin-authoring`；插件 `cc-plugin-agents-md, cc-plugin-telemetry, cc-plugin-plugin-authoring`（CLI 2.1.310）。
- 比设计 §2.2 第 5 条更严：设计说其余工具「一律问」，host 实际是 Read/Glob/Grep/Write/Edit/PowerShell/Bash 以外的工具一律直接拒。
- 设计 §8 第 2、3、7、8、9、10、11、14 条按推荐做，没有逐条问。

本分支实现中冒出来、要人确认的：
- **AppData 和 `%TEMP%` 冲突（已定，见 Next 第 2 条：用户选了另给 `--work-dir` 参数，不开口子）**：设计要求 cwd 只能在测试目录的 `work\` 下，测试 profile 又要求测试目录直接放在 `%TEMP%`（默认就在 `%USERPROFILE%\AppData\Local\Temp`）；而拒绝表不许 cwd 落在 AppData 里。现在默认 TEMP 下的 `work\` 一律被拒，有测试钉住。可选：AppData 规则对 `%TEMP%` 开口子，或把 work 目录挪到别处。
  原建议是只给 orchestrad 自己建的 `work\` 豁免 AppData 这一行；用户没采纳，选了 `--work-dir`。
- 路由路径参数写成 `:id`，不是设计里的 `:ownedId` / `:approvalId` / `:stageId`（已有测试要求路由只含小写字母）。
- `text-too-long` 现在同时用于提醒（120 字）和自有会话消息（2048 字节），提示文字已改成不带数字的「文字太长」；要不要拆成两个错误码，在处理函数落地前定。
- 设计稿要不要提交进仓库（见 Facts）。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-02 AdamPlatin123：本分支早于 r4 的计划。r4 的 D1（工作顺序）是：M0 只做只读注意力层，M1 才有自有会话互发消息，M2 安全强制。按 D1，M0 阶段不该出现对话和导入。处理：用户 2026-11-02 决定提前做；M0 的各条不变量照守，在此记录。
- 2026-11-02 AdamPlatin123：实现与设计稿的出入。
  - 暂存复制放在 `src/import/staged-copy.ts`，不在 `src/fs/`：仓库扫描规则禁止 `src/fs/` 下除读闸、写围栏、node-io 以外的文件做读写调用。
  - 没有 `fence.mkdtemp`：扫描规则禁止在写围栏以外出现这个词。改为用 `mkdirp` 建随机名目录，只认 mkdirp 报告由它新建的。
  - 读闸新增 `openRead`，供导入复制用（复核修正，97ef0b7）。
  - 设计第 1、4、10 步之外多做了一件 UI 小事（1a15923 飘小音符）。
- 2026-11-02 AdamPlatin123：探针 §10 的结论改了设计的几处前提，host 已按探针结论实现：
  - 自有会话里只有 `PowerShell` 工具，没有 `Bash`，PowerShell 按 shell 风险处理。
  - 只读工具、`EnterPlanMode`、`Skill` 不经过 `canUseTool`，所以真正的闸是 PreToolUse 钩子。
  - `maxTurns` 按每条消息算，碰到上限只结束这一轮，会话照常可用。
- 2026-11-02 AdamPlatin123：第 5 步与设计的出入。
  - 消息检查（超长、以 `/` 开头）放在形状检查之前，这是设计的顺序；`routes.ts` 的 CHECKS 把它们归在去重之后。两种顺序下都是 4xx，都不写东西。
  - `/` 开头的检查放在底座里，不放在消息处理函数里。
  - GET 允许不带 Origin（同源 GET 浏览器不发），带了就必须完全相等。
  - `owned-disabled` 也覆盖 retry。
- 2026-11-02 AdamPlatin123：本会话第 3 步开了头，没写下任何文件就停了（主会话要求在测试全绿的点停下，后续并回主会话一条线）。第 9 步因用户决定前端推倒重做而停。
- 2026-11-02 AdamPlatin123：5895f37 的提交信息写了「user decisions recorded」，但那个提交只含上限改动（`test/ui/stage-html.test.ts`），交接文件的更新没写进去（写入被那个会话的 worktree 隔离 hook 拦下）。本条和上面的各项更新在下一个 `handoff:` 提交里补上。

## 代号速查
| 代号 | 内容（一句话） | 出处 |
|---|---|---|
| D1 | 工作顺序：M0 只读注意力层 → M1 自有会话互发消息 → M2 安全强制 → M3 声部 → M4 Maestro / AutoRoute | r4 §4 |
| D5 | 自有驱动：Claude 用 vendored 的 dsh-TUI SDK 后端，强制关 bypass，不继承你的设置、hooks、`.mcp.json`（设计 §8 第 2 条说明这里不 vendored） | r4 §4 |
| M0 / M1 / M2 | r4 的里程碑：只读观察 / 自有会话互发消息 / 安全强制 | r4 §4 D1 |
| r4 §5.3 | orchestrad 只写自己的数据目录；agent 的 cwd 不得落在 Orchestra 数据目录、任何 DSH_HOME、任何 CLAUDE_CONFIG_DIR 里 | r4 §5.3 |
| r4 §8.5 | taint（污染）：来源链里有外部或未知来源的会话，权限收紧 | r4 §8.5 |
| Q4 | 审批超时代定 30 分钟后算拒绝，可按项目覆盖 | 设计 §8 第 7 条转引 r4 |
| Q8 = A | 自有 Claude 沿用你的 CLAUDE_CONFIG_DIR，复用登录（2026-10-29 已定） | r4 §17 Q8 |
| 第 N 步 | 设计 §7 工作拆分表的行号 | slice-design.md §7 |
| 第 17 步 | 更早的计划里引入 toast 脚本的那一步；之前 powershell-toast 规则不能启用 | `src/os/spawn.ts` 注释 |
| magpie | 本机的模型网关，0.2 的自有会话经它调用模型 | 设计 §0 |
| procguard | 本仓库的 C# 辅助进程（进程看守），计划中的 `run-in-job` 会把子进程放进随父进程结束的 Job | 设计 §8 第 3 条 |
