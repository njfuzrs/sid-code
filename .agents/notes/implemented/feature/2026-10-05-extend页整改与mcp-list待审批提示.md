---
Status: implemented
Date: 2026-10-05
---
# extend/ 十页按源码现状整改，mcp list 末尾补待审批提示

## 决定了什么

- `website/extend/*.md` 按当前 main 源码改写与源码矛盾的说法：同名优先级（project 覆盖 user，`--add-dir` 高于项目级）、skill `max-turns` 默认 30、`allowed-tools` 未声明时 delegate 只给只读四件套、补 `context` 字段、hook `timeout` 单位是秒、嵌套 hook 会打 warn、环境变量表补三项、MCP 项目级未批准不加载（pending/approve/reject）、`mcp remove` 不存在时 rc=1、MCP 企业管控一节、插件安全表述、Bridge 准入、插件只支持本地目录、IDE 扩展未发布 + `diffPreview` 默认关 + 关标签页=未表态。手写页去掉旧 `src/` 路径与行号。
- `packages/cli/src/command/mcp-cli.ts`：`mcp list`（非 JSON）在有待审批项目级 server 时末尾打印「另有 N 个…见 `sid-code mcp pending`」。`--json` 形状不变。
- `packages/core/src/config/settings/types.ts`：hooks 字段注释写明 timeout 单位是秒，经 `docs:gen-reference` 进 `ref/settings.md`。

## 放弃了什么（以及为什么不选）

- 不把待审批项塞进 `mcp list --json`：脚本在消费这个形状，改它是破坏性变更；JSON 用户走 `mcp pending --json`。
- skills 快速上手示例没保留 `allowed-tools` 加一句「会多确认一次」：实测 `-p` 下即使 `--allowed-tools Skill` 也会被拒，示例直接跑不通，所以去掉字段，另开 warning 框解释。
- 不统一斜杠路径与模型路径的 `max-turns` / `timeout-mins` 钳制：价值低，只在文档写清差异。

## 拿什么证明它生效了

- 用 `make build` 后的仓库根 `sid-code` 二进制，在 tmp 仓库里设 `SID_CONFIG_DIR=<tmp>/cfg` 实测：
  - skill：示例不带 `allowed-tools` + `--allowed-tools Skill` → 输出 `- fix: 修正 add 函数的边界条件`；带 `allowed-tools: bash, read` → 模型回「changelog-entry skill 没跑起来，这次调用的权限没批」；不加 `--allowed-tools Skill` → 「Skill: 工具 "Skill" 需要用户确认」被拒。
  - mcp：add 之后 list 为空、get 报「不存在」、pending 列出 fs，approve 之后 list/get 都能看到；`mcp remove nope` 退出码 1。
- `packages/cli/tests/command/mcp-list-pending-hint.test.ts` 3 pass；把提示行输出删掉做变异，第 1 条用例转红（2 pass / 1 fail）。
