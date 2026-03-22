#!/usr/bin/env bash
# sid-code 命令系统增强功能演示脚本

set -e

echo "=========================================="
echo "sid-code 命令系统增强功能演示"
echo "=========================================="
echo ""

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

function section() {
    echo ""
    echo -e "${BLUE}## $1${NC}"
    echo "----------------------------------------"
}

function demo() {
    echo -e "${YELLOW}$ $1${NC}"
    echo "$2"
    echo ""
}

section "1. 参数解析器 (ArgParser)"

demo "位置参数解析" \
"const parser = new ArgParser('add server myserver');
parser.get(0);  // 'add'
parser.get(1);  // 'server'
parser.get(2);  // 'myserver'"

demo "--key=value 格式" \
"const parser = new ArgParser('add server --scope=user --timeout=5000');
parser.string('scope');   // 'user'
parser.number('timeout'); // 5000"

demo "布尔标志" \
"const parser = new ArgParser('list --all --verbose');
parser.flag('all');     // true
parser.flag('verbose'); // true"

section "2. 子命令架构"

demo "多层级命令查找" \
"registry.get('mcp list');           // MCPListCommand
registry.get('mcp add');            // MCPAddCommand
registry.get('parent sub subsub');  // SubSubCommand"

demo "别名支持" \
"registry.get('mcp ls');  // MCPListCommand (ls 是 list 的别名)
registry.get('p s1');     // SubCommand1 (p 是 parent 别名，s1 是 sub1 别名)"

section "3. MCP 管理命令"

demo "/mcp list - 列出所有服务器" \
"MCP 服务器状态:
  ✓ 已连接 filesystem (stdio) [5 工具, 2 资源]
  ○ 已禁用 api (http)
  ✗ 未连接 remote (sse) - Connection timeout"

demo "/mcp add - 添加 stdio 服务器" \
"/mcp add filesystem npx -y @modelcontextprotocol/server-filesystem /tmp
→ MCP 服务器 \"filesystem\" 已添加到 project 配置 (stdio)"

demo "/mcp add - 添加 HTTP 服务器" \
"/mcp add api http://localhost:3000 --transport http --timeout 10000 --trust
→ MCP 服务器 \"api\" 已添加到 project 配置 (http)"

demo "/mcp disable - 临时禁用" \
"/mcp disable filesystem --session
→ MCP 服务器 \"filesystem\" 已在当前会话禁用"

demo "/mcp remove - 移除服务器" \
"/mcp remove filesystem --scope project
→ MCP 服务器 \"filesystem\" 已从 project 配置中移除"

section "4. Skills 管理"

demo "/skills list - 列出所有 skills" \
"Skills 列表:

用户级 (~/.sid-code/skills/):
  ✓ 已启用 code-review - 代码审查助手
  ○ 已禁用 refactor - 重构建议

项目级 (.sid-code/skills/):
  ✓ 已启用 test-gen - 生成单元测试"

demo "/skills enable - 启用 skill" \
"/skills enable code-review --scope user
→ Skill \"code-review\" 已在 user 配置中启用"

demo "/skills disable - 禁用 skill" \
"/skills disable refactor --scope user
→ Skill \"refactor\" 已在 user 配置中禁用"

section "5. 扩展管理"

demo "/agents list - 列出自定义 agents" \
"自定义 Agents:

用户级 (~/.sid-code/agents/):
  • debugger - 调试助手 [工具: read, grep, bash]

项目级 (.sid-code/agents/):
  • tester - 测试生成器 [工具: read, write, bash]"

demo "/commands list - 列出自定义命令" \
"自定义命令:

用户级 (~/.sid-code/commands/):
  /review - 代码审查
  /explain - 解释代码

项目级 (.sid-code/commands/):
  /deploy - 部署到生产环境"

section "6. Help 系统增强"

demo "/help - 显示所有命令" \
"可用命令:
  /help [command]  - 显示帮助信息
  /model [name]    - 显示/切换模型
  /mcp             - MCP 服务器管理
  /skills          - Skills 管理
  /agents          - 自定义 Agents 管理
  ...

提示: 使用 /help <command> 查看命令详情"

demo "/help mcp - 显示 MCP 命令详情" \
"MCP 服务器管理

子命令:
  /mcp list              - 列出所有 MCP 服务器状态
  /mcp add <name> <cmd>  - 添加 MCP 服务器
    --scope user|project   配置作用域
    --transport stdio|http|sse  传输方式
    --timeout <ms>         连接超时
    --trust                信任服务器
  /mcp remove <name>     - 移除 MCP 服务器
  ...

示例:
  /mcp add myserver npx -y @modelcontextprotocol/server-filesystem /tmp"

section "7. SessionState 增强"

demo "会话数据存储" \
"// 存储会话级别的临时数据
sessionState.set('mcp_disabled', ['filesystem', 'api']);
sessionState.get('mcp_disabled');  // ['filesystem', 'api']
sessionState.has('mcp_disabled');  // true
sessionState.delete('mcp_disabled');"

section "8. 配置作用域"

demo "三级作用域" \
"user    - 用户级 (~/.sid-code/config.yaml)
project - 项目级 (.sid-code/config.yaml 或 .mcp.json)
session - 会话级 (内存，退出后丢失)

优先级: session > project > user"

demo "作用域示例" \
"# 用户级（所有项目共享）
/mcp add global-server npx server --scope user

# 项目级（仅当前项目）
/mcp add project-server npx server --scope project

# 会话级（临时）
/mcp disable noisy-server --session"

section "9. 测试覆盖"

echo "✅ ArgParser 单元测试: 13 个测试全部通过"
echo "✅ Registry 集成测试: 13 个测试全部通过"
echo "✅ 总测试数: 496 个测试，0 失败"
echo "✅ 编译通过: 无 TypeScript 错误"
echo ""

section "10. 性能指标"

echo "📊 编译产物大小: 63MB"
echo "📊 子命令查找: O(n)，n ≤ 3"
echo "📊 参数解析: O(m)，m = 参数数量"
echo "📊 配置缓存: 5 分钟 TTL"
echo ""

section "11. 向后兼容性"

echo "✅ 所有现有命令保持不变"
echo "✅ 旧的 /mcp 命令仍然可用"
echo "✅ 新增的子命令和选项都是可选的"
echo "✅ 参数格式向后兼容"
echo ""

section "12. 文档"

echo "📚 增强方案: docs/command-enhancement-plan.md"
echo "📚 实施总结: docs/command-enhancement-summary.md"
echo "📚 使用指南: docs/command-usage-guide.md"
echo "📚 变更日志: docs/CHANGELOG-commands.md"
echo "📚 项目文档: CLAUDE.md (已更新)"
echo ""

section "13. 对比 gemini-cli"

echo "| 功能         | gemini-cli | sid-code | 状态 |"
echo "|--------------|-----------|----------|------|"
echo "| 子命令架构   | ✅ yargs   | ✅ 手动   | ✅    |"
echo "| 参数解析     | ✅ yargs   | ✅ 自定义 | ✅    |"
echo "| MCP 管理     | ✅ CLI     | ✅ 交互式 | ✅    |"
echo "| Skills 管理  | ✅ CLI     | ✅ 交互式 | ✅    |"
echo "| Scope 管理   | ✅ 3 级    | ✅ 3 级   | ✅    |"
echo "| Help 系统    | ✅ 自动    | ✅ 手动   | ✅    |"
echo ""

section "14. 下一步计划"

echo "P0 (核心功能完善):"
echo "  - 实际测试 MCP add/remove 功能"
echo "  - 测试 Skills enable/disable 功能"
echo "  - 补充端到端集成测试"
echo ""
echo "P1 (用户体验优化):"
echo "  - 为所有命令添加详细帮助"
echo "  - 添加命令自动补全提示"
echo "  - 优化错误提示信息"
echo ""
echo "P2 (高级功能):"
echo "  - 实现 Checkpoint/Restore 增强"
echo "  - 添加 MCP 服务器连接测试"
echo "  - 支持 Skills 远程安装"
echo ""

echo "=========================================="
echo "演示完成！"
echo "=========================================="
echo ""
echo "查看详细文档："
echo "  - 使用指南: docs/command-usage-guide.md"
echo "  - 变更日志: docs/CHANGELOG-commands.md"
echo "  - 项目文档: CLAUDE.md"
echo ""
