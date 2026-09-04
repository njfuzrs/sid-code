---
Status: implemented
Date: 2026-09-04
---
# 账号迁移重写历史后,0.1.602 的 beta 产物促升不了 —— 切 0.1.603 重发,不覆盖上传

## 决定了什么

上一轮发版(2026-09-03)因旧 GitHub 账号 `rushengzhou` 被封停而中断。迁往新账号
`njfuzrs` 时**重写了全部 commit hash**(撤销追踪 `packages/tui-renderer/src/`,
125 文件 / 24456 行),导致服务器上 `0.1.602` 那批 beta 产物**编自一个已不存在于任何 ref
的 commit**:

```
99e28297  ← 服务器产物字节自报的 commit（旧账号身份）   git branch --contains = 空
b10b75c2  ← main 上同一个提交（新账号身份），tree 不同
```

`release.sh --promote 0.1.602` 的 G2 门禁(第④道)据此拒绝促升,报
「这是个分支包,不能促升成稳定版」。**门禁判断正确,不是误报。**

裁决:**版本号 +1 到 0.1.603,从当前 `main` 全新走一遍 `--upload` → PR → `--promote`。**
0.1.602 永久停在 beta 通道,作为被历史重写作废的一版。
顺带把 `main` 上那 11 个未发布提交(vendor symlink 落地、CI 修复、账号迁移)一起发出去。

配套:新增 `changelog/curated/v0.1.603.json`,`userFacing: false`。
区间 9 条提交(按 `--first-parent` + `isNoiseSubject` 过滤后)全部是内部改动;
唯二触及会打进二进制的运行时文件(`sync-output.ts`、`crash-marker.ts`)
经 `git diff` 逐行确认**只改了注释**,所以「无用户可见变更」是事实而非偷懒。

## 放弃了什么（以及为什么不选）

**方案 A:`--no-bump --upload` 重建 0.1.602 覆盖服务器那份,再促升。** 已否决。
它能过门禁(新字节编自 `main`),但会造成**同一个版本号对应两套字节**:
tag `v0.1.602` 指向 `f46b5e6f`,而覆盖后的产物自报 `27bcbefa`。
这只是把「产物 commit 不存在」换成「tag 与字节错位」—— 正是 CLAUDE.md 发版一节
反复要消灭的那类不一致(那里记着 v0.1.591…v0.1.596 六个 tag 全部错位、
`git checkout <tag>` 重建不出对应二进制的教训)。省一个版本号不值这个代价。

**方案 B:给 `--promote` 加旁路 / 放宽 G2 门禁。** 已否决。
门禁这次是**首次在真实场景下拦住了它设计要拦的东西**。为了走通一次发布去放宽它,
等于用一次性便利换掉一道刚证明自己有效的防线 —— 而下一次遇到真的分支包时它就不在了。

**方案 C:只发官网、发布延后。** 未选(但已确认可行)。
用户 `sid-code update` 读 `latest.txt`,不促升就永远停在 0.1.601;
只发官网只能让 `/changelog` 好看,不解决「升不到新版」这个用户实际问题。

## 拿什么证明它生效了

**根因是实测出来的,不是推断**:

```
$ bun run scripts/artifact-identity.ts promote-gate \
    dist/release/0.1.602/sid-code-0.1.602-darwin-arm64.tar.gz 0.1.602
  v0.1.602 的产物编自 99e28297da94（main），**它不是 main 的祖先** —— 这是个分支包
  ⛔ promote 门禁未通过（v0.1.602）

$ git branch -a --contains 99e28297      # 空输出 = 任何 ref 都不含它
$ git rev-parse 99e28297^{tree}          # 0c245bec…
$ git rev-parse b10b75c2^{tree}          # 39e14243… 不同
$ git diff --stat 99e28297 b10b75c2 | tail -1
  125 files changed, 24456 deletions(-)   # 差的正是 tui-renderer/src
```

**服务器现状核过,不是照抄文档**:`beta.txt`=0.1.602 / `latest.txt`=0.1.601;
0.1.602 目录 5 平台 tarball 与 `.sha256` 全部 HTTP 200(0.1.601 缺
`linux-x64-baseline`,那个 target 是 0.1.602 才加的,符合预期)。

**「无用户可见变更」的判据**:`git diff v0.1.602..main -- <两个运行时文件>` 全文读过,
`3 insertions / 3 deletions` 全在注释行(删掉「未获授权」表述、改「claude-code ink fork」
措辞),无一行逻辑改动。

**curated 文件校验**:`bun run changelog:check` → 22 个文件全部通过,
`v0.1.603` 是**唯一没有 warn 的那个**。

⚠️ 附带发现(未修,记录在此):其余 21 个 curated 文件全部报「commits 覆盖率偏低 100%」。
成因同样是这次历史重写 —— 文件里记的旧 hash 仍存在但只挂在 worktree 引用上,
与 `main` 上的新 hash 对不上,**不是漏了功能**。它是 warn 而非 error,
`generate-changelog.ts` 不调 `checkCoverage`,release.sh 对其失败也是
`|| warn "不阻断发布"`,故不卡发版。按 CLAUDE.md「changelog 产物不纳入反漂移门禁」
一节,刻意不去批量改这 21 个文件的 hash —— 改它们等于用 22 个文件的改动
换一个不影响任何产物的数字好看。
