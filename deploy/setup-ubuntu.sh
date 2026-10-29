#!/usr/bin/env bash
# deploy/setup-ubuntu.sh
# Script instalasi dependency server Tencent Cloud (Ubuntu 20.04 / 22.04 / 24.04 & Debian)
set -euo pipefail

echo "==> [1/4] Memperbarui daftar paket sistem..."
sudo apt-get update -y

echo "==> [2/4] Menginstal Nginx, Git, Curl, dan library Linux untuk Puppeteer (Render PDF)..."
if apt-cache show libasound2t64 >/dev/null 2>&1; then
  ASOUND_PKG="libasound2t64"
else
  ASOUND_PKG="libasound2"
fi

sudo apt-get install -y \
  nginx git curl ca-certificates fonts-liberation \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 "$ASOUND_PKG" libpangocairo-1.0-0 libpango-1.0-0 libcairo2

echo "==> [3/4] Memeriksa Node.js LTS (v20)..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

echo "==> [4/4] Menginstal PM2 Process Manager secara global..."
sudo npm install -g pm2

echo ""
echo "Selesai! Langkah berikutnya di folder proyek DocumentationAhliPJK3:"
echo "  1. npm install"
echo "  2. cp .env.example .env && nano .env   # Isi ACCESS_KEY rahasia tim Anda"
echo "  3. pm2 start ecosystem.config.js && pm2 save && pm2 startup"

