---
Status: implemented
Date: 2026-10-27
---
# harness-compare 按 provider 把 input_tokens 归一成未命中余量

## 决定了什么

`scripts/harness-compare.ts` 新增 `uncachedInput`：provider 不是 anthropic 时，`input_tokens` 减去 cache_read 和 cache_write，再写进宽表。主代理调用的 provider 从同 `pair_index`、无 caller 的 `BilledRequest` 取（raw.jsonl 不记 provider），子代理调用直接用 `BilledRequest.provider`。provider 缺省时按 anthropic 处理，保持旧数据不变。

原因：宽表的命中率分母是 `cr + cw + inp`，要求 `inp` 是未命中余量（Anthropic 口径）。OpenAI 协议族的 `input_tokens` 是 `prompt_tokens`，**已经含命中**（`packages/core/src/llm/types.ts` `normalizeCacheUsage` 的注释写明了这一点），deepseek 走网关时 provider 正是 `openai`。不改的话，F3 的维度 2（缓存命中）在 sid 一侧会整体被算低一半（bench_fix F0 核查项 K3）。

## 放弃了什么（以及为什么不选）

- **在采集台 summarize.py 里事后修正**：宽表 `calls.tsv` 也会被组 A/B 的分析脚本直接读，只修汇总层的话，逐调用数据仍然是错数。
- **改 sid-code 运行时，让 raw.jsonl 记归一化后的值**：raw.jsonl 的契约是记 provider 原始 usage，其他消费者（`normalizeCacheUsage` 的调用方）依赖这一点，口径分歧应该在读取侧收口。
- **按模型名判断（`deepseek` 子串）**：同一模型可能走 anthropic 兼容网关，判据应跟协议走，不跟模型名走（记忆：禁按模型硬编码分级）。

## 拿什么证明它生效了

- `bun test ./tests/scripts/harness-compare.test.ts`：11 pass。新用例用 F0 冒烟会话 `20261027-103231-dca269fa` 第 2 次调用的真实形态（prompt 54903，命中 53248），断言主调用 inp=1655、子代理 inp=100、命中率=53248/54903。
- 变异自证：把 `uncachedInput` 改成恒返回 input，新用例变红（10 pass / 1 fail），恢复后转绿。
- 旧数据不变：`87ee25dd` 版与本版在 S1v（opus）上 `--tsv` 输出 md5 相同（`3f4e49a7…`）。
