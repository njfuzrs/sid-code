# 发布手册（维护者）

> 从根 `CLAUDE.md` 搬来（2026-10-17），只在发版、回滚、改 `release.sh` 时需要读。
> 测试 `tests/release-channel.test.ts`、`tests/release-flow-contract.test.ts` 会断言本文件的关键段落。

## 本地环境：双版本并存

| 命令 | 指向 | 版本 | 用途 |
| --- | --- | --- | --- |
| `sid-code` / `sc` | `~/.local/bin/sid-code` → 线上下载版 | 稳定版 | 验证线上版本 |
| `sid-code-dev` / `sc-dev` | `~/bin/sid-code-dev` → 本地构建产物（仓库根） | 开发版 | 日常开发调试 |

两条命令是**不同的二进制名**，不靠 PATH 优先级区分。

## 日常开发

```bash
git pull          # 拉最新源码
make build        # 构建二进制（版本号不变，日常就用这个）
sc-dev            # 启动开发版（注意是 sc-dev，不是 sc）
```

## 发布上线

**⚠️ 铁律：先提交功能代码，再发布。禁止先发布后提交。**
发布产物必须能对应到一个确切 git commit。先发布后提交会开一个「已发布但未提交」的窗口——期间任何源码改动都会让线上二进制与 commit 对不上，出线上问题无法定位到确切代码版本。

这条铁律现在由脚本**机械化执行**，不再只靠人记：

- `release.sh` 开头有**工作区洁净门禁**，脏就直接拒绝发布（确认无碍加 `--allow-dirty`）。
- bump 提交与 tag 都由 `release.sh` 自己完成，且 tag 打在 bump 提交上、当场校验对齐。以前是「tag 打在 bump 前的 HEAD、bump 提交人工补做」，导致 tag 指向的 commit 里版本号比 tag 低一位（实测 v0.1.591…v0.1.596 **六个 tag 全部错位**，`git checkout <tag>` 重建不出对应二进制）。

### 先决定走哪条路：不是每次发版都要泡 beta

**`--promote` 与 `--upload` 之间没有任何时长门禁**（实测 `release.sh` 里 0 处
`sleep`/`mtime`/`age` 判据），所以「泡多久」完全是人的判断，不是流程强制。
两条路都合法，按**改动风险**选，别按习惯选：

| | 快车道（常规） | 泡制道（高风险） |
| --- | --- | --- |
| 什么时候用 | 文档、CI、内部重构、单点修复 —— 即**出问题也能秒级回滚**的改动 | 动了主循环 / 权限 / 网络重试 / 上下文压缩 / TUI 渲染，或一次发很多东西 |
| 怎么做 | 第 3 步之后直接接第 6 步 `--promote`（中间不等） | 第 6 步先装 beta 自己用一段时间，再 `--promote` |
| 用户拿到新版 | 当次发布即可 | 你验收之后 |
| 兜底 | `rollback.sh` 秒级回指旧版 | beta 期就发现问题，不流到 stable |

**判据是「回滚够不够快」，不是「改动大不大」**：制品全在自有服务器、
`rollback.sh` 是纯指针操作(秒级)，所以绝大多数改动的正确答案是**快车道**。
泡制道换来的是「stable 用户一次都没踩到」，代价是发布周期从分钟级变成天级 ——
只有当"踩到了再回滚"这件事本身不可接受时(数据损坏、权限放开、无法察觉的静默错误)
才值得付。

⚠️ **两条路的命令序列完全一样，唯一区别是第 6 步前面等不等。**
不存在"跳过 beta 的专用命令" —— `--upload` 永远只写 `beta.txt`，
`--promote` 永远是唯一能动 `latest.txt` 的入口，这个结构不因走哪条路而变
（理由见下方「发布通道」三条不能改回去的设计）。

⚠️ **泡制期只有真有人装 beta 才有价值。** 建好而没人装，它就退化成
「防线全在、调用全 0」。现状与判据见下方「发布通道」末尾。

标准顺序（脚本接管了 bump 与 tag，人负责前两步和收尾的 PR）：

```bash
# 1. 验证构建（全量单测由 release.sh 门禁负责，此处不重复跑）
make build

# 2. 提交功能代码（工作区必须干净，否则 release.sh 会拒绝）
#    ⚠️ 含 changelog/curated/v<下一个版本>.json —— 缺了 release.sh 会交互确认一次，
#    非交互环境（管道 / CI）会降级为 warn 直接过，于是官网那一版没有变更说明。
#    先跑 `bun run changelog:curate` 起草并过目；纯内部版本写 userFacing:false 即可。
git add <改动文件>
git commit -m "feat: ..."

# 3. 发布到 **beta 通道**：门禁(bun test) → bump → changelog → 5 平台构建 → 冒烟+自检
#    → 自动提交 `bump vX.Y.Z` → 打 tag（对齐校验）→ 原子上传 → 服务器端 sha256 复核
#    → 写 beta.txt → push tag → 建 GitHub Release
#    ⚠️ 这一步**不改 latest.txt**，稳定版用户拿不到它（见下方「发布通道」）
#    实测耗时 5m25s（其中全量 bun test 183s 占 56%）
./scripts/release.sh --upload

# 4. bump 提交走 PR 进 main（main 受 ruleset 保护，直推被 GH013 拒；见下方 ⚠）
git switch -c chore/release-<version>
git push -u origin chore/release-<version>
gh pr create --base main --fill
gh pr merge --auto --merge          # ⚠ 必须 --merge，squash 会让 tag 指向游离提交
                                    #   CI 实测 3m52s

# 5. 合并后同步 + 核验 + 清分支 + 发布官网
git switch main && git pull
git merge-base --is-ancestor v<version> main && echo OK   # 铁律的人肉复核（--promote 也会自己跑）
git push origin --delete chore/release-<version>          # 删远端分支（合并后就是残留）
git branch -d chore/release-<version>                     # 删本地分支（-d 会拒绝删未合并的）
./scripts/website-deploy.sh   # /changelog 是站点构建期快照，release.sh 只生成数据不发站点

# 6. 促升到稳定通道（纯指针，不重新构建）
#    区间 (当前 latest, 目标] 只有一版 = 快车道，零交互；
#    多于一版时先合并稳定版说明（changelog/curated/stable/v<ver>.json），
#    **交互确认**后才写 latest.txt，非交互环境直接拒绝。
#    beta 期修 bug 用 `--upload --beta-fix --beta-note "<一句话>"` 发下一个号（自动写 betaOnly curated）
#    ↑ 高风险改动走泡制道时，在这一步之前先装 beta 自己用一段时间：
#      curl -fsSL https://www.sid-code.cc/releases/sid-code/install.sh | SID_CODE_CHANNEL=beta bash
./scripts/release.sh --promote <version>

# 7. 端到端核验：稳定通道用户真能升上来（不看脚本自报，看用户链路）
curl -fsSL https://www.sid-code.cc/releases/sid-code/latest.txt   # 应等于 <version>
sid-code update && sid-code --version                            # 应升到 <version>
```

**⚠️ 第 4 步的 PR 必须先合并，第 6 步才能跑。** 顺序反了会被门禁拦住:
`--promote` 的 G2 门禁问的是 **`origin/main`**，而 `release.sh` 自己提交的 `bump`
先落在**本地** main —— PR 未合并时产物 commit「在本地 main = YES、在 origin/main = NO」。
这个窗口是真实存在的(实测 v0.1.603:upload 结束 16:39:23、PR 合并 16:48:20，
窗口 9 分钟)，而在 2026-09-04 修掉之前，门禁问的是本地 main，
**那段窗口里 promote 会放行一个尚未进主线的版本，且输出是一句 ✅**。

**⚠️ 第 5 步删分支不是可选的洁癖。** 合并后的 `chore/release-*` 留着就是残留,
下次发版 `git branch` 里会堆一串同名前缀的死分支，
而**判断"哪个是本次的"要靠版本号比对** —— 这正是 §0 铁律里「不确定就别动」
最容易被违反的场景。用 `git branch -d`(小写)而不是 `-D`:前者会拒绝删未合并的分支,
是免费的保险。仓库已开 `delete_branch_on_merge`，走 GitHub 网页合并会自动删远端，
但**命令行 `gh pr merge` 之后本地那条仍要自己删**。

**⚠️ 第 4 步为什么不是 `git push`**：main 受 ruleset `protect-main` 保护（要求 PR + `all-checks-passed`），直推被 **GH013** 拒（`Changes must be made through a pull request`）。而此刻**制品已上线、tag 已推送、bump 提交还在本地** —— 正是上面那条铁律要防的「已发布但未提交」窗口，只不过成因从人的疏忽变成了门禁冲突。所以这一步是**必经**的，不是可选的收尾。`release.sh` 跑完会按实际保护状态把这几条命令打出来。

曾考虑给 `release.sh` 开 ruleset bypass 让它能直推，**否决**：bypass 是给「人/应用」开的口子而非给某个提交，一旦开了任何直推都能绕过汇聚门 —— 而全量 CI 与 GitHub Release 那一步都挂在那道门上。用它换掉「每次发版一个 PR」的成本不值。

**⚠️ 合并必须用 merge 不能 squash**：tag 已经打在 bump 提交上。squash 会另造一个提交、原提交不进 main，于是 tag 指向一个**游离提交** —— `git checkout <tag>` 仍能用，但 `git merge-base --is-ancestor <tag> main` 会失败，「产物对应确切 commit」这条铁律就退化成「对应一个不在主线上的 commit」。核验方式：

```bash
git merge-base --is-ancestor v<version> main && echo OK
```

**这条核验现在是机械的**（2026-08-27）：`release.sh --promote` 会自己跑它，
判据优先读**产物字节里那 40 位 commit**（`dist/release/<ver>/` 还在时），
本地没有产物才退化到 tag 判据 —— 而退化路径会明说自己是弱判据，不冒充强判据。
上面这条命令保留作人肉复核，但**不再是唯一防线**：一条靠人记得跑的核验，
在忘记跑的那一次恰好是最需要它的那一次。

**发版后 `git status` 会多出 `northstar/`**：那是 `release.sh` 设计上就要求入库的指标快照（见 `scripts/release.sh` 中 northstar 一节），**不是脏数据**，跟 bump 一起提交进同一个 PR。

**上传凭据**：SSH 信息读自 `scripts/deploy.env`（不入库，见 `deploy.env.example` 模板）。
配了 `DEPLOY_SSH_PASSWORD` 后用 sshpass 免交互上传，无需每次输密码。首次配置：
`cp scripts/deploy.env.example scripts/deploy.env` 后填入真实值。

### 发布通道：beta 泡制 → promote 促升 → rollback 回滚

服务器顶层有**两个指针文件**，各一行版本号，两个通道**共用同一批版本目录**：

| 指针 | 通道 | 谁会改它 | 用户怎么装 |
| --- | --- | --- | --- |
| `beta.txt` | 抢先版 | 每次 `--upload` | `SID_CODE_CHANNEL=beta` |
| `latest.txt` | 稳定版 | **只有** `--promote <version>` | 缺省 |

```bash
./scripts/release.sh --upload              # 发到 beta（不动 latest.txt）
./scripts/release.sh --promote 0.1.601     # 稳定通道指过去
                                           # 快车道：紧跟 --upload 就跑，不必等（无时长门禁）
                                           # 泡制道：先装 beta 用一段时间再跑（高风险改动）
./scripts/rollback.sh                      # 看两个通道现指向谁 + 有哪些版本可回
./scripts/rollback.sh 0.1.600              # 稳定通道回指旧版（秒级）
./scripts/rollback.sh 0.1.600 --channel beta
```

三条不能改回去的设计（改回去都**不会报错**，只会静默失去价值）：

- **promote 是纯指针操作，不重新构建**。用户装到的字节 = beta 期被测的字节。给 beta
  单独一套目录的话，promote 就要复制或重建，"泡制期测的就是要发的东西"当场失效。
- **`--upload` 绝不写 `latest.txt`**。顺手加回那一行 = 取消整个通道机制（一发布即全量
  放量），而发布日志与从前一模一样。反漂移断言在 `tests/release-channel.test.ts`。
- **旧版本清理要豁免两个指针指向的版本**。beta 泡制期连发几版会把 stable 指向的那版
  挤出 `RELEASE_KEEP_VERSIONS=5` 窗口；删掉之后 latest.txt 还指着它 ——
  形态是**全部稳定版用户 404 装不上**，服务器端零报错。
- **窗口外的目录要 OSS 归档当场核对通过才删**（B46 P3，`scripts/archive-ops.sh verify`）。
  服务器只是热缓存，归档是唯一事实源；核对出错时跳过核对继续删 = 退回永久删除
  （B46 之前已因此丢过 20 个版本）。promote / rollback 到已淘汰的版本会先从归档回暖。

⚠️ **回滚不会让已装坏版本的用户自动降级**，他们要各自再跑一次 `sid-code update`。
`rollback.sh` 挡住的只是「还没更新的人不再踩坑」，这是它能做到的全部。
它**不碰 git**（版本号 / tag / 提交全不动）：回滚的是「用户拿到哪一版」，
不是「仓库停在哪一版」，混在一起会让一次秒级止血变成一次要 review 的改动。

`sid-code update` 与自动更新**跟随已安装的通道**（beta 安装读 beta.txt，dev 构建不自动更新；
`resolveUpdateChannel`，#204）。显式 `SID_CODE_CHANNEL` 优先于已安装通道。

**这段泡制期只有在真有人用 beta 时才有价值。** 建好而没人装，它就退化成第二个
「防线全在、调用全 0」。所以 A2 的验收判据不是"通道能用"，而是
**至少有一次真实回归是在 beta 期被发现、没有流到 latest**。

⚠️ **这条判据到 2026-10-17 仍未满足**：beta 通道 2026-08-25 建立，此后 v0.1.602–v0.1.610
都经 beta 发出，**没有一次由 beta 期发现并拦下的真实回归**（v0.1.602 因账号封停 + 历史重写作废）。
所以只能说「机制可用、判据未验证」——不要在文档或 PR 里把它写成一道正在起作用的防线。

**这不代表通道机制该撤掉**,但它确实意味着:**默认走快车道是当前的诚实选择**。
理由是不对称的——泡制道的收益依赖"有人真的装 beta 去用"这个尚未发生的前提,
而快车道的兜底(`rollback.sh` 秒级指针回滚)是已经实测过的。
把每次发布都当高风险来泡,只会把流程拖长而换不到任何已验证的保护。
真正能让这条判据被满足的动作不是「继续要求每次泡 beta」,
而是**给 beta 找到至少一个固定的真实使用场景**(例如自己日常就用 beta 二进制),
在那之前,泡制道留给你判断为高风险的那几次。

### Changelog + Tag

release.sh 在 bump 后重建 changelog；构建与冒烟全部通过后自动提交 `bump vX.Y.Z`，再把 annotated tag `vX.Y.Z` 打在**这个提交**上（`generate-changelog.ts` 会过滤 `^bump v\d` 提交，所以它不会污染 changelog）。每次运行完整重建，确定性且幂等。两份产物各有唯一职责：

| 产物 | 职责 | 内容来源 |
| --- | --- | --- |
| `CHANGELOG.md` | 文本事实源，给 diff / `curl` / 脚本 | git 历史（**全量原始提交**，按 feat/fix/docs/… 6 组） |
| `website/.vitepress/data/changelog.json` | 官网 `/changelog` 页的数据源，由 `theme/Changelog.vue` 渲染 | `changelog/curated/*.json`（**用户视角文案**，4 组受控词） |

**两个受众，两条渲染路径**：commit message 的读者是未来的自己，changelog 的读者是用户，靠正则做不了这个转换（实测 276 条提交里 24% 是用户完全不关心的文档/杂项）。所以官网正文来自**人工过目过的** curated 文案：

```bash
bun run changelog:curate            # 为下一个版本起草（spawn sid-code 自己读 diff 改写）
bun run changelog:curate 0.1.601    # 指定版本 / 补跑
bun run changelog:check             # 不调 LLM，只校验已入库的全部文案
```

产出 `changelog/curated/v<version>.json` → **读一遍**（脚本会把条目打印到终端）→ 需要就直接改 JSON → commit。发版前 release.sh 会检查该文件是否存在，缺了会交互确认一次（放在构建**之前**，此刻补还来得及）。

⚠ **五条禁令**，破了就是数据错乱、内容失真或每次 commit 都红：

- `release.sh` / `generate-changelog.ts` **绝不调 LLM**，只读已入库的 curated 文件 —— 发布路径必须确定性 + 离线 + 幂等，把一次 LLM 调用塞进发布链会同时破掉这三条。
- curated 文件**必须人工过目**才提交。校验器只拦形态（词表、长度、URL、字段自洽），拦不住「把内部重构写成用户特性」「漏掉一个真实的破坏性变更」—— 这两类只有人能拦。
- `CHANGELOG.md` **必须保持全量原始提交**（含 hash、docs/其他 分组）。curated 漏了东西时它是唯一的回溯途径。
- `website-deploy.sh` **不得**重跑 `generate-changelog.ts` —— 会把 HEAD 上尚未发版的提交归到已发布的版本号名下。只有 `release.sh` 有资格生成这份数据。
- changelog 产物**不纳入** `docs-gen-reference --check` 那类反漂移门禁 —— `website/ref/` 能立门禁是因为源是源码；changelog 的源是 git 历史，每提交一次就变。

## 三个构建目标职责

| 命令 | 版本号 | 用途 |
| --- | --- | --- |
| `make build` | 不变 | **日常开发（99% 的场合）**：改完 / 拉完代码重建二进制 |
| `make build-bump` | +1 | 少见：想本地自测一个带新版本号的二进制 |
| `./scripts/release.sh --upload` | +1 | 正式发布：构建 5 平台制品并上传到服务器 |

**选哪个：默认 `make build`。** 只要你不是在专门测「版本号本身」，就用它。
`make rebuild` 保留为 `make build` 的别名（历史文档里到处是它），敲了也不会出错，
但新写的文档 / 命令一律用 `make build`。

三条由「版本号内联进二进制」派生的规则（`bun build --compile` 编译时把 `package.json` 写进产物，git pull 更新源码不会改它）：

- **源码更新后必须重新编译**，否则跑的还是旧代码。
- **版本号只 bump 一次**：直接 `./scripts/release.sh --upload`，别先跑 `make build-bump`（它也 bump，会让版本号 +2）。已 bump 过用 `--no-bump --upload` 复用。
- **`build-bump` / `release.sh` 之后补一次 `make build`**：发布制品是跨平台编译产物，仓库根的开发版二进制不会跟着更新，内联版本号还停在旧值 —— 不补则 `sc-dev` 显示的版本比线上低一位，容易误判。

