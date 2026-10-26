#!/bin/sh
input=$(cat)
eval "$(echo "$input" | jq -r '@sh "dir=\(.workspace.current_dir // .cwd) model=\(.model.display_name // "") effort=\(.effort.level // "") repo=\(.workspace.repo.name // "") used=\(.context_window.used_percentage // "") h5=\(.rate_limits.five_hour.used_percentage // "") h5r=\(.rate_limits.five_hour.resets_at // "") d7=\(.rate_limits.seven_day.used_percentage // "")"')"

c() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
SEP=" $(printf '\033[90m|\033[0m') "

# line 1: model/effort | repo-or-folder (branch) | PR
l1=""
m="${model%% (*}"; [ -n "$effort" ] && m="$m $effort"
[ -n "$m" ] && l1=$(c 33 "$m")
name="${repo:-$(basename "$dir")}"
branch=$(git -C "$dir" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null || git -C "$dir" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
loc=$(c 34 "$name"); [ -n "$branch" ] && loc="$loc $(c 35 "($branch)")"
l1="${l1:+$l1$SEP}$loc"
pr=$(cd "$dir" 2>/dev/null && gh pr view --json number,state,reviewDecision -q 'select(.state == "OPEN") | "#\(.number) \((.reviewDecision // "") | if . == "" then "open" else ascii_downcase | gsub("_"; " ") end)"' 2>/dev/null)
[ -n "$pr" ] && prb="$(c 32 "$pr")"

# line 2: context bar | 5h | 7d
l2=""
if [ -n "$used" ]; then
  u=$(printf '%.0f' "$used"); left=$((100 - u))
  if [ "$left" -lt 20 ]; then col=31; elif [ "$left" -lt 40 ]; then col=33; else col=32; fi
  n=$((u / 10)); [ "$n" -gt 10 ] && n=10
  bar=""; i=0
  while [ $i -lt 10 ]; do
    [ $i -lt $n ] && bar="${bar}█" || bar="${bar}░"
    i=$((i + 1))
  done
  l2="$(c $col "$bar $u%")"
fi
if [ -n "$h5" ]; then
  t="5h:$(printf '%.0f' "$h5")%"
  if [ -n "$h5r" ]; then
    s=$((h5r - $(date +%s)))
    [ "$s" -gt 0 ] && t="$t reset:$((s / 3600))h $(((s % 3600) / 60))m"
  fi
  l2="${l2:+$l2$SEP}$(c 36 "$t")"
fi
[ -n "$d7" ] && l2="${l2:+$l2$SEP}$(c 36 "wk:$(printf '%.0f' "$d7")%")"

printf '%s' "$l1"
[ -n "$l2" ] && printf '%s%s' "$SEP" "$l2"
[ -n "$pr" ] && printf '%s%s' "$SEP" "$prb"
exit 0
