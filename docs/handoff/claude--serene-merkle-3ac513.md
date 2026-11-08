# Handoff: claude/serene-merkle-3ac513

## Facts
- Owner: AdamPlatin123
- When: 2026-11-05
- Machine: 550W备份1号机
- Branch: claude/serene-merkle-3ac513（从 `claude/orchestra-app` 的 8eb2215 切出）
- Commit: f111072（之前 1678a76）
- Pushed: no（用户没让推；要推还是合进 `claude/orchestra-app`，由用户定）
- Uncommitted on that machine: `hosts/claude/node_modules`（已被 .gitignore 忽略），从 `zen-superagent-exploration-04992d` 那个 worktree 原样复制来，为了在测试 profile 里起 Claude 自有会话。

## Goal
请求卡「改派」：worker 的 orchestra_dispatch、总台、DSH seat 发来的派活请求，人可以换成另一家（Codex/Claude）或另一个模型再派出。用户 2026-11-05 选了这一项；另一项「派给已有 worker」不做。

## Done（已完成且已验证）
- 服务端：`POST /api/owned/new` 带 requestId 时只要求任务原文和卡片一致，哪家、哪个模型由人选，并且走普通派出的全部检查（`src/route/requests.ts` claim/bind，`src/server/owned-handlers.ts`）。请求的受污染标记、来源链、项目根 runIn 都不变。bind 之后请求的 harness/model 改成实际运行的，所以总台的派单列表和 worker 收到的回复写的都是实际派给了谁。
- journal 新 kind `request-reassign`（from、fromModel、to、toModel），和 owned-new 的 human 记录写在同一批；`agent-request` 记录里的 harness 仍是卡片原来请求的。换了家，或者换掉了请求点名的模型，才写这条记录。旧版本 orchestrad 读到不认识的 kind 会拒绝启动（`src/store/journal.ts` parseLine）。
- worker 回复：改派时加一句 `The person sent it to X instead of the Y you asked for.`（`src/route/dispatch.ts` sent）。
- 前端：两页（`/` 和 `/tower`）的请求卡上加「改派…」按钮，点开 `re-dlg` 对话框，里面是哪家、模型两个下拉框，加上原文、它请求的是什么、在哪里干活、以及「改派只换由谁来跑」的说明（`ui/owned.js` describeReassign、`ui/drive.js`、`ui/home.html`、`ui/tower.html`、`shared/strings.js`）。
- 验证：
  - 全量 `node --test "test/**/*.test.ts"`（node 用主检出目录的 `.tools/node24/node.exe`）：1786 条，1783 过，0 失败，1 跳过，2 todo。基线 8eb2215 是 1782 条，1779 过，0 失败。
  - 新测试在 `test/route/requests.test.ts`、`test/route/dispatch.test.ts`、`test/server/agent-requests-http.test.ts`、`test/ui/owned-app.test.ts`、`test/store/journal.test.ts`。把源码退回 8eb2215、只留新测试时，它们都会失败（例外见 Unverified）。
  - 测试 profile 页面实走（内置浏览器，1280 宽）：开一个 Codex worker，让它调 orchestra_dispatch（harness codex）→ 等你里出现请求卡 → 改派… → 换成 Claude，模型列表跟着变成 zcode/GLM-5.3 → 派出 → 新会话是 claude / zcode/GLM-5.3；journal 里依次是 route（chosen 为 claude）、agent-request（harness 为 codex）、request-reassign（codex→claude）。`/tower` 页面上也有这个对话框。测试实例经 stdin 关闭停下，procguard 退出，7481 端口已释放，测试目录已删。
  - 多代理复核（三个视角，每条发现再由一位复核者核对）：确认 3 条，都是低严重度，都已在 f111072 修好：只换模型时 worker 回复不说是人改派的；对话框在派出途中被关掉时失败原因丢了；换家再换回来时模型被重置成列表第一项。另外 2 条被推翻。
- 页面体积上限放宽了（`test/ui/home-page.test.ts` 289→296 KiB，`test/ui/tower-page.test.ts` 240→247 KiB），原因是对话框和两页共用的代码。tower 页的上限最早是用户 2026-11-02 定的（168 KiB），同一天又放宽到 240，见那条测试的注释。

## Unverified（做了但没验证，或验证没过）
- 页面实走时，worker 那一轮在请求卡被派出之前就结束了，所以 worker 实际收到的「The person sent it to …」那句回复，在真模型下没看到。这句话只有单元测试覆盖。worker 的派活工具是不是不等人点就先回了，原因没查。这个行为在改派之前就是这样，不是这次引入的。
- 「换回卡片原来那家时恢复卡片上的模型」：页面测试里的假 DOM 换选项时不会重置选中值，所以那条断言不带修复也能过，等于没测到。真浏览器里也没走过这一步。
- 「对话框关掉后，失败原因写到页面提示」：没有测试，也没在页面上走过。
- 改派到被拒的情况在页面上没走过：Claude 关闭、名额满、模型不在名单。服务端测试只覆盖了 Claude 关闭时报 owned-disabled、卡片继续等。
- DSH seat 请求的改派只有 HTTP 测试（用替身会话），没有用真 DSH 走过；来源不可信的请求改派后，真会话是不是仍按受污染运行，只有单元测试。
- 手机宽度、亮色主题下的对话框没看过。

## Next（按优先级，每条可独立执行）
1. 用户决定这条分支的去向：合进 `claude/orchestra-app`（应能快进，它基于 8eb2215），还是推远端。另外，原会话的 worktree 里有一条空分支 `claude/request-reassign`，指在 8eb2215、没有提交，确认不用后可以删。
2. 在测试 profile 里补走 Unverified 的第 2、3、4 条：打开改派对话框，把 Claude 切过去再切回 Codex，看模型是不是变回卡片上的那个；派出途中按 Esc，看页面提示有没有写原因；用 `--owned` 只开一家，看改派到另一家时怎么提示。
3. 查 worker 的派活工具在「派前问你」时是不是不等人点就回了：读 `src/route/dispatch.ts` 的 ask() 和 Codex 动态工具的超时。预期：worker 的那一轮应该等到人派出或拒绝。

## Do not touch
- 主检出目录里 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 的未提交改动：那是用户本人的第七批改动。

## Open questions
- r4 的 A17（agent 只能请求新建会话，由你批准）写的是「人批准」，没说人能不能换掉请求的那一家。改派没有放宽 A17，派出仍然只有人能点，只是让人多了一个选择。要不要在 r4 里补一句，由用户定。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-05 AdamPlatin123：交接计划写的是在 `claude/request-reassign` 上做。那条分支检出在原会话的 worktree 里，这个会话的 worktree 拿不到它，所以实际做在 `claude/serene-merkle-3ac513` 上（先 reset 到 8eb2215，没有丢任何东西）。
