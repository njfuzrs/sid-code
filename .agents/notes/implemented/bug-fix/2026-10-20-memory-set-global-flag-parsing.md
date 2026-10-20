---
Status: implemented
Date: 2026-10-20
---
# /memory set 的 --global 改为 token 级剥离，顺带修掉静默存空 value

## 决定了什么

`packages/cli/src/command/builtins.ts` 的 `case "set"` 分支重写 flag 解析：scope 判定与
value 清理统一用 `parts.slice(2)`（rest）这一个数据源；`--global` 在 join 之前按
**完整 token** `filter` 剥离（不再 `String.replace` 子串删除）；空值检查挪到剥离之后。
三个行为变化：

1. value 正文含 `--global` 子串（如 `value-with---global-inside`）不再被误删，
   scope 也不再被子串命中误判为 global；
2. 多个 `--global` 全部剥离（旧 `replace` 字符串形式只删首个）；
3. `/memory set key --global`（value 仅剩 flag）从「静默存入空 value」改为报用法错误
   ——这是修复前就存在、文档没发现的第二个 bug，本次一并收口。

新增回归测试 `packages/cli/tests/command/memory-set-global-flag.test.ts`（7 用例，
落盘隔离走 `SID_CONFIG_DIR` → tmpdir，读回用独立 MemoryStore 实例验证真实落盘）。

## 放弃了什么（以及为什么不选）

- **保留 `value.replace("--global", "")`、只加 `/g` 标志**：仍是子串匹配，
  正文误删问题不解决，只解决"删几次"。否决。
- **只修 value 清理、scope 继续用 `args.includes()`**：数据源不统一是根因之一。
  key 名含 `--global` 子串时 scope 仍会被误判（`/memory set --global-flag note x`），
  两边结论可以对不上。否决——文档排查记录里第 ③ 点就是这个问题。
- **引入引号感知的 shell-like 分词**：能根治"正文里恰好有独立 `--global` token"
  的固有歧义，但 `/memory` 的分词口径（`split(/\s+/)`，无引号感知）是整个命令
  （set/get/search/list）共享的既有契约，本次只修 flag 解析这一个缺陷，
  不顺手改分词语义。留给将来若真有用户需求再单独提案。
- **接受固有歧义**：`/memory set key use --global flag` 仍会把独立 `--global`
  token 剥掉并置 scope=global——flag 后置设计的固有限制，测试已把它固化为预期行为。

## 拿什么证明它生效了

- `bun test ./packages/cli/tests/command/memory-set-global-flag.test.ts` → 7 pass / 0 fail。
- **变异自证**：把修复临时改回旧逻辑（`args.includes` + `replace`），4 个用例变红
  且各自对应修复点（正文子串误删 / flag 夹中间 / 多 flag 只删首个 / key 子串 scope
  误判）；恢复后全绿。恒绿门禁比没有门禁更危险，这条自证说明测试真的在看缺陷。
- `bun run affected-tests:run`（判定为 packages/cli 全量）→ 2624 pass / 0 fail。
- `bun run lint` / `bun run format:check` / `bun run lint:command-system` → 全绿。
- `bun run docs:gen-reference` → website/ref/ 无漂移（改动不涉及帮助文本）。
- `make build` → 编译产物自检通过。
- `bun run typecheck:gate` 在 worktree 报 8 项新增，逐条核对**无一落在本次改动文件**；
  其中 `ink.tsx` signal-exit 一项在父仓 main 上同样出现（本机 node_modules 环境漂移，
  signal-exit 装的是 4.1.0），且 main 最近 3 个 commit CI 均 success——判定与本次改动无关。
