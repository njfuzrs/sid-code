# run 指纹采集（source 用，不是直接跑）。
# 依赖调用方已经 `cd` 到本目录，且设好 JOBDIR。
#
# 算法在 run_fingerprint.py：从 run 产物采 §3.4 的必控变量，落 `$JOBDIR/run-fingerprint.json`。
#
# ## 为什么做成 source 而不是「跑完手工cd 一下」
#
# `run-model-switch.sh:446` 那段注释记着同型教训：digest 工具在第九棒就存在，
# 而**九棒里零次被跑过**。价值不在工具，在它被真的执行 —— 一条臂 $36–41，
# 漏采一次就再也补不回来（runs/ 被 gitignore，本机删了就没了）。
#
# ## 只读旁路
#
# 采集失败**一律不改 RUN_RC**：跑分产物已经落盘，采集挂了不该把一次成功的 run
# 判成失败。同理也不该吞掉错误 —— 失败时打印手工重跑命令。
#
# ## network_policy 只能声明
#
# Harbor 把它放在 trial 运行期（`harbor/trial/network_policy.py`），**不写进
# result.json**（2026-11-04 核过 a11-sid 的 10 份产物）。所以由调用方用
# `SID_HARBOR_NETWORK_POLICY` 声明；不声明就留 null（→ 比对时判 INCOMPLETE，
# **不假装知道**）。跑法脚本自己知道用了哪一档，人不必记。

run_fingerprint_collect() {
  local jobdir="${1:-${JOBDIR:-}}"
  local py
  py="$(dirname "${BASH_SOURCE[0]}")/run_fingerprint.py"

  if [ -z "$jobdir" ] || [ ! -d "$jobdir" ]; then
    echo "--- 跳过 run 指纹采集（无 job 目录: ${jobdir:-<空>}）"
    return 0
  fi

  local -a declare_args=()
  if [ -n "${SID_HARBOR_NETWORK_POLICY:-}" ]; then
    declare_args+=(--declare "network_policy=${SID_HARBOR_NETWORK_POLICY}")
  fi

  echo ""
  echo "=== 收尾：run 指纹（方案 §3.4 的必控变量，落 $jobdir/run-fingerprint.json）==="
  if python3 "$py" collect "$jobdir" ${declare_args[@]+"${declare_args[@]}"} 2>&1 | sed 's/^/    /'; then
    echo "    ⚠️ run-fingerprint.json 在 runs/ 下（已 ignore）—— 基线入库时要单独带上它。"
  else
    echo "    ⚠️ 指纹采集失败（不影响已落盘的跑分产物）。手工重跑："
    echo "       python3 run_fingerprint.py collect $jobdir${declare_args[*]:+ ${declare_args[*]}}"
  fi
  return 0
}
