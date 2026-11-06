---
Status: implemented
Date: 2026-11-06
---
# L2 判定器接通 agent-traj-bench：认 score.py 判分行 + 支持分档基线

对应《评测接入 CI/CD》§6.6 **T20** 的前置。T20 dry-run（拿 T15 基线判 T16 那一轮）实测判定器对 v0.2.1 计分集**永远 INVALID**，有两处独立的原因。

## 决定了什么

**1. `verifier_health.verifier_ran` 认 traj-bench 的判分行。**
traj-bench 的 verifier 不是 pytest：`test.sh` 跑 bun test，再由 `score.py` 汇总，stdout 只有一行结论 JSON（`{"reward", "f2p", "p2p", "error_code", …}`）。原判据只认 pytest 结论行，于是每一题都是「verifier未判分」，infra 100%。
新增 `_score_py_concluded`：整行是 JSON 对象、四个键齐全、`reward` 是数（不是 bool）才算。`error_code≠0` 也算判分（判的是 0）；判分超时被杀时 stdout 为空，仍判没判分（T16 的 T0013 就是这个形态）。

**2. `eval-verdict` 支持分档基线 `fingerprints: [...]`。**
traj-bench 一轮是按 `task.toml` 硬顶分两档各跑一次 harbor，两档的 `max_duration_ms` 与题子集都不同。原实现把多个 `--current` 当「补跑合并」，要求它们互相 VALID，于是两档永远 INVALID。
基线改为可给 `fingerprints`（与 `fingerprint` 二选一）。规则是：
- 每个当前 run 必须与恰好一档 VALID，被测二进制照常豁免；
- 每一档都要被匹配到，否则判「没跑全」；
- 所有 run 的二进制 sha / commit 必须相同，因为一次 L2 只测一个版本。

单档基线的路径一行没动。

**3. 顺手修人读输出**：配对比较原来打印「净变化 {down-up:+d}」，↑4/↓0 时显示「净变化 -4」，读起来像退了 4 题。改成只报一个方向、恒非负（「净回退 N」/「净改善 N」）。判定逻辑不变。

## 放弃了什么（以及为什么不选）

- **traj-bench 侧让 score.py 多打印一行 `N passed`**：那等于为了骗过判据伪造一个 pytest 结论行，而且已冻结的 v0.2.1 题集（含 `taskset_digest`）要重发。判据应该认识被测对象的真实输出。
- **用子串 `"reward"` 当判据**：日志里任何地方提到 reward 都会让一题被判成「判分了」，这是本文件头警告过的「巧合正确」。
- **分档时把 `max_duration_ms` / `taskset_digest` 从补跑比对里豁免**：那会让「两次不同配置的 run 拼一个分母」也被放行，正是 `current_fingerprint` 要拦的形态。分档是基线里显式声明的结构，不是放宽比对。
- **把两档合成一份指纹再比**：`taskset_digest` 是按题集算的，合并要重新定义算法，两份实现迟早分叉。

## 拿什么证明它生效了

- 真实产物 dry-run：用 T15 两档指纹做分档基线，判 T16 那一轮两档，结论是 **WARN**。修前是 INVALID。
  - 指纹 VALID，S′ 3/3，配对 ↑4/↓0，降级模式。
  - WARN 来自成本：$6.35 → $10.96，+72.7%。T16 单轮成本确实高于 T15 均值（PR #16 里也记了，未与平台账单对账）。
- `test-eval-verdict.py` 101/0，新增 ⑭ 8 条、⑮ 6 条：
  - ⑭：score.py 行 / error_code≠0 认；空 stdout、缺键、bool reward、子串不认；pytest 行仍认；traj-bench 形态的 run 判 PASS。
  - ⑮：两档新二进制判 PASS；只跑一档判 INVALID；换模型判 INVALID 并点名 `model_id`；两档二进制不同判 INVALID；`fingerprint` 与 `fingerprints` 同给判基线不自洽。
- 变异自证（tmpdir 副本）：
  - 撤掉 score.py 判据：3 条变红，含「infra 100%」原形态。
  - 撤掉分档分支：⑮ 变红，原报错「补跑的 run 之间指纹不一致 … max_duration_ms, taskset_digest」原样复现。
- 其余 harbor 套件全绿：arm-health 44、compare-paired 25、run-fingerprint 62、w3-classify 51、w3-summary 32 等。`bun test tests/eval/` 830/0（含 `harbor-agent-contract` 对 `verifier_ran` 的约束）。
