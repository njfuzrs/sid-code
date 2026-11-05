---
Status: implemented
Date: 2026-11-05
---
# 运行指纹纳入墙钟预算 max_duration_ms，k 轮间传错档会被判 INVALID

## 决定了什么

T15（k=3 基线）定为传 `--ak max_duration_ms=<agent 硬顶 × 0.9>`。v0.2.1 计分集只有两档硬顶
（8 题 1800s、24 题 2700s，×3 后 5400s / 8100s），所以每轮要按档分两次 `harbor run`，
分别传 4860000 / 7290000。这样「某轮漏传 / 传错档」就成了一个真实风险，而当时指纹采不到这个值。

改了三处：

- `sid_code_agent.py`：metadata 新增 `sid_max_duration_ms`，取自 `_resolved_flags`
  （与 `sid_max_turns` 同一纪律：Harbor 的 `result.json` 只记显式 `--ak`，默认值不落产物）。
- `run_fingerprint.py`：`FIELDS` / `SOURCES` 加 `max_duration_ms`，逐 trial 读后折叠。
- 测试 fixture（`test-run-fingerprint.py`、`test-eval-verdict.py`）补这一键；TS 门禁
  `tests/eval/harbor-run-fingerprint.test.ts` 加字段清单与 metadata 落盘断言。

## 放弃了什么（以及为什么不选）

- **全部题统一传 4860000**：只需一次 run，但把 24 题的墙钟预算砍掉 40%，测的不再是同一能力。
- **不进指纹、靠跑批脚本自律**：k 轮间配置一致是 T15 的硬要求，靠人记等于没有门禁。
- **在 run 级（config.json 的 kwargs）取值**：只记显式传的 `--ak`，不传时与「不限」不可区分；
  逐 trial 从 metadata 取才能区分。
- **按题名分档记录成 dict**：当前 `_collapse` 要求 run 内单值。因为每次 run 只含一档，
  run 内本来就单值，两档靠「分两次 run、各自比对同档基线」处理，不必改折叠逻辑。

## 拿什么证明它生效了

- `python3 evals/external-benchmarks/harbor/test-run-fingerprint.py` → 通过 57 / 失败 0
  （逐字段变异清单自动覆盖新字段：改 `max_duration_ms` → INVALID 且只点名它）。
- `python3 evals/external-benchmarks/harbor/test-eval-verdict.py` → 通过 81 / 失败 0
  （修 fixture 前 10 条红：两边都缺新键 → INCOMPLETE → INVALID，说明判定器确实在看它）。
- 变异自证（改完 `shasum -a 256 -c` 核复原 OK）：
  M1 采集恒 None → Python 侧 4 条红（missing 非空、base 自比不 VALID）；
  M2 从 FIELDS 删掉 → Python「变异清单覆盖 FIELDS 全集」红 + TS 3 条红；
  M3 适配器不落该键 → TS「三格都写进 metadata」红。
- `bun run affected-tests:run` 1780 pass / 0 fail；lint、format:check、typecheck:gate、make build 全绿。
- 未验证：真实 run 上的采集（需等 T15 第一轮产物）。
