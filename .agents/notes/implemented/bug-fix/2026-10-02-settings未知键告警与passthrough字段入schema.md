---
Status: implemented
Date: 2026-10-02
---
# settings 未知顶层键告警 + passthrough 字段入 schema（B32），附参考页两处可读性改进（B31）

## 决定了什么

**B32（拼错静默不生效）**

- `SettingsSchema` 补声明原先只靠 `.passthrough()` 生效的 **27** 个字段：`ref/settings.md` 上标 ⚠ 的 26 个，外加一个连白名单都漏了的 `bridge`（`cli.ts` 读 `config.bridge?.enabled`）。`ref/settings.md` 的 ⚠ 由 26 降到 0，页首那句「拼错只会静默不生效」由生成器按数量自动改写。
- 类型**只写到不比运行时更严**：对象字段一律 `z.object({}).passthrough()` 空壳（子结构由各消费点解析，schema 里再写一遍就是第二份会漂移的事实源）；`toolSearch` 是 `boolean | "auto" | number`，与 `parseToolSearchConfig` 同口径；`conflictSeverity` 用枚举，因为 `cli.ts` 对非法值本来就回退 `warn`，schema 判不合法只多一条提示、行为不变。
- 启动时检查用户 / 项目 / 本地三个 settings 文件的顶层键：已知集合 = schema 声明键 ∪ `normalizeConfigKeys` 的别名表（snake_case 写法运行时确实生效）∪ `$schema`。未知键进 `_validationDiagnostics.warnings`（与 D10 的字段级错误同一出口：TUI 横幅、`-p` 的 stderr），带 did-you-mean（编辑距离 ≤ 2 且 < 键长一半，大小写不敏感，复用 `levenshteinDistance`）。
- 别名表从 `normalizeConfigKeys` 函数体提到模块级 `SETTINGS_KEY_ALIASES`，归一化与告警共用一份；行为不变。

**B31（参考页可读性）**

- `ref/cli.md` 子命令表只留首行说明，多行用法 / 选项 / 示例原样进各自的 `### sid-code <sub>` 代码块，不再截成「…」（D112：`mcp` 正好截在子命令清单处）。
- `/cron` `/mcp` `/memory` `/plugin` `/ide` `/lsp` `/cache` `/trace` 补 `argumentHint`，description 去掉括号里的参数枚举（D113 ①）；补全列表与参考页同源，两处一起变好。
- `ref/cli.md` 页首「67 个条目 vs 66 个 flag」补一句**按数据算出来的**口径说明：64 条一一对应 + 3 条不对应顶层声明（`--resume [值]`、`--no-session-persistence`、`--build-info`）+ 2 个声明了不写进帮助（`--dump-tools`、`--session-persistence`），64 + 2 = 66（D113 ②）。

## 放弃了什么（以及为什么不选）

- **未知键直接拒绝 / 报错退出**：`.passthrough()` 的初衷是向前兼容 —— 新版本写进去的字段，旧版本读到时不能拒。拒绝会让「降级一个版本」变成「启动失败」。
- **把 managed-settings.json 也纳入检查**：那里放的是企业策略键（`policyLimits`、`allowManagedHooksOnly`……），走 `policy.ts` 另一套解析，混进来全是误报。误报多了用户会学会无视横幅，告警就成了死功能。
- **对象字段把子结构也写进 schema**：用户级 settings.json 的运行时取值走 `loadConfigFile` 的原始 JSON，不经 schema；写死子结构只会在 `getSettings()` 视图里多摘值、多报错，换不到任何行为上的保护，还多一份要同步的类型。
- **删掉 `PASSTHROUGH_FIELDS` 机制**：清单清空但保留。以后再出现「有消费点但 schema 表达不了」的字段，登记进去页面会自动标 ⚠，比悄悄不写强。
- **子命令用法用 `<details>` 折叠**：VitePress 里 `<details>` 内的 markdown 渲染依赖空行与缩进，生成器里多一处易碎点；独立小节 + 代码块还能被页内锚点链接到。
- **差值那句写死成「差的是 --build-info」**：下次加一个 flag 就成了骗人的解释，所以由 `describeCountGap` 按对账数据生成。

## 拿什么证明它生效了

- `packages/core/tests/config/settings-unknown-keys.test.ts` 7 条：`autoMemroy` 报且建议 `autoMemory`；合法字段（schema 键、原 passthrough 键、snake_case 别名、`$schema`）0 报；短键不乱配；大小写拼错能建议；27 个字段全部已声明；`toolSearch` 四种运行时取值都接受；对象子键不被剥。
- 变异自证 4 项全部转红：去掉告警调用 / 已知集合去掉别名表 / schema 去掉 `bridge` / `toolSearch` 收紧为 boolean。
- 编译产物端到端：settings.json 里加 `autoMemroy`、`langauge` 跑 `./sid-code -p`，stderr 出现「配置检查发现 2 项提示」，分别建议 `autoMemory`、`language`；用本机真实 `~/.sid-code/settings.json`（21 个顶层键）跑，未知配置项 **0** 条（误报为 0）。
- `bun run docs:gen-reference --check` 通过；`ref/settings.md` 的 ⚠ 行数 0。
