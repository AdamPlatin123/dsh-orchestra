# Handoff: claude/sharp-robinson-3001ea

## Facts
- Owner: AdamPlatin123
- When: 2026-11-08
- Machine: 550W备份1号机
- Branch: claude/sharp-robinson-3001ea（在 `claude/orchestra-app` 的 5ae387c 之上继续；问题卡那一段的交接已归档在 `docs/handoff/archive/claude--sharp-robinson-3001ea.md`）
- Commit: 本交接所在的提交；之前 813038a（拆 drive.js）、4842f6f（配一次就记住）、88d6944（删旧页面）
- Pushed: no（这 3 个提交 + 本交接都只在这台机器上；没合进 `claude/orchestra-app`）
- Uncommitted on that machine: none

## Goal
用户 2026-11-08 选了「前端原地重构」：不引框架、不加构建步骤，沿用 2026-10-31 UI 交互设计（模板克隆、只写 textContent、按 id 打补丁、纯 describe 函数、假 DOM 测试）。同时定了两件事：删掉旧页面 `/tower`；8 位码改成「配一次就记住」（不要每次启动输两个码）。

## Done（已完成且已验证）
- 删旧页面（88d6944）：`ui/tower.html`、`ui/tower.css`、`ui/app.js` 删除；`GET /tower` 回 301 到 `/`（同 `/stage`）。`GET /api/tower` 保留（首页在轮询它）。原来在旧页面上跑的审批测试（`test/ui/owned-app.test.ts` 8 个）改在首页上跑，断言未改就全过；dom.js 补丁测试移到 `test/ui/page-dom.test.ts`；109 条只给旧页面用的文案和一批死代码删除。首页加载总量约 330→302 KiB。
- 配一次就记住（4842f6f）：
  - 一个浏览器只输一个码：`POST /api/pair-code` 在控制台打印新码（回 204，码不进回复和日志）；`POST /api/pair`（JSON `{code}`）一次换到 cookie 和操作令牌。解锁码、两个解锁接口、无脚本配对表单都删了。`POST /api/pair/forget` 忘掉这台浏览器。
  - `src/server/pairings.ts`：最多记 16 个浏览器、每个 90 天，存在 `ORCHESTRA_HOME\pairings.json`，只存 sid 和令牌的 sha256。启动时一个都没记住才打印配对码。
  - 令牌在页面的 localStorage（按端口隔开）；只有 cookie 的请求访问自有接口一律 403 not-unlocked（防的是本机别的进程在另一个端口拿到 cookie）。
  - 实走（测试 profile、内置浏览器）：配对 → 重启 orchestrad → 控制台只打印「1 browser remembered」，页面直接是已配对；带令牌 `/api/owned` 200、只带 cookie 403；pairings.json 里只有哈希。
- 拆 drive.js（813038a）：`ui/drive.js` 847→240 行（状态、共用部件、`dialog()` 帮手、act 分派表），其余拆进 `ui/approve.js`、`dlg-new.js`、`dlg-pair.js`、`dlg-qa.js`、`dlg-re.js`、`dock.js`、`reads.js`；五个对话框都走同一个 `dialog()` 帮手。`test/helpers/owned-fixture.ts` 统一产出审批和 seat 样例；`owned-http` 的「每条路由」样例 body 改为从路由 shape 生成。断言一条没改。页面总量 +5.5 KB，没放宽任何预算。实走：旧令牌失效时页面自己清掉并弹配对框、配对、派活台、忘掉这台浏览器。
- 全量 `node --test "test/**/*.test.ts"`（node 用主检出目录的 `.tools/node24/node.exe`）：1797 条，1794 过，0 失败，1 跳过，2 todo。走完测试实例已停、无残留 procguard / codex 进程、测试目录已删、临时 `.claude/launch.json` 已删。

## Unverified（做了但没验证，或验证没过）
- `scripts/live-smoke.ts`、`scripts/live-route.ts`、`scripts/tower-demo.ts` 已改成新配对流程，只过了 `node --check`，没实际跑。`live-smoke --daemon-kill` 改成重启后沿用第一次的 cookie 和令牌（新逻辑下重启不打印码）。
- 真实 profile 没跑过新配对：第一次会打印码，之后应不再打印；`start-orchestra.cmd` 的提示文字没核对。
- cookie 和令牌现在存在浏览器资料目录里（用户选「记住」时接受的代价）：本机同一用户下有意翻浏览器文件的进程能拿到。
- 拆分后的页面只在内置浏览器里点过配对、派活台、忘掉；改派、问题卡、审批按住、刹车只有假 DOM 测试。
- 手机宽度、亮色主题都没看。

## Next（按优先级，每条可独立执行）
1. 请用户决定这条分支的去向：合进 `claude/orchestra-app`（它停在 5ae387c，可以快进），以及是否推送。注意 `claude/orchestra-app` 检出在 `.claude/worktrees/zen-superagent-exploration-04992d`，那里 `.git` 归管理员所有，要用 `git -c safe.directory=<那个路径> -C <那个路径> merge --ff-only ...`。合并后把本文件移到 `docs/handoff/archive/`，并更新 `docs/handoff/claude--orchestra-app.md`。
2. 跑一次 `node scripts/live-smoke.ts --harness codex`（测试 profile、普通权限控制台），确认新配对流程下脚本能走通。
3. 按首页重写 `docs/quickstart.md` 的 §3.1、§3.2 和第 6 节第 2 条（还在写旧页面的塔表、计数筛选、关于数据、「你」行）。
4. 删旧页面后首页没有的四项，要不要补由用户定：「关于数据」视图、「你」行的最近一次派活（`/api/tower` 的 `router.dispatch` 还在，没地方显示）、整棵树的交互（计数筛选、折叠、键盘移动）、自有会话行的工作目录名。

## Do not touch
- 主检出目录里 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 的未提交改动：用户本人的第七批改动。

## Open questions
- r4 要不要补一句：配对「首次」之后记住 90 天、最多 16 个浏览器，解锁码取消。r4 §10.11 第 1 条只写「首次配对时」打印码，和新做法不冲突，但没写记住多久。r4 由用户本人改。
- 批量审批（参考截图里那排「批准」开关）仍待用户拍板，见归档交接的 Open questions。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-08 AdamPlatin123：这条分支的上一段工作（问题卡）已快进合进 `claude/orchestra-app`（5ae387c）并推送，交接已归档；本文件是同一分支上新一段工作的交接。

## 代号速查
| 代号 | 内容（一句话） | 出处 |
|---|---|---|
| D8 | 审批、拍板、刹车只有你能做，超时就算拒绝；agent 那一侧没有这些路由 | r4 §4 |
| r4 §10.11 第 1 条 | 首次配对时控制台打印 8 位一次性码，输入后换成 HttpOnly、SameSite=Strict 的 cookie | r4 §10.11 |
| r4 §10.9 | 「允许」带上看到的摘要和队列版本；列表变动后 750 ms 内无效；高风险要按住或键入 | `ui/approve.js` |
| 测试 profile | `--test-profile --test-dir <dir>`：数据全在那个测试目录里，不碰真实数据 | `src/boot.ts` |
