---
title: 安装
description: 一条 curl 命令装好 sid-code，以及 PATH / 权限 / 架构识别三类常见失败的处理。
---

# 安装

一条命令装完。这页还列了三类最常见的失败，以及它们的**原样报错文本**——
照着报错找对应小节就行，不用通读。

支持 macOS 与 Linux，`arm64` 与 `x64`。Windows 原生不支持（Git Bash 等会直接报错退出，不会装坏东西），走 WSL2 跑同一条命令即可。

## 快速上手

```bash
curl -fsSL https://www.sid-code.cc/releases/sid-code/install.sh | bash
sid-code --version    # 确认装上了
```

<!--
  ⚠ 这里刻意**只验证版本，不启动 TUI**。
  曾经写「装完直接跑：`sc`」——但 sid-code 不带模型，没配 provider 时进 TUI
  打第一句话就报模型错误，用户会当成安装失败。而解释这件事的 tip 原本在本页
  第 198 行，用户在第 22 行就已经离开页面去开终端了：同一页里前后自相矛盾。
  现在把「还要配 provider」提到这里，`sc` 挪到配好之后。
-->

::: warning 装完还不能用，还差一步
sid-code **不带模型**。装完只是有了这个壳，还得告诉它去哪调模型：
[配置 LLM Provider](/start/configure)（三族各一份可直接粘的配置；
或者直接跑 `sid-code` 让 TUI 的分步引导问你要哪个）。

配好之后再启动。**跳过这步直接启动，打第一句话就会报模型错误**——那不是装坏了。

<!--
  ⚠ 这两处刻意用 `sid-code` 而不是 `sc`：本页第 80 行的 warning 说了 `sc` 是
  全放行别名（= --dangerously-skip-permissions）。在那条警示**之前**先教 `sc`，
  等于让读者先照着敲了全放行命令，再往下读到「其实这个不建议第一次用」。
  顺序反了，警示就白写。
-->
:::

::: tip 首次安装后命令找不到？
安装脚本会把 PATH 写进你的 shell 配置文件，但**当前这个终端窗口读不到新配置**。
重开一个终端，或按脚本最后提示的那行 `source ~/.zshrc` 执行一次。
详见下面的[失败一](#失败一-command-not-found-sid-code)。
:::

## 它装了什么、装到哪

脚本全程非交互，不需要 `sudo`，所有东西都在你的家目录下：

| 路径 | 内容 |
| --- | --- |
| `~/.local/share/sid-code/versions/<版本号>/` | 二进制本体，按版本号分目录 |
| `~/.local/bin/sid-code` | 软链接，指向当前版本 |
| `~/.sid-code/` | 你的配置、会话记录、日志 |
| `~/.zshrc`（或 `.bash_profile` / `.bashrc`） | 追加一段 `# >>> sid-code >>>` 标记块，写 PATH 和 `sc` 别名 |

几条值得知道的性质：

- **只追加，不覆盖。** 写 shell 配置时只在文件末尾追加带标记的块，不动你原有的任何内容；
  你已经有同名 `sc` 别名的话它尊重你的，不覆盖。
- **保留最近 2 个版本（含当前）。** 升级时更旧的版本目录会被清掉，出问题可以切回上一个。
- **已有配置绝不动。** `~/.sid-code/settings.json` 存在时脚本完全跳过配置写入——
  升级场景不会把你的 API Key 冲掉。
- **下载有校验。** sha256 不匹配就中止，且中止发生在切换软链接**之前**，
  现有安装不受影响。校验通过后还会跑一次 `--version` 冒烟测试，挡住"校验过了但架构不对"。

装完你会看到：

```text
╔══════════════════════════════════════╗
║   安装完成！v<版本号>
╚══════════════════════════════════════╝

  现在可以运行：
    sc                   # 启动（跳过全部权限检查，熟手用）
    sid-code             # 启动（需逐条确认权限）
    sid-code --version   # 确认版本
    sid-code update      # 以后升级到最新版本
```

::: warning `sc` 别名跳过了权限确认
安装脚本写的 `sc` 别名等价于 `sid-code --dangerously-skip-permissions`，
意思是它改文件、跑命令都不再问你。这对熟手顺手，但**第一次用建议直接跑 `sid-code`**，
把每一步确认看清楚（[跑通第一个任务](/start/first-task)就是这么演示的）。
两种模式的边界见[权限与人工确认](/use/permissions)。
:::

## 指定版本安装

```bash
# 锁定某个版本（回滚场景）
curl -fsSL https://www.sid-code.cc/releases/sid-code/install.sh | SID_CODE_VERSION=<版本号> bash
```

| 环境变量 | 作用 |
| --- | --- |
| `SID_CODE_VERSION` | 锁定安装版本，默认读服务器通道指针 |
| `SID_CODE_CHANNEL` | 发布通道 `stable`（默认）/ `beta`，见下节 |
| `SID_CONFIG_DIR` | 配置目录，默认 `~/.sid-code` |
| `RELEASE_BASE` | 下载地址前缀，默认官网下载地址 |

## 抢先版（beta 通道）

新版本先发到 `beta` 通道泡一段时间，验收没问题才促升到稳定版。
想提前拿到新功能、并且愿意帮忙暴露问题，就装 beta：

```bash
curl -fsSL https://www.sid-code.cc/releases/sid-code/install.sh | SID_CODE_CHANNEL=beta bash
```

两个通道装到的是**同一批产物**，promote 只是把稳定通道的指针挪过去 —— 也就是说
你在 beta 期跑的二进制，与之后所有人拿到的是同一份字节，没有"再构建一次"这一步。

::: tip 通道会跟着安装走
装 beta 时安装脚本会在版本目录旁写一个通道标记，之后 `sid-code update` 和后台自动更新
都**沿用 beta 通道**（读 `beta.txt`），beta 期发的修复号不用手动操作就能升上去：

```bash
sid-code update                            # 沿用当前通道（beta 用户仍在 beta）
SID_CODE_CHANNEL=stable sid-code update    # 退出 beta，回到稳定版
```
:::

beta 期发现问题时不会在原版本号里换字节，而是发下一个构建号；验收通过后促升最后那个号。
所以稳定版的版本号可能跳号（比如 0.1.606 → 0.1.609），被跳过的中间号在
[更新日志](/changelog)里标为「预发布」，它们的变更已合并进稳定版的说明。

想退回稳定版随时可以，跑一次 `SID_CODE_CHANNEL=stable sid-code update` 即可，配置和会话都不受影响。

## 升级与卸载

```bash
sid-code update    # 升级到最新版（不动 ~/.sid-code/ 里的配置和会话）
```

日常启动还会按 `settings.autoUpdate` 后台检查当前通道的新版本（默认 `auto`，下次启动才切）。
三种模式、失败保护、回滚见[自动更新](/use/auto-update)。

卸载没有专门命令，手工删三处即可：

```bash
rm -rf ~/.local/share/sid-code    # 二进制
rm -f  ~/.local/bin/sid-code      # 软链接
rm -rf ~/.sid-code                # 配置与会话（想留着下次用就别删）
```

再从 shell 配置文件里删掉 `# >>> sid-code >>>` 到 `# <<< sid-code <<<` 之间那段。

## 常见问题

### 失败一：`command not found: sid-code`

装完当场就报这个，是**最高频**的一个，而且几乎总是同一个原因：
PATH 写进配置文件了，但当前窗口还没读到。

```text
zsh: command not found: sid-code
```

按顺序试：

```bash
# 1. 先确认二进制真的装上了（这条能出版本号说明只是 PATH 问题）
~/.local/bin/sid-code --version

# 2. 让当前窗口读新配置（或者干脆重开一个终端）
source ~/.zshrc        # zsh
source ~/.bash_profile # macOS + bash
source ~/.bashrc       # Linux + bash

# 3. 确认 PATH 里有了
echo $PATH | tr ':' '\n' | grep '.local/bin'
```

如果第 1 步就没有输出，那是下载或解压没成功，重跑一次安装命令。

如果第 3 步始终 grep 不到，说明脚本没找到该写哪个文件——它遇到两种情况会跳过写入
并打印 `⚠️` 提示：**shell 不是 zsh/bash**，或者**目标配置文件不存在**
（脚本刻意不替你创建新的 rc 文件，因为凭空创建 `.bash_profile` 会改变
你 shell 的加载行为）。这两种情况手动加两行：

```bash
export PATH="$HOME/.local/bin:$PATH"
alias sc='sid-code --dangerously-skip-permissions'
```

### 失败二：架构或系统不支持

```text
  ❌ 不支持的架构: i386
  ❌ 不支持的操作系统: MINGW64_NT-10.0（目前仅支持 macOS / Linux）
```

前者是 32 位机器，后者通常是在 Windows 的 Git Bash 里跑。
Windows 用户走 WSL2，在 WSL 里跑同一条 curl 命令即可。

值得单说一下 macOS：`uname -m` 在 Rosetta 下的 shell 里会返回 `x86_64`，
于是装的是 x64 版本——**能跑，但比原生 arm64 慢**。确认一下：

```bash
uname -m    # Apple Silicon 原生应该输出 arm64
```

输出 `x86_64` 而你的机器是 M 系列芯片，说明当前终端跑在 Rosetta 下，
换一个原生终端重装。

<!--
  ⚠ 标题必须把两个症状都写出来（曾叫「失败三：权限相关」）。
  本页的设计承诺是「照着报错找对应小节」，而这一节里第一个报错其实是**连不上服务器**，
  权限问题只是第二种——叫「权限相关」会让连不上服务器的人在目录里扫一遍标题后跳过它。
-->

### 失败三：下载失败，或权限不对

```text
  ❌ 下载失败: https://www.sid-code.cc/releases/sid-code/<版本号>/sid-code-<版本号>-darwin-arm64.tar.gz
```

看到这个**大概率不是权限，而是连不上服务器**（确认能访问 www.sid-code.cc，检查代理设置或防火墙是否放行）。先单独试一下：

```bash
curl -I https://www.sid-code.cc/releases/sid-code/latest.txt
```

真正的权限问题长这样，通常是家目录下某个目录属主不对（历史上用过 `sudo` 装东西留下的）：

```text
mkdir: /Users/you/.local/bin: Permission denied
```

修：

```bash
sudo chown -R "$(whoami)" ~/.local ~/.sid-code
```

macOS 上还有一类是 Gatekeeper 拦截：

```text
"sid-code" cannot be opened because the developer cannot be verified.
```

安装脚本已经对新装的目录做了 `xattr -cr` 去隔离，正常不会遇到。
真遇到就手动去一次：

```bash
xattr -cr ~/.local/share/sid-code
```

<!--
  这条保留（页首那个 warning 已经先说过一次），因为两处服务的是不同读者：
  页首那条给顺序读下来的人，这条给**直接搜报错跳进本页失败小节**的人——
  他不会回头看页首。重复一次的代价远小于让他以为装坏了。
-->

::: tip 装完了但一跑就报模型错误
那不是安装问题，是还没配 provider（sid-code 不带模型）。往下走[配置 LLM Provider](/start/configure)——
里面有个 `base_url` 的 `/v1` 坑，两族协议规则正好相反，是新手第一大卡点。
:::

## 相关

- [配置 LLM Provider](/start/configure) —— 装完的第一件事
- [跑通第一个任务](/start/first-task) —— 配好之后走一遍完整流程
- [CLI 参数与子命令](/ref/cli) —— 全部参数速查
- [环境变量](/ref/env) —— 含 `SID_CONFIG_DIR` 等
