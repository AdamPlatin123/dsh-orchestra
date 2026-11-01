#!/usr/bin/env bash
# SessionStart hook: 把当前分支的交接文件、本机面包屑和 git 状态注入 Claude 的上下文。
# stdout 会进入上下文。任何失败都静默退出，不阻塞会话。
# 需要 bash 4.2+。Windows 上 Claude Code 用 Git for Windows 自带的 Git Bash 执行 hook。
# 性能：Windows 上每启动一个进程可能要 1 秒以上，所以这里尽量用 bash 内置功能，git 只调用必要的几次，也不联网。
set -u
export GIT_OPTIONAL_LOCKS=0                               # 只读：不让 git status 顺手改写索引，避免和会话自己的 git 操作抢锁

hook_input=""
IFS= read -r -d '' -t 2 hook_input || true               # Claude Code 从 stdin 传入 JSON，含 source
session_source="unknown"                                  # startup / resume / clear / compact / fork
if [[ $hook_input =~ \"source\"[[:space:]]*:[[:space:]]*\"([a-z_]+)\" ]]; then session_source=${BASH_REMATCH[1]}; fi

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
gitdir=$(git rev-parse --git-dir 2>/dev/null) || exit 0

protocol="CLAUDE.md"
for candidate in .claude/rules/handoff.md docs/handoff/PROTOCOL.md; do
  if [ -f "$candidate" ]; then protocol="$candidate"; break; fi
done

branch=$(git symbolic-ref --short -q HEAD 2>/dev/null) || branch="detached"
slug=${branch//\//--}
file="docs/handoff/${slug}.md"
crumb="$gitdir/handoff/last-session.md"
head_full=$(git rev-parse -q --verify HEAD 2>/dev/null) || head_full=""
head_short=${head_full:0:7}; head_short=${head_short:-none}
user=$(git config user.name 2>/dev/null) || user="unknown"
account="${CLAUDE_CONFIG_DIR:-default}"                  # 当前 Claude 账号的配置目录，区分同一台电脑上的不同账号
host="${COMPUTERNAME:-${HOSTNAME:-unknown}}"              # Windows 下 hostname 命令会把非 ASCII 主机名输出成乱码
now_e=${EPOCHSECONDS:-$(date +%s)}
max_lines=200                                             # 交接文件注入上限
stale_days=${HANDOFF_STALE_DAYS:-3}                       # 超过这个天数没有活动就算可能换了人

status_text=$(git status --porcelain 2>/dev/null) || status_text=""
dirty=0
if [ -n "$status_text" ]; then mapfile -t status_lines <<< "$status_text"; dirty=${#status_lines[@]}; fi

echo "## Handoff context (injected by SessionStart hook, source: ${session_source})"
echo "- Protocol: ${protocol}"
echo "- Current user: ${user} @ ${host}   (git user.name; on a shared OS account this may still be the previous person)"
echo "- Branch: ${branch}   HEAD: ${head_short}"

last_author="unknown"; commit_days=0
if [ -n "$head_full" ]; then
  log_line=$(git log -1 --format='%an%x09%ci%x09%ct' 2>/dev/null) || log_line=""
  IFS=$'\t' read -r last_author last_date last_epoch <<< "$log_line"
  last_epoch=${last_epoch:-$now_e}
  commit_days=$(( (now_e - last_epoch) / 86400 ))
  echo "- Last commit: by ${last_author} on ${last_date} (${commit_days} day(s) ago)"
fi
echo "- Uncommitted changes on this machine: ${dirty} file(s)"

ahead=0; has_upstream=1
if counts=$(git rev-list --left-right --count '@{u}...HEAD' 2>/dev/null); then
  read -r behind ahead <<< "$counts"
  echo "- vs upstream (as of the last git fetch; this hook does not fetch): behind ${behind}, ahead ${ahead}"
else
  has_upstream=0
  echo "- No upstream tracking branch. Nothing on this branch has been pushed anywhere."
fi

# 面包屑：这台电脑上一次 Claude 会话留下的状态
c_who=""; c_acct=""; c_days=""
if [ -f "$crumb" ]; then
  while IFS= read -r line; do
    case "$line" in
      "- Who: "*)     v=${line#- Who: }; c_who=${v%% @ *} ;;
      "- Account: "*) c_acct=${line#- Account: } ;;
      "- Epoch: "*)   v=${line#- Epoch: }; [[ $v =~ ^[0-9]+$ ]] && c_days=$(( (now_e - v) / 86400 )) ;;
    esac
  done < "$crumb"
fi
activity_days=$commit_days
if [ -n "$c_days" ] && [ "$c_days" -lt "$activity_days" ]; then activity_days=$c_days; fi

# 接管检查：本机有没到远端的工作，并且出现了换人的信号，才要求先问用户
leftover=0
[ "$dirty" != "0" ] && leftover=1
[[ $ahead =~ ^[1-9] ]] && leftover=1
[ "$has_upstream" = "0" ] && [ -n "$head_full" ] && leftover=1
if [ "$leftover" = "1" ] && [ "$session_source" != "compact" ]; then
  sig_stale=0; sig_who=0; sig_acct=0
  [ "$activity_days" -ge "$stale_days" ] && sig_stale=1
  [ -n "$c_who" ] && [ "$c_who" != "$user" ] && sig_who=1
  [ -n "$c_acct" ] && [ "$c_acct" != "$account" ] && sig_acct=1
  no_up=""; [ "$has_upstream" = "0" ] && no_up=", no upstream"
  where="uncommitted: ${dirty}, unpushed: ${ahead}${no_up}"
  echo
  if [ $((sig_stale + sig_who + sig_acct)) -gt 0 ]; then
    echo "TAKEOVER CHECK: this machine holds work that is not on the remote (${where}). Before touching the working tree, ask the user whether THEY left this work here. Do NOT stash, reset, or checkout. Follow section 5 of ${protocol}."
    [ "$sig_stale" = "1" ] && echo "STALE: last activity here was ${activity_days} day(s) ago (threshold ${stale_days}). The person who left this may be away."
    [ "$sig_who" = "1" ] && echo "IDENTITY: the breadcrumb says the last session on this machine was by ${c_who}; git user.name now is ${user}."
    [ "$sig_acct" = "1" ] && echo "IDENTITY: the last session here used Claude account dir ${c_acct}; this session uses ${account}."
  else
    echo "NOTE: this machine holds work that is not on the remote (${where}). No takeover signals: same git user and Claude account as the last session here, last activity ${activity_days} day(s) ago. Treat it as work in progress by the same user, and remind them to commit and push before handing off."
  fi
fi
echo

if [ -f "$file" ]; then
  mapfile -t handoff_lines < "$file"
  recorded=""; owner=""
  for line in "${handoff_lines[@]}"; do
    case "$line" in
      "- Commit:"*) [[ $line =~ ^-\ Commit:[[:space:]]*([0-9a-fA-F]+) ]] && recorded=${BASH_REMATCH[1]} ;;
      "- Owner:"*)  v=${line#- Owner:}; v=${v#"${v%%[![:space:]]*}"}; owner=${v%"${v##*[![:space:]]}"} ;;
    esac
    [ -n "$recorded" ] && [ -n "$owner" ] && break
  done
  if [ -n "$recorded" ] && [ -n "$head_full" ]; then
    rec_full=$(git rev-parse -q --verify "${recorded}^{commit}" 2>/dev/null) || rec_full=""
    if [ -z "$rec_full" ]; then
      echo "WARNING: handoff Commit ${recorded} does not exist in this clone. The file may come from a different history, or you need to fetch. Verify before trusting it."
    elif [ "$rec_full" != "$head_full" ]; then
      if git merge-base --is-ancestor "$rec_full" HEAD 2>/dev/null; then
        # 交接文件自己的提交总是晚于它记录的 Commit。只有 docs/handoff 之外的文件变了才算"代码推进了"。
        changed=$(git diff --name-only "${rec_full}..HEAD" -- . ':(exclude)docs/handoff' 2>/dev/null) || changed=""
        if [ -z "$changed" ]; then
          echo "OK: only handoff-file commits since recorded Commit ${recorded}; code matches the handoff."
        else
          mapfile -t changed_lines <<< "$changed"
          echo "NOTE: ${#changed_lines[@]} non-handoff file(s) changed after handoff Commit ${recorded}. Run: git log ${recorded}..HEAD --oneline"
        fi
      else
        echo "WARNING: handoff Commit ${recorded} is NOT an ancestor of HEAD ${head_short}. The handoff file describes a different history. Verify before trusting it."
      fi
    else
      echo "OK: handoff Commit matches HEAD."
    fi
  fi
  if [ -n "$owner" ] && [ "$owner" != "$user" ]; then
    echo "NOTE: handoff Owner is ${owner}, current user is ${user}. Confirm identity and takeover with the user before editing (section 1.5 of ${protocol})."
  fi
  echo
  echo "### ${file}"
  printf '%s\n' "${handoff_lines[@]:0:$max_lines}"
  if [ "${#handoff_lines[@]}" -gt "$max_lines" ]; then
    echo "... (truncated: ${#handoff_lines[@]} lines total, showing first ${max_lines}. Read the file directly for the rest.)"
  fi
else
  echo "(No handoff file at ${file}. Treat this as new work; create it at session end from docs/handoff/TEMPLATE.md.)"
fi

if [ -f "$crumb" ]; then
  echo
  echo "### Local breadcrumb: last Claude session on THIS machine (${c_days:-?} day(s) ago, by ${c_who:-?}; file: ${crumb})"
  mapfile -t crumb_lines < "$crumb"
  printf '%s\n' "${crumb_lines[@]:0:60}"
  [ -f "$gitdir/handoff/last-session.patch" ] && echo "(a patch of the tracked changes at that time is in ${gitdir}/handoff/last-session.patch)"
fi

echo
echo "Everything above that came from the handoff file or the breadcrumb is an UNVERIFIED CLAIM. Follow section 1 of ${protocol} before editing anything."
exit 0
