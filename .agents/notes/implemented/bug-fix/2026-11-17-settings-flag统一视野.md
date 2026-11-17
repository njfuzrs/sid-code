---
Status: implemented
Date: 2026-11-17
Source: 20261116-H2目标续跑与收敛-发现二次核查（2026-11-16）
---
# 让 `--settings` 成为统一视野：Config 与 hooks 都吃 flagSettings

## 决定了什么

`--settings`（`flagSettings` 内存源）此前只进 `getSettings()` 视野，`loadConfig()` 构造的
Config 与 hooks 都静默无视它。同一根因被报过三次（hooks 只读用户级 → HC1 补齐磁盘三源 →
本次）。这次把三条链一次性对齐：

1. **Config**：`loadConfigFile()` 在 `mergeConfig(userConfig, overlay)` 之后叠加 flag 层
   （`config.ts`）。**全字段放行**，含 `model` / `baseURL` / `provider` / `env` /
   `availableModels` 这些项目级白名单刻意排除的路由字段。
2. **hooks**：`collectHookLayers()` 新增 `source: "flag"` 的一层（`hook-layers.ts`），
   位置在 `local` 之后（与 `SETTING_SOURCES` 的 `... local → flag → policy` 同序），
   读**原始对象、不做 env 插值** —— `${CLAUDE_PROJECT_DIR}` 必须留给 hook 子进程。
3. **起始权限模式**：`resolveStartPermissionMode()` 新增 `origin: "flag"` 候选
   （`permission-mode-source.ts`），位置在 policy 之后、local 之前，`trust: "full"`。

配套：`ConfigSource.Flag` 新增，三处来源映射（`app.ts` / `hook-cli.ts` /
`HooksDialog.tsx`）同步补齐；`config.hooks` 保持「用户级 settings.json 的 hooks」语义 ——
flag 的 hooks 在 config 层被 `delete` 掉，只走 `_hookLayers`，否则 `app.ts` 的
`!hasUserLayer && config.hooks` 兜底会在「没有 user 层」时把同一份 hooks 再注册一遍。

三处注释、`--help` 文案、`website/ref/cli.md` 一并改成新行为。

## 放弃了什么（以及为什么不选）

- **没有让 `--settings` 覆盖企业 policy**。flag 排在 policy 之后，`policy → flag → local →
  project → user` —— 这是「管理员下发的管控不可被命令行绕过」的唯一保留口子。若把 flag 提到
  policy 之上，`--settings` 就成了绕过企业策略的后门。
- **没有把 flag 的 permissionMode trust 设为 `restricted`**。`restricted` 防的是「随仓库
  clone 下来、任何人可提交的配置」把档位放宽；`--settings` 是用户在命令行显式给的，
  与用户级 `settings.json` 同级。**代价要点破**：如果调用方把 `--settings` 指向仓库内的文件
  （A2 用例就是 `--settings a2-hook-settings.json`），等于用户显式信任该文件的内容。
  这是「显式传参」与「自动加载」的语义差别，不是同一个威胁模型。
- **没有在 config 层给 flagSettings 加 schema 校验**。与用户级 `settings.json` 同口径
  （只做 JSON 解析 + env 插值 + `normalizeConfigKeys`），避免同一份配置在两条链上被两套
  规则判定。非法值仍按既有的「无效配置不阻断启动」路径静默落默认。
- **没有给 flag 的 hooks 做 env 插值**。与磁盘各层读原始 JSON 的理由相同；提前展开会让
  `${CLAUDE_PROJECT_DIR}` 变成空串或外层项目的路径，且错得无声。
- **没有拆成「先修 Config，再修 hooks」两个 PR**。同一根因分开修就是第四次打补丁，
  而且中间态（`--settings` 对 Config 生效、对 hooks 不生效）正是 2026-11-16 那次核查
  把它当「新发现」报一遍的形态。
- **没有加启动期 warning**（方案 B 时期的备选：`--settings` 里出现 config-only 字段时提示）。
  字段现在全部生效，这个 warning 会变成错误提示。
- **没有改 A2 用例的 id**（仍是 `A2-settings-flag-no-hook`）。改名会让 `expect-guard`
  把它当成「新增用例」从而绕过人工 `expect-reviewed` 评审 —— 那是用改名掩盖一次期望变更。

## 拿什么证明它生效了

- **单测**：`packages/core/tests/config/settings-flag-scope.test.ts` 11 用例全绿：
  - Config 侧 6 条：负向对照（磁盘值）、只传 `extraSettings` 入参不生效、真实 CLI 路径被
    flag 覆盖（`goal 6 / theme flag-theme / maxTurns 11`）、**部分覆盖**（flag 只写 theme 时
    goal 与 maxTurns 保留磁盘值）、flag 的 hooks 不进 `config.hooks`、`getSettings` 视野一致。
  - hooks 侧 3 条：flag 层存在且 `file = "<--settings>"`、命令里的 `${CLAUDE_PROJECT_DIR}`
    未被展开、数组写法归一、无 flagSettings/无 hooks 时不产生层。
  - 权限档位 2 条：flag 的 `permissionMode` 生效（`origin: "flag"`）、policy 同档位压制 flag。
- **契约变更（不是为凑绿改预期）**：PR #897 那条「真实 CLI 路径 Config 仍 7」按新契约改为 6。
  A2 用例从 `lock-defect` 改 `guard`，`HookExecuted` 0 → 1、`hook.log` 从 absent 改为
  `"[hook] edit\n"`；`mutations` 改为「删掉 flag 层」模拟回退。
- **G2 冒烟**：`bun run smoke` **41 例 41 通过**（含改后的 A2）。
- **变异自证**：`bun run smoke:mutate` —— 待补运行结果（脚本要求工作区干净，故在提交后跑）。
- **类型检查**：`bun run typecheck:gate` 当前 62 处 / 基线 62 处，**无新增**。
- **静态门禁**：`bun run lint` 0 warning 0 error、`format:check` 通过、`lint:boundary` 通过。
- **参考页**：`docs:gen-reference` 更新 `website/ref/cli.md`；`tests/website/gen-reference.test.ts`
  54 pass / 0 fail（改前选测里唯一失败的就是它，原因是参考页未重新生成）。
- **选测**：`bun run affected-tests:run` 8519 pass / 1 fail（即上面的参考页，已修）；
  重新生成后该文件单跑 54 pass。
