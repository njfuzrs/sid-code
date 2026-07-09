# Changelog

本文件由 scripts/generate-changelog.ts 自动生成，请勿手改。

## v0.1.583 (2026-07-09)

### 修复
- (test): 修复 change-detector 测试写文件前的 fs.watch 武装时序竞态

### 其他
- (eval): refresh dashboard 2026-07-09T10:28Z
- (eval): refresh dashboard 2026-07-09T10:27Z
- (eval): refresh dashboard 2026-07-09T10:27Z
- (eval,hooks): 下线 case 生成脚本 + 移除 pre-push 的 bun test 门禁

## v0.1.582 (2026-07-09)

### 新功能
- (rg,fallback,test): 内嵌 rg 升级 v15.1.0 + fallbackSwitchMode 三态 + 测试超时修复
- (rg,fallback,ui): 内嵌 rg 最佳努力 + fallback 降级决策引擎 + 选择题单选/多选视觉区分
- (ui,tools): askUserQuestion preview/notes + Footer 窄屏自适应 + grep 退出码修复
- (ui,commands): argumentHint 提示系统 + Shift+Tab 权限模式循环切换
- (commands): 统一命令持久化机制（-p 标志），扩展 /model 子代理与 fallback 切换
- 完整默认配置模板 + 首装/更新两条路径安全补全
- (ux): 补全列表回车直接执行 + release.sh 门禁加固 + 清理遗留脚本
- 构建二进制包&规则校验优化
- (observability): 完善子代理错误面板 & side-call 轨迹实时同步
- tui界面提供统一错误面板
- (themes): 语义颜色显式化，修复浅色可读性与消息显示异常
- footer去掉debug显示
- 约束型误伤/误判/误导 & 中断/错误处理/静默失败/硬编码分档 一轮修复
- 实现 Agentic Loop 查询模型、输出停顿检测与 token 预算续接，增强会话存储与恢复
- Agentic Loop & Human-in-the-Loop 对齐
- 清理过时文档
- 更新设计方案
- OpenAI Responses API 支持 (A3) 与多模块增强
- 六、Sprint 3 详细 Todo-List（架构投资）
- 五、Sprint 2 详细 Todo-List（加固防线）
- (provider): 多层超时防护体系与可观测性增强
- 工具质量和稳定性优化
- 可观测性缺口 — hang 死场景诊断盲区与改进方案-实现
- 可观测性缺口 — hang 死场景诊断盲区与改进方案-实现了一半
- read工具优化 & 方案设计
- 优化grep工具
- Anthropic 协议族兼容性全面修复计划 & 状态同步隐患修复
- 折叠优化&子代理超时优化

### 修复
- 高危 — 粘性开关脱同步(状态栏撒谎) & 2. 中危 — auto 是「死档」
- (config): 团队默认配置占位符 Key 静默失败改为启动即报错
- (llm): 伪装成功的空流静默失败 — 四层纵深防御
- /goal 执行过程问题排查 — glm-5.2 会话 20260707 -第三轮修复
- /goal 执行过程问题排查 — glm-5.2 会话 20260707 -第二轮修复
- /goal 执行过程问题排查 — glm-5.2 会话 20260707 -第一轮修复
- 修复测试报错
- (agent/mcp/llm): 修复共享 AbortSignal 上事件监听器泄漏，扩展 abort reason 白名单
- 孤儿 Stream Snapshot 跨 queryLoop 污染看门狗
- (provider): 补齐 OpenAI 族缓存命中字段兜底链 — Kimi 顶层 cached_tokens
- (provider): OpenAI/DeepSeek 缓存命中率修复 — 按 DYNAMIC_BOUNDARY 拆分静态/动态区
- (ui): 修复 compact 摘要与 reattach 锚点泄漏到 TUI

### 重构
- (agent/query/llm): 收敛超时配置体系，默认关闭循环检测并移除 partial-read 保护
- (ui): 提取 DialogSwitch 中枢，统一对话框调度

### 文档
- CLAUDE.md 明确发布铁律——先提交功能代码再发布再补 bump 提交
- 更新文档
- 更新文档状态

### 其他
- 添加 rebuild 目标 + 开发/发布/更新三线流程文档
- 更新文档
- 更新文档
- doc: Provider 层生产级稳定性优化 — 实施路线与 Todo-List
- 可观测性缺口弥补
