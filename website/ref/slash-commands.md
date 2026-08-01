---
title: 斜杠命令
description: 交互模式里可用的全部斜杠命令。
---

# 斜杠命令

交互模式里可用的全部斜杠命令。

<!--
  本页由脚本生成，请勿手工编辑
  AUTO-GEN:START 与 AUTO-GEN:END 标记之间的内容由
  scripts/docs-gen-reference.ts 从源码生成（数据源：BUILTIN_COMMANDS + legacy 注册表），
  手改会在下次生成时被覆盖，且 pre-commit 会先拦住。
  需要补充说明请写在标记之外——那部分内容会被保留。
  （此提示写给维护者，HTML 注释不会渲染给终端用户。）
-->

<!-- AUTO-GEN:START 由 scripts/docs-gen-reference.ts 生成，勿手工编辑 -->

> 共 **62** 个内置斜杠命令，从运行时命令注册表导出。
> 在交互模式输入 `/` 会看到同一份列表（补全列表与本表同源）。

| 命令 | 说明 | 别名 | 参数 |
|---|---|---|---|
| `/add-dir` | 运行时把目录加入当前会话可访问白名单（用户级授权，仅本会话） | — | `<目录路径> \| --list \| --remove <目录>` |
| `/agents` | 自定义 Agents 管理 | — | — |
| `/allow` | 添加 allow 权限规则（默认当前会话，-p 持久化） | — | `<规则> [-p] [--scope user\|project]` |
| `/batch` | 把任务分解为独立单元、各自 worktree 并行执行（经 Workflow 编排） | — | `<要批量处理的任务>` |
| `/btw` | 旁路提问：基于当前对话上下文快速回答，不打断也不写入主对话 | `/by-the-way` `/ask` | `你的问题` |
| `/bug` | 生成 bug 报告模板（含环境信息）并复制到剪贴板 | `/feedback` | `[问题简述]` |
| `/cache` | 显示缓存命中率/省钱长期统计（--period day\|week\|month --model &lt;name> --breaks --history --prune &lt;N>） | — | — |
| `/checkpoints` | 查看快照历史 | `/cp` | — |
| `/claude-api` | 加载 Claude API 参考文档作为对话上下文 | — | `[messages\|streaming\|all]` |
| `/clear` | 清空对话历史 | `/reset` `/new` | — |
| `/color` | 设置 UI 强调色（品牌色），reset 恢复，-p 持久化 | `/accent` | `[#hex\|reset] [-p]` |
| `/commands` | 列出所有自定义命令 | `/cmds` | — |
| `/compact` | 压缩对话历史（无参全量 / 数字只压前半段 / 文本 focus 保留重点） | — | `[比例\|下标\|focus 指令]` |
| `/config` | 显示当前配置 | `/settings` | — |
| `/context` | 上下文用量可视化（分类 token 拆解 + 距压缩阈值） | — | — |
| `/copy` | 复制最后一条助手回复到剪贴板（code 只复制代码块） | — | `[code]` |
| `/cost` | 显示 token 用量和费用 | — | — |
| `/cron` | 管理定时任务 (list/delete) | `/schedule` | — |
| `/debug` | 调试信息：上传当前轨迹快照、显示诊断数据、复制 Session ID | `/diag` | — |
| `/deny` | 添加 deny 权限规则（默认当前会话，-p 持久化） | — | `<规则> [-p] [--scope user\|project]` |
| `/diff` | 显示当前工作区 git diff（--staged 看已暂存改动） | — | `[--staged\|--cached]` |
| `/doctor` | 环境自检诊断（版本/运行时/配置/git/ripgrep/模型/MCP） | `/checkup` | — |
| `/effort` | 显示或切换推理强度档位（low/medium/high/max/auto） | — | `low\|medium\|high\|max\|auto` |
| `/exit` | 退出程序 | `/quit` `/q` | — |
| `/export` | 导出对话到剪贴板或文件 | `/save` | `[clipboard\|file\|<path>] [json\|md]` |
| `/fast` | 切换 Fast Mode 偏好（网关对等能力就绪前为预留开关） | — | `[on\|off]` |
| `/fork` | 分叉当前会话为独立新会话（打印重启命令） | — | — |
| `/goal` | 目标驱动持续执行：设定完成条件，AI 在达成前不停止 | — | `<完成条件> \| status \| pause \| resume \| edit <新条件> \| turns <n> \| budget <tokens> \| clear` |
| `/help` | 显示帮助信息 | `/h` `/?` | — |
| `/hooks` | 管理 Hook (list/enable/disable/enable-all/disable-all，-p 持久化) | — | `[list\|enable\|disable\|enable-all\|disable-all] [name] [-p]` |
| `/ide` | IDE 集成管理（status/connect/disconnect/install） | — | — |
| `/init` | 分析代码库并生成 CLAUDE.md（--dirs-only 仅初始化 .sid-code/ 目录） | — | — |
| `/insights` | 生成会话分析报告（模型/成本/token/工具/异常概览） | `/analyze` | `[session-id\|latest]` |
| `/keybindings` | 查看键位绑定 / 创建 keybindings.json 模板 | `/keys` | `[init]` |
| `/language` | 显示或切换输出语言偏好（-p 持久化） | `/lang` | `[zh\|en\|auto\|unset] [-p]` |
| `/loop` | 按间隔重复运行 prompt：/loop 5m &lt;任务>（固定节奏）或 /loop &lt;任务>（自适应轮询） | — | `[间隔如 5m] <要重复的任务>` |
| `/mcp` | MCP 服务器管理 | — | — |
| `/memory` | 管理记忆（auto/external/set/get/delete/list/search/show/reload） | `/mem` | — |
| `/model` | 显示或切换模型（主模型 / fallback / 子代理，-p 持久化） | `/m` | `[name\|fallback <name>\|sub <type> <name>] [-p]` |
| `/permissions` | 查看当前权限规则和模式 | `/perms` | — |
| `/plan` | 进入计划模式（先规划后执行） | — | — |
| `/plugin` | 插件管理 (list/info/install/uninstall/enable/disable) | `/plugins` | — |
| `/ps` | 列出后台任务和活跃会话 | `/tasks` | — |
| `/reload-plugins` | 重新加载所有插件组件（命令/Skills/Hooks/MCP） | `/reload-plugin` | — |
| `/rename` | 重命名当前会话（无参则据上下文自动生成名字） | — | `[新名字]` |
| `/restore` | 恢复到指定快照点 | — | — |
| `/rewind` | 回退会话（可选代码/对话/两者），等价 Esc+Esc | `/checkpoint` | — |
| `/skills` | Skills 管理 | — | — |
| `/stats` | 显示当前会话统计信息 | — | — |
| `/status` | 显示会话状态概览（模型/目录/token/provider/skills） | — | — |
| `/statusline` | 配置自定义状态栏脚本（stdin JSON → stdout 状态栏，对齐 CC） | — | — |
| `/telemetry` | 显示当前会话遥测摘要（Span 树 + Metric 汇总） | `/tele` | — |
| `/terminal-setup` | 为当前终端安装 Shift+Enter 换行键绑定（VSCode/Cursor/Windsurf 等） | — | — |
| `/theme` | 显示或切换主题（-p 持久化） | — | `[name\|list] [-p]` |
| `/think` | 显示或切换思考开关（on/off/auto） | — | `on\|off\|auto` |
| `/todos` | 列出当前会话的待办清单（TodoWrite 维护） | `/todo` | — |
| `/trace` | 排查会话:把当前/指定会话轨迹嚼碎成结构化摘要(--list 列会话, &lt;id> 指定, --full 详细) | `/digest` | — |
| `/tui` | 切换全屏 TUI（Alternate Buffer）模式偏好（重启生效） | `/fullscreen` | `[on\|off]` |
| `/undo` | 撤销最近一次文件修改（回滚到上一个 checkpoint） | — | — |
| `/vim` | 切换 Vim 输入模式（无参 toggle；on/off；-p 持久化） | — | `[on\|off] [-p]` |
| `/workflows` | 查看动态工作流 run（无参列出；带 runId 看详情） | `/wf` | `[runId\|taskId]` |
| `/worktree` | 管理 Git Worktree (list/clean) | `/wt` | — |

<!-- AUTO-GEN:END -->
