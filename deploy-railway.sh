#!/bin/bash

echo "🚂 Railway 部署腳本 (最簡單)"
echo "=========================="

# 檢查是否安裝 Railway CLI
if ! command -v railway &> /dev/null; then
    echo "📦 安裝 Railway CLI..."
    npm install -g @railway/cli
fi

echo "🔧 建立 Railway 配置..."

# 建立 railway.json
cat > railway.json << 'EOL'
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm run build"
  },
  "deploy": {
    "startCommand": "npm start",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 100,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
EOL

# 建立 nixpacks.toml (優化建置)
cat > nixpacks.toml << 'EOL'
[phases.build]
cmds = [
  "npm ci",
  "npx prisma generate",
  "npm run build"
]

[phases.start]
cmd = "npm start"

[variables]
NODE_ENV = "production"
EOL

echo "🔧 更新 package.json..."
# 添加 Railway 相關腳本
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.scripts = {
  ...pkg.scripts,
  'railway:build': 'prisma generate && npm run build',
  'railway:start': 'prisma migrate deploy && node dist/test-server.js'
};
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
console.log('✅ package.json 已更新為 Railway 配置');
"

echo "📝 建立環境變數模板..."
cat > .env.railway.template << 'EOL'
# Railway 環境變數設定
NODE_ENV=production
PORT=3000

# Railway 會自動提供 PostgreSQL
# DATABASE_URL 會由 Railway 自動設定

# JWT 密鑰 (請生成安全密鑰)
JWT_SECRET=您的超級安全JWT密鑰_請使用隨機字串
JWT_EXPIRES_IN=24h
JWT_REFRESH_SECRET=您的刷新令牌密鑰_請使用隨機字串
JWT_REFRESH_EXPIRES_IN=7d

# LINE Pay (如果需要真實支付功能)
LINE_PAY_CHANNEL_ID=您的LINE_Pay_Channel_ID
LINE_PAY_CHANNEL_SECRET=您的LINE_Pay_Channel_Secret
LINE_PAY_ENV=production
LINE_PAY_API_URL=https://api-pay.line.me

# 其他服務
SENDGRID_API_KEY=您的郵件服務密鑰
FROM_EMAIL=noreply@您的網域.com

# 安全配置
BCRYPT_ROUNDS=12
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
EOL

echo "🚀 開始 Railway 部署..."
echo ""
echo "請依照以下步驟："
echo "1. 登入 Railway: railway login"
echo "2. 建立新專案: railway new"
echo "3. 添加 PostgreSQL: railway add --plugin postgresql"
echo "4. 部署: railway up"
echo ""
read -p "按 Enter 開始自動執行，或 Ctrl+C 取消..."

# 自動執行
echo "🔐 登入 Railway..."
railway login

echo "🆕 建立新專案..."
railway new chicken-pos-system

echo "🗄️ 添加 PostgreSQL 資料庫..."
railway add --plugin postgresql

echo "📤 部署應用..."
railway up

echo ""
echo "🎉 部署完成！"
echo "🌐 您的應用網址: https://your-app.railway.app"
echo "🗄️ 資料庫已自動配置"
echo ""
echo "📋 接下來："
echo "1. 前往 Railway 面板設定環境變數"
echo "2. 執行資料庫遷移: railway run prisma migrate deploy"
echo "3. 執行種子資料: railway run npm run db:seed"