# UI 交互设计（M0 起）

- 日期：2026-10-31。状态：设计结论；M0 计划已按它改好（见第八节），要你定的事见第七节，和开眼笔记第 7 节的对照见第九节；第二轮（补听挑战稿和第三份稿的尾部、复核 40 条）的改动记在第八节末；第三轮（并入第 2b 步的代码事实、2c 的范围、复核余下的 M1/M2/L2–L6）和第三轮的复核也记在那里。
- 依据：r4 D3、r4 D8、r4 D10、§3.2、§5.3（r4:595）、§10.9、§10.11、§11；M0 计划；开眼笔记 P1–P7 和第 7 节（第二轮，尤其 7.3「人这一端」、7.5 分档、7.6 被否掉的）；四份设计稿和三份评审（开眼、安全与已定规则、工期）。第一轮时第三份稿末尾被截断、第四份（挑战稿）没送到，第二轮已补听：采纳的写进正文，没采纳的在第六节末各写一行理由。
- 标记：（推断）= r4 和评审都没写，是本文的取舍。

## 结论

你问的「更好的范式」，本文的回答是「日志投影 + 命令表」，不引框架。分六条说：

- **页面是什么**：journal 的示波器，不是数据库。orchestrad 推「截至某个 jseq 的整份收件箱快照」（jseq = journal 每条记录的序号）。页面只存选中、路由、弹窗、待定 chip（chip = 行旁的小状态标签）、连接状态这些界面状态，画面 = render(最新快照, 现在)。
- **怎么更新**：一条 SSE 流（SSE = 服务器单向推送的长连接）。M0 只发整份快照（≤500 条，≤256 KB），不发增量。增量帧的形状先留好，M2 前按实测决定要不要开：快照大小或份数超过门槛才开（r4:2099 的观察者协议是给主代理与 Maestro 的，不是给浏览器定的期限）。
- **动作怎么算数**：每次人类动作带页面生成的 actionId（每次动作的一次性编号），daemon 按 journal 去重。结果只有在流里出现才算数，从不乐观显示、从不自动重试。
- **组件怎么写**：不用库、不构建。每行从 `<template>` 克隆，只写 `textContent`，按条目 id 复用节点（键控补丁）；「这一行该长什么样」由纯函数算出（描述符）；配一个约 120 行的假 DOM，在 node:test 里测。
- **按键**：一张命令表同时生成快捷键、行提示和 `?` 帮助，M1 再用它生成 Ctrl+K 面板。
- **工期**：UI 两轮合计约 +1.45 天工作量（第一轮 +1.0，第二轮净 +0.45），取代开眼笔记 §7.5 的人这一端档（原文第二档，约 1–2.3 天），不另加；步骤 17（toast）移到线 C（D-10）。连同已提交的第 2b 步（a83826d）和第 2c 步（安全档其余五条里的三条，加一条仓库测试，D-19，正在另一个会话里做；另两条不在 2c 里：环境时钟进步骤 3 的 Clock 扫描规则，算在步骤 3 里；脚本也走 boot 没估、没排，推断 ≤0.05 天，见 D-19），关键路径约 18.3 天；只算 2b 约 17.45 天。这两个数都按 D-17 的默认抵掉了 0.25 天，抵扣是推断，抵不掉时各加 0.25（约 18.55、17.7 天）。细账见第八节。

和 §7.3 走得不一样的地方逐条列在第九节。要你定的见第七节：D-15（通知何时回执）、D-16（seen 从哪来）、D-17（ui-only 还发不发网页，第 4 步开工前定）、D-18（页内提示），以及 D-19（安全档：工期和一处安全取舍，另带两处 r4 措辞）、D-20（门脚本档和 agent 定义）；D-12 第二轮加了一条⑤（自动改选后先按 j/k）。

## 一、状态模型与协议

**1. 一条流，五种帧**。`GET /api/events?tab=<uuid>&perm=<granted|denied|default>&why=<open|reload|gap|stale|probe|backpressure>`，三个参数按正则或枚举校验，照旧要 cookie 和 `Sec-Fetch-Site`。不发 `retry:`：重连全由 `ui/conn.js` 管，浏览器自己的重连不用（见 4）。每帧是 `event: <种类>` 加一行 JSON，形状写在 `shared/protocol.js`（v=1）。

| 帧 | id | 内容 | 什么时候发 |
|---|---|---|---|
| `snapshot` | `<bootId>.<jseq>` | `{v, bootId, jseq, srev, serverWall, tickMs, profile, mode, modeReasons, status, items, clipped, later, reminders, ended, recentActions}` | 每条连接的第一帧；之后每批提交只要改了视图或记下一次人类动作，就发一份 |
| `status` | 无 | `{bootId, srev, status}`，整个替换 | 源健康（含「停摆」，见第四节）、刹车可用性、通知路由、toast worker、活流数、`tuningRev`、`snippetRev`（片段被清除或过期删掉时加 1）、`dshOrigin`（你粘贴的 `/connect` URL 的 origin，不带 token 和路径）变了就发；不进 journal |
| `tick` | 无 | `{bootId, jseq, srev, serverWall}` | 每 5 s；`jseq` = 这条流上最后交给 `res.write()` 的那份快照的 jseq（不是最后编码的那份）；流「脏」时不写 tick（见 3） |
| `notify` | 无 | `{itemId, attempt, sev, title:{key,args}, project}` | 条目该通知时，只发给一条流（见 6） |
| `bye` | 无 | `{reason: shutdown\|superseded\|replaced\|backpressure}` | 发完就结束响应；页面怎么接每一种见 4 |

- `delta {jseq, prev, upserted, removed}` 只在 `shared/protocol.js` 里留形状（和 r4:2099 观察者协议同形），M0 不发。
- 快照字段：`items` 只含 open 和 seen 的条目（上限 500，多出的条数记在 `clipped`，页面底部写「另有 n 条没显示」；字段不叫 truncated，因为扫描规则 `ban:truncate` 在 src、shared、ui 里禁这个子串）；`later:{snoozed, nextWall}`、`reminders:{pending, nextWall}` 是计数，页面折成底部一行，不悄悄藏掉；`ended` 是最近 20 条结束的条目；`recentActions` 是最近 64 条人类动作的结果，只从 journal 尾部的 `human.result` 读（见 5），跨重启。
- ui-only 发不发页面视 D-17。推荐默认是 M0 不发：ui-only 照第 2 步的现状打印每条原因、以 ui-only 退出码（22，`src/runtime/exit.ts`）退出，不起 HTTP，本文所有 ui-only 的写法都不实现；`mode`、`modeReasons` 和错误码 `ui-only` 只在 `shared/protocol.js` 里留着。你选「发」时才照下面做：ui-only 没有 journal，也发快照，`jseq: 0`，`items`、`ended`、`recentActions` 是空数组，`later`、`reminders` 的计数是 0，`mode:'ui-only'` 加 `modeReasons`。

**2. 载荷形状**：
- `ItemView {id, rev, kind, group, sev, state, conf, project{id,name,hue}, harness, own:'observed', part{ref,short}, committedWall, committedJseq, notify:'none'|'pending'|'handed', title:{key,args}, verbs[], open:{kind}, reminder?:{text, textState}}`。`rev` 是最后一次变化的 jseq，`committedJseq` 是条目创建那批的 jseq，两个都由 apply 写进 `inbox_item` 的两列（步骤 3），能从 journal 重建；`hue` 取 0–11；`reminder` 只有提醒条目带，通知正文就取它。
- `EndView {id, kind, project, end, cause:'human'|'source'|'clock', endedWall, endedJseq, actionId?}`，`end` 取 `shared/protocol.js` 里的结束类枚举（步骤 3 建并冻结，`model/inbox.ts` 引用它）。
- `ActionOutcome {actionId, verb, itemId?, outcome:'applied'|'noop:<原因>'|'unknown', jseq, bootId, brake?}`，只从 journal 的 `human.result` 记录读（见 5）；`unknown` 有两个来处：启动对账给孤儿 `human` 补的（按构造只有刹车会留下没有结果的 `human`），和 dsh-connect 的 fetch 超时（见 5）。
  - 只有刹车执行带 `brake: {commandId, subtrees:[{root:{pid, createTime}, requestId, killed, residual, status:'ok'|'partial'|'refused'|'unknown'}]}`。一个 actionId 下可以有几棵子树，每棵各有自己的 procguard `requestId`，`commandId` 指向步骤 6 的 Command 记录。
  - 页面照它拼刹车的结果，按这个先后看：`outcome:'unknown'` 或有子树 unknown →「刹车结果不明」（daemon 动过手，但 procguard 没给出结论：要你看进程树或重新出计划）；有子树 refused →「没刹 n 棵：执行前核对没过（进程变了、根成了多会话宿主，或核对超时），重新出计划」（daemon 没动手）；有残留 →「部分残留」；每棵都是 ok 且残留 0 →「已刹车 n 个进程 · 0 残留」。「计划过期」不走这里，是 409 `plan-expired` 的回复（见 5）。
- 源里来的任意文字不进帧。标题是 `{key,args}`，`args` 只取枚举、数字和三种过了格式检查的 journal 字段：
  - 工具名要匹配 `^[A-Za-z0-9_.:-]{1,64}$`；版本要匹配 `^\d{1,5}(\.\d{1,5}){1,3}([-+][0-9A-Za-z.-]{1,32})?$`；
  - cwd 末段不能含控制字符或 Cf 类字符（零宽和双向控制：U+200B–200F、U+202A–202E、U+2066–2069），不超过 32 个码点；
  - 过不了就不用它：工具名、版本换成「未知」，cwd 末段换成项目 id 的短形式。正则写在 `shared/protocol.js`（步骤 3），由 `server/view.ts` 套用。agent 能 cd 进一个名字精心构造的目录，系统通知又收不回，所以这一步不能省；`shared/sanitize.js` 只剥 C0/C1/ESC，拦不住双向控制字符。
  - `project.name` 默认就是 cwd 末段，所以在每一种帧（快照、notify）和 toast 里都过同样的检查，过不了就换成项目 id 的短形式；只有你在 Tuning 里改过的名字免检（那是你自己写的字）。
  - 页面和 toast 用同一个 `shared/strings.js` 拼字；低置信类别的标题 key 带「推测」，文字以「推测：」开头（`strings.test` 逐个查通知标题 key）。
  - 唯一例外是你自己写的提醒文字（≤120 个码点，带 `textState`；`POST /api/reminders` 超了回 422 `text-too-long`，不悄悄截短，输入框显示剩余字数）：没触发的提醒片段本来就钉住；触发后过了 TTL 被清掉时，下一份快照显示「已清除」，这是「画面只由 jseq 决定」的一处写明的例外（推断）。
- Peek 和「打开」的细节走 `GET /api/items/:id/detail`：`{asOfJseq, item（已结束的也带结束类）, peek:{events, text, textState: present|expired|purged|lost}, open:{resume|native|dsh-link|none 的细节}}`。Peek 开着时，`item.rev > asOfJseq` 或 status 的 `snippetRev` 变了就重取（清除和 TTL 过期不产生 jseq，所以另用这个计数）。Peek 开着时跟随选中：选中变化 150 ms 后才取 detail，用 AbortController 取消上一个请求，同时至多 1 个 detail 请求在途（计时经 `ui/clock.js`），免得连按 `j`/`k` 时一串 detail 请求排在刹车 POST 前面。它替换原计划的 `GET /api/items`。

**3. 次序、补发、多标签**：
- 只有快照带 jseq。`status` 用自己的 `srev`（同一次启动内递增），`tick`、`notify`、`bye` 不带 id，所以 jseq 只有「journal 次序」一个意思（P1）。
- 服务端次序（单线程）：journal fsync → db 事务 → 本批改了视图就编码一份快照（所有流共用同一份字节，没有流就不编码）→ 按登记顺序写给每条流 → 路由 notify。新流的快照读取和登记在同一个同步回合里完成。`notify` 帧总排在它依赖的那份快照之后。
- 页面 reduce：同一 bootId 下比手上旧的快照丢掉并计数；bootId 变了就整份替换，显示「orchestrad 重启过」；`tick.jseq` 和手上的 jseq 不等算缺口（只有 bug 才会出现，目标 0），关流、带 `why=gap` 重开、拿新快照（为什么这不算开眼 §7.6 否掉的在线对账，见第九节末）。
- 不认 `Last-Event-ID`，删掉从数据库补发。重载和新标签本来就不带这个头；重连就是再拿一份快照，只有一条读路径。
- 慢流合并：上一帧还没写进内核（`write()` 返回 false、还没 drain）时不排第二份快照，只记「脏」，drain 时发最新那份（计 `sse.coalesced`）。流脏时 tick 和 notify 也不写：drain 时先写最新快照，再写排着的 notify，然后恢复 tick；这样 tick 报的 jseq 一定已经写出去了，不会造成假缺口。notify 选流时先跳过脏流，只剩脏流时才排在它的待发快照后面。未发字节超过 1 MiB 就发 `bye{backpressure}` 并断开（计 `sse.drop`），页面重连拿快照。每个缓冲都有闸（P2）。份数超标时的 100 ms 尾随合并见第四节预算表。
- 多标签：每个配对会话最多 2 条活流。第 3 条连上时，最老的那条收到 `bye{superseded}`。同一 tab id（存在 sessionStorage）再连时，旧连接收到 `bye{replaced}`，不进墓碑，所以重载只替换自己。tab id 只在重载时沿用：导航类型（`ui/clock.js` 读 `performance` 的 navigation 条目）不是 `reload` 的，例如新开、「复制标签页」、前进后退，一律换新 id，因为 Chrome 的「复制标签页」会连 sessionStorage 一起复制。被 `superseded` 顶掉的 tab id 进墓碑（每会话至多 64 个），再连得 409，不会来回抢。被顶掉的页面（`superseded` 或 `replaced`）不自动重连，显示「已在另一个标签页打开 · 在此使用」，点了换一个新 tab id。理由：明文 HTTP/1.1 每个主机只有 6 个连接，toast 点开的新标签越积越多，刹车 POST 会排队；新标签要能赢，因为它通常是你刚点开的那条深链。

**4. 连接状态与过期显示**（`ui/conn.js`，纯函数 `next(state, event, mono)` 加一层薄驱动）：

| 状态 | 进入 | 钟或闸 | 页面显示 |
|---|---|---|---|
| connecting | 打开页面，或探测要重开 | 先经 `ui/api.js` 的 `getSession(tabId)` 取 `GET /api/session?tab=`（CSRF 令牌、bootId、superseded），拿到 200 才新开 EventSource（探测刚拿到 200 时直接用那次的回复）；10 s 没快照 → 关流、探测 | 连接中 |
| live | 收到快照 | 20 s 没有任何帧 → stale；`error` 事件或 `bye` → 关流，按原因走（见下） | 正常 |
| stale | 20 s（4 × tick）没帧 | 每 20 s 关流、探测一次 | 横幅「数据截至 hh:mm:ss · jseq N」，标题加「[未更新]」；不闪不响 |
| down | 探测遇到网络错误，或 5 s 没回复 | 5 s 起退避到 30 s 再探 | 连不上 orchestrad（原因见启动它的控制台） |
| refused | 探测得 200，流却在第一份快照之前又失败；或探测得 200、403 以外的状态码 | 和 down 一样 5–30 s 退避 | 连接被拒（状态码 N） |
| unpaired | 探测得 403 | 等你输配对码 | 配对页。页面之前拿到过 bootId，就写「orchestrad 重启过，控制台里有新配对码」；没拿到过，写「需要配对：配对码在启动 orchestrad 的控制台里」 |
| superseded | `bye{superseded}`、`bye{replaced}` 或 409 | 等你点「在此使用」 | 见上 |

- 先取 session、再开流：CSRF 令牌只在 session 的回复里，client-state 和通知回执都要带它。先开流的话，令牌到手之前来的 notify 回执会得 403，1.5 s 后转 toast，还把这条流标成「回执失败」。重载和重新配对之后也一样先取。
- 新鲜度和连接状态分开算：新鲜度 = 现在的单调钟 − 收到最后一帧时的单调钟（都经 `ui/clock.js`）。超过 20 s，不管在哪个状态（connecting、down、refused、unpaired 也一样），存在时长都变灰，「数据截至」横幅和「[未更新]」都在。「现在没有要你处理的事」只在 live 而且新鲜时显示，其余情况显示过期或连不上的那句（第四节）。这样一个看不见的页面不会说「没事」。
- 重连只由 `conn.js` 发起。EventSource 的任何 `error` 事件、任何 `bye` 帧，都先 `es.close()`。理由：网络出错时 EventSource 不进 CLOSED，而是停在 CONNECTING 自己隔几秒重试，这会绕开 down 的退避，也会让「连不上」晚到约 30 s。
- 关流之后按原因走：
  - `error`：立刻探测一次。
  - `bye{shutdown}`：等 1 s 再探测。旧的监听可能还没关，立刻探测会得 200、重开又马上失败。
  - `bye{backpressure}`：1 s 后带 `why=backpressure` 重开，拿新快照。
  - `bye{superseded}`、`bye{replaced}`：进 superseded，不重连。
- 探测也走 `getSession`：200 重开（回到 connecting），403 进 unpaired，网络错误或 5 s 没回复（超时经 `ui/clock.js`）进 down，其他状态码进 refused，`superseded:true` 进 superseded；同时只有一个探测，所以探测本身必须有超时，不然一个挂住的探测会把状态机冻在原地。页面重新可见时立刻重算一次。没有这一步，daemon 每次重启后 SSE 都得 403，页面会一直转圈。
- 结果：daemon 进程退出时连接当场断开，`error` 事件马上到，探测随即失败，显示「连不上 orchestrad」。多快能到是推断、未测：Windows 上连一个关着的回环端口通常要约 2 s 才被拒，`orchestra.localhost` 又会先后试 ::1 和 127.0.0.1，所以约 2–4 s。手动检查的门槛是 5 s 加一次渲染；探测按 5 s 超时判成 down 也算过。实测值记进验收记录。daemon 卡住但没退出时，20 s 后显示过期。
- 时间：ui/ 里只有 `ui/clock.js` 能读时间。displayNow = 最近一帧的 `serverWall` +（`performance.now()` − 收到那帧时的值）。`render(view, displayNow)` 是纯函数，存在时长随 tick 刷新。浏览器的 Date 从不和 daemon 的时间相减（P4）。

**5. 变更与人类动词怎么算「做成了」**：
- 写 human 记录的 POST（seen、snooze、acted、reminders、brake/execute、roots/*、protect/*、dsh-connect、self-rating）在 JSON 里带 `actionId`：动作发生那一刻由 `ui/api.js` 用 `crypto.randomUUID()` 生成，同时记下当时的 itemId。「那一刻」是按下键、点击、点开通知，或者 seen 的停留计满（见第三节 1）的那一刻；没有按键时也是同一个规则。不带的：pair、notify-ack、client-state（按自然键幂等）、brake/plan（只出计划，不引起转换）。
- daemon 按 (actionId, requestDigest) 去重，requestDigest = sha256(canonical(路由, 参数, 去掉 actionId 的 body))。名字故意和 journal 行自己的 `digest`（盖整个 body，含 actionId）分开：拿行 digest 重建去重表，重启后的正当重试会被当成 422 `actionId-reused`。例外：`dsh-connect` 的 body 里有 `/connect` URL 和 token，它的 requestDigest 只盖路由，不盖 body，免得 token 的哈希落进 journal 和去重表（r4 §10.11：token 当场丢弃、不落库）；代价是这条路由认不出「同 actionId、不同 URL」。
- journal 里一次人类动作分两条记录：
  - `human {actionId, verb, targetId?, requestDigest}`：targetId 是条目 id、根 id 或 pid:createTime。刹车的 `human` 在检查顺序那一串都过之后、执行第 1 步（重新取快照核对谱系）之前写（不是一过去重那一格就写：后面的检查拒掉的请求不留 `human`；执行一开始就不再回 4xx，核对没过的子树记 `refused`，照常写 `human.result`）：杀进程要等 Command 的结果，中间可能崩溃，要留下「动过手」的证据。其余动词（标记类、提醒、roots、protect、dsh-connect、自评）的 `human` 在效果之后和 `human.result` 同批写，所以按构造不会留下没有结果的 `human`。
  - `human.result {actionId, outcome, commandId?, subtrees?}`：只在效果之后写。标记类和它引起的转换同批提交；刹车要等 Command 的结果回来才写。`recentActions` 只从 `human.result` 读，所以刹车在真杀完之前不会显示成功（P5 = 标记后于效果）。
  - 启动对账时，任何有 `human` 没有 `human.result` 的动作都补一条 `outcome:'unknown'`，in-flight 随之结束，同 actionId 的重试拿到这个结果，不会永远 409。按构造只有刹车会这样；万一出现别的动词（例如 journal 被手工改过），chip 写「结果不明」，和「刹车结果不明」分开。
  - 非刹车动词在效果做到一半时崩溃，journal 里什么也没有，同 actionId 重试会再做一次。这几种动作重做一次无害：protect、roots 按自然键写，dsh-connect 的 token 不落库，重试要你重新粘贴（推断）。
- 去重表启动时从 `human` 记录的 (actionId, requestDigest) 重建，所以重启前后重试都不会做两次。查重在追加 journal 之前做，重复的 actionId 进不了 journal。0001 里 `human` 是一种 event kind，actionId 上建部分唯一索引（只管 kind = human），投影的 apply 用 `INSERT OR IGNORE`：万一有重复漏进 journal，apply 和以后每次重建都跳过它并记 metric `journal.dupAction`，不会失败（计划不变量 22）。
- 光有这张表还不够：主线程虽然是单线程，`protect/*` 要 await procguard、`dsh-connect` 要 await fetch，而非刹车动词的 `human` 要等效果做完才写；await 期间同 actionId 的重试在表里查不到，会把效果再做一次，409 `in-flight` 也永远不出现。所以步骤 4 的 `server/idempotency.ts` 另有一张内存里的 in-flight 表：请求一过了去重那一格就登记 (actionId, requestDigest)（还没做后面的检查），每个动词都登记；后面任何一格拒掉都算请求失败，当场删掉；`human.result` 那批提交时，同一个同步回合里先把这个 actionId 记进去重表、再删 in-flight，中间不留两张表都查不到的空当。去重那一格先查它、再查重建的表。`dsh-connect` 的 fetch 经 Clock 有 10 s 超时（推断），超时写 `human.result`（`outcome:'unknown'`：请求已发给 DSH，不知道它收没收下），in-flight 随之结束。约 0 d；步骤 3 的两种记录何时写不变。

检查顺序固定：鉴权（403）→ ui-only（503，只在 D-17 选「发」时有这一格）→ 带没带 actionId（400）→ 去重（原样回复 / 409 / 422）→ 条目在不在（404）→ 条目已结束（`noop:already-ended`）→ 动词在不在 `item.verbs`（422）→ 动词自己的检查（例如刹车的三个码）→ 执行。已结束的条目没有动词，所以「已结束」必须排在动词检查前面；不然动词和自动清除撞在一起时，页面会显示「被拒绝」，而不是「无需操作」。

| 情况 | 回复 |
|---|---|
| 同 actionId、同内容 | 原样回复，加 `replayed:true`，不写新记录 |
| 同 actionId，第一次还在处理 | 409 `in-flight`（页面显示「仍在处理」，chip 留着、钟重新计） |
| 同 actionId、不同内容 | 422 `actionId-reused` |
| 没带 actionId | 400 `actionId-missing` |
| 动词不在 `item.verbs` 里 | 422 `verb-not-allowed` |
| ui-only 模式（只在 D-17 选「发」时） | 503 `ui-only` |
| 没有这个条目 | 404 `item-unknown` |
| 条目已经结束 | 照收，结果记 `noop:already-ended` |
| 提醒文字超过 120 个码点 | 422 `text-too-long` |
| 刹车：procguard 还没确认保护名单 | 503 `brake-unavailable` |
| 刹车：测试 profile 下不是登记过的测试根（含还没解析、被拒、createTime 对不上；具体原因只进日志，推断） | 422 `not-test-root` |
| protect：procguard 超时，保护名单没改成（推断） | 503 `procguard-timeout`，页面显示「保护名单没改成，可重试」；不写 journal，in-flight 当场删 |
| 刹车：计划过期（单调钟和墙钟哪个先到点，见第三节 3） | 409 `plan-expired`，弹窗显示「重新生成」 |
| 成功 | `{actionId, accepted:true, jseq}` |

- 4xx 和 503 只走 HTTP 回复，不写 journal；`applied`、`noop`、`unknown` 写 `human.result` 记录，并出现在下一份快照的 `recentActions` 里。`unknown` 来自启动对账（任何孤儿 `human` 都补一条，按构造只有刹车会有孤儿）和 dsh-connect 的 10 s 超时（见上）。HTTP 200 只说明「收下了」，chip 只在流里见到这个 actionId 才变「已生效」（P5）。
- chip 按 actionId：已发送 → 已生效 / 无需操作：已自动清除 14:02 / 被拒绝：〈原因〉 / 仍在处理（409 `in-flight`）/ 刹车结果不明 / 结果不明（非刹车动词：dsh-connect 超时，要你看 Tuning、需要就重新粘贴；或启动对账补的，按构造不出现）。
  - 标记类 5 s、刹车执行 15 s 没结果，显示「还没收到结果 · 查看」，这时用同一个 actionId 手动重试是安全的。它和「刹车结果不明」是两个符号、要你做两种事（P1），文字和 `static-render.test` 都要求两者不同。
  - bootId 变了而 `recentActions` 里没有它，显示「还没收到结果 · orchestrad 重启过」。从不自动重试；你手动重试时沿用同一个 actionId。
  - in-flight 也有钟：procguard 每个请求 10 s 超时（暂定，步骤 6），kill-tree 请求超时的那棵子树记 `status:'unknown'`（执行第 1 步核对用的快照超时记 `refused`：那时 daemon 还没动手），结果照常写进 `human.result`，in-flight 随之结束；dsh-connect 的 fetch 10 s 超时（推断，步骤 15）同理，结果记 `unknown`。`protect/*` 遇到 procguard 超时没有子树可记，算请求失败（推断）：不写 journal，删 in-flight，同 actionId 重试会再做一次（按自然键写，无害）。
- 待定表要活过重载：daemon 重启后页面会走 403 → 配对 → `location.reload()`，模块内存清空，这时新 bootId 的快照还没来。所以待定表经 `ui/prefs.js` 存进 sessionStorage，每条 `{actionId, verb, itemId, bootId, sentWall}`（`sentWall` 取 displayNow），重载后第一份快照到了再和 `recentActions` 对：对上了显示结果；bootId 变了又没对上，显示「还没收到结果 · orchestrad 重启过」，可以用同一个 actionId 手动重试；超过 10 分钟的条目丢掉。存储不可用时（try/catch 抓到），重载后这些 chip 就没了，结果只能从条目状态和 `ended` 里看。

**6. 通知回执与「在线」的判定**：
- `client-state {tabId, visibility, frozen, permission, perf?}` 只在变化时发：流打开、visibilitychange、权限变化、`freeze`、`resume`、`pagehide`（`freeze`、`pagehide` 用 `keepalive`）。可选的 `perf` 是步骤 19 的 UI 时延样本，只随变成隐藏和 `pagehide` 那两次一起发，从不单独定时发；形状在步骤 3 留好，M1 再加 `views`。发送方不自己调 `fetch`，调 `ui/api.js` 的同步帮手 `sendClientState(state, {keepalive})`；扫描只许 `ui/api.js` 出现 `fetch`。不用 setInterval：Chrome 把隐藏 5 分钟以上的标签页的定时器压到每分钟一次，原计划的 15 s 心跳加「30 s 没报算离线」正好会在你离开时把通知全改走 toast。
- 「可通知的客户端」= SSE 流开着、没冻结、权限 granted、没标「回执失败」。`notify` 只发给一条流：最近可见的那条，没有就最新的那条，所以不会两个标签同时响。
- 页面收到 `notify` 同步做两件事：`new Notification(...)`，紧接着调 `api.ackDispatched(itemId, attempt, tabId)`。这个帮手在 `ui/api.js` 里用 `keepalive` 发 `POST /api/notify-ack {itemId, attempt, tabId, phase:'dispatched'}`，不返回 promise。中间不 await、不等 rAF（rAF = 浏览器每画一帧前调一次的回调；隐藏标签页不画，所以不调）。第一次 dispatched 回执先只记下到达时刻；这次尝试的 1.5 s 窗口（经 Clock 端口计时）过完、没来 `phase:'error'`，才写一条 journal，把 `notifiedAt` 设成那个到达时刻。窗口里来了 error，就不设、转 toast，`notifiedAt` 由 toast 的 `shown` 设。之后的 dispatched 只回 200 dup。这样 journal 不会在浏览器报错之后还写着「已通知」（P5）；回执和 error 两种先后各有一例测试。这是 D-15 的推荐默认，另一种做法（等 `show` 再回执）见第七节。
- 系统真的显示时（`show` 事件）再经 `api.ackShown(...)` 报 `phase:'shown'`，只进 metric 旁表，用来报「交给系统 → 显示」的 p99 和「没显示」的 k/n。`error` 事件经 `api.ackError(...)` 报 `phase:'error'`，daemon 收到就立刻转 toast，并给这条流标「回执失败」。不拿 show 当回执的理由是「勿扰模式下 show 可能永远不来」，这一点未核实：如果 Chrome 在把通知交给 Windows 时就触发 show，那「交给系统 → 显示」的 p99 和「没显示」的 k/n 什么也没量到（P7）。所以 18A 用这两个数之前，你在场时开着勿扰（专注助手）弹一条，看 show 何时来、来不来（计划 §5 清单第 5 条）。界面写「已交给系统」，不写「已看到」。
- 1.5 s 没收到 dispatched 回执就转 toast，并给这条流标「回执失败」。这个标记有出口：同一个 tab 发来 `visible` 且没冻结的 client-state（包括 `resume`），或者这条流重连，就清掉；Tuning 的通知面板对带标记的标签页写「此标签页暂不接收通知」。原计划写的是「直到它下一次回执成功」，可带标记的流不再收 notify，永远等不到那次回执：一次偶然的冻结就让这个标签页之后的通知全走 toast，状态既没有钟也没有出口（P2）。

**7. 什么在哪算**：daemon 算分组、级别、verbs、结束类、标题的 key 和 args、snooze 落到 UTC 毫秒（写进 journal）、打开目标、通知路由和 status。页面只算存在时长、排序（共用 `shared/protocol.js` 里的比较函数：分组 → 级别 → committedJseq → id）、选中、路由、弹窗、chip、连接状态和标题角标。

## 二、组件写法

**M0：不用库、不构建。** `/` 发 `ui/index.html`，`/assets/ui/*` 和 `/assets/shared/*` 按白名单从内存发（ETag = sha256，`no-cache`，不要 cookie）。URL 布局和仓库一致，`'../shared/x.js'` 在浏览器和 node:test 里解析到同一个文件，用不着 import map（那是内联脚本，CSP 不许）。

| 文件 | 做什么 | 规则 |
|---|---|---|
| `ui/index.html` | 静态壳：各个 `<template>`、四个分组区、一个 `<script type=module>` | 没有内联脚本、`style=`、`on*=` |
| `ui/app.js` | 只做接线 | 唯一有顶层副作用的模块 |
| `ui/store.js` | 纯 `reduce(state, frame)` 和选择器（行、分组计数、角标、下一条） | 输入深冻结测试 |
| `ui/conn.js` | 连接七态机和 EventSource 驱动 | 唯一的 `new EventSource('/api/events…')` |
| `ui/clock.js` | 时间、定时器、rAF、导航类型；步骤 19 的 PerformanceObserver 也在这里，`ui/perf.js` 只消费它 | ui/ 里唯一能读时间、碰 `performance` 的文件 |
| `ui/prefs.js` | tab id、单键开关、待定动作表 | 唯一碰浏览器存储的文件，全部 try/catch |
| `ui/api.js` | POST、actionId、待定表、超时 | 唯一的 `fetch`，第一个参数总以 `/api/` 字面量开头；只导出具体的帮手（`getSession`、各动词、`ackDispatched`、`ackShown`、`ackError`、`sendClientState`、配对和 dsh-connect 的提交），不导出通用的 `post(url)`；CSRF 令牌只放模块内存 |
| `ui/view.js` | 纯函数描述符 `describeRow/Group/Empty` → `{key, cls, data, text}` | 不碰 DOM |
| `ui/dom.js` | 唯一写 DOM 的文件 | 见下 |
| `ui/commands.js`、`ui/hotkeys.js` | 命令表；纯 `keyToCommand(event, ctx)` | 见第三节 |
| `ui/route.js` | 纯 hash 解析；外链校验 | 唯一能开窗口或导航的文件（`location.hash =`、`location.reload()` 除外） |
| `ui/notify.js`、`peek.js`、`dialogs.js`、`kill-dialog.js`、`tuning.js`、`pair.js` | 各自的界面 | 纯函数部分单独可测 |
| `shared/protocol.js` | 帧种类、载荷字段、verbs、错误码、结束类、ActionOutcome 枚举、行比较函数、id 和标题 args 的正则 | 两端共用；枚举和正则由步骤 3 建并冻结，`model/inbox.ts`、`server/routes.ts` 引用它；帧与载荷形状在步骤 4 冻结 |
| `shared/strings.js` | 全部中文文字和 `{key,args}` 拼字 | 页面和 toast 共用；不许出现「完成」 |

- `ui/dom.js` 的写法：每行从 `<template>` 克隆；只写 `textContent`、`dataset`、`classList`，值没变就不写；按 itemId 的 Map 复用节点；重排用 `moveBefore`，没有就 `insertBefore` 再按 itemId 还焦点；焦点在列表上时不重排（D-12 ④，见第三节 1）；roving tabindex。P0 的告警图标和闪烁靠在三个预先写在 `index.html` 里的 `<link rel=icon>` 节点之间切换（第三节 4），不写 `.href`。页面可见时一帧合并成一次 rAF 渲染，变可见时同步渲染一次，隐藏时不渲染；reduce、回执、通知照常立刻跑。
- 命名纪律（现有扫描本来就管，范围是 `src/`、`shared/`、`scripts/` 全部，不只 `shared/`）：连注释也不能出现 `fetch`（`dsh-connect.ts`、`boot.ts`、`import-fence.ts` 除外）、`EventSource` 和 `WebSocket`（`import-fence.ts` 除外）、`.constructor`。步骤 4、5 新写的 `server/sse.ts`、`notify/channel.ts` 这类文件，注释里写「SSE 客户端」「浏览器的推送连接」「保活请求」，不写这些词。任何地方不出现 `truncate`、`symlink`、`link(`，截断函数叫 `clip()`。

**怎么长**：
- M1 乐手页：同一条流加集合（乐手、乐章、审批、Decision 等），同样的帧种类。对话用临时 chunk 帧 `{partRef, msgId, seq, text}`，`Text.appendData` 追加，正式消息落库后替换（P5）；打开哪几页由 client-state 的 `views` 字段报给 daemon，chunk 只推给订阅了的标签，换页不重连（挑战稿的提议；放在流的 URL 上，每换一页都要重开流、重拿整份快照）。Ctrl+K 面板从 `commands.js` 生成（约 150 行、0.5 d，记在 M1）。markdown 只渲染已闭合的块，做法按 D-14。
- 手写渲染撑不住时（`dom.js` 超过 400 行，或实测补丁 p99 > 50 ms），再把 VanJS 1.6.1（MIT，约 1.2 KB gz，只用 createElement）作为新的用户决定提出。注意：现有扫描的 `vendor-type-only` 对 ui/ 也生效，vendor 进来要改一条扫描规则，这个成本要一起报。
- M2：Stage 用 createElementNS 画 SVG，走同一个补丁器；Ledger 用 canvas。快照超门槛时开 `delta` 帧。M2 真要第二块屏常开时，再看 Web Locks + BroadcastChannel。
- M3：Score 回放 = 同一个 reduce 跑在 `GET /api/frames?to=<jseq>` 上，由同一个编码器从 journal 重编。

**测试**：纯模块直接 import（`load-pure` 测试保证除 `app.js` 外都不碰 document）。`test/helpers/fake-dom.ts`（约 120 行）实现 Element、Text、template、dataset、classList、moveBefore 和焦点，碰 `innerHTML`、`outerHTML`、`insertAdjacentHTML` 就抛错，用来测 `dom.js` 的节点复用和操作数。不加 jsdom、Playwright 或任何新依赖；样子在测试 profile 下手看。

## 三、交互模型

**1. 键盘语法**。单键只在焦点在收件箱列表（`role=grid`）或页面 body 上时生效，焦点在输入框里一律不认；Tuning 有「单键快捷键」开关（WCAG 2.1.4）。`g` 组合键全局有效。一律忽略：`isComposing`、`keyCode` 229、key `Process`、`e.repeat`、按着 Ctrl/Alt/Meta（组合键除外）。

| 键 | 动作 | 来源 |
|---|---|---|
| `j`/`k`、↓/↑、Home/End | 移动 | r4 + 别名 |
| `o`、Enter | 打开 | r4 + 别名 |
| `p`、Space | Peek | r4 + 别名 |
| `s` | 稍后：1 = 15 分钟、2 = 1 小时、3 = 今晚 20:00、4 = 明早 9:00、5 = 自定（datetime-local） | r4 |
| `r` | 设提醒（datetime-local，默认 +1 小时，可写文字） | r4 |
| `e` | 处理完（acted），只在 `item.verbs` 有它时 | 新 |
| `n` | 下一条要你看的：open 先于 seen，再按级别、committedJseq，跨分组跨项目，到底回头 | 新 |
| `K`（Shift+K） | 刹车 | r4 |
| `?` | 帮助层（从命令表生成） | 新 |
| `g p` / `g t` | Program / Tuning；`g s`、`g l` 灰显预留 | r4 + `g t` |
| Esc | 关掉最上一层，从不执行动作 | 新 |

- 预留、不响应：`a`、`x`、`d`、`m`、`f`、`/`、`z`、列表上的数字、Ctrl+K。
- 动词绑定按下键那一刻选中的 itemId；弹窗里写出这条的项目和标题；弹窗开着时条目结束了，弹窗写明并禁用按钮。
- 防误触（r4 §10.9 r4:1663 的两半）：
  - 焦点在列表上时冻结排序：已有的行不换位置，新来的条目先排到各自分组末尾；按 `j`/`k` 或焦点离开列表时，才按比较函数重排一次（D-12 ④）。
  - daemon 推来的一份新快照把选中行的 itemId、屏幕位置或 verbs 改了之后 750 ms 内，`e` 和 `K` 不响应；你自己按 `j`/`k` 不触发（D-12 ③）。冻结排序之后，还会挪动选中行的只剩插入和删除。
- 选中是 itemId，不是下标。选中的条目消失时依次选：同组下一条、同组上一条、下一组第一条。自动改选之后（D-12 ⑤），`e`、`s`、`r`、`K` 都不响应（行提示写「先按 j/k 选一条」），直到你自己用 `j`/`k`、方向键或点击选中一行；hash 深链和 toast 落地的选中照旧可以直接动作。理由：M0 里这些动作都撤不回（没有 reopen、cancel 路由），而自动改选的行不是你挑的；750 ms 只挡得住「行刚在光标底下换掉就按键」，挡不住走开再回来。这和 §7.3 的空位效果一样，但不用多一种行状态。流里的更新从不移动 DOM 焦点，只在焦点所在行被删时把焦点救回列表。
- seen（D-16 的推荐默认）：
  - 算：你主动选中一行（`j`/`k`、方向键、Home/End、点击）之后，在它上面停留 ≥500 ms（页面可见且有焦点）；或者 peek、打开、点通知。
  - 不算：载入时的默认选中、hash 深链和 toast 落地的选中、条目结束后的自动改选，以及用 `j`/`k` 扫过去。这几种选中都要你再动一次手，停留才开始计。
  - actionId：停留计满的那一刻由 `ui/api.js` 生成，itemId 取你主动选中的那一行；点通知时在点击处理函数里生成。
  - seen 是 noticed 的证据，不算「干预」：干预只数改变条目或进程的动作（snooze、remind、acted、刹车执行、roots、protect、dsh-connect），peek 和打开也不算（推断；计划 §2.2 第 13 条已改）。

**2. 命令表**。`ui/commands.js` 每行 `{id, keys, scope, labelZh, level, verb}`。同一张表生成：hotkeys 的映射、选中行的提示（只列 `item.verbs` 里有的，例如「o 打开 · p 预览 · s 稍后 · K 刹车」）、底部图例、`?` 帮助层；M1 的 Ctrl+K 面板也读它。测试保证每个键在每个作用域只有一个意思，键和提示不会各说各的。
- Ctrl+K 面板（M1）：备用键 Ctrl+Alt+K；前缀 `>` 动词、`@` 乐手、`#` 项目、`!` 条目 id；先选条目再选动词；子序列打分，关键词含英文别名和拼音首字母；破坏性动词永远不是 Enter 的默认项。

**3. 确认级别**：
- 浏览（open、peek、g 跳转）：不确认。
- 标记（seen、snooze、remind、acted）：不确认，出 chip；都写 journal。M0 里 acted、snooze、remind 都撤不回（`z` 撤销不做，见第六节），所以误触靠两道闸挡：750 ms（第三节 1）和「自动改选后先按 j/k」。
- 配置（roots、protect、dsh-connect）：显式按钮；移除保护要再确认；dsh-connect 输入框 `autocomplete=off`，提交后清空。
- ui/ 里任何地方都没有 `<form>`（扫描管，见第五节）：模块没载入、或处理函数在 `preventDefault` 之前抛错时，原生表单会用 GET 把配对码或 `/connect` 的 token 提交进 URL 和浏览器历史（不变量 14、r4:1698）。输入框都不带 `name`（扫描规则 `ui:input-name`，见第五节），配对码输入框也 `autocomplete=off`；配对和 dsh-connect 只经 `ui/api.js` 的帮手提交。
- 刹车：`K` → `POST /api/brake/plan` → 原生 `<dialog>`：
  - 弹窗头写 harness、项目、pid 和创建时刻；下面是进程树，默认勾 RSS 最大的子树，可多勾（照计划 §2.2 第 2 条）。
  - 倒计时：计划回复带 `expiresAt`（daemon 的墙钟，计划生成时 +60 s），页面显示 min(`expiresAt` − displayNow, 60 s − 回复到达后页面单调钟走过的时长)，两项都经 `ui/clock.js` 读。取小的那个：daemon 墙钟往回拨时 displayNow 跟着跳，只看第一项会把倒计时拖长，第二项把它压在 60 s 内，和 daemon 判过期的两只钟一致。过期显示「重新生成」。daemon 判 409 `plan-expired` 时两只钟都算：计划记录存 `createdMono`（Clock 端口）、`ttlMs: 60000` 和 `expiresAt`，单调钟走满 60 s 或墙钟到了 `expiresAt`，哪个先到就算过期；墙钟往回拨拖不长杀进程的计划，往前拨只会让它提早过期（P4）。`expiresAt` 就是墙钟那一侧的到期时刻，同时给页面做倒计时。
  - 弹窗里没有 `<form>`，不会有隐式提交。「执行」是 `type=button`，只认点击和 Space：焦点在它上面时按 Enter 被拦下（`preventDefault`），什么也不发。PID 输入框里按 Enter、按 Ctrl+Enter 都什么也不发；`K` 也不执行。弹窗出现后 750 ms 内，点击和 Space 也不执行。初始焦点在树上。
  - 选中 harness 根或含受保护节点时，键入那个节点的 PID（`inputmode=numeric`，先做 NFKC，全角数字也认）。
  - 结果分五种：已刹车 n 个进程 · 0 残留 / 部分残留 / 没刹 n 棵 / 计划过期 / 刹车结果不明，文字两两不同（`static-render.test`）。除「计划过期」外都照 `ActionOutcome.brake` 拼（第一节 2），「计划过期」是 409 `plan-expired`。页面 15 s 没等到结果显示的是「还没收到结果 · 查看」，不是「刹车结果不明」（第一节 5）。
- M1 的 `a`/`x` 用同样的防误触（冻结排序和 750 ms 两半都用），高风险工具类再加键入确认；r4 D8 不变。

**4. 通知与深链**：
- `new Notification(title, {tag: itemId, body, requireInteraction: P0, renotify: P0 且 attempt > 1, silent: false})`；测试 profile 下标题带「[测试]」前缀。itemId → Notification 的 Map；条目离开 open/seen（结束或稍后）才 `close()`（从状态推出来，幂等）；seen 不收回，因为 500 ms 停留只是「可能看过」的证据，不够把系统里那条收掉。点击：`preventDefault`、focus、`location.hash = '#/item/<id>'`、发 seen。
- P0 分两层：
  - 标记：有未结的 P0 条目（open 或 seen）时，标题恒以「【P0】」开头、图标恒为告警图标，从状态推，不靠定时器。
  - 闪烁：有 open 且没 seen 的 P0、窗口又没焦点时，在标记之上再闪，直到 seen 或条目结束。闪烁只是装饰：交替闪时一半时间没有标记，隐藏标签页的定时器又会被压到每分钟一次，所以保证靠的是标记，不是闪烁。
  - 图标由 `ui/dom.js` 在三个预先写在 `index.html` 里的 `<link rel=icon>` 节点（普通、告警、告警高亮）之间切换，闪烁只在告警和告警高亮之间换；标题闪烁也只换「【P0】」后面的字，前缀一直在。不写 `.href`（扫描只许 `ui/route.js` 写 `.href =`）；声音用系统通知自带的（D-13），不用 WebAudio。
- 一次性的效果（系统通知、读屏播报）只由 `notify` 帧触发，不从快照的差异推，重连和重载后不会再响一遍。持续的标记（【P0】标题、告警图标、闪烁）和撤回（`close()`、停止闪烁）都从状态推，所以重载之后、在另一个标签页里也看得到；不然每次重启后都要重配对、重载，未结的 P0 就会一个标记都没有。
- 页头只显示通知权限。「本次启动已交给系统 n 条」或「未测」放在 Tuning 的通知面板（D-15 ③：开眼笔记 §7.6 已按 P1 否掉页头计数，它没有对应的动作，放在页头本身就是一次打断）。行上：`notify` 还是 pending 且已过 5 s，显示「通知未送达」。
- 深链 `#/item/<id>`：在收件箱里就选中并滚过去；不在就取 detail 显示结束类（例如「已自动清除：源头已解决 · 14:02」）；查无此条显示「找不到条目」。id 必须匹配 `[A-Za-z0-9_-]{1,64}`；hash 里从不放 token。toast 的 launch URL 用同一个格式。

**5. 无障碍与输入法**：
- `role=grid`，每组一个 rowgroup 带组头，roving tabindex，`aria-selected`；焦点框和选中样式不同（选中 = 左边条加底色，焦点 = 2 px 描边）。级别永远写成文字 P0–P3，不只靠颜色。
- polite、assertive 两个播报区空着写在 `index.html` 里，载入时就在（读屏只播报载入时已在 DOM 里的区域，第一条 notify 来了才建，那一条就丢了）。级别 P1 的 `notify` 帧进 polite 区（2 s 内合并成一条），级别 P0 进 assertive 区，别的不播报。`prefers-reduced-motion` 时不闪不动。原生 `<dialog>` 的 `showModal()` 负责焦点圈定和焦点归还。
- 输入框（配对码、提醒文字、PID、自定时间）：`isComposing`、`keyCode` 229、`compositionend` 后 50 ms 内的 Enter 不提交；Ctrl+Enter 总能提交，刹车弹窗除外（见 3）；真按钮一直在。
- 列表上 2 s 内来了 3 次 `keyCode` 229：显示一次提示「中文输入法拦截了快捷键：按 Shift 切到英文，或用方向键和 Enter」。微软拼音会不会吞掉列表上的字母键没核实，你在场时实测 2 分钟（计划 §5 清单第 5 条）。

## 四、开工前要定的其它事

- **路由**：只用 hash：`#/`、`#/item/<id>`、`#/tuning[/roots|/protect|/connect]`；预留 `#/m/<id>`、`#/decisions`、`#/stage`、`#/ledger`、`#/score/<jseq>`、`#/rooms/<id>`。服务端只发 `/` 和资源，用不着给每条路径兜底。配对是浮层，不是路由；配好后 `location.reload()`（hash 保留），页面资源自然和正在跑的 daemon 对上。
- **外链**：只有 `ui/route.js` 能开窗口或导航。DSH 会话页（照计划 §2.2 第 9 条）的 origin 必须和你粘贴的 `/connect` URL 的 origin 完全相同（daemon 在 status 的 `dshOrigin` 里给出，不带 token），路径按 DSH 会话页的前缀加会话 id 正则校验，前缀在步骤 15 照 DSH 的实际 URL 定。随便一个回环端口都不行：那里正是 agent 跑 dev server 的地方（r4:1699），r4:2257 也只给你粘贴的 `/connect` 下的会话页。resume 命令只复制，UUID 先过正则。
- **模式与空态**，每种一个 `data-state` 和一句话，两两不同（P7：没观察到就说没观察到）：
  - 有会话、没条目，而且页面 live、新鲜、各源都正常：「现在没有要你处理的事 · 正在观察 N 个会话 · 截至 hh:mm:ss」。只有这一种情况说这句话。
  - 列表为空，但有源出错或停摆：「没看到要你处理的事，但 <源> 出错，可能看漏」。
  - 源健康条（挑战稿的提议，只取「出事才亮」的部分）：任一源 status 为 error 或停摆（没装、没配置的 off 不算）时，不管列表空不空，页头下一行显示琥珀条「收件箱可能不完整：<源> 出错 · 自 hh:mm · g t 去 Tuning」。「停摆」= daemon 现在的单调钟减去这个源最近一次轮询时的单调钟读数 `lastPollMono`，超过 max(3 × 它的轮询间隔, 15 s)（推断：15 s 是 3 个 tick；DSH 热文件 250 ms 一轮，只用 3 倍的话，事件循环卡 1 s 就会误报）；daemon 每个 5 s tick 经 Clock 判一次，只进 status、不进 journal；这样不抛错、悄悄停掉的轮询器也看得见（P2、P7）。墙钟时刻 `lastPollWall`、`lastEventWall` 只用来写「自 hh:mm」和 Tuning 里的显示，不拿来算时长（计划不变量 20：时长只用单调钟）：拿墙钟算的话，墙钟往回拨 1 h，一个真停了的轮询器就会藏 1 h，往前拨又会误报。一切正常时这一条不出现；它带一个动作（g t），所以不是 §7.6 否掉的那种计数。
  - 一个会话都没观察到：「没有在观察任何会话」，并列出每个源的状态。
  - 页面不新鲜（第一节 4）：空列表显示「数据截至 hh:mm:ss · 可能已过时」，不说「没有要你处理的事」。
  - ui-only：视 D-17。推荐默认下没有这个页面，浏览器那边是 down 态的「连不上 orchestrad（原因见启动它的控制台）」；你选「发」时，琥珀色横幅加原因，列表换成说明和「g t 去 Tuning」，动词一律 503。
  - stale、down、refused、unpaired、superseded：见第一节的表。
  - 测试 profile：不能关的斜纹「TEST PROFILE」条；页面标题、浏览器通知和 toast 的标题都加「[测试]」前缀（`shared/strings.js` 按 profile 拼）；测试用图标。agent 在你的桌面上跑测试 profile，`toast-latency` 一次弹 10 条，不加前缀就和真的一样（P1）。
- **中文**：`lang=zh-CN`；全部文字在 `shared/strings.js`，页面和 toast 共用；不认识的错误码原样显示；「完成」两个字禁用（r4 D19，扫描管）。分组头中文在前、乐谱名作副标：需要你 Fermatas / 出错了 Wrong notes / 待审 Ready for review / 提醒 Reminders（推断，代-13）。时长写「40秒、2分、1时、1天」，悬停给绝对时间；字段按码点截断。
- **主题与密度**：`:root` 上的 CSS 变量，按 `prefers-color-scheme` 切亮暗，M0 不做手动切换；系统字体 Segoe UI、Microsoft YaHei UI，等宽数字。一行 28 px，1080p 约 30 行。harness 颜色照 r4 §11.3（Claude 白、DSH 蓝、Codex 橙）再加字母 C/D/X；项目用 12 个固定色相 class；样式只走 class 和 dataset，不写 style 属性。
- **代定（代-13，可改）**：tick 5 s、20 s 判过期；每个配对会话 2 条活流；中文在前的分组头；snooze 的四个数字预设。seen 的 500 ms 停留不在这里，归 D-16 问你。
- **时延预算**（P3 两行写法；尾部目标都是假设）：

| 预算 | 确定性那行（M0 的 CI 守） | 随机尾部（步骤 19 的探针才量） |
|---|---|---|
| 一份快照的 reduce + 补丁 | 改 u 行时 DOM 操作 ≤ 8u + 2，与总行数无关（fake-dom 数操作） | 帧到绘制 p99 ≤ 50 ms |
| 按键 | 处理函数同步、不 await | 按键到绘制 p99 ≤ 50 ms |
| 通知回执 | `notify` 处理函数返回前已发出回执 | 交给系统 → 显示 p99（18A 用 shown 回执报；勿扰实测之前标「口径未核实」） |
| 首屏 | — | 打开到首份快照画出 ≤ 500 ms |
| 体积 | ui/ + shared/ ≤ 80 KB；500 条时快照 ≤ 256 KB | — |
| 份数或字节超标时 | 份数超标（例如低置信条目来回翻）先开经 Clock 的 100 ms 尾随合并：每条流每 100 ms 至多一份，确定性上界加 100 ms，写进 `latency-bounds` 的 AC3 行；delta 只管字节超标。两样 M0 都不实现 | 快照字节 p99 > 64 KB 开 delta；每条流每分钟 > 120 份开合并（metric 实测） |

## 五、怎么测

每条新测试和新扫描规则，先用故意做坏的样本证明它能命中（P7）。

**daemon 侧（步骤 4、5）**：
- `sse.test`：带不带 `Last-Event-ID`，第一帧都是快照；`snapshot.jseq == applied_jseq`，提交前没有任何帧；虚拟钟下每 5 s 一个 tick，`tick.jseq` 等于最后交给 `res.write()` 的快照；status、tick、notify、bye 都没有 id；套接字堵住时连提交 10 批，drain 后只补发 1 份、是最新的，堵住期间不写 tick 和 notify，drain 后 notify 排在那份快照之后；金丝雀串（后面加一个 U+202E）埋在源文本、cwd 末段和工具名里，在快照、notify 帧和 toast 的 XML 里都出现 0 次；虚拟钟下停掉一个轮询器，max(3 倍间隔, 15 s) + 5 s 内 status 里这个源变「停摆」，同时把墙钟往回拨 1 h 也一样；事件循环卡 1 s（虚拟钟一次跳 1 s）不出「停摆」；未发 >1 MiB 出 `bye{backpressure}`；没有流时不编码；`stop()` 发 `bye{shutdown}`；D-17 选「发」时另加一例：ui-only 下第一帧是 `jseq: 0`、数组全空的快照。
- `sse-cap.test`：第 3 条流顶掉最老的（`bye{superseded}`，进墓碑）；同一 tab id 再连只替换自己（旧连接得 `bye{replaced}`，不进墓碑，再连不得 409）；墓碑里的 tab 再连得 409。`prefs.test` 配一例「复制标签页」：导航类型不是 `reload` 时换新 tab id，两个标签页不互相顶。
- `view-parity.test`：合成 journal 的每个前缀 k，用当前 db 编码的快照，和删掉 db、只用 journal 重建后编码的快照，canonical JSON 逐字节相同。不比的字段：`status`、`serverWall`、`srev`、顶层 `bootId`，以及提醒的文字和 `textState`（片段表是旁表，删库后提醒文字变「已丢失」，由 `rebuild.test` 另测）。500 条时 ≤256 KB。
- `idempotency.test`：400、404、两种 422、409 各一例（503 视 D-17）；同内容重复回同一个结果、只有 1 条 human 记录；重启重建后去重照样生效，同 actionId、同内容的重试得 `replayed:true`，不得 422（坏样本：拿 journal 行的 `digest` 重建去重表，这一例必须变红）；刹车只有 `human` 没有 `human.result` 时重启，补出 `outcome:'unknown'`；journal 里塞一条没有结果的 `protect/add` 的 `human` 再重启，也补出 `unknown`，同 actionId 重试得原样回复的 `unknown`，不得 409；非刹车动词正常走一次，`human` 和 `human.result` 在同一批；标记类的 `human.result` 和它的转换在同一批；两个并发的 `protect/add` 带同一个 actionId（第一个还在等假 procguard）→ 效果只做 1 次，第二个得 409 `in-flight`（坏样本：去掉 in-flight 表，这一例必须变红；dsh-connect 的 10 s 超时测在步骤 15 的 `dsh-connect.test`）；已结束的条目得 `noop:already-ended`；竞态一例：页面画出条目后、POST 到达前，自动清除先提交，结果是 `noop:already-ended`，不是 422；journal 里人为塞一条重复 actionId，apply 和全量重建都不失败、记一次 `journal.dupAction`；`dsh-connect` 的 human 记录里查不到 token，也查不到含 token 的 body 的哈希。
- `detail.test`（结束类、textState 四种、asOfJseq）、`notify-ack.test`（步骤 4：参数校验；三种 phase 原样转给 channel 的 `ack()`；shown 只进 metric）、`assets.test`（只发经 `app-assets` 读进来的白名单路径，白名单外的路径被拒；index.html 没有内联脚本、`style=`、`on*=`、`<form`；两个播报区节点在；体积上限）、`headers-csp.test`（r4:595 原样；D-11 同意后多 `trusted-types 'none'`）。`reminder-api.test` 在步骤 13。
- `notify/channel.test`（步骤 5，接假的 ToastPort）改：「30 s 没报状态算离线」换成「流断了立刻算离线」；冻结、权限被拒都算离线；没冻结、流开着的隐藏标签页过 10 分钟虚拟时间仍算在线；notify 只发给一条流；dispatched 之后安静过完 1.5 s → 写 1 条 journal，`notifiedAt` = 回执到达时刻；dispatched 之后 1.5 s 内来 error → 不写、不设，立刻转 toast 并标「回执失败」（从 `notify-ack.test` 挪来），`notifiedAt` 由 toast 的 shown 设；之后的 dispatched 写 0 条；「回执失败」在这个 tab 发来 `visible` 且没冻结的 client-state、或重连时清掉，带标记时 Tuning 写「此标签页暂不接收通知」。

**页面侧（步骤 5，node:test，不要 DOM 库）**：
- `store.test`：输入深冻结不被改；旧 jseq 丢弃；bootId 变了出重启横幅、未决 chip 变「还没收到结果 · orchestrad 重启过」；409 `in-flight` 显示「仍在处理」、chip 留着；待定表从 sessionStorage 读回后，重载前发出的动作照样能对上 `recentActions`；`tick.jseq` 对不上算缺口；chip 只由 `recentActions` 清，不由 HTTP 200 清；刹车的五种结果各拼对一次，几种子树状态同时出现时按 unknown > refused > 残留 > ok 取。
- `conn.test`：驻留表上每个状态都有钟或闸；session 回复到之前不建 EventSource（打开、重开、重载后都是）；20 s 没帧 → stale；任何 `error` 和任何 `bye` 都先关流，之后不再有浏览器自己的重连；`error` → 一次探测，`bye{shutdown}` → 1 s 后一次探测；403 → unpaired（有没有拿到过 bootId，文字不同），网络错误或 5 s 没回复 → down 并按 5–30 s 退避，200 → 重开，200 后流在快照前又失败或其他状态码 → refused 并退避；`bye{backpressure}` → 1 s 后带 `why=backpressure` 重开；`bye{superseded}`、`bye{replaced}` 不自动重连；同时只有一个探测；最后一帧超过 20 s 时，connecting、down、refused、unpaired 下都带「[未更新]」。
- `dom.test`（fake-dom）：重排保留节点和焦点；焦点在列表上时来一份改了次序的快照，行序不变、新条目排在分组末尾，按 `j` 或焦点离开后才重排；rev 没变写 0 次；改 1 行时，100 行和 1,000 行的 DOM 操作都 ≤10 次；碰 innerHTML 类写入点抛错。
- `static-render.test`（描述符）：每个 kind × state × conf × 结束类的 `data-*` 和文字都不同，相同对数 0；各空态、降级态两两不同，空列表 × 每个非 live 或不新鲜的状态各一例，都不含「现在没有要你处理的事」；源出错、源停摆时的空态和源健康条各一例；「还没收到结果」「刹车结果不明」「结果不明」两两不同；刹车的五种结果（已刹车 · 0 残留 / 部分残留 / 没刹 n 棵 / 计划过期 / 刹车结果不明）文字两两不同；「完成」0 次；行提示 = 命令表 ∩ `item.verbs`。
- `hotkeys.test`、`ime.test`：229、Process、repeat、修饰键、输入框焦点、焦点不在列表都忽略；`K` 要 Shift；itemId 按键时绑定；750 ms 由新快照触发，不由你的 `j`/`k` 触发；自动改选之后 `e`、`s`、`r`、`K` 都不响应、出「先按 j/k 选一条」，按 `j`/`k` 或点击之后才恢复；seen 停留只在主动选中后开始计，载入默认选中、hash 落地、自动改选停多久都不发 seen；每个作用域一键一义；Enter 不绑破坏性动词；compositionend 后 50 ms、Ctrl+Enter、3 次 229 出提示。
- `notify.test`：处理函数返回前已发回执，rAF 永远不触发也一样；renotify 只给 P0 重发；结束或稍后才 close，seen 不 close；点击设 hash 并发 seen；show 事件经 `ackShown` 报 shown；P0 未结时，任何闪烁相位下标题都带「【P0】」，重载后也带；测试 profile 下通知标题带「[测试]」。Peek 的纯函数部分：连按 10 次 `j` 只发 1 个 detail 请求。
- `kill-dialog.test` 加：焦点在「执行」上按 Enter 什么也不发，按 Space 才执行；PID 输入框里按 Enter、Ctrl+Enter 都什么也不发；`K` 到不了「执行」；弹窗出现后 750 ms 内点击无效；PID 先 NFKC；倒计时取 min(`expiresAt` − displayNow, 60 s − 回复后的单调钟时长)，过期后显示「重新生成」；一例：回复之后 serverWall 往回跳 1 h，倒计时仍在页面单调钟 60 s 时走到 0。另有 `route.test`、`load-pure.test`、`strings.test`。
- `static-scan.test`：ui/ 新规则每条一正一反：禁 `DOMParser`、`createContextualFragment`、`setHTMLUnsafe`、`parseHTMLUnsafe`、`srcdoc`、`execCommand`、`Worker`、`SharedWorker`、`importScripts`、`setAttribute('on…')`、`setAttribute('style')`、`cssText`、`WebSocket`、`XMLHttpRequest`、`sendBeacon`（带不了 CSRF 头）；`EventSource` 只在 `ui/conn.js` 且带 `/api/events` 字面量；`fetch` 只在 `ui/api.js`；时间 API 只在 `ui/clock.js`；存储只在 `ui/prefs.js`；`window.open`、`location.assign`、`location.replace(`、`location =`、`window.location =`、`document.location =`、`location.href`、`.href =`、`setAttribute('href'` 只在 `ui/route.js`（`location.hash =`、`location.reload()` 不算）；`ui/*.html` 里的 `<form`、`createElement('form')`；`ui:input-name`：`ui/*.html` 里带 `name=` 的 `<input`、`<textarea`、`<select`（`<meta name=…>` 不算，反例就用它）和 ui/*.js 里的 `setAttribute('name'`；`ui/*.html` 的内联脚本、`style=`、`on*=`；`shared/strings.js` 里的「完成」。

**步骤 18A 的 UI 一块**（`latency-report`，N = 0 一律「未测」，不写「通过」）：
- 通知「交给系统 → 显示」p50/p99，「没显示」的 k/n 和 Wilson 95% 上界。「没显示」只算 attempt = 1 和 P0 的重发；非 P0 的同 tag 补发是静默替换，Chrome 会不会对它触发 show 没核实，单独计数，不混进去。你在场的勿扰实测（计划 §5 清单第 5 条）做完之前，这两行标「口径未核实」。
- 人类动词：标记类从 HTTP 收到请求（单调钟，记进 metric 表）到这批提交做完；刹车从 `human` 记录到 Command 的结果。不用「human 记录到结果提交」：标记类的结果和 human 同批写，按构造就是 0，会读成通过。
- 看见→动作：seen 到同一条目的下一条人类动作记录（从 journal 算）。
- `sse.coalesced`、`sse.drop`、`sse.superseded`、重连原因（`why`）计数，缺口次数（目标 0）。
- 快照字节 p99、每分钟份数，对照开 delta 和开合并的门槛。
- 帧到绘制、按键到绘制、「还没收到结果」和「刹车结果不明」的次数（分开报）：要等步骤 19 的 UI 时延探针，没做就是「未测」。

**手动**：
- 实现会话，测试 profile 的浏览器面板：XSS/OSC fixture 显示字面文本；停掉 daemon（进程退出）5 s 内（加一次渲染）显示「连不上 orchestrad」（error → 关流 → 一次探测 → 网络错误；推断约 2–4 s，探测按 5 s 超时判 down 也算过），记下实际用了几秒，之后探测按 5–30 s 退避；重启后显示配对页，不转圈；DevTools 断网 20 s 出现「数据截至 … · jseq N」；开 3 个标签页，最老的显示「在此使用」；刹车弹窗里按 Enter 什么都不发生；点通知落到 `#/item/<id>` 并记 seen；标签页隐藏 6 分钟后仍收得到通知。
- 你在场：微软拼音中文模式下对列表按 `j`/`k`，记下是生效还是出提示（2 分钟）；开着勿扰（专注助手）弹一条测试通知，记下 `show` 事件是没来、交给系统时就来，还是真显示时才来（2 分钟）。

## 六、被否掉的方案

- 先 `GET /api/items` 再订阅：两次调用之间有空窗，还是两条读路径。
- `Last-Event-ID` 从数据库补发：重载和新标签不带这个头；视图行和 journal 批对不上，又多一条要和快照一致的路径。
- M0 就发增量帧加 prev 链：多一套缺口逻辑和测试，M0 的体量用不上；形状先留着，按实测门槛开。
- WebSocket、长轮询：要改扫描和 builtin 表，或多占连接；单向推送用不上。
- 注释心跳：页面 JS 看不见注释行，驱动不了「过期」。15 s tick（60 s 才判过期）也不要：回环上 5 s tick 几乎不花钱。
- setInterval 报 client-state，或每个 tick 都 POST：隐藏标签页被节流；流开着本身就说明在线。
- 只在 show 事件或 rAF 之后回执：勿扰下 show 可能永远不来（未核实，见第一节 6）；隐藏标签页不绘制。等 show 再回执是 D-15 的另一种做法，由你定。
- 乐观 chip、HTTP 200 就清 chip、自动重试：效果没发生就先显示了；违反原则 8。
- 每次启动清空的去重表：重启后重试会做两次。
- 从快照差异触发报警：重连后会再响一遍。
- 页面有焦点时用页内提示代替系统通知：第一轮否掉的是靠空闲阈值的版本。挑战稿的版本只看「可见 + 有焦点」，所以改成 D-18 问你；推荐 M0 不做：改了 r4 D10，有焦点 ≠ 在看（第二块屏），页内提示不进操作中心，而且 r4 §11.2 里 P2/P3 本来就不通知，实际只涉及 P1。
- 一个配对会话只许一个标签页，或第 5 个回 429：toast 点开的新标签被挡在外面，M2 第二块屏也用不了。
- Web Locks + BroadcastChannel 选主、SharedWorker：多约 0.25 d，SharedWorker 还要 TT 策略；M2 真要多窗口再看。
- `z` 撤销：要新增 reopen、cancel 路由和状态边，M0 工期紧。所以 M0 的标记都撤不回，误触靠第三节 1 的两道闸。
- M0 就做 Ctrl+K 面板：否，12 个命令不值 0.5 d，记在 M1。
- 键入时长解析（「今晚」「明早9点」）：怕输入法；M0 用数字预设加 datetime-local，解析器随 M1 面板。
- 刹车改成单选子树：改了计划 §2.2 第 2 条，而且 `K` 在弹窗里会有两个意思。
- WebAudio 提示音：后台标签页没有用户手势时静默失败。
- htmx、Turbo、LiveView、Datastar、Alpine、petite-vue 要 innerHTML 类写入点或 eval；Lit、uhtml、idiomorph 要开扫描口子和 TT 策略，或往 TT 写入点写字符串。Preact + htm 和 morphdom 用 DOM 节点作输入时不需要 TT 策略；否掉它们的真实理由是零依赖，以及现有扫描规则 `vendor-type-only` 对 ui/ 也生效，vendor 进来要改这一条。
- Shadow DOM 组件：`style-src` 挡住内联样式，按键和焦点被重定向到宿主。
- jsdom、happy-dom、Playwright：新依赖。
- 行里带 200 字摘要：每个标签页的流都变大，清除秘密时视图会悄悄变。
- 资源路由改成 `/ui/*`、`/shared/*`：`/assets/ui`、`/assets/shared` 本来就和仓库同构，不值得动冻结表。
- 文档范围的单键监听：违反 WCAG 2.1.4，语音输入会误触发。
- 通用的 `fetch(url)` 包装：第一个参数不是字面量，会绕开「ui/ 只许 `/api/` 字面量」那条扫描。

**第二轮补听：挑战稿和第三份稿尾部里没采纳的**（采纳的已写进正文，清单见第八节末）：
- 发 `retry: 2000`：`conn.js` 每次都新开 EventSource，本来就不带 `Last-Event-ID`；`retry:` 只会招来绕开 down 退避的原生重连。
- 15 s 判过期：20 s = 4 × tick，和 r4 的 4 倍保活规则一致；早 5 s 不改变你的任何动作。
- 发完 bye 后服务端把套接字留 30 s 等页面关：`conn.js` 见 bye 就关；留着反而占掉 6 个连接里的一个。
- 每个配对会话只许 1 条流、页面变可见就自动接管：toast 点开新标签再关掉时，旧标签要你点一下才恢复；自动接管在两个窗口交替遮挡时会来回抢。省约 0.1 d，不值。
- 每 3 个 tick 报一次 client-state、带上页面的各项计数：在线看流开着就够，不用定时 POST；计数从服务端的 `why=` 和 `sse.*` 来。
- 去掉 freeze、resume 的 keepalive POST，靠 1.5 s 回执超时：要多等 1.5 s，再加 PowerShell 冷启动 1.3–3.4 s，超出 AC3 的 2 s。
- 变更带 `basis{bootId, jseq}`，bootId 不同回 409 `stale-boot`：永远触发不了（旧启动的页面先得 403），重新配对后还会挡住同 actionId 的手动重试；§7.6 也否了通用 itemRev/409。
- `lastJseq ≥ 回复的 jseq` 就清掉待定 chip：本文只在 `recentActions` 里出现这个 actionId 时清，chip 能显示真实结局（例如「无需操作：已自动清除」），更贴 P5。
- 只把视图当数据测、不要假 DOM：补丁器就一个自动化测试都没有了（P7）；三份评审都要 fake-dom。
- ui-pure 扫描规则（纯模块禁 document、window、fetch 和时间 API）：时间只在 `clock.js`、fetch 只在 `api.js`、`load-pure.test` 已经覆盖大半，剩下的只多管没跑到的分支，不值关键线上的 0.02 d。
- M0 不要 `n` 键：观察来的 Fermata 要等源头清掉，seen 的行会留很久，跳过 seen 正是 `n` 和 `j` 的区别；约 0.05 d，工期评审说少了它最伤日常用。
- Tuning 当成快照里 `self` 字段的第二个渲染器、去掉 `GET /api/tuning`：快照每批都发给每个标签页，Tuning 数据跟着重发；`tuningRev` 加重取帧更小，那样最多省 0.05 d。
- 「靠抵消做到净 +0.1 d、不挪线」：它的抵消项逐条处理过，两项本文已有，一项否掉，一项（周自评移到 M1）写进 D-10 的代价栏。
- 两个浏览器都配对时，旧的 client-state 把 notify 发错浏览器：Edge 和 Chrome 进的是同一个 Windows 操作中心，照样看得到；没回执还会转 toast。
- 「可见性接管来回抢」这条风险：本文不自动接管，不适用。
- AudioContext 重载后要手势才响（第三份稿尾部）：D-13 不用页内声音，不适用。
- M1 乐手页再加流会撞 6 个连接、M1 要上 Web Locks（第三份稿尾部）：本文 M1 每个标签页仍只有一条流，按视图分发，不加连接。
- 推迟假 DOM 测试和 close/renotify 细节，把 UI 压到 +0.15 d（第三份稿尾部）：假 DOM 是补丁器唯一的自动化检查（P7），close/renotify 只有几行。

## 七、要你定的事

计划里先按推荐默认排。多数事项你不定，就一直按推荐默认做；例外写在最后一栏：D-11 照 r4 原样发，D-14 到 M1 前再问；另外凡是要改 r4 措辞的（D-12 的①②③⑤、D-13 的 r4 §11.2「播放声音」、D-17 的 r4:589、D-19 的两处），你不点头就不改 r4，代码照推荐默认做。你不同意，按「代价」一栏改。本文和计划 §2.1 的 D-n（带短横）是计划的编号，和 r4 的决定 Dn（不带短横，本文写成「r4 D10」）是两套。

几个词：
- TT = 浏览器的 Trusted Types 白名单：开了以后，往 innerHTML 这类写入点写字符串会被浏览器直接拒掉。CSP = 浏览器的内容安全策略，限定页面能跑哪些脚本。
- 一份新快照 = daemon 经 SSE 推来的一整份收件箱视图。D-12 ③ 说的就是它，不是浏览器画的一帧；本文别处的「帧」都指 SSE 推来的一条消息。
- AC3 = 等你的事 2 s 内生成条目并提交通知；AC10 = Tuning 显示 codex 那行文案和 Claude 版本漂移；18A、18B = 计划步骤 18 的两半（验收脚本、收尾与端到端）。
- P5 = 开眼准则「标记后于效果」。metric 表 = 只放测量样本的旁表，不参与重建。human 记录 = journal 里记人类动作的那种记录。hash 落地 = 经 `#/item/<id>` 这类地址打开页面时的那次选中。
- 安全档、人这一端档、门脚本档 = 开眼笔记 §7.5 原文的第一、二、三档。改名是为了不和开眼笔记 §6 的第一、二、三档（已并进 M0 计划，第三档是步骤 19）混。
- rAF = requestAnimationFrame，浏览器每画一帧之前调一次的回调；标签页隐藏时不调。
- srev = status 帧自己的序号，同一次启动内只增不减，和 journal 的 jseq 无关。
- drain = 套接字的发送缓冲写空时 Node 发出的事件；合并（coalesce）= 慢流上不排第二份快照，等 drain 时只发最新那份。
- D-19 的几个词：WriteFence = 写围栏，唯一能写盘的入口。哑 io = 随手造的一个假读写接口。WriteFence 的 rm（删文件、删目录）和 mkdtemp 今天直接调 fs，不经注入的 io（rename 第 2b 步起已经经 io），所以就算只配一个哑 io，rm 照样删真文件。今天挡住别的模块自己造写围栏的只有按名字的静态扫描（只许 main.ts、working.ts 造，另禁 `.constructor`），运行时没有挡；绕过扫描的模块配上自选的根就能删真文件。「fs 能力在 boot 里造好」= 只让一个文件碰 `node:fs`，boot 在装导入围栏之前用它造好读闸门和写围栏的工厂，递给 main；之后别的模块 import 不到它，也造不出能动真文件的闸门。process 能力清单 = 一张表，把 process 对象上的每个属性归成「留着、锁成桩、boot 先拿走」三类。删陪跑规则 = 删掉几条和别的防线重复、自己从没单独拦下过东西的静态扫描规则，把 fs 名字禁令合成一张表，再加一个覆盖测试。环境时钟 = 读时间的其它写法（如 `Date()`、`performance.timeOrigin`、`process.uptime`），开眼 §7.3 要它们也只许出现在 clock.ts。脚本也走 boot = 碰真实根的开发脚本也先过导入围栏再跑（`boot --script <名字>`）。

| # | 事项 | 推荐默认 | 代价 | 你不定时怎么办 |
|---|---|---|---|---|
| D-10 | 工期：UI 两轮合计约 +1.45 天工作量（第一轮 +1.0；第二轮步骤 3 +0.15、步骤 5 +0.3，步骤 4 的约 +0.25 由 D-17 的默认抵掉），步骤 17（toast）从线 B 挪到线 C 末尾。接受它也就选了人这一端档「只做核心四条」的做法 | 接受 | 线 B 是关键线，线 C 早 0–0.3 天做完（步骤 6 的落库部分挪到第 8.0 天之后，从这里扣，见计划 §4.1）；步骤 17 依赖步骤 3 冻结的通知接口（含 ToastPort）和 `shared/strings.js` 一次定对。人这一端档全做（上屏、打断计量等）约再 +1.3 天，全压在线 B。不挪步骤 17，关键路径再 +0.75 天。要往回压：线 B 削③漂移显示（约 −0.3 天，AC10 推到 M2），再削线 C 的②policy v0（约再 −0.2 天）。另一项可削：周自评移到 M1，省约 0.05 天（步骤 15）；不推荐，r4:2719 写明从 M0 起采集，M4 的 Q11 要用 | 按推荐默认 |
| D-11 | r4:595 的 CSP 末尾加 `trusted-types 'none'` | 加 | 约 0 天（`headers-csp` 测试本来就有）。以后建不了任何 TT 策略：DOMPurify 的策略、Lit、从字符串起 Worker 都用不了 | 照 r4:595 原样发 |
| D-12 | 快捷键（r4 §11.9）：① 加 `n`、`e`、`?`、`g t` 和方向键、Enter、Space、Home/End 别名；② 单键只在列表焦点里生效，Tuning 可关；③ 「列表变化后 750 ms 内无效」读作「一份新快照改了选中行的 id、位置或可用动词」，M0 用在 `e`、`K`，M1 的 `a`/`x` 照此；④ 照 r4 §10.9 r4:1663 保留「焦点在列表上时冻结排序」，按 `j`/`k` 或焦点离开列表时才重排；⑤ 选中的条目结束、页面自动改选到别的行之后，`e`、`s`、`r`、`K` 先不响应，等你用 `j`/`k`、方向键或点击自己选一行（hash 深链和 toast 落地的选中照旧可以直接动作）；这改了 r4 §11.9 里 `s`、`r`、`K` 何时响应 | 五条都接受 | ⑤约 0 天（已含在步骤 5）；不接受⑤就只剩 750 ms 一道闸，你走开再回来按 `e` 或 `K`，可能落在一行不是你挑的条目上，而 M0 的这些动作都撤不回。不接受③就按字面「列表一变就 750 ms 无效」，正常的 SSE 流量下键会频繁失灵；不接受②则不满足 WCAG 2.1.4，语音输入会误触发；④约 0 天（键控补丁里多一个「冻结时沿用旧次序」的分支，含在步骤 5 的估时里，推断），不接受④就要改 r4 §10.9 的措辞，行会在光标底下换位，只剩 750 ms 一道防线 | 按推荐默认 |
| D-13 | P0 的「播放声音」（r4 §11.2）由系统通知自带的声音满足（`silent:false`、toast 默认声音），不用页内 WebAudio | 接受 | 声音受勿扰和系统音量管。不接受就加回 WebAudio 和「声音未启用：点一下页面」提示，+0.1 天 | 按推荐默认 |
| D-14 | M1 前定：r4 §5.3 规则 2 的 markdown 不用 DOMPurify，改成手写子集，全部用 createElement 建节点；链接照 r4:596 只许 http(s)，经 `ui/route.js` 的中转确认页打开 | 接受 | M1 约 0.5 天。DOMPurify 是 npm 依赖，和零依赖冲突，也和 D-11 的 `'none'` 不兼容。中转页 M0 约 0 天：`route.js` 是唯一能开窗口的文件，M1 在它里面加，不放宽扫描。M0 不受影响 | M1 开工前再问 |
| D-15 | 浏览器通知何时回执（人这一端档核心四条之一，开眼笔记 §7.5 也在等你定）：① 交给系统就回执（`phase:'dispatched'`），这次尝试 1.5 s 内没报 error 才写 `notifiedAt`，`show` 只进 metric；② 勿扰实测之前，「交给系统 → 显示」两行标「口径未核实」；③ 页头不放「已交给系统 n 条」，放 Tuning | 三条都接受 | ① 的代价：`notifiedAt` 记的是「交给系统、1.5 s 内没报错」，不是「显示了」；Windows 设置里关掉了浏览器的通知时，网页权限仍是 granted，回执照样到，不会转 toast（推断，未核实）。非 P0 的同 tag 补发是静默替换，Chrome 会不会对它触发 show 没核实：默认下只影响 18A「没显示」的 k/n，那一项已单独计数。另一种是开眼笔记 §7.3 的做法：`show` 事件来了才回执，`error` 直接转 toast。它更贴 P5，几乎零成本；代价是 AC3 的「提交通知」时延变大（口径变诚实）；勿扰下 show 若不来，每条都会在 1.5 s 后再转 toast，并把这条流标「回执失败」；静默替换若不触发 show，每次补发多弹一条 toast（至少一次，不丢）。③ 不接受就留在页头，违背 §7.6 按 P1 的判断 | 按推荐默认 |
| D-16 | seen 从哪来（M4 的 Q11 要用 noticed 指标来定）：主动选中（`j`/`k`、方向键、点击）后停留 ≥500 ms，或 peek、打开、点通知，写成 human 记录；载入默认选中、hash 落地、自动改选都不算；seen 不算「干预」 | 接受 | 停留阈值 500 ms 是假设；停留会多写 human 记录（每个条目至多一次 seen）。另一种是开眼笔记 §7.3 的做法：seen 只来自显式输入（在行上按 `p/o/s/r/K`、点击行、点通知），noticed 不进 journal，由 18A 从原始证据按带版本号的规则重算。它更严，但你只看了一眼、没按任何键的条目永远不算 noticed，noticed 会偏晚；而且要把选中和停留的原始证据另存进 metric 表，约 +0.1 天（推断） | 按推荐默认 |
| D-17 | ui-only 还发不发网页（开眼 §7.5 问的同一件事，只定一次；第 4 步开工前要定。开眼笔记 2f4e46b 起也写「仍待你定」，见第九节） | M0 不发：ui-only 照第 2 步的现状打印每条原因、以 ui-only 退出码（22）退出，不起 HTTP；浏览器那边显示「连不上 orchestrad（原因见启动它的控制台）」；ui-only 的 Tuning 页移到 M1 | 省约 0.25 天（开眼笔记 117a3a7 版 §7.5 估 0.25–0.5，现在那一节没写估时；按下限抵掉第二轮步骤 4 的增量，推断；步骤 4 原来的 1.5 天里没写 ui-only 怎么起 HTTP，这部分可能本来就没算，抵不掉时关键路径约 18.55 天）。r4:589「ui-only 提供 Tuning」要改措辞，要你点头。Low 副本、完整性不明、数据目录检查失败、journal 断链时，浏览器只看到「连不上」，原因只在控制台；真实 profile 本来就由你在可见控制台里启动（代-2），配对码也只在那里打印。另一种（照 r4 发）：步骤 4 再 +0.25–0.5 天，关键路径同加；步骤 4 要写清 main.ts 在不拿锁、不开存储、不装写围栏的情况下起 HTTP，端口从参数或默认常量来（不读被拒的数据目录里的 config），配对码和 bootId 挪进 main.ts，`modeReasons` 只取代码里 `UiOnlyReason` 的 id（journal 断链不在里面：它是拿锁之后才发现的，两种选项下都打印原因、以 22 退出），`startup-modes` 里两个测试重写。完整性不明时进程可能其实是提权的，在那里开一个带配对的 HTTP 监听是安全代价，所以选「发」时推荐完整性不明仍退出，只对 Low 和数据目录失败发页面 | 第 4 步按代码现状（不发）开工，ui-only 的形状只在 `shared/protocol.js` 里留着；你后来选「发」，在线 B 的步骤 15 补上（+0.25–0.5 天）；r4:589 到你点头才改 |
| D-18 | 页面可见且有焦点时，级别 P1 的提醒只在页内出（行闪 + polite 播报，回执 `phase:'in-page'`，AC3 单列一组）；P0 永远走系统通知（挑战稿的提议） | M0 不做（r4 D10 原样），M2 随专注模式再议 | 要做 +0.1 天（步骤 3 的契约、步骤 5、18A）。不推荐的理由：有焦点 ≠ 在看（第二块屏）；页内提示不进操作中心，走开回来就没了；`notifiedAt` 会有两种意思；r4 §11.2 里 P2/P3 本来就不通知，实际只涉及 P1 | 不做 |
| D-19 | 开眼 §7.5 的安全档（原文第一档） | 做 2b 和 2c 的四件；开眼 §7.3 另两条见代价栏。即第 2b 步（已提交 a83826d，0.5 天）加第 2c 步（2c 本身约 0.85 天，压在线 A 的步骤 3 之前；按推荐默认正在另一个会话里做，还没做完）。2c 只做四件（前三件出自 §7.3「第 3 步开工前」，第四件出自开眼 §7.7）：fs 能力在 boot 里造好（净约 0.5 天）、process 能力清单（0.25）、删陪跑规则（0.1）、一条钉住进程内 start() 的 home 的仓库测试（很小，算在 0.85 里，推断）。另有一问，两种选项下都要答：同意 r4 措辞两处，r4 D3「心跳锁」改「身份锁」，r4:589 缺 registerHooks 改为退出（第 2b 步的代码已经这样做，选哪种都留着）；推荐同意 | 关键路径约 17.45 → 18.3 天（2b 那 0.5 天已经做完，不管选什么都计入）；开眼 §7.3 另两条不在 2c 里：环境时钟照开眼原文并进步骤 3 的 Clock 扫描规则，不管选哪种都做，算在步骤 3 的 2.4 天里（推断 ≤0.05 天）；脚本也走 boot 没估、还没排（推断 ≤0.05 天；开眼原文放在第 6 步之前）。另一种：只做 2b，其余几条到 M1，关键路径约 17.45 天；代价是到 M1 之前，挡住别的模块自己造写围栏的只有静态扫描，运行时没有挡：绕过扫描的模块配上自选的根，就算只配一个哑 io，也能删真文件（开眼 §7.3；词义见上）。不同意那两处措辞：代码照现状，r4 和代码不一致，留到你点头 | 按推荐默认（开眼笔记把整个安全档标了必做；脚本也走 boot 还没排）；r4 措辞到你点头才改 |
| D-20 | 开眼 §7.4、§7.5 的门脚本档（原文第三档）和两个 agent 定义 | 门脚本先只做「修复见证」（约 0.5 天），排在线 C 等步骤 3 的那段空档里（第 8.0 天前约 0.4 天多），做不完的接在线 C 末尾（线 C 两段空档合计约 0.7 天，见计划 §4.1），不算进关键路径；安静信道计时、跳过台账、提交尾注到 M1。两个 agent 定义（`.claude/agents/` 下的 orchestra-impl、orchestra-review）先不加，照 D-8 的做法，由编排器从转录里统计工具调用 | 做之前，修复没被见证的风险照旧（开眼 §7.2：注释掉 write-fence 的两处复查，测试仍全过）；门脚本全做约 1.5 天。agent 定义是持久配置，要你同意 | 按推荐默认：修复见证照上面排；agent 定义不加 |

## 八、对计划和 r4 的影响

**M0 计划（本次已改）**：
- 第一轮工期：步骤 4 +0.3（1.5 → 1.8）、步骤 5 +0.6（2 → 2.6）、18A +0.1（1.25 → 1.35），合计 +1.0 天工作量；步骤 3 只就地改路由表、0001 和 `model/inbox.ts`，当时记 0 天（第二轮补了价，见本节末）。步骤 17 移到线 C 末尾，关键路径 16.25 → 16.5。
- 步骤 4 的 +0.3 = 新增约 +0.5，减去删掉 `Last-Event-ID` 补发的 −0.2；新增的是快照编码与合并、2 条活流与墓碑、actionId 去重与 `recentActions`、detail 路由、计数（推断：估时按三份设计稿的中值取）。
- 步骤 5 的 +0.6：状态与连接 +0.25，描述符、键控补丁与 fake-dom +0.15，命令表、chip、seen、输入法提示 +0.15，ui/ 扫描规则 +0.1，空态 +0.05，去掉 WebAudio −0.1。
- 第一轮复核后的修正（2026-10-31，23 条）当时记作不改估时；第二轮认定它们加了新机制，补了价（见本节末）。内容是：连接改成「任何 error 或 bye 先关流、再探测」；actionId 的检查顺序和刹车结果字段；待定表存 sessionStorage；`bye{replaced}`；冻结排序（D-12 ④）；seen 只在主动选中后计（D-16）；回执点和页头计数（D-15）；`clipped` 改名；view-parity 的排除字段。I20 的结束类渲染已在步骤 5 的 `static-render.test` 里，所以从步骤 19 删掉（2.0 → 1.75 d）。
- 其它就地改动：§2 UI 行；§2.1 加 D-10 到 D-16；§2.2 第 13 条（noticed、shown）；§2.3 加代-13；§3 的 ui/、shared/、server/ 文件；步骤 3（路由形状、唯一约束、verbs 表）；步骤 13（快照带待触发提醒计数）；步骤 17（线 C、共用 strings）；步骤 19（加 UI 时延探针 0.25 d，不算工期）；§5 静默表（「30 s 客户端离线」换成「20 s UI 判过期」）和在场清单第 5 条；§6 第 13 条扩充、新增第 22 条；§7 风险表与削减说明；附录加一行。

**r4 待并入（这次不改 r4）**：
- §5.3 规则 1：D-11 同意后 CSP 加 `trusted-types 'none'`；规则 2：D-14 同意后去掉 DOMPurify。
- §11.2：P0 声音按 D-13；分组头中文在前（代-13）；「观察者协议」补一句：浏览器这一路 M0 只发整份快照，delta 按实测门槛开，M2 前按实测决定要不要开（A15 本身是给主代理与 Maestro 的，不是给浏览器定的期限）。
- §11.9：D-12 的①②③⑤（④ 照 r4 §10.9，不用改）；Ctrl+K 面板（备用 Ctrl+Alt+K）记在 M1。
- §13.3：M1 加 Ctrl+K 面板 0.5 d、chunk 帧与视图订阅（client-state 的 `views`）、markdown 子集约 0.5 d（D-14）；另加第二轮推到 M1 的三项（见本节末）。
- r4:589 和 r4 D3：D-17 同意后，ui-only 的 Tuning 页移到 M1；「心跳锁」改「身份锁」、缺 registerHooks 改为退出这两处不随 D-19 的选项变，你点头就改。
- G.7：代-13。

**开眼笔记要跟着改几句（这次不改那份文件，由它的主会话改）**：§7.5 的第二档（本文叫人这一端档）写成「由 UI 交互设计取代：两轮合计 +1.45 d，已进 M0 计划；show 回执见 D-15」，免得两边都算一遍；第一档、第三档写成「见计划 D-19、D-20」。「ui-only 网页还做不做」一条已由主会话改好（2f4e46b），现在写的是「仍待你定，计划里编号 D-17」，和本文一致；bc49949 那一版曾写「已定：fork 的前端设计保留 ui-only 页面，所有动作返回 503」，那个「已定」指的是本文第一轮的写法，不是你的决定。你定了 D-17 之后，开眼笔记再由它的主会话跟着改。

**第二轮（2026-10-31：补听挑战稿和第三份稿尾部，复核 40 条）**：
- 估时（都是推断）：
  - 步骤 3 +0.15（2.25 → 2.4）：第一轮就地改的契约约 0.1，加这轮挪进步骤 3 的 `shared/protocol.js` 枚举与正则、完整的通知接口、`human` 两种记录、`lastPollMono` 和 `lastPollWall` 等约 0.05。
  - 步骤 4 ±0（仍 1.8）：第一轮复核后的修正约 +0.1、args 格式检查 +0.05、源停摆判定和结果记录约 +0.1，共约 +0.25；D-17 的默认「不发 ui-only 页」抵掉约 −0.25。你选「发」，这 0.25 就回到关键路径上，另加 0–0.25。这个抵扣是推断：步骤 4 原来的 1.5 天里没写 ui-only 怎么起 HTTP（不拿锁、不开存储、端口从哪来、配对码放哪），这部分可能本来就没算；抵不掉时关键路径约 18.55 天（只做 2b 约 17.7 天）。
  - 步骤 5 +0.3（2.6 → 2.9）：第一轮复核后的修正（待定表、冻结排序、tab id、chip）约 +0.15；refused 态、新鲜度、两种「不明」、自动改选后先按 j/k 约 +0.08；`<form>`、导航两条扫描规则 +0.02；从挑战稿嫁接的源健康条 0.05、Peek 防抖 0.02、【P0】标记 0.01。
  - 步骤 6（procguard 请求超时）、15（源时长显示）、18A（静默替换单独计数、看见→动作）各约 +0.01–0.02，算在误差里。
- 关键路径：第 2b 步（0.5 天，已提交 a83826d）现在就计入，步骤 3 和步骤 6 都往后挪 0.5 天；加上面的增量约 17.45 天；D-19 按推荐默认把第 2c 步（安全档其余五条里的三条，加一条仓库测试，约 0.85 天）也压在步骤 3 之前，约 18.3 天；另两条里环境时钟进步骤 3（算在 2.4 天里），脚本也走 boot 没估、没排（推断 ≤0.05 天）。串行约 29.5 天（四项全削约 26 天）。线 B 是关键线。线 C 改在 2c 做完后（第 5.6 天）开工，步骤 6 的落库部分挪到第 8.0 天之后，线 C 早 0–0.3 天做完（见计划 §4.1）。
- 新增要你定的：D-17、D-18、D-19、D-20；D-9 改成「现在就要定」，补了你不定时会怎样；第七节和计划 §2.1 都加了「你不定时怎么办」或「代价」栏。
- 复核意见改了什么（要点）：
  - 安全：标题 args 过格式检查（防双向控制字符进收不回的系统通知）；ui/ 里不许 `<form>`；DSH 链接要和粘贴的 `/connect` 同 origin；导航只许 `route.js`；命名禁令的范围写对（`src/`、`shared/`、`scripts/` 全部）。
  - 每个状态都有钟和出口：连接多一个 refused 态、探测有 5 s 超时、`bye{shutdown}` 后等 1 s；「回执失败」有出口；in-flight 由 procguard 请求超时兜住；刹车计划两只钟哪个先到点就过期，墙钟往回拨拖不长。
  - 一符一义：「还没收到结果」和「刹车结果不明」分开；新鲜度和连接状态分开算，看不见时不说「没事」；自动改选后先按 j/k；【P0】标记从状态推；`[未更新]` 不再和「计划过期」共用一个词。
  - 标记后于效果：`notifiedAt` 等 1.5 s 窗口里没报错才写；`human.result` 只在效果之后写。
  - 契约归属：`shared/protocol.js` 的枚举、整个通知接口（含 ToastPort）、`human` 两种记录、`inbox_item` 的 `rev` 和 `committedJseq` 都在步骤 3 定；步骤 4 只冻结帧和载荷形状。另补了 `ItemView.reminder`、status 的 `snippetRev` 和 `dshOrigin`、读页面资源的 `app-assets` 根类、先取 session 再开流、client-state 的可选 `perf` 字段。
  - 说人话：结论拆成六条；分档改名；r4 的决定一律写「r4 Dn」；「数据不丢」的两处理由改成照实说「M0 不采，写未测」。
- 计划里跟着改的：状态行、§0、§0.5 P7 行、§2 UI 行、§2.1（名词解释、代价栏、D-9 到 D-20）、§2.2 第 3、13 条、§2.3 代-13、§3、§4.1（2b、2c 行，时间线和算式）、步骤 2、3、4、5、6、15、17、18A、19、§5 在场清单第 10 条、§6 第 10、13、14、22 条、§7、附录。
- 从挑战稿嫁接的：源健康条和「停摆」（用 `lastPollMono` 判，`lastPollWall`、`lastEventWall` 只作显示）；`human` 记录的字段名（和复核意见合并成两种记录）；Peek 跟随选中的防抖；【P0】标题和告警图标；浏览器通知和 toast 标题的「[测试]」前缀；播报区载入时就在；M1 视图订阅走 client-state；份数超标先开 100 ms 合并（第三份稿尾部）；静默替换单独计数（第三份稿尾部）；计划 §0.5 的 P7 行。没采纳的写在第六节末，各一行理由。
- 推到 M1 的：亮灯测试（daemon 发一条探针条目，走一遍浏览器和 toast 两路，回执后清掉）；乐池条（每个活 Part 一个小图标，约 0.15 天；M0 由空态的分母和源健康条顶着）；ISA-18.2 收件箱健康指标（每小时条目数、泛滥、抖动、超过 24 h 未结，只出报告，和打断计量一起做）。
- 第二轮之后又复核一遍（11 条，C1–C11），都改了，估时不变：「停摆」改用单调钟判；除刹车外 `human` 和 `human.result` 在效果之后同批写，启动对账给任何孤儿 `human` 补 `unknown`（以上两条和刹车计划「两只钟哪个先到」的写法，都要告诉步骤 3）；线 C 改在 2c 做完后开工，空档写清楚；`project.name` 在每种帧里都过检查；`ui:input-name` 扫描规则；D-12 加⑤；D-19 的两处 r4 措辞两种选项下都要答；D-20 不定时也按默认；断线提示的推断时长统一为约 2–4 s；关键路径注明 D-17 的抵扣是推断（最坏约 18.55 天）。
- 第三轮（2026-10-31）：
  - 照 HEAD 的代码把第 2b 步（a83826d，已提交）的事实写进计划：锁没有心跳，daemon.json 每次启动只写一次 `{v, pid, profile, bootId, startedAt}`（createTime 到步骤 6 补），第二个实例的提示写出持有者的 pid 和启动时刻；退出码 20–26（`src/runtime/exit.ts`）；缺 registerHooks 时 boot 以缺特性（21）退出、不 import main.ts；冻住持有者的测试默认就跑、不靠时间余量；停下就结束进程，停下时从不手动放锁；`ports.fetch` 每次新造 init、dispatcher 绑死，步骤 15 之前只服务 `data:`；node:test 下真实 profile 拒绝（也看进程自己的环境）；ui-only 今天以 22 退出、不起 HTTP（步骤 4 怎么做仍视 D-17）。
  - 2c 只列另一个会话正在做的四件（fs 能力在 boot 里造好、process 能力清单、删陪跑规则、钉住进程内 start() 的 home 的仓库测试），仍 0.85 天，还没做完；步骤 6 照旧在 2c 之后、第 5.6 天开工。
  - M1：开眼笔记 §7.5 已由主会话改回「仍待你定」（2f4e46b），两边一致；本文和计划都不把 D-17 写成已定（见上面「开眼笔记要跟着改几句」和第九节）。
  - M2：非刹车动词的 `human` 等效果做完才写，`protect/*`、`dsh-connect` 的 await 期间重试会把效果做两次；步骤 4 加内存 in-flight 表，dsh-connect 的 fetch 加 10 s 超时（推断），`idempotency.test` 加一例并发（第一节 5）。约 0 d。
  - L2：「刹车还有 unknown」改成照实写 unknown 的两个来处；第七节开头的 r4 措辞清单补上 D-13。L3：「停摆」门槛改为 max(3 × 间隔, 15 s)（推断），`sse.test` 加「卡 1 s 不报停摆」。L4：刹车倒计时取 min(`expiresAt` − displayNow, 60 s − 回复后的单调钟时长)，`kill-dialog.test` 加一例。L5：步骤 6 先照步骤 3 写下的 Clock 接口写，第 8.0 天后接上，算在 x 里，x 可能因此变大（计划 §4.1）。L6：第七节和计划 §2.1 的名词解释加上 D-19 的几个词。
  - 估时都不变：关键路径约 18.3 天（只算 2b 约 17.45，最坏约 18.55），串行约 29.5 天。
- 第三轮的复核（2026-10-31，20 条，照 HEAD 的代码核对），都改了，估时不变：
  - 本文：刹车的 `human` 改在所有检查都过、调 procguard 之前写；in-flight 一过去重那一格就登记，后面被拒当场删，`human.result` 那批提交时和去重表在同一个同步回合交接；`protect/*` 的 procguard 超时算请求失败（推断）（第一节 5）。去重跳过的出处改成计划不变量 22。哑 io 的说法照代码改：rename 第 2b 步起已经经 io，今天挡住自造写围栏的只有静态扫描。D-19 的推荐默认照实写成「做 2b 和 2c 的四件；§7.3 另两条未排」（默认没变），名词解释补上环境时钟、脚本也走 boot；D-17 的 0.25–0.5 注明出自开眼笔记 117a3a7 版。
  - 定稿前又收的（同日，6 条小问题和一处代码事实）：journal 断链改为打印原因、以 22 退出、进程内不放锁，两种 D-17 选项都这样（第 2b 步起停下就结束进程，进程内放锁会留下一个丢了锁还活着的进程）；刹车的 `human` 在检查顺序都过之后、执行第 1 步之前写，执行时核对没过的子树记 `refused`、照常写 `human.result`，页面多一种结果「没刹 n 棵」（第一节 2、第三节 3）；`TestRoots` 的几种拒绝在 HTTP 上都回 422 `not-test-root`，`protect/*` 的 procguard 超时回 503 `procguard-timeout`（推断，第一节 5 的表）；测试根解析取命令行是计划不变量 14 的例外；环境时钟并进步骤 3 的 Clock 扫描规则（算在 2.4 天里），脚本也走 boot 仍没排。估时不变。
  - 计划：测试根解析、daemon.json 补 createTime 写进步骤 6；步骤 6 等 2b 的理由改成 WriteIo 和停法（2b 没改 SpawnGate）；§3 补 `exit.ts`、`working.ts` 和 start 的真实次序；node:test 下拒绝真实 profile 写上唯一例外；停下时要做的事放进 `working.ts` 的 `stop()`；步骤 17 接上 toast 常量；步骤 3 的 Clock 接口照写的签名出。

## 九、和开眼笔记第 7 节的对照

开眼笔记 §7.3「第 3–5 步、17、18A：人这一端」比本文早写，也自称是对「前端交互怎么规划」的回答。下表逐条写本文是保留、改了还是去掉，以及理由。两处改动要你定（D-15、D-16），其余是本文的取舍。

**工期**：本文两轮的 +1.45 d 取代 §7.5 的人这一端档（原文第二档：全做约 2.3 d，只做核心四条约 1 d），不另加。安全档（原文第一档）大部分算进 M0 计划的总数：第 2b 步已提交并计入；「第 3 步开工前」五条里的三条，加一条仓库测试，是第 2c 步（按 D-19）；另两条不在 2c 里：环境时钟进步骤 3 的 Clock 扫描规则（算在 2.4 d 里），脚本也走 boot 没估、没排（推断 ≤0.05 天，见 D-19）。门脚本档（原文第三档）见 D-20。这两档都不在本文的 +1.45 d 里。§7.5 还问「ui-only 网页还做不做」，见 D-17（推荐 M0 不发）。§7.5 这一条现在（2f4e46b）写的是「仍待你定，计划里编号 D-17。fork 第二轮评审推荐 M0 不出 ui-only 页面……r4 原写法是 ui-only 提供 Tuning 页。不管怎么定，第 3 步都保留 'ui-only' 这个错误码」，和本文一致。它前一版（bc49949）写「已定：fork 的前端设计保留 ui-only 页面，所有动作返回 503」，那个「已定」指的是本文第一轮，不是你的决定。小差别：§7.5 说几种原因「按各自的退出码退出」，代码现状（和计划步骤 3 对 journal 断链的写法）是都用同一个 ui-only 退出码 22。你定了之后，开眼笔记由它的主会话跟着改。

**通道状态条**

| §7.3 的条目 | 本文 | 理由 |
|---|---|---|
| 心跳改成具名事件 `hb {jseq, bootId}` | 保留，改名 `tick`，多带 `srev`、`serverWall` | 同一件事；`serverWall` 给页面算存在时长 |
| 连续 2 个心跳（30 s）没帧判失联 | 改：5 s 一个 tick，20 s 判过期 | 回环上 5 s tick 几乎不花钱，过期早 10 s 显示 |
| 进入 CLOSED 时读一次 `/api/session`，分三种 | 保留并扩大：分「需要配对（或 orchestrad 重启过）」「连不上」「连接被拒（状态码 N）」三种，另多一种「被顶掉」；任何 `error` 或 `bye` 都先关流再探测，探测有 5 s 超时 | EventSource 出网络错误时不进 CLOSED（第一节 4）；第一轮漏了「连接被拒」，别的状态码会在报错和重开之间按网速打转，第二轮补上 |
| SSE id 取 jseq，重配对后 `?since=jseq` 补差 | 改：每条连接第一帧都是整份快照，不补差 | 只留一条读路径；重载和新标签本来就不带补差参数 |
| 「没有需要你的事 · 截至 jseq N」只在在线时显示；失联时列表变灰、标题加前缀、不闪不响 | 保留：新鲜度和连接状态分开算，页面不新鲜时任何状态下都不说这句（第一节 4、第四节）；标题前缀「[未更新]」 | 第一轮只在 stale 态变灰，connecting、down 下照样会说「没有要你处理的事」，第二轮补上 |

**「你看见了」只能由你的输入铸出**

| §7.3 的条目 | 本文 | 理由 |
|---|---|---|
| seen 只来自显式输入（按 `p/o/s/r/K`、点击行、点通知） | 改：主动选中后停留 500 ms 也算（D-16，要你定） | 只看不按键的条目也算看见；载入、hash、自动改选照 §7.3 不算 |
| toast 深链单列一类 | 改：toast 落地和 hash 深链一样，不算 seen，也不单列成一类 | 页面分不清是你点的 toast 还是别处来的同一个地址；单列要多一种记录，M0 没有用它的地方 |
| 遥测路由不产生状态转换 | 保留：notify-ack 只写 `notifiedAt`，不改条目状态；client-state 不写 journal | — |
| 所有 POST 只从 `ui/api.js` 发出 | 保留 | — |
| noticed 不进 journal，18A 按带版本号的规则重算 | 改：seen 写成 human 记录，noticed 直接从 journal 读（D-16） | 少一份原始证据表；代价写在 D-16 |
| P0 闪烁在第一次显式 seen 或结案时停 | 保留（seen 照 D-16 的定义） | — |

**按身份动作**

| §7.3 的条目 | 本文 | 理由 |
|---|---|---|
| 选中按 itemId 记 | 保留 | — |
| 选中的条目结案后原位留空位，按 `j`/`k` 之前需要目标的键都不起作用 | 部分保留：自动改选同组下一条，但改选后 `e`、`s`、`r`、`K` 都不响应，直到你按 `j`/`k` 或点一行 | 效果和空位一样，又不用多一种行状态和「何时收掉」的规则。第一轮只用 750 ms，挡不住你走开再回来按 `e`，而 M0 的动作都撤不回 |
| 焦点在列表上时冻结排序（r4 §10.9 r4:1663） | 保留（D-12 ④）；合成稿原来漏了，复核后补回 | r4 原文；去掉要改 r4 |
| 动词只带 itemId；对已结案的条目，服务端回 409 并附结局 | 改：照收，结果记 `noop:already-ended`，写进 journal | 结果走流，chip 才能只认流（P5）；409 只在 HTTP 回复里，页面一重载就丢 |
| 不做乐观更新，按键后显示「处理中…」，收到够新的帧才变 | 保留（chip「已发送」） | — |
| 错误原样显示在行里，从不自动重试 | 保留 | — |
| 刹车弹窗写明 harness、项目、pid 和创建时刻；渲染后 750 ms 内确认键无效 | 保留；另外 Enter 永远不执行，只认点击和 Space | 第三节 3 |

**通知分三级：弹出、上屏、看见**

| §7.3 的条目 | 本文 | 理由 |
|---|---|---|
| 浏览器通知在 `show` 事件里才回执 | 改：交给系统就回执，`show` 只进 metric（D-15，要你定） | 「勿扰下 show 可能不来」未核实，先实测；两边的代价写在 D-15 |
| `error` 事件直接转 toast | 保留 | — |
| 上屏时刻（可见、有焦点、行在视口内）记进 metric；18A 报「提交通知 → 上屏 → 看见 → 动作」三段 | 改：M0 报 blocked→noticed、看见→动作和人类动词的时延（都从 journal 或 metric 算），「上屏」这个点移到 M1，和 UI 时延探针一起做 | 要做视口和焦点采样，工期不够。M0 不采这些证据（client-state 不进 journal，行在不在视口从不上报），M1 起才有，M1 也补算不出 M0 的；M0 报告里这几行写「未测」 |
| AudioContext 挂起时记「没响」 | 去掉 | D-13：不用页内声音 |
| 回执改到 show 后，AC3 时延变大是口径变诚实 | 照抄进 D-15 的代价 | — |

**推送用固定词表**

| §7.3 的条目 | 本文 | 理由 |
|---|---|---|
| notify 帧只带枚举和 id | 保留 | — |
| 标题用 `shared/constants.js` 的固定词表拼，只用过了格式检查的 journal 字段和你起的项目名 | 保留，词表放 `shared/strings.js`（`{key,args}`）；args 过格式检查（第一节 2），项目名在每种帧和 toast 里都过检查（你改过的名字免检） | 中文文字和拼字放一处，页面和 toast 共用；`constants.js` 只放枚举。第一轮漏了「过了格式检查」这个条件，第二轮补上 |
| 源文本只留在 Peek 里 | 保留 | — |
| 要你做不同动作的类别标题不同；推测类标题带「推测」 | 保留：`conf` 进标题 key，低置信类的 key 带「推测」（第一节 2）；`static-render.test` 守行的「两两不同」，`strings.test` 逐个查通知标题 key | — |
| 条目结案后收回通知 | 保留：条目结束或稍后才 `close()`；seen 不收回 | 第一轮写成「离开 open 就 close」，500 ms 停留就会收掉系统里那条 |
| 提醒文字默认进通知正文 | 保留：正文取 `ItemView.reminder.text`（第一节 2），notify 帧排在快照之后 | 第一轮的 ItemView 里没有这个字段，第二轮补上 |
| 源文本埋金丝雀串，在通知里出现 0 次 | 保留，并进 `sse.test`（任何帧里 0 次） | — |

**屏幕是投影**

| §7.3 的条目 | 本文 | 理由 |
|---|---|---|
| `shared/view.js` 导出 `view(snapshot, uiState, uiNow) → rows` | 改：描述符在 `ui/view.js`，排序比较函数在 `shared/protocol.js` | daemon 不需要行；两端只共用比较函数 |
| `ui/clock.js` 是 ui 里唯一的时间来源 | 保留 | — |
| 片段被清除时推一帧 purge | 改：不单发 purge 帧；清除和过期不产生 jseq，所以 status 帧的 `snippetRev` 加 1，Peek 开着时见它变了就重取 detail | 少一种帧。第一轮写的是「按 `rev` 重取」，可清除不改 `rev`，开着的 Peek 会一直显示已清除的文字 |
| CI：页面 reducer 吃完前 N 帧，渲染结果和 daemon 在 jseq N 的投影逐行相同，含断线补差 | 改：每帧都是整份快照，reducer 的结果按构造就等于最新快照（`store.test`）；daemon 这一侧用 `view-parity.test` 比「db 编码」和「只从 journal 重建后编码」 | 没有补差，就没有补差路径要比 |

**打断计量只出报告**

| §7.3 的条目 | 本文 | 理由 |
|---|---|---|
| notify 记录带结果枚举（shown / shown-quiet / not-pushed:原因）；18A 报每小时打断数，并事后归为有用、多余、误报、不明四类 | 移到 M1 | 工期。M0 不采 shown-quiet、not-pushed:原因这些证据，M1 起才有，M1 也补算不出 M0 的；M0 报告里这几项写「未测」 |

**§7.6 被否掉的**：
- 「页头显示打断计数」：本文原来在页头放「本次启动已交给系统 n 条」，属于同一类，现在挪到 Tuning（D-15 ③）。源健康条不算这一类：一切正常时它不出现，出现时带一个动作（g t）。
- 「通用的 itemRev / 409」：本文也没有用。
- 「在线 digest 对账」：`tick.jseq` 对不上就关流重开，看起来像它，其实不一样：只比一个整数，不算每批的摘要；走的是已有的重连路径（`why=gap`），不多一个状态；每次都计进 18A 的缺口次数（目标 0），所以重连不会把 bug 藏起来。
