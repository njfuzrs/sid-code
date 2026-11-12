---
Status: implemented
Date: 2026-11-12
Source: 内置工具设计对齐 Claude Code：缺陷、修复与验收方案（2026-11-12）
---
# notebook_edit 补 zodSchema，并给 zodSchema 加全量覆盖门禁

## 决定了什么

`packages/core/src/tool/notebook-edit.ts` 的 `NotebookEditTool` 新增
`readonly zodSchema = notebookEditSchema();`，`inputSchema()` 改为
`z.toJSONSchema(this.zodSchema)`（原来每次就地调 `notebookEditSchema()` 再转）。

此前它只在 `inputSchema()` 里就地转 JSON Schema，实例上没挂 `zodSchema`，
于是 `validateToolInput()`（`packages/core/src/tool/input-validator.ts:62-65`）走
`!schema` 早退：别名归一、strict null 回填、数字归一、`safeParse` 整条链全部跳过，
非法枚举（`edit_mode: "bogus"`）直接进 `execute()`，只能靠工具内部的事后手工检查兜底。
42 个内置工具里只有它是这个状态。

配套三处：

- 新增门禁 `tests/tool/zod-schema-coverage.test.ts`：用 T0 的 `--dump-tool-meta`
  取真实注册表，断言每个内置工具的 `hasZodSchema` 都是 true；豁免名单写在测试里
  且每条必须带理由、必须是真实存在的工具名（防止拼错变成永久失效的豁免）。
- `tests/tool/builtin-tool-meta.test.ts` 的 `hasZodSchema` 断言从
  `["notebook_edit"]` 改为 `[]`——这是 T0 当时刻意留下的「等 T3 补完就收紧」的口子，
  现在按约定收紧。
- `packages/core/tests/tool/notebook-edit.test.ts` 补四条执行器边界用例：
  `zodSchema` 已挂且与 `inputSchema()` 同源、`cell_id`/`cell_type` 传 null 能回填、
  非法 `edit_mode` 返回中文 zod 错误（含合法取值）、缺 `new_source` 在工具边界被点名。

## 放弃了什么（以及为什么不选）

**不给 notebook_edit 另写一份 JSON Schema**（或保留 `inputSchema()` 原地构造）。
`inputSchema()` 现在与 `zodSchema` 是同一个 zod 对象（`lazySchema` 缓存保证引用稳定），
`z.toJSONSchema` 是确定性的，所以「发给模型的契约」与「运行时校验器」不可能漂移。
另写一份就等于给这条链加第二个事实源，正是 T2 要修的「两处不同源」那一类问题。

**不做豁免名单的“预留”**。方案原文说 `StructuredOutput` 不需要豁免——它按会话动态
注册、schema 由用户提供，本来就不在 `--dump-tool-meta` 的 dump 里。所以豁免表初始为空，
而不是先塞一条看着像理由的条目：空表加「每条必须带理由 + 必须是真实工具」两条断言，
比一条写不清理由的豁免更接近这条门禁的目的。

**不顺手改 `notebook_edit` 的参数或描述**。方案明确划了边界；参数形态的调整属于 T4
（废弃参数）与 T1（别名），放在这个 PR 里会让 review 分不清哪些改动是补 zodSchema 必需的。

**不把 T2 的未知键门禁塞进来**。`findUnknownTopLevelKeys` 与它的全工具遍历属于 PR-A
的另一半（T2），共用 `--dump-tool-meta` 出口但断言目标不同。分开提能让两条门禁各自
独立回滚。

## 拿什么证明它生效了

出口对账（2026-11-12，worktree，`SID_CONFIG_DIR` 指向 tmpdir）：

```
$ bun run packages/cli/src/entrypoints/bootstrap.ts --dump-tool-meta
total 42
noZod []          # T3 之前是 ["notebook_edit"]
deferred 18
```

新增与改动的测试：`bun test ./tests/tool/zod-schema-coverage.test.ts
./tests/tool/builtin-tool-meta.test.ts ./packages/core/tests/tool/notebook-edit.test.ts`
→ **28 pass / 0 fail，271 expect**。

**变异自证**：把 `readonly zodSchema = notebookEditSchema();` 删掉、`inputSchema()` 改回
原地构造（等价于改动前状态），同一条命令 → **6 fail**，且失败消息点名了正确对象：

- 新门禁：`以下工具没挂 zodSchema，会跳过别名/null 回填/数字归一/safeParse：notebook_edit`；
- T0 门禁：`hasZodSchema 全部为 true` 断言列出 `+ "notebook_edit"`；
- notebook_edit 四条校验用例全红（`toBeDefined` / `null` 回填 / 中文枚举错误 / 缺必填）。

恢复后重跑 28 pass。

参考页：`bun run docs:gen-reference --check` → `✓ 参考页与源码一致，CLI 双源对账通过`。
零漂移符合预期——JSON Schema 的来源本来就是这个 zod 对象，产物逐字节相同。

其余门禁：

- `make build` 通过（产物自检 5 项全绿）；
- `bun run format:check` / `bun run lint`（0 warning / 0 error）/ `bun run lint:boundary` 通过；
- `bun run typecheck:gate` 无新增（62 处 / 基线 64）；
- `bun run affected-tests:run`：**3690 pass / 1 skip / 2 fail**。两条失败都在
  `tests/build/rules-paths-scope-nonempty.test.ts`，是 worktree 环境假失败，三条举证齐全：
  ① 该文件只 import `bun:test` / `child_process` / `fs` / `path` / `@sid-code/core/config/rules`，
  不 import 本次改动模块；② 父仓 main 单跑 3 pass / 0 fail；③ 成因是 worktree 的 `.git`
  为 gitdir 指针文件，`ruleOwnerDir` 解析到主仓根而非 worktree 根，候选集恒为空。
- `bun run smoke`：26 例 25 通过。唯一失败 `B1-webhook-trigger` 是本机常驻 daemon 占用
  3847 端口（用例注释里写明的真实约束），该进程退出后单跑 `bun run scripts/smoke/run.ts
  B1-webhook-trigger` → **1 pass**。
