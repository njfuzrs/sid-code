---
Status: implemented
Date: 2026-10-19
---
# effort 线上对齐官方：adaptive Claude auto 不发 effort、Grok xhigh、GLM 档位，附 /effort 文案

## 决定了什么

- **adaptive Claude 的 auto 不发 `output_config.effort`**（`dialect/anthropic.ts`）：只发 `thinking:{type:"adaptive"}`，服务端按模型默认档跑（Opus 5.5 / Haiku 5.5 = medium，其余 high）。此前 auto 显式发 high，在 Opus 5.5 / Haiku 5.5 上比服务端默认高一档（排查 E3 方案 ①）。`outputConfig.effort` 改为可选，`thinkingType` 照写，否则 `buildThinkingParam` 会退回 manual budget。思考上限降档在 auto 下仍生效，基准档取注册表 `defaultEffort`（缺省 high）。
- **Grok xhigh**：注册表 `reasoningEffortValues` 类型放进 xhigh，grok-4.3 / 4.6 / 4.7 登记 xhigh。grok applier 读同一张表，表里有 xhigh 就原样下发，4.5 和未登记模型仍钳 high（E8）。
- **GLM 档位**：GLM-5.2 档位表改为 high / max；glm applier 按档位表把表外档位**向上**取整（5.2 的 low/medium → high，5.3 的 medium → high），没登记档位表的 GLM 保持旧行为（E10）。可选档由 `getSelectableEfforts` 的映射预演自动跟随，没有另建表。
- applier 与线格式层 `filterParamsForModel` 都读 `lookupCatalog(...).reasoningEffortValues`，所以两层对同一模型给出同一个答案。
- **文案（G / E6）**：`/effort` 帮助里写明「无参数打开面板」；auto 的说明改成「不下发档位，服务端按模型默认」，并注明 manual Claude 的例外；补上「子代理不受影响」和「思考关闭时划线」的说明。面板 auto 选项、命令描述、`config.ts` 的 effortLevel 注释同步改了，参考页已重新生成。

## 放弃了什么（以及为什么不选）

- **E3 方案 ②（保留显式发 high，只改文案说 auto = high）**：用户在 Opus 5.5 / Haiku 5.5 上会被抬高一档，「auto = 跟随默认」仍是假话。F1 已经给注册表补了每模型默认档，方案 ① 不缺数据。
- **GLM 表外档位向下取整**（同 `clampToKnownValues`）：5.2 的 low 会变成「无档可降」，取到最高档，与官方「low → high」相反。按官方语义只能向上取。
- **Grok 加一个 `supportsXhighEffort` 字段**（同 Claude 的 D）：Grok 已经有 `reasoningEffortValues`，线格式层也在读它。再加一个字段等于造第二份真相。
- **按模型名硬编码 xhigh 白名单**：违反「禁按模型硬编码分级」，走注册表数据。

## 拿什么证明它生效了

- 新测试 `packages/core/tests/llm/effort-wire-f2.test.ts` 9 条，走真实 `resolveEffortCapability` + `filterParamsForModel`。`effort-default-display.test.ts` 里锁「F1 不改线上 / adaptive auto 发 high」的旧断言已按新行为改写。两文件 23 pass。
- 变异自证（各自变红后已恢复）：① auto 改回 `effort ?? "high"` → 2 fail；② grok `xhighOk` 恒 false → 1 fail；③ glm 改回只钳 xhigh → 2 fail；④ 降档基准忽略注册表默认档 → 1 fail。
- 探针（非联网）：Opus 5.5 / Haiku 5.5 auto 线上 `{thinkingType:"adaptive"}`，Footer 显示 medium；grok-4.7 可选 low…xhigh，xhigh→xhigh；grok-4.5 xhigh→high；glm-5.2 可选 high,max；glm-5.3 medium→high。
- 没做：真网关补测 Grok 4.6 / 4.7 的 xhigh（只有文档依据）、Opus 5.5 不发 effort 时的真响应。发版后从轨迹 `effort_wire` 看：adaptive Claude auto 应为 `omitted`，Grok xhigh 的 400 率。出问题可以单独回滚本 PR。
