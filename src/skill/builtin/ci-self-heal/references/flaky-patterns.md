// flaky-patterns.md placeholder
// 此文件由 SKILL.md §6 引用. 启发式信号已落在 references/ci-failure-patterns.md §2.7 flaky 段, 本文件保留作 spiral Step 7 边界 case 的"长期沉淀"位置, 当前 Step 4 仅占位.

# Flaky Identification Patterns

> SKILL.md §3.5 引用. 当前 Step 4 阶段, 启发式 pattern 集中在 references/ci-failure-patterns.md §2.7 flaky 段;
> 本文件保留作 Step 7 边界 case 沉淀位置 (例如多次 retry 历史推断 / Date.now 跨时区 等).

## 当前阶段 (Step 4) 已生效 patterns

详见 ci-failure-patterns.md §2.7. 关键信号:

- retry 标记: `retry N` / `attempt M of N`
- 时间相关: `timeout` / `setTimeout` / `sleep` / `Date.now`
- 网络相关: `ECONNREFUSED` / `EADDRINUSE` / `fetch failed`
- 端口冲突: `listen EADDRINUSE` / `port already in use`

## Step 7 待沉淀 (M5+ Daemon 持久化后)

- 跨 run 历史失败率 (同 test 在最近 10 次 CI 中失败 ≥ 3 次 = 高 flaky 信号)
- 时区 / locale 相关失败 (`Date.now` / `toLocaleString`)
- race condition (eventually consistent / async without await)

## 与 retry 配置的区分 (Step 4 实施重点)

- 显式 retry 配置 (vitest.config.ts `retry: N`, jest `--retry N`) → 不算 flaky 信号 (是工具自带 retry)
- 隐式 retry (没有配置但 log 出现 `retry`) → 真 flaky 信号
- 区分依据: 看 log 中 retry 标记是否伴随 "attempt" 字样 + 时间戳间隔
