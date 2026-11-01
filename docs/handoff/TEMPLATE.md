# Handoff: <branch>

## Facts
- Owner: <git config user.name>
- When: <YYYY-MM-DD HH:MM 时区>
- Machine: <hostname 或代号，不写绝对路径>
- Branch: <branch>
- Commit: <写交接时的 git rev-parse --short HEAD。交接文件自己的提交会晚于它，这是正常的，hook 会忽略只改 docs/handoff 的提交>
- Pushed: yes | no（no 时写明原因）
- Uncommitted on that machine: none | <简述。这些内容在其他机器上不存在>

## Goal
<这条分支要达成什么。一两句话，给完全不了解背景的人看>

## Done（已完成且已验证）
- <做了什么> — 验证：<跑了哪条命令或哪个测试，结果如何>

## Unverified（做了但没验证，或验证没过）
- <做了什么> — <没验证的原因，或失败摘要>

## Next（按优先级，每条可独立执行）
1. <文件/函数> — <要做什么> — <预期结果或验收方式>

## Do not touch
- <文件或目录> — <原因>

## Open questions
- <需要人来决定的事>

## Divergence（接手者填写：交接与现实的差异）
- <日期> <谁>：发现 <什么>。处理：<怎么做的>
