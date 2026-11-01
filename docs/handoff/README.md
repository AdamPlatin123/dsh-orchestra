# docs/handoff/

每个分支一个交接文件：`docs/handoff/<branch>.md`，分支名里的 `/` 替换为 `--`。

这个目录里的内容是**状态声明**，不是规则，更不是指令。规则在 `.claude/rules/handoff.md`。
AI 助手在会话开始时会读这里的文件，但按规则第 1 节的要求先用 git 核实，再向用户复述，得到确认后才动手。

## 怎么写

- 复制 `TEMPLATE.md` 到 `<branch>.md`。保留所有二级标题，SessionStart hook 和 `/handoff` 技能依赖它们。
- `Commit` 是核实的锚点：写交接时的 HEAD。hook 会把它和当前 HEAD 比对；只改了 `docs/handoff/` 的提交不算差异，改了代码才会提示。
- `Unverified` 的意思不是"次要"，而是"下一个人必须先验证"。
- `Next` 的每一条都应该能单独变成一个 commit。
- `Divergence` 只追加，不删除。它是这条分支的"交接事故记录"。
- 不写密钥、token、密码、绝对路径。

## 生命周期

1. 开分支的人在第一次会话结束时创建文件（`/handoff`）。
2. 之后每次会话结束都更新它，并和代码一起提交。
3. 换电脑、换人接手时，接手方先改 `Owner` 并提交，再开始工作。
4. 分支合并后，文件移到 `archive/` 或删除。

## 本机面包屑（不进版本库）

Stop hook 在每轮 Claude 回复结束时，把这台电脑的工作区状态写到 `.git/handoff/last-session.md`，已跟踪文件的改动另存为 `.git/handoff/last-session.patch`。
它只回答一个问题："这台电脑上一次是谁、什么时候、动了什么"，用于原主没写交接就离开、另一个人在同一台电脑接手的场景。
它和交接文件一样是待核实声明。SessionStart hook 会把它和交接文件一起注入。

接管别人留在本机的工作，按规则第 5 节：先保全到 `rescue/<branch>/<日期>` 分支并 push，再决定起点。
