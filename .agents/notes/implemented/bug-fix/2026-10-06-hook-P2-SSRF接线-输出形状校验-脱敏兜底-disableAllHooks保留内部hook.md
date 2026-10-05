---
Status: implemented
Date: 2026-10-06
---
# Hook P2：SSRF 接线、输出形状校验、脱敏值兜底、会话记忆让路 hook ask、disableAllHooks 不关内部可观测 hook

## 决定了什么

一次修九条（缺陷编号见 docs-research `20260927-Hook系统-顺着sc-11-hooks核出的缺陷.md`）：

- **H5**：url hook 由裸 `fetch` 改走 `ssrfGuardedFetch`（`runner.ts`）。私有 / 云元数据地址拦截，**loopback 放行**（对齐 CC，本机通知服务是正当用法）；`allowedEnvVars` 补进 settings schema 与两个转换器（`registry.convertLegacyHook` / `system.convertPluginHook`），原先写了也到不了 guard。
- **H8 / H9**：#175 删快速路径时已经修掉，本次补断言：异常隔离（后一个 hook 的 deny 不被前一个的异常吞掉），runtime hook 的耗时进入 `totalDuration`。
- **H13**：key 黑名单补上裸 `key` 段、`SK` / `PAT`、`cookie`、`*_BASE_URL` / `*_ENDPOINT`；新增**值形态兜底**（`sk-` / `ghp_` / `glpat-` / `AKIA` / PEM 私钥 / JWT 前缀），不管 key 叫什么都脱敏。
- **H17**：`parseJsonOutput` 拒收 JSON 数组；command / url hook 的输出按已知字段校验，未知字段与非法 `decision` 按「来源 + 问题」去重后打 warn。**只告警不丢弃**。
- **H18**：在可阻塞事件上配 `async: true` 时，注册期打 warn；后台 hook 的真实退出码照实记录，`markCompleted` 新增 `rewake` 参数，把「是否回灌」和「退出码」拆成两个参数分开传。
- **H25**：会话记忆为 allow 且 hook 说 ask 时，记忆让路，走正常的升级确认。deny 记忆照常早退，skipPermissions 不动。
- **H26**：多个 hook 把 `updatedInput` 改成不同内容时打 warn，点名竞争双方和最终采纳者。合并规则不变。
- **H28**：选了缺陷文档里的候选 A。`disableAllHooks`（企业策略和用户 settings 两个来源）只关用户可配置的 hook，`type: runtime` 一律保留；开关生效时按来源各打一条 info，说明屏蔽了几个、保留了几个。

## 放弃了什么（以及为什么不选）

- **H28 候选 B（保持现状）**：越是管得严的企业，越拿不到自己的度量数据，而且「采集停了」和「没人用」在数据上分不出来。**候选 C（拆成两个策略字段）**：多一个配置项，却换不来新能力。用户本来就配不出 runtime 类型的 hook（schema 不认），关掉它挡不住任何「任意代码执行」。保留 runtime 的判据是 `config.type === "runtime"`，**不看 `source`**：`source` 是调用方自己填的，内部 hook 和测试里都有填 `User` 的情况，靠它判断不可靠。
- **H17 遇到未知字段就丢弃**：新协议字段会被静默吃掉，等于把「静默失效」换了一种形态。
- **H13 换成白名单**：hook 必需的环境变量多（PATH / HOME / LANG / SHELL / NODE_ENV / TERM…），白名单漏一个，hook 就直接跑不起来。
- **H26 自动合并改参**：两份改写在语义上合并不了（「加 `--dry-run`」和「换成别的命令」无法同时满足），能做的只有让冲突可见。
- **H25 让 hook 一律压过会话记忆**：这会打开一条「hook allow 越过用户明确拒绝」的新路径，所以只对 allow 记忆加 ask 这一种组合让路。
- **H5 连 loopback 一起拦**：本机审计 / 通知端点是 url hook 最常见的用法之一，CC 也是放行 loopback 的。SSRF 要防的是借本进程去够内网和元数据服务。

## 拿什么证明它生效了

- 新增 `packages/core/tests/hook/hook-p2-isolation-ssrf-shape.test.ts`，23 条，每条断言正反两面。**变异自证**：逐个撤掉 16 个修复点（值兜底、cookie 模式、数组拒收、字段告警、退出码、SSRF 接线、转换器转发、loopback 放行、async 告警、记忆让路、deny 记忆护栏、改参告警、同值不告警、企业 / 用户两处 H28），每个都至少让 1 条测试变红。
- H5 走的是**用户配置的真实路径**（`replacePluginHooks` / `initializeFromLegacy` → fire），没有直接调 `ssrfGuardedFetch`：指向 `169.254.169.254` 的请求被拦且有日志；指向本机 `Bun.serve` 的请求放行，header 只插值白名单里的变量。
- `enterprise-policy-gate.test.ts` 的门面用例原先断言 disableAllHooks 会关掉 runtime hook，这次按 H28 的新语义改写了。
- docs-research 下的复现脚本指向修复后代码重跑：H13 九个变量全部为空；H15–H18 场景【5】的数组被拒收并告警；H25【1】`needsConfirmation=true`、【2】仍 `allowed:true`；H26 出现冲突告警；H28 内部 hook 剩 1 个；H6–H9 场景 D 中第二个 hook 照常执行。
- `bun run affected-tests:run` 1718 pass / 0 fail，`make build` 自检通过，`lint` / `lint:boundary` / `docs:gen-reference --check` 全绿。
- 未验证：真实企业部署下 disableAllHooks 的日志是否被人看到，H17 告警在真实轨迹里的误报率（特别是 CC 协议里还有哪些字段没进白名单）。这两项要等上线后看 `events.jsonl` 里的 warn。
