# Handoff: claude/running-panel

## Facts
- Owner: AdamPlatin123
- When: 2026-11-06
- Machine: 550W备份1号机
- Branch: claude/running-panel（从 `claude/orchestra-app` 的 8eb2215 切出；不含改派分支 `claude/serene-merkle-3ac513`）
- Commit: 见本文件所在的提交
- Pushed: no（用户没让推）
- Uncommitted on that machine: 无

## Goal
首页 `/` 的 running 界面（用户 2026-11-05 选「先不 fork，做界面」）：底部「xxx 正在做」胶囊 → 点开右栏 → 每个正在做的 worker 一张卡（名称 + 箭头 / 类型 · 成员数 · 开了多久 / 成员状态点）→ 再点卡片推入细节子页。不 fork DS-Bot，不读 DS-Bot 数据（那是 r4 的 M2 只读遥测）。

## Done（已完成且已验证）
- 胶囊 `#cap-run`（`ui/home.html` 的 #isl）：「A、B 正在做 · +N」，等你的排前面；猜出来的状态不算正在做（T1）；快照被截断时说「没读到」而不是「没有」；尾部「成员出错 N」。
- 右栏 `#right`：宽屏默认收起，点胶囊展开，选择存 localStorage `orchestra.home.right`；窄屏（≤899px）是抽屉，不自己打开，焦点圈在抽屉里，盖住的部分 `visibility: hidden`；窄屏关抽屉不改宽屏的选择，变回宽屏时恢复宽屏的选择。
- 卡片：`ui/fold.js` describeRun（复用 foldFace、memberRow），汇总在 `ui/wings.js` runCards / describeRunCap / describeRunList / describeRunPage。卡上的「等你」按审批件数算（`askingOf`：自有会话的根节点替子代理等待，不重复算），和胶囊一致（T3）。不在做、但有成员出错的 worker 另起一组。
- 细节子页 `#run-page`：返回键和 Esc 回到原卡片；轮询时不跳；只有根成员有「打开」（去左侧会话详情）；没有批准、拒绝、刹车按钮（D8）。
- 原 subs 折叠卡保留「在卡内展开」；右栏收起时不画线，点对话里的派发行会展开右栏。
- 验证：
  - 全量 `node --test "test/**/*.test.ts"`（node 用主检出目录的 `.tools/node24/node.exe`）：1799 条，1796 过，0 失败，1 跳过，2 todo（基线 8eb2215：1782 / 1779 / 0）。新测试在 `test/ui/run-panel.test.ts`（17 条），去掉对应实现时会失败（逐条做过反向验证）。
  - 多代理复核三个视角：确认 10 条，全部修好并配了测试，没有被推翻的。
  - 测试 profile 实走（内置浏览器，1280/1024/375，深浅色）：派一个 Codex 自有会话起两个子代理，胶囊、展开、卡片三行、子页、Esc、焦点、清理都看过。实走发现的两处（卡上「等你」多算一个、窄屏关抽屉改掉宽屏偏好）已在本提交修好，只有单元测试复核，没再实走。
- 页面体积上限放宽：`test/ui/home-page.test.ts` 自有文件 128 KiB、总量 316 KiB；`test/ui/tower-page.test.ts` 240 → 242 KiB（/tower 也加载 strings.js 和 prefs.js）。

## Unverified（做了但没验证，或验证没过）
- 「开了 X」从 `/api/owned` 的 createdAt 算，不是附图的「这一回合跑了多久」；只读会话和未解锁时写「开了多久未知」。真值要服务端加字段，没加。
- 抽屉没有 `role="dialog"` / `aria-modal`（`ui/dom.js` 允许的属性里没有 inert）；读屏的浏览模式没在真读屏上试过。
- 推断状态、成员超过 16 个的分段条、非自有会话的卡，都只有单元测试，实走时测试 profile 里没有这类数据。
- 窄屏点「打开」后抽屉是否自己关、焦点去向，没实走。

## Next（按优先级，每条可独立执行）
1. 用户决定这条分支的去向：合进 `claude/orchestra-app`（基于 8eb2215，可快进），以及和改派分支 `claude/serene-merkle-3ac513` 谁先合（两者都改了 `ui/home.html`、`shared/strings.js`、`src/server/ui-assets.ts`，后合的那个要重跑 `scripts/embed-ui.ts` 并解冲突）。
2. 用户在真实 profile 上看一眼（代-2：真实 profile 只由用户启动）。
3. 要附图那样的「已运行时长」：在 tower 快照或 `/api/owned` 行上加「本回合开始时间」字段，`ui/wings.js` runSince 改读它。

## Do not touch
- 主检出目录里 `docs/specs/2026-10-27-dsh-orchestra-design-r4.md` 的未提交改动（用户本人的第七批）。

## Open questions
- 右栏默认收起，和第三轮方案 22（右栏常驻）不同；这是按用户这次原话做的，要不要在计划里改一句，由用户定。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-06 AdamPlatin123：这个 worktree 原先的空分支 `claude/request-reassign`（8eb2215，无提交）改名成了 `claude/running-panel`；改派实际做在 `claude/serene-merkle-3ac513`。
