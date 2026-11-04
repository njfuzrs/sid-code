---
Status: implemented
Date: 2026-11-04
---
# 延迟工具的完整指南移出 system，bundled skill 并入 Skill 元工具

## 决定了什么

两项一起做，共用一次 A/B（bench_fix 06b，维护者 2026-11-04 确认合并）。

**Q5-b**：`buildToolGuideSection`（`config/system-prompt.ts`）不再给延迟工具渲染「### X 工具使用指南 [需激活]」段，延迟分区只保留名单行。名单行、分区标题和警告指针都不变。模型用 `tool_search` 激活某个工具后，下一轮 `query/loop.ts` 会重新调用 `activeDefinitions()`，该工具通过 `toolToDefinition` 带着「description + 使用指南」进入 tools[]。所以模型真要用时能看到指南，system 里提前放的那一份只用来判断要不要激活。MCP 段（`buildMcpToolGuideSection`）不在本次范围内，见 06b §7 候选 Q5-f。

**Q5-d**：`review` / `simplify` / `verify` 不再各自注册成 `skill__<name>` 工具。`cli.ts` 改为通过 `SkillMetaTool.registerBundled` 把它们登记到元工具上：

- `execute` 先查 manager，查不到再查 bundled 表。命中后委托给 `BundledSkillTool.execute`（`args` 对应 `input`）。fork、agent 类型、禁用名单的语义都不变。
- `getListingEntries` 把 bundled 条目汇总进来，带 `isBundled: true`。被禁用的不列，和 manager 同名的让位给 manager。bundled 条目第一次出现在 skill listing 里。此前 `listing.ts` 注释说 `BundledSkillTool.getListingEntry()` 会提供条目，但这个方法从来没有实现。
- 权限走新函数 `authorizeBundledSkill`（`skill/executor.ts`）：只看统一规则，不跑敏感属性模型。原因是 bundled skill 随二进制发布、是可信的，`runForkedCommand` 本来也传 `trusted: true`。如果套用敏感属性模型，review / verify 带的 agent 字段会走 ask，`-p` 下就直接被拒。
- `extractSkillRules` 把 `skill__<name>` 识别为 `Skill(<name>)` 的兼容别名，大小写不敏感，只认不带括号的写法。官网 `extend/skills.md` 教过用户写 `deny: ["skill__review"]`，不认这个别名的话，照文档写的 deny 规则会静默失效。

**行为变化（PR 正文和官网都已写明）**：

1. 工具列表里不再有 `skill__*`。`--disallowed-tools skill__review` 已经没有对应的工具，不再起作用，要拦就改用 `disabledSkills` 或 `deny: ["Skill(review)"]`。
2. **权限放宽**：main 上用 `-p --permission-mode default` 调 `skill__review` 会被拒（会话 `20261104-133328-2e3d8c7a`，原因是 `BundledSkillTool` 没实现 `checkPermissions`，落到默认的 ask）。合并后，元工具的 `checkPermissions` 恒为 allow，无规则时 bundled skill 直接放行，和磁盘 skill 经元工具的现有口径一致。deny / ask 规则（包括旧写法）照旧生效，fork 子代理内部的工具调用照旧走 dontAsk subChecker。
3. UI 不用改：`getToolSummary("Skill", {skill:"review"})` 本来就输出 `review "…"`，旧的 `skill__review` 反而是空串。

## 放弃了什么（以及为什么不选）

- **Q5-d 乙：bundled 注册进 `SkillManager`**。这样 `allowedTools`、`agent` 这类敏感属性会经 `authorizeSkill` 走 ask，`-p` 下直接被拒，等于在无头模式下关掉 review / simplify / verify，是功能回退。bundled 原来走 `runForkedCommand`，语义也不一样，改动面大。
- **Q5-d 丙：3 个工具设 `shouldDefer`**。延迟名单会多 3 行，模型要先 `tool_search` 才能调用。listing 里仍然没有它们，可发现性比现在更差。
- **旧写法 `skill__<name>` 当破坏性变更直接改名**。仓库代码、本机配置、tests / evals 里都没有人写这条规则，但官网文档明确教过。外部用户照文档写的 deny 规则会静默失效，这是安全面的回退，所以做了兼容别名。
- **`--disallowed-tools skill__<name>` 也做映射**。这个参数的语义是「从工具列表移除工具」，现在已经没有这个工具了。把它映射成 skill 级 deny 会让同一个参数有两种语义，所以只在官网和 CHANGELOG 里点明替代写法。
- **两项分开各做一次 A/B**。两项都只碰常规题里 0 调用的工具，单独做的话每项都测不出回归信号，所以合成一次，用功能探针把风险兜住（维护者 2026-11-04 确认）。

## 拿什么证明它生效了

同一个冻结二进制（`58de4521`，用环境开关 `SID_CODE_Q5BD` 分两臂，合入前已删）× deepseek-v4-1-flash `--effort max`。**opus 没测**（额度不够，同 Q5-a 的偏离），opus 额度恢复后补测；退步就回滚。复现材料在 docs-research `bench_fix/06b-F5-Q5bd-延迟工具指南与bundled-skill合并.md` §8，脚本在 `harness-bench/bin/q5bd/`。

- **开工前核实**：激活后的定义确实带指南（单测：`activateTool("workflow")` 后 description 930 字符，含 761 字符的 usageGuide；端到端会话 `20261104-133140-b222baec`：tool_search → workflow 成功）。
- **冒烟**：tools[] 26 → 23，只少了 3 个 `skill__*`；system 18,293 → 16,810 字符；首调 input_tokens **−996**（预估 −0.95K）。真实题 R2 / L3f 上同样是每调用 −996。
- **功能探针**（主判据，每臂 5 次）：P-wf「用 workflow 并行审查 3 个文件」两臂都是 5/5 激活并调用成功。P-rv「review 一下这次改动」off 1/5、on 2/5，没有新报错形态。off 臂出现 1 次把 `skill__review` 当 skill 名塞进 `Skill` 元工具的误投，on 臂 0 次。wf-on 有 2/5 首调报 `meta.phases[0] 必须含字符串 title`，重试后成功；这个报错早在本次改动前的历史会话里就出现过 5 次，删掉的指南也没讲 phases 的写法，所以不归因到 Q5-b。
- **R2 召回**（盲判，2 批，每批混 2 份 F3 锚点，4 个锚点复现 10/10、12/13、9/10、12/13，口径没漂移）：

  | | off | on | 差 |
  |---|---|---|---|
  | n=5（第一批） | 0.483 | 0.392 | −0.092（不过线） |
  | **n=10（合并）** | **0.446** | **0.408** | **−0.038**（95% 区间 [−0.167, +0.079]，置换 p 0.62） |

  n=5 时没过线，按维护者同意补到 n=10 后过线（−0.05）。on 臂的方差更大（sd 0.187，off 是 0.096），来自两个低分样本：R2#4（1/24）和 R2#7（3/24），判员都记为根因只有「全部成立」的笼统背书，没点名位置。两个样本都没有调用 `Skill`、`skill__*`、`tool_search` 或任何延迟工具，和改动在工具调用层面没有交集。**这个方差不能排除是首调少了约 1K tokens 引起的**，opus 补测时一起看。
- **L3f 覆盖**：off 2/3 次读满 29/29，on 3/3 次读满。
- **省**：R2 ΣP 中位 1.155M → 1.135M（n=10），L3f 4.47M → 3.65M（n=3）。
- **单测**：新增 `skill/bundled-via-meta-tool.test.ts` 15 条，覆盖分发、manager 优先、5 种 deny 写法（含旧写法 `skill__review`）、ask 规则在 dontAsk 下拒、checker 转发、禁用名单、listing。`tool-guide-dedup.test.ts` 和 `deferred-tools-in-prompt.test.ts` 改成断言延迟指南不进 system、激活后的定义里有指南。
- **变异自证**：恢复延迟指南渲染 → 2 条变红；去掉兜底分发 → 11 条变红；去掉兼容别名 → 3 条变红；listing 不过滤禁用 → 1 条变红。
