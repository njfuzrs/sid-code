---
Status: implemented
Date: 2026-08-24
---
# Dependabot 装反了：版本更新开着、告警与安全更新关着，先翻过来再收窄噪音

## 决定了什么

**核心事实：这个功能不是"要不要开"，是已经开了一半、且开错了那一半。**

2026-08-10 随开源准备提交进来的 `.github/dependabot.yml` 让**常规版本更新**从那天起
一直在跑，而仓库设置里真正有价值的两个开关**一直是 disabled**（实测）：

```
security_and_analysis.dependabot_security_updates: {"status": "disabled"}
repos/:owner/:repo/automated-security-fixes:       {"enabled": false}
repos/:owner/:repo/dependabot/alerts:              403 "disabled for this repository"
```

于是拿到了全部噪音、没拿到任何安全收益。三件事：

**1. 翻转开关**（不在本仓文件内，是仓库设置，`gh api -X PUT` 两条，均 204）：
`vulnerability-alerts` 与 `automated-security-fixes` 现在都是 enabled。
**这一条是本次改动里唯一真正增加安全性的部分**，下面两条都只是降噪。

**2. 收窄常规版本更新**（`.github/dependabot.yml`）：weekly → monthly；
主包加 `oxlint` 组（`oxlint` + `@oxlint/binding-*` 必须原子升级）与 `rest` catch-all 组；
子包加 `rest` 组。`rest` 必须声明在最后 —— Dependabot 按声明顺序匹配，一个依赖只进
第一个命中的组，放前面会把 `react` / `types` / `oxlint` 三组全部吞掉。

**3. 一个 PR 承载全部版本变更**，6 个 dependabot PR 全关：
yaml 2.8.2→2.9.0（根+子包）、oxlint 与 4 个 binding 1.77.0→1.78.0、
子包 `@anthropic-ai/sdk` 0.116→0.117.1，并**删掉 `js-yaml` + `@types/js-yaml`**
（全仓零引用，见下）。

## 放弃了什么（以及为什么不选）

**否决「逐个合那 6 个 PR」** —— 这是我最初列给用户的方案，核过 strict 后放弃。
必需检查开了 strict（分支必须与 main 最新），合一个其余全部 BEHIND 要重跑全量 CI
（约 200s/轮），6 个就是 6 轮，且期间任何 main 提交会让剩下的再次 BEHIND
（见 [[automerge-strict-serializes-merges]]）。**判定本身没变，变的只是包装**：
哪些该升、哪些是死依赖、哪些被覆盖，结论与逐个处理时完全一致。

**否决「升到 oxlint 最新的 1.79.0」**。实测 1.79.0 在本仓 `exit=1`：新增
`no-irregular-whitespace` 命中 `terminal-setup.ts:44` —— 那行注释里的 `/* *​/`
藏了个零宽字符，是为了不让块注释提前闭合而**刻意**写的。1.78.0 `exit=0`。
要升 1.79 得先处理那个转义，属于另一件事。

**否决「顺手拆掉 `.oxlintrc.json` 里那 4 行 binding 钉版」**。那份注释说钉版是因为
CI 的 install 带 `--omit=optional`，但全仓 grep `omit` 在 workflow / Makefile / 脚本里
**零命中**，10 个 workflow 全是裸 `bun install --frozen-lockfile`；我起了干净 probe
只装 `oxlint` 不装 binding，install 与运行都 `exit=0`。所以那 4 行**现在可能是纯负担**，
其原始成因（P1-5 时期的仓外 `file:` 依赖）已经消失。
**但本次不动它** —— 它与"清掉这批 PR"无关，且拆掉会改变 CI 的依赖解析路径，
该单独一个 PR 验。这里只把版本对齐到 1.78.0。

**否决「关掉 bun 版本更新只留安全更新」**（用户选项之一，用户选了收窄而非关闭）。
关掉的代价是常规依赖缓慢陈旧、需要人记得手工 `bun update`；monthly + 分组之后
噪音已经降到一个 PR/月，不值得用"多一件要记的事"去换。

**没有采用 `cooldown`**。查文档时发现 Dependabot 2026 年起对版本更新有 **3 天默认
cooldown**（安全更新不受此限），显式配置能调。monthly 间隔下这个旋钮意义不大，
留给以后真觉得"新版本刚发就被提 PR"时再用。

## 拿什么证明它生效了

**开关翻转**（这是唯一能证明"安全性真的增加了"的证据，其余都是降噪）：

```
gh api -X PUT .../vulnerability-alerts        → HTTP 204
gh api -X PUT .../automated-security-fixes    → HTTP 204
复核：dependabot_security_updates = {"status":"enabled"}
      automated-security-fixes    = {"enabled":true,"paused":false}
```

**配置形态**（拿 `yaml.parse` 打印顺序，不靠目测 —— 见 [[verify-counts-by-script-not-eyeball]]）：

```
bun @ /                        interval=monthly limit=5 groups(按序)=react > types > oxlint > rest
bun @ /packages/eval-framework interval=monthly limit=3 groups(按序)=rest
github-actions @ /             interval=monthly limit=3 groups=(none)
```
`rest` 在两处都是最后一个，正是"按序匹配"要求的位置。

**#52/#54 红掉的那一条，本地反向自证**：它们的失败是
`error: lockfile had changes, but lockfile is frozen`（Dependabot 改了子包
`package.json` 但没重生成根 `bun.lock`）。本次重生成后：

```
bun install --frozen-lockfile → Checked 135 installs across 185 packages (no changes)  exit=0
grep -c "1\.77\.0" bun.lock   → 0        （无残留旧版本）
grep -n  "js-yaml"  bun.lock   → 零命中   （死依赖已从 lock 移除）
```

**五道门禁**：`bun test` **10802 pass / 0 fail**（744 文件 / 152.42s）、
`make build` exit=0 且 `will always be undefined` 与 `warn` 各 **0 命中**
（见 [[worktree-cwd-breaks-permission-tests]] 那条教训：exit 0 不等于可交付）、
`bun run lint`（已是 1.78.0）/ `format:check` / `lint:boundary` 全 exit=0。

**#56 的 macOS 红是既存 flake，不是这次升级引入的**，按三条举证：
① 失败的 `运行时落盘门禁` 不 import oxlint；
② 同一条在 main 的 run `32622978424`（PR #98）也红过，且本地单跑 `3 pass / 0 fail`，
本次全量里也是绿的；③ 成因是 #56 的 base 停在 `607464af`（v0.1.601），落后 8 个提交。

**死依赖的判据是零引用，不是"看起来没用"**：
`grep -rn "js-yaml" .` 排除 `node_modules` / `.git` / `bun.lock` 后只剩
`package.json:110` 与 `:120` 两行声明本身，没有任何 import。所以 #53 是在给一个
死依赖提 major 升级 —— 正确处理是删，不是升。

**顺带核实的一条，防止以后误判**：`open-pull-requests-limit`（这里是 5）
**不适用于安全更新 PR**，安全 PR 既不计入也不受限。所以压低这个值不会挡住 CVE 修复，
文件头那句"刻意压低"是安全的。
