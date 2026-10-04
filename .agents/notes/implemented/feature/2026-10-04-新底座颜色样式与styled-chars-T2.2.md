---
Status: implemented
Date: 2026-10-04
---
# 新底座颜色三函数、颜色级别修正与 styled-chars 五函数，对拍旧底座向量（B9 / T2.2）

## 决定了什么

- `packages/tui/src/colorize.ts` 整文件改写，`packages/tui/src/text/styled-chars.ts` 新增；
  `render-port/next/text.ts` 的 8 个导出全部接上，next 的 text 端口不再有占位。
- 规则全部来自黑盒对拍旧底座（不读实现，D-5）：
  - `colorize`：只认 `ansi:<16 色名>`、`#hex`、`ansi256(n)`、`rgb(r,g,b)`。裸名 `red`、`ansi:gray`（chalk 有这个属性但不是 16 色之一）、
    带首尾空格的写法都原样返回；`#` / `#zzz` 交给 chalk（输出黑色），`ansi256(999)` / `rgb(300,…)` 不做范围校验。
  - `applyTextStyles`：inverse → strikethrough → underline → italic → bold → dim → 前景 → 背景，由内到外。顺序决定字节序列。
  - 颜色级别：vscode（区分大小写）且 256 色 → 真彩；非空 `TMUX` 且真彩 → 256 色，除非设了 `SID_CODE_TMUX_TRUECOLOR`
    或旧名 `CLAUDE_CODE_TMUX_TRUECOLOR`（**任意非空值都算开，`0` 也算**）。两条按序执行，VS Code 里的 tmux 最终是 256 色。
    只看 `TMUX`，不看 `TERM=tmux-*`。
  - styled-chars：宽度用 `stringWidth(char.value)`，不信 tokenizer 的 `fullWidth`（它对天城文连字报窄）；
    只有空格和 `\t` 是空白（`\n`、全角空格、NBSP 都算词）；行首空白丢掉，断点处空白换行并丢掉；
    放不下但不超行宽的词换行，超行宽的词硬折并先填满当前行；宽度 ≤ 0 不换行；返回输入里的同一批字符对象。
- `chalk` 从 5.6.2 升到 6.0.0，和 CLI 用同一个实例。chalk 是进程单例，CLI 的 markdown 渲染也会改它的 level，
  装两个版本就是两个单例，颜色级别修正只会作用到其中一个。
- 两个测试 fixture 的 `color="green"` 改成 `ansi:green`：新 colorize 不认裸名，CLI 源码里没有裸名用法。
- 顺带修了相似度门禁 `scripts/tui-similarity.ts` 的一个真 bug：jscpd 报告里的 `position` 是 UTF-8 **字节**偏移，
  脚本按 JS 字符串下标切片。文件里只要有中文注释，切出来的就是别处的文本，「是否继承自上游」的判定随之失真。
  T2.2 里它把上游原样的 `ansi256` / `rgb` 分支误判成从旧底座复制。改为按字节切，补了带中文注释的夹具用例
  （旧实现红、新实现绿）。

## 放弃了什么（以及为什么不选）

- **保留上游的裸颜色名**（`color in chalk`）：会让 `ansi:gray`、`bold`、`level` 这类 chalk 属性名被当成颜色，
  与旧底座输出不同；端口 `Color` 类型本来就不含裸名。
- **把颜色级别修正放到 CLI 入口**：旧底座是在模块加载时修正的，依赖方（markdown）看到的 level 已经是修正后的值。
  挪到 CLI 会改变初始化顺序，还得在 next / legacy 两边各写一份。
- **为相似度命中加白名单**：命中的几处本来就是误报（字节 / 字符偏移错位），修门禁是正解。
  在定位到偏移问题之前，`applyTextStyles` 被改写了几轮，最后成了表驱动的写法：叠加顺序集中在 `STYLE_LAYERS` /
  `COLOR_LAYERS` 两张表里，类型也从表派生，这个形态本身更好，所以保留。

## 拿什么证明它生效了

- `bun test ./packages/tui/tests/color-styled.test.ts`：37 pass。覆盖 chalk 级别 0–3 × 25 种颜色写法 × 4 段文本
  （前景 / 背景）、11 组样式组合、16 条环境矩阵（子进程跑旧底座得出），以及 27 段 styled-chars 语料 × 10 种宽度。
- 变异自证：17 处改动各自至少让 1 条测试转红，sha256 核对后已还原。包括 vscode 升级、tmux 降级、新旧变量名优先级、
  16 色名单、样式顺序（两处）、rgb 空格容忍、宽度来源、空白判定、行首空白、断点空白、换行 / 硬折分支、末行输出、
  对象同一性。
- next 下：`next-switch`（17 pass）和 `diff-ansi-lines`（8 pass，用到 applyColor / colorize / applyTextStyles）
  在 legacy 和 next 下都通过。
- tsc：在 HEAD 与工作区各跑一次全量 `tsc --noEmit` 做对比，没有新增错误，消掉 1 个（fixture 的 `"green"` 不符合 `Color` 类型）。
- 全量 `bun test` 13747 pass / 0 fail；`make build` 无 undefined 警告。
- 门禁：`tui:similarity`（修复后放行 39 处、违规 0）、`tui:text-vectors --check`、lint、format、`lint:boundary`、`tui:spec`。
- ⚠️ 新变量名 `SID_CODE_TMUX_TRUECOLOR` 不会出现在 `website/ref/env.md` 里：参考页生成器的 `PKG_SRC_DIRS`
  不扫 `packages/tui`（只扫 shared / tui-renderer / core / cli）。T9 删旧底座时必须把 `tui` 加进去，
  否则 D125 那批变量会从参考页静默消失。
- ⚠️ 补正：初版 `color-styled.test.ts` 为了拿输入常量 import 了 `scripts/tui-text-vectors.ts`，而这个脚本在顶层
  import 旧底座，等于间接依赖旧底座，T9 删掉旧底座后这个测试会挂。已改为把输入也写进向量 JSON
  （`color.inputs`），并在 `text.test.ts` 加了元测试：`packages/tui/tests` 下任何文件 import 旧底座或 `scripts/tui-*`
  都会转红。把旧写法放回去验证过，元测试确实变红。
