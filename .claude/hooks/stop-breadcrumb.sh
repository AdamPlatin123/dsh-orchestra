#!/usr/bin/env bash
# Stop hook: 每轮回复结束时把本机工作区状态写成面包屑。在 settings.json 里设为 async，不阻塞回复，也不输出。
# 文件放在 .git/ 下（worktree 则在它自己的 gitdir 下），永远不会进版本库，只服务"同一台电脑、下一个人接手"的场景。
# 性能：尽量用 bash 内置功能，git 只调用必要的几次。
set -u
export GIT_OPTIONAL_LOCKS=0                               # 不让 git status 顺手改写索引，避免和会话自己的 git 操作抢锁
IFS= read -r -d '' -t 1 _ || true                        # 吃掉 stdin 的 JSON，这里用不到
cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
gitdir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
head_full=$(git rev-parse -q --verify HEAD 2>/dev/null) || exit 0   # 空仓库不写
dir="$gitdir/handoff"
mkdir -p "$dir" 2>/dev/null || exit 0

branch=$(git symbolic-ref --short -q HEAD 2>/dev/null) || branch="detached"
user=$(git config user.name 2>/dev/null) || user="unknown"
host="${COMPUTERNAME:-${HOSTNAME:-unknown}}"
now_e=${EPOCHSECONDS:-$(date +%s)}
printf -v now_h '%(%Y-%m-%d %H:%M %z)T' "$now_e"
status_text=$(git status --porcelain 2>/dev/null) || status_text=""
dirty=0
if [ -n "$status_text" ]; then mapfile -t status_lines <<< "$status_text"; dirty=${#status_lines[@]}; fi
ahead=$(git rev-list --count '@{u}..HEAD' 2>/dev/null) || ahead="all (no upstream)"
stat_text=$(git diff HEAD --stat 2>/dev/null) || stat_text=""

{
  echo "# Last Claude session on this machine"
  echo "(auto-written by the Stop hook after every turn; lives in .git/, never committed; an UNVERIFIED CLAIM like any handoff file)"
  echo "- Who: ${user} @ ${host}"
  echo "- Who-note: git user.name; may still be the previous person on a shared OS account"
  echo "- Account: ${CLAUDE_CONFIG_DIR:-default}"
  echo "- When: ${now_h}"
  echo "- Epoch: ${now_e}"
  echo "- Branch: ${branch}  HEAD: ${head_full:0:7}"
  echo "- Uncommitted files: ${dirty}"
  echo "- Unpushed commits: ${ahead}"
  echo
  echo "## git status --porcelain"
  if [ -n "$status_text" ]; then printf '%s\n' "${status_lines[@]:0:200}"; else echo "(clean)"; fi
  echo
  echo "## git diff HEAD --stat"
  if [ -n "$stat_text" ]; then mapfile -t stat_lines <<< "$stat_text"; n=${#stat_lines[@]}; s=$(( n > 40 ? n - 40 : 0 )); printf '%s\n' "${stat_lines[@]:$s}"; fi
} > "$dir/last-session.md.tmp" 2>/dev/null && mv -f "$dir/last-session.md.tmp" "$dir/last-session.md" 2>/dev/null

# 已跟踪文件的改动保存成补丁，作为工作区被人动过之后的最后一道保险。未跟踪文件只记名字。
if [ -n "$stat_text" ]; then
  git diff HEAD --binary > "$dir/last-session.patch.tmp" 2>/dev/null && mv -f "$dir/last-session.patch.tmp" "$dir/last-session.patch" 2>/dev/null
else
  rm -f "$dir/last-session.patch" 2>/dev/null
fi
exit 0
