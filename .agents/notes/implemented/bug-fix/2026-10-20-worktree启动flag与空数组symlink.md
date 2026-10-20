---
Status: implemented
Date: 2026-10-20
---
# `--worktree` 可选值语义与 `symlinkDirectories: []` 关闭 symlink

## 决定了什么

修官网 worktree 页核出的两个「承诺与实现不一致」缺陷（排查报告 20261016）：

- **E1**：`extractWorktreeArg` 预扫描 argv，兑现 help 的 `--worktree[=<name>]`。
  parseArgs 的 `type:"string"` 强制带值，裸 `--worktree` 以前直接报 `argument missing`。
  **只认等号形式**（`--worktree` / `--worktree=` / `--worktree=name`），不吃下一个 token——
  `sid-code --worktree 帮我修登录页` 自动命名 worktree，提示词留在 positionals。
  `worktree` 从 parseArgs 声明摘掉，进 `HELP_ONLY_WHITELIST`（与 resume 同款）。
  help 补一句「仅交互模式」：创建入口仍包在 `if (!config.print)` 里，无头 `-p` 不建 worktree。
- **E2**：`getWorktreeConfig` 对 `symlinkDirectories` 改为「是数组就尊重，含 `[]`」，
  与同函数的 `sparsePaths` 对齐。显式 `[]` 不再被 `length > 0` 回退成默认 `["node_modules"]`。
  schema / `WorktreeConfig` 注释补「设为 [] 可完全关闭 symlink」，官网 use 页按修复后语义改写。

## 放弃了什么（以及为什么不选）

- **E1 抄 extractResumeArg 吃下一个非 `-` token**：能保住 `--worktree my-feature`，但会把正经提示词当 worktree 名。
  help 写的是 GNU `[=<name>]`（等号可选值），不是 resume 那种空格分隔也算值。选 B：行为变化仅限
  「以前 `--worktree foo` 把 foo 当名字」这一条（修复前裸 flag 根本进不去，等号形式不受影响）。
- **E1 把 `--worktree=` 塞回 parseArgs 而不摘声明**：裸 flag 归一成 `--worktree=` 也能过 parseArgs，
  但 `--worktree --print` 仍会撞 ambiguous。整段预扫描更干净。
- **E2 改 mergeSettingsRead 让空数组覆盖上层**：读取合并对字符串数组是拼接去重（权限 deny 同款）。
  为关 symlink 开特例会让「某一层 `[]` 清掉另一层名单」变成静默删除，比现在危险。
  单层 `[]`、其它层省略该键时合并结果就是 `[]`，本缺陷修这一层即可。
- **无头模式也创建 worktree**：超出本次「帮助文本撒谎」的范围；help / 官网点明「仅交互」比悄悄改 `-p` 行为安全。

## 拿什么证明它生效了

见本 PR 验证段：`extract-worktree-arg.test.ts` 覆盖未出现 / 裸 flag / 等号空值 / 等号带值 / 后跟提示词不吃名字；
`config-symlink-empty.test.ts` 覆盖未设置得默认、显式 `[]` 得 `[]`、创建期不链 `node_modules`。
变异自证：把 `extractWorktreeArg` 改回吃下一个 token → 「提示词留 rest」变红；把 `length > 0` 加回 → 空数组用例变红。
