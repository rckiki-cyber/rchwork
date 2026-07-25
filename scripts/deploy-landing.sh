#!/usr/bin/env bash
set -euo pipefail

# ── deploy-landing.sh ──────────────────────────────────────────────────────────
# 把 GitHub Release 更新日志同步到 bytelegal.cn（Vercel landing page）。
# 将 legalwork-landing.html、图片资源、site-data/changelog.json 拷贝到部署目录
# 并执行 vercel deploy。
#
# 用法:
#   ./scripts/deploy-landing.sh              # 部署到 Vercel 生产环境
#   ./scripts/deploy-landing.sh --dry-run    # 只拷贝不部署
# ────────────────────────────────────────────────────────────────────────────────

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="${DEPLOY_DIR:-/tmp/legalwork-landing-deploy}"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
  esac
done

echo "=== 源目录: $REPO_DIR"
echo "=== 部署目录: $DEPLOY_DIR"

# 1. 确保部署目录存在
mkdir -p "$DEPLOY_DIR/site-data"

# 2. 拷贝 landing 页
cp "$REPO_DIR/legalwork-landing.html" "$DEPLOY_DIR/index.html"
echo "✓ index.html"

# 3. 拷贝图片资源
for img in legalwork-logo.png legalwork-app-screenshot-new.png \
            legalwork-settings-screenshot.png legalwork-research-screenshot.png \
            knowledge-base-screenshot.png; do
  if [ -f "$REPO_DIR/$img" ]; then
    cp "$REPO_DIR/$img" "$DEPLOY_DIR/"
    echo "✓ $img"
  fi
done

# 4. 拷贝 changelog 数据
cp "$REPO_DIR/site-data/changelog.json" "$DEPLOY_DIR/site-data/"
echo "✓ site-data/changelog.json"

if [ "$DRY_RUN" = true ]; then
  echo ""
  echo "=== 干运行，未部署 ==="
  echo "手动部署: cd $DEPLOY_DIR && vercel --prod --yes"
  exit 0
fi

# 5. Vercel 部署
echo ""
echo "=== 部署到 Vercel ==="
cd "$DEPLOY_DIR"
if [ ! -f .vercel/project.json ]; then
  echo "首次使用，先 link: vercel link --project legalwork-landing-deploy --yes"
  vercel link --project legalwork-landing-deploy --yes
fi
vercel --prod --yes
echo ""
echo "=== 完成: https://bytelegal.cn ==="
