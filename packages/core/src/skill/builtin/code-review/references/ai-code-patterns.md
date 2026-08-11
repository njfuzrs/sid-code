# AI 生成代码典型反模式

> code-review Skill 应特别识别这些模式 — 这是 sid-code 核心叙事"为 AI 代码兜底"的具体抓手。
> RFC-001 §1.1（业务问题：AI 代码漏洞密度 2.74×、OWASP 失败率 45%）。

---

## 1. 编造依赖（Hallucinated Dependencies）

### 模式

AI 引入"听起来合理但不存在"的 npm/pip/go 包：

```ts
// ❌ AI 编造的库
import { ImaginaryHelper } from "@org/imaginary-helper-v2";
import { fastConvert } from "lodash-magic";  // lodash 没有 magic 子模块
import * as utils from "@vercel/super-utils";  // @vercel 下没有这个包
```

### 检测

1. 找到所有 `import` / `require` / `from`
2. 核对 `package.json` / `go.mod` / `requirements.txt` 中是否真有该包
3. 对常见库（lodash / react / express）核对子模块是否存在
4. 找不到 → flag blocker

---

## 2. 编造 API（Hallucinated Methods）

### 模式

AI 调用真实库的不存在方法：

```ts
import _ from "lodash";
_.fastSort(arr);  // ❌ lodash 没有 fastSort
_.deepMergeIntelligent(a, b);  // ❌ 编造的
```

### 检测

- 对常见库（lodash / react / express / fs / path）维护方法白名单或检查官方 API
- M3+ Context Engine 可基于 import 解析校验（F-05 调用图）

---

## 3. 假修复（Fake Fix）

### 模式

PR 描述说"修复了 bug X"，但实际改动只是隐藏问题：

```ts
// 原: try { riskyCall() } catch (e) { logger.error(e); throw e; }
// AI: try { riskyCall() } catch (e) { /* 修复 bug */ }  // 静默吞错 = 不是修复
```

### 检测

- finding 时 cross-reference PR 描述中的"修复"声明
- 如果 catch 块从有内容变成空 → 大概率是假修复
- 如果改动是"删除测试 + 删除断言" → 假修复（参见 RL-006）

---

## 4. 表面优化（Cosmetic Refactor）

### 模式

PR 标题"重构提高可维护性"，但实际只是改了变量名 / 缩进 / 加了注释，**带入新 bug**：

```ts
// 原（正确）
function calculate(price, discount) {
  return price * (1 - discount / 100);
}

// AI（带 bug）
function calculate(price: number, discount: number): number {
  // 优化：移除百分比转换
  return price * (1 - discount);
}
```

### 检测

- 如果"重构"diff 改变了计算公式 / 比较运算符 / 控制流，不是纯重构 → 检查是否引入 bug

---

## 5. 过度防御（Over-defensive）

### 模式

AI 把所有调用都包 try/catch + null check，包括明显不会失败的路径：

```ts
// AI 生成
function add(a: number, b: number): number {
  if (a === null || a === undefined) return 0;
  if (b === null || b === undefined) return 0;
  if (typeof a !== "number") return 0;
  // ... 10 行类型检查后 ...
  return a + b;
}
```

### 检测

- 同一函数内 ≥ 3 条 null check 但参数已经是 `: number` 类型 → flag low（可读性）
- 不要 flag blocker，但提示"过度防御"

---

## 6. 编造的数字常量

### 模式

AI 用看似合理但无依据的常量：

```ts
const MAX_RETRY = 7;  // 为什么 7? PR 描述里说"最佳实践"但找不到依据
const TIMEOUT_MS = 4523;  // 看起来精确，实际是编造
```

### 检测

- 对配置类常量，要求 PR 含数字依据 / 测试支撑
- 如果数字非典型（不是 1000/3000/10000 之类），flag medium 要求说明

---

## 7. 复制粘贴 + 半改

### 模式

AI 从一处函数复制到另一处，但只改了一半：

```ts
async function getUserById(id: string) {
  const user = await db.users.findOne({ id });
  return user;
}

// AI 生成（漏改）
async function getProductById(id: string) {
  const user = await db.users.findOne({ id });  // ❌ 还在查 users 表
  return user;
}
```

### 检测

- 函数名 vs 函数体不一致 → flag high
- 表名/类名不匹配 → flag high

---

## 8. 不存在的文件路径

### 模式

```ts
import { config } from "../../../config/production.json";  // ❌ 文件不存在
```

### 检测

- 用 `glob` 工具核对路径是否真存在
- 找不到 → flag blocker

---

## 9. 弱类型 / any 滥用

### 模式

AI 用 `any` 绕过类型系统：

```ts
function processData(data: any) {
  return data.users.map((u: any) => u.name);
}
```

### 检测

- 在 TypeScript 项目中 `: any` 出现 ≥ 3 次 → flag medium（可读性 / 类型安全）
- 在原本严格类型的模块改回 any → flag high

---

## 10. 假的"性能优化"

### 模式

AI 声称优化但实际更慢：

```ts
// AI 生成（"优化"）
const result = items
  .filter((x) => x.active)
  .map((x) => x.value)
  .filter((x) => x > 0)
  .reduce((s, x) => s + x, 0);

// 比原来的简单 for 循环慢 3 倍（多次遍历 + GC 压力）
```

### 检测

- "性能优化"diff 中如果引入更多链式 + 更多临时数组 → flag medium 要求 benchmark

---

## 守护清单（Skill 在 review 时主动检查的）

- [ ] 所有 import 在 package.json/requirements.txt/go.mod 中存在
- [ ] 所有调用方法在被调对象上真实存在（M3+ Context Engine 后）
- [ ] catch 块不静默吞错
- [ ] PR 描述声明的"修复"在 diff 中真有对应代码
- [ ] 数值常量有依据
- [ ] 复制粘贴的函数已完整改完
- [ ] 文件路径存在
- [ ] any 滥用 ≤ 3 次（TypeScript 项目）
