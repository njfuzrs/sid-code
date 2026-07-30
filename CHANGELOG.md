# Changelog

本文件由 scripts/generate-changelog.ts 自动生成，请勿手改。

## v0.1.595 (2026-07-30)

### 修复
- **mcp** · 只读子代理 MCP 工具放行收紧 + 指令静默遵循 + 截断保护 `90da5aed`
  - tool-filter: 只读子代理（explore/plan/verify）MCP 工具不再绕过白名单 （P0 多 provider 安全加固，防止 glm/deepseek 在只读任务中调用浏览器工具）
  - agent-definition: 只读子代理 system prompt 追加只读模式约束
  - instructions-delta: MCP 注入说明追加"静默遵循"指令，降低模型元认知外泄
  - loop: MCP instructions 块添加 4000 字符截断保护
- **tui** · alt screen 鼠标滚轮兼容性修复（macOS Terminal.app 兜底） `c9c87db5`
  - cli.ts: TERM_PROGRAM=Apple_Terminal 时 alternateBuffer 自动回退 false， 走主屏原生 scrollback 滚动（任何终端都支持），可用 --alternate-buffer 覆盖
  - dec.ts + MouseContext.tsx: 启用 DEC 1007（alternate scroll），alt screen 下滚轮转 Up/Down 方向键，作为终端不支持 SGR 1006 时的兜底； 1000/1002/1003 优先级高于 1007，支持 1006 的终端不受影响（无害叠加）

## v0.1.594 (2026-07-30)

### 修复
- **logger** · 落盘级别门控豁免 AUDIT:* 分类，修复审计轨迹被掐断 `caecceb2`
  - 豁免的是**分类**而非级别：同配置下普通 INFO 仍被挡住
  - 仍受 mutedCategories 约束（用户显式静默优先级更高）
  - AUDIT 条目每轮仅几行、约 200 字节，不构成写放大
  - 新增豁免分类的判据：低频 + 缺失即致盲
- **logger,telemetry** · 日志落盘级别门控 + 缓存遥测轮转修复 `165cb681`
  - 日志落盘级别门控：文件写入不再无视 level，修复审计模式下 DEBUG 日志占 90.7% 的写放大（104MB → 应有 1.2MB，87 倍）
  - append 模式轮转修复：currentLogSize 起点从 header 字节改为 既有文件大小，修复跨会话累积永不触发轮转的 bug
  - 缓存遥测加大小轮转：10MB 上限滚动为 .1，保留 1 份历史
  - 尾部读取优化：从 readFileSync 全量读改为只读尾部 1MB 窗口， 降低 RSS（原 8.5MB/51615 行全量读）
  - 跨轮转回补：当前文件不足 limit 条时回补 .1 尾部，避免刚 轮转完 /cache --history 显示为空
- 假压缩误报恢复兜底 + 记忆索引脱敏 + MCP 围栏格式加固 `1f8edbf2`
  - syncGatewayPricing: 端点恢复但价格未变时也清 failed_at（防永久锁死）
  - normalizeMemoryDesc: 抹去基础设施坐标（公网 IP / 特权账号）
  - buildMcpInstructionsSection: 加 <system-reminder> 围栏，不以 # 开头
  - 文档: 上下文注入根因分析从 todo 迁至 done

## v0.1.593 (2026-07-30)

### 新功能
- **website** · changelog 搜索改为多词 AND 匹配，跨字段可组合命中 `65d16cba`
- **website** · changelog 并入官网 /changelog，删除独立 mini 站 `cb49987b`
- **website** · 新增叙述覆盖度门禁 —— 命令改动自动触发 --coverage 检查 `34ad2a2d`
- **website** · 阶段 4 服务器上线 —— 官网/文档站发布链路 + nginx 切站 `feee6b10`
- **website,docs** · 参考文档生成器落地——运行时自省 + 对账门禁 + holdout 公开面适配 `9346c17b`
- **website,docs** · 搭建 VitePress 官网文档站点 + 参考文档生成器 `19ee0a4a`
- **agent,skill,swarm,tool,query** · 对齐 CC 缺口方案双检 + 多模块补全修复（P0-P3） `17fe77f6`
- **session,checkpoint,skill,cli** · 会话持久化对齐 CC §14 + Skill 元工具化重构（P0-P3） `9de3fdd6`
- **agent,swarm,tool,permission** · 子代理系统对齐 CC §11 + git 归因/危险检测统一 + bash 快照受影响文件追踪（P0-P3） `b29c1955`
- **context,llm,query** · 上下文窗口管理对齐 CC §12 缺口修复（P0-P3） `91011f4e`
- **mcp** · 对齐 CC 缺口修复 B1-B3/G1-G6 + G5 mcp serve `01533f88`
- **memory,command,config** · 外部 @import 审批命令入口 + 父目录链 git root 上界 `beef9924`
- **memory,config,ui** · 记忆系统增强 + CLAUDE.md 导入处理（M2/M3/M4/M7/M9/M11） `c7f8df13`
- **hook,skill,command** · Hook 系统对齐 CC 缺口 G7/G10/G11/G13 + Skill 禁用统一 + 清理废弃模块 `c7a44575`
- **hook,query,agent,permission** · hook 系统增强——PreToolUse 统一解读 + 退出码对齐 CC + prompt/agent 类型 + 真子代理执行器 `5d6c9a06`

### 修复
- 上下文注入三连根因修复落地（语义围栏 + 假压缩误报 + 双通道重复注入） `84877be2`
- 记忆键归一化清理 + Read NUL 报错增强 + todo-write 软提示降级 `49fd6f20`
- 上下文注入审计第 7 批修复 + 死代码清理 `23f45e80`
- 负收益防线审计第 2 轮修复落地 + 上下文注入审计第 6 批 `90898fb3`
- 负收益防线审计修复落地（发现 1-6，批次 A/B/C/D/E） `25f725b0`
- 审计第 4、5 批修复（作用域规则闸门 + 消息保真） `01bbf262`
- **system-prompt** · 缓存键从手写维度列表改为自动遍历 ctx 字段 `8cdcdc70`
- 审计第 2 批三项功能等同修复（团队记忆同步/skill 上报/IDE 增量注入） `35b03e9e`
- 审计第 1 批三项安全修复（@权限校验/frontmatter fail-closed/记忆键单射） `ee1fb493`
- **website** · ref 页面「请勿手工编辑」提示从 danger 框改为 HTML 注释 `65b84e3c`
- JIT 规则 paths 作用域真正生效 + history-adapter 保留 tool_result `d82fbff0`
- **website** · 表格改回 display:block 修复长 URL 撑破容器溢出 `28330ede`
- **website-deploy** · 修首页冒烟假失败 —— pipefail + grep -q 让 curl 吃 EPIPE(exit 23) `183636a5`
- **llm,query** · 迁移 skill 崩溃复盘修复 + todo gate 误判自愈 + 北极星宗旨 `b483a2bc`

### 文档
- 上下文注入错位根因排查（reminder 前置拼接淹没用户指令 + system/user 双通道重复注入） `ef2dc751`
- 负收益防线审计第 2 版 + 企业级能力调研与规划 `7111cced`
- 审计清单补验完成（第20-22条）与修复执行计划，新增质量方法论 `2e51c01b`
- **website** · 精简首页 tagline，砍通用能力罗列突出四条差异化 `7ad881d5`
- **website** · 首页定位从「跑在终端」改为「长在企业研发环境里」 `1abf9b77`
- **website** · 扩写 11 篇叙述页补全覆盖度 + 同步报告 §5 修复标注 `054a8258`
- **website** · 修复参考页三处脚本口径漏项（覆盖度报告 §5） `a450fa46`
- **website** · 补全 P1 用户会主动找但找不到的叙述文档（覆盖度报告 §2.2 八项） `1ad35f71`
- 精简 CLAUDE.md，去重复表述保留全部规则（190→169 行） `0f7eeb21`
- CLAUDE.md 新增「不删无关文件」铁律与会话自检第 4 条 `4f1bd8ad`
- **website** · 补全 P0 能力型命令叙述文档（覆盖度报告 §2.1 七项） `b7d3c534`
- 新增上下文注入作用域审计文档，同步官网导航与 README 格式 `504e3c97`
- **reference** · 记 T-5.7 验收 —— L5 team 全部 5 篇已写实并上线 `0c564581`
- **website** · 阶段 5 内容撰写 T-5.7 —— L5 team 最后 1 篇 observability 写实 `2d62bf62`
- **website** · 记 T-5.6 验收 —— L3 extend 6 篇已写实并上线 `8ac0d1a0`
- **website** · 阶段 5 内容撰写 T-5.7 —— P6 L5 team 4 篇写实 `77bf11f9`
- **website** · 阶段 5 内容撰写 T-5.6 —— P5 L3 extend 其余 6 篇写实 `b8633a23`
- **website** · 记 T-5.5 验收 —— ref/glossary 术语表已写实并上线 `1b3ac1dc`
- **website** · 阶段 5 内容撰写 T-5.5 —— ref/glossary 术语表写实（L4 唯一人工页） `5b410228`
- **website** · 阶段 5 内容撰写 T-5.3/T-5.4 —— P2 差异化 4 篇 + P3 L2 其余 7 篇写实 `7b52563d`
- **website** · 阶段 5 内容撰写 T-5.1/T-5.2 —— 落地页数字复核 + L1 入门 5 篇写实 `b0ecd226`

### 其他
- **website** · 同步 llms.txt —— observability 页 description 变更 `0f9390f2`
- **git,docs** · 统一 commit 归因邮箱至 sid-code.cc 并补设计方案阶段 3 验收 `4583d1cc`

## v0.1.592 (2026-07-23)

### 新功能
- **query,trace** · SID_MAX_TURNS 软阈值提醒 + 只读死锁缺口 A/B 修复 + model_at_start 归因 + 空壳清理放宽 `60f4c8b2`
  - 新增 SID_MAX_TURNS 软阈值提醒（第四层兜底）：默认关闭，仅显式设置时启用， 单条消息处理超过 N 轮时一次性注入软提醒，不强杀，尊重"不打断长任务"偏好
  - 缺口 A 修复：isReadonlyProbeCommand 剥离 cd/env 前缀后再判只读， 让 `cd /a/b && git status` 等真实死锁形态进入检测
  - 缺口 B 修复：read/ls/glob/grep/lsp 等纯只读工具折叠进 probe 签名， 使 `git status ↔ read 同区域` 交替空转构成稳定复合签名，不再被交替清零
  - §6.4 model_at_start 归因字段：trace 中新增启动模型追踪， model 跟踪 /model 切换后的实际模型，供归因对照
  - §6.1 放宽空壳清理：覆盖"发出一次 BeforeModel 即被 abort、0 token" 的启动即中断会话，清理全天噪音
- **ui** · 状态栏重构为两行分层布局 + 两色层次 `e4eee675`
  - Footer 从单行四区改为两行：行1(会话/运行态)左对齐、行2(环境/上下文)右对齐
  - 引入两色层次：单位/符号(暗色后退) + 数值(亮色前进)，全程有层次不再一片灰
  - 修复权限模式恒被截断：去掉内层 width="100%"，行宽由 flex 父容器自然决定
  - 窄屏渐进隐藏改为各行独立按 dropOrder 丢计量项
  - fallback 测试适配：移除 defaultModel、传 defaultParams
  - 新增状态切换/阻塞交互/后台看门狗修复方案文档
- 补齐 CC 对齐缺口——Vim 引擎、会话回退、14 个新命令、CLI 校验与 UI 增强 `c5a67324`
  - 新增 Vim 编辑引擎（src/ui/vim/）：motions/operators/text-objects/transitions
  - 新增会话回退管理器（rewind-manager）+ RewindDialog UI
  - 新增 14 个命令：batch/bug/claude-api/color/fast/fork/insights/ keybindings/statusline/terminal-setup/tui/agents/auth/mcp-cli
  - 新增 CLI 标志校验（flag-e2e/flag-validators）
  - 新增剪贴板图片粘贴、Shell 任务接管（adopt）
  - 文档重组：对齐方案文件移入 double-check/ 子目录
  - 各模块配套测试覆盖
- **command,skill** · 新增 6 个命令 + /pr skill `1c90ca9c`
  - 新增 /context /copy /rename /statusline /vim /workflows 命令，
  - 新增 /pr bundled skill（对齐 CC），app 层增强 setVimMode/
  - setStatusLine/renameSession/stream-json 双向流/maxBudgetUsd，
  - UI 增强状态栏 Vim 模式，新增 3 组测试。
- 大规模补齐 CC 对齐缺口——CLI/权限/会话/UI/命令/配置全面补全 `6420a7c1`
  - CLI：新增 session-id、effort、allow-tool 等 20+ 参数，对齐 CC 启动参数集
  - 权限：acceptEdits 下文件系统命令放行、路径/Shell 规则匹配、mode-policy
  - 会话：fork-session 分叉、no-session-persistence、sessionName
  - 命令：新增 /status、/todos 内置命令
  - UI：ContextDialog、Footer 状态栏、statusline、external-editor、kill-ring
  - 配置：扩展 Config 接口 30+ 字段，settings 源控制、MCP 配置源
  - 工具：WebFetch 预授权域名、工具白名单替换
  - 测试：新增 10+ 测试文件覆盖各模块
- **query** · 统一优先级消息队列 + mid-turn 抢占 drain,补齐缓存/环境/终止对齐 `a943c6e9`
  - 新增 message-queue-manager.ts:收敛用户输入/后台通知/agent 消息到 now/next/later 优先级队列
  - loop.ts 支持 mid-turn 抢占 drain(now 级,SID_ENABLE_MIDTURN_DRAIN 灰度开关)
  - stop_sequence 纳入正常终止白名单,走完整收尾链
  - cache-strategy: 工具区缓存断点 markLastToolCacheBreakpoint(仅直连 Anthropic)+断点预算护栏计入 tools
  - system-prompt: 新增上下文管理静态告知(增强 5.3)+环境信息补齐 git 仓库判定与 OS Version
  - errors.ts 登记 midturn-preempt abort reason
  - task/notification 接入统一队列
  - 补充 message-queue-manager / midturn-drain / stop-sequence-end-turn 测试
- **tool** · P2-17 cron 人类可读调度 + P2-15 sub_agent 透出 model/cwd `3a2a03ab`
  - P2-17：新增 cron/describe.ts 的 cronToHuman，识别每 N 分钟/每小时/每天/
  - 工作日/每周某几天/每月某日等常见模式，识别不了回落原始 cron；cron_list
  - 输出「人读描述（原始 cron）」。
  - P2-15：sub_agent schema 补 model（每次调用覆盖模型）与 cwd（工作目录），
  - 同步/后台两路径均透传到 SubAgentTask（内部本就支持，此前未暴露给 LLM）。
  - 测试 tests/cron/describe.test.ts 9 pass + tests/agent/sub-agent.test.ts
  - 29 pass；全量 5809 pass；make rebuild 通过。
- **web-fetch** · P2-2 HTML→Markdown 保留页面结构 `d82a5e0c`
  - 标题→# 前缀、链接→[text](url)、列表→- 前缀、表格单元格→| 分隔
  - 强调→**/*、行内代码→反引号
  - 去 script/style/HTML 注释，解码十六进制/数字/具名实体
  - javascript: 伪协议链接只保留文字，防注入
- **tool** · 补齐结构化任务清单 + WebFetch 缓存/prompt + bash 超时 env 覆盖 `161fc280`
  - 新增 structured-task-store：subject/status/owner/blocks/blockedBy 双向依赖边维护 + 成环检测 + isTaskUnblocked
  - 新增 task_create/task_update/task_get/task_list 四工具（结构化清单）
  - 原后台任务族改名 bg_task_get/bg_task_list（语义对应 CC TaskOutput 族）
  - 同步 coordinator/loop-detection/agent-definition/tool-filter/ tool-classifier/cli 全部引用
- **skill** · 新增 claude-code-migration 迁移技能 `17123e5f`
  - 将 Claude Code 的用户级和项目级配置迁移到 sid-code，支持
  - settings、MCP servers、commands、skills、agents、hooks、memory、
  - output styles、permissions 等配置的迁移。
  - 新增 inspect-migration.mjs 只读检查脚本、mapping.md 映射准绳、
  - E2E 测试脚本及 Claude Code 设计空间研究文档。

### 修复
- **trace,hook,query,tool,task** · eval-session 评估 4 项缺陷修复 + 文档测试闭环 `e8b5c6de`
  - queryLoop 侧 StreamPhase 快照 key 是 `${loop_id}:${turn_index}`，采集器配对看门狗此前用 「累计 pair 数 + 1」查快照，key 语义不同 → 除首条用户消息外永远查不到，stream_snapshot 恒 null（死代码）。新增 BeforeModelInput.stream_snapshot_ref 透传 turn_index +…
  - 慢模型 + 长上下文下单轮生成超 2 分钟配对阈值是常态，但流仍在收 chunk 并非 hang。
  - 看 stream_snapshot.still_progressing：流有进展 → 降级为 [低] model_call_slow_response， 不再进 high_severity_anomalies；真 hang（无进展/已 abort）仍报 [高] watchdog（digest.ts/collector.ts）。
  - 原 `errors` 字段实为 high+medium 异常计数（含 watchdog/stuck_loop 假阳性），被误当真错误数 灌水进分诊主键。拆为三字段：`real_errors`（诚实错误计数，仅 is_error/TurnError 等）、 `anomalies_count`（异常总数，含假阳性，仅供参考）、`errors`（弃用别名 = anomalies_count，向后兼容）。
  - 批量分诊主键改用 `select(.real_errors>0 or .high_severity_anomalies>0)`（digest.ts + 文档同步）。
  - 弱模型对大文件常做几十次 limit=10~60 窄窗读、反复重读同一区域（实证 33 次），read 是纯只读、 无引导信号 → 拉长步数 + 推高 token。新增「重复窄读」非阻塞提示：同文件 ≥3 次且与历史高度重叠 → 提示复用/整读；首次对小文件传小 limit → 提示可一次整读。绝不拦截只读操作（read.ts）。
  - 防回归：提示含每轮自增的「第 N 次」元信息，会破坏 repeated-readonly-guard 的内容签名（每轮都变 → repeatCount 清零 → 瘫痪 git-status 冻结死循环止损阀）。新增 stripReadEfficiencyHint， loop-detection 做签名前先剥离该段（read.ts/loop.ts + 单测覆盖签名稳定性）。
  - flush() 此前另起 drain 与在途 drain 竞争，可能先看到空队列而提前 resolve，读端拿到不存在文件。
- **telemetry,trace** · 账本增量落盘 + 并行子代理误报修复 + ✗标记只信is_error `509d93d7`
  - 成本不落账本(高)：usage-ledger 从 append 改 upsert，每轮 AfterModel 增量落盘，去掉 ledgerWritten flag；读侧 dedupeBySession 兼容历史 append 多行。交互式会话任务完成后不再丢账本。
  - 并行子代理误报循环(中)：digest shape run 检测加时间戳窗口，同时间戳 派发的 fan-out 不计 run；保留串行空转告警。
  - ✗标记混淆(低)：移除关键词启发式，✗ 只留给 is_error===true 的真失败。
- **llm,query,config** · 补齐 git 快照死循环 4 个缺口 + 文档归档 `e92aafc0`
  - §6.3 重复开流成因遥测（原未落地）：fallback.ts 重开流路径读 stream-observer snapshot 的 timeoutsFired，推导结构化 reopenReason （idle/content_progress/fallback_stream_timeout），无超时记录则取 classified.reason；retry-telemetry.ts 新增 reop…
  - abort 路径必达+集成测试（原部分落地）：empty-param 测试用真实 AbortController 在 processStream 返回前触发 abort，断言 cancel result 含「被中断/未执行/没有落地/分段写入」且已 sessionStore 落盘
  - 第一层脏工作区单测（原部分落地）：attachments 测试创建临时 git 仓库 →commit→制造 untracked+modified 脏状态，断言脏文件名绝不泄漏进 <git-status>
  - 文档归档：根治-git快照死循环 todo→done；新增两份排查/评估文档
- 双层预防根治 git 快照冻结死循环 + 全屏有界视口物理根治幽灵残留 `681f7231`
  - 第一层（attachments.ts）：移除 volatile Status 块，消除净/脏矛盾源
  - 第二层（empty-param.ts, loop.ts）：空参数/中断回执明确"未落地"，覆盖 abort 路径
  - 方案乙（config.ts, app.ts, cli.ts, help.ts, tui.ts）：默认全屏 alt-screen 有界视口，--inline 逃生舱
  - 子代理前台不再双投递通知（sub-agent.ts, agent-task.ts）
  - UI 修复：sub_agent 卡片 header、live tool 视口封顶等
  - 自检更新 + 测试更新
- H1-H10 系统性修复——fallback 死代码、terminal 拉黑、硬超时误杀、孤儿弹窗、子代理 thinking 收口 `0bf9bae0`
  - H1: fallback 注入 resolveContextLimit 回调，根治 tryRecoverMaxTokens 死代码
  - （构造从不传 contextLimit → 恒 return null）
  - H2: 用户显式切模型或降级选中时清除 terminal 拉黑态，避免切了等于没切
  - H3: CLAUDE.md 模型切换复用 applyPrimaryModelSwitch 统一重算路径
  - （此前裸改 config.model，maxTokens/provider/effort 全失真致 400）
  - H4: fallback 注入 resolveMaxOutputTokens，修复自定义模型漏钳制 maxTokens 致 400
  - H5: config.ts 新增 resolveMaxOutputTokensForModel 导出
  - H6: turn_hard 超时改为 setInterval 周期检查，与人机等待闸门共享状态，
- **fallback,query,config** · 修复 fallback 切模型 maxTokens 不重算致 400 + 看门狗误杀弹窗 `dac6cbc5`
  - config: 登记 _explicitMaxTokens 提前到首次 resolveCurrentModelConfig 之前，避免用户显式值被模型推导覆盖；新增 clampMaxTokensToModelCeiling 统一钳制
  - app: 抽取 applyPrimaryModelSwitch 统一 /model 切换与 fallback 降级 的主模型写回逻辑，确保两条入口均重算 maxTokens
  - fallback: 切到 fallback 模型时按注册表上限钳制 maxTokens
- **fallback,query,config** · 修复 fallback 切模型 maxTokens 不重算致 400 + 看门狗误杀弹窗 `2d12bfc9`
  - config: 登记 _explicitMaxTokens 提前到首次 resolveCurrentModelConfig 之前，避免用户显式值被模型推导覆盖；新增 clampMaxTokensToModelCeiling 统一钳制
  - app: 抽取 applyPrimaryModelSwitch 统一 /model 切换与 fallback 降级 的主模型写回逻辑，确保两条入口均重算 maxTokens
  - fallback: 切到 fallback 模型时按注册表上限钳制 maxTokens
- **query,permission** · 补齐队列/权限/clear 三处缺口 `21a3cd2c`
  - 队列：drainByPriorityAndKind 双条件精确出队，mid-turn 只取 user-input
  - 不误吞其他 kind（如 permission-response）
  - 权限：checkDenyRules 复合命令逐子命令拆分匹配 deny 规则，任一命中即
  - 整体拒绝（some 语义），修补 `ls && curl evil.com` 绕过 deny 前缀的安全缺口
  - /clear：两处增加 clearMessageQueue() 调用，防止跨会话残留
  - 配置：新增 askUserQuestionTimeout 配置项
  - 测试：补齐对应测试用例

### 文档
- **skill** · 完善 eval-session 评估文档——执行环境约定、跨段桥接、批量分诊与能力链路探针 `240efac8`
  - 增加执行环境约定（分清"谁在评""评谁"）
  - 新增 Phase 3.5 跨段桥接（模型失误→harness 发现）
  - 新增 Phase 0 适评性分诊与批量分诊脚本
  - 新增成本基线判读与 B 路能力链路探针
  - 术语统一：缺陷→发现（缺陷+优化点）
  - 更新完成判据与输出模板
- 重组对齐 claude-code 缺口修复方案文档 + 新增安全审计 `1394f629`
  - 将 todo 下分散的对标方案文档归并进「对齐claude-code-缺口修复方案/」目录并编号
  - 新增 09-20 记忆/MCP/子代理/上下文窗口/Git/会话/IDE/SDK/Skills/配置/生态等对标方案
  - 新增 docs/security-audit prompt 注入与凭证管理审计
- 发布流程第一步移除重复的 bun test，release.sh 内部已自带门禁 `20a9bd66`

### 其他
- doc: 新增方案设计文档 幽灵残留：完全对齐 claude-code 渲染架构 —— 物理根治 `1ebaf645`

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
