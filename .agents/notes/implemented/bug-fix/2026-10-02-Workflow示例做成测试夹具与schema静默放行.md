---
Status: implemented
Date: 2026-10-02
---
# Workflow 文档示例做成可执行测试夹具，`checkSchemaShape` 拒绝无可识别关键字的 schema（B19 / D56 / D58）

## 决定了什么

1. 新增 `tests/website/workflow-doc-examples.test.ts`：从 `website/extend/workflows.md` 抽出全部 javascript 代码块，
   喂 `parseAndValidateMeta`，再用 stub 运行时（agent 按 schema 合成最小合规值）跑 `runInSandbox`；
   对示例里出现的每个 schema 断言 `checkSchemaShape === null`，并断言它会拒绝裸字符串 `"hello"`（即真的在约束东西）。
2. 修文档（D56 / D58）：`meta.phases` 改为 `[{ title }]` 对象数组，格式要求补上 phases 形状；示例 schema 补根层
   `type: "object"` / `properties` / `required`。
3. `json-schema-validator.ts` 的 `checkSchemaShape`：对象**有键但没有任何一个可识别的 JSON Schema 关键字**时报错，
   提示「是不是漏了根层的 type / properties」。此前这种对象被判合法，`validateAgainstSchema` 对任何值都 `valid:true`，
   结构化输出零报错地失效。
4. `swarm/team.ts` 的 `run()` 头注释改成与实现一致：全部成员并发，隔离成员靠 `withAgentCwd` 传 cwd，不再串行 chdir。
5. 同一轮审阅的同两页其余文档项一并改（D57 / D59 / D60 / D61 / D62）：
   - workflows.md 参数名改回工具 schema 的下划线写法（`resume_from_run_id` / `script_path` / `budget_total`）；
     对照表「上限」补「单 run ≤ 1000 个 agent」；示例审计步补 schema，汇总步去掉多余的单 thunk `parallel`。
   - 测试 stub 的 `agent()` 无 schema 时改为返回**字符串**（与 `sub-agent-runner.ts` 一致），
     这样「没给 schema 却读字段」（D59）会直接抛 TypeError，而不是静默得到 0。
   - subagents.md：summarize 工具集「全部」→「无（纯文本）」；「精确控制」→「保证放行生效（代价是粒度变粗）」；
     「成本」→「单价」；实测版本号更新到 v0.1.606。
   - D60 的根因在 CLI：`sid-code agents` 把空 `tools` 统一渲染成「(全部)」，而 summarize 的空语义是「零工具」
     （`filterToolsForAgent` 直接 `return []`）。`command/agents.ts` 对 summarize 特判显示「(无，纯文本)」，补单测。

## 放弃了什么（以及为什么不选）

- **空对象 `{}` 也报错**：不选。`{}` 在 JSON Schema 里是显式的「接受任意值」，是合法意图；只拦「有键但全不认识」，
  这正是 D58 的形态，误伤面最小。
- **只认本校验器实现了的关键字**（type/properties/items/enum…）：不选。`anyOf`、`$ref`、`description` 这类合法写法
  会被误判成「写错了」。白名单用 draft 2020-12 的完整词表，判断的是「是不是在写 JSON Schema」，不是「本校验器支不支持」。
- **在 validateAgainstSchema 里补逻辑**：不选。shape 检查在 `StructuredOutputTool` 里已有接线（带缓存），
  在入口拦更早、报错信息更清楚。
- **D60 只改文档不改 CLI**：不选。官网那格就是照 `sid-code agents` 的输出抄的，只改文档下次重测还会抄回去。
- **给全部官网页的代码块做通用执行门禁**：不选。别的页的代码块大多是 shell / 配置片段，没有可调用的真实入口；
  只有 workflow 脚本有现成的校验函数和沙箱可以喂。

## 拿什么证明它生效了

- 变异自证（2026-10-02 本机）：
  - 文档整页回退到 HEAD → 新测试 `2 fail`（meta 校验 + schema 约束两条都红）；
  - 只修 phases、保留错误 schema → 仍 `(fail) … 防 D58`，说明 schema 那条断言独立有效；
  - `json-schema-validator.ts` 回退到 HEAD → `(fail) B19：没有任何可识别关键字的 schema → 报错`。
- D59 变异：删掉审计步 schema → `TypeError: undefined is not an object (evaluating 'audit.issues.length')`，测试红。
- D60 变异：`agents.ts` 回退 → 新单测 `Received: "(全部)"` 红；修后编译产物 `sid-code agents` 输出「工具: (无，纯文本)」。
- 第二轮选测 3179 pass / 0 fail，`docs:gen-reference` 无漂移。
- 恢复后：`bun test ./packages/core/tests/workflow/ ./tests/website/workflow-doc-examples.test.ts` → 132 pass / 0 fail；
  `bun run affected-tests:run` → 1557 pass / 0 fail；`make build` 自检通过且 `will always be undefined` 计数 0；
  lint / format:check / lint:boundary 全绿。
