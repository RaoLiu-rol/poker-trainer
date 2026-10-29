#!/bin/sh
# build_site.sh — 生成可部署的纯静态站点（不含 APK/AAB/中间文件）
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/poker"
OUT="${CI_SITE_OUT:-$ROOT/dist}"

rm -rf "$OUT"
mkdir -p "$OUT/locale" "$OUT/icons"

cp "$SRC/index.html" "$SRC/style.css" "$SRC/engine.js" "$SRC/app.js" "$SRC/i18n.js" "$OUT/"
cp "$SRC/manifest.webmanifest" "$SRC/sw.js" "$SRC/privacy.html" "$OUT/"
cp "$SRC"/locale/*.js "$OUT/locale/"
cp "$SRC"/icons/*.png "$OUT/icons/"

# 站点根重定向
cat > "$OUT/404.html" <<'EOF'
<!doctype html><meta charset="utf-8"><script>location.replace('./index.html')</script>
EOF

echo "site built: $OUT"
du -sh "$OUT"
