---
title: 代码智能（LSP）
description: 定义跳转、引用查找、诊断注入如何让改代码更准：装好 language server 即零配置生效。
---

# 代码智能（LSP）

LSP 让 sid-code 从"按文本搜代码"升级到"按语义读代码"。差别很实际：
`grep add` 会把注释里的 add、别的文件里同名的 add 全捞回来；
`findReferences` 只给真正引用那个符号的三处。

它还有一条更值钱的链路：**诊断注入**。语言服务器实时算出的类型错误会自动进模型上下文，
不用你贴报错、不用它跑一遍 `tsc` 才发现问题。

## 快速上手

**不用配置**。装好对应语言的 language server 就自动生效：

```bash
npm i -g typescript-language-server typescript
```

装完重启 sid-code。验证一下——建个有类型错误的文件：

```bash
mkdir -p /tmp/lspdemo && cd /tmp/lspdemo
cat > calc.ts <<'EOF'
export function add(a: number, b: number): number {
  return a + b;
}

export function total(xs: number[]): number {
  return xs.reduce((s, x) => add(s, x), 0);
}

const bad: string = add(1, 2);
EOF

sid-code -p "用 lsp 工具对 calc.ts 第 1 行的 add 做 findReferences"
```

实测工具原始输出：

```text
calc.ts:1:17
calc.ts:6:30
calc.ts:9:21
```

三处：第 1 行的定义本身、第 6 行 `reduce` 回调里的调用、第 9 行赋值时的调用。
`grep` 做不到这个精度——它分不清定义和调用，也分不清同名的不同符号。

## 10 个操作

| 操作 | 干什么 | 必填参数 |
| --- | --- | --- |
| `goToDefinition` | 跳到符号定义处 | `filePath` + `line` + `character` |
| `findReferences` | 找所有引用 | 同上 |
| `hover` | 拿类型签名与文档 | 同上 |
| `goToImplementation` | 找接口/抽象方法的实现 | 同上 |
| `prepareCallHierarchy` | 取调用层级项（调用链第一步） | 同上 |
| `incomingCalls` | 谁调用了我 | 同上 |
| `outgoingCalls` | 我调用了谁 | 同上 |
| `documentSymbol` | 列出文件内所有符号 | 只要 `filePath` |
| `workspaceSymbol` | 全工作区按名搜符号 | `filePath` + `query` |
| `codeAction` | 拿语言服务器算好的确定性修复 | `filePath`（可选 `line`/`character`） |

行号列号都是 **1-based**（和编辑器显示一致，不是 0-based）。

几个实测输出，感受一下返回形态。`hover`（返回的是带语言标记的代码块）：

```typescript
function add(a: number, b: number): number
```

`documentSymbol` 与 `workspaceSymbol`：

```text
===== documentSymbol =====
Function add (1:17)
Constant bad (9:7)
Function total (5:17)
  Function xs.reduce() callback (6:20)

===== workspaceSymbol（query=total）=====
total (Function) — calc.ts:5:1
```

`documentSymbol` 的缩进是真的层级——`reduce` 回调作为 `total` 的子符号嵌套在下面。

## 诊断注入：不用你贴报错

这条链路是 LSP 最实用的部分。语言服务器推给 sid-code 的实时诊断会**自动注入模型上下文**，
形态是这样（实测）：

```text
## /tmp/lspdemo/calc.ts
  Error (9:7) [typescript] 2322: Type 'number' is not assignable to type 'string'.
  Hint (9:7) [typescript] 6133: 'bad' is declared but its value is never read.
```

注入时还会附一句要求，让模型别无视真实的类型错误。几个门控值得知道：

| 门控 | 行为 | 为什么 |
| --- | --- | --- |
| 严重度过滤 | 只有含 **Error / Warning** 的文件才注入 | Hint / Info 不足以构成打扰模型的理由 |
| 跨轮次去重 | 已投递过的诊断不重复注入 | 否则同一个错误每轮刷一遍，纯噪音 |
| 能力门控 | 只在**有 `edit` / `write` 工具**时注入 | 诊断是给"能改代码的 agent"看的；只读会话不该被诊断打扰 |
| 编辑后失效 | 改完文件清掉该文件的已投递记录 | 让修复后重新推送的诊断能作为"新诊断"再投递，也避免过时错误驻留 |

注意上表第一行：文件里只有 Hint 时**整个文件都不注入**。所以上面那段实测里，
Error 和 Hint 是一起出现的——是那条 Error 把文件带进来的。

## `codeAction`：拿现成的修复方案

比让模型自己推怎么改更可靠——这是语言服务器算出来的确定性修复：

```text
## 推荐修复（isPreferred，语言服务器标记为首选）
  - "Remove unused declaration for: 'bad'" [quickfix]
      删除 calc.ts:9:1–9:32

说明：以上为语言服务器计算的确定性修复方案。上方"影响范围 → 内容"即修复要做的改动，
用 edit 工具在对应位置落地即可（本工具只读展示、不自动改文件）。
```

典型用途：补缺失的 import、删未用变量。注意 **`codeAction` 只读**，
它给"改哪里 → 改成什么"，实际落地要用 `edit` 工具。

## 内置支持的 10 种语言

装好 command 就自动注册，不用写任何配置：

| 语言 | command | 安装 |
| --- | --- | --- |
| TypeScript / JavaScript | `typescript-language-server` | `npm i -g typescript-language-server typescript` |
| Vue | `vue-language-server` | `npm i -g @vue/language-server @vue/typescript-plugin` |
| Python | `pyright-langserver` | `npm i -g pyright` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |
| JSON | `vscode-json-language-server` | `npm i -g vscode-langservers-extracted` |
| YAML | `yaml-language-server` | `npm i -g yaml-language-server` |
| HTML | `vscode-html-language-server` | `npm i -g vscode-langservers-extracted` |
| CSS | `vscode-css-language-server` | `npm i -g vscode-langservers-extracted` |
| Shell | `bash-language-server` | `npm i -g bash-language-server` |

::: tip 为什么不打包进二进制
language server 各自是独立进程、各自的运行时（Node / Python / Go / Rust），
物理上没法塞进单二进制。业界（VSCode / Neovim / Zed）也都是"按需获取 + 自动配置"。
sid-code 承担的是**自动配置**那一半：command 在 PATH 里就自动注册，不在就给精准安装引导。
:::

## 长尾语言：写 `lsp.json`

内置目录没覆盖的语言自己配。`~/.sid-code/lsp.json`（或项目级 `.sid-code/lsp.json`）：

```json
{
  "ruby": {
    "command": "solargraph",
    "args": ["stdio"],
    "extensionToLanguage": { ".rb": "ruby" }
  }
}
```

同名 key 会覆盖前一层配置——想换掉内置的 Python server（比如从 pyright 换到 pylsp），
就用 `"python"` 这个 key 写自己的。合并顺序是**内置 → 全局 `~/.sid-code/lsp.json`
→ 项目级 `.sid-code/lsp.json`**，后者覆盖前者，所以项目里的配置优先级最高。

`command` 和 `extensionToLanguage` 两个字段必填，缺任一个那条会被跳过并给出警告。

## 常见问题

### 怎么判断 LSP 到底有没有生效

让它跑一次 `lsp` 工具。没生效时工具会明确告诉你：

```text
LSP 服务器未就绪或未配置。请确认对应语言的 language server 已安装并在 PATH 中
（内置支持 TypeScript/Vue/Python/Go/Rust 等，装好即自动生效）。
```

### 内置支持的语言，但报"未找到服务器"

说明 command 没装或不在 PATH。报错会直接给安装命令（实测 `.css` 文件）：

```text
未找到处理 .css 文件的 LSP 服务器：/tmp/lspdemo/y.css
原因：css language server 未安装或不在 PATH 中。
CSS 需 vscode-css-language-server，安装：npm i -g vscode-langservers-extracted
安装后重启 sid-code 即自动生效（无需手动配置）。
```

注意最后一句：**要重启**。language server 是启动时探测 PATH 注册的，装完不重启不生效。

### 长尾语言的报错长什么样

不在内置目录里的扩展名，报错会给出配置模板和文件路径（实测 `.rb`）：

```text
没有为 .rb 文件类型配置 LSP 服务器：/tmp/lspdemo/x.rb
内置语言目录未覆盖此类型。可在全局配置 ~/.sid-code/lsp.json 或项目 .sid-code/lsp.json
中添加，格式：
  { "<名称>": { "command": "<language-server 命令>", "args": ["--stdio"],
    "extensionToLanguage": { ".rb": "<语言ID>" } } }
```

### 需要配环境变量打开吗

不需要。sid-code 的 LSP 是**自动检测**：初始化成功且有可用服务器就启用。
（如果你用过 Claude Code，那里的 LSP 工具要 `ENABLE_LSP_TOOL` 环境变量门控，这里不用。）

没配 / 没装 / 初始化失败时自动降级为无操作，不报错、不阻塞启动——
LSP 初始化本身也是后台进行的，不会拖慢冷启动。

### 大文件会不会拖死语言服务器

有 10MB 上限，超过的文件 LSP 工具直接拒绝处理。另外返回的 location 结果最多 50 条，
且会过滤掉 `.gitignore` 忽略的文件——防止 `node_modules` 里的匹配撑爆上下文。

### 什么时候该用 lsp 而不是 grep

做**符号级导航**时用 lsp：找定义、找引用、看类型、追调用链。
找字符串、找注释、找配置项这类**文本级**搜索还是 grep 更合适。

判断标准很简单：你想找的是"这个符号"还是"这段文字"。

## 相关

- [扩展方式总览](/extend/) — 五条扩展路径怎么选
- [工具清单](/ref/tools) — `lsp` 工具的完整参数定义
- [跑通第一个任务](/start/first-task) — 看它改代码时的完整工具序列
- [settings.json 字段](/ref/settings) — 相关配置字段
