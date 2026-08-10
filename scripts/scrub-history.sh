#!/bin/bash
# scripts/scrub-history.sh — 一次性历史重写：清密钥 + 改作者邮箱（P0-2 阶段 1）
#
# ⚠️⚠️ 这是不可逆的单向门操作。它会重写全部 commit hash（本仓 1201 个），
#      所有已有 clone 都必须重新拉取，force push 会覆盖远端历史。
#      **执行前必须人工确认，脚本默认只做 dry-run 检查、不动任何东西。**
#
# 用法：
#   ./scripts/scrub-history.sh --check     # 只体检：列出待清对象、确认前置条件（默认行为）
#   ./scripts/scrub-history.sh --run       # 真正执行重写（需再输入 YES 二次确认）
#
# 它做四件事（对应 docs/bugfixes/todo/开源准备-项目工程化差距全量清单.md 的 P0-2 第 2/3/4 条）：
#   ① 从全部历史中删除 .mcp.json（该文件现已被 .gitignore，但历史里有 9 个 commit）
#   ② 把 3 个真实密钥在**所有历史 blob** 中替换为占位符
#      （不能只删 .mcp.json —— 密钥还散在 evals 两个文件和审计文档的历史版本里，
#        实测 6 个受污染 blob 分布在 4 条路径上）
#   ③ 把 919→实测 1201 个 commit 的作者/committer 邮箱改成个人邮箱
#   ④ 顺带清 commit message 里的内部网关域名（changelog 由 git 历史重建，
#      不在这里改，generate-changelog.ts 会把它反复生成回来）
#
# 前置依赖：git-filter-repo（本机当前未安装）
#   brew install git-filter-repo    # 或 pip3 install git-filter-repo
#
# ⚠️ rotate 密钥是**另一件事，且优先级更高**：重写历史不能挽回已泄露的事实。
#    三个 key 必须先在各自控制台作废/重签，再谈清历史。见文档 P0-2「必须做的四件事」第 1 条。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

MODE="check"
for arg in "$@"; do
  case "${arg}" in
    --check) MODE="check" ;;
    --run)   MODE="run" ;;
    *) echo "未知参数：${arg}"; exit 2 ;;
  esac
done

# ---- 待清密钥清单 -------------------------------------------------------------
# 注意：这里必须写全值才能替换。本文件**不入库**时才安全 —— 见文件末尾说明。
# 实际做法是从环境或外部文件读，避免脚本自身变成第 4 个泄露点。
SECRETS_FILE="${SECRETS_FILE:-${REPO_ROOT}/.scrub-secrets.txt}"

echo "=========================================="
echo " sid-code 历史清洗体检（模式：${MODE}）"
echo "=========================================="
echo

# ---- 前置条件检查 ------------------------------------------------------------
FAIL=0

echo "[1/6] git-filter-repo 是否可用"
if command -v git-filter-repo >/dev/null 2>&1; then
  echo "      ✅ $(git-filter-repo --version 2>&1 | head -1)"
else
  echo "      ❌ 未安装。装法：brew install git-filter-repo"
  FAIL=1
fi

echo "[2/6] 工作区是否干净（重写前必须先提交或 stash 完所有改动）"
if [[ -z "$(git status --porcelain)" ]]; then
  echo "      ✅ 干净"
else
  echo "      ❌ 有未提交改动 —— 重写会让这些改动无法对应任何 commit："
  git status --porcelain | sed 's/^/         /'
  FAIL=1
fi

echo "[3/6] 密钥清单文件 ${SECRETS_FILE}"
if [[ -f "${SECRETS_FILE}" ]]; then
  echo "      ✅ 存在（$(grep -cv '^\s*$' "${SECRETS_FILE}") 条替换规则）"
else
  echo "      ⚠️  不存在。需按 git-filter-repo --replace-text 格式创建，每行一条："
  echo "         literal:<真实key>==><占位符>"
  echo "      例（三条，值需自己填全）："
  echo "         literal:<REDACTED_GATEWAY_KEY>…==><REDACTED_GATEWAY_KEY>"
  echo "         literal:<REDACTED_TAVILY_KEY>…==><REDACTED_TAVILY_KEY>"
  echo "         literal:<REDACTED_TAVILY_KEY>…==><REDACTED_TAVILY_KEY>"
  echo "      ⚠️ 该文件含真实密钥明文，**必须**放在仓库外或加进 .gitignore，用完即删。"
  FAIL=1
fi

echo "[4/6] 历史中受污染的 blob 与路径（权威口径：全 blob 扫描，不只看文件名）"
echo "      2026-08-10 实测：6 个受污染 blob，分布在 4 条路径 ——"
echo "         .mcp.json                                            （整文件删除）"
echo "         evals/sample-50.jsonl                                （内容替换）"
echo "         evals/raw-outputs/bench-results-1779296863941.jsonl  （内容替换）"
echo "         docs/bugfixes/todo/开源准备-项目工程化差距全量清单.md （内容替换，审计文档自身也记了明文）"
echo "      ⚠️ 只删 .mcp.json 是不够的 —— 原文档漏了后三条。"

echo "[5/6] commit 规模与作者邮箱分布"
echo "      commit 总数：$(git rev-list --all --count)"
git log --all --format='%ae' | sort | uniq -c | sort -rn | sed 's/^/      /'

echo "[6/6] 远端与备份"
git remote -v | sed 's/^/      /'
echo "      ⚠️ 重写后需 force push；push 前**务必**先做一份完整裸仓备份："
echo "         git clone --mirror . ../sid-code-backup-\$(date +%Y%m%d).git"
echo

if [[ "${MODE}" == "check" ]]; then
  echo "=========================================="
  if [[ "${FAIL}" -eq 0 ]]; then
    echo " 体检通过。确认要重写请跑：$0 --run"
  else
    echo " 体检未通过（见上方 ❌），先补齐前置条件。"
  fi
  echo "=========================================="
  exit 0
fi

# ---- 真正执行 ----------------------------------------------------------------
if [[ "${FAIL}" -ne 0 ]]; then
  echo "❌ 前置条件未满足，拒绝执行。"
  exit 1
fi

echo "⚠️  即将重写全部 $(git rev-list --all --count) 个 commit 的 hash。"
echo "⚠️  这不可逆，且所有已有 clone 都要重新拉取。"
read -r -p "确认继续？输入大写 YES： " CONFIRM
if [[ "${CONFIRM}" != "YES" ]]; then
  echo "已取消。"
  exit 1
fi

BACKUP="../sid-code-backup-$(date +%Y%m%d-%H%M%S).git"
echo "==> 先做裸仓备份到 ${BACKUP}"
git clone --mirror . "${BACKUP}"

echo "==> ① + ② 删 .mcp.json 全部历史 + 替换全历史中的密钥"
git filter-repo --force \
  --invert-paths --path .mcp.json \
  --replace-text "${SECRETS_FILE}"

echo "==> ③ 改作者/committer 邮箱"
echo "    ⚠️ 下面的 NEW_EMAIL / NEW_NAME 需按实际个人身份改，脚本不代填。"
NEW_EMAIL="${NEW_EMAIL:?请设置 NEW_EMAIL 环境变量，例：NEW_EMAIL=you@personal.dev}"
NEW_NAME="${NEW_NAME:-zhourusheng}"
git filter-repo --force --email-callback "
  return b'${NEW_EMAIL}'
" --name-callback "
  return b'${NEW_NAME}'
"

echo "==> ④ 清 commit message 里的内部域名"
git filter-repo --force --message-callback "
  return message.replace(b'gateway.example.com', b'gateway.example.com')
"

echo
echo "==> 重写完成。收尾自查："
echo "    1. 复扫历史确认密钥归零（用文档 §P0-2 的全 blob 扫描法，不要只 git grep 当前 HEAD）"
echo "    2. git log --all --format='%ae' | sort -u   # 应只剩新邮箱"
echo "    3. 重新加远端并 force push（filter-repo 会自动移除 origin）："
echo "       git remote add origin <new-url> && git push --force --all && git push --force --tags"
echo "    4. 通知所有协作者重新 clone —— 旧 clone 再 push 会把脏历史带回来"
