---
Status: implemented
Date: 2026-11-16
Source: H2 目标续跑与收敛 · 上一轮发现二次核查（2026-11-16）
---
# `--settings` 的作用范围写清并锁住：只到 settings 视野，不到 Config 对象

## 决定了什么

把「`--settings` 到底影响什么」从**三处互相印证的错误注释**改成事实，并加一条测试把它锁住。**零行为变更**，改的是读者能据此推断的结论。

结论本身：`--settings <file-or-json>` 经 `setFlagSettings()` 注入的是 `flagSettings` 内存源，只有 `getSettings()` / `getSettingsForSource("flagSettings")` 会消费它；`loadConfigFile()` 只读磁盘 `~/.sid-code/settings.json` + project/local 行为白名单 overlay，**全程不取这个源**。所以 `--settings '{"model":...}'`、`'{"goal":...}'`、`'{"maxTurns":...}'` 这类只走 Config 的字段**静默无效**。

四处文本改动：

- `packages/core/src/config/config.ts` — `extraSettings` 字段注释。原话「优先级高于常规 user/project/local 三源，作为最后一层覆盖」没说作用在哪个对象上，读者会理解成对 Config 也生效。
- `packages/cli/src/cli.ts` — 启动注入处注释。原话「使后续 `loadConfigFile` → `getSettings` 合并时即生效」**点名了一个恰恰不吃 flagSettings 的函数**，比上一处更误导：它把怀疑也堵死了。
- `packages/core/src/permission/checker.ts` — P2-1 修 permissions 时留下的「（给 loadConfig 用：模型、开关等）」，括号里那句是错的。
- `packages/cli/src/help.ts` — `--help` 的 `--settings` 说明。这是用户唯一能看到的表述，此前同样只说「最后一层覆盖」。

加一条测试 `packages/core/tests/config/settings-flag-scope.test.ts`（4 个用例）：磁盘基线、只传入参、真实 CLI 路径（先 `setFlagSettings` 再 `loadConfig`）、`getSettings` 视野对照。

## 放弃了什么（以及为什么不选）

**① 放弃「方案 A：让 `loadConfigFile()` 也消费 flagSettings」——本轮不做，理由三条，任一条都足以拦住。**

- **有未拍板的设计决策，agent 无权替用户定**：`loadConfigFile` 的项目级 overlay 有意不放行 `model` / `baseURL` / `provider` / `availableModels` / `env`（恶意仓库改这些会在信任确认前把请求路由到攻击者端点）。`flagSettings` 来自用户当场敲的命令，信任等级更高，但「放不放行路由字段」是要人拍板的产品决定；附带还要处理 `--settings ./.sid-code/evil.json` 这种路径诱导。
- **policy 压制链会断**：`SETTING_SOURCES` 的顺序是 user → project → local → **flagSettings → policySettings**，即企业 policy 压制 flagSettings。把 flagSettings 并进 Config 层，而 Config 恰恰承载路由字段，那「policy 不可被 `--settings` 绕过」在 config 层就没有对策了（目前只有 `permissionMode` 走了 policy 信任度表）。落地前必须先确认压制在别处仍生效，否则是拿安全换便利。
- **单独修 config 会造出第四块补丁**：hooks 那条（`tests/smoke/cases/A2-settings-flag-no-hook`，`kind: lock-defect`）是同一个根因的第二个受害者，permissions 是 2026-09 单独修的。只修 config，`--settings` 会变成「config 生效、hooks 不生效」的新混合态，下一次核查又会把 hooks 当新发现报一遍——同一根因已经被发现三次了。

**② 放弃「与 hooks 合并成一个『统一 `--settings` 视野』PR」——本轮做不了。** 修好 hooks 会让 A2 那条 `lock-defect` 用例按设计变红，必须改它的 `expect`；而改已有 G2 用例的期望按仓库规则要**人**看过 diff 后加 `expect-reviewed` 标签，agent 不得给自己的 PR 加。这跟本轮「自动合并」的交付形态直接冲突，所以正确做法是让那条 PR 走人工 review。

**③ 放弃「启动期 warning：`--settings` 里出现 config-only 键就提示」。** 它比注释更可观测，但要维护一份「只走 config 的顶层键」清单，而这份清单会随 Config 增字段漂移；更关键的是方案 A 一旦落地它就变成错误提示。留待方案 A 时一起做。

**④ 放弃「把 goal 配置改走 `getSettings()`」。** `loop.ts` 的 `{ ...DEFAULT_GOAL_CONFIG, ...config.goal }` 是唯一的 goal 默认值合并点，而 goal 还带运行时状态（`turnsUsed` / `tokenBudget` 由 `/goal` 写回）。搬过去会让「默认值 + 用户配置 + 运行时状态」三个来源分裂到两套系统里。

## 拿什么证明它生效了

**① 只读探针**（`SID_CONFIG_DIR` 指向临时目录，不碰真实配置；磁盘设置 `goal.defaultMaxTurns=7`，`--settings` 想写 6）：

```text
A) settings.json   goal  → {"defaultMaxTurns":7}     ← 磁盘源生效
A) settings.json   theme → undefined
B) 只传 extraSettings   → {"defaultMaxTurns":7}      ← 入参无效
C) setFlagSettings 后   → goal: {"defaultMaxTurns":7}  theme: undefined  model: ""
D) getSettings 视野     → {"goal":{"defaultMaxTurns":6},"theme":"flag-theme","model":"flag-model"}
```

C 与 D 同一个 `flagSettings`，两条链结论相反 —— 这就是要写进注释的那句话。

**② 新增测试全绿**：

```text
bun test ./packages/core/tests/config/settings-flag-scope.test.ts
 4 pass / 0 fail / 10 expect() calls / 135.00ms
```

**③ 变异自证**（防止「恒绿的门禁」）：把 `loadConfigFile` 临时改成方案 A 的形态（`mergeConfig(userConfig, overlay)` 之后再叠 `normalizeConfigKeys(flagSettings)`），同一条测试立刻变红：

```text
(fail) 真实 CLI 路径（先 setFlagSettings 再 loadConfig）：Config 仍不受影响
  Expected: 7   Received: 6
3 pass / 1 fail
```

恢复后重跑回到 4 pass / 0 fail。这条证明断言测的确实是「Config 吃不吃 flagSettings」这条链路，而不是别的什么。

**④ 门禁**：

```text
bun run affected-tests:run  → selective 5 个目标：6114 pass / 10 skip / 0 fail（465 files，337s）
make build                  → 通过（产物自检 5 项全绿）
bun run smoke               → 40 例：40 通过，0 失败，0 跳过
bun run smoke 的 expect-guard → 本次没有改动 G2 用例
bun run lint                → 0 warnings / 0 errors（3237 files）
bun run format:check        → All matched files use the correct format
bun run lint:boundary       → 通过（测试无跨包相对路径 / 渲染端口 0 处直连）
bun run lint:command-system → 四道门禁通过
bun run lint:legacy-tool    → 引用 LegacyTool 的生产文件 57 / 基线 57
bun run typecheck:gate      → 62 处错误 / 基线 62 处，无新增
bun run verify:agent-note   → 903 份形态合规
bun run website:build       → build complete in 17.50s（改了 website/ref/cli.md）
```

**⑤ 一个 worktree 陷阱（顺手记下来，它会让「不是你的错」看起来像你的错）**：worktree 建出来时 `node_modules` 是**指向主仓的软链**，于是 `@sid-code/core` 被解析到主仓 checkout，而测试文件从 worktree 加载 —— 同一个类型出现两个物理路径，`typecheck:gate` 第一次跑报 6 处 `TS2322/TS2345`，错误行里同一个类型同时是 `<root>/packages/core/src/...` 和 `/Users/.../sid-code/packages/core/src/...`。删掉软链重装（`bun install`）后 62/62 通过。判据很直接：**报错里出现两种 specifier 指向同一模块**。这与 CLAUDE.md 里「worktree 里 exit 0 不等于可交付」是同一枚硬币的两面 —— 非 0 也可能与你的改动无关，但必须举证到具体成因，不能只说「环境问题」。

**⑤ 没修什么（避免读者误以为已修）**：`--settings` 对 Config 字段**仍然无效**，hooks 那条**仍然无效**。本 PR 只让「无效」这件事在源码注释和 `--help` 里变得可见，并让未来任何改动这条边界的 PR 会撞上一条红测试。
