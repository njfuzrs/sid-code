# Changelog

本文件由 scripts/generate-changelog.ts 自动生成，请勿手改。

## v0.1.583 (2026-07-10)

### 新功能
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
