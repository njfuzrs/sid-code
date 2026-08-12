# Changelog

本文件由 scripts/generate-changelog.ts 自动生成，请勿手改。

## v0.1.600 (2026-08-06)

### 新功能
- **release** · 发布/文档地址切到 <链接已省略> 并补存量配置迁移 `c89461bf`
  - update.ts 的 DEFAULT_RELEASE_HOST 升为 DEFAULT_RELEASE_ORIGIN（host → origin， 因为本次要害是 https；env 覆盖传裸 host 默认补 https，带 scheme 则原样用）
  - install-template.sh 的 RELEASE_BASE、team-defaults 模板的 searxng/traj 地址
  - 拆开 DEPLOY_SSH_HOST 与新增的 PUBLIC_BASE_URL：前者仅 scp/ssh（走 IP 更稳）， 后者派生所有对外 URL（必须域名+证书）。原先一个变量兼两职，取值天然冲突。 release.sh 生成 install.sh 的 sed 目标随之改为 origin —— 这是安全边界， 保证 SSH 目标不会泄进用户 curl 的脚本
  - fetch-ripgrep.ts 下载根不再从 SSH host 派生
- **tool** · 增加工具结果展示档位并补齐文档说明 `f7a837f5`
  - 为工具结果新增 hidden/summary 两档 TUI 展示策略，
  - 避免把仅供模型消费的提示词与内部状态直接泄漏到消息流。
  - 补齐主执行器、子代理执行器、history/UI 适配链路，
  - 并为 todo_write、tool_search、plan mode、task 工具等
  - 声明合适的展示档位。
  - 新增展示档位审计测试，并更新 prompt cache、JIT 上下文、
  - 成本与术语相关文档，补充最新实测数据与交叉引用。
- **website** · 博客列表页与元信息改版 `686e8ccc`
  - BlogIndex 卡片列表重做，新增渐变背板与源码引证计数（构建期统计）
  - 新增 BlogRelated.vue 相关文章推荐、feed.ts RSS、site.ts 站点常量
  - BlogMeta 元信息展示扩充，brand.css 补配套样式变量
  - blog/index.md 三条自我约束从 bullet 列表改为并排卡片带，文字未改
- **model** · 拆分本地别名与厂商真名，同一模型可接多渠道 `3703efe5`
  - 别名侧（问「哪一条配置」）：模型选择、/model 显示、fallback、计价、审计
  - 真名侧（问「这到底是什么模型」）：HTTP 请求体、thinking/effort 能力判定、 内置注册表兜底、探针请求与去重

### 修复
- **stream** · 分离首字节与心跳超时并接通网络配置 `fdc4e937`
  - 为流式处理增加首字节专用超时，避免网关排队期被心跳阈值误杀
  - 从 network profile 派生主循环与子代理默认超时，并透传 settings 配置
  - 修正超时重试遥测的真实耗时，并补充首字节与心跳超时回归测试
- **website** · 修复博客页面布局跳动并简化列表信息 `2b74e5c3`
  - 移除博客列表页无决策价值的全站统计、宣言和页脚导航
  - 保留逐篇文章的阅读时长与源码引证信息
  - 使用 scrollbar-gutter: stable 消除短页与长页切换时的侧栏位移
  - 统一博客卡片与标签的视觉层次，并删除无用统计聚合代码

### 重构
- **website** · 合并博客文章页底部导航并精简信息 `f5e1d7ec`
  - 合并文章页元信息、系列导航和相关文章为统一页脚，按 URL 去重并保留最多两条继续读链接。
  - 关闭文章页重复的最后更新与默认翻页，避免与系列阅读顺序冲突。
  - 补充 prompt cache 相关文章链接。

### 文档
- summary 笔记入库，北极星现状刷新至 2026-08-05 `37dd3410`
  - .gitignore 解禁 docs/summary，本地笔记转为入库追踪
  - CLAUDE.md 北极星现状更新：TTFT 已有纯净埋点（p50 4.7s / p95 23.0s， 1032 样本），此前「几乎无 latency 基线」的描述已过期；补记「沿用文档 现状而不回源码核验会把已修问题当缺口重复上报」的方法论教训
  - 新增 3 份 todo 清单：可观测性缺陷（埋点接线与 OTLP 出口）、 可观测性接线率门禁、模型别名与真名分离实施记录
- 文档目录重组——todo 已结项归档、reference 研究类重归类、blog 规划页删除 `981b0bf6`
  - bugfixes/todo → done: 归档 9 个已完成项（可观测性指标体系、一键迁移研究、 审计 3 篇、官网覆盖度核对报告）
  - reference → research: opensource-browser-automation-tools-comparison.md 重归类为研究类文档
  - reference → bugfixes/todo: 官网与文档站设计方案（仍在进行中）
  - security-audit → bugfixes/todo: prompt 注入审计（仍在进行中）
  - 删除 website/blog/series-plan.md（已发布为博客，规划文档不再需要）
  - docs/reference/install-guide.md 删除（已过时）

### 其他
- doc: 更新llms.txt `78b76fff`

## v0.1.599 (2026-08-04)

### 修复
- 参考页重新生成，llms.txt 页数更正为 43 页（新增博客系列规划页） `1c008a5d`
- 修复 TUI 刷屏并调整构建与会话限时默认值 `237eea4e`
  - 将编译产物固定为 React production build，避免 development build
  - 输出 Maximum update depth 错误刷屏。
  - 解耦 Ink 的 stderr 拦截与 console patch，补充 TUI console 护栏、
  - alternate-buffer 判定可观测性及相关回归测试。
  - 默认关闭会话级总时长硬顶，保留显式配置入口和既有进度超时防线，
  - 并同步发布脚本、headless 文档与排查记录。
- **test** · 单测污染用户遥测数据隔离根治 + cache 聚合修复 `0c5e5e7d`
  - 全局 preload 兜底（tests/preload-isolate-sid-home.ts + bunfig.toml）
  - 进程启动时把 SID_CONFIG_DIR 默认指向临时目录
  - 针对调用链深处无参构造（如 PermissionChecker 里 new AuditLogger()） 这类测试作者看不见的污染，让隔离成为默认值
  - 显式隔离补齐
  - cache-detection / clear-resets-cache-state 补 SID_CODE_CACHE_BREAKS + 微任务 flush（落盘走 import().then()，同步恢复 env 会赛跑）
  - crash-marker / pid-manager 改 getSidHome() 派生，不再硬编码 homedir()
  - flag-e2e 显式传 SID_CONFIG_DIR + debug_log_file（子进程不继承 env， 且 debugLogFile 默认值是字面量不走 getSidHome()，曾每跑截断用户 debug.log）
  - 6 个无条件 delete SID_CONFIG_DIR 改存/恢复（同批多文件共享进程， 直接删会抹掉 preload 兜底）
- **stream** · 流重开事故根因修复——stream_restart 作废广播 + empty-param 连坐 `b9979fd7`
  - stream_restart 事件 + 四处消费者清空累加器
  - 新增 StreamEvent.stream_restart（types.ts），判据取 provider 显式信号
  - fallback.ts 五个重开点（重试/401/降级/非流式/纵深防御）广播作废
  - stream-handler.ts 降级路径广播作废
  - 四处消费者一致清空：query/stream-processor、agent/stream-processor、 forked-agent、headless，usage 不回退（作废 token 真实计费）
  - stream-processor 末尾标记未收尾 tool_use 为 _truncated，区分传输截断与模型退化
  - app.ts 接线 onStreamRestart 撤回屏幕已渲染文本 + 清抢跑缓存
  - empty-param 连坐替换：本轮一旦有退化块，同响应所有 tool_use 一并降为 text
- **model** · 完善模型切换与 effort 档位治理 `a1b6be7f`
  - 切换或恢复模型时归正无效 effort 档位，保持显示与实际下发一致
  - 根据 thinking 状态提示 effort 是否生效，并同步可扩展 agent registry
  - 增加模型名大小写提示、fallback 自降级及重复端点告警
  - 标记同名模型不可达条目并补齐相关回归测试
- **core** · 补齐工具失败闭环与交互状态治理 `34ce2312`
  - 为主循环和子代理补齐工具失败的 PostToolUseFailure 收尾及耗时追踪
  - 接入失败工具 telemetry span，覆盖 hook 阻止、权限拒绝和参数校验失败
  - 增加瞬态错误与粘滞状态的自动清理，完善重试恢复提示
  - 为 LSP 等工具接入阶段进度，并统一工具卡片进度路由
  - 完善模型分组、严格模型门禁、语言与 effort 对话框及路径显示
  - 补充诊断、hook 配对、模型、UI 与工具进度测试并更新参考文档

### 文档
- **blog** · 新增博客系列规划文档 `7d9df7e8`
  - 六个系列 23 篇选题，按北极星方向组织：上下文工程（2 篇已发 + 3 篇）、
  - 数据与度量（3 篇）、Agent 架构（3 篇）、安全与权限（3 篇）、TUI（2 篇）、
  - 工程踩坑（5 篇）。附带三档优先级排序和从已发布文章提炼的写法约定。
- 落地记录 + 开源准备 P0-1 复评 + prompt-cache 博客 `387c36b8`
  - 单测污染方案 todo→done：追加 2026-08-04 落地记录，六项清单全部 ☑， 含与原方案的 5 处偏差（基线漂移、微任务 flush、聚合 bug、preload 兜底、 flag-e2e 截断 debug.log）及第 6 项排查结果
  - 开源准备 P0-1 复评：纠正 ink 来源判定（cc 的 src/ink 是 MIT 上游 ink 的 fork，非 Anthropic 自研），暴露面从 21000+ 行下调到 4000~5000 行， 问题性质从「照搬专有代码」下调为「MIT fork 归属声明有瑕疵」， 新增路径 D（归属化 + 依赖替换 + 删死码），路径 A/B/C 标注已否决/降级
  - prompt-cache 博客：283 个会话 4.2 亿输入 token 的命中率账本， 含 Anthropic/OpenAI 两族协议分叉实现与实测数据
  - llms.txt 索引更新（41→42 页）

## v0.1.598 (2026-08-03)

### 新功能
- **llm/agent** · 子代理重试循环收敛到唯一韧性漏斗 streamWithResilience `77444e94`
  - 新增 src/llm/resilient-stream.ts：封装「漏斗 + 退避心跳 + 快照清理」的入口
  - agentic-loop.ts：删除 sleepWithAbort/turnAbort/独立超时，声明 querySource + switchMode=auto + availability 三项，韧性能力由漏斗统一提供
  - forked-agent.ts / headless.ts：接线 streamWithResilience（headless 上界压 3）
  - sub-agent.ts：内置/自定义/总结轮传递细分 querySource（agent:builtin/ agent:custom/agent:summary），遥测可归因到路径
  - fallback.ts：content_block_start 也算"有内容"，修复无参工具调用被误判空响应 → 白重试 N 次后转 fallback
  - fallback.ts：无法分类错误不重试直接转 fallback（fail-fast），避免确定性 故障烧掉 maxRetries × 退避才放弃
  - fallback.ts：重试耗尽文案补回真实根因（lastRetryError/reason），不再只报 "已达最大重试次数"——子代理侧尤其致命，会被包成"超时"带偏排查方向
  - agentic-loop.ts：快照清理移到退避之前，避免最长 120s 退避期旧快照存活 误导 collector 的 still_progressing 判据
- LLM 韧性 per-call 化 + 工具增量翻卡 + JIT 博客重写 `820ee1c9`
  - 新增 keepalive fetch 包装器，fallback 开关动态注入 fetch 选项
  - 降级状态从实例字段搬到 per-call context，修复并发子代理互相干扰 （单实例 hasFallenBack 置位后静默拒绝其它代理降级）
  - 新增 PerCallOptions per-call 覆盖，未传字段回落 config
  - 删除生产不可达死代码（CONNECTION_RETRY 循环、PERSISTENT_HEARTBEAT_MS）
  - 新增 liveToolSettledSink 侧信道，并行批次内工具完成即翻卡， 不等同批次最慢的兄弟
  - history-adapter 导出 buildCompletedToolCall 供侧信道与权威路径 共用，消除两套渲染导致的视觉跳变
  - JIT 上下文博客重写：补实测基线、中文标点吞 @import 缺陷、 追加式注入收口下沉到 setSystemPrompt
- **language** · 重构语言偏好系统，区分 auto/unset 并支持 CLI/环境变量 `62b27904`
  - 新增 prompt-lang.ts 收口语言类型与归一化：auto（跟随用户输入语言） 与 unset（回落缺省中文）语义分离；normalizeLanguagePref 兼容 zh-CN/ English 等写法；resolveLanguageFromEnv 兼容 SID_LANGUAGE 与 SID_CODE_LANGUAGE。
  - 新增 --language CLI 参数与 SID_LANGUAGE 环境变量，优先级 --language > SID_LANGUAGE > settings.json > 缺省(中文)；--language 非法值报错退出，环境变量非法值静默忽略（残留 env 不该打断启动）。
  - 子代理语言归一化：resolveEffectiveLanguage 把 auto 解析成具体语言， 子代理拿到的永远是确定值（不再各猜各的语言）。
  - en 模式语言约束改用英文撰写（旧版"均使用英文"是中文语境命令模型 说英文，压力方向反了），并加 FORMAT OVERRIDE 处理内置 agent prompt 里的中文小节标题，避免英文报告里插入中文标题。
  - internal_en 标签剥离：把模型夹在正文里的英文 thinking 剥出来， 防止污染输出语言。
  - 同步重写 /language 帮助、官网参考页（cli/settings/slash-commands） 与配套测试。
- **ui** · think 工具展示思考正文，header 补用途标签 `ed4e2609`
  - ui-utils.ts 新增 getThinkThought 提取思考正文；getToolSummary 补 think 分支给出首句摘要，按 stringWidth 列宽截断（中文占 2 列， 沿用码点数上限会撑爆 header）；getResultSummary 对 think 返回空串， 避免兜底算出「6 字符」这种描述确认语本身的假指标
  - ToolMessage 结果区改渲思考正文，走 SlicingMaxSizedBox 同步折叠 （Static 安全），折叠档 8 行并复用 ctrl+o 阶梯展开；header 改用 「思考记录」用途标签，与下方正文分工不重复
  - 空思考仍走既有 isError 渲染路径，错误可见
- 补齐重试自愈与发布流程门禁 `7ba9b582`
  - 为子代理流式调用增加可重试错误处理、指数退避和可中断等待，
  - 并与主路径共享退避计算逻辑。
  - 收敛上下文超限判定，接通模型能力缓存、未知模型 effort 自愈、
  - 非流式能力自愈和 `/model discover` 的缓存查询。
  - 完善发布脚本的失败回滚、工作区洁净门禁、上传原子性和版本 tag
  - 对齐校验，补充编译产物自检与跨平台 ripgrep 状态清理。
  - 新增全量 CI 门禁及重试、能力接线、发布流程回归测试，更新修复
  - 记录和环境变量参考页。

### 修复
- **build** · 自检成功输出从 stderr 改走 stdout + 绿色，消除红色误导 `af16dac4`
  - self-check.ts: 全部通过时走 stdout + 绿色 ✓，失败才走 stderr + 红色 ✗ 非 TTY（管道/CI）不输出 ANSI 转义码，避免日志残留 [0m 乱码
  - self-check.ts: 去掉内部编号（方向 1、方向 2/4/6），精简面向用户的措辞
  - Makefile: 删掉与自检重复的 echo 标题行
  - embed-builtin-skills.ts: 去掉 per-skill 列表噪音，只留总结行
- **tool** · 统一工具 schema 参数命名为 snake_case，根治跨工具类比死循环 `f2aeb347`
  - lsp 工具用 filePath，write/read/edit 用 file_path，模型在两者同时可见时发生
  - 跨工具类比错位，写计划文件连续 13 次参数名写错陷入死循环（轨迹
  - 20260803-142835-b8c52ec4）。全仓库普查发现命名不一致覆盖 11 个文件 16 处
  - 字段，全部统一为 snake_case；协议边界之外的内部数据模型（TodoItem 持久化
  - 快照、CronTask 磁盘格式、TeammateSpec swarm 内部字段）保持不变，仅在
  - execute() 入口做桥接，避免级联到下游 UI/持久化消费者。
  - 新增 tests/tool/schema-naming-convention.test.ts：动态发现全部工具文件、
  - 括号平衡定位 schema 字面量、零例外白名单断言 snake_case，防止新工具再引入
- **agent/llm** · 韧性层 B0-B6 对齐 —— 权限 P0 缺口修复 + side-call 韧性统一 `f633990d`
  - permissionChecker 从 AgentLoopConfig 可选字段改为必填，漏传变编译错误
  - 抽取 buildBaseLoopConfig 工厂收敛两条 runAgentLoop 路径公共字段， 修复自定义子代理路径漏传 permissionChecker 导致权限层整体绕过的 P0
  - tool-executor 分级 fail-closed：无检查器时只读放行、写类操作拒绝
  - 6 条 side-call 路径统一走 streamWithResilience，与主 fallback 引擎共享 terminal 错误拉黑，429/523 不再 1ms 即失败 路径：goal/evaluator、hook/runner、memory/recall、auto-compact、 context-collapse、partial-compact
  - 新增 permission-fail-closed 回归 + 分类器调用方安全边界钉点
  - 修 withMockSpawn 异步范围（await fn() 再还原 mock）
  - 修 B6 gates wall-clock flaky（断言 slot 分量非完整 delayMs）
  - app.ts 401 认证刷新比较逻辑修复（分别比较两 key，不再 ^@ 拼接）
- **ui/agent** · 子代理进度内嵌工具卡片，后台任务驱逐体验对齐 CC `35fcce58`
  - 解除 isShell 门槛改为按事件类型路由（ui/tool-progress-route.ts）， 避免"按工具名注册"这种一改就漏的耦合
  - sub-agent.ts 增 _onProgress 回灌通道，把子代理每轮进度实时推给 父工具卡片（前台）；registry 仍供后台任务面板消费，两路并列不冲突
  - 三档降级渲染（ui/agent-progress-view.ts）：逐条活动 / 一行计数 / 多代理每行一条，按屏幕高度和并行数自适应
  - recentActivities 滑动窗口补齐（MAX_RECENT_ACTIVITIES=3），填掉 此前恒为空数组的死字段
  - 按帧合并重渲，避免并行多子代理逐条触发重绘
  - EVICT_GRACE_MS 60s → 30s，对齐 CC PANEL_GRACE_MS
  - 新增显式 dismissed 字段 + Ctrl+X 手动批量划掉终态任务
  - killed 状态独立 3s 展示窗口，8 处终态写入统一走 graceDeadlineFor(status) 消除硬编码漂移
- **agent/task** · 消除前台子代理重复渲染并补齐翻卡测试 `7f28843e`
  - 为前台 sub_agent 增加显式面板可见性，统一后台任务过滤口径。
  - 抽取侧信道翻卡逻辑并补齐面板闸门、实时翻卡回归测试。
  - 更新 TUI 子代理问题排查文档，记录问题二的二次校验闭环。
- **llm** · 补齐 B6 韧性门槛并记录测试隔离缺口 `86856cf5`
  - 增加共享限流冷却下限，补齐 B6 的 S1–S4 门槛测试
  - 更新韧性层方案文档，记录落地证据、实测数据与边界
  - 记录缓存遥测测试污染的根因及隔离治理方案
  - 移除已完成验证的临时探针脚本
- **permission** · 键盘循环跳过逻辑提取共享，修正漂移的测试与文档 `ae9b0cb3`
  - 提取 getNextKeyboardPermissionMode 到 permission/mode.ts，app.ts 与测试共用。 企业策略门控作为参数注入，保持纯函数可直接单测。
  - 测试改为调生产函数，序列断言更正为 default→acceptEdits→auto→default （bypass 可用时多一档 always-allow）；补一条反向断言钉住「acceptEdits 下一档 必须是 auto」——少了它，未来把 auto 加回跳过列表时旧断言依然全绿； 另补企业策略禁用某档时的跳过用例。
  - permissions.md 更正顺序，并写明 plan 是独立状态机、always-allow 只在启动时 开了 -y/--yes 才进循环（启动快照，不随会话漂移）。plan-mode.md 原本就是对的，未改。
- **hook/docs** · 消除 hook 配置的三处假信号 `be59c84f`
  - src/config/schema.ts 的 VALID_HOOK_EVENTS 是一份手写的 12 条 snake_case 清单，而 registry.resolveEventName 对 PascalCase 与 snake_case 都认 （37 个枚举成员 + 25 条 LEGACY_EVENT_MAP 别名）。用户按 ref/hooks.md （从枚举生成，全 PascalCase）…
  - registry.initializeFromLegacy 对形状不合法的 hook 是裸 continue—— 静默丢弃，加载不报错不打日志，配置看着没问题 hook 就是不触发， 是最难自查的一类错。最常见的错法是照抄 agent frontmatter 的嵌套形状 {matcher, hooks:[...]}（settings.json 要平铺）。现在会点名缺哪个字段， 嵌套时直接说破。
  - ref/hooks.md 的「预留」判据是注释关键词匹配，漏标 6 个：注释还有 「先占位」这类同义写法。改为按「hook 层外有无 fire<Event>Event 调用方」 判定，17 接线 / 15 未接线（与源码实测一致，此前 23/9）。 表头新增「配置里写」列（snake_case，可直接抄进 settings.json）与 「会触发」列——「名字合不合法」和「配了会不会触发」是两个…
- **llm/agent** · B5 归因与门槛修正 —— 消除 7 处排查误导 `308419cd`
  - B5-1 agentic-loop 补 model_context_window_exceeded 分支：撞上下文上限 此前穿透到「未知停止原因」误报「模型不可用」（模型是好的，是上下文顶满）。 改为与主循环同源的压缩后续写，压不动即如实失败，续写有 2 次上界防空转。
  - B5-2 classifyError 收纳截断类错误：unexpected end of JSON input / Premature close 等归到 network_error。注意是修分类器本体而非放宽子代理 门槛——后者会把主路径「裸 Error 也重试」的缺陷扩散过去。
  - B5-3 parseXShouldRetry 改三态（boolean | undefined）：此前「服务端说别 重试」与「header 不存在」压成同一个 false。网关用它表达「这个 key 就是 错的」时我们照样打满 10 次退避，最坏白烧 ~20 分钟。
  - B5-4 AgentLoopResult 加 retryAttempts / lastRetryReason：超时路径此前 整句丢弃 errorMessage，限流重试耗尽会被报成「超时」，排查方向被带去查 网络配置而非限流。
  - B5-5 frontmatter timeout 钳制到 [10s, 600s]：此前无上限，写个超大值就 能把单个子代理最坏墙钟拉到 11 天（「有界」这个安全性质由外层超时提供）。
  - B5-6 具名 SUBAGENT_DEFAULT_MAX_TOKENS：保留 4096 并给出依据——注册表 非零 maxOutputTokens 的最小值恰为 4096，故不会触发 max_tokens 越界。
  - B5-7 FallbackConfig.onAuthRefresh + app.ts 注入：401 从「用旧凭据重试 一次」升级为「重读凭据源 + 清 provider 缓存」。凭据未变则返回 false， 绝不谎报刷新成功。needsAuthRefresh 闸门保留（防无限刷新循环）。
  - ModelFallback 构造函数逐字段手抄，漏了 onAuthRefresh —— 钩子注了但永不 被调用，正是本批次要消除的「看着有能力、实际没有」形态。
- **agent/worktree** · 修复并发隔离与孤儿 worktree 清理 `779e7bd0`
  - 隔离并行子代理的流快照与重试遥测，补齐 teardown 和事件消费。
  - 修复 symlink 被误判为用户改动、未跟踪文件被 GC 忽略的问题。
  - 增加并发隔离、遥测、symlink 防污染与启动期回收回归测试。
- 补齐任务追踪与跨平台运行能力 `7171d494`
  - 补齐 todo 清单实时提醒、终态持久化和进度追踪埋点，避免跨用户消息重复记录。
  - 修复重试退避的中断响应，补充 grep 类型别名与 shell 输入处理能力。
  - 增加 Linux、Windows 防休眠和睡眠检测，完善相关测试及修复文档归档。
- **harness** · 修复模型契约、假设机制与工具输入校验 `64027ef5`
  - 补齐 strict JSON Schema 对 record 字典的兼容性降级，并将 strict
  - 契约中的 optional null 归一为未提供，避免工具参数校验失败或被
  - coerce 静默污染。
  - 为 sub_agent 增加模型白名单校验，明确 Responses API 协议优先级，
  - 修复假设机制的默认开关、复核水位和空转裁决，并放行只读假设工具
  - 的无头权限。同步更新工具描述、环境变量帮助、依赖锁文件和回归测试。
- **todo** · 修复清单实时提醒与终态进度追踪 `bbac459b`
  - 按任务内容配对清单差异，避免插入、删除、重排导致误报或漏报
  - 改用消息历史扫描提醒节流，跨用户消息保持提醒能力并补齐可观测性
  - 保存全部完成后的终态清单，确保进度快照与推进事件完整落盘
  - 补充 todo 工具、提醒扫描和实时集成测试
- **ui** · 输入框边框色改用 mixToContrast 派生，修复层次反转 `c562de4a`
  - 新增 mixToContrast(color, bg, targetRatio)（color-utils.ts）， 二分求解 + 缓存，每帧调用不重复算；6 套主题实测收敛 2.58~2.59
  - 边框与 > 提示符统一的是色相不是色值：提示符满强度点睛（7.79）， 边框弱化到结构层（~2.6），构成同族递进
  - 反向搜索框走 modeBorderColor() 压到 2.6，保留模式色相
  - CLAUDE.md 补"弱化档从 token 派生"规范 + 反例正例
  - 回归测试锁上下界、层次不反转、色相同族
- **todo** · 防止完成清单后重复输出报告 `4f842cd1`
  - 将 producedSubstantialText 传入完成度提醒，明确禁止重述已交付内容。
  - 调整 TodoWrite 全部完成提示为条件分流，避免无条件要求汇总。
  - 增加重复输出回归测试，并同步相关缺陷清单。

### 文档
- **website** · 首页补 sc 全放行警示，worktree 清理写明数据保护 `33c12eca`
  - 安装脚本会往 rc 文件写 `alias sc='sid-code --dangerously-skip-permissions'` （dist/release/install.sh:242），即改文件、跑命令一律不问。安装页第 80 行 有这条警示，但**首页**把 `sc` 当推荐启动方式且完全不提权限——首页是绝大多数人 唯一会看的一页，等于默认让新手在自己仓库里全放行。首页现在并列给出…
  - `/worktree clean` 原文只说「你命名的不碰」「锁住的跳过」，读者最担心的 「临时 worktree 里我还没提交的改动会不会一起没了」没有答案——而列表里恰好有个 「✎未提交」标记，更让人悬着。现在正面写出四条保护（阈值 + 6 小时宽限期 / 无未提交改动（含未 git add 的新文件）/ 无未推送 commit / 未锁定且非活跃会话）， 并说明判定失败时保守跳过。
- **website** · 排障页补症状索引与「卡住不动」条目 `2e1f6944`
  - 来排障页的人正卡着，没耐心顺序读 240 行，而 sidebar 只能看到 5 个小节名
  - （「行为不对」看不出覆盖了什么）。在 /doctor 之后加一层症状级索引，
  - 把 17 条症状按「你遇到的」映射到小节。
  - 补「它卡住不动了」这条——此前全站只在日志开关那一段提过一次「卡住」，
  - 而这是最常见的求助场景。给了一张「真卡住 vs 在等你」的分辨表
  - （有确认框 / token 在涨 / 完全静止 / 反复重试，四种现象四种处置）。
  - Hook 不触发那条从一句「/hooks list 看是不是被禁用了」扩成四步排查，
  - 把最常见的根因（写成嵌套形状）放在第一位，并接上刚加的加载告警。
- **website** · 博客升为独立顶层入口 + 导航结构对齐 `205a1e3d`
  - 博客独立成 Tab 与独立 sidebar：它与文档是两类内容（文档讲怎么做， 博客讲为什么这么设计 + 实测数据），不是难度递进关系。折进「指南」 下拉会少一层曝光，且顶栏高亮归到「指南」，读者在文章页会以为还在文档里。
  - 文档 → 博客的引流改走正文「相关」段（use/context、use/memory、 start/next、首页），带一句「为什么值得读」，比 sidebar 里一个光秃秃 的标题更能让人点进去。
  - 「指南」下拉 8 条与 GUIDE_SIDEBAR 8 个分组一一对应、同序（原先漏掉 「出问题时」，等于顶栏声称的目录比实际内容少一块）。
  - llms.txt 章节顺序改为与顶栏同序（原按目录名字母序，「开始」排第 4， 模型会把入门内容当成靠后的补充材料）；blog 单独成章节不并进「指南」。
  - extend/index.md 选择表补 Workflow / IDE 集成两行（原先它自称是这一层 的路由器却漏了这两页，两页正文入链数为 0～1）；同时删掉「五条扩展路径」 这个会随表格增删漂移的数字，改按「教它新本事 / 接进现有环境」两类描述。
  - 404 文案不再写死 Tab 名（曾写「从入门页开始找」，Tab 改名后就在指路到 一个站上不存在的地方），改指顶栏搜索框。

### 其他
- **ui** · 输入框只画上下横线，避免复制带入竖线 `a9bdd22f`
  - InputArea 三处边框统一走 INPUT_BORDER_PROPS（single + 去左右边框）， 可用宽度相应从 termWidth-4 改为 -2（不再扣竖线，只扣 paddingX）
  - 边框色改 theme.text.primary，与 footer 当前模型名同色：品牌色 ui.active 在通宽下抢走输入内容的视觉重心，border.default 又糊进背景。 取色走 inputBorderColor() 惰性求值，否则模块级常量会让 /theme 切换暗亮后边框仍是旧色
  - src/ui/CLAUDE.md L2.2 补两条规则：用户会复制的区域不画竖线； 通宽横线的字形与颜色取值边界

## v0.1.597 (2026-07-31)

### 新功能
- **llm** · 模型能力动态采集与 GPT-5.x effort 接线 `b419c2b5`
  - 新增 model-capabilities.ts：外部目录同步 + 服务端探针 + 400 自愈， 实现"用户只配 name/endpoint/apiKey 就能用"
  - effort.ts openai-responses 从 applyNoop 改为 applyOpenAIResponses， 5 档原样透传（含 xhigh），该族当前唯一原生认 xhigh 的协议族
  - 未知协议族模型：从"不支持 effort"改为乐观放行 + 400 自愈兜底， 避免"出一个新模型改一次代码"
  - 注册表新增 GPT-5.6 三档（luna/terra/sol），contextWindow=1_050_000
  - App 新增 maybeProbeUnknownModel 探针入口，fire-and-forget 不阻塞
  - 测试同步更新，新增模型能力缓存隔离（beforeEach 重置）

### 重构
- **build** · 重命名构建目标，make build 不动版本号 `2a14b603`
  - make build 改为日常开发构建（不动版本号），替代旧的 make rebuild
  - 新增 make build-bump 目标，显式 bump 版本号再构建
  - make rebuild 保留为 make build 别名（兼容历史文档）
  - 更新所有文档/脚本/源码注释中的 make rebuild → make build
  - 修复 CI 构建命令（eval-pr-smoke.yml）
  - 新增 tests/build-target-naming.test.ts 测试

## v0.1.596 (2026-07-31)

### 新功能
- **website** · 新增「文章」板块 + 首篇《JIT 上下文》 `4b80ad73`
  - website/blog/ 放文章 md，/blog/ 为列表页
  - .vitepress/blog-meta.ts 为元数据唯一事实源（扫目录，不手写清单） sidebar 与列表页共用它，两处顺序/标题不会各自漂移
  - BlogIndex.vue 列表卡片 + 标签筛选；BlogMeta.vue 文章页元信息行 （日期/阅读时长/标签自动渲染，作者只写 date 与 tags）
  - 列表页 search: false —— 否则每篇文章在搜索结果里出现两次
  - llms.txt 新增「文章」段落分类

### 修复
- **jit-context** · 补齐第 5/7 批缺口 + 轨迹采集 P0 修复 `b99c0e9f`
  - 第 5 批：JIT 埋点——子代理侧打点（sub-agent.ts）、主循环埋点
  - 下沉到 trace/jit-telemetry.ts、JIT 度量聚合（digest.ts）
  - 第 7 批：作用域基准分层——managed/user/userRulesDir 层用
  - originalCwd 基准（rules.ts）；bash 写文件触发 JIT（bashWriteTargets）
  - P0 修复：uploader.ts outputDir 显式 undefined 覆盖默认值
  - 导致轨迹采集静默失效
- **hypothesis** · 缺口7第3条——GoalGateDecision/TimerDrift/WatchdogKill 补 absoluteTurn/promptSeq 统一轮次口径 `05c9b9dd`
  - goal-gate.ts：GoalGateContext 加可选 absoluteTurn/promptSeq， emitTraceEvent 注入时落 absoluteTurn，未注入降级为原 turn（向后兼容）
  - stream-observer.ts：emitTimerDrift/emitWatchdogKill 签名各加两可选字段
  - loop.ts：4 处调用点传参（handleGoalGate 1处 + emitTimerDrift 2处 + emitWatchdogKill 1处），都传 sessionState.getAbsoluteTurn() + promptSeq
- **hypothesis** · 修补假设纪律机制八缺口（翻案/证据方向/事件驱动注入/埋点/轮次支撑） `ef97b0c9`
  - 缺口1：翻案机制（confirmed→reopen，上限 2 次，challengedAfterConfirm 永久留痕）
  - 缺口2：交付物缓冲与 ledger 同寿，/clear 一并清理
  - 缺口3：事件驱动注入（turn-1 降级极简，judgment 引导紧贴判断时机）
  - 缺口4：证据方向三分（supporting/refuting/neutral），neutral 为缺省落点
  - 缺口5：cue 词频抑制（SESSION_CUE_FREQ_THRESHOLD=6）
  - 缺口6：翻案文案措辞优化（不触发自我批判）
  - 缺口7：strategicNag 文案从泛化改为特指
  - 缺口8：HypothesisSettled 埋点 + 真实轮次取值器（延迟接线）
- **jit-context** · 补齐 JIT 上下文对标 CC 的第 0/1/2 批缺口（P0-2 + P1-1~7 + P2-2/7/8/9） `d29061fa`
  - P0-2 符号链接出项目外泄露：realpath 解引用与路径段比对**叠加**，且向上遍历 每一步都重新 realpath（只在入口解一次挡不住「入口在项目内、祖先链爬出去」）； visitedDirs 防 symlink 环。边界两侧同口径，项目根本身是 symlink 时不误伤。
  - P1-4 路径口径统一：accessedPath / projectRoot 均过 normalizeToolPath。此前传 相对路径时 dirname 得到相对段，与绝对 root 比对必然失败，while 一次都不进， **静默返回 null**（轨迹里 grep/glob 的 path 本就允许相对路径）。
  - P2-5 去掉 toLowerCase()：去重键改用 realpath 原样。小写化在大小写敏感 FS 上 会把 src/Ui 与 src/ui 撞成一份。与 P1-4 是「统一路径口径」的两面，合并改造。
  - P1-5 break → continue：作用域未命中只跳过该候选，不再连带抑制同目录无条件规则。
  - P1-1 候选文件名单一事实源：从 rules.ts import，并新增 CLAUDE.local.md 与 .claude/rules/**.md（此前完全盲区）；rules 目录逐份独立判定并全部注入。
  - P1-2 快照新鲜度：loadedFiles 从 Set 升级为 Map<path, {mtime,size}>，命中时比对 时间戳，变了就重读。关键是 scannedDirs 目录级短路必须让位于新鲜度校验—— 否则「同目录复访」（改完 src/ui/CLAUDE.md 接着读该目录下另一个文件）这个最主要 的场景里短路先生效、mtime 比对一次都不执行，P1-2 等于没做。为此引入 has…
  - P1-6 收口下沉：JIT 回灌放进 ContextManager.setSystemPrompt 本身，使任何覆盖式 重建（/memory reload、/language、watcher、压缩后重建）都不会丢子目录规则—— 靠纪律维持的收口必然漏网，改成没有可绕过的路径。
  - P1-7 注入字节进记账：新增 setBaseMemoryTokens 统一收口，上报「基线 + JIT」合计 （setMemoryTokens 是覆盖式，裸调会把 JIT 增量抹成 0）。此前 /context 的 Memory files 分类系统性低估，压缩阈值判断跟着偏。
- **config** · JIT 项目边界从字符串前缀匹配改为路径段匹配 `502b20fe`
  - 回归测试（tests/config/jit-context-boundary.test.ts）
  - JIT 机制对标 CC 的缺口分析文档
- **config** · §8 静默遵循规则优化——去反例字面量+加反向边界 `906223fd`
  - 去掉 ✗ 反例字面量，改为句式描述，防止反向诱导模型照抄
  - 补充「系统自动添加/与出现位置无关」归因框定，模型有依据判断
  - 加反向边界：用户直接询问时允许如实回答，防止过度执行
  - 同步更新 attachments.ts 中 system-reminder 文案
  - 更新测试用例：去掉反例断言，增补反向边界与归因断言
- **query** · hypothesis 三缺陷修复（显式 cues 过滤/交付门禁闸门/策略提示） `6d434eec`
  - 缺陷1：显式 falsifierCues 跳过泛化门槛，防线在生产主路径上 完全失效。新增 sanitizeExplicitCues() 做筛而不做弃。
  - 缺陷2：交付门禁闸门 hasOpen() 与载荷 unsettled() 口径不一致， 全 refuted 时闸门不响。新增 hasUnsettled() 统一判据。
  - 缺陷3：连续推翻零确认时无换策略提示，模型连推 6 条才自省。 新增 consecutiveRefutations() + claimStrategyNag() 一次性信号， 达阈值注入 buildStrategyShiftReminder() 提示换取证手段。
- **ink,ui,config** · Footer 行2 右对齐真根因修复 + 规则落地 `e10ce105`
  - yoga 多槽布局缓存（_vendor/yoga-layout）在 performLayout 时命中旧 世代缓存，跳过子节点定位，flex-end 的 left 冻结在旧宽度
  - TerminalContext 挂独立的 stdout.resize 监听，闭包捕获的 proxy 恒 为旧值，导致 dimensions 永久滞后一次 resize
  - 系统提示词 §8「禁止复述 harness 注入的内部上下文」规则
  - attachments.ts / jit-context.ts 静默遵循指令
  - 前两轮 bugfix 文档标注「结论已作废」
  - 新增 yoga-layout-cache-positions 与 internal-context-silence 测试
  - 方法论文档沉淀第三轮教训（5 条硬规则）
- **migration, trace, cli** · 审计发现修复五合一 `0db8a646`
  - P1-4: 迁移失败兜底——setStoredMigrationVersion 自包 try/catch，cli.ts 调用方也兜一层
  - P1-5: 上传队列隔离——retryQueuePath 从全局 sidPaths 改为 outputDir 派生
  - P1-6: 上传队列去重 + 封顶——同 session_id+file 跳过追加，队列超 5000 条丢最旧
  - P0-3: 审计日志行号改字节偏移——statSync O(1) 替代 readFileSync+split 数行号
  - P2-7/8: 启动期日志降级——initLogger 之前的 warn 泄漏 stderr，降级 debug 静默吞掉
- **ink** · 主屏 resize 后 Footer 行2 右对齐失效修复 `02e8c370`
  - 主屏设 prevFrameContaminated=true，与 altScreen 的 resetFramesForAltScreen 对称，强制下一帧 full-damage（防 blit 用 旧宽度 stale cells）
  - 无条件先调 onComputeLayout() 重算 yoga——commit 短路时唯一重算 入口；幂等（后续 commit 的 onComputeLayout 重算同一布局）
  - 无条件调 scheduleRender() 绘制一帧——onComputeLayout 只更新 yoga 不绘制，commit 短路时 onRender 也不调；scheduleRender 经 throttle 排在 onComputeLayout 之后，读到新宽度，无 viewport/content 错配
- **llm** · 未知模型 contextWindow 兜底从 128K 提至 1M + 删 deepseek 特判 `cf9e5748`
  - token-estimator.ts: 兜底 128K→1M，删 deepseek 特判，更新注释
  - token-estimator.test.ts: 同步修正 4 处断言（契约变更）
  - 新增待修方案文档：记录 4 个数据源调研（apihub 不可达 / uniapi 无能力字段 / tags 覆盖率 14% / Moonshot /v1/models 不返回 context_window）+ 候选方案
- **config** · 移除启动期明文 API key 告警（误报占位符展开值） `2d6e3d0d`
  - 删除 warnPlaintextApiKeys 函数、plaintextWarned Set、调用点
  - 删除因此变未使用的 getLogger import
  - install-guide 3.2 节补 env 占位符安全建议段落

### 其他
- **config** · 修复 rules-glob-basis-layering 夹具——mock os.homedir 让 fakeHome 生效 `981fcd57`
  - 发布门禁被 3 个测试失败拦住，根因是测试夹具假设错误：
  - Bun 的 os.homedir() 不认 process.env.HOME 重定向（与 Node.js 行为
  - 不同）。测试设 process.env.HOME = fakeHome 后，findGlobalCLAUDEmd()
  - 和 userRulesDirs() 仍指向真实家目录——导致 ① 测试写在 fakeHome/
  - .claude/rules/ 的规则永远扫不到（userRulesDir 层空载）；② 真实
  - ~/.claude/CLAUDE.md 反而被加载。连无 paths 前置条件的无条件规则
  - （always.md）都加载失败，排除了 paths 匹配逻辑问题。
  - 修复：改用 mock.module("node:os") 从模块层面拦截 homedir()，让
- **trace** · 上传队列隔离与去重门禁测试（P1-5/P1-6） `f1cc845f`
  - 为上一轮审计修复补充门禁测试：断言 retryQueuePath 从 outputDir 派生
  - 而非 sidPaths.uploadQueue()，以及同 session_id+file 不重复追加。

## v0.1.595 (2026-07-30)

### 修复
- **mcp** · 只读子代理 MCP 工具放行收紧 + 指令静默遵循 + 截断保护 `200cde5e`
  - tool-filter: 只读子代理（explore/plan/verify）MCP 工具不再绕过白名单 （P0 多 provider 安全加固，防止 glm/deepseek 在只读任务中调用浏览器工具）
  - agent-definition: 只读子代理 system prompt 追加只读模式约束
  - instructions-delta: MCP 注入说明追加"静默遵循"指令，降低模型元认知外泄
  - loop: MCP instructions 块添加 4000 字符截断保护
- **tui** · alt screen 鼠标滚轮兼容性修复（macOS Terminal.app 兜底） `3cedd24a`
  - cli.ts: TERM_PROGRAM=Apple_Terminal 时 alternateBuffer 自动回退 false， 走主屏原生 scrollback 滚动（任何终端都支持），可用 --alternate-buffer 覆盖
  - dec.ts + MouseContext.tsx: 启用 DEC 1007（alternate scroll），alt screen 下滚轮转 Up/Down 方向键，作为终端不支持 SGR 1006 时的兜底； 1000/1002/1003 优先级高于 1007，支持 1006 的终端不受影响（无害叠加）

## v0.1.594 (2026-07-30)

### 修复
- **logger** · 落盘级别门控豁免 AUDIT:* 分类，修复审计轨迹被掐断 `c908f8b4`
  - 豁免的是**分类**而非级别：同配置下普通 INFO 仍被挡住
  - 仍受 mutedCategories 约束（用户显式静默优先级更高）
  - AUDIT 条目每轮仅几行、约 200 字节，不构成写放大
  - 新增豁免分类的判据：低频 + 缺失即致盲
- **logger,telemetry** · 日志落盘级别门控 + 缓存遥测轮转修复 `bb9a0f57`
  - 日志落盘级别门控：文件写入不再无视 level，修复审计模式下 DEBUG 日志占 90.7% 的写放大（104MB → 应有 1.2MB，87 倍）
  - append 模式轮转修复：currentLogSize 起点从 header 字节改为 既有文件大小，修复跨会话累积永不触发轮转的 bug
  - 缓存遥测加大小轮转：10MB 上限滚动为 .1，保留 1 份历史
  - 尾部读取优化：从 readFileSync 全量读改为只读尾部 1MB 窗口， 降低 RSS（原 8.5MB/51615 行全量读）
  - 跨轮转回补：当前文件不足 limit 条时回补 .1 尾部，避免刚 轮转完 /cache --history 显示为空
- 假压缩误报恢复兜底 + 记忆索引脱敏 + MCP 围栏格式加固 `4d5b4a9e`
  - syncGatewayPricing: 端点恢复但价格未变时也清 failed_at（防永久锁死）
  - normalizeMemoryDesc: 抹去基础设施坐标（公网 IP / 特权账号）
  - buildMcpInstructionsSection: 加 <system-reminder> 围栏，不以 # 开头
  - 文档: 上下文注入根因分析从 todo 迁至 done

## v0.1.593 (2026-07-30)

### 新功能
- **website** · changelog 搜索改为多词 AND 匹配，跨字段可组合命中 `5c477f88`
- **website** · changelog 并入官网 /changelog，删除独立 mini 站 `1b58a13a`
- **website** · 新增叙述覆盖度门禁 —— 命令改动自动触发 --coverage 检查 `f1800a03`
- **website** · 阶段 4 服务器上线 —— 官网/文档站发布链路 + nginx 切站 `ce0d20ef`
- **website,docs** · 参考文档生成器落地——运行时自省 + 对账门禁 + holdout 公开面适配 `7bf5b988`
- **website,docs** · 搭建 VitePress 官网文档站点 + 参考文档生成器 `e5a28b15`
- **agent,skill,swarm,tool,query** · 对齐 CC 缺口方案双检 + 多模块补全修复（P0-P3） `8e33af11`
- **session,checkpoint,skill,cli** · 会话持久化对齐 CC §14 + Skill 元工具化重构（P0-P3） `e4003326`
- **agent,swarm,tool,permission** · 子代理系统对齐 CC §11 + git 归因/危险检测统一 + bash 快照受影响文件追踪（P0-P3） `7b621127`
- **context,llm,query** · 上下文窗口管理对齐 CC §12 缺口修复（P0-P3） `87474ff2`
- **mcp** · 对齐 CC 缺口修复 B1-B3/G1-G6 + G5 mcp serve `ded5d2d8`
- **memory,command,config** · 外部 @import 审批命令入口 + 父目录链 git root 上界 `1f64962c`
- **memory,config,ui** · 记忆系统增强 + CLAUDE.md 导入处理（M2/M3/M4/M7/M9/M11） `8b22dc2c`
- **hook,skill,command** · Hook 系统对齐 CC 缺口 G7/G10/G11/G13 + Skill 禁用统一 + 清理废弃模块 `615338a4`
- **hook,query,agent,permission** · hook 系统增强——PreToolUse 统一解读 + 退出码对齐 CC + prompt/agent 类型 + 真子代理执行器 `ce25de2e`

### 修复
- 上下文注入三连根因修复落地（语义围栏 + 假压缩误报 + 双通道重复注入） `1d96cec8`
- 记忆键归一化清理 + Read NUL 报错增强 + todo-write 软提示降级 `6545829c`
- 上下文注入审计第 7 批修复 + 死代码清理 `f33ae564`
- 负收益防线审计第 2 轮修复落地 + 上下文注入审计第 6 批 `060e37b8`
- 负收益防线审计修复落地（发现 1-6，批次 A/B/C/D/E） `f18c2b23`
- 审计第 4、5 批修复（作用域规则闸门 + 消息保真） `39e12bda`
- **system-prompt** · 缓存键从手写维度列表改为自动遍历 ctx 字段 `7612bf03`
- 审计第 2 批三项功能等同修复（团队记忆同步/skill 上报/IDE 增量注入） `c3b0ae29`
- 审计第 1 批三项安全修复（@权限校验/frontmatter fail-closed/记忆键单射） `d87d50d3`
- **website** · ref 页面「请勿手工编辑」提示从 danger 框改为 HTML 注释 `a5806776`
- JIT 规则 paths 作用域真正生效 + history-adapter 保留 tool_result `385e7b35`
- **website** · 表格改回 display:block 修复长 URL 撑破容器溢出 `e00db072`
- **website-deploy** · 修首页冒烟假失败 —— pipefail + grep -q 让 curl 吃 EPIPE(exit 23) `c28029f0`
- **llm,query** · 迁移 skill 崩溃复盘修复 + todo gate 误判自愈 + 北极星宗旨 `3409d6e5`

### 文档
- **website** · 精简首页 tagline，砍通用能力罗列突出四条差异化 `cebc83a2`
- **website** · 首页定位从「跑在终端」改为「长在企业研发环境里」 `98eb7621`
- **website** · 扩写 11 篇叙述页补全覆盖度 + 同步报告 §5 修复标注 `3881e0e9`
- **website** · 修复参考页三处脚本口径漏项（覆盖度报告 §5） `fb09c9ff`
- **website** · 补全 P1 用户会主动找但找不到的叙述文档（覆盖度报告 §2.2 八项） `e5fc205b`
- 精简 CLAUDE.md，去重复表述保留全部规则（190→169 行） `f5779be3`
- CLAUDE.md 新增「不删无关文件」铁律与会话自检第 4 条 `45cc55fd`
- **website** · 补全 P0 能力型命令叙述文档（覆盖度报告 §2.1 七项） `7e9de785`
- 新增上下文注入作用域审计文档，同步官网导航与 README 格式 `86e974ff`
- **website** · 阶段 5 内容撰写 T-5.7 —— L5 team 最后 1 篇 observability 写实 `c095600a`
- **website** · 阶段 5 内容撰写 T-5.7 —— P6 L5 team 4 篇写实 `cdf63368`
- **website** · 阶段 5 内容撰写 T-5.6 —— P5 L3 extend 其余 6 篇写实 `a67fd37b`
- **website** · 阶段 5 内容撰写 T-5.5 —— ref/glossary 术语表写实（L4 唯一人工页） `55b75342`
- **website** · 阶段 5 内容撰写 T-5.3/T-5.4 —— P2 差异化 4 篇 + P3 L2 其余 7 篇写实 `65232ecf`
- **website** · 阶段 5 内容撰写 T-5.1/T-5.2 —— 落地页数字复核 + L1 入门 5 篇写实 `8f8963e0`

### 其他
- **website** · 同步 llms.txt —— observability 页 description 变更 `cbd067eb`
- **git,docs** · 统一 commit 归因邮箱至 sid-code.cc 并补设计方案阶段 3 验收 `6015ef4f`

## v0.1.592 (2026-07-23)

### 新功能
- **query,trace** · SID_MAX_TURNS 软阈值提醒 + 只读死锁缺口 A/B 修复 + model_at_start 归因 + 空壳清理放宽 `8e2d8f2a`
  - 新增 SID_MAX_TURNS 软阈值提醒（第四层兜底）：默认关闭，仅显式设置时启用， 单条消息处理超过 N 轮时一次性注入软提醒，不强杀，尊重"不打断长任务"偏好
  - 缺口 A 修复：isReadonlyProbeCommand 剥离 cd/env 前缀后再判只读， 让 `cd /a/b && git status` 等真实死锁形态进入检测
  - 缺口 B 修复：read/ls/glob/grep/lsp 等纯只读工具折叠进 probe 签名， 使 `git status ↔ read 同区域` 交替空转构成稳定复合签名，不再被交替清零
  - §6.4 model_at_start 归因字段：trace 中新增启动模型追踪， model 跟踪 /model 切换后的实际模型，供归因对照
  - §6.1 放宽空壳清理：覆盖"发出一次 BeforeModel 即被 abort、0 token" 的启动即中断会话，清理全天噪音
- **ui** · 状态栏重构为两行分层布局 + 两色层次 `2e35ee01`
  - Footer 从单行四区改为两行：行1(会话/运行态)左对齐、行2(环境/上下文)右对齐
  - 引入两色层次：单位/符号(暗色后退) + 数值(亮色前进)，全程有层次不再一片灰
  - 修复权限模式恒被截断：去掉内层 width="100%"，行宽由 flex 父容器自然决定
  - 窄屏渐进隐藏改为各行独立按 dropOrder 丢计量项
  - fallback 测试适配：移除 defaultModel、传 defaultParams
  - 新增状态切换/阻塞交互/后台看门狗修复方案文档
- 补齐 CC 对齐缺口——Vim 引擎、会话回退、14 个新命令、CLI 校验与 UI 增强 `c443c392`
  - 新增 Vim 编辑引擎（src/ui/vim/）：motions/operators/text-objects/transitions
  - 新增会话回退管理器（rewind-manager）+ RewindDialog UI
  - 新增 14 个命令：batch/bug/claude-api/color/fast/fork/insights/ keybindings/statusline/terminal-setup/tui/agents/auth/mcp-cli
  - 新增 CLI 标志校验（flag-e2e/flag-validators）
  - 新增剪贴板图片粘贴、Shell 任务接管（adopt）
  - 文档重组：对齐方案文件移入 double-check/ 子目录
  - 各模块配套测试覆盖
- **command,skill** · 新增 6 个命令 + /pr skill `5b64d5f1`
  - 新增 /context /copy /rename /statusline /vim /workflows 命令，
  - 新增 /pr bundled skill（对齐 CC），app 层增强 setVimMode/
  - setStatusLine/renameSession/stream-json 双向流/maxBudgetUsd，
  - UI 增强状态栏 Vim 模式，新增 3 组测试。
- 大规模补齐 CC 对齐缺口——CLI/权限/会话/UI/命令/配置全面补全 `c8a85525`
  - CLI：新增 session-id、effort、allow-tool 等 20+ 参数，对齐 CC 启动参数集
  - 权限：acceptEdits 下文件系统命令放行、路径/Shell 规则匹配、mode-policy
  - 会话：fork-session 分叉、no-session-persistence、sessionName
  - 命令：新增 /status、/todos 内置命令
  - UI：ContextDialog、Footer 状态栏、statusline、external-editor、kill-ring
  - 配置：扩展 Config 接口 30+ 字段，settings 源控制、MCP 配置源
  - 工具：WebFetch 预授权域名、工具白名单替换
  - 测试：新增 10+ 测试文件覆盖各模块
- **query** · 统一优先级消息队列 + mid-turn 抢占 drain,补齐缓存/环境/终止对齐 `12ceb4fb`
  - 新增 message-queue-manager.ts:收敛用户输入/后台通知/agent 消息到 now/next/later 优先级队列
  - loop.ts 支持 mid-turn 抢占 drain(now 级,SID_ENABLE_MIDTURN_DRAIN 灰度开关)
  - stop_sequence 纳入正常终止白名单,走完整收尾链
  - cache-strategy: 工具区缓存断点 markLastToolCacheBreakpoint(仅直连 Anthropic)+断点预算护栏计入 tools
  - system-prompt: 新增上下文管理静态告知(增强 5.3)+环境信息补齐 git 仓库判定与 OS Version
  - errors.ts 登记 midturn-preempt abort reason
  - task/notification 接入统一队列
  - 补充 message-queue-manager / midturn-drain / stop-sequence-end-turn 测试
- **tool** · P2-17 cron 人类可读调度 + P2-15 sub_agent 透出 model/cwd `9ccf1a1a`
  - P2-17：新增 cron/describe.ts 的 cronToHuman，识别每 N 分钟/每小时/每天/
  - 工作日/每周某几天/每月某日等常见模式，识别不了回落原始 cron；cron_list
  - 输出「人读描述（原始 cron）」。
  - P2-15：sub_agent schema 补 model（每次调用覆盖模型）与 cwd（工作目录），
  - 同步/后台两路径均透传到 SubAgentTask（内部本就支持，此前未暴露给 LLM）。
  - 测试 tests/cron/describe.test.ts 9 pass + tests/agent/sub-agent.test.ts
  - 29 pass；全量 5809 pass；make rebuild 通过。
- **web-fetch** · P2-2 HTML→Markdown 保留页面结构 `e0775439`
  - 标题→# 前缀、链接→[text](url)、列表→- 前缀、表格单元格→| 分隔
  - 强调→**/*、行内代码→反引号
  - 去 script/style/HTML 注释，解码十六进制/数字/具名实体
  - javascript: 伪协议链接只保留文字，防注入
- **tool** · 补齐结构化任务清单 + WebFetch 缓存/prompt + bash 超时 env 覆盖 `fe25e4ff`
  - 新增 structured-task-store：subject/status/owner/blocks/blockedBy 双向依赖边维护 + 成环检测 + isTaskUnblocked
  - 新增 task_create/task_update/task_get/task_list 四工具（结构化清单）
  - 原后台任务族改名 bg_task_get/bg_task_list（语义对应 CC TaskOutput 族）
  - 同步 coordinator/loop-detection/agent-definition/tool-filter/ tool-classifier/cli 全部引用
- **skill** · 新增 claude-code-migration 迁移技能 `ff6a75cb`
  - 将 Claude Code 的用户级和项目级配置迁移到 sid-code，支持
  - settings、MCP servers、commands、skills、agents、hooks、memory、
  - output styles、permissions 等配置的迁移。
  - 新增 inspect-migration.mjs 只读检查脚本、mapping.md 映射准绳、
  - E2E 测试脚本及 Claude Code 设计空间研究文档。

### 修复
- **trace,hook,query,tool,task** · eval-session 评估 4 项缺陷修复 + 文档测试闭环 `d974361a`
  - queryLoop 侧 StreamPhase 快照 key 是 `${loop_id}:${turn_index}`，采集器配对看门狗此前用 「累计 pair 数 + 1」查快照，key 语义不同 → 除首条用户消息外永远查不到，stream_snapshot 恒 null（死代码）。新增 BeforeModelInput.stream_snapshot_ref 透传 turn_index +…
  - 慢模型 + 长上下文下单轮生成超 2 分钟配对阈值是常态，但流仍在收 chunk 并非 hang。
  - 看 stream_snapshot.still_progressing：流有进展 → 降级为 [低] model_call_slow_response， 不再进 high_severity_anomalies；真 hang（无进展/已 abort）仍报 [高] watchdog（digest.ts/collector.ts）。
  - 原 `errors` 字段实为 high+medium 异常计数（含 watchdog/stuck_loop 假阳性），被误当真错误数 灌水进分诊主键。拆为三字段：`real_errors`（诚实错误计数，仅 is_error/TurnError 等）、 `anomalies_count`（异常总数，含假阳性，仅供参考）、`errors`（弃用别名 = anomalies_count，向后兼容）。
  - 批量分诊主键改用 `select(.real_errors>0 or .high_severity_anomalies>0)`（digest.ts + 文档同步）。
  - 弱模型对大文件常做几十次 limit=10~60 窄窗读、反复重读同一区域（实证 33 次），read 是纯只读、 无引导信号 → 拉长步数 + 推高 token。新增「重复窄读」非阻塞提示：同文件 ≥3 次且与历史高度重叠 → 提示复用/整读；首次对小文件传小 limit → 提示可一次整读。绝不拦截只读操作（read.ts）。
  - 防回归：提示含每轮自增的「第 N 次」元信息，会破坏 repeated-readonly-guard 的内容签名（每轮都变 → repeatCount 清零 → 瘫痪 git-status 冻结死循环止损阀）。新增 stripReadEfficiencyHint， loop-detection 做签名前先剥离该段（read.ts/loop.ts + 单测覆盖签名稳定性）。
  - flush() 此前另起 drain 与在途 drain 竞争，可能先看到空队列而提前 resolve，读端拿到不存在文件。
- **telemetry,trace** · 账本增量落盘 + 并行子代理误报修复 + ✗标记只信is_error `7eb1ee85`
  - 成本不落账本(高)：usage-ledger 从 append 改 upsert，每轮 AfterModel 增量落盘，去掉 ledgerWritten flag；读侧 dedupeBySession 兼容历史 append 多行。交互式会话任务完成后不再丢账本。
  - 并行子代理误报循环(中)：digest shape run 检测加时间戳窗口，同时间戳 派发的 fan-out 不计 run；保留串行空转告警。
  - ✗标记混淆(低)：移除关键词启发式，✗ 只留给 is_error===true 的真失败。
- **llm,query,config** · 补齐 git 快照死循环 4 个缺口 + 文档归档 `a87a14e4`
  - §6.3 重复开流成因遥测（原未落地）：fallback.ts 重开流路径读 stream-observer snapshot 的 timeoutsFired，推导结构化 reopenReason （idle/content_progress/fallback_stream_timeout），无超时记录则取 classified.reason；retry-telemetry.ts 新增 reop…
  - abort 路径必达+集成测试（原部分落地）：empty-param 测试用真实 AbortController 在 processStream 返回前触发 abort，断言 cancel result 含「被中断/未执行/没有落地/分段写入」且已 sessionStore 落盘
  - 第一层脏工作区单测（原部分落地）：attachments 测试创建临时 git 仓库 →commit→制造 untracked+modified 脏状态，断言脏文件名绝不泄漏进 <git-status>
  - 文档归档：根治-git快照死循环 todo→done；新增两份排查/评估文档
- 双层预防根治 git 快照冻结死循环 + 全屏有界视口物理根治幽灵残留 `10fd7a7d`
  - 第一层（attachments.ts）：移除 volatile Status 块，消除净/脏矛盾源
  - 第二层（empty-param.ts, loop.ts）：空参数/中断回执明确"未落地"，覆盖 abort 路径
  - 方案乙（config.ts, app.ts, cli.ts, help.ts, tui.ts）：默认全屏 alt-screen 有界视口，--inline 逃生舱
  - 子代理前台不再双投递通知（sub-agent.ts, agent-task.ts）
  - UI 修复：sub_agent 卡片 header、live tool 视口封顶等
  - 自检更新 + 测试更新
- H1-H10 系统性修复——fallback 死代码、terminal 拉黑、硬超时误杀、孤儿弹窗、子代理 thinking 收口 `1139fcdb`
  - H1: fallback 注入 resolveContextLimit 回调，根治 tryRecoverMaxTokens 死代码
  - （构造从不传 contextLimit → 恒 return null）
  - H2: 用户显式切模型或降级选中时清除 terminal 拉黑态，避免切了等于没切
  - H3: CLAUDE.md 模型切换复用 applyPrimaryModelSwitch 统一重算路径
  - （此前裸改 config.model，maxTokens/provider/effort 全失真致 400）
  - H4: fallback 注入 resolveMaxOutputTokens，修复自定义模型漏钳制 maxTokens 致 400
  - H5: config.ts 新增 resolveMaxOutputTokensForModel 导出
  - H6: turn_hard 超时改为 setInterval 周期检查，与人机等待闸门共享状态，
- **fallback,query,config** · 修复 fallback 切模型 maxTokens 不重算致 400 + 看门狗误杀弹窗 `9c3945d7`
  - config: 登记 _explicitMaxTokens 提前到首次 resolveCurrentModelConfig 之前，避免用户显式值被模型推导覆盖；新增 clampMaxTokensToModelCeiling 统一钳制
  - app: 抽取 applyPrimaryModelSwitch 统一 /model 切换与 fallback 降级 的主模型写回逻辑，确保两条入口均重算 maxTokens
  - fallback: 切到 fallback 模型时按注册表上限钳制 maxTokens
- **fallback,query,config** · 修复 fallback 切模型 maxTokens 不重算致 400 + 看门狗误杀弹窗 `a038d765`
  - config: 登记 _explicitMaxTokens 提前到首次 resolveCurrentModelConfig 之前，避免用户显式值被模型推导覆盖；新增 clampMaxTokensToModelCeiling 统一钳制
  - app: 抽取 applyPrimaryModelSwitch 统一 /model 切换与 fallback 降级 的主模型写回逻辑，确保两条入口均重算 maxTokens
  - fallback: 切到 fallback 模型时按注册表上限钳制 maxTokens
- **query,permission** · 补齐队列/权限/clear 三处缺口 `5f24e1bf`
  - 队列：drainByPriorityAndKind 双条件精确出队，mid-turn 只取 user-input
  - 不误吞其他 kind（如 permission-response）
  - 权限：checkDenyRules 复合命令逐子命令拆分匹配 deny 规则，任一命中即
  - 整体拒绝（some 语义），修补 `ls && curl evil.com` 绕过 deny 前缀的安全缺口
  - /clear：两处增加 clearMessageQueue() 调用，防止跨会话残留
  - 配置：新增 askUserQuestionTimeout 配置项
  - 测试：补齐对应测试用例

### 文档
- **skill** · 完善 eval-session 评估文档——执行环境约定、跨段桥接、批量分诊与能力链路探针 `1836f624`
  - 增加执行环境约定（分清"谁在评""评谁"）
  - 新增 Phase 3.5 跨段桥接（模型失误→harness 发现）
  - 新增 Phase 0 适评性分诊与批量分诊脚本
  - 新增成本基线判读与 B 路能力链路探针
  - 术语统一：缺陷→发现（缺陷+优化点）
  - 更新完成判据与输出模板
- 发布流程第一步移除重复的 bun test，release.sh 内部已自带门禁 `d85eaccd`

## v0.1.591 (2026-07-17)

### 新功能
- **session** · 会话浏览器按终端高度动态分页，优化元信息展示与环绕导航 `25f78a6a`
  - 动态分页：用 useStdout 获取终端行数，实时计算每页会话数， 防止选择器高于终端导致滚动条 bug
  - 环绕式导航：新增 useWrapSelection hook，↑↓ 键在列表首尾 间环绕（取模），滚动窗口跟随目标行
  - 元信息行：时间显示改为"北京时间 (相对时间)" 格式，新增 模型短名展示（去掉 provider 前缀与冗余后缀）
  - 溢出指示：▲ 修正为"还有更新的会话"，▼ 修正为"还有更早的会话"
  - SessionInfo 新增 model 字段，从会话文件 data.model 读取
- **session** · 会话浏览器添加 Ctrl+P「仅当前项目」筛选 `f7ceed3f`
  - 从 session_start.cwd 解析会话工作目录，存入 SessionData.cwd
  - 选择器顶栏显示当前范围（全部/仅当前项目）与会话总数
  - Footer 提示 Ctrl+P 切换项目范围
  - getAllSessionFiles 优先使用 session_start.cwd，退回 directories[0]
- **cli** · -r/--resume 可选值语义——无值开交互选择器，带值按 ID/搜索词恢复 `25982103`
  - 手动解析 -r 可选值（parseArgs 不支持 [value]），三态：缺省/无值开选择器/带值恢复
  - 未精确命中时把值作为搜索词进选择器（对齐 CC）
  - 会话浏览器 UI 重构为 CC 风格两行布局 + 搜索框 + 底部功能提示
  - 新增 extractResumeArg 单测
- **ui** · diff 渲染折叠——新建文件/大改动默认折叠，ctrl+o 阶梯展开 `4263cf7f`
  - DiffRenderer 新增 maxLines prop + foldRenderPlan 纯函数，同步裁剪， 确保 Static 一次成型不污染 scrollback
  - ToolResultDisplay 设 DIFF_COLLAPSE_MAX_LINES=16 折叠档，isDiff 分支 接上折叠、与普通文本共用 expandLevel 阶梯展开
  - 新建文件在 colorizeCode 前按 maxLines 保留头部，末尾追加统一折叠 footer
  - 新增 foldRenderPlan 单测 + 折叠渲染快照测试
- **session** · 会话状态快照持久化——todo/假设/目标/权限跨 resume 恢复 `4be11df8`
  - 新增 persistTodoState/persistHypothesisLedger/persistGoalState 持久化方法， 每轮 done 后落盘到 JSONL metadata，与 persistUsageStats 对称
  - restoreSession 回灌：todo 清单 → TodoPanel 首屏展示、假设登记表 → 交付门禁 不失据、权限模式(安全档位) → 跨会话恢复、agent 设置恢复
  - /clear 边界加固：置空后立即落归零快照覆盖旧数据，防止恢复端幽灵清单/统计/ 目标/假设复活；goal 用 __CLEARED__ 哨兵标记
  - checkpointSessionId 引入：resume 时 checkpoint 跟随逻辑会话 id，使 /undo 恢复 后能回滚到 resume 之前的编辑
  - 首屏 goalDisplay 对称推送：resume 带活跃目标时 Footer 不再空白
  - 权限模式安全红线：dangerously-skip-permissions/always-allow 绝不跨会话恢复
  - 新增 hypothesis-ledger/todo-write 的 serialize/hydrate 方法
  - 新增 tests/session/hypothesis-persistence.test.ts 与 todo-persistence.test.ts

### 修复
- 多项 P0/P1 安全与稳定性修复 `fb77e54d`
  - P0-1: 会话按项目分目录，cwd 一致性告警（纵深防御跨项目恢复）
  - P0-2: permissionMode 不做隐式跨会话恢复（对齐 CC 安全红线）
  - P1-1: todo_write 加入子代理禁用列表（防止并发写污染主会话 todo）
  - P1-2: checkpoint 写时双层 eviction + 跨会话 LRU 真删总量清理
- **ink** · 抑制短命 Ink 实例的终端探查，防止回复碎片漏入输入框 `fc62f996`
  - 新增 suppressTerminalProbe 机制：短命实例跳过探查，主 TUI 正常探查
  - 新增 responseFragment 类型：丢弃拆分/截断的终端回复，不误作按键
  - 处理 Lone ST（\x1b\\）等尾部碎片，CSI-private/CSI-secondary 前缀
- **session** · resume 后累计用量统计回灌——Footer 不再从零值起 `843a2a6c`
  - 新增 UsageSnapshot 接口与序列化/反序列化逻辑（state.ts）
  - resume 路径从 JSONL metadata 恢复累计用量（app.ts）
  - 每轮对话结束落盘用量快照到会话 JSONL（app.ts）
  - 新增 usage-stats-persistence 单元测试

### 文档
- 归档 bugfixes/done 目录下散落文档到对应主题目录 `5b3d76ca`
  - 新建"系统提示词冻结快照"主题目录收纳 git 快照冻结相关分析；
  - 其余散落文档按主题归入 循环检测与长任务/中断与错误处理/
  - Harness与模型评估/调度与状态持久化/Token与计费统计。

### 其他
- **ink** · 新增终端响应碎片漏入回归测试 `012073f4`
  - 新增 tests/ink/terminal-response-fragment.test.ts 对短命 Ink 实例终端探查回复碎片漏入输入框的 bug 做回归覆盖
  - 补充 docs/bugfixes/todo/ 持久化恢复对齐 CC 改造 TODO 执行清单
- **ui** · 移除 CodeColorizer MaxSizedBox 死代码，新增持久化审计文档 `2c80bee8`
  - 移除 availableHeight 参数及 MaxSizedBox 折叠分支：全仓无人传参， 且与 Static 安全铁律冲突（异步测高先把内容落 scrollback 再折叠， 污染回滚区且不可擦除）
  - 新增两份审计文档：状态持久化与恢复对称性分析、对标 Claude Code 差距分析与核心哲学

## v0.1.590 (2026-07-16)

### 新功能
- **startup** · update 后全端点定价强制刷新 + API Key 占位符识别 `221f0c4f`
  - 新增 refreshGatewayPricingOnStartup，通过版本水位线（lastPricingSyncVersion） 判断刚 update 后 force 全端点强制刷新定价缓存，忽略 24h TTL
  - 新增 isMissingApiKey 函数，识别 __YOUR_API_KEY__ 占位符为未配置， 新用户首次安装时友好引导而非静默撞 401
  - 新增测试：gateway-pricing 启动刷新策略 5 个用例 + config 占位符识别 3 个用例
  - 文档：重命名可观测性指标体系目录 + 新增网关定价审计报告
- **llm** · 网关定价多端点分桶、按次计费展示、采集可观测性 `695f31ea`
  - 缓存结构从单端点扁平改为按归一化端点分桶（v2），旧版 v1 自动迁移
  - lookupGatewayPricing 端点感知：先查精确桶，再跨桶兜底
  - syncGatewayPricing 只更新本端点桶，不再互相覆盖
  - /model pricing 展示按次计费模型（quotaType=1）
  - 新增观察者模式 + GatewayPricingSync trace 事件
  - 测试环境隔离：避免读到本机真实网关缓存导致断言不稳定
- **llm** · 网关定价自动采集与端点归一化计费 `66c015b6`
  - 新增 endpoint-key.ts：normalizeBaseURL 端点 URL 归一化， 收敛等价写法避免计费复合键漏配
  - 新增 gateway-pricing.ts：从 new-api 网关 /api/pricing 接口 自动采集价格，含本地缓存与容错回退
  - 新增 /model pricing 命令：查看模型定价表含来源标注 （用户手写/网关采集/内置注册表/兜底估算）
  - 新增 /model discover --pricing：手动触发网关价格采集
  - resolvePricing 优先级链：用户手写 > 网关采集 > 注册表 > 兜底
  - 配置与计费链路配套调整
- **trace** · 补全会话轨迹可观测性指标（缺口分析一至六类） `5f656e6d`
  - 一类·TTFB：anthropic 路径补齐 headers_received/HttpConnected 事件，与 openai 同口径
  - 二类·reasoning token：新增 reasoningTokens 字段（Usage/Hook/Trace），openai extract 函数，loop 透传
  - 三类·输出/输入比：SessionEnd 派生 output_input_ratio
  - 四类·缓存命中率：SessionEnd 派生 session_cache_hit_rate
  - 五类·上下文趋势：逐轮 context_usage_ratio 序列 + 峰值，落盘 used/window/ratio
  - 六类·可靠性：弃流数/重试次数聚合，stream_completed 纯生成耗时 → 吞吐 tokens/sec
  - trace builder 新增 10+ 派生/采集类指标字段，collector 新增对应采集逻辑
  - 测试：collector 新增 9 个用例覆盖新指标采集与派生
- **ui** · bash 长命令实时进度展示 + RetryStatus 倒计时定格修复 `b0fc64d6`
  - bash.ts: pump 循环替代 Response().text() 一次性 await，120ms 节流 emit 尾部 5 行
  - app.ts: liveToolProgress 侧信道 Map 注入 executing 态 progressMessage； refreshLiveProgressInPlace 轻量路径只换 live tool_group 引用，不重建 committed； CM3 补清请求失败重试成功后 retryStatus 残留
  - ToolMessage.tsx: shell 实时输出以独立多行块展示在命令行下方
  - App.tsx: committed 数组引用稳定化，防止轻量刷新触发 Static 全量重渲
  - history-adapter.ts: estimateToolRows 计入进度行数；countLiveItemTools 修正 hiddenToolCount 计工具数而非行数（防「1 个工具显示成 10 个」）
  - test: 更新断言 + 新增 shell 多行实时输出折叠测试

### 修复
- **agent/query/llm/plan** · 归因脱节修复——按实际证据判定而非硬编码代理条件 `c3d87c05`
  - llm/errors: 删除裸 "not found" 子串匹配，避免把 5xx 可重试错误误判为终端 model_not_found
  - plan/recovery: 新增 classifyRecoveryTrigger，按错误消息内容判定触发类型，不再按工具名硬编码
  - query/tool-executor: 新增 hookActuallyModifiedInput，仅在 hook 真的改参时才注入提示
  - query/empty-param: 不再臆造"大上下文退化"根因，空参数时只陈述事实

## v0.1.589 (2026-07-15)

### 新功能
- **plan** · Plan 审批对话框升级为多选项列表，支持取消和附意见拒绝 `6434b820`
  - 审批回调类型从二值字面量改为 string，支持 cancel / reject:feedback 等扩展决策
  - 新增 cancel 分支：退出 Plan Mode 并记录日志
  - 新增 reject 带 feedback 解析：注入用户修改意见到 LLM 上下文
  - 消息统一用 <system-reminder> 包裹，阻止 TUI 意外渲染
  - PlanApprovalDialog 从 Y/N 升级为选择列表：批准 / 拒绝附意见 / 取消 / 其他…
  - 支持键盘导航（↑↓ 移动、Enter 选择、y/n 快捷键、Esc 取消）和文本输入态
- **tool** · 延迟加载工具「schema 未发送」补救机制 + ask_user_question 首轮可见 `c16c7201`
  - 新增 buildSchemaNotSentHint：参数校验失败时判断是否因 schema 未发送， 追加"先 tool_search 激活"引导，避免模型盲调反复微调参数
  - registry 新增 toolSearchEnabled 标志，由 queryLoop 首轮回填， 供 tool-executor 做门控判断
  - executeSingleTool 参数校验失败时调用 buildSchemaNotSentHint 追加补救
  - ask_user_question 改为 alwaysLoad（首轮带完整 schema）， 作为 /commit 等内置流程的刚需工具，避免盲调翻车

### 修复
- **ui** · 调整审批对话框选项列表间距，修复图标拥挤 `1b499981`
  - 将选项图标区域宽度从 4→5，并在指针图标与单选图标之间
  - 补充空格，改善视觉间距。
- **ui** · 统一快捷键提示显示逻辑，Composer 不再独立判断 `6197b4af`
  - DialogSwitch 透传 hideShortcutsHint={true}，不再依赖 isEmpty 动态判断是否显示 Composer 的快捷键提示
  - 快捷键提示统一由顶部 AppHeader/EmptyLogo 控制，避免重复
- **ui** · 修复幽灵行残留 — 终端任务驱逐兜底 + 动态区活项视口封顶 `49b235ab`
  - queryLoop finally 收尾驱逐：主循环终止后不再依赖下一轮循环触发驱逐
  - evictTerminalTasks 增加 force 参数：支持忽略缓冲期强制驱逐
  - App.tsx 独立 1s 定时器驱逐兜底：对标 cc CoordinatorAgentStatus，不依赖主循环
  - 动态区 live 活项视口封顶：按视口预算尾部截断，根治并行多工具时 executing 行溢出 scrollback
  - MainScreenLayout 隐藏工具摘要：折叠超预算活项时显示"… +N 个工具执行中"

### 重构
- **ui** · 提取 isEnter 变量消除 key.name 重复比较 `e2535d4b`
  - 将 3 处 key.name === "return" 提取为 isEnter 常量，
  - 集中处理回车键判断，减少重复代码。
- **plan** · Plan 文件命名从词汇 slug 改为语义命名（时间戳 + 主题 + 项目子目录） `a26d2d3c`
  - 新增 formatPlanTime / resolvePlanProject / sanitizeProjectName / sanitizePlanTopic 函数
  - Plan 路径改为 plans/{项目名}/{YYYYMMDD-HHmm}-{主题}.md 结构
  - enter-plan-mode 工具增加 topic 参数，支持中文主题命名
  - 更新测试覆盖新命名逻辑
- **tool** · ask_user_question 注册策略注释完善与代码顺序整理 `13b7179f`

## v0.1.588 (2026-07-14)

### 新功能
- 可观测性修复 — TTFT 数据源校准 + 缓存脱落归因 + UX 文案 + 指标体系文档 `7bbc3dea`
  - P0-1（排查报告 Bug A）：TTFT 从被污染的 AfterModelRaw.ttft_ms
  - 切换到纯净的 StreamPhase("first_content").ttft_ms，
  - 消除重试/渲染延迟双重污染；
  - 新增 gen_p50/p95/p99 生成耗时维度，让"慢在生成"显式可见；
  - avgLatencyMs 渲染标注"整轮耗时"，避免与首字节混淆（Bug B）
  - P1-2：缓存命中下降归因增加 precededByRetry 字段，前缀未变时
  - 按"是否紧跟重试"分离两类脱落：重试触发 vs 纯服务端波动
  - P2：todo gate 中性措辞优化；openai 协议缓存命中率上限提示（60-70% 正常）
- 码点安全截断 + daemon 防命令注入 + bash 引号诊断 `1b413272`
  - feat(context): 码点安全的 truncateToolOutput，避免切断 emoji/CJK 扩展区
  - feat(bash): 新增引号畸形诊断，命令失败时附 heredoc 写法提示
  - fix(daemon): worker/workspace 改用 execFileSync，消除命令注入风险
  - test: 补充 sliceByCodePoint 和 quoting-diagnostics 单测
  - docs: 归档 git-status 快照冻结死循环相关根因分析
- git-status 快照冻结死循环多方向修复 `b44de12d`
  - 方向 0：新增 --self-check 编译产物自检（bootstrap + self-check 模块），
  - 在 make build/rebuild 和 release.sh 末尾自动验证关键修复已内联。
  - 方向 2/4/6：新增 repeated-readonly-guard 模块，检测连续相同只读
  - 探查命令（git status/diff/log 等）+ 输出稳定不变，先注入携带实时
  - git 状态的收敛提醒，注满上限仍空转则强制收尾。
  - 方向 3：非只读命令（git add/commit 等）成功执行后失效 git 状态
  - 缓存，确保下一次 generateGitStatusAttachment 拿到最新状态。
  - 补充：loop-detection 默认关闭的决策依据从"对齐 CC"升级为"实测
- 统一移动测试文件到test目录下 `1ae2558c`
- 调整doc目录结构 `c5d1d86f`

## v0.1.587 (2026-07-14)

### 新功能
- MCP instructions 增量注入 + 工具延迟加载豁免 + 缓存冷热判定修复 + paramText 参数检索 + 编辑失败追踪 + cache_creation 成本补落 `a1f2630c`
- worktree 创建期告警 + LSP codeAction 支持 + 上下文压力节流 + 工具延迟加载 + DYNAMIC_BOUNDARY 保真 `d3c487ae`
  - worktree advisories：创建期检测依赖一致性（lockfile hash 比对）和 DB migration 冲突，回显给用户 / 子代理日志落盘，异常不阻断
  - LSP CodeAction：新增 LSPCodeAction 类型、diagnostic-registry latest 只读快照、 lsp-formatters 格式化、server-instance 能力声明、lsp.ts codeAction 操作
  - 上下文压力 cadence 节流：按档位（warn/urgent）节流注入，升档强注入、同档 低频重述（每 8 轮），避免幻影用户消息（对话重播/截断幻觉根因）
  - toolSearch 默认开启：对标 CC 默认行为，15 个长尾工具首轮不注入省 token
  - DYNAMIC_BOUNDARY 保真：复用 cache-strategy.ts 单一事实源，截断路径不丢边界 标记，防止缓存分区失效
  - 文档：删除可选优化/README.md，更新 context-engineering-next-optimizations.md
- 通知结构化快照重构 + 内部消息来源分类拆分 + 文档更新 `57ea4135`
  - 通知机制：新增 StructuredNotification 与 enqueueTaskNotification 入口，
  - TUI 结构化优先渲染，根治子代理结论含 XML 字面量破坏解析问题。
  - 内部消息：INTERNAL_ORIGINS/INTERNAL_RENDER_ORIGINS 分类拆分，
  - 修正 hasInternalOrigin 防止 task-notification 被整条隐藏误吞。
  - 系统提示：补充按需拉取完整结论说明。
  - 文档：团队记忆同步方案二次评审修正与落地记录。
- 子代理增强——LSP 诊断注入、tool_choice 透传、masking 隔离 `581f6f4c`
  - 具备 edit/write 工具的子代理在每轮开始前收集已编辑文件的 LSP 诊断
  - 注入为 user 消息让子代理感知自己引入的类型/语法错误
  - 作用域限定为本子代理编辑过的文件，并发子代理互不偷取
  - 为每个子代理派生独立 sessionId，避免并发子代理临时文件覆盖
  - 自定义子代理以 task.type 标识，普通子代理以 taskId 标识
  - 发给 LLM 的消息改用 getCleanedMessages()（大输出剪枝 + masking）
  - 此前裸发 getMessages() 无任何工具输出剪枝，input token 线性膨胀
  - auto-compact 设 toolChoice:"none" 禁止摘要时调工具，但此前被静默丢弃
- 流式工具执行器 + 工具编排 + 侧链持久化 + 内部字段剥离 `cd2ec196`
  - GAP-01 流式工具执行器（模型输出与工具执行并行）
  - GAP-08 防御性内部字段剥离（纵深防模型伪造）
  - GAP-10 工具编排层独立可测（分区调度算法提取）
  - P2-10 子代理 sidechain 持久化（防中断丢失）
  - 循环检测与终止策略-差距分析标记为已完成
- 不确定-1 会话硬顶修复 + 必删-4 语言约束 + system-prompt 优化 + StatsDialog 单价 + 防线触发率脚本 `b4556ddd`
  - 不确定-1：app.ts 新增 sessionTimedOut 判断防止静默吞掉；maxSessionDurationMs 默认 60min（单轮 2 倍）
  - 必删-4：语言约束改为 reasoningLanguageDrift 能力标志驱动
  - system-prompt：新增"批量化搜索"和"避免宽 ASCII 表格"规则
  - StatsDialog：新增 pricing prop 显示每百万 token 单价
  - 新增 scripts/defense-trigger-rate.ts 防线触发率度量脚本
- 审计报告落地修复与功能增强（不确定-1/2/3/4 + G13/G19/G22） `48e55c61`
  - 不确定-1：会话级硬顶纳入 network-profile 统一配置，headless/SDK 路径补齐
  - 不确定-2/3：单次调用重试硬顶 maxRetriesPerCall 防退避风暴
  - 不确定-4：baseURL 优先级链明确化
  - G13：子代理类型透传，save_memory agent scope 定位到子代理类型记忆目录
  - G19：think 工具注册（新泛型 Tool → LegacyTool 桥接）
  - G22：/compact 部分压缩（partial-compact）接线
  - trace/digest：新增 SubAgentSpan/SubAgentSummary 数据结构
  - 配套测试与注释规范
- G19 工具注册现代化——bridge 适配器（新泛型 Tool → LegacyTool 桥接） `0bb519b4`
  - src/tool/bridge.ts: 新增 toLegacyTool() 桥接适配器，buildTool() 构建的新泛型 Tool 经此适配后可直接 registry.register()
  - src/tool/types.ts: LegacyTool 注释中标注 G19 迁移路径，新工具直接用 buildTool() + bridge 无需等全量迁移
  - tests/tool/registry-modernization.test.ts: 完整闭环测试（buildTool → toLegacyTool → register → definitions）
  - src/query/compact/g16-g26-decision.ts: G16/G26 决策记录文档
- G10 autoDream 接线与配置（app.ts 集成 + settings 配置项 + 单元测试） `02e7efbe`
  - src/app.ts: autoDream 初始化接线，复用后台记忆提取子系统的 getMainContext + memoryDir
  - src/config/config.ts: 新增 autoDream 配置项及 auto_dream/autoDream 双键映射
  - tests/memory/dream.test.ts: 三级 gate 判定 + 状态持久化 + recordSession 计数测试
- 多项功能增强（G6/G10/G21/G23/G25） `109df47c`
  - G6: Read 工具支持多模态富媒体（图片/PDF/Notebook），含图片 mediaBlock 返回、Notebook 结构化渲染、PDF document 块
  - G10: 新增 autoDream 自主记忆巩固系统，三级 gate 触发（时间/会话/记忆量），fire-and-forget 后台 agent 跑 consolidate → prune
  - G21: Glob/Ls 工具接入 deny 规则过滤，被 deny 的敏感文件不再出现在列举结果中
  - G23: Shell 模式退出提示渐进衰减，复用 app-config 通用 hint 计数 API（满 3 次收敛）
  - G25: 命令上下文注入 permissionChecker 实例，修复 /allow /deny /add-dir /permissions 运行时永远为 null 的漏传
  - 新增 partial-compact 查询压缩模块
  - edit/write 工具增强
  - 对照 claude-code 多模态能力分析文档落地
- **command,llm,permission** · /add-dir 命令 + G6 富媒体序列化 + G21 deny 路径隐藏 `c4d3b43e`
  - 新增 /add-dir 命令：运行时将目录加入当前会话可访问白名单，支持 --list / --remove
  - G6: 抽取 serializeToolResultBlock 函数，支持图片/文档多部件 content 收敛流式/非流式两条序列化路径，避免逻辑漂移
  - G21: 新增 isPathHidden 方法，让 deny 规则对 glob/ls 列举结果生效 glob 工具注入 isPathHidden 回调，被拒文件从列表里隐藏（对标 claude-code）
- 多项功能增强（G6/G11/G12/G17/G20） `8feb8f62`
  - G6: Read 工具支持图片/Notebook/PDF 读取
  - G11: 新增 NotebookEdit 工具（cell 级 .ipynb 编辑）
  - G12: 系统提示重建时刷新输出风格
  - G17: PTL 截头重试机制（避免 prompt 过长导致摘要失败）
  - G20: sibling-abort 并发工具中断联动
  - 新增 diff/doctor 命令
  - 修复 sed -i 在 cd 场景下的路径解析
  - 补充 sed 误报边界测试和 notebook-edit 测试
- **mcp,config** · G3 Elicitation 接线与 G12 输出风格可插拔 `9bc59649`
  - G3：MCP 服务端请求路由（elicitation/create），SSE 传输层双向通信， CLI 交互处理兜底，capabilities 声明与 handler 注册
  - G12：outputStyle 配置注入系统提示词静态缓存区，用户可插拔输出风格
  - 测试：更新 git-status 断言适配新 snapshot 格式，新增防死锁哨兵
- 多项安全增强与功能补全（G2/G3/G5/G8/G9/G10/G11/G12/G13） `5d64abfa`
  - G13: 新增 agent-store 记忆系统，按子代理类型注入历史积累经验
  - G9: 补齐 bash-security 5 个校验器（畸形 token 注入/jq 逃逸/元字符/ 反斜杠转义空格/危险变量与不完整命令）
  - G10/G11/G12: 新增文件写入/编辑前安全检测，编辑工具接管
  - G8: 兼容 OpenAI 系 rate-limit header，补充限流状态提取
  - G2: ToolClassifier 接线，auto 权限模式回归生效
  - G3: MCP 传输层支持 Elicitation 服务器发起请求
  - G5: 长跑工具中间进度路由到状态栏
  - 对标 claude-code 的 git status 附件格式（仲裁锚点 + 结构化标签）

### 修复
- **llm** · 修复错误分类数字子串误判 + OpenAI strict schema 兼容性 `a6784bb2`
  - errors.ts: classifyError/is401Error/is408Error/is409Error 改用数字边界匹配， 避免网关 request id 中巧合内嵌的状态码数字子串（如 "404"）误判为终端错误； 拿到结构化 HTTP status 时优先使用，不再回退文本扫描（2026-07-13 生产事故复盘）
  - openai-responses-request.ts: strict:true 工具的 schema 补全 required + optional 字段转 nullable，满足 OpenAI Structured Outputs 硬性要求； 对 z.any()/z.unknown() 等无约束节点自动检测并降级为非 strict（2026-07-14 复测发现）
  - install-template.sh: PATH 前置改为幂等判断，避免 update 时重复拱到最前
  - 新增/补充测试覆盖上述回归场景
- **task-notification** · 多通知聚合为一条消息，防止 _meta 浅合并覆盖前面的通知 `5d11c84a`
  - 将 query/loop.ts 中逐条 addMessage 改为一次性聚合注入，_meta.notif 收集为
  - 数组；history-adapter 兼容单对象/数组两种形态，确保 TUI 渲染不丢通知。
  - 新增回归测试覆盖多通知数组与空数组回退场景。

## v0.1.586 (2026-07-10)

### 新功能
- goal 轮次动态调整与显示去歧义，及多项修复 `f7fc85f3`
  - 新增 /goal turns <n> 子命令：运行时调整最大轮次上限（1~1000）
  - 默认 maxTurns 50→150：长任务模式留足空间，用户可随时 ESC 介入
  - 状态栏 goal 列去歧义：移除易误读的百分比，改为"目标 N/M 轮"中文标签
  - 全链路去彩色 emoji：goal 改用单色几何字形（◎/⏸/⚠/✔），与 figures.ts 一致
  - 活项分流机制：含 executing 工具的 tool_group 从 Static 移入动态区，根治 scrollback 幽灵行残留
  - model-registry 路由前缀白名单：剥离 ali-/volc-/siliconflow- 等网关前缀后重试匹配
  - openai idle 超时定时器泄漏修复：cancelTimeoutId 此前无句柄，每秒泄漏数百个
  - trace 内存优化：builder 新增 new_messages 回退，collector 剥离旧 raw_messages

### 性能
- 新增 TUI CPU/内存性能诊断与验证脚本 `08f54e7a`
  - perf-probe.sh          PTY 下采样真实 TUI 的 CPU%/RSS/线程
  - perf-tui-drive.exp     expect 驱动 TUI 流式输出
  - perf-md-bench.ts       块闭合粒度 O(N²) markdown 重解析基准
  - perf-stream-token.ts   逐 token 流式渲染成本增长基准
  - perf-lex-vs-format.ts  拆分 lex vs format 成本（证实瓶颈在 marked.lexer）
  - traj-bench.ts          rebuildTraj 每轮全量重写的写放大基准
  - perf-verify-stream.ts  验证流式增量渲染修复（120块 658ms→7ms）
  - perf-verify-timer.ts   确定性验证 SSE 定时器泄漏修复（500→0）

## v0.1.585 (2026-07-10)

### 修复
- **install** · 更新提示优化——抑制无谓 source 提示 + 补全 HTML 更新日志链接 `843b9d46`
  - source 提示改为条件触发：仅当刚写入 PATH 块且当前 shell 的 PATH 里还没有 ~/.local/bin 时才提示。sid-code update 场景下命令本就从 PATH 找到才跑起来， 当前 shell 已含 bin 目录、二进制原地换掉即刻生效，旧逻辑无脑提示纯属噪声
  - 完成提示补上 CHANGELOG.html 网页链接（可直接点开，放在文本链接之前作为推荐）

## v0.1.584 (2026-07-10)

### 新功能
- **changelog** · 富化 changelog 生成——commit body 细节 + 科技风 HTML 页面 `e416da8f`
  - generate-changelog.ts 重写为「git 是唯一事实源，每次从 git 完整重建」， 产出 CHANGELOG.md（文本事实源）+ CHANGELOG.html（可直接点开的网页）两份
  - 抓取 commit body 细节：subject 下挂 body 里的 bullet/编号列表作为子条目， 让用户看得懂每个版本到底改了什么，不再只是一句标题
  - 过滤机器噪声：bump 记账 / Merge / eval dashboard 刷盘 / Co-Authored-By 尾注
  - HTML 页面：分组徽章 + commit 细节可折叠 + 实时搜索过滤 + 侧栏版本导航， commit hash 链到 gitlab commit 页（从 origin remote 推导）
  - HTML 采用明亮浅色主题（浅灰背景 + 白卡片 + 高对比文字），科技感但清晰易读
  - release.sh 接线：MD + HTML 一并纳入发布产物、上传服务器顶层，完成提示给出双链接
  - CLAUDE.md 发布铁律同步：bump 提交步骤补上 CHANGELOG.html
- **command** · 实现 /export 斜杠命令——导出对话到剪贴板或文件 `58d3a0c8`
  - 新增 /export 命令（export/index.ts），支持 clipboard/file 目标与 md/json/both 格式
  - 新增 ExportDialog 对话框组件，提供目标/格式选择 UI
  - 在 DialogSwitch 中注册 export 路由，App 层注入 exportConversation 回调
  - DialogType 联合类型新增 "export" 枚举值
  - 将约束型误伤机制排查清单从 todo 迁移到 done（已完成审计）
- **command** · 实现 /debug 斜杠命令——轨迹快照上传 + 诊断信息 + 剪贴板复制 `a4ef2158`
  - 上传当前轨迹快照到云端（best-effort，5s 超时）
  - 显示丰富诊断信息（session ID、模型、版本、时长、轮次、token、费用、工具统计）
  - 自动将 Session ID 复制到剪贴板
  - 新增 src/command/commands/debug/ 命令（新体系 UnifiedCommand）
  - TraceCollector 新增 uploadSnapshot() 公开方法（mid-session 上传）
  - TraceCollector 新增 getUploadUrl() 只读访问器
  - UploadManager 新增 getBaseUrl() getter
  - CommandContext/AppContext 接口新增可选 traceCollector 字段
- **command** · 实现 /debug 斜杠命令——轨迹快照上传 + 诊断信息 + 剪贴板复制 `5076eb81`
  - 上传当前轨迹快照到云端（best-effort，5s 超时）
  - 显示丰富诊断信息（session ID、模型、版本、时长、轮次、token、费用、工具统计）
  - 自动将 Session ID 复制到剪贴板
  - 新增 src/command/commands/debug/ 命令（新体系 UnifiedCommand）
  - TraceCollector 新增 uploadSnapshot() 公开方法（mid-session 上传）
  - TraceCollector 新增 getUploadUrl() 只读访问器
  - UploadManager 新增 getBaseUrl() getter
  - CommandContext/AppContext 接口新增可选 traceCollector 字段
- **build** · ripgrep 二进制改为仓库本地化存储，消除构建期联网依赖 `265a94c0`
  - vendor/rg-embed 是 git 追踪的 0 字节占位文件，但每次 make rebuild / release.sh 都会把当前平台真实 rg 二进制拷贝进去覆盖它，导致 git status 必然显示"已修改"，每次都要手动 git checkout 还原，容易忘记/误提交。
  - 4 平台预编译 rg 二进制（共约 18.5MB）只缓存在本机 vendor/rg-<platform> （.gitignore 排除、不入库），换机器/CI/vendor 被清理后就得重新联网下载 公司服务器，release.sh 交叉编译经常要等几十秒下载，且单点依赖服务器。
  - 新增仓库内规范路径 vendor/ripgrep/<version>/rg-<platform>，直接 git 提交 4 平台二进制（约 18.5MB，已用 sha256 核对与服务器一致）。
  - fetch-ripgrep.ts 改为两级查找：优先复用仓库内已提交文件（全程不联网）， 缺失时才回退联网下载，下载结果直接落到该规范路径，方便后续 git add。
  - 新增 --print-version，release.sh 用它读取版本号（避免两处硬编码漂移）。
  - release.sh 交叉编译循环改读新规范路径。
  - vendor/rg-embed 彻底移出 git 追踪（git rm --cached），改为纯本地构建产物； main() 失败兜底：--as-embed 联网也失败时写 0 字节占位，保证 bun build --compile 的固定 import 路径不因缺文件报错（延续原有降级语义）。
  - 连续两次 make rebuild，git status 不再显示 vendor/rg-embed 被修改。

### 修复
- **trace** · uploadSnapshot 未初始化时避免访问 this.metadata `ec426371`
  - 修复 TraceCollector.uploadSnapshot() 在未初始化时（this.metadata 为 undefined）
  - 直接访问 session_id 导致 TypeError 的问题。将初始化检查前置。
- **install** · 修复独立终端找不到 sid-code 命令——RC 文件检测与 PATH 注册逻辑重写 `24d0fe84`
  - 区分 macOS login bash（.bash_profile）与 Linux interactive bash（.bashrc）
  - 不再依赖子 shell 运行时 PATH 判断，改为直接检查文件内容
  - 新增 safe_insert 函数，保留原文件权限
  - 新增 sc 快捷命令别名
  - 安全原则：只追加不覆盖、不创建不存在的文件、尊重已有 alias
- **trace** · 修复轨迹上传长期失效——CLI 参数浅合并覆盖 settings.json 的 upload 配置 `e9740f86`
  - cli.ts：仅当用户显式传了 --no-trace/--trace-upload-disabled/--trace-upload-url 等 flag 时才构造 trace 对象，否则返回 undefined 不覆盖文件配置。
  - config.ts loadNewFormatAsConfig：Object.assign 改为一层深合并（嵌套对象合并 而非整体替换），避免 app.json 的部分字段吞掉 settings.json 的完整配置。

### 重构
- review 修复——消除 as any、类型安全、代码位置调整 `f7f666e3`
  - collector.ts: TraceUploaderInterface 新增可选 getBaseUrl() 方法， 消除 getUploadUrl 中的 as any 类型断言
  - debug.ts: catch (err: any) → catch (err: unknown) 防御非 Error 对象
  - uploader.ts: getBaseUrl() 从字段区移到方法区
  - adapter.ts: toAppContext 补全 traceCollector 桥接（对称性）
  - config.ts: 深合并注释补充说明仅一层深

## v0.1.583 (2026-07-09)

### 修复
- **test** · 修复 change-detector 测试写文件前的 fs.watch 武装时序竞态 `5eb409e0`
  - fs.watch(recursive) 依赖 FSEvents，watcher 建立后需要短暂时间才能就绪；
  - 测试原先 watchDirs() 后立即 writeFileSync，若 watcher 未就绪则本次变更
  - 事件被漏掉。全量测试负载下该竞态窗口命中率明显升高（Bun 1.3.11→1.3.14
  - 升级后自测连续复现）。修复：写文件前先 sleep 50ms 等 watcher 就绪。

### 其他
- **eval,hooks** · 下线 case 生成脚本 + 移除 pre-push 的 bun test 门禁 `adb947ab`
  - 删除 evals/scripts/import-trajectory-platform.ts / scripts/eval/new-case.ts / scripts/eval/select-real-tasks-30.ts 三个 case 生成/导入脚本（不再需要）
  - scanContamination/scanSecrets 抽到新增 scripts/eval/lib/security-scan.ts， 供 check-real-tasks-pollution.ts / scan-trajectory-secrets.ts 复用，避免连带 删除安全扫描能力
  - pre-push hook 去掉 bun test 门禁段落，保留 holdout 泄露检测 + real-tasks 永封 校验 + dashboard 自动刷新提交
  - 同步更新 evals/README.md / docs/eval/TODO.md / package.json 中对已删命令的引用
  - 删除对应测试 tests/eval/import-trajectory-platform.test.ts

## v0.1.582 (2026-07-09)

### 新功能
- **rg,fallback,test** · 内嵌 rg 升级 v15.1.0 + fallbackSwitchMode 三态 + 测试超时修复 `16a81ea8`
- **rg,fallback,ui** · 内嵌 rg 最佳努力 + fallback 降级决策引擎 + 选择题单选/多选视觉区分 `0e52e9b2`
- **ui,tools** · askUserQuestion preview/notes + Footer 窄屏自适应 + grep 退出码修复 `2a5304e4`
- **ui,commands** · argumentHint 提示系统 + Shift+Tab 权限模式循环切换 `07b2e588`
- **commands** · 统一命令持久化机制（-p 标志），扩展 /model 子代理与 fallback 切换 `36a80473`
- 完整默认配置模板 + 首装/更新两条路径安全补全 `3859d1f0`
- **ux** · 补全列表回车直接执行 + release.sh 门禁加固 + 清理遗留脚本 `e1e7031f`
- 构建二进制包&规则校验优化 `02b858df`
- **observability** · 完善子代理错误面板 & side-call 轨迹实时同步 `b861bf9f`
- tui界面提供统一错误面板 `3c54c866`
- **themes** · 语义颜色显式化，修复浅色可读性与消息显示异常 `088f9b00`
- footer去掉debug显示 `41315ce0`
- 约束型误伤/误判/误导 & 中断/错误处理/静默失败/硬编码分档 一轮修复 `4877b80d`
- 实现 Agentic Loop 查询模型、输出停顿检测与 token 预算续接，增强会话存储与恢复 `de39272c`
- Agentic Loop & Human-in-the-Loop 对齐 `fd086b3a`
- 清理过时文档 `0eb2c66f`
- 更新设计方案 `64335972`
- OpenAI Responses API 支持 (A3) 与多模块增强 `ca938734`
- 六、Sprint 3 详细 Todo-List（架构投资） `c27d5972`
- 五、Sprint 2 详细 Todo-List（加固防线） `96bc3673`
- **provider** · 多层超时防护体系与可观测性增强 `ac4d69f5`
- 工具质量和稳定性优化 `98adcc59`
- 可观测性缺口 — hang 死场景诊断盲区与改进方案-实现 `316650d7`
- 可观测性缺口 — hang 死场景诊断盲区与改进方案-实现了一半 `78bab88a`
- read工具优化 & 方案设计 `8560c7cf`
- 优化grep工具 `0dbb1736`
- Anthropic 协议族兼容性全面修复计划 & 状态同步隐患修复 `21ad561e`
- 折叠优化&子代理超时优化 `96000f1e`
- openai协议族兼容性处理 `2b19bb45`
- 删除 OSC 9;4 进度环 `7addc2b5`
- 优化没有配置key报错，增加引导 `799e034f`
- 内容截断检测优化 `86a89bce`
- 子代理超时 `50c358bd`
- 代码优化 `99228b77`

### 修复
- 高危 — 粘性开关脱同步(状态栏撒谎) & 2. 中危 — auto 是「死档」 `f99bcf55`
- **config** · 团队默认配置占位符 Key 静默失败改为启动即报错 `b4c1612d`
- **llm** · 伪装成功的空流静默失败 — 四层纵深防御 `adaf7fe7`
- /goal 执行过程问题排查 — glm-5.2 会话 20260707 -第三轮修复 `b89a3eea`
- /goal 执行过程问题排查 — glm-5.2 会话 20260707 -第二轮修复 `d7ec224f`
- /goal 执行过程问题排查 — glm-5.2 会话 20260707 -第一轮修复 `1e90432c`
- 修复测试报错 `2416100d`
- **agent/mcp/llm** · 修复共享 AbortSignal 上事件监听器泄漏，扩展 abort reason 白名单 `668af34d`
- 孤儿 Stream Snapshot 跨 queryLoop 污染看门狗 `7d9bed35`
- **provider** · 补齐 OpenAI 族缓存命中字段兜底链 — Kimi 顶层 cached_tokens `f443a234`
- **provider** · OpenAI/DeepSeek 缓存命中率修复 — 按 DYNAMIC_BOUNDARY 拆分静态/动态区 `94808aa0`
- **ui** · 修复 compact 摘要与 reattach 锚点泄漏到 TUI `8d0afcd6`
- DeepSeek 思考链走 content 通道泄漏为正文 → 任务"假性中断 `0c8bc800`
- 优化clear命令残留 `30f343ab`
- 密钥丢失 bug,用户的密钥被抹掉了 `b81f504e`
- 截断检测仅覆盖文件时生效 + 补充副作用分析文档 `7c10b4ab`
- DeepSeek 流式 hang + ESC/Ctrl+C 无效 `ba972d57`

### 重构
- **agent/query/llm** · 收敛超时配置体系，默认关闭循环检测并移除 partial-read 保护 `fb2c4e9f`
- **ui** · 提取 DialogSwitch 中枢，统一对话框调度 `05a1198a`

### 文档
- CLAUDE.md 明确发布铁律——先提交功能代码再发布再补 bump 提交 `e126e663`
- 更新文档 `a2242adb`

### 其他
- 添加 rebuild 目标 + 开发/发布/更新三线流程文档 `db1b206e`
- 更新文档 `bfa8a6c2`
- 更新文档 `38eeda76`
- doc: Provider 层生产级稳定性优化 — 实施路线与 Todo-List `e039c991`
- 可观测性缺口弥补 `f61b0ae6`
