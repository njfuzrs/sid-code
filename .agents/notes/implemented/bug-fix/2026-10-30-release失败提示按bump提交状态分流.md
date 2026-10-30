---
Status: implemented
Date: 2026-10-30
---
# release.sh 失败收尾提示按「bump 已提交 / beta 已上线」分流，不再一律说「版本号已回滚」

## 决定了什么

`scripts/release.sh` 的 `on_exit` 原来不管失败点在哪，最后一行都打印「修复问题后直接重跑即可（版本号已回滚，无需 --no-bump）」。
但 bump 提交成功后回滚清单会被清空（`ROLLBACK_FILES=()`），package.json 不会被恢复，这句话是假的。

新增两个状态位，在真实执行点置位：

- `BUMP_COMMITTED=true`：紧跟 `git commit -q -m "bump ${TAG}"` 成功之后；
- `BETA_PUBLISHED=true`：紧跟写 `beta.txt` 的 scp 之后。

`on_exit` 按优先级给出唯一正确的提示：

| 失败点 | 提示 |
| --- | --- |
| beta 已写入后（tag 推送 / Release） | 版本已对外，不要重跑、不要撤 bump，补完后走 PR |
| bump 已提交、beta 未写（上传 / 归档 / 审计） | 版本号没有回滚；确认 tag 未推送后 `git tag -d` + `git reset --keep HEAD^` 再重跑 |
| `--no-bump` 运行 | 重跑仍加 `--no-bump` |
| bump 提交之前 | 原提示（直接重跑，无需 --no-bump） |

bump 已提交时同时隐藏「本地 tag 仍存在，重跑会复用它」，因为那个 tag 指着要撤掉的提交，复用就是错的。文件头「中途失败怎么办」一节同步改写。

## 放弃了什么（以及为什么不选）

- **在 trap 里自动 `git reset --keep HEAD^` + `git tag -d`**：否决。trap 在任何失败路径都会跑，自动改用户的 HEAD 风险太大。比如用户在两次运行之间手动提交过，或 tag 其实已经被别的路径推上去了。所以只打印命令，由人确认 `git ls-remote` 为空后再执行。
- **让 `--no-bump` 重跑能通过 G2**（把期望 commit 放宽成「v<ver>^ 或 v<ver>」）：否决。G2 的判据「构建时 HEAD = v<ver>^」是按真实执行顺序推出来的（见 `scripts/lib/artifact-identity.ts` 那张表）。放宽它会让「产物编自一个已经带 bump 的 HEAD、再在其上叠一个空 bump」这类状态混进来，换来的只是省掉一条 reset 命令。
- **把 bump 提交挪到上传成功之后**：否决。tag 必须打在 bump 提交上，而 G2 在上传前要用 `v<ver>^` 校验产物。挪动会牵动 tag 对齐、G2 和 changelog 锚点三处约束，超出这次修提示的范围。

## 拿什么证明它生效了

v0.1.613 发版实测：第一次运行在上传 linux-x64 时 scp 断开（`Connection to ... closed by remote host`）。trap 打印了「版本号已回滚，无需 --no-bump」，但 `package.json` 仍是 `0.1.613`，`bump v0.1.613` 提交（059b3db9）和本地 tag 都还在。改用 `--no-bump --upload --allow-dirty` 重跑，5/5 产物被 G2 拦下（`产物 commit=059b3db93e7b，期望 f5062e68f7a0`）。最后 `git tag -d` + `git reset --keep f5062e68` 后重跑才通过。

新增 `tests/scripts/release-on-exit-hint.test.ts`：把 `on_exit` 函数体原样切出来，注入 4 种状态组合执行，断言的是实际 stderr 输出，不是源码字面量。

```
bun test ./tests/scripts/release-on-exit-hint.test.ts ./tests/release-flow-contract.test.ts ./tests/scripts/shell-fullwidth-var.test.ts
 92 pass / 0 fail
```

变异自证（每次改坏后对应用例变红，恢复后 5 pass）：

- 删掉 `BUMP_COMMITTED=true` 置位 → 「两个状态位在真实执行点被置位」红
- `elif [ "$BUMP_COMMITTED" = true ]` 改成 `elif false` → 「【回归】bump 已提交后失败」红
- `BETA_PUBLISHED` 分支改成 `if false` → 「beta 已上线后失败：禁止提示撤 bump」红
