---
title: 代码智能（LSP）
description: 了解 LSP 符号导航、诊断注入与修复建议；交互式会话自动注册已安装的 language server。
---

# 代码智能（LSP）

LSP 让 sid-code 从"按文本搜代码"升级到"按语义读代码"。差别很实际：
`grep add` 会把注释里的 add、别的文件里同名的 add 全捞回来；
`findReferences` 则由语言服务器查找目标符号的引用。

它还有一条更值钱的链路：**诊断注入**。交互式会话启用 LSP、语言服务器推送诊断且会话具备 `edit` 或 `write` 工具时，符合严重度条件的新诊断会自动进入模型上下文；不用你手动贴报错，也不必先运行 `tsc` 才让模型看到它们。

## 快速上手

**不用写配置**。安装对应语言的 language server 后，交互式会话会自动探测并注册它：

```bash
npm i -g typescript-language-server typescript
```

安装后重启 sid-code；如果 sid-code 已在交互会话中运行，也可执行 `/lsp reload` 重新探测。
无头 `-p`（`--print`）和 Bridge 模式不会启动 LSP，下面用交互式会话验证。

先建一个有类型错误的文件：

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
```

在该目录启动交互会话：

```bash
sid-code
```

然后在会话中请求模型：

```text
请使用 lsp 工具对 calc.ts 第 1 行第 17 列的 add 执行 findReferences。
```

`line` / `character` 都是从 1 开始计数的坐标，所以示例中的 `add` 位于 `line: 1`、`character: 17`。在该示例目录只包含 `calc.ts`、并由 `typescript-language-server` 返回这些符号时，工具输出如下：

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
| `goToDefinition` | 跳到符号定义处 | `file_path` + `line` + `character` |
| `findReferences` | 找所有引用 | 同上 |
| `hover` | 拿类型签名与文档 | 同上 |
| `goToImplementation` | 找接口/抽象方法的实现 | 同上 |
| `prepareCallHierarchy` | 取调用层级项（调用链第一步） | 同上 |
| `incomingCalls` | 谁调用了我 | 同上 |
| `outgoingCalls` | 我调用了谁 | 同上 |
| `documentSymbol` | 列出文件内所有符号 | 只要 `file_path` |
| `workspaceSymbol` | 全工作区按名搜符号 | `file_path` + `query` |
| `codeAction` | 拿语言服务器算好的确定性修复 | `file_path`（可选 `line`/`character`） |

所有操作都需要 `operation` 和 `file_path`。`workspaceSymbol` 还必须提供 `query`；`codeAction` 可不带位置查询整文件，也可同时提供 `line` 和 `character` 缩小查询范围。

行号列号都是 **1-based**（和编辑器显示一致，不是 0-based）。

下面是本示例在 `typescript-language-server` 下实测的输出。实际结果和符号层级由所用 language server 决定。`hover` 示例：

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

输出顺序、回调是否列为子符号，以及 `workspaceSymbol` 是否返回目标符号都由 server 决定。以上是该 TypeScript server 在该示例文件上的实测。`documentSymbol` 的缩进表示服务器返回的符号层级；返回扁平符号时不会显示嵌套。

## 诊断注入：不用你贴报错

语言服务器推送的诊断会在满足条件时自动进入模型上下文。对上面的 TypeScript 示例，过滤 Hint / Info 后的诊断正文如下；完整提醒还会包含要求模型处理 Error / Warning 的说明：

```text
## /tmp/lspdemo/calc.ts
  Error (9:7) [typescript] 2322: Type 'number' is not assignable to type 'string'.
（另有 1 条提示（Hint/Info）已省略）
```

`Hint` / `Info` 会逐条过滤，不会出现在注入诊断里；若被省略，会附上省略数量。注入时还会附一句要求，让模型别无视真实的类型错误。几个门控值得知道：

| 门控 | 行为 | 为什么 |
| --- | --- | --- |
| 严重度过滤 | 只有含 **Error / Warning** 的文件才注入 | Hint / Info 不足以构成打扰模型的理由 |
| 跨轮次去重 | 已投递过的诊断不重复注入 | 否则同一个错误每轮刷一遍，纯噪音 |
| 能力门控 | 只在**有 `edit` / `write` 工具**时收集注入 | 诊断是给"能改代码的 agent"看的；只读会话不该被诊断打扰 |
| 编辑后失效 | 编辑后清除该文件的去重记录和待投递诊断 | 让基于新内容推送的新诊断能再次投递 |

文件里只有 Hint / Info 时**不会注入该文件**；若同批还含 Error / Warning，只注入后两者，并注明省略的提示数量。编辑后语言服务器会异步收到文件变更；重新发布诊断前，注入和 `codeAction` 查询都可能尚未反映新内容。

## `codeAction`：拿现成的修复方案

语言服务器可为已发布的诊断计算 quickfix。对上面的 TypeScript 示例，可能返回如下首选修复（具体 action 由 server 决定）：

```text
## 推荐修复（isPreferred，语言服务器标记为首选）
  - "Remove unused declaration for: 'bad'" [quickfix]
      删除 calc.ts:9:1–9:32
```

注意：`unused` 只表示当前未被引用，不代表该声明不需要；删除前应确认它是否属于尚未接线的设计。

`codeAction` 只读展示建议，不会自动应用 WorkspaceEdit。模型需理解建议中的范围与文本，再用 `edit` 工具落地；`edit` 使用文本匹配，不会按 LSP 坐标直接应用修复。

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

内置目录没覆盖的语言自己配。`~/.sid-code/lsp.json`（或项目级 `.sid-code/lsp.json`）。下面以 `solargraph stdio` 为启动命令的 Solargraph 配置为例；请根据实际使用的 server 调整 `args`：

```json
{
  "ruby": {
    "command": "solargraph",
    "args": ["stdio"],
    "extensionToLanguage": { ".rb": "ruby" }
  }
}
```

同名 key 会覆盖前一层的**整条服务器配置**，不是逐字段合并——想换掉内置的 Python server（比如从 pyright 换到 pylsp），就用 `"python"` 这个 key 写完整配置。合并顺序是**内置 → 全局 `~/.sid-code/lsp.json` → 项目级 `.sid-code/lsp.json`**，后者优先级最高；自定义配置不继承被覆盖项中省略的 `args`、`env` 等字段。

`command` 和 `extensionToLanguage` 两个字段必填，缺任一个那条会被跳过并记录警告。`args` 可省略；若填写，应按所用 language server 的启动方式提供参数，不能假设所有 server 都使用 `--stdio`。例如，若自定义配置覆盖 Python 内置项而省略 `args`，该 server 会以空参数启动，不会继承原配置的 `--stdio`。

改完 `lsp.json` 不用重启：交互会话里跑 `/lsp reload` 会重新加载配置，并关闭旧的语言服务器实例。新实例仍按需启动；首次 LSP 查询时才会启动对应进程。
`/lsp`（等同 `/lsp status`）查看系统状态和各语言服务器的**进程状态**；刚注册但尚未被查询的服务器会显示 `stopped`，并非已经就绪。

无头（`-p` / `--print`）与 Bridge 模式不会启动 LSP，内置 `/lsp` 命令在这些模式下不可用；请在交互式会话查看状态或重载配置。

## 常见问题

### 怎么判断 LSP 到底有没有生效

分两种情况：

① **模型说没有 `lsp` 工具** —— 初始化完成后没有注册可用的 language server（通常是尚未安装，或命令不在 PATH）。此时 `lsp` 工具不会出现在模型上下文中。安装对应 server 后，重启 sid-code，或在已有交互会话中执行 `/lsp reload` 重新探测。

② **工具在但报「未就绪或未配置」** —— LSP 尚未初始化完成，或运行形态跳过了 LSP 初始化。若 LSP 已就绪但该文件类型没有对应 server，工具会给出针对该扩展名的安装或配置引导。未就绪时的提示原文：

```text
LSP 服务器未就绪或未配置。请确认对应语言的 language server 已安装并在 PATH 中
（内置支持 TypeScript/Vue/Python/Go/Rust 等，装好即自动生效）。
```

### 内置支持的语言，但报"未找到服务器"

LSP 初始化后，若某文件扩展名有内置服务器但没有对应路由，通常是该服务器命令尚未安装或不在 PATH。工具会给出安装命令（输出示例来自 `.css` 文件）：

```text
未找到处理 .css 文件的 LSP 服务器：/tmp/lspdemo/y.css
原因：css language server 未安装或不在 PATH 中。
CSS 需 vscode-css-language-server，安装：npm i -g vscode-langservers-extracted
安装后重启 sid-code 即自动生效（无需手动配置）。
```

以上是服务器缺失时的原始报错文本，其中提示安装后重启。对于持续运行的交互会话，安装后也可执行 `/lsp reload` 重新探测 PATH；新注册的服务器在首次查询时启动。

### 长尾语言的报错长什么样

不在内置目录里的扩展名，报错会给出配置模板和文件路径（实测 `.rb`）：

```text
没有为 .rb 文件类型配置 LSP 服务器：/tmp/lspdemo/x.rb
内置语言目录未覆盖此类型。可在全局配置 ~/.sid-code/lsp.json 或项目 .sid-code/lsp.json
中添加，格式：
  { "<名称>": { "command": "<language-server 命令>", "args": ["--stdio"],
    "extensionToLanguage": { ".rb": "<语言ID>" } } }
```

模板中的 `args` 只是一个示例；若 server 默认使用 stdio，也可省略此字段，否则请按该 server 的启动方式填写。

### 需要配环境变量打开吗

不需要。交互式会话会自动探测 PATH，并在初始化成功且有可用服务器时启用 LSP。
（如果你用过 Claude Code，那里的 LSP 工具要 `ENABLE_LSP_TOOL` 环境变量门控，这里不用。）

没有安装可用的 server 时，LSP 工具不会出现在模型工具列表中；配置错误或服务器运行异常不会中止 CLI，但可能在会话中显示一次性健康告警。LSP 配置异步加载，语言服务器进程则在首次 LSP 查询时按需启动；启动期间仍会进行 PATH 探测，因此不承诺完全没有启动开销。无头 `-p` 和 Bridge 模式会跳过 LSP 初始化。

### 大文件会不会拖死语言服务器

单个目标文件超过 10 MiB 时，LSP 工具会拒绝读取处理。定义、引用、实现、工作区符号和调用者/被调用项等列表最多显示 50 条；`prepareCallHierarchy` 和 `documentSymbol` 不使用这个条数限制。

定义、引用和实现操作会过滤 `.gitignore` 忽略的路径；工作区符号、调用层级和符号列表不做这项过滤。过滤依赖 `git check-ignore`，若 Git 不可用或检查失败则会保留原结果。

### 什么时候该用 lsp 而不是 grep

做**符号级导航**时用 lsp：找定义、找引用、看类型、追调用链。
找字符串、找注释、找配置项这类**文本级**搜索还是 grep 更合适。

判断标准很简单：你想找的是"这个符号"还是"这段文字"。

## 相关

- [扩展方式总览](/extend/) — 五条扩展路径怎么选
- [工具清单](/ref/tools) — `lsp` 工具的完整参数定义
- [跑通第一个任务](/start/first-task) — 看它改代码时的完整工具序列
- [settings.json 字段](/ref/settings) — 相关配置字段
