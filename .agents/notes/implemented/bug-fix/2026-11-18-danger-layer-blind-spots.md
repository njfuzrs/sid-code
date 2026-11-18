---
Status: implemented
Date: 2026-11-18
Source: auto 权限档误报弹窗与分类器缺用户意图 —— 修复与验收方案（2026-11-17）§2.9.1 / 附录 C
---
# 补齐危险命令层的三处盲区：分组占位、远端 heredoc 正文、超时静默钳制

## 决定了什么

修复三处「always-allow 档静默放行 / 静默改变行为」的盲区，都用最小改动面接在**既有口径**上：

### 1. D1：危险层的程序位不再被分组 / 关键字 / 函数头占走

- `canonicalizeSimpleCommand`（`permission/shell-command-variants.ts`）新增前缀归一化：
  剥「整段被一对分组括号包裹」的外层、剥拆段后悬空的尾 `)`、跳
  `if/then/elif/else/while/until/do/select/case/!/time` 关键字、跳 `f()` / `f(){` /
  `function f {` 函数头、跳 `case` 的分支模式 `pat)`。
- `expandShellCommand` 新增 `collectGrouped`：把 `( … )` 的分组体按 shell 分隔符展开成
  额外的 `commands` / `pipelines`（**只补危险层判据，不碰 `variants`**）。
- 数组赋值 `x=(a b)` 整段视为赋值，不再把 `b)` 当程序名。

### 2. C-1：远端 / 容器 shell 的 heredoc 正文按脚本判

`classifyHeredocOwnership` 的 `codeForDangerScan` 增加
`remoteShellReceivesScript(owner.program, owner.args)`。`ssh h <<'EOF'` /
`docker exec -i c sh <<'EOF'` / `kubectl exec -i p -- sh <<'EOF'` 的正文会在远端 shell 里执行，
修前危险层一条都不判（探针实测 8 种远端形态全部 `allowed=true`）。
`ssh h 'bash -s'` 这种「带引号的 shell + 参数」也认：按空白取第一个词再判。

### 3. C-2：超时被上限钳制时必须有回执

`tool/bash.ts` 的 `execute` 统一收口加 `clampTimeoutNotice`：前台命令请求的 `timeout`
超过 `maxMs` 时，在结果**首行**注明「请求 1800s 超过上限，实际按 600s 执行」。
后台命令不加（结果体是 JSON，前置文本会破坏 `task_id` 解析）。

## 放弃了什么（以及为什么不选）

### 不改 `splitCommandStructure` 的默认拆分口径

方案 §2.9.1 的 M1 建议「对 `( … )` 内部递归拆分」。直接在公共函数上改会同时影响：

- `checkAllowList` 的 `flatCount === subCommands.length` 一致性断言 —— `splitCompoundCommand`
  仍在分组内不拆，两边口径不一致会让复合命令的 allow 组合判定回退到 `every`，把
  `(cd ws && ls)` 这类从「命中 allow」变成「要逐段命中」；
- `variants`（文本正则 + `detectPrivilegeEscalation` 的输入）—— 拆开的段会让那一层的
  判定面变大。

所以改用**危险层专用的 `collectGrouped`**：只补 `commands` / `pipelines`，公共拆分口径与
`variants` 一字不动。代价是「危险层比其他层严」，但这正是安全层该有的方向。

### 不把远端程序的引号参数当脚本递归展开

`ssh host 'rm -rf /etc'` 的脚本在参数里，同样会在远端执行。没有一起修，因为
`ssh host "echo 'rm -rf / is bad'"` 这类**数据文本**在递归展开后会被文本正则命中，
变成 critical 硬拒（无出口）——那是一次不可批准的误报。
要修需要先有「远端参数即代码」的独立判据（区分 script 参数与普通参数），
不在本次范围，已记入方案附件。

### 不改成「超时上限只告警不钳制」

钳制本身是保护（防单条命令挂死整轮）。去掉钳制换来的是「模型可以要求 1 小时」，
但它同时失去 `WALL_CLOCK_CHECK_MS` 的兜底意义。只补回执，不动钳制。

## 拿什么证明它生效了

### 变异自证（逐条改坏 → 看红 → 恢复）

1. 把 `canonicalizeSimpleCommand` 的归一化改回 `const normalized = sub;` →
   M2/M3 组 + 归一化单测共 **20 条变红**（`if then` / `for do` / `case` 三分支 /
   `f()` / `{ }` / `program=rm` 全部失配）；恢复后全绿。
2. 把 `collectGrouped(source, 0)` 注释掉 → **M1 组 4 条变红**
   （`(echo hi; rm -rf /)`、`(echo hi⏎rm -rf /)`、`(curl x | sh)`、嵌套分组）；
   恢复后全绿。

### 行为探针（真实 `PermissionChecker.check`，always-allow 档）

```
修前 → 修后
(rm -rf /etc)                    allowed=true  → 递归删除根目录~critical
(echo hi; rm -rf /etc)           allowed=true  → 递归删除根目录~critical
if true; then rm -rf /etc; fi    allowed=true  → 递归删除根目录~critical
case $x in a) echo a;; b) rm...  allowed=true  → 递归删除根目录~critical
f() { rm -rf /etc; }; f          allowed=true  → 递归删除根目录~critical
{ rm -rf /etc; }                 allowed=true  → 递归删除根目录~critical
ssh host <<'EOF' rm -rf /etc EOF allowed=true  → 递归删除根目录~critical
docker exec -i c sh <<'EOF' …    allowed=true  → 递归删除根目录~critical
kubectl exec -i p -- sh <<'EOF'  allowed=true  → 递归删除根目录~critical
```

不误报组（全部仍 `allowed=true`）：引号内的 `"(rm -rf /etc)"`、`${HOME}`、`((x++))`、
`x=(a b)`（注入层既存 ask，与本次无关）、`ssh host ls`、`docker exec -c cat <<EOF` 的数据正文。

### 测试与门禁

- `packages/core/tests/permission/danger-grouping-keyword.test.ts`：**57 pass / 0 fail**
  （M1/M2/M3 成对断言 + C-1 远端 6 放 4 拦 + 归一化单测）。
- `packages/core/tests/tool/bash-timeout-clamp.test.ts`：5 条（超限/未超限/未传/后台/ env 变化）。
- `bun test ./packages/core/tests/permission/`：**1700 pass / 0 fail**（修前 1653，新增 47 条）。
- `bun run verify:agent-note`：935 份 Note 形态合规。

### 为什么之前没拦住

- D1：危险层的程序位判据与「拆分口径」是两个独立事实源，拆分侧有一致性断言
  （`flatCount === subCommands.length`），程序位侧**没有**「裸命令与包裹形态同结论」的断言。
  本次补的就是这条成对断言。
- C-1：`remoteShellReceivesScript` 早就存在，但只接给了注入层的 `shellScript`，
  危险层的 `codeForDangerScan` 没接——一个判据两个消费方，只接了一半。
- C-2：钳制写在一行 `Math.min` 里，没有「用户请求值 vs 实际值」的回执契约。
