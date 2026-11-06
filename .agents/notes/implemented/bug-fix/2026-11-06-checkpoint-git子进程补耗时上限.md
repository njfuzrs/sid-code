---
Status: implemented
Date: 2026-11-06
---
# checkpoint 的 git 子进程补耗时上限：卡住时 3s 放弃并降级为空集

## 决定了什么

`packages/core/src/checkpoint/bash-affected-files.ts` 的两处 git 子进程调用都补上
`timeout: GIT_SUBPROCESS_TIMEOUT_MS`（3000ms），并把 `getGitWorkingSetFiles` 里的两条
`git diff` 由串行改为并行（`Promise.all`）；常量导出，供测试断言用。

行为变化只有一处：git 在异常环境里卡住时，文件集提取在约 3s 后放弃、走两处调用点既有的
catch 降级为空集，不再无限等待。正常路径不变（实测个位数到两位数毫秒，远不到 timeout）。

为什么这属于生产缺陷而不只是测试 flake：`packages/core/src/query/tool-executor.ts:1969-1972`
在**每次破坏性 bash 执行前**同步 `await getBashAffectedFiles(...)`。没有 timeout 时 git 一旦
不返回，这次 bash 调用就一起挂住；CI 上的表现只是它最容易被看见的那一面
（2026-11-06 `test (macos-latest, 1/2)` 里该用例 5000.77ms 撞 bun 默认 5s 超时）。

## 放弃了什么（以及为什么不选）

- **只给测试加显式 timeout / 只重跑 CI**：测试会变绿，生产路径仍然会挂住。症状搬家不算修复。
- **对齐 `packages/core/src/tool/bash/shell-snapshot.ts:29` 的 10s**：那是 shell 快照脚本，
  可接受较长的上限；checkpoint 在 bash 执行前卡 10s 是用户可感知的交互延迟。且两条 diff
  并行后最坏耗时就是单条 timeout，3s 已经比实测慢两个数量级。
- **把提取改成 fire-and-forget（不 await）**：checkpoint 必须在破坏**发生前**拿到文件集，
  否则快照晚于破坏，回滚语义直接失效。这个方案看起来最"快"，实际是把保护关掉。
- **把 timeout 做成配置项（env / settings）**：没有真实调参场景，新增配置面还要同步
  help 的 env 段与官网参考页，成本大于收益。真要调，改常量是一个可 review 的 diff。
- **保留串行**：两次都卡住就是 2×timeout（6s），足以再次撞穿 5s 的调用方预算。两条 diff
  互不依赖，并行没有语义代价。

## 拿什么证明它生效了

- **新用例**（`bash-snapshot.test.ts`：假 git = `#!/bin/sh` + `exec sleep 30`，PATH 前置）：
  有 timeout 时 `getBashAffectedFiles("git reset --hard HEAD~1", dir)` 于 **3003.56ms**
  返回 `[]`，整文件 **20 pass / 0 fail**（含原有 19 条，git clean 真实仓库路径也在内）。
- **变异自证**：用 perl 删掉两处 `timeout` 后，同一用例 **15006.46ms 撞自身 15s 显式超时变红**
  （19 pass / 1 fail，报错原文 `this test timed out after 15000ms`）；恢复后重新 20 pass / 0 fail。
  这条证明用例真的在验证 timeout，而不是"git 立即失败也返回空集"的恒绿。
- **门禁**：`bun run affected-tests:run` 93 pass / 0 fail（10 files）；`bun run lint` 0 warning；
  `format:check` 通过；`lint:boundary` / `lint:command-system` / `lint:legacy-tool` 通过；
  `typecheck:gate` 62 处（基线 64，无新增）；`make build` 成功且产物自检 5 项全绿。
- **现场对照**：2026-11-06 那个 run 里，同一提交在 ubuntu 3 片 + `test (macos-latest, 2/2)`
  全绿，只有 `test (macos-latest, 1/2)` 的这条用例超时——与"慢 runner 上 git 偶发卡住"一致。
