# 通用 Case 模板

本目录存放 agent-agnostic 的通用评测 case 模板。这些 case 不引用任何特定 agent 的内部路径/模块名，任何 agent 都能跑。

## Case 编写规范

1. `input.user_query` 不能包含特定 agent 的内部路径（如 `src/agent/loop.ts`）
2. `expected.must_include` 只检查通用能力输出（如"能否正确重构代码"）
3. 可选 `input.repo` 字段指定被测仓库（不指定则用 agent 当前工作目录）

## 目录结构

```
cases/
├── coding-basics/       ← 基础编码能力（变量命名、函数提取等）
├── debugging/           ← 调试能力（定位 bug、修复错误）
├── refactoring/         ← 重构能力（提取函数、简化逻辑）
└── security/            ← 安全审计能力（发现漏洞、修复建议）
```

## 示例 Case

```yaml
id: generic_001
category: coding-basics
priority: p0
grader_type: rubric_5d

input:
  user_query: "将下面的函数重构为更易读的形式：\n\nfunction f(a,b,c){return a?b>c?b:c:b<c?b:c}"

expected:
  must_include:
    - "function"
  must_not_include:
    - "我无法"
  max_steps: 5

rubric:
  - dimension: completeness
    weight: 0.4
    criteria: "重构后的代码是否保持了原始逻辑的完整性"
  - dimension: accuracy
    weight: 0.3
    criteria: "重构后的代码是否与原始代码行为一致"
  - dimension: clarity
    weight: 0.3
    criteria: "重构后的代码是否更易读（有意义的变量名、清晰的控制流）"
```
