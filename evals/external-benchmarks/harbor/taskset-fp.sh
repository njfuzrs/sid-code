# 题集指纹闸（source 用，不是直接跑）。
# 依赖调用方已经 `cd` 到本目录，且设好 DATASET、JOB 或 JOBDIR。
#
# 算法在 taskset_fp.py：哈希题名 + lock.json 的 task.digest。
# 旧两段指纹（只含题名）比对时只核前两段，避免在途 job 被新格式误杀。
_HARBOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_TASKSET_PY="$_HARBOR_DIR/taskset_fp.py"
_TASKSET_JOBDIR="${JOBDIR:-runs/${JOB:-}}"

taskset_fp() {
  python3 "$_TASKSET_PY" --dataset "$DATASET" --job-dir "$_TASKSET_JOBDIR" \
    --registry "$_HARBOR_DIR/registry.local.json" compute
}

taskset_fp_gate() {
  python3 "$_TASKSET_PY" --dataset "$DATASET" --job-dir "$_TASKSET_JOBDIR" \
    --registry "$_HARBOR_DIR/registry.local.json" gate
}

taskset_fp_remember() {
  python3 "$_TASKSET_PY" --dataset "$DATASET" --job-dir "$_TASKSET_JOBDIR" \
    --registry "$_HARBOR_DIR/registry.local.json" remember
}
