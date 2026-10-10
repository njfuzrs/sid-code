---
Status: implemented
Date: 2026-10-09
---
# 新底座外部编辑器 handoff 与 alt 下重绘（B9 / T6.1b）

## 决定了什么

规则全部来自对 legacy 的黑盒探针，没读旧底座代码（D-5）。探针脚本备份在 `~/Backups/sid-code-t67-probe-results-20261008/T6.1b/`。

- **`enterAlternateScreen`（X5）**：先关 raw mode（有组件持有时），**不** `unref`、不摘 readable、不清解析器、不写 bracketed paste，所以不能复用上游的 `suspendTerminal` / `pauseInput`。App 新增一对 `pauseForHandoff` / `resumeFromHandoff`，让渡期间 readable 回调不读 stdin，字节留在流里，收回后在下一个 tick 交给 `useInput`。然后一次写入：`<u >4m` → 主屏 `?1049h` / 已在 `<AlternateScreen>` 里则只关鼠标（开过才关）→ `?1004l` → `0m` → 显示光标 → `2J H`。
- **让渡期间**：复用 `isSuspended` 挡住出帧，提交、resize、forceRedraw 都不写字节；alt 下 resize 不再当场重开鼠标；SIGCONT 的 alt 重进照旧（legacy 如此）。
- **`exitAlternateScreen`（X5）**：主屏写 `2J H ?1049l` + 隐藏光标；alt 里写 `?1049h 2J H` + 重开鼠标 + 隐藏光标。然后重开 raw mode，当场出一帧：主屏按 R10 的 SIGCONT 口径（`redrawAfterSuspend`），视口变过就 full reset；alt 对空白整帧画，视口记录同时更新，不再多写 `2J`。最后 `?1004h`，扩展键开着再重申 `<u >1u >4;2m`（与有没有人持有 raw mode、在不在 alt 无关）。
- 没进过也照样执行 exit；重复调用每次整段再写，raw mode 只关 / 开一次；stdout 非 TTY 时让出前先写一遍当前帧，收回只写一对空的同步包裹。
- **`forceRedraw` 的 alt 路径（R8 / S9）**：擦屏后作废 `altPreviousScreen`，按 R14 对空白整帧画。

## 放弃了什么

- **用上游 `suspendTerminal` 实现 X5**：它会 `unref`、清输入解析器、写 `?2004l/h`，探针显示 legacy 一样都不做；套用会让 S8 与 I4 都红。
- **挂载段对齐**：两边首帧后隐藏光标的时机不同（`?25l` 在 raw mode 开启前后），属于 I4 / X3，不在 X5 的比对范围内，契约测试跳过 `mounted` 段。
- **S8 的 I4 部分**：外部编辑器前后的 bracketed paste 等模式归属由 T5.3c 收口。S8 场景本身在 next 上已与基线一致。

## 拿什么证明它生效了

- 新契约 `packages/cli/tests/render-port/external-editor.test.tsx` 15 条（主屏 11、alt 4），夹具 `fixtures/external-editor-app.tsx` 跑在子进程里。每条先断言 legacy 等于写死的字节，再断言 next 与 legacy 逐段一致，两套底座都是 15/15。
- 探针 22 组（主屏 / alt × 提交、收缩、resize、按键、SIGCONT、forceRedraw、重复、只 exit、无 raw mode、非 TTY、kitty）挂载段之后 legacy 与 next 逐字节一致。
- 变异自证 11 处全红：不关 raw mode、不关 focus、alt 里不关鼠标、收回不重开鼠标、收回不作废前帧、不重申扩展键、非 TTY 让出前不写帧、让渡期间 resize 重开鼠标、alt 收回后多 `2J`、让渡期间读 stdin、alt forceRedraw 不作废前帧（S9）。
- term-bench：**S8、S9 在 next 上转绿**。render-port + tui 在 next 上 1002 pass / 6 fail，基线（`b9bd841b`）是 S8 / S9 也红；剩下 6 条 M5 ×2、O5、X7（只缺选区 3 个方法）、S10、S13 都归别的子任务。legacy 1008/1008。
- 坑：用 Python 文本模式读探针输出会把 `\r\n` 折成 `\n`，写死的期望值因此第一轮全错。期望值要从 bun 里 `JSON.stringify` 原始字节取。
