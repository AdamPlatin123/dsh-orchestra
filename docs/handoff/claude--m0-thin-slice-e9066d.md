# Handoff: claude/m0-thin-slice-e9066d

## Facts
- Owner: AdamPlatin123
- When: 2026-11-01
- Machine: 550W备份1号机
- Branch: claude/m0-thin-slice-e9066d（从 main 的 d3fcbcd 切出）
- Commit: 86733d8
- Pushed: no（push 前要问用户）
- Uncommitted on that machine: none（主检出目录里 r4「第七批」的未提交改动不在这条分支上，见 `docs/handoff/main.md`）

## Goal
M0 的「最薄通路」：在计划第 10 步之前，让 orchestrad 以只读方式读一个真实的 Claude Code 或 DSH 会话文件，显示在浏览器里。用户 2026-11-01 选了「两种都读」的切法。

## Done（已完成且已验证）
- 普通权限（Medium 完整性，S-1-16-8192）下的基线：改动前 939 条里 936 过、0 失败、1 跳过、2 todo。上个会话失败的 13 条，原因确实只是提权。验证：`node --test "test/**/*.test.ts"`，Node 用 `.tools/node24/node.exe`。
- `src/lib/zstd/frames.ts`：从 S1-DSH spike 移植的 zstd 帧遍历器，计划第 9 步可以直接用。验证：`test/lib/zstd-frames.test.ts`，在每个字节处截断都不会提前吐帧；故意删掉校验位的 4 字节后测试变红。
- `src/sources/peek.ts`：列出 harness 根下的 Claude transcript（`projects/<目录>/<uuid>.jsonl`）和 DSH v4 日志，读一个会话的最后 200 条事件。所有读取都经读闸门：只用 `'r'` 打开、读完即关、不开 tail 句柄。不留游标，不写 journal 和 db。源里来的每段文字都剥控制字符、过脱敏器，并截到 2 KB。验证：`test/sources/peek.test.ts`，6 条；跳过脱敏后测试变红。
- `src/server/http.ts`：peek 页，只在加了 `--peek-port <端口>` 时才加载。从第 4 步取的部分：只听 127.0.0.1 和 ::1；Host 必须完全相等；一次性配对码（10 分钟，连错 5 次作废）；cookie 带 HttpOnly 和 SameSite=Strict；POST 校验 Origin；`Sec-Fetch-Site` 只放行 same-origin 或 none；不发 CORS 头。页面在服务端渲染、全部转义，不含任何脚本（CSP `default-src 'none'`）。验证：`test/server/peek-http.test.ts`（6 条，HTML 不转义时测试变红）、`test/server/peek-e2e.test.ts`（真正起一个测试 profile 的 orchestrad，从配对一路走到读出两种会话）。
- 改动后全量测试：958 条，955 过、0 失败、1 跳过、2 todo。跳过的一条要开发者模式才能建目录链接。

## Unverified（做了但没验证，或验证没过）
- 真实 profile 加 `--peek-port`，在本机真实数据上显示会话：还没有人跑过。按计划 §6 不变量 11，agent 只能起测试 profile，真实 profile 只能由用户启动。这也是 orchestrad 头一回以真实 profile 启动：会建 `~/.orchestra`。
- 真实数据的样子（多大、多少条、有没有 DSH 文件超过 32 MiB 的读取上限）没在测试里出现过，测试只用合成 fixture。

## Next（按优先级，每条可独立执行）
1. 用户在普通权限、交互式的控制台里运行：先设 `ORCHESTRA_NODE=G:\_Projects\dsh-orchestra\.tools\node24\node.exe`，再在这个 worktree 根目录运行 `orchestra.cmd --peek-port 7470`。浏览器打开 `http://orchestra.localhost:7470/`，输入控制台打印的 8 位配对码。预期：列出 Claude 和 DSH 的会话，点进去能看到最后 200 条事件。结果写回本文件。
2. 只要第 1 条显示有问题（读闸门拒绝、超过上限、乱码），就在 `src/sources/peek.ts` 里修，并补一条合成 fixture 的测试来复现。不要把真实内容放进测试或提交里。
3. 第 1 条通过以后，问用户：合并回 main，还是留在分支上，接着做第 4 步（HTTP、UI 鉴权、SSE，计划第 575 行起）。第 4 步应当把这里的 `--peek-port` 换成从 config 读端口，把 peek 路由并进 `server/routes.ts`，或者删掉。

## Do not touch
- 主检出目录里 r4 的未提交改动：由用户决定什么时候提交。
- `test/repo/contract-freeze.test.ts` 的金样：这条分支没改冻结契约，以后也不应该为 peek 去改它。

## Open questions
- 这一版和计划第 4 步有三处不同，都只针对 peek：页面没有脚本，所以配对表单用 form-urlencoded，不是 JSON；因为除了配对没有改状态的路由，所以没有 CSRF 令牌；端口来自 `--peek-port`，不是 config。第 4 步是照计划改回来，还是保留无脚本的页面，要用户定。
- `test/helpers/scan-rules.ts` 的 global-power-name 规则现在先把 `Sec-Fetch-Site`、`-Mode`、`-Dest`、`-User` 这四个头名抹成空格再匹配（它们不是全局变量）。这条扫描规则放宽了一点，要用户点头。

## Divergence（接手者填写：交接与现实的差异）
- 2026-11-01 AdamPlatin123：桌面应用改成以普通权限运行以后，git 报这个 worktree 的所有者是 BUILTIN/Administrators（是之前提权的会话建的）。处理：每条 git 命令临时加 `-c safe.directory=…`，没有改全局 git 配置。
