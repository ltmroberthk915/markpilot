#!/usr/bin/env bash
# R8 终局回归门 · 层3 探针回放驱动器（串行，铁律3 单 GUI）
# 每个探针：跑、记退出码、抓汇总行，落 .perf/probe-r8-final/layer3/<probe>.log
cd "$(dirname "$0")" || exit 1
OUTROOT=../../.perf/probe-r8-final/layer3
mkdir -p "$OUTROOT"
SUMMARY=../../.perf/probe-r8-final/layer3-summary.tsv
: > "$SUMMARY"

run_probe() {
  local name="$1" cap="$2" timeout_ms=$(( ($2) * 1000 ))
  local log="$OUTROOT/$name.log"
  echo "[$(date +%H:%M:%S)] START $name (cap ${cap}s)" >> "$SUMMARY"
  timeout --kill-after=10 "$cap" node "$name.cjs" > "$log" 2>&1
  local code=$?
  local line
  line=$(grep -E "汇总|结论|=== (PASS|FAIL)|^结论" "$log" | tail -1 | cut -c1-200)
  [ -z "$line" ] && line=$(grep -E "PASS|FAIL|绿|红" "$log" | tail -1 | cut -c1-200)
  echo -e "$name\texit=$code\t$line" >> "$SUMMARY"
  echo "[$(date +%H:%M:%S)] DONE  $name exit=$code :: $line" >> "$SUMMARY"
}

# R1 家族
run_probe probe-r1-caret 600
run_probe probe-r1-history 600
run_probe probe-r1-mathedit 600
run_probe probe-r1-media 600
run_probe probe-r1-reveal 600
# R2 家族
run_probe probe-r2-code 600
run_probe probe-r2-drop 600
run_probe probe-r2-keys 600
run_probe probe-r2-media2 600
run_probe probe-r2-reveal 600
run_probe probe-r2-tables 600
# R3 家族
run_probe probe-r3-css 600
run_probe probe-r3-doc 600
run_probe probe-r3-evidence 600
run_probe probe-r3-perf 900
# R4 家族
run_probe probe-r4-find 600
run_probe probe-r4-focus 600
run_probe probe-r4-main 600
run_probe probe-r4-menu 600
# R5 家族
run_probe probe-r5-export 900
run_probe probe-r5-theme 600
# R6 家族
run_probe probe-r6-bold 600
run_probe probe-r6-imgdrag 600
run_probe probe-r6-keys2 600
run_probe probe-r6-para 600
# R7 家族
run_probe probe-r7-blind 900
run_probe probe-r7fix2 600
# R8 专案（cutmenu 用于 73 triage；export-crash 最长放最后；menu-diag/shot 取证补充）
run_probe probe-r8-cutmenu 600
run_probe probe-r8-menu-diag 600
run_probe probe-r8-menu-shot 600
run_probe probe-r8-export-crash 2100

echo "[$(date +%H:%M:%S)] ALL DONE" >> "$SUMMARY"
