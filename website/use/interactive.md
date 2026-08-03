---
title: 交互模式与键位
description: 常用键位、和弦、中断与排队输入的行为。
---

# 交互模式与键位

这页解决一个问题：**你在会话里除了打字，还能按什么。**

不用背。记住三个就够开工：`?` 看全部键位、`Esc` 打断、`Shift+Tab` 切权限模式。
其余的等真遇到那个场景再回来查。

## 快速上手

进会话后直接按 `?`（输入框为空时），会展开完整键位表：

```text
快捷键 — 输入 /help 查看更多
```

这张表**不是硬编码的文档**，是从运行时键位表算出来的——你在
`~/.sid-code/keybindings.json` 里改过的键位会直接反映在里面。想生成一份模板：

```text
/keybindings init
```

## 详细说明

### 输入区

| 键 | 作用 |
| --- | --- |
| `!` | 进 shell 模式，这一行直接当命令跑，不发给模型 |
| `@` | 选文件/目录，把路径塞进输入 |
| `Shift+Enter` | 换行（不发送）。终端吞掉这个键就用 `Alt/Opt+Enter` 或 `Ctrl+J` |
| `↑` / `↓` | 翻输入历史 |
| `Ctrl+R` | 反向搜索输入历史 |
| `Ctrl+G` | 把当前输入丢进外部编辑器改（`$EDITOR`） |

`Shift+Enter` 在 VSCode / Cursor / Windsurf 的内置终端里默认收不到，跑一次
`/terminal-setup` 装上键绑定即可。

### 贴图与拖放：多模态输入

sid-code 支持把图片和 PDF 直接喂给模型——不用先存盘再 `@` 引用，粘贴或拖放就行。

**粘贴截图**：在 macOS 上 `Cmd+Ctrl+Shift+4` 截一块到剪贴板，回到 sid-code 输入框按 `Cmd+V`。终端对图片剪贴板的典型信号是「paste 事件收到空内容」——sid-code 检测到后会调系统工具把剪贴板图片落成临时 PNG，自动插入 `@<临时路径>` 引用。各平台的读取方式：

| 平台 | 工具 |
| --- | --- |
| macOS | `pngpaste`（装了优先），否则 `osascript` 兜底 |
| Linux | Wayland 用 `wl-paste`，X11 用 `xclip` |
| Windows | PowerShell `Get-Clipboard` |

没装对应工具不会报错，只是静默返回 null——图片那条路径走不通，文字粘贴照常工作。

**拖放图片**：把一个图片文件拖进终端窗口，多数终端会「粘贴文件路径」。sid-code 识别到这是单个图片文件路径（扩展名匹配且文件存在）时，自动当图片引用。多文件拖放不处理（保守，避免误判普通文本）。

**直接 `@` 引用**：也能手动 `@` 一个图片或 PDF 路径，效果一样。

支持的格式：

| 类型 | 格式 | 行为 |
| --- | --- | --- |
| 图片 | `.png` `.jpg` `.jpeg` `.gif` `.webp` | 走 Read 工具的 vision 管道，以视觉内容块返回，模型直接看图 |
| PDF | `.pdf` | 按页读取为文档块，**单次最多 20 页**；超过 10 页的 PDF 必须指定 `pages` 参数，否则会报错要求分页 |

几个设计取舍值得知道：

- **图片不内联字节**。粘贴/拖放只是拿到一个文件路径，真正读图走 Read 工具——它产出 mediaBlocks 交给支持 vision 的 provider。所以图片能不能看，取决于当前模型支不支持 vision
- **PDF 要分页读**。`pages` 参数支持 `1-5`、`3`、`2,4,7` 这类范围/单页/列表写法。一份 50 页的 PDF 全塞进去会爆上下文，超过 10 页就强制分页
- **临时文件自动落盘**。粘贴的截图会存到 `~/.sid-code/tmp/pasted-images/` 下的临时 PNG，会话结束后清理

::: tip 粘贴没反应？
终端可能没把图片剪贴板识别成 paste 事件。试试先 `@` 手动引用，或直接拖文件进窗口。Linux 上确认装了 `wl-paste`（Wayland）或 `xclip`（X11）。
:::

### 模型正在输出时你还能打字

打字不会被丢掉，会**排队**。三个优先级：

| 键 | 语义 |
| --- | --- |
| `Enter` | 排队（默认），本轮结束后按顺序发 |
| `Alt+N` | 插队，本轮结束后最先发 |
| `Alt+L` | 延后，排在所有普通排队之后 |

空闲状态下 `Alt+N` / `Alt+L` 不拦截——没有队列就没有队列语义，照常当字符插入。

### 全局键

| 键 | 作用 |
| --- | --- |
| `Esc` | 取消当前操作（打断模型 / 中止工具） |
| `Esc` `Esc` | 打开回退选择器，见[会话管理](/use/sessions) |
| `Ctrl+C` | 退出 |
| `Shift+Tab` | 切权限模式，见[权限与人工确认](/use/permissions) |
| `Ctrl+S` | Copy Mode |
| `Ctrl+L` | 清屏（保留历史） |
| `Ctrl+O` | 展开/收起折叠内容（工具结果 + 思考过程） |
| `Ctrl+T` | 切后台任务面板 |
| `Ctrl+F` | 终止全部后台任务（按两次确认） |
| `Ctrl+X` | 把已完成的后台任务从面板划掉 |
| `Ctrl+B` | 把当前任务转后台 |
| `Ctrl+E` | 关掉错误面板 |
| `Alt+M` | 切 Markdown 渲染 |
| `Alt+T` | 切扩展思考 |
| `Alt+P` | 切模型（不清空已经打的字） |

`Ctrl+B` 在 tmux 下和默认 prefix 撞车。要么改 tmux prefix，要么在
`keybindings.json` 里把 `app:backgroundTask` 换个键。

`Ctrl+F` / `Ctrl+X` / `Ctrl+B` 都是**上下文分层**的：没有对应的任务时它们不抢按键，
照常走输入框的光标移动（emacs 传统）。所以编辑输入时按它们不会误触发。

后台任务跑完后，面板上的条目会自己消失（已完成 / 失败留 30 秒，被你终止的留 3 秒）。
留这个窗口是为了让你还能回看一眼结果。不想等就按 `Ctrl+X` 立刻划掉——只清已结束的，
还在跑的任务不受影响（要停它们用 `Ctrl+F`）。划掉只是从屏幕上拿走，模型那边
`bg_task_list` / `task_output` 照样查得到。

### Copy Mode：为什么鼠标选不中文字

默认是**全屏有界视口**（alternate buffer）：滚动、鼠标滚轮、虚拟列表都由 sid-code
自己接管。代价是鼠标事件被程序吃掉了，**没法用鼠标直接划选文本**。

两条出路：

1. **临时**：按 `Ctrl+S` 进 Copy Mode，鼠标事件被放开，正常划选复制。按任意非导航键退出。
2. **永久**：用 `--inline` 逃生舱回到旧的主屏内联模式。

```bash
sid-code --inline
```

`--inline` 下历史直接进终端原生 scrollback，鼠标原生选中，也兼容不支持
alternate buffer 的终端。代价是执行中的工具输出可能在 scrollback 里留下残行——
全屏模式正是为根治这个才成了默认。

要长期用内联模式，别每次带参数，写进 `~/.sid-code/settings.json`：

```json
{
  "alternateBuffer": false
}
```

只想复制模型上一条回复的话，不必划选：

```text
/copy        复制最后一条回复
/copy code   只复制其中的代码块
```

### 斜杠命令

输入 `/` 会弹出补全列表，和[斜杠命令参考](/ref/slash-commands)是同一份数据源。
这里不重复列，只挑日常最常用的：

| 命令 | 干什么 |
| --- | --- |
| `/status` | 当前模型、目录、token、provider 一屏看完 |
| `/context` | 上下文占用拆解，见[上下文与压缩](/use/context) |
| `/cost` | 这次会话花了多少 |
| `/diff` | 看工作区 git diff |
| `/undo` | 撤销最近一次文件修改 |
| `/doctor` | 环境自检 |

### Vim 模式

习惯 vi 键位的，输入框原生支持一套 Vim 引擎（`src/ui/vim/`，纯函数 reducer：

输入 {当前缓冲 + 模式态 + 一个按键} → 输出 {新缓冲 + 新模式态}）：

```text
/vim        本会话开（toggle）
/vim on     显式开
/vim on -p  写进配置，以后都开
```

多数命令都支持 `-p` 后缀 = 持久化到 settings.json，不加就只作用于当前会话。

#### 支持到什么程度

不是装饰性的 vi 键位，是一套覆盖 normal / insert / visual 三大模式、支持 count 前缀、
operator + motion 组合、text object 的完整引擎。逐类列出**实际实现了**的动作
（每条都在 `transitions.ts` 的 `reduceNormalFirst` / `reduceVisual` 分发里）：

**移动**（`motions.ts`）：

| 键 | 动作 |
| --- | --- |
| `h` `l` `j` `k` | 左右上下（支持 count，如 `3j` 下移 3 行） |
| `w` `b` `e` | 下一个词 / 上一个词 / 词末（含跨行） |
| `W` `B` `E` | 空白分词版本（WORD 而非 word） |
| `0` `^` `$` | 行首 / 行首非空白 / 行末 |
| `gg` | 跳到首行（支持 `5gg` 跳第 5 行） |
| `G` | 跳到末行（支持 `5G`） |
| `f` `F` `t` `T` `;` `,` | 行内字符查找：正向/反向/正向停前/反向停前，`;` 重复、`,` 反向重复 |

**编辑**（`operators.ts`）：

| 键 | 动作 |
| --- | --- |
| `x` | 删光标处字符（count = 删几个） |
| `dd` | 删整行 |
| `D` | 删到行末（= `d$`） |
| `yy` | 复制整行 |
| `Y` | 复制整行 |
| `p` `P` | 粘贴（光标后/前） |
| `s` | 删字符并进插入 |
| `C` | 删到行末并进插入 |
| `J` | 下一行并到当前行（空格连接） |
| `~` | 翻转大小写 |
| `r` | 替换（进待决，按下一个字符替换光标处字符） |

**插入进入**：

| 键 | 动作 |
| --- | --- |
| `i` `a` `I` `A` | 光标前 / 后 / 行首 / 行末进插入 |
| `o` `O` | 下一行 / 上一行新建空行进插入 |

**operator + motion 组合**（`d` `c` `y` 配 motion）：

| 组合 | 动作 |
| --- | --- |
| `dw` `cw` `yw` | 删/改/复制一个词 |
| `de` `df<char>` `dt<char>` | 到词末 / 到字符 / 到字符前 |
| `d$` `d0` `d^` | 到行末 / 行首 / 行首非空白 |
| `dG` `dgg` | 到末行 / 首行 |
| `df<x>` | 删到下一个 `x`（含 x） |
| `5dd` | 删 5 行 |

**text object**（`text-objects.ts`，`i` = inner 不含边界 / `a` = around 含边界）：

| 键 | 选什么 |
| --- | --- |
| `iw` `aw` | 词对象 |
| `i"` `a"` | 双引号内容 / 含引号 |
| `i'` `a'` | 单引号 |
| `` i` `` `` a` `` | 反引号 |
| `i(` `a(` `ib` `ab` | 括号内 / 含括号 |
| `i[` `a[` | 方括号 |
| `i{` `a{` `iB` `aB` | 花括号 |
| `i<` `a>` | 尖括号 |

用法：`di"` 删掉引号里的内容、`ci(` 改括号里的内容、`ya[` 复制含方括号的整段。

**可视模式**（`v` 字符选 / `V` 行选）：

| 键 | 动作 |
| --- | --- |
| `v` | 进字符可视模式 |
| `V` | 进行可视模式 |
| 移动键 | 扩展选区 |
| `d` `x` `y` `c` | 对选区删/复制/改 |
| `>` `<` | 对选区缩进/反缩进 |

`Ctrl+V`（列选）**未实现**——这是和完整 Vim 的主要差距，列块编辑做不到。

::: tip 这是输入框 Vim，不是编辑器 Vim
作用域是 sid-code 的多行输入框，不是你打开的外部编辑器（`Ctrl+G` 进的那个）。
所以没有 `:ex` 命令行、没有 `:` 开头的 Ex 命令、没有具名寄存器 `"ay`、没有 marks、
没有 `.` 重复。它解决的是「在输入框里改 prompt 时的手感和 Vim 一样」，
不是替代一个真正的 Vim。
:::

### 思考开关：`/think`

`Alt+T` 是扩展思考的快捷键，斜杠命令 `/think` 管的是同一件事但更精确——三档显式控制：

```text
/think          显示当前思考开关状态 + 模型能力
/think on       开启思考
/think off      关闭思考
/think auto     恢复 auto（跟随模型/provider 默认）
/think on -p    切换并持久化到 settings.json（别名 --persist / save）
```

两个要分清的概念：

- **思考开关**（`/think`）控制**是否思考**——on / off / auto 三档
- **推理强度**（`/effort`）控制**思考多深**——low / medium / high / xhigh / max 五档

两者正交：可以「开着思考但强度调低」，也可以「关掉思考」直接不思考。

::: tip 不是所有模型都有这个开关
`/think` 只对支持显式思考开关的模型有意义（如带 thinking budget 的模型）。OpenAI o-series 这类**内置推理**的模型，思考行为由模型自身决定，`/think` 会直接提示「当前模型不支持显式思考开关」而不下发——这不是故障。
:::

如果设了环境变量 `SID_CODE_THINKING=on|off`，它会覆盖运行时切换。这时 `/think on` 虽然不报错，但实际行为不会变——命令会显式提示你「环境变量正在覆盖」。取消覆盖用 `unset SID_CODE_THINKING`。

### 外观与偏好

四个命令管界面外观，都支持 `-p` 持久化（默认仅当前会话）：

| 命令 | 管什么 | 常用调法 |
| --- | --- | --- |
| `/theme` | 整套配色（浅色/深色主题） | `/theme` 打开选择对话框；`/theme list` 看清单；`/theme "Default Light" -p` 直接切 |
| `/color` | 强调色（只点睛品牌色，不动整套配色） | `/color #89b4fa -p`；`/color reset` 清除覆盖 |
| `/tui` | 全屏 vs 内联渲染模式 | `/tui off` 切到内联（= `--inline`）；`/tui on` 切回全屏 |
| `/language` | 输出语言偏好（zh / en / auto） | `/language zh -p` 中文优先；`/language auto` 回退默认 |

几个容易混的点：

- `/theme` 切的是**预设主题**（浅色/深色多套），`/color` 只覆盖**强调色**一个变量——两个不冲突，可以「用 Default Light 主题 + 自定义蓝色强调」
- `/tui` 写的是 `alternateBuffer` 字段，**重启后才生效**——运行时无法就地切全屏/内联（渲染链路在启动时一次性定型）。命令会明确提示「重启 sid-code 后生效」
- `/language` 切完**立即重建系统提示词**，下一轮 LLM 调用就用新语言，不用重开会话。`auto` 是删除偏好字段、回退系统提示词默认（中文）

颜色支持 `#RGB` / `#RRGGBB` 十六进制和 CSS/Ink 命名色（如 `blue`、`cyan`），命名色会归一化成 hex 存储，保证跨主题稳定。

### 自定义状态栏：`/statusline`

底部状态栏默认是内置聚合视图（模型 · 分支 · token · 费用…）。想换成自己的，挂一个脚本：

```text
/statusline 'jq -r "\(.model) · \(.gitBranch) · \(.contextPercent)%"'
```

脚本协议：sid-code 把当前状态序列化成 JSON 经 **stdin** 喂给脚本，脚本的 **stdout** 就是状态栏内容（支持 ANSI 颜色）。收到的 JSON 包含这些字段：

| 字段 | 内容 |
| --- | --- |
| `cwd` | 当前工作目录 |
| `gitBranch` | 当前 git 分支 |
| `worktree` | worktree 信息 |
| `permissionMode` | 权限模式 |
| `model` | 当前模型 |
| `inputTokens` / `outputTokens` | token 计数 |
| `contextPercent` | 上下文占用百分比 |
| `costUSD` | 本次会话费用 |
| `cacheHitRate` | 缓存命中率 |
| `effort` | 推理强度档位 |
| `thinking` | 思考开关状态 |

管理：

```text
/statusline              查看当前配置 + 协议说明
/statusline <命令> -p    设置并持久化到 settings.json
/statusline off          禁用，回退内置
/statusline off -p       禁用并从 settings.json 移除
```

容错：脚本超时（1s）或非零退出会自动回退内置状态栏，不会卡住界面。

## 常见问题

**按 `?` 没反应，直接打出了问号。**
`?` 只在输入框为空时是"看键位"，已经有内容时它就是个普通字符。清空输入再按。

**`Shift+Enter` 变成了直接发送。**
终端没把这个组合传给程序。跑 `/terminal-setup`，或改用 `Alt+Enter` / `Ctrl+J`。

**Esc 按了但模型还在说。**
`Esc` 发出中断后要等当前这一小段流式响应收尾。连按会触发 `Esc` `Esc` 的回退选择器，
不是"更快的打断"。

**鼠标滚轮能滚，但选不中文字。**
全屏视口的预期行为，见上面 Copy Mode 一节。

**改了 `keybindings.json` 但没生效。**
键位在启动时加载，改完要重开会话。另有一批保留键（如 `Ctrl+C`）不允许被占用，
被拒的绑定会在启动时报出来。

## 相关

- [权限与人工确认](/use/permissions) —— `Shift+Tab` 切的那几种模式各是什么
- [会话管理](/use/sessions) —— `Esc` `Esc` 回退选择器怎么用
- [上下文与压缩](/use/context) —— `/context` 那张表怎么读
- [斜杠命令](/ref/slash-commands) —— 全部命令速查
