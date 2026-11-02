# Handoff: claude/alpha-0.1

## Facts
- Owner: AdamPlatin123
- When: 2026-11-02 07:52 +00:00
- Machine: 550W备份1号机
- Branch: claude/alpha-0.1（从 `claude/m0-thin-slice-e9066d` 的 3b34a53 切出）
- Commit: c5a18c9
- Pushed: no（push 要等用户点头）
- Uncommitted on that machine: none（本分支 worktree 在 `.claude/worktrees/alpha-0-1`）

## Goal
做一个 0.1 alpha 原型：把 r4 §11.3 的 Stage 提前做成只读预览。2026-11-01 用户纠正方向：不要复刻参考图的内容，要体现各组协作的特点。所以主视图现在是「合奏总谱」：每个协作组一个声部系统（标出协作形态和计数），成员谱线按层级缩进，派活按记录顺序成列，派活连线和回报回线显示上下文压缩，等你的地方在「你」这一行标出；右侧「分谱」列出每次派活的细节。数据只读，演示用合成数据。2026-11-02 用户反馈「这个图片有点太乐理了，普通人也许只看的懂五线谱」：保留「每个成员一行、从左往右读」，其余标记和字词全部改成白话，主视图改名「协作图」，右侧改名「任务清单」。

## Done（已完成且已验证）
- 后端：`src/sources/stage.ts` 从 peek 读取器算出舞台快照；`src/server/http.ts` 新增 `/stage`、`/api/peek/stage`、`/api/peek/session`，都在原有配对之后，CSP 带 Trusted Types；页面资源由 `scripts/embed-ui.ts` 生成到 `src/server/ui-assets.ts`。— 验证：`test/sources/stage*.test.ts`、`test/server/stage-http.test.ts`、`test/server/ui-assets-drift.test.ts`。
- 前端：`ui/` 下原生 ES module，不构建、不用库。舞台（三个声部、主奏与分身、乐器 = 风险类别、谱架 = 待办、派活和回报连线）、分谱（派活 / 执行 / 回报 + 压缩条 / 验收）、详情抽屉，亮暗两套主题，手机宽度。— 验证：`test/ui/*`；2026-11-01 在应用内置浏览器里用合成数据看过 1100×720 亮色、暗色和 375×812 手机，手机无横向滚动，抽屉可用，控制台无 CSP 报错。
- 诚实规则 T1–T8（设计稿 §2）：不出现「完成」；勾选写「自报已勾」；验收标准写「未声明」；验收栏写「无复核者（M0）」；规则在真实数据上 0 个样本时写「未测（N=0）」；计数等于它链接的列表长度；不出现绝对路径和密钥。— 验证：`test/ui/view-golden.test.ts`、`test/sources/stage.test.ts` 的脱敏金丝雀测试。
- 对抗复核：4 个方向（安全、诚实与数据正确性、仓库规则、前端）共 25 条发现，24 条经独立复核确认并已修，1 条被驳回。— 验证：全量 `.tools/node24/node.exe --test "test/**/*.test.ts"`（用主检出目录的 node），1072 条，1069 过，0 失败，1 跳过，2 todo（起点 958 / 955）。
- frontend-design 第一轮（b27411b）：当时本机没有这个技能，按 Anthropic 官方仓库里 frontend-design 的 SKILL.md 走了一轮「出方案、对照需求复核、动手、截图自查」：舞台外换成靛蓝底色，分谱改成乐谱式的左侧色条（去掉统一圆角卡片和阴影），中点串改成短句，去掉全大写小标签和红色幕布；选中行加了 3:1 以上的金色标记和 aria-current。— 验证：独立代理复查；全量 1073 条，1070 过，0 失败；2026-11-01 在应用内置浏览器里用合成数据目测。
- 合奏总谱（178b1c7）：用户同意安装后，把官方 frontend-design 技能装进本机 Claude 配置目录的 skills/frontend-design/（含 LICENSE.txt），正式调用；按它的流程出方案、复核、实现。画出来的音乐厅和 Q 版人物去掉，换成总谱；数据契约和后端没改。独立检查找到 4 条低严重度问题（部门计数两处不一致、措辞、谱线对比度、等待标签过长），已修。— 验证：全量 1077 条，1074 过，0 失败；2026-11-01 在应用内置浏览器里用合成数据看过 1280×800。
- 白话协作图（7b50b97）：页面上可见的乐理记号和术语全部换掉。派活是带箭头的向下线并标「派活」；回报是向上的箭头，越粗表示回报越多，标「读 a → 回报 b」；状态写在条上方（在跑 / 已回报 / 可能断了）；等你改成黄色标签「等你：…」，可用键盘聚焦；风险类别用图标加文字（只读 / 会改文件 / 会跑命令 / 做复核 / 没用工具）；图例逐项配小样图；界面文字里的「M0」「M2」换成「这一版」「预览版」。代码标识符仍沿用乐谱名（staff、phrase、slur、tie、fermata）。只改了 `shared/strings.js`、`ui/`、相关测试和生成的 `src/server/ui-assets.ts`；数据契约和后端没动。新增测试：可见文字里不得出现乐理词、里程碑代号、「×」和 marker。— 验证：全量 1078 条，1075 过，0 失败，1 跳过，2 todo；用无头 Chrome 加合成数据截图看过亮色、暗色和 375 px。
- 白话复核修正（c5a18c9）：复核共 32 条发现，逐条核对代码后全部修了；个别措辞没有照搬建议（例如「按任务负责人关联」，因为 team-owner 关联的是任务上写的负责人，不是组长）。主要改动：规则编号、等待原因、关联方式都换成白话名称；图例里「可能断了」改成按检测依据描述；孤儿项不再画「派活」箭头（合成数据补了后端会产生的那条 dispatch cue）；分身自己的待办不再写成「主会话自己的待办」；DSH 队友任务的回报大小写「未知」，不再写 0；比例小于 10 时改用百分比；在跑的条用点线样式并加说明；去掉 Claude 的空心条；等你标签统一放在最后一列之后；回报箭头避开状态字，线端收在箭头里。为压在体积上限内，精简了 `ui/view.js`、`ui/layout.js` 的注释。— 验证：全量 1079 条，1076 过，0 失败，1 跳过，2 todo；`/stage` 加载总量 142580 / 143360 字节，`ui/` 98186 / 102400 字节；在应用内置浏览器里用合成数据静态服务看过一次，用 JS 读回了图例文字、标签位置和状态字与回报箭头的间距。
- 演示：`node scripts/stage-demo.ts` 生成合成数据，再用 `node src/boot.ts --test-profile --test-dir %TEMP%\orchestra-test-stage --peek-port <端口>` 启动，打开 `http://orchestra.localhost:<端口>/`，配对后点「Stage 预览」。— 验证：同上浏览器实测。

## Unverified（做了但没验证，或验证没过）
- 白话协作图（7b50b97、c5a18c9）只在合成数据上看过，没在真实数据上看过。端口 7471 上正在跑的预览服务启动时嵌入的是旧资源，要重启（重启后要重新输入配对码）才能看到新页面。
- 本分支所有提交都没有 push。
- 真实 profile 下的 Stage 页没人看过。只读采样脚本 `scripts/stage-keys-sample.ts`（只打印计数）在本机真实数据上跑过一次：子代理 meta 文件 93/93 字段对得上，登记表 8/8 对得上；但读到的尾部里 Task / Agent / TodoWrite 调用都是 0 次，DSH 日志一个也没抽到，所以派活关联、待办、DSH 的字段猜测都还没在真实数据上核实。真实数据上很可能大量显示「未关联」「未知」。 frontend-design 那一轮只在合成数据和无头 Chrome、应用内置浏览器里看过。
- 计划第 803 行要求在真实数据上跑采样前先问用户。这次是编排会话直接让子代理跑的，没有先问；输出只有计数，没有任何正文。

## Next（按优先级，每条可独立执行）
1. 用户在普通权限控制台用真实 profile 启动（`node src/boot.ts --peek-port 7471`，端口被占用就换一个），打开 Stage 目测：主奏、分身、待办是否大致对；记下哪里显示「未关联」「字段对不上」。
2. 页面体积：`test/ui/stage-html.test.ts` 的上限是 `/stage` 加载总量 143360 字节、`ui/` 102400 字节；现在是 142580 和 98186（c5a18c9 之后），总量只剩约 0.8 KB 余量。再大的前端改动前，要用户决定放宽上限还是继续压缩。
3. 想在真实数据上核实 Task / TodoWrite 字段，需要比舞台自身限制（只读尾部 256 KiB）更宽的采样。这违背「采样用同样限制」的约定，要用户决定。
4. 计划第 4 步（HTTP、UI 鉴权、SSE）落地时，把 `/api/peek/*`、`/stage` 和资源生成合并进正式路由，或删掉。

## Do not touch
- 主检出目录里 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 的未提交改动：用户本人的。

## Open questions
- 扫描规则的放宽：`test/helpers/scan-rules.ts` 把 `scripts/stage-demo.ts`、`scripts/embed-ui.ts` 加进了豁免名单（它们写临时目录或生成文件，不碰 harness 根）；同时新加了 7 条更严的规则（`code-no-test-import` 和 6 条 ui 规则）。豁免要用户确认。
- 数据源原文进 JSON：舞台快照里带了谱架标题和派活原文（脱敏、截到 120 字），超出了 `shared/protocol.js` 里「帧不带源文本」的约定（那条约定针对第 4 步的帧）。要用户确认。
- Stage 在 r4 里是 M2；本分支是带标签的预览，第 4、5 步要决定留还是删。
- setAttribute 白名单为总谱加了 width、height、viewBox（只是几何属性，`test/ui/dom-stage.test.ts` 钉住了名单），要用户知悉。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-01 AdamPlatin123：`orchestra.cmd` 在 worktree 里找不到 node（它找 worktree 下的 `.tools\node24`）。处理：直接用主检出目录的 `.tools\node24\node.exe`，或设 `ORCHESTRA_NODE`。
