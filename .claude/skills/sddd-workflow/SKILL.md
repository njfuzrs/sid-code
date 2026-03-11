---
name: "SDDD Workflow"
description: "Spec-Driven Design & Development 五阶段工作流。当用户说'开始实现 Spec'、'按 SDDD 流程'、'implement spec'、'start task'、'开始任务' 时触发。提供从读取上下文到实施完成的完整流程指导。"
---

# SDDD 五阶段工作流

## 何时使用
- 开始实现新的 Spec（SPEC-XXX）
- 用户说"按照 SDDD 流程"或"开始实现"
- 从零开始一个新功能的开发

## 阶段 1：加载上下文（Research）

1. 读取当前 Spec 的三件套：
   - `docs/specs/active/{spec-id}/spec.md` — 理解"做什么"
   - `docs/specs/active/{spec-id}/plan.md` — 理解"怎么做"
   - `docs/specs/active/{spec-id}/tasks.md` — 理解"做哪些"
2. 读取 `docs/failure-modes.md`，检查是否有与当前任务相关的已知坑
3. 确认 spec.md 的 status 是否为 `ready` 或 `in_progress`
   - 如果是 `draft` / `clarified` / `planned`，提醒用户该 Spec 尚未就绪

## 阶段 2：澄清（Clarify）

如果 spec.md 中没有 "## Clarification" 章节，或该章节为空：
1. 读完 spec.md 后，列出所有疑问（通常 3-5 个）
2. 等待用户逐一回答
3. 将 Q&A 追加到 spec.md 的 Clarification 章节
4. 格式：
   ```
   ### Q1: [问题简述]
   - **提问者**: AI Agent
   - **日期**: YYYY-MM-DD
   - **问题**: [完整描述]
   - **答案**: [明确答案]
   - **影响范围**: [数据模型/API/前端/测试等]
   ```

如果 Clarification 章节已有内容，跳过此阶段。

## 阶段 3：确认执行计划

1. 找到 tasks.md 中下一个未完成的 Task
2. 向用户确认：
   - "下一个任务是 Task N: [描述]，涉及文件 [文件列表]，是否开始？"
3. 检查该 Task 的依赖是否已完成
   - 如果有未完成的依赖，提醒用户

## 阶段 4：执行（Implement）

按 Task 逐个执行，每个 Task 的流程：
1. 编写代码
2. 运行验证命令（参考 tasks.md 中的"验证"字段）
3. 验证通过后，更新 tasks.md：
   - 标记 checkbox 为 `[x]`
   - 添加完成日期
   - 更新"进度概览"的计数
4. 如果发现偏差，使用 `/deviation-protocol` 记录

**关键约束：**
- 只修改 plan.md "文件修改范围"中声明的文件
- 如果需要修改未声明的文件，先记录偏差，等待用户确认
- 每个 Task 完成后必须运行测试

## 阶段 5：收尾

所有 Task 完成后，使用 `/spec-closeout` 执行收尾流程。
