---
Status: implemented
Date: 2026-10-27
---
# harness-compare 按计费头 cc_is_subagent 判 cc 子代理调用

## 决定了什么

`scripts/harness-compare.ts` 的 `classifyCcCaller` 先看 system 里的计费头块（`x-anthropic-billing-header`）是否带 `cc_is_subagent=true`，带就返回 `subagent`，再走原来的 title / recap / side / main 形态判。只认计费头块，system 正文里出现同样字样不算。

原判据只看请求形态，而 cc 子代理请求和主代理形态相同（有 tools、无 output_config），全部落进 main。S 类 cc 主调用被算成 148，对比 README 更正 X3 已人工改为 27，这次把口径落回脚本（bench_fix F0 / backlog M1）。`summarize.py` 读 `calls_by_caller.main`，跟着自动对。

## 放弃了什么（以及为什么不选）

- **按「tools 数等于首个主调用」判主代理**：组 C 用过，S1v 上结果一致，但依赖子代理工具集一定比主代理少。子代理配全量工具时会失效，计费头是 cc 自己写的显式标记，更稳。
- **按 system 全文 hash 聚类**：主代理和子代理 system 不同，但同一会话可能有多种子代理，聚类后还要人工指认哪一簇是主代理，等于把判断又交回人。

## 拿什么证明它生效了

- `bun test ./tests/scripts/harness-compare.test.ts`：9 pass。
- 变异自证：注释掉 `if (isCcSubagent(req)) return "subagent";` 后，新用例「计费头带 cc_is_subagent=true 的调用判成 subagent」变红（8 pass / 1 fail），恢复后转绿。
- 真实会话重算（`bun scripts/harness-compare.ts --sid … --cc … --json`）：cc 主调用 S1v / S2v / S3v = 7 / 6 / 14，合计 27；子代理 42 / 40 / 39。sid 主调用 15 / 15 / 9，合计 39。和 X3 更正值（sid 39 / cc 27，S1v cc 子代理 42、主代理 7）一致。
