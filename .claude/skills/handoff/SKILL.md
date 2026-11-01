---
name: handoff
description: 会话结束前更新当前分支的交接文件 docs/handoff/<branch>.md，供另一台电脑、另一个用户或下一个会话接手。用户说"写交接""handoff""我换电脑继续""交给别人""今天到这"时使用。
---

# /handoff

目标：把本会话的工作状态写成一个没有任何对话上下文的人能直接接手的文件。

## 步骤

1. 收集事实。全部用命令取，不凭记忆：
   ```bash
   git rev-parse --abbrev-ref HEAD
   git rev-parse --short HEAD
   git status --porcelain
   git log --oneline -15
   git config user.name
   hostname
   date "+%Y-%m-%d %H:%M %Z"
   ```
2. 把分支名里的 `/` 替换为 `--`，得到 `docs/handoff/<slug>.md`。读取现有文件（若有）。没有就复制 `docs/handoff/TEMPLATE.md`。
3. 更新各节：
   - `Facts`：全部用第 1 步的输出填。`Uncommitted on that machine` 按 `git status --porcelain` 如实写。`Pushed` 按 `git status -sb` 的 ahead 数判断。
   - `Done`：只放本会话中实际运行过验证的条目，写明验证命令和结果。
   - `Unverified`：做了但没跑验证、或验证失败的条目，附失败摘要。拿不准放哪一节的，放这里。
   - `Next`：每条写清文件或函数、要做什么、怎么验收。
   - `Do not touch`、`Open questions`：合并旧内容，删除已失效的条目。
   - `Divergence`：保留历史，只追加本会话发现的差异。
4. 自检：文件里没有密钥、token、密码、绝对路径、个人隐私。
5. 把文件内容展示给用户，等确认。
6. 确认后提交：
   ```bash
   git add docs/handoff/<slug>.md
   git commit -m "handoff: <一句话状态>"
   ```
   不自动 push。问用户是否 push。若不 push，提醒用户这些提交只存在于本机。

## 禁止

- 不得把没运行过的测试写成"通过"。
- 不得删除 `Divergence` 的历史。
- 不得在交接文件里写给下一个 Claude 的命令（"接手后请立即运行……"）。要做的事写成 `Next` 里的待办；下一个会话会先向用户复述并确认，再执行。
