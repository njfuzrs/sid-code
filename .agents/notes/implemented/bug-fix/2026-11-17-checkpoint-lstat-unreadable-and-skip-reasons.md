---
Status: implemented
Date: 2026-11-17
Source: 文件检查点非普通文件快照与undo死循环-修复方案（2026-11-16）
---
# 检查点的「类型无法判定」必须是独立一态，且跳过原因要一路传到展示层

## 决定了什么

P4（#898）把 `createSnapshot` 的判据换成 `lstatSync` 之后，留了两个洞。本 PR 收口：

1. `classifyPathForSnapshot`（`packages/core/src/checkpoint/manager.ts`）加 `try/catch`，新增第四态
   `unreadable`。`lstatSync(..., { throwIfNoEntry: false })` **只**把 ENOENT 变成 `undefined`，
   ENOTDIR / EACCES / ENAMETOOLONG 照样抛。抛出去有两条实测后果：
   - `createSnapshot` 外层 catch 后 `return ""` ⇒ **整批**丢失（同批真文件也不进快照）；
   - `undo()` / `undoFile()` / `restoreToSnapshot()` / `restoreBeforeSnapshot()` 的循环体没有外层
     catch ⇒ 整个 `/undo` 抛错且快照不消耗 ⇒ 与本类目要修的死循环同一种形态。
2. `skippedFiles.reason` 扩成 `"non-regular" | "unreadable"`（缺省仍是 too-large），日志分三组；
   `too-large` 的判据从 `reason !== "non-regular"` 改成 `reason === undefined`——否则新态会被
   算进「超过单文件上限」，同一个撒谎换个说法。
3. `restore.ts` 的确认面板把渲染抽成纯函数 `formatUnprotectedLines`，三类原因各成一组，
   非普通文件/不可读路径不再显示无意义的 `0.0MB` 与「超过单文件上限」。
4. 补测试：ENOTDIR 用**自造样本**（`<tmp>/blocker.bin/sub/note.md`，中间段是普通文件），
   不依赖本机历史数据；另补 `undoFile` 的兼容分支（摘条目 + 空快照分片真删）。

## 放弃了什么（以及为什么不选）

- **把 `unreadable` 并进 `non-regular`**：行为一样（跳过），但日志与 `/restore` 面板会把
  「路径本身非法」说成「这是个设备文件」——正是本次要消灭的那类误导。
- **把 `unreadable` 降级成 `absent`**：`absent` 按「新建文件」入快照，回退时 `unlinkSync` 该路径；
  将来它真变成普通文件就会被误删。
- **用 errno 判据（EPERM/EISDIR/ENOTEMPTY/ENOTDIR）**：三平台错误码不一致，靠 catch 分支会漏；
  类型判断才是主判据，`unreadable` 只用于「连类型都拿不到」。
- **顺手改 `/undo` 命令层的 null 文案**：`undo()` 在 N5 真失败时返回 `null` 是方案 §4.2 明确
  要求的契约（快照保留、可重试），改它要动返回值类型与 p0/p4 断言，属独立方案，不塞进本 PR。
- **顺手修 §7.2 的逐文件 try**：那是方案自己标注「未修」的既有项；本 PR 只消除 `lstat` 这条
  新增触发路径，不扩大范围。

## 拿什么证明它生效了

- 修复前基线（`git show f7e05681:`）：`createSnapshot` 用 `Bun.file().exists()`，实测对
  `/dev/null/foo` 返回 `false` 不抛；其余三处用 `existsSync`，同样返回 `false`。
- 探针实测（bun 1.4.2 / darwin）：修复前 `undo()` 对 ENOTDIR 条目**抛错且快照不消耗**（连续两次
  都抛、快照数保持 1），`createSnapshot([bad, real])` 返回 `""` 且快照数 0；修复后两者均正常跳过。
- 本机历史数据只读扫描：135 个会话 / 6,127 条目里 **11 条** ENOTDIR 路径（全部 `existedBefore=false`，
  形态 `sid-code/sid-code/...`，父段是编译产物二进制），说明这不是纯理论触发面。
- `bun test ./packages/core/tests/checkpoint/` → **128 pass / 0 fail**（新增 6 例）。
- `bun test ./packages/cli/tests/command/restore-unprotected-lines.test.ts` → 6 pass。
- `bun run affected-tests:run` → **3506 pass / 9 skip / 0 fail**（339 文件）。
- `make build` → 产物自检全过（git-status 锚点 / 止损阀 / 内置 skill / ripgrep / review skill）。
