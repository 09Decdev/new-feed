#!/usr/bin/env bash
# Baseline commit cho news-poster GUI (docs + Wave 1-2).
# Cách chạy: cd news-poster && bash git-init.sh
# - Chỉ stage nội dung trong repo news-poster này.
# - Từ chối commit nếu phát hiện file nhạy cảm trong staged.
# - Không push.
set -euo pipefail
cd "$(dirname "$0")"

SENSITIVE='(^|/)(\.env$|\.session\.json$|posted\.json$|node_modules/|.*\.log$)'

git add -A
STAGED="$(git diff --cached --name-only || true)"

if [ -z "$STAGED" ]; then
  echo "Khong co gi moi de commit."
  git status --short
  exit 0
fi

if echo "$STAGED" | grep -iE "$SENSITIVE"; then
  echo >&2 "!! Phat hien file nhan cam trong staged -> DUNG lai, khong commit."
  echo >&2 "Kiem tra lai .gitignore."
  exit 1
fi

echo "=== Stage ${#STAGED} file. Kiem tra staged truoc khi commit:"
echo "$STAGED" | head -40

git commit -m "$(cat <<'EOF'
feat: news-poster GUI autobuild baseline (docs + Wave 1-2 server/API)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"

echo "=== Done ==="
git log -1 --stat | head -40
git status --short