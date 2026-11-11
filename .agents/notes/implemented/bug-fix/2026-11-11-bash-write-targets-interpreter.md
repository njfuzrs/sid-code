---
Status: implemented
Date: 2026-11-11
Source: B8-bash解释器内层写删（2026-11-10）
---
# bash 写目标提取与 checkpoint 共用一份实现，补齐 mv 源 / git 路径 / find / 解释器字面量

## 决定了什么

按方案 §3 的 HB-10a 范围落地四层（L4 不在本 PR，见「放弃了什么」）：

- **L1**：`mv` 从「只取最后一个非选项参数」改为**全部非选项参数**（源会消失，与 `rm` 同级）；
  新增 `gitWritePathTargets` 提取 `git rm` / `git mv` / `git restore` 的位置参数与
  `git checkout --` 之后的路径。`cp` / `install` / `ln` / `rsync` / `scp` 保持只取目标——
  `cp .git/hooks/x /tmp/y` 的源是**读**，收源会让「读一个 hook」也变成确认。
- **L2**：`find` 出现 `-delete` / `-exec` / `-ok` / `-fprint*` 等副作用动作时，
  把**起点目录**加入候选。不展开 `-name` / `-path`：起点不命中保护路径就不新增确认。
- **L3**：新增 `interpreterWriteTargets`——解释器 `-c` / `-e` / `--eval` / `--print`
  代码串里，「有写 API」+「有字面量路径」两条同时成立才提取。
  写 API 清单不含裸 `open(path)` / `open(path,'r')`：本机 959 会话实测只读 `open` 有 122 条，
  是读审计日志 / 读 settings 的高频合法操作。
  解释器 heredoc（`python3 - <<'PY'`）单独走 `ShellCommandExpansion.interpreterHeredocs`，
  与 `python3 script.py <<EOF`（stdin 是数据）区分开。
- **L5**：把提取逻辑抽成 `writeTargetsFromExpansion(expansion)`，
  `extractBashWriteTargets` 与 checkpoint 的 `getBashAffectedFiles` **共用这一份**。
  修前是两套实现，实测 `perl -pi` 在安全侧能识别、在 checkpoint 侧不能，`mv` 源则反过来。
  checkpoint 的触发条件也随之从「命令文本里出现 rm|mv|cp / sed -i / tee / 重定向」的正则预筛，
  改为「提取器提得到目标」——提不到就是不建快照，两套口径不再有漂移空间。

顺带把 `sed -i` / `perl -pi` 的内联脚本识别统一进共享提取器（`scriptProgramTargets`）：
安全侧少一个误报候选（`s/a/b/` 不再被当路径），checkpoint 侧不再快照不存在的文件。

## 放弃了什么（以及为什么不选）

- **L4（always-allow 下「解释器写 API 但目标不可静态判定」落确认）不做**。方案 §3.5 与
  §10.1 明确要求它与 HB-11（A2 校验器 + Step 14 误伤收窄）同批上线，并用 ④ B24 的交互式
  批准率/误伤率看净效应。本机 99.0% 的 bash 调用发生在 `bypassPermissions` 会话里，
  测不出交互式成本。提前做会让「新增保护」与「原有误伤」混在同一次上线里，分不清归因。
- **不扩展 `isShellLikeProgram`**。它已被 `variants` / `scripts` 复用，改它会同时改变
  Step 2 的危险命令判定面。解释器 heredoc 另开 `interpreterHeredocs` 字段，
  只喂写目标提取。
- **`cp` 的源不再进 checkpoint 快照**（原 `bash-snapshot.test.ts` 断言源也在）。
  cp 不破坏源，多快照只是 `/undo` 列表里的噪音；而安全侧必须只取目标，否则「读 hook」
  会变确认。两侧共用一份实现后只能取其中一个口径，取「只目标」。
- **不做「解释器事后检测」（执行后对比受保护路径 mtime）**。能发现但不能阻止；
  方案 §4 已论证，留作以后降低 L4 成本的备选。
- **不裸退工作区级快照**给「写目标不可静态判定」的解释器命令。`getGitWorkingSetFiles`
  在 monorepo 上成本过高，且对解释器全量写入的回退价值有限（方案 R7）。
- **`stripWorktreeContainerPrefix` 对「路径正好是 worktree 根」不生效**（正则要求 slug
  之后还有 `/`）。因此本地在 `.sid-code/worktrees/<slug>` 里跑 `find . -exec …` 会让
  Step 6 命中 `.sid-code/`。这是既有边界、不在本 PR 修；测试侧改为显式传 `cwd`，
  不让用例依赖 runner 的 cwd（详见「拿什么证明」）。

## 拿什么证明它生效了

**探针（改动后直接调提取器）**：

```
mv .git/hooks/pre-commit /tmp/x        → [".git/hooks/pre-commit","/tmp/x"]   （修前只有 /tmp/x）
cp start.sh .git/hooks/pre-commit      → [".git/hooks/pre-commit"]            （源不入候选）
git rm .git/hooks/pre-commit           → [".git/hooks/pre-commit"]
git checkout -- .git/hooks/pre-commit  → [".git/hooks/pre-commit"]
git checkout main                      → []
git checkout -b feat/new-branch        → []
find .git/hooks -name x -delete        → [".git/hooks"]
find . -name '*.ts'                    → []
python3 -c "open('.git/hooks/x','w')"  → [".git/hooks/x"]
python3 -c "print('.git/hooks/x')"     → []
python3 -c "open('~/.sid-code/logs/…')"→ []                                   （只读 open 不误报）
python3 - <<'PY' 写 hooks              → [".git/hooks/pre-commit"]
python3 script.py <<'EOF'              → []                                   （stdin 是数据）
```

**单测**：新增 `packages/core/tests/permission/bash-write-targets-interpreter.test.ts`
（16 用例：L1/L2/L3 形态表 + always-allow / default 端到端 step 断言 + 只读对照），
并在 `checkpoint/bash-snapshot.test.ts` 补 5 条（perl -pi / 解释器 / find -delete / git rm / 只读）。
两文件合计 `41 pass / 0 fail`。

**变异自证（5 条，逐条确认变红后恢复原文件）**：

| 变异 | 失败数 | 首条失败 |
| --- | --- | --- |
| 去掉 L3「写 API」判据 | 6 | 判不写：只读 open / print / 普通路径 |
| `mv` 不收集全部非选项参数 | 10 | mv 的源与目标都收 |
| 去掉 find 分支 | 10 | 带副作用动作：起点目录进候选 |
| 不收集解释器 heredoc | 2 | 解释器 heredoc：正文是代码 / stdin 是数据 |
| 去掉 git 路径分支 | 12 | git rm / git mv / git restore 的路径参数 |

**门禁**：`bun run format` / `lint` / `format:check` / `typecheck:gate`（无新增类型错误）/
`lint:boundary` / `lint:command-system` / `lint:legacy-tool` / `affected-tests:run`
（1288 pass / 0 fail）/ `make build`（产物自检通过）全部绿。

**全量 `bun test` 的两条 worktree 环境性失败（已按三条证据举证，与本改动无关）**：
`tests/build/rules-paths-scope-nonempty.test.ts`（`ruleOwnerDir` 遇到路径里的 `.sid-code`
段就当容器前缀，worktree 内的 owner 目录被算到仓库外）与
`packages/core/tests/agent/isolated-subagent-cwd.test.ts`（cwd 在 worktree 内时
子代理必然注入「【隔离环境提示】」）。两条在父仓 main 上单跑 **15 pass / 0 fail**，
且都不 import 本次改动的模块。

**顺带修正的测试前提**（契约被有意变更，不是为凑绿改断言）：
`checkpoint/bash-snapshot.test.ts` 的「cp 源与目标都收」改为「只收目标」；
`dangerous-command-matrix.test.ts` 的 `verdict()` 补 `cwd: ws`——`find .` 的起点
按 cwd 解析，不传时会落到 runner 的 cwd（本地在 `.sid-code/worktrees/` 下即误命中），
该文件测的是危险命令判定，本不该依赖 runner 路径。
