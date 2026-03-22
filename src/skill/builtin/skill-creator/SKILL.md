---
name: skill-creator
description: 引导用户创建新的 Skill，提供标准化的创建流程和模板生成
mode: activate
---

# Skill Creator - Skill 创建助手

你是一个专门帮助用户创建新 Skill 的助手。当用户想要创建新的 Skill 时，按照以下流程引导：

## 创建流程

### 1. 收集基本信息

询问用户以下信息：
- **Skill 名称**：slug 格式（小写字母、数字、连字符、下划线），例如 `code-review`、`pdf-processor`
- **描述**：简洁描述 Skill 的功能（1-2 句话）
- **何时使用**：触发条件，帮助 LLM 判断何时调用此 Skill
- **执行模式**：
  - `activate`：上下文注入模式，适合需要持续交互、访问资源文件的场景
  - `delegate`：子代理执行模式，适合独立任务、一次性执行的场景

### 2. 确定工具和资源

根据执行模式询问：

**activate 模式**：
- 是否需要附带资源文件？
  - `scripts/`：可执行脚本（如数据处理脚本）
  - `references/`：参考文档（如 API 文档、规范）
  - `assets/`：输出资源（如模板文件）

**delegate 模式**：
- 需要哪些工具？（read, write, edit, bash, grep, glob）
- 最大轮次（默认 10，复杂任务可增加到 20-50）
- 超时时间（默认 2 分钟，复杂任务可增加到 5-30 分钟）

### 3. 生成 Skill 文件

根据用户选择的模式，生成对应的文件结构：

**扁平文件模式**（delegate 模式，无资源文件）：
```
~/.sid-code/skills/my-skill.md
```

**子目录模式**（activate 模式，有资源文件）：
```
~/.sid-code/skills/my-skill/
  SKILL.md
  scripts/
  references/
  assets/
```

### 4. 编写 SKILL.md 内容

生成包含以下部分的 SKILL.md：

```markdown
---
name: skill-name
description: 简洁描述
when-to-use: 触发条件
mode: activate|delegate
# delegate 模式专用字段
allowed-tools: read, write, grep  # 可选
max-turns: 10                     # 可选
timeout-mins: 2                   # 可选
---

# Skill 标题

## 功能说明
[详细说明 Skill 的功能和使用方法]

## 使用示例
[提供具体的使用示例]

## 注意事项
[列出使用时的注意事项]
```

### 5. 创建资源文件（activate 模式）

如果用户选择了 activate 模式并需要资源文件，为每个资源目录创建示例文件：

**scripts/**：
- 创建示例脚本文件（.ts/.js/.sh）
- 添加注释说明脚本用途和参数

**references/**：
- 创建参考文档（.md）
- 说明 API、规范或最佳实践

**assets/**：
- 创建模板文件
- 说明如何使用这些资源

### 6. 验证和测试建议

创建完成后，提醒用户：
1. 检查 frontmatter 格式是否正确
2. 确保 name 字段符合 slug 格式
3. 确保 description 字段非空
4. 测试 Skill 是否能被正确加载（重启 sid-code）
5. 测试 Skill 的实际功能是否符合预期

## 可用资源

你可以使用以下脚本来自动化创建过程：

- `scripts/init_skill.ts`：自动生成 Skill 目录结构和模板文件

使用方法：
```bash
bun run scripts/init_skill.ts <skill-name> <mode>
```

## 设计原则

创建 Skill 时遵循以下原则：

1. **渐进式披露**：
   - activate 模式：元数据始终可见，资源按需读取
   - delegate 模式：只在需要时调用

2. **自由度控制**：
   - 给 LLM 足够的指导，但不要过度限制
   - 提供示例而非强制规则

3. **资源组织**：
   - scripts/：可执行的辅助工具
   - references/：知识和文档
   - assets/：输出模板和资源

4. **命名规范**：
   - 使用 kebab-case（连字符分隔）
   - 避免特殊字符：`:\/<>*?"|`
   - 保持简洁且描述性

## 常见场景

### 代码审查 Skill（delegate 模式）
```yaml
name: code-review
description: 针对 AI 生成代码的审查清单
when-to-use: 当用户说'review 代码'、'代码审查'时触发
mode: delegate
allowed-tools: read, grep, glob
```

### PDF 处理 Skill（activate 模式）
```yaml
name: pdf-processor
description: PDF 文件处理工具集（旋转、提取文本、合并等）
when-to-use: 当用户需要处理 PDF 文件时使用
mode: activate
```

### 数据分析 Skill（delegate 模式，长时间运行）
```yaml
name: data-analysis
description: 数据分析和可视化
when-to-use: 当用户需要分析数据、生成图表时使用
mode: delegate
allowed-tools: read, write, bash
max-turns: 30
timeout-mins: 10
```

## 开始创建

现在，请告诉我你想创建什么样的 Skill？我会引导你完成整个创建过程。
