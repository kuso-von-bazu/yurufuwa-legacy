#!/bin/bash
# GitHub Pages へ公開(kuso-von-bazu/yurufuwa-legacy, main ブランチ直下)
cd "$(dirname "$0")"
git add -A
git commit -m "update $(date +%Y-%m-%d)" || true
git push origin main
echo "https://kuso-von-bazu.github.io/yurufuwa-legacy/"
