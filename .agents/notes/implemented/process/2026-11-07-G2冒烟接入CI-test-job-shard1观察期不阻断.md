---
Status: implemented
Date: 2026-11-07
---
# G2 无头回放冒烟接入 CI：挂在 test job 的 make build 之后，只跑 shard 1，观察期不阻断

## 决定了什么

`.github/workflows/ci.yml` 的 test job 在「构建 + 产物自检」（`make build`）之后加一步 `bun run smoke`：

- `if: matrix.shard == 1`：每个平台（ubuntu / macOS）各跑一次。用例与单测分片无关，每个分片都跑只会重复占用 runner。
- `continue-on-error: true`：转正前观察 2 周（专项 M2 验收：0 次非代码原因的红）。观察期内红了只在日志和 step summary 里看得见，不阻断合并。转正 = 删掉这一行，不用改 ruleset，test job 本来就在 `all-checks-passed` 的 `needs` 里。
- `tests/release-flow-contract.test.ts` 加一条反漂移断言：解析 YAML，要求 test job 里有 `bun run smoke` 这一步，且排在 `make build` 之后。

## 放弃了什么（以及为什么不选）

- **新开一个 `smoke` job，用 `actions/download-artifact` 拿二进制**：test job 已经在当场 `make build`，再开 job 要多一次上传和下载，还要把新 job 登记进 `all-checks-passed` 的 `needs`（合约测试会强制）。接在原 job 上，零额外构建、零 ruleset 改动。
- **一上来就做成阻断**：G2 第一次在 ubuntu 上跑，本地只在 macOS 验证过。隔离环境的差异（`/tmp` 的 realpath、PATH 里的 sh/git 等）可能在 ubuntu 上第一次暴露。时红时绿的必需检查会养成「红了就重跑」的习惯，比没有门禁更糟（专项排序原则第 3 条）。
- **每个分片都跑**：4 例共约 1.3s，开销本身无所谓，但会把同一个失败重复报 5 次，干扰判断。

## 拿什么证明它生效了

- 合约测试变异自证（worktree 内）：
  - 基线 1 pass；
  - 把 `run: bun run smoke` 改成 `run: echo skipped` → 0 pass / 1 fail；
  - 把整个冒烟步骤挪到 `make build` 之前 → 0 pass / 1 fail；
  - 还原后 1 pass。
- 本地：`make build` 通过（无 `will always be undefined`），`bun run smoke` 4/4 通过；lint、format:check、typecheck:gate 通过。
- 选测 `bun test ./tests/`：1793 pass / 1 fail。失败的是 `release-archive.test.ts`「ls 前缀匹配陷阱」，耗时 542166ms，期间宿主 09:22:05 睡眠、09:31:08 唤醒（`pmset -g log`）。该文件不读 ci.yml、release-flow-contract 或 smoke 中的任何一个；单独跑这一例通过，完整重跑该文件 2 次都是 27/27。
- 转正依据要等 CI 上的实际运行记录：PR 上 ubuntu 与 macOS 两个 shard 1 的 step summary 都要出现 4 例的结果表。
