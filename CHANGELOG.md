# Changelog

本文件由 scripts/generate-changelog.ts 自动生成，请勿手改。

## v0.1.592 (2026-07-28)

### 新功能
- **website** · 新增叙述覆盖度门禁 —— 命令改动自动触发 --coverage 检查 `34ad2a2d`
  - 每个内置命令必须在 ref/ 参考表之外至少一篇指南页提到，
  - 防止"只进字典不进教程"。当前为告警模式（--coverage 恒退 0），
  - 存量 18 个未覆盖命令清完后切换为 --coverage-strict 阻断。
- **website** · 阶段 4 服务器上线 —— 官网/文档站发布链路 + nginx 切站 `feee6b10`
  - 版本目录 + symlink 原子切换，rsync 全部完成并校验 index.html 后才 ln -sfn
  - --dry-run / --no-gen / --rollback / --allow-dirty
  - 发布前 free -m / df -h 门禁（可用内存 < 300MB 拒绝发布而非中途 OOM）
  - gzip -9 -k 预压缩，配合 gzip_static 零 CPU 开销直吐
  - 保留最近 3 版，清理显式跳过 current 指向的目录
  - 冒烟强制校验 install.sh 返回 200（风险 1 的常态化防线）
  - 比方案多做两处：上传后 chown root:root（rsync -a 会带上构建机 uid 501:staff）； ssh 调用清 LC_ALL/LANG（否则每条远程命令吐 setlocale 噪音淹掉真 warn）
  - §5.3 的 location ~* \.html$ 正则会赢下匹配并旁路 /releases/ 的 alias， 致 CHANGELOG.html 404（原文只预见了「加 no-cache」）。已删该块， no-cache 收敛到各 location 内。
- **website,docs** · 参考文档生成器落地——运行时自省 + 对账门禁 + holdout 公开面适配 `9346c17b`
  - 优先运行时自省，不静态解析源码文本。工具走 --dump-tools、斜杠命令走 loadBuiltinCommands()、Hook 事件走枚举、settings 走 SettingsSchema().shape， 只有 help.ts 这类"人看的文本"才做文本解析并配结构化源交叉对账。
  - --check 对账模式供 pre-commit 门禁调用，漂移退 1。
  - --stale 报告 >90 天未复核的指南页，只告警不阻塞。
  - src/cli.ts 加 --dump-tools 隐藏出口（与发给 LLM 的工具定义同源）
  - src/help.ts / src/config/config.ts / src/hook/types.ts 注释补全
  - pre-commit.sh 接 docs:gen-reference-check，拦参考页漂移
  - pre-push.sh 检测 website/ 变动跑站点构建（死链检测 = 构建门禁，§4.5.4 第四道）
  - eval holdout 门禁把 website/ 纳入公开面扫描，sid×file 两层循环改单次 grep -f（7200 次进程 → 1 次，否则撞穿 5s 超时会被 --no-verify 绕过）
- **website,docs** · 搭建 VitePress 官网文档站点 + 参考文档生成器 `19ee0a4a`
  - 新增 website/ VitePress 站点：自定义品牌主题、站点配置、 start/use/extend/ref/team 五大分区 markdown 页面骨架
  - 新增 tokenize 侧边栏/大纲提取工具及单元测试
  - 新增 scripts/docs-gen-reference.ts 参考文档生成器
  - package.json 增加 website:dev/build/preview 与 docs:gen-reference 脚本
  - 新增官网与文档站点部署方案设计文档
  - 新增 README.md
- **agent,skill,swarm,tool,query** · 对齐 CC 缺口方案双检 + 多模块补全修复（P0-P3） `17fe77f6`
  - agent: 新增 depth-context 子代理深度上下文；frontmatter 消费 model/skills/color 等字段；explore 彻底程度引导；agent-color 注册
  - skill: 新增 listing 元信息；PR 归因统一注入 commit-push-pr/pr-workflow/pr 三条路径；skill 元工具化收敛（删 tool.ts，meta-tool 收口）
  - swarm/team: 新增 team-context/team-message；接通 mailbox 双向通信； structured-task-store 持久化 + 认领调度
  - tool/permission: git 全局选项(-c/-C/--no-pager)只读判定剥离与细分； git 操作分类归一化（-c 前缀不撑开分类）
  - query: 新增 post-compact；compact/partial-compact 阶段增强
  - session: rewind-manager/store 增强；fork session 支持
  - config: 新增 plugin-only-policy；settings schema 扩展（prAttribution 等）
- **session,checkpoint,skill,cli** · 会话持久化对齐 CC §14 + Skill 元工具化重构（P0-P3） `9de3fdd6`
  - P0-B1: checkpoint 覆盖 Bash/NotebookEdit 改文件（cp/>/>>/tee/sed -i 提取，动态路径静默跳过）
  - P0-G1: --session-id <uuid> CLI 入口接线 + UUID 校验 + 组合约束
  - P1-G2: --fork-session + /fork 分叉会话（拷贝历史 + 重新盖戳 + checkpoint 复制）
  - P1-G3: per-message usage 落盘（assistant 记录内嵌 usage/model/stopReason）
  - P1-G4: --no-session-persistence 禁用持久化（headless/CI 门控）
  - P1-G5: /rename 会话重命名
  - P1-G6: 三优先级排队 now>next>later + ↑ 弹回编辑
  - P2-G7: per-message gitBranch/permissionMode/cwd 落盘
- **agent,swarm,tool,permission** · 子代理系统对齐 CC §11 + git 归因/危险检测统一 + bash 快照受影响文件追踪（P0-P3） `b29c1955`
  - 内置 explore/plan/summarize 新增 modelTier 语义档位，未配 subAgentModels 时走便宜模型（registry.ts）
  - 自定义/插件 agent frontmatter model 字段消费透传（custom.ts / loadPluginAgents.ts / cli.ts）
  - frontmatter skills 预加载：AgentDefinition.skills + skill-preload.ts 注入子代理 system prompt
  - frontmatter color 消费：自定义 agent UI 区分色（color.ts / AgentsDialog.tsx）
  - Agent Teams mailbox 双向通信接通：成员 onBeforeTurn drain 邮箱（team.ts / sub-agent.ts）
  - explore 彻底程度引导文案补齐（agent-definition.ts）
  - frontmatter permissionMode/hooks/background/isolation 消费（agent-hooks.ts / custom.ts）
  - 共享任务列表持久化 + 与 swarm 打通：team-task-store.ts 落盘 .sid-code/tasks/，成员认领调度
- **context,llm,query** · 上下文窗口管理对齐 CC §12 缺口修复（P0-P3） `91011f4e`
  - P0-2: 调整压缩阈值系数，1M 窗口触发从 88% 提前到 82%
  - P1-1: 新增 SID_CODE_AUTOCOMPACT_PCT env 覆盖压缩阈值（接活 compactThreshold 死参数）
  - P1-2: /compact focus on X 自由文本聚焦参数（透传 customInstructions）
  - P1-3: PreCompact hook 手动压缩也触发 + additionalContext 注入摘要 prompt
  - P2-1: MAX_THINKING_TOKENS 思考预算上限（manual 精确钳制 / adaptive 映射降档）
  - P3-1: 读取 CLAUDE_CODE_SUBAGENT_MODEL env 填充子代理默认模型
  - 新增 merge-instructions 工具函数合并用户 focus + hook 指令
  - 迁移 skill 新增 apply-migration 脚本 + 测试
- **mcp** · 对齐 CC 缺口修复 B1-B3/G1-G6 + G5 mcp serve `01533f88`
  - B1: 接线 mergeMcpConfigs 三作用域合并(user>local>project)+签名去重+policy
  - B2: 删除死代码 class MCPCommand
  - B3: 补 /mcp prompt 执行子命令(MCPPromptRunCommand)
  - G1: 新增 ListMcpResources/ReadMcpResource 工具 + @server:uri 提及展开
  - G2: prompts 注册为 mcp__server__prompt slash 命令(动态随连接刷新)
  - G3: MAX_MCP_OUTPUT_TOKENS token 维度输出上限(mcp-output-limit.ts)
  - G4: StreamableHTTP 标准传输(session-id 保持 + SSE 分流)
  - G5: mcp serve 把自身工具暴露为 MCP server(stdio),默认仅只读工具, --allow-write 放开写/执行类; 新增 server-transport.ts + mcp-serve.ts
- **memory,command,config** · 外部 @import 审批命令入口 + 父目录链 git root 上界 `beef9924`
  - M4-4/M4-5：新增 /memory external allow|deny|status 子命令，支持拒绝外部导入后 注入 system-reminder 告知模型指令缺失，并接线 setExternalImportsApproved/ getExternalImportsState 到 AppContext
  - M7：findCLAUDEmdChain 父目录链上界新增 git 仓库根检测（existsSync 探测 .git）， monorepo 场景下父链止于仓库根，避免拉入仓库外无关上层目录
  - CLAUDE.md 清理废弃 stable 别名说明
  - 旧审计文档归档至 double-check 子目录
- **memory,config,ui** · 记忆系统增强 + CLAUDE.md 导入处理（M2/M3/M4/M7/M9/M11） `c7f8df13`
  - M2: auto-memory 后台提取开关（env SID_CODE_AUTO_MEMORY > settings > 默认 true）， 运行时热接线/断线，新增 /memory auto 命令
  - M3: CLAUDE.md @import 扩展白名单（.txt/.json）+ 行内导入识别 + 跳过代码围栏/行内代码
  - M4: 外部 @import 审批机制，未批准路径跳过并弹 ClaudeMdExternalImportDialog 审批
  - M7: 父目录链多层 CLAUDE.md 逐层加载（越深优先级越高）
  - M9: symlink 指向的规则文件去重防重复加载
  - M11: 记忆改走索引指针路径（memorySystemPrompt 替代全文摘要）
- **hook,skill,command** · Hook 系统对齐 CC 缺口 G7/G10/G11/G13 + Skill 禁用统一 + 清理废弃模块 `c7a44575`
  - G7 异步 hook（async/asyncRewake）：command 类型后台执行不阻塞主循环， exit 2 时 stderr 下轮回灌唤醒模型；会话结束清理已完成条目
  - G10 if 条件过滤：matcher 命中工具名后，用权限规则语法（如 Bash(git *)） 对 tool_input 二次过滤
  - G11 新事件：InstructionsLoaded / TeammateIdle / Elicitation / ElicitationResult
  - G13 企业策略 Hook 门控：disableAllHooks / allowManagedHooksOnly （managed-settings.json，fire-and-forget 不影响启动）
  - bundled skill 同样 honor disabledSkills（原仅磁盘 skill 生效）
  - UnifiedCommandRegistry.setDisabledSkills() 运行时更新禁用列表，清缓存重载
  - budget 新增 estimateSkillListingTokens 估算注入 token
  - 删除 config-snapshot.ts / permission-race.ts(@deprecated) / resolve-once.ts
- **hook,query,agent,permission** · hook 系统增强——PreToolUse 统一解读 + 退出码对齐 CC + prompt/agent 类型 + 真子代理执行器 `5d6c9a06`
  - G3：抽取 interpretPreToolUse 统一解读 PreToolUse（block/ permissionDecision/updatedInput），主循环、进程内子代理、spawn 子代理三处共享；permissionDecision 注入 PermissionChecker.check， 避免各处自行解读口径漂移
  - G4：退出码语义对齐 Claude Code——仅 exit 2 阻塞，其余非零为非阻塞 告警；SessionStart/SubagentStart/Setup 忽略阻塞（降级 systemMessage）
  - G5：新增 prompt / agent 两种 LLM 层 hook 类型（config/schema/ registry/planner/runner 全链路支持），agent 类型可声明工具白名单
  - G6：agent hook 注入真子代理执行器（携带工具注册表 + ProviderRegistry），启动只读子代理多轮验证而非退化为单轮 LLM 调用； 宽松解析 {ok, reason} 裁决，解析不到默认放行不误阻塞
  - UI 清理：移除 spinner 行尾 effortGlyph 显示（Composer/ LoadingIndicator）

### 修复
- **website** · 表格改回 display:block 修复长 URL 撑破容器溢出 `28330ede`
  - .vp-doc table 曾被改成 display:table，内容超宽时无滚动条，
  - 长 URL 撑破容器溢出到右侧 aside。改回 block + overflow-x:auto
  - 触发横向滚动。
- **website-deploy** · 修首页冒烟假失败 —— pipefail + grep -q 让 curl 吃 EPIPE(exit 23) `183636a5`
  - 限速 3000 场景 3/3 通过（旧写法同条件 3/3 失败）
  - 四条分支实测均判定正确：连不上(curl 7) / 404(curl 22) / 有响应但内容不含目标串 / 正常首页
  - bash -n 语法检查通过
  - 真实跑一次 ./scripts/website-deploy.sh，第 12 步两条冒烟全绿
- **llm,query** · 迁移 skill 崩溃复盘修复 + todo gate 误判自愈 + 北极星宗旨 `b483a2bc`
  - openai.ts: [DONE] 后立即跳出 while 不再 reader.read()，消除网关 延迟关 socket 的空转窗口；reader.cancel() 用 .catch() 兜住异步 rejection，防止 unhandledRejection 崩溃
  - errors.ts: 新增 RETRYABLE_CONNECTION_MESSAGES 消息文本兜底，识别 裸 Error 类型的连接关闭错误（无 .code 字段，此前落到无法分类不重试）
  - normalize-tool-input.ts: RAW_STRING_FIELDS 白名单保护文件内容类字段 不被 JSON.parse 误转成对象（write.content 等）
  - loop.ts: 续命耗尽时区分"忘标记"（有产出却不翻状态位）与"真没做完"， 忘标记走中性收尾不抛假警报
  - todo-reminder.ts/types.ts: 新增 forgotMark 阈值、产出文本阈值、中性收尾文案

### 文档
- **reference** · 记 T-5.7 验收 —— L5 team 全部 5 篇已写实并上线 `0c564581`
  - quota.costLimit 用 ?? 兜住 costLimit，配了前者会让 --max-budget-usd 静默失效， 而团队模板恰好带 quota.costLimit:100 → 全团队该参数默认无效
  - 企业策略路径分裂：权限规则读 /etc/ 与 ~/ 两候选，但模式管控开关只读 ~/， 且 /etc/sid-code/policy.json 是废弃路径、字段进不了运行时 Config
  - team-defaults 补全用的是编译进二进制的模板而非服务器那份， 故 --upload-team-defaults 后老用户要等发新版才生效
- **website** · 阶段 5 内容撰写 T-5.7 —— L5 team 最后 1 篇 observability 写实 `2d62bf62`
  - 落盘结构取自真实会话目录 ls（9 个文件：metadata/session-summary/session.traj/ raw.jsonl/events.jsonl/messages.json/raw_preview/audit_range/warn.log）， events.jsonl 的 13 类事件分布由 python 统计真实文件得出
  - trace-digest.ts 实跑一个真实会话，输出原文摘录（含 L0 事实层/L1 假设层带证伪条件、 Provider 健康 TTFT P50）。顺带记下该例的一个真实反差：metadata.exit_status=error 但 messages.json 的 abnormal=false / exit=end_turn，故正文点明"error 状态不等于异常终止"
  - 上传形态取自 uploader.ts:246-266：POST <url>/api/v1/upload/session-file、 multipart、X-Upload-Token + X-Content-SHA256、gzip level 6、30s 超时、5 次指数退避
  - 三个开关（enabled / upload.url+token / auto_upload / delete_after_upload）相互独立， 依据 cli.ts:505-511 的注释与实现
  - LRU 保留 100 个会话、优先删已上传（collector.ts:180-198）
  - 如实写边界：影子调用用量此前只在 SessionEnd 同步一次、崩溃即丢，现已由 setSideStatsObserver 每次落定即同步（collector.ts:186-191, 1740-1750）； 以及无实时 dashboard、平台侧口径不在本页范围
- **website** · 记 T-5.6 验收 —— L3 extend 6 篇已写实并上线 `8ac0d1a0`
  - 项目级 Skill 在 -p 下默认加载不到（cli.ts:1328），是设计而非 bug， 但对 CI 使用者是硬卡点，文档已按"先给现象再给根因"写。
  - --json-schema 校验通过的载荷不进 stdout（app.ts:4467）， 故文档不把它当"取结构化结果的通道"，另给两条可用替代。
- **website** · 阶段 5 内容撰写 T-5.7 —— P6 L5 team 4 篇写实 `77bf11f9`
  - website/team/ 下 4 个占位页改成正文（defaults/migrate/policy/quota）。
  - 这批内容是本次会话之前已在工作区完成、尚未提交的部分，此处单独成一次提交
  - 与 T-5.6 分开记账，避免两个批次的改动混在同一个 commit 里。
  - observability.md 仍是占位页（T-5.7 剩余项）。
- **website** · 阶段 5 内容撰写 T-5.6 —— P5 L3 extend 其余 6 篇写实 `b8633a23`
  - index：五条扩展路径选择表。核心是「谁能拦住模型」——只有 Hook 能阻断， 其余四条都是提示词/工具，模型可以不听；以及未触发时的上下文开销对比 （Skill 摘要实测 0.5K tok，Hook/子代理/MCP 为 0，CLAUDE.md 全文常驻）。
  - skills：8 个内置 Skill 的 description 逐条从 SKILL.md 取；实测坐实了 「项目级 Skill 在 -p 下默认加载不到」——同一个 Skill 同一条命令， 未开 trust_project_extensions 时模型答「这个 Skill 目前不存在」， 开了之后正确输出。根因在 cli.ts:1328（print 模式 onUntrusted 直接返回 […
  - mcp：mcp add/list/get/remove 四个子命令在隔离 SID_CONFIG_DIR 下实跑； 写清「接上了但模型说没有 mcp 工具」不是故障而是默认延迟加载， 实测走 tool_search 即拿到 mcp__fetch-demo__echo；补 toolSearchKeepLoaded 豁免写法。
  - lsp：10 个操作 + 内置 10 种语言目录（逐条对 builtin-servers.ts 核）； hover/findReferences/documentSymbol/workspaceSymbol/codeAction 五个操作 与诊断注入的原始输出均由直连 LSPTool 取得；两类「未找到服务器」报错 （内置未装 .css / 长尾 .rb）从真实输出复制。
  - headless：三种输出格式的实测形态，含 stream-json 的 result 消息 （total_cost_usd 只在这条里有）。两个会让脚本静默出错的坑写在显眼处： ① debug 开着时日志走 stdout 直接撑爆 jq，且 app.json 里 debug 可能被改成 true； ② --json-schema 校验通过的载荷不进 stdout（app.ts:4467 只取最…
  - plugins：三层架构与 plugin.json 字段对 validate.ts 核；--plugin-dir 实测 加载（日志 1 命令 + 1 Skill）；点破「问模型有没有某斜杠命令」问不出来—— 斜杠命令不进模型上下文，实测模型翻遍目录答「没有」而命令加载得好好的。 Bridge 补足权限转发/单轮串行/UUID 去重三个语义，并标注它等于交出执行权。
- **website** · 记 T-5.5 验收 —— ref/glossary 术语表已写实并上线 `1b3ac1dc`
  - §10 阶段 5 的 T-5.5 划掉并补取证清单（10 条术语的源码/实跑出处）
  - §6.4 的 P4 行去掉"glossary 仍属 T-5.5 待写"这句已过期的注解
  - last_verified 推到 2026-07-28
- **website** · 阶段 5 内容撰写 T-5.5 —— ref/glossary 术语表写实（L4 唯一人工页） `5b410228`
  - effort 档位：五档 low/medium/high/xhigh/max + auto 取自 `EFFORT_LEVELS`（llm/effort.ts:29）；「标度与底层模型无关、不支持的 档位会明确告知实际下发档」取自 effort 命令的钳制提示逻辑。
  - 权限模式：八档与状态栏显示名逐条对照 `getModeName()`（permission/mode.ts:59）。
  - 上下文窗口：「按模型算、8K–1M」取自 model-registry 的 contextWindow 实测区间。
  - 会话 id 格式：`YYYYMMDD-HHMMSS-<8位hex>` 取自 session/id.ts，示例用真实落盘会话。
  - 轨迹：三个文件（session.traj / events.jsonl / raw.jsonl）以真实轨迹目录核对。
  - microcompact：可丢弃 vs 不可复现工具的分类取自 compact/microcompact.ts 白名单。
  - 记忆：「索引进上下文 + 按需 Read」取自 memory/prompt.ts 提示词原文； 按 git 顶层目录分桶取自 memory/paths.ts:53。
  - 回退点 30 个上限取自 `MAX_REWIND_POINTS`；checkpoint 粒度取自 checkpoint/manager.ts。
- **website** · 阶段 5 内容撰写 T-5.3/T-5.4 —— P2 差异化 4 篇 + P3 L2 其余 7 篇写实 `7b52563d`
  - T-5.3（P2）：permissions / cost / hooks / subagents
  - T-5.4（P3）：interactive / sessions / context / plan-mode / memory / worktree / troubleshooting
  - 更新 llms.txt 与设计方案追踪表
- **website** · 阶段 5 内容撰写 T-5.1/T-5.2 —— 落地页数字复核 + L1 入门 5 篇写实 `b0ecd226`
  - start/install：三类失败（PATH / 架构 / 权限）报错文本取自 install-template.sh 真实分支；按脚本实际行为写清"只追加不覆盖 / 留 2 个旧版本 / 已有配置不动 / sha256 失败在切软链前中止"；点破 sc 别名等价 --dangerously-skip-permissions。
  - start/configure：/v1 两族相反规则实测两个方向 —— anthropic 多写 /v1 → 真 404 "Invalid URL (POST /v1/v1/messages)"； openai 漏写 /v1 → 不报 404 而是 HTTP 200 的 HTML 错误页（被非 SSE 检测拦下）。 两段报错均从真实输出复制。给出"配完先跑 auth status"而非靠能否启动…
  - start/first-task：真跑了一个完整任务（故意写错的 add 函数 + node 断言测试）， 工具序列、模型结论、会话摘要（$0.0813 / 缓存 55% / 6 成功 0 失败）全是实测原文； y/n/a 语义与"危险操作标红且默认聚焦拒绝"取自 PermissionPrompt.tsx。
  - start/next：四条路径 + 参考页速查表，链接经死链检测验证。

### 其他
- **website** · 同步 llms.txt —— observability 页 description 变更 `0f9390f2`
  - docs-gen-reference 的产物，随 team/observability.md 的 frontmatter description
  - 从占位文案改成正文文案而自动更新。非手改。
- **git,docs** · 统一 commit 归因邮箱至 sid-code.cc 并补设计方案阶段 3 验收 `4583d1cc`
  - 归因邮箱 dev→cc：config 默认值、git-attribution 常量、两处文档引用同步
  - 设计方案文档标记阶段 3（参考文档生成器）T-3.1–T-3.12 全部完成， 含实测数字更正、4 个实现期真缺陷、T-3.6b 双防线独立性结论

## v0.1.591 (2026-07-17)

### 新功能
- **session** · 会话浏览器按终端高度动态分页，优化元信息展示与环绕导航 `0cf5f7a7`
  - 动态分页：用 useStdout 获取终端行数，实时计算每页会话数， 防止选择器高于终端导致滚动条 bug
  - 环绕式导航：新增 useWrapSelection hook，↑↓ 键在列表首尾 间环绕（取模），滚动窗口跟随目标行
  - 元信息行：时间显示改为"北京时间 (相对时间)" 格式，新增 模型短名展示（去掉 provider 前缀与冗余后缀）
  - 溢出指示：▲ 修正为"还有更新的会话"，▼ 修正为"还有更早的会话"
  - SessionInfo 新增 model 字段，从会话文件 data.model 读取
- **session** · 会话浏览器添加 Ctrl+P「仅当前项目」筛选 `ea4e1519`
  - 从 session_start.cwd 解析会话工作目录，存入 SessionData.cwd
  - 选择器顶栏显示当前范围（全部/仅当前项目）与会话总数
  - Footer 提示 Ctrl+P 切换项目范围
  - getAllSessionFiles 优先使用 session_start.cwd，退回 directories[0]
- **cli** · -r/--resume 可选值语义——无值开交互选择器，带值按 ID/搜索词恢复 `a9dfaa76`
  - 手动解析 -r 可选值（parseArgs 不支持 [value]），三态：缺省/无值开选择器/带值恢复
  - 未精确命中时把值作为搜索词进选择器（对齐 CC）
  - 会话浏览器 UI 重构为 CC 风格两行布局 + 搜索框 + 底部功能提示
  - 新增 extractResumeArg 单测
- **ui** · diff 渲染折叠——新建文件/大改动默认折叠，ctrl+o 阶梯展开 `9e774ac5`
  - DiffRenderer 新增 maxLines prop + foldRenderPlan 纯函数，同步裁剪， 确保 Static 一次成型不污染 scrollback
  - ToolResultDisplay 设 DIFF_COLLAPSE_MAX_LINES=16 折叠档，isDiff 分支 接上折叠、与普通文本共用 expandLevel 阶梯展开
  - 新建文件在 colorizeCode 前按 maxLines 保留头部，末尾追加统一折叠 footer
  - 新增 foldRenderPlan 单测 + 折叠渲染快照测试
- **session** · 会话状态快照持久化——todo/假设/目标/权限跨 resume 恢复 `a4046cb5`
  - 新增 persistTodoState/persistHypothesisLedger/persistGoalState 持久化方法， 每轮 done 后落盘到 JSONL metadata，与 persistUsageStats 对称
  - restoreSession 回灌：todo 清单 → TodoPanel 首屏展示、假设登记表 → 交付门禁 不失据、权限模式(安全档位) → 跨会话恢复、agent 设置恢复
  - /clear 边界加固：置空后立即落归零快照覆盖旧数据，防止恢复端幽灵清单/统计/ 目标/假设复活；goal 用 __CLEARED__ 哨兵标记
  - checkpointSessionId 引入：resume 时 checkpoint 跟随逻辑会话 id，使 /undo 恢复 后能回滚到 resume 之前的编辑
  - 首屏 goalDisplay 对称推送：resume 带活跃目标时 Footer 不再空白
  - 权限模式安全红线：dangerously-skip-permissions/always-allow 绝不跨会话恢复
  - 新增 hypothesis-ledger/todo-write 的 serialize/hydrate 方法
  - 新增 tests/session/hypothesis-persistence.test.ts 与 todo-persistence.test.ts

### 修复
- 多项 P0/P1 安全与稳定性修复 `21b66d3a`
  - P0-1: 会话按项目分目录，cwd 一致性告警（纵深防御跨项目恢复）
  - P0-2: permissionMode 不做隐式跨会话恢复（对齐 CC 安全红线）
  - P1-1: todo_write 加入子代理禁用列表（防止并发写污染主会话 todo）
  - P1-2: checkpoint 写时双层 eviction + 跨会话 LRU 真删总量清理
- **ink** · 抑制短命 Ink 实例的终端探查，防止回复碎片漏入输入框 `729ef874`
  - 新增 suppressTerminalProbe 机制：短命实例跳过探查，主 TUI 正常探查
  - 新增 responseFragment 类型：丢弃拆分/截断的终端回复，不误作按键
  - 处理 Lone ST（\x1b\\）等尾部碎片，CSI-private/CSI-secondary 前缀
- **session** · resume 后累计用量统计回灌——Footer 不再从零值起 `04e96264`
  - 新增 UsageSnapshot 接口与序列化/反序列化逻辑（state.ts）
  - resume 路径从 JSONL metadata 恢复累计用量（app.ts）
  - 每轮对话结束落盘用量快照到会话 JSONL（app.ts）
  - 新增 usage-stats-persistence 单元测试

### 文档
- 归档 bugfixes/done 目录下散落文档到对应主题目录 `639a0209`
  - 新建"系统提示词冻结快照"主题目录收纳 git 快照冻结相关分析；
  - 其余散落文档按主题归入 循环检测与长任务/中断与错误处理/
  - Harness与模型评估/调度与状态持久化/Token与计费统计。

### 其他
- doc: 添加迁移工具调研文档 `9501149b`
- **ink** · 新增终端响应碎片漏入回归测试 `3a509760`
  - 新增 tests/ink/terminal-response-fragment.test.ts 对短命 Ink 实例终端探查回复碎片漏入输入框的 bug 做回归覆盖
  - 补充 docs/bugfixes/todo/ 持久化恢复对齐 CC 改造 TODO 执行清单
- **ui** · 移除 CodeColorizer MaxSizedBox 死代码，新增持久化审计文档 `3e5dff11`
  - 移除 availableHeight 参数及 MaxSizedBox 折叠分支：全仓无人传参， 且与 Static 安全铁律冲突（异步测高先把内容落 scrollback 再折叠， 污染回滚区且不可擦除）
  - 新增两份审计文档：状态持久化与恢复对称性分析、对标 Claude Code 差距分析与核心哲学

## v0.1.590 (2026-07-16)

### 新功能
- **startup** · update 后全端点定价强制刷新 + API Key 占位符识别 `0aafe2bc`
  - 新增 refreshGatewayPricingOnStartup，通过版本水位线（lastPricingSyncVersion） 判断刚 update 后 force 全端点强制刷新定价缓存，忽略 24h TTL
  - 新增 isMissingApiKey 函数，识别 __YOUR_API_KEY__ 占位符为未配置， 新用户首次安装时友好引导而非静默撞 401
  - 新增测试：gateway-pricing 启动刷新策略 5 个用例 + config 占位符识别 3 个用例
  - 文档：重命名可观测性指标体系目录 + 新增网关定价审计报告
- **llm** · 网关定价多端点分桶、按次计费展示、采集可观测性 `5005ffb7`
  - 缓存结构从单端点扁平改为按归一化端点分桶（v2），旧版 v1 自动迁移
  - lookupGatewayPricing 端点感知：先查精确桶，再跨桶兜底
  - syncGatewayPricing 只更新本端点桶，不再互相覆盖
  - /model pricing 展示按次计费模型（quotaType=1）
  - 新增观察者模式 + GatewayPricingSync trace 事件
  - 测试环境隔离：避免读到本机真实网关缓存导致断言不稳定
- **llm** · 网关定价自动采集与端点归一化计费 `164224a1`
  - 新增 endpoint-key.ts：normalizeBaseURL 端点 URL 归一化， 收敛等价写法避免计费复合键漏配
  - 新增 gateway-pricing.ts：从 new-api 网关 /api/pricing 接口 自动采集价格，含本地缓存与容错回退
  - 新增 /model pricing 命令：查看模型定价表含来源标注 （用户手写/网关采集/内置注册表/兜底估算）
  - 新增 /model discover --pricing：手动触发网关价格采集
  - resolvePricing 优先级链：用户手写 > 网关采集 > 注册表 > 兜底
  - 配置与计费链路配套调整
- **trace** · 补全会话轨迹可观测性指标（缺口分析一至六类） `5a5ab098`
  - 一类·TTFB：anthropic 路径补齐 headers_received/HttpConnected 事件，与 openai 同口径
  - 二类·reasoning token：新增 reasoningTokens 字段（Usage/Hook/Trace），openai extract 函数，loop 透传
  - 三类·输出/输入比：SessionEnd 派生 output_input_ratio
  - 四类·缓存命中率：SessionEnd 派生 session_cache_hit_rate
  - 五类·上下文趋势：逐轮 context_usage_ratio 序列 + 峰值，落盘 used/window/ratio
  - 六类·可靠性：弃流数/重试次数聚合，stream_completed 纯生成耗时 → 吞吐 tokens/sec
  - trace builder 新增 10+ 派生/采集类指标字段，collector 新增对应采集逻辑
  - 测试：collector 新增 9 个用例覆盖新指标采集与派生
- **ui** · bash 长命令实时进度展示 + RetryStatus 倒计时定格修复 `cf64fc5e`
  - bash.ts: pump 循环替代 Response().text() 一次性 await，120ms 节流 emit 尾部 5 行
  - app.ts: liveToolProgress 侧信道 Map 注入 executing 态 progressMessage； refreshLiveProgressInPlace 轻量路径只换 live tool_group 引用，不重建 committed； CM3 补清请求失败重试成功后 retryStatus 残留
  - ToolMessage.tsx: shell 实时输出以独立多行块展示在命令行下方
  - App.tsx: committed 数组引用稳定化，防止轻量刷新触发 Static 全量重渲
  - history-adapter.ts: estimateToolRows 计入进度行数；countLiveItemTools 修正 hiddenToolCount 计工具数而非行数（防「1 个工具显示成 10 个」）
  - test: 更新断言 + 新增 shell 多行实时输出折叠测试

### 修复
- **agent/query/llm/plan** · 归因脱节修复——按实际证据判定而非硬编码代理条件 `941035f1`
  - llm/errors: 删除裸 "not found" 子串匹配，避免把 5xx 可重试错误误判为终端 model_not_found
  - plan/recovery: 新增 classifyRecoveryTrigger，按错误消息内容判定触发类型，不再按工具名硬编码
  - query/tool-executor: 新增 hookActuallyModifiedInput，仅在 hook 真的改参时才注入提示
  - query/empty-param: 不再臆造"大上下文退化"根因，空参数时只陈述事实

### 其他
- doc：AI Agent 核心可观测性指标体系 & sid-code 覆盖缺口分析 `aec12b6d`

## v0.1.589 (2026-07-15)

### 新功能
- **plan** · Plan 审批对话框升级为多选项列表，支持取消和附意见拒绝 `efcea8c4`
  - 审批回调类型从二值字面量改为 string，支持 cancel / reject:feedback 等扩展决策
  - 新增 cancel 分支：退出 Plan Mode 并记录日志
  - 新增 reject 带 feedback 解析：注入用户修改意见到 LLM 上下文
  - 消息统一用 <system-reminder> 包裹，阻止 TUI 意外渲染
  - PlanApprovalDialog 从 Y/N 升级为选择列表：批准 / 拒绝附意见 / 取消 / 其他…
  - 支持键盘导航（↑↓ 移动、Enter 选择、y/n 快捷键、Esc 取消）和文本输入态
- **tool** · 延迟加载工具「schema 未发送」补救机制 + ask_user_question 首轮可见 `a0bfdafc`
  - 新增 buildSchemaNotSentHint：参数校验失败时判断是否因 schema 未发送， 追加"先 tool_search 激活"引导，避免模型盲调反复微调参数
  - registry 新增 toolSearchEnabled 标志，由 queryLoop 首轮回填， 供 tool-executor 做门控判断
  - executeSingleTool 参数校验失败时调用 buildSchemaNotSentHint 追加补救
  - ask_user_question 改为 alwaysLoad（首轮带完整 schema）， 作为 /commit 等内置流程的刚需工具，避免盲调翻车

### 修复
- **ui** · 调整审批对话框选项列表间距，修复图标拥挤 `d39488a6`
  - 将选项图标区域宽度从 4→5，并在指针图标与单选图标之间
  - 补充空格，改善视觉间距。
- **ui** · 统一快捷键提示显示逻辑，Composer 不再独立判断 `dd53fb6d`
  - DialogSwitch 透传 hideShortcutsHint={true}，不再依赖 isEmpty 动态判断是否显示 Composer 的快捷键提示
  - 快捷键提示统一由顶部 AppHeader/EmptyLogo 控制，避免重复
- **ui** · 修复幽灵行残留 — 终端任务驱逐兜底 + 动态区活项视口封顶 `6382ebf8`
  - queryLoop finally 收尾驱逐：主循环终止后不再依赖下一轮循环触发驱逐
  - evictTerminalTasks 增加 force 参数：支持忽略缓冲期强制驱逐
  - App.tsx 独立 1s 定时器驱逐兜底：对标 cc CoordinatorAgentStatus，不依赖主循环
  - 动态区 live 活项视口封顶：按视口预算尾部截断，根治并行多工具时 executing 行溢出 scrollback
  - MainScreenLayout 隐藏工具摘要：折叠超预算活项时显示"… +N 个工具执行中"

### 重构
- **ui** · 提取 isEnter 变量消除 key.name 重复比较 `2df8348c`
  - 将 3 处 key.name === "return" 提取为 isEnter 常量，
  - 集中处理回车键判断，减少重复代码。
- **plan** · Plan 文件命名从词汇 slug 改为语义命名（时间戳 + 主题 + 项目子目录） `8176107c`
  - 新增 formatPlanTime / resolvePlanProject / sanitizeProjectName / sanitizePlanTopic 函数
  - Plan 路径改为 plans/{项目名}/{YYYYMMDD-HHmm}-{主题}.md 结构
  - enter-plan-mode 工具增加 topic 参数，支持中文主题命名
  - 更新测试覆盖新命名逻辑
- **tool** · ask_user_question 注册策略注释完善与代码顺序整理 `6ab2d4cf`

### 其他
- doc: 更新参考文档内容 `b6edc1ff`

## v0.1.588 (2026-07-14)

### 新功能
- 可观测性修复 — TTFT 数据源校准 + 缓存脱落归因 + UX 文案 + 指标体系文档 `c013255e`
  - P0-1（排查报告 Bug A）：TTFT 从被污染的 AfterModelRaw.ttft_ms
  - 切换到纯净的 StreamPhase("first_content").ttft_ms，
  - 消除重试/渲染延迟双重污染；
  - 新增 gen_p50/p95/p99 生成耗时维度，让"慢在生成"显式可见；
  - avgLatencyMs 渲染标注"整轮耗时"，避免与首字节混淆（Bug B）
  - P1-2：缓存命中下降归因增加 precededByRetry 字段，前缀未变时
  - 按"是否紧跟重试"分离两类脱落：重试触发 vs 纯服务端波动
  - P2：todo gate 中性措辞优化；openai 协议缓存命中率上限提示（60-70% 正常）
- 码点安全截断 + daemon 防命令注入 + bash 引号诊断 `450bec62`
  - feat(context): 码点安全的 truncateToolOutput，避免切断 emoji/CJK 扩展区
  - feat(bash): 新增引号畸形诊断，命令失败时附 heredoc 写法提示
  - fix(daemon): worker/workspace 改用 execFileSync，消除命令注入风险
  - test: 补充 sliceByCodePoint 和 quoting-diagnostics 单测
  - docs: 归档 git-status 快照冻结死循环相关根因分析
- git-status 快照冻结死循环多方向修复 `a685d075`
  - 方向 0：新增 --self-check 编译产物自检（bootstrap + self-check 模块），
  - 在 make build/rebuild 和 release.sh 末尾自动验证关键修复已内联。
  - 方向 2/4/6：新增 repeated-readonly-guard 模块，检测连续相同只读
  - 探查命令（git status/diff/log 等）+ 输出稳定不变，先注入携带实时
  - git 状态的收敛提醒，注满上限仍空转则强制收尾。
  - 方向 3：非只读命令（git add/commit 等）成功执行后失效 git 状态
  - 缓存，确保下一次 generateGitStatusAttachment 拿到最新状态。
  - 补充：loop-detection 默认关闭的决策依据从"对齐 CC"升级为"实测
- 调整文档位置 `0d882d01`
- 统一移动测试文件到test目录下 `0bce4df4`
- 调整doc目录结构 `f57dc867`
- 调整doc目录结构 `77ccf9af`

### 其他
- doc：更新文档完成状态 `8986c99c`

## v0.1.587 (2026-07-14)

### 新功能
- MCP instructions 增量注入 + 工具延迟加载豁免 + 缓存冷热判定修复 + paramText 参数检索 + 编辑失败追踪 + cache_creation 成本补落 `a985fd37`
- worktree 创建期告警 + LSP codeAction 支持 + 上下文压力节流 + 工具延迟加载 + DYNAMIC_BOUNDARY 保真 `2eea82dd`
  - worktree advisories：创建期检测依赖一致性（lockfile hash 比对）和 DB migration 冲突，回显给用户 / 子代理日志落盘，异常不阻断
  - LSP CodeAction：新增 LSPCodeAction 类型、diagnostic-registry latest 只读快照、 lsp-formatters 格式化、server-instance 能力声明、lsp.ts codeAction 操作
  - 上下文压力 cadence 节流：按档位（warn/urgent）节流注入，升档强注入、同档 低频重述（每 8 轮），避免幻影用户消息（对话重播/截断幻觉根因）
  - toolSearch 默认开启：对标 CC 默认行为，15 个长尾工具首轮不注入省 token
  - DYNAMIC_BOUNDARY 保真：复用 cache-strategy.ts 单一事实源，截断路径不丢边界 标记，防止缓存分区失效
  - 文档：删除可选优化/README.md，更新 context-engineering-next-optimizations.md
- 通知结构化快照重构 + 内部消息来源分类拆分 + 文档更新 `e902b904`
  - 通知机制：新增 StructuredNotification 与 enqueueTaskNotification 入口，
  - TUI 结构化优先渲染，根治子代理结论含 XML 字面量破坏解析问题。
  - 内部消息：INTERNAL_ORIGINS/INTERNAL_RENDER_ORIGINS 分类拆分，
  - 修正 hasInternalOrigin 防止 task-notification 被整条隐藏误吞。
  - 系统提示：补充按需拉取完整结论说明。
  - 文档：团队记忆同步方案二次评审修正与落地记录。
- 子代理增强——LSP 诊断注入、tool_choice 透传、masking 隔离 `e6dd3a82`
  - 具备 edit/write 工具的子代理在每轮开始前收集已编辑文件的 LSP 诊断
  - 注入为 user 消息让子代理感知自己引入的类型/语法错误
  - 作用域限定为本子代理编辑过的文件，并发子代理互不偷取
  - 为每个子代理派生独立 sessionId，避免并发子代理临时文件覆盖
  - 自定义子代理以 task.type 标识，普通子代理以 taskId 标识
  - 发给 LLM 的消息改用 getCleanedMessages()（大输出剪枝 + masking）
  - 此前裸发 getMessages() 无任何工具输出剪枝，input token 线性膨胀
  - auto-compact 设 toolChoice:"none" 禁止摘要时调工具，但此前被静默丢弃
- 流式工具执行器 + 工具编排 + 侧链持久化 + 内部字段剥离 `efab10cc`
  - GAP-01 流式工具执行器（模型输出与工具执行并行）
  - GAP-08 防御性内部字段剥离（纵深防模型伪造）
  - GAP-10 工具编排层独立可测（分区调度算法提取）
  - P2-10 子代理 sidechain 持久化（防中断丢失）
  - 循环检测与终止策略-差距分析标记为已完成
- 不确定-1 会话硬顶修复 + 必删-4 语言约束 + system-prompt 优化 + StatsDialog 单价 + 防线触发率脚本 `4ea9855d`
  - 不确定-1：app.ts 新增 sessionTimedOut 判断防止静默吞掉；maxSessionDurationMs 默认 60min（单轮 2 倍）
  - 必删-4：语言约束改为 reasoningLanguageDrift 能力标志驱动
  - system-prompt：新增"批量化搜索"和"避免宽 ASCII 表格"规则
  - StatsDialog：新增 pricing prop 显示每百万 token 单价
  - 新增 scripts/defense-trigger-rate.ts 防线触发率度量脚本
- 审计报告落地修复与功能增强（不确定-1/2/3/4 + G13/G19/G22） `86872426`
  - 不确定-1：会话级硬顶纳入 network-profile 统一配置，headless/SDK 路径补齐
  - 不确定-2/3：单次调用重试硬顶 maxRetriesPerCall 防退避风暴
  - 不确定-4：baseURL 优先级链明确化
  - G13：子代理类型透传，save_memory agent scope 定位到子代理类型记忆目录
  - G19：think 工具注册（新泛型 Tool → LegacyTool 桥接）
  - G22：/compact 部分压缩（partial-compact）接线
  - trace/digest：新增 SubAgentSpan/SubAgentSummary 数据结构
  - 配套测试与注释规范
- G19 工具注册现代化——bridge 适配器（新泛型 Tool → LegacyTool 桥接） `9b04cd67`
  - src/tool/bridge.ts: 新增 toLegacyTool() 桥接适配器，buildTool() 构建的新泛型 Tool 经此适配后可直接 registry.register()
  - src/tool/types.ts: LegacyTool 注释中标注 G19 迁移路径，新工具直接用 buildTool() + bridge 无需等全量迁移
  - tests/tool/registry-modernization.test.ts: 完整闭环测试（buildTool → toLegacyTool → register → definitions）
  - src/query/compact/g16-g26-decision.ts: G16/G26 决策记录文档
- G10 autoDream 接线与配置（app.ts 集成 + settings 配置项 + 单元测试） `8690e9ea`
  - src/app.ts: autoDream 初始化接线，复用后台记忆提取子系统的 getMainContext + memoryDir
  - src/config/config.ts: 新增 autoDream 配置项及 auto_dream/autoDream 双键映射
  - tests/memory/dream.test.ts: 三级 gate 判定 + 状态持久化 + recordSession 计数测试
- 多项功能增强（G6/G10/G21/G23/G25） `e7819d81`
  - G6: Read 工具支持多模态富媒体（图片/PDF/Notebook），含图片 mediaBlock 返回、Notebook 结构化渲染、PDF document 块
  - G10: 新增 autoDream 自主记忆巩固系统，三级 gate 触发（时间/会话/记忆量），fire-and-forget 后台 agent 跑 consolidate → prune
  - G21: Glob/Ls 工具接入 deny 规则过滤，被 deny 的敏感文件不再出现在列举结果中
  - G23: Shell 模式退出提示渐进衰减，复用 app-config 通用 hint 计数 API（满 3 次收敛）
  - G25: 命令上下文注入 permissionChecker 实例，修复 /allow /deny /add-dir /permissions 运行时永远为 null 的漏传
  - 新增 partial-compact 查询压缩模块
  - edit/write 工具增强
  - 对照 claude-code 多模态能力分析文档落地
- **command,llm,permission** · /add-dir 命令 + G6 富媒体序列化 + G21 deny 路径隐藏 `13d45349`
  - 新增 /add-dir 命令：运行时将目录加入当前会话可访问白名单，支持 --list / --remove
  - G6: 抽取 serializeToolResultBlock 函数，支持图片/文档多部件 content 收敛流式/非流式两条序列化路径，避免逻辑漂移
  - G21: 新增 isPathHidden 方法，让 deny 规则对 glob/ls 列举结果生效 glob 工具注入 isPathHidden 回调，被拒文件从列表里隐藏（对标 claude-code）
- 多项功能增强（G6/G11/G12/G17/G20） `a2d95058`
  - G6: Read 工具支持图片/Notebook/PDF 读取
  - G11: 新增 NotebookEdit 工具（cell 级 .ipynb 编辑）
  - G12: 系统提示重建时刷新输出风格
  - G17: PTL 截头重试机制（避免 prompt 过长导致摘要失败）
  - G20: sibling-abort 并发工具中断联动
  - 新增 diff/doctor 命令
  - 修复 sed -i 在 cd 场景下的路径解析
  - 补充 sed 误报边界测试和 notebook-edit 测试
- **mcp,config** · G3 Elicitation 接线与 G12 输出风格可插拔 `ba7420c4`
  - G3：MCP 服务端请求路由（elicitation/create），SSE 传输层双向通信， CLI 交互处理兜底，capabilities 声明与 handler 注册
  - G12：outputStyle 配置注入系统提示词静态缓存区，用户可插拔输出风格
  - 测试：更新 git-status 断言适配新 snapshot 格式，新增防死锁哨兵
- 多项安全增强与功能补全（G2/G3/G5/G8/G9/G10/G11/G12/G13） `3a637438`
  - G13: 新增 agent-store 记忆系统，按子代理类型注入历史积累经验
  - G9: 补齐 bash-security 5 个校验器（畸形 token 注入/jq 逃逸/元字符/ 反斜杠转义空格/危险变量与不完整命令）
  - G10/G11/G12: 新增文件写入/编辑前安全检测，编辑工具接管
  - G8: 兼容 OpenAI 系 rate-limit header，补充限流状态提取
  - G2: ToolClassifier 接线，auto 权限模式回归生效
  - G3: MCP 传输层支持 Elicitation 服务器发起请求
  - G5: 长跑工具中间进度路由到状态栏
  - 对标 claude-code 的 git status 附件格式（仲裁锚点 + 结构化标签）

### 修复
- **llm** · 修复错误分类数字子串误判 + OpenAI strict schema 兼容性 `ccec09df`
  - errors.ts: classifyError/is401Error/is408Error/is409Error 改用数字边界匹配， 避免网关 request id 中巧合内嵌的状态码数字子串（如 "404"）误判为终端错误； 拿到结构化 HTTP status 时优先使用，不再回退文本扫描（2026-07-13 生产事故复盘）
  - openai-responses-request.ts: strict:true 工具的 schema 补全 required + optional 字段转 nullable，满足 OpenAI Structured Outputs 硬性要求； 对 z.any()/z.unknown() 等无约束节点自动检测并降级为非 strict（2026-07-14 复测发现）
  - install-template.sh: PATH 前置改为幂等判断，避免 update 时重复拱到最前
  - 新增/补充测试覆盖上述回归场景
- **task-notification** · 多通知聚合为一条消息，防止 _meta 浅合并覆盖前面的通知 `f6c29696`
  - 将 query/loop.ts 中逐条 addMessage 改为一次性聚合注入，_meta.notif 收集为
  - 数组；history-adapter 兼容单对象/数组两种形态，确保 TUI 渲染不丢通知。
  - 新增回归测试覆盖多通知数组与空数组回退场景。

### 其他
- doc：更新文档 `e487c2bd`
- doc：更新代办事项状态 `d13b186f`
- doc：更新文档 `9aaba54b`

## v0.1.586 (2026-07-10)

### 新功能
- goal 轮次动态调整与显示去歧义，及多项修复 `2abd47e0`
  - 新增 /goal turns <n> 子命令：运行时调整最大轮次上限（1~1000）
  - 默认 maxTurns 50→150：长任务模式留足空间，用户可随时 ESC 介入
  - 状态栏 goal 列去歧义：移除易误读的百分比，改为"目标 N/M 轮"中文标签
  - 全链路去彩色 emoji：goal 改用单色几何字形（◎/⏸/⚠/✔），与 figures.ts 一致
  - 活项分流机制：含 executing 工具的 tool_group 从 Static 移入动态区，根治 scrollback 幽灵行残留
  - model-registry 路由前缀白名单：剥离 ali-/volc-/siliconflow- 等网关前缀后重试匹配
  - openai idle 超时定时器泄漏修复：cancelTimeoutId 此前无句柄，每秒泄漏数百个
  - trace 内存优化：builder 新增 new_messages 回退，collector 剥离旧 raw_messages

### 性能
- 新增 TUI CPU/内存性能诊断与验证脚本 `6a1815c8`
  - perf-probe.sh          PTY 下采样真实 TUI 的 CPU%/RSS/线程
  - perf-tui-drive.exp     expect 驱动 TUI 流式输出
  - perf-md-bench.ts       块闭合粒度 O(N²) markdown 重解析基准
  - perf-stream-token.ts   逐 token 流式渲染成本增长基准
  - perf-lex-vs-format.ts  拆分 lex vs format 成本（证实瓶颈在 marked.lexer）
  - traj-bench.ts          rebuildTraj 每轮全量重写的写放大基准
  - perf-verify-stream.ts  验证流式增量渲染修复（120块 658ms→7ms）
  - perf-verify-timer.ts   确定性验证 SSE 定时器泄漏修复（500→0）

### 其他
- doc：更新文档 `9c225cd1`
- doc：更新文档 `6d5b0589`

## v0.1.585 (2026-07-10)

### 修复
- **install** · 更新提示优化——抑制无谓 source 提示 + 补全 HTML 更新日志链接 `b27e6bb0`
  - source 提示改为条件触发：仅当刚写入 PATH 块且当前 shell 的 PATH 里还没有 ~/.local/bin 时才提示。sid-code update 场景下命令本就从 PATH 找到才跑起来， 当前 shell 已含 bin 目录、二进制原地换掉即刻生效，旧逻辑无脑提示纯属噪声
  - 完成提示补上 CHANGELOG.html 网页链接（可直接点开，放在文本链接之前作为推荐）

### 其他
- doc：更新文档 `abe5613a`

## v0.1.584 (2026-07-10)

### 新功能
- **changelog** · 富化 changelog 生成——commit body 细节 + 科技风 HTML 页面 `6ad242b9`
  - generate-changelog.ts 重写为「git 是唯一事实源，每次从 git 完整重建」， 产出 CHANGELOG.md（文本事实源）+ CHANGELOG.html（可直接点开的网页）两份
  - 抓取 commit body 细节：subject 下挂 body 里的 bullet/编号列表作为子条目， 让用户看得懂每个版本到底改了什么，不再只是一句标题
  - 过滤机器噪声：bump 记账 / Merge / eval dashboard 刷盘 / Co-Authored-By 尾注
  - HTML 页面：分组徽章 + commit 细节可折叠 + 实时搜索过滤 + 侧栏版本导航， commit hash 链到 gitlab commit 页（从 origin remote 推导）
  - HTML 采用明亮浅色主题（浅灰背景 + 白卡片 + 高对比文字），科技感但清晰易读
  - release.sh 接线：MD + HTML 一并纳入发布产物、上传服务器顶层，完成提示给出双链接
  - CLAUDE.md 发布铁律同步：bump 提交步骤补上 CHANGELOG.html
- **command** · 实现 /export 斜杠命令——导出对话到剪贴板或文件 `64926652`
  - 新增 /export 命令（export/index.ts），支持 clipboard/file 目标与 md/json/both 格式
  - 新增 ExportDialog 对话框组件，提供目标/格式选择 UI
  - 在 DialogSwitch 中注册 export 路由，App 层注入 exportConversation 回调
  - DialogType 联合类型新增 "export" 枚举值
  - 将约束型误伤机制排查清单从 todo 迁移到 done（已完成审计）
- **command** · 实现 /debug 斜杠命令——轨迹快照上传 + 诊断信息 + 剪贴板复制 `eeac94f4`
  - 上传当前轨迹快照到云端（best-effort，5s 超时）
  - 显示丰富诊断信息（session ID、模型、版本、时长、轮次、token、费用、工具统计）
  - 自动将 Session ID 复制到剪贴板
  - 新增 src/command/commands/debug/ 命令（新体系 UnifiedCommand）
  - TraceCollector 新增 uploadSnapshot() 公开方法（mid-session 上传）
  - TraceCollector 新增 getUploadUrl() 只读访问器
  - UploadManager 新增 getBaseUrl() getter
  - CommandContext/AppContext 接口新增可选 traceCollector 字段
- **command** · 实现 /debug 斜杠命令——轨迹快照上传 + 诊断信息 + 剪贴板复制 `23d61dc6`
  - 上传当前轨迹快照到云端（best-effort，5s 超时）
  - 显示丰富诊断信息（session ID、模型、版本、时长、轮次、token、费用、工具统计）
  - 自动将 Session ID 复制到剪贴板
  - 新增 src/command/commands/debug/ 命令（新体系 UnifiedCommand）
  - TraceCollector 新增 uploadSnapshot() 公开方法（mid-session 上传）
  - TraceCollector 新增 getUploadUrl() 只读访问器
  - UploadManager 新增 getBaseUrl() getter
  - CommandContext/AppContext 接口新增可选 traceCollector 字段
- **build** · ripgrep 二进制改为仓库本地化存储，消除构建期联网依赖 `ce2c2402`
  - vendor/rg-embed 是 git 追踪的 0 字节占位文件，但每次 make rebuild / release.sh 都会把当前平台真实 rg 二进制拷贝进去覆盖它，导致 git status 必然显示"已修改"，每次都要手动 git checkout 还原，容易忘记/误提交。
  - 4 平台预编译 rg 二进制（共约 18.5MB）只缓存在本机 vendor/rg-<platform> （.gitignore 排除、不入库），换机器/CI/vendor 被清理后就得重新联网下载 公司服务器，release.sh 交叉编译经常要等几十秒下载，且单点依赖服务器。
  - 新增仓库内规范路径 vendor/ripgrep/<version>/rg-<platform>，直接 git 提交 4 平台二进制（约 18.5MB，已用 sha256 核对与服务器一致）。
  - fetch-ripgrep.ts 改为两级查找：优先复用仓库内已提交文件（全程不联网）， 缺失时才回退联网下载，下载结果直接落到该规范路径，方便后续 git add。
  - 新增 --print-version，release.sh 用它读取版本号（避免两处硬编码漂移）。
  - release.sh 交叉编译循环改读新规范路径。
  - vendor/rg-embed 彻底移出 git 追踪（git rm --cached），改为纯本地构建产物； main() 失败兜底：--as-embed 联网也失败时写 0 字节占位，保证 bun build --compile 的固定 import 路径不因缺文件报错（延续原有降级语义）。
  - 连续两次 make rebuild，git status 不再显示 vendor/rg-embed 被修改。

### 修复
- **trace** · uploadSnapshot 未初始化时避免访问 this.metadata `78982a78`
  - 修复 TraceCollector.uploadSnapshot() 在未初始化时（this.metadata 为 undefined）
  - 直接访问 session_id 导致 TypeError 的问题。将初始化检查前置。
- **install** · 修复独立终端找不到 sid-code 命令——RC 文件检测与 PATH 注册逻辑重写 `03d7beec`
  - 区分 macOS login bash（.bash_profile）与 Linux interactive bash（.bashrc）
  - 不再依赖子 shell 运行时 PATH 判断，改为直接检查文件内容
  - 新增 safe_insert 函数，保留原文件权限
  - 新增 sc 快捷命令别名
  - 安全原则：只追加不覆盖、不创建不存在的文件、尊重已有 alias
- **trace** · 修复轨迹上传长期失效——CLI 参数浅合并覆盖 settings.json 的 upload 配置 `b683fc44`
  - cli.ts：仅当用户显式传了 --no-trace/--trace-upload-disabled/--trace-upload-url 等 flag 时才构造 trace 对象，否则返回 undefined 不覆盖文件配置。
  - config.ts loadNewFormatAsConfig：Object.assign 改为一层深合并（嵌套对象合并 而非整体替换），避免 app.json 的部分字段吞掉 settings.json 的完整配置。

### 重构
- review 修复——消除 as any、类型安全、代码位置调整 `b5de2692`
  - collector.ts: TraceUploaderInterface 新增可选 getBaseUrl() 方法， 消除 getUploadUrl 中的 as any 类型断言
  - debug.ts: catch (err: any) → catch (err: unknown) 防御非 Error 对象
  - uploader.ts: getBaseUrl() 从字段区移到方法区
  - adapter.ts: toAppContext 补全 traceCollector 桥接（对称性）
  - config.ts: 深合并注释补充说明仅一层深

## v0.1.583 (2026-07-09)

### 修复
- **test** · 修复 change-detector 测试写文件前的 fs.watch 武装时序竞态 `e976106e`
  - fs.watch(recursive) 依赖 FSEvents，watcher 建立后需要短暂时间才能就绪；
  - 测试原先 watchDirs() 后立即 writeFileSync，若 watcher 未就绪则本次变更
  - 事件被漏掉。全量测试负载下该竞态窗口命中率明显升高（Bun 1.3.11→1.3.14
  - 升级后自测连续复现）。修复：写文件前先 sleep 50ms 等 watcher 就绪。

### 其他
- **eval,hooks** · 下线 case 生成脚本 + 移除 pre-push 的 bun test 门禁 `75d6ab9f`
  - 删除 evals/scripts/import-trajectory-platform.ts / scripts/eval/new-case.ts / scripts/eval/select-real-tasks-30.ts 三个 case 生成/导入脚本（不再需要）
  - scanContamination/scanSecrets 抽到新增 scripts/eval/lib/security-scan.ts， 供 check-real-tasks-pollution.ts / scan-trajectory-secrets.ts 复用，避免连带 删除安全扫描能力
  - pre-push hook 去掉 bun test 门禁段落，保留 holdout 泄露检测 + real-tasks 永封 校验 + dashboard 自动刷新提交
  - 同步更新 evals/README.md / docs/eval/TODO.md / package.json 中对已删命令的引用
  - 删除对应测试 tests/eval/import-trajectory-platform.test.ts

## v0.1.582 (2026-07-09)

### 新功能
- **rg,fallback,test** · 内嵌 rg 升级 v15.1.0 + fallbackSwitchMode 三态 + 测试超时修复 `6bc1c0ff`
- **rg,fallback,ui** · 内嵌 rg 最佳努力 + fallback 降级决策引擎 + 选择题单选/多选视觉区分 `d1c94c70`
- **ui,tools** · askUserQuestion preview/notes + Footer 窄屏自适应 + grep 退出码修复 `08d1dd4a`
- **ui,commands** · argumentHint 提示系统 + Shift+Tab 权限模式循环切换 `24b54649`
- **commands** · 统一命令持久化机制（-p 标志），扩展 /model 子代理与 fallback 切换 `3090c797`
- 完整默认配置模板 + 首装/更新两条路径安全补全 `dfa399a3`
- **ux** · 补全列表回车直接执行 + release.sh 门禁加固 + 清理遗留脚本 `38ad3d3e`
- 构建二进制包&规则校验优化 `81fbee92`
- **observability** · 完善子代理错误面板 & side-call 轨迹实时同步 `d89f37a6`
- tui界面提供统一错误面板 `88a6e8ef`
- **themes** · 语义颜色显式化，修复浅色可读性与消息显示异常 `80f4fa02`
- footer去掉debug显示 `8b136a62`
- 约束型误伤/误判/误导 & 中断/错误处理/静默失败/硬编码分档 一轮修复 `3c90e099`
- 实现 Agentic Loop 查询模型、输出停顿检测与 token 预算续接，增强会话存储与恢复 `68a19e77`
- Agentic Loop & Human-in-the-Loop 对齐 `1626b006`
- 清理过时文档 `0fc608df`
- 更新设计方案 `2f7f3069`
- OpenAI Responses API 支持 (A3) 与多模块增强 `8bd80436`
- 六、Sprint 3 详细 Todo-List（架构投资） `79e2f891`
- 五、Sprint 2 详细 Todo-List（加固防线） `98fc5f6f`
- **provider** · 多层超时防护体系与可观测性增强 `b843cea9`
- 工具质量和稳定性优化 `bdaaacba`
- 可观测性缺口 — hang 死场景诊断盲区与改进方案-实现 `eace5e67`
- 可观测性缺口 — hang 死场景诊断盲区与改进方案-实现了一半 `53b61980`
- read工具优化 & 方案设计 `0dfa063d`
- 优化grep工具 `ad25e89c`
- Anthropic 协议族兼容性全面修复计划 & 状态同步隐患修复 `60420c87`
- 折叠优化&子代理超时优化 `bd64d65c`
- openai协议族兼容性处理 `e0c7fbea`
- 删除 OSC 9;4 进度环 `e8db6f02`
- 优化没有配置key报错，增加引导 `59aec6fa`
- 内容截断检测优化 `8fac619b`
- 子代理超时 `c6f714fb`
- 代码优化 `db1c9caf`

### 修复
- 高危 — 粘性开关脱同步(状态栏撒谎) & 2. 中危 — auto 是「死档」 `fdabd4fe`
- **config** · 团队默认配置占位符 Key 静默失败改为启动即报错 `aab0cff0`
- **llm** · 伪装成功的空流静默失败 — 四层纵深防御 `1b96a6f4`
- /goal 执行过程问题排查 — glm-5.2 会话 20260707 -第三轮修复 `d3a2f612`
- /goal 执行过程问题排查 — glm-5.2 会话 20260707 -第二轮修复 `e9eac525`
- /goal 执行过程问题排查 — glm-5.2 会话 20260707 -第一轮修复 `d91c18b5`
- 修复测试报错 `adc0ef9a`
- **agent/mcp/llm** · 修复共享 AbortSignal 上事件监听器泄漏，扩展 abort reason 白名单 `a4a9ad20`
- 孤儿 Stream Snapshot 跨 queryLoop 污染看门狗 `45392787`
- **provider** · 补齐 OpenAI 族缓存命中字段兜底链 — Kimi 顶层 cached_tokens `109ad9fe`
- **provider** · OpenAI/DeepSeek 缓存命中率修复 — 按 DYNAMIC_BOUNDARY 拆分静态/动态区 `8bccf823`
- **ui** · 修复 compact 摘要与 reattach 锚点泄漏到 TUI `53e1594f`
- DeepSeek 思考链走 content 通道泄漏为正文 → 任务"假性中断 `e9f6c30f`
- 优化clear命令残留 `376c6aaa`
- 密钥丢失 bug,用户的密钥被抹掉了 `1efc6474`
- 截断检测仅覆盖文件时生效 + 补充副作用分析文档 `ee06bceb`

### 重构
- **agent/query/llm** · 收敛超时配置体系，默认关闭循环检测并移除 partial-read 保护 `2ec6dc5c`
- **ui** · 提取 DialogSwitch 中枢，统一对话框调度 `5f6ea637`

### 文档
- CLAUDE.md 明确发布铁律——先提交功能代码再发布再补 bump 提交 `c6ab9dec`
- 更新文档 `002b3400`
- 更新文档状态 `6fcaed84`

### 其他
- 添加 rebuild 目标 + 开发/发布/更新三线流程文档 `faa0c0d6`
- 更新文档 `bb6520f8`
- 更新文档 `0267010d`
- doc: Provider 层生产级稳定性优化 — 实施路线与 Todo-List `d9033d9c`
- 可观测性缺口弥补 `8d278b31`
