---
name: "SDDD Module"
description: "新增模块时的同步检查清单。当用户说'新增模块'、'添加新功能'、'add module'、'新增工具'、'新增命令' 时触发。确保所有相关文件都同步更新。"
---

# 新增模块检查清单

## 何时使用
- 添加新的功能模块
- 新增工具、命令、Provider、MCP Server 等

## 核心检查项

添加新功能时，必须检查并同步修改以下文件：

### 代码层
- [ ] `internal/app/app.go` — 新模块是否需要在 App 中初始化和接线？
- [ ] `internal/tool/registry.go` — 新增工具是否注册到 Registry？
- [ ] `internal/command/builtin.go` — 新增 slash 命令是否注册？
- [ ] `internal/config/config.go` — 新增配置项是否添加到 Config 结构体？
- [ ] `internal/cli/root.go` — 新增 CLI 参数是否绑定？

### MCP 相关（如涉及）
- [ ] `internal/mcp/manager.go` — 新 MCP Server 是否注册到 Manager？
- [ ] `internal/mcp/mcp_tool.go` — MCP 工具适配器是否正确转换为 Tool 接口？
- [ ] MCP Server 配置是否添加到 `~/.sid-code/config.yaml` 的 `mcp_servers` 字段？

### 配置与文档层
- [ ] `~/.sid-code/config.yaml` — 配置文件示例是否更新？
- [ ] `CLAUDE.md` — 目录结构是否更新？
- [ ] `docs/failure-modes.md` — 是否发现新的失败模式？

## 完成后
向用户报告检查结果，列出已同步和未同步的文件。
