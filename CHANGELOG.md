# Changelog

本文件由 scripts/generate-changelog.ts 自动生成，请勿手改。

## v0.1.588 (2026-07-14)

### 新功能
- 可观测性修复 — TTFT 数据源校准 + 缓存脱落归因 + UX 文案 + 指标体系文档 `c013255`
  - P0-1（排查报告 Bug A）：TTFT 从被污染的 AfterModelRaw.ttft_ms
  - 切换到纯净的 StreamPhase("first_content").ttft_ms，
  - 消除重试/渲染延迟双重污染；
  - 新增 gen_p50/p95/p99 生成耗时维度，让"慢在生成"显式可见；
  - avgLatencyMs 渲染标注"整轮耗时"，避免与首字节混淆（Bug B）
  - P1-2：缓存命中下降归因增加 precededByRetry 字段，前缀未变时
  - 按"是否紧跟重试"分离两类脱落：重试触发 vs 纯服务端波动
  - P2：todo gate 中性措辞优化；openai 协议缓存命中率上限提示（60-70% 正常）
- 码点安全截断 + daemon 防命令注入 + bash 引号诊断 `450bec6`
  - feat(context): 码点安全的 truncateToolOutput，避免切断 emoji/CJK 扩展区
  - feat(bash): 新增引号畸形诊断，命令失败时附 heredoc 写法提示
  - fix(daemon): worker/workspace 改用 execFileSync，消除命令注入风险
  - test: 补充 sliceByCodePoint 和 quoting-diagnostics 单测
  - docs: 归档 git-status 快照冻结死循环相关根因分析
- git-status 快照冻结死循环多方向修复 `a685d07`
  - 方向 0：新增 --self-check 编译产物自检（bootstrap + self-check 模块），
  - 在 make build/rebuild 和 release.sh 末尾自动验证关键修复已内联。
  - 方向 2/4/6：新增 repeated-readonly-guard 模块，检测连续相同只读
  - 探查命令（git status/diff/log 等）+ 输出稳定不变，先注入携带实时
  - git 状态的收敛提醒，注满上限仍空转则强制收尾。
  - 方向 3：非只读命令（git add/commit 等）成功执行后失效 git 状态
  - 缓存，确保下一次 generateGitStatusAttachment 拿到最新状态。
  - 补充：loop-detection 默认关闭的决策依据从"对齐 CC"升级为"实测
- 调整文档位置 `0d882d0`
- 统一移动测试文件到test目录下 `0bce4df`
- 调整doc目录结构 `f57dc86`
- 调整doc目录结构 `77ccf9a`

### 其他
- doc：更新文档完成状态 `8986c99`

## v0.1.587 (2026-07-14)

### 新功能
- MCP instructions 增量注入 + 工具延迟加载豁免 + 缓存冷热判定修复 + paramText 参数检索 + 编辑失败追踪 + cache_creation 成本补落 `a985fd3`
- worktree 创建期告警 + LSP codeAction 支持 + 上下文压力节流 + 工具延迟加载 + DYNAMIC_BOUNDARY 保真 `2eea82d`
  - worktree advisories：创建期检测依赖一致性（lockfile hash 比对）和 DB migration 冲突，回显给用户 / 子代理日志落盘，异常不阻断
  - LSP CodeAction：新增 LSPCodeAction 类型、diagnostic-registry latest 只读快照、 lsp-formatters 格式化、server-instance 能力声明、lsp.ts codeAction 操作
  - 上下文压力 cadence 节流：按档位（warn/urgent）节流注入，升档强注入、同档 低频重述（每 8 轮），避免幻影用户消息（对话重播/截断幻觉根因）
  - toolSearch 默认开启：对标 CC 默认行为，15 个长尾工具首轮不注入省 token
  - DYNAMIC_BOUNDARY 保真：复用 cache-strategy.ts 单一事实源，截断路径不丢边界 标记，防止缓存分区失效
  - 文档：删除可选优化/README.md，更新 context-engineering-next-optimizations.md
- 通知结构化快照重构 + 内部消息来源分类拆分 + 文档更新 `e902b90`
  - 通知机制：新增 StructuredNotification 与 enqueueTaskNotification 入口，
  - TUI 结构化优先渲染，根治子代理结论含 XML 字面量破坏解析问题。
  - 内部消息：INTERNAL_ORIGINS/INTERNAL_RENDER_ORIGINS 分类拆分，
  - 修正 hasInternalOrigin 防止 task-notification 被整条隐藏误吞。
  - 系统提示：补充按需拉取完整结论说明。
  - 文档：团队记忆同步方案二次评审修正与落地记录。
- 子代理增强——LSP 诊断注入、tool_choice 透传、masking 隔离 `e6dd3a8`
  - 具备 edit/write 工具的子代理在每轮开始前收集已编辑文件的 LSP 诊断
  - 注入为 user 消息让子代理感知自己引入的类型/语法错误
  - 作用域限定为本子代理编辑过的文件，并发子代理互不偷取
  - 为每个子代理派生独立 sessionId，避免并发子代理临时文件覆盖
  - 自定义子代理以 task.type 标识，普通子代理以 taskId 标识
  - 发给 LLM 的消息改用 getCleanedMessages()（大输出剪枝 + masking）
  - 此前裸发 getMessages() 无任何工具输出剪枝，input token 线性膨胀
  - auto-compact 设 toolChoice:"none" 禁止摘要时调工具，但此前被静默丢弃
- 流式工具执行器 + 工具编排 + 侧链持久化 + 内部字段剥离 `efab10c`
  - GAP-01 流式工具执行器（模型输出与工具执行并行）
  - GAP-08 防御性内部字段剥离（纵深防模型伪造）
  - GAP-10 工具编排层独立可测（分区调度算法提取）
  - P2-10 子代理 sidechain 持久化（防中断丢失）
  - 循环检测与终止策略-差距分析标记为已完成
- 不确定-1 会话硬顶修复 + 必删-4 语言约束 + system-prompt 优化 + StatsDialog 单价 + 防线触发率脚本 `4ea9855`
  - 不确定-1：app.ts 新增 sessionTimedOut 判断防止静默吞掉；maxSessionDurationMs 默认 60min（单轮 2 倍）
  - 必删-4：语言约束改为 reasoningLanguageDrift 能力标志驱动
  - system-prompt：新增"批量化搜索"和"避免宽 ASCII 表格"规则
  - StatsDialog：新增 pricing prop 显示每百万 token 单价
  - 新增 scripts/defense-trigger-rate.ts 防线触发率度量脚本
- 审计报告落地修复与功能增强（不确定-1/2/3/4 + G13/G19/G22） `8687242`
  - 不确定-1：会话级硬顶纳入 network-profile 统一配置，headless/SDK 路径补齐
  - 不确定-2/3：单次调用重试硬顶 maxRetriesPerCall 防退避风暴
  - 不确定-4：baseURL 优先级链明确化
  - G13：子代理类型透传，save_memory agent scope 定位到子代理类型记忆目录
  - G19：think 工具注册（新泛型 Tool → LegacyTool 桥接）
  - G22：/compact 部分压缩（partial-compact）接线
  - trace/digest：新增 SubAgentSpan/SubAgentSummary 数据结构
  - 配套测试与注释规范
- G19 工具注册现代化——bridge 适配器（新泛型 Tool → LegacyTool 桥接） `9b04cd6`
  - src/tool/bridge.ts: 新增 toLegacyTool() 桥接适配器，buildTool() 构建的新泛型 Tool 经此适配后可直接 registry.register()
  - src/tool/types.ts: LegacyTool 注释中标注 G19 迁移路径，新工具直接用 buildTool() + bridge 无需等全量迁移
  - tests/tool/registry-modernization.test.ts: 完整闭环测试（buildTool → toLegacyTool → register → definitions）
  - src/query/compact/g16-g26-decision.ts: G16/G26 决策记录文档
- G10 autoDream 接线与配置（app.ts 集成 + settings 配置项 + 单元测试） `8690e9e`
  - src/app.ts: autoDream 初始化接线，复用后台记忆提取子系统的 getMainContext + memoryDir
  - src/config/config.ts: 新增 autoDream 配置项及 auto_dream/autoDream 双键映射
  - tests/memory/dream.test.ts: 三级 gate 判定 + 状态持久化 + recordSession 计数测试
- 多项功能增强（G6/G10/G21/G23/G25） `e7819d8`
  - G6: Read 工具支持多模态富媒体（图片/PDF/Notebook），含图片 mediaBlock 返回、Notebook 结构化渲染、PDF document 块
  - G10: 新增 autoDream 自主记忆巩固系统，三级 gate 触发（时间/会话/记忆量），fire-and-forget 后台 agent 跑 consolidate → prune
  - G21: Glob/Ls 工具接入 deny 规则过滤，被 deny 的敏感文件不再出现在列举结果中
  - G23: Shell 模式退出提示渐进衰减，复用 app-config 通用 hint 计数 API（满 3 次收敛）
  - G25: 命令上下文注入 permissionChecker 实例，修复 /allow /deny /add-dir /permissions 运行时永远为 null 的漏传
  - 新增 partial-compact 查询压缩模块
  - edit/write 工具增强
  - 对照 claude-code 多模态能力分析文档落地
- **command,llm,permission** · /add-dir 命令 + G6 富媒体序列化 + G21 deny 路径隐藏 `13d4534`
  - 新增 /add-dir 命令：运行时将目录加入当前会话可访问白名单，支持 --list / --remove
  - G6: 抽取 serializeToolResultBlock 函数，支持图片/文档多部件 content 收敛流式/非流式两条序列化路径，避免逻辑漂移
  - G21: 新增 isPathHidden 方法，让 deny 规则对 glob/ls 列举结果生效 glob 工具注入 isPathHidden 回调，被拒文件从列表里隐藏（对标 claude-code）
- 多项功能增强（G6/G11/G12/G17/G20） `a2d9505`
  - G6: Read 工具支持图片/Notebook/PDF 读取
  - G11: 新增 NotebookEdit 工具（cell 级 .ipynb 编辑）
  - G12: 系统提示重建时刷新输出风格
  - G17: PTL 截头重试机制（避免 prompt 过长导致摘要失败）
  - G20: sibling-abort 并发工具中断联动
  - 新增 diff/doctor 命令
  - 修复 sed -i 在 cd 场景下的路径解析
  - 补充 sed 误报边界测试和 notebook-edit 测试
- **mcp,config** · G3 Elicitation 接线与 G12 输出风格可插拔 `ba7420c`
  - G3：MCP 服务端请求路由（elicitation/create），SSE 传输层双向通信， CLI 交互处理兜底，capabilities 声明与 handler 注册
  - G12：outputStyle 配置注入系统提示词静态缓存区，用户可插拔输出风格
  - 测试：更新 git-status 断言适配新 snapshot 格式，新增防死锁哨兵
- 多项安全增强与功能补全（G2/G3/G5/G8/G9/G10/G11/G12/G13） `3a63743`
  - G13: 新增 agent-store 记忆系统，按子代理类型注入历史积累经验
  - G9: 补齐 bash-security 5 个校验器（畸形 token 注入/jq 逃逸/元字符/ 反斜杠转义空格/危险变量与不完整命令）
  - G10/G11/G12: 新增文件写入/编辑前安全检测，编辑工具接管
  - G8: 兼容 OpenAI 系 rate-limit header，补充限流状态提取
  - G2: ToolClassifier 接线，auto 权限模式回归生效
  - G3: MCP 传输层支持 Elicitation 服务器发起请求
  - G5: 长跑工具中间进度路由到状态栏
  - 对标 claude-code 的 git status 附件格式（仲裁锚点 + 结构化标签）

### 修复
- **llm** · 修复错误分类数字子串误判 + OpenAI strict schema 兼容性 `ccec09d`
  - errors.ts: classifyError/is401Error/is408Error/is409Error 改用数字边界匹配， 避免网关 request id 中巧合内嵌的状态码数字子串（如 "404"）误判为终端错误； 拿到结构化 HTTP status 时优先使用，不再回退文本扫描（2026-07-13 生产事故复盘）
  - openai-responses-request.ts: strict:true 工具的 schema 补全 required + optional 字段转 nullable，满足 OpenAI Structured Outputs 硬性要求； 对 z.any()/z.unknown() 等无约束节点自动检测并降级为非 strict（2026-07-14 复测发现）
  - install-template.sh: PATH 前置改为幂等判断，避免 update 时重复拱到最前
  - 新增/补充测试覆盖上述回归场景
- **task-notification** · 多通知聚合为一条消息，防止 _meta 浅合并覆盖前面的通知 `f6c2969`
  - 将 query/loop.ts 中逐条 addMessage 改为一次性聚合注入，_meta.notif 收集为
  - 数组；history-adapter 兼容单对象/数组两种形态，确保 TUI 渲染不丢通知。
  - 新增回归测试覆盖多通知数组与空数组回退场景。

### 其他
- doc：更新文档 `e487c2b`
- doc：更新代办事项状态 `d13b186`
- doc：更新文档 `9aaba54`

## v0.1.586 (2026-07-10)

### 新功能
- goal 轮次动态调整与显示去歧义，及多项修复 `2abd47e`
  - 新增 /goal turns <n> 子命令：运行时调整最大轮次上限（1~1000）
  - 默认 maxTurns 50→150：长任务模式留足空间，用户可随时 ESC 介入
  - 状态栏 goal 列去歧义：移除易误读的百分比，改为"目标 N/M 轮"中文标签
  - 全链路去彩色 emoji：goal 改用单色几何字形（◎/⏸/⚠/✔），与 figures.ts 一致
  - 活项分流机制：含 executing 工具的 tool_group 从 Static 移入动态区，根治 scrollback 幽灵行残留
  - model-registry 路由前缀白名单：剥离 ali-/volc-/siliconflow- 等网关前缀后重试匹配
  - openai idle 超时定时器泄漏修复：cancelTimeoutId 此前无句柄，每秒泄漏数百个
  - trace 内存优化：builder 新增 new_messages 回退，collector 剥离旧 raw_messages

### 性能
- 新增 TUI CPU/内存性能诊断与验证脚本 `6a1815c`
  - perf-probe.sh          PTY 下采样真实 TUI 的 CPU%/RSS/线程
  - perf-tui-drive.exp     expect 驱动 TUI 流式输出
  - perf-md-bench.ts       块闭合粒度 O(N²) markdown 重解析基准
  - perf-stream-token.ts   逐 token 流式渲染成本增长基准
  - perf-lex-vs-format.ts  拆分 lex vs format 成本（证实瓶颈在 marked.lexer）
  - traj-bench.ts          rebuildTraj 每轮全量重写的写放大基准
  - perf-verify-stream.ts  验证流式增量渲染修复（120块 658ms→7ms）
  - perf-verify-timer.ts   确定性验证 SSE 定时器泄漏修复（500→0）

### 其他
- doc：更新文档 `9c225cd`
- doc：更新文档 `6d5b058`

## v0.1.585 (2026-07-10)

### 修复
- **install** · 更新提示优化——抑制无谓 source 提示 + 补全 HTML 更新日志链接 `b27e6bb`
  - source 提示改为条件触发：仅当刚写入 PATH 块且当前 shell 的 PATH 里还没有 ~/.local/bin 时才提示。sid-code update 场景下命令本就从 PATH 找到才跑起来， 当前 shell 已含 bin 目录、二进制原地换掉即刻生效，旧逻辑无脑提示纯属噪声
  - 完成提示补上 CHANGELOG.html 网页链接（可直接点开，放在文本链接之前作为推荐）

### 其他
- doc：更新文档 `abe5613`

## v0.1.584 (2026-07-10)

### 新功能
- **changelog** · 富化 changelog 生成——commit body 细节 + 科技风 HTML 页面 `6ad242b`
  - generate-changelog.ts 重写为「git 是唯一事实源，每次从 git 完整重建」， 产出 CHANGELOG.md（文本事实源）+ CHANGELOG.html（可直接点开的网页）两份
  - 抓取 commit body 细节：subject 下挂 body 里的 bullet/编号列表作为子条目， 让用户看得懂每个版本到底改了什么，不再只是一句标题
  - 过滤机器噪声：bump 记账 / Merge / eval dashboard 刷盘 / Co-Authored-By 尾注
  - HTML 页面：分组徽章 + commit 细节可折叠 + 实时搜索过滤 + 侧栏版本导航， commit hash 链到 gitlab commit 页（从 origin remote 推导）
  - HTML 采用明亮浅色主题（浅灰背景 + 白卡片 + 高对比文字），科技感但清晰易读
  - release.sh 接线：MD + HTML 一并纳入发布产物、上传服务器顶层，完成提示给出双链接
  - CLAUDE.md 发布铁律同步：bump 提交步骤补上 CHANGELOG.html
- **command** · 实现 /export 斜杠命令——导出对话到剪贴板或文件 `6492665`
  - 新增 /export 命令（export/index.ts），支持 clipboard/file 目标与 md/json/both 格式
  - 新增 ExportDialog 对话框组件，提供目标/格式选择 UI
  - 在 DialogSwitch 中注册 export 路由，App 层注入 exportConversation 回调
  - DialogType 联合类型新增 "export" 枚举值
  - 将约束型误伤机制排查清单从 todo 迁移到 done（已完成审计）
- **command** · 实现 /debug 斜杠命令——轨迹快照上传 + 诊断信息 + 剪贴板复制 `eeac94f`
  - 上传当前轨迹快照到云端（best-effort，5s 超时）
  - 显示丰富诊断信息（session ID、模型、版本、时长、轮次、token、费用、工具统计）
  - 自动将 Session ID 复制到剪贴板
  - 新增 src/command/commands/debug/ 命令（新体系 UnifiedCommand）
  - TraceCollector 新增 uploadSnapshot() 公开方法（mid-session 上传）
  - TraceCollector 新增 getUploadUrl() 只读访问器
  - UploadManager 新增 getBaseUrl() getter
  - CommandContext/AppContext 接口新增可选 traceCollector 字段
- **command** · 实现 /debug 斜杠命令——轨迹快照上传 + 诊断信息 + 剪贴板复制 `23d61dc`
  - 上传当前轨迹快照到云端（best-effort，5s 超时）
  - 显示丰富诊断信息（session ID、模型、版本、时长、轮次、token、费用、工具统计）
  - 自动将 Session ID 复制到剪贴板
  - 新增 src/command/commands/debug/ 命令（新体系 UnifiedCommand）
  - TraceCollector 新增 uploadSnapshot() 公开方法（mid-session 上传）
  - TraceCollector 新增 getUploadUrl() 只读访问器
  - UploadManager 新增 getBaseUrl() getter
  - CommandContext/AppContext 接口新增可选 traceCollector 字段
- **build** · ripgrep 二进制改为仓库本地化存储，消除构建期联网依赖 `ce2c240`
  - vendor/rg-embed 是 git 追踪的 0 字节占位文件，但每次 make rebuild / release.sh 都会把当前平台真实 rg 二进制拷贝进去覆盖它，导致 git status 必然显示"已修改"，每次都要手动 git checkout 还原，容易忘记/误提交。
  - 4 平台预编译 rg 二进制（共约 18.5MB）只缓存在本机 vendor/rg-<platform> （.gitignore 排除、不入库），换机器/CI/vendor 被清理后就得重新联网下载 公司服务器，release.sh 交叉编译经常要等几十秒下载，且单点依赖服务器。
  - 新增仓库内规范路径 vendor/ripgrep/<version>/rg-<platform>，直接 git 提交 4 平台二进制（约 18.5MB，已用 sha256 核对与服务器一致）。
  - fetch-ripgrep.ts 改为两级查找：优先复用仓库内已提交文件（全程不联网）， 缺失时才回退联网下载，下载结果直接落到该规范路径，方便后续 git add。
  - 新增 --print-version，release.sh 用它读取版本号（避免两处硬编码漂移）。
  - release.sh 交叉编译循环改读新规范路径。
  - vendor/rg-embed 彻底移出 git 追踪（git rm --cached），改为纯本地构建产物； main() 失败兜底：--as-embed 联网也失败时写 0 字节占位，保证 bun build --compile 的固定 import 路径不因缺文件报错（延续原有降级语义）。
  - 连续两次 make rebuild，git status 不再显示 vendor/rg-embed 被修改。

### 修复
- **trace** · uploadSnapshot 未初始化时避免访问 this.metadata `78982a7`
  - 修复 TraceCollector.uploadSnapshot() 在未初始化时（this.metadata 为 undefined）
  - 直接访问 session_id 导致 TypeError 的问题。将初始化检查前置。
- **install** · 修复独立终端找不到 sid-code 命令——RC 文件检测与 PATH 注册逻辑重写 `03d7bee`
  - 区分 macOS login bash（.bash_profile）与 Linux interactive bash（.bashrc）
  - 不再依赖子 shell 运行时 PATH 判断，改为直接检查文件内容
  - 新增 safe_insert 函数，保留原文件权限
  - 新增 sc 快捷命令别名
  - 安全原则：只追加不覆盖、不创建不存在的文件、尊重已有 alias
- **trace** · 修复轨迹上传长期失效——CLI 参数浅合并覆盖 settings.json 的 upload 配置 `b683fc4`
  - cli.ts：仅当用户显式传了 --no-trace/--trace-upload-disabled/--trace-upload-url 等 flag 时才构造 trace 对象，否则返回 undefined 不覆盖文件配置。
  - config.ts loadNewFormatAsConfig：Object.assign 改为一层深合并（嵌套对象合并 而非整体替换），避免 app.json 的部分字段吞掉 settings.json 的完整配置。

### 重构
- review 修复——消除 as any、类型安全、代码位置调整 `b5de269`
  - collector.ts: TraceUploaderInterface 新增可选 getBaseUrl() 方法， 消除 getUploadUrl 中的 as any 类型断言
  - debug.ts: catch (err: any) → catch (err: unknown) 防御非 Error 对象
  - uploader.ts: getBaseUrl() 从字段区移到方法区
  - adapter.ts: toAppContext 补全 traceCollector 桥接（对称性）
  - config.ts: 深合并注释补充说明仅一层深

## v0.1.583 (2026-07-09)

### 修复
- **test** · 修复 change-detector 测试写文件前的 fs.watch 武装时序竞态 `e976106`
  - fs.watch(recursive) 依赖 FSEvents，watcher 建立后需要短暂时间才能就绪；
  - 测试原先 watchDirs() 后立即 writeFileSync，若 watcher 未就绪则本次变更
  - 事件被漏掉。全量测试负载下该竞态窗口命中率明显升高（Bun 1.3.11→1.3.14
  - 升级后自测连续复现）。修复：写文件前先 sleep 50ms 等 watcher 就绪。

### 其他
- **eval,hooks** · 下线 case 生成脚本 + 移除 pre-push 的 bun test 门禁 `75d6ab9`
  - 删除 evals/scripts/import-trajectory-platform.ts / scripts/eval/new-case.ts / scripts/eval/select-real-tasks-30.ts 三个 case 生成/导入脚本（不再需要）
  - scanContamination/scanSecrets 抽到新增 scripts/eval/lib/security-scan.ts， 供 check-real-tasks-pollution.ts / scan-trajectory-secrets.ts 复用，避免连带 删除安全扫描能力
  - pre-push hook 去掉 bun test 门禁段落，保留 holdout 泄露检测 + real-tasks 永封 校验 + dashboard 自动刷新提交
  - 同步更新 evals/README.md / docs/eval/TODO.md / package.json 中对已删命令的引用
  - 删除对应测试 tests/eval/import-trajectory-platform.test.ts

## v0.1.582 (2026-07-09)

### 新功能
- **rg,fallback,test** · 内嵌 rg 升级 v15.1.0 + fallbackSwitchMode 三态 + 测试超时修复 `6bc1c0f`
- **rg,fallback,ui** · 内嵌 rg 最佳努力 + fallback 降级决策引擎 + 选择题单选/多选视觉区分 `d1c94c7`
- **ui,tools** · askUserQuestion preview/notes + Footer 窄屏自适应 + grep 退出码修复 `08d1dd4`
- **ui,commands** · argumentHint 提示系统 + Shift+Tab 权限模式循环切换 `24b5464`
- **commands** · 统一命令持久化机制（-p 标志），扩展 /model 子代理与 fallback 切换 `3090c79`
- 完整默认配置模板 + 首装/更新两条路径安全补全 `dfa399a`
- **ux** · 补全列表回车直接执行 + release.sh 门禁加固 + 清理遗留脚本 `38ad3d3`
- 构建二进制包&规则校验优化 `81fbee9`
- **observability** · 完善子代理错误面板 & side-call 轨迹实时同步 `d89f37a`
- tui界面提供统一错误面板 `88a6e8e`
- **themes** · 语义颜色显式化，修复浅色可读性与消息显示异常 `80f4fa0`
- footer去掉debug显示 `8b136a6`
- 约束型误伤/误判/误导 & 中断/错误处理/静默失败/硬编码分档 一轮修复 `3c90e09`
- 实现 Agentic Loop 查询模型、输出停顿检测与 token 预算续接，增强会话存储与恢复 `68a19e7`
- Agentic Loop & Human-in-the-Loop 对齐 `1626b00`
- 清理过时文档 `0fc608d`
- 更新设计方案 `2f7f306`
- OpenAI Responses API 支持 (A3) 与多模块增强 `8bd8043`
- 六、Sprint 3 详细 Todo-List（架构投资） `79e2f89`
- 五、Sprint 2 详细 Todo-List（加固防线） `98fc5f6`
- **provider** · 多层超时防护体系与可观测性增强 `b843cea`
- 工具质量和稳定性优化 `bdaaacb`
- 可观测性缺口 — hang 死场景诊断盲区与改进方案-实现 `eace5e6`
- 可观测性缺口 — hang 死场景诊断盲区与改进方案-实现了一半 `53b6198`
- read工具优化 & 方案设计 `0dfa063`
- 优化grep工具 `ad25e89`
- Anthropic 协议族兼容性全面修复计划 & 状态同步隐患修复 `60420c8`
- 折叠优化&子代理超时优化 `bd64d65`
- openai协议族兼容性处理 `e0c7fbe`
- 删除 OSC 9;4 进度环 `e8db6f0`
- 优化没有配置key报错，增加引导 `59aec6f`
- 内容截断检测优化 `8fac619`
- 子代理超时 `c6f714f`
- 代码优化 `db1c9ca`

### 修复
- 高危 — 粘性开关脱同步(状态栏撒谎) & 2. 中危 — auto 是「死档」 `fdabd4f`
- **config** · 团队默认配置占位符 Key 静默失败改为启动即报错 `aab0cff`
- **llm** · 伪装成功的空流静默失败 — 四层纵深防御 `1b96a6f`
- /goal 执行过程问题排查 — glm-5.2 会话 20260707 -第三轮修复 `d3a2f61`
- /goal 执行过程问题排查 — glm-5.2 会话 20260707 -第二轮修复 `e9eac52`
- /goal 执行过程问题排查 — glm-5.2 会话 20260707 -第一轮修复 `d91c18b`
- 修复测试报错 `adc0ef9`
- **agent/mcp/llm** · 修复共享 AbortSignal 上事件监听器泄漏，扩展 abort reason 白名单 `a4a9ad2`
- 孤儿 Stream Snapshot 跨 queryLoop 污染看门狗 `4539278`
- **provider** · 补齐 OpenAI 族缓存命中字段兜底链 — Kimi 顶层 cached_tokens `109ad9f`
- **provider** · OpenAI/DeepSeek 缓存命中率修复 — 按 DYNAMIC_BOUNDARY 拆分静态/动态区 `8bccf82`
- **ui** · 修复 compact 摘要与 reattach 锚点泄漏到 TUI `53e1594`
- DeepSeek 思考链走 content 通道泄漏为正文 → 任务"假性中断 `e9f6c30`
- 优化clear命令残留 `376c6aa`
- 密钥丢失 bug,用户的密钥被抹掉了 `1efc647`
- 截断检测仅覆盖文件时生效 + 补充副作用分析文档 `ee06bce`

### 重构
- **agent/query/llm** · 收敛超时配置体系，默认关闭循环检测并移除 partial-read 保护 `2ec6dc5`
- **ui** · 提取 DialogSwitch 中枢，统一对话框调度 `5f6ea63`

### 文档
- CLAUDE.md 明确发布铁律——先提交功能代码再发布再补 bump 提交 `c6ab9de`
- 更新文档 `002b340`
- 更新文档状态 `6fcaed8`

### 其他
- 添加 rebuild 目标 + 开发/发布/更新三线流程文档 `faa0c0d`
- 更新文档 `bb6520f`
- 更新文档 `0267010`
- doc: Provider 层生产级稳定性优化 — 实施路线与 Todo-List `d9033d9`
- 可观测性缺口弥补 `8d278b3`
