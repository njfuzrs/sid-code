---
Status: implemented
Date: 2026-08-24
---
# `SID_CONFIG_DIR` 不覆盖 debug.log：连带 6 处同型违反与 env 名分裂一次性收口

## 决定了什么

**一句话**：把「配置根目录」的派生收口到 `config/paths.ts` 一处，并让 `SID_CONFIG_DIR`
真的管住**全部**落盘路径（此前它管不住 debug.log、audit.log、output-styles、rules、
daemon 日志、compact-stats，以及整个轨迹子系统）。

缺陷本体是：`debugLogFile` 的默认值是字面量 `"~/.sid-code/debug.log"`，
而展开侧 `debug/logger.ts:146` 用 `join(homedir(), p.slice(1))` —— `homedir()` 不读 env。
于是配置目录被隔离到 tmpdir，**debug.log 仍写真实 HOME**。

排查后发现这不是一个 typo：`config/paths.ts` 的模块注释**两处**明写「杜绝各模块自行
`join(homedir(), ".sid-code", ...)`」，实际违反者 6 处；且轨迹子系统读的是**另一个
env 名** `SID_CODE_HOME`，与权威定义的 `SID_CONFIG_DIR` 互不认识 ——
设了前者的人发现配置还在老地方，设了后者的人发现轨迹还在老地方。

具体改了四类东西：

1. **新增单一展开入口** `expandSidHomePath()`（`config/paths.ts`）。两条语义：
   遗留的 `~/.sid-code/xxx` 字面量 → `sidHomePath("xxx")`（尊重 `SID_CONFIG_DIR`）；
   其余 `~/xxx` → `homedir()/xxx`（用户手写路径语义不变）。
   `logger.ts` 改为调它，删掉自己那份展开。
   **这一条不能省**：老用户的 `~/.sid-code/app.json` 里已经存着那个字面量
   （`saveAppConfig` 会把当时的默认值连带写进磁盘），而磁盘值优先于新默认值 ——
   只改默认值对他们完全无效。
2. **默认值改走 `sidPaths`**：新增 `sidPaths.debugLog()` / `sidPaths.auditLog()`，
   `config.ts:872,875` 与 `app-config.ts:134` 三处字面量、`cli.ts:1254,1337` 两处
   `?? "~/.sid-code/audit.log"` 兜底全部替换。
3. **其余 4 处 `join(homedir(), ".sid-code")` 收口**：`config/output-styles.ts`、
   `config/rules.ts`（同时把 `~/.claude/rules` 改走 `getClaudeHome()`）、
   `daemon/service.ts`、`query/compact/adaptive-strategy.ts`。
4. **env 名收敛**：`getSidHome()` 现在按 `SID_CONFIG_DIR > SID_CODE_HOME > ~/.sid-code`
   解析，`SID_CODE_HOME` 降级为**兼容别名**；`trace/digest.ts` 与
   `scripts/verify-hypothesis-guide.ts` 删掉自己那份判据改调 `getSidHome()`；
   两处用户可见文案（`/trace` 报错、`trace-digest.ts`）补上 `SID_CONFIG_DIR`；
   `--help` 与 `website/ref/env.md` 把 `SID_CODE_HOME` 显式登记为别名。

新增门禁测试 `packages/core/tests/config/sid-home-path-derivation.test.ts`（17 用例）。

## 放弃了什么（以及为什么不选）

**只改 debug.log 一处**（原方案 §2.4 的写法）—— 否决。会留下 5 处同型缺陷，
且下一个人还要把整套排查重做一遍。方案自己在 §2.6 已经改了定级（P2 → P2+）
并给出「一次性收口」的做法，这里照它执行。

**直接删掉 `SID_CODE_HOME`** —— 否决。它会静默打断既有用户脚本（本仓自己的
`scripts/trace-digest.ts` 就在用），而"静默"是最糟的失败模式：用户看到的是
"轨迹突然没了"，不是一条报错。降级为兼容别名的成本只有 `getSidHome()` 里多读一个 env。

**把 debug.log 挪进 `logs/`**（`sidPaths.log("debug.log")`，与 `daemon.log` /
`permissions-audit.log` 一致）—— 否决。`~/.sid-code/debug.log` 这个路径写进了
`--help`、`website/ref/cli.md`、`website/use/troubleshooting.md` 和大量注释；
本次是修「不尊重 `SID_CONFIG_DIR`」这一个缺陷，顺手挪目录会让所有文档同时失准，
也把一个纯 bug 修复变成行为变更。想挪另开 PR。

**门禁用逐字符状态机去注释** —— 实测后放弃。它在本仓真实源码上失灵：
`output-styles.ts:58` 的正则字面量 `replace(/^["']|["']$/g, "")` 里的 `"` 被当成
字符串开头，此后整个文件状态错位，把 `/** … */` 当代码扫 → **误报 3 处注释**。
改成行级分类（最靠左的注释标记胜出）。偏差方向也想清楚了：字符串里写 `//` 会导致
**漏报**而非误报 —— 对一条"拦下一个违反者"的门禁来说漏报可接受，误报不可接受
（它会逼人删掉解释性注释，正好把知识删干净）。

**门禁扫全仓（含 tests/）** —— 没做。测试里刻意构造 `~/.sid-code` 字面量是合法的
（就在本次这份测试里），扫进去只会逼人加豁免。

## 拿什么证明它生效了

**端到端、用真二进制、新旧对照**（不是"机理讲得通"，也不是"测试全绿"）。
脚本对同一套输入分别跑两个二进制，判据两条：debug.log 出现在 `SID_CONFIG_DIR` 下，
且假 HOME 下无 `.sid-code`：

```
# 线上版（含缺陷）
$ HOME=<fake> SID_CONFIG_DIR=<cfg> ~/.local/bin/sid-code -p -d --max-turns 1 hi
  cfg  : （无 debug.log）
  fake HOME: .sid-code        ← 缺陷复现
# 本次构建
$ HOME=<fake> SID_CONFIG_DIR=<cfg> ./sid-code -p -d --max-turns 1 hi
  cfg  : debug.log ✓（连同 app.json/logs/trajectories/… 15 项全在 cfg 下）
  fake HOME: （空）           ← 修复生效
```

**门禁的变异自证**（`CLAUDE.md` 那条：新增门禁必做，否则会变成"防线全在、调用全 0"）：
把 `logger.ts` 的展开与 `config.ts` 的两个默认值改回缺陷写法，重跑 →
**5 个用例转红**（含静态门禁那条与运行时假 HOME 那条）；改回来 → 17 pass 0 fail。
过程中还真抓到一次门禁自身的假绿：`config.ts` 有一行行注释写着
`不写 "~/.sid-code/*.log" 字面量`，里面的 `/*` 被早期扫描器当成块注释开启，
吞掉后续 13 行代码 → **有违规却报绿**。已固化成一条专门的变异自证用例。

其余门禁：
- `bun run affected-tests:run`（判定 selective，7 个目标）→ **4155 pass 0 fail**，44s。
- `make build` → 通过，且**显式 grep 了 `will always be undefined`**（worktree 里新增
  导出的必查项，`CLAUDE.md` 有教训）→ 零命中；编译产物自检 4 项全过。
- `bun run lint` / `format:check` / `lint:boundary` → 全过（越界依赖 0 处）。
- `bun run docs:gen-reference` → 重新生成 `website/ref/env.md`（`SID_CODE_HOME`
  从"未列入的读取点"升为正式登记项，82 → 83 个变量）。

**牺牲了什么**：`getSidHome()` 多读一个 env（可忽略）；`daemon/service.ts` 的日志目录
在**安装时**解析一次并写死进 plist / systemd unit —— 非默认 `SID_CONFIG_DIR` 下装的服务，
日志固定落在安装当时那个目录。这是"安装快照"语义，与 `daemon` 的其他参数
（interval / max-concurrent）一致，已在代码注释里点破，不是缺陷。

**服务的北极星方向**：**数据主权**（落盘路径可控才谈得上数据在自己手上）+
**企业级**（容器 / CI / 评测场景要求所有产物落点可控）。
它也是评测接入方案阶段 A 的前置：10 题 × 多 trial 会把这条路径打穿 10+ 次。
